import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { tableToGeoJSON } from "$lib/db/geojson";
import { buildClean, buildInput, buildReducedInput, countRows } from "./clean";
import { deleteVerticesInBox, snapVerticesInBox, type PinchResult } from "./close";
import {
  buildGapRegions,
  buildOverlapRegions,
  checkFixedIssues,
  rebuildSliversAndIssues,
  type IssueKind,
  type IssueRow,
} from "./issues";
import { metersToDegrees, setCentroidLat } from "./units";
import { verifyExport, type ExportCheck } from "./verify";

export type { IssueKind, IssueRow } from "./issues";
export type { ExportCheck } from "./verify";

export type ProgressFn = (stage: number, label: string) => void;

export class PipelineError extends Error {
  constructor(
    message: string,
    public readonly failedStage: number,
  ) {
    super(message);
    this.name = "PipelineError";
  }
}

export interface CleanOptions {
  gapWidthM: number; // primary slider, meters (0 = no gap filling)
  sliverTolM: number; // "Sliver tolerance" slider, meters: DETECTION cutoff only
  // (ST_CoverageInvalidEdges). The clean never snaps, so this does not affect the fix.
}

export interface CleanResult {
  originalGeoJSON: string;
  cleanedGeoJSON: string;
  issues: IssueRow[];
  issuesGeoJSON: string;
  bounds: [number, number, number, number] | null;
  totalCount: number;
  collapsedCount: number;
  fixedKeys: Set<string>;
  // Kinds whose detection query failed (even after retry) and was degraded to
  // an empty table — a 0 count for these means "couldn't check," not "clean."
  detectionFailed: Set<IssueKind>;
  // Independent validation of the exact table that gets exported (tc_clean),
  // run automatically on every clean/reclean. See verify.ts.
  exportCheck: ExportCheck;
}

export interface RecleanResult {
  cleanedGeoJSON: string;
  collapsedCount: number;
  fixedKeys: Set<string>;
  issues: IssueRow[];
  issuesGeoJSON: string;
  detectionFailed: Set<IssueKind>;
  exportCheck: ExportCheck;
}

// Carried from the full run to cheap re-runs.
let totalCount = 0;
let cachedIssues: IssueRow[] = [];
// Gap/overlap detection is static (built once per load), so its failure state
// is carried here for recleanOnly to merge with the live sliver failure state.
let staticFailedKinds = new Set<IssueKind>();

// Run ST_CoverageClean, retrying once against a precision-reduced input if GEOS
// still throws after the snap tolerance has been applied. With snap=1e-10 this is
// a true last resort — SnappingNoder absorbs float jitter before the overlay runs
// in the vast majority of real datasets.
// Returns the input table actually used so callers can reuse it for a subsequent retry.
async function cleanResilient(
  conn: AsyncDuckDBConnection,
  target: string,
  snapDeg: number,
  gapDeg: number,
): Promise<"tc_input" | "tc_input_reduced"> {
  try {
    await buildClean(conn, target, snapDeg, gapDeg, "tc_input");
    return "tc_input";
  } catch (e) {
    console.warn(`${target}: clean failed, retrying with reduced precision:`, e);
    await buildReducedInput(conn);
    await buildClean(conn, target, snapDeg, gapDeg, "tc_input_reduced");
    return "tc_input_reduced";
  }
}

async function computeBounds(
  conn: AsyncDuckDBConnection,
): Promise<[number, number, number, number] | null> {
  try {
    const r = await conn.query(`--sql
      SELECT MIN(ST_XMin(geom)) AS xmin, MIN(ST_YMin(geom)) AS ymin,
             MAX(ST_XMax(geom)) AS xmax, MAX(ST_YMax(geom)) AS ymax
      FROM layer_01 WHERE geom IS NOT NULL
    `);
    const { xmin, ymin, xmax, ymax } = r.toArray()[0] as Record<string, number>;
    if ([xmin, ymin, xmax, ymax].every((v) => Number.isFinite(v))) {
      setCentroidLat((ymin + ymax) / 2);
      return [xmin, ymin, xmax, ymax];
    }
  } catch {
    // fall through to null
  }
  return null;
}

