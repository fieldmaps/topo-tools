import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { degSqToM2, degToM, metersToDegrees } from "./units";

// Sliver detection. A "sliver" is a near-miss T-junction between two polygons:
// adjacent units that should share an edge but whose coordinates miss, leaving a
// thin gap. Detected with GEOS's coverage validator, ST_CoverageInvalidEdges,
// which returns the boundary EDGES where the coverage is invalid (gaps/overlaps).
// Its tolerance flags gaps NARROWER than the value: a near-miss thinner than this
// is a sliver; wider ones are legitimate gaps, left alone. Detected by default
// (shown like gaps/overlaps). Native and fast — no per-vertex distance blowup, and
// nothing fires inside a single smooth polygon, so no convex-hull artifacts.
//
// The sliver geometry is the actual invalid EDGE (a line tracing exactly where
// the two boundaries fail to meet), rendered as a line. We only buffer the edges
// transiently to cluster them — the gap+overlap pair of one near-miss merges into
// a single sliver — then take the real edges back via intersection.
//
// The coverage validator also flags the boundaries of genuine OVERLAP areas as
// invalid edges. Those are already surfaced as overlap issues, so we subtract the
// overlap regions from the sliver lines to avoid duplicating every overlap as a
// sliver. Real near-miss slivers are open gaps, so they don't lie inside an
// overlap polygon and survive the subtraction.
const SLIVER_NEARMISS_TOL_M = 10; // coverage-validator tolerance: flag gaps narrower than this
const SLIVER_CLUSTER_RADIUS_M = 10; // merge invalid edges within ~this into one sliver (the gap+overlap pair)

// A discrete topology problem in the *input* coverage, surfaced in the issues
// table so the user can click to zoom to it. Issues are computed once at load
// (they're a property of the input, independent of the cleaning sliders).

export interface IssueRow {
  key: string; // "gap-3" / "overlap-7" / "sliver-2" — stable id, also the map feature id
  kind: "gap" | "overlap" | "sliver";
  areaM2: number; // approximate, for display/sorting
  maxWidthM: number; // longer bounding-box dimension, approximate
  units: number[]; // fids involved (overlaps: two units; gaps: none; slivers: one unit)
  bbox: [number, number, number, number];
}

export interface IssuesResult {
  rows: IssueRow[];
  geojson: string; // FeatureCollection of issue polygons, props {key, kind}
}

async function emptyRegions(conn: AsyncDuckDBConnection, table: string, extra = ""): Promise<void> {
  await conn.query(
    `CREATE OR REPLACE TABLE ${table} AS SELECT NULL::BIGINT AS n${extra}, NULL::GEOMETRY AS geom WHERE FALSE`,
  );
}

// Gap regions = enclosed areas not covered by any polygon in the input.
// Computed directly: union all polygons → interior rings of the union ARE the
// gaps → convert each ring back to a polygon via difference against the filled
// exterior. Independent of ST_CoverageClean, so works even when the coverage
// has overlaps or degenerate edges that would trip the cleaner.
async function buildGapRegions(conn: AsyncDuckDBConnection): Promise<void> {
  try {
    await conn.query(`--sql
      CREATE OR REPLACE TABLE tc_gap_regions AS
      WITH
      union_cte AS (
        SELECT ST_Union_Agg(geom) AS u
        FROM layer_01 WHERE geom IS NOT NULL AND NOT ST_IsEmpty(geom)
      ),
      parts AS (
        SELECT (UNNEST(ST_Dump(u))).geom AS poly
        FROM union_cte WHERE u IS NOT NULL
      ),
      holes AS (
        SELECT UNNEST(ST_Dump(
          ST_Difference(ST_MakePolygon(ST_ExteriorRing(poly)), poly)
        )).geom AS geom
        FROM parts WHERE ST_NumInteriorRings(poly) > 0
      )
      SELECT row_number() OVER () AS n, geom
      FROM holes WHERE geom IS NOT NULL AND NOT ST_IsEmpty(geom) AND ST_Area(geom) > 0
    `);
  } catch (e) {
    console.warn("gap-region detection failed; skipping gaps:", e);
    await emptyRegions(conn, "tc_gap_regions");
  }
}

