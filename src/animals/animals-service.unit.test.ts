/**
 * Tests that animalsApi validates and persists create, update, batch and import operations.
 * Database and workbook boundaries are mocked; no Docker or live database is used.
 * Direct validation-rule coverage lives in animal-validation.unit.test.ts.
 */
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import type { TFunction } from "i18next";
import type { RlsDb } from "../db/db";
import { animalsApi, AnimalCreateInput, CommitImportRow } from "./animals";
import { loadImportWorksheet } from "./import-workbook";

jest.mock("../db/schema", () => ({
  animals: { id: "animal.id" },
  earTags: { id: "earTag.id" },
  farmIdColumnValue: { farmId: "farm" },
}));
jest.mock("drizzle-orm", () => ({
  ...jest.requireActual<typeof import("drizzle-orm")>("drizzle-orm"),
  eq: (_column: unknown, id: string) => ({ ids: [id] }),
  inArray: (_column: unknown, ids: string[]) => ({ ids }),
}));
jest.mock("./import-workbook", () => ({ loadImportWorksheet: jest.fn() }));

type Row = AnimalCreateInput & { id: string; farmId: string };
type Tag = { id: string; farmId: string; number: string; animal: Row | null };
type Where = { id?: string | { in: string[] }; farmId?: string };
const t = ((key: string) => key) as unknown as TFunction;
const birth = new Date("2020-01-01T00:00:00Z");
function animal(id: string, patch: Partial<Row> = {}): Row {
  return {
    id, farmId: "farm", name: id, type: "cow", usage: "other", sex: "female", dateOfBirth: birth,
    registered: false, motherId: null, fatherId: null, dateOfDeath: null, deathReason: null, ...patch,
  };
}
function importRow(patch: Partial<CommitImportRow> = {}): CommitImportRow {
  return { name: "imported", sex: "female", dateOfBirth: birth, usage: "other", ...patch };
}

// Faithful in-memory persistence boundary: the real service and domain validation run unchanged.
function database(initial: Row[] = [], tags: Tag[] = []) {
  const stored = initial.map((row) => ({ ...row }));
  const writes: Array<{ kind: string; data: unknown }> = [];
  const matches = (row: Row, where: Where = {}) =>
    (!where.farmId || row.farmId === where.farmId) &&
    (!where.id || (typeof where.id === "string" ? row.id === where.id : where.id.in.includes(row.id)));
  const query = {
    animals: {
      findMany: async ({ where }: { where?: Where } = {}) => stored.filter((row) => matches(row, where)).map((row) => ({ ...row, earTag: null })),
      findFirst: async ({ where }: { where: Where }) => stored.find((row) => matches(row, where)),
    },
    earTags: { findMany: async () => tags },
  };
  const tx = {
    query,
    insert: (table: { id: string }) => ({ values: (values: Partial<Row> | Partial<Row>[]) => ({ returning: async () => {
      const inputs = Array.isArray(values) ? values : [values];
      writes.push({ kind: table.id === "animal.id" ? "insertAnimal" : "insertTag", data: inputs });
      if (table.id !== "animal.id") return inputs.map((row, index) => ({ ...row, id: `tag-${index}`, animal: null }));
      const inserted = inputs.map((row, index) => animal(row.id ?? `created-${index}`, row));
      stored.push(...inserted);
      return inserted;
    } }) }),
    update: () => ({ set: (patch: Partial<Row>) => ({ where: ({ ids }: { ids: string[] }) => {
      writes.push({ kind: "updateAnimal", data: patch });
      const updated = stored.filter((row) => ids.includes(row.id));
      for (const row of updated) Object.assign(row, patch);
      return Object.assign(Promise.resolve(updated), { returning: async () => updated });
    } }) }),
  };
  const db = { rls: async (callback: (transaction: typeof tx) => unknown) => callback(tx) } as unknown as RlsDb;
  return { api: animalsApi(db, t), stored, writes };
}

