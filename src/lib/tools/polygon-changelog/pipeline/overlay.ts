import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";

// Identity overlay: produces three artefacts
//   cw_overlap (a_fid, b_fid, geom) — A ∩ B per intersecting pair
//   cw_a_only  (a_fid, geom)        — A minus union of overlapping B partners
//   cw_b_only  (b_fid, geom)        — B minus union of overlapping A partners
//
// Fast path (stageOverlay): pairwise ST_Intersection / ST_Difference — fast
// for clean inputs but fails when two polygons from opposite layers share a
// partially-overlapping collinear edge ("found non-noded intersection").
//
// Robust fallback (stageOverlayNoded): nodes all boundaries from both layers
// together via ST_Node + ST_Polygonize, then reassigns atomic pieces to A/B
// via point-in-polygon. Structurally immune to non-noded intersection errors.

const SLIVER_DEFAULT = 1e-12; // ~1 cm² at the equator, in degrees²

async function stageOverlay(
  conn: AsyncDuckDBConnection,
  sliverEps: number,
): Promise<void> {
  await conn.query(`DROP TABLE IF EXISTS cw_overlap`);
  await conn.query(`DROP TABLE IF EXISTS cw_a_only`);
  await conn.query(`DROP TABLE IF EXISTS cw_b_only`);

  // Loosen the SPATIAL_JOIN memory limit for the duration of this stage; the
  // partner-CTE plan trips the conservative default on dense layers.
  const memRow = (
    await conn.query("SELECT current_setting('memory_limit') AS v")
  ).toArray()[0] as { v: string };
  const prevMem = memRow.v;
  await conn.query("SET memory_limit = '999GB'");

  try {
    await conn.query(`--sql
      CREATE OR REPLACE TABLE cw_overlap AS
      SELECT a.fid AS a_fid,
             b.fid AS b_fid,
             ST_MakeValid(ST_CollectionExtract(ST_Intersection(a.geom, b.geom), 3)) AS geom
      FROM cw_a_keyed a JOIN cw_b_keyed b
        ON ST_Intersects(a.geom, b.geom)
    `);
    await conn.query(`--sql
      DELETE FROM cw_overlap
      WHERE geom IS NULL OR ST_IsEmpty(geom) OR ST_Area(geom) < ${sliverEps}
    `);

    await conn.query(`--sql
      CREATE OR REPLACE TABLE cw_a_only AS
      WITH partners AS (
        SELECT a.fid AS a_fid, ST_Union_Agg(b.geom) AS pgeom
        FROM cw_a_keyed a JOIN cw_b_keyed b ON ST_Intersects(a.geom, b.geom)
        GROUP BY a.fid
      )
      SELECT a.fid AS a_fid,
             ST_CollectionExtract(
               ST_MakeValid(
                 CASE WHEN p.pgeom IS NULL THEN a.geom ELSE ST_Difference(a.geom, p.pgeom) END
               ),
               3
             ) AS geom
      FROM cw_a_keyed a LEFT JOIN partners p ON p.a_fid = a.fid
    `);
    await conn.query(`--sql
      DELETE FROM cw_a_only
      WHERE geom IS NULL OR ST_IsEmpty(geom) OR ST_Area(geom) < ${sliverEps}
    `);

    await conn.query(`--sql
      CREATE OR REPLACE TABLE cw_b_only AS
      WITH partners AS (
        SELECT b.fid AS b_fid, ST_Union_Agg(a.geom) AS pgeom
        FROM cw_b_keyed b JOIN cw_a_keyed a ON ST_Intersects(b.geom, a.geom)
        GROUP BY b.fid
      )
      SELECT b.fid AS b_fid,
             ST_CollectionExtract(
               ST_MakeValid(
                 CASE WHEN p.pgeom IS NULL THEN b.geom ELSE ST_Difference(b.geom, p.pgeom) END
               ),
               3
             ) AS geom
      FROM cw_b_keyed b LEFT JOIN partners p ON p.b_fid = b.fid
    `);
    await conn.query(`--sql
      DELETE FROM cw_b_only
      WHERE geom IS NULL OR ST_IsEmpty(geom) OR ST_Area(geom) < ${sliverEps}
    `);
  } finally {
    await conn.query(`SET memory_limit = '${prevMem}'`);
  }
}

