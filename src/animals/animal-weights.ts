import { eq } from "drizzle-orm";
import { RlsDb } from "../db/db";
import { animalWeights, farmIdColumnValue } from "../db/schema";

export type AnimalWeight = typeof animalWeights.$inferSelect;

export type AnimalWeightCreateInput = {
  date: Date;
  weightKg: number;
  notes?: string | null;
};

export type AnimalWeightUpdateInput = Partial<AnimalWeightCreateInput>;

export function animalWeightsApi(db: RlsDb) {
  return {
    async listWeights(animalId: string): Promise<AnimalWeight[]> {
      return db.rls(async (tx) => {
        return tx.query.animalWeights.findMany({
          where: { animalId },
          orderBy: { date: "asc", createdAt: "asc" },
        });
      });
    },

    // undefined when the animal isn't visible to the caller; the FK check alone doesn't go through RLS
    async createWeight(
      animalId: string,
      createdBy: string,
      input: AnimalWeightCreateInput
    ): Promise<AnimalWeight | undefined> {
      return db.rls(async (tx) => {
        const animal = await tx.query.animals.findFirst({ where: { id: animalId }, columns: { id: true } });
        if (!animal) return undefined;
        const [weight] = await tx
          .insert(animalWeights)
          .values({ ...farmIdColumnValue, animalId, createdBy, ...input })
          .returning();
        return weight;
      });
    },

    async updateWeight(weightId: string, input: AnimalWeightUpdateInput): Promise<AnimalWeight | undefined> {
      return db.rls(async (tx) => {
        // Drizzle rejects an empty update set
        if (Object.keys(input).length === 0) return tx.query.animalWeights.findFirst({ where: { id: weightId } });
        const [weight] = await tx.update(animalWeights).set(input).where(eq(animalWeights.id, weightId)).returning();
        return weight;
      });
    },

    // false when the entry isn't visible to the caller (another farm or not existing)
    async deleteWeight(weightId: string): Promise<boolean> {
      return db.rls(async (tx) => {
        const deleted = await tx
          .delete(animalWeights)
          .where(eq(animalWeights.id, weightId))
          .returning({ id: animalWeights.id });
        return deleted.length > 0;
      });
    },
  };
}