// Re-clean at the current slider values. Primary clean uses snap=1e-10: GEOS's
// SnappingNoder absorbs float jitter (~1e-13 deg on shared boundaries) by snapping
// vertex pairs within tolerance to the same existing coordinate — only jittered
// vertices move, nothing else. snap=0 would skip this and fail with "Result area
// inconsistent with overlay operation" on most real-world coverages.
//
// For crossing-boundary topology (polygon edges that physically cross a neighbour's
// edge, not just a near-miss gap) GEOS collapses the affected polygon to empty rather
// than producing a corrupt result. If that happens, we retry with snap=-1 (auto):
// broader vertex movement but recovers the lost polygons.
// Gap + overlap regions are static (built once per load) and are NOT recomputed.
export async function recleanOnly(
  conn: AsyncDuckDBConnection,
  opts: CleanOptions,
): Promise<RecleanResult> {
  const snapDeg = 1e-10; // SnappingNoder: only moves vertices within 10 µm of a neighbour
  const gapDeg = metersToDegrees(opts.gapWidthM);

  // Re-detect slivers at the new tolerance and rebuild the issues table first, so
  // checkFixedIssues queries a tc_issues consistent with the slider value.
  const issuesRes = await rebuildSliversAndIssues(conn, opts.sliverTolM, staticFailedKinds);
  cachedIssues = issuesRes.rows;

  const inputUsed = await cleanResilient(conn, "tc_clean", snapDeg, gapDeg);

  // Auto-snap fallback: if snap=1e-10 collapsed any polygons (crossing-edge topology),
  // retry with snap=-1. This makes wider vertex moves but recovers lost polygons.
  let kept = await countRows(conn, "tc_clean");
  if (kept < totalCount) {
    console.warn(`${totalCount - kept} polygon(s) collapsed at snap=0; retrying with auto-snap`);
    try {
      await buildClean(conn, "tc_clean", -1, gapDeg, inputUsed);
      kept = await countRows(conn, "tc_clean");
    } catch (e) {
      console.warn("auto-snap retry also failed; keeping snap=0 result:", e);
    }
  }

  const fixedKeys = await checkFixedIssues(conn, cachedIssues);
  const exportCheck = await verifyExport(conn);

  return {
    cleanedGeoJSON: await tableToGeoJSON(conn, "tc_clean", "layer_attr"),
    collapsedCount: Math.max(0, totalCount - kept),
    fixedKeys,
    issues: issuesRes.rows,
    issuesGeoJSON: issuesRes.geojson,
    detectionFailed: issuesRes.failedKinds,
    exportCheck,
  };
}

// Full run from already-loaded layer_01/layer_attr: freeze the input, build the
// aggressive gap reference, enumerate issues (gaps + overlaps), then clean at the
// current width.
export async function runFromLoaded(
  conn: AsyncDuckDBConnection,
  opts: CleanOptions,
  onProgress: ProgressFn,
): Promise<CleanResult> {
  onProgress(2, "Analyzing coverage");
  totalCount = await buildInput(conn);
  if (totalCount === 0) {
    throw new PipelineError("No polygons found to clean.", 2);
  }

  const bounds = await computeBounds(conn);
  const originalGeoJSON = await tableToGeoJSON(conn, "layer_01", null);

  onProgress(3, "Finding gaps, overlaps & slivers");
  // Static region tables (independent of the sliders): gaps + overlaps are a
  // property of the input, built once. Best-effort — failures degrade to an empty
  // region table, never abort the clean (their failure state is recorded instead).
  // Slivers are built inside recleanOnly, since they depend on the (live)
  // sliver-tolerance slider.
  const gapOk = await buildGapRegions(conn);
  const overlapOk = await buildOverlapRegions(conn);
  staticFailedKinds = new Set();
  if (!gapOk) staticFailedKinds.add("gap");
  if (!overlapOk) staticFailedKinds.add("overlap");

  onProgress(4, "Cleaning topology");
  // recleanOnly re-detects slivers at the current tolerance, assembles the issues
  // table, then runs ST_CoverageClean (snap = sliver tolerance).
  let reclean: RecleanResult;
  try {
    reclean = await recleanOnly(conn, opts);
  } catch (e) {
    throw new PipelineError(e instanceof Error ? e.message : String(e), 4);
  }

  return {
    originalGeoJSON,
    cleanedGeoJSON: reclean.cleanedGeoJSON,
    issues: reclean.issues,
    issuesGeoJSON: reclean.issuesGeoJSON,
    bounds,
    totalCount,
    collapsedCount: reclean.collapsedCount,
    fixedKeys: reclean.fixedKeys,
    detectionFailed: reclean.detectionFailed,
    exportCheck: reclean.exportCheck,
  };
}