function mockImportWorksheet(
  rows: Array<{ rowNumber: number; values: unknown[] }>,
  headers = ["Ohrmarkennummer", "Tiername", "Geschlecht", "Geburtsdatum", "Nutzungsart"]
) {
  const row = (cells: unknown[]) => ({
    eachCell: (callback: (cell: { text: string }, index: number) => void) =>
      cells.forEach((cell, index) => callback({ text: String(cell) }, index + 1)),
    getCell: (index: number) => ({ text: String(cells[index - 1] ?? ""), value: cells[index - 1] }),
  });
  const worksheet = {
    getRow: () => row(headers),
    eachRow: (callback: (value: ReturnType<typeof row>, index: number) => void) => {
      callback(row(headers), 1);
      for (const source of rows) callback(row(source.values), source.rowNumber);
    },
  };
  jest.mocked(loadImportWorksheet).mockResolvedValue(worksheet as unknown as Awaited<ReturnType<typeof loadImportWorksheet>>);
}

beforeEach(() => { jest.clearAllMocks(); });

describe("animal write-path consistency", () => {
  it("rejects invalid create before insertion, and accepts valid create", async () => {
    const { api, writes } = database();
    await expect(api.createAnimal(animal("unused", { type: "deer", usage: "milk" }))).rejects.toThrow("usage_species");
    expect(writes).toEqual([]);
    await expect(api.createAnimal(animal("unused", { type: "deer" }))).resolves.toMatchObject({ type: "deer" });
    expect(writes).toHaveLength(1);
  });

  it("rejects explicit unresolved parents before a create write", async () => {
    const { api, writes } = database();
    await expect(api.createAnimal(animal("unused", { motherId: "missing" }))).rejects.toThrow("parent_missing");
    expect(writes).toEqual([]);
  });

  it("validates single-update retained fields and allows unrelated legacy edits", async () => {
    const { api, writes } = database([animal("legacy", { type: "pig", usage: "milk" })]);
    await expect(api.updateAnimal("legacy", { name: "renamed" })).resolves.toMatchObject({ name: "renamed" });
    expect(writes).toHaveLength(1);
    await expect(api.updateAnimal("legacy", { type: "deer" })).rejects.toThrow("usage_species");
    expect(writes).toHaveLength(1);
  });

  it("checks effective retained death reason when clearing death", async () => {
    const { api, writes } = database([animal("a", { dateOfDeath: new Date("2021-01-01"), deathReason: "died" })]);
    await expect(api.updateAnimal("a", { dateOfDeath: null })).rejects.toThrow("death_reason_date");
    expect(writes).toEqual([]);
    await expect(api.updateAnimal("a", { dateOfDeath: null, deathReason: null })).resolves.toMatchObject({ dateOfDeath: null });
  });

  it("validates every common-patch target using its stored species before any writes", async () => {
    const { api, writes } = database([animal("cow"), animal("pig", { type: "pig" })]);
    await expect(api.batchUpdateAnimals(["cow", "pig"], { usage: "milk" })).rejects.toThrow("usage_species");
    expect(writes).toEqual([]);
    await expect(api.batchUpdateAnimals(["cow", "pig"], { usage: "other" })).resolves.toHaveLength(2);
  });

  it("rejects an invalid row of per-animal bulk updates before any writes", async () => {
    const { api, writes } = database([animal("cow"), animal("pig", { type: "pig" })]);
    await expect(api.updateAnimals([{ id: "cow", name: "renamed" }, { id: "pig", usage: "milk" }])).rejects.toThrow("usage_species");
    expect(writes).toEqual([]);
  });

  it("uses final parent state independently of per-animal batch order", async () => {
    const { api } = database([
      animal("child", { sex: "male", dateOfBirth: new Date("2022-01-01") }),
      animal("mother", { sex: "male" }),
    ]);
    await expect(api.updateAnimals([{ id: "child", motherId: "mother" }, { id: "mother", sex: "female" }])).resolves.toHaveLength(2);
  });

  it("revalidates affected outgoing relations when a referenced parent changes in the same batch", async () => {
    const { api, writes } = database([
      animal("child", { motherId: "mother", dateOfBirth: new Date("2022-01-01") }), animal("mother"),
    ]);
    await expect(api.updateAnimals([{ id: "child", name: "new" }, { id: "mother", sex: "male" }])).rejects.toThrow("parent_sex");
    expect(writes).toEqual([]);
  });
});

