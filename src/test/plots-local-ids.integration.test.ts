// jest.mock is hoisted before imports by Jest — only the HTTP call to geo.admin is mocked
// mockGet is only called lazily from the factory, after it has been initialized below
jest.mock("axios", () => ({ __esModule: true, default: { get: (url: string) => mockGet(url) } }));

import { describe, it, expect, beforeAll, beforeEach, jest } from "@jest/globals";
import { sql } from "drizzle-orm";
import i18next from "i18next";
import de from "../../resources/locales/de.json";
import { rlsDb } from "../db/db";
import * as schema from "../db/schema";
import type { GeoAdminParcels } from "../geoadmin/geoadmin";
import { plotsApi } from "../plots/plots";
import type { SupabaseToken } from "../supabase/supabase";
import { cleanDb, getAdminDb } from "./helpers";
import { createPlot, createUserWithFarm } from "./test-utils";

const mockGet = jest.fn<(url: string) => Promise<{ data: { results: GeoAdminParcels[] } }>>();

function square(xMin: number, yMin: number, xMax: number, yMax: number): number[][][] {
  return [
    [
      [xMin, yMin],
      [xMax, yMin],
      [xMax, yMax],
      [xMin, yMax],
      [xMin, yMin],
    ],
  ];
}

function parcel(id: number, number: string, realestateType: string, coordinates: number[][][]): GeoAdminParcels {
  return {
    type: "Feature",
    featureId: id,
    bbox: [],
    layerBodId: "ch.swisstopo-vd.stand-oerebkataster",
    layerName: "Parcels",
    id,
    geometry: { type: "Polygon", coordinates },
    properties: {
      number,
      realestate_type: realestateType,
      oereb_status_de: "",
      oereb_status_fr: "",
      oereb_status_it: "",
      oereb_status_rm: "",
      oereb_status_en: "",
      bfs_nr: 5586,
    },
  };
}

// Plot A spans two parcels (60% in 101, 40% in 102)
const PLOT_A = square(8.0, 47.0, 8.01, 47.01);
const PARCEL_101 = parcel(101, "101", "Liegenschaft", square(7.99, 46.99, 8.006, 47.02));
const PARCEL_102 = parcel(102, "102", "Liegenschaft", square(8.006, 46.99, 8.02, 47.02));
// Plot B lies inside a building right on top of its parcel
const PLOT_B = square(8.05, 47.0, 8.06, 47.01);
const PARCEL_200 = parcel(200, "200", "Liegenschaft", square(8.04, 46.99, 8.07, 47.02));
const BUILDING_RIGHT = parcel(201, "SDR9", "SelbstRecht.Baurecht", square(8.049, 46.999, 8.061, 47.011));
// Plot C has a name chosen by the farmer
const PLOT_C = square(8.1, 47.0, 8.11, 47.01);
const PARCEL_300 = parcel(300, "300", "Liegenschaft", square(8.09, 46.99, 8.12, 47.02));

function tokenFromJwt(jwt: string): SupabaseToken {
  return JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString("utf-8")) as SupabaseToken;
}

beforeAll(async () => {
  if (!i18next.isInitialized) {
    await i18next.init({ resources: { de: { translation: de } }, fallbackLng: "de", preload: ["de"] });
  }
});

beforeEach(async () => {
  await cleanDb();
  mockGet.mockReset();
});

