import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { UnionFind } from "../unionFind";

export type RelClass =
  | "unchanged"
  | "modified"
  | "merge"
  | "split"
  | "complex"
  | "created"
  | "removed";

export interface ClassifyOptions {
  tauMatch: number;
  tauSame: number;
}

interface PairRow {
  a_fid: number;
  b_fid: number;
  shared_area: number;
  coverage_a: number;
  coverage_b: number;
  iou: number;
}

interface PairOut extends PairRow {
  cluster_id: number;
  relationship_class: RelClass;
}

interface SingletonOut {
  side: "a" | "b";
  fid: number;
  cluster_id: number;
  relationship_class: RelClass;
}

const num = (v: unknown): number => {
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "number") return v;
  return Number(v);
};

export async function stageClassify(
  conn: AsyncDuckDBConnection,
  { tauMatch, tauSame }: ClassifyOptions,
): Promise<{ pairs: PairOut[]; singletons: SingletonOut[] }> {
  const pairs: PairRow[] = (await conn.query("SELECT * FROM cw_pairs"))
    .toArray()
    .map((r: Record<string, unknown>) => ({
      a_fid: num(r.a_fid),
      b_fid: num(r.b_fid),
      shared_area: num(r.shared_area),
      coverage_a: num(r.coverage_a),
      coverage_b: num(r.coverage_b),
      iou: num(r.iou),
    }));

  const allA: number[] = (await conn.query("SELECT fid FROM cw_a_keyed"))
    .toArray()
    .map((r: Record<string, unknown>) => num(r.fid));
  const allB: number[] = (await conn.query("SELECT fid FROM cw_b_keyed"))
    .toArray()
    .map((r: Record<string, unknown>) => num(r.fid));

  // Union-find over "a:<fid>" / "b:<fid>" — only edges meeting tauMatch
  // contribute. Unmatched fids get their own singleton component.
  const uf = new UnionFind();
  for (const fid of allA) uf.add(`a:${fid}`);
  for (const fid of allB) uf.add(`b:${fid}`);

  const passingPairs: PairRow[] = [];
  for (const p of pairs) {
    if (Math.max(p.coverage_a, p.coverage_b) >= tauMatch) {
      uf.union(`a:${p.a_fid}`, `b:${p.b_fid}`);
      passingPairs.push(p);
    }
  }

  const components = uf.components();
  // Map root key → numeric cluster_id
  const clusterId = new Map<string, number>();
  let nextId = 1;
  for (const root of components.keys()) clusterId.set(root, nextId++);

  // Per-cluster counts and best IoU (for 1:1 unchanged/modified distinction)
  const clusterMembers = new Map<number, { aFids: number[]; bFids: number[] }>();
  for (const [root, members] of components.entries()) {
    const id = clusterId.get(root)!;
    const aFids: number[] = [];
    const bFids: number[] = [];
    for (const m of members) {
      const [side, fidStr] = m.split(":");
      const fid = Number(fidStr);
      if (side === "a") aFids.push(fid);
      else bFids.push(fid);
    }
    clusterMembers.set(id, { aFids, bFids });
  }

  // Best IoU per cluster for the 1:1 IoU check (worst-case: one pair).
  const clusterBestIou = new Map<number, number>();
  for (const p of passingPairs) {
    const root = uf.find(`a:${p.a_fid}`);
    const id = clusterId.get(root)!;
    const prev = clusterBestIou.get(id) ?? -Infinity;
    if (p.iou > prev) clusterBestIou.set(id, p.iou);
  }

  // Classify each cluster
  const clusterClass = new Map<number, RelClass>();
  for (const [id, { aFids, bFids }] of clusterMembers.entries()) {
    const na = aFids.length;
    const nb = bFids.length;
    let cls: RelClass;
    if (na === 1 && nb === 1) {
      const iou = clusterBestIou.get(id) ?? 0;
      cls = iou >= tauSame ? "unchanged" : "modified";
    } else if (na === 1 && nb > 1) {
      cls = "split";
    } else if (na > 1 && nb === 1) {
      cls = "merge";
    } else if (na > 1 && nb > 1) {
      cls = "complex";
    } else if (na === 1 && nb === 0) {
      cls = "removed";
    } else if (na === 0 && nb === 1) {
      cls = "created";
    } else {
      cls = "complex"; // should not happen for connected components, defensive
    }
    clusterClass.set(id, cls);
  }

  // Build pairs out (only passing edges)
  const pairsOut: PairOut[] = passingPairs.map((p) => {
    const id = clusterId.get(uf.find(`a:${p.a_fid}`))!;
    return { ...p, cluster_id: id, relationship_class: clusterClass.get(id)! };
  });

  // Singletons: fids whose cluster has zero on the other side
  const singletonsOut: SingletonOut[] = [];
  for (const [id, { aFids, bFids }] of clusterMembers.entries()) {
    const cls = clusterClass.get(id)!;
    if (bFids.length === 0) {
      for (const fid of aFids) {
        singletonsOut.push({ side: "a", fid, cluster_id: id, relationship_class: cls });
      }
    } else if (aFids.length === 0) {
      for (const fid of bFids) {
        singletonsOut.push({ side: "b", fid, cluster_id: id, relationship_class: cls });
      }
    }
  }

  await writeBack(conn, pairsOut, singletonsOut, clusterMembers, clusterClass);
  return { pairs: pairsOut, singletons: singletonsOut };
}

