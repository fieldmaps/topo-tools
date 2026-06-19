import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";

// Overlap measurement by point sampling — the robust, can't-fail alternative to
// exact polygon intersection.
//
// Why not exact intersection? GEOS OverlayNG compiled to WASM has a floating-point
// robustness bug: ST_Intersection / ST_Difference throw "found non-noded
// intersection" on the near-coincident shared boundaries between two independently
// digitized versions of the same coverage (verified — the same engine succeeds
// natively). No input cleaning fixes it. See the project memory
// reference-wasm-overlayng-fp-divergence.
//
// Instead we estimate the overlap *ratios* the classifier actually needs. For a
// changelog, "how much of A is covered by B" is a fuzzy, ratio-valued question; a
// 1 m boundary wobble is noise, not signal. We drop a regular grid of sample points
// inside each polygon and count how many land in each polygon of the other layer.
// Point-in-polygon (ST_Within) never noddes edges, so it cannot fail.
//
//   coverage_a = (A's sample points that fall in B) / (A's sample points)   ≈ area(A∩B)/area(A)
//   coverage_b = (B's sample points that fall in A) / (B's sample points)   ≈ area(A∩B)/area(B)
//   shared_area = coverage_a * area(A)   (areas computed exactly via ST_Area)
//   iou = shared_area / (area(A) + area(B) - shared_area)
//
// Geometry is used at FULL precision throughout. An earlier version simplified the
// polygons to speed up ST_Within, but simplifying the two layers independently moves
// their boundaries apart by up to the tolerance, so genuinely-identical units came
// out with coverage < 1 and misclassified as "modified". At full precision an
// unchanged unit's sample points fall inside the identical other-layer polygon, so
// coverage is exactly 1 — no false change. The cost is bearable because the
// point→polygon assignment uses DuckDB's index-based SPATIAL_JOIN (plain ST_Within
// in the ON clause), ~14× faster than a manual bbox-prefilter join here.
// See reference-spatial-join-vs-bbox-prefilter.

// GRID×GRID lattice over each polygon's bbox, clipped to the polygon. Every unit is
// sampled regardless of size, so small units are never missed. Higher = more
// accurate ratios, slower (coverage std-error ≈ 1/(2·√points_in_unit)).
//
// 32 was chosen by auditing sampled IoU against the exact native overlay on the SYR
// admin4 data: at GRID=32 the modified/unchanged verdict matches exact for every
// matched pair down to a 0.99 IoU threshold (max abs IoU error ~0.6%); GRID=16 left
// ~9 genuinely-unchanged units wrongly flagged "modified" at 0.99 (one stray boundary
// point in a small unit is ~0.8% of its samples, which IoU amplifies). A 1.0 (bit-
// identical) threshold is NOT reliably resolvable by sampling at any GRID and is
// capped out in the UI. See reference-wasm-overlayng-fp-divergence.
const GRID = 32;

// EPSG:8857 (Equal Earth) for area in m² — ratios are unit-free but shared_area is real.
const AREA = (g: string) => `ST_Area(ST_Transform(${g}, 'EPSG:4326', 'EPSG:8857'))`;

// Interior sample points for one side: a grid clipped to each polygon, plus a
// guaranteed ST_PointOnSurface so units too small/thin to catch a grid point are
// never dropped (they'd misclassify as created/removed). ST_PointOnSurface always
// returns an interior point and handles MultiPolygon / GeometryCollection units
// (islands, exclaves) — which ST_MaximumInscribedCircle rejects.
async function samplePoints(conn: AsyncDuckDBConnection, side: "a" | "b"): Promise<void> {
  await conn.query(`--sql
    CREATE TABLE cw_${side}_pts AS
    WITH bbox AS (
      SELECT fid, geom,
             ST_XMin(geom) AS x0, ST_XMax(geom) AS x1,
             ST_YMin(geom) AS y0, ST_YMax(geom) AS y1
      FROM cw_${side}_keyed
    ),
    grid AS (
      SELECT fid, geom,
             ST_Point(x0 + (i + 0.5) * (x1 - x0) / ${GRID},
                      y0 + (j + 0.5) * (y1 - y0) / ${GRID}) AS pt
      FROM bbox,
           UNNEST(range(0, ${GRID})) AS gx(i),
           UNNEST(range(0, ${GRID})) AS gy(j)
    )
    SELECT fid AS self_fid, pt FROM grid WHERE ST_Within(pt, geom)
    UNION ALL
    SELECT fid AS self_fid, ST_PointOnSurface(geom) AS pt FROM cw_${side}_keyed
  `);
}

