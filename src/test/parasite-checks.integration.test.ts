import { describe, it, expect, beforeEach } from "@jest/globals";

import { cleanDb, getAdminDb, request } from "./helpers";
import { createUserWithFarm, createAnimal, createTreatment } from "./test-utils";

type CheckResponse = {
  id: string;
  name: string | null;
  animalType: string | null;
  method: string;
  previousCheckId: string | null;
  treatmentId: string | null;
  animals: Array<{ animalId: string; famachaScore: number | null }>;
  fecSamples: Array<{
    id: string;
    pooled: boolean;
    animalIds: string[];
    results: Array<{ parasiteType: string; countPerGram: number | null; grade: string | null }>;
  }>;
  followUpTasks: Array<{ id: string; name: string; dueDate: string | null }>;
  summary: {
    animalCount: number;
    famachaAverage: number | null;
    famachaDistribution: Array<{ score: number; count: number }>;
    fecByParasite: Array<{ parasiteType: string; avgCountPerGram: number; sampleCount: number }>;
    gradesByParasite: Array<{ parasiteType: string; sampleCount: number; highestGrade: string; averageGrade: number }>;
  };
  comparisonToPrevious: {
    previousCheckId: string;
    famachaBeforeAverage: number | null;
    famachaAfterAverage: number | null;
    famachaAverageChange: number | null;
    fecReduction: Array<{ parasiteType: string; afterSampleCount: number; reductionPercent: number | null }>;
  } | null;
};

async function createCheck(jwt: string, payload: Record<string, unknown>) {
  const res = await request("POST", "/v1/parasiteChecks", payload, jwt);
  return { status: res.status, body: (await res.json()) as { data: CheckResponse } };
}

