import { eq, and } from "drizzle-orm";
import { RlsDb } from "../db/db";
import { products, farmIdColumnValue } from "../db/schema";

export type ProductCreateInput = Omit<typeof products.$inferInsert, "id" | "farmId">;
export type ProductUpdateInput = Partial<ProductCreateInput>;
export type Product = typeof products.$inferSelect;

export function productsApi(rlsDb: RlsDb) {
  return {
    async createProduct(productInput: ProductCreateInput): Promise<Product> {
      return rlsDb.rls(async (tx) => {
        const [product] = await tx
          .insert(products)
          .values({ ...farmIdColumnValue, ...productInput })
          .returning();
        return product;
      });
    },

    async getProductById(id: string): Promise<Product | undefined> {
      return rlsDb.rls(async (tx) => {
        const [product] = await tx.select().from(products).where(eq(products.id, id));
        return product;
      });
    },

    async getProductsForFarm(farmId: string): Promise<Product[]> {
      return rlsDb.rls(async (tx) => {
        return tx.select().from(products).where(eq(products.farmId, farmId));
      });
    },

    async getActiveProductsForFarm(farmId: string): Promise<Product[]> {
      return rlsDb.rls(async (tx) => {
        return tx
          .select()
          .from(products)
          .where(and(eq(products.farmId, farmId), eq(products.active, true)));
      });
    },

    async updateProduct(id: string, data: ProductUpdateInput): Promise<Product> {
      return rlsDb.rls(async (tx) => {
        const [product] = await tx.update(products).set(data).where(eq(products.id, id)).returning();
        return product;
      });
    },

    async deleteProduct(id: string): Promise<void> {
      return rlsDb.rls(async (tx) => {
        await tx.delete(products).where(eq(products.id, id));
      });
    },
  };
}
