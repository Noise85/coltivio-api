import { count, eq } from "drizzle-orm";
import { RlsDb } from "../db/db";
import { farmIdColumnValue, crops, cropFamilies, cropRotations, harvests } from "../db/schema";

export type CropCreateInput = Omit<typeof crops.$inferInsert, "id" | "farmId">;
export type CropUpdateInput = Partial<CropCreateInput>;
export type Crop = typeof crops.$inferSelect & {
  family: typeof cropFamilies.$inferSelect | null;
};

export type CropFamilyCreateInput = Omit<typeof cropFamilies.$inferInsert, "id" | "farmId">;
export type CropFamilyUpdateInput = Partial<CropFamilyCreateInput>;
export type CropFamily = typeof cropFamilies.$inferSelect;

export function cropApi(rlsDb: RlsDb) {
  return {
    async createCrop(cropInput: CropCreateInput): Promise<Crop> {
      const result = await rlsDb.rls(async (tx) => {
        const [crop] = await tx
          .insert(crops)
          .values({ ...farmIdColumnValue, ...cropInput })
          .returning();
        return crop;
      });
      const crop = await this.getCropById(result.id);
      return crop!;
    },
    async getCropById(id: string): Promise<Crop | undefined> {
      return rlsDb.rls(async (tx) => {
        return tx.query.crops.findFirst({
          where: { id },
          with: { family: true },
        });
      });
    },
    async geCropsForFarm(farmId: string): Promise<Crop[]> {
      return rlsDb.rls(async (tx) => {
        return tx.query.crops.findMany({
          where: { farmId },
          with: { family: true },
        });
      });
    },
    async updateCrop(id: string, data: CropUpdateInput): Promise<Crop> {
      await rlsDb.rls(async (tx) => {
        await tx.update(crops).set(data).where(eq(crops.id, id));
      });
      const crop = await this.getCropById(id);
      return crop!;
    },
    async deleteCrop(id: string): Promise<void> {
      return rlsDb.rls(async (tx) => {
        await tx.delete(crops).where(eq(crops.id, id));
      });
    },
    async cropInUse(id: string): Promise<boolean> {
      return rlsDb.rls(async (tx) => {
        const [cropRotationResult] = await tx
          .select({ count: count() })
          .from(cropRotations)
          .where(eq(cropRotations.cropId, id));
        const [harvestResult] = await tx.select({ count: count() }).from(harvests).where(eq(harvests.cropId, id));
        return cropRotationResult.count > 0 || harvestResult.count > 0;
      });
    },

    async createCropFamily(familyInput: CropFamilyCreateInput): Promise<CropFamily> {
      return rlsDb.rls(async (tx) => {
        const [family] = await tx
          .insert(cropFamilies)
          .values({ ...farmIdColumnValue, ...familyInput })
          .returning();
        return family;
      });
    },

    async getCropFamilyById(id: string): Promise<CropFamily | undefined> {
      return rlsDb.rls(async (tx) => {
        return tx.query.cropFamilies.findFirst({
          where: { id },
        });
      });
    },

    async getCropFamiliesForFarm(): Promise<CropFamily[]> {
      return rlsDb.rls(async (tx) => {
        return tx.query.cropFamilies.findMany();
      });
    },

    async updateCropFamily(id: string, data: CropFamilyUpdateInput): Promise<CropFamily> {
      return rlsDb.rls(async (tx) => {
        const [family] = await tx.update(cropFamilies).set(data).where(eq(cropFamilies.id, id)).returning();
        return family;
      });
    },

    async deleteCropFamily(id: string): Promise<void> {
      return rlsDb.rls(async (tx) => {
        await tx.delete(cropFamilies).where(eq(cropFamilies.id, id));
      });
    },

    async cropFamilyInUse(id: string): Promise<boolean> {
      return rlsDb.rls(async (tx) => {
        const [result] = await tx.select({ count: count() }).from(crops).where(eq(crops.familyId, id));
        return result.count > 0;
      });
    },
  };
}