describe("Parasite checks", () => {
  beforeEach(cleanDb);

  it("rejects a check with mixed animal types", async () => {
    const { jwt } = await createUserWithFarm();
    const sheep = await createAnimal(jwt, { name: "Sheep1", type: "sheep" });
    const goat = await createAnimal(jwt, { name: "Goat1", type: "goat" });

    const { status } = await createCheck(jwt, {
      date: "2025-06-01",
      method: "famacha",
      animals: [{ animalId: sheep.id }, { animalId: goat.id }],
    });
    expect(status).toBe(400);
  });

  it("creates a FAMACHA check with scores", async () => {
    const { jwt } = await createUserWithFarm();
    const a1 = await createAnimal(jwt, { name: "Goat1", type: "goat" });
    const a2 = await createAnimal(jwt, { name: "Goat2", type: "goat" });

    const { status, body } = await createCheck(jwt, {
      date: "2025-06-01",
      name: "Frühjahrskontrolle",
      method: "famacha",
      animals: [
        { animalId: a1.id, famachaScore: 2 },
        { animalId: a2.id, famachaScore: 4 },
      ],
    });
    expect(status).toBe(200);
    expect(body.data.name).toBe("Frühjahrskontrolle");
    expect(body.data.animalType).toBe("goat");
    expect(body.data.summary.famachaAverage).toBe(3);
    expect(body.data.summary.famachaDistribution.find((entry) => entry.score === 4)!.count).toBe(1);

    const listRes = await request("GET", "/v1/parasiteChecks", undefined, jwt);
    const listBody = (await listRes.json()) as { data: { count: number } };
    expect(listBody.data.count).toBe(1);

    const historyRes = await request("GET", `/v1/animals/byId/${a2.id}/parasiteHistory`, undefined, jwt);
    expect(historyRes.status).toBe(200);
    const historyBody = (await historyRes.json()) as { data: { checks: Array<{ famachaScore: number | null }> } };
    expect(historyBody.data.checks).toHaveLength(1);
    expect(historyBody.data.checks[0].famachaScore).toBe(4);
  });

  it("dedupes animals given twice", async () => {
    const { jwt } = await createUserWithFarm();
    const a1 = await createAnimal(jwt, { name: "S1", type: "sheep" });
    const a2 = await createAnimal(jwt, { name: "S2", type: "sheep" });

    const famacha = await createCheck(jwt, {
      date: "2025-06-01",
      method: "famacha",
      animals: [{ animalId: a1.id, famachaScore: 3 }, { animalId: a1.id }],
    });
    expect(famacha.status).toBe(200);
    expect(famacha.body.data.animals).toHaveLength(1);
    expect(famacha.body.data.animals[0].famachaScore).toBe(3);

    const fec = await createCheck(jwt, {
      date: "2025-06-01",
      method: "fecal_egg_count",
      animals: [{ animalId: a1.id }, { animalId: a2.id }],
      fecSamples: [{ animalIds: [a1.id, a1.id], results: [{ parasiteType: "strongyles", countPerGram: 100 }] }],
    });
    expect(fec.status).toBe(200);
    expect(fec.body.data.fecSamples[0].animalIds).toEqual([a1.id]);
    expect(fec.body.data.fecSamples[0].pooled).toBe(false);

    const duplicateParasite = await createCheck(jwt, {
      date: "2025-06-01",
      method: "fecal_egg_count",
      animals: [{ animalId: a1.id }, { animalId: a2.id }],
      fecSamples: [
        {
          animalIds: [a1.id],
          results: [
            { parasiteType: "strongyles", countPerGram: 100 },
            { parasiteType: "strongyles", countPerGram: 200 },
          ],
        },
      ],
    });
    expect(duplicateParasite.status).toBe(400);
  });

  it("rejects a check without animals", async () => {
    const { jwt } = await createUserWithFarm();
    const { status } = await createCheck(jwt, { date: "2025-06-01", method: "famacha" });
    expect(status).toBe(400);
  });

  it("creates a fecal egg count check with individual and pooled samples", async () => {
    const { jwt } = await createUserWithFarm();
    const a1 = await createAnimal(jwt, { name: "S1", type: "sheep" });
    const a2 = await createAnimal(jwt, { name: "S2", type: "sheep" });
    const a3 = await createAnimal(jwt, { name: "S3", type: "sheep" });

    const { status, body } = await createCheck(jwt, {
      date: "2025-06-01",
      method: "fecal_egg_count",
      labName: "Vet Lab",
      animals: [{ animalId: a1.id }, { animalId: a2.id }, { animalId: a3.id }],
      fecSamples: [
        { label: "Ind-1", animalIds: [a1.id], results: [{ parasiteType: "strongyles", countPerGram: 800 }] },
        {
          label: "Pool-1",
          animalIds: [a2.id, a3.id],
          results: [
            { parasiteType: "strongyles", countPerGram: 400 },
            { parasiteType: "coccidia", countPerGram: 150 },
          ],
        },
      ],
    });
    expect(status).toBe(200);
    expect(body.data.fecSamples).toHaveLength(2);
    expect(body.data.fecSamples.find((sample) => sample.pooled)!.animalIds).toHaveLength(2);
    const strongyles = body.data.summary.fecByParasite.find((entry) => entry.parasiteType === "strongyles")!;
    expect(strongyles.sampleCount).toBe(2);
    expect(strongyles.avgCountPerGram).toBe(600);

    const historyRes = await request("GET", `/v1/animals/byId/${a3.id}/parasiteHistory`, undefined, jwt);
    const historyBody = (await historyRes.json()) as {
      data: { fecResults: Array<{ pooled: boolean; poolSize: number; results: Array<{ parasiteType: string }> }> };
    };
    expect(historyBody.data.fecResults).toHaveLength(1);
    expect(historyBody.data.fecResults[0].pooled).toBe(true);
    expect(historyBody.data.fecResults[0].poolSize).toBe(2);
  });

  it("validates check consistency", async () => {
    const { jwt } = await createUserWithFarm();
    const a1 = await createAnimal(jwt, { name: "S1", type: "sheep" });
    const a2 = await createAnimal(jwt, { name: "S2", type: "sheep" });

    // Sample animal not part of the check
    const foreignSample = await createCheck(jwt, {
      date: "2025-06-01",
      method: "fecal_egg_count",
      animals: [{ animalId: a1.id }],
      fecSamples: [{ animalIds: [a2.id], results: [{ parasiteType: "strongyles", countPerGram: 100 }] }],
    });
    expect(foreignSample.status).toBe(400);

    // Same animal in two samples
    const animalInTwoSamples = await createCheck(jwt, {
      date: "2025-06-01",
      method: "fecal_egg_count",
      animals: [{ animalId: a1.id }, { animalId: a2.id }],
      fecSamples: [
        { animalIds: [a1.id, a2.id], results: [{ parasiteType: "strongyles", countPerGram: 100 }] },
        { animalIds: [a1.id], results: [{ parasiteType: "strongyles", countPerGram: 200 }] },
      ],
    });
    expect(animalInTwoSamples.status).toBe(400);

    // FAMACHA score on a fecal egg count check
    const scoreOnFec = await createCheck(jwt, {
      date: "2025-06-01",
      method: "fecal_egg_count",
      animals: [{ animalId: a1.id, famachaScore: 3 }],
    });
    expect(scoreOnFec.status).toBe(400);

    // Score out of range
    const outOfRange = await createCheck(jwt, {
      date: "2025-06-01",
      method: "famacha",
      animals: [{ animalId: a1.id, famachaScore: 6 }],
    });
    expect(outOfRange.status).toBe(400);

    // Nothing was persisted
    const db = getAdminDb();
    const checks = await db.query.parasiteChecks.findMany();
    expect(checks).toHaveLength(0);
  });

  it("creates a follow-up task only when requested", async () => {
    const { jwt } = await createUserWithFarm();
    const a1 = await createAnimal(jwt, { name: "S1", type: "sheep" });

    const { status, body } = await createCheck(jwt, {
      date: "2025-06-01",
      method: "famacha",
      animals: [{ animalId: a1.id }],
      followUp: { dueDate: "2025-06-15" },
    });
    expect(status).toBe(200);
    expect(body.data.followUpTasks).toHaveLength(1);
    expect(body.data.followUpTasks[0].dueDate).toMatch(/^2025-06-15/);

    const db = getAdminDb();
    const links = await db.query.taskLinks.findMany({ where: { taskId: body.data.followUpTasks[0].id } });
    expect(links.map((link) => link.linkType)).toEqual(["parasite_check"]);

    const taskRes = await request("GET", `/v1/tasks/byId/${body.data.followUpTasks[0].id}`, undefined, jwt);
    expect(taskRes.status).toBe(200);
    const taskBody = (await taskRes.json()) as {
      data: { links: Array<{ linkType: string; displayName: string | null }> };
    };
    const checkLink = taskBody.data.links.find((link) => link.linkType === "parasite_check")!;
    expect(checkLink.displayName).toBe("FAMACHA · 2025-06-01");

    await createCheck(jwt, { date: "2025-07-01", method: "famacha", animals: [{ animalId: a1.id }] });
    const tasks = await db.query.tasks.findMany();
    expect(tasks).toHaveLength(1);
  });

  it("links a treatment and computes reduction on re-check", async () => {
    const { jwt } = await createUserWithFarm();
    const a1 = await createAnimal(jwt, { name: "S1", type: "sheep" });
    const a2 = await createAnimal(jwt, { name: "S2", type: "sheep" });
    const treatment = await createTreatment(jwt, [a1.id, a2.id], { name: "Dewormer" });

    const before = await createCheck(jwt, {
      date: "2025-06-01",
      method: "fecal_egg_count",
      animals: [{ animalId: a1.id }, { animalId: a2.id }],
      treatmentId: treatment.id,
      fecSamples: [{ animalIds: [a1.id, a2.id], results: [{ parasiteType: "strongyles", countPerGram: 1000 }] }],
    });
    expect(before.status).toBe(200);
    expect(before.body.data.treatmentId).toBe(treatment.id);

    const after = await createCheck(jwt, {
      date: "2025-06-15",
      method: "fecal_egg_count",
      animals: [{ animalId: a1.id }, { animalId: a2.id }],
      previousCheckId: before.body.data.id,
      fecSamples: [{ animalIds: [a1.id, a2.id], results: [{ parasiteType: "strongyles", countPerGram: 50 }] }],
    });
    expect(after.status).toBe(200);
    expect(after.body.data.comparisonToPrevious!.previousCheckId).toBe(before.body.data.id);
    expect(after.body.data.comparisonToPrevious!.fecReduction[0].reductionPercent).toBeCloseTo(95);

    // The original check lists its re-checks with the reduction against it
    const beforeRes = await request("GET", `/v1/parasiteChecks/byId/${before.body.data.id}`, undefined, jwt);
    const beforeBody = (await beforeRes.json()) as {
      data: { rechecks: Array<{ id: string; fecReduction: Array<{ reductionPercent: number | null }> }> };
    };
    expect(beforeBody.data.rechecks).toHaveLength(1);
    expect(beforeBody.data.rechecks[0].id).toBe(after.body.data.id);
    expect(beforeBody.data.rechecks[0].fecReduction[0].reductionPercent).toBeCloseTo(95);

    // Re-checks are not chained: a re-check of a re-check is rejected
    const chained = await createCheck(jwt, {
      date: "2025-07-01",
      method: "fecal_egg_count",
      animals: [{ animalId: a1.id }],
      previousCheckId: after.body.data.id,
    });
    expect(chained.status).toBe(400);

    // A base check with re-checks cannot become a re-check itself
    const other = await createCheck(jwt, {
      date: "2025-05-01",
      method: "fecal_egg_count",
      animals: [{ animalId: a1.id }],
    });
    const baseToRecheck = await request(
      "PATCH",
      `/v1/parasiteChecks/byId/${before.body.data.id}`,
      { previousCheckId: other.body.data.id },
      jwt
    );
    expect(baseToRecheck.status).toBe(400);

    // A re-check repeats the base measurement: same method, only base animals
    const otherMethod = await createCheck(jwt, {
      date: "2025-06-20",
      method: "famacha",
      animals: [{ animalId: a1.id }],
      previousCheckId: before.body.data.id,
    });
    expect(otherMethod.status).toBe(400);
    const newcomer = await createAnimal(jwt, { name: "Newcomer", type: "sheep" });
    const foreignAnimal = await createCheck(jwt, {
      date: "2025-06-20",
      method: "fecal_egg_count",
      animals: [{ animalId: a1.id }, { animalId: newcomer.id }],
      previousCheckId: before.body.data.id,
    });
    expect(foreignAnimal.status).toBe(400);
    const subset = await createCheck(jwt, {
      date: "2025-06-20",
      method: "fecal_egg_count",
      animals: [{ animalId: a1.id }],
      previousCheckId: before.body.data.id,
    });
    expect(subset.status).toBe(200);

    // The list includes re-checks: the one from 06-15 and the subset from 06-20
    const listRes = await request("GET", "/v1/parasiteChecks?from=2025-06-10", undefined, jwt);
    const listBody = (await listRes.json()) as { data: { count: number } };
    expect(listBody.data.count).toBe(2);

    // Animal history includes the linked treatment, but not unrelated ones
    const unrelatedTreatment = await createTreatment(jwt, [a1.id], { name: "Antibiotic" });
    const historyRes = await request("GET", `/v1/animals/byId/${a1.id}/parasiteHistory`, undefined, jwt);
    const historyBody = (await historyRes.json()) as { data: { treatments: Array<{ id: string }> } };
    const historyTreatmentIds = historyBody.data.treatments.map((entry) => entry.id);
    expect(historyTreatmentIds).toContain(treatment.id);
    expect(historyTreatmentIds).not.toContain(unrelatedTreatment.id);
  });

  it("updates and deletes a check", async () => {
    const { jwt } = await createUserWithFarm();
    const a1 = await createAnimal(jwt, { name: "S1", type: "sheep" });
    const a2 = await createAnimal(jwt, { name: "S2", type: "sheep" });
    const { body } = await createCheck(jwt, {
      date: "2025-06-01",
      method: "famacha",
      animals: [{ animalId: a1.id, famachaScore: 2 }],
    });

    const patchRes = await request(
      "PATCH",
      `/v1/parasiteChecks/byId/${body.data.id}`,
      {
        notes: "Rainy season",
        animals: [
          { animalId: a1.id, famachaScore: 3 },
          { animalId: a2.id, famachaScore: 5 },
        ],
      },
      jwt
    );
    expect(patchRes.status).toBe(200);
    const patchBody = (await patchRes.json()) as { data: CheckResponse & { notes: string | null } };
    expect(patchBody.data.notes).toBe("Rainy season");
    expect(patchBody.data.summary.famachaAverage).toBe(4);

    const deleteRes = await request("DELETE", `/v1/parasiteChecks/byId/${body.data.id}`, undefined, jwt);
    expect(deleteRes.status).toBe(200);
    const getRes = await request("GET", `/v1/parasiteChecks/byId/${body.data.id}`, undefined, jwt);
    expect(getRes.status).toBe(404);
  });

  it("denies cross-farm access", async () => {
    const owner = await createUserWithFarm({}, "owner@test.com");
    const other = await createUserWithFarm({ name: "Other Farm" }, "other@test.com");
    const ownerAnimal = await createAnimal(owner.jwt, { name: "Mine", type: "sheep" });
    const { body } = await createCheck(owner.jwt, {
      date: "2025-06-01",
      method: "famacha",
      animals: [{ animalId: ownerAnimal.id, famachaScore: 1 }],
    });

    const getRes = await request("GET", `/v1/parasiteChecks/byId/${body.data.id}`, undefined, other.jwt);
    expect(getRes.status).toBe(404);

    const deleteRes = await request("DELETE", `/v1/parasiteChecks/byId/${body.data.id}`, undefined, other.jwt);
    expect(deleteRes.status).toBe(404);

    // Referencing another farm's animal is rejected
    const foreignAnimal = await createCheck(other.jwt, {
      date: "2025-06-01",
      method: "famacha",
      animals: [{ animalId: ownerAnimal.id }],
    });
    expect(foreignAnimal.status).toBe(404);

    const historyRes = await request("GET", `/v1/animals/byId/${ownerAnimal.id}/parasiteHistory`, undefined, other.jwt);
    expect(historyRes.status).toBe(404);
  });
});

