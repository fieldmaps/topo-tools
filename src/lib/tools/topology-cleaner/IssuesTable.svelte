<script lang="ts">
  import type { IssueRow } from "./pipeline";

  let {
    rows = [],
    selectedKey = null,
    fixedKeys = new Set<string>(),
    onSelect,
    onHover,
  }: {
    rows?: IssueRow[];
    selectedKey?: string | null;
    fixedKeys?: Set<string>;
    onSelect?: (key: string) => void;
    onHover?: (key: string | null) => void;
  } = $props();

  let showGaps = $state(true);
  let showOverlaps = $state(true);
  let showSlivers = $state(true);

  const gapCount = $derived(rows.filter((r) => r.kind === "gap").length);
  const overlapCount = $derived(rows.filter((r) => r.kind === "overlap").length);
  const sliverCount = $derived(rows.filter((r) => r.kind === "sliver").length);
  // Only overlaps + gaps are auto-fixed (overlaps always, gaps within the gap-width).
  // Slivers are detection-only (the clean never snaps) — they don't count as fixed.
  const isFixable = (r: IssueRow) => r.kind === "overlap" || r.kind === "gap";
  const fixableCount = $derived(rows.filter(isFixable).length);
  const fixedCount = $derived(rows.filter((r) => isFixable(r) && fixedKeys.has(r.key)).length);
  const visible = $derived(
    rows.filter((r) => {
      if (r.kind === "gap") return showGaps;
      if (r.kind === "overlap") return showOverlaps;
      if (r.kind === "sliver") return showSlivers;
      return false;
    }),
  );

  function fmtArea(m2: number): string {
    if (!Number.isFinite(m2)) return "—";
    if (m2 >= 1e6) return `${(m2 / 1e6).toLocaleString(undefined, { maximumFractionDigits: 2 })} km²`;
    if (m2 >= 1) return `${Math.round(m2).toLocaleString()} m²`;
    return `${m2.toPrecision(2)} m²`;
  }

  function fmtLength(m: number): string {
    if (!Number.isFinite(m) || m <= 0) return "—";
    const units: [number, string][] = [[1000, "km"], [1, "m"], [0.01, "cm"], [0.001, "mm"]];
    const [factor, label] = units.find(([f]) => m >= f) ?? [0.001, "mm"];
    return `${(m / factor).toLocaleString(undefined, { maximumFractionDigits: 1 })} ${label}`;
  }

  function kindLabel(r: IssueRow): string {
    if (r.kind === "overlap") return "Overlap";
    if (r.kind === "gap") return "Gap";
    return "Sliver";
  }

  function kindClass(r: IssueRow): string {
    if (r.kind === "overlap") return "tc-key--overlap";
    if (r.kind === "gap") return "tc-key--gap";
    return "tc-key--sliver";
  }

  function isFixed(r: IssueRow): boolean {
    return isFixable(r) && fixedKeys.has(r.key);
  }
</script>

