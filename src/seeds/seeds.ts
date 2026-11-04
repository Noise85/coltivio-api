import { count, eq } from "drizzle-orm";
import { RlsDb } from "../db/db";
import { crops, farmIdColumnValue, seeds, sowingPresets, sowings } from "../db/schema";
import { assertUnitMatchesQuantityKind } from "../sowings/sowing-units";

export type SeedCreateInput = Omit<typeof seeds.$inferInsert, "id" | "farmId">;
// quantityKind is immutable: changing weight <-> count would make existing sowings unsummable
export type SeedUpdateInput = Partial<Omit<SeedCreateInput, "quantityKind">>;
export type Seed = typeof seeds.$inferSelect & {
  crop: typeof crops.$inferSelect;
};

export function seedsApi(rlsDb: RlsDb) {
  return {
    async createSeed(seedInput: SeedCreateInput): Promise<Seed> {
      if (seedInput.defaultUnit) {
        assertUnitMatchesQuantityKind(seedInput.defaultUnit, seedInput.quantityKind);
      }
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
      const { name, description, cropId, defaultAmount, defaultUnit } = data;
      if (defaultUnit) {
        assertUnitMatchesQuantityKind(defaultUnit, existingSeed.quantityKind);
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
