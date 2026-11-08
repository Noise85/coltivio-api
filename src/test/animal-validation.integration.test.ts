import { afterAll, beforeEach, describe, expect, it, jest } from "@jest/globals";
import ExcelJS from "exceljs";
import { randomUUID } from "node:crypto";
import i18next from "i18next";
import { jwtDecode } from "jwt-decode";
import en from "../../resources/locales/en.json";
import { animalsApi } from "../animals/animals";
import { disconnect, rlsDb } from "../db/db";
import type { SupabaseToken } from "../supabase/supabase";
import * as schema from "../db/schema";
import { cleanDb, getAdminDb, getAdminSql, rawRequest } from "./helpers";
import { createAnimal, createUserWithFarm } from "./test-utils";

// Each CORE case groups several real HTTP/database checks within one shared test harness.
jest.setTimeout(30_000);

const validAnimal = {
  name: "Control", type: "cow", sex: "female", usage: "other", registered: false, dateOfBirth: "2020-01-01",
};
type AnimalResult = {
  id: string;
  name: string;
  type: string;
  usage: string;
  dateOfBirth: string;
  dateOfDeath: string | null;
  deathReason: "died" | "slaughtered" | "unknown" | null;
  motherId: string | null;
  fatherId: string | null;
};
type CommitResult = { created: number; merged: number; skipped: Array<{ index: number; reason: string }> };
type PreviewRow = {
  rowNumber: number;
  name: string | null;
  earTagNumber: string | null;
  sex: string | null;
  dateOfBirth: string | null;
  usage: string | null;
  dateOfDeath: string | null;
  deathReason: string | null;
  motherEarTagNumber: string | null;
  fatherEarTagNumber: string | null;
  parseErrors: string[];
};

function api(method: string, path: string, body: Record<string, unknown> | undefined, jwt: string, farmId?: string) {
  return rawRequest(method, path, {
    body,
    headers: {
      Authorization: `Bearer ${jwt}`,
      "Accept-Language": "en",
      ...(farmId ? { "x-farm-id": farmId } : {}),
    },
  });
}

async function success<T>(response: Response): Promise<T> {
  const body = await response.json() as { data: T };
  expect(response.status).toBe(200);
  expect(body).toHaveProperty("data");
  // Warnings are a documented future requirement, not a new success contract.
  expect(body).not.toHaveProperty("warnings");
  expect(body.data).not.toHaveProperty("warnings");
  return body.data;
}

async function validationError(response: Response, field: RegExp): Promise<string> {
  const body = await response.json() as { error: string };
  expect(response.status).toBe(400);
  expect(typeof body.error).toBe("string");
  expect(body.error).toMatch(field);
  expect(body.error).not.toMatch(/animal_validation\.|animal_import\./);
  expect(body).not.toHaveProperty("data");
  return body.error;
}

const importHeaders = [
  "Ohrmarkennummer", "Tiername", "Geschlecht", "Geburtsdatum", "Nutzungsart", "Todesdatum",
  "Ohrmarkennummer (Mutter)", "Ohrmarkennummer (Vater)",
];
async function workbook(rows: string[][]): Promise<Buffer> {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet("Tiere");
  sheet.addRow(importHeaders);
  rows.forEach((row) => sheet.addRow(row));
  return Buffer.from(await book.xlsx.writeBuffer());
}

// Same multipart boundary pattern as the existing animal import integration suite.
async function upload(path: string, buffer: Buffer, jwt: string, fields: Record<string, string> = {}) {
  const form = new FormData();
  form.append("file", new Blob([buffer as unknown as ArrayBuffer], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  }), "animals.xlsx");
  Object.entries(fields).forEach(([key, value]) => form.append(key, value));
  return fetch(`${process.env.SERVER_URL!}${path}`, {
    method: "POST", headers: { Authorization: `Bearer ${jwt}`, "Accept-Language": "en" }, body: form,
  });
}

