import { describe, it, expect, beforeEach } from "@jest/globals";

import { cleanDb, getAdminDb, request } from "./helpers";
import * as schema from "../db/schema";
import {
  createUserWithFarm,
  createPlot,
  createFertilizer,
  createFertilizerApplication,
  TEST_GEOMETRY,
} from "./test-utils";

const OTHER_GEOMETRY = {
  type: "MultiPolygon",
  coordinates: [
    [
      [
        [9.0, 46.0],
        [9.1, 46.0],
        [9.1, 46.1],
        [9.0, 46.1],
        [9.0, 46.0],
      ],
    ],
  ],
};

// ---------------------------------------------------------------------------
// Fertilizer Applications CRUD
// ---------------------------------------------------------------------------
describe("Fertilizer Applications CRUD", () => {
  beforeEach(cleanDb);

  it("creates a fertilizer application and retrieves it by id", async () => {
    const { jwt, farmId } = await createUserWithFarm();
    const plot = await createPlot(jwt, { name: "FertField" });
    const fert = await createFertilizer(jwt, { name: "Cow Slurry", unit: "l" });
    const [app] = await createFertilizerApplication(jwt, plot.id, fert.id, {
      date: "2025-04-15",
      unit: "load",
      amountPerUnit: 500,
      numberOfUnits: 3,
      method: "spread",
    });

    expect(app.farmId).toBe(farmId);
    expect(app.plotId).toBe(plot.id);
    expect(app.fertilizerId).toBe(fert.id);
    expect(app.unit).toBe("load");
    expect(app.amountPerUnit).toBe(500);
    expect(app.numberOfUnits).toBe(3);

    // Verify DB
    const db = getAdminDb();
    const dbApp = await db.query.fertilizerApplications.findFirst({
      where: { id: app.id },
    });
    expect(dbApp!.plotId).toBe(plot.id);
    expect(dbApp!.fertilizerId).toBe(fert.id);
    expect(dbApp!.unit).toBe("load");
    expect(dbApp!.amountPerUnit).toBe(500);
    expect(dbApp!.numberOfUnits).toBe(3);
    expect(dbApp!.method).toBe("spread");
    expect(dbApp!.farmId).toBe(farmId);

    // GET by id includes plot and fertilizer
    const getRes = await request("GET", `/v1/fertilizerApplications/byId/${app.id}`, undefined, jwt);
    expect(getRes.status).toBe(200);
    const getBody = (await getRes.json()) as {
      data: {
        plot: { name: string };
        fertilizer: { name: string };
      };
    };
    expect(getBody.data.plot.name).toBe("FertField");
    expect(getBody.data.fertilizer.name).toBe("Cow Slurry");
  });

  it("lists fertilizer applications for farm", async () => {
    const { jwt } = await createUserWithFarm();
    const plot = await createPlot(jwt);
    const fert = await createFertilizer(jwt);
    await createFertilizerApplication(jwt, plot.id, fert.id);

    const res = await request("GET", "/v1/fertilizerApplications", undefined, jwt);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { count: number } };
    expect(body.data.count).toBe(1);
  });

  it("lists fertilizer applications for a specific plot", async () => {
    const { jwt } = await createUserWithFarm();
    const p1 = await createPlot(jwt, { name: "P1" });
    const p2 = await createPlot(jwt, { name: "P2" });
    const fert = await createFertilizer(jwt);
    await createFertilizerApplication(jwt, p1.id, fert.id);
    await createFertilizerApplication(jwt, p2.id, fert.id);

    const res = await request("GET", `/v1/plots/byId/${p1.id}/fertilizerApplications`, undefined, jwt);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { count: number } };
    expect(body.data.count).toBe(1);
  });

  it("creates batch fertilizer applications for multiple plots", async () => {
    const { jwt } = await createUserWithFarm();
    const p1 = await createPlot(jwt, { name: "BatchF1" });
    const p2 = await createPlot(jwt, { name: "BatchF2" });
    const fert = await createFertilizer(jwt);

    const res = await request(
      "POST",
      "/v1/fertilizerApplications",
      {
        date: "2025-05-01",
        unit: "bag",
        amountPerUnit: 25,
        fertilizerId: fert.id,
        plots: [
          { plotId: p1.id, numberOfUnits: 2, geometry: TEST_GEOMETRY, size: 5000 },
          { plotId: p2.id, numberOfUnits: 3, geometry: TEST_GEOMETRY, size: 6000 },
        ],
      },
      jwt
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { count: number } };
    expect(body.data.count).toBe(2);

    // Verify DB
    const db = getAdminDb();
    const dbApps = await db.query.fertilizerApplications.findMany({});
    expect(dbApps).toHaveLength(2);
    expect(dbApps.every((a) => a.unit === "bag")).toBe(true);
    expect(dbApps.every((a) => a.amountPerUnit === 25)).toBe(true);
  });

  it("updates a fertilizer application", async () => {
    const { jwt } = await createUserWithFarm();
    const plot = await createPlot(jwt);
    const fert = await createFertilizer(jwt, { name: "Slurry" });
    const otherFert = await createFertilizer(jwt, { name: "Manure" });
    const [app] = await createFertilizerApplication(jwt, plot.id, fert.id, {
      date: "2025-04-15",
      unit: "load",
      amountPerUnit: 500,
      numberOfUnits: 3,
      method: "spread",
    });

    const res = await request(
      "PATCH",
      `/v1/fertilizerApplications/byId/${app.id}`,
      {
        date: "2025-05-01",
        unit: "bag",
        amountPerUnit: 25,
        numberOfUnits: 4,
        method: "spray",
        fertilizerId: otherFert.id,
        additionalNotes: "Corrected",
      },
      jwt
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { fertilizer: { name: string } } };
    expect(body.data.fertilizer.name).toBe("Manure");

    // Verify DB
    const db = getAdminDb();
    const dbApp = await db.query.fertilizerApplications.findFirst({
      where: { id: app.id },
    });
    expect(dbApp!.date.toISOString().slice(0, 10)).toBe("2025-05-01");
    expect(dbApp!.unit).toBe("bag");
    expect(dbApp!.amountPerUnit).toBe(25);
    expect(dbApp!.numberOfUnits).toBe(4);
    expect(dbApp!.method).toBe("spray");
    expect(dbApp!.fertilizerId).toBe(otherFert.id);
    expect(dbApp!.additionalNotes).toBe("Corrected");

    // Clear nullable values
    const clearRes = await request(
      "PATCH",
      `/v1/fertilizerApplications/byId/${app.id}`,
      { method: null, additionalNotes: null },
      jwt
    );
    expect(clearRes.status).toBe(200);
    const clearedApp = await db.query.fertilizerApplications.findFirst({
      where: { id: app.id },
    });
    expect(clearedApp!.method).toBeNull();
    expect(clearedApp!.additionalNotes).toBeNull();
  });

  it("ignores plot, geometry and size when updating a fertilizer application", async () => {
    const { jwt } = await createUserWithFarm();
    const plot = await createPlot(jwt);
    const otherPlot = await createPlot(jwt, { name: "Other" });
    const fert = await createFertilizer(jwt);
    const [app] = await createFertilizerApplication(jwt, plot.id, fert.id);

    const res = await request(
      "PATCH",
      `/v1/fertilizerApplications/byId/${app.id}`,
      { numberOfUnits: 42, plotId: otherPlot.id, geometry: OTHER_GEOMETRY, size: 1 },
      jwt
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { numberOfUnits: number; plotId: string; size: number; geometry: { coordinates: unknown } };
    };
    expect(body.data.numberOfUnits).toBe(42);
    expect(body.data.plotId).toBe(plot.id);
    expect(body.data.size).toBe(10000);
    expect(body.data.geometry.coordinates).toEqual(TEST_GEOMETRY.coordinates);
  });

  it("returns 404 when updating an unknown fertilizer application", async () => {
    const { jwt } = await createUserWithFarm();
    const res = await request(
      "PATCH",
      "/v1/fertilizerApplications/byId/00000000-0000-0000-0000-000000000000",
      { numberOfUnits: 1 },
      jwt
    );
    expect(res.status).toBe(404);
  });

  it("deletes a fertilizer application", async () => {
    const { jwt } = await createUserWithFarm();
    const plot = await createPlot(jwt);
    const fert = await createFertilizer(jwt);
    const [app] = await createFertilizerApplication(jwt, plot.id, fert.id);

    const res = await request("DELETE", `/v1/fertilizerApplications/byId/${app.id}`, undefined, jwt);
    expect(res.status).toBe(200);

    // Verify DB
    const db = getAdminDb();
    const dbApp = await db.query.fertilizerApplications.findFirst({
      where: { id: app.id },
    });
    expect(dbApp).toBeUndefined();
  });

  it("returns fertilizer application years", async () => {
    const { jwt } = await createUserWithFarm();
    const plot = await createPlot(jwt);
    const fert = await createFertilizer(jwt);
    await createFertilizerApplication(jwt, plot.id, fert.id, {
      date: "2025-04-15",
    });

    const res = await request("GET", "/v1/fertilizerApplications/years", undefined, jwt);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { result: string[] } };
    expect(body.data.result).toContain("2025");
  });

  it("marks fertilizer as in use after creating application", async () => {
    const { jwt } = await createUserWithFarm();
    const plot = await createPlot(jwt);
    const fert = await createFertilizer(jwt, { name: "UsedFert" });
    await createFertilizerApplication(jwt, plot.id, fert.id);

    const res = await request("GET", `/v1/fertilizers/byId/${fert.id}/inUse`, undefined, jwt);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { inUse: boolean } };
    expect(body.data.inUse).toBe(true);
  });

  it("returns summary for farm", async () => {
    const { jwt } = await createUserWithFarm();
    const plot = await createPlot(jwt);
    const fert = await createFertilizer(jwt, { name: "SummaryFert" });
    await createFertilizerApplication(jwt, plot.id, fert.id, { numberOfUnits: 3 });

    const res = await request("GET", "/v1/fertilizerApplications/summaries", undefined, jwt);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        monthlyApplications: {
          appliedFertilizers: { fertilizerName: string; totalAmount: number; totalProducedUnits: number }[];
        }[];
      };
    };
    expect(body.data.monthlyApplications).toBeDefined();
    const applied = body.data.monthlyApplications
      .flatMap((month) => month.appliedFertilizers)
      .find((entry) => entry.fertilizerName === "SummaryFert");
    expect(applied).toBeDefined();
    expect(applied!.totalProducedUnits).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Fertilizer Application Presets
