import { describe, it, expect, beforeEach } from "@jest/globals";

import { cleanDb, getAdminDb, request } from "./helpers";
import * as schema from "../db/schema";
import { createUserWithFarm, createDrug } from "./test-utils";

// ---------------------------------------------------------------------------
// Drugs CRUD
// ---------------------------------------------------------------------------
describe("Drugs CRUD", () => {
  beforeEach(cleanDb);

  it("creates a drug with treatment and retrieves it by id", async () => {
    const { jwt, farmId } = await createUserWithFarm();
    const drug = await createDrug(jwt, {
      name: "Amoxicillin",
      criticalAntibiotic: true,
      receivedFrom: "Dr. Vet",
    });

    expect(drug.name).toBe("Amoxicillin");
    expect(drug.criticalAntibiotic).toBe(true);
    expect(drug.receivedFrom).toBe("Dr. Vet");
    expect(drug.farmId).toBe(farmId);
    const drugTreatments = drug.drugTreatment as Array<Record<string, unknown>>;
    expect(drugTreatments).toHaveLength(1);
    expect(drugTreatments[0].doseValue).toBe(5);
    expect(drugTreatments[0].doseUnit).toBe("ml");
    expect(drugTreatments[0].milkWaitingDays).toBe(3);

    // Verify DB
    const db = getAdminDb();
    const dbDrug = await db.query.drugs.findFirst({
      where: { id: drug.id },
    });
    expect(dbDrug!.name).toBe("Amoxicillin");
    expect(dbDrug!.criticalAntibiotic).toBe(true);
    expect(dbDrug!.receivedFrom).toBe("Dr. Vet");
    expect(dbDrug!.farmId).toBe(farmId);

    // GET by id
    const getRes = await request("GET", `/v1/drugs/byId/${drug.id}`, undefined, jwt);
    expect(getRes.status).toBe(200);
    const getBody = (await getRes.json()) as { data: { id: string } };
    expect(getBody.data.id).toBe(drug.id);
  });

  it("lists drugs for farm", async () => {
    const { jwt } = await createUserWithFarm();
    await createDrug(jwt, { name: "Drug1" });
    await createDrug(jwt, { name: "Drug2" });

    const res = await request("GET", "/v1/drugs", undefined, jwt);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { count: number } };
    expect(body.data.count).toBe(2);
  });

  it("updates a drug", async () => {
    const { jwt } = await createUserWithFarm();
    const drug = await createDrug(jwt, { name: "OldDrug" });

    const res = await request(
      "PATCH",
      `/v1/drugs/byId/${drug.id}`,
      { name: "NewDrug", notes: "Handle with care" },
      jwt
    );
    expect(res.status).toBe(200);

    // Verify DB
    const db = getAdminDb();
    const dbDrug = await db.query.drugs.findFirst({
      where: { id: drug.id },
    });
    expect(dbDrug!.name).toBe("NewDrug");
    expect(dbDrug!.notes).toBe("Handle with care");
  });

  it("deletes a drug", async () => {
    const { jwt } = await createUserWithFarm();
    const drug = await createDrug(jwt);

    const res = await request("DELETE", `/v1/drugs/byId/${drug.id}`, undefined, jwt);
    expect(res.status).toBe(200);

    // Verify DB
    const db = getAdminDb();
    const dbDrug = await db.query.drugs.findFirst({
      where: { id: drug.id },
    });
    expect(dbDrug).toBeUndefined();
  });

  it("checks if drug is in use (false when unused)", async () => {
    const { jwt } = await createUserWithFarm();
    const drug = await createDrug(jwt);

    const res = await request("GET", `/v1/drugs/byId/${drug.id}/inUse`, undefined, jwt);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { inUse: boolean } };
    expect(body.data.inUse).toBe(false);
  });
});
