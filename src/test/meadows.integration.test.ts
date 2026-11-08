import { describe, it, expect, beforeEach } from "@jest/globals";
import ExcelJS from "exceljs";
import { eq } from "drizzle-orm";

import { cleanDb, getAdminDb, request } from "./helpers";
import * as schema from "../db/schema";
import { createAnimal, createHerd, createOutdoorSchedule, createUserWithFarm } from "./test-utils";

function square(minLng: number, minLat: number, edge = 0.01) {
  return {
    type: "MultiPolygon" as const,
    coordinates: [
      [
        [
          [minLng, minLat],
          [minLng + edge, minLat],
          [minLng + edge, minLat + edge],
          [minLng, minLat + edge],
          [minLng, minLat],
        ],
      ],
    ],
  };
}

type MeadowResponse = {
  id: string;
  name: string;
  size: number;
  geometry: { type: string; coordinates: number[][][][] };
};

async function createMeadow(jwt: string, payload: Record<string, unknown>) {
  const res = await request("POST", "/v1/meadows", payload, jwt);
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: MeadowResponse }).data;
}

// ---------------------------------------------------------------------------
// Meadows CRUD
// ---------------------------------------------------------------------------
describe("Meadows CRUD", () => {
  beforeEach(cleanDb);

  it("creates a meadow from a geometry and computes its size", async () => {
    const { jwt, farmId } = await createUserWithFarm();
    const smallMeadow = await createMeadow(jwt, { name: "Small", geometry: square(8.0, 47.0) });
    const meadow = await createMeadow(jwt, {
      name: "Weide Nord",
      geometry: square(8.1, 47.0, 0.02),
      additionalNotes: "steep",
    });

    expect(meadow.name).toBe("Weide Nord");
    expect(meadow.geometry.type).toBe("MultiPolygon");
    expect(meadow.geometry.coordinates[0][0][0]).toEqual([8.1, 47.0]);
    // Doubling the edge length quadruples the area
    expect(meadow.size).toBeGreaterThan(smallMeadow.size * 3.95);
    expect(meadow.size).toBeLessThan(smallMeadow.size * 4.05);

    const db = getAdminDb();
    const dbMeadow = await db.query.meadows.findFirst({ where: { id: meadow.id } });
    expect(dbMeadow!.farmId).toBe(farmId);
    expect(dbMeadow!.additionalNotes).toBe("steep");

    const listRes = await request("GET", "/v1/meadows", undefined, jwt);
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as { data: { count: number; result: MeadowResponse[] } };
    expect(listBody.data.count).toBe(2);

    const getRes = await request("GET", `/v1/meadows/byId/${meadow.id}`, undefined, jwt);
    expect(getRes.status).toBe(200);
  });

  it("rejects a meadow without geometry", async () => {
    const { jwt } = await createUserWithFarm();
    const res = await request("POST", "/v1/meadows", { name: "Nothing" }, jwt);
    expect(res.status).toBe(400);
  });

  it("updates name and geometry, recomputing the size", async () => {
    const { jwt } = await createUserWithFarm();
    const meadow = await createMeadow(jwt, { name: "M", geometry: square(8.0, 47.0) });

    const renameRes = await request("PATCH", `/v1/meadows/byId/${meadow.id}`, { name: "M2" }, jwt);
    expect(renameRes.status).toBe(200);
    const renamed = ((await renameRes.json()) as { data: MeadowResponse }).data;
    expect(renamed.name).toBe("M2");
    expect(renamed.size).toBe(meadow.size);

    const reshapeRes = await request(
      "PATCH",
      `/v1/meadows/byId/${meadow.id}`,
      { geometry: square(8.0, 47.0, 0.02) },
      jwt
    );
    expect(reshapeRes.status).toBe(200);
    const reshaped = ((await reshapeRes.json()) as { data: MeadowResponse }).data;
    expect(reshaped.name).toBe("M2");
    expect(reshaped.size).toBeGreaterThan(meadow.size * 3.95);
  });

  it("deleting a meadow deletes its outdoor schedules", async () => {
    const { jwt } = await createUserWithFarm();
    const meadow = await createMeadow(jwt, { name: "M", geometry: square(8.0, 47.0) });
    const herd = await createHerd(jwt);
    const scheduleRes = await request(
      "POST",
      `/v1/animals/herds/byId/${herd.id}/outdoorSchedules`,
      { startDate: "2025-05-01", endDate: "2025-05-31", type: "pasture", meadowId: meadow.id },
      jwt
    );
    expect(scheduleRes.status).toBe(200);
    const schedule = (
      (await scheduleRes.json()) as { data: { id: string; meadowId: string; meadow: { name: string } } }
    ).data;
    expect(schedule.meadowId).toBe(meadow.id);
    expect(schedule.meadow.name).toBe("M");

    const deleteRes = await request("DELETE", `/v1/meadows/byId/${meadow.id}`, undefined, jwt);
    expect(deleteRes.status).toBe(200);

    const db = getAdminDb();
    const dbSchedule = await db.query.outdoorSchedules.findFirst({ where: { id: schedule.id } });
    expect(dbSchedule).toBeUndefined();
    const dbRecurrences = await db.query.outdoorScheduleRecurrences.findMany({
      where: { outdoorScheduleId: schedule.id },
    });
    expect(dbRecurrences).toHaveLength(0);
  });

  it("archiving a meadow hides it from the list but keeps its schedules", async () => {
    const { jwt } = await createUserWithFarm();
    const meadow = await createMeadow(jwt, { name: "M", geometry: square(8.0, 47.0) });
    await createMeadow(jwt, { name: "N", geometry: square(8.1, 47.0) });
    const herd = await createHerd(jwt);
    const scheduleRes = await request(
      "POST",
      `/v1/animals/herds/byId/${herd.id}/outdoorSchedules`,
      { startDate: "2025-05-01", endDate: "2025-05-31", type: "pasture", meadowId: meadow.id },
      jwt
    );
    expect(scheduleRes.status).toBe(200);
    const schedule = ((await scheduleRes.json()) as { data: { id: string } }).data;

    const archiveRes = await request("PATCH", `/v1/meadows/byId/${meadow.id}`, { archived: true }, jwt);
    expect(archiveRes.status).toBe(200);
    const archived = ((await archiveRes.json()) as { data: { archivedAt: string | null } }).data;
    expect(archived.archivedAt).not.toBeNull();

    const listRes = await request("GET", "/v1/meadows", undefined, jwt);
    const list = ((await listRes.json()) as { data: { result: MeadowResponse[] } }).data.result;
    expect(list.map((listedMeadow) => listedMeadow.name)).toEqual(["N"]);

    const listAllRes = await request("GET", "/v1/meadows?includeArchived=true", undefined, jwt);
    const listAll = ((await listAllRes.json()) as { data: { result: MeadowResponse[] } }).data.result;
    expect(listAll.map((listedMeadow) => listedMeadow.name)).toEqual(["M", "N"]);

    const db = getAdminDb();
    const dbSchedule = await db.query.outdoorSchedules.findFirst({ where: { id: schedule.id } });
    expect(dbSchedule!.meadowId).toBe(meadow.id);

    const unarchiveRes = await request("PATCH", `/v1/meadows/byId/${meadow.id}`, { archived: false }, jwt);
    const unarchived = ((await unarchiveRes.json()) as { data: { archivedAt: string | null } }).data;
    expect(unarchived.archivedAt).toBeNull();
  });
});

