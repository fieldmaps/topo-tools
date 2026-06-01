import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { tableToGeoJSON } from "$lib/db/geojson";
import { buildClean, buildInput, buildReducedInput, countRows } from "./clean";
import { buildIssues, checkFixedIssues, type IssueRow } from "./issues";
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
  snappingM: number; // advanced slider, meters (-1 = auto)
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

// Re-clean at the current slider values. Cheap: a single ST_CoverageClean
// against the frozen tc_input. The issues table is static (a property of the
// input) so it is NOT recomputed here.
export async function recleanOnly(
  conn: AsyncDuckDBConnection,
  opts: CleanOptions,
): Promise<RecleanResult> {
  const snapDeg = metersToDegrees(opts.snappingM);
  const gapDeg = metersToDegrees(opts.gapWidthM);

  await cleanResilient(conn, "tc_clean", snapDeg, gapDeg);

  const kept = await countRows(conn, "tc_clean");
  const fixedKeys = await checkFixedIssues(conn, cachedIssues);
  return {
    cleanedGeoJSON: await tableToGeoJSON(conn, "tc_clean", "layer_attr"),
    collapsedCount: Math.max(0, totalCount - kept),
    fixedKeys,
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

  onProgress(3, "Finding gaps, overlaps & notches");
  // Enumerate discrete gap + overlap issues for the table. Best-effort: internal
  // failures degrade to fewer/no issues, never abort the clean.
  let issues: IssueRow[] = [];
  let issuesGeoJSON = '{"type":"FeatureCollection","features":[]}';
  try {
    const res = await buildIssues(conn);
    issues = res.rows;
    issuesGeoJSON = res.geojson;
  } catch (e) {
    console.warn("issue enumeration failed; table will be empty:", e);
  }
  cachedIssues = issues;

  onProgress(4, "Cleaning topology");
  let reclean: RecleanResult;
  try {
    reclean = await recleanOnly(conn, opts);
  } catch (e) {
    throw new PipelineError(e instanceof Error ? e.message : String(e), 4);
  }

  return {
    originalGeoJSON,
    cleanedGeoJSON: reclean.cleanedGeoJSON,
    issues,
    issuesGeoJSON,
    bounds,
    totalCount,
    collapsedCount: reclean.collapsedCount,
    fixedKeys: reclean.fixedKeys,
  };
}
