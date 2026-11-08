/**
 * Direct tests of animal validation rules, normalization, enum values and localized errors.
 * Service write-path coverage with mocked persistence lives in animals-service.unit.test.ts.
 */
import { describe, expect, test } from "@jest/globals";
import i18next from "i18next";
import en from "../../resources/locales/en.json";
import de from "../../resources/locales/de.json";
import it from "../../resources/locales/it.json";
import fr from "../../resources/locales/fr.json";
import { deathReasonSchema } from "../db/schema";
import {
  AnimalValidationState, assertAnimalConsistency, validateAnimalConsistency,
  validateImportAnimalPrerequisites, hasAssignedEarTagConflict,
  resolveAnimalDeathFields,
} from "./animal-validation";

const d = (value: string) => new Date(value);
const now = d("2026-11-08T12:00:00Z");
const animal = (patch: Partial<AnimalValidationState> = {}): AnimalValidationState => ({
  id: "child", type: "cow", usage: "other", sex: "female", dateOfBirth: d("2024-01-01"), ...patch,
});
const mother = animal({ id: "mother", dateOfBirth: d("2020-01-01") });
const father = animal({ id: "father", sex: "male", dateOfBirth: d("2020-01-01") });
const parents = new Map([[mother.id!, mother], [father.id!, father]]);
const issues = (next: AnimalValidationState, previous?: AnimalValidationState,
  nextParents = parents, oldParents = parents) => validateAnimalConsistency(next, previous, nextParents, oldParents, now);

describe("animal consistency rules", () => {
  test.each(["pig", "deer"])("rejects milk for %s, permits other", (type) => {
    expect(issues(animal({ type, usage: "milk" }))).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "usage", key: "animal_validation.usage_species" }),
    ]));
    expect(issues(animal({ type }))).toEqual([]);
  });
  test.each(["cow", "goat", "sheep", "horse", "donkey"])("permits milk for %s", (type) => {
    expect(issues(animal({ type, usage: "milk" }))).toEqual([]);
  });
  test("accepts valid mother and father", () => {
    expect(issues(animal({ motherId: "mother", fatherId: "father" }))).toEqual([]);
  });
  test.each(["motherId", "fatherId"] as const)("rejects wrong sex, species, age, missing reference and self for %s", (field) => {
    const correct = field === "motherId" ? mother : father;
    for (const [patch, key] of [
      [{ sex: field === "motherId" ? "male" : "female" }, "parent_sex"],
      [{ type: "goat" }, "parent_species"],
      [{ dateOfBirth: d("2024-01-01") }, "parent_birth"],
      [{ dateOfBirth: d("2025-01-01") }, "parent_birth"],
    ] as const) {
      expect(issues(animal({ [field]: correct.id }), undefined,
        new Map([[correct.id!, { ...correct, ...patch }]]))).toEqual(expect.arrayContaining([
        expect.objectContaining({ field, key: `animal_validation.${key}` }),
      ]));
    }
    expect(issues(animal({ [field]: "missing" }))).toEqual(expect.arrayContaining([
      expect.objectContaining({ field, key: "animal_validation.parent_missing" }),
    ]));
    expect(issues(animal({ [field]: "child" }), undefined, new Map([["child", animal()]])))
      .toEqual(expect.arrayContaining([expect.objectContaining({ field, key: "animal_validation.parent_self" })]));
  });
  test("allows no parents and clearing parent links", () => {
    expect(issues(animal({ motherId: null, fatherId: null }), animal({ motherId: "mother" }))).toEqual([]);
  });
  test("allows birth today, rejects tomorrow", () => {
    expect(issues(animal({ dateOfBirth: d("2026-11-08") }))).toEqual([]);
    expect(issues(animal({ dateOfBirth: d("2026-11-09") }))).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "dateOfBirth", key: "animal_validation.birth_future" }),
    ]));
  });
  test("uses Zurich today even before midnight UTC", () => {
    expect(validateAnimalConsistency(animal({ dateOfBirth: d("2026-11-09") }), undefined, parents, parents,
      d("2026-11-08T23:30:00Z"))).toEqual([]);
    expect(validateAnimalConsistency(animal({ dateOfBirth: d("2026-07-09") }), undefined, parents, parents,
      d("2026-07-08T22:30:00Z"))).toEqual([]);
  });
  test("allows death on birth or later (including future), rejects earlier", () => {
    for (const date of ["2024-01-01", "2024-01-02", "2030-01-01"]) {
      expect(issues(animal({ dateOfDeath: d(date) }))).toEqual([]);
    }
    expect(issues(animal({ dateOfDeath: d("2023-12-31") }))).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "dateOfDeath", key: "animal_validation.death_before_birth" }),
    ]));
  });
  test("requires date for reason, permits death without reason and clearing both", () => {
    expect(issues(animal({ deathReason: "died" }))).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "deathReason", key: "animal_validation.death_reason_date" }),
    ]));
    expect(issues(animal({ dateOfDeath: d("2025-01-01"), deathReason: "died" }))).toEqual([]);
    const previous = animal({ dateOfDeath: d("2025-01-01"), deathReason: "died" });
    expect(issues({ ...previous, dateOfDeath: null }, previous)).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "deathReason" }),
    ]));
    expect(issues({ ...previous, dateOfDeath: null, deathReason: null }, previous)).toEqual([]);
  });
});

