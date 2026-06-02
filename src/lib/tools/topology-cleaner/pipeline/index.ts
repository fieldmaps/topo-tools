import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { tableToGeoJSON } from "$lib/db/geojson";
import { buildClean, buildInput, buildReducedInput, countRows } from "./clean";
import {
  buildGapRegions,
  buildOverlapRegions,
  checkFixedIssues,
  rebuildSliversAndIssues,
  type IssueRow,
} from "./issues";
import { metersToDegrees, setCentroidLat } from "./units";

export type { IssueRow } from "./issues";

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
}

export interface RecleanResult {
  cleanedGeoJSON: string;
  collapsedCount: number;
  fixedKeys: Set<string>;
  issues: IssueRow[];
  issuesGeoJSON: string;
}

// Carried from the full run to cheap re-runs.
let totalCount = 0;
let cachedIssues: IssueRow[] = [];

// Run ST_CoverageClean, retrying once against a precision-reduced input if GEOS
// throws (typically "Result area inconsistent with overlay operation" — float
// jitter in the coverage's internal overlay). Grid-snapping the input removes
// the near-degenerate edges that trip the overlay.
async function cleanResilient(
  conn: AsyncDuckDBConnection,
  target: string,
  snapDeg: number,
  gapDeg: number,
): Promise<void> {
  try {
    await buildClean(conn, target, snapDeg, gapDeg, "tc_input");
  } catch (e) {
    console.warn(`${target}: clean failed, retrying with reduced precision:`, e);
    await buildReducedInput(conn);
    await buildClean(conn, target, snapDeg, gapDeg, "tc_input_reduced");
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

// Re-clean at the current slider values. The clean uses snap=0 deliberately:
// ST_CoverageClean's snapping re-nodes the WHOLE coverage (collateral changes far
// from any issue), and snapping is the only thing that closes near-miss slivers —
// so we don't snap. The clean fixes overlaps + fills gaps (snap=0 touches only the
// genuinely-broken polygons); slivers are DETECTION-ONLY (the sliver-tolerance
// slider drives ST_CoverageInvalidEdges, not the fix). Gap + overlap regions are
// static (built once per load) and are NOT recomputed.
export async function recleanOnly(
  conn: AsyncDuckDBConnection,
  opts: CleanOptions,
): Promise<RecleanResult> {
  const snapDeg = 0; // never snap — see note above (slivers are detection-only)
  const gapDeg = metersToDegrees(opts.gapWidthM);

  // Re-detect slivers at the new tolerance and rebuild the issues table first, so
  // checkFixedIssues queries a tc_issues consistent with the slider value.
  const issuesRes = await rebuildSliversAndIssues(conn, opts.sliverTolM);
  cachedIssues = issuesRes.rows;

  await cleanResilient(conn, "tc_clean", snapDeg, gapDeg);

  const kept = await countRows(conn, "tc_clean");
  const fixedKeys = await checkFixedIssues(conn, cachedIssues);

  return {
    cleanedGeoJSON: await tableToGeoJSON(conn, "tc_clean", "layer_attr"),
    collapsedCount: Math.max(0, totalCount - kept),
    fixedKeys,
    issues: issuesRes.rows,
    issuesGeoJSON: issuesRes.geojson,
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
  // region table, never abort the clean. Slivers are built inside recleanOnly,
  // since they depend on the (live) sliver-tolerance slider.
  await buildGapRegions(conn);
  await buildOverlapRegions(conn);

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
  };
}
