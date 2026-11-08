import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { addYears } from "date-fns";
import createHttpError from "http-errors";
import { TFunction } from "i18next";
import { RlsDb, Transaction } from "../db/db";
import * as tables from "../db/schema";
import { EarTag } from "../ear-tags/ear-tags";
import { Treatment } from "../treatments/treatments";
import { loadImportWorksheet } from "./import-workbook";
import {
  buildMeadowJournal,
  buildOutdoorJournal,
  expandOutdoorSchedule,
  MeadowJournalEntry,
  OutdoorJournalResult,
} from "./outdoor-journal";

// Sex value mapping (all locales combined — values are lowercased before lookup)
const SEX_MAP: Record<string, "male" | "female"> = {
  // German
  weiblich: "female",
  w: "female",
  geiss: "female",
  geiß: "female",
  männlich: "male",
  m: "male",
  bock: "male",
  // Italian
  femmina: "female",
  maschio: "male",
  // French
  femelle: "female",
  mâle: "male",
};

type AnimalUsage = (typeof tables.animalUsage.enumValues)[number];

// Usage value mapping (all locales combined — values are lowercased before lookup)
const USAGE_MAP: Record<string, AnimalUsage> = {
  // German
  milch: "milk",
  milk: "milk",
  andere: "other",
  other: "other",
  "nicht definiert": "other",
  // Italian
  latte: "milk",
  "non definito": "other",
  altro: "other",
  // French
  lait: "milk",
  "non défini": "other",
  autre: "other",
};

// Header name to logical field mapping, keyed by locale. Parent ear tag columns are derived from the
// ear tag headers, see PARENT_SUFFIX.
const HEADER_MAP: Record<string, Record<string, string>> = {
  de: {
    ohrmarkennummer: "earTag",
    "ohrmarken-nr.": "earTag",
    tiername: "name",
    name: "name",
    geschlecht: "sex",
    geburtsdatum: "dateOfBirth",
    nutzungsart: "usage",
    todesdatum: "dateOfDeath",
  },
  it: {
    "numero di marca auricolare": "earTag",
    "numero marca auricolare": "earTag",
    nome: "name",
    sesso: "sex",
    "data di nascita": "dateOfBirth",
    "tipo d'utilizzo": "usage",
    "data del decesso": "dateOfDeath",
    "data di morte": "dateOfDeath",
  },
  fr: {
    "numéro de marque auriculaire": "earTag",
    "no de marque auriculaire": "earTag",
    "no marque auriculaire": "earTag",
    nom: "name",
    sexe: "sex",
    "date de naissance": "dateOfBirth",
    "type d'utilisation": "usage",
    "date de mort": "dateOfDeath",
  },
};

// TVD names parent columns "<ear tag header> (Mutter)", but the ear tag header itself is worded
// slightly differently per export and language (e.g. "No de marque auriculaire" vs "No marque auriculaire (mère)").
const PARENT_SUFFIX = /^(.+?)\s*\((mutter|mère|madre|vater|père|padre)\)$/;
const MOTHER_WORDS = new Set(["mutter", "mère", "madre"]);

function lookupHeader(headerText: string, preferredHeaderMap: Record<string, string>): string | undefined {
  if (Object.hasOwn(preferredHeaderMap, headerText)) {
    return preferredHeaderMap[headerText];
  }
  return Object.values(HEADER_MAP).find((map) => Object.hasOwn(map, headerText))?.[headerText];
}

// Looks up a header's field name, preferring the request's locale but falling back to every other
// known locale before giving up — TVD exports are not always in the farm's configured locale.
function resolveHeaderField(rawHeaderText: string, preferredHeaderMap: Record<string, string>): string | undefined {
  // TVD headers contain non-breaking spaces ("No de marque") and typographic apostrophes.
  const headerText = rawHeaderText.replace(/\s+/g, " ").replace(/’/g, "'");
  const parent = headerText.match(PARENT_SUFFIX);
  if (parent) {
    // Only the parent's ear tag is imported, "Name (Mutter)" and the like are ignored.
    if (lookupHeader(parent[1], preferredHeaderMap) !== "earTag") {
      return undefined;
    }
    return MOTHER_WORDS.has(parent[2]) ? "motherEarTag" : "fatherEarTag";
  }
  return lookupHeader(headerText, preferredHeaderMap);
}

const REQUIRED_IMPORT_COLUMNS = ["earTag", "name", "sex", "dateOfBirth"] as const;

// Throws a localized 400 listing the TVD column names the user has to add to their export.
function assertRequiredImportColumns(columnIndex: Record<string, number>, presentHeaders: string[], t: TFunction) {
  const missingColumns = REQUIRED_IMPORT_COLUMNS.filter((col) => !columnIndex[col]);
  if (missingColumns.length === 0) {
    return;
  }
  console.error(
    `[animals-import] Missing required columns: ${missingColumns.join(", ")}. Headers present in file: ${presentHeaders.join(", ") || "none"}`
  );
  const columns = missingColumns.map((col) => `"${t(`animal_import.columns.${col}`)}"`).join(", ");
  throw createHttpError(
    400,
    t("animal_import.error_missing_columns", { columns, interpolation: { escapeValue: false } })
  );
}

