import type {
  FilterSpecification,
  LayerSpecification,
  StyleSpecification,
} from "maplibre-gl";

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

export async function loadStyle(): Promise<StyleSpecification> {
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

export const polyFilter: FilterSpecification = [
  "match",
  ["geometry-type"],
  ["Polygon", "MultiPolygon"],
  true,
  false,
];

export const lineWidth = [
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