// ---------------------------------------------------------------------------
describe("Fertilizer Application Presets", () => {
  beforeEach(cleanDb);

  it("creates a preset and retrieves it", async () => {
    const { jwt, farmId } = await createUserWithFarm();
    const fert = await createFertilizer(jwt, { name: "PresetFert" });

    const createRes = await request(
      "POST",
      "/v1/fertilizerApplications/presets",
      {
        name: "Standard Spread",
        fertilizerId: fert.id,
        unit: "load",
        method: "spread",
        amountPerUnit: 500,
      },
      jwt
    );
    expect(createRes.status).toBe(200);
    const preset = (
      (await createRes.json()) as {
        data: { id: string; name: string; method: string; amountPerUnit: number };
      }
    ).data;
    expect(preset.name).toBe("Standard Spread");
    expect(preset.method).toBe("spread");
    expect(preset.amountPerUnit).toBe(500);

    // Verify DB
    const db = getAdminDb();
    const dbPreset = await db.query.fertilizerApplicationPresets.findFirst({
      where: { id: preset.id },
    });
    expect(dbPreset!.name).toBe("Standard Spread");
    expect(dbPreset!.method).toBe("spread");
    expect(dbPreset!.amountPerUnit).toBe(500);
    expect(dbPreset!.fertilizerId).toBe(fert.id);
    expect(dbPreset!.farmId).toBe(farmId);
  });

  it("updates a preset", async () => {
    const { jwt } = await createUserWithFarm();
    const fert = await createFertilizer(jwt);
    const createRes = await request(
      "POST",
      "/v1/fertilizerApplications/presets",
      { name: "Old", fertilizerId: fert.id, unit: "load", amountPerUnit: 100 },
      jwt
    );
    const preset = ((await createRes.json()) as { data: { id: string } }).data;

    await request(
      "PATCH",
      `/v1/fertilizerApplications/presets/byId/${preset.id}`,
      { name: "New", amountPerUnit: 200 },
      jwt
    );

    // Verify DB
    const db = getAdminDb();
    const dbPreset = await db.query.fertilizerApplicationPresets.findFirst({
      where: { id: preset.id },
    });
    expect(dbPreset!.name).toBe("New");
    expect(dbPreset!.amountPerUnit).toBe(200);
  });

  it("deletes a preset", async () => {
    const { jwt } = await createUserWithFarm();
    const fert = await createFertilizer(jwt);
    const createRes = await request(
      "POST",
      "/v1/fertilizerApplications/presets",
      { name: "ToDelete", fertilizerId: fert.id, unit: "load", amountPerUnit: 100 },
      jwt
    );
    const preset = ((await createRes.json()) as { data: { id: string } }).data;

    const res = await request("DELETE", `/v1/fertilizerApplications/presets/byId/${preset.id}`, undefined, jwt);
    expect(res.status).toBe(200);

    // Verify DB
    const db = getAdminDb();
    const dbPreset = await db.query.fertilizerApplicationPresets.findFirst({
      where: { id: preset.id },
    });
    expect(dbPreset).toBeUndefined();
  });
});
