<script lang="ts">
  import type { RelClass, TableRow } from "./pipeline";

  let {
    rows = [],
    selectedClusterId = null,
    visibleClasses = null,
    onRowClick,
  }: {
    rows?: TableRow[];
    selectedClusterId?: number | null;
    visibleClasses?: Set<RelClass> | null;
    onRowClick?: (clusterId: number | null) => void;
  } = $props();

  let search = $state("");

  const REL_COLORS: Record<RelClass, string> = {
    unchanged: "#9ec5ab",
    modified: "#e5b250",
    merge: "#5a8fd8",
    split: "#e07550",
    complex: "#b25dab",
    created: "#6cc46c",
    removed: "#d35a5a",
  };

  const REL_ORDER: RelClass[] = [
    "unchanged",
    "modified",
    "merge",
    "split",
    "complex",
    "created",
    "removed",
  ];

  // Filter rows by visibleClasses and free-text search. Searches across A/B
  // codes and names.
  const filteredRows = $derived.by(() => {
    const term = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (visibleClasses && !visibleClasses.has(r.relationship_class)) return false;
      if (!term) return true;
      const hay = [r.a_code, r.a_name, r.b_code, r.b_name]
        .filter(Boolean)
        .map((s) => String(s).toLowerCase())
        .join(" ");
      return hay.includes(term);
    });
  });

  // Group rows by cluster_id. For each cluster, determine the rowspan to use
  // on each side. The "new" column rowspans across all rows for that cluster
  // when it's an N:1 merge (unique B fid, multiple A rows). Symmetric for splits.
  interface Cluster {
    cluster_id: number;
    relationship_class: RelClass;
    rows: TableRow[];
    aFidsUnique: number;
    bFidsUnique: number;
  }

  const clusters = $derived.by<Cluster[]>(() => {
    const map = new Map<number, Cluster>();
    for (const r of filteredRows) {
      let c = map.get(r.cluster_id);
      if (!c) {
        c = {
          cluster_id: r.cluster_id,
          relationship_class: r.relationship_class,
          rows: [],
          aFidsUnique: 0,
          bFidsUnique: 0,
        };
        map.set(r.cluster_id, c);
      }
      c.rows.push(r);
    }
    // Sort clusters: by relationship class (per REL_ORDER), then cluster_id.
    const out = Array.from(map.values());
    for (const c of out) {
      const aFids = new Set<number>();
      const bFids = new Set<number>();
      for (const r of c.rows) {
        if (r.a_fid != null) aFids.add(r.a_fid);
        if (r.b_fid != null) bFids.add(r.b_fid);
      }
      c.aFidsUnique = aFids.size;
      c.bFidsUnique = bFids.size;
    }
    out.sort((x, y) => {
      const xi = REL_ORDER.indexOf(x.relationship_class);
      const yi = REL_ORDER.indexOf(y.relationship_class);
      if (xi !== yi) return xi - yi;
      return x.cluster_id - y.cluster_id;
    });
    return out;
  });

  // For each cluster, precompute rowspans:
  //  - If aFids = 1 and bFids > 1 (split): the A cell spans bFids rows.
  //  - If aFids > 1 and bFids = 1 (merge): the B cell spans aFids rows.
  //  - Otherwise (1:1 or N:M complex), no rowspan.
  function rowspanForCluster(c: Cluster): "a" | "b" | "none" {
    if (c.aFidsUnique === 1 && c.bFidsUnique > 1) return "a";
    if (c.bFidsUnique === 1 && c.aFidsUnique > 1) return "b";
    return "none";
  }

  function fmtPct(v: number | null): string {
    if (v == null || !Number.isFinite(v)) return "—";
    return (v * 100).toFixed(1) + "%";
  }

  function handleRow(c: Cluster): void {
    if (!onRowClick) return;
    const newId = c.cluster_id === selectedClusterId ? null : c.cluster_id;
    onRowClick(newId);
  }
</script>

