import { count, eq } from "drizzle-orm";
import { RlsDb } from "../db/db";
import { farmIdColumnValue, cropProtectionProducts, cropProtectionApplications } from "../db/schema";

export type CropProtectionProductCreateInput = Omit<typeof cropProtectionProducts.$inferInsert, "id" | "farmId">;
export type CropProtectionProductUpdateInput = Partial<CropProtectionProductCreateInput>;
export type CropProtectionProduct = typeof cropProtectionProducts.$inferSelect;

export function cropProtectionProductsApi(rlsDb: RlsDb) {
  return {
    async createCropProtectionProduct(
      cropProtectionProductInput: CropProtectionProductCreateInput
    ): Promise<CropProtectionProduct> {
      return rlsDb.rls(async (tx) => {
        const [cropProtectionProduct] = await tx
          .insert(cropProtectionProducts)
          .values({ ...farmIdColumnValue, ...cropProtectionProductInput })
          .returning();
        return cropProtectionProduct;
      });
    },
    async getCropProtectionProductById(id: string): Promise<CropProtectionProduct | undefined> {
      return rlsDb.rls(async (tx) => {
        const [cropProtectionProduct] = await tx
          .select()
          .from(cropProtectionProducts)
          .where(eq(cropProtectionProducts.id, id));
        return cropProtectionProduct;
      });
    },
    async getCropProtectionProductsForFarm(farmId: string): Promise<CropProtectionProduct[]> {
      return rlsDb.rls(async (tx) => {
        return tx.select().from(cropProtectionProducts).where(eq(cropProtectionProducts.farmId, farmId));
      });
    },
    async updateCropProtectionProduct(
      id: string,
      data: CropProtectionProductUpdateInput
    ): Promise<CropProtectionProduct> {
      return rlsDb.rls(async (tx) => {
        const [cropProtectionProduct] = await tx
          .update(cropProtectionProducts)
          .set(data)
          .where(eq(cropProtectionProducts.id, id))
          .returning();
        return cropProtectionProduct;
      });
    },
    async deleteCropProtectionProduct(id: string): Promise<void> {
      return rlsDb.rls(async (tx) => {
        await tx.delete(cropProtectionProducts).where(eq(cropProtectionProducts.id, id));
      });
    },
    async cropProtectionProductInUse(id: string): Promise<boolean> {
      return rlsDb.rls(async (tx) => {
        const [result] = await tx
          .select({ count: count() })
          .from(cropProtectionApplications)
          .where(eq(cropProtectionApplications.productId, id));
        return result.count > 0;
      });
    },
  };
}
