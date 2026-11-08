import createHttpError from "http-errors";
import type { TFunction } from "i18next";
import type { animals } from "../db/schema";

/** Only operands used by the consistency rules; no database or HTTP dependencies. */
export type AnimalValidationState = {
  id?: string;
  type: string;
  usage: string;
  sex: string;
  dateOfBirth: Date;
  dateOfDeath?: Date | null;
  deathReason?: string | null;
  motherId?: string | null;
  fatherId?: string | null;
};

export type AnimalValidationIssue = {
  field: string;
  key: "animal_validation.usage_species" | "animal_validation.birth_future"
    | "animal_validation.death_before_birth" | "animal_validation.death_reason_date"
    | "animal_validation.parent_missing" | "animal_validation.parent_self"
    | "animal_validation.parent_sex" | "animal_validation.parent_species" | "animal_validation.parent_birth";
  params?: Record<string, string>;
};

export type AnimalLifecycleFields = Pick<typeof animals.$inferSelect, "dateOfDeath" | "deathReason">;

/** Resolve only actual lifecycle writes; never infer a date or backfill unrelated edits. */
export function resolveAnimalDeathFields(
  patch: Partial<AnimalLifecycleFields>,
  previous?: Pick<AnimalValidationState, "dateOfDeath" | "deathReason">
): Partial<AnimalLifecycleFields> {
  const result: Partial<AnimalLifecycleFields> = {};
  if (patch.dateOfDeath !== undefined) result.dateOfDeath = patch.dateOfDeath;
  if (patch.deathReason !== undefined) result.deathReason = patch.deathReason;
  if (patch.dateOfDeath === undefined && patch.deathReason === undefined) return result;

  const date = patch.dateOfDeath !== undefined ? patch.dateOfDeath : previous?.dateOfDeath;
  const reason = patch.deathReason !== undefined ? patch.deathReason : previous?.deathReason;
  if (date != null && reason == null) result.deathReason = "unknown";
  return result;
}

export type ImportAnimalValidationIssue = {
  key: "animal_import.error_name_required" | "animal_import.error_sex_required"
    | "animal_import.error_sex_unknown" | "animal_import.error_dob_required" | "animal_import.error_dob_invalid";
  params?: Record<string, string>;
};

/** Import-only prerequisites. Callers retain cell parsing, normalization and name fallback. */
export function validateImportAnimalPrerequisites(input: {
  name: string | null | undefined;
  sexValue: string | null | undefined;
  sex: "male" | "female" | null | undefined;
  dateOfBirth: Date | null | undefined;
  birthDatePresent: boolean;
}): ImportAnimalValidationIssue[] {
  const issues: ImportAnimalValidationIssue[] = [];
  if (!input.name) issues.push({ key: "animal_import.error_name_required" });
  if (!input.sexValue) {
    issues.push({ key: "animal_import.error_sex_required" });
  } else if (!input.sex) {
    issues.push({ key: "animal_import.error_sex_unknown", params: { value: input.sexValue } });
  }
  if (!input.birthDatePresent) {
    issues.push({ key: "animal_import.error_dob_required" });
  } else if (!input.dateOfBirth || !Number.isFinite(input.dateOfBirth.getTime())) {
    issues.push({ key: "animal_import.error_dob_invalid" });
  }
  return issues;
}

/** Context is already resolved in the selected farm; no lookup or assignment happens here. */
export function hasAssignedEarTagConflict(
  assignedAnimalId: string | null | undefined,
  mergeAnimalId?: string | null
): boolean {
  return !!assignedAnimalId && assignedAnimalId !== mergeAnimalId;
}

function day(date: Date | null | undefined): number | null {
  return date == null ? null : Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function currentSwissDay(now: Date): number {
  const date = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Zurich", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
  return new Date(`${date}T00:00:00Z`).getTime();
}

/** Each legacy exception is scoped to one rule's unchanged operands, not the whole animal. */
export function validateAnimalConsistency(
  next: AnimalValidationState,
  previous: AnimalValidationState | undefined,
  parents: ReadonlyMap<string, AnimalValidationState>,
  previousParents: ReadonlyMap<string, AnimalValidationState> = parents,
  now: Date = new Date()
): AnimalValidationIssue[] {
  const issues: AnimalValidationIssue[] = [];
  const check = (
    field: string, key: AnimalValidationIssue["key"], operands: readonly unknown[],
    oldOperands: readonly unknown[] | undefined, invalid: boolean, params?: Record<string, string>
  ) => {
    const unchanged = oldOperands !== undefined && operands.length === oldOperands.length
      && operands.every((operand, index) => Object.is(operand, oldOperands[index]));
    if (invalid && !unchanged) issues.push({ field, key, ...(params ? { params } : {}) });
  };

  check("usage", "animal_validation.usage_species", [next.type, next.usage],
    previous && [previous.type, previous.usage],
    next.usage === "milk" && (next.type === "pig" || next.type === "deer"), { species: next.type });
  check("dateOfBirth", "animal_validation.birth_future", [day(next.dateOfBirth)],
    previous && [day(previous.dateOfBirth)], day(next.dateOfBirth)! > currentSwissDay(now));
  check("dateOfDeath", "animal_validation.death_before_birth", [day(next.dateOfBirth), day(next.dateOfDeath)],
    previous && [day(previous.dateOfBirth), day(previous.dateOfDeath)],
    next.dateOfDeath != null && day(next.dateOfDeath)! < day(next.dateOfBirth)!);
  check("deathReason", "animal_validation.death_reason_date", [next.deathReason ?? null, day(next.dateOfDeath)],
    previous && [previous.deathReason ?? null, day(previous.dateOfDeath)],
    next.deathReason != null && next.dateOfDeath == null);

  for (const [field, sex] of [["motherId", "female"], ["fatherId", "male"]] as const) {
    const id = next[field];
    if (!id) continue;
    const oldId = previous?.[field] ?? null;
    const parent = parents.get(id);
    const oldParent = oldId ? previousParents.get(oldId) : undefined;
    const params = { field, sex };
    check(field, "animal_validation.parent_self", [next.id ?? null, id],
      previous && [previous.id ?? null, oldId], next.id === id, params);
    check(field, "animal_validation.parent_missing", [id, !!parent],
      previous && [oldId, !!oldParent], !parent, params);
    if (!parent) continue;
    check(field, "animal_validation.parent_sex", [id, parent.sex],
      previous && [oldId, oldParent?.sex], parent.sex !== sex, params);
    check(field, "animal_validation.parent_species", [id, parent.type, next.type],
      previous && [oldId, oldParent?.type, previous.type], parent.type !== next.type, params);
    check(field, "animal_validation.parent_birth", [id, day(parent.dateOfBirth), day(next.dateOfBirth)],
      previous && [oldId, day(oldParent?.dateOfBirth), day(previous.dateOfBirth)],
      day(parent.dateOfBirth)! >= day(next.dateOfBirth)!, params);
  }
  return issues;
}

export function assertAnimalConsistency(
  next: AnimalValidationState,
  previous: AnimalValidationState | undefined,
  parents: ReadonlyMap<string, AnimalValidationState>,
  t: TFunction,
  previousParents?: ReadonlyMap<string, AnimalValidationState>,
  now?: Date
): void {
  const issues = validateAnimalConsistency(next, previous, parents, previousParents, now);
  if (issues.length) {
    const message = issues.map((issue) => t(issue.key, issue.key, issue.params ?? {})).join("; ");
    throw createHttpError(400, next.id ? `${next.id}: ${message}` : message);
  }
}