describe("animal import consistency", () => {
  it("skips invalid create rows before writing any animals or tags", async () => {
    const { api, writes } = database();
    const result = await api.commitImport([importRow({ usage: "milk", earTagNumber: "new" })], "pig", "farm");
    expect(result).toMatchObject({ created: 0, merged: 0, skipped: [{ index: 0 }] });
    expect(result.skipped[0].reason).toContain("usage_species");
    expect(writes).toEqual([]);
  });

  it("preserves stored species on merges and grandfathers identical legacy contradictions", async () => {
    const { api, stored } = database([animal("legacy", { type: "deer", usage: "milk" })]);
    expect(await api.commitImport([importRow({ mergeAnimalId: "legacy", usage: "milk", name: "renamed" })], "cow", "farm"))
      .toEqual({ created: 0, merged: 1, skipped: [] });
    expect(stored[0]).toMatchObject({ type: "deer", usage: "milk", name: "renamed" });
  });

  it("does not mutate skipped merges or run their delayed parent assignment", async () => {
    const parent = animal("mother", { dateOfBirth: new Date("2010-01-01") });
    const { api, writes } = database([animal("pig", { type: "pig" }), parent], [{ id: "tag-m", farmId: "farm", number: "M", animal: parent }]);
    const result = await api.commitImport([importRow({ mergeAnimalId: "pig", usage: "milk", motherEarTagNumber: "M" })], "cow", "farm");
    expect(result.skipped[0].reason).toContain("usage_species");
    expect(writes).toEqual([]);
  });

  it("resolves newly imported parents regardless of row order", async () => {
    const { api, stored } = database();
    const result = await api.commitImport([
      importRow({ name: "child", earTagNumber: "C", motherEarTagNumber: "M", dateOfBirth: new Date("2022-01-01") }),
      importRow({ name: "mother", earTagNumber: "M" }),
    ], "cow", "farm");
    expect(result).toEqual({ created: 2, merged: 0, skipped: [] });
    expect(stored.find((row) => row.name === "child")?.motherId).toBe(stored.find((row) => row.name === "mother")?.id);
  });

  it("rejects invalid resolved parents without writing the child", async () => {
    const father = animal("male", { sex: "male", dateOfBirth: new Date("2010-01-01") });
    const { api, writes } = database([father], [{ id: "tag", farmId: "farm", number: "M", animal: father }]);
    const result = await api.commitImport([importRow({ motherEarTagNumber: "M" })], "cow", "farm");
    expect(result.skipped[0].reason).toContain("parent_sex");
    expect(writes).toEqual([]);
  });

  it("rechecks a child against retained parent values after rejecting an invalid parent merge", async () => {
    const mother = animal("mother");
    const { api, stored } = database([mother], [{ id: "tag", farmId: "farm", number: "M", animal: mother }]);
    const result = await api.commitImport([
      importRow({ name: "child", motherEarTagNumber: "M", dateOfBirth: new Date("2022-01-01") }),
      importRow({ mergeAnimalId: "mother", earTagNumber: "M", sex: "male", dateOfBirth: new Date("2099-01-01") }),
    ], "cow", "farm");
    expect(result).toMatchObject({ created: 1, merged: 0, skipped: [{ index: 1 }] });
    expect(stored.find((row) => row.name === "child")?.motherId).toBe("mother");
    expect(stored.find((row) => row.id === "mother")?.sex).toBe("female");
  });

  it("rejects a parent with an invalid outgoing link before rechecking its child", async () => {
    const mother = animal("mother");
    const male = animal("male", { sex: "male", dateOfBirth: new Date("2010-01-01") });
    const { api, stored } = database([mother, male], [
      { id: "tag-m", farmId: "farm", number: "M", animal: mother },
      { id: "tag-x", farmId: "farm", number: "X", animal: male },
    ]);
    const result = await api.commitImport([
      importRow({ name: "child", motherEarTagNumber: "M", dateOfBirth: new Date("2022-01-01") }),
      importRow({ mergeAnimalId: "mother", earTagNumber: "M", sex: "male", motherEarTagNumber: "X" }),
    ], "cow", "farm");
    expect(result).toMatchObject({ created: 1, merged: 0, skipped: [{ index: 1 }] });
    expect(stored.find((row) => row.name === "child")?.motherId).toBe("mother");
  });

  it("does not let a later correction hide an earlier invalid merge to the same target", async () => {
    const { api, stored, writes } = database([animal("pig", { type: "pig" })]);
    const result = await api.commitImport([
      importRow({ mergeAnimalId: "pig", usage: "milk" }),
      importRow({ mergeAnimalId: "pig", usage: "other", name: "valid" }),
    ], "cow", "farm");
    expect(result).toMatchObject({ created: 0, merged: 1, skipped: [{ index: 0 }] });
    expect(writes).toHaveLength(1);
    expect(stored[0]).toMatchObject({ name: "valid", usage: "other" });
  });

  it("retains an earlier valid merge when a later duplicate-target merge is invalid", async () => {
    const { api, stored, writes } = database([animal("pig", { type: "pig" })]);
    const result = await api.commitImport([
      importRow({ mergeAnimalId: "pig", usage: "other", name: "valid" }),
      importRow({ mergeAnimalId: "pig", usage: "milk" }),
    ], "cow", "farm");
    expect(result).toMatchObject({ created: 0, merged: 1, skipped: [{ index: 1 }] });
    expect(writes).toHaveLength(1);
    expect(stored[0]).toMatchObject({ name: "valid", usage: "other" });
  });

  it("preserves unresolved parent-tag behavior", async () => {
    const { api, stored } = database();
    expect(await api.commitImport([importRow({ motherEarTagNumber: "unknown" })], "cow", "farm"))
      .toEqual({ created: 1, merged: 0, skipped: [] });
    expect(stored[0].motherId).toBeNull();
  });

  it("skips missing merge targets without writes", async () => {
    const { api, writes } = database();
    const result = await api.commitImport([importRow({ mergeAnimalId: "unknown" })], "cow", "farm");
    expect(result).toMatchObject({ created: 0, merged: 0, skipped: [{ index: 0 }] });
    expect(writes).toEqual([]);
  });

  it("validates legacy Excel import birth and usage before writes", async () => {
    const headers = ["Ohrmarkennummer", "Tiername", "Geschlecht", "Geburtsdatum", "Nutzungsart"];
    const values = ["TAG", "animal", "weiblich", birth, "Milch"];
    const row = (cells: unknown[]) => ({
      eachCell: (callback: (cell: { text: string }, index: number) => void) => cells.forEach((cell, index) => callback({ text: String(cell) }, index + 1)),
      getCell: (index: number) => ({ text: String(cells[index - 1] ?? ""), value: cells[index - 1] }),
    });
    const worksheet = {
      getRow: () => row(headers),
      eachRow: (callback: (value: ReturnType<typeof row>, index: number) => void) => { callback(row(headers), 1); callback(row(values), 2); },
    };
    jest.mocked(loadImportWorksheet).mockResolvedValue(worksheet as unknown as Awaited<ReturnType<typeof loadImportWorksheet>>);
    const { api, writes } = database();
    const result = await api.importFromExcel(Buffer.from("mock"), "pig", true, "farm");
    expect(result.skipped[0].reason).toContain("usage_species");
    expect(writes).toEqual([]);
  });
});


