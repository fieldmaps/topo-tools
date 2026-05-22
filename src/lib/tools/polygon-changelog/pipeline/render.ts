import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";

// Builds cw_overlay_render — the union of overlap pieces and the two side-only
// difference pieces, each tagged with cluster_id + relationship_class. This is
// the table that the map renders as the choropleth overlay.
//
// Sub-piece selection:
//  - cw_overlap → cluster_id from cw_polygon_class on the A side (an overlap
//    piece always has both a_fid and b_fid; either side resolves to the same
//    cluster). relationship_class likewise carried by the polygon-class row.
//  - cw_a_only  → must come from a 'removed' cluster (or, defensively, from a
//    cluster whose A-only sub-piece sits inside a "modified" cluster where the
//    polygon didn't fully overlap). The cluster_id is the A polygon's cluster.
//  - cw_b_only  → analogous to cw_a_only on the B side.

export async function stageRender(conn: AsyncDuckDBConnection): Promise<void> {
  await conn.query("DROP TABLE IF EXISTS cw_overlay_render");

  await conn.query(`--sql
    CREATE TABLE cw_overlay_render AS
    SELECT
      ST_Multi(o.geom) AS geom,
      pc.cluster_id AS cluster_id,
      pc.relationship_class AS relationship_class,
      'both' AS piece_side,
      o.a_fid AS a_fid,
      o.b_fid AS b_fid
    FROM cw_overlap o
    LEFT JOIN cw_polygon_class pc
      ON pc.side = 'a' AND pc.fid = o.a_fid

    UNION ALL

    SELECT
      ST_Multi(ao.geom) AS geom,
      pc.cluster_id AS cluster_id,
      pc.relationship_class AS relationship_class,
      'a_only' AS piece_side,
      ao.a_fid AS a_fid,
      NULL::INTEGER AS b_fid
    FROM cw_a_only ao
    LEFT JOIN cw_polygon_class pc
      ON pc.side = 'a' AND pc.fid = ao.a_fid

    UNION ALL

    SELECT
      ST_Multi(bo.geom) AS geom,
      pc.cluster_id AS cluster_id,
      pc.relationship_class AS relationship_class,
      'b_only' AS piece_side,
      NULL::INTEGER AS a_fid,
      bo.b_fid AS b_fid
    FROM cw_b_only bo
    LEFT JOIN cw_polygon_class pc
      ON pc.side = 'b' AND pc.fid = bo.b_fid
  `);
}

// Serialize the overlay table to a GeoJSON FeatureCollection string.
export async function buildOverlayGeoJSON(conn: AsyncDuckDBConnection): Promise<string> {
  const rows = (
    await conn.query(`--sql
      SELECT
        ST_AsGeoJSON(geom) AS _geom,
        cluster_id,
        relationship_class,
        piece_side,
        a_fid,
        b_fid
      FROM cw_overlay_render
      WHERE geom IS NOT NULL
    `)
  ).toArray() as Array<Record<string, unknown>>;

  const features = rows.map((r) => ({
    type: "Feature",
    geometry: JSON.parse(r._geom as string),
    properties: {
      cluster_id: r.cluster_id == null ? null : Number(r.cluster_id),
      relationship_class: r.relationship_class,
      piece_side: r.piece_side,
      a_fid: r.a_fid == null ? null : Number(r.a_fid),
      b_fid: r.b_fid == null ? null : Number(r.b_fid),
    },
  }));

  return JSON.stringify({ type: "FeatureCollection", features }, (_k, v) =>
    typeof v === "bigint" ? Number(v) : v,
  );
}

// Serialize one side's keyed source layer (geometry + fid + cluster_id) for the
// outline overlay on top of the choropleth. cluster_id is used downstream so a
// click on the outline still resolves to the right cluster selection.
export async function buildOutlineGeoJSON(
  conn: AsyncDuckDBConnection,
  side: "a" | "b",
): Promise<string> {
  const rows = (
    await conn.query(`--sql
      SELECT
        ST_AsGeoJSON(k.geom) AS _geom,
        k.fid AS fid,
        pc.cluster_id AS cluster_id,
        pc.relationship_class AS relationship_class
      FROM cw_${side}_keyed k
      LEFT JOIN cw_polygon_class pc ON pc.side = '${side}' AND pc.fid = k.fid
      WHERE k.geom IS NOT NULL
    `)
  ).toArray() as Array<Record<string, unknown>>;

  const features = rows.map((r) => ({
    type: "Feature",
    geometry: JSON.parse(r._geom as string),
    properties: {
      fid: r.fid == null ? null : Number(r.fid),
      cluster_id: r.cluster_id == null ? null : Number(r.cluster_id),
      relationship_class: r.relationship_class,
      side,
    },
  }));

  return JSON.stringify({ type: "FeatureCollection", features }, (_k, v) =>
    typeof v === "bigint" ? Number(v) : v,
  );
}

export async function computeBounds(
  conn: AsyncDuckDBConnection,
): Promise<[number, number, number, number] | null> {
  try {
    const r = await conn.query(`--sql
      SELECT
        MIN(ST_XMin(geom)) AS xmin,
        MIN(ST_YMin(geom)) AS ymin,
        MAX(ST_XMax(geom)) AS xmax,
        MAX(ST_YMax(geom)) AS ymax
      FROM cw_overlay_render
      WHERE geom IS NOT NULL
    `);
    const row = r.toArray()[0] as Record<string, number>;
    const { xmin, ymin, xmax, ymax } = row;
    if (isFinite(xmin) && isFinite(ymin) && isFinite(xmax) && isFinite(ymax)) {
      return [xmin, ymin, xmax, ymax];
    }
    return null;
  } catch {
    return null;
  }
}
