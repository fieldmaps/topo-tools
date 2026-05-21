import type { AsyncDuckDB, AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { loadFile } from "$lib/db/loader";

// Per-side prefix conventions: cw_a_* for "previous", cw_b_* for "new".
// loadFile produces ${prefix}raw_layer, ${prefix}layer_01, ${prefix}layer_attr;
// we then derive cw_a_keyed (fid, code, name, geom) / cw_b_keyed for the rest of
// the pipeline. The intermediate cw_*_layer_01 / cw_*_layer_attr tables stay
// around because the column-picker UI needs them to enumerate attribute columns,
// and stage 6 (table.ts) joins back to the *_attr tables for any other props.

export async function loadSide(
  db: AsyncDuckDB,
  conn: AsyncDuckDBConnection,
  side: "a" | "b",
  files: File[],
): Promise<void> {
  const prefix = `cw_${side}_`;
  await loadFile(db, conn, files, { prefix });
}

const QIDENT = (s: string) => '"' + s.replace(/"/g, '""') + '"';

export async function buildKeyed(
  conn: AsyncDuckDBConnection,
  side: "a" | "b",
  codeCol: string | null,
  nameCol: string | null,
): Promise<void> {
  const prefix = `cw_${side}_`;
  const codeExpr = codeCol ? `CAST(a.${QIDENT(codeCol)} AS VARCHAR)` : "NULL::VARCHAR";
  const nameExpr = nameCol ? `CAST(a.${QIDENT(nameCol)} AS VARCHAR)` : "NULL::VARCHAR";
  await conn.query(`--sql
    CREATE OR REPLACE TABLE cw_${side}_keyed AS
    SELECT g.fid AS fid,
           ${codeExpr} AS code,
           ${nameExpr} AS name,
           g.geom AS geom
    FROM ${prefix}layer_01 g
    LEFT JOIN ${prefix}layer_attr a ON a.fid = g.fid
    WHERE g.geom IS NOT NULL
  `);
}

export async function dropPriorRun(conn: AsyncDuckDBConnection): Promise<void> {
  // Drop all crosswalk-owned tables from any previous run on the same session
  // so re-running with different inputs starts clean.
  const tables = [
    "cw_a_keyed",
    "cw_b_keyed",
    "cw_overlap",
    "cw_a_only",
    "cw_b_only",
    "cw_a_areas",
    "cw_b_areas",
    "cw_pair_areas",
    "cw_pairs",
    "cw_pairs_classified",
    "cw_polygon_class",
    "cw_changelog",
    "cw_overlay_render",
  ];
  for (const t of tables) await conn.query(`DROP TABLE IF EXISTS ${t}`);
}
