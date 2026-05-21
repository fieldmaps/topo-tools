<script lang="ts">
  import { duckdbState, initDuckDB } from "$lib/db/duckdb.svelte";
  import DownloadMenu from "$lib/components/DownloadMenu.svelte";
  import DropZone from "$lib/components/DropZone.svelte";
  import { onMount, untrack } from "svelte";
  import MapView from "./MapView.svelte";
  import CrosswalkTable from "./CrosswalkTable.svelte";
  import { dropPriorRun, loadSide } from "./pipeline/load";
  import { detectColumns, type ColumnGuess } from "./pipeline/columns";
  import {
    PipelineError,
    reclassifyOnly,
    runFromLoaded,
    type RelClass,
    type TableRow,
  } from "./pipeline";

  const STAGE_LABELS = [
    "Load sources",
    "Build keyed layers",
    "Overlay boundaries",
    "Compute coverage",
    "Classify clusters",
    "Render overlay",
  ];

  const ALL_CLASSES: RelClass[] = [
    "unchanged",
    "modified",
    "merge",
    "split",
    "complex",
    "created",
    "removed",
  ];


  // Input state
  let filesA = $state<File[]>([]);
  let filesB = $state<File[]>([]);
  let loadedA = $state(false);
  let loadedB = $state(false);
  let loadingSide = $state<"a" | "b" | null>(null);
  let loadError = $state<string | null>(null);

  // Auto-detected columns + user selections
  let colsA = $state<ColumnGuess | null>(null);
  let colsB = $state<ColumnGuess | null>(null);
  let aCodeCol = $state<string | null>(null);
  let aNameCol = $state<string | null>(null);
  let bCodeCol = $state<string | null>(null);
  let bNameCol = $state<string | null>(null);

  // Thresholds
  let tauMatch = $state(0.67);
  let tauSame = $state(0.98);

  // Pipeline run state
  let running = $state(false);
  let currentStage = $state(0); // 0=idle, 1-6=active, 7=done
  let errorStage = $state(0);
  let stageLabel = $state("");
  let error = $state<string | null>(null);

  // Results
  let overlayGeoJSON = $state<string | null>(null);
  let outlineAGeoJSON = $state<string | null>(null);
  let outlineBGeoJSON = $state<string | null>(null);
  let tableRows = $state<TableRow[]>([]);
  let bounds = $state<[number, number, number, number] | null>(null);

  // Selection / filter
  let selectedClusterId = $state<number | null>(null);
  let visibleClasses = $state<Set<RelClass>>(new Set(ALL_CLASSES));

  // Comparison mode
  let showSide = $state<"both" | "a" | "b">("both");

  const SIDES: Array<"both" | "a" | "b"> = ["both", "a", "b"];

  function handleKey(e: KeyboardEvent): void {
    if (!overlayGeoJSON) return;
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
    if (e.key === "]") {
      const i = SIDES.indexOf(showSide);
      showSide = SIDES[(i + 1) % SIDES.length];
    } else if (e.key === "[") {
      const i = SIDES.indexOf(showSide);
      showSide = SIDES[(i + SIDES.length - 1) % SIDES.length];
    }
  }

  onMount(() => {
    initDuckDB();
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  });

  // Debounced reclassify on slider changes
  let reclassifyTimer: ReturnType<typeof setTimeout> | undefined;
  let reclassifying = $state(false);


  // Auto-run when both sides are loaded. Re-dropping a file resets loadedA/B
  // to false then true again, which re-triggers the run.
  $effect(() => {
    const a = loadedA;
    const b = loadedB;
    if (!a || !b) return;
    untrack(() => {
      if (!running) handleRun();
    });
  });

  // Auto-load each side when files are dropped.
  // Re-dropping after a run reloads: stale dropdowns/results would otherwise
  // linger because loadedA/loadedB stayed true from the prior run.
  $effect(() => {
    const f = filesA;
    const ready = duckdbState.ready;
    if (f.length === 0 || !ready) return;
    untrack(() => {
      if (loadingSide === "a") return;
      colsA = null;
      aCodeCol = null;
      aNameCol = null;
      loadedA = false;
      resetResults();
      loadSideThen("a");
    });
  });
  $effect(() => {
    const f = filesB;
    const ready = duckdbState.ready;
    if (f.length === 0 || !ready) return;
    untrack(() => {
      if (loadingSide === "b") return;
      colsB = null;
      bCodeCol = null;
      bNameCol = null;
      loadedB = false;
      resetResults();
      loadSideThen("b");
    });
  });

  function resetResults(): void {
    overlayGeoJSON = null;
    outlineAGeoJSON = null;
    outlineBGeoJSON = null;
    tableRows = [];
    bounds = null;
    selectedClusterId = null;
    currentStage = 0;
    errorStage = 0;
    stageLabel = "";
    error = null;
    loadError = null;
    showSide = "both";
  }

  async function loadSideThen(side: "a" | "b"): Promise<void> {
    loadError = null;
    loadingSide = side;
    try {
      const files = side === "a" ? filesA : filesB;
      await loadSide(duckdbState.db!, duckdbState.conn!, side, files);
      const cols = await detectColumns(duckdbState.conn!, `cw_${side}_layer_attr`);
      if (side === "a") {
        colsA = cols;
        aCodeCol = cols.code;
        aNameCol = cols.name;
        loadedA = true;
      } else {
        colsB = cols;
        bCodeCol = cols.code;
        bNameCol = cols.name;
        loadedB = true;
      }
    } catch (e) {
      loadError = e instanceof Error ? e.message : String(e);
    } finally {
      loadingSide = null;
    }
  }

  async function handleRun(): Promise<void> {
    error = null;
    running = true;
    overlayGeoJSON = null;
    outlineAGeoJSON = null;
    outlineBGeoJSON = null;
    tableRows = [];
    selectedClusterId = null;
    currentStage = 1;
    errorStage = 0;
    stageLabel = "Sources loaded";
    try {
      const result = await runFromLoaded(
        duckdbState.conn!,
        {
          tauMatch,
          tauSame,
          aCodeCol,
          aNameCol,
          bCodeCol,
          bNameCol,
        },
        (stage, label) => {
          currentStage = stage;
          stageLabel = label;
        },
      );
      overlayGeoJSON = result.overlayGeoJSON;
      outlineAGeoJSON = result.outlineAGeoJSON;
      outlineBGeoJSON = result.outlineBGeoJSON;
      tableRows = result.tableRows;
      bounds = result.bounds;
      currentStage = 7;
      stageLabel = "Done";
      exposeDebugHook();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      errorStage = e instanceof PipelineError ? (e as PipelineError).failedStage : currentStage;
      currentStage = 0;
    } finally {
      running = false;
    }
  }

  function scheduleReclassify(): void {
    if (overlayGeoJSON == null) return;
    if (reclassifyTimer) clearTimeout(reclassifyTimer);
    reclassifyTimer = setTimeout(async () => {
      reclassifying = true;
      try {
        const result = await reclassifyOnly(duckdbState.conn!, {
          tauMatch,
          tauSame,
          aCodeCol,
          aNameCol,
          bCodeCol,
          bNameCol,
        });
        overlayGeoJSON = result.overlayGeoJSON;
        outlineAGeoJSON = result.outlineAGeoJSON;
        outlineBGeoJSON = result.outlineBGeoJSON;
        tableRows = result.tableRows;
        exposeDebugHook();
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      } finally {
        reclassifying = false;
      }
    }, 100);
  }

  function exposeDebugHook(): void {
    if (typeof window === "undefined") return;
    const summary: Record<string, number> = {};
    for (const c of ALL_CLASSES) summary[c] = 0;
    const seen = new Set<string>();
    for (const r of tableRows) {
      const key = r.cluster_id + ":" + r.relationship_class;
      if (seen.has(key)) continue;
      seen.add(key);
      summary[r.relationship_class] = (summary[r.relationship_class] ?? 0) + 1;
    }
    // Per-cluster counts are derived from unique cluster_id; a single cluster
    // might produce multiple rows so we de-dup by (cluster_id, class).
    const clusterCounts: Record<string, number> = {};
    for (const c of ALL_CLASSES) clusterCounts[c] = 0;
    const clusterClass = new Map<number, RelClass>();
    for (const r of tableRows) clusterClass.set(r.cluster_id, r.relationship_class);
    for (const cls of clusterClass.values()) clusterCounts[cls]++;
    (window as unknown as { __cw_debug: unknown }).__cw_debug = {
      done: currentStage === 7,
      summary: clusterCounts,
      tableRows,
      selectedClusterId,
      overlayGeoJSON,
    };
  }

  $effect(() => {
    // Update debug hook on selection changes so tests can observe state.
    selectedClusterId;
    if (overlayGeoJSON != null) untrack(exposeDebugHook);
  });

  function stageStatus(idx: number): "pending" | "active" | "done" | "error" {
    const stageNum = idx + 1;
    if (errorStage > 0) {
      if (stageNum < errorStage) return "done";
      if (stageNum === errorStage) return "error";
      return "pending";
    }
    if (currentStage === 0) return "pending";
    if (currentStage === 7) return "done";
    if (stageNum < currentStage) return "done";
    if (stageNum === currentStage) return "active";
    return "pending";
  }

  function toggleClass(c: RelClass): void {
    const next = new Set(visibleClasses);
    if (next.has(c)) next.delete(c);
    else next.add(c);
    visibleClasses = next;
  }

  function fileStem(files: File[]): string {
    if (files.length === 0) return "changelog";
    return files[0].name.replace(/\.[^.]+$/, "");
  }

  function setSelected(id: number | null): void {
    selectedClusterId = id;
  }