<div class="cw-table">
  <div class="cw-table-toolbar">
    <input
      class="cw-search"
      placeholder="Search codes or names…"
      bind:value={search}
      aria-label="Search"
    />
  </div>

  <div class="cw-table-scroll">
    <table>
      <thead>
        <tr>
          <th>Class</th>
          <th>Previous code</th>
          <th>Previous name</th>
          <th>New code</th>
          <th>New name</th>
          <th>Cov A</th>
          <th>Cov B</th>
          <th>IoU</th>
        </tr>
      </thead>
      <tbody>
        {#each clusters as c (c.cluster_id)}
          {@const span = rowspanForCluster(c)}
          {#each c.rows as r, i (i)}
            <tr
              class="cw-row"
              class:cw-row-selected={selectedClusterId === c.cluster_id}
              onclick={() => handleRow(c)}
              data-cluster-id={c.cluster_id}
              data-relationship-class={c.relationship_class}
            >
              {#if i === 0 || (span !== "a" && span !== "none")}
                <td class="cw-class-cell">
                  <span class="cw-class-badge" style="background:{REL_COLORS[r.relationship_class]}"
                  >{r.relationship_class}</span>
                </td>
              {:else if span === "a" && i === 0}
                <!-- spanned -->
              {/if}

              <!-- Previous side: A code & name -->
              {#if span === "a"}
                {#if i === 0}
                  <td rowspan={c.rows.length} class="cw-spanned">{r.a_code ?? "—"}</td>
                  <td rowspan={c.rows.length} class="cw-spanned">{r.a_name ?? "—"}</td>
                {/if}
              {:else}
                <td>{r.a_code ?? "—"}</td>
                <td>{r.a_name ?? "—"}</td>
              {/if}

              <!-- New side: B code & name -->
              {#if span === "b"}
                {#if i === 0}
                  <td rowspan={c.rows.length} class="cw-spanned">{r.b_code ?? "—"}</td>
                  <td rowspan={c.rows.length} class="cw-spanned">{r.b_name ?? "—"}</td>
                {/if}
              {:else}
                <td>{r.b_code ?? "—"}</td>
                <td>{r.b_name ?? "—"}</td>
              {/if}

              <td class="cw-num">{fmtPct(r.coverage_a)}</td>
              <td class="cw-num">{fmtPct(r.coverage_b)}</td>
              <td class="cw-num">{fmtPct(r.iou)}</td>
            </tr>
          {/each}
        {/each}
      </tbody>
    </table>

    {#if filteredRows.length === 0}
      <p class="cw-empty">No rows match the current filter.</p>
    {/if}
  </div>
</div>

<style>
  .cw-table {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }
  .cw-table-toolbar {
    padding: 0.5rem;
    background: #f9fafb;
    border-bottom: 1px solid #e5e7eb;
  }
  .cw-search {
    width: 100%;
    padding: 0.4rem 0.6rem;
    border: 1px solid #d1d5db;
    border-radius: 4px;
    font-size: 0.875rem;
  }
  .cw-table-scroll {
    flex: 1;
    overflow: auto;
    min-height: 0;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.85rem;
  }
  thead {
    position: sticky;
    top: 0;
    background: #f3f4f6;
    z-index: 1;
  }
  th,
  td {
    text-align: left;
    padding: 0.4rem 0.6rem;
    border-bottom: 1px solid #e5e7eb;
    vertical-align: middle;
  }
  th {
    font-weight: 600;
    font-size: 0.75rem;
    text-transform: uppercase;
    color: #4b5563;
  }
  .cw-row {
    cursor: pointer;
  }
  .cw-row:hover {
    background: #f9fafb;
  }
  .cw-row-selected {
    background: #eef2ff !important;
  }
  .cw-row-selected:hover {
    background: #e0e7ff !important;
  }
  .cw-class-cell {
    width: 1%;
    white-space: nowrap;
  }
  .cw-class-badge {
    display: inline-block;
    padding: 1px 6px;
    border-radius: 3px;
    color: #fff;
    font-size: 0.7rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.02em;
  }
  .cw-spanned {
    background: rgba(99, 102, 241, 0.05);
    border-left: 2px solid #a5b4fc;
    font-weight: 500;
  }
  .cw-num {
    text-align: right;
    font-variant-numeric: tabular-nums;
    color: #4b5563;
  }
  .cw-empty {
    padding: 1rem;
    text-align: center;
    color: #6b7280;
    font-size: 0.875rem;
  }
</style>
