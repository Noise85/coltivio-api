import { describe, it, expect, beforeEach } from "@jest/globals";
import ExcelJS from "exceljs";
import { cleanDb, request } from "./helpers";
import { createAnimal, createDrug, createFarmMember, createTreatment, createUserWithFarm } from "./test-utils";

type WeightResponse = { id: string; animalId: string; date: string; weightKg: number; notes: string | null };
type AnimalDose = { animalId: string; animalWeightKg: number | null; effectiveDoseValue: number | null };

async function addWeight(jwt: string, animalId: string, date: string, weightKg: number) {
  const res = await request("POST", `/v1/animals/byId/${animalId}/weights`, { date, weightKg }, jwt);
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: WeightResponse }).data;
}

async function getTreatmentDoses(jwt: string, treatmentId: string): Promise<AnimalDose[]> {
  const res = await request("GET", `/v1/treatments/byId/${treatmentId}`, undefined, jwt);
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: { animalDoses: AnimalDose[] } }).data.animalDoses;
}

const PER_KG_DOSE = { drugDoseValue: 0.5, drugDoseUnit: "ml", drugDosePerUnit: "kg" };

describe("Animal weights", () => {
  beforeEach(cleanDb);

  it("creates, lists, updates and deletes weight entries", async () => {
    const { jwt } = await createUserWithFarm();
    const animal = await createAnimal(jwt);

    const later = await addWeight(jwt, animal.id, "2025-06-01", 420);
    await addWeight(jwt, animal.id, "2025-01-01", 400);

    const listRes = await request("GET", `/v1/animals/byId/${animal.id}/weights`, undefined, jwt);
    expect(listRes.status).toBe(200);
    const list = ((await listRes.json()) as { data: { result: WeightResponse[] } }).data.result;
    expect(list.map((weight) => weight.weightKg)).toEqual([400, 420]);

    const patchRes = await request("PATCH", `/v1/animals/weights/byId/${later.id}`, { weightKg: 430 }, jwt);
    expect(patchRes.status).toBe(200);
    expect(((await patchRes.json()) as { data: WeightResponse }).data.weightKg).toBe(430);

    const deleteRes = await request("DELETE", `/v1/animals/weights/byId/${later.id}`, undefined, jwt);
    expect(deleteRes.status).toBe(200);
    const afterDelete = await request("GET", `/v1/animals/byId/${animal.id}/weights`, undefined, jwt);
    expect(((await afterDelete.json()) as { data: { result: WeightResponse[] } }).data.result).toHaveLength(1);
  });

  it("rejects non-positive weights", async () => {
    const { jwt } = await createUserWithFarm();
    const animal = await createAnimal(jwt);
    const res = await request(
      "POST",
      `/v1/animals/byId/${animal.id}/weights`,
      { date: "2025-01-01", weightKg: 0 },
      jwt
    );
    expect(res.status).toBe(400);
  });

  it("returns the latest weight on the animal list and detail", async () => {
    const { jwt } = await createUserWithFarm();
    const animal = await createAnimal(jwt);
    const otherAnimal = await createAnimal(jwt, { name: "NoWeight" });
    await addWeight(jwt, animal.id, "2025-01-01", 400);
    await addWeight(jwt, animal.id, "2025-06-01", 420);

    const detailRes = await request("GET", `/v1/animals/byId/${animal.id}`, undefined, jwt);
    const detail = ((await detailRes.json()) as { data: { latestWeight: { weightKg: number } | null } }).data;
    expect(detail.latestWeight?.weightKg).toBe(420);

    const listRes = await request("GET", "/v1/animals", undefined, jwt);
    const list = (
      (await listRes.json()) as { data: { result: { id: string; latestWeight: { weightKg: number } | null }[] } }
    ).data.result;
    expect(list.find((entry) => entry.id === animal.id)?.latestWeight?.weightKg).toBe(420);
    expect(list.find((entry) => entry.id === otherAnimal.id)?.latestWeight).toBeNull();
  });

  it("rejects weights for an animal of another farm", async () => {
    const { jwt: otherJwt } = await createUserWithFarm({}, "other@test.com");
    const otherAnimal = await createAnimal(otherJwt);
    const { jwt } = await createUserWithFarm();
    const res = await request(
      "POST",
      `/v1/animals/byId/${otherAnimal.id}/weights`,
      { date: "2025-01-01", weightKg: 400 },
      jwt
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 when patching or deleting a weight entry of another farm or a missing one", async () => {
    const { jwt: otherJwt } = await createUserWithFarm({}, "other@test.com");
    const otherAnimal = await createAnimal(otherJwt);
    const otherWeight = await addWeight(otherJwt, otherAnimal.id, "2025-01-01", 400);
    const { jwt } = await createUserWithFarm();

    const patchRes = await request("PATCH", `/v1/animals/weights/byId/${otherWeight.id}`, { weightKg: 1 }, jwt);
    expect(patchRes.status).toBe(404);
    const deleteRes = await request("DELETE", `/v1/animals/weights/byId/${otherWeight.id}`, undefined, jwt);
    expect(deleteRes.status).toBe(404);
    const missingRes = await request(
      "DELETE",
      "/v1/animals/weights/byId/00000000-0000-0000-0000-000000000000",
      undefined,
      jwt
    );
    expect(missingRes.status).toBe(404);

    // The other farm's entry is untouched
    const listRes = await request("GET", `/v1/animals/byId/${otherAnimal.id}/weights`, undefined, otherJwt);
    const list = ((await listRes.json()) as { data: { result: WeightResponse[] } }).data.result;
    expect(list.map((weight) => weight.weightKg)).toEqual([400]);
  });

  it("requires animals write access to add weights", async () => {
    const { jwt: ownerJwt } = await createUserWithFarm();
    const animal = await createAnimal(ownerJwt);
    const { jwt: memberJwt } = await createFarmMember(ownerJwt, "reader@test.com", {
      permissions: [{ feature: "animals", access: "read" }],
    });
    const res = await request(
      "POST",
      `/v1/animals/byId/${animal.id}/weights`,
      { date: "2025-01-01", weightKg: 400 },
      memberJwt
    );
    expect(res.status).toBe(403);
  });
});

describe("Treatment effective dose", () => {
  beforeEach(cleanDb);

  it("uses the latest weight on or before the start date for per-kg doses", async () => {
    const { jwt } = await createUserWithFarm();
    const animal = await createAnimal(jwt);
    await addWeight(jwt, animal.id, "2025-01-01", 400);
    await addWeight(jwt, animal.id, "2025-03-01", 450);
    // After the treatment start, must be ignored
    await addWeight(jwt, animal.id, "2025-05-01", 500);

    const treatment = await createTreatment(jwt, [animal.id], {
      ...PER_KG_DOSE,
      startDate: "2025-04-01",
      endDate: "2025-04-03",
    });

    expect(await getTreatmentDoses(jwt, treatment.id)).toEqual([
      { animalId: animal.id, animalWeightKg: 450, effectiveDoseValue: 225 },
    ]);
  });

  it("prefers client weight overrides and stores no effective amount for non per-kg doses", async () => {
    const { jwt } = await createUserWithFarm();
    const animal = await createAnimal(jwt);
    const animalWithoutWeight = await createAnimal(jwt, { name: "Light" });
    await addWeight(jwt, animal.id, "2025-01-01", 400);

    const perKgTreatment = await createTreatment(jwt, [animal.id, animalWithoutWeight.id], {
      ...PER_KG_DOSE,
      animalWeights: [{ animalId: animal.id, weightKg: 380 }],
    });
    const perKgDoses = await getTreatmentDoses(jwt, perKgTreatment.id);
    expect(perKgDoses.find((dose) => dose.animalId === animal.id)).toEqual({
      animalId: animal.id,
      animalWeightKg: 380,
      effectiveDoseValue: 190,
    });
    expect(perKgDoses.find((dose) => dose.animalId === animalWithoutWeight.id)).toEqual({
      animalId: animalWithoutWeight.id,
      animalWeightKg: null,
      effectiveDoseValue: null,
    });

    const perAnimalTreatment = await createTreatment(jwt, [animal.id], {
      drugDoseValue: 10,
      drugDoseUnit: "ml",
      drugDosePerUnit: "animal",
    });
    expect(await getTreatmentDoses(jwt, perAnimalTreatment.id)).toEqual([
      { animalId: animal.id, animalWeightKg: 400, effectiveDoseValue: null },
    ]);
  });

  it("recomputes the effective amount when the dose changes and keeps stored weights", async () => {
    const { jwt } = await createUserWithFarm();
    const animal = await createAnimal(jwt);
    await addWeight(jwt, animal.id, "2024-12-01", 400);
    const treatment = await createTreatment(jwt, [animal.id], PER_KG_DOSE);

    // A newer weight entry before the start date must not replace the stored weight on unrelated edits
    await addWeight(jwt, animal.id, "2024-12-15", 410);
    const patchRes = await request("PATCH", `/v1/treatments/byId/${treatment.id}`, { drugDoseValue: 1 }, jwt);
    expect(patchRes.status).toBe(200);
    expect(await getTreatmentDoses(jwt, treatment.id)).toEqual([
      { animalId: animal.id, animalWeightKg: 400, effectiveDoseValue: 400 },
    ]);

    // Changing the start date looks the weight up again
    const moveRes = await request(
      "PATCH",
      `/v1/treatments/byId/${treatment.id}`,
      { startDate: "2025-01-02", endDate: "2025-01-04" },
      jwt
    );
    expect(moveRes.status).toBe(200);
    expect(await getTreatmentDoses(jwt, treatment.id)).toEqual([
      { animalId: animal.id, animalWeightKg: 410, effectiveDoseValue: 410 },
    ]);
  });

  it("stores effective amounts entered by the user and keeps the animal's weight", async () => {
    const { jwt } = await createUserWithFarm();
    const animal = await createAnimal(jwt);
    await addWeight(jwt, animal.id, "2024-12-01", 400);
    const treatment = await createTreatment(jwt, [animal.id], {
      ...PER_KG_DOSE,
      effectiveDoseOverrides: [{ animalId: animal.id, effectiveDoseValue: 180 }],
    });
    expect(await getTreatmentDoses(jwt, treatment.id)).toEqual([
      { animalId: animal.id, animalWeightKg: 400, effectiveDoseValue: 180 },
    ]);

    // Without an override on edit the amount is computed again from dose and weight
    const patchRes = await request("PATCH", `/v1/treatments/byId/${treatment.id}`, { drugDoseValue: 1 }, jwt);
    expect(patchRes.status).toBe(200);
    expect(await getTreatmentDoses(jwt, treatment.id)).toEqual([
      { animalId: animal.id, animalWeightKg: 400, effectiveDoseValue: 400 },
    ]);

    const overridePatchRes = await request(
      "PATCH",
      `/v1/treatments/byId/${treatment.id}`,
      { effectiveDoseOverrides: [{ animalId: animal.id, effectiveDoseValue: 350 }] },
      jwt
    );
    expect(overridePatchRes.status).toBe(200);
    expect(await getTreatmentDoses(jwt, treatment.id)).toEqual([
      { animalId: animal.id, animalWeightKg: 400, effectiveDoseValue: 350 },
    ]);
  });

  it("keeps amounts entered by hand when an edit doesn't touch the dose", async () => {
    const { jwt } = await createUserWithFarm();
    const animal = await createAnimal(jwt);
    await addWeight(jwt, animal.id, "2024-12-01", 400);
    const treatment = await createTreatment(jwt, [animal.id], {
      ...PER_KG_DOSE,
      effectiveDoseOverrides: [{ animalId: animal.id, effectiveDoseValue: 180 }],
    });
    // Same values as stored, like a client sending the whole form, plus a new name
    const patchRes = await request(
      "PATCH",
      `/v1/treatments/byId/${treatment.id}`,
      { ...PER_KG_DOSE, startDate: "2025-01-01", name: "Renamed" },
      jwt
    );
    expect(patchRes.status).toBe(200);
    expect(await getTreatmentDoses(jwt, treatment.id)).toEqual([
      { animalId: animal.id, animalWeightKg: 400, effectiveDoseValue: 180 },
    ]);
  });

  it("keeps amounts entered by hand on edits from the app that always sends animalIds", async () => {
    const { jwt } = await createUserWithFarm();
    const animal = await createAnimal(jwt);
    const secondAnimal = await createAnimal(jwt);
    await addWeight(jwt, animal.id, "2024-12-01", 400);
    await addWeight(jwt, secondAnimal.id, "2024-12-01", 200);
    const treatment = await createTreatment(jwt, [animal.id], {
      ...PER_KG_DOSE,
      effectiveDoseOverrides: [{ animalId: animal.id, effectiveDoseValue: 180 }],
    });
    // Full form payload of app 1.0.9: unchanged animalIds, no effectiveDoseOverrides
    const oldAppPayload = {
      name: "Renamed",
      startDate: "2025-01-01",
      endDate: "2025-01-03",
      ...PER_KG_DOSE,
      animalIds: [animal.id],
    };
    const patchRes = await request("PATCH", `/v1/treatments/byId/${treatment.id}`, oldAppPayload, jwt);
    expect(patchRes.status).toBe(200);
    expect(await getTreatmentDoses(jwt, treatment.id)).toEqual([
      { animalId: animal.id, animalWeightKg: 400, effectiveDoseValue: 180 },
    ]);

    // Adding an animal computes its amount and still keeps the one entered by hand
    const addAnimalRes = await request(
      "PATCH",
      `/v1/treatments/byId/${treatment.id}`,
      { ...oldAppPayload, animalIds: [animal.id, secondAnimal.id] },
      jwt
    );
    expect(addAnimalRes.status).toBe(200);
    const doses = await getTreatmentDoses(jwt, treatment.id);
    expect(doses).toHaveLength(2);
    expect(doses).toEqual(
      expect.arrayContaining([
        { animalId: animal.id, animalWeightKg: 400, effectiveDoseValue: 180 },
        { animalId: secondAnimal.id, animalWeightKg: 200, effectiveDoseValue: 100 },
      ])
    );

    // Removing the second animal again leaves the first untouched
    const removeAnimalRes = await request("PATCH", `/v1/treatments/byId/${treatment.id}`, oldAppPayload, jwt);
    expect(removeAnimalRes.status).toBe(200);
    expect(await getTreatmentDoses(jwt, treatment.id)).toEqual([
      { animalId: animal.id, animalWeightKg: 400, effectiveDoseValue: 180 },
    ]);
  });

  it("accepts a PATCH with only weight overrides and keeps unrelated fields", async () => {
    const { jwt } = await createUserWithFarm();
    const animal = await createAnimal(jwt);
    const treatment = await createTreatment(jwt, [animal.id], { ...PER_KG_DOSE, isAntibiotic: true });

    const patchRes = await request(
      "PATCH",
      `/v1/treatments/byId/${treatment.id}`,
      { animalWeights: [{ animalId: animal.id, weightKg: 300 }] },
      jwt
    );
    expect(patchRes.status).toBe(200);
    expect(((await patchRes.json()) as { data: { isAntibiotic: boolean } }).data.isAntibiotic).toBe(true);
    expect(await getTreatmentDoses(jwt, treatment.id)).toEqual([
      { animalId: animal.id, animalWeightKg: 300, effectiveDoseValue: 150 },
    ]);
  });

  it("returns 404 when patching a missing treatment", async () => {
    const { jwt } = await createUserWithFarm();
    const res = await request(
      "PATCH",
      "/v1/treatments/byId/00000000-0000-0000-0000-000000000000",
      { name: "Missing" },
      jwt
    );
    expect(res.status).toBe(404);
  });

  it("auto-calculated drug treatments still work and get an effective amount", async () => {
    const { jwt } = await createUserWithFarm();
    const animal = await createAnimal(jwt);
    await addWeight(jwt, animal.id, "2024-12-01", 400);
    const drug = await createDrug(jwt);
    const treatment = await createTreatment(jwt, [animal.id], {
      drugId: drug.id,
      drugDoseValue: 5,
      drugDoseUnit: "ml",
      drugDosePerUnit: "kg",
    });
    expect(await getTreatmentDoses(jwt, treatment.id)).toEqual([
      { animalId: animal.id, animalWeightKg: 400, effectiveDoseValue: 2000 },
    ]);
  });

  it("shows weight and effective amount in the treatment report", async () => {
    const { jwt } = await createUserWithFarm();
    const animal = await createAnimal(jwt, { name: "ReportCow" });
    await addWeight(jwt, animal.id, "2024-12-01", 400);
    await createTreatment(jwt, [animal.id], { ...PER_KG_DOSE, startDate: "2025-03-01", endDate: "2025-03-05" });

    const res = await request(
      "POST",
      "/v1/reports/treatments/download",
      { fromDate: "2025-01-01", toDate: "2025-12-31" },
      jwt
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { base64: string } };
    const workbook = new ExcelJS.Workbook();
    const reportBytes = Buffer.from(body.data.base64, "base64");
    await workbook.xlsx.load(
      reportBytes.buffer.slice(reportBytes.byteOffset, reportBytes.byteOffset + reportBytes.byteLength)
    );
    const sheet = workbook.worksheets[0];
    const headerTexts: string[] = [];
    let dataRow: ExcelJS.Row | undefined;
    sheet.eachRow((row) => {
      row.eachCell((cell) => headerTexts.push(String(cell.value)));
      if (String(row.getCell(3).value).includes("ReportCow")) dataRow = row;
    });
    expect(headerTexts).toContain("Gewicht (kg)");
    expect(headerTexts).toContain("Effektive Menge");
    expect(dataRow?.getCell(7).value).toBe(400);
    expect(String(dataRow?.getCell(8).value)).toMatch(/^200 /);
  });
});
