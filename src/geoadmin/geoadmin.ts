import axios from "axios";

interface GeoAdminResponse {
  results: GeoAdminParcels[];
}

export interface GeoAdminParcels {
  type: string;
  featureId: number;
  bbox: number[];
  layerBodId: string;
  layerName: string;
  id: number;
  geometry: Geometry;
  properties: Properties;
}

interface Geometry {
  type: string;
  coordinates: any[][][];
}

interface Properties {
  fid?: string;
  number?: string;
  gemeindename?: string;
  kanton?: string;
  oereb_status_de: string;
  oereb_status_fr: string;
  oereb_status_it: string;
  oereb_status_rm: string;
  oereb_status_en: string;
  bfs_nr: number;
  firmenname?: string;
  adresszeile?: string;
  plz?: number;
  ort?: string;
  telefon?: string;
  email?: string;
  url_oereb?: string;
  oereb_webservice?: string;
  bgdi_status?: number;
  egris_egrid?: string;
  oereb_extract_pdf?: string;
  oereb_extract_url?: string;
  realestate_type?: string;
  label?: string;
}

// Config
const BASE_URL = "https://api3.geo.admin.ch/rest/services/api/MapServer/identify";

function buildUrl(geometry: string, offset: string = "0") {
  const params = new URLSearchParams({
    sr: "4326",
    geometry: geometry,
    geometryFormat: "geojson",
    geometryType: "esriGeometryEnvelope",
    tolerance: "0",
    layers: "all:ch.swisstopo-vd.stand-oerebkataster",
    offset,
  });
  return `${BASE_URL}?${params.toString()}`;
}

// identify returns at most ~202 features per request. Paging with offset skips and repeats features, so an
// envelope that comes back (nearly) full is split into four and queried again.
const FULL_RESPONSE_THRESHOLD = 200;
// 8 splits shrink an envelope by 256 in each direction, far below parcel size
const MAX_SPLIT_DEPTH = 8;
const REQUEST_TIMEOUT_MS = 15_000;

// Envelopes are "xmin,ymin,xmax,ymax" in EPSG:4326. Parcels on tile borders are returned once.
export async function getParcelsForEnvelopes(envelopes: string[]): Promise<GeoAdminParcels[]> {
  const parcelsById = new Map<number, GeoAdminParcels>();

  async function collectParcels(xMin: number, yMin: number, xMax: number, yMax: number, depth: number) {
    const envelope = `${xMin},${yMin},${xMax},${yMax}`;
    const response = await axios.get<GeoAdminResponse>(buildUrl(envelope), { timeout: REQUEST_TIMEOUT_MS });
    const results = response.data.results;
    if (results.length >= FULL_RESPONSE_THRESHOLD && depth >= MAX_SPLIT_DEPTH) {
      console.warn(`[geoadmin] parcels of envelope ${envelope} may be incomplete, still full at the deepest split`);
    }
    if (results.length < FULL_RESPONSE_THRESHOLD || depth >= MAX_SPLIT_DEPTH) {
      for (const parcel of results) parcelsById.set(parcel.id, parcel);
      return;
    }
    const xMid = (xMin + xMax) / 2;
    const yMid = (yMin + yMax) / 2;
    await collectParcels(xMin, yMin, xMid, yMid, depth + 1);
    await collectParcels(xMid, yMin, xMax, yMid, depth + 1);
    await collectParcels(xMin, yMid, xMid, yMax, depth + 1);
    await collectParcels(xMid, yMid, xMax, yMax, depth + 1);
  }

  for (const envelope of envelopes) {
    const [xMin, yMin, xMax, yMax] = envelope.split(",").map(Number);
    await collectParcels(xMin, yMin, xMax, yMax, 0);
  }
  return [...parcelsById.values()];
}
