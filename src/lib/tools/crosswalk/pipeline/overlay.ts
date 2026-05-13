import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";

// Identity overlay: produces three artefacts
//   cw_overlap (a_fid, b_fid, geom) — A ∩ B per intersecting pair
//   cw_a_only  (a_fid, geom)        — A minus union of overlapping B partners
//   cw_b_only  (b_fid, geom)        — B minus union of overlapping A partners
//
// Polygon parts only — ST_Intersection of two valid polygons can return mixed
// GeometryCollections under nearly-tangent inputs. ST_CollectionExtract(_, 3)
// keeps the polygon parts and drops dangling points/lines; ST_MakeValid then
// recovers a clean geometry.
//
// The partner-union for each side is computed row-wise via ST_Union_Agg
// grouped by the source fid, so each row only unions its few neighbors (typical
// bipartite degree 1–6 for admin-boundary inputs) rather than the whole
// opposite layer. The conservative DuckDB-WASM SPATIAL_JOIN memory limit is
// temporarily widened around this join — same pattern as edge-extender's
// voronoi stage.

const SLIVER_DEFAULT = 1e-12; // ~1 cm² at the equator, in degrees²

export async function stageOverlay(
  conn: AsyncDuckDBConnection,
  sliverEps: number = SLIVER_DEFAULT,
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