<div class="tc-table-wrap">
  <div class="tc-toolbar">
    <span class="tc-fixed-count" class:all={fixedCount === fixableCount && fixableCount > 0}>
      {fixedCount} of {fixableCount} fixed
    </span>
    <div class="tc-filters">
      <button
        type="button"
        class="tc-chip tc-chip--overlap"
        class:off={!showOverlaps}
        onclick={() => (showOverlaps = !showOverlaps)}
        title="Toggle overlaps"
      >
        <span class="tc-key tc-key--overlap"></span> Overlaps {overlapCount}
      </button>
      <button
        type="button"
        class="tc-chip tc-chip--gap"
        class:off={!showGaps}
        onclick={() => (showGaps = !showGaps)}
        title="Toggle gaps"
      >
        <span class="tc-key tc-key--gap"></span> Gaps {gapCount}
      </button>
      <button
        type="button"
        class="tc-chip tc-chip--sliver"
        class:off={!showSlivers}
        onclick={() => (showSlivers = !showSlivers)}
        title="Toggle slivers"
      >
        <span class="tc-key tc-key--sliver"></span> Slivers {sliverCount}
      </button>
    </div>
  </div>

  {#if rows.length === 0}
    <p class="tc-empty">No issues found — the coverage is clean. 🎉</p>
  {:else}
    <div class="tc-scroll">
      <table class="tc-table">
        <thead>
          <tr>
            <th class="tc-check-cell" style="width:46px">Fixed</th>
            <th>Type</th>
            <th class="tc-num" style="width:88px">Max width</th>
            <th class="tc-num" style="width:80px">Area</th>
          </tr>
        </thead>
        <tbody onmouseleave={() => onHover?.(null)}>
          {#each visible as r (r.key)}
            <tr
              class:selected={r.key === selectedKey}
              onclick={() => onSelect?.(r.key)}
              onmouseenter={() => onHover?.(r.key)}
            >
              <td class="tc-check-cell">
                {#if r.kind === "sliver"}
                  <span class="tc-detect-mark" title="Detection only — not auto-fixed (closing a sliver needs snapping)">–</span>
                {:else}
                  <span class="tc-checkbox" class:tc-checkbox--on={isFixed(r)}>
                    {#if isFixed(r)}✓{/if}
                  </span>
                {/if}
              </td>
              <td>
                <span class="tc-key {kindClass(r)}"></span>
                {kindLabel(r)}
              </td>
              <td class="tc-num">{fmtLength(r.maxWidthM)}</td>
              <td class="tc-num">{fmtArea(r.areaM2)}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</div>

<style>
  .tc-table-wrap {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    background: #fff;
  }
  .tc-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    padding: 0.5rem 0.75rem;
    border-bottom: 1px solid #e5e7eb;
    flex-wrap: wrap;
  }
  .tc-fixed-count {
    font-size: 0.82rem;
    font-weight: 600;
    color: #b45309;
  }
  .tc-fixed-count.all {
    color: #15803d;
  }
  .tc-filters {
    display: flex;
    gap: 0.4rem;
  }
  .tc-chip {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    font-size: 0.72rem;
    padding: 0.2rem 0.5rem;
    border: 1px solid #d1d5db;
    border-radius: 999px;
    background: #fff;
    color: #374151;
    cursor: pointer;
  }
  .tc-chip.off {
    opacity: 0.4;
  }
  .tc-empty {
    padding: 1.25rem 0.9rem;
    font-size: 0.85rem;
    color: #047857;
    margin: 0;
  }
  .tc-scroll {
    overflow: auto;
    min-height: 0;
    flex: 1;
  }
  .tc-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.8rem;
    table-layout: fixed;
  }
  .tc-table thead th {
    position: sticky;
    top: 0;
    background: #f9fafb;
    text-align: left;
    font-weight: 600;
    color: #4b5563;
    padding: 0.4rem 0.5rem;
    border-bottom: 1px solid #e5e7eb;
    z-index: 1;
  }
  .tc-table td {
    padding: 0.35rem 0.5rem;
    border-bottom: 1px solid #f3f4f6;
    color: #374151;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .tc-num {
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  .tc-table tbody tr {
    cursor: pointer;
  }
  .tc-table tbody tr:hover {
    background: #f3f4f6;
  }
  .tc-table tbody tr.selected {
    background: #fef3c7;
  }
  .tc-key {
    display: inline-block;
    width: 10px;
    height: 10px;
    border-radius: 2px;
    margin-right: 0.35rem;
    vertical-align: middle;
  }
  .tc-key--overlap {
    background: #e11d48;
  }
  .tc-key--gap {
    background: #f59e0b;
  }
  .tc-key--sliver {
    background: #7c3aed;
  }
  .tc-detect-mark {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 15px;
    height: 15px;
    font-size: 13px;
    color: #9ca3af;
  }
  .tc-check-cell {
    text-align: center;
  }
  .tc-checkbox {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 15px;
    height: 15px;
    border: 1.5px solid #d1d5db;
    border-radius: 3px;
    background: #fff;
    font-size: 10px;
    color: transparent;
  }
  .tc-checkbox--on {
    background: #16a34a;
    border-color: #16a34a;
    color: #fff;
  }
</style>
