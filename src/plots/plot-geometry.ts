import { SQL, sql } from "drizzle-orm";
import { MultiPolygon } from "../geo/geojson";

// Points closer than this (in degrees, ~1 mm) are merged. Cutting plots out of each other can leave several
// vertices a fraction of a millimetre apart; the API returns 9 decimals, so clients see them as duplicate points.
const REPEATED_POINT_TOLERANCE_DEGREES = 0.00000001;

// Same repair as "Fix geometries" in QGIS (and the shapefile import): resolves self-intersections, keeps only the
// polygon parts and forces a counter-clockwise MultiPolygon. Invalid geometries make ST_Difference fail with a
// GEOS TopologyException, which blocks every plot drawn next to them.
export function repairedMultiPolygon(geometry: SQL): SQL<MultiPolygon> {
  return sql<MultiPolygon>`ST_ForcePolygonCCW(ST_Multi(ST_CollectionExtract(ST_MakeValid(ST_RemoveRepeatedPoints(${geometry}, ${REPEATED_POINT_TOLERANCE_DEGREES}), 'method=structure'), 3)))`;
}
