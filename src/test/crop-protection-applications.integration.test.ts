import { describe, it, expect, beforeEach } from "@jest/globals";

import { cleanDb, getAdminDb, request } from "./helpers";
import * as schema from "../db/schema";
import {
  createUserWithFarm,
  createPlot,
  createCropProtectionProduct,
  createCropProtectionApplication,
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
// Crop Protection Applications CRUD
// ---------------------------------------------------------------------------
describe("Crop Protection Applications CRUD", () => {
  beforeEach(cleanDb);

  it("creates an application and retrieves it by id", async () => {
    const { jwt, farmId } = await createUserWithFarm();
    const plot = await createPlot(jwt, { name: "SprayField" });
    const product = await createCropProtectionProduct(jwt, {
      name: "Funguard",
      unit: "kg",
    });
    const app = await createCropProtectionApplication(jwt, plot.id, product.id, {
      dateTime: "2025-06-15T08:00:00Z",
      unit: "amount_per_hectare",
      amountPerUnit: 2.5,
      numberOfUnits: 10,
      method: "spraying",
    });

    expect(app.farmId).toBe(farmId);
    expect(app.plotId).toBe(plot.id);
    expect(app.productId).toBe(product.id);
    expect(app.unit).toBe("amount_per_hectare");
    expect(app.amountPerUnit).toBe(2.5);
    expect(app.method).toBe("spraying");

    // Verify DB
    const db = getAdminDb();
    const dbApp = await db.query.cropProtectionApplications.findFirst({
      where: { id: app.id },
    });
    expect(dbApp!.plotId).toBe(plot.id);
    expect(dbApp!.productId).toBe(product.id);
    expect(dbApp!.unit).toBe("amount_per_hectare");
    expect(dbApp!.amountPerUnit).toBe(2.5);
    expect(dbApp!.numberOfUnits).toBe(10);
    expect(dbApp!.method).toBe("spraying");
    expect(dbApp!.farmId).toBe(farmId);

    // GET by id includes product and plot
    const getRes = await request("GET", `/v1/cropProtectionApplications/byId/${app.id}`, undefined, jwt);
    expect(getRes.status).toBe(200);
    const getBody = (await getRes.json()) as {
      data: {
        product: { name: string };
        plot: { name: string };
      };
    };
    expect(getBody.data.product.name).toBe("Funguard");
    expect(getBody.data.plot.name).toBe("SprayField");
  });

  it("lists applications for farm", async () => {
    const { jwt } = await createUserWithFarm();
    const plot = await createPlot(jwt);
    const product = await createCropProtectionProduct(jwt);
    await createCropProtectionApplication(jwt, plot.id, product.id);

    const res = await request("GET", "/v1/cropProtectionApplications", undefined, jwt);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { count: number } };
    expect(body.data.count).toBe(1);
  });

  it("lists applications for a specific plot", async () => {
    const { jwt } = await createUserWithFarm();
    const p1 = await createPlot(jwt, { name: "P1" });
    const p2 = await createPlot(jwt, { name: "P2" });
    const product = await createCropProtectionProduct(jwt);
    await createCropProtectionApplication(jwt, p1.id, product.id);
    await createCropProtectionApplication(jwt, p2.id, product.id);

    const res = await request("GET", `/v1/plots/byId/${p1.id}/cropProtectionApplications`, undefined, jwt);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { count: number } };
    expect(body.data.count).toBe(1);
  });

  it("creates batch applications for multiple plots", async () => {
    const { jwt } = await createUserWithFarm();
    const p1 = await createPlot(jwt, { name: "BatchCP1" });
    const p2 = await createPlot(jwt, { name: "BatchCP2" });
    const product = await createCropProtectionProduct(jwt);

    const res = await request(
      "POST",
      "/v1/cropProtectionApplications/batch",
      {
        method: "spraying",
        dateTime: "2025-06-20T10:00:00Z",
        productId: product.id,
        unit: "amount_per_hectare",
        amountPerUnit: 3.0,
        plots: [
          { plotId: p1.id, geometry: TEST_GEOMETRY, size: 5000, numberOfUnits: 5 },
          { plotId: p2.id, geometry: TEST_GEOMETRY, size: 6000, numberOfUnits: 6 },
        ],
      },
      jwt
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { count: number } };
    expect(body.data.count).toBe(2);

    // Verify DB
    const db = getAdminDb();
    const dbApps = await db.query.cropProtectionApplications.findMany({});
    expect(dbApps).toHaveLength(2);
    expect(dbApps.every((a) => a.method === "spraying")).toBe(true);
    expect(dbApps.every((a) => a.amountPerUnit === 3.0)).toBe(true);
  });

  it("updates an application", async () => {
    const { jwt } = await createUserWithFarm();
    const plot = await createPlot(jwt);
    const product = await createCropProtectionProduct(jwt);
    const app = await createCropProtectionApplication(jwt, plot.id, product.id, {
      method: "spraying",
    });

    const res = await request(
      "PATCH",
      `/v1/cropProtectionApplications/byId/${app.id}`,
      { method: "broadcasting", additionalNotes: "Changed method" },
      jwt
    );
    expect(res.status).toBe(200);

    // Verify DB
    const db = getAdminDb();
    const dbApp = await db.query.cropProtectionApplications.findFirst({
      where: { id: app.id },
    });
    expect(dbApp!.method).toBe("broadcasting");
    expect(dbApp!.additionalNotes).toBe("Changed method");
  });

  it("ignores plot, geometry and size when updating an application", async () => {
    const { jwt } = await createUserWithFarm();
    const plot = await createPlot(jwt);
    const otherPlot = await createPlot(jwt, { name: "Other" });
    const product = await createCropProtectionProduct(jwt);
    const app = await createCropProtectionApplication(jwt, plot.id, product.id);

    const res = await request(
      "PATCH",
      `/v1/cropProtectionApplications/byId/${app.id}`,
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

  it("returns 404 when updating an unknown application", async () => {
    const { jwt } = await createUserWithFarm();
    const res = await request(
      "PATCH",
      "/v1/cropProtectionApplications/byId/00000000-0000-0000-0000-000000000000",
      { numberOfUnits: 1 },
      jwt
    );
    expect(res.status).toBe(404);
  });

  it("deletes an application", async () => {
    const { jwt } = await createUserWithFarm();
    const plot = await createPlot(jwt);
    const product = await createCropProtectionProduct(jwt);
    const app = await createCropProtectionApplication(jwt, plot.id, product.id);

    const res = await request("DELETE", `/v1/cropProtectionApplications/byId/${app.id}`, undefined, jwt);
    expect(res.status).toBe(200);

    // Verify DB
    const db = getAdminDb();
    const dbApp = await db.query.cropProtectionApplications.findFirst({
      where: { id: app.id },
    });
    expect(dbApp).toBeUndefined();
  });

  it("returns application years", async () => {
    const { jwt } = await createUserWithFarm();
    const plot = await createPlot(jwt);
    const product = await createCropProtectionProduct(jwt);
    await createCropProtectionApplication(jwt, plot.id, product.id, {
      dateTime: "2025-06-15T08:00:00Z",
    });

    const res = await request("GET", "/v1/cropProtectionApplications/years", undefined, jwt);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { result: string[] } };
    expect(body.data.result).toContain("2025");
  });

  it("marks product as in use after creating application", async () => {
    const { jwt } = await createUserWithFarm();
    const plot = await createPlot(jwt);
    const product = await createCropProtectionProduct(jwt, { name: "UsedProduct" });
    await createCropProtectionApplication(jwt, plot.id, product.id);

    const res = await request("GET", `/v1/cropProtectionProducts/byId/${product.id}/inUse`, undefined, jwt);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { inUse: boolean } };
    expect(body.data.inUse).toBe(true);
  });

  it("returns summary for farm", async () => {
    const { jwt } = await createUserWithFarm();
    const plot = await createPlot(jwt);
    const product = await createCropProtectionProduct(jwt, { name: "SummaryProduct", unit: "kg" });
    await createCropProtectionApplication(jwt, plot.id, product.id, {
      dateTime: "2025-06-15T08:00:00Z",
      amountPerUnit: 2.5,
      numberOfUnits: 10,
    });

    const res = await request("GET", "/v1/cropProtectionApplications/summaries", undefined, jwt);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        monthlyApplications: {
          appliedCropProtections: { productName: string; totalAmount: number; totalProducedUnits: number }[];
        }[];
      };
    };
    expect(body.data.monthlyApplications).toBeDefined();
    const applied = body.data.monthlyApplications
      .flatMap((month) => month.appliedCropProtections)
      .find((entry) => entry.productName === "SummaryProduct");
    expect(applied).toBeDefined();
    expect(applied!.totalAmount).toBe(25);
    expect(applied!.totalProducedUnits).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// Crop Protection Application Presets
// ---------------------------------------------------------------------------
describe("Crop Protection Application Presets", () => {
  beforeEach(cleanDb);

  it("creates a preset and retrieves it", async () => {
    const { jwt, farmId } = await createUserWithFarm();

    const createRes = await request(
      "POST",
      "/v1/cropProtectionApplications/presets",
      {
        name: "Standard Spray",
        method: "spraying",
        unit: "amount_per_hectare",
        amountPerUnit: 2.5,
      },
      jwt
    );
    expect(createRes.status).toBe(200);
    const preset = (
      (await createRes.json()) as {
        data: { id: string; name: string; method: string; amountPerUnit: number };
      }
    ).data;
    expect(preset.name).toBe("Standard Spray");
    expect(preset.method).toBe("spraying");

    // Verify DB
    const db = getAdminDb();
    const dbPreset = await db.query.cropProtectionApplicationPresets.findFirst({
      where: { id: preset.id },
    });
    expect(dbPreset!.name).toBe("Standard Spray");
    expect(dbPreset!.method).toBe("spraying");
    expect(dbPreset!.unit).toBe("amount_per_hectare");
    expect(dbPreset!.amountPerUnit).toBe(2.5);
    expect(dbPreset!.farmId).toBe(farmId);
  });

  it("updates a preset", async () => {
    const { jwt } = await createUserWithFarm();
    const createRes = await request(
      "POST",
      "/v1/cropProtectionApplications/presets",
      { name: "Old", method: "spraying", unit: "amount_per_hectare", amountPerUnit: 1.0 },
      jwt
    );
    const preset = ((await createRes.json()) as { data: { id: string } }).data;

    await request(
      "PATCH",
      `/v1/cropProtectionApplications/presets/byId/${preset.id}`,
      { name: "New", amountPerUnit: 3.0 },
      jwt
    );

    // Verify DB
    const db = getAdminDb();
    const dbPreset = await db.query.cropProtectionApplicationPresets.findFirst({
      where: { id: preset.id },
    });
    expect(dbPreset!.name).toBe("New");
    expect(dbPreset!.amountPerUnit).toBe(3.0);
  });

  it("deletes a preset", async () => {
    const { jwt } = await createUserWithFarm();
    const createRes = await request(
      "POST",
      "/v1/cropProtectionApplications/presets",
      { name: "ToDelete", unit: "amount_per_hectare", amountPerUnit: 1.0 },
      jwt
    );
    const preset = ((await createRes.json()) as { data: { id: string } }).data;

    const res = await request("DELETE", `/v1/cropProtectionApplications/presets/byId/${preset.id}`, undefined, jwt);
    expect(res.status).toBe(200);

    // Verify DB
    const db = getAdminDb();
    const dbPreset = await db.query.cropProtectionApplicationPresets.findFirst({
      where: { id: preset.id },
    });
    expect(dbPreset).toBeUndefined();
  });
});
