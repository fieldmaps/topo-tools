import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";

// Sliver fixing by MOUTH PINCH.
//
// A sliver is a thin near-miss crack between two units. It's open (not an enclosed
// hole), so ST_CoverageClean's gap-fill ignores it. The fix the user wants — and the
// one that works — is to "pinch the mouth shut": snap the crack's open-end vertices
// together so the thin strip becomes an ENCLOSED gap. Once enclosed, the existing
// gap-fill (ST_CoverageClean's gap parameter, already in the pipeline) absorbs it
// into a neighbour. Validated against a hand-pinched coverage: pinching converts a
// sliver into a gap (Slivers−1, Gaps+1) that then fills.
//
// The operation is a pure vertex snap: every layer_01 vertex inside the user's
// selection box is moved to the box's vertex-centroid, rebuilding the affected
// polygons. Structure-preserving — parts and holes are kept; only the boxed vertices
// move. The user selects the mouth, so only the handful of near-coincident mouth
// vertices collapse to one point.

export interface PinchResult {
  ok: boolean;
  reason?: string;
  movedVertices: number; // how many vertices were snapped
}

// Snap every layer_01 vertex within `bbox` ([minLng,minLat,maxLng,maxLat]) to the
// centroid of those vertices, rebuilding the affected polygons in place. Returns the
// count of moved vertices (0 → nothing in the box, caller can treat as a no-op).
export async function snapVerticesInBox(
  conn: AsyncDuckDBConnection,
  bbox: [number, number, number, number],
): Promise<PinchResult> {
  const [x0, y0, x1, y1] = bbox;
  // Vertex-in-box test, reused in the anchor CTE and the snap lambda. `p` / the
  // lambda's pt is a POINT.
  const inBox = (p: string) =>
    `ST_X(${p}) BETWEEN ${x0} AND ${x1} AND ST_Y(${p}) BETWEEN ${y0} AND ${y1}`;

  // Affected polygons: any whose bbox overlaps the selection box (bbox-prefiltered,
  // no SPATIAL_JOIN). We rebuild each from its parts → rings → vertices.
  try {
    await conn.query(`--sql
      CREATE OR REPLACE TABLE tc_pinch AS
      WITH
      affected AS (
        SELECT fid, geom FROM layer_01
        WHERE ST_XMax(geom) >= ${x0} AND ST_XMin(geom) <= ${x1}
          AND ST_YMax(geom) >= ${y0} AND ST_YMin(geom) <= ${y1}
      ),
      -- explode to parts (keep part index so multipolygons reassemble correctly)
      parts AS (
        SELECT fid, (d).path[1] AS pidx, (d).geom AS part
        FROM (SELECT fid, UNNEST(ST_Dump(geom)) AS d FROM affected)
      ),
      -- explode each part to its rings: ridx 0 = exterior, 1..k = holes
      rings AS (
        SELECT fid, pidx, 0 AS ridx, ST_ExteriorRing(part) AS ring FROM parts
        UNION ALL
        SELECT fid, pidx, g AS ridx, ST_InteriorRingN(part, g::INTEGER) AS ring
        FROM parts, generate_series(1, ST_NumInteriorRings(part)) AS t(g)
      ),
      -- anchor = centroid of all boxed vertices across all affected rings
      anchor AS (
        SELECT ST_Centroid(ST_Collect(list(pt))) AS a, COUNT(*) AS n FROM (
          SELECT r.ring, UNNEST(list_transform(
            generate_series(1, ST_NPoints(r.ring)), i -> ST_PointN(r.ring, i::INTEGER)
          )) AS pt
          FROM rings r
        ) WHERE ${inBox("pt")}
      ),
      -- rebuild each ring, snapping boxed vertices to the anchor
      snapped AS (
        SELECT r.fid, r.pidx, r.ridx,
          ST_RemoveRepeatedPoints(ST_MakeLine(list_transform(
            generate_series(1, ST_NPoints(r.ring)),
            i -> CASE WHEN ${inBox("ST_PointN(r.ring, i::INTEGER)")}
                      THEN anchor.a ELSE ST_PointN(r.ring, i::INTEGER) END
          ))) AS ring
        FROM rings r CROSS JOIN anchor
      ),
      -- reassemble parts (exterior ring + holes), then the (multi)polygon
      rebuilt_parts AS (
        SELECT fid, pidx,
          CASE WHEN COUNT(*) FILTER (WHERE ridx > 0) = 0
               THEN ST_MakePolygon(MAX(ring) FILTER (WHERE ridx = 0))
               ELSE ST_MakePolygon(MAX(ring) FILTER (WHERE ridx = 0),
                                   array_agg(ring) FILTER (WHERE ridx > 0)) END AS part
        FROM snapped GROUP BY fid, pidx
      ),
      rebuilt AS (
        SELECT fid,
          ST_MakeValid(CASE WHEN COUNT(*) = 1 THEN MAX(part) ELSE ST_Collect(list(part)) END) AS geom
        FROM rebuilt_parts GROUP BY fid
      )
      SELECT r.fid, r.geom, (SELECT n FROM anchor) AS moved FROM rebuilt r
    `);
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e), movedVertices: 0 };
  }

  const moved = await conn.query("SELECT COALESCE(MAX(moved), 0) AS n FROM tc_pinch");
  const movedVertices = Number((moved.toArray()[0] as { n: bigint | number }).n ?? 0);
  if (movedVertices === 0) {
    return { ok: false, reason: "no vertices in the selection", movedVertices: 0 };
  }

  // Guard: every rebuilt geometry must be valid and non-empty before committing.
  const bad = await conn.query(`--sql
    SELECT COUNT(*) AS n FROM tc_pinch WHERE geom IS NULL OR ST_IsEmpty(geom) OR NOT ST_IsValid(geom)
  `);
  if (Number((bad.toArray()[0] as { n: bigint | number }).n ?? 0) > 0) {
    return { ok: false, reason: "pinch produced invalid geometry", movedVertices };
  }

  await conn.query(`--sql
    UPDATE layer_01 SET geom = (SELECT geom FROM tc_pinch p WHERE p.fid = layer_01.fid)
    WHERE fid IN (SELECT fid FROM tc_pinch)
  `);
  return { ok: true, movedVertices };
}