describe("Archiving meadows with outdoor schedules", () => {
  beforeEach(cleanDb);

  async function addSchedule(jwt: string, herdId: string, payload: Record<string, unknown>) {
    return request("POST", `/v1/animals/herds/byId/${herdId}/outdoorSchedules`, payload, jwt);
  }

  it("blocks archiving while an open-ended schedule runs on the meadow", async () => {
    const { jwt } = await createUserWithFarm();
    const meadow = await createMeadow(jwt, { name: "M", geometry: square(8.0, 47.0) });
    const herd = await createHerd(jwt);
    const scheduleRes = await addSchedule(jwt, herd.id, {
      startDate: "2025-05-01",
      type: "pasture",
      meadowId: meadow.id,
    });
    expect(scheduleRes.status).toBe(200);

    const archiveRes = await request("PATCH", `/v1/meadows/byId/${meadow.id}`, { archived: true }, jwt);
    expect(archiveRes.status).toBe(409);
  });

  it("blocks archiving while a recurring schedule has upcoming occurrences", async () => {
    const { jwt } = await createUserWithFarm();
    const meadow = await createMeadow(jwt, { name: "M", geometry: square(8.0, 47.0) });
    const herd = await createHerd(jwt);
    const scheduleRes = await addSchedule(jwt, herd.id, {
      startDate: "2024-05-01",
      endDate: "2024-05-31",
      type: "pasture",
      meadowId: meadow.id,
      recurrence: { frequency: "yearly", interval: 1 },
    });
    expect(scheduleRes.status).toBe(200);

    const archiveRes = await request("PATCH", `/v1/meadows/byId/${meadow.id}`, { archived: true }, jwt);
    expect(archiveRes.status).toBe(409);
  });

  it("rejects new schedules on an archived meadow but keeps existing links when re-saving", async () => {
    const { jwt } = await createUserWithFarm();
    const meadow = await createMeadow(jwt, { name: "M", geometry: square(8.0, 47.0) });
    const otherMeadow = await createMeadow(jwt, { name: "N", geometry: square(8.1, 47.0) });
    const herd = await createHerd(jwt);
    const pastSchedule = { startDate: "2025-05-01", endDate: "2025-05-31", type: "pasture", meadowId: meadow.id };
    const scheduleRes = await addSchedule(jwt, herd.id, pastSchedule);
    expect(scheduleRes.status).toBe(200);
    const schedule = ((await scheduleRes.json()) as { data: { id: string } }).data;

    const archiveRes = await request("PATCH", `/v1/meadows/byId/${meadow.id}`, { archived: true }, jwt);
    expect(archiveRes.status).toBe(200);

    const newScheduleRes = await addSchedule(jwt, herd.id, {
      startDate: "2025-07-01",
      endDate: "2025-07-31",
      type: "pasture",
      meadowId: meadow.id,
    });
    expect(newScheduleRes.status).toBe(400);

    // Updating the existing schedule without changing its meadow still works
    const updateRes = await request(
      "PATCH",
      `/v1/animals/herds/outdoorSchedules/byId/${schedule.id}`,
      { notes: "dry", meadowId: meadow.id },
      jwt
    );
    expect(updateRes.status).toBe(200);

    // Re-saving the herd with its schedules keeps the link to the archived meadow
    const herdRes = await request(
      "PATCH",
      `/v1/animals/herds/byId/${herd.id}`,
      { outdoorSchedules: [pastSchedule] },
      jwt
    );
    expect(herdRes.status).toBe(200);

    // Moving a schedule of another herd onto the archived meadow is rejected
    const otherHerd = await createHerd(jwt, { name: "Other" });
    const otherScheduleRes = await addSchedule(jwt, otherHerd.id, {
      startDate: "2025-05-01",
      endDate: "2025-05-31",
      type: "pasture",
      meadowId: otherMeadow.id,
    });
    const otherSchedule = ((await otherScheduleRes.json()) as { data: { id: string } }).data;
    const moveRes = await request(
      "PATCH",
      `/v1/animals/herds/outdoorSchedules/byId/${otherSchedule.id}`,
      { meadowId: meadow.id },
      jwt
    );
    expect(moveRes.status).toBe(400);
  });
});

