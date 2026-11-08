import { describe, it, expect, beforeEach } from "@jest/globals";

import { cleanDb, getAdminDb, request } from "./helpers";
import * as schema from "../db/schema";
import { createUserWithFarm, createPlot, createCrop, createHarvests, TEST_GEOMETRY } from "./test-utils";

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
// Harvests CRUD
// ---------------------------------------------------------------------------
describe("Harvests CRUD", () => {
  beforeEach(cleanDb);

  it("creates a harvest and retrieves it by id", async () => {
    const { jwt, farmId } = await createUserWithFarm();
    const plot = await createPlot(jwt, { name: "HarvestField" });
    const crop = await createCrop(jwt, { name: "Hay", category: "grass" });
    const [harvest] = await createHarvests(jwt, plot.id, crop.id, {
      date: "2025-07-15",
      unit: "round_bale",
      kilosPerUnit: 300,
      numberOfUnits: 5,
    });

    expect(harvest.farmId).toBe(farmId);
    expect(harvest.plotId).toBe(plot.id);
    expect(harvest.cropId).toBe(crop.id);
    expect(harvest.unit).toBe("round_bale");
    expect(harvest.kilosPerUnit).toBe(300);
    expect(harvest.numberOfUnits).toBe(5);

    // Verify DB
    const db = getAdminDb();
    const dbHarvest = await db.query.harvests.findFirst({
      where: { id: harvest.id },
    });
    expect(dbHarvest!.plotId).toBe(plot.id);
    expect(dbHarvest!.cropId).toBe(crop.id);
    expect(dbHarvest!.unit).toBe("round_bale");
    expect(dbHarvest!.kilosPerUnit).toBe(300);
    expect(dbHarvest!.numberOfUnits).toBe(5);
    expect(dbHarvest!.farmId).toBe(farmId);

    // GET by id includes crop and plot
    const getRes = await request("GET", `/v1/harvests/byId/${harvest.id}`, undefined, jwt);
    expect(getRes.status).toBe(200);
    const getBody = (await getRes.json()) as {
      data: {
        crop: { name: string };
        plot: { name: string };
      };
    };
    expect(getBody.data.crop.name).toBe("Hay");
    expect(getBody.data.plot.name).toBe("HarvestField");
  });

  it("lists harvests for farm", async () => {
    const { jwt } = await createUserWithFarm();
    const plot = await createPlot(jwt);
    const crop = await createCrop(jwt, { category: "grass" });
    await createHarvests(jwt, plot.id, crop.id);

    const res = await request("GET", "/v1/harvests", undefined, jwt);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { count: number } };
    expect(body.data.count).toBe(1);
  });

  it("lists harvests for a specific plot", async () => {
    const { jwt } = await createUserWithFarm();
    const p1 = await createPlot(jwt, { name: "Plot1" });
    const p2 = await createPlot(jwt, { name: "Plot2" });
    const crop = await createCrop(jwt, { category: "grass" });
    await createHarvests(jwt, p1.id, crop.id);
    await createHarvests(jwt, p2.id, crop.id);

    const res = await request("GET", `/v1/plots/byId/${p1.id}/harvests`, undefined, jwt);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { count: number } };
    expect(body.data.count).toBe(1);
  });

  it("creates batch harvests for multiple plots", async () => {
    const { jwt } = await createUserWithFarm();
    const p1 = await createPlot(jwt, { name: "BatchH1" });
    const p2 = await createPlot(jwt, { name: "BatchH2" });
    const crop = await createCrop(jwt, { category: "grass" });

    const res = await request(
      "POST",
      "/v1/harvests/batch",
      {
        date: "2025-08-01",
        cropId: crop.id,
        unit: "load",
        kilosPerUnit: 500,
        plots: [
          { plotId: p1.id, geometry: TEST_GEOMETRY, size: 5000, numberOfUnits: 3 },
          { plotId: p2.id, geometry: TEST_GEOMETRY, size: 6000, numberOfUnits: 4 },
        ],
      },
      jwt
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { count: number } };
    expect(body.data.count).toBe(2);

    // Verify DB
    const db = getAdminDb();
    const dbHarvests = await db.query.harvests.findMany({});
    expect(dbHarvests).toHaveLength(2);
    expect(dbHarvests.every((h) => h.unit === "load")).toBe(true);
    expect(dbHarvests.every((h) => h.kilosPerUnit === 500)).toBe(true);
  });

  it("updates a harvest", async () => {
    const { jwt } = await createUserWithFarm();
    const plot = await createPlot(jwt);
    const crop = await createCrop(jwt, { name: "Hay", category: "grass" });
    const otherCrop = await createCrop(jwt, { name: "Clover", category: "grass" });
    const [harvest] = await createHarvests(jwt, plot.id, crop.id, {
      date: "2025-07-15",
      unit: "round_bale",
      kilosPerUnit: 300,
      numberOfUnits: 5,
      conservationMethod: "dried",
    });

    const res = await request(
      "PATCH",
      `/v1/harvests/byId/${harvest.id}`,
      {
        date: "2025-07-20",
        cropId: otherCrop.id,
        unit: "square_bale",
        kilosPerUnit: 20,
        numberOfUnits: 50,
        conservationMethod: "silage",
        harvestCount: 2,
        additionalNotes: "Corrected",
      },
      jwt
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { crop: { name: string } } };
    expect(body.data.crop.name).toBe("Clover");

    // Verify DB
    const db = getAdminDb();
    const dbHarvest = await db.query.harvests.findFirst({
      where: { id: harvest.id },
    });
    expect(dbHarvest!.date.toISOString().slice(0, 10)).toBe("2025-07-20");
    expect(dbHarvest!.cropId).toBe(otherCrop.id);
    expect(dbHarvest!.unit).toBe("square_bale");
    expect(dbHarvest!.kilosPerUnit).toBe(20);
    expect(dbHarvest!.numberOfUnits).toBe(50);
    expect(dbHarvest!.conservationMethod).toBe("silage");
    expect(dbHarvest!.harvestCount).toBe(2);
    expect(dbHarvest!.additionalNotes).toBe("Corrected");

    // Clear nullable values
    const clearRes = await request(
      "PATCH",
      `/v1/harvests/byId/${harvest.id}`,
      { conservationMethod: null, harvestCount: null, additionalNotes: null },
      jwt
    );
    expect(clearRes.status).toBe(200);
    const clearedHarvest = await db.query.harvests.findFirst({
      where: { id: harvest.id },
    });
    expect(clearedHarvest!.conservationMethod).toBeNull();
    expect(clearedHarvest!.harvestCount).toBeNull();
    expect(clearedHarvest!.additionalNotes).toBeNull();
  });

  it("ignores plot, geometry and size when updating a harvest", async () => {
    const { jwt } = await createUserWithFarm();
    const plot = await createPlot(jwt);
    const otherPlot = await createPlot(jwt, { name: "Other" });
    const crop = await createCrop(jwt, { category: "grass" });
    const [harvest] = await createHarvests(jwt, plot.id, crop.id);

    const res = await request(
      "PATCH",
      `/v1/harvests/byId/${harvest.id}`,
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

  it("returns 404 when updating an unknown harvest", async () => {
    const { jwt } = await createUserWithFarm();
    const res = await request(
      "PATCH",
      "/v1/harvests/byId/00000000-0000-0000-0000-000000000000",
      { numberOfUnits: 1 },
      jwt
    );
    expect(res.status).toBe(404);
  });

  it("deletes a harvest", async () => {
    const { jwt } = await createUserWithFarm();
    const plot = await createPlot(jwt);
    const crop = await createCrop(jwt, { category: "grass" });
    const [harvest] = await createHarvests(jwt, plot.id, crop.id);

    const res = await request("DELETE", `/v1/harvests/byId/${harvest.id}`, undefined, jwt);
    expect(res.status).toBe(200);

    // Verify DB
    const db = getAdminDb();
    const dbHarvest = await db.query.harvests.findFirst({
      where: { id: harvest.id },
    });
    expect(dbHarvest).toBeUndefined();
  });

  it("returns harvest years", async () => {
    const { jwt } = await createUserWithFarm();
    const plot = await createPlot(jwt);
    const crop = await createCrop(jwt, { category: "grass" });
    await createHarvests(jwt, plot.id, crop.id, { date: "2025-07-15" });

    const res = await request("GET", "/v1/harvests/years", undefined, jwt);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { result: string[] } };
    expect(body.data.result).toContain("2025");
  });

  it("returns harvest summary for farm", async () => {
    const { jwt } = await createUserWithFarm();
    const plot = await createPlot(jwt);
    const crop = await createCrop(jwt, { category: "grass" });
    await createHarvests(jwt, plot.id, crop.id);

    const res = await request("GET", "/v1/harvests/summaries", undefined, jwt);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { monthlyHarvests: unknown[] };
    };
    expect(body.data.monthlyHarvests).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Harvest Presets
// ---------------------------------------------------------------------------
describe("Harvest Presets", () => {
  beforeEach(cleanDb);

  it("creates a preset and retrieves it", async () => {
    const { jwt, farmId } = await createUserWithFarm();

    const createRes = await request(
      "POST",
      "/v1/harvests/presets",
      { name: "Hay Bale", unit: "round_bale", kilosPerUnit: 300 },
      jwt
    );
    expect(createRes.status).toBe(200);
    const preset = (
      (await createRes.json()) as {
        data: { id: string; name: string; unit: string; kilosPerUnit: number };
      }
    ).data;
    expect(preset.name).toBe("Hay Bale");
    expect(preset.unit).toBe("round_bale");
    expect(preset.kilosPerUnit).toBe(300);

    // Verify DB
    const db = getAdminDb();
    const dbPreset = await db.query.harvestPresets.findFirst({
      where: { id: preset.id },
    });
    expect(dbPreset!.name).toBe("Hay Bale");
    expect(dbPreset!.unit).toBe("round_bale");
    expect(dbPreset!.kilosPerUnit).toBe(300);
    expect(dbPreset!.farmId).toBe(farmId);
  });

  it("lists presets", async () => {
    const { jwt } = await createUserWithFarm();
    await request("POST", "/v1/harvests/presets", { name: "P1", unit: "load", kilosPerUnit: 500 }, jwt);
    await request("POST", "/v1/harvests/presets", { name: "P2", unit: "crate", kilosPerUnit: 20 }, jwt);

    const res = await request("GET", "/v1/harvests/presets", undefined, jwt);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { count: number } };
    expect(body.data.count).toBe(2);
  });

  it("updates a preset", async () => {
    const { jwt } = await createUserWithFarm();
    const createRes = await request(
      "POST",
      "/v1/harvests/presets",
      { name: "OldPreset", unit: "load", kilosPerUnit: 100 },
      jwt
    );
    const preset = ((await createRes.json()) as { data: { id: string } }).data;

    await request("PATCH", `/v1/harvests/presets/byId/${preset.id}`, { name: "NewPreset", kilosPerUnit: 250 }, jwt);

    // Verify DB
    const db = getAdminDb();
    const dbPreset = await db.query.harvestPresets.findFirst({
      where: { id: preset.id },
    });
    expect(dbPreset!.name).toBe("NewPreset");
    expect(dbPreset!.kilosPerUnit).toBe(250);
  });

  it("deletes a preset", async () => {
    const { jwt } = await createUserWithFarm();
    const createRes = await request(
      "POST",
      "/v1/harvests/presets",
      { name: "ToDelete", unit: "load", kilosPerUnit: 100 },
      jwt
    );
    const preset = ((await createRes.json()) as { data: { id: string } }).data;

    const res = await request("DELETE", `/v1/harvests/presets/byId/${preset.id}`, undefined, jwt);
    expect(res.status).toBe(200);

    // Verify DB
    const db = getAdminDb();
    const dbPreset = await db.query.harvestPresets.findFirst({
      where: { id: preset.id },
    });
    expect(dbPreset).toBeUndefined();
  });
});