// Delete every layer_01 vertex within `bbox`, rebuilding affected polygons without them.
// Rings that would drop below 3 distinct vertices are left intact (the part is dropped if
// its exterior ring degenerates; holes that degenerate are simply omitted).
export async function deleteVerticesInBox(
  conn: AsyncDuckDBConnection,
  bbox: [number, number, number, number],
): Promise<PinchResult> {
  const [x0, y0, x1, y1] = bbox;
  const inBox = (p: string) =>
    `ST_X(${p}) BETWEEN ${x0} AND ${x1} AND ST_Y(${p}) BETWEEN ${y0} AND ${y1}`;

  try {
    await conn.query(`--sql
      CREATE OR REPLACE TABLE tc_pinch AS
      WITH
      affected AS (
        SELECT fid, geom FROM layer_01
        WHERE ST_XMax(geom) >= ${x0} AND ST_XMin(geom) <= ${x1}
          AND ST_YMax(geom) >= ${y0} AND ST_YMin(geom) <= ${y1}
      ),
      parts AS (
        SELECT fid, (d).path[1] AS pidx, (d).geom AS part
        FROM (SELECT fid, UNNEST(ST_Dump(geom)) AS d FROM affected)
      ),
      rings AS (
        SELECT fid, pidx, 0 AS ridx, ST_ExteriorRing(part) AS ring FROM parts
        UNION ALL
        SELECT fid, pidx, g AS ridx, ST_InteriorRingN(part, g::INTEGER) AS ring
        FROM parts, generate_series(1, ST_NumInteriorRings(part)) AS t(g)
      ),
      -- count non-closing vertices in box (what will be removed)
      del_count AS (
        SELECT SUM(len(list_filter(
          list_transform(generate_series(1, ST_NPoints(ring) - 1), i -> ST_PointN(ring, i::INTEGER)),
          pt -> (${inBox("pt")})
        )))::BIGINT AS n
        FROM rings
      ),
      -- for each ring: keep non-closing vertices outside the box
      open_rings AS (
        SELECT fid, pidx, ridx,
          list_filter(
            list_transform(
              generate_series(1, ST_NPoints(ring) - 1),
              i -> ST_PointN(ring, i::INTEGER)
            ),
            pt -> NOT (${inBox("pt")})
          ) AS kepts
        FROM rings
      ),
      -- close ring by repeating first kept vertex; skip degenerate rings (< 3 vertices)
      del_rings AS (
        SELECT fid, pidx, ridx,
          CASE WHEN len(kepts) >= 3
            THEN ST_RemoveRepeatedPoints(ST_MakeLine(list_append(kepts, kepts[1])))
            ELSE NULL
          END AS ring
        FROM open_rings
      ),
      -- reassemble parts; drop any part whose exterior ring became degenerate
      rebuilt_parts AS (
        SELECT fid, pidx,
          CASE WHEN COUNT(*) FILTER (WHERE ridx > 0) = 0
               THEN ST_MakePolygon(MAX(ring) FILTER (WHERE ridx = 0))
               ELSE ST_MakePolygon(MAX(ring) FILTER (WHERE ridx = 0),
                                   array_agg(ring) FILTER (WHERE ridx > 0)) END AS part
        FROM del_rings
        WHERE ring IS NOT NULL
        GROUP BY fid, pidx
        HAVING MAX(ring) FILTER (WHERE ridx = 0) IS NOT NULL
      ),
      rebuilt AS (
        SELECT fid,
          ST_MakeValid(CASE WHEN COUNT(*) = 1 THEN MAX(part) ELSE ST_Collect(list(part)) END) AS geom
        FROM rebuilt_parts GROUP BY fid
      )
      SELECT r.fid, r.geom, (SELECT n FROM del_count) AS moved FROM rebuilt r
    `);
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e), movedVertices: 0 };
  }

  const moved = await conn.query("SELECT COALESCE(MAX(moved), 0) AS n FROM tc_pinch");
  const movedVertices = Number((moved.toArray()[0] as { n: bigint | number }).n ?? 0);
  if (movedVertices === 0) {
    return { ok: false, reason: "no vertices in the selection", movedVertices: 0 };
  }

  const bad = await conn.query(`--sql
    SELECT COUNT(*) AS n FROM tc_pinch WHERE geom IS NULL OR ST_IsEmpty(geom) OR NOT ST_IsValid(geom)
  `);
  if (Number((bad.toArray()[0] as { n: bigint | number }).n ?? 0) > 0) {
    return { ok: false, reason: "delete produced invalid geometry", movedVertices };
  }

  await conn.query(`--sql
    UPDATE layer_01 SET geom = (SELECT geom FROM tc_pinch p WHERE p.fid = layer_01.fid)
    WHERE fid IN (SELECT fid FROM tc_pinch)
  `);
  return { ok: true, movedVertices };
}
