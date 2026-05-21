<script lang="ts">
  import type {
    ExpressionSpecification,
    FilterSpecification,
    GeoJSONSource,
    LayerSpecification,
    Map as MaplibreMap,
    MapMouseEvent,
    StyleSpecification,
  } from "maplibre-gl";
  import "maplibre-gl/dist/maplibre-gl.css";
  import { onDestroy, onMount } from "svelte";
  import { createSpin } from "$lib/utils/spin";

  let {
    overlayGeojson = null,
    outlineAGeojson = null,
    outlineBGeojson = null,
    bounds = null,
    selectedClusterId = null,
    visibleClasses = null,
    onClusterClick,
  }: {
    overlayGeojson?: string | null;
    outlineAGeojson?: string | null;
    outlineBGeojson?: string | null;
    bounds?: [number, number, number, number] | null;
    selectedClusterId?: number | null;
    visibleClasses?: Set<string> | null;
    onClusterClick?: (id: number | null) => void;
  } = $props();

  let container: HTMLDivElement | undefined;
  let map: MaplibreMap | undefined;
  let overlayUrl: string | undefined;
  let outlineAUrl: string | undefined;
  let outlineBUrl: string | undefined;
  let styleReady = false;
  const { start: startSpin, stop: stopSpin } = createSpin(() => map);

  const polyFilter: FilterSpecification = [
    "match",
    ["geometry-type"],
    ["Polygon", "MultiPolygon"],
    true,
    false,
  ];

  const lineWidth = [
    "interpolate",
    ["linear"],
    ["zoom"],
    4,
    0.2,
    10,
    0.6,
    14,
    1,
  ] as unknown as number;

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

  $effect(() => {
    // Visibility filter on the overlay fill: hide pieces whose class is filtered out.
    if (!map || !styleReady) return;
    const layer = "cw-overlay-fill";
    if (!map.getLayer(layer)) return;
    if (visibleClasses == null) {
      map.setFilter(layer, polyFilter);
      return;
    }
    const classList = Array.from(visibleClasses);
    map.setFilter(layer, [
      "all",
      polyFilter,
      ["match", ["get", "relationship_class"], classList, true, false],
    ] as FilterSpecification);
  });

  $effect(() => {
    // Selection styling: update fill-opacity and the highlight outline filter.
    if (!map || !styleReady) return;
    const opExpr = fillOpacityExpr();
    if (map.getLayer("cw-overlay-fill")) {
      map.setPaintProperty("cw-overlay-fill", "fill-opacity", opExpr);
    }
    const highlightFilter: FilterSpecification =
      selectedClusterId == null
        ? (["==", ["get", "cluster_id"], -1] as FilterSpecification) // matches nothing
        : (["==", ["get", "cluster_id"], selectedClusterId] as FilterSpecification);
    if (map.getLayer("cw-highlight-line")) {
      map.setFilter("cw-highlight-line", highlightFilter);
    }
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
          "fill-outline-color": "#444",
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
    // Side A (Previous) renders as a dashed darker outline; Side B (New) as a solid
    // slightly lighter outline. Both render above the fill but below the
    // highlight line.
    const beforeId = map.getLayer("cw-highlight-line") ? "cw-highlight-line" : undefined;
    map.addLayer(
      {
        id: `cw-outline-${side}-line`,
        type: "line",
        source: id,
        paint:
          side === "a"
            ? {
                "line-color": "#222",
                "line-width": lineWidth,
                "line-dasharray": [2, 2],
              }
            : {
                "line-color": "#000",
                "line-width": lineWidth,
              },
      },
      beforeId,
    );
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

  // Local fallback basemap — same approach as the shared MapView so offline
  // mode still shows land vs water.
  const LAND_SOURCE_ID = "ne-land";
  const LAND_LAYER_ID = "ne-land-fill";
  const LAND_URL = "/data/ne_50m_land.geojson";
  const WATER_COLOR = "#dde6ed";
  const LAND_COLOR = "#f5f5f3";

  const fallbackStyle: StyleSpecification = {
    version: 8,
    projection: { type: "globe" },
    sources: { [LAND_SOURCE_ID]: { type: "geojson", data: LAND_URL } },
    layers: [
      { id: "background", type: "background", paint: { "background-color": WATER_COLOR } },
      {
        id: LAND_LAYER_ID,
        type: "fill",
        source: LAND_SOURCE_ID,
        paint: { "fill-color": LAND_COLOR },
      },
    ],
  };

  async function loadStyle(): Promise<StyleSpecification> {
    try {
      const remote = (await fetch("https://tiles.openfreemap.org/styles/positron").then((r) =>
        r.json(),
      )) as StyleSpecification & { sources: Record<string, unknown> };
      remote.projection = { type: "globe" };
      remote.sources[LAND_SOURCE_ID] = { type: "geojson", data: LAND_URL };
      const landLayer: LayerSpecification = {
        id: LAND_LAYER_ID,
        type: "fill",
        source: LAND_SOURCE_ID,
        paint: { "fill-color": LAND_COLOR },
      };
      const bgIdx = remote.layers.findIndex((l) => l.type === "background");
      const insertAt = bgIdx >= 0 ? bgIdx + 1 : 0;
      remote.layers.splice(insertAt, 0, landLayer);
      return remote;
    } catch {
      return fallbackStyle;
    }
  }

  function handleMapClick(e: MapMouseEvent): void {
    if (!map || !onClusterClick) return;
    const feats = map.queryRenderedFeatures(e.point, { layers: ["cw-overlay-fill"] });
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