describe("consolidated import prerequisites", () => {
  it("rejects unusable Date objects in legacy import without persistence", async () => {
    mockImportWorksheet([{ rowNumber: 7, values: ["", "animal", "weiblich", new Date(NaN), "other"] }]);
    const { api, writes } = database();
    const result = await api.importFromExcel(Buffer.from("mock"), "cow", true, "farm");
    expect(result.skipped).toEqual([{ row: 7, earTagNumber: null, name: "animal", reason: "Invalid date format" }]);
    expect(writes).toEqual([]);
  });

  it("reports unusable preview Date values as null with a localized issue and source row", async () => {
    mockImportWorksheet([{ rowNumber: 7, values: ["", "animal", "weiblich", new Date(NaN), "other"] }]);
    const { api, writes } = database();
    const result = await api.parseImportPreview(Buffer.from("mock"), true, "farm");
    expect(result[0]).toMatchObject({ rowNumber: 7, dateOfBirth: null, parseErrors: ["animal_import.error_dob_invalid"] });
    expect(writes).toEqual([]);
  });

  it("preserves first-error legacy behavior while preview accumulates ordered issues", async () => {
    mockImportWorksheet([{ rowNumber: 4, values: ["", "", "", null, ""] }]);
    const { api, writes } = database();
    const legacy = await api.importFromExcel(Buffer.from("mock"), "cow", true, "farm");
    expect(legacy.skipped).toEqual([{ row: 4, earTagNumber: null, name: null, reason: "Name is required" }]);
    const preview = await api.parseImportPreview(Buffer.from("mock"), true, "farm");
    expect(preview[0].parseErrors).toEqual([
      "animal_import.error_name_required", "animal_import.error_sex_required", "animal_import.error_dob_required",
    ]);
    expect(writes).toEqual([]);
  });

  it.each([
    ["", birth, "Sex is required", "animal_import.error_sex_required"],
    ["unknown", birth, "Unknown sex value: unknown", "animal_import.error_sex_unknown"],
    ["weiblich", null, "Date of birth is required", "animal_import.error_dob_required"],
    ["weiblich", "invalid", "Invalid date format", "animal_import.error_dob_invalid"],
  ])("preserves missing/unknown sex and missing/invalid DOB messages (%s, %s)", async (sex, date, legacyReason, previewReason) => {
    mockImportWorksheet([{ rowNumber: 2, values: ["", "animal", sex, date, "other"] }]);
    const { api, writes } = database();
    expect((await api.importFromExcel(Buffer.from("mock"), "cow", true, "farm")).skipped[0].reason).toBe(legacyReason);
    expect((await api.parseImportPreview(Buffer.from("mock"), true, "farm"))[0].parseErrors).toEqual([previewReason]);
    expect(writes).toEqual([]);
  });

  it("preserves ear-tag fallback, localized sex mapping, and unrecognized usage default", async () => {
    mockImportWorksheet([{ rowNumber: 2, values: ["  TAG  ", "  ", " Femmina ", birth, "unknown"] }]);
    const { api, stored } = database();
    const preview = await api.parseImportPreview(Buffer.from("mock"), true, "farm");
    expect(preview[0]).toMatchObject({ name: "TAG", sex: "female", usage: "other", parseErrors: [] });
    expect((await api.importFromExcel(Buffer.from("mock"), "cow", true, "farm")).summary.imported).toBe(1);
    expect(stored[0]).toMatchObject({ name: "TAG", sex: "female", usage: "other", registered: true });
  });

  it("preserves assigned-tag conflict for legacy creation and allowance for same-target merge", async () => {
    const current = animal("existing");
    const tags = [{ id: "tag", farmId: "farm", number: "TAG", animal: current }];
    const { api, writes } = database([current], tags);
    mockImportWorksheet([{ rowNumber: 2, values: ["TAG", "animal", "weiblich", birth, "other"] }]);
    expect((await api.importFromExcel(Buffer.from("mock"), "cow", true, "farm")).skipped[0].reason).toBe("Ear tag already assigned");
    expect(writes).toEqual([]);
    expect(await api.commitImport([importRow({ mergeAnimalId: "existing", earTagNumber: "TAG" })], "cow", "farm"))
      .toEqual({ created: 0, merged: 1, skipped: [] });
  });

  it("preserves the explicit-earTagId guard rather than adding a number conflict check", async () => {
    const current = animal("existing");
    const { api } = database([current], [{ id: "owned", farmId: "farm", number: "TAG", animal: current }]);
    const result = await api.commitImport([importRow({ earTagNumber: "TAG", earTagId: "explicit" })], "cow", "farm");
    expect(result).toEqual({ created: 1, merged: 0, skipped: [] });
  });

  it("does not add an empty-name restriction to ordinary animal API writes", async () => {
    const { api } = database();
    await expect(api.createAnimal(animal("unused", { name: "" }))).resolves.toMatchObject({ name: "" });
  });
});


