export interface Tool {
  slug: string;
  name: string;
  tagline: string;
  iconHref: string;
}

export const tools: Tool[] = [
  {
    slug: "clean",
    name: "Topology Cleaner",
    tagline:
      "Detect overlaps and gaps in a polygon coverage and clean them automatically, with an adjustable gap-width threshold.",
    iconHref: "/icons/tools/topology-cleaner.svg",
  },
  {
    slug: "extend",
    name: "Edge Extender",
    tagline:
      "Fill gaps between adjacent polygons by extending boundaries outward with Voronoi diagrams.",
    iconHref: "/icons/tools/edge-extender.svg",
  },
  {
    slug: "changelog",
    name: "Changelog",
    tagline:
      "Compare two versions of a polygon layer and classify each unit as unchanged, modified, merged, split, created, or removed.",
    iconHref: "/icons/tools/polygon-changelog.svg",
  },
];
