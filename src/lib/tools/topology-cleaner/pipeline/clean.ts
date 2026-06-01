import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";

// The topology-cleaner pipeline. Reads the loader-owned `layer_01` (fid, geom)
// + `layer_attr` tables, then runs DuckDB spatial's ST_CoverageClean over the
// whole coverage. ST_CoverageClean is a scalar over a GEOMETRY[] that returns a
// collection in the SAME order as the input list, so we freeze the input order
// once (tc_input) and rejoin cleaned elements to their fid by the top-level
// dump-path index.

// DuckDB accepts scientific notation in numeric literals, but format defensively.
function fmt(n: number): string {
  return Number.isFinite(n) ? n.toString() : "-1";
}

// Build the frozen input list ONCE per load. Both array_agg's share the same
// ORDER BY fid in one SELECT so geoms[i] ↔ fids[i] — the explicit ordering is
// load-bearing because preserve_insertion_order=false is set globally.
// Returns the feature count (length of the list).
export async function buildInput(conn: AsyncDuckDBConnection): Promise<number> {
  await conn.query(`--sql
    CREATE OR REPLACE TABLE tc_input AS
    SELECT
      array_agg(geom ORDER BY fid)::GEOMETRY[] AS geoms,
      array_agg(fid  ORDER BY fid)             AS fids
    FROM layer_01
    WHERE geom IS NOT NULL AND NOT ST_IsEmpty(geom)
  `);
  const r = await conn.query("SELECT COALESCE(len(fids), 0) AS n FROM tc_input");
  return Number((r.toArray()[0] as { n: bigint | number }).n ?? 0);
}

// Run ST_CoverageClean and explode the resulting collection back to one row per
// input feature. We key on the top-level dump path index (s.path[1], 1-based),
// regrouping a cleaned MultiPolygon element's parts ([2,1],[2,2]) back to one
// fid with a per-element (tiny) ST_Union_Agg — never a global union. ST_Dump
// drops EMPTY elements, so collapsed polygons simply don't appear in the output
// (the caller derives the collapsed count from the row delta).
//
// `snapDeg`/`gapDeg` are already in degrees (see units.ts); -1 = auto snapping,
// 0 = no gap filling. `inputTable` is the frozen list to clean (tc_input, or the
// precision-reduced tc_input_reduced on the robustness-retry path).
export async function buildClean(
  conn: AsyncDuckDBConnection,
  targetTable: string,
  snapDeg: number,
  gapDeg: number,
  inputTable = "tc_input",
): Promise<void> {
  await conn.query(`--sql
    CREATE OR REPLACE TABLE ${targetTable} AS
    WITH cleaned AS (
      SELECT fids, ST_CoverageClean(geoms, ${fmt(snapDeg)}, ${fmt(gapDeg)}) AS coll
      FROM ${inputTable}
    ),
    dumped AS (
      SELECT fids, UNNEST(ST_Dump(coll)) AS s FROM cleaned
    )
    SELECT fids[s.path[1]] AS fid, ST_MakeValid(ST_Union_Agg(s.geom)) AS geom
    FROM dumped
    GROUP BY fids[s.path[1]]
  `);
}

// Precision-reduced copy of the frozen input, built lazily for the clean's
// robustness retry: snapping coordinates to a grid removes the float jitter that
// makes ST_CoverageClean's internal overlay throw on some coverages.
export async function buildReducedInput(conn: AsyncDuckDBConnection): Promise<void> {
  await conn.query(`--sql
    CREATE OR REPLACE TABLE tc_input_reduced AS
    SELECT
      array_agg(ST_MakeValid(ST_ReducePrecision(geom, 1e-8)) ORDER BY fid)::GEOMETRY[] AS geoms,
      array_agg(fid ORDER BY fid)                                                       AS fids
    FROM layer_01
    WHERE geom IS NOT NULL AND NOT ST_IsEmpty(geom)
  `);
}

// Count rows in a cleaned table (post-explode) for the collapsed-feature warning.
export async function countRows(
  conn: AsyncDuckDBConnection,
  table: string,
): Promise<number> {
  const r = await conn.query(
    `SELECT COUNT(*) AS n FROM ${table} WHERE geom IS NOT NULL AND NOT ST_IsEmpty(geom)`,
  );
  return Number((r.toArray()[0] as { n: bigint | number }).n ?? 0);
}