</script>

<div class="cw-layout">
  <aside class="cw-sidebar">
    <header>
      <a class="cw-back" href="/">← Topology Tools</a>
      <h1>Changelog</h1>
      <p class="cw-blurb">
        Compare two versions of a polygon layer (e.g. ADM2 across census rounds) and classify each
        unit as unchanged, modified, merged, split, created, or removed. Drop both versions; the
        tool overlays them, scores coverage per pair, and groups related polygons into clusters.
      </p>
    </header>

    {#if duckdbState.initError}
      <div class="cw-error">
        <strong>Initialisation error:</strong>
        {duckdbState.initError}
      </div>
    {/if}

    <section class="cw-step">
      <h2 class="cw-step-heading">Drop both layers</h2>
      <div class="cw-dropzones">
        <div data-testid="dropzone-a">
          <label class="cw-zone-label">Previous</label>
          <DropZone
            bind:files={filesA}
            disabled={running || loadingSide === "a"}
            helpText="Older version. Polygon layer in any supported format."
          />
        </div>
        <div data-testid="dropzone-b">
          <label class="cw-zone-label">New</label>
          <DropZone
            bind:files={filesB}
            disabled={running || loadingSide === "b"}
            helpText="Newer version. Same coverage area."
          />
        </div>
      </div>
      {#if loadingSide === "a"}<p class="cw-status">Loading Previous…</p>{/if}
      {#if loadingSide === "b"}<p class="cw-status">Loading New…</p>{/if}
      {#if loadError}<div class="cw-error">{loadError}</div>{/if}
    </section>

    {#if loadedA || loadedB}
      <section class="cw-step">
        <h2 class="cw-step-heading">Pick code &amp; name columns</h2>
        <div class="cw-cols">
          {#if colsA}
            <fieldset class="cw-fieldset">
              <legend>Previous</legend>
              <label class="cw-field">
                <span>Code</span>
                <select bind:value={aCodeCol} disabled={running}>
                  <option value={null}>(none)</option>
                  {#each colsA.all as col (col)}<option value={col}>{col}</option>{/each}
                </select>
              </label>
              <label class="cw-field">
                <span>Name</span>
                <select bind:value={aNameCol} disabled={running}>
                  <option value={null}>(none)</option>
                  {#each colsA.all as col (col)}<option value={col}>{col}</option>{/each}
                </select>
              </label>
            </fieldset>
          {/if}
          {#if colsB}
            <fieldset class="cw-fieldset">
              <legend>New</legend>
              <label class="cw-field">
                <span>Code</span>
                <select bind:value={bCodeCol} disabled={running}>
                  <option value={null}>(none)</option>
                  {#each colsB.all as col (col)}<option value={col}>{col}</option>{/each}
                </select>
              </label>
              <label class="cw-field">
                <span>Name</span>
                <select bind:value={bNameCol} disabled={running}>
                  <option value={null}>(none)</option>
                  {#each colsB.all as col (col)}<option value={col}>{col}</option>{/each}
                </select>
              </label>
            </fieldset>
          {/if}
        </div>
      </section>
    {/if}

    <section class="cw-step">
      <h2 class="cw-step-heading">Thresholds</h2>
      <label class="cw-slider">
        <span>Match overlap — {Math.round(tauMatch * 100)}%</span>
        <input
          type="range"
          min="0"
          max="1"
          step="0.01"
          bind:value={tauMatch}
          oninput={scheduleReclassify}
          disabled={running}
        />
        <p class="cw-hint">
          How much of either polygon must overlap the other for the two to be considered related. Lower = more matches.
        </p>
      </label>

      <details class="cw-advanced">
        <summary>Advanced</summary>
        <label class="cw-slider">
          <span>Unchanged overlap — {Math.round(tauSame * 100)}%</span>
          <input
            type="range"
            min="0"
            max="1"
            step="0.01"
            bind:value={tauSame}
            oninput={scheduleReclassify}
            disabled={running}
          />
          <p class="cw-hint">
            How much a 1:1 matched pair must overlap to be classified as <em>unchanged</em> rather than <em>modified</em>.
          </p>
        </label>
      </details>

    </section>

    {#if currentStage > 0 || errorStage > 0}
      <ol class="cw-stages">
        {#each STAGE_LABELS as label, i}
          {@const status = stageStatus(i)}
          <li class={status}>
            {#if status === "error"}
              <span class="cw-stage-x">✕</span>
            {:else}
              <span class="cw-stage-dot"></span>
            {/if}
            <span class="cw-stage-label">
              {i + 1 === currentStage && stageLabel ? stageLabel : label}
            </span>
          </li>
        {/each}
      </ol>
    {/if}

    {#if error}<div class="cw-error">{error}</div>{/if}

    {#if overlayGeoJSON}
      <section class="cw-step">
        <h2 class="cw-step-heading">Download</h2>
        <div class="cw-downloads">
          <DownloadMenu
            primaryLabel="Changelog CSV"
            filenameStem={fileStem(filesA)}
            exportSource="crosswalk_changelog"
          />
        </div>
      </section>
    {/if}

    <p class="cw-privacy">Your files never leave your device.</p>
  </aside>

  <div class="cw-result">
    <div class="cw-map-pane">
      {#if overlayGeoJSON}
        <div class="cw-view-toolbar">
          <div class="cw-mode-btns" role="group" aria-label="View mode">
            <button class="cw-mode-btn" class:active={showSide === "both"} onclick={() => showSide = "both"}>Overview</button>
            <button class="cw-mode-btn" class:active={showSide === "a"} onclick={() => showSide = "a"}>Previous</button>
            <button class="cw-mode-btn" class:active={showSide === "b"} onclick={() => showSide = "b"}>New</button>
          </div>
        </div>
      {/if}

      <MapView
        overlayGeojson={overlayGeoJSON}
        outlineAGeojson={outlineAGeoJSON}
        outlineBGeojson={outlineBGeoJSON}
        {bounds}
        {selectedClusterId}
        {visibleClasses}
        onClusterClick={setSelected}
        {showSide}
      />
    </div>
    <div class="cw-table-pane">
      <CrosswalkTable
        rows={tableRows}
        {selectedClusterId}
        {visibleClasses}
        onRowClick={setSelected}
        onToggleClass={toggleClass}
      />
    </div>
  </div>
</div>

<style>
  .cw-layout {
    display: grid;
    grid-template-columns: 340px 1fr;
    height: 100dvh;
    overflow: hidden;
  }
  .cw-sidebar {
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
  .cw-back {
    display: inline-block;
    font-size: 0.75rem;
    color: #6b7280;
    text-decoration: none;
    margin-bottom: 0.5rem;
  }
  .cw-back:hover {
    color: #111;
  }
  .cw-blurb {
    font-size: 0.825rem;
    color: #374151;
    margin: 0;
    line-height: 1.5;
  }
  .cw-step {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    padding-top: 0.75rem;
    border-top: 1px solid #e5e7eb;
  }
  .cw-step-heading {
    font-size: 1rem;
    font-weight: 600;
    color: #111;
    margin: 0;
  }
  .cw-dropzones {
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
  }
  .cw-zone-label {
    display: block;
    font-size: 0.75rem;
    font-weight: 600;
    color: #4b5563;
    margin-bottom: 0.2rem;
  }
  .cw-cols {
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
  }
  .cw-fieldset {
    border: 1px solid #e5e7eb;
    border-radius: 4px;
    padding: 0.5rem 0.6rem;
  }
  .cw-fieldset legend {
    font-size: 0.75rem;
    font-weight: 600;
    color: #4b5563;
    padding: 0 0.3rem;
  }
  .cw-field {
    display: grid;
    grid-template-columns: 60px 1fr;
    align-items: center;
    gap: 0.4rem;
    margin: 0.2rem 0;
    font-size: 0.8rem;
  }
  .cw-field select {
    width: 100%;
    padding: 0.25rem 0.4rem;
    font-size: 0.8rem;
    border: 1px solid #d1d5db;
    border-radius: 3px;
    background: #fff;
  }
  .cw-slider {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    font-size: 0.85rem;
  }
  .cw-slider input[type="range"] {
    width: 100%;
  }
  .cw-hint {
    font-size: 0.75rem;
    color: #6b7280;
    margin: 0;
    line-height: 1.3;
  }
  .cw-advanced {
    margin-top: 0.5rem;
  }
  .cw-advanced summary {
    font-size: 0.8rem;
    color: #6b7280;
    cursor: pointer;
    user-select: none;
  }
  .cw-advanced summary:hover {
    color: #374151;
  }
  .cw-advanced > .cw-slider {
    margin-top: 0.5rem;
  }
  .cw-status {
    font-size: 0.85rem;
    color: #4b5563;
    margin: 0;
  }
  .cw-error {
    padding: 0.6rem 0.8rem;
    background: #fef2f2;
    border: 1px solid #fecaca;
    border-radius: 4px;
    color: #b91c1c;
    font-size: 0.8rem;
    word-break: break-word;
  }
  .cw-stages {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }
  .cw-stages li {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    font-size: 0.8rem;
    color: #6b7280;
  }
  .cw-stages li.done {
    color: #047857;
  }
  .cw-stages li.active {
    color: #1d4ed8;
    font-weight: 600;
  }
  .cw-stages li.error {
    color: #b91c1c;
    font-weight: 600;
  }
  .cw-stage-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: currentColor;
    opacity: 0.5;
  }
  .cw-stages li.active .cw-stage-dot {
    opacity: 1;
  }
  .cw-stages li.done .cw-stage-dot {
    opacity: 1;
  }
  .cw-stage-x {
    width: 12px;
    text-align: center;
    font-weight: 700;
  }
  .cw-downloads {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .cw-privacy {
    margin: 0;
    padding-top: 0.5rem;
    font-size: 0.7rem;
    color: #9ca3af;
  }
  .cw-result {
    display: grid;
    grid-template-rows: 65% 35%;
    height: 100dvh;
    min-width: 0;
  }
  .cw-map-pane {
    min-height: 0;
    border-bottom: 1px solid #e5e7eb;
    position: relative;
  }

  .cw-view-toolbar {
    position: absolute;
    top: 0.5rem;
    right: 0.5rem;
    z-index: 10;
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 0.35rem;
    pointer-events: auto;
  }

  .cw-mode-btns {
    display: flex;
    border: 1px solid #d1d5db;
    border-radius: 6px;
    overflow: hidden;
    background: #fff;
    box-shadow: 0 1px 3px rgba(0,0,0,0.1);
  }

  .cw-mode-btn {
    padding: 0.3rem 0.6rem;
    font-size: 0.75rem;
    font-weight: 500;
    border: none;
    background: #fff;
    color: #6b7280;
    cursor: pointer;
    border-left: 1px solid #e5e7eb;
    transition: background 0.1s, color 0.1s;
  }

  .cw-mode-btn:first-child {
    border-left: none;
  }

  .cw-mode-btn:hover {
    background: #f3f4f6;
    color: #111;
  }

  .cw-mode-btn.active {
    background: #111;
    color: #fff;
  }

  .cw-table-pane {
    min-height: 0;
  }
  @media (min-width: 1280px) {
    .cw-result {
      grid-template-rows: 1fr;
      grid-template-columns: 65% 35%;
    }
    .cw-map-pane {
      border-right: 1px solid #e5e7eb;
      border-bottom: none;
    }
  }
</style>
