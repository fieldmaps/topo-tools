<script lang="ts">
  import type {
    ExpressionSpecification,
    FilterSpecification,
    GeoJSONSource,
    Map as MaplibreMap,
    MapMouseEvent,
  } from "maplibre-gl";
  import "maplibre-gl/dist/maplibre-gl.css";
  import { onDestroy, onMount } from "svelte";
  import { createSpin } from "$lib/utils/spin";
  import { loadStyle, polyFilter, lineWidth } from "$lib/utils/mapStyle";

  let {
    overlayGeojson = null,
    outlineAGeojson = null,
    outlineBGeojson = null,
    bounds = null,
    selectedClusterId = null,
    visibleClasses = null,
    showSide = "b" as "a" | "b",
    onClusterClick,
  }: {
    overlayGeojson?: string | null;
    outlineAGeojson?: string | null;
    outlineBGeojson?: string | null;
    bounds?: [number, number, number, number] | null;
    selectedClusterId?: number | null;
    visibleClasses?: Set<string> | null;
    showSide?: "a" | "b";
    onClusterClick?: (id: number | null) => void;
  } = $props();

  let container: HTMLDivElement | undefined;
  let map: MaplibreMap | undefined;
  let overlayUrl: string | undefined;
  let outlineAUrl: string | undefined;
  let outlineBUrl: string | undefined;
  let styleReady = false;
  let sidePending: number | undefined;
  const { start: startSpin, stop: stopSpin } = createSpin(() => map);

  // Color palette per relationship_class. The palette intentionally keeps
  // unchanged a calm desaturated green so changed classes pop visually.
  const REL_COLORS: Record<string, string> = {
    unchanged: "#9ec5ab",
    modified: "#e5b250",
    merge: "#5a8fd8",
    split: "#e07550",
    complex: "#b25dab",
    created: "#6cc46c",
    removed: "#d35a5a",
  };

  function fillColorExpr(): ExpressionSpecification {
    return [
      "match",
      ["get", "relationship_class"],
      "unchanged",
      REL_COLORS.unchanged,
      "modified",
      REL_COLORS.modified,
      "merge",
      REL_COLORS.merge,
      "split",
      REL_COLORS.split,
      "complex",
      REL_COLORS.complex,
      "created",
      REL_COLORS.created,
      "removed",
      REL_COLORS.removed,
      "#cccccc",
    ] as unknown as ExpressionSpecification;
  }

  function fillOpacityExpr(): ExpressionSpecification {
    // 0.85 when selected cluster matches OR no cluster is selected;
    // 0.25 when something is selected and this feature is a different cluster;
    // 0 when the feature's class is hidden by the filter.
    if (selectedClusterId == null) {
      return 0.85 as unknown as ExpressionSpecification;
    }
    return [
      "case",
      ["==", ["get", "cluster_id"], selectedClusterId],
      0.95,
      0.2,
    ] as unknown as ExpressionSpecification;
  }

  function buildFillFilter(): FilterSpecification {
    const conditions: FilterSpecification[] = [polyFilter];
    if (visibleClasses != null) {
      conditions.push(["match", ["get", "relationship_class"], Array.from(visibleClasses), true, false] as FilterSpecification);
    }
    return conditions.length === 1 ? conditions[0] : (["all", ...conditions] as FilterSpecification);
  }

  $effect(() => {
    // Read reactive deps before any early return so Svelte tracks them.
    const filter = buildFillFilter();
    if (!map || !styleReady) return;
    for (const layer of ["cw-overlay-fill", "cw-outline-a-fill", "cw-outline-b-fill"]) {
      if (map.getLayer(layer)) map.setFilter(layer, filter);
    }
  });

  $effect(() => {
    // Read reactive deps before any early return so Svelte tracks them.
    const opExpr = fillOpacityExpr();
    const highlightFilter: FilterSpecification =
      selectedClusterId == null
        ? (["==", ["get", "cluster_id"], -1] as FilterSpecification)
        : (["==", ["get", "cluster_id"], selectedClusterId] as FilterSpecification);
    if (!map || !styleReady) return;
    for (const layer of ["cw-overlay-fill", "cw-outline-a-fill", "cw-outline-b-fill"]) {
      if (map.getLayer(layer)) map.setPaintProperty(layer, "fill-opacity", opExpr);
    }
    for (const layer of ["cw-highlight-line", "cw-outline-a-highlight", "cw-outline-b-highlight"]) {
      if (map.getLayer(layer)) map.setFilter(layer, highlightFilter);
    }
  });

  function applySideVisibility(side: "a" | "b"): void {
    if (!map) return;
    const vis = (id: string, v: boolean) => {
      if (map!.getLayer(id)) map!.setLayoutProperty(id, "visibility", v ? "visible" : "none");
    };
    const isA = side === "a";
    vis("cw-overlay-fill", false);
    vis("cw-outline-a-fill", isA);
    vis("cw-outline-b-fill", !isA);
    vis("cw-outline-a-line", isA);
    vis("cw-outline-b-line", !isA);
    vis("cw-highlight-line", false);
    vis("cw-outline-a-highlight", isA);
    vis("cw-outline-b-highlight", !isA);
  }

  $effect(() => {
    // Visibility driven by showSide: toggles overlay fill vs side fills + outlines.
    // Read reactive dep before any early return.
    const side = showSide;
    if (!map || !styleReady) return;
    // Cancel any pending frame so rapid changes don't produce intermediate renders.
    if (sidePending !== undefined) cancelAnimationFrame(sidePending);
    sidePending = requestAnimationFrame(() => applySideVisibility(side));
  });

  $effect(() => {
    const b = bounds;
    if (!b || !map) return;
    function apply() {
      if (!map || !b) return;
      const [minLng, minLat, maxLng, maxLat] = b;
      stopSpin();
      map.fitBounds(
        [
          [minLng, minLat],
          [maxLng, maxLat],
        ],
        { padding: 40, animate: true },
      );
    }
    if (map.isStyleLoaded()) apply();
    else map.once("load", apply);
  });

  function setSource(id: string, dataUrl: string): void {
    if (!map) return;
    const src = map.getSource(id) as GeoJSONSource | undefined;
    if (src) src.setData(dataUrl);
  }

  $effect(() => {
    const data = overlayGeojson;
    if (!data || !map || !styleReady) return;
    if (overlayUrl) URL.revokeObjectURL(overlayUrl);
    overlayUrl = URL.createObjectURL(new Blob([data], { type: "application/json" }));
    if (!map.getSource("cw-overlay")) {
      map.addSource("cw-overlay", { type: "geojson", data: overlayUrl, promoteId: "cluster_id" });
      map.addLayer({
        id: "cw-overlay-fill",
        type: "fill",
        source: "cw-overlay",
        filter: polyFilter,
        paint: {
          "fill-color": fillColorExpr(),
          "fill-opacity": fillOpacityExpr(),
          "fill-outline-color": [
            "interpolate",
            ["linear"],
            ["zoom"],
            5, "rgba(0,0,0,0)",
            8, "rgba(0,0,0,0.25)",
            12, "rgba(0,0,0,0.6)",
          ] as unknown as string,
        },
      });
      // Highlight outline for the selected cluster — sits above outlines so
      // it's always on top. The filter is updated by the selection effect.
      map.addLayer({
        id: "cw-highlight-line",
        type: "line",
        source: "cw-overlay",
        filter: ["==", ["get", "cluster_id"], -1] as FilterSpecification,
        paint: {
          "line-color": "#111",
          "line-width": 2.5,
        },
      });
    } else {
      setSource("cw-overlay", overlayUrl);
    }
  });

  function addOutline(side: "a" | "b", dataUrl: string): void {
    if (!map) return;
    const id = `cw-outline-${side}`;
    if (map.getSource(id)) {
      setSource(id, dataUrl);
      return;
    }
    map.addSource(id, { type: "geojson", data: dataUrl });
    const beforeId = map.getLayer("cw-highlight-line") ? "cw-highlight-line" : undefined;
    const outlineWidth = ["interpolate", ["linear"], ["zoom"], 4, 0.5, 8, 1, 12, 2, 16, 4] as unknown as number;
    // Fill layer for single-side comparison mode — hidden by default, shown when showSide matches.
    map.addLayer(
      {
        id: `cw-outline-${side}-fill`,
        type: "fill",
        source: id,
        layout: { visibility: "none" },
        paint: {
          "fill-color": fillColorExpr(),
          "fill-opacity": fillOpacityExpr(),
          "fill-outline-color": [
            "interpolate",
            ["linear"],
            ["zoom"],
            5, "rgba(0,0,0,0)",
            8, "rgba(0,0,0,0.25)",
            12, "rgba(0,0,0,0.6)",
          ] as unknown as string,
        },
      },
      beforeId,
    );
    map.addLayer(
      {
        id: `cw-outline-${side}-line`,
        type: "line",
        source: id,
        paint: {
          "line-color": "#000",
          "line-width": outlineWidth,
        },
      },
      beforeId,
    );
    // Highlight outline for selected cluster on this side's source.
    map.addLayer({
      id: `cw-outline-${side}-highlight`,
      type: "line",
      source: id,
      filter: ["==", ["get", "cluster_id"], -1] as FilterSpecification,
      layout: { visibility: "none" },
      paint: { "line-color": "#111", "line-width": 2.5 },
    });
    map.on("mousemove", `cw-outline-${side}-fill`, () => {
      if (map) map.getCanvas().style.cursor = "pointer";
    });
    map.on("mouseleave", `cw-outline-${side}-fill`, () => {
      if (map) map.getCanvas().style.cursor = "";
    });
    // Apply current showSide visibility since the effect won't re-fire for newly added layers.
    applySideVisibility(showSide);
  }

  $effect(() => {
    const data = outlineAGeojson;
    if (!data || !map || !styleReady) return;
    if (outlineAUrl) URL.revokeObjectURL(outlineAUrl);
    outlineAUrl = URL.createObjectURL(new Blob([data], { type: "application/json" }));
    addOutline("a", outlineAUrl);
  });

  $effect(() => {
    const data = outlineBGeojson;
    if (!data || !map || !styleReady) return;
    if (outlineBUrl) URL.revokeObjectURL(outlineBUrl);
    outlineBUrl = URL.createObjectURL(new Blob([data], { type: "application/json" }));
    addOutline("b", outlineBUrl);
  });

  function handleMapClick(e: MapMouseEvent): void {
    if (!map || !onClusterClick) return;
    const fillLayer =
      showSide === "a" ? "cw-outline-a-fill"
      : showSide === "b" ? "cw-outline-b-fill"
      : "cw-overlay-fill";
    if (!map.getLayer(fillLayer)) { onClusterClick(null); return; }
    const feats = map.queryRenderedFeatures(e.point, { layers: [fillLayer] });
    if (feats.length === 0) {
      onClusterClick(null);
      return;
    }
    const cid = feats[0].properties?.cluster_id;
    onClusterClick(cid == null ? null : Number(cid));
  }

  onMount(async () => {
    if (!container) return;
    const maplibregl = await import("maplibre-gl");
    const style = await loadStyle();
    map = new maplibregl.Map({
      container,
      style,
      center: [20, 5],
      zoom: Math.log2((Math.min(container.clientWidth, container.clientHeight) * Math.PI) / 512),
      attributionControl: { compact: true },
    });
    map.once("load", () => {
      styleReady = true;
      startSpin();
      map?.on("mousedown", stopSpin);
      map?.on("touchstart", stopSpin);
      map?.on("wheel", stopSpin);
      map?.on("click", handleMapClick);
      map?.on("mousemove", "cw-overlay-fill", () => {
        if (map) map.getCanvas().style.cursor = "pointer";
      });
      map?.on("mouseleave", "cw-overlay-fill", () => {
        if (map) map.getCanvas().style.cursor = "";
      });
    });
  });

  onDestroy(() => {
    stopSpin();
    map?.remove();
    if (overlayUrl) URL.revokeObjectURL(overlayUrl);
    if (outlineAUrl) URL.revokeObjectURL(outlineAUrl);
    if (outlineBUrl) URL.revokeObjectURL(outlineBUrl);
  });
</script>

<div bind:this={container} class="cw-map"></div>

<style>
  .cw-map {
    width: 100%;
    height: 100%;
    min-height: 400px;
  }
</style>