async function buildSliverRegions(conn: AsyncDuckDBConnection): Promise<void> {
  // Scientific-notation DOUBLE literals (tiny degree values; avoids DECIMAL overflow).
  const tol = metersToDegrees(SLIVER_NEARMISS_TOL_M).toExponential();
  const r = metersToDegrees(SLIVER_CLUSTER_RADIUS_M).toExponential();
  try {
    await conn.query(`--sql
      CREATE OR REPLACE TABLE tc_sliver_regions AS
      WITH ie AS (
        -- one geometry holding all invalid edges (clean linestrings)
        SELECT ST_CoverageInvalidEdges_Agg(geom, ${tol}) AS e
        FROM layer_01 WHERE geom IS NOT NULL AND NOT ST_IsEmpty(geom)
      ),
      buf AS (SELECT e, ST_Buffer(e, ${r}) AS bg FROM ie WHERE e IS NOT NULL AND NOT ST_IsEmpty(e)),
      -- cluster the edges (overlapping buffers group the gap+overlap pair),
      -- but keep the ACTUAL edge lines via intersection with each cluster
      clusters AS (SELECT e, (UNNEST(ST_Dump(bg))).geom AS blob FROM buf),
      -- already-detected overlap areas (slightly buffered) — invalid edges that
      -- merely trace these are overlap duplicates, so erase them from the slivers
      ov AS (
        SELECT ST_Buffer(ST_Union_Agg(geom), ${r}) AS g
        FROM tc_overlap_regions WHERE geom IS NOT NULL AND NOT ST_IsEmpty(geom)
      ),
      lines AS (
        SELECT CASE WHEN ov.g IS NOT NULL
                    THEN ST_Difference(ST_Intersection(c.e, c.blob), ov.g)
                    ELSE ST_Intersection(c.e, c.blob) END AS geom
        FROM clusters c LEFT JOIN ov ON TRUE
      )
      SELECT
        ROW_NUMBER() OVER (ORDER BY ST_Length(geom) DESC) AS n,
        geom,
        0.0::DOUBLE AS area_deg2, -- a line has no area
        0.0::DOUBLE AS mic_radius_deg, -- nor a width
        ST_XMin(geom) AS xmin, ST_YMin(geom) AS ymin,
        ST_XMax(geom) AS xmax, ST_YMax(geom) AS ymax
      FROM lines WHERE geom IS NOT NULL AND NOT ST_IsEmpty(geom)
      ORDER BY ST_Length(geom) DESC
    `);
  } catch (e) {
    console.warn("sliver detection failed; skipping slivers:", e);
    await conn.query(`--sql
      CREATE OR REPLACE TABLE tc_sliver_regions AS
      SELECT NULL::BIGINT AS n, NULL::GEOMETRY AS geom,
             NULL::DOUBLE AS area_deg2, NULL::DOUBLE AS mic_radius_deg,
             NULL::DOUBLE AS xmin, NULL::DOUBLE AS ymin,
             NULL::DOUBLE AS xmax, NULL::DOUBLE AS ymax
      WHERE FALSE
    `);
  }
}

// Overlap regions = polygonal pairwise intersections of the input polygons
// (touching borders intersect as lines and are dropped by CollectionExtract).
// Uses bbox predicates instead of ST_Intersects in the JOIN so DuckDB plans
// this as PIECEWISE_MERGE_JOIN rather than SPATIAL_JOIN (which OOMs in WASM).
async function buildOverlapRegions(conn: AsyncDuckDBConnection): Promise<void> {
  try {
    await conn.query(`--sql
      CREATE OR REPLACE TABLE tc_overlap_regions AS
      WITH pairs AS (
        SELECT a.fid AS fa, b.fid AS fb,
               ST_MakeValid(ST_CollectionExtract(ST_Intersection(a.geom, b.geom), 3)) AS geom
        FROM layer_01 a JOIN layer_01 b
          ON a.fid < b.fid
          AND ST_XMax(b.geom) >= ST_XMin(a.geom) AND ST_XMin(b.geom) <= ST_XMax(a.geom)
          AND ST_YMax(b.geom) >= ST_YMin(a.geom) AND ST_YMin(b.geom) <= ST_YMax(a.geom)
          AND ST_Intersects(a.geom, b.geom)
      )
      SELECT row_number() OVER () AS n, fa, fb, geom
      FROM pairs
      WHERE geom IS NOT NULL AND NOT ST_IsEmpty(geom) AND ST_Area(geom) > 0
    `);
  } catch (e) {
    console.warn("overlap detection failed; skipping overlaps:", e);
    await emptyRegions(conn, "tc_overlap_regions", ", NULL::BIGINT AS fa, NULL::BIGINT AS fb");
  }
}

