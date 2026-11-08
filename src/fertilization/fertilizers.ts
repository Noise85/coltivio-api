import { count, eq } from "drizzle-orm";
import { RlsDb } from "../db/db";
import { farmIdColumnValue, fertilizerApplications, fertilizers } from "../db/schema";

export type FertilizerCreateInput = Omit<typeof fertilizers.$inferInsert, "id" | "farmId">;
export type FertilizerUpdateInput = Partial<FertilizerCreateInput>;
export type Fertilizer = typeof fertilizers.$inferSelect;

export function fertilizersApi(rlsDb: RlsDb) {
  return {
    async createFertilizer(fertilizerInput: FertilizerCreateInput): Promise<Fertilizer> {
      return rlsDb.rls(async (tx) => {
        const [fertilizer] = await tx
          .insert(fertilizers)
          .values({ ...farmIdColumnValue, ...fertilizerInput })
          .returning();
        return fertilizer;
      });
    },
    async getFertilizerById(id: string): Promise<Fertilizer | undefined> {
      return rlsDb.rls(async (tx) => {
        const [fertilizer] = await tx.select().from(fertilizers).where(eq(fertilizers.id, id));
        return fertilizer;
      });
    },
    async getFertilizersForFarm(farmId: string): Promise<Fertilizer[]> {
      return rlsDb.rls(async (tx) => {
        return tx.select().from(fertilizers).where(eq(fertilizers.farmId, farmId));
      });
    },
    async updateFertilizer(id: string, data: FertilizerUpdateInput): Promise<Fertilizer> {
      return rlsDb.rls(async (tx) => {
        const [fertilizer] = await tx.update(fertilizers).set(data).where(eq(fertilizers.id, id)).returning();
        return fertilizer;
      });
    },
    async deleteFertilizer(id: string): Promise<void> {
      return rlsDb.rls(async (tx) => {
        await tx.delete(fertilizers).where(eq(fertilizers.id, id));
      });
    },
    async fertilizerInUse(id: string): Promise<boolean> {
      return rlsDb.rls(async (tx) => {
        const [result] = await tx
          .select({ count: count() })
          .from(fertilizerApplications)
          .where(eq(fertilizerApplications.fertilizerId, id));
        return result.count > 0;
      });
    },
  };
}
