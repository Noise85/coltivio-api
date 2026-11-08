import { describe, it, expect, beforeEach } from "@jest/globals";

import { cleanDb, getAdminDb, request } from "./helpers";
import * as schema from "../db/schema";
import { createUserWithFarm, createCrop, createCropFamily } from "./test-utils";

// ---------------------------------------------------------------------------
// Crops CRUD
// ---------------------------------------------------------------------------
describe("Crops CRUD", () => {
  beforeEach(cleanDb);

  it("creates a crop and retrieves it by id", async () => {
    const { jwt, farmId } = await createUserWithFarm();
    const crop = await createCrop(jwt, {
      name: "Barley",
      category: "grain",
    });

    expect(crop.name).toBe("Barley");
    expect(crop.category).toBe("grain");
    expect(crop.farmId).toBe(farmId);

    // Verify DB
    const db = getAdminDb();
    const dbCrop = await db.query.crops.findFirst({
      where: { id: crop.id },
    });
    expect(dbCrop!.name).toBe("Barley");
    expect(dbCrop!.category).toBe("grain");
    expect(dbCrop!.farmId).toBe(farmId);

    // GET by id
    const getRes = await request("GET", `/v1/crops/byId/${crop.id}`, undefined, jwt);
    expect(getRes.status).toBe(200);
  });

  it("lists crops for farm", async () => {
    const { jwt } = await createUserWithFarm();
    await createCrop(jwt, { name: "C1" });
    await createCrop(jwt, { name: "C2" });

    const res = await request("GET", "/v1/crops", undefined, jwt);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { count: number } };
    // 2 created + 1 default "natural meadow" crop from farm creation
    expect(body.data.count).toBe(3);
  });

  it("creates crop with family reference", async () => {
    const { jwt } = await createUserWithFarm();
    const family = await createCropFamily(jwt, { name: "Nightshades" });
    const crop = await createCrop(jwt, { name: "Tomato", category: "vegetable", familyId: family.id });

    // Verify DB
    const db = getAdminDb();
    const dbCrop = await db.query.crops.findFirst({
      where: { id: crop.id },
    });
    expect(dbCrop!.familyId).toBe(family.id);

    // Verify API returns family
    expect(crop.familyId).toBe(family.id);
    const cropFamily = crop.family as Record<string, unknown> | null;
    expect(cropFamily).not.toBeNull();
    expect(cropFamily!.name).toBe("Nightshades");
  });

  it("updates a crop", async () => {
    const { jwt } = await createUserWithFarm();
    const crop = await createCrop(jwt, { name: "OldWheat" });

    const res = await request("PATCH", `/v1/crops/byId/${crop.id}`, { name: "Winter Wheat", variety: "Arina" }, jwt);
    expect(res.status).toBe(200);

    // Verify DB
    const db = getAdminDb();
    const dbCrop = await db.query.crops.findFirst({
      where: { id: crop.id },
    });
    expect(dbCrop!.name).toBe("Winter Wheat");
    expect(dbCrop!.variety).toBe("Arina");
  });

  it("deletes a crop", async () => {
    const { jwt } = await createUserWithFarm();
    const crop = await createCrop(jwt);

    const res = await request("DELETE", `/v1/crops/byId/${crop.id}`, undefined, jwt);
    expect(res.status).toBe(200);

    // Verify DB
    const db = getAdminDb();
    const dbCrop = await db.query.crops.findFirst({
      where: { id: crop.id },
    });
    expect(dbCrop).toBeUndefined();
  });

  it("checks if crop is in use (false when unused)", async () => {
    const { jwt } = await createUserWithFarm();
    const crop = await createCrop(jwt);

    const res = await request("GET", `/v1/crops/byId/${crop.id}/inUse`, undefined, jwt);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { inUse: boolean } };
    expect(body.data.inUse).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Crop Families CRUD
// ---------------------------------------------------------------------------
describe("Crop Families CRUD", () => {
  beforeEach(cleanDb);

  it("creates a crop family and retrieves it", async () => {
    const { jwt, farmId } = await createUserWithFarm();
    const family = await createCropFamily(jwt, {
      name: "Brassicas",
      waitingTimeInYears: 4,
    });

    expect(family.name).toBe("Brassicas");
    expect(family.waitingTimeInYears).toBe(4);

    // Verify DB
    const db = getAdminDb();
    const dbFamily = await db.query.cropFamilies.findFirst({
      where: { id: family.id },
    });
    expect(dbFamily!.name).toBe("Brassicas");
    expect(dbFamily!.waitingTimeInYears).toBe(4);
    expect(dbFamily!.farmId).toBe(farmId);
  });

  it("lists crop families for farm", async () => {
    const { jwt } = await createUserWithFarm();
    await createCropFamily(jwt, { name: "F1" });
    await createCropFamily(jwt, { name: "F2" });

    const res = await request("GET", "/v1/crops/families", undefined, jwt);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { count: number } };
    expect(body.data.count).toBe(2);
  });

  it("updates a crop family", async () => {
    const { jwt } = await createUserWithFarm();
    const family = await createCropFamily(jwt, { name: "OldName", waitingTimeInYears: 2 });

    const res = await request(
      "PATCH",
      `/v1/crops/families/byId/${family.id}`,
      { name: "NewName", waitingTimeInYears: 5 },
      jwt
    );
    expect(res.status).toBe(200);

    // Verify DB
    const db = getAdminDb();
    const dbFamily = await db.query.cropFamilies.findFirst({
      where: { id: family.id },
    });
    expect(dbFamily!.name).toBe("NewName");
    expect(dbFamily!.waitingTimeInYears).toBe(5);
  });

  it("deletes a crop family", async () => {
    const { jwt } = await createUserWithFarm();
    const family = await createCropFamily(jwt);

    const res = await request("DELETE", `/v1/crops/families/byId/${family.id}`, undefined, jwt);
    expect(res.status).toBe(200);

    // Verify DB
    const db = getAdminDb();
    const dbFamily = await db.query.cropFamilies.findFirst({
      where: { id: family.id },
    });
    expect(dbFamily).toBeUndefined();
  });

  it("reports crop family in use when a crop references it", async () => {
    const { jwt } = await createUserWithFarm();
    const family = await createCropFamily(jwt, { name: "Solanaceae" });
    await createCrop(jwt, { familyId: family.id });

    const res = await request("GET", `/v1/crops/families/byId/${family.id}/inUse`, undefined, jwt);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { inUse: boolean } };
    expect(body.data.inUse).toBe(true);
  });

  it("reports crop family not in use when no crop references it", async () => {
    const { jwt } = await createUserWithFarm();
    const family = await createCropFamily(jwt);

    const res = await request("GET", `/v1/crops/families/byId/${family.id}/inUse`, undefined, jwt);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { inUse: boolean } };
    expect(body.data.inUse).toBe(false);
  });
});
