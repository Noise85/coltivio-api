import { describe, it, expect, beforeEach } from "@jest/globals";
import ExcelJS from "exceljs";

import { cleanDb, getAdminDb, request } from "./helpers";
import { createUserWithFarm, createCrop, createFarmMember, createPlot, TEST_GEOMETRY } from "./test-utils";

type SowingResponse = {
  id: string;
  farmId: string;
  plotId: string;
  cropId: string;
  seedId: string | null;
  unit: string;
  amount: number;
  totalBaseAmount: number;
  baseAmountPerHectare: number;
  size: number;
  plot: { name: string };
  crop: { name: string };
  seed: { name: string } | null;
};

async function createSeed(jwt: string, cropId: string, data: Record<string, unknown>) {
  const res = await request("POST", "/v1/seeds", { name: "Test Seed", quantityKind: "weight", cropId, ...data }, jwt);
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: { id: string } }).data;
}

async function createSowings(jwt: string, payload: Record<string, unknown>): Promise<SowingResponse[]> {
  const res = await request("POST", "/v1/sowings", { date: "2025-04-20", ...payload }, jwt);
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: { result: SowingResponse[] } }).data.result;
}

describe("Sowings", () => {
  beforeEach(cleanDb);

  it("creates sowings on multiple plots and normalizes per-area amounts", async () => {
    const { jwt, farmId } = await createUserWithFarm();
    const crop = await createCrop(jwt, { name: "Futtermais" });
    const seed = await createSeed(jwt, crop.id, {});
    const p1 = await createPlot(jwt, { name: "Acker 1" });
    const p2 = await createPlot(jwt, { name: "Acker 2" });

    const result = await createSowings(jwt, {
      cropId: crop.id,
      seedId: seed.id,
      unit: "kg_per_ha",
      plots: [
        { plotId: p1.id, amount: 30, geometry: TEST_GEOMETRY, size: 10000 },
        { plotId: p2.id, amount: 30, geometry: TEST_GEOMETRY, size: 5000 },
      ],
    });
    expect(result).toHaveLength(2);
    const first = result.find((sowing) => sowing.plotId === p1.id)!;
    const second = result.find((sowing) => sowing.plotId === p2.id)!;
    expect(first.farmId).toBe(farmId);
    expect(first.crop.name).toBe("Futtermais");
    expect(first.seed!.name).toBe("Test Seed");
    // 30 kg/ha on 1 ha = 30'000 g
    expect(first.totalBaseAmount).toBe(30000);
    expect(first.baseAmountPerHectare).toBe(30000);
    // 30 kg/ha on 0.5 ha = 15'000 g
    expect(second.totalBaseAmount).toBe(15000);

    const db = getAdminDb();
    const dbSowings = await db.query.sowings.findMany({});
    expect(dbSowings).toHaveLength(2);
  });

  it("takes the crop from the seed and rejects a different crop", async () => {
    const { jwt } = await createUserWithFarm();
    const crop = await createCrop(jwt, { name: "Futtermais" });
    const otherCrop = await createCrop(jwt, { name: "Weizen" });
    const seed = await createSeed(jwt, crop.id, {});
    const plot = await createPlot(jwt);

    const [sowing] = await createSowings(jwt, {
      seedId: seed.id,
      unit: "kg_per_ha",
      plots: [{ plotId: plot.id, amount: 30, geometry: TEST_GEOMETRY, size: 10000 }],
    });
    expect(sowing.cropId).toBe(crop.id);

    const mismatchRes = await request(
      "POST",
      "/v1/sowings",
      {
        date: "2025-04-20",
        cropId: otherCrop.id,
        seedId: seed.id,
        unit: "kg_per_ha",
        plots: [{ plotId: plot.id, amount: 30, geometry: TEST_GEOMETRY, size: 10000 }],
      },
      jwt
    );
    expect(mismatchRes.status).toBe(400);
    expect(((await mismatchRes.json()) as { code: string }).code).toBe("sowing_crop_mismatch");

    const missingCropRes = await request(
      "POST",
      "/v1/sowings",
      {
        date: "2025-04-20",
        unit: "kg_per_ha",
        plots: [{ plotId: plot.id, amount: 30, geometry: TEST_GEOMETRY, size: 10000 }],
      },
      jwt
    );
    expect(missingCropRes.status).toBe(400);
    expect(((await missingCropRes.json()) as { code: string }).code).toBe("sowing_crop_required");

    // switching to a seed of another crop moves the sowing to that crop
    const otherSeed = await createSeed(jwt, otherCrop.id, { name: "Weizen CH Nara" });
    const updateRes = await request("PATCH", `/v1/sowings/byId/${sowing.id}`, { seedId: otherSeed.id }, jwt);
    expect(updateRes.status).toBe(200);
    expect(((await updateRes.json()) as { data: SowingResponse }).data.cropId).toBe(otherCrop.id);

    // changing only the crop while a seed of another crop is set is rejected
    const cropOnlyRes = await request("PATCH", `/v1/sowings/byId/${sowing.id}`, { cropId: crop.id }, jwt);
    expect(cropOnlyRes.status).toBe(400);
  });

  it("normalizes total amounts and derives the rate per hectare", async () => {
    const { jwt } = await createUserWithFarm();
    const crop = await createCrop(jwt, { name: "Salat" });
    const plot = await createPlot(jwt);

    const [sowing] = await createSowings(jwt, {
      cropId: crop.id,
      unit: "plants",
      plots: [{ plotId: plot.id, amount: 200, geometry: TEST_GEOMETRY, size: 100 }],
    });
    expect(sowing.seedId).toBeNull();
    expect(sowing.totalBaseAmount).toBe(200);
    // 200 plants on 100 m² = 20'000 plants/ha
    expect(sowing.baseAmountPerHectare).toBe(20000);
  });

  it("rejects an amount of 0", async () => {
    const { jwt } = await createUserWithFarm();
    const crop = await createCrop(jwt);
    const plot = await createPlot(jwt);
    const res = await request(
      "POST",
      "/v1/sowings",
      {
        date: "2025-04-20",
        cropId: crop.id,
        unit: "kg_per_ha",
        plots: [{ plotId: plot.id, amount: 0, geometry: TEST_GEOMETRY, size: 10000 }],
      },
      jwt
    );
    expect(res.status).toBe(400);
  });

  it("lets read-only members read but not write sowings and seeds", async () => {
    const { jwt: ownerJwt } = await createUserWithFarm({}, undefined, { withActiveMembership: true });
    const crop = await createCrop(ownerJwt);
    const plot = await createPlot(ownerJwt);
    const { jwt: memberJwt } = await createFarmMember(ownerJwt, "member@test.com", {
      permissions: [{ feature: "field_calendar", access: "read" }],
    });

    const listRes = await request("GET", "/v1/sowings", undefined, memberJwt);
    expect(listRes.status).toBe(200);

    const createRes = await request(
      "POST",
      "/v1/sowings",
      {
        date: "2025-04-20",
        cropId: crop.id,
        unit: "kg_per_ha",
        plots: [{ plotId: plot.id, amount: 30, geometry: TEST_GEOMETRY, size: 10000 }],
      },
      memberJwt
    );
    expect(createRes.status).toBe(403);

    const seedRes = await request(
      "POST",
      "/v1/seeds",
      { name: "X", cropId: crop.id, quantityKind: "weight" },
      memberJwt
    );
    expect(seedRes.status).toBe(403);
  });

  it("rejects units that do not match the seed quantity kind", async () => {
    const { jwt } = await createUserWithFarm();
    const crop = await createCrop(jwt);
    const seed = await createSeed(jwt, crop.id, { quantityKind: "weight" });
    const plot = await createPlot(jwt);

    const res = await request(
      "POST",
      "/v1/sowings",
      {
        date: "2025-04-20",
        cropId: crop.id,
        seedId: seed.id,
        unit: "seeds_per_m2",
        plots: [{ plotId: plot.id, amount: 40, geometry: TEST_GEOMETRY, size: 10000 }],
      },
      jwt
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("sowing_unit_mismatch");
  });

  it("updates a sowing and recomputes base amounts", async () => {
    const { jwt } = await createUserWithFarm();
    const crop = await createCrop(jwt);
    const seed = await createSeed(jwt, crop.id, {});
    const plot = await createPlot(jwt);
    const [sowing] = await createSowings(jwt, {
      cropId: crop.id,
      seedId: seed.id,
      unit: "kg_per_ha",
      plots: [{ plotId: plot.id, amount: 30, geometry: TEST_GEOMETRY, size: 20000 }],
    });

    const res = await request("PATCH", `/v1/sowings/byId/${sowing.id}`, { unit: "kg", amount: 50 }, jwt);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: SowingResponse };
    expect(body.data.totalBaseAmount).toBe(50000);
    expect(body.data.baseAmountPerHectare).toBe(25000);

    const badRes = await request("PATCH", `/v1/sowings/byId/${sowing.id}`, { unit: "plants" }, jwt);
    expect(badRes.status).toBe(400);

    // removing the seed allows any unit
    const noSeedRes = await request("PATCH", `/v1/sowings/byId/${sowing.id}`, { seedId: null, unit: "plants" }, jwt);
    expect(noSeedRes.status).toBe(200);
  });

  it("lists sowings for farm and plot, summarizes per plot and deletes", async () => {
    const { jwt } = await createUserWithFarm();
    const crop = await createCrop(jwt);
    const p1 = await createPlot(jwt, { name: "P1" });
    const p2 = await createPlot(jwt, { name: "P2" });
    const [sowing] = await createSowings(jwt, {
      cropId: crop.id,
      unit: "kg_per_ha",
      plots: [{ plotId: p1.id, amount: 30, geometry: TEST_GEOMETRY, size: 10000 }],
    });
    await createSowings(jwt, {
      date: "2024-04-20",
      cropId: crop.id,
      unit: "kg_per_ha",
      plots: [{ plotId: p2.id, amount: 30, geometry: TEST_GEOMETRY, size: 10000 }],
    });

    const farmRes = await request("GET", "/v1/sowings?fromDate=2024-01-01&toDate=2025-12-31", undefined, jwt);
    expect(((await farmRes.json()) as { data: { count: number } }).data.count).toBe(2);

    const plotRes = await request("GET", `/v1/plots/byId/${p1.id}/sowings`, undefined, jwt);
    expect(((await plotRes.json()) as { data: { count: number } }).data.count).toBe(1);

    const plotSummaryRes = await request("GET", `/v1/plots/byId/${p1.id}/sowingSummary`, undefined, jwt);
    const plotSummary = (await plotSummaryRes.json()) as {
      data: { monthlySowings: { year: number; sownSeeds: { totalBaseAmount: number }[] }[] };
    };
    // only the 2025 sowing is on this plot: 30 kg/ha on 1 ha
    expect(plotSummary.data.monthlySowings).toHaveLength(1);
    expect(plotSummary.data.monthlySowings[0].year).toBe(2025);
    expect(plotSummary.data.monthlySowings[0].sownSeeds[0].totalBaseAmount).toBe(30000);

    const deleteRes = await request("DELETE", `/v1/sowings/byId/${sowing.id}`, undefined, jwt);
    expect(deleteRes.status).toBe(200);
    const getRes = await request("GET", `/v1/sowings/byId/${sowing.id}`, undefined, jwt);
    expect(getRes.status).toBe(404);
  });

  it("keeps seeds and plants of the same seed apart in the summary", async () => {
    const { jwt } = await createUserWithFarm();
    const crop = await createCrop(jwt, { name: "Salat" });
    const seed = await createSeed(jwt, crop.id, { quantityKind: "count" });
    const plot = await createPlot(jwt);
    await createSowings(jwt, {
      seedId: seed.id,
      unit: "plants_per_m2",
      plots: [{ plotId: plot.id, amount: 10, geometry: TEST_GEOMETRY, size: 100 }],
    });
    await createSowings(jwt, {
      seedId: seed.id,
      unit: "seeds",
      plots: [{ plotId: plot.id, amount: 500, geometry: TEST_GEOMETRY, size: 100 }],
    });

    const res = await request("GET", "/v1/sowings/summaries", undefined, jwt);
    const body = (await res.json()) as {
      data: { monthlySowings: { sownSeeds: { countUnit: string | null; totalBaseAmount: number }[] }[] };
    };
    const sownSeeds = body.data.monthlySowings[0].sownSeeds;
    expect(sownSeeds).toHaveLength(2);
    expect(sownSeeds.find((entry) => entry.countUnit === "plants")?.totalBaseAmount).toBe(1000);
    expect(sownSeeds.find((entry) => entry.countUnit === "seeds")?.totalBaseAmount).toBe(500);
  });

  it("sums base amounts per seed and kind in the summary", async () => {
    const { jwt } = await createUserWithFarm();
    const crop = await createCrop(jwt, { name: "Weizen" });
    const seed = await createSeed(jwt, crop.id, { name: "Weizen CH Nara" });
    const plot = await createPlot(jwt);
    await createSowings(jwt, {
      cropId: crop.id,
      seedId: seed.id,
      unit: "kg_per_ha",
      plots: [{ plotId: plot.id, amount: 180, geometry: TEST_GEOMETRY, size: 10000 }],
    });
    await createSowings(jwt, {
      date: "2025-04-25",
      cropId: crop.id,
      seedId: seed.id,
      unit: "kg",
      plots: [{ plotId: plot.id, amount: 20, geometry: TEST_GEOMETRY, size: 1000 }],
    });

    const res = await request("GET", "/v1/sowings/summaries", undefined, jwt);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        monthlySowings: {
          year: number;
          month: number;
          sownSeeds: { seedName: string | null; quantityKind: string; totalBaseAmount: number; totalSize: number }[];
        }[];
      };
    };
    expect(body.data.monthlySowings).toHaveLength(1);
    const [sownSeed] = body.data.monthlySowings[0].sownSeeds;
    expect(sownSeed.seedName).toBe("Weizen CH Nara");
    expect(sownSeed.quantityKind).toBe("weight");
    expect(sownSeed.totalBaseAmount).toBe(200000);
    expect(sownSeed.totalSize).toBe(11000);
  });

  it("returns the unit map", async () => {
    const { jwt } = await createUserWithFarm();
    const res = await request("GET", "/v1/sowings/units", undefined, jwt);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { result: { unit: string; quantityKind: string; perArea: boolean }[] };
    };
    expect(body.data.result).toContainEqual({
      unit: "kg_per_ha",
      quantityKind: "weight",
      countUnit: null,
      perArea: true,
    });
    expect(body.data.result).toContainEqual({
      unit: "plants",
      quantityKind: "count",
      countUnit: "plants",
      perArea: false,
    });
  });

  it("rejects crops and plots of other farms", async () => {
    const { jwt } = await createUserWithFarm();
    const crop = await createCrop(jwt);
    const plot = await createPlot(jwt);
    const { jwt: otherJwt } = await createUserWithFarm({ name: "Other Farm" }, "other@test.com");
    const otherCrop = await createCrop(otherJwt);
    const otherPlot = await createPlot(otherJwt);

    const foreignPlotRes = await request(
      "POST",
      "/v1/sowings",
      {
        date: "2025-04-20",
        cropId: crop.id,
        unit: "kg_per_ha",
        plots: [{ plotId: otherPlot.id, amount: 30, geometry: TEST_GEOMETRY, size: 10000 }],
      },
      jwt
    );
    expect(foreignPlotRes.status).toBe(400);
    expect(((await foreignPlotRes.json()) as { code: string }).code).toBe("plot_not_found");

    const foreignCropRes = await request(
      "POST",
      "/v1/sowings",
      {
        date: "2025-04-20",
        cropId: otherCrop.id,
        unit: "kg_per_ha",
        plots: [{ plotId: plot.id, amount: 30, geometry: TEST_GEOMETRY, size: 10000 }],
      },
      jwt
    );
    expect(foreignCropRes.status).toBe(400);
    expect(((await foreignCropRes.json()) as { code: string }).code).toBe("crop_not_found");

    const foreignSeedCropRes = await request(
      "POST",
      "/v1/seeds",
      { name: "Fremd", cropId: otherCrop.id, quantityKind: "weight" },
      jwt
    );
    expect(foreignSeedCropRes.status).toBe(400);
  });

  it("refuses to delete a crop that is in use", async () => {
    const { jwt } = await createUserWithFarm();
    const crop = await createCrop(jwt);
    await createSeed(jwt, crop.id, {});

    const res = await request("DELETE", `/v1/crops/byId/${crop.id}`, undefined, jwt);
    expect(res.status).toBe(409);
  });

  it("does not expose sowings of other farms", async () => {
    const { jwt } = await createUserWithFarm();
    const crop = await createCrop(jwt);
    const plot = await createPlot(jwt);
    const [sowing] = await createSowings(jwt, {
      cropId: crop.id,
      unit: "kg_per_ha",
      plots: [{ plotId: plot.id, amount: 30, geometry: TEST_GEOMETRY, size: 10000 }],
    });
    const { jwt: otherJwt } = await createUserWithFarm({ name: "Other Farm" }, "other@test.com");

    const getRes = await request("GET", `/v1/sowings/byId/${sowing.id}`, undefined, otherJwt);
    expect(getRes.status).toBe(404);
  });
});