describe("Animal validation — approved CORE integration", () => {
  beforeEach(cleanDb);
  afterAll(async () => {
    // Direct service coverage creates worker-side app connections in addition to HTTP-server pools.
    await Promise.all([disconnect(), getAdminSql().end()]);
  });

  it("CORE1: rejects contradictory species/life data on create and patch without writes, with valid controls", async () => {
    const { jwt } = await createUserWithFarm();
    const db = getAdminDb();
    const invalid: Array<{ patch: Record<string, unknown>; field: RegExp }> = [
      { patch: { type: "pig", usage: "milk" }, field: /usage.*milk/i },
      { patch: { type: "deer", usage: "milk" }, field: /usage.*milk/i },
      { patch: { dateOfBirth: "2999-01-01" }, field: /dateOfBirth/ },
      { patch: { dateOfDeath: "2019-12-31" }, field: /dateOfDeath/ },
      { patch: { deathReason: "died" }, field: /deathReason/ },
    ];
    for (const { patch, field } of invalid) {
      await validationError(await api("POST", "/v1/animals", { ...validAnimal, ...patch }, jwt), field);
      expect(await db.query.animals.findMany({})).toHaveLength(0);
    }
    const control = await success<AnimalResult>(await api("POST", "/v1/animals", validAnimal, jwt));
    const before = await db.query.animals.findFirst({ where: { id: control.id } });
    for (const { patch, field } of invalid) {
      await validationError(await api("PATCH", `/v1/animals/byId/${control.id}`, patch, jwt), field);
      expect(await db.query.animals.findFirst({ where: { id: control.id } })).toEqual(before);
    }
    for (const type of ["pig", "deer"]) {
      await success<AnimalResult>(await api("POST", "/v1/animals", { ...validAnimal, type, usage: "other" }, jwt));
    }
    await success<AnimalResult>(await api("POST", "/v1/animals", { ...validAnimal, usage: "milk" }, jwt));
    const equalDates = await success<AnimalResult>(await api("PATCH", `/v1/animals/byId/${control.id}`, {
      dateOfDeath: "2020-01-01", deathReason: "slaughtered",
    }, jwt));
    expect(equalDates.deathReason).toBe("slaughtered");
    expect(await db.query.animals.findMany({})).toHaveLength(4);
  });

  it("CORE2: validates parent role/species/birth/self and keeps cross-farm references inaccessible under JWT/RLS", async () => {
    const { jwt, farmId } = await createUserWithFarm({}, "animal-owner@test.com");
    const foreign = await createUserWithFarm({}, "animal-foreign@test.com");
    const db = getAdminDb();
    const mother = await createAnimal(jwt, { name: "Mother", dateOfBirth: "2010-01-01", usage: "other" });
    const father = await createAnimal(jwt, { name: "Father", sex: "male", dateOfBirth: "2011-01-01", usage: "other" });
    const goat = await createAnimal(jwt, { type: "goat", dateOfBirth: "2010-01-01", usage: "other" });
    const sameDay = await createAnimal(jwt, { dateOfBirth: "2020-01-01", usage: "other" });
    const younger = await createAnimal(jwt, { dateOfBirth: "2021-01-01", usage: "other" });
    const hidden = await createAnimal(foreign.jwt, { name: "Private parent", dateOfBirth: "2010-01-01", usage: "other" });
    const child = await createAnimal(jwt, { name: "Child", dateOfBirth: "2020-01-01", usage: "other" });
    for (const patch of [
      { motherId: father.id }, { fatherId: mother.id }, { motherId: goat.id },
      { motherId: sameDay.id }, { motherId: younger.id }, { motherId: child.id }, { fatherId: child.id },
    ]) {
      await validationError(await api("PATCH", `/v1/animals/byId/${child.id}`, patch, jwt, farmId), /motherId|fatherId/);
      expect(await db.query.animals.findFirst({ where: { id: child.id } })).toMatchObject({ motherId: null, fatherId: null });
    }
    const error = await validationError(await api("PATCH", `/v1/animals/byId/${child.id}`, { motherId: hidden.id }, jwt, farmId), /accessible.*farm/);
    expect(error).not.toContain(hidden.id);
    expect(error).not.toContain("Private parent");
    await validationError(await api("PATCH", `/v1/animals/byId/${child.id}`, { motherId: randomUUID() }, jwt, farmId), /accessible.*farm/);
    expect((await api("GET", `/v1/animals/byId/${hidden.id}`, undefined, jwt, farmId)).status).toBe(404);
    expect((await api("GET", `/v1/animals/byId/${hidden.id}`, undefined, foreign.jwt, foreign.farmId)).status).toBe(200);
    expect((await api("GET", "/v1/animals", undefined, jwt, foreign.farmId)).status).toBe(403);
    const beforeCount = (await db.query.animals.findMany({})).length;
    await validationError(await api("POST", "/v1/animals", { ...validAnimal, fatherId: mother.id }, jwt), /fatherId/);
    expect(await db.query.animals.findMany({})).toHaveLength(beforeCount);
    const linked = await success<AnimalResult>(await api("PATCH", `/v1/animals/byId/${child.id}`, { motherId: mother.id, fatherId: father.id }, jwt, farmId));
    expect(linked).toMatchObject({ motherId: mother.id, fatherId: father.id });
    expect(await db.query.animals.findFirst({ where: { id: child.id } })).toMatchObject({ motherId: mother.id, fatherId: father.id });
  });

  it("CORE3: both bulk paths reject atomically, honor final parent state, and normalize reasons per target", async () => {
    const { jwt, farmId } = await createUserWithFarm();
    const db = getAdminDb();
    const english = i18next.createInstance();
    await english.init({ lng: "en", fallbackLng: "en", resources: { en: { translation: en } } });
    // The per-animal update service has an exported endpoint definition but no registered HTTP route.
    // Exercise its real selected-farm RLS transaction using the JWT issued by GoTrue, without mocks/admin access.
    const service = animalsApi(rlsDb(jwtDecode<SupabaseToken>(jwt), farmId), english.t);
    const cow = await createAnimal(jwt, { name: "Cow", usage: "other", dateOfBirth: "2020-01-01" });
    const pig = await createAnimal(jwt, { name: "Pig", type: "pig", usage: "other", dateOfBirth: "2020-01-01" });
    await expect(service.updateAnimals([
      { id: cow.id, name: "Must rollback" }, { id: pig.id, usage: "milk" },
    ])).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/usage.*milk/i) });
    expect(await db.query.animals.findFirst({ where: { id: cow.id } })).toMatchObject({ name: "Cow", usage: "other" });
    await validationError(await api("PATCH", "/v1/animals/batch", { animalIds: [cow.id, pig.id], data: { usage: "milk" } }, jwt), /usage.*milk/i);
    expect(await db.query.animals.findFirst({ where: { id: cow.id } })).toMatchObject({ usage: "other" });
    expect(await db.query.animals.findFirst({ where: { id: pig.id } })).toMatchObject({ usage: "other" });

    const parent = await createAnimal(jwt, { name: "Corrected parent", sex: "male", dateOfBirth: "2010-01-01", usage: "other" });
    await expect(service.updateAnimals([
      { id: cow.id, motherId: parent.id }, { id: parent.id, sex: "female" },
    ])).resolves.toHaveLength(2);
    expect(await db.query.animals.findFirst({ where: { id: cow.id } })).toMatchObject({ motherId: parent.id });
    expect(await db.query.animals.findFirst({ where: { id: parent.id } })).toMatchObject({ sex: "female" });

    const known = await createAnimal(jwt, { name: "Known", usage: "other", dateOfDeath: "2023-01-01", deathReason: "slaughtered" });
    const result = await success<{ result: AnimalResult[]; count: number }>(await api("PATCH", "/v1/animals/batch", {
      animalIds: [pig.id, known.id], data: { dateOfDeath: "2024-01-01" },
    }, jwt));
    expect(result.count).toBe(2);
    expect(result.result.find(({ id }) => id === pig.id)?.deathReason).toBe("unknown");
    expect(result.result.find(({ id }) => id === known.id)?.deathReason).toBe("slaughtered");
    expect(await db.query.animals.findFirst({ where: { id: pig.id } })).toMatchObject({ deathReason: "unknown", dateOfDeath: new Date("2024-01-01") });
    expect(await db.query.animals.findFirst({ where: { id: known.id } })).toMatchObject({ deathReason: "slaughtered" });
    await validationError(await api("PATCH", "/v1/animals/batch", {
      animalIds: [known.id, parent.id], data: { deathReason: "died" },
    }, jwt), /deathReason/);
    expect(await db.query.animals.findFirst({ where: { id: known.id } })).toMatchObject({ deathReason: "slaughtered" });
  });

  it("CORE4: persists and serializes unknown and applies reason-only/null edits against stored death dates without warnings fields", async () => {
    const { jwt } = await createUserWithFarm();
    const db = getAdminDb();
    const dead = await success<AnimalResult>(await api("POST", "/v1/animals", { ...validAnimal, dateOfDeath: "2023-01-01" }, jwt));
    expect(dead.deathReason).toBe("unknown");
    expect(new Date(dead.dateOfDeath!).toISOString()).toBe("2023-01-01T00:00:00.000Z");
    expect(await db.query.animals.findFirst({ where: { id: dead.id } })).toMatchObject({ deathReason: "unknown", dateOfDeath: new Date("2023-01-01") });
    const reasonOnly = await success<AnimalResult>(await api("PATCH", `/v1/animals/byId/${dead.id}`, { deathReason: "slaughtered" }, jwt));
    expect(reasonOnly).toMatchObject({ deathReason: "slaughtered", dateOfDeath: dead.dateOfDeath });
    const dateOnly = await success<AnimalResult>(await api("PATCH", `/v1/animals/byId/${dead.id}`, { dateOfDeath: "2024-01-01" }, jwt));
    expect(dateOnly.deathReason).toBe("slaughtered");
    const nullReason = await success<AnimalResult>(await api("PATCH", `/v1/animals/byId/${dead.id}`, { deathReason: null }, jwt));
    expect(nullReason.deathReason).toBe("unknown");
    const alive = await createAnimal(jwt, { name: "Alive", usage: "other" });
    const merge = await success<CommitResult>(await api("POST", "/v1/animals/import/commit", {
      type: "cow",
      rows: [
        { ...validAnimal, mergeAnimalId: dead.id, deathReason: "died" },
        { ...validAnimal, mergeAnimalId: alive.id, deathReason: "died" },
      ],
    }, jwt));
    expect(merge).toMatchObject({ created: 0, merged: 1, skipped: [{ index: 1 }] });
    expect(merge.skipped[0].reason).toContain("deathReason");
    expect(await db.query.animals.findFirst({ where: { id: dead.id } })).toMatchObject({ deathReason: "died", dateOfDeath: new Date("2024-01-01") });
    expect(await db.query.animals.findFirst({ where: { id: alive.id } })).toMatchObject({ deathReason: null, dateOfDeath: null });
  });

  it("CORE5: keeps admin-seeded legacy contradictions readable, unrelated edits and identical merges usable", async () => {
    const { jwt, farmId } = await createUserWithFarm();
    const db = getAdminDb();
    const [wrongParent] = await db.insert(schema.animals).values({
      farmId, name: "Legacy parent", type: "goat", sex: "male", usage: "other", dateOfBirth: new Date("3000-01-01"),
    }).returning();
    const [legacy] = await db.insert(schema.animals).values({
      farmId, name: "Legacy deer", type: "deer", sex: "female", usage: "milk", dateOfBirth: new Date("2999-01-01"),
      dateOfDeath: new Date("2010-01-01"), deathReason: "died", motherId: wrongParent.id,
    }).returning();
    const read = await success<AnimalResult>(await api("GET", `/v1/animals/byId/${legacy.id}`, undefined, jwt));
    expect(read).toMatchObject({ type: "deer", usage: "milk", motherId: wrongParent.id });
    await success<AnimalResult>(await api("PATCH", `/v1/animals/byId/${legacy.id}`, { name: "Legacy renamed" }, jwt));
    const merge = await success<CommitResult>(await api("POST", "/v1/animals/import/commit", {
      type: "cow", rows: [{
        mergeAnimalId: legacy.id, name: "Legacy merged", sex: "female", usage: "milk", dateOfBirth: "2999-01-01",
        dateOfDeath: "2010-01-01", deathReason: "died",
      }],
    }, jwt));
    expect(merge).toEqual({ created: 0, merged: 1, skipped: [] });
    expect(await db.query.animals.findFirst({ where: { id: legacy.id } })).toMatchObject({
      name: "Legacy merged", type: "deer", usage: "milk", dateOfBirth: legacy.dateOfBirth,
      dateOfDeath: legacy.dateOfDeath, motherId: wrongParent.id,
    });
    await success<AnimalResult>(await api("PATCH", `/v1/animals/byId/${legacy.id}`, { usage: "other" }, jwt));
    await validationError(await api("PATCH", `/v1/animals/byId/${legacy.id}`, { dateOfBirth: "3001-01-01" }, jwt), /dateOfBirth/);
    const [orphanReason] = await db.insert(schema.animals).values({
      farmId, name: "Legacy orphan reason", type: "cow", sex: "female", usage: "other", dateOfBirth: new Date("2020-01-01"), deathReason: "died",
    }).returning();
    await success<AnimalResult>(await api("PATCH", `/v1/animals/byId/${orphanReason.id}`, { name: "Still editable", deathReason: "died" }, jwt));
    expect(await db.query.animals.findFirst({ where: { id: orphanReason.id } })).toMatchObject({ name: "Still editable", dateOfDeath: null, deathReason: "died" });
  });

  it("CORE6: real XLSX preview/commit and legacy prerequisites keep rejected rows free of animal/tag/parent writes", async () => {
    const { jwt, farmId } = await createUserWithFarm();
    const db = getAdminDb();
    const [motherTag, maleTag] = await db.insert(schema.earTags).values([
      { farmId, number: "MOTHER_TAG" }, { farmId, number: "MALE_TAG" },
    ]).returning();
    const mother = await createAnimal(jwt, { name: "Import mother", usage: "other", dateOfBirth: "2010-01-01", earTagId: motherTag.id });
    await createAnimal(jwt, { name: "Import male", usage: "other", sex: "male", dateOfBirth: "2010-01-01", earTagId: maleTag.id });
    const buffer = await workbook([
      ["GOOD_TAG", "Good child", "weiblich", "2020-01-01", "other", "2024-01-01", "MOTHER_TAG"],
      ["FUTURE_TAG", "Future child", "weiblich", "2999-01-01", "other", "", "MOTHER_TAG"],
      ["BAD_MOTHER_TAG", "Bad mother child", "weiblich", "2020-01-01", "other", "", "MALE_TAG"],
      ["", "", "unknown", "not-a-date", "other"],
    ]);
    const preview = await success<{ rows: PreviewRow[] }>(await upload("/v1/animals/import/preview", buffer, jwt, { skipHeaderRow: "true" }));
    expect(preview.rows[0]).toMatchObject({ rowNumber: 2, deathReason: "unknown", parseErrors: [] });
    expect(preview.rows[3].rowNumber).toBe(5);
    expect(preview.rows[3].parseErrors).toEqual(["Name is required", "Unknown sex value: unknown", "Invalid date format"]);
    expect(await db.query.animals.findMany({})).toHaveLength(2);
    expect(await db.query.earTags.findMany({})).toHaveLength(2);
    const commit = await success<CommitResult>(await api("POST", "/v1/animals/import/commit", {
      type: "cow", rows: preview.rows.filter(({ parseErrors }) => parseErrors.length === 0),
    }, jwt));
    expect(commit).toMatchObject({ created: 1, merged: 0, skipped: [{ index: 1 }, { index: 2 }] });
    expect(commit.skipped[0].reason).toContain("dateOfBirth");
    expect(commit.skipped[1].reason).toContain("motherId");
    const child = await db.query.animals.findFirst({ where: { name: "Good child" } });
    expect(child).toMatchObject({ motherId: mother.id, deathReason: "unknown", dateOfDeath: new Date("2024-01-01") });
    expect(await db.query.animals.findMany({})).toHaveLength(3);
    expect((await db.query.earTags.findMany({})).map(({ number }) => number).sort()).toEqual(["GOOD_TAG", "MALE_TAG", "MOTHER_TAG"]);

    const legacyBuffer = await workbook([
      ["LEGACY_GOOD", "", "weiblich", "2020-01-01", "other", "2024-01-01"],
      ["", "", "unknown", "not-a-date", "other"],
      ["LEGACY_BAD", "Invalid usage", "weiblich", "2020-01-01", "milk"],
    ]);
    const legacy = await success<{ skipped: Array<{ row: number; reason: string }>; summary: { imported: number; skipped: number } }>(
      await upload("/v1/animals/import", legacyBuffer, jwt, { type: "pig", skipHeaderRow: "true" })
    );
    expect(legacy.summary).toMatchObject({ imported: 1, skipped: 2 });
    expect(legacy.skipped[0]).toEqual(expect.objectContaining({ row: 3, reason: "Name is required" }));
    expect(legacy.skipped[1]).toEqual(expect.objectContaining({ row: 4, reason: expect.stringMatching(/usage.*milk/i) }));
    expect(await db.query.animals.findFirst({ where: { name: "LEGACY_GOOD" } })).toMatchObject({ type: "pig", dateOfDeath: null, deathReason: null });
    expect(await db.query.earTags.findFirst({ where: { number: "LEGACY_BAD" } })).toBeUndefined();
  });
});
