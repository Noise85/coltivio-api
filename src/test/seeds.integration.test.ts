import { describe, it, expect, beforeEach } from "@jest/globals";

import { cleanDb, getAdminDb, request } from "./helpers";
import { createUserWithFarm, createCrop, createPlot, TEST_GEOMETRY } from "./test-utils";

type SeedResponse = {
  id: string;
  farmId: string;
  name: string;
  cropId: string | null;
  crop: { name: string } | null;
  quantityKind: "weight" | "count";
  defaultAmount: number | null;
  defaultUnit: string | null;
};

async function createSeed(jwt: string, data: Record<string, unknown>): Promise<SeedResponse> {
  const res = await request(
    "POST",
    "/v1/seeds",
    { name: "Futtermais LG 31.205", quantityKind: "weight", ...data },
    jwt
  );
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: SeedResponse }).data;
}

describe("Seeds CRUD", () => {
  beforeEach(cleanDb);

  it("creates a seed with crop and default rate and retrieves it", async () => {
    const { jwt, farmId } = await createUserWithFarm();
    const crop = await createCrop(jwt, { name: "Futtermais" });
    const seed = await createSeed(jwt, { cropId: crop.id, defaultAmount: 30, defaultUnit: "kg_per_ha" });

    expect(seed.farmId).toBe(farmId);
    expect(seed.cropId).toBe(crop.id);
    expect(seed.crop!.name).toBe("Futtermais");
    expect(seed.defaultUnit).toBe("kg_per_ha");

    const getRes = await request("GET", `/v1/seeds/byId/${seed.id}`, undefined, jwt);
    expect(getRes.status).toBe(200);

    const listRes = await request("GET", "/v1/seeds", undefined, jwt);
    const listBody = (await listRes.json()) as { data: { count: number } };
    expect(listBody.data.count).toBe(1);
  });

  it("rejects a default unit that does not match the quantity kind", async () => {
    const { jwt } = await createUserWithFarm();
    const res = await request(
      "POST",
      "/v1/seeds",
      { name: "Salat Setzlinge", quantityKind: "count", defaultAmount: 10, defaultUnit: "kg_per_ha" },
      jwt
    );
    expect(res.status).toBe(400);
  });

  it("updates a seed but never changes its quantity kind", async () => {
    const { jwt } = await createUserWithFarm();
    const seed = await createSeed(jwt, { defaultAmount: 30, defaultUnit: "kg_per_ha" });

    const res = await request(
      "PATCH",
      `/v1/seeds/byId/${seed.id}`,
      { name: "Renamed", defaultAmount: 35, quantityKind: "count" },
      jwt
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: SeedResponse };
    expect(body.data.name).toBe("Renamed");
    expect(body.data.defaultAmount).toBe(35);
    expect(body.data.quantityKind).toBe("weight");

    const badUnitRes = await request("PATCH", `/v1/seeds/byId/${seed.id}`, { defaultUnit: "plants_per_m2" }, jwt);
    expect(badUnitRes.status).toBe(400);
  });

  it("reports in-use and refuses to delete a seed used by sowings", async () => {
    const { jwt } = await createUserWithFarm();
    const crop = await createCrop(jwt);
    const plot = await createPlot(jwt);
    const seed = await createSeed(jwt, { cropId: crop.id });

    const notInUseRes = await request("GET", `/v1/seeds/byId/${seed.id}/inUse`, undefined, jwt);
    expect(((await notInUseRes.json()) as { data: { inUse: boolean } }).data.inUse).toBe(false);

    const sowingRes = await request(
      "POST",
      "/v1/sowings",
      {
        date: "2025-04-20",
        cropId: crop.id,
        seedId: seed.id,
        unit: "kg_per_ha",
        plots: [{ plotId: plot.id, amount: 30, geometry: TEST_GEOMETRY, size: 10000 }],
      },
      jwt
    );
    expect(sowingRes.status).toBe(200);

    const inUseRes = await request("GET", `/v1/seeds/byId/${seed.id}/inUse`, undefined, jwt);
    expect(((await inUseRes.json()) as { data: { inUse: boolean } }).data.inUse).toBe(true);

    const deleteRes = await request("DELETE", `/v1/seeds/byId/${seed.id}`, undefined, jwt);
    expect(deleteRes.status).toBe(409);
  });

  it("deletes an unused seed", async () => {
    const { jwt } = await createUserWithFarm();
    const seed = await createSeed(jwt, {});

    const res = await request("DELETE", `/v1/seeds/byId/${seed.id}`, undefined, jwt);
    expect(res.status).toBe(200);

    const db = getAdminDb();
    const dbSeed = await db.query.seeds.findFirst({ where: { id: seed.id } });
    expect(dbSeed).toBeUndefined();
  });

  it("does not expose seeds of other farms", async () => {
    const { jwt } = await createUserWithFarm();
    const seed = await createSeed(jwt, {});
    const { jwt: otherJwt } = await createUserWithFarm({ name: "Other Farm" }, "other@test.com");

    const getRes = await request("GET", `/v1/seeds/byId/${seed.id}`, undefined, otherJwt);
    expect(getRes.status).toBe(404);

    const listRes = await request("GET", "/v1/seeds", undefined, otherJwt);
    const listBody = (await listRes.json()) as { data: { count: number } };
    expect(listBody.data.count).toBe(0);
  });
});