// Noded overlay: ST_Node all boundaries from both layers together, then
// ST_Polygonize to get atomic pieces, then point-in-polygon assign each
// piece to A and/or B. Structurally avoids non-noded intersection errors
// because all edge crossings are resolved before any polygon operation runs.
async function stageOverlayNoded(
  conn: AsyncDuckDBConnection,
  sliverEps: number,
): Promise<void> {
  await conn.query(`DROP TABLE IF EXISTS cw_overlap`);
  await conn.query(`DROP TABLE IF EXISTS cw_a_only`);
  await conn.query(`DROP TABLE IF EXISTS cw_b_only`);

  const memRow = (
    await conn.query("SELECT current_setting('memory_limit') AS v")
  ).toArray()[0] as { v: string };
  const prevMem = memRow.v;
  await conn.query("SET memory_limit = '999GB'");

  try {
    // Node all A and B boundaries together, then polygonize into atomic pieces.
    await conn.query(`--sql
      CREATE OR REPLACE TABLE cw_pieces AS
      WITH
      all_bounds AS (
        SELECT ST_Boundary(geom) AS geom FROM cw_a_keyed
        UNION ALL
        SELECT ST_Boundary(geom) AS geom FROM cw_b_keyed
      ),
      noded AS (SELECT ST_Node(ST_Collect(list(geom))) AS geom FROM all_bounds),
      raw AS (
        SELECT UNNEST(ST_Dump(ST_Polygonize(list(geom)))).geom AS geom FROM noded
      )
      SELECT ROW_NUMBER() OVER () AS pid, geom FROM raw
    `);

    // Interior point per piece (computed once; reused for both A and B joins).
    await conn.query(`--sql
      CREATE OR REPLACE TABLE cw_piece_pts AS
      SELECT pid, ST_PointOnSurface(geom) AS pt FROM cw_pieces
    `);

    // Assign each piece to its A polygon (bbox prefilter → PIECEWISE_MERGE_JOIN,
    // avoids the SPATIAL_JOIN memory limit).
    await conn.query(`--sql
      CREATE OR REPLACE TABLE cw_piece_a AS
      SELECT pp.pid, a.fid AS a_fid
      FROM cw_piece_pts pp
      JOIN cw_a_keyed a
        ON ST_X(pp.pt) >= ST_XMin(a.geom)
       AND ST_X(pp.pt) <= ST_XMax(a.geom)
       AND ST_Y(pp.pt) >= ST_YMin(a.geom)
       AND ST_Y(pp.pt) <= ST_YMax(a.geom)
       AND ST_Within(pp.pt, a.geom)
    `);

    await conn.query(`--sql
      CREATE OR REPLACE TABLE cw_piece_b AS
      SELECT pp.pid, b.fid AS b_fid
      FROM cw_piece_pts pp
      JOIN cw_b_keyed b
        ON ST_X(pp.pt) >= ST_XMin(b.geom)
       AND ST_X(pp.pt) <= ST_XMax(b.geom)
       AND ST_Y(pp.pt) >= ST_YMin(b.geom)
       AND ST_Y(pp.pt) <= ST_YMax(b.geom)
       AND ST_Within(pp.pt, b.geom)
    `);

    // Intersection: pieces belonging to both A and B.
    await conn.query(`--sql
      CREATE OR REPLACE TABLE cw_overlap AS
      SELECT pa.a_fid, pb.b_fid, ST_MakeValid(ST_Union_Agg(p.geom)) AS geom
      FROM cw_pieces p
      JOIN cw_piece_a pa ON p.pid = pa.pid
      JOIN cw_piece_b pb ON p.pid = pb.pid
      GROUP BY pa.a_fid, pb.b_fid
    `);
    await conn.query(`--sql
      DELETE FROM cw_overlap
      WHERE geom IS NULL OR ST_IsEmpty(geom) OR ST_Area(geom) < ${sliverEps}
    `);

    // A-only: pieces inside A but outside B.
    await conn.query(`--sql
      CREATE OR REPLACE TABLE cw_a_only AS
      SELECT pa.a_fid, ST_MakeValid(ST_Union_Agg(p.geom)) AS geom
      FROM cw_pieces p
      JOIN cw_piece_a pa ON p.pid = pa.pid
      LEFT JOIN cw_piece_b pb ON p.pid = pb.pid
      WHERE pb.pid IS NULL
      GROUP BY pa.a_fid
    `);
    await conn.query(`--sql
      DELETE FROM cw_a_only
      WHERE geom IS NULL OR ST_IsEmpty(geom) OR ST_Area(geom) < ${sliverEps}
    `);

    // B-only: pieces inside B but outside A.
    await conn.query(`--sql
      CREATE OR REPLACE TABLE cw_b_only AS
      SELECT pb.b_fid, ST_MakeValid(ST_Union_Agg(p.geom)) AS geom
      FROM cw_pieces p
      JOIN cw_piece_b pb ON p.pid = pb.pid
      LEFT JOIN cw_piece_a pa ON p.pid = pa.pid
      WHERE pa.pid IS NULL
      GROUP BY pb.b_fid
    `);
    await conn.query(`--sql
      DELETE FROM cw_b_only
      WHERE geom IS NULL OR ST_IsEmpty(geom) OR ST_Area(geom) < ${sliverEps}
    `);
  } finally {
    await conn.query(`SET memory_limit = '${prevMem}'`);
    for (const t of ["cw_pieces", "cw_piece_pts", "cw_piece_a", "cw_piece_b"]) {
      await conn.query(`DROP TABLE IF EXISTS ${t}`);
    }
  }
}

// Try the fast pairwise path; fall back to the noded approach if GEOS throws
// (typically "found non-noded intersection" from partially-overlapping collinear
// edges in the input shapefiles — a structural issue that precision reduction
// cannot fix).
export async function stageOverlayResilient(
  conn: AsyncDuckDBConnection,
  sliverEps: number = SLIVER_DEFAULT,
): Promise<void> {
  try {
    await stageOverlay(conn, sliverEps);
  } catch (firstErr) {
    console.warn("overlay fast path failed, retrying with noded approach:", firstErr);
    await stageOverlayNoded(conn, sliverEps);
  }
}
