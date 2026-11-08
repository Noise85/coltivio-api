import { describe, it, expect, beforeEach } from "@jest/globals";

import { cleanDb, getAdminDb, request } from "./helpers";
import * as schema from "../db/schema";
import { createUserWithFarm, createPlot, createTillage, TEST_GEOMETRY } from "./test-utils";

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
// Tillages CRUD
// ---------------------------------------------------------------------------
describe("Tillages CRUD", () => {
  beforeEach(cleanDb);

  it("creates a tillage and retrieves it by id", async () => {
    const { jwt, farmId } = await createUserWithFarm();
    const plot = await createPlot(jwt, { name: "TillField" });
    const tillage = await createTillage(jwt, plot.id, {
      action: "plowing",
      date: "2025-03-15",
    });

    expect(tillage.action).toBe("plowing");
    expect(tillage.farmId).toBe(farmId);
    expect(tillage.plotId).toBe(plot.id);

    // Verify DB
    const db = getAdminDb();
    const dbTillage = await db.query.tillages.findFirst({
      where: { id: tillage.id },
    });
    expect(dbTillage!.action).toBe("plowing");
    expect(dbTillage!.plotId).toBe(plot.id);
    expect(dbTillage!.farmId).toBe(farmId);
    expect(dbTillage!.size).toBe(10000);

    // GET by id includes plot
    const getRes = await request("GET", `/v1/tillages/byId/${tillage.id}`, undefined, jwt);
    expect(getRes.status).toBe(200);
    const getBody = (await getRes.json()) as {
      data: { id: string; plot: { id: string; name: string } };
    };
    expect(getBody.data.plot.id).toBe(plot.id);
    expect(getBody.data.plot.name).toBe("TillField");
  });

  it("lists tillages for farm", async () => {
    const { jwt } = await createUserWithFarm();
    const plot = await createPlot(jwt);
    await createTillage(jwt, plot.id, { date: "2025-03-01" });
    await createTillage(jwt, plot.id, { date: "2025-04-01" });

    const res = await request("GET", "/v1/tillages", undefined, jwt);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { count: number } };
    expect(body.data.count).toBe(2);
  });

  it("lists tillages for a specific plot", async () => {
    const { jwt } = await createUserWithFarm();
    const p1 = await createPlot(jwt, { name: "Plot1" });
    const p2 = await createPlot(jwt, { name: "Plot2" });
    await createTillage(jwt, p1.id);
    await createTillage(jwt, p2.id);

    const res = await request("GET", `/v1/plots/byId/${p1.id}/tillages`, undefined, jwt);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { count: number } };
    expect(body.data.count).toBe(1);
  });

  it("creates batch tillages for multiple plots", async () => {
    const { jwt } = await createUserWithFarm();
    const p1 = await createPlot(jwt, { name: "BatchP1" });
    const p2 = await createPlot(jwt, { name: "BatchP2" });

    const res = await request(
      "POST",
      "/v1/tillages/batch",
      {
        action: "harrowing",
        date: "2025-05-01",
        plots: [
          { plotId: p1.id, geometry: TEST_GEOMETRY, size: 5000 },
          { plotId: p2.id, geometry: TEST_GEOMETRY, size: 6000 },
        ],
      },
      jwt
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { count: number } };
    expect(body.data.count).toBe(2);

    // Verify DB
    const db = getAdminDb();
    const dbTillages = await db.query.tillages.findMany({});
    expect(dbTillages).toHaveLength(2);
    expect(dbTillages.every((t) => t.action === "harrowing")).toBe(true);
  });

  it("updates a tillage", async () => {
    const { jwt } = await createUserWithFarm();
    const plot = await createPlot(jwt);
    const tillage = await createTillage(jwt, plot.id, { action: "plowing" });

    const res = await request(
      "PATCH",
      `/v1/tillages/byId/${tillage.id}`,
      { action: "tilling", additionalNotes: "Deep tilling" },
      jwt
    );
    expect(res.status).toBe(200);

    // Verify DB
    const db = getAdminDb();
    const dbTillage = await db.query.tillages.findFirst({
      where: { id: tillage.id },
    });
    expect(dbTillage!.action).toBe("tilling");
    expect(dbTillage!.additionalNotes).toBe("Deep tilling");
  });

  it("ignores plot, geometry and size when updating a tillage", async () => {
    const { jwt } = await createUserWithFarm();
    const plot = await createPlot(jwt);
    const otherPlot = await createPlot(jwt, { name: "Other" });
    const tillage = await createTillage(jwt, plot.id, { action: "plowing" });

    const res = await request(
      "PATCH",
      `/v1/tillages/byId/${tillage.id}`,
      { action: "harrowing", plotId: otherPlot.id, geometry: OTHER_GEOMETRY, size: 1 },
      jwt
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { action: string; plotId: string; size: number; geometry: { coordinates: unknown } };
    };
    expect(body.data.action).toBe("harrowing");
    expect(body.data.plotId).toBe(plot.id);
    expect(body.data.size).toBe(10000);
    expect(body.data.geometry.coordinates).toEqual(TEST_GEOMETRY.coordinates);
  });

  it("returns 404 when updating an unknown tillage", async () => {
    const { jwt } = await createUserWithFarm();
    const res = await request(
      "PATCH",
      "/v1/tillages/byId/00000000-0000-0000-0000-000000000000",
      { action: "harrowing" },
      jwt
    );
    expect(res.status).toBe(404);
  });

  it("deletes a tillage", async () => {
    const { jwt } = await createUserWithFarm();
    const plot = await createPlot(jwt);
    const tillage = await createTillage(jwt, plot.id);

    const res = await request("DELETE", `/v1/tillages/byId/${tillage.id}`, undefined, jwt);
    expect(res.status).toBe(200);

    // Verify DB
    const db = getAdminDb();
    const dbTillage = await db.query.tillages.findFirst({
      where: { id: tillage.id },
    });
    expect(dbTillage).toBeUndefined();
  });

  it("returns tillage years", async () => {
    const { jwt } = await createUserWithFarm();
    const plot = await createPlot(jwt);
    await createTillage(jwt, plot.id, { date: "2025-03-01" });

    const res = await request("GET", "/v1/tillages/years", undefined, jwt);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { result: string[]; count: number };
    };
    expect(body.data.result).toContain("2025");
  });
});