describe("Sowing presets", () => {
  beforeEach(cleanDb);

  it("creates, updates, lists and deletes presets", async () => {
    const { jwt } = await createUserWithFarm();
    const crop = await createCrop(jwt, { name: "Futtermais" });
    const seed = await createSeed(jwt, crop.id, {});

    const createRes = await request(
      "POST",
      "/v1/sowings/presets",
      { name: "Mais Standard", cropId: crop.id, seedId: seed.id, unit: "kg_per_ha", amount: 30 },
      jwt
    );
    expect(createRes.status).toBe(200);
    const preset = ((await createRes.json()) as { data: { id: string; crop: { name: string } } }).data;
    expect(preset.crop.name).toBe("Futtermais");

    const badRes = await request("PATCH", `/v1/sowings/presets/byId/${preset.id}`, { unit: "seeds_per_m2" }, jwt);
    expect(badRes.status).toBe(400);

    const updateRes = await request("PATCH", `/v1/sowings/presets/byId/${preset.id}`, { amount: 35 }, jwt);
    expect(updateRes.status).toBe(200);
    expect(((await updateRes.json()) as { data: { amount: number } }).data.amount).toBe(35);

    const listRes = await request("GET", "/v1/sowings/presets", undefined, jwt);
    expect(((await listRes.json()) as { data: { count: number } }).data.count).toBe(1);

    // a crop other than the seed's crop and a unit of the other kind are rejected
    const otherCrop = await createCrop(jwt, { name: "Weizen" });
    const cropMismatchRes = await request(
      "PATCH",
      `/v1/sowings/presets/byId/${preset.id}`,
      { cropId: otherCrop.id },
      jwt
    );
    expect(cropMismatchRes.status).toBe(400);
    expect(((await cropMismatchRes.json()) as { code: string }).code).toBe("sowing_crop_mismatch");

    const emptyNameRes = await request("PATCH", `/v1/sowings/presets/byId/${preset.id}`, { name: " " }, jwt);
    expect(emptyNameRes.status).toBe(400);

    const deleteRes = await request("DELETE", `/v1/sowings/presets/byId/${preset.id}`, undefined, jwt);
    expect(deleteRes.status).toBe(200);
  });
});

