import { and, eq } from "drizzle-orm";
import { addUtcDays } from "../date-utils";
import { RlsDb } from "../db/db";
import { animalHeats, animalTypeSchema, farmGestationSettings, farmIdColumnValue } from "../db/schema";
import type { AnimalType } from "./animals";
import { todayUtcDay } from "./animals";
import { CodedError } from "../errors";
import { DEFAULT_GESTATION_DAYS } from "./gestation-defaults";

export type AnimalHeat = typeof animalHeats.$inferSelect;

export type AnimalHeatCreateInput = {
  date: Date;
  mated?: boolean;
  sireId?: string | null;
  sireName?: string | null;
  notes?: string | null;
};

export type AnimalHeatUpdateInput = Partial<AnimalHeatCreateInput>;

export type GestationSetting = { animalType: AnimalType; gestationDays: number; isDefault: boolean };

// Heats and matings less than this many days apart belong to the same heat: a heat lasts several days, is often
// logged more than once, and animals are often mated or inseminated twice in one heat. The shortest cycle
// (sheep, goats) is longer.
const SAME_HEAT_DAYS = 14;

// A mating followed by another heat of the same animal (mated or not) at least SAME_HEAT_DAYS later and before
// the expected birth didn't lead to a pregnancy. It gets no expected birth. Of several matings in the same heat
// only the last one gets the expected birth, the earlier ones share its outcome.
export type AnimalHeatWithOutcome = AnimalHeat & {
  expectedBirthDate: Date | null;
  conceptionFailed: boolean;
};

export type BreedingCalendarEntry = AnimalHeatWithOutcome & {
  animal: { id: string; name: string; type: AnimalType; earTagNumber: string | null };
  sire: { id: string; name: string } | null;
};

// Expected birth and failed conception per heat. Heats of several animals may be mixed.
export function resolveHeatOutcomes<T extends { id: string; animalId: string; date: Date; mated: boolean }>(
  heats: T[],
  gestationDaysOf: (heat: T) => number
): Map<string, { expectedBirthDate: Date | null; conceptionFailed: boolean }> {
  const heatsByAnimalId = new Map<string, T[]>();
  for (const heat of heats) {
    heatsByAnimalId.set(heat.animalId, [...(heatsByAnimalId.get(heat.animalId) ?? []), heat]);
  }
  const outcomes = new Map<string, { expectedBirthDate: Date | null; conceptionFailed: boolean }>();
  for (const animalHeats of heatsByAnimalId.values()) {
    // Newest first, so a mating's later mating in the same heat is already resolved
    const newestFirst = [...animalHeats].sort((a, b) => b.date.getTime() - a.date.getTime());
    let laterMating: { date: Date; conceptionFailed: boolean } | null = null;
    for (const heat of newestFirst) {
      if (!heat.mated) {
        outcomes.set(heat.id, { expectedBirthDate: null, conceptionFailed: false });
        continue;
      }
      const sameHeatEnd = addUtcDays(heat.date, SAME_HEAT_DAYS);
      if (laterMating && laterMating.date < sameHeatEnd) {
        outcomes.set(heat.id, { expectedBirthDate: null, conceptionFailed: laterMating.conceptionFailed });
        laterMating = { date: heat.date, conceptionFailed: laterMating.conceptionFailed };
        continue;
      }
      const expectedBirthDate = addUtcDays(heat.date, gestationDaysOf(heat));
      const conceptionFailed = animalHeats.some(
        (laterHeat) => laterHeat.date >= sameHeatEnd && laterHeat.date < expectedBirthDate
      );
      outcomes.set(heat.id, { expectedBirthDate: conceptionFailed ? null : expectedBirthDate, conceptionFailed });
      laterMating = { date: heat.date, conceptionFailed };
    }
  }
  return outcomes;
}

function assertValidSire(animalId: string, sire: { id: string; sex: "male" | "female" }) {
  if (sire.id === animalId) throw new CodedError("invalid_sire", "An animal can't be its own sire");
  if (sire.sex !== "male") throw new CodedError("invalid_sire", "The sire must be a male animal");
}