// ---------------------------------------------------------------------------
// Tillage Presets
// ---------------------------------------------------------------------------
describe("Tillage Presets", () => {
  beforeEach(cleanDb);

  it("creates a preset and retrieves it", async () => {
    const { jwt, farmId } = await createUserWithFarm();

    const createRes = await request("POST", "/v1/tillages/presets", { name: "Deep Plow", action: "plowing" }, jwt);
    expect(createRes.status).toBe(200);
    const preset = (
      (await createRes.json()) as {
        data: { id: string; name: string; action: string; farmId: string };
      }
    ).data;
    expect(preset.name).toBe("Deep Plow");
    expect(preset.action).toBe("plowing");

    // Verify DB
    const db = getAdminDb();
    const dbPreset = await db.query.tillagePresets.findFirst({
      where: { id: preset.id },
    });
    expect(dbPreset!.name).toBe("Deep Plow");
    expect(dbPreset!.action).toBe("plowing");
    expect(dbPreset!.farmId).toBe(farmId);
  });

  it("lists presets", async () => {
    const { jwt } = await createUserWithFarm();
    await request("POST", "/v1/tillages/presets", { name: "P1", action: "plowing" }, jwt);
    await request("POST", "/v1/tillages/presets", { name: "P2", action: "tilling" }, jwt);

    const res = await request("GET", "/v1/tillages/presets", undefined, jwt);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { count: number } };
    expect(body.data.count).toBe(2);
  });

  it("updates a preset", async () => {
    const { jwt } = await createUserWithFarm();
    const createRes = await request("POST", "/v1/tillages/presets", { name: "OldPreset", action: "plowing" }, jwt);
    const preset = ((await createRes.json()) as { data: { id: string } }).data;

    const res = await request(
      "PATCH",
      `/v1/tillages/presets/byId/${preset.id}`,
      { name: "NewPreset", action: "harrowing" },
      jwt
    );
    expect(res.status).toBe(200);

    // Verify DB
    const db = getAdminDb();
    const dbPreset = await db.query.tillagePresets.findFirst({
      where: { id: preset.id },
    });
    expect(dbPreset!.name).toBe("NewPreset");
    expect(dbPreset!.action).toBe("harrowing");
  });

  it("deletes a preset", async () => {
    const { jwt } = await createUserWithFarm();
    const createRes = await request("POST", "/v1/tillages/presets", { name: "ToDelete", action: "rolling" }, jwt);
    const preset = ((await createRes.json()) as { data: { id: string } }).data;

    const res = await request("DELETE", `/v1/tillages/presets/byId/${preset.id}`, undefined, jwt);
    expect(res.status).toBe(200);

    // Verify DB
    const db = getAdminDb();
    const dbPreset = await db.query.tillagePresets.findFirst({
      where: { id: preset.id },
    });
    expect(dbPreset).toBeUndefined();
  });
});
