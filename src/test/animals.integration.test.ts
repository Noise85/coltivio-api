import { describe, it, expect, beforeEach } from "@jest/globals";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { eq } from "drizzle-orm";

import { cleanDb, getAdminDb, request } from "./helpers";
import * as schema from "../db/schema";
import { createUserWithFarm, createAnimal, createHerd, createOutdoorSchedule } from "./test-utils";

// ---------------------------------------------------------------------------
// Animals CRUD
// ---------------------------------------------------------------------------
describe("Animals CRUD", () => {
  beforeEach(cleanDb);

  it("creates an animal and retrieves it by id", async () => {
    const { jwt, farmId } = await createUserWithFarm();
    const animal = await createAnimal(jwt, {
      name: "Daisy",
      type: "cow",
      sex: "female",
      dateOfBirth: "2022-03-10",
      usage: "milk",
      registered: true,
    });

    expect(animal.name).toBe("Daisy");
    expect(animal.type).toBe("cow");
    expect(animal.sex).toBe("female");
    expect(animal.farmId).toBe(farmId);
    expect(animal.usage).toBe("milk");

    // Verify DB
    const db = getAdminDb();
    const dbAnimal = await db.query.animals.findFirst({
      where: { id: animal.id },
    });
    expect(dbAnimal!.name).toBe("Daisy");
    expect(dbAnimal!.type).toBe("cow");
    expect(dbAnimal!.sex).toBe("female");
    expect(dbAnimal!.usage).toBe("milk");
    expect(dbAnimal!.registered).toBe(true);
    expect(dbAnimal!.farmId).toBe(farmId);

    // GET by id
    const getRes = await request("GET", `/v1/animals/byId/${animal.id}`, undefined, jwt);
    expect(getRes.status).toBe(200);
    const getBody = (await getRes.json()) as {
      data: {
        id: string;
        mother: unknown | null;
        father: unknown | null;
        childrenAsMother: unknown[];
        childrenAsFather: unknown[];
      };
    };
    expect(getBody.data.id).toBe(animal.id);
    expect(getBody.data.mother).toBeNull();
    expect(getBody.data.childrenAsMother).toEqual([]);
  });

  it("lists animals for farm with count", async () => {
    const { jwt } = await createUserWithFarm();
    await createAnimal(jwt, { name: "A1" });
    await createAnimal(jwt, { name: "A2" });

    const res = await request("GET", "/v1/animals", undefined, jwt);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { result: Array<{ milkAndMeatUsable?: boolean }>; count: number };
    };
    expect(body.data.count).toBe(2);
    expect(body.data.result).toHaveLength(2);
    expect(body.data.result[0].milkAndMeatUsable).toBeDefined();
  });

  it("filters animals by single type (string→array preprocessing)", async () => {
    const { jwt } = await createUserWithFarm();
    await createAnimal(jwt, { name: "Cow1", type: "cow" });
    await createAnimal(jwt, { name: "Goat1", type: "goat" });

    // Single value: query string sends it as a plain string, preprocess wraps it
    const res = await request("GET", "/v1/animals?animalTypes=cow", undefined, jwt);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { result: Array<{ type: string }>; count: number };
    };
    expect(body.data.count).toBe(1);
    expect(body.data.result[0].type).toBe("cow");
  });

  it("filters animals by multiple types", async () => {
    const { jwt } = await createUserWithFarm();
    await createAnimal(jwt, { name: "Cow1", type: "cow" });
    await createAnimal(jwt, { name: "Goat1", type: "goat" });
    await createAnimal(jwt, { name: "Sheep1", type: "sheep" });

    const res = await request("GET", "/v1/animals?animalTypes=cow&animalTypes=goat", undefined, jwt);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { result: Array<{ type: string }>; count: number };
    };
    expect(body.data.count).toBe(2);
    const types = body.data.result.map((a) => a.type);
    expect(types).toContain("cow");
    expect(types).toContain("goat");
  });

  it("filters out dead animals with onlyLiving=true", async () => {
    const { jwt } = await createUserWithFarm();
    await createAnimal(jwt, { name: "Alive" });
    await createAnimal(jwt, {
      name: "Dead",
      dateOfDeath: "2024-06-01",
      deathReason: "died",
    });

    // onlyLiving defaults to true
    const res = await request("GET", "/v1/animals", undefined, jwt);
    const body = (await res.json()) as {
      data: { result: Array<{ name: string }>; count: number };
    };
    expect(body.data.count).toBe(1);
    expect(body.data.result[0].name).toBe("Alive");

    // onlyLiving=false shows all
    const allRes = await request("GET", "/v1/animals?onlyLiving=false", undefined, jwt);
    const allBody = (await allRes.json()) as {
      data: { result: unknown[]; count: number };
    };
    expect(allBody.data.count).toBe(2);
  });

  it("updates an animal", async () => {
    const { jwt } = await createUserWithFarm();
    const animal = await createAnimal(jwt, { name: "OldName", usage: "milk" });

    const res = await request("PATCH", `/v1/animals/byId/${animal.id}`, { name: "NewName", usage: "other" }, jwt);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { name: string; usage: string } };
    expect(body.data.name).toBe("NewName");
    expect(body.data.usage).toBe("other");

    // Verify DB
    const db = getAdminDb();
    const dbAnimal = await db.query.animals.findFirst({
      where: { id: animal.id },
    });
    expect(dbAnimal!.name).toBe("NewName");
    expect(dbAnimal!.usage).toBe("other");
  });

  it("deletes a single animal", async () => {
    const { jwt } = await createUserWithFarm();
    const animal = await createAnimal(jwt);

    const res = await request("DELETE", `/v1/animals/byId/${animal.id}`, undefined, jwt);
    expect(res.status).toBe(200);

    // Verify DB
    const db = getAdminDb();
    const dbAnimal = await db.query.animals.findFirst({
      where: { id: animal.id },
    });
    expect(dbAnimal).toBeUndefined();
  });

  it("batch deletes multiple animals", async () => {
    const { jwt } = await createUserWithFarm();
    const a1 = await createAnimal(jwt, { name: "D1" });
    const a2 = await createAnimal(jwt, { name: "D2" });
    const keep = await createAnimal(jwt, { name: "Keep" });

    const qs = `animalIds=${a1.id}&animalIds=${a2.id}`;
    const res = await request("DELETE", `/v1/animals?${qs}`, undefined, jwt);
    expect(res.status).toBe(200);

    // Verify DB
    const db = getAdminDb();
    const remaining = await db.query.animals.findMany({});
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe(keep.id);
  });

  it("batch updates multiple animals", async () => {
    const { jwt } = await createUserWithFarm();
    const a1 = await createAnimal(jwt, { name: "B1", usage: "milk" });
    const a2 = await createAnimal(jwt, { name: "B2", usage: "milk" });

    const res = await request(
      "PATCH",
      "/v1/animals/batch",
      { animalIds: [a1.id, a2.id], data: { usage: "other" } },
      jwt
    );
    expect(res.status).toBe(200);

    // Verify DB
    const db = getAdminDb();
    const dbAnimals = await db.query.animals.findMany({
      where: { id: { in: [a1.id, a2.id] } },
    });
    expect(dbAnimals).toHaveLength(2);
    expect(dbAnimals.every((a) => a.usage === "other")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Parent-child relationships
// ---------------------------------------------------------------------------
describe("Animal parent-child relationships", () => {
  beforeEach(cleanDb);

  it("sets mother/father and retrieves children", async () => {
    const { jwt } = await createUserWithFarm();
    const mother = await createAnimal(jwt, { name: "Mother", sex: "female" });
    const father = await createAnimal(jwt, { name: "Father", sex: "male" });
    const calf = await createAnimal(jwt, {
      name: "Calf",
      dateOfBirth: "2024-06-01",
      motherId: mother.id,
      fatherId: father.id,
    });

    // Verify DB
    const db = getAdminDb();
    const dbCalf = await db.query.animals.findFirst({
      where: { id: calf.id },
    });
    expect(dbCalf!.motherId).toBe(mother.id);
    expect(dbCalf!.fatherId).toBe(father.id);

    // Verify via API - GET by id
    const calfRes = await request("GET", `/v1/animals/byId/${calf.id}`, undefined, jwt);
    const calfBody = (await calfRes.json()) as {
      data: { mother: { id: string } | null; father: { id: string } | null };
    };
    expect(calfBody.data.mother!.id).toBe(mother.id);
    expect(calfBody.data.father!.id).toBe(father.id);

    // Children of mother
    const childrenRes = await request("GET", `/v1/animals/byId/${mother.id}/children`, undefined, jwt);
    expect(childrenRes.status).toBe(200);
    const childrenBody = (await childrenRes.json()) as {
      data: { result: Array<{ id: string }>; count: number };
    };
    expect(childrenBody.data.count).toBe(1);
    expect(childrenBody.data.result[0].id).toBe(calf.id);

    // Children of father
    const fatherChildrenRes = await request("GET", `/v1/animals/byId/${father.id}/children`, undefined, jwt);
    const fatherChildrenBody = (await fatherChildrenRes.json()) as {
      data: { count: number };
    };
    expect(fatherChildrenBody.data.count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Herds CRUD
// ---------------------------------------------------------------------------
describe("Herds CRUD", () => {
  beforeEach(cleanDb);

  it("creates a herd with animals and retrieves it", async () => {
    const { jwt, farmId } = await createUserWithFarm();
    const a1 = await createAnimal(jwt, { name: "H1" });
    const a2 = await createAnimal(jwt, { name: "H2" });
    const herd = await createHerd(jwt, {
      name: "Pasture Herd",
      animalIds: [a1.id, a2.id],
    });

    expect(herd.name).toBe("Pasture Herd");

    // Verify DB
    const db = getAdminDb();
    const dbHerd = await db.query.herds.findFirst({
      where: { id: herd.id },
    });
    expect(dbHerd!.name).toBe("Pasture Herd");
    expect(dbHerd!.farmId).toBe(farmId);

    // Verify animals got herdId in DB
    const dbAnimals = await db.query.animals.findMany({
      where: { id: { in: [a1.id, a2.id] } },
    });
    expect(dbAnimals.every((a) => a.herdId === herd.id)).toBe(true);

    // GET by id includes animals
    const getRes = await request("GET", `/v1/animals/herds/byId/${herd.id}`, undefined, jwt);
    expect(getRes.status).toBe(200);
    const getBody = (await getRes.json()) as {
      data: { animals: unknown[] };
    };
    expect(getBody.data.animals).toHaveLength(2);
  });

  it("lists herds for farm", async () => {
    const { jwt } = await createUserWithFarm();
    await createHerd(jwt, { name: "Herd A" });
    await createHerd(jwt, { name: "Herd B" });

    const res = await request("GET", "/v1/animals/herds", undefined, jwt);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { count: number } };
    expect(body.data.count).toBe(2);
  });

  it("updates a herd name and animal assignments", async () => {
    const { jwt } = await createUserWithFarm();
    const a1 = await createAnimal(jwt, { name: "OrigAnimal" });
    const a2 = await createAnimal(jwt, { name: "NewAnimal" });
    const herd = await createHerd(jwt, { name: "OldName", animalIds: [a1.id] });

    const res = await request(
      "PATCH",
      `/v1/animals/herds/byId/${herd.id}`,
      { name: "NewName", animalIds: [a2.id] },
      jwt
    );
    expect(res.status).toBe(200);

    // Verify DB
    const db = getAdminDb();
    const dbHerd = await db.query.herds.findFirst({
      where: { id: herd.id },
    });
    expect(dbHerd!.name).toBe("NewName");

    const dbA1 = await db.query.animals.findFirst({
      where: { id: a1.id },
    });
    expect(dbA1!.herdId).toBeNull();
    const dbA2 = await db.query.animals.findFirst({
      where: { id: a2.id },
    });
    expect(dbA2!.herdId).toBe(herd.id);
  });

  it("deletes a herd", async () => {
    const { jwt } = await createUserWithFarm();
    const herd = await createHerd(jwt, { name: "ToDelete" });

    const res = await request("DELETE", `/v1/animals/herds/byId/${herd.id}`, undefined, jwt);
    expect(res.status).toBe(200);

    // Verify DB
    const db = getAdminDb();
    const dbHerd = await db.query.herds.findFirst({
      where: { id: herd.id },
    });
    expect(dbHerd).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Herds with inline outdoor schedules
// ---------------------------------------------------------------------------
describe("Herds with inline outdoor schedules", () => {
  beforeEach(cleanDb);

  it("creates a herd with outdoor schedules", async () => {
    const { jwt } = await createUserWithFarm();
    const herd = await createHerd(jwt, {
      name: "ScheduleHerd",
      outdoorSchedules: [
        { startDate: "2025-05-01", endDate: "2025-06-30", type: "pasture" },
        { startDate: "2025-07-01", endDate: "2025-09-30", type: "exercise_yard" },
      ],
    });

    // Verify DB
    const db = getAdminDb();
    const dbSchedules = await db.query.outdoorSchedules.findMany({
      where: { herdId: herd.id },
    });
    expect(dbSchedules).toHaveLength(2);

    // Verify API response
    const res = await request("GET", `/v1/animals/herds/byId/${herd.id}`, undefined, jwt);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { outdoorSchedules: Array<{ type: string }> };
    };
    expect(body.data.outdoorSchedules).toHaveLength(2);
  });

  it("creates a herd with outdoor schedules including recurrence", async () => {
    const { jwt } = await createUserWithFarm();
    const herd = await createHerd(jwt, {
      name: "RecurHerd",
      outdoorSchedules: [
        {
          startDate: "2025-05-01",
          endDate: "2025-05-01",
          type: "exercise_yard",
          recurrence: {
            frequency: "weekly",
            interval: 1,
            byWeekday: ["MO", "WE", "FR"],
            until: "2025-09-30",
          },
        },
      ],
    });

    // Verify DB
    const db = getAdminDb();
    const dbSchedules = await db.query.outdoorSchedules.findMany({
      where: { herdId: herd.id },
    });
    expect(dbSchedules).toHaveLength(1);
    const dbRecurrences = await db.query.outdoorScheduleRecurrences.findMany({
      where: { outdoorScheduleId: dbSchedules[0].id },
    });
    expect(dbRecurrences).toHaveLength(1);
    expect(dbRecurrences[0].frequency).toBe("weekly");

    // Verify API response
    const res = await request("GET", `/v1/animals/herds/byId/${herd.id}`, undefined, jwt);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { outdoorSchedules: Array<{ recurrence: Record<string, unknown> | null }> };
    };
    expect(body.data.outdoorSchedules).toHaveLength(1);
    expect(body.data.outdoorSchedules[0].recurrence).not.toBeNull();
  });

  it("rejects createHerd with overlapping inline schedules", async () => {
    const { jwt } = await createUserWithFarm();
    const res = await request(
      "POST",
      "/v1/animals/herds",
      {
        name: "OverlapHerd",
        animalIds: [],
        outdoorSchedules: [
          { startDate: "2025-05-01", endDate: "2025-08-31", type: "pasture" },
          { startDate: "2025-07-01", endDate: "2025-09-30", type: "exercise_yard" },
        ],
      },
      jwt
    );
    expect(res.status).toBe(409);

    // Verify nothing was created in DB
    const db = getAdminDb();
    const dbHerds = await db.query.herds.findMany({});
    expect(dbHerds).toHaveLength(0);
  });

  it("updateHerd replaces outdoor schedules", async () => {
    const { jwt } = await createUserWithFarm();
    const herd = await createHerd(jwt, {
      name: "ReplaceHerd",
      outdoorSchedules: [{ startDate: "2025-05-01", endDate: "2025-09-30", type: "pasture" }],
    });

    // Replace with two new schedules
    const patchRes = await request(
      "PATCH",
      `/v1/animals/herds/byId/${herd.id}`,
      {
        outdoorSchedules: [
          { startDate: "2025-05-01", endDate: "2025-06-30", type: "exercise_yard" },
          { startDate: "2025-07-01", endDate: "2025-09-30", type: "pasture" },
        ],
      },
      jwt
    );
    expect(patchRes.status).toBe(200);

    // Verify DB — old schedule gone, two new ones exist
    const db = getAdminDb();
    const dbSchedules = await db.query.outdoorSchedules.findMany({
      where: { herdId: herd.id },
    });
    expect(dbSchedules).toHaveLength(2);

    // Verify API response
    const res = await request("GET", `/v1/animals/herds/byId/${herd.id}`, undefined, jwt);
    const body = (await res.json()) as {
      data: { outdoorSchedules: Array<{ type: string }> };
    };
    expect(body.data.outdoorSchedules).toHaveLength(2);
  });

  it("updateHerd with empty outdoorSchedules removes all schedules", async () => {
    const { jwt } = await createUserWithFarm();
    const herd = await createHerd(jwt, {
      name: "ClearHerd",
      outdoorSchedules: [{ startDate: "2025-05-01", endDate: "2025-09-30", type: "pasture" }],
    });

    const patchRes = await request("PATCH", `/v1/animals/herds/byId/${herd.id}`, { outdoorSchedules: [] }, jwt);
    expect(patchRes.status).toBe(200);

    // Verify DB
    const db = getAdminDb();
    const dbSchedules = await db.query.outdoorSchedules.findMany({
      where: { herdId: herd.id },
    });
    expect(dbSchedules).toHaveLength(0);
  });

  it("rejects updateHerd with overlapping replacement schedules", async () => {
    const { jwt } = await createUserWithFarm();
    const herd = await createHerd(jwt, { name: "OverlapUpdate" });

    const res = await request(
      "PATCH",
      `/v1/animals/herds/byId/${herd.id}`,
      {
        outdoorSchedules: [
          { startDate: "2025-05-01", endDate: "2025-08-31", type: "pasture" },
          { startDate: "2025-07-01", endDate: "2025-09-30", type: "exercise_yard" },
        ],
      },
      jwt
    );
    expect(res.status).toBe(409);

    // Verify DB unchanged (no schedules created)
    const db = getAdminDb();
    const dbSchedules = await db.query.outdoorSchedules.findMany({
      where: { herdId: herd.id },
    });
    expect(dbSchedules).toHaveLength(0);
  });

  it("updateHerd without outdoorSchedules leaves existing schedules untouched", async () => {
    const { jwt } = await createUserWithFarm();
    const herd = await createHerd(jwt, {
      name: "KeepSchedules",
      outdoorSchedules: [{ startDate: "2025-05-01", endDate: "2025-09-30", type: "pasture" }],
    });

    // Update only the name
    const patchRes = await request("PATCH", `/v1/animals/herds/byId/${herd.id}`, { name: "Renamed" }, jwt);
    expect(patchRes.status).toBe(200);

    // Verify DB — schedule still exists
    const db = getAdminDb();
    const dbSchedules = await db.query.outdoorSchedules.findMany({
      where: { herdId: herd.id },
    });
    expect(dbSchedules).toHaveLength(1);

    // Verify API response
    const res = await request("GET", `/v1/animals/herds/byId/${herd.id}`, undefined, jwt);
    const body = (await res.json()) as {
      data: { name: string; outdoorSchedules: unknown[] };
    };
    expect(body.data.name).toBe("Renamed");
    expect(body.data.outdoorSchedules).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Outdoor Schedules CRUD
// ---------------------------------------------------------------------------
describe("Outdoor Schedules CRUD", () => {
  beforeEach(cleanDb);

  it("creates a schedule without recurrence", async () => {
    const { jwt } = await createUserWithFarm();
    const herd = await createHerd(jwt, { name: "OutdoorHerd" });

    const schedule = await createOutdoorSchedule(jwt, herd.id, {
      startDate: "2025-05-01",
      endDate: "2025-09-30",
      type: "pasture",
    });
    expect(schedule.herdId).toBe(herd.id);
    expect(schedule.type).toBe("pasture");
    expect(schedule.recurrence).toBeNull();

    // Verify DB
    const db = getAdminDb();
    const dbSchedule = await db.query.outdoorSchedules.findFirst({
      where: { id: schedule.id },
    });
    expect(dbSchedule!.herdId).toBe(herd.id);
    expect(dbSchedule!.type).toBe("pasture");
  });

  it("creates a schedule with weekly recurrence", async () => {
    const { jwt } = await createUserWithFarm();
    const herd = await createHerd(jwt, { name: "RecurHerd" });

    const schedule = await createOutdoorSchedule(jwt, herd.id, {
      startDate: "2025-05-01",
      endDate: "2025-05-01",
      type: "exercise_yard",
      recurrence: {
        frequency: "weekly",
        interval: 1,
        byWeekday: ["MO", "WE", "FR"],
      },
    });
    expect(schedule.recurrence).not.toBeNull();
    const rec = schedule.recurrence as Record<string, unknown>;
    expect(rec.frequency).toBe("weekly");
    expect(rec.byWeekday).toEqual(["MO", "WE", "FR"]);

    // Verify DB
    const db = getAdminDb();
    const dbSchedule = await db.query.outdoorSchedules.findFirst({
      where: { id: schedule.id },
    });
    expect(dbSchedule).toBeDefined();
    const dbRecurrences = await db.query.outdoorScheduleRecurrences.findMany({
      where: { outdoorScheduleId: schedule.id },
    });
    expect(dbRecurrences).toHaveLength(1);
    expect(dbRecurrences[0].frequency).toBe("weekly");
  });

  it("updates a schedule", async () => {
    const { jwt } = await createUserWithFarm();
    const herd = await createHerd(jwt);
    const schedule = await createOutdoorSchedule(jwt, herd.id);

    const res = await request(
      "PATCH",
      `/v1/animals/herds/outdoorSchedules/byId/${schedule.id}`,
      { type: "exercise_yard", notes: "Updated notes" },
      jwt
    );
    expect(res.status).toBe(200);

    // Verify DB
    const db = getAdminDb();
    const dbSchedule = await db.query.outdoorSchedules.findFirst({
      where: { id: schedule.id },
    });
    expect(dbSchedule!.type).toBe("exercise_yard");
    expect(dbSchedule!.notes).toBe("Updated notes");
  });

  it("deletes a schedule", async () => {
    const { jwt } = await createUserWithFarm();
    const herd = await createHerd(jwt);
    const schedule = await createOutdoorSchedule(jwt, herd.id);

    const res = await request("DELETE", `/v1/animals/herds/outdoorSchedules/byId/${schedule.id}`, undefined, jwt);
    expect(res.status).toBe(200);

    // Verify DB
    const db = getAdminDb();
    const dbSchedule = await db.query.outdoorSchedules.findFirst({
      where: { id: schedule.id },
    });
    expect(dbSchedule).toBeUndefined();
  });

  it("rejects overlapping schedules for the same herd", async () => {
    const { jwt } = await createUserWithFarm();
    const herd = await createHerd(jwt);
    await createOutdoorSchedule(jwt, herd.id, {
      startDate: "2025-05-01",
      endDate: "2025-09-30",
    });

    // Overlapping range should fail
    const res = await request(
      "POST",
      `/v1/animals/herds/byId/${herd.id}/outdoorSchedules`,
      { startDate: "2025-08-01", endDate: "2025-10-31", type: "pasture" },
      jwt
    );
    expect(res.status).toBe(409);

    // Verify DB: still only one schedule
    const db = getAdminDb();
    const dbSchedules = await db.query.outdoorSchedules.findMany({
      where: { herdId: herd.id },
    });
    expect(dbSchedules).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Outdoor Journal
// ---------------------------------------------------------------------------
describe("Outdoor Journal", () => {
  beforeEach(cleanDb);

  it("returns journal entries for animals in a herd with outdoor schedules", async () => {
    const { jwt } = await createUserWithFarm();
    const sheep = await createAnimal(jwt, {
      name: "OldSheep",
      type: "sheep",
      sex: "female",
      dateOfBirth: "2020-01-01",
      usage: "other",
    });
    const herd = await createHerd(jwt, { animalIds: [sheep.id] });
    await createOutdoorSchedule(jwt, herd.id, {
      startDate: "2027-05-01",
      endDate: "2027-09-30",
    });

    const res = await request(
      "GET",
      "/v1/animals/outdoorJournal?fromDate=2027-01-01&toDate=2027-12-31",
      undefined,
      jwt
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        entries: Array<{ category: string; animalCount: number }>;
        uncategorizedAnimals: Array<{ id: string; name: string; earTag: unknown }>;
      };
    };
    expect(body.data.entries.length).toBeGreaterThanOrEqual(1);
    expect(body.data.entries[0].category).toBe("D1");
    expect(body.data.entries[0].animalCount).toBe(1);
    expect(body.data.uncategorizedAnimals).toHaveLength(0);
  });

  it("counts uncategorized animals (e.g. pigs)", async () => {
    const { jwt } = await createUserWithFarm();
    const pig = await createAnimal(jwt, {
      type: "pig",
      sex: "female",
      dateOfBirth: "2024-01-01",
      usage: "other",
    });
    const herd = await createHerd(jwt, { animalIds: [pig.id] });
    await createOutdoorSchedule(jwt, herd.id, {
      startDate: "2027-05-01",
      endDate: "2027-09-30",
    });

    const res = await request(
      "GET",
      "/v1/animals/outdoorJournal?fromDate=2027-01-01&toDate=2027-12-31",
      undefined,
      jwt
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { entries: unknown[]; uncategorizedAnimals: Array<{ id: string; name: string }> };
    };
    expect(body.data.entries).toHaveLength(0);
    expect(body.data.uncategorizedAnimals).toHaveLength(1);
    expect(body.data.uncategorizedAnimals[0].id).toBe(pig.id);
  });

  it("returns empty when no herds have outdoor schedules", async () => {
    const { jwt } = await createUserWithFarm();
    await createAnimal(jwt);

    const res = await request(
      "GET",
      "/v1/animals/outdoorJournal?fromDate=2027-01-01&toDate=2027-12-31",
      undefined,
      jwt
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { entries: unknown[]; uncategorizedAnimals: unknown[] };
    };
    expect(body.data.entries).toHaveLength(0);
    expect(body.data.uncategorizedAnimals).toHaveLength(0);
  });

  it("pig alongside categorized sheep both appear correctly", async () => {
    const { jwt } = await createUserWithFarm();
    const sheep = await createAnimal(jwt, {
      name: "OldSheep",
      type: "sheep",
      sex: "female",
      dateOfBirth: "2020-01-01",
      usage: "other",
    });
    const pig = await createAnimal(jwt, {
      name: "Piggy",
      type: "pig",
      sex: "female",
      dateOfBirth: "2024-01-01",
      usage: "other",
    });
    const herd = await createHerd(jwt, { animalIds: [sheep.id, pig.id] });
    await createOutdoorSchedule(jwt, herd.id, {
      startDate: "2027-05-01",
      endDate: "2027-09-30",
    });

    const res = await request(
      "GET",
      "/v1/animals/outdoorJournal?fromDate=2027-01-01&toDate=2027-12-31",
      undefined,
      jwt
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        entries: Array<{ category: string; animalCount: number }>;
        uncategorizedAnimals: Array<{ id: string; name: string }>;
      };
    };
    // Sheep should produce a D1 entry
    expect(body.data.entries.length).toBeGreaterThanOrEqual(1);
    expect(body.data.entries[0].category).toBe("D1");
    // Pig should be uncategorized
    expect(body.data.uncategorizedAnimals).toHaveLength(1);
    expect(body.data.uncategorizedAnimals[0].id).toBe(pig.id);
  });

  it("pig added to existing herd via updateHerd shows as uncategorized", async () => {
    const { jwt } = await createUserWithFarm();
    const pig = await createAnimal(jwt, {
      name: "LatePig",
      type: "pig",
      sex: "female",
      dateOfBirth: "2024-01-01",
      usage: "other",
    });
    // Create herd without the pig, add schedule, then add pig via updateHerd
    const herd = await createHerd(jwt);
    await createOutdoorSchedule(jwt, herd.id, {
      startDate: "2027-05-01",
      endDate: "2027-09-30",
    });
    await request("PATCH", `/v1/animals/herds/byId/${herd.id}`, { animalIds: [pig.id] }, jwt);

    const res = await request(
      "GET",
      "/v1/animals/outdoorJournal?fromDate=2027-01-01&toDate=2027-12-31",
      undefined,
      jwt
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        entries: unknown[];
        uncategorizedAnimals: Array<{ id: string }>;
      };
    };
    expect(body.data.entries).toHaveLength(0);
    expect(body.data.uncategorizedAnimals).toHaveLength(1);
    expect(body.data.uncategorizedAnimals[0].id).toBe(pig.id);
  });

  it("pig added via updateAnimal herdId (no membership) shows as uncategorized", async () => {
    const { jwt } = await createUserWithFarm();
    const herd = await createHerd(jwt);
    await createOutdoorSchedule(jwt, herd.id, {
      startDate: "2027-05-01",
      endDate: "2027-09-30",
    });
    // Create pig, then set herdId directly via updateAnimal (bypasses membership creation)
    const pig = await createAnimal(jwt, {
      name: "DirectPig",
      type: "pig",
      sex: "female",
      dateOfBirth: "2024-01-01",
      usage: "other",
    });
    await request("PATCH", `/v1/animals/byId/${pig.id}`, { herdId: herd.id }, jwt);

    const res = await request(
      "GET",
      "/v1/animals/outdoorJournal?fromDate=2027-01-01&toDate=2027-12-31",
      undefined,
      jwt
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        entries: unknown[];
        uncategorizedAnimals: Array<{ id: string }>;
      };
    };
    expect(body.data.entries).toHaveLength(0);
    expect(body.data.uncategorizedAnimals).toHaveLength(1);
    expect(body.data.uncategorizedAnimals[0].id).toBe(pig.id);
  });

  it("splits journal entries when animal changes category mid-schedule", async () => {
    const { jwt } = await createUserWithFarm();
    // Female sheep born 2026-07-01 → turns 365 days on ~2027-07-01 (D3 → D1)
    const youngSheep = await createAnimal(jwt, {
      type: "sheep",
      sex: "female",
      dateOfBirth: "2026-07-01",
      usage: "other",
    });
    const herd = await createHerd(jwt, { animalIds: [youngSheep.id] });
    await createOutdoorSchedule(jwt, herd.id, {
      startDate: "2027-05-01",
      endDate: "2027-09-30",
    });

    const res = await request(
      "GET",
      "/v1/animals/outdoorJournal?fromDate=2027-01-01&toDate=2027-12-31",
      undefined,
      jwt
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { entries: Array<{ category: string }> };
    };
    const categories = body.data.entries.map((e) => e.category);
    expect(categories).toContain("D3");
    expect(categories).toContain("D1");
  });
});

// ---------------------------------------------------------------------------
// Custom Outdoor Journal Categories
// ---------------------------------------------------------------------------
describe("Custom Outdoor Journal Categories", () => {
  beforeEach(cleanDb);

  it("sets custom categories for an animal and verifies DB", async () => {
    const { jwt } = await createUserWithFarm();
    const animal = await createAnimal(jwt, {
      type: "pig",
      sex: "female",
      dateOfBirth: "2024-01-01",
      usage: "other",
    });

    const res = await request(
      "PUT",
      `/v1/animals/byId/${animal.id}/customOutdoorJournalCategories`,
      {
        entries: [
          { startDate: "2027-05-01", endDate: "2027-06-30", category: "A1" },
          { startDate: "2027-07-01", endDate: "2027-09-30", category: "A2" },
        ],
      },
      jwt
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { result: Array<{ id: string; category: string; animalId: string }> };
    };
    expect(body.data.result).toHaveLength(2);
    expect(body.data.result.map((c) => c.category).sort()).toEqual(["A1", "A2"]);
    expect(body.data.result.every((c) => c.animalId === animal.id)).toBe(true);

    // Verify DB
    const db = getAdminDb();
    const dbCategories = await db.query.customOutdoorJournalCategories.findMany({
      where: { animalId: animal.id },
    });
    expect(dbCategories).toHaveLength(2);
    expect(dbCategories.map((c) => c.category).sort()).toEqual(["A1", "A2"]);
  });

  it("replaces existing custom categories on subsequent call", async () => {
    const { jwt } = await createUserWithFarm();
    const animal = await createAnimal(jwt, {
      type: "pig",
      sex: "female",
      usage: "other",
    });

    // Set initial categories
    await request(
      "PUT",
      `/v1/animals/byId/${animal.id}/customOutdoorJournalCategories`,
      {
        entries: [{ startDate: "2027-05-01", endDate: "2027-09-30", category: "A1" }],
      },
      jwt
    );

    // Replace with new ones
    const res = await request(
      "PUT",
      `/v1/animals/byId/${animal.id}/customOutdoorJournalCategories`,
      {
        entries: [{ startDate: "2027-06-01", endDate: "2027-07-31", category: "D1" }],
      },
      jwt
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { result: Array<{ category: string }> };
    };
    expect(body.data.result).toHaveLength(1);
    expect(body.data.result[0].category).toBe("D1");

    // Verify DB — old entries gone, only new one
    const db = getAdminDb();
    const dbCategories = await db.query.customOutdoorJournalCategories.findMany({
      where: { animalId: animal.id },
    });
    expect(dbCategories).toHaveLength(1);
    expect(dbCategories[0].category).toBe("D1");
  });

  it("clears all categories when empty array is passed", async () => {
    const { jwt } = await createUserWithFarm();
    const animal = await createAnimal(jwt, {
      type: "pig",
      sex: "female",
      usage: "other",
    });

    // Set initial
    await request(
      "PUT",
      `/v1/animals/byId/${animal.id}/customOutdoorJournalCategories`,
      {
        entries: [{ startDate: "2027-05-01", endDate: "2027-09-30", category: "A1" }],
      },
      jwt
    );

    // Clear
    const res = await request(
      "PUT",
      `/v1/animals/byId/${animal.id}/customOutdoorJournalCategories`,
      { entries: [] },
      jwt
    );
    expect(res.status).toBe(200);

    // Verify DB
    const db = getAdminDb();
    const dbCategories = await db.query.customOutdoorJournalCategories.findMany({
      where: { animalId: animal.id },
    });
    expect(dbCategories).toHaveLength(0);
  });

  it("rejects overlapping custom categories", async () => {
    const { jwt } = await createUserWithFarm();
    const animal = await createAnimal(jwt, {
      type: "pig",
      sex: "female",
      usage: "other",
    });

    const res = await request(
      "PUT",
      `/v1/animals/byId/${animal.id}/customOutdoorJournalCategories`,
      {
        entries: [
          { startDate: "2027-05-01", endDate: "2027-08-31", category: "A1" },
          { startDate: "2027-07-01", endDate: "2027-09-30", category: "A2" },
        ],
      },
      jwt
    );
    expect(res.status).toBe(409);

    // Verify DB — nothing was created
    const db = getAdminDb();
    const dbCategories = await db.query.customOutdoorJournalCategories.findMany({
      where: { animalId: animal.id },
    });
    expect(dbCategories).toHaveLength(0);
  });

  it("custom categories are included in GET animal by id", async () => {
    const { jwt } = await createUserWithFarm();
    const animal = await createAnimal(jwt, {
      type: "pig",
      sex: "female",
      usage: "other",
    });

    await request(
      "PUT",
      `/v1/animals/byId/${animal.id}/customOutdoorJournalCategories`,
      {
        entries: [{ startDate: "2027-05-01", endDate: "2027-09-30", category: "A1" }],
      },
      jwt
    );

    const res = await request("GET", `/v1/animals/byId/${animal.id}`, undefined, jwt);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        customOutdoorJournalCategories: Array<{
          id: string;
          category: string;
          animalId: string;
        }>;
      };
    };
    expect(body.data.customOutdoorJournalCategories).toHaveLength(1);
    expect(body.data.customOutdoorJournalCategories[0].category).toBe("A1");
    expect(body.data.customOutdoorJournalCategories[0].animalId).toBe(animal.id);
  });

  it("custom category overrides null age-based category in outdoor journal", async () => {
    const { jwt } = await createUserWithFarm();
    // Pig has no age-based rules → normally uncategorized
    const pig = await createAnimal(jwt, {
      type: "pig",
      sex: "female",
      dateOfBirth: "2024-01-01",
      usage: "other",
    });

    // Set a custom category covering the outdoor schedule period
    await request(
      "PUT",
      `/v1/animals/byId/${pig.id}/customOutdoorJournalCategories`,
      {
        entries: [{ startDate: "2027-01-01", endDate: "2027-12-31", category: "D1" }],
      },
      jwt
    );

    const herd = await createHerd(jwt, { animalIds: [pig.id] });
    await createOutdoorSchedule(jwt, herd.id, {
      startDate: "2027-05-01",
      endDate: "2027-09-30",
    });

    const res = await request(
      "GET",
      "/v1/animals/outdoorJournal?fromDate=2027-01-01&toDate=2027-12-31",
      undefined,
      jwt
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        entries: Array<{ category: string; animalCount: number }>;
        uncategorizedAnimals: unknown[];
      };
    };
    expect(body.data.uncategorizedAnimals).toHaveLength(0);
    expect(body.data.entries.length).toBeGreaterThanOrEqual(1);
    expect(body.data.entries[0].category).toBe("D1");
    expect(body.data.entries[0].animalCount).toBe(1);
  });

  it("pig without custom category remains uncategorized in outdoor journal", async () => {
    const { jwt } = await createUserWithFarm();
    const pig = await createAnimal(jwt, {
      type: "pig",
      sex: "female",
      dateOfBirth: "2024-01-01",
      usage: "other",
    });

    const herd = await createHerd(jwt, { animalIds: [pig.id] });
    await createOutdoorSchedule(jwt, herd.id, {
      startDate: "2027-05-01",
      endDate: "2027-09-30",
    });

    const res = await request(
      "GET",
      "/v1/animals/outdoorJournal?fromDate=2027-01-01&toDate=2027-12-31",
      undefined,
      jwt
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        entries: unknown[];
        uncategorizedAnimals: Array<{ id: string }>;
      };
    };
    expect(body.data.entries).toHaveLength(0);
    expect(body.data.uncategorizedAnimals).toHaveLength(1);
    expect(body.data.uncategorizedAnimals[0].id).toBe(pig.id);
  });

  it("deleting animal cascades to custom categories", async () => {
    const { jwt } = await createUserWithFarm();
    const animal = await createAnimal(jwt, {
      type: "pig",
      sex: "female",
      usage: "other",
    });

    await request(
      "PUT",
      `/v1/animals/byId/${animal.id}/customOutdoorJournalCategories`,
      {
        entries: [{ startDate: "2027-05-01", endDate: "2027-09-30", category: "A1" }],
      },
      jwt
    );

    // Delete the animal
    await request("DELETE", `/v1/animals/byId/${animal.id}`, undefined, jwt);

    // Verify DB — custom categories cascaded
    const db = getAdminDb();
    const dbCategories = await db.query.customOutdoorJournalCategories.findMany({
      where: { animalId: animal.id },
    });
    expect(dbCategories).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Herd detail includes outdoor schedules
// ---------------------------------------------------------------------------
describe("Herd detail includes outdoor schedules", () => {
  beforeEach(cleanDb);

  it("GET herd by id includes associated outdoor schedules", async () => {
    const { jwt } = await createUserWithFarm();
    const herd = await createHerd(jwt);
    await createOutdoorSchedule(jwt, herd.id, {
      startDate: "2025-06-01",
      endDate: "2025-08-31",
      type: "pasture",
    });

    const res = await request("GET", `/v1/animals/herds/byId/${herd.id}`, undefined, jwt);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { outdoorSchedules: Array<{ type: string }> };
    };
    expect(body.data.outdoorSchedules).toHaveLength(1);
    expect(body.data.outdoorSchedules[0].type).toBe("pasture");
  });
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------
describe("Animals input validation", () => {
  beforeEach(cleanDb);

  it("rejects invalid animal type", async () => {
    const { jwt } = await createUserWithFarm();
    const res = await request(
      "POST",
      "/v1/animals",
      {
        name: "Bad",
        type: "dragon",
        sex: "female",
        dateOfBirth: "2020-01-01",
        registered: true,
        usage: "other",
      },
      jwt
    );
    expect(res.status).toBe(400);

    // Verify nothing was created in DB
    const db = getAdminDb();
    const dbAnimals = await db.query.animals.findMany({});
    expect(dbAnimals).toHaveLength(0);
  });

  it("rejects missing required fields", async () => {
    const { jwt } = await createUserWithFarm();
    const res = await request("POST", "/v1/animals", { name: "Incomplete" }, jwt);
    expect(res.status).toBe(400);

    // Verify nothing was created in DB
    const db = getAdminDb();
    const dbAnimals = await db.query.animals.findMany({});
    expect(dbAnimals).toHaveLength(0);
  });

  it("rejects invalid sex", async () => {
    const { jwt } = await createUserWithFarm();
    const res = await request(
      "POST",
      "/v1/animals",
      {
        name: "Bad",
        type: "cow",
        sex: "unknown",
        dateOfBirth: "2020-01-01",
        registered: true,
        usage: "milk",
      },
      jwt
    );
    expect(res.status).toBe(400);

    // Verify nothing was created in DB
    const db = getAdminDb();
    const dbAnimals = await db.query.animals.findMany({});
    expect(dbAnimals).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Import preview + commit (two-phase import)
// ---------------------------------------------------------------------------

// Builds an in-memory xlsx buffer with the standard German header row and the
// given data rows. Each row is [earTag, name, sex, dateOfBirth, usage].
async function buildExcelBuffer(rows: [string, string, string, string, string?][]) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Tiere");
  sheet.addRow(["Ohrmarkennummer", "Tiername", "Geschlecht", "Geburtsdatum", "Nutzungsart"]);
  for (const row of rows) {
    sheet.addRow(row);
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

const TVD_OVERVIEW_HEADER = [
  "Ohrmarken-Nr.",
  "Name",
  "Geburtsdatum",
  "Geschlecht",
  "Rasse",
  "Tiergeschichte",
  "Todesdatum",
];
const TVD_PEDIGREE_HEADER = [
  "Ohrmarken-Nr.",
  "Name",
  "Geburtsdatum",
  "Geschlecht",
  "Rasse",
  "Ohrmarken-Nr. (Mutter)",
  "Name (Mutter)",
  "Rasse (Mutter)",
  "Ohrmarken-Nr. (Vater)",
  "Name (Vater)",
  "Rasse (Vater)",
];

// Mirrors the structure of the TVD "Daten exportieren" file: x:-prefixed SpreadsheetML, inline
// strings and no r attributes on rows or cells.
async function buildTvdExportBuffer(rows: string[][], header: string[] = TVD_OVERVIEW_HEADER) {
  const escape = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const headerCells = header.map((h) => `<x:c t="str"><x:v>${escape(h)}</x:v></x:c>`).join("");
  const dataRows = rows
    .map(
      (row) =>
        `<x:row>${row.map((v) => `<x:c t="inlineStr"><x:is><x:t xml:space="preserve">${escape(v)}</x:t></x:is></x:c>`).join("")}</x:row>`
    )
    .join("");
  const ns = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
  const relNs = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="utf-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml" /><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml" /><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml" /></Types>`
  );
  zip.file(
    "_rels/.rels",
    `<?xml version="1.0" encoding="utf-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Type="${relNs}/officeDocument" Target="/xl/workbook.xml" Id="R1" /></Relationships>`
  );
  zip.file(
    "xl/workbook.xml",
    `<?xml version="1.0" encoding="utf-8"?><x:workbook xmlns:x="${ns}"><x:sheets><x:sheet name="Übersicht" sheetId="1" r:id="R2" xmlns:r="${relNs}" /></x:sheets></x:workbook>`
  );
  zip.file(
    "xl/_rels/workbook.xml.rels",
    `<?xml version="1.0" encoding="utf-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Type="${relNs}/worksheet" Target="/xl/worksheets/sheet1.xml" Id="R2" /></Relationships>`
  );
  zip.file(
    "xl/worksheets/sheet1.xml",
    `<?xml version="1.0" encoding="utf-8"?><x:worksheet xmlns:x="${ns}"><x:sheetData><x:row>${headerCells}</x:row>${dataRows}</x:sheetData></x:worksheet>`
  );
  return zip.generateAsync({ type: "nodebuffer" });
}

// Sends a multipart/form-data POST with an xlsx file attached. Returns the
// raw Response so callers can inspect status and body.
async function uploadExcel(
  path: string,
  buffer: Buffer,
  fields: Record<string, string>,
  jwt: string,
  extraHeaders: Record<string, string> = {}
) {
  const baseUrl = process.env.SERVER_URL!;
  const formData = new FormData();
  formData.append(
    "file",
    new Blob([buffer as unknown as ArrayBuffer], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    }),
    "animals.xlsx"
  );
  for (const [key, value] of Object.entries(fields)) {
    formData.append(key, value);
  }
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}`, ...extraHeaders },
    body: formData,
  });
}

describe("Animal import — preview + commit", () => {
  beforeEach(cleanDb);

  it("preview returns all rows with parsed fields, no DB writes", async () => {
    const { jwt } = await createUserWithFarm();
    const buffer = await buildExcelBuffer([
      ["CH1234", "Rosa", "weiblich", "2021-06-15", "milch"],
      ["CH5678", "Bruno", "bock", "2020-03-01"],
    ]);

    const res = await uploadExcel("/v1/animals/import/preview", buffer, { skipHeaderRow: "true" }, jwt);
    expect(res.status).toBe(200);

    const body = (await res.json()) as { data: { rows: unknown[] } };
    const rows = body.data.rows as Array<{
      rowNumber: number;
      earTagNumber: string | null;
      earTagId: string | null;
      earTagAssigned: boolean;
      name: string | null;
      sex: string | null;
      dateOfBirth: string | null;
      usage: string | null;
      parseErrors: string[];
    }>;
    expect(rows).toHaveLength(2);

    const rosa = rows[0];
    expect(rosa.name).toBe("Rosa");
    expect(rosa.sex).toBe("female");
    expect(rosa.usage).toBe("milk");
    expect(rosa.earTagNumber).toBe("CH1234");
    expect(rosa.earTagId).toBeNull(); // no existing ear tag in DB
    expect(rosa.earTagAssigned).toBe(false);
    expect(rosa.parseErrors).toHaveLength(0);

    const bruno = rows[1];
    expect(bruno.name).toBe("Bruno");
    expect(bruno.sex).toBe("male");
    expect(bruno.usage).toBe("other"); // no usage column value → default
    expect(bruno.parseErrors).toHaveLength(0);

    // No animals created
    const db = getAdminDb();
    expect(await db.query.animals.findMany({})).toHaveLength(0);
  });

  it("preview populates parseErrors for invalid rows", async () => {
    const { jwt } = await createUserWithFarm();
    const buffer = await buildExcelBuffer([
      ["", "", "", ""], // name + sex + dob missing
      ["CH1", "Bella", "komisch", "2020-01-01"], // unknown sex
    ]);

    const res = await uploadExcel("/v1/animals/import/preview", buffer, { skipHeaderRow: "true" }, jwt);
    expect(res.status).toBe(200);

    const body = (await res.json()) as { data: { rows: unknown[] } };
    const rows = body.data.rows as Array<{ parseErrors: string[] }>;
    expect(rows[0].parseErrors).toHaveLength(3); // name + sex + dob all missing
    expect(rows[1].parseErrors).toHaveLength(1);
    expect(rows[1].parseErrors[0]).toMatch(/komisch/);
  });

  it("preview marks earTagAssigned=true when ear tag belongs to another animal", async () => {
    const { jwt } = await createUserWithFarm();
    // Create an animal that already holds ear tag CH999
    const existing = await createAnimal(jwt, { name: "Taken" });
    const db = getAdminDb();
    const [earTag] = await db.insert(schema.earTags).values({ farmId: existing.farmId, number: "CH999" }).returning();
    await db.update(schema.animals).set({ earTagId: earTag.id }).where(eq(schema.animals.id, existing.id));

    const buffer = await buildExcelBuffer([["CH999", "New", "weiblich", "2022-01-01"]]);
    const res = await uploadExcel("/v1/animals/import/preview", buffer, { skipHeaderRow: "true" }, jwt);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      data: {
        rows: Array<{
          earTagAssigned: boolean;
          assignedToAnimalId: string | null;
          assignedToAnimalName: string | null;
        }>;
      };
    };
    expect(body.data.rows[0].earTagAssigned).toBe(true);
    expect(body.data.rows[0].assignedToAnimalId).toBe(existing.id);
    expect(body.data.rows[0].assignedToAnimalName).toBe("Taken");
  });

  it("commit creates new animals and returns correct counts", async () => {
    const { jwt } = await createUserWithFarm();
    const res = await request(
      "POST",
      "/v1/animals/import/commit",
      {
        type: "goat",
        rows: [
          { name: "Rosa", sex: "female", dateOfBirth: "2021-06-15", usage: "milk", earTagNumber: "CH100" },
          { name: "Bruno", sex: "male", dateOfBirth: "2020-03-01", usage: "other" },
        ],
      },
      jwt
    );
    expect(res.status).toBe(200);

    const body = (await res.json()) as { data: { created: number; merged: number } };
    expect(body.data.created).toBe(2);
    expect(body.data.merged).toBe(0);

    // Verify DB
    const db = getAdminDb();
    const animals = await db.query.animals.findMany({ with: { earTag: true } });
    expect(animals).toHaveLength(2);
    const rosa = animals.find((a) => a.name === "Rosa")!;
    expect(rosa.sex).toBe("female");
    expect(rosa.type).toBe("goat");
    expect(rosa.earTag?.number).toBe("CH100");
    const bruno = animals.find((a) => a.name === "Bruno")!;
    expect(bruno.earTag).toBeNull();
  });

  it("commit merges into existing animal, overwrites imported fields only", async () => {
    const { jwt } = await createUserWithFarm();
    const existing = await createAnimal(jwt, {
      name: "OldName",
      type: "cow",
      sex: "female",
      dateOfBirth: "2018-01-01",
      usage: "milk",
    });

    const res = await request(
      "POST",
      "/v1/animals/import/commit",
      {
        type: "cow",
        rows: [
          {
            name: "UpdatedName",
            sex: "female",
            dateOfBirth: "2019-05-10",
            usage: "other",
            earTagNumber: "CH200",
            mergeAnimalId: existing.id,
          },
        ],
      },
      jwt
    );
    expect(res.status).toBe(200);

    const body = (await res.json()) as { data: { created: number; merged: number } };
    expect(body.data.created).toBe(0);
    expect(body.data.merged).toBe(1);

    // Imported fields were overwritten
    const db = getAdminDb();
    const updated = await db.query.animals.findFirst({
      where: { id: existing.id },
      with: { earTag: true },
    });
    expect(updated!.name).toBe("UpdatedName");
    expect(updated!.usage).toBe("other");
    expect(updated!.earTag?.number).toBe("CH200");
    // type was NOT in the imported fields — still the original (cow)
    expect(updated!.type).toBe("cow");

    // No new animal was created
    expect(await db.query.animals.findMany({})).toHaveLength(1);
  });

  it("commit skips create row when ear tag is already assigned, still creates others", async () => {
    const { jwt } = await createUserWithFarm();
    // Assign CH300 to an existing animal
    const existing = await createAnimal(jwt, { name: "Holder" });
    const db = getAdminDb();
    const [earTag] = await db.insert(schema.earTags).values({ farmId: existing.farmId, number: "CH300" }).returning();
    await db.update(schema.animals).set({ earTagId: earTag.id }).where(eq(schema.animals.id, existing.id));

    const res = await request(
      "POST",
      "/v1/animals/import/commit",
      {
        type: "goat",
        rows: [
          // This row should be skipped — CH300 already taken
          { name: "Conflict", sex: "female", dateOfBirth: "2021-01-01", usage: "other", earTagNumber: "CH300" },
          // This row should succeed
          { name: "Clean", sex: "male", dateOfBirth: "2021-01-01", usage: "other" },
        ],
      },
      jwt
    );
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      data: { created: number; merged: number; skipped: Array<{ index: number; reason: string }> };
    };
    expect(body.data.created).toBe(1); // only "Clean" created
    expect(body.data.merged).toBe(0);
    expect(body.data.skipped).toHaveLength(1);
    expect(body.data.skipped[0].index).toBe(0);
    expect(body.data.skipped[0].reason).toMatch(/CH300/);

    const allAnimals = await db.query.animals.findMany({});
    expect(allAnimals).toHaveLength(2); // Holder + Clean (Conflict was skipped)
    expect(allAnimals.find((a) => a.name === "Conflict")).toBeUndefined();
  });

  it("preview parses dateOfDeath, motherEarTagNumber, fatherEarTagNumber when columns are present", async () => {
    const { jwt } = await createUserWithFarm();
    // Build excel with the extra TVD columns
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Tiere");
    sheet.addRow([
      "Ohrmarkennummer",
      "Tiername",
      "Geschlecht",
      "Geburtsdatum",
      "Nutzungsart",
      "Todesdatum",
      "Ohrmarkennummer (Mutter)",
      "Ohrmarkennummer (Vater)",
    ]);
    sheet.addRow(["CH500", "Zora", "weiblich", "2019-04-10", "milch", "2023-11-01", "CH501", "CH502"]);
    sheet.addRow(["CH501", "Mama", "weiblich", "2016-01-01", "", "", "", ""]); // no death, no parents
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());

    const res = await uploadExcel("/v1/animals/import/preview", buffer, { skipHeaderRow: "true" }, jwt);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      data: {
        rows: Array<{
          earTagNumber: string | null;
          name: string | null;
          dateOfDeath: string | null;
          motherEarTagNumber: string | null;
          fatherEarTagNumber: string | null;
          parseErrors: string[];
        }>;
      };
    };
    const rows = body.data.rows;
    expect(rows).toHaveLength(2);

    const zora = rows[0];
    expect(zora.name).toBe("Zora");
    expect(zora.dateOfDeath).toMatch(/^2023-11-01/);
    expect(zora.motherEarTagNumber).toBe("CH501");
    expect(zora.fatherEarTagNumber).toBe("CH502");
    expect(zora.parseErrors).toHaveLength(0);

    const mama = rows[1];
    expect(mama.dateOfDeath).toBeNull();
    expect(mama.motherEarTagNumber).toBeNull();
    expect(mama.fatherEarTagNumber).toBeNull();
  });

  it("preview resolves columns from another locale's headers, not just the request locale", async () => {
    const { jwt } = await createUserWithFarm();
    // Mix German and French headers in one file — TVD exports aren't always consistent.
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Tiere");
    sheet.addRow(["Ohrmarkennummer", "Nom", "Sexe", "Geburtsdatum"]);
    sheet.addRow(["CH700", "Gustav", "männlich", "2021-02-10"]);
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());

    // Request locale defaults to "de", but "Nom"/"Sexe" only exist in the French header map.
    const res = await uploadExcel("/v1/animals/import/preview", buffer, { skipHeaderRow: "true" }, jwt);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      data: { rows: Array<{ earTagNumber: string | null; name: string | null; sex: string | null }> };
    };
    expect(body.data.rows).toHaveLength(1);
    expect(body.data.rows[0].earTagNumber).toBe("CH700");
    expect(body.data.rows[0].name).toBe("Gustav");
    expect(body.data.rows[0].sex).toBe("male");
  });

  it("preview still fails when a column is missing in every supported locale", async () => {
    const { jwt } = await createUserWithFarm();
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Tiere");
    // "dateOfBirth" column missing under any locale's header name, plus an unrecognized extra column.
    sheet.addRow(["Ohrmarkennummer", "Tiername", "Geschlecht", "Herkunftsland"]);
    sheet.addRow(["CH800", "Hans", "männlich", "CH"]);
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());

    const res = await uploadExcel("/v1/animals/import/preview", buffer, { skipHeaderRow: "true" }, jwt);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('"Geburtsdatum"');
  });

  it("preview names the missing columns in the request locale", async () => {
    const { jwt } = await createUserWithFarm();
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Tiere");
    // Only the optional columns were picked in the TVD export, the standard ones are missing.
    sheet.addRow([
      "Numero di marca auricolare",
      "Data del decesso",
      "Numero di marca auricolare (madre)",
      "Numero di marca auricolare (padre)",
    ]);
    sheet.addRow(["CH900", "", "CH901", "CH902"]);
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());

    const res = await uploadExcel("/v1/animals/import/preview", buffer, { skipHeaderRow: "true" }, jwt, {
      "Accept-Language": "it",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe(
      `Nel file mancano colonne obbligatorie: "Nome", "Sesso", "Data di nascita". Creare il file nella TVD tramite «Esportare i dati» e caricarlo senza modificarlo.`
    );
  });

  it("preview reads the TVD 'Daten exportieren' format (prefixed namespace, no cell references)", async () => {
    const { jwt } = await createUserWithFarm();
    const buffer = await buildTvdExportBuffer([
      ["CH910", "Biala", "05.12.2023", "weiblich", "Engadinerschaf", "OK", ""],
      ["CH911", "Donnat", "20.10.2025", "männlich", "Engadinerschaf", "fehlerhaft", "13.05.2026"],
    ]);

    const res = await uploadExcel("/v1/animals/import/preview", buffer, { skipHeaderRow: "true" }, jwt);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        rows: Array<{
          earTagNumber: string | null;
          name: string | null;
          sex: string | null;
          dateOfBirth: string | null;
          dateOfDeath: string | null;
          parseErrors: string[];
        }>;
      };
    };
    expect(body.data.rows).toHaveLength(2);
    expect(body.data.rows[0]).toMatchObject({
      earTagNumber: "CH910",
      name: "Biala",
      sex: "female",
      dateOfBirth: "2023-12-05T00:00:00.000Z",
      dateOfDeath: null,
      parseErrors: [],
    });
    expect(body.data.rows[1]).toMatchObject({
      earTagNumber: "CH911",
      name: "Donnat",
      sex: "male",
      // The "Bestandsverlauf" variant of the export also lists animals that have left the farm.
      dateOfDeath: "2026-05-13T00:00:00.000Z",
    });
  });

  it("one-step import reads the TVD 'Daten exportieren' format", async () => {
    const { jwt } = await createUserWithFarm();
    const buffer = await buildTvdExportBuffer([
      ["CH920", "Samira", "06.01.2026", "weiblich", "Engadinerschaf", "OK", ""],
    ]);

    const res = await uploadExcel("/v1/animals/import", buffer, { skipHeaderRow: "true", type: "sheep" }, jwt);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { summary: { imported: number; skipped: number } } };
    expect(body.data.summary).toMatchObject({ imported: 1, skipped: 0 });
  });

  it("imports parents from the TVD 'Abstammung' view of the export", async () => {
    const { jwt } = await createUserWithFarm();
    const buffer = await buildTvdExportBuffer(
      [
        ["CH930", "Mama", "01.02.2018", "weiblich", "Capra Grigia", "", "", "", "", "", ""],
        [
          "CH931",
          "Kitz",
          "03.03.2025",
          "weiblich",
          "Kreuzung",
          "CH930",
          "Mama",
          "Capra Grigia",
          "CH999",
          "Bock",
          "andere",
        ],
      ],
      TVD_PEDIGREE_HEADER
    );

    const previewRes = await uploadExcel("/v1/animals/import/preview", buffer, { skipHeaderRow: "true" }, jwt);
    expect(previewRes.status).toBe(200);
    const previewBody = (await previewRes.json()) as {
      data: {
        rows: Array<{ name: string | null; motherEarTagNumber: string | null; fatherEarTagNumber: string | null }>;
      };
    };
    const rows = previewBody.data.rows;
    expect(rows[1]).toMatchObject({ name: "Kitz", motherEarTagNumber: "CH930", fatherEarTagNumber: "CH999" });

    const commitRes = await request("POST", "/v1/animals/import/commit", { type: "goat", rows }, jwt);
    expect(commitRes.status).toBe(200);

    const db = getAdminDb();
    const mother = await db.query.animals.findFirst({ where: { name: "Mama" } });
    const kid = await db.query.animals.findFirst({ where: { name: "Kitz" } });
    expect(kid!.motherId).toBe(mother!.id);
  });

  it("preview reads the French 'ascendance' export headers", async () => {
    const { jwt } = await createUserWithFarm();
    const buffer = await buildTvdExportBuffer(
      [["CH940", "Neige", "10.04.2024", "femelle", "Mouton", "CH941", "Mère", "Mouton", "CH942", "Père", "Mouton"]],
      [
        // The real export separates "No" and "de" with a non-breaking space.
        "No\u00a0de marque auriculaire",
        "Nom",
        "Date de naissance",
        "Sexe",
        "Race",
        "No marque auriculaire (mère)",
        "Nom (mère)",
        "Race (mère)",
        "No marque auriculaire (père)",
        "Nom (père)",
        "Race (père)",
      ]
    );

    const res = await uploadExcel("/v1/animals/import/preview", buffer, { skipHeaderRow: "true" }, jwt, {
      "Accept-Language": "fr",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { rows: Array<Record<string, unknown>> };
    };
    expect(body.data.rows[0]).toMatchObject({
      earTagNumber: "CH940",
      name: "Neige",
      sex: "female",
      motherEarTagNumber: "CH941",
      fatherEarTagNumber: "CH942",
    });
  });

  it("preview reads the Italian 'panoramica' export headers", async () => {
    const { jwt } = await createUserWithFarm();
    const buffer = await buildTvdExportBuffer(
      [["CH950", "Bianca", "05.12.2023", "femmina", "Pecora", "OK", "13.05.2026"]],
      ["Numero marca auricolare", "Nome", "Data di nascita", "Sesso", "Razza", "Storia dell’animale", "Data di morte"]
    );

    const res = await uploadExcel("/v1/animals/import/preview", buffer, { skipHeaderRow: "true" }, jwt, {
      "Accept-Language": "it",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { rows: Array<Record<string, unknown>> };
    };
    expect(body.data.rows[0]).toMatchObject({
      earTagNumber: "CH950",
      name: "Bianca",
      sex: "female",
      dateOfDeath: "2026-05-13T00:00:00.000Z",
    });
  });

  it("preview rejects a file that is not an Excel workbook with a localized 400", async () => {
    const { jwt } = await createUserWithFarm();
    const res = await uploadExcel("/v1/animals/import/preview", Buffer.from("not a workbook"), {}, jwt);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe(
      "Die Datei konnte nicht gelesen werden. Bitte die Excel-Datei aus der TVD unverändert hochladen."
    );
  });

  it("full two-phase flow: preview then commit", async () => {
    const { jwt } = await createUserWithFarm();
    const buffer = await buildExcelBuffer([["CH400", "Liesel", "weiblich", "2022-09-01", "milch"]]);

    // Phase 1: preview
    const previewRes = await uploadExcel("/v1/animals/import/preview", buffer, { skipHeaderRow: "true" }, jwt);
    expect(previewRes.status).toBe(200);
    const previewBody = (await previewRes.json()) as {
      data: {
        rows: Array<{
          earTagNumber: string | null;
          earTagId: string | null;
          name: string | null;
          sex: string | null;
          dateOfBirth: string | null;
          usage: string | null;
          parseErrors: string[];
        }>;
      };
    };
    const [row] = previewBody.data.rows;
    expect(row.parseErrors).toHaveLength(0);
    expect(row.name).toBe("Liesel");

    // Phase 2: commit (user may have edited the row before submitting)
    const commitRes = await request(
      "POST",
      "/v1/animals/import/commit",
      {
        type: "goat",
        rows: [
          {
            earTagNumber: row.earTagNumber,
            earTagId: row.earTagId,
            name: "Liesel (edited)",
            sex: row.sex,
            dateOfBirth: row.dateOfBirth,
            usage: row.usage,
          },
        ],
      },
      jwt
    );
    expect(commitRes.status).toBe(200);

    const commitBody = (await commitRes.json()) as { data: { created: number; merged: number } };
    expect(commitBody.data.created).toBe(1);

    const db = getAdminDb();
    const animal = await db.query.animals.findFirst({ with: { earTag: true } });
    expect(animal!.name).toBe("Liesel (edited)");
    expect(animal!.earTag?.number).toBe("CH400");
  });
});

// ---------------------------------------------------------------------------
// Animal import — dateOfDeath and parent resolution
// ---------------------------------------------------------------------------
describe("Animal import — dateOfDeath and parent resolution", () => {
  beforeEach(cleanDb);

  it("commit sets dateOfDeath and deathReason=died on create", async () => {
    const { jwt } = await createUserWithFarm();
    const res = await request(
      "POST",
      "/v1/animals/import/commit",
      {
        type: "goat",
        rows: [{ name: "Dead", sex: "female", dateOfBirth: "2019-01-01", usage: "other", dateOfDeath: "2023-06-15" }],
      },
      jwt
    );
    expect(res.status).toBe(200);

    const db = getAdminDb();
    const animal = await db.query.animals.findFirst({ where: { name: "Dead" } });
    expect(animal!.dateOfDeath).toEqual(new Date("2023-06-15"));
    expect(animal!.deathReason).toBe("died");
  });

  it("commit sets dateOfDeath and deathReason=died on merge", async () => {
    const { jwt } = await createUserWithFarm();
    const existing = await createAnimal(jwt, { name: "Alive", dateOfBirth: "2019-01-01" });

    const res = await request(
      "POST",
      "/v1/animals/import/commit",
      {
        type: "goat",
        rows: [
          {
            name: "Alive",
            sex: "female",
            dateOfBirth: "2019-01-01",
            usage: "other",
            dateOfDeath: "2024-02-20",
            mergeAnimalId: existing.id,
          },
        ],
      },
      jwt
    );
    expect(res.status).toBe(200);

    const db = getAdminDb();
    const updated = await db.query.animals.findFirst({ where: { id: existing.id } });
    expect(updated!.dateOfDeath).toEqual(new Date("2024-02-20"));
    expect(updated!.deathReason).toBe("died");
  });

  it("commit resolves mother from existing DB animal by ear tag", async () => {
    const { jwt, farmId } = await createUserWithFarm();
    // Create mother animal in DB with an ear tag
    const db = getAdminDb();
    const [motherTag] = await db.insert(schema.earTags).values({ farmId, number: "MOM001" }).returning();
    const [mother] = await db
      .insert(schema.animals)
      .values({
        farmId,
        name: "Mama",
        type: "goat",
        sex: "female",
        dateOfBirth: new Date("2015-01-01"),
        usage: "other",
        earTagId: motherTag.id,
        registered: true,
      })
      .returning();

    const res = await request(
      "POST",
      "/v1/animals/import/commit",
      {
        type: "goat",
        rows: [
          {
            name: "Offspring",
            sex: "female",
            dateOfBirth: "2022-05-01",
            usage: "other",
            earTagNumber: "OFF001",
            motherEarTagNumber: "MOM001",
          },
        ],
      },
      jwt
    );
    expect(res.status).toBe(200);

    const offspring = await db.query.animals.findFirst({ where: { name: "Offspring" } });
    expect(offspring!.motherId).toBe(mother.id);
    expect(offspring!.fatherId).toBeNull();
  });

  it("commit resolves mother from another animal created in the same import batch", async () => {
    const { jwt } = await createUserWithFarm();
    const res = await request(
      "POST",
      "/v1/animals/import/commit",
      {
        type: "goat",
        rows: [
          // Mother is in the same batch
          { name: "BatchMom", sex: "female", dateOfBirth: "2015-03-01", usage: "other", earTagNumber: "BMOM" },
          {
            name: "BatchKid",
            sex: "female",
            dateOfBirth: "2022-07-01",
            usage: "other",
            earTagNumber: "BKID",
            motherEarTagNumber: "BMOM",
          },
        ],
      },
      jwt
    );
    expect(res.status).toBe(200);

    const db = getAdminDb();
    const mom = await db.query.animals.findFirst({ where: { name: "BatchMom" } });
    const kid = await db.query.animals.findFirst({ where: { name: "BatchKid" } });
    expect(kid!.motherId).toBe(mom!.id);
  });

  it("commit silently skips parent assignment when ear tag cannot be resolved", async () => {
    const { jwt } = await createUserWithFarm();
    const res = await request(
      "POST",
      "/v1/animals/import/commit",
      {
        type: "goat",
        rows: [
          {
            name: "Orphan",
            sex: "female",
            dateOfBirth: "2022-01-01",
            usage: "other",
            motherEarTagNumber: "NONEXISTENT",
          },
        ],
      },
      jwt
    );
    expect(res.status).toBe(200);

    const db = getAdminDb();
    const animal = await db.query.animals.findFirst({ where: { name: "Orphan" } });
    // Animal was still created, just no parent set
    expect(animal).toBeDefined();
    expect(animal!.motherId).toBeNull();
  });
});