describe("Schedules on archived meadows", () => {
  beforeEach(cleanDb);

  it("existing schedules can't be changed to run on or after the archive date", async () => {
    const { jwt } = await createUserWithFarm();
    const meadow = await createMeadow(jwt, { name: "M", geometry: square(8.0, 47.0) });
    const herd = await createHerd(jwt);
    const scheduleRes = await request(
      "POST",
      `/v1/animals/herds/byId/${herd.id}/outdoorSchedules`,
      { startDate: "2025-05-01", endDate: "2025-05-31", type: "pasture", meadowId: meadow.id },
      jwt
    );
    expect(scheduleRes.status).toBe(200);
    const schedule = ((await scheduleRes.json()) as { data: { id: string } }).data;

    // Archived on 1 Aug 2025 (Swiss time)
    await getAdminDb()
      .update(schema.meadows)
      .set({ archivedAt: new Date("2025-08-01T08:00:00Z") })
      .where(eq(schema.meadows.id, meadow.id));
    const scheduleUrl = `/v1/animals/herds/outdoorSchedules/byId/${schedule.id}`;

    const beforeArchiveRes = await request("PATCH", scheduleUrl, { endDate: "2025-07-31" }, jwt);
    expect(beforeArchiveRes.status).toBe(200);

    const onArchiveDayRes = await request("PATCH", scheduleUrl, { endDate: "2025-08-01" }, jwt);
    expect(onArchiveDayRes.status).toBe(400);

    const openEndedRes = await request("PATCH", scheduleUrl, { endDate: null }, jwt);
    expect(openEndedRes.status).toBe(400);

    const yearlyRes = await request("PATCH", scheduleUrl, { recurrence: { frequency: "yearly", interval: 1 } }, jwt);
    expect(yearlyRes.status).toBe(400);

    const notesRes = await request("PATCH", scheduleUrl, { notes: "dry" }, jwt);
    expect(notesRes.status).toBe(200);

    // Same rule when re-saving the herd with its schedules
    const herdUrl = `/v1/animals/herds/byId/${herd.id}`;
    const herdOpenEndedRes = await request(
      "PATCH",
      herdUrl,
      { outdoorSchedules: [{ startDate: "2025-05-01", type: "pasture", meadowId: meadow.id }] },
      jwt
    );
    expect(herdOpenEndedRes.status).toBe(400);
    const herdUnchangedRes = await request(
      "PATCH",
      herdUrl,
      { outdoorSchedules: [{ startDate: "2025-05-01", endDate: "2025-07-31", type: "pasture", meadowId: meadow.id }] },
      jwt
    );
    expect(herdUnchangedRes.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Meadows in outdoor schedules and the outdoor journal
// ---------------------------------------------------------------------------
describe("Meadows in outdoor journal", () => {
  beforeEach(cleanDb);

  it("lists herd/meadow periods in the outdoor journal and the meadow usage endpoint", async () => {
    const { jwt } = await createUserWithFarm();
    const meadow = await createMeadow(jwt, { name: "Weide Süd", geometry: square(8.0, 47.0) });
    const otherMeadow = await createMeadow(jwt, { name: "Andere", geometry: square(8.5, 47.0) });
    const firstSheep = await createAnimal(jwt, {
      type: "sheep",
      sex: "female",
      dateOfBirth: "2020-01-01",
      usage: "other",
    });
    const secondSheep = await createAnimal(jwt, {
      type: "sheep",
      sex: "female",
      dateOfBirth: "2020-01-01",
      usage: "other",
    });
    await createHerd(jwt, {
      name: "Schafe",
      animalIds: [firstSheep.id, secondSheep.id],
      outdoorSchedules: [
        { startDate: "2025-05-01", endDate: "2025-05-15", type: "pasture", meadowId: meadow.id },
        { startDate: "2025-05-16", endDate: "2025-05-31", type: "pasture", meadowId: otherMeadow.id },
        { startDate: "2025-06-01", endDate: "2025-06-30", type: "exercise_yard" },
      ],
    });

    const journalRes = await request(
      "GET",
      "/v1/animals/outdoorJournal?fromDate=2025-01-01&toDate=2025-12-31",
      undefined,
      jwt
    );
    expect(journalRes.status).toBe(200);
    const journalBody = (await journalRes.json()) as {
      data: {
        entries: unknown[];
        meadowEntries: Array<{
          meadowId: string;
          meadowName: string;
          herdName: string;
          startDate: string;
          endDate: string;
          animalCount: number;
          animalCountsByType: Record<string, number>;
        }>;
      };
    };
    expect(journalBody.data.entries.length).toBeGreaterThan(0);
    expect(journalBody.data.meadowEntries).toHaveLength(2);
    const southEntry = journalBody.data.meadowEntries.find((entry) => entry.meadowId === meadow.id)!;
    expect(southEntry.meadowName).toBe("Weide Süd");
    expect(southEntry.herdName).toBe("Schafe");
    expect(southEntry.animalCount).toBe(2);
    expect(southEntry.animalCountsByType).toEqual({ sheep: 2 });
    expect(southEntry.startDate.slice(0, 10)).toBe("2025-05-01");
    expect(southEntry.endDate.slice(0, 10)).toBe("2025-05-15");

    const usageRes = await request(
      "GET",
      `/v1/meadows/byId/${meadow.id}/usage?fromDate=2025-01-01&toDate=2025-12-31`,
      undefined,
      jwt
    );
    expect(usageRes.status).toBe(200);
    const usageBody = (await usageRes.json()) as { data: { result: Array<{ meadowId: string }> } };
    expect(usageBody.data.result).toHaveLength(1);
    expect(usageBody.data.result[0].meadowId).toBe(meadow.id);
  });

  it("updates the meadow of an existing outdoor schedule", async () => {
    const { jwt } = await createUserWithFarm();
    const meadow = await createMeadow(jwt, { name: "M", geometry: square(8.0, 47.0) });
    const herd = await createHerd(jwt);
    const schedule = await createOutdoorSchedule(jwt, herd.id);
    expect(schedule.meadowId).toBeNull();

    const setRes = await request(
      "PATCH",
      `/v1/animals/herds/outdoorSchedules/byId/${schedule.id}`,
      { meadowId: meadow.id },
      jwt
    );
    expect(setRes.status).toBe(200);
    expect(((await setRes.json()) as { data: { meadowId: string } }).data.meadowId).toBe(meadow.id);

    const clearRes = await request(
      "PATCH",
      `/v1/animals/herds/outdoorSchedules/byId/${schedule.id}`,
      { meadowId: null },
      jwt
    );
    expect(clearRes.status).toBe(200);
    expect(((await clearRes.json()) as { data: { meadowId: string | null } }).data.meadowId).toBeNull();
  });

  it("adds a meadow sheet to the outdoor journal Excel report", async () => {
    const { jwt } = await createUserWithFarm();
    const meadow = await createMeadow(jwt, { name: "Weide Ost", geometry: square(8.0, 47.0) });
    const sheep = await createAnimal(jwt, {
      type: "sheep",
      sex: "female",
      dateOfBirth: "2020-01-01",
      usage: "other",
    });
    await createHerd(jwt, {
      name: "Herde A",
      animalIds: [sheep.id],
      outdoorSchedules: [{ startDate: "2025-05-01", endDate: "2025-05-10", type: "pasture", meadowId: meadow.id }],
    });

    const res = await request(
      "POST",
      "/v1/reports/outdoorjournal/download",
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
    const meadowSheet = workbook.worksheets[1];
    expect(meadowSheet).toBeDefined();
    const dataRow = meadowSheet.getRow(2);
    expect(dataRow.getCell(1).value).toBe("Weide Ost");
    expect(dataRow.getCell(3).value).toBe("Herde A");
    expect(dataRow.getCell(7).value).toBe(10);
    expect(dataRow.getCell(8).value).toBe(1);
  });

  it("adds a meadow sheet to the combined animals report, including yearly repeats", async () => {
    const { jwt } = await createUserWithFarm();
    const meadow = await createMeadow(jwt, { name: "Weide Ost", geometry: square(8.0, 47.0) });
    const sheep = await createAnimal(jwt, {
      type: "sheep",
      sex: "female",
      dateOfBirth: "2020-01-01",
      usage: "other",
    });
    await createHerd(jwt, {
      name: "Herde A",
      animalIds: [sheep.id],
      outdoorSchedules: [
        {
          startDate: "2025-05-01",
          endDate: "2025-05-10",
          type: "pasture",
          meadowId: meadow.id,
          recurrence: { frequency: "yearly", interval: 1 },
        },
      ],
    });

    const res = await request(
      "POST",
      "/v1/reports/animals/download",
      { fromDate: "2026-01-01", toDate: "2026-12-31", generateTreatments: false, generateOutdoorJournal: true },
      jwt
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { base64: string } };

    const workbook = new ExcelJS.Workbook();
    const reportBytes = Buffer.from(body.data.base64, "base64");
    await workbook.xlsx.load(
      reportBytes.buffer.slice(reportBytes.byteOffset, reportBytes.byteOffset + reportBytes.byteLength)
    );
    const meadowSheet = workbook.worksheets[1];
    expect(meadowSheet).toBeDefined();
    const dataRow = meadowSheet.getRow(2);
    expect(dataRow.getCell(1).value).toBe("Weide Ost");
    expect(dataRow.getCell(5).value).toBe(new Date("2026-05-01").toLocaleDateString("de"));
    expect(dataRow.getCell(7).value).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// Multi-farm isolation
// ---------------------------------------------------------------------------
describe("Meadows multi-farm isolation", () => {
  beforeEach(cleanDb);

  it("does not expose or allow referencing another farm's meadows", async () => {
    const { jwt: ownerJwt } = await createUserWithFarm({}, "owner-a@test.com");
    const meadowA = await createMeadow(ownerJwt, { name: "A", geometry: square(8.0, 47.0) });

    const { jwt: otherJwt } = await createUserWithFarm({}, "owner-b@test.com");

    const listRes = await request("GET", "/v1/meadows", undefined, otherJwt);
    const listBody = (await listRes.json()) as { data: { count: number } };
    expect(listBody.data.count).toBe(0);

    const getRes = await request("GET", `/v1/meadows/byId/${meadowA.id}`, undefined, otherJwt);
    expect(getRes.status).toBe(404);

    const patchRes = await request("PATCH", `/v1/meadows/byId/${meadowA.id}`, { name: "Hacked" }, otherJwt);
    expect(patchRes.status).toBe(404);

    const herdB = await createHerd(otherJwt);
    const scheduleRes = await request(
      "POST",
      `/v1/animals/herds/byId/${herdB.id}/outdoorSchedules`,
      { startDate: "2025-05-01", endDate: "2025-05-31", type: "pasture", meadowId: meadowA.id },
      otherJwt
    );
    expect(scheduleRes.status).toBe(400);

    const usageRes = await request(
      "GET",
      `/v1/meadows/byId/${meadowA.id}/usage?fromDate=2025-01-01&toDate=2025-12-31`,
      undefined,
      otherJwt
    );
    expect(usageRes.status).toBe(404);

    await request("DELETE", `/v1/meadows/byId/${meadowA.id}`, undefined, otherJwt);
    const db = getAdminDb();
    const stillThere = await db.query.meadows.findFirst({ where: { id: meadowA.id } });
    expect(stillThere).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Herd membership changes reflected in meadow history
// ---------------------------------------------------------------------------
type MeadowEntry = { meadowId: string; startDate: string; endDate: string; animalCount: number };

async function getMeadowPeriods(jwt: string, meadowId: string) {
  const res = await request("GET", "/v1/animals/outdoorJournal?fromDate=2025-01-01&toDate=2025-12-31", undefined, jwt);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { data: { meadowEntries: MeadowEntry[] } };
  return body.data.meadowEntries
    .filter((entry) => entry.meadowId === meadowId)
    .map((entry) => ({
      from: entry.startDate.slice(0, 10),
      to: entry.endDate.slice(0, 10),
      animals: entry.animalCount,
    }));
}

async function createSheep(jwt: string) {
  return createAnimal(jwt, { type: "sheep", sex: "female", dateOfBirth: "2020-01-01", usage: "other" });
}

describe("Herd membership changes in meadow history", () => {
  beforeEach(cleanDb);

  async function herdOnMeadowInMay(jwt: string, meadowName: string, animalIds: string[]) {
    const meadow = await createMeadow(jwt, { name: meadowName, geometry: square(8.0, 47.0) });
    const herd = await createHerd(jwt, {
      name: `Herd ${meadowName}`,
      animalIds,
      outdoorSchedules: [{ startDate: "2025-05-01", endDate: "2025-05-31", type: "pasture", meadowId: meadow.id }],
    });
    return { meadow, herd };
  }

  it("adding an animal with an effective date raises the count from that day, without a double-counted day", async () => {
    const { jwt } = await createUserWithFarm();
    const [firstSheep, secondSheep, thirdSheep] = [
      await createSheep(jwt),
      await createSheep(jwt),
      await createSheep(jwt),
    ];
    const { meadow, herd } = await herdOnMeadowInMay(jwt, "M", [firstSheep.id, secondSheep.id]);

    const res = await request(
      "PATCH",
      `/v1/animals/herds/byId/${herd.id}`,
      { animalIds: [firstSheep.id, secondSheep.id, thirdSheep.id], effectiveDate: "2025-05-11" },
      jwt
    );
    expect(res.status).toBe(200);

    expect(await getMeadowPeriods(jwt, meadow.id)).toEqual([
      { from: "2025-05-01", to: "2025-05-10", animals: 2 },
      { from: "2025-05-11", to: "2025-05-31", animals: 3 },
    ]);
  });

  it("removing an animal with an effective date lowers the count from that day", async () => {
    const { jwt } = await createUserWithFarm();
    const [firstSheep, secondSheep] = [await createSheep(jwt), await createSheep(jwt)];
    const { meadow, herd } = await herdOnMeadowInMay(jwt, "M", [firstSheep.id, secondSheep.id]);

    const res = await request(
      "PATCH",
      `/v1/animals/herds/byId/${herd.id}`,
      { animalIds: [firstSheep.id], effectiveDate: "2025-05-21" },
      jwt
    );
    expect(res.status).toBe(200);

    expect(await getMeadowPeriods(jwt, meadow.id)).toEqual([
      { from: "2025-05-01", to: "2025-05-20", animals: 2 },
      { from: "2025-05-21", to: "2025-05-31", animals: 1 },
    ]);
    const db = getAdminDb();
    const removedAnimal = await db.query.animals.findFirst({ where: { id: secondSheep.id } });
    expect(removedAnimal!.herdId).toBeNull();
  });

  it("moving an animal between herds on different meadows counts it on each meadow for its own days", async () => {
    const { jwt } = await createUserWithFarm();
    const [movingSheep, stayingSheep, otherSheep] = [
      await createSheep(jwt),
      await createSheep(jwt),
      await createSheep(jwt),
    ];
    const { meadow: northMeadow } = await herdOnMeadowInMay(jwt, "North", [movingSheep.id, stayingSheep.id]);
    const { meadow: southMeadow, herd: southHerd } = await herdOnMeadowInMay(jwt, "South", [otherSheep.id]);

    const res = await request(
      "PATCH",
      `/v1/animals/byId/${movingSheep.id}`,
      { herdId: southHerd.id, herdEffectiveDate: "2025-05-16" },
      jwt
    );
    expect(res.status).toBe(200);

    expect(await getMeadowPeriods(jwt, northMeadow.id)).toEqual([
      { from: "2025-05-01", to: "2025-05-15", animals: 2 },
      { from: "2025-05-16", to: "2025-05-31", animals: 1 },
    ]);
    expect(await getMeadowPeriods(jwt, southMeadow.id)).toEqual([
      { from: "2025-05-01", to: "2025-05-15", animals: 1 },
      { from: "2025-05-16", to: "2025-05-31", animals: 2 },
    ]);
  });

  it("re-saving a herd or an animal without changes keeps memberships untouched", async () => {
    const { jwt } = await createUserWithFarm();
    const [firstSheep, secondSheep] = [await createSheep(jwt), await createSheep(jwt)];
    const { meadow, herd } = await herdOnMeadowInMay(jwt, "M", [firstSheep.id, secondSheep.id]);
    const db = getAdminDb();
    const membershipsBefore = await db.query.herdMemberships.findMany({ orderBy: { id: "asc" } });

    const herdRes = await request(
      "PATCH",
      `/v1/animals/herds/byId/${herd.id}`,
      { name: "Renamed", animalIds: [secondSheep.id, firstSheep.id] },
      jwt
    );
    expect(herdRes.status).toBe(200);
    const animalRes = await request("PATCH", `/v1/animals/byId/${firstSheep.id}`, { herdId: herd.id }, jwt);
    expect(animalRes.status).toBe(200);

    const membershipsAfter = await db.query.herdMemberships.findMany({ orderBy: { id: "asc" } });
    expect(membershipsAfter).toEqual(membershipsBefore);
    expect(await getMeadowPeriods(jwt, meadow.id)).toEqual([{ from: "2025-05-01", to: "2025-05-31", animals: 2 }]);
  });

  it("rejects an effective date before the animal's current membership", async () => {
    const { jwt } = await createUserWithFarm();
    const sheep = await createSheep(jwt);
    await herdOnMeadowInMay(jwt, "North", [sheep.id]);
    const otherHerd = await createHerd(jwt, { name: "Other" });

    const res = await request(
      "PATCH",
      `/v1/animals/byId/${sheep.id}`,
      { herdId: otherHerd.id, herdEffectiveDate: "2025-04-01" },
      jwt
    );
    expect(res.status).toBe(400);

    const db = getAdminDb();
    const unchangedAnimal = await db.query.animals.findFirst({ where: { id: sheep.id } });
    expect(unchangedAnimal!.herdId).not.toBe(otherHerd.id);
  });
  it("reports the earliest herd change date per animal, matching what herd updates accept", async () => {
    const { jwt } = await createUserWithFarm();
    const sheepInHerd = await createSheep(jwt);
    const looseSheep = await createSheep(jwt);
    await herdOnMeadowInMay(jwt, "North", [sheepInHerd.id]);
    const otherHerd = await createHerd(jwt, { name: "Other" });

    const res = await request(
      "GET",
      `/v1/animals/herds/earliestChangeDates?animalIds=${sheepInHerd.id}&animalIds=${looseSheep.id}`,
      undefined,
      jwt
    );
    expect(res.status).toBe(200);
    const { result } = (
      (await res.json()) as {
        data: { result: { animalId: string; earliestDate: string | null }[] };
      }
    ).data;

    // In a herd: the start of its active membership; never in a herd: no limit
    const db = getAdminDb();
    const activeMembership = await db.query.herdMemberships.findFirst({
      where: { animalId: sheepInHerd.id, toDate: { isNull: true } },
    });
    const earliestDate = result.find((entry) => entry.animalId === sheepInHerd.id)!.earliestDate!;
    expect(earliestDate.slice(0, 10)).toBe(activeMembership!.fromDate.toISOString().slice(0, 10));
    expect(result.find((entry) => entry.animalId === looseSheep.id)!.earliestDate).toBeNull();

    // The day before is rejected, the reported day itself is accepted
    const dayBefore = new Date(new Date(earliestDate).getTime() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const rejected = await request(
      "PATCH",
      `/v1/animals/byId/${sheepInHerd.id}`,
      { herdId: otherHerd.id, herdEffectiveDate: dayBefore },
      jwt
    );
    expect(rejected.status).toBe(400);
    const accepted = await request(
      "PATCH",
      `/v1/animals/byId/${sheepInHerd.id}`,
      { herdId: otherHerd.id, herdEffectiveDate: earliestDate.slice(0, 10) },
      jwt
    );
    expect(accepted.status).toBe(200);
  });
});