describe("explicit unknown death-reason policy", () => {
  const death = new Date("2023-01-01T00:00:00Z");

  it("stores unknown for a create death date with omitted or null reason", async () => {
    for (const reason of [undefined, null]) {
      const { api } = database();
      await expect(api.createAnimal(animal("created", { dateOfDeath: death, deathReason: reason })))
        .resolves.toMatchObject({ dateOfDeath: death, deathReason: "unknown" });
    }
  });

  it("stores unknown on single date-only updates but retains known existing reasons", async () => {
    const { api } = database([
      animal("living"), animal("known", { dateOfDeath: new Date("2022-01-01"), deathReason: "slaughtered" }),
    ]);
    await expect(api.updateAnimal("living", { dateOfDeath: death })).resolves.toMatchObject({ deathReason: "unknown" });
    await expect(api.updateAnimal("known", { dateOfDeath: death })).resolves.toMatchObject({ deathReason: "slaughtered" });
  });

  it("normalizes per-animal date patches and preserves explicitly supplied reasons", async () => {
    const { api, stored } = database([animal("a"), animal("b")]);
    await api.updateAnimals([{ id: "a", dateOfDeath: death }, { id: "b", dateOfDeath: death, deathReason: "died" }]);
    expect(stored.find((row) => row.id === "a")?.deathReason).toBe("unknown");
    expect(stored.find((row) => row.id === "b")?.deathReason).toBe("died");
  });

  it("normalizes each common-batch target against its retained reason", async () => {
    const { api, stored } = database([
      animal("living"), animal("known", { dateOfDeath: new Date("2022-01-01"), deathReason: "slaughtered" }),
    ]);
    await api.batchUpdateAnimals(["living", "known"], { dateOfDeath: death });
    expect(stored.find((row) => row.id === "living")?.deathReason).toBe("unknown");
    expect(stored.find((row) => row.id === "known")?.deathReason).toBe("slaughtered");
  });

  it("accepts reason-only patch against stored date and never invents one for living animals", async () => {
    const { api, writes } = database([animal("dead", { dateOfDeath: death }), animal("living")]);
    await expect(api.updateAnimal("dead", { deathReason: "slaughtered" })).resolves.toMatchObject({ dateOfDeath: death, deathReason: "slaughtered" });
    await expect(api.updateAnimal("living", { deathReason: "died" })).rejects.toThrow("death_reason_date");
    expect(writes).toHaveLength(1);
  });

  it("defaults imported dates to unknown without skipping accepted rows", async () => {
    const { api, stored } = database();
    expect(await api.commitImport([importRow({ dateOfDeath: death })], "cow", "farm"))
      .toEqual({ created: 1, merged: 0, skipped: [] });
    expect(stored[0]).toMatchObject({ dateOfDeath: death, deathReason: "unknown" });
  });

  it("applies reason-only merge to the retained stored death date", async () => {
    const { api, stored } = database([animal("dead", { dateOfDeath: death })]);
    expect(await api.commitImport([importRow({ mergeAnimalId: "dead", deathReason: "slaughtered" })], "cow", "farm"))
      .toEqual({ created: 0, merged: 1, skipped: [] });
    expect(stored[0]).toMatchObject({ dateOfDeath: death, deathReason: "slaughtered" });
  });

  it("skips reason-only merge without effective date before any writes", async () => {
    const { api, writes } = database([animal("living")]);
    const result = await api.commitImport([importRow({ mergeAnimalId: "living", deathReason: "died" })], "cow", "farm");
    expect(result).toMatchObject({ created: 0, merged: 0, skipped: [{ index: 0 }] });
    expect(result.skipped[0].reason).toContain("death_reason_date");
    expect(writes).toEqual([]);
  });

  it("retains a known merge reason on date-only edits and defaults missing effective reason to unknown", async () => {
    const { api, stored } = database([
      animal("known", { dateOfDeath: new Date("2022-01-01"), deathReason: "slaughtered" }), animal("missing"),
    ]);
    const result = await api.commitImport([
      importRow({ mergeAnimalId: "known", dateOfDeath: death }),
      importRow({ mergeAnimalId: "missing", dateOfDeath: death, deathReason: null }),
    ], "cow", "farm");
    expect(result).toEqual({ created: 0, merged: 2, skipped: [] });
    expect(stored.find((row) => row.id === "known")?.deathReason).toBe("slaughtered");
    expect(stored.find((row) => row.id === "missing")?.deathReason).toBe("unknown");
  });

  it("preserves explicit imported reason, unrelated legacy data and import null-date no-clear behavior", async () => {
    const { api, stored } = database([
      animal("legacy", { dateOfDeath: death, deathReason: null }),
      animal("orphan", { dateOfDeath: null, deathReason: "died" }),
    ]);
    await api.updateAnimal("orphan", { name: "renamed" });
    await api.commitImport([
      importRow({ mergeAnimalId: "legacy", dateOfDeath: null }),
      importRow({ dateOfDeath: death, deathReason: "slaughtered" }),
    ], "cow", "farm");
    expect(stored.find((row) => row.id === "legacy")).toMatchObject({ dateOfDeath: death, deathReason: null });
    expect(stored.find((row) => row.id === "orphan")).toMatchObject({ dateOfDeath: null, deathReason: "died", name: "renamed" });
    expect(stored.find((row) => row.name === "imported" && row.id !== "legacy")).toMatchObject({ deathReason: "slaughtered" });
  });

  it("normalizes explicit null reason against stored death dates in patch and merge", async () => {
    const { api, stored } = database([
      animal("known", { dateOfDeath: death, deathReason: "slaughtered" }),
      animal("missing", { dateOfDeath: death, deathReason: null }),
    ]);
    await expect(api.updateAnimal("known", { deathReason: null })).resolves.toMatchObject({ deathReason: "unknown" });
    expect(await api.commitImport([importRow({ mergeAnimalId: "missing", deathReason: null })], "cow", "farm"))
      .toEqual({ created: 0, merged: 1, skipped: [] });
    expect(stored.find((row) => row.id === "missing")?.deathReason).toBe("unknown");
  });

  it("normalizes an explicit identical death date but does not backfill an unrelated edit", async () => {
    const { api, stored } = database([
      animal("touched", { dateOfDeath: death, deathReason: null }),
      animal("untouched", { dateOfDeath: death, deathReason: null }),
    ]);
    await api.updateAnimals([{ id: "touched", dateOfDeath: new Date(death) }, { id: "untouched", name: "renamed" }]);
    expect(stored.find((row) => row.id === "touched")?.deathReason).toBe("unknown");
    expect(stored.find((row) => row.id === "untouched")?.deathReason).toBeNull();
  });

  it("grandfathers identical invalid reason-without-date tuples but rejects changes", async () => {
    const { api, stored } = database([animal("orphan", { deathReason: "died", dateOfDeath: null })]);
    await expect(api.updateAnimal("orphan", { deathReason: "died" })).resolves.toMatchObject({ dateOfDeath: null, deathReason: "died" });
    expect(await api.commitImport([importRow({ mergeAnimalId: "orphan", deathReason: "died" })], "cow", "farm"))
      .toEqual({ created: 0, merged: 1, skipped: [] });
    await expect(api.updateAnimal("orphan", { deathReason: "slaughtered" })).rejects.toThrow("death_reason_date");
    const result = await api.commitImport([importRow({ mergeAnimalId: "orphan", deathReason: "slaughtered" })], "cow", "farm");
    expect(result).toMatchObject({ merged: 0, skipped: [{ index: 0 }] });
    expect(stored[0]).toMatchObject({ dateOfDeath: null, deathReason: "died" });
  });

  it("rejects mixed common-batch reason-only writes before any mutation", async () => {
    const { api, writes } = database([animal("dead", { dateOfDeath: death }), animal("living")]);
    await expect(api.batchUpdateAnimals(["dead", "living"], { deathReason: "died" })).rejects.toThrow("death_reason_date");
    expect(writes).toEqual([]);
  });

  it("rejects imported create reasons without dates and never invents a death date", async () => {
    const { api, writes } = database();
    const result = await api.commitImport([importRow({ deathReason: "died" })], "cow", "farm");
    expect(result).toMatchObject({ created: 0, skipped: [{ index: 0 }] });
    expect(result.skipped[0].reason).toContain("death_reason_date");
    expect(writes).toEqual([]);
  });

  it("uses cumulative normalized lifecycle fields for repeated accepted merge targets", async () => {
    const { api, stored } = database([animal("target")]);
    const result = await api.commitImport([
      importRow({ mergeAnimalId: "target", dateOfDeath: death }),
      importRow({ mergeAnimalId: "target", deathReason: "slaughtered" }),
    ], "cow", "farm");
    expect(result).toEqual({ created: 0, merged: 2, skipped: [] });
    expect(stored[0]).toMatchObject({ dateOfDeath: death, deathReason: "slaughtered" });
  });

  it("previews unknown and keeps legacy one-step import death columns ignored", async () => {
    mockImportWorksheet([{ rowNumber: 2, values: ["", "animal", "weiblich", birth, "other", death] }],
      ["Ohrmarkennummer", "Tiername", "Geschlecht", "Geburtsdatum", "Nutzungsart", "Todesdatum"]);
    const { api, stored } = database();
    const preview = await api.parseImportPreview(Buffer.from("mock"), true, "farm");
    expect(preview[0]).toMatchObject({ dateOfDeath: death, deathReason: "unknown", parseErrors: [] });
    await api.importFromExcel(Buffer.from("mock"), "cow", true, "farm");
    expect(stored[0]).toMatchObject({ dateOfDeath: null, deathReason: null });
  });
});
