import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { UnionFind } from "../unionFind";

export type RelClass =
  | "unchanged"
  | "modified"
  | "relocated"
  | "merge"
  | "split"
  | "complex"
  | "created"
  | "removed";

// Canonical class order + color palette — single source of truth for the
// table toolbar, map fill expression, and legend (all three previously kept
// their own copy of this list).
export const REL_ORDER: RelClass[] = [
  "unchanged",
  "modified",
  "relocated",
  "merge",
  "split",
  "complex",
  "created",
  "removed",
];

export const REL_COLORS: Record<RelClass, string> = {
  unchanged: "#9ec5ab",
  modified: "#e5b250",
  relocated: "#3fb8c4",
  merge: "#5a8fd8",
  split: "#e07550",
  complex: "#b25dab",
  created: "#6cc46c",
  removed: "#d35a5a",
};

export interface ClassifyOptions {
  tauMatch: number;
  tauSame: number;
  linkByCode: boolean;
  linkByName: boolean;
  // Only consulted when both linkByCode and linkByName are true.
  linkMode: "either" | "both";
}

interface PairRow {
  a_fid: number;
  b_fid: number;
  shared_area: number;
  coverage_a: number;
  coverage_b: number;
  iou: number;
  a_code: string | null;
  a_name: string | null;
  b_code: string | null;
  b_name: string | null;
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

const str = (v: unknown): string | null => (v == null ? null : String(v));

// Builds the set of values that appear exactly once in a keyed table's column.
// Non-unique values (shared by multiple polygons) are excluded because they
// can't reliably identify a single unit — matching on them would union all
// polygons sharing that value into one cluster.
function uniqueValues(
  rows: Array<Record<string, unknown>>,
  col: string,
): Set<string> {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const v = str(r[col]);
    if (v != null) counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  const out = new Set<string>();
  for (const [v, n] of counts) if (n === 1) out.add(v);
  return out;
}

// True if a pair's code and/or name match across versions, per the user's
// linkByCode/linkByName/linkMode settings. A value only qualifies when it is
// unique on each side — duplicates (e.g. "No_Pcode") are excluded to prevent
// spurious mass-linking. Called for any touching pair, regardless of coverage.
function identityMatch(
  p: PairRow,
  opts: ClassifyOptions,
  uniqueCodesA: Set<string>,
  uniqueCodesB: Set<string>,
  uniqueNamesA: Set<string>,
  uniqueNamesB: Set<string>,
): boolean {
  if (!opts.linkByCode && !opts.linkByName) return false;
  const codeMatch =
    opts.linkByCode &&
    p.a_code != null &&
    p.a_code === p.b_code &&
    uniqueCodesA.has(p.a_code) &&
    uniqueCodesB.has(p.b_code!);
  const nameMatch =
    opts.linkByName &&
    p.a_name != null &&
    p.a_name === p.b_name &&
    uniqueNamesA.has(p.a_name) &&
    uniqueNamesB.has(p.b_name!);
  if (opts.linkByCode && opts.linkByName) {
    return opts.linkMode === "both" ? codeMatch && nameMatch : codeMatch || nameMatch;
  }
  return codeMatch || nameMatch;
}

export async function stageClassify(
  conn: AsyncDuckDBConnection,
  opts: ClassifyOptions,
): Promise<{ pairs: PairOut[]; singletons: SingletonOut[] }> {
  const { tauMatch, tauSame } = opts;
  const pairs: PairRow[] = (
    await conn.query(`--sql
      SELECT p.*, ak.code AS a_code, ak.name AS a_name, bk.code AS b_code, bk.name AS b_name
      FROM cw_pairs p
      LEFT JOIN cw_a_keyed ak ON ak.fid = p.a_fid
      LEFT JOIN cw_b_keyed bk ON bk.fid = p.b_fid
    `)
  )
    .toArray()
    .map((r: Record<string, unknown>) => ({
      a_fid: num(r.a_fid),
      b_fid: num(r.b_fid),
      shared_area: num(r.shared_area),
      coverage_a: num(r.coverage_a),
      coverage_b: num(r.coverage_b),
      iou: num(r.iou),
      a_code: str(r.a_code),
      a_name: str(r.a_name),
      b_code: str(r.b_code),
      b_name: str(r.b_name),
    }));

  const aRows = (await conn.query("SELECT fid, code, name FROM cw_a_keyed")).toArray() as Array<
    Record<string, unknown>
  >;
  const bRows = (await conn.query("SELECT fid, code, name FROM cw_b_keyed")).toArray() as Array<
    Record<string, unknown>
  >;

  const allA = aRows.map((r) => num(r.fid));
  const allB = bRows.map((r) => num(r.fid));

  // Values that appear exactly once per side — only these are eligible as
  // identity anchors. Duplicates (e.g. "No_Pcode") are excluded.
  const uniqueCodesA = uniqueValues(aRows, "code");
  const uniqueCodesB = uniqueValues(bRows, "code");
  const uniqueNamesA = uniqueValues(aRows, "name");
  const uniqueNamesB = uniqueValues(bRows, "name");

  // Union-find over "a:<fid>" / "b:<fid>". Unmatched fids get their own
  // singleton component. Two-phase when identity linking is on:
  //
  // Phase 1 — Identity: pair A/B fids that share a unique code/name AND have no
  //   other spatial tauMatch connections to third parties. "Claiming" both fids
  //   prevents neighbours from absorbing them into larger clusters.
  //
  //   The "no other spatial connections" guard is critical: when A splits into
  //   B1 (inheriting A's code) + B2 (new code), A connects spatially above
  //   tauMatch to both B1 and B2. If we claimed A↔B1 as an identity pair, B2
  //   would be left disconnected (showing as "created" instead of "split"). By
  //   The "all neighbors covered" guard is critical: when A splits into B1
  //   (inheriting A's code) + B2 (new code), B2 has no identity match. Since
  //   not all of A's spatial neighbors are identity-covered, A is not claimed —
  //   Phase 2 then handles A→B1+B2 correctly as a split.
  //
  //   Conversely, when a region of N shifted units all have 1:1 code matches
  //   (like Arbin, Harasta, Jaramana…), every spatial neighbor of each unit IS
  //   identity-covered, so all N pairs are claimed and the N:M complex cluster
  //   decomposes into N separate 1:1 pairs.
  //
  // Phase 2 — Spatial: union unclaimed fids whose coverage passes tauMatch,
  //   exactly as the original algorithm. Claimed fids are skipped here.
  const uf = new UnionFind();
  for (const fid of allA) uf.add(`a:${fid}`);
  for (const fid of allB) uf.add(`b:${fid}`);

  // Pre-compute which B fids each A fid reaches via tauMatch (and vice versa),
  // and which fids have any identity match at all (used for the coverage check).
  const spatialNeighborsA = new Map<number, Set<number>>();
  const spatialNeighborsB = new Map<number, Set<number>>();
  for (const p of pairs) {
    if (Math.max(p.coverage_a, p.coverage_b) < tauMatch) continue;
    if (!spatialNeighborsA.has(p.a_fid)) spatialNeighborsA.set(p.a_fid, new Set());
    if (!spatialNeighborsB.has(p.b_fid)) spatialNeighborsB.set(p.b_fid, new Set());
    spatialNeighborsA.get(p.a_fid)!.add(p.b_fid);
    spatialNeighborsB.get(p.b_fid)!.add(p.a_fid);
  }

  // A/B fids that have at least one potential identity match — used to decide
  // whether a fid's spatial neighbors are "identity-covered."
  const identityASet = new Set<number>();
  const identityBSet = new Set<number>();
  if (opts.linkByCode || opts.linkByName) {
    for (const p of pairs) {
      if (identityMatch(p, opts, uniqueCodesA, uniqueCodesB, uniqueNamesA, uniqueNamesB)) {
        identityASet.add(p.a_fid);
        identityBSet.add(p.b_fid);
      }
    }
  }

  const passingPairs: Array<PairRow & { rescuedByIdentity: boolean }> = [];
  const claimedA = new Set<number>();
  const claimedB = new Set<number>();

  if (opts.linkByCode || opts.linkByName) {
    for (const p of pairs) {
      if (!identityMatch(p, opts, uniqueCodesA, uniqueCodesB, uniqueNamesA, uniqueNamesB)) continue;
      if (claimedA.has(p.a_fid) || claimedB.has(p.b_fid)) continue;
      // Safe to claim only if every other spatial tauMatch neighbor of A_fid is
      // also identity-covered in B (and vice versa). If any spatial neighbor
      // lacks an identity match, it signals a genuine split/merge — skip the
      // claim and let Phase 2 handle the whole cluster via spatial overlap.
      const aSpatialBFids = spatialNeighborsA.get(p.a_fid) ?? new Set<number>();
      const bSpatialAFids = spatialNeighborsB.get(p.b_fid) ?? new Set<number>();
      const allANeighborsCovered = [...aSpatialBFids].every(
        (bOther) => bOther === p.b_fid || identityBSet.has(bOther),
      );
      const allBNeighborsCovered = [...bSpatialAFids].every(
        (aOther) => aOther === p.a_fid || identityASet.has(aOther),
      );
      if (!allANeighborsCovered || !allBNeighborsCovered) continue;
      claimedA.add(p.a_fid);
      claimedB.add(p.b_fid);
      const spatialAlsoPass = Math.max(p.coverage_a, p.coverage_b) >= tauMatch;
      uf.union(`a:${p.a_fid}`, `b:${p.b_fid}`);
      passingPairs.push({ ...p, rescuedByIdentity: !spatialAlsoPass });
    }
  }

  for (const p of pairs) {
    if (Math.max(p.coverage_a, p.coverage_b) < tauMatch) continue;
    if (claimedA.has(p.a_fid) || claimedB.has(p.b_fid)) continue;
    uf.union(`a:${p.a_fid}`, `b:${p.b_fid}`);
    passingPairs.push({ ...p, rescuedByIdentity: false });
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
  // True only if every edge that connected this cluster was an identity
  // rescue rather than a spatial tauMatch pass. For 1:1 clusters there is
  // exactly one connecting edge, so this is unambiguous; it's irrelevant for
  // larger clusters (merge/split/complex stay classified as today either way).
  const clusterRescuedOnly = new Map<number, boolean>();
  for (const p of passingPairs) {
    const root = uf.find(`a:${p.a_fid}`);
    const id = clusterId.get(root)!;
    const prev = clusterBestIou.get(id) ?? -Infinity;
    if (p.iou > prev) clusterBestIou.set(id, p.iou);
    const prevRescuedOnly = clusterRescuedOnly.get(id) ?? true;
    clusterRescuedOnly.set(id, prevRescuedOnly && p.rescuedByIdentity);
  }

  // Classify each cluster
  const clusterClass = new Map<number, RelClass>();
  for (const [id, { aFids, bFids }] of clusterMembers.entries()) {
    const na = aFids.length;
    const nb = bFids.length;
    let cls: RelClass;
    if (na === 1 && nb === 1) {
      if (clusterRescuedOnly.get(id)) {
        cls = "relocated";
      } else {
        const iou = clusterBestIou.get(id) ?? 0;
        cls = iou >= tauSame ? "unchanged" : "modified";
      }
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
  await rebuildChangelog(conn, tauMatch, tauSame);
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
}

export async function rebuildChangelog(
  conn: AsyncDuckDBConnection,
  tauMatch: number,
  tauSame: number,
): Promise<void> {
  await conn.query("DROP TABLE IF EXISTS cw_changelog");
  await conn.query(`--sql
    CREATE TABLE cw_changelog AS
    SELECT
      ak.code AS code_a,
      ak.name AS name_a,
      bk.code AS code_b,
      bk.name AS name_b,
      p.relationship_class,
      ROUND(p.coverage_a, 3) AS a_in_b,
      ROUND(p.coverage_b, 3) AS b_in_a,
      ROUND(p.iou, 3) AS similarity,
      ${tauMatch} AS threshold_match,
      ${tauSame} AS threshold_unchanged
    FROM cw_pairs_classified p
    LEFT JOIN cw_a_keyed ak ON ak.fid = p.a_fid
    LEFT JOIN cw_b_keyed bk ON bk.fid = p.b_fid

    UNION ALL

    SELECT ak.code AS code_a, ak.name AS name_a,
           NULL AS code_b, NULL AS name_b,
           pc.relationship_class,
           NULL AS a_in_b, NULL AS b_in_a, NULL AS similarity,
           ${tauMatch} AS threshold_match, ${tauSame} AS threshold_unchanged
    FROM cw_polygon_class pc
    JOIN (
      SELECT cluster_id, SUM(CASE WHEN side='b' THEN 1 ELSE 0 END) AS nb
      FROM cw_polygon_class GROUP BY cluster_id
    ) cnt ON cnt.cluster_id = pc.cluster_id
    LEFT JOIN cw_a_keyed ak ON ak.fid = pc.fid
    WHERE pc.side = 'a' AND cnt.nb = 0

    UNION ALL

    SELECT NULL AS code_a, NULL AS name_a,
           bk.code AS code_b, bk.name AS name_b,
           pc.relationship_class,
           NULL AS a_in_b, NULL AS b_in_a, NULL AS similarity,
           ${tauMatch} AS threshold_match, ${tauSame} AS threshold_unchanged
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