describe("legacy compatibility and effective state", () => {
  test("grandfathers identical invalid values, including equivalent dates", () => {
    const previous = animal({ type: "deer", usage: "milk", dateOfBirth: d("2030-01-01"),
      dateOfDeath: d("2029-01-01"), deathReason: "died", motherId: "father" });
    expect(issues({ ...previous, dateOfBirth: d("2030-01-01T22:00:00Z") }, previous)).toEqual([]);
  });
  test("fixing one contradiction leaves unrelated legacy rules alone", () => {
    const previous = animal({ type: "deer", usage: "milk", deathReason: "died" });
    expect(issues({ ...previous, usage: "other" }, previous)).toEqual([]);
    expect(issues({ ...previous, deathReason: null }, previous)).toEqual([]);
    expect(issues({ ...previous, type: "pig" }, previous)).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "usage" }),
    ]));
  });
  test("changing birth considers retained death", () => {
    const previous = animal({ dateOfDeath: d("2025-01-01") });
    expect(issues({ ...previous, dateOfBirth: d("2025-02-01") }, previous)).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "dateOfDeath" }),
    ]));
  });
  test("parent subrules are independent when a different legacy parent fault is fixed", () => {
    const previous = animal({ type: "goat", motherId: "father" });
    const next = { ...previous, type: "cow" };
    // Fixing species leaves the unchanged wrong parent sex grandfathered.
    expect(issues(next, previous)).toEqual([]);
    expect(issues({ ...next, dateOfBirth: d("2019-01-01") }, previous)).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "animal_validation.parent_birth" }),
    ]));
  });
  test("uses parent's final attributes when both records are edited", () => {
    const previous = animal({ motherId: "mother" });
    const changedParents = new Map(parents).set("mother", { ...mother, sex: "male" });
    expect(issues(previous, previous, changedParents, parents)).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "animal_validation.parent_sex" }),
    ]));
  });
});

describe("validation error contract", () => {
  test.each([["en", en], ["de", de], ["it", it], ["fr", fr]] as const)(
    "uses the %s resource and preserves HTTP 400", async (language, translation) => {
      const i18n = i18next.createInstance();
      await i18n.init({ lng: language, resources: { [language]: { translation } } });
      try {
        assertAnimalConsistency(animal({ type: "pig", usage: "milk" }), undefined, parents, i18n.t, parents, now);
        throw new Error("Expected rejection");
      } catch (error) {
        expect(error).toMatchObject({ status: 400 });
        expect((error as Error).message).toBe(`child: ${translation.animal_validation.usage_species.replace("{{species}}", "pig")}`);
      }
    }
  );
});

