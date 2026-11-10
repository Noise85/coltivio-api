import { count, eq } from "drizzle-orm";
import { RlsDb } from "../db/db";
import { crops, farmIdColumnValue, seeds, sowingPresets, sowings } from "../db/schema";
import { CodedError } from "../errors";
import { assertUnitMatchesQuantityKind } from "../sowings/sowing-units";

export type SeedCreateInput = Omit<typeof seeds.$inferInsert, "id" | "farmId">;
// quantityKind is immutable: changing weight <-> count would make existing sowings unsummable
export type SeedUpdateInput = Partial<Omit<SeedCreateInput, "quantityKind">>;
export type Seed = typeof seeds.$inferSelect & {
  crop: typeof crops.$inferSelect;
};

export function seedsApi(rlsDb: RlsDb) {
  // foreign keys bypass RLS, so a crop of another farm has to be caught here
  async function assertCropExists(cropId: string) {
    const crop = await rlsDb.rls(async (tx) => tx.query.crops.findFirst({ where: { id: cropId } }));
    if (!crop) {
      throw new CodedError("crop_not_found", "Crop not found");
    }
  }

  // a default unit can stand alone (preselected in a sowing), a default amount can't
  function assertDefaultAmountHasUnit(defaultAmount: number | null | undefined, defaultUnit: unknown) {
    if (defaultAmount != null && defaultUnit == null) {
      throw new CodedError("seed_default_amount_without_unit", "A default amount needs a default unit");
    }
  }

  return {
    async createSeed(seedInput: SeedCreateInput): Promise<Seed> {
      if (seedInput.defaultUnit) {
        assertUnitMatchesQuantityKind(seedInput.defaultUnit, seedInput.quantityKind);
      }
      assertDefaultAmountHasUnit(seedInput.defaultAmount, seedInput.defaultUnit);
      await assertCropExists(seedInput.cropId);
      const [createdSeed] = await rlsDb.rls(async (tx) => {
        return tx
          .insert(seeds)
          .values({ ...farmIdColumnValue, ...seedInput })
          .returning({ id: seeds.id });
      });
      const seed = await this.getSeedById(createdSeed.id);
      return seed!;
    },
    async getSeedById(id: string): Promise<Seed | undefined> {
      return rlsDb.rls(async (tx) => {
        return tx.query.seeds.findFirst({
          where: { id },
          with: { crop: true },
        });
      });
    },
    async getSeedsForFarm(farmId: string): Promise<Seed[]> {
      return rlsDb.rls(async (tx) => {
        return tx.query.seeds.findMany({
          where: { farmId },
          with: { crop: true },
          orderBy: { name: "asc" },
        });
      });
    },
    async updateSeed(id: string, data: SeedUpdateInput): Promise<Seed | undefined> {
      const existingSeed = await this.getSeedById(id);
      if (!existingSeed) {
        return undefined;
      }
      const { name, description, cropId, defaultUnit } = data;
      // clearing the unit also clears the amount, which would mean nothing on its own
      const defaultAmount = defaultUnit === null ? null : data.defaultAmount;
      if (defaultUnit) {
        assertUnitMatchesQuantityKind(defaultUnit, existingSeed.quantityKind);
      }
      assertDefaultAmountHasUnit(
        defaultAmount === undefined ? existingSeed.defaultAmount : defaultAmount,
        defaultUnit === undefined ? existingSeed.defaultUnit : defaultUnit
      );
      if (cropId) {
        await assertCropExists(cropId);
      }
      const values = { name, description, cropId, defaultAmount, defaultUnit };
      const hasValues = Object.values(values).some((value) => value !== undefined);
      if (hasValues) {
        await rlsDb.rls(async (tx) => {
          await tx.update(seeds).set(values).where(eq(seeds.id, id));
          // sowings and presets always carry the crop of their seed
          if (cropId && cropId !== existingSeed.cropId) {
            await tx.update(sowings).set({ cropId }).where(eq(sowings.seedId, id));
            await tx.update(sowingPresets).set({ cropId }).where(eq(sowingPresets.seedId, id));
          }
        });
      }
      return this.getSeedById(id);
    },
    async deleteSeed(id: string): Promise<void> {
      return rlsDb.rls(async (tx) => {
        await tx.delete(seeds).where(eq(seeds.id, id));
      });
    },
    async seedInUse(id: string): Promise<boolean> {
      return rlsDb.rls(async (tx) => {
        const [result] = await tx.select({ count: count() }).from(sowings).where(eq(sowings.seedId, id));
        return result.count > 0;
      });
    },
  };
}
