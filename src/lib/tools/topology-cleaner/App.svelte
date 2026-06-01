<script lang="ts">
  import DownloadMenu from "$lib/components/DownloadMenu.svelte";
  import DropZone from "$lib/components/DropZone.svelte";
  import { duckdbState, initDuckDB } from "$lib/db/duckdb.svelte";
  import { loadFile } from "$lib/db/loader";
  import { onMount, untrack } from "svelte";
  import IssuesTable from "./IssuesTable.svelte";
  import MapView from "./MapView.svelte";
  import { PipelineError, recleanOnly, runFromLoaded, type IssueRow } from "./pipeline";

  const STAGE_LABELS = [
    "Load file",
    "Analyze coverage",
    "Find gaps, overlaps & slivers",
    "Clean topology",
  ];

  // Input
  let files = $state<File[]>([]);
  let loaded = $state(false);
  let loading = $state(false);
  let loadError = $state<string | null>(null);

  // Sliders (meters). gapWidthM=0 → no gap filling. sliverTolM is the unified
  // near-miss tolerance: it both detects slivers and is the ST_CoverageClean snap
  // distance that closes them (0 → slivers off, no snapping).
  let gapWidthM = $state(0);
  const SLIVER_TOL_DEFAULT_M = 1;
  const SLIVER_TOL_MAX_M = 50;
  let sliverTolM = $state(SLIVER_TOL_DEFAULT_M);

  // Round x up to the nearest "nice" number (1/2/5 × 10^n).
  function niceNum(x: number): number {
    if (x <= 0) return 1;
    const mag = Math.pow(10, Math.floor(Math.log10(x)));
    const frac = x / mag;
    return (frac <= 1 ? 1 : frac <= 2 ? 2 : frac <= 5 ? 5 : 10) * mag;
  }

  function fmtGap(m: number): string {
    if (m === 0) return "none";
    if (m >= 1000) return `${(m / 1000).toFixed(1)} km`;
    if (m >= 1) return `${Number.isInteger(m) ? m : m.toFixed(m < 10 ? 2 : 1)} m`;
    if (m >= 0.01) return `${(m * 100).toFixed(1)} cm`;
    return `${(m * 1000).toFixed(1)} mm`;
  }

  // Auto-max: 2× the widest gap in the input, rounded to a nice number.
  const autoMaxGapM = $derived.by(() => {
    const widths = issues
      .filter((r) => r.kind === "gap")
      .map((r) => r.maxWidthM)
      .filter((w) => w > 0);
    if (widths.length === 0) return 100;
    return niceNum(Math.max(...widths) * 2);
  });

  const gapMaxM = $derived(autoMaxGapM);
  const gapStepM = $derived(niceNum(gapMaxM / 100));

  // Clamp gapWidthM if the max drops below it.
  $effect(() => {
    const max = gapMaxM;
    untrack(() => {
      if (gapWidthM > max) {
        gapWidthM = max;
        scheduleReclean();
      }
    });
  });

  // Run state
  let running = $state(false);
  let currentStage = $state(0); // 0 idle, 1..4 active, 5 done
  let errorStage = $state(0);
  let stageLabel = $state("");
  let error = $state<string | null>(null);

  // Results
  let originalGeoJSON = $state<string | null>(null);
  let cleanedGeoJSON = $state<string | null>(null);
  let issuesGeoJSON = $state<string | null>(null);
  let issues = $state<IssueRow[]>([]);
  let fixedKeys = $state<Set<string>>(new Set());
  let bounds = $state<[number, number, number, number] | null>(null);
  let totalCount = $state(0);
  let collapsedCount = $state(0);

  // View + selection
  let showSide = $state<"a" | "b">("b");
  let selectedKey = $state<string | null>(null);
  let focusBbox = $state<[number, number, number, number] | null>(null);

  // Debounce for slider-driven re-clean.
  let recleanTimer: ReturnType<typeof setTimeout> | undefined;
  let recleaning = $state(false);
  let recleanPending = false;

  function handleKey(e: KeyboardEvent): void {
    if (!cleanedGeoJSON) return;
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
    if (e.key === "]" || e.key === "[") {
      showSide = showSide === "a" ? "b" : "a";
    }
  }

  onMount(() => {
    initDuckDB();
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  });

  $effect(() => {
    const f = files;
    const ready = duckdbState.ready;
    if (f.length === 0 || !ready) return;
    untrack(() => {
      if (loading) return;
      loaded = false;
      resetResults();
      loadThenFlag();
    });
  });

  $effect(() => {
    const ok = loaded;
    if (!ok) return;
    untrack(() => {
      if (!running) handleRun();
    });
  });

  function resetResults(): void {
    originalGeoJSON = null;
    cleanedGeoJSON = null;
    issuesGeoJSON = null;
    issues = [];
    fixedKeys = new Set();
    bounds = null;
    totalCount = 0;
    collapsedCount = 0;
    currentStage = 0;
    errorStage = 0;
    stageLabel = "";
    error = null;
    loadError = null;
    showSide = "b";
    selectedKey = null;
    focusBbox = null;
    gapWidthM = 0;
    sliverTolM = SLIVER_TOL_DEFAULT_M;
    recleanPending = false;
    if (recleanTimer) {
      clearTimeout(recleanTimer);
      recleanTimer = undefined;
    }
  }

  async function loadThenFlag(): Promise<void> {
    loadError = null;
    loading = true;
    currentStage = 1;
    stageLabel = "Loading file…";
    try {
      await loadFile(duckdbState.db!, duckdbState.conn!, files);
      loaded = true;
    } catch (e) {
      loadError = e instanceof Error ? e.message : String(e);
      currentStage = 0;
    } finally {
      loading = false;
    }
  }

  async function handleRun(): Promise<void> {
    error = null;
    running = true;
    errorStage = 0;
    try {
      const result = await runFromLoaded(
        duckdbState.conn!,
        { gapWidthM, sliverTolM },
        (stage, label) => {
          currentStage = stage;
          stageLabel = label;
        },
      );
      originalGeoJSON = result.originalGeoJSON;
      cleanedGeoJSON = result.cleanedGeoJSON;
      issuesGeoJSON = result.issuesGeoJSON;
      issues = result.issues;
      fixedKeys = result.fixedKeys;
      bounds = result.bounds;
      totalCount = result.totalCount;
      collapsedCount = result.collapsedCount;
      gapWidthM = gapMaxM; // default to max now that issues (and thus gapMaxM) are known
      currentStage = 5;
      stageLabel = "Done";
      showSide = "b";
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      errorStage = e instanceof PipelineError ? (e as PipelineError).failedStage : currentStage;
      currentStage = 0;
    } finally {
      running = false;
    }
    if (cleanedGeoJSON) scheduleReclean();
  }

  function scheduleReclean(): void {
    if (cleanedGeoJSON == null) return;
    if (recleanTimer) clearTimeout(recleanTimer);
    if (recleaning) {
      recleanPending = true;
      return;
    }
    recleanTimer = setTimeout(doReclean, 200);
  }

  async function doReclean(): Promise<void> {
    recleaning = true;
    recleanPending = false;
    try {
      const result = await recleanOnly(duckdbState.conn!, { gapWidthM, sliverTolM });
      cleanedGeoJSON = result.cleanedGeoJSON;
      collapsedCount = result.collapsedCount;
      fixedKeys = result.fixedKeys;
      // Slivers are re-detected at the current tolerance, so refresh the table+map.
      issues = result.issues;
      issuesGeoJSON = result.issuesGeoJSON;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      recleaning = false;
      if (recleanPending) {
        recleanPending = false;
        setTimeout(doReclean, 0);
      }
    }
  }

  // Selecting an issue (from table or map) highlights it, switches to Version A
  // so the highlight is visible over the original coverage, and zooms to it.
  function selectIssue(key: string): void {
    const row = issues.find((r) => r.key === key);
    if (!row) return;
    selectedKey = key;
    showSide = "a";
    focusBbox = row.bbox.slice() as [number, number, number, number]; // fresh array → always re-zooms
  }

  function onMapIssueClick(key: string | null): void {
    if (key == null) {
      selectedKey = null;
      return;
    }
    selectIssue(key);
  }

  function stageStatus(idx: number): "pending" | "active" | "done" | "error" {
    const stageNum = idx + 1;
    if (errorStage > 0) {
      if (stageNum < errorStage) return "done";
      if (stageNum === errorStage) return "error";
      return "pending";
    }
    if (currentStage === 0) return "pending";
    if (currentStage === 5) return "done";
    if (stageNum < currentStage) return "done";
    if (stageNum === currentStage) return "active";
    return "pending";
  }

  function fileStem(f: File[]): string {
    return f[0]?.name.replace(/\.[^.]+$/, "") ?? "coverage";
  }