describe("Sowing field events", () => {
  beforeEach(cleanDb);

  it("only includes sowings when requested via types", async () => {
    const { jwt } = await createUserWithFarm();
    const crop = await createCrop(jwt, { name: "Gerste" });
    const plot = await createPlot(jwt);
    await createSowings(jwt, {
      cropId: crop.id,
      unit: "kg_per_ha",
      plots: [{ plotId: plot.id, amount: 150, geometry: TEST_GEOMETRY, size: 10000 }],
    });

    const defaultRes = await request(
      "GET",
      "/v1/farm/fieldEvents?fromDate=2025-01-01&toDate=2025-12-31",
      undefined,
      jwt
    );
    expect(defaultRes.status).toBe(200);
    const defaultBody = (await defaultRes.json()) as { data: { result: { type: string }[] } };
    expect(defaultBody.data.result).toHaveLength(0);

    const sowingRes = await request(
      "GET",
      "/v1/farm/fieldEvents?fromDate=2025-01-01&toDate=2025-12-31&types=sowing,harvest",
      undefined,
      jwt
    );
    expect(sowingRes.status).toBe(200);
    const sowingBody = (await sowingRes.json()) as { data: { result: { type: string }[] } };
    expect(sowingBody.data.result).toHaveLength(1);
    expect(sowingBody.data.result[0].type).toBe("sowing");

    const invalidRes = await request(
      "GET",
      "/v1/farm/fieldEvents?fromDate=2025-01-01&toDate=2025-12-31&types=unknown",
      undefined,
      jwt
    );
    expect(invalidRes.status).toBe(400);
  });

  it("includes sowings in the field calendar report when requested", async () => {
    const { jwt } = await createUserWithFarm();
    const crop = await createCrop(jwt, { name: "Gerste" });
    const seed = await createSeed(jwt, crop.id, { name: "Salat Lollo", quantityKind: "count" });
    const plot = await createPlot(jwt);
    await createSowings(jwt, {
      cropId: crop.id,
      unit: "kg_per_ha",
      plots: [{ plotId: plot.id, amount: 150, geometry: TEST_GEOMETRY, size: 10000 }],
    });
    await createSowings(jwt, {
      seedId: seed.id,
      unit: "plants",
      plots: [{ plotId: plot.id, amount: 400, geometry: TEST_GEOMETRY, size: 10000 }],
    });

    const res = await request(
      "POST",
      "/v1/reports/fieldcalendar/download",
      {
        fromDate: "2025-01-01",
        toDate: "2025-12-31",
        generateCropRotations: false,
        generateTillages: false,
        generateFertilizerApplications: false,
        generateCropProtectionApplications: false,
        generateHarvests: false,
        generateSowings: true,
      },
      jwt
    );
    expect(res.status).toBe(200);

    const body = (await res.json()) as { data: { base64: string } };
    const workbook = new ExcelJS.Workbook();
    const reportBytes = Buffer.from(body.data.base64, "base64");
    await workbook.xlsx.load(
      reportBytes.buffer.slice(reportBytes.byteOffset, reportBytes.byteOffset + reportBytes.byteLength)
    );
    const cellTexts: string[] = [];
    workbook.eachSheet((sheet) => {
      sheet.eachRow((row) => {
        row.eachCell((cell) => {
          cellTexts.push(String(cell.value));
        });
      });
    });
    // weight shown in kg, counted plants with their own label
    expect(cellTexts).toContain("Salat Lollo");
    expect(cellTexts).toContain("150.00 kg");
    expect(cellTexts).toContain("400 Pflanzen");
  });
});
