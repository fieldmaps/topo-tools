import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";

// Exact identity overlay: pairwise ST_Intersection / ST_Difference via GEOS OverlayNG.
// Produces cw_overlap (a_fid, b_fid, geom), cw_a_only (a_fid, geom), cw_b_only
// (b_fid, geom) — the precise A∩B, A∖B, B∖A geometry. stageAreas turns these into the
// exact coverage/IoU ratios in cw_pairs.
//
// This is the preferred path: when it succeeds the overlap is exact. But GEOS
// OverlayNG compiled to WASM has a floating-point robustness bug — it throws
// "found non-noded intersection" on the near-coincident shared boundaries between two
// independently-digitized versions of the same coverage (the same engine succeeds
// natively). When that happens the caller falls back to point sampling (sample.ts).
// See the project memory reference-wasm-overlayng-fp-divergence.

const SLIVER = 1e-12; // drop intersection/difference crumbs below ~1 cm² (in deg²)

export async function stageOverlayExact(conn: AsyncDuckDBConnection): Promise<void> {
  await conn.query(`DROP TABLE IF EXISTS cw_overlap`);
  await conn.query(`DROP TABLE IF EXISTS cw_a_only`);
  await conn.query(`DROP TABLE IF EXISTS cw_b_only`);

  // The partner-union CTEs use ST_Intersects in a JOIN (SPATIAL_JOIN), which
  // pre-reserves memory; loosen the limit for the stage and restore after.
  const prevMem = (
    (await conn.query("SELECT current_setting('memory_limit') AS v")).toArray()[0] as { v: string }
  ).v;
  await conn.query("SET memory_limit = '999GB'");
  try {
    await conn.query(`--sql
      CREATE TABLE cw_overlap AS
      SELECT a.fid AS a_fid, b.fid AS b_fid,
             ST_MakeValid(ST_CollectionExtract(ST_Intersection(a.geom, b.geom), 3)) AS geom
      FROM cw_a_keyed a JOIN cw_b_keyed b ON ST_Intersects(a.geom, b.geom)
    `);
    await conn.query(`DELETE FROM cw_overlap WHERE geom IS NULL OR ST_IsEmpty(geom) OR ST_Area(geom) < ${SLIVER}`);

    await conn.query(`--sql
      CREATE TABLE cw_a_only AS
      WITH partners AS (
        SELECT a.fid AS a_fid, ST_Union_Agg(b.geom) AS pgeom
        FROM cw_a_keyed a JOIN cw_b_keyed b ON ST_Intersects(a.geom, b.geom)
        GROUP BY a.fid
      )
      SELECT a.fid AS a_fid,
             ST_CollectionExtract(ST_MakeValid(
               CASE WHEN p.pgeom IS NULL THEN a.geom ELSE ST_Difference(a.geom, p.pgeom) END), 3) AS geom
      FROM cw_a_keyed a LEFT JOIN partners p ON p.a_fid = a.fid
    `);
    await conn.query(`DELETE FROM cw_a_only WHERE geom IS NULL OR ST_IsEmpty(geom) OR ST_Area(geom) < ${SLIVER}`);

    await conn.query(`--sql
      CREATE TABLE cw_b_only AS
      WITH partners AS (
        SELECT b.fid AS b_fid, ST_Union_Agg(a.geom) AS pgeom
        FROM cw_b_keyed b JOIN cw_a_keyed a ON ST_Intersects(b.geom, a.geom)
        GROUP BY b.fid
      )
      SELECT b.fid AS b_fid,
             ST_CollectionExtract(ST_MakeValid(
               CASE WHEN p.pgeom IS NULL THEN b.geom ELSE ST_Difference(b.geom, p.pgeom) END), 3) AS geom
      FROM cw_b_keyed b LEFT JOIN partners p ON p.b_fid = b.fid
    `);
    await conn.query(`DELETE FROM cw_b_only WHERE geom IS NULL OR ST_IsEmpty(geom) OR ST_Area(geom) < ${SLIVER}`);
  } finally {
    await conn.query(`SET memory_limit = '${prevMem}'`);
  }
}