</script>

<div class="tc-layout">
  <aside class="tc-sidebar">
    <header>
      <a class="tc-back" href="/">← Topology Tools</a>
      <h1>Topology Cleaner</h1>
      <p class="tc-blurb">
        Fix overlaps and gaps in a polygon coverage. Drop a layer; the tool lists every overlap and
        gap (click one to zoom to it), then cleans the topology with DuckDB's
        <code>ST_CoverageClean</code>. Compare the Original with the Fixed result, and widen the
        gap slider to close gaps too large to fix automatically.
      </p>
    </header>

    {#if duckdbState.initError}
      <div class="tc-error"><strong>Initialisation error:</strong> {duckdbState.initError}</div>
    {/if}

    <section class="tc-step">
      <h2 class="tc-step-heading">Drop a coverage</h2>
      <DropZone
        bind:files
        disabled={running || loading}
        helpText="Polygon coverage in any supported format — adjacent admin units, basins, etc."
      />
      {#if loading}<p class="tc-status">Loading…</p>{/if}
      {#if loadError}<div class="tc-error">{loadError}</div>{/if}
    </section>

    {#if cleanedGeoJSON}
      <section class="tc-step">
        <h2 class="tc-step-heading">Gap width</h2>
        <label class="tc-slider">
          <span>Fill gaps up to — {fmtGap(gapWidthM)}</span>
          <input
            type="range"
            min="0"
            max={gapMaxM}
            step={gapStepM}
            bind:value={gapWidthM}
            oninput={scheduleReclean}
            disabled={running}
          />
          <p class="tc-hint">
            Enclosed gaps narrower than this are merged into a neighbour. Raise it to close gaps too
            large to clean automatically.
          </p>
        </label>
      </section>

      <section class="tc-step">
        <h2 class="tc-step-heading">Sliver tolerance</h2>
        <label class="tc-slider">
          <span>Near-miss up to — {sliverTolM === 0 ? "off" : fmtGap(sliverTolM)}</span>
          <input
            type="range"
            min="0"
            max={SLIVER_TOL_MAX_M}
            step="0.5"
            bind:value={sliverTolM}
            oninput={scheduleReclean}
            disabled={running}
          />
          <p class="tc-hint">
            Thin slits where two units' boundaries should meet at a T-junction but the coordinates
            miss by less than this. The same distance is used to snap them shut when cleaning, so
            anything flagged is closed. Set to <strong>off</strong> to ignore slivers.
          </p>
        </label>
      </section>
    {/if}

    {#if currentStage > 0 || errorStage > 0}
      <ol class="tc-stages">
        {#each STAGE_LABELS as label, i}
          {@const status = stageStatus(i)}
          <li class={status}>
            {#if status === "error"}<span class="tc-stage-x">✕</span>{:else}<span
                class="tc-stage-dot"
              ></span>{/if}
            <span>{i + 1 === currentStage && stageLabel ? stageLabel : label}</span>
          </li>
        {/each}
      </ol>
    {/if}

    {#if error}<div class="tc-error">{error}</div>{/if}

    {#if cleanedGeoJSON && collapsedCount > 0}
      <p class="tc-warn">{collapsedCount} of {totalCount} polygons collapsed at this gap width.</p>
    {/if}

    {#if cleanedGeoJSON}
      <section class="tc-step">
        <h2 class="tc-step-heading">Download</h2>
        <DownloadMenu
          primaryLabel="Download GeoJSON"
          filenameStem={fileStem(files)}
          cachedGeoJSON={cleanedGeoJSON}
          exportSource="clean_topology"
        />
      </section>
    {/if}

    <p class="tc-privacy">Your files never leave your device.</p>
  </aside>

  <div class="tc-result">
    <div class="tc-map-pane">
      {#if running || recleaning}
        <div class="tc-busy" role="status" aria-live="polite">
          <span class="tc-busy-spinner" aria-hidden="true"></span>
          {running ? "Processing layer…" : "Updating…"}
        </div>
      {/if}
      {#if cleanedGeoJSON}
        <div class="tc-view-toolbar">
          <div class="tc-mode-btns" role="group" aria-label="View mode">
            <button
              class="tc-mode-btn"
              class:active={showSide === "a"}
              onclick={() => (showSide = "a")}>Original</button
            >
            <button
              class="tc-mode-btn"
              class:active={showSide === "b"}
              onclick={() => (showSide = "b")}>Fixed</button
            >
          </div>
          <p class="tc-kbd-hint"><kbd>[</kbd><kbd>]</kbd> to cycle</p>
        </div>
      {/if}
      <MapView
        originalGeojson={originalGeoJSON}
        cleanedGeojson={cleanedGeoJSON}
        issuesGeojson={issuesGeoJSON}
        {bounds}
        {focusBbox}
        {selectedKey}
        {showSide}
        onIssueClick={onMapIssueClick}
      />
    </div>
    {#if cleanedGeoJSON}
      <div class="tc-table-pane">
        <IssuesTable rows={issues} {selectedKey} {fixedKeys} onSelect={selectIssue} />
      </div>
    {/if}
  </div>
</div>

<style>
  .tc-layout {
    display: grid;
    grid-template-columns: 340px 1fr;
    height: 100dvh;
    overflow: hidden;
  }
  .tc-sidebar {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    padding: 1.25rem;
    overflow-y: auto;
    border-right: 1px solid #e5e7eb;
    background: #fff;
  }
  header h1 {
    font-size: 1.25rem;
    font-weight: 700;
    color: #111;
    margin: 0 0 0.5rem;
  }
  .tc-back {
    display: inline-block;
    font-size: 0.75rem;
    color: #6b7280;
    text-decoration: none;
    margin-bottom: 0.5rem;
  }
  .tc-back:hover {
    color: #111;
  }
  .tc-blurb {
    font-size: 0.825rem;
    color: #374151;
    margin: 0;
    line-height: 1.5;
  }
  .tc-blurb code {
    font-size: 0.78rem;
    background: #f3f4f6;
    padding: 0.05rem 0.25rem;
    border-radius: 3px;
  }
  .tc-step {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    padding-top: 0.75rem;
    border-top: 1px solid #e5e7eb;
  }
  .tc-step-heading {
    font-size: 1rem;
    font-weight: 600;
    color: #111;
    margin: 0;
  }
  .tc-slider {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    font-size: 0.85rem;
  }
  .tc-slider input[type="range"] {
    width: 100%;
  }
  .tc-hint {
    font-size: 0.75rem;
    color: #6b7280;
    margin: 0;
    line-height: 1.3;
  }
  .tc-num-input {
    width: 100%;
    padding: 0.3rem 0.4rem;
    font-size: 0.8rem;
    border: 1px solid #d1d5db;
    border-radius: 4px;
    color: #374151;
    background: #fff;
  }
  .tc-num-input:disabled {
    background: #f9fafb;
    color: #9ca3af;
  }
  .tc-status {
    font-size: 0.85rem;
    color: #4b5563;
    margin: 0;
  }
  .tc-error {
    padding: 0.6rem 0.8rem;
    background: #fef2f2;
    border: 1px solid #fecaca;
    border-radius: 4px;
    color: #b91c1c;
    font-size: 0.8rem;
    word-break: break-word;
  }
  .tc-warn {
    margin: 0;
    font-size: 0.8rem;
    color: #b45309;
    font-weight: 600;
  }
  .tc-stages {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }
  .tc-stages li {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    font-size: 0.8rem;
    color: #6b7280;
  }
  .tc-stages li.done {
    color: #047857;
  }
  .tc-stages li.active {
    color: #1d4ed8;
    font-weight: 600;
  }
  .tc-stages li.error {
    color: #b91c1c;
    font-weight: 600;
  }
  .tc-stage-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: currentColor;
    opacity: 0.5;
  }
  .tc-stages li.active .tc-stage-dot,
  .tc-stages li.done .tc-stage-dot {
    opacity: 1;
  }
  .tc-stage-x {
    width: 12px;
    text-align: center;
    font-weight: 700;
  }
  .tc-privacy {
    margin: 0;
    padding-top: 0.5rem;
    font-size: 0.7rem;
    color: #9ca3af;
  }
  .tc-result {
    display: grid;
    grid-template-rows: 60% 40%;
    height: 100dvh;
    min-width: 0;
  }
  .tc-map-pane {
    position: relative;
    min-height: 0;
    border-bottom: 1px solid #e5e7eb;
  }
  .tc-table-pane {
    min-height: 0;
  }
  @media (min-width: 1280px) {
    .tc-result {
      grid-template-rows: 1fr;
      grid-template-columns: 1fr 360px;
    }
    .tc-map-pane {
      border-right: 1px solid #e5e7eb;
      border-bottom: none;
    }
  }
  .tc-busy {
    position: absolute;
    top: 0.5rem;
    left: 0.5rem;
    z-index: 11;
    display: flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.3rem 0.6rem;
    font-size: 0.75rem;
    font-weight: 600;
    color: #1d4ed8;
    background: #fff;
    border: 1px solid #d1d5db;
    border-radius: 6px;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
  }
  .tc-busy-spinner {
    width: 12px;
    height: 12px;
    border: 2px solid #bfdbfe;
    border-top-color: #1d4ed8;
    border-radius: 50%;
    animation: tc-spin 0.7s linear infinite;
  }
  @keyframes tc-spin {
    to {
      transform: rotate(360deg);
    }
  }
  .tc-view-toolbar {
    position: absolute;
    top: 0.5rem;
    right: 0.5rem;
    z-index: 10;
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 0.35rem;
  }
  .tc-mode-btns {
    display: flex;
    border: 1px solid #d1d5db;
    border-radius: 6px;
    overflow: hidden;
    background: #fff;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
  }
  .tc-mode-btn {
    padding: 0.3rem 0.6rem;
    font-size: 0.75rem;
    font-weight: 500;
    border: none;
    background: #fff;
    color: #6b7280;
    cursor: pointer;
    border-left: 1px solid #e5e7eb;
  }
  .tc-mode-btn:first-child {
    border-left: none;
  }
  .tc-mode-btn:hover {
    background: #f3f4f6;
    color: #111;
  }
  .tc-mode-btn.active {
    background: #111;
    color: #fff;
  }
  .tc-kbd-hint {
    margin: 0;
    font-size: 0.7rem;
    color: #6b7280;
    background: #fff;
    border: 1px solid #d1d5db;
    border-radius: 6px;
    padding: 0.2rem 0.45rem;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
  }
  .tc-kbd-hint kbd {
    font-family: inherit;
    font-size: 0.7rem;
    padding: 0.05rem 0.2rem;
    border: 1px solid #d1d5db;
    border-radius: 3px;
    background: #f3f4f6;
    color: #4b5563;
  }
</style>