describe("Parasite re-check rules", () => {
  beforeEach(cleanDb);

  async function setupFecBase() {
    const { jwt, userId } = await createUserWithFarm();
    const a1 = await createAnimal(jwt, { name: "S1", type: "sheep" });
    const a2 = await createAnimal(jwt, { name: "S2", type: "sheep" });
    const base = await createCheck(jwt, {
      date: "2025-06-01",
      method: "fecal_egg_count",
      animals: [{ animalId: a1.id }, { animalId: a2.id }],
      fecSamples: [
        { animalIds: [a1.id], results: [{ parasiteType: "strongyles", countPerGram: 1000 }] },
        { animalIds: [a2.id], results: [{ parasiteType: "strongyles", countPerGram: 500 }] },
      ],
    });
    expect(base.status).toBe(200);
    return { jwt, userId, a1, a2, base: base.body.data };
  }

  it("deletes re-checks together with their base check", async () => {
    const { jwt, a1, base } = await setupFecBase();
    const recheck = await createCheck(jwt, {
      date: "2025-06-15",
      method: "fecal_egg_count",
      animals: [{ animalId: a1.id }],
      previousCheckId: base.id,
    });
    expect(recheck.status).toBe(200);

    const deleteRes = await request("DELETE", `/v1/parasiteChecks/byId/${base.id}`, undefined, jwt);
    expect(deleteRes.status).toBe(200);
    const db = getAdminDb();
    expect(await db.query.parasiteChecks.findMany()).toHaveLength(0);
  });

  it("locks method and animals of a base check with re-checks and enforces dates", async () => {
    const { jwt, a1, a2, base } = await setupFecBase();
    const recheck = await createCheck(jwt, {
      date: "2025-06-15",
      method: "fecal_egg_count",
      animals: [{ animalId: a1.id }],
      previousCheckId: base.id,
    });
    expect(recheck.status).toBe(200);

    const patch = (body: Record<string, unknown>) => request("PATCH", `/v1/parasiteChecks/byId/${base.id}`, body, jwt);
    expect((await patch({ method: "famacha" })).status).toBe(400);
    expect((await patch({ animals: [{ animalId: a2.id }] })).status).toBe(400);
    expect((await patch({ date: "2025-06-20" })).status).toBe(400);
    // Results and notes stay editable
    expect((await patch({ notes: "corrected", date: "2025-05-30" })).status).toBe(200);

    // A re-check cannot be dated before its base check
    const tooEarly = await createCheck(jwt, {
      date: "2025-05-01",
      method: "fecal_egg_count",
      animals: [{ animalId: a1.id }],
      previousCheckId: base.id,
    });
    expect(tooEarly.status).toBe(400);
  });

  it("computes the reduction on the same animals only", async () => {
    const { jwt, a1, base } = await setupFecBase();
    // Only a1 re-checked: compared against a1's 1000, not the base average of 750
    const recheck = await createCheck(jwt, {
      date: "2025-06-15",
      method: "fecal_egg_count",
      animals: [{ animalId: a1.id }],
      fecSamples: [{ animalIds: [a1.id], results: [{ parasiteType: "strongyles", countPerGram: 50 }] }],
      previousCheckId: base.id,
    });
    expect(recheck.status).toBe(200);
    const reduction = recheck.body.data.comparisonToPrevious!.fecReduction[0];
    expect(reduction.reductionPercent).toBeCloseTo(95);
  });

  it("returns no reduction percent when pooled and individual samples are mixed", async () => {
    const { jwt, a1, a2, base } = await setupFecBase();
    const recheck = await createCheck(jwt, {
      date: "2025-06-15",
      method: "fecal_egg_count",
      animals: [{ animalId: a1.id }, { animalId: a2.id }],
      fecSamples: [{ animalIds: [a1.id, a2.id], results: [{ parasiteType: "strongyles", countPerGram: 50 }] }],
      previousCheckId: base.id,
    });
    expect(recheck.status).toBe(200);
    expect(recheck.body.data.comparisonToPrevious!.fecReduction[0].reductionPercent).toBeNull();
  });

  it("filters the list by animal", async () => {
    const { jwt, a1, a2 } = await setupFecBase();
    await createCheck(jwt, { date: "2025-07-01", method: "famacha", animals: [{ animalId: a2.id }] });

    const res = await request("GET", `/v1/parasiteChecks?animalId=${a1.id}`, undefined, jwt);
    const body = (await res.json()) as { data: { count: number } };
    expect(body.data.count).toBe(1);
  });

  it("rejects treatments, previous checks and assignees of another farm", async () => {
    const owner = await setupFecBase();
    const other = await createUserWithFarm({ name: "Other Farm" }, "other@test.com");
    const otherAnimal = await createAnimal(other.jwt, { name: "Theirs", type: "sheep" });
    const otherTreatment = await createTreatment(other.jwt, [otherAnimal.id], { name: "Their treatment" });

    const foreignTreatment = await createCheck(owner.jwt, {
      date: "2025-07-01",
      method: "famacha",
      animals: [{ animalId: owner.a1.id }],
      treatmentId: otherTreatment.id,
    });
    expect(foreignTreatment.status).toBe(404);

    const foreignPrevious = await createCheck(other.jwt, {
      date: "2025-07-01",
      method: "fecal_egg_count",
      animals: [{ animalId: otherAnimal.id }],
      previousCheckId: owner.base.id,
    });
    expect(foreignPrevious.status).toBe(404);

    const foreignAssignee = await createCheck(owner.jwt, {
      date: "2025-07-01",
      method: "famacha",
      animals: [{ animalId: owner.a1.id }],
      followUp: { dueDate: "2025-07-15", assigneeId: other.userId },
    });
    expect(foreignAssignee.status).toBe(404);
  });

  it("compares pooled samples only when they contain the same animals", async () => {
    const { jwt } = await createUserWithFarm();
    const [a1, a2, a3, a4] = await Promise.all(
      ["P1", "P2", "P3", "P4"].map((name) => createAnimal(jwt, { name, type: "sheep" }))
    );
    const base = await createCheck(jwt, {
      date: "2025-06-01",
      method: "fecal_egg_count",
      animals: [a1, a2, a3, a4].map((animal) => ({ animalId: animal.id })),
      fecSamples: [
        { animalIds: [a1.id, a2.id], results: [{ parasiteType: "strongyles", countPerGram: 1000 }] },
        { animalIds: [a3.id, a4.id], results: [{ parasiteType: "strongyles", countPerGram: 200 }] },
      ],
    });
    expect(base.status).toBe(200);

    // Same pool a1+a2: compared with its own 1000, not the base average of 600
    const samePool = await createCheck(jwt, {
      date: "2025-06-15",
      method: "fecal_egg_count",
      animals: [{ animalId: a1.id }, { animalId: a2.id }],
      fecSamples: [{ animalIds: [a2.id, a1.id], results: [{ parasiteType: "strongyles", countPerGram: 900 }] }],
      previousCheckId: base.body.data.id,
    });
    expect(samePool.status).toBe(200);
    const samePoolReduction = samePool.body.data.comparisonToPrevious!.fecReduction[0];
    expect(samePoolReduction.reductionPercent).toBeCloseTo(10);

    // Pool a1+a3 matches no base pool: no percent
    const otherPool = await createCheck(jwt, {
      date: "2025-06-16",
      method: "fecal_egg_count",
      animals: [{ animalId: a1.id }, { animalId: a3.id }],
      fecSamples: [{ animalIds: [a1.id, a3.id], results: [{ parasiteType: "strongyles", countPerGram: 100 }] }],
      previousCheckId: base.body.data.id,
    });
    expect(otherPool.status).toBe(200);
    expect(otherPool.body.data.comparisonToPrevious!.fecReduction[0].reductionPercent).toBeNull();
  });

  it("compares FAMACHA scores on the animals scored in both checks", async () => {
    const { jwt } = await createUserWithFarm();
    const a1 = await createAnimal(jwt, { name: "F1", type: "goat" });
    const a2 = await createAnimal(jwt, { name: "F2", type: "goat" });
    const base = await createCheck(jwt, {
      date: "2025-06-01",
      method: "famacha",
      animals: [
        { animalId: a1.id, famachaScore: 4 },
        { animalId: a2.id, famachaScore: 2 },
      ],
    });
    // Only a1 re-scored: compared with a1's 4, not the base average of 3
    const recheck = await createCheck(jwt, {
      date: "2025-06-15",
      method: "famacha",
      animals: [{ animalId: a1.id, famachaScore: 2 }, { animalId: a2.id }],
      previousCheckId: base.body.data.id,
    });
    expect(recheck.status).toBe(200);
    const comparison = recheck.body.data.comparisonToPrevious!;
    expect(comparison.famachaBeforeAverage).toBe(4);
    expect(comparison.famachaAfterAverage).toBe(2);
    expect(comparison.famachaAverageChange).toBe(-2);
  });

  it("rejects moving a re-check before its base check", async () => {
    const { jwt, a1, base } = await setupFecBase();
    const recheck = await createCheck(jwt, {
      date: "2025-06-15",
      method: "fecal_egg_count",
      animals: [{ animalId: a1.id }],
      previousCheckId: base.id,
    });
    const moveRes = await request(
      "PATCH",
      `/v1/parasiteChecks/byId/${recheck.body.data.id}`,
      { date: "2025-05-01" },
      jwt
    );
    expect(moveRes.status).toBe(400);
  });

  it("stores an empty name as null, removes task links on delete and keeps empty checks editable", async () => {
    const { jwt, a1, base } = await setupFecBase();

    const renamed = await request("PATCH", `/v1/parasiteChecks/byId/${base.id}`, { name: "  " }, jwt);
    const renamedBody = (await renamed.json()) as { data: CheckResponse };
    expect(renamedBody.data.name).toBeNull();

    // A check whose animals were all deleted stays editable; a blank name is no name on create too
    const lonely = await createCheck(jwt, {
      date: "2025-07-01",
      name: "  ",
      method: "famacha",
      animals: [{ animalId: a1.id }],
      followUp: { dueDate: "2025-07-15" },
    });
    expect(lonely.body.data.name).toBeNull();
    const deleteAnimalRes = await request("DELETE", `/v1/animals/byId/${a1.id}`, undefined, jwt);
    expect(deleteAnimalRes.status).toBe(200);
    const notesRes = await request(
      "PATCH",
      `/v1/parasiteChecks/byId/${lonely.body.data.id}`,
      { notes: "animal sold" },
      jwt
    );
    expect(notesRes.status).toBe(200);

    // Deleting the check removes its follow-up task link
    await request("DELETE", `/v1/parasiteChecks/byId/${lonely.body.data.id}`, undefined, jwt);
    const db = getAdminDb();
    const links = await db.query.taskLinks.findMany({ where: { linkType: "parasite_check" } });
    expect(links).toHaveLength(0);
  });

  it("stores graded results next to counts and keeps them out of averages", async () => {
    const { jwt } = await createUserWithFarm();
    const a1 = await createAnimal(jwt, { name: "G1", type: "goat" });
    const a2 = await createAnimal(jwt, { name: "G2", type: "goat" });
    const a3 = await createAnimal(jwt, { name: "G3", type: "goat" });
    const animals = [{ animalId: a1.id }, { animalId: a2.id }];

    const graded = await createCheck(jwt, {
      date: "2025-06-01",
      method: "fecal_egg_count",
      animals,
      fecSamples: [
        {
          animalIds: [a1.id, a2.id],
          results: [
            { parasiteType: "strongyles", countPerGram: 150 },
            { parasiteType: "capillaria", countPerGram: 0 },
            { parasiteType: "coccidia", grade: "low" },
            { parasiteType: "lungworm", grade: "high" },
          ],
        },
      ],
    });
    expect(graded.status).toBe(200);
    const summary = graded.body.data.summary;
    expect(summary.fecByParasite.map((entry) => entry.parasiteType).sort()).toEqual(["capillaria", "strongyles"]);
    expect(summary.gradesByParasite.find((entry) => entry.parasiteType === "lungworm")!.highestGrade).toBe("high");

    // Average grade per sample like the counts: pooled "high" (3) + individual "negative" (0) = 1.5
    const perSample = await createCheck(jwt, {
      date: "2025-06-03",
      method: "fecal_egg_count",
      animals: [...animals, { animalId: a3.id }],
      fecSamples: [
        { animalIds: [a1.id, a2.id], results: [{ parasiteType: "coccidia", grade: "high" }] },
        { animalIds: [a3.id], results: [{ parasiteType: "coccidia", grade: "negative" }] },
      ],
    });
    expect(perSample.status).toBe(200);
    const coccidia = perSample.body.data.summary.gradesByParasite.find((entry) => entry.parasiteType === "coccidia")!;
    expect(coccidia.highestGrade).toBe("high");
    expect(coccidia.averageGrade).toBeCloseTo(1.5);

    // A result needs exactly one of count and grade
    const neither = await createCheck(jwt, {
      date: "2025-06-02",
      method: "fecal_egg_count",
      animals,
      fecSamples: [{ animalIds: [a1.id], results: [{ parasiteType: "coccidia" }] }],
    });
    expect(neither.status).toBe(400);
    const both = await createCheck(jwt, {
      date: "2025-06-02",
      method: "fecal_egg_count",
      animals,
      fecSamples: [{ animalIds: [a1.id], results: [{ parasiteType: "coccidia", countPerGram: 10, grade: "low" }] }],
    });
    expect(both.status).toBe(400);
  });

  it("updates results from counts to grades and returns grades in the animal history", async () => {
    const { jwt, a1, a2, base } = await setupFecBase();

    const patchRes = await request(
      "PATCH",
      `/v1/parasiteChecks/byId/${base.id}`,
      {
        fecSamples: [
          { animalIds: [a1.id], results: [{ parasiteType: "strongyles", grade: "medium" }] },
          { animalIds: [a2.id], results: [{ parasiteType: "strongyles", grade: "low" }] },
        ],
      },
      jwt
    );
    expect(patchRes.status).toBe(200);
    const patchBody = (await patchRes.json()) as { data: CheckResponse };
    const results = patchBody.data.fecSamples.flatMap((sample) => sample.results);
    expect(results.map((result) => result.countPerGram)).toEqual([null, null]);
    expect(results.map((result) => result.grade).sort()).toEqual(["low", "medium"]);
    expect(patchBody.data.summary.fecByParasite).toHaveLength(0);
    const strongyles = patchBody.data.summary.gradesByParasite.find((entry) => entry.parasiteType === "strongyles")!;
    expect(strongyles.sampleCount).toBe(2);
    expect(strongyles.highestGrade).toBe("medium");
    expect(strongyles.averageGrade).toBeCloseTo(1.5);

    const historyRes = await request("GET", `/v1/animals/byId/${a1.id}/parasiteHistory`, undefined, jwt);
    const historyBody = (await historyRes.json()) as {
      data: {
        fecResults: Array<{
          results: Array<{ parasiteType: string; countPerGram: number | null; grade: string | null }>;
        }>;
      };
    };
    expect(historyBody.data.fecResults[0].results).toEqual([
      { parasiteType: "strongyles", countPerGram: null, grade: "medium" },
    ]);

    // The update applies the same exactly-one-of rule as create
    const both = await request(
      "PATCH",
      `/v1/parasiteChecks/byId/${base.id}`,
      {
        fecSamples: [{ animalIds: [a1.id], results: [{ parasiteType: "strongyles", countPerGram: 10, grade: "low" }] }],
      },
      jwt
    );
    expect(both.status).toBe(400);
  });

  it("leaves graded results out of the reduction", async () => {
    const { jwt, a1, a2, base } = await setupFecBase();

    // Only grades in the re-check: nothing to compare against the base counts
    const allGraded = await createCheck(jwt, {
      date: "2025-06-15",
      method: "fecal_egg_count",
      animals: [{ animalId: a1.id }],
      fecSamples: [{ animalIds: [a1.id], results: [{ parasiteType: "strongyles", grade: "low" }] }],
      previousCheckId: base.id,
    });
    expect(allGraded.status).toBe(200);
    expect(allGraded.body.data.comparisonToPrevious!.fecReduction).toHaveLength(0);

    // a1 graded, a2 counted: only a2's 500 -> 50 is paired
    const partlyGraded = await createCheck(jwt, {
      date: "2025-06-16",
      method: "fecal_egg_count",
      animals: [{ animalId: a1.id }, { animalId: a2.id }],
      fecSamples: [
        { animalIds: [a1.id], results: [{ parasiteType: "strongyles", grade: "low" }] },
        { animalIds: [a2.id], results: [{ parasiteType: "strongyles", countPerGram: 50 }] },
      ],
      previousCheckId: base.id,
    });
    expect(partlyGraded.status).toBe(200);
    const reduction = partlyGraded.body.data.comparisonToPrevious!.fecReduction;
    expect(reduction).toHaveLength(1);
    expect(reduction[0].afterSampleCount).toBe(1);
    expect(reduction[0].reductionPercent).toBeCloseTo(90);
  });

  it("summarizes a parasite counted in one sample and graded in another separately", async () => {
    const { jwt } = await createUserWithFarm();
    const a1 = await createAnimal(jwt, { name: "M1", type: "sheep" });
    const a2 = await createAnimal(jwt, { name: "M2", type: "sheep" });

    const mixed = await createCheck(jwt, {
      date: "2025-06-01",
      method: "fecal_egg_count",
      animals: [{ animalId: a1.id }, { animalId: a2.id }],
      fecSamples: [
        { animalIds: [a1.id], results: [{ parasiteType: "coccidia", countPerGram: 300 }] },
        { animalIds: [a2.id], results: [{ parasiteType: "coccidia", grade: "medium" }] },
      ],
    });
    expect(mixed.status).toBe(200);
    const summary = mixed.body.data.summary;
    const counted = summary.fecByParasite.find((entry) => entry.parasiteType === "coccidia")!;
    expect(counted.sampleCount).toBe(1);
    expect(counted.avgCountPerGram).toBe(300);
    const graded = summary.gradesByParasite.find((entry) => entry.parasiteType === "coccidia")!;
    expect(graded.sampleCount).toBe(1);
    expect(graded.averageGrade).toBe(2);
  });
});
