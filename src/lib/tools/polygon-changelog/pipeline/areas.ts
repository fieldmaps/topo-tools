import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";

// Per-pair coverage + IoU. shared_area sums over all overlap pieces tagged with
// the same (a_fid, b_fid) — a single A∩B may decompose into multiple polygon
// parts after ST_CollectionExtract, so a SUM here is the right aggregate.
//
// coverage_a = shared / area(A) — "what fraction of A is covered by B"
// coverage_b = shared / area(B) — "what fraction of B is covered by A"
// iou       = shared / (area(A) + area(B) - shared) — symmetric Jaccard
//
// All three are needed downstream:
//  - max(coverage_a, coverage_b) is the edge weight for tauMatch
//  - iou drives the tauSame threshold inside 1:1 clusters

export async function stageAreas(conn: AsyncDuckDBConnection): Promise<void> {
  await conn.query(`--sql
    CREATE OR REPLACE TABLE cw_a_areas AS
    SELECT fid, ST_Area(ST_Transform(geom, 'EPSG:4326', 'EPSG:8857')) AS area FROM cw_a_keyed
  `);
  await conn.query(`--sql
    CREATE OR REPLACE TABLE cw_b_areas AS
    SELECT fid, ST_Area(ST_Transform(geom, 'EPSG:4326', 'EPSG:8857')) AS area FROM cw_b_keyed
  `);

  await conn.query(`--sql
    CREATE OR REPLACE TABLE cw_pair_areas AS
    SELECT a_fid, b_fid, SUM(ST_Area(ST_Transform(geom, 'EPSG:4326', 'EPSG:8857'))) AS shared_area
    FROM cw_overlap
    GROUP BY a_fid, b_fid
  `);

  await conn.query(`--sql
    CREATE OR REPLACE TABLE cw_pairs AS
    SELECT
      p.a_fid, p.b_fid, p.shared_area,
      p.shared_area / NULLIF(aa.area, 0)                                   AS coverage_a,
      p.shared_area / NULLIF(ba.area, 0)                                   AS coverage_b,
      p.shared_area / NULLIF(aa.area + ba.area - p.shared_area, 0)         AS iou
    FROM cw_pair_areas p
    JOIN cw_a_areas aa ON aa.fid = p.a_fid
    JOIN cw_b_areas ba ON ba.fid = p.b_fid
  `);
}
