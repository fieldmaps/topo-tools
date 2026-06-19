import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";

// Exact coverage/IoU from the precise overlay geometry (stageOverlayExact). Areas are
// in m² via EPSG:8857 (Equal Earth); the ratios are unit-free.
//
//   coverage_a = area(A∩B) / area(A)
//   coverage_b = area(A∩B) / area(B)
//   iou        = area(A∩B) / (area(A) + area(B) − area(A∩B))
//
// shared_area sums over the pieces of a single A∩B (ST_CollectionExtract can split it
// into multiple polygons). Produces cw_pairs — the same schema stageSample produces,
// so classify.ts is identical for the exact and sampled paths.
const AREA = (g: string) => `ST_Area(ST_Transform(${g}, 'EPSG:4326', 'EPSG:8857'))`;

export async function stageAreas(conn: AsyncDuckDBConnection): Promise<void> {
  for (const t of ["cw_a_areas", "cw_b_areas", "cw_pair_areas", "cw_pairs"]) {
    await conn.query(`DROP TABLE IF EXISTS ${t}`);
  }
  await conn.query(`CREATE TABLE cw_a_areas AS SELECT fid, ${AREA("geom")} AS area FROM cw_a_keyed`);
  await conn.query(`CREATE TABLE cw_b_areas AS SELECT fid, ${AREA("geom")} AS area FROM cw_b_keyed`);

  await conn.query(`--sql
    CREATE TABLE cw_pair_areas AS
    SELECT a_fid, b_fid, SUM(${AREA("geom")}) AS shared_area
    FROM cw_overlap GROUP BY a_fid, b_fid
  `);

  await conn.query(`--sql
    CREATE TABLE cw_pairs AS
    SELECT p.a_fid, p.b_fid, p.shared_area,
           p.shared_area / NULLIF(aa.area, 0)                            AS coverage_a,
           p.shared_area / NULLIF(ba.area, 0)                            AS coverage_b,
           p.shared_area / NULLIF(aa.area + ba.area - p.shared_area, 0)  AS iou
    FROM cw_pair_areas p
    JOIN cw_a_areas aa ON aa.fid = p.a_fid
    JOIN cw_b_areas ba ON ba.fid = p.b_fid
  `);
}