// ── Sliver fixing by mouth pinch ─────────────────────────────────────────────
//
// The user box-selects a sliver's open mouth and snaps those vertices together
// (snapVerticesInBox), which encloses the thin crack into a gap. That mutates the
// working coverage (layer_01), so we rebuild EVERYTHING downstream — the frozen
// input, the gap + overlap regions (now stale), then re-detect slivers and re-clean.
// The re-clean's gap-fill absorbs the freshly-enclosed gap. Reversibility is a stack
// of layer_01 snapshots (DuckDB tables); undo restores the most recent and re-derives.

const undoStack: string[] = [];
let undoCounter = 0;
const MAX_UNDO = 20;

export interface PinchOutcome {
  ok: boolean;
  reason?: string;
  movedVertices?: number;
  // Present when ok: the refreshed results (the input changed, so originalGeoJSON too).
  result?: RecleanResult & { originalGeoJSON: string };
}

// Full re-derive from the current (possibly edited) layer_01.
async function deriveAll(conn: AsyncDuckDBConnection, opts: CleanOptions): Promise<RecleanResult> {
  totalCount = await buildInput(conn);
  const gapOk = await buildGapRegions(conn);
  const overlapOk = await buildOverlapRegions(conn);
  staticFailedKinds = new Set();
  if (!gapOk) staticFailedKinds.add("gap");
  if (!overlapOk) staticFailedKinds.add("overlap");
  return recleanOnly(conn, opts);
}

async function refreshedResult(
  conn: AsyncDuckDBConnection,
  opts: CleanOptions,
): Promise<RecleanResult & { originalGeoJSON: string }> {
  const reclean = await deriveAll(conn, opts);
  const originalGeoJSON = await tableToGeoJSON(conn, "layer_01", null);
  return { ...reclean, originalGeoJSON };
}

// Shared skeleton for snap and delete: snapshot layer_01, run the vertex operation,
// validate, push to the undo stack, then re-derive. A failed or no-op edit discards
// the snapshot and is returned as {ok:false} without dirtying the undo stack.
async function applyVertexEdit(
  conn: AsyncDuckDBConnection,
  bbox: [number, number, number, number],
  opts: CleanOptions,
  op: (conn: AsyncDuckDBConnection, bbox: [number, number, number, number]) => Promise<PinchResult>,
): Promise<PinchOutcome> {
  const snap = `tc_undo_${undoCounter++}`;
  await conn.query(`CREATE OR REPLACE TABLE ${snap} AS SELECT * FROM layer_01`);

  let res: PinchResult;
  try {
    res = await op(conn, bbox);
  } catch (e) {
    res = { ok: false, reason: e instanceof Error ? e.message : String(e), movedVertices: 0 };
  }
  if (!res.ok) {
    await conn.query(`DROP TABLE IF EXISTS ${snap}`);
    return { ok: false, reason: res.reason };
  }

  undoStack.push(snap);
  while (undoStack.length > MAX_UNDO) {
    await conn.query(`DROP TABLE IF EXISTS ${undoStack.shift()}`);
  }
  return { ok: true, result: await refreshedResult(conn, opts) };
}