export async function buildIssues(conn: AsyncDuckDBConnection): Promise<IssuesResult> {
  await buildGapRegions(conn);
  await buildOverlapRegions(conn);
  await buildSliverRegions(conn);

  await conn.query(`--sql
    CREATE OR REPLACE TABLE tc_issues AS
    SELECT 'gap-' || n AS key, 'gap' AS kind, ST_Area(geom) AS area_deg,
           (ST_MaximumInscribedCircle(geom)).radius AS mic_radius_deg,
           NULL::BIGINT AS unit_a, NULL::BIGINT AS unit_b, geom,
           ST_XMin(geom) AS xmin, ST_YMin(geom) AS ymin, ST_XMax(geom) AS xmax, ST_YMax(geom) AS ymax
    FROM tc_gap_regions WHERE geom IS NOT NULL AND NOT ST_IsEmpty(geom)
    UNION ALL
    SELECT 'overlap-' || n, 'overlap', ST_Area(geom),
           (ST_MaximumInscribedCircle(geom)).radius,
           fa, fb, geom,
           ST_XMin(geom), ST_YMin(geom), ST_XMax(geom), ST_YMax(geom)
    FROM tc_overlap_regions WHERE geom IS NOT NULL AND NOT ST_IsEmpty(geom)
    UNION ALL
    SELECT 'sliver-' || n, 'sliver', area_deg2, mic_radius_deg,
           NULL::BIGINT, NULL::BIGINT, geom,
           xmin, ymin, xmax, ymax
    FROM tc_sliver_regions WHERE geom IS NOT NULL AND NOT ST_IsEmpty(geom)
  `);

  const meta = await conn.query(`--sql
    SELECT key, kind, area_deg, mic_radius_deg, unit_a, unit_b, xmin, ymin, xmax, ymax
    FROM tc_issues
    ORDER BY
      CASE kind WHEN 'overlap' THEN 0 WHEN 'gap' THEN 1 ELSE 2 END,
      CASE kind WHEN 'overlap' THEN -mic_radius_deg
                WHEN 'gap' THEN mic_radius_deg
                ELSE -mic_radius_deg END
  `);
  const rows: IssueRow[] = (
    meta.toArray() as Array<{
      key: string;
      kind: "gap" | "overlap" | "sliver";
      area_deg: number;
      mic_radius_deg: number;
      unit_a: bigint | number | null;
      unit_b: bigint | number | null;
      xmin: number;
      ymin: number;
      xmax: number;
      ymax: number;
    }>
  ).map((r) => ({
    key: r.key,
    kind: r.kind,
    // Slivers are lines — no area or width; show "—" rather than "0.0 m²".
    areaM2: r.kind === "sliver" ? NaN : degSqToM2(r.area_deg),
    maxWidthM: r.kind === "sliver" ? NaN : 2 * degToM(r.mic_radius_deg),
    units: [r.unit_a, r.unit_b]
      .filter((u): u is bigint | number => u !== null)
      .map((u) => Number(u)),
    bbox: [r.xmin, r.ymin, r.xmax, r.ymax],
  }));

  const gj = await conn.query(`--sql
    SELECT key, kind, ST_AsGeoJSON(geom) AS _geom
    FROM tc_issues WHERE geom IS NOT NULL AND NOT ST_IsEmpty(geom)
  `);
  const features = (gj.toArray() as Array<{ key: string; kind: string; _geom: string }>).map(
    (r) => ({
      type: "Feature",
      geometry: JSON.parse(r._geom),
      properties: { key: r.key, kind: r.kind },
    }),
  );
  return { rows, geojson: JSON.stringify({ type: "FeatureCollection", features }) };
}

// Check which issues are resolved in the current cleaned output (tc_clean).
// Overlaps are always fixed by ST_CoverageClean. For gaps, we test whether a
// representative interior point of the gap polygon is now covered by any cleaned
// polygon — if so, the gap has been merged into a neighbour.
export async function checkFixedIssues(
  conn: AsyncDuckDBConnection,
  rows: IssueRow[],
): Promise<Set<string>> {
  const fixed = new Set<string>();
  rows.filter((r) => r.kind === "overlap").forEach((r) => fixed.add(r.key));

  const hasGaps = rows.some((r) => r.kind === "gap");
  if (!hasGaps) return fixed;

  try {
    const result = await conn.query(`--sql
      SELECT i.key,
        EXISTS(
          SELECT 1 FROM tc_clean c
          WHERE ST_Contains(c.geom, ST_PointOnSurface(i.geom))
        ) AS is_fixed
      FROM tc_issues i WHERE i.kind = 'gap'
    `);
    for (const row of result.toArray() as Array<{ key: string; is_fixed: boolean }>) {
      if (row.is_fixed) fixed.add(row.key);
    }
  } catch (e) {
    console.warn("checkFixedIssues failed; fixed status unavailable:", e);
  }

  return fixed;
}
