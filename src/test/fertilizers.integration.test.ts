import { describe, it, expect, beforeEach } from "@jest/globals";

import { cleanDb, getAdminDb, request } from "./helpers";
import * as schema from "../db/schema";
import { createUserWithFarm, createFertilizer } from "./test-utils";

// ---------------------------------------------------------------------------
// Fertilizers CRUD
// ---------------------------------------------------------------------------
describe("Fertilizers CRUD", () => {
  beforeEach(cleanDb);

  it("creates a fertilizer and retrieves it by id", async () => {
    const { jwt, farmId } = await createUserWithFarm();
    const fert = await createFertilizer(jwt, {
      name: "Cow Manure",
      type: "organic",
      unit: "t",
    });

    expect(fert.name).toBe("Cow Manure");
    expect(fert.type).toBe("organic");
    expect(fert.unit).toBe("t");
    expect(fert.farmId).toBe(farmId);

    // Verify DB
    const db = getAdminDb();
    const dbFert = await db.query.fertilizers.findFirst({
      where: { id: fert.id },
    });
    expect(dbFert!.name).toBe("Cow Manure");
    expect(dbFert!.type).toBe("organic");
    expect(dbFert!.unit).toBe("t");
    expect(dbFert!.farmId).toBe(farmId);

    // GET by id
    const getRes = await request("GET", `/v1/fertilizers/byId/${fert.id}`, undefined, jwt);
    expect(getRes.status).toBe(200);
  });

  it("lists fertilizers for farm", async () => {
    const { jwt } = await createUserWithFarm();
    await createFertilizer(jwt, { name: "F1" });
    await createFertilizer(jwt, { name: "F2" });

    const res = await request("GET", "/v1/fertilizers", undefined, jwt);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { count: number } };
    expect(body.data.count).toBe(2);
  });

  it("updates a fertilizer", async () => {
    const { jwt } = await createUserWithFarm();
    const fert = await createFertilizer(jwt, { name: "OldName" });

    const res = await request(
      "PATCH",
      `/v1/fertilizers/byId/${fert.id}`,
      { name: "NewName", description: "Rich in nitrogen" },
      jwt
    );
    expect(res.status).toBe(200);

    // Verify DB
    const db = getAdminDb();
    const dbFert = await db.query.fertilizers.findFirst({
      where: { id: fert.id },
    });
    expect(dbFert!.name).toBe("NewName");
    expect(dbFert!.description).toBe("Rich in nitrogen");
  });

  it("deletes a fertilizer", async () => {
    const { jwt } = await createUserWithFarm();
    const fert = await createFertilizer(jwt);

    const res = await request("DELETE", `/v1/fertilizers/byId/${fert.id}`, undefined, jwt);
    expect(res.status).toBe(200);

    // Verify DB
    const db = getAdminDb();
    const dbFert = await db.query.fertilizers.findFirst({
      where: { id: fert.id },
    });
    expect(dbFert).toBeUndefined();
  });

  it("checks if fertilizer is in use (false when unused)", async () => {
    const { jwt } = await createUserWithFarm();
    const fert = await createFertilizer(jwt);

    const res = await request("GET", `/v1/fertilizers/byId/${fert.id}/inUse`, undefined, jwt);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { inUse: boolean } };
    expect(body.data.inUse).toBe(false);
  });
});