async function writeBack(
  conn: AsyncDuckDBConnection,
  pairs: PairOut[],
  singletons: SingletonOut[],
  clusterMembers: Map<number, { aFids: number[]; bFids: number[] }>,
  clusterClass: Map<number, RelClass>,
): Promise<void> {
  await conn.query("DROP TABLE IF EXISTS cw_pairs_classified");
  await conn.query("DROP TABLE IF EXISTS cw_polygon_class");

  await conn.query(`--sql
    CREATE TABLE cw_pairs_classified (
      a_fid INTEGER,
      b_fid INTEGER,
      shared_area DOUBLE,
      coverage_a DOUBLE,
      coverage_b DOUBLE,
      iou DOUBLE,
      cluster_id INTEGER,
      relationship_class VARCHAR
    )
  `);

  await conn.query(`--sql
    CREATE TABLE cw_polygon_class (
      side VARCHAR,
      fid INTEGER,
      cluster_id INTEGER,
      relationship_class VARCHAR
    )
  `);

  // Bulk insert via batched VALUES. Limit batch to ~500 rows per insert so the
  // generated SQL stays under DuckDB's reasonable statement-size envelope.
  const BATCH = 500;
  const sqlNum = (n: number) => (Number.isFinite(n) ? n.toString() : "NULL");
  const sqlStr = (s: string) => "'" + s.replace(/'/g, "''") + "'";

  for (let i = 0; i < pairs.length; i += BATCH) {
    const slice = pairs.slice(i, i + BATCH);
    const values = slice
      .map(
        (p) =>
          `(${p.a_fid}, ${p.b_fid}, ${sqlNum(p.shared_area)}, ${sqlNum(p.coverage_a)}, ${sqlNum(
            p.coverage_b,
          )}, ${sqlNum(p.iou)}, ${p.cluster_id}, ${sqlStr(p.relationship_class)})`,
      )
      .join(", ");
    await conn.query(`INSERT INTO cw_pairs_classified VALUES ${values}`);
  }

  // Polygon class: one row per a_fid + one per b_fid, regardless of singleton
  // status — matched fids still need a row so render.ts can join cluster_id
  // onto overlap pieces.
  const polyRows: Array<{ side: "a" | "b"; fid: number; cluster_id: number; cls: RelClass }> = [];
  for (const [id, { aFids, bFids }] of clusterMembers.entries()) {
    const cls = clusterClass.get(id)!;
    for (const fid of aFids) polyRows.push({ side: "a", fid, cluster_id: id, cls });
    for (const fid of bFids) polyRows.push({ side: "b", fid, cluster_id: id, cls });
  }
  for (let i = 0; i < polyRows.length; i += BATCH) {
    const slice = polyRows.slice(i, i + BATCH);
    const values = slice
      .map((p) => `(${sqlStr(p.side)}, ${p.fid}, ${p.cluster_id}, ${sqlStr(p.cls)})`)
      .join(", ");
    await conn.query(`INSERT INTO cw_polygon_class VALUES ${values}`);
  }

  // singletons array not separately written — they're already in cw_polygon_class.
  // Stage 6 (table.ts) reconstructs the singleton rows for the table from
  // cw_polygon_class with NULL on the other side.
  void singletons;

  await conn.query("DROP TABLE IF EXISTS cw_changelog");
  await conn.query(`--sql
    CREATE TABLE cw_changelog AS
    SELECT
      ak.code AS code_a,
      bk.code AS code_b,
      p.relationship_class,
      p.coverage_a AS a_in_b,
      p.coverage_b AS b_in_a,
      p.iou AS similarity
    FROM cw_pairs_classified p
    LEFT JOIN cw_a_keyed ak ON ak.fid = p.a_fid
    LEFT JOIN cw_b_keyed bk ON bk.fid = p.b_fid

    UNION ALL

    SELECT ak.code AS code_a, NULL AS code_b, pc.relationship_class,
           NULL AS a_in_b, NULL AS b_in_a, NULL AS similarity
    FROM cw_polygon_class pc
    JOIN (
      SELECT cluster_id, SUM(CASE WHEN side='b' THEN 1 ELSE 0 END) AS nb
      FROM cw_polygon_class GROUP BY cluster_id
    ) cnt ON cnt.cluster_id = pc.cluster_id
    LEFT JOIN cw_a_keyed ak ON ak.fid = pc.fid
    WHERE pc.side = 'a' AND cnt.nb = 0

    UNION ALL

    SELECT NULL AS code_a, bk.code AS code_b, pc.relationship_class,
           NULL AS a_in_b, NULL AS b_in_a, NULL AS similarity
    FROM cw_polygon_class pc
    JOIN (
      SELECT cluster_id, SUM(CASE WHEN side='a' THEN 1 ELSE 0 END) AS na
      FROM cw_polygon_class GROUP BY cluster_id
    ) cnt ON cnt.cluster_id = pc.cluster_id
    LEFT JOIN cw_b_keyed bk ON bk.fid = pc.fid
    WHERE pc.side = 'b' AND cnt.na = 0

    ORDER BY relationship_class, code_a NULLS LAST, code_b NULLS LAST
  `);
}
