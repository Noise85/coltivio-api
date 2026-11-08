import { count, eq } from "drizzle-orm";
import { RlsDb } from "../db/db";
import { drugs, drugTreatment, farmIdColumnValue, treatments } from "../db/schema";

export type DrugTreatmentCreateInput = Omit<typeof drugTreatment.$inferInsert, "id" | "drugId">;
export type DrugCreateInput = Omit<typeof drugs.$inferInsert, "id" | "farmId"> & {
  drugTreatment: DrugTreatmentCreateInput[];
};
export type DrugUpdateInput = Partial<Omit<DrugCreateInput, "drugTreatment">> & {
  drugTreatment?: DrugTreatmentCreateInput[];
};
export type Drug = typeof drugs.$inferSelect;
export type DrugTreatment = typeof drugTreatment.$inferSelect;
export type DrugWithTreatment = Drug & {
  drugTreatment: DrugTreatment[];
};

export function drugsApi(rlsDb: RlsDb) {
  return {
    async createDrug(drugInput: DrugCreateInput): Promise<DrugWithTreatment> {
      return rlsDb.rls(async (tx) => {
        const { drugTreatment: drugTreatmentData, ...drugData } = drugInput;

        // Insert drug
        const [drug] = await tx
          .insert(drugs)
          .values({ ...farmIdColumnValue, ...drugData })
          .returning();

        // Insert drug treatment data
        if (drugTreatmentData && drugTreatmentData.length > 0) {
          await tx.insert(drugTreatment).values(
            drugTreatmentData.map((dt) => ({
              drugId: drug.id,
              ...dt,
            }))
          );
        }

        // Fetch and return drug with drugTreatment
        const drugWithTreatment = await tx.query.drugs.findFirst({
          where: { id: drug.id },
          with: {
            drugTreatment: true,
          },
        });

        return drugWithTreatment!;
      });
    },

    async getDrugById(id: string): Promise<DrugWithTreatment | undefined> {
      return rlsDb.rls(async (tx) => {
        return tx.query.drugs.findFirst({
          where: { id },
          with: {
            drugTreatment: true,
          },
        });
      });
    },

    async getDrugsForFarm(farmId: string): Promise<DrugWithTreatment[]> {
      return rlsDb.rls(async (tx) => {
        return tx.query.drugs.findMany({
          where: { farmId },
          with: {
            drugTreatment: true,
          },
        });
      });
    },

    async updateDrug(id: string, data: DrugUpdateInput): Promise<DrugWithTreatment> {
      return rlsDb.rls(async (tx) => {
        const { drugTreatment: drugTreatmentData, ...drugData } = data;

        // Update drug if there's drug data
        if (Object.keys(drugData).length > 0) {
          await tx.update(drugs).set(drugData).where(eq(drugs.id, id));
        }

        // Handle drug treatment updates
        if (drugTreatmentData) {
          // Delete existing drug treatment data
          await tx.delete(drugTreatment).where(eq(drugTreatment.drugId, id));

          // Insert new drug treatment data
          if (drugTreatmentData.length > 0) {
            await tx.insert(drugTreatment).values(
              drugTreatmentData.map((dt) => ({
                drugId: id,
                ...dt,
              }))
            );
          }
        }

        // Fetch and return updated drug with drugTreatment
        const updatedDrug = await tx.query.drugs.findFirst({
          where: { id },
          with: {
            drugTreatment: true,
          },
        });

        return updatedDrug!;
      });
    },

    async deleteDrug(id: string): Promise<void> {
      return rlsDb.rls(async (tx) => {
        await tx.delete(drugs).where(eq(drugs.id, id));
      });
    },

    async drugInUse(id: string): Promise<boolean> {
      return rlsDb.rls(async (tx) => {
        const [result] = await tx.select({ count: count() }).from(treatments).where(eq(treatments.drugId, id));
        return result.count > 0;
      });
    },
  };
}