describe("normalized import prerequisites", () => {
  const valid = { name: "TAG-1", sexValue: "weiblich", sex: "female" as const,
    dateOfBirth: d("2020-01-01"), birthDatePresent: true };
  test("accepts normalized values, including an already resolved ear-tag name", () => {
    expect(validateImportAnimalPrerequisites(valid)).toEqual([]);
  });
  test("reports all missing operands in established first-error order", () => {
    expect(validateImportAnimalPrerequisites({ name: null, sexValue: null, sex: null,
      dateOfBirth: null, birthDatePresent: false })).toEqual([
      { key: "animal_import.error_name_required" },
      { key: "animal_import.error_sex_required" },
      { key: "animal_import.error_dob_required" },
    ]);
  });
  test("distinguishes unrecognized sex and preserves its normalized value", () => {
    expect(validateImportAnimalPrerequisites({ ...valid, sexValue: "unknown", sex: null })).toEqual([
      { key: "animal_import.error_sex_unknown", params: { value: "unknown" } },
    ]);
  });
  test.each([null, new Date(NaN)])("rejects unusable parsed birth date %s when input was present", (dateOfBirth) => {
    expect(validateImportAnimalPrerequisites({ ...valid, dateOfBirth })).toEqual([
      { key: "animal_import.error_dob_invalid" },
    ]);
  });
  test("does not apply life rules or name normalization to import prerequisites", () => {
    expect(validateImportAnimalPrerequisites({ ...valid, name: " ", dateOfBirth: d("2099-01-01") })).toEqual([]);
  });
  test.each([
    [undefined, undefined, false], [null, undefined, false], ["owner", undefined, true],
    ["owner", "other", true], ["owner", "owner", false], [null, "target", false],
  ] as const)("assigned ear tag owner %s / target %s => conflict %s", (owner, target, expected) => {
    expect(hasAssignedEarTagConflict(owner, target)).toBe(expected);
  });
});

describe("death write normalization", () => {
  const date = d("2025-01-01");
  test("source API enum accepts unknown, died and slaughtered only", () => {
    for (const value of ["unknown", "died", "slaughtered"]) expect(deathReasonSchema.safeParse(value).success).toBe(true);
    expect(deathReasonSchema.safeParse("missing").success).toBe(false);
  });
  test("death date without effective reason becomes unknown without mutating input", () => {
    const patch = { dateOfDeath: date };
    expect(resolveAnimalDeathFields(patch)).toEqual({ dateOfDeath: date, deathReason: "unknown" });
    expect(patch).toEqual({ dateOfDeath: date });
    expect(resolveAnimalDeathFields({ dateOfDeath: date, deathReason: null }))
      .toEqual({ dateOfDeath: date, deathReason: "unknown" });
  });
  test.each(["died", "slaughtered", "unknown"] as const)("retains explicit/stored %s on date-only edit", (deathReason) => {
    expect(resolveAnimalDeathFields({ dateOfDeath: date, deathReason })).toEqual({ dateOfDeath: date, deathReason });
    expect(resolveAnimalDeathFields({ dateOfDeath: date }, { deathReason })).toEqual({ dateOfDeath: date });
  });
  test("normalizes explicit null reason using retained date but does not invent date", () => {
    expect(resolveAnimalDeathFields({ deathReason: null }, { dateOfDeath: date, deathReason: "died" }))
      .toEqual({ deathReason: "unknown" });
    expect(resolveAnimalDeathFields({ deathReason: null }, { dateOfDeath: date, deathReason: null }))
      .toEqual({ deathReason: "unknown" });
    expect(resolveAnimalDeathFields({ deathReason: "died" })).toEqual({ deathReason: "died" });
    expect(resolveAnimalDeathFields({ deathReason: "unknown" })).toEqual({ deathReason: "unknown" });
  });
  test("reason-only edit uses stored date without copying it into patch", () => {
    expect(resolveAnimalDeathFields({ deathReason: "slaughtered" }, { dateOfDeath: date, deathReason: "unknown" }))
      .toEqual({ deathReason: "slaughtered" });
  });
  test("unrelated or undefined-only lifecycle fields do not backfill legacy data", () => {
    const previous = { dateOfDeath: date, deathReason: null };
    expect(resolveAnimalDeathFields({}, previous)).toEqual({});
    expect(resolveAnimalDeathFields({ dateOfDeath: undefined, deathReason: undefined }, previous)).toEqual({});
  });
  test("explicit date-only resubmission opts into unknown normalization", () => {
    expect(resolveAnimalDeathFields({ dateOfDeath: date }, { dateOfDeath: date, deathReason: null }))
      .toEqual({ dateOfDeath: date, deathReason: "unknown" });
  });
  test("clearing date never invents reason and clearing both stays valid", () => {
    expect(resolveAnimalDeathFields({ dateOfDeath: null }, { dateOfDeath: date, deathReason: "died" }))
      .toEqual({ dateOfDeath: null });
    expect(resolveAnimalDeathFields({ dateOfDeath: null, deathReason: null }, { dateOfDeath: date, deathReason: "died" }))
      .toEqual({ dateOfDeath: null, deathReason: null });
  });
});