export async function stageSample(conn: AsyncDuckDBConnection): Promise<void> {
  const temps = ["cw_a_pts", "cw_b_pts"];
  for (const t of [...temps, "cw_a_areas", "cw_b_areas", "cw_pairs"]) {
    await conn.query(`DROP TABLE IF EXISTS ${t}`);
  }

  // Exact per-unit areas (one ST_Area per unit, not per point).
  await conn.query(`CREATE TABLE cw_a_areas AS SELECT fid, ${AREA("geom")} AS area FROM cw_a_keyed`);
  await conn.query(`CREATE TABLE cw_b_areas AS SELECT fid, ${AREA("geom")} AS area FROM cw_b_keyed`);

  await samplePoints(conn, "a");
  await samplePoints(conn, "b");

  // Assign sample points to the other layer with ST_Within in the JOIN — DuckDB's
  // SPATIAL_JOIN (index-based). It pre-reserves memory, so loosen the limit for the
  // duration, as elsewhere in the pipeline. The join is inner: points landing in no
  // other-layer polygon simply don't contribute to any pair (they still count in the
  // per-unit totals). coverage_a/coverage_b come from the symmetric counts.
  const prevMem = (
    (await conn.query("SELECT current_setting('memory_limit') AS v")).toArray()[0] as { v: string }
  ).v;
  await conn.query("SET memory_limit = '999GB'");
  try {
    await conn.query(`--sql
      CREATE TABLE cw_pairs AS
      WITH
      a_total AS (SELECT self_fid AS a_fid, COUNT(*) AS n FROM cw_a_pts GROUP BY self_fid),
      b_total AS (SELECT self_fid AS b_fid, COUNT(*) AS n FROM cw_b_pts GROUP BY self_fid),
      a_hits AS (
        SELECT p.self_fid AS a_fid, o.fid AS b_fid, COUNT(*) AS c
        FROM cw_a_pts p JOIN cw_b_keyed o ON ST_Within(p.pt, o.geom)
        GROUP BY p.self_fid, o.fid
      ),
      b_hits AS (
        SELECT o.fid AS a_fid, p.self_fid AS b_fid, COUNT(*) AS c
        FROM cw_b_pts p JOIN cw_a_keyed o ON ST_Within(p.pt, o.geom)
        GROUP BY o.fid, p.self_fid
      ),
      pair_keys AS (
        SELECT a_fid, b_fid FROM a_hits
        UNION
        SELECT a_fid, b_fid FROM b_hits
      ),
      raw AS (
        SELECT
          k.a_fid, k.b_fid,
          COALESCE(ah.c, 0)::DOUBLE / atot.n * aa.area AS shared_area,
          COALESCE(ah.c, 0)::DOUBLE / atot.n          AS coverage_a,
          COALESCE(bh.c, 0)::DOUBLE / btot.n          AS coverage_b,
          aa.area AS area_a, ba.area AS area_b
        FROM pair_keys k
        JOIN a_total atot ON atot.a_fid = k.a_fid
        JOIN b_total btot ON btot.b_fid = k.b_fid
        JOIN cw_a_areas aa ON aa.fid = k.a_fid
        JOIN cw_b_areas ba ON ba.fid = k.b_fid
        LEFT JOIN a_hits ah ON ah.a_fid = k.a_fid AND ah.b_fid = k.b_fid
        LEFT JOIN b_hits bh ON bh.a_fid = k.a_fid AND bh.b_fid = k.b_fid
      )
      SELECT a_fid, b_fid, shared_area, coverage_a, coverage_b,
             shared_area / NULLIF(area_a + area_b - shared_area, 0) AS iou
      FROM raw
    `);
  } finally {
    await conn.query(`SET memory_limit = '${prevMem}'`);
  }

  for (const t of temps) await conn.query(`DROP TABLE IF EXISTS ${t}`);
}