describe("syncMissingLocalIds", () => {
  it("assigns the real-estate parcel with the largest overlap and splits full geo.admin responses", async () => {
    const { jwt, farmId } = await createUserWithFarm();
    const plotA = await createPlot(jwt, { name: "1", geometry: { type: "MultiPolygon", coordinates: [PLOT_A] } });
    const plotB = await createPlot(jwt, { name: "2", geometry: { type: "MultiPolygon", coordinates: [PLOT_B] } });
    const plotC = await createPlot(jwt, {
      name: "Wiese Nord",
      geometry: { type: "MultiPolygon", coordinates: [PLOT_C] },
    });

    const requestedEnvelopes: string[] = [];
    mockGet.mockImplementation(async (url: string) => {
      const envelope = new URL(url).searchParams.get("geometry") ?? "";
      requestedEnvelopes.push(envelope);
      const [xMin, , xMax] = envelope.split(",").map(Number);
      // Plot A's envelope comes back full, as in dense areas: the client has to split it
      if (xMin === 8.0 && xMax === 8.01) {
        const filler = Array.from({ length: 202 }, (_unused, index) =>
          parcel(1000 + index, "999", "Liegenschaft", square(9, 46, 9.001, 46.001))
        );
        return { data: { results: filler } };
      }
      // Both parcels touch every quarter of plot A's envelope and must only be counted once
      if (xMin >= 8.0 && xMax <= 8.01) return { data: { results: [PARCEL_101, PARCEL_102] } };
      if (xMin >= 8.05 && xMax <= 8.06) return { data: { results: [BUILDING_RIGHT, PARCEL_200] } };
      if (xMin >= 8.1 && xMax <= 8.11) return { data: { results: [PARCEL_300] } };
      return { data: { results: [] } };
    });

    await plotsApi(rlsDb(tokenFromJwt(jwt), farmId), i18next.getFixedT("de")).syncMissingLocalIds();

    // 3 plot envelopes, plot A's split once into four
    expect(requestedEnvelopes).toHaveLength(7);
    const plots = await getAdminDb().query.plots.findMany({ where: { farmId } });
    const plotById = new Map(plots.map((plot) => [plot.id, plot]));
    expect(plotById.get(plotA.id)).toMatchObject({ localId: "101", name: "101" });
    expect(plotById.get(plotB.id)).toMatchObject({ localId: "200", name: "200" });
    expect(plotById.get(plotC.id)).toMatchObject({ localId: "300", name: "Wiese Nord" });
  });

  it("doesn't assign the number of a parcel that only touches the plot by a sliver", async () => {
    const { jwt, farmId } = await createUserWithFarm();
    const plot = await createPlot(jwt, { name: "1", geometry: { type: "MultiPolygon", coordinates: [PLOT_A] } });
    // The plot's own parcel is missing from the results, the neighbour overlaps it by 5%
    const neighbour = parcel(400, "400", "Liegenschaft", square(8.0095, 46.99, 8.03, 47.02));
    mockGet.mockResolvedValue({ data: { results: [neighbour] } });

    await plotsApi(rlsDb(tokenFromJwt(jwt), farmId), i18next.getFixedT("de")).syncMissingLocalIds();

    const stored = await getAdminDb().query.plots.findFirst({ where: { id: plot.id } });
    expect(stored).toMatchObject({ localId: null, name: "1" });
  });

  it("still assigns numbers when a stored plot geometry is self-intersecting", async () => {
    const { jwt, farmId } = await createUserWithFarm();
    const validPlot = await createPlot(jwt, { name: "1", geometry: { type: "MultiPolygon", coordinates: [PLOT_A] } });
    // Bow tie inside parcel 300, stored directly since the API repairs geometries on save
    const [bowTiePlot] = await getAdminDb()
      .insert(schema.plots)
      .values({
        farmId,
        name: "2",
        size: 1000,
        geometry: sql`ST_SetSRID(ST_GeomFromText('MULTIPOLYGON(((8.1 47, 8.11 47.01, 8.11 47, 8.1 47.01, 8.1 47)))'), 4326)`,
      })
      .returning({ id: schema.plots.id });
    mockGet.mockResolvedValue({ data: { results: [PARCEL_101, PARCEL_102, PARCEL_300] } });

    await plotsApi(rlsDb(tokenFromJwt(jwt), farmId), i18next.getFixedT("de")).syncMissingLocalIds();

    const plots = await getAdminDb().query.plots.findMany({ where: { farmId } });
    const plotById = new Map(plots.map((plot) => [plot.id, plot]));
    expect(plotById.get(validPlot.id)?.localId).toBe("101");
    expect(plotById.get(bowTiePlot.id)?.localId).toBe("300");
  });

  it("keeps existing parcel numbers", async () => {
    const { jwt, farmId } = await createUserWithFarm();
    const plot = await createPlot(jwt, {
      name: "1",
      localId: "55",
      geometry: { type: "MultiPolygon", coordinates: [PLOT_A] },
    });
    mockGet.mockResolvedValue({ data: { results: [PARCEL_101, PARCEL_102] } });

    await plotsApi(rlsDb(tokenFromJwt(jwt), farmId), i18next.getFixedT("de")).syncMissingLocalIds();

    const stored = await getAdminDb().query.plots.findFirst({ where: { id: plot.id } });
    expect(stored).toMatchObject({ localId: "55", name: "1" });
  });
});