export function breedingApi(db: RlsDb) {
  async function getGestationSettings(farmId: string): Promise<GestationSetting[]> {
    const configured = await db.rls(async (tx) => {
      return tx.query.farmGestationSettings.findMany({ where: { farmId } });
    });
    const configuredByType = new Map(configured.map((setting) => [setting.animalType, setting.gestationDays]));
    return animalTypeSchema.options.map((animalType) => {
      const configuredDays = configuredByType.get(animalType);
      return {
        animalType,
        gestationDays: configuredDays ?? DEFAULT_GESTATION_DAYS[animalType],
        isDefault: configuredDays === undefined,
      };
    });
  }

  return {
    getGestationSettings,

    async updateGestationSettings(
      farmId: string,
      settings: { animalType: AnimalType; gestationDays: number | null }[]
    ): Promise<GestationSetting[]> {
      await db.rls(async (tx) => {
        for (const setting of settings) {
          // null resets the type back to its default
          if (setting.gestationDays === null) {
            await tx
              .delete(farmGestationSettings)
              .where(
                and(eq(farmGestationSettings.farmId, farmId), eq(farmGestationSettings.animalType, setting.animalType))
              );
            continue;
          }
          await tx
            .insert(farmGestationSettings)
            .values({ ...farmIdColumnValue, animalType: setting.animalType, gestationDays: setting.gestationDays })
            .onConflictDoUpdate({
              target: [farmGestationSettings.farmId, farmGestationSettings.animalType],
              set: { gestationDays: setting.gestationDays },
            });
        }
      });
      return getGestationSettings(farmId);
    },

    async listHeats(animalId: string, farmId: string): Promise<AnimalHeatWithOutcome[]> {
      const [animal, heats, gestationSettings] = await Promise.all([
        db.rls((tx) => tx.query.animals.findFirst({ where: { id: animalId }, columns: { type: true } })),
        db.rls((tx) =>
          tx.query.animalHeats.findMany({
            where: { animalId },
            orderBy: { date: "desc", createdAt: "desc" },
          })
        ),
        getGestationSettings(farmId),
      ]);
      const gestationDays =
        gestationSettings.find((setting) => setting.animalType === animal?.type)?.gestationDays ??
        (animal ? DEFAULT_GESTATION_DAYS[animal.type] : 0);
      const outcomes = resolveHeatOutcomes(heats, () => gestationDays);
      return heats.map((heat) => ({
        ...heat,
        expectedBirthDate: outcomes.get(heat.id)?.expectedBirthDate ?? null,
        conceptionFailed: outcomes.get(heat.id)?.conceptionFailed ?? false,
      }));
    },

    // undefined when the animal or the sire isn't visible to the caller (another farm or not existing).
    // The FK check alone would accept any animal id, it doesn't go through RLS.
    async createHeat(
      animalId: string,
      createdBy: string,
      input: AnimalHeatCreateInput
    ): Promise<AnimalHeat | undefined> {
      return db.rls(async (tx) => {
        const animal = await tx.query.animals.findFirst({ where: { id: animalId }, columns: { id: true } });
        if (!animal) return undefined;
        if (input.sireId) {
          const sire = await tx.query.animals.findFirst({
            where: { id: input.sireId },
            columns: { id: true, sex: true },
          });
          if (!sire) return undefined;
          assertValidSire(animalId, sire);
        }
        const [heat] = await tx
          .insert(animalHeats)
          .values({ ...farmIdColumnValue, animalId, createdBy, ...input })
          .returning();
        return heat;
      });
    },

    async updateHeat(heatId: string, input: AnimalHeatUpdateInput): Promise<AnimalHeat | undefined> {
      return db.rls(async (tx) => {
        // Drizzle rejects an empty update set
        if (Object.keys(input).length === 0) return tx.query.animalHeats.findFirst({ where: { id: heatId } });
        if (input.sireId) {
          const [existingHeat, sire] = await Promise.all([
            tx.query.animalHeats.findFirst({ where: { id: heatId }, columns: { animalId: true } }),
            tx.query.animals.findFirst({ where: { id: input.sireId }, columns: { id: true, sex: true } }),
          ]);
          if (!existingHeat || !sire) return undefined;
          assertValidSire(existingHeat.animalId, sire);
        }
        const [heat] = await tx.update(animalHeats).set(input).where(eq(animalHeats.id, heatId)).returning();
        return heat;
      });
    },

    // false when the heat isn't visible to the caller (another farm or not existing)
    async deleteHeat(heatId: string): Promise<boolean> {
      return db.rls(async (tx) => {
        const deleted = await tx
          .delete(animalHeats)
          .where(eq(animalHeats.id, heatId))
          .returning({ id: animalHeats.id });
        return deleted.length > 0;
      });
    },

    // Heats of living animals that either happened in the range or (when mated) are expected to give birth in it
    async getCalendar(farmId: string, from?: Date, to?: Date): Promise<BreedingCalendarEntry[]> {
      const rangeFrom = from ?? addUtcDays(todayUtcDay(), -60);
      const rangeTo = to ?? addUtcDays(todayUtcDay(), 365);
      const gestationSettings = await getGestationSettings(farmId);
      const gestationDaysByType = new Map(
        gestationSettings.map((setting) => [setting.animalType, setting.gestationDays])
      );
      // Heats up to the longest gestation before the range can still have their birth in it
      const longestGestationDays = Math.max(...gestationSettings.map((setting) => setting.gestationDays));

      const heats = await db.rls(async (tx) => {
        return tx.query.animalHeats.findMany({
          where: {
            farmId,
            // Later heats up to a gestation after the range can still mark a mating in it as failed
            date: {
              gte: addUtcDays(rangeFrom, -longestGestationDays),
              lte: addUtcDays(rangeTo, longestGestationDays),
            },
            animal: { dateOfDeath: { isNull: true } },
          },
          with: {
            animal: { with: { earTag: true } },
            sire: true,
          },
          orderBy: { date: "asc" },
        });
      });

      const outcomes = resolveHeatOutcomes(
        heats,
        (heat) => gestationDaysByType.get(heat.animal.type) ?? DEFAULT_GESTATION_DAYS[heat.animal.type]
      );
      const entries: BreedingCalendarEntry[] = [];
      for (const heat of heats) {
        const expectedBirthDate = outcomes.get(heat.id)?.expectedBirthDate ?? null;
        const conceptionFailed = outcomes.get(heat.id)?.conceptionFailed ?? false;
        const heatInRange = heat.date >= rangeFrom && heat.date <= rangeTo;
        const birthInRange =
          expectedBirthDate !== null && expectedBirthDate >= rangeFrom && expectedBirthDate <= rangeTo;
        if (!heatInRange && !birthInRange) continue;
        const { animal, sire, ...heatFields } = heat;
        entries.push({
          ...heatFields,
          expectedBirthDate,
          conceptionFailed,
          animal: { id: animal.id, name: animal.name, type: animal.type, earTagNumber: animal.earTag?.number ?? null },
          sire: sire ? { id: sire.id, name: sire.name } : null,
        });
      }
      return entries;
    },
  };
}
