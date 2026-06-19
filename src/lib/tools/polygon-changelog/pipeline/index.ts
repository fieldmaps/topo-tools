import type { AsyncDuckDB, AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { buildKeyed, dropPriorRun, loadSide } from "./load";
import { stageOverlayExact } from "./overlay";
import { stageAreas } from "./areas";
import { stageSample } from "./sample";
import { stageClassify, REL_ORDER, REL_COLORS, type RelClass } from "./classify";
import { stageRender, buildOverlayGeoJSON, buildOutlineGeoJSON, computeBounds } from "./render";
import { stageTable, type TableRow } from "./table";

export type ProgressFn = (stage: number, label: string) => void;

// Which overlap method produced the result: exact geometric intersection, or the
// point-sampling fallback used when exact throws under the WASM OverlayNG bug.
export type ComparisonMethod = "exact" | "sampling";

export class PipelineError extends Error {
  constructor(
    message: string,
    public readonly failedStage: number,
  ) {
    super(message);
    this.name = "PipelineError";
  }
}

export interface PipelineOptions {
  tauMatch: number;
  tauSame: number;
  aCodeCol: string[];
  aNameCol: string | null;
  bCodeCol: string[];
  bNameCol: string | null;
  linkByCode: boolean;
  linkByName: boolean;
  linkMode: "either" | "both";
}

export interface PipelineResult {
  overlayGeoJSON: string;
  outlineAGeoJSON: string;
  outlineBGeoJSON: string;
  tableRows: TableRow[];
  bounds: [number, number, number, number] | null;
  // Set on a full run; undefined for reclassify-only (overlap unchanged).
  method?: ComparisonMethod;
}

const STAGE_LABELS = [
  "Loading sources",
  "Building keyed layers",
  "Measuring overlap",
  "Classifying clusters",
  "Rendering result",
];

export function stageLabel(i: number): string {
  return STAGE_LABELS[i - 1] ?? "";
}

export async function runFromLoaded(
  conn: AsyncDuckDBConnection,
  opts: PipelineOptions,
  onProgress: ProgressFn,
): Promise<PipelineResult> {
  let stage = 0;
  try {
    stage = 2;
    onProgress(2, "Building keyed layers");
    await buildKeyed(conn, "a", opts.aCodeCol, opts.aNameCol);
    await buildKeyed(conn, "b", opts.bCodeCol, opts.bNameCol);

    stage = 3;
    // Prefer exact geometric overlap; fall back to point sampling only if GEOS
    // OverlayNG throws under the WASM floating-point bug (near-coincident edges).
    let method: ComparisonMethod;
    try {
      onProgress(3, "Measuring overlap (exact)");
      await stageOverlayExact(conn);
      await stageAreas(conn);
      method = "exact";
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`exact overlay failed (WASM OverlayNG); falling back to point sampling: ${msg}`);
      onProgress(3, "Measuring overlap (sampling)");
      await stageSample(conn);
      method = "sampling";
    }

    stage = 4;
    onProgress(4, "Classifying clusters");
    await stageClassify(conn, {
      tauMatch: opts.tauMatch,
      tauSame: opts.tauSame,
      linkByCode: opts.linkByCode,
      linkByName: opts.linkByName,
      linkMode: opts.linkMode,
    });

    stage = 5;
    onProgress(5, "Rendering result");
    await stageRender(conn);
    const [overlayGeoJSON, outlineAGeoJSON, outlineBGeoJSON, tableRows, bounds] = await Promise.all(
      [
        buildOverlayGeoJSON(conn),
        buildOutlineGeoJSON(conn, "a"),
        buildOutlineGeoJSON(conn, "b"),
        stageTable(conn),
        computeBounds(conn),
      ],
    );

    return { overlayGeoJSON, outlineAGeoJSON, outlineBGeoJSON, tableRows, bounds, method };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new PipelineError(msg, stage);
  }
}

// Re-runs only the classify → render path. Used when the user moves the
// threshold sliders: geometry hasn't changed, only how clusters are labeled.
export async function reclassifyOnly(
  conn: AsyncDuckDBConnection,
  opts: PipelineOptions,
): Promise<PipelineResult> {
  await stageClassify(conn, {
    tauMatch: opts.tauMatch,
    tauSame: opts.tauSame,
    linkByCode: opts.linkByCode,
    linkByName: opts.linkByName,
    linkMode: opts.linkMode,
  });
  await stageRender(conn);
  const [overlayGeoJSON, outlineAGeoJSON, outlineBGeoJSON, tableRows, bounds] = await Promise.all([
    buildOverlayGeoJSON(conn),
    buildOutlineGeoJSON(conn, "a"),
    buildOutlineGeoJSON(conn, "b"),
    stageTable(conn),
    computeBounds(conn),
  ]);
  return { overlayGeoJSON, outlineAGeoJSON, outlineBGeoJSON, tableRows, bounds };
}

// Full load + run, used on the initial "Run" button click after both files are
// dropped. Splits stage 1 (load) into A and B sub-steps for nicer progress UX.
export async function runPipeline(
  db: AsyncDuckDB,
  conn: AsyncDuckDBConnection,
  filesA: File[],
  filesB: File[],
  opts: PipelineOptions,
  onProgress: ProgressFn,
): Promise<PipelineResult> {
  try {
    await dropPriorRun(conn);
    onProgress(1, "Loading Version A");
    await loadSide(db, conn, "a", filesA);
    onProgress(1, "Loading Version B");
    await loadSide(db, conn, "b", filesB);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new PipelineError(msg, 1);
  }
  return runFromLoaded(conn, opts, onProgress);
}

export type { TableRow, RelClass };
export { REL_ORDER, REL_COLORS };
