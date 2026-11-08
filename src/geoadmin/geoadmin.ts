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

export async function getParcelsForEnvelopes(envelopes: string[]): Promise<GeoAdminParcels[]> {
  const parcels: GeoAdminParcels[] = [];
  for (const envelope of envelopes) {
    const url = buildUrl(envelope);
    const response = await axios.get<GeoAdminResponse>(url);
    parcels.push(...response.data.results);
  }
  return parcels;
}
