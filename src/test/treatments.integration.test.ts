import { describe, it, expect, beforeEach } from "@jest/globals";

import { cleanDb, getAdminDb, request } from "./helpers";
import * as schema from "../db/schema";
import { createUserWithFarm, createAnimal, createTreatment, createDrug } from "./test-utils";

// ---------------------------------------------------------------------------
// Treatments CRUD
// ---------------------------------------------------------------------------
describe("Treatments CRUD", () => {
  beforeEach(cleanDb);

  it("creates a treatment and retrieves it by id", async () => {
    const { jwt, farmId } = await createUserWithFarm();
    const animal = await createAnimal(jwt, { name: "SickCow" });
    const treatment = await createTreatment(jwt, [animal.id], {
      name: "Vaccination",
      startDate: "2025-02-01",
      endDate: "2025-02-03",
      criticalAntibiotic: false,
      antibiogramAvailable: true,
    });

    expect(treatment.name).toBe("Vaccination");
    expect(treatment.farmId).toBe(farmId);
    expect(treatment.criticalAntibiotic).toBe(false);
    expect(treatment.antibiogramAvailable).toBe(true);

    // Verify DB
    const db = getAdminDb();
    const dbTreatment = await db.query.treatments.findFirst({
      where: { id: treatment.id },
    });
    expect(dbTreatment!.name).toBe("Vaccination");
    expect(dbTreatment!.farmId).toBe(farmId);
    expect(dbTreatment!.criticalAntibiotic).toBe(false);
    expect(dbTreatment!.antibiogramAvailable).toBe(true);

    // GET by id includes animals
    const getRes = await request("GET", `/v1/treatments/byId/${treatment.id}`, undefined, jwt);
    expect(getRes.status).toBe(200);
    const getBody = (await getRes.json()) as {
      data: { id: string; animals: Array<{ id: string }> };
    };
    expect(getBody.data.id).toBe(treatment.id);
    expect(getBody.data.animals).toHaveLength(1);
    expect(getBody.data.animals[0].id).toBe(animal.id);
  });

  it("lists treatments for farm", async () => {
    const { jwt } = await createUserWithFarm();
    const a1 = await createAnimal(jwt, { name: "Cow1" });
    const a2 = await createAnimal(jwt, { name: "Cow2" });
    await createTreatment(jwt, [a1.id], { name: "T1" });
    await createTreatment(jwt, [a2.id], { name: "T2" });

    const res = await request("GET", "/v1/treatments", undefined, jwt);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { count: number } };
    expect(body.data.count).toBe(2);
  });

  it("creates treatment for multiple animals", async () => {
    const { jwt } = await createUserWithFarm();
    const a1 = await createAnimal(jwt, { name: "Cow1" });
    const a2 = await createAnimal(jwt, { name: "Cow2" });
    const treatment = await createTreatment(jwt, [a1.id, a2.id], {
      name: "Group Treatment",
    });

    // GET by id to verify both animals
    const getRes = await request("GET", `/v1/treatments/byId/${treatment.id}`, undefined, jwt);
    const getBody = (await getRes.json()) as {
      data: { animals: Array<{ id: string }> };
    };
    expect(getBody.data.animals).toHaveLength(2);
  });

  it("rejects foreign animal IDs on create and update, including when not first", async () => {
    const { jwt } = await createUserWithFarm({}, `treatments-local-${Date.now()}@test.ch`);
    const { jwt: foreignJwt } = await createUserWithFarm({}, `treatments-foreign-${Date.now()}@test.ch`);
    const localAnimal = await createAnimal(jwt, { name: "Local" });
    const foreignAnimal = await createAnimal(foreignJwt, { name: "Foreign" });

    const createRes = await request(
      "POST",
      "/v1/treatments",
      {
        name: "Cross-farm treatment",
        startDate: "2025-02-01",
        endDate: "2025-02-03",
        criticalAntibiotic: false,
        antibiogramAvailable: false,
        animalIds: [localAnimal.id, foreignAnimal.id],
      },
      jwt
    );
    expect(createRes.status).toBe(400);

    const treatment = await createTreatment(jwt, [localAnimal.id], { name: "Local treatment" });
    const updateRes = await request(
      "PATCH",
      `/v1/treatments/byId/${treatment.id}`,
      { animalIds: [localAnimal.id, foreignAnimal.id] },
      jwt
    );
    expect(updateRes.status).toBe(400);

    const getRes = await request("GET", `/v1/treatments/byId/${treatment.id}`, undefined, jwt);
    const body = (await getRes.json()) as { data: { animals: Array<{ id: string }> } };
    expect(body.data.animals.map((animal) => animal.id)).toEqual([localAnimal.id]);
  });

  it("creates treatment with drug reference and marks drug in use", async () => {
    const { jwt } = await createUserWithFarm();
    const animal = await createAnimal(jwt);
    const drug = await createDrug(jwt, { name: "Antibiotic X" });
    const treatment = await createTreatment(jwt, [animal.id], {
      name: "Drug Treatment",
      drugId: drug.id,
    });

    // Verify DB
    const db = getAdminDb();
    const dbTreatment = await db.query.treatments.findFirst({
      where: { id: treatment.id },
    });
    expect(dbTreatment!.drugId).toBe(drug.id);

    // Drug should now be in use
    const inUseRes = await request("GET", `/v1/drugs/byId/${drug.id}/inUse`, undefined, jwt);
    const inUseBody = (await inUseRes.json()) as { data: { inUse: boolean } };
    expect(inUseBody.data.inUse).toBe(true);
  });

  it("updates a treatment", async () => {
    const { jwt } = await createUserWithFarm();
    const animal = await createAnimal(jwt);
    const treatment = await createTreatment(jwt, [animal.id], { name: "OldName" });

    const res = await request(
      "PATCH",
      `/v1/treatments/byId/${treatment.id}`,
      { name: "NewName", notes: "Went well" },
      jwt
    );
    expect(res.status).toBe(200);

    // Verify DB
    const db = getAdminDb();
    const dbTreatment = await db.query.treatments.findFirst({
      where: { id: treatment.id },
    });
    expect(dbTreatment!.name).toBe("NewName");
    expect(dbTreatment!.notes).toBe("Went well");
  });

  it("deletes a treatment", async () => {
    const { jwt } = await createUserWithFarm();
    const animal = await createAnimal(jwt);
    const treatment = await createTreatment(jwt, [animal.id]);

    const res = await request("DELETE", `/v1/treatments/byId/${treatment.id}`, undefined, jwt);
    expect(res.status).toBe(200);

    // Verify DB
    const db = getAdminDb();
    const dbTreatment = await db.query.treatments.findFirst({
      where: { id: treatment.id },
    });
    expect(dbTreatment).toBeUndefined();
  });
});
