export interface Tool {
  slug: string;
  name: string;
  tagline: string;
  iconHref: string;
}

export const tools: Tool[] = [
  {
    slug: "extend",
    name: "Edge Extender",
    tagline:
      "Fill gaps between adjacent polygons by extending boundaries outward with Voronoi diagrams.",
    iconHref: "/icons/tools/edge-extender.svg",
  },
  {
    slug: "crosswalk",
    name: "Boundary Cross-walk",
    tagline:
      "Compare two versions of a polygon layer and classify each unit as unchanged, modified, merged, split, created, or removed.",
    iconHref: "/icons/tools/boundary-crosswalk.svg",
  },
];