// Pinch the vertices inside `bbox` together (snap to their centroid), closing a
// sliver mouth, then re-derive so the existing gap-fill can absorb the resulting gap.
export async function applyPinch(
  conn: AsyncDuckDBConnection,
  bbox: [number, number, number, number],
  opts: CleanOptions,
): Promise<PinchOutcome> {
  return applyVertexEdit(conn, bbox, opts, snapVerticesInBox);
}

// Delete the vertices inside `bbox`, rebuilding affected polygons without them,
// then re-derive. Useful for removing stray/spurious vertices.
export async function applyDelete(
  conn: AsyncDuckDBConnection,
  bbox: [number, number, number, number],
  opts: CleanOptions,
): Promise<PinchOutcome> {
  return applyVertexEdit(conn, bbox, opts, deleteVerticesInBox);
}

// Restore the most recent pre-edit snapshot and re-derive. Null when nothing to undo.
export async function undoEdit(
  conn: AsyncDuckDBConnection,
  opts: CleanOptions,
): Promise<(RecleanResult & { originalGeoJSON: string }) | null> {
  const snap = undoStack.pop();
  if (!snap) return null;
  await conn.query(`CREATE OR REPLACE TABLE layer_01 AS SELECT * FROM ${snap}`);
  await conn.query(`DROP TABLE IF EXISTS ${snap}`);
  return refreshedResult(conn, opts);
}

export function canUndoEdit(): boolean {
  return undoStack.length > 0;
}

// Polygon vertices lying near a detected sliver edge, as a GeoJSON point collection.
// These are the selectable "snap targets" the map shows so the user can box a mouth.
export async function sliverVerticesGeoJSON(
  conn: AsyncDuckDBConnection,
  tolM: number,
): Promise<string> {
  // Show vertices within a few tolerances of a sliver edge (the mouth vertices sit
  // right on the near-miss boundaries).
  const d = metersToDegrees(Math.max(tolM, 1) * 4).toExponential();
  let rows: Array<{ _geom: string }> = [];
  try {
    const r = await conn.query(`--sql
      WITH slu AS (
        SELECT ST_Union_Agg(geom) AS g FROM tc_sliver_regions
        WHERE geom IS NOT NULL AND NOT ST_IsEmpty(geom)
      ),
      nearpoly AS (
        SELECT geom FROM layer_01
        WHERE (SELECT g FROM slu) IS NOT NULL AND ST_DWithin(geom, (SELECT g FROM slu), ${d})
      ),
      rings AS (
        SELECT ST_ExteriorRing((d2).geom) AS ring
        FROM (SELECT UNNEST(ST_Dump(geom)) AS d2 FROM nearpoly)
      ),
      verts AS (
        SELECT UNNEST(list_transform(
          generate_series(1, ST_NPoints(ring)), i -> ST_PointN(ring, i::INTEGER)
        )) AS p FROM rings
      )
      SELECT DISTINCT ST_AsGeoJSON(p) AS _geom
      FROM verts WHERE ST_DWithin(p, (SELECT g FROM slu), ${d})
    `);
    rows = r.toArray() as Array<{ _geom: string }>;
  } catch {
    rows = [];
  }
  const features = rows.map((r) => ({
    type: "Feature",
    geometry: JSON.parse(r._geom),
    properties: {},
  }));
  return JSON.stringify({ type: "FeatureCollection", features });
}

// Drop all undo snapshots (call on new file load).
export async function resetEditUndo(conn: AsyncDuckDBConnection): Promise<void> {
  for (const s of undoStack.splice(0)) await conn.query(`DROP TABLE IF EXISTS ${s}`);
}