// Parses a date string — supports ISO (YYYY-MM-DD) and DD.MM.YYYY (used in Italian/Swiss TVD exports)
function parseDateString(value: string): Date | null {
  const dotFormat = value.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (dotFormat) {
    const [, day, month, year] = dotFormat;
    const d = new Date(`${year}-${month}-${day}`);
    return isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

export type SkippedRow = {
  row: number;
  earTagNumber: string | null;
  name: string | null;
  reason: string;
};

export type ImportResult = {
  skipped: SkippedRow[];
  summary: {
    totalRows: number;
    imported: number;
    skipped: number;
  };
};

export type AnimalType = (typeof tables.animalType.enumValues)[number];
export type AnimalCategory = (typeof tables.animalCategory.enumValues)[number];
export type AnimalSex = (typeof tables.animalSex.enumValues)[number];
export type AnimalDeathReason = (typeof tables.deathReason.enumValues)[number];

export type Herd = typeof tables.herds.$inferSelect;
export type HerdMembership = typeof tables.herdMemberships.$inferSelect;
export type OutdoorSchedule = typeof tables.outdoorSchedules.$inferSelect;
export type OutdoorScheduleRecurrence = typeof tables.outdoorScheduleRecurrences.$inferSelect;

export type OutdoorScheduleWithRecurrence = OutdoorSchedule & {
  recurrence: OutdoorScheduleRecurrence | null;
};
export type OutdoorScheduleType = (typeof tables.outdoorScheduleType.enumValues)[number];

export type OutdoorScheduleCreateInput = {
  startDate: Date;
  endDate?: Date | null;
  type: OutdoorScheduleType;
  notes?: string | null;
  meadowId?: string | null;
  recurrence?: {
    frequency: (typeof tables.frequency.enumValues)[number];
    interval: number;
    byWeekday?: (typeof tables.weekday.enumValues)[number][] | null;
    byMonthDay?: number | null;
    until?: string | null;
    count?: number | null;
  } | null;
};

export type OutdoorScheduleUpdateInput = Partial<OutdoorScheduleCreateInput>;

// Build a minimal OutdoorScheduleWithRecurrence from a create input so it can
// be passed to expandOutdoorSchedule without needing real DB ids.
function inputToSchedule(input: OutdoorScheduleCreateInput): OutdoorScheduleWithRecurrence {
  return {
    id: "",
    farmId: "",
    herdId: "",
    meadowId: input.meadowId ?? null,
    startDate: input.startDate,
    endDate: input.endDate ?? null,
    type: input.type,
    notes: input.notes ?? null,
    recurrence: input.recurrence
      ? {
          id: "",
          farmId: "",
          outdoorScheduleId: "",
          frequency: input.recurrence.frequency,
          interval: input.recurrence.interval,
          byWeekday: input.recurrence.byWeekday ?? null,
          byMonthDay: input.recurrence.byMonthDay ?? null,
          until: input.recurrence.until ?? null,
          count: input.recurrence.count ?? null,
        }
      : null,
  };
}

// Meadow FK checks bypass RLS, so make sure referenced meadows are visible to (= belong to) the current farm.
// Archived meadows can't get new schedules. Schedules already linked before (previouslyLinkedMeadowIds) stay allowed
// as long as they don't run on or after the archive date.
async function assertMeadowsAccessible(
  tx: Transaction,
  schedules: OutdoorScheduleWithRecurrence[],
  previouslyLinkedMeadowIds: (string | null)[] = []
) {
  const uniqueMeadowIds = [
    ...new Set(schedules.map((schedule) => schedule.meadowId).filter((meadowId): meadowId is string => !!meadowId)),
  ];
  if (uniqueMeadowIds.length === 0) return;
  const foundMeadows = await tx.query.meadows.findMany({
    where: { id: { in: uniqueMeadowIds } },
    columns: { id: true, archivedAt: true },
  });
  if (foundMeadows.length !== uniqueMeadowIds.length) {
    throw createHttpError(400, "Meadow not found");
  }
  for (const meadow of foundMeadows) {
    if (!meadow.archivedAt) continue;
    if (!previouslyLinkedMeadowIds.includes(meadow.id)) {
      throw createHttpError(400, "Meadow is archived");
    }
    const archiveDay = swissUtcDay(meadow.archivedAt);
    const farFuture = addYears(archiveDay, 100);
    const runsAfterArchive = schedules.some(
      (schedule) => schedule.meadowId === meadow.id && expandOutdoorSchedule(schedule, archiveDay, farFuture).length > 0
    );
    if (runsAfterArchive) {
      throw createHttpError(400, "Meadow is archived");
    }
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;

// Calendar day as UTC midnight, matching how date columns are written and read back
function toUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

// Calendar day of a timestamp in Swiss local time as UTC midnight. toUtcDay would give the previous day
// between 00:00 and 01:00/02:00 local time.
export function swissUtcDay(date: Date): Date {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Zurich",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
  return new Date(`${parts}T00:00:00.000Z`);
}

export function todayUtcDay(): Date {
  return swissUtcDay(new Date());
}

// Per animal: its active membership, and the first day a herd change can take effect without overlapping its
// history (the active membership's start, else the day after the last closed one; null without any history).
// Shared by changeHerdMemberships and the endpoint the clients use to limit the effective date they offer.
async function loadHerdMembershipLimits(tx: Transaction, animalIds: string[]) {
  const activeMemberships = await tx.query.herdMemberships.findMany({
    where: { animalId: { in: animalIds }, toDate: { isNull: true } },
  });
  const activeMembershipByAnimalId = new Map(activeMemberships.map((membership) => [membership.animalId, membership]));

  // Latest closed membership per animal, only needed for animals without an active one
  const animalIdsWithoutActive = animalIds.filter((animalId) => !activeMembershipByAnimalId.has(animalId));
  const latestClosedMemberships =
    animalIdsWithoutActive.length > 0
      ? await tx
          .selectDistinctOn([tables.herdMemberships.animalId], {
            animalId: tables.herdMemberships.animalId,
            toDate: tables.herdMemberships.toDate,
          })
          .from(tables.herdMemberships)
          .where(
            and(
              inArray(tables.herdMemberships.animalId, animalIdsWithoutActive),
              isNotNull(tables.herdMemberships.toDate)
            )
          )
          .orderBy(tables.herdMemberships.animalId, desc(tables.herdMemberships.toDate))
      : [];
  const latestClosedToDateByAnimalId = new Map(
    latestClosedMemberships.map((membership) => [membership.animalId, membership.toDate])
  );

  const earliestHerdChangeDateByAnimalId = new Map<string, Date | null>();
  for (const animalId of animalIds) {
    const activeMembership = activeMembershipByAnimalId.get(animalId);
    const latestClosedToDate = latestClosedToDateByAnimalId.get(animalId);
    earliestHerdChangeDateByAnimalId.set(
      animalId,
      activeMembership
        ? activeMembership.fromDate
        : latestClosedToDate
          ? new Date(latestClosedToDate.getTime() + DAY_MS)
          : null
    );
  }
  return { activeMembershipByAnimalId, earliestHerdChangeDateByAnimalId };
}

// Moves animals into targetHerdId (or out of any herd when null) as of effectiveDate.
// Membership ranges are inclusive on both ends, so the previous membership ends the day before effectiveDate.
// Animals whose active membership already is in the target herd are left untouched.
// An effectiveDate before the animal's existing history would create overlapping memberships:
// mode "strict" rejects it (explicit user input), mode "clamp" moves it to the first free day (implicit defaults).
async function changeHerdMemberships(
  tx: Transaction,
  animalIds: string[],
  targetHerdId: string | null,
  requestedEffectiveDate: Date,
  mode: "strict" | "clamp"
) {
  // Duplicates would otherwise insert the same membership twice
  const uniqueAnimalIds = [...new Set(animalIds)];
  if (uniqueAnimalIds.length === 0) return;

  const { activeMembershipByAnimalId, earliestHerdChangeDateByAnimalId } = await loadHerdMembershipLimits(
    tx,
    uniqueAnimalIds
  );

  const membershipIdsToDelete: string[] = [];
  // Active memberships to close, grouped by their new toDate so each date needs one update
  const membershipIdsToCloseByToDate = new Map<number, string[]>();
  const membershipsToInsert: { animalId: string; herdId: string; fromDate: Date }[] = [];
  const changedAnimalIds: string[] = [];

  for (const animalId of uniqueAnimalIds) {
    const activeMembership = activeMembershipByAnimalId.get(animalId);
    if ((activeMembership?.herdId ?? null) === targetHerdId) continue;

    const earliestAllowedDate = earliestHerdChangeDateByAnimalId.get(animalId) ?? null;

    let effectiveDate = toUtcDay(requestedEffectiveDate);
    if (earliestAllowedDate && effectiveDate < earliestAllowedDate) {
      if (mode === "strict") {
        throw createHttpError(400, "Effective date is before the animal's current herd membership");
      }
      effectiveDate = earliestAllowedDate;
    }

    if (activeMembership) {
      if (activeMembership.fromDate.getTime() === effectiveDate.getTime()) {
        // Replaced on the day it started, so it never applied
        membershipIdsToDelete.push(activeMembership.id);
      } else {
        const closingToDate = effectiveDate.getTime() - DAY_MS;
        const idsForToDate = membershipIdsToCloseByToDate.get(closingToDate) ?? [];
        idsForToDate.push(activeMembership.id);
        membershipIdsToCloseByToDate.set(closingToDate, idsForToDate);
      }
    }

    if (targetHerdId) {
      membershipsToInsert.push({
        animalId,
        herdId: targetHerdId,
        fromDate: effectiveDate,
      });
    }
    changedAnimalIds.push(animalId);
  }

  if (membershipIdsToDelete.length > 0) {
    await tx.delete(tables.herdMemberships).where(inArray(tables.herdMemberships.id, membershipIdsToDelete));
  }
  for (const [closingToDate, membershipIds] of membershipIdsToCloseByToDate) {
    await tx
      .update(tables.herdMemberships)
      .set({ toDate: new Date(closingToDate) })
      .where(inArray(tables.herdMemberships.id, membershipIds));
  }
  if (membershipsToInsert.length > 0) {
    await tx
      .insert(tables.herdMemberships)
      .values(membershipsToInsert.map((membership) => ({ ...tables.farmIdColumnValue, ...membership })));
  }
  if (changedAnimalIds.length > 0) {
    await tx.update(tables.animals).set({ herdId: targetHerdId }).where(inArray(tables.animals.id, changedAnimalIds));
  }
}

const meadowSummaryColumns = { columns: { id: true, name: true, size: true } } as const;

// Checks if any two schedules in the list produce overlapping concrete occurrences.
// Uses a 25-year window starting from the earliest schedule start date.
export function hasScheduleOverlap(schedules: OutdoorScheduleWithRecurrence[]): boolean {
  if (schedules.length < 2) return false;
  const windowFrom = schedules.reduce((min, s) => (s.startDate < min ? s.startDate : min), schedules[0].startDate);
  const windowTo = new Date(windowFrom.getFullYear() + 25, windowFrom.getMonth(), windowFrom.getDate());
  const expanded = schedules.map((s) => expandOutdoorSchedule(s, windowFrom, windowTo));
  for (let i = 0; i < expanded.length; i++) {
    for (let j = i + 1; j < expanded.length; j++) {
      for (const a of expanded[i]) {
        for (const b of expanded[j]) {
          if (a.startDate <= b.endDate && b.startDate <= a.endDate) return true;
        }
      }
    }
  }
  return false;
}

export type AnimalCreateInput = Omit<typeof tables.animals.$inferInsert, "id" | "farmId">;
export type AnimalUpdateInput = Partial<AnimalCreateInput>;
export type BatchUpdateAnimalInput = {
  type?: AnimalType;
  usage?: AnimalUsage;
  registered?: boolean;
  dateOfDeath?: Date;
  deathReason?: AnimalDeathReason;
  motherId?: string | null;
  fatherId?: string | null;
};
export type CustomOutdoorJournalCategory = typeof tables.customOutdoorJournalCategories.$inferSelect;
export type Animal = typeof tables.animals.$inferSelect & {
  earTag: EarTag | null;
};

export type ParsedImportRow = {
  rowNumber: number;
  earTagNumber: string | null;
  earTagId: string | null; // non-null if an existing unassigned ear tag was found in DB
  earTagAssigned: boolean; // true if the ear tag is already assigned to a different animal
  assignedToAnimalId: string | null; // the animal that currently holds this ear tag (if earTagAssigned)
  assignedToAnimalName: string | null;
  name: string | null;
  sex: "male" | "female" | null;
  dateOfBirth: Date | null;
  usage: AnimalUsage | null;
  dateOfDeath: Date | null;
  deathReason: AnimalDeathReason | null; // preset to "died" when dateOfDeath is present
  motherEarTagNumber: string | null;
  fatherEarTagNumber: string | null;
  parseErrors: string[]; // empty means the row is importable as-is
};

export type CommitImportRow = {
  earTagNumber?: string | null;
  earTagId?: string | null;
  name: string;
  sex: "male" | "female";
  dateOfBirth: Date;
  usage: AnimalUsage;
  dateOfDeath?: Date | null;
  deathReason?: AnimalDeathReason | null;
  motherEarTagNumber?: string | null;
  fatherEarTagNumber?: string | null;
  mergeAnimalId?: string | null; // if set, update existing animal instead of creating a new one
};

export type CommitImportResult = {
  created: number;
  merged: number;
  skipped: Array<{ index: number; reason: string }>; // 0-based index into the input rows array
};
export type FamilyTreeNode = {
  id: string;
  name: string;
  earTagNumber: string | null;
  dateOfBirth: Date;
  dateOfDeath: Date | null;
  sex: "male" | "female";
};

export type FamilyTreeEdge = {
  parentId: string;
  childId: string;
  relation: "mother" | "father";
};

export type FamilyTreeResult = {
  nodes: FamilyTreeNode[];
  edges: FamilyTreeEdge[];
};

export type AnimalWithRelations = Animal & {
  mother: Animal | null;
  father: Animal | null;
  childrenAsMother: Animal[];
  childrenAsFather: Animal[];
  treatments: Treatment[];
  herd: Herd | null;
  customOutdoorJournalCategories: CustomOutdoorJournalCategory[];
};

export function animalsApi(rlsDb: RlsDb, t: TFunction) {
  return {
    async createAnimal(input: AnimalCreateInput & { herdEffectiveDate?: Date | null }): Promise<Animal> {
      const { herdEffectiveDate, ...animalInput } = input;
      const result = await rlsDb.rls(async (tx) => {
        const [result] = await tx
          .insert(tables.animals)
          .values({
            ...tables.farmIdColumnValue,
            ...animalInput,
          })
          .returning();

        // Create herd membership if animal is assigned to a herd
        if (animalInput.herdId) {
          await changeHerdMemberships(
            tx,
            [result.id],
            animalInput.herdId,
            herdEffectiveDate ?? todayUtcDay(),
            "strict"
          );
        }

        return result;
      });
      const animal = await rlsDb.rls(async (tx) => {
        return tx.query.animals.findFirst({
          where: { id: result.id },
          with: {
            earTag: true,
          },
        });
      });
      return animal!;
    },

    async getAnimalById(id: string): Promise<AnimalWithRelations | undefined> {
      return rlsDb.rls(async (tx) => {
        const result = await tx.query.animals.findFirst({
          where: { id },
          with: {
            earTag: true,
            mother: {
              with: {
                earTag: true,
              },
            },
            father: {
              with: {
                earTag: true,
              },
            },
            childrenAsFather: {
              with: {
                earTag: true,
              },
            },
            childrenAsMother: {
              with: {
                earTag: true,
              },
            },
            animalTreatments: {
              with: {
                treatment: true,
              },
            },
            herd: true,
            customOutdoorJournalCategories: true,
          },
        });
        if (!result) return undefined;
        return {
          ...result,
          treatments: result.animalTreatments.map((at) => at.treatment),
        };
      });
    },

    // First day a herd change can take effect for each animal (null: no herd history yet)
    async getEarliestHerdChangeDates(animalIds: string[]): Promise<{ animalId: string; earliestDate: Date | null }[]> {
      const uniqueAnimalIds = [...new Set(animalIds)];
      if (uniqueAnimalIds.length === 0) return [];
      return rlsDb.rls(async (tx) => {
        const { earliestHerdChangeDateByAnimalId } = await loadHerdMembershipLimits(tx, uniqueAnimalIds);
        return uniqueAnimalIds.map((animalId) => ({
          animalId,
          earliestDate: earliestHerdChangeDateByAnimalId.get(animalId) ?? null,
        }));
      });
    },

    async getAnimalsForFarm(
      farmId: string,
      onlyLiving: boolean,
      animalTypes?: AnimalType[]
    ): Promise<Array<Animal & { milkAndMeatUsable: boolean }>> {
      return rlsDb.rls(async (tx) => {
        return tx.query.animals.findMany({
          where: {
            farmId,
            type: { in: animalTypes },
            dateOfDeath: onlyLiving ? { isNull: true } : undefined,
          },
          with: {
            earTag: true,
          },
          extras: {
            milkAndMeatUsable: (table) =>
              sql<boolean>`NOT EXISTS (
                  SELECT 1 FROM ${tables.animalTreatments}
                  JOIN ${tables.treatments} ON ${tables.treatments.id} = ${tables.animalTreatments.treatmentId}
                  WHERE ${tables.animalTreatments.animalId} = ${table.id}
                  AND (${tables.treatments.milkUsableDate} > NOW() OR ${tables.treatments.meatUsableDate} > NOW())
              )`.as("milk_and_meat_usable"),
          },
        });
      });
    },

    async getFamilyTree(farmId: string, type: AnimalType): Promise<FamilyTreeResult> {
      const allAnimals = await rlsDb.rls(async (tx) => {
        return tx.query.animals.findMany({
          where: { farmId, type },
          with: { earTag: true },
        });
      });

      const animalIds = new Set(allAnimals.map((a) => a.id));

      const nodes: FamilyTreeNode[] = allAnimals.map((a) => ({
        id: a.id,
        name: a.name,
        earTagNumber: a.earTag?.number ?? null,
        dateOfBirth: a.dateOfBirth,
        dateOfDeath: a.dateOfDeath ?? null,
        sex: a.sex,
      }));

      const edges: FamilyTreeEdge[] = [];
      for (const a of allAnimals) {
        if (a.motherId && animalIds.has(a.motherId)) {
          edges.push({ parentId: a.motherId, childId: a.id, relation: "mother" });
        }
        if (a.fatherId && animalIds.has(a.fatherId)) {
          edges.push({ parentId: a.fatherId, childId: a.id, relation: "father" });
        }
      }

      return { nodes, edges };
    },

    async updateAnimals(
      data: Array<AnimalUpdateInput & { id: string; herdEffectiveDate?: Date | null }>
    ): Promise<Animal[]> {
      await rlsDb.rls(async (tx) => {
        for (const { id, herdId, herdEffectiveDate, ...animal } of data) {
          if (Object.keys(animal).length > 0) {
            await tx.update(tables.animals).set(animal).where(eq(tables.animals.id, id));
          }
          // Herd changes go through memberships so the outdoor journal history stays correct
          if (herdId !== undefined) {
            await changeHerdMemberships(
              tx,
              [id],
              herdId,
              herdEffectiveDate ?? todayUtcDay(),
              herdEffectiveDate ? "strict" : "clamp"
            );
          }
        }
      });
      const result = await rlsDb.rls(async (tx) => {
        return tx.query.animals.findMany({
          where: { id: { in: data.map(({ id }) => id) } },
          with: {
            earTag: true,
          },
        });
      });
      return result!;
    },

    async updateAnimal(id: string, input: AnimalUpdateInput & { herdEffectiveDate?: Date | null }): Promise<Animal> {
      const { herdId, herdEffectiveDate, ...data } = input;
      const result = await rlsDb.rls(async (tx) => {
        const [result] =
          Object.keys(data).length > 0
            ? await tx
                .update(tables.animals)
                .set(data)
                .where(eq(tables.animals.id, id))
                .returning({ id: tables.animals.id })
            : await tx.select({ id: tables.animals.id }).from(tables.animals).where(eq(tables.animals.id, id));

        // Herd changes go through memberships so the outdoor journal history stays correct
        if (result && herdId !== undefined) {
          await changeHerdMemberships(
            tx,
            [id],
            herdId,
            herdEffectiveDate ?? todayUtcDay(),
            herdEffectiveDate ? "strict" : "clamp"
          );
        }
        return result;
      });

      const animal = await rlsDb.rls(async (tx) => {
        return tx.query.animals.findFirst({
          where: { id: result.id },
          with: {
            earTag: true,
          },
        });
      });
      return animal!;
    },

    async batchUpdateAnimals(animalIds: string[], data: BatchUpdateAnimalInput): Promise<Animal[]> {
      return rlsDb.rls(async (tx) => {
        await tx.update(tables.animals).set(data).where(inArray(tables.animals.id, animalIds));
        return tx.query.animals.findMany({
          where: { id: { in: animalIds } },
          with: {
            earTag: true,
          },
        });
      });
    },

    async deleteAnimals(animalIds: string[]) {
      return rlsDb.rls(async (tx) => {
        await tx.delete(tables.animals).where(inArray(tables.animals.id, animalIds));
      });
    },

    async deleteAnimal(id: string): Promise<void> {
      return rlsDb.rls(async (tx) => {
        await tx.delete(tables.animals).where(eq(tables.animals.id, id));
      });
    },

    async getChildrenOfAnimal(animalId: string): Promise<Animal[]> {
      return rlsDb.rls(async (tx) => {
        return tx.query.animals.findMany({
          where: {
            OR: [
              {
                motherId: animalId,
              },
              {
                fatherId: animalId,
              },
            ],
          },
          with: {
            earTag: true,
          },
        });
      });
    },

    // --- Herds CRUD ---

    async getHerdsForFarm(farmId: string) {
      return rlsDb.rls(async (tx) => {
        return tx.query.herds.findMany({
          where: { farmId },
          with: {
            animals: { with: { earTag: true } },
            outdoorSchedules: { with: { recurrence: true, meadow: meadowSummaryColumns } },
          },
        });
      });
    },

    async getHerdById(id: string) {
      return rlsDb.rls(async (tx) => {
        return tx.query.herds.findFirst({
          where: { id },
          with: {
            animals: { with: { earTag: true } },
            outdoorSchedules: { with: { recurrence: true, meadow: meadowSummaryColumns } },
          },
        });
      });
    },

    async createHerd(
      input: { name: string },
      animalIds: string[],
      outdoorSchedules?: OutdoorScheduleCreateInput[],
      effectiveDate?: Date | null
    ) {
      // Validate overlap among schedules before entering the transaction
      if (outdoorSchedules?.length) {
        if (hasScheduleOverlap(outdoorSchedules.map(inputToSchedule))) {
          throw createHttpError(409, "Schedule overlaps with another schedule");
        }
      }

      return rlsDb.rls(async (tx) => {
        await assertMeadowsAccessible(tx, outdoorSchedules?.map(inputToSchedule) ?? []);

        const [herd] = await tx
          .insert(tables.herds)
          .values({ ...tables.farmIdColumnValue, ...input })
          .returning();

        if (animalIds.length > 0) {
          if (effectiveDate) {
            await changeHerdMemberships(tx, animalIds, herd.id, effectiveDate, "strict");
          } else {
            // Without an explicit date: if schedules are provided and the earliest startDate is in the past, backdate
            // membership to that date so the outdoor journal reflects the full schedule history. Clamped per animal so
            // it never overlaps an earlier membership in another herd.
            const today = todayUtcDay();
            const earliestScheduleStart =
              outdoorSchedules && outdoorSchedules.length > 0
                ? outdoorSchedules.reduce(
                    (earliest, s) => (s.startDate < earliest ? s.startDate : earliest),
                    outdoorSchedules[0].startDate
                  )
                : null;
            const membershipFromDate =
              earliestScheduleStart && earliestScheduleStart < today ? earliestScheduleStart : today;
            await changeHerdMemberships(tx, animalIds, herd.id, membershipFromDate, "clamp");
          }
        }

        // Create outdoor schedules if provided (overlap already validated above)
        if (outdoorSchedules?.length) {
          for (const { recurrence, ...scheduleInput } of outdoorSchedules) {
            const [schedule] = await tx
              .insert(tables.outdoorSchedules)
              .values({
                ...tables.farmIdColumnValue,
                herdId: herd.id,
                ...scheduleInput,
              })
              .returning();

            if (recurrence) {
              await tx.insert(tables.outdoorScheduleRecurrences).values({
                ...tables.farmIdColumnValue,
                outdoorScheduleId: schedule.id,
                ...recurrence,
              });
            }
          }
        }

        return herd;
      });
    },

    async updateHerd(
      id: string,
      input: { name?: string },
      animalIds?: string[],
      outdoorSchedules?: OutdoorScheduleCreateInput[],
      effectiveDate?: Date | null
    ) {
      // Validate overlap among new schedules before entering the transaction
      if (outdoorSchedules?.length) {
        if (hasScheduleOverlap(outdoorSchedules.map(inputToSchedule))) {
          throw createHttpError(409, "Schedule overlaps with another schedule");
        }
      }

      return rlsDb.rls(async (tx) => {
        if (outdoorSchedules !== undefined) {
          const existingSchedules = await tx.query.outdoorSchedules.findMany({
            where: { herdId: id },
            columns: { meadowId: true },
          });
          await assertMeadowsAccessible(
            tx,
            outdoorSchedules.map(inputToSchedule),
            existingSchedules.map((schedule) => schedule.meadowId)
          );
        }

        // Only run the update if there are fields to set (avoids Drizzle "No values to set" error)
        const [herd] =
          Object.keys(input).length > 0
            ? await tx.update(tables.herds).set(input).where(eq(tables.herds.id, id)).returning()
            : await tx.query.herds.findMany({ where: { id }, limit: 1 });

        // If animalIds provided, it is the new full member list: only animals that were added or removed change
        // memberships, unchanged animals keep their history
        if (animalIds !== undefined) {
          const membershipDate = effectiveDate ?? todayUtcDay();
          const membershipMode = effectiveDate ? "strict" : "clamp";
          const activeMemberships = await tx.query.herdMemberships.findMany({
            where: { herdId: id, toDate: { isNull: true } },
            columns: { animalId: true },
          });
          const currentAnimalIds = new Set(activeMemberships.map((membership) => membership.animalId));
          const newAnimalIds = new Set(animalIds);
          const removedAnimalIds = [...currentAnimalIds].filter((animalId) => !newAnimalIds.has(animalId));
          const addedAnimalIds = [...newAnimalIds].filter((animalId) => !currentAnimalIds.has(animalId));

          await changeHerdMemberships(tx, removedAnimalIds, null, membershipDate, membershipMode);
          await changeHerdMemberships(tx, addedAnimalIds, id, membershipDate, membershipMode);

          // Repair denormalized herdId for animals pointing at this herd without an active membership
          const staleAnimalIds = await tx
            .select({ id: tables.animals.id })
            .from(tables.animals)
            .where(eq(tables.animals.herdId, id));
          const strayAnimalIds = staleAnimalIds
            .map((animal) => animal.id)
            .filter((animalId) => !newAnimalIds.has(animalId));
          if (strayAnimalIds.length > 0) {
            await tx.update(tables.animals).set({ herdId: null }).where(inArray(tables.animals.id, strayAnimalIds));
          }
        }

        // If outdoorSchedules provided, delete all existing and replace with new ones
        if (outdoorSchedules !== undefined) {
          // Recurrences cascade-delete with their parent schedule
          await tx.delete(tables.outdoorSchedules).where(eq(tables.outdoorSchedules.herdId, id));

          // Create new schedules (overlap already validated above)
          for (const { recurrence, ...scheduleInput } of outdoorSchedules) {
            const [schedule] = await tx
              .insert(tables.outdoorSchedules)
              .values({
                ...tables.farmIdColumnValue,
                herdId: id,
                ...scheduleInput,
              })
              .returning();

            if (recurrence) {
              await tx.insert(tables.outdoorScheduleRecurrences).values({
                ...tables.farmIdColumnValue,
                outdoorScheduleId: schedule.id,
                ...recurrence,
              });
            }
          }
        }

        return herd;
      });
    },

    async deleteHerd(id: string) {
      return rlsDb.rls(async (tx) => {
        await tx.delete(tables.herds).where(eq(tables.herds.id, id));
      });
    },

    // --- Outdoor Schedules CRUD ---

    async getOutdoorSchedulesForHerd(herdId: string) {
      return rlsDb.rls(async (tx) => {
        return tx.query.outdoorSchedules.findMany({
          where: { herdId },
          with: { recurrence: true, meadow: meadowSummaryColumns },
        });
      });
    },

    async getOutdoorScheduleById(id: string) {
      return rlsDb.rls(async (tx) => {
        return tx.query.outdoorSchedules.findFirst({
          where: { id },
          with: { recurrence: true, meadow: meadowSummaryColumns },
        });
      });
    },

    async createOutdoorSchedule(
      herdId: string,
      input: OutdoorScheduleCreateInput
    ): Promise<OutdoorScheduleWithRecurrence> {
      const { recurrence, ...scheduleInput } = input;

      // Validate no overlap with existing schedules for this herd
      const existing = await this.getOutdoorSchedulesForHerd(herdId);
      if (hasScheduleOverlap([...existing, inputToSchedule(input)])) {
        throw createHttpError(409, "Schedule overlaps with existing schedule");
      }

      const result = await rlsDb.rls(async (tx) => {
        await assertMeadowsAccessible(tx, [inputToSchedule(input)]);

        const [schedule] = await tx
          .insert(tables.outdoorSchedules)
          .values({
            ...tables.farmIdColumnValue,
            herdId,
            ...scheduleInput,
          })
          .returning();

        if (recurrence) {
          await tx.insert(tables.outdoorScheduleRecurrences).values({
            ...tables.farmIdColumnValue,
            outdoorScheduleId: schedule.id,
            ...recurrence,
          });
        }

        return schedule;
      });

      const created = await this.getOutdoorScheduleById(result.id);
      return created!;
    },

    async updateOutdoorSchedule(id: string, input: OutdoorScheduleUpdateInput): Promise<OutdoorScheduleWithRecurrence> {
      const { recurrence, ...scheduleData } = input;

      // Fetch current schedule to know its herdId
      const current = await this.getOutdoorScheduleById(id);
      if (!current) {
        throw createHttpError(404, "Outdoor schedule not found");
      }

      const updatedSchedule: OutdoorScheduleWithRecurrence = {
        ...current,
        meadowId: scheduleData.meadowId !== undefined ? scheduleData.meadowId : current.meadowId,
        startDate: scheduleData.startDate ?? current.startDate,
        endDate: scheduleData.endDate !== undefined ? scheduleData.endDate : current.endDate,
        recurrence:
          recurrence !== undefined
            ? recurrence
              ? {
                  ...current.recurrence,
                  id: current.recurrence?.id ?? "",
                  farmId: current.farmId,
                  outdoorScheduleId: current.id,
                  ...recurrence,
                  until: recurrence.until ?? null,
                  byWeekday: recurrence.byWeekday ?? null,
                  byMonthDay: recurrence.byMonthDay ?? null,
                  count: recurrence.count ?? null,
                }
              : null
            : current.recurrence,
      };

      // Validate no overlap (exclude self)
      if (scheduleData.startDate !== undefined || scheduleData.endDate !== undefined || recurrence !== undefined) {
        const existing = await this.getOutdoorSchedulesForHerd(current.herdId);
        if (hasScheduleOverlap([...existing.filter((s) => s.id !== id), updatedSchedule])) {
          throw createHttpError(409, "Schedule overlaps with existing schedule");
        }
      }

      await rlsDb.rls(async (tx) => {
        await assertMeadowsAccessible(tx, [updatedSchedule], [current.meadowId]);

        // Update schedule fields if any provided
        if (Object.keys(scheduleData).length > 0) {
          await tx.update(tables.outdoorSchedules).set(scheduleData).where(eq(tables.outdoorSchedules.id, id));
        }

        // Handle recurrence upsert/delete
        if (recurrence !== undefined) {
          const existingRecurrence = await tx.query.outdoorScheduleRecurrences.findFirst({
            where: { outdoorScheduleId: id },
          });

          if (recurrence === null) {
            if (existingRecurrence) {
              await tx
                .delete(tables.outdoorScheduleRecurrences)
                .where(eq(tables.outdoorScheduleRecurrences.outdoorScheduleId, id));
            }
          } else if (existingRecurrence) {
            await tx
              .update(tables.outdoorScheduleRecurrences)
              .set(recurrence)
              .where(eq(tables.outdoorScheduleRecurrences.outdoorScheduleId, id));
          } else {
            await tx.insert(tables.outdoorScheduleRecurrences).values({
              ...tables.farmIdColumnValue,
              outdoorScheduleId: id,
              ...recurrence,
            });
          }
        }
      });

      const updated = await this.getOutdoorScheduleById(id);
      return updated!;
    },

    async deleteOutdoorSchedule(id: string) {
      return rlsDb.rls(async (tx) => {
        await tx.delete(tables.outdoorSchedules).where(eq(tables.outdoorSchedules.id, id));
      });
    },

    // Replace all custom outdoor journal categories for an animal, with overlap validation
    async setCustomOutdoorJournalCategories(
      animalId: string,
      entries: {
        startDate: Date;
        endDate?: Date | null;
        category: AnimalCategory;
      }[]
    ): Promise<CustomOutdoorJournalCategory[]> {
      // Validate no overlaps among the entries
      const rangeSchedules = entries.map((e) =>
        inputToSchedule({ startDate: e.startDate, endDate: e.endDate, type: "pasture", recurrence: null })
      );
      if (hasScheduleOverlap(rangeSchedules)) {
        throw createHttpError(409, "Custom outdoor journal category date ranges overlap");
      }

      return rlsDb.rls(async (tx) => {
        // Delete existing entries for this animal
        await tx
          .delete(tables.customOutdoorJournalCategories)
          .where(eq(tables.customOutdoorJournalCategories.animalId, animalId));

        if (entries.length === 0) return [];

        return tx
          .insert(tables.customOutdoorJournalCategories)
          .values(
            entries.map((e) => ({
              ...tables.farmIdColumnValue,
              animalId,
              startDate: e.startDate,
              endDate: e.endDate ?? null,
              category: e.category,
            }))
          )
          .returning();
      });
    },

    async getHerdsWithMembershipsForFarm(farmId: string) {
      return rlsDb.rls(async (tx) => {
        return tx.query.herds.findMany({
          where: { farmId },
          with: {
            herdMemberships: {
              with: {
                animal: {
                  with: { earTag: true, customOutdoorJournalCategories: true },
                },
              },
            },
            outdoorSchedules: { with: { recurrence: true, meadow: meadowSummaryColumns } },
          },
        });
      });
    },

    async getOutdoorJournal(
      farmId: string,
      fromDate: Date,
      toDate: Date
    ): Promise<OutdoorJournalResult & { meadowEntries: MeadowJournalEntry[] }> {
      const herds = await this.getHerdsWithMembershipsForFarm(farmId);
      return {
        ...buildOutdoorJournal(herds, fromDate, toDate),
        meadowEntries: buildMeadowJournal(herds, fromDate, toDate),
      };
    },

    // Import animals from an Excel file buffer. Uses header row to detect columns by name.
    async importFromExcel(
      fileBuffer: Buffer,
      type: AnimalType,
      skipHeaderRow: boolean,
      farmId: string,
      locale: string = "de"
    ): Promise<ImportResult> {
      const worksheet = await loadImportWorksheet(fileBuffer, t);

      // Build column index map from header row
      const headerMap = HEADER_MAP[locale] ?? HEADER_MAP["de"];
      const columnIndex: Record<string, number> = {};

      if (!skipHeaderRow) {
        throw createHttpError(400, "A header row is required for import.");
      }

      const headerRow = worksheet.getRow(1);
      const presentHeaders: string[] = [];
      headerRow.eachCell((cell, colNumber) => {
        const headerText = cell.text?.trim().toLowerCase();
        if (headerText) {
          presentHeaders.push(headerText);
          const field = resolveHeaderField(headerText, headerMap);
          if (field) {
            columnIndex[field] = colNumber;
          }
        }
      });

      assertRequiredImportColumns(columnIndex, presentHeaders, t);

      // Fetch all existing ear tags for this farm to check for duplicates (with animal assignment info)
      const existingEarTags = await rlsDb.rls(async (tx) => {
        return tx.query.earTags.findMany({
          where: { farmId },
          with: { animal: { with: { earTag: true } } },
        });
      });
      const earTagByNumber = new Map(existingEarTags.map((tag) => [tag.number.toLowerCase(), tag]));

      const skippedRows: SkippedRow[] = [];
      const validAnimals: (AnimalCreateInput & { earTagNumber?: string })[] = [];
      const earTagsToCreate = new Set<string>();

      // Process rows
      let rowIndex = 0;
      worksheet.eachRow((row, rowNumber) => {
        rowIndex++;
        if (skipHeaderRow && rowNumber === 1) return;

        const earTagNumber = row.getCell(columnIndex["earTag"]).text?.trim() || null;
        const name = row.getCell(columnIndex["name"]).text?.trim() || null;
        const sexValue = row.getCell(columnIndex["sex"]).text?.trim().toLowerCase() || null;
        const dobCell = row.getCell(columnIndex["dateOfBirth"]);
        const usageValue = columnIndex["usage"]
          ? row.getCell(columnIndex["usage"]).text?.trim().toLowerCase() || null
          : null;

        const resolvedName = name ?? earTagNumber;
        if (!resolvedName) {
          skippedRows.push({
            row: rowNumber,
            earTagNumber,
            name,
            reason: "Name is required",
          });
          return;
        }

        if (!sexValue) {
          skippedRows.push({
            row: rowNumber,
            earTagNumber,
            name,
            reason: "Sex is required",
          });
          return;
        }
        const sex = SEX_MAP[sexValue];
        if (!sex) {
          skippedRows.push({
            row: rowNumber,
            earTagNumber,
            name,
            reason: `Unknown sex value: ${sexValue}`,
          });
          return;
        }

        // Parse usage — default to "other" if column not present or value not recognized
        let usage: AnimalUsage = "other";
        if (usageValue) {
          const mapped = USAGE_MAP[usageValue];
          if (mapped) {
            usage = mapped;
          }
        }

        let dateOfBirth: Date;
        if (dobCell.value) {
          if (dobCell.value instanceof Date) {
            dateOfBirth = dobCell.value;
          } else if (typeof dobCell.value === "string") {
            const parsed = parseDateString(dobCell.value);
            if (!parsed) {
              skippedRows.push({
                row: rowNumber,
                earTagNumber,
                name,
                reason: "Invalid date format",
              });
              return;
            }
            dateOfBirth = parsed;
          } else if (typeof dobCell.value === "number") {
            // Excel date serial number
            dateOfBirth = new Date(Math.round((dobCell.value - 25569) * 86400 * 1000));
          } else {
            skippedRows.push({
              row: rowNumber,
              earTagNumber,
              name,
              reason: "Invalid date format",
            });
            return;
          }
        } else {
          skippedRows.push({
            row: rowNumber,
            earTagNumber,
            name,
            reason: "Date of birth is required",
          });
          return;
        }

        // Check ear tag status
        let earTagId: string | undefined;
        if (earTagNumber) {
          const existingTag = earTagByNumber.get(earTagNumber.toLowerCase());
          if (existingTag) {
            if (existingTag.animal) {
              skippedRows.push({
                row: rowNumber,
                earTagNumber,
                name,
                reason: "Ear tag already assigned",
              });
              return;
            }
            earTagId = existingTag.id;
          } else {
            earTagsToCreate.add(earTagNumber);
          }
        }

        validAnimals.push({
          name: resolvedName,
          type,
          sex,
          usage,
          dateOfBirth,
          earTagId,
          earTagNumber: earTagNumber || undefined,
          registered: true,
        });
      });

      // Batch create missing ear tags
      const earTagNumbersToCreate = Array.from(earTagsToCreate);
      let newEarTags: EarTag[] = [];
      if (earTagNumbersToCreate.length > 0) {
        newEarTags = await rlsDb.rls(async (tx) => {
          return tx
            .insert(tables.earTags)
            .values(
              earTagNumbersToCreate.map((number) => ({
                ...tables.farmIdColumnValue,
                number,
              }))
            )
            .returning();
        });
      }
      const newEarTagMap = new Map(newEarTags.map((tag) => [tag.number.toLowerCase(), tag.id]));

      // Assign ear tag IDs
      const animalsToCreate: AnimalCreateInput[] = validAnimals.map((animal) => {
        const { earTagNumber, ...animalData } = animal;
        if (earTagNumber && !animalData.earTagId) {
          animalData.earTagId = newEarTagMap.get(earTagNumber.toLowerCase());
        }
        return animalData;
      });

      // Batch create all valid animals
      let importedCount = 0;
      if (animalsToCreate.length > 0) {
        const result = await rlsDb.rls(async (tx) => {
          return tx
            .insert(tables.animals)
            .values(
              animalsToCreate.map((input) => ({
                ...tables.farmIdColumnValue,
                ...input,
              }))
            )
            .returning({ id: tables.animals.id });
        });
        importedCount = result.length;
      }
      const totalRows = skipHeaderRow ? rowIndex - 1 : rowIndex;

      return {
        skipped: skippedRows,
        summary: {
          totalRows,
          imported: importedCount,
          skipped: skippedRows.length,
        },
      };
    },

    // Parse an Excel file and return all rows (valid + invalid) without writing to the DB.
    // The frontend uses this to show a preview, let the user edit/remove rows, and optionally
    // assign a mergeAnimalId before calling commitImport.
    async parseImportPreview(
      fileBuffer: Buffer,
      skipHeaderRow: boolean,
      farmId: string,
      locale: string = "de"
    ): Promise<ParsedImportRow[]> {
      const worksheet = await loadImportWorksheet(fileBuffer, t);

      const headerMap = HEADER_MAP[locale] ?? HEADER_MAP["de"];
      const columnIndex: Record<string, number> = {};

      if (!skipHeaderRow) {
        throw createHttpError(400, "A header row is required for import.");
      }

      const headerRow = worksheet.getRow(1);
      const presentHeaders: string[] = [];
      headerRow.eachCell((cell, colNumber) => {
        const headerText = cell.text?.trim().toLowerCase();
        if (headerText) {
          presentHeaders.push(headerText);
          const field = resolveHeaderField(headerText, headerMap);
          if (field) {
            columnIndex[field] = colNumber;
          }
        }
      });

      assertRequiredImportColumns(columnIndex, presentHeaders, t);

      // Fetch all existing ear tags for this farm to check assignment status
      const existingEarTags = await rlsDb.rls(async (tx) => {
        return tx.query.earTags.findMany({
          where: { farmId },
          with: { animal: true },
        });
      });
      const earTagByNumber = new Map(existingEarTags.map((tag) => [tag.number.toLowerCase(), tag]));

      const rows: ParsedImportRow[] = [];

      worksheet.eachRow((row, rowNumber) => {
        if (skipHeaderRow && rowNumber === 1) return;

        const earTagNumber = row.getCell(columnIndex["earTag"]).text?.trim() || null;
        const name = row.getCell(columnIndex["name"]).text?.trim() || null;
        const sexValue = row.getCell(columnIndex["sex"]).text?.trim().toLowerCase() || null;
        const dobCell = row.getCell(columnIndex["dateOfBirth"]);
        const usageValue = columnIndex["usage"]
          ? row.getCell(columnIndex["usage"]).text?.trim().toLowerCase() || null
          : null;
        const dodCell = columnIndex["dateOfDeath"] ? row.getCell(columnIndex["dateOfDeath"]) : null;
        const motherEarTagNumber = columnIndex["motherEarTag"]
          ? row.getCell(columnIndex["motherEarTag"]).text?.trim() || null
          : null;
        const fatherEarTagNumber = columnIndex["fatherEarTag"]
          ? row.getCell(columnIndex["fatherEarTag"]).text?.trim() || null
          : null;

        const parseErrors: string[] = [];

        const resolvedName = name ?? earTagNumber;
        if (!resolvedName) parseErrors.push(t("animal_import.error_name_required"));

        let sex: "male" | "female" | null = null;
        if (!sexValue) {
          parseErrors.push(t("animal_import.error_sex_required"));
        } else {
          sex = SEX_MAP[sexValue] ?? null;
          if (!sex) parseErrors.push(t("animal_import.error_sex_unknown", { value: sexValue }));
        }

        // Default usage to "other" when column is absent or value unrecognized
        const usage: AnimalUsage = usageValue ? (USAGE_MAP[usageValue] ?? "other") : "other";

        let dateOfBirth: Date | null = null;
        if (!dobCell.value) {
          parseErrors.push(t("animal_import.error_dob_required"));
        } else if (dobCell.value instanceof Date) {
          dateOfBirth = dobCell.value;
        } else if (typeof dobCell.value === "string") {
          const parsed = parseDateString(dobCell.value);
          if (!parsed) {
            parseErrors.push(t("animal_import.error_dob_invalid"));
          } else {
            dateOfBirth = parsed;
          }
        } else if (typeof dobCell.value === "number") {
          dateOfBirth = new Date(Math.round((dobCell.value - 25569) * 86400 * 1000));
        } else {
          parseErrors.push(t("animal_import.error_dob_invalid"));
        }

        // Parse optional date of death — same logic as dateOfBirth but no error if absent
        let dateOfDeath: Date | null = null;
        if (dodCell?.value) {
          if (dodCell.value instanceof Date) {
            dateOfDeath = dodCell.value;
          } else if (typeof dodCell.value === "string") {
            dateOfDeath = parseDateString(dodCell.value);
          } else if (typeof dodCell.value === "number") {
            dateOfDeath = new Date(Math.round((dodCell.value - 25569) * 86400 * 1000));
          }
        }

        // Look up ear tag in DB — populate earTagId / earTagAssigned / assignedToAnimalId for the frontend
        let earTagId: string | null = null;
        let earTagAssigned = false;
        let assignedToAnimalId: string | null = null;
        let assignedToAnimalName: string | null = null;
        if (earTagNumber) {
          const existingTag = earTagByNumber.get(earTagNumber.toLowerCase());
          if (existingTag) {
            if (existingTag.animal) {
              earTagAssigned = true;
              assignedToAnimalId = existingTag.animal.id;
              assignedToAnimalName = existingTag.animal.name;
            } else {
              earTagId = existingTag.id;
            }
          }
        }

        rows.push({
          rowNumber,
          earTagNumber,
          earTagId,
          earTagAssigned,
          assignedToAnimalId,
          assignedToAnimalName,
          name: resolvedName,
          sex,
          dateOfBirth,
          usage,
          dateOfDeath,
          deathReason: dateOfDeath ? "died" : null,
          motherEarTagNumber,
          fatherEarTagNumber,
          parseErrors,
        });
      });

      return rows;
    },

    // Commit a (possibly user-modified) set of parsed rows to the DB. Each row either creates
    // a new animal or merges into an existing one (overwriting only the imported fields).
    async commitImport(rows: CommitImportRow[], type: AnimalType, farmId: string): Promise<CommitImportResult> {
      // Fetch all farm ear tags once — used for both create and merge paths
      const existingEarTags = await rlsDb.rls(async (tx) => {
        return tx.query.earTags.findMany({
          where: { farmId },
          with: { animal: true },
        });
      });
      // Mutable map keyed by lowercase number so we can add newly created tags
      const earTagByNumber = new Map(
        existingEarTags.map((tag) => [tag.number.toLowerCase(), tag as (typeof existingEarTags)[0]])
      );

      const skipped: CommitImportResult["skipped"] = [];

      // --- Create path (rows without mergeAnimalId) ---
      const createRows = rows.flatMap((r, i) => (!r.mergeAnimalId ? [{ row: r, index: i }] : []));

      // Determine which ear tag numbers need to be created
      const earTagsToCreate = new Set<string>();
      const validCreateRows: Array<{ row: CommitImportRow; index: number }> = [];
      for (const { row, index } of createRows) {
        if (row.earTagNumber && !row.earTagId) {
          const existing = earTagByNumber.get(row.earTagNumber.toLowerCase());
          if (existing?.animal) {
            skipped.push({ index, reason: t("animal_import.error_ear_tag_assigned", { number: row.earTagNumber }) });
            continue;
          }
          if (!existing) earTagsToCreate.add(row.earTagNumber);
        }
        validCreateRows.push({ row, index });
      }

      // Batch create missing ear tags and populate the map
      if (earTagsToCreate.size > 0) {
        const newEarTags = await rlsDb.rls(async (tx) => {
          return tx
            .insert(tables.earTags)
            .values(Array.from(earTagsToCreate).map((number) => ({ ...tables.farmIdColumnValue, number })))
            .returning();
        });
        for (const tag of newEarTags) {
          earTagByNumber.set(tag.number.toLowerCase(), { ...tag, animal: null });
        }
      }

      // Maps earTagNumber (lowercase) → newly created/merged animalId for parent resolution
      const importedEarTagToAnimalId = new Map<string, string>();

      let created = 0;
      if (validCreateRows.length > 0) {
        const animalsToInsert = validCreateRows.map(({ row }) => {
          // Prefer explicit earTagId from frontend, then look up by number
          const resolvedEarTagId = row.earTagId ?? earTagByNumber.get(row.earTagNumber?.toLowerCase() ?? "")?.id;
          return {
            ...tables.farmIdColumnValue,
            name: row.name,
            type,
            sex: row.sex,
            dateOfBirth: row.dateOfBirth,
            usage: row.usage,
            earTagId: resolvedEarTagId,
            registered: true,
            ...(row.dateOfDeath ? { dateOfDeath: row.dateOfDeath, deathReason: row.deathReason ?? "died" } : {}),
          };
        });

        const result = await rlsDb.rls(async (tx) => {
          return tx.insert(tables.animals).values(animalsToInsert).returning({ id: tables.animals.id });
        });
        created = result.length;

        // Map earTagNumber → created animalId for parent resolution below
        result.forEach(({ id }, i) => {
          const earTagNumber = validCreateRows[i].row.earTagNumber;
          if (earTagNumber) importedEarTagToAnimalId.set(earTagNumber.toLowerCase(), id);
        });
      }

      // --- Merge path (rows with mergeAnimalId) ---
      const mergeRows = rows.flatMap((r, i) => (r.mergeAnimalId ? [{ row: r, index: i }] : []));
      let merged = 0;

      for (const { row, index } of mergeRows) {
        const animalId = row.mergeAnimalId!;

        // Resolve the ear tag to assign (if any)
        let resolvedEarTagId: string | undefined;
        if (row.earTagId) {
          resolvedEarTagId = row.earTagId;
        } else if (row.earTagNumber) {
          const existing = earTagByNumber.get(row.earTagNumber.toLowerCase());
          if (existing) {
            if (existing.animal && existing.animal.id !== animalId) {
              skipped.push({ index, reason: t("animal_import.error_ear_tag_assigned", { number: row.earTagNumber }) });
              continue;
            }
            resolvedEarTagId = existing.id;
          } else {
            // Create the ear tag on the fly
            const [newTag] = await rlsDb.rls(async (tx) => {
              return tx
                .insert(tables.earTags)
                .values({ ...tables.farmIdColumnValue, number: row.earTagNumber! })
                .returning();
            });
            resolvedEarTagId = newTag.id;
            earTagByNumber.set(row.earTagNumber.toLowerCase(), { ...newTag, animal: null });
          }
        }

        await rlsDb.rls(async (tx) => {
          await tx
            .update(tables.animals)
            .set({
              name: row.name,
              sex: row.sex,
              dateOfBirth: row.dateOfBirth,
              usage: row.usage,
              ...(resolvedEarTagId !== undefined ? { earTagId: resolvedEarTagId } : {}),
              ...(row.dateOfDeath ? { dateOfDeath: row.dateOfDeath, deathReason: row.deathReason ?? "died" } : {}),
            })
            .where(eq(tables.animals.id, animalId));
        });

        // Track for parent resolution
        if (row.earTagNumber) importedEarTagToAnimalId.set(row.earTagNumber.toLowerCase(), animalId);

        merged++;
      }

      // --- Parent resolution (mother/father) ---
      // Resolve an ear tag number to an animal ID: check existing DB animals first, then this import batch
      const resolveParentId = (earTagNumber: string): string | undefined => {
        const tag = earTagByNumber.get(earTagNumber.toLowerCase());
        if (tag?.animal?.id) return tag.animal.id;
        return importedEarTagToAnimalId.get(earTagNumber.toLowerCase());
      };

      for (const row of rows) {
        if (!row.motherEarTagNumber && !row.fatherEarTagNumber) continue;

        // Determine this row's animalId (created or merged)
        const animalId =
          row.mergeAnimalId ??
          (row.earTagNumber ? importedEarTagToAnimalId.get(row.earTagNumber.toLowerCase()) : undefined);
        if (!animalId) continue;

        const motherId = row.motherEarTagNumber ? resolveParentId(row.motherEarTagNumber) : undefined;
        const fatherId = row.fatherEarTagNumber ? resolveParentId(row.fatherEarTagNumber) : undefined;
        if (!motherId && !fatherId) continue;

        await rlsDb.rls(async (tx) => {
          await tx
            .update(tables.animals)
            .set({
              ...(motherId ? { motherId } : {}),
              ...(fatherId ? { fatherId } : {}),
            })
            .where(eq(tables.animals.id, animalId));
        });
      }

      return { created, merged, skipped };
    },
  };
}
