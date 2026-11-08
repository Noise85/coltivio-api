import { addDays } from "date-fns";
import { eq } from "drizzle-orm";
import type { Animal } from "../animals/animals";
import { RlsDb } from "../db/db";
import { animalTreatments, farmIdColumnValue, treatments } from "../db/schema";
import type { DrugWithTreatment } from "../drugs/drugs";

export type TreatmentCreateInput = Omit<typeof treatments.$inferInsert, "id" | "farmId" | "createdAt" | "createdBy"> & {
  animalIds: string[];
};

export type TreatmentUpdateInput = Partial<Omit<TreatmentCreateInput, "drugId">>;

export type Treatment = typeof treatments.$inferSelect;

export type TreatmentWithRelations = Treatment & {
  animals: Animal[];
  drug: DrugWithTreatment | null;
};

export function treatmentsApi(rlsDb: RlsDb) {
  return {
    async createTreatment(treatmentInput: TreatmentCreateInput, userId: string): Promise<Treatment> {
      const { animalIds, ...treatmentData } = treatmentInput;

      return rlsDb.rls(async (tx) => {
        let milkUsableDate = treatmentData.milkUsableDate;
        let meatUsableDate = treatmentData.meatUsableDate;

        // If dates not provided and drug specified, auto-calculate based on first animal's type
        if (treatmentData.drugId && (!milkUsableDate || !meatUsableDate)) {
          const animal = await tx.query.animals.findFirst({
            where: { id: animalIds[0] },
          });

          if (!animal) {
            throw new Error("Animal not found");
          }

          const drugTreatmentData = await tx.query.drugTreatment.findFirst({
            where: {
              drugId: treatmentData.drugId,
              animalType: animal.type,
            },
          });
          if (!drugTreatmentData) {
            throw new Error(`No treatment data found for drug and animal type ${animal.type}`);
          }

          if (!milkUsableDate) {
            milkUsableDate = addDays(treatmentData.endDate, drugTreatmentData.milkWaitingDays);
          }
          if (!meatUsableDate) {
            meatUsableDate = addDays(treatmentData.endDate, drugTreatmentData.meatWaitingDays);
          }
        }

        // Insert treatment
        const [treatment] = await tx
          .insert(treatments)
          .values({
            ...farmIdColumnValue,
            ...treatmentData,
            milkUsableDate,
            meatUsableDate,
            createdBy: userId,
          })
          .returning();

        // Insert animal-treatment associations
        if (animalIds.length > 0) {
          await tx.insert(animalTreatments).values(
            animalIds.map((animalId) => ({
              ...farmIdColumnValue,
              animalId,
              treatmentId: treatment.id,
            }))
          );
        }

        return treatment;
      });
    },

    async getTreatmentById(id: string): Promise<TreatmentWithRelations | undefined> {
      return rlsDb.rls(async (tx) => {
        const result = await tx.query.treatments.findFirst({
          where: { id },
          with: {
            animalTreatments: {
              with: {
                animal: {
                  with: { earTag: true },
                },
              },
            },
            drug: {
              with: {
                drugTreatment: true,
              },
            },
          },
        });
        if (!result) return undefined;
        return {
          ...result,
          animals: result.animalTreatments.map((at) => at.animal),
        };
      });
    },

    async getTreatmentsForFarm(farmId: string): Promise<TreatmentWithRelations[]> {
      return rlsDb.rls(async (tx) => {
        const results = await tx.query.treatments.findMany({
          where: { farmId },
          with: {
            animalTreatments: {
              with: {
                animal: {
                  with: { earTag: true },
                },
              },
            },
            drug: {
              with: {
                drugTreatment: true,
              },
            },
          },
          orderBy: { startDate: "desc" },
        });
        return results.map((r) => ({
          ...r,
          animals: r.animalTreatments.map((at) => at.animal),
        }));
      });
    },

    async getTreatmentsForAnimal(animalId: string): Promise<TreatmentWithRelations[]> {
      return rlsDb.rls(async (tx) => {
        // Find treatments through the junction table
        const animalTreatmentRecords = await tx.query.animalTreatments.findMany({
          where: { animalId },
          with: {
            treatment: {
              with: {
                drug: {
                  with: { drugTreatment: true },
                },
                animalTreatments: {
                  with: {
                    animal: {
                      with: { earTag: true },
                    },
                  },
                },
              },
            },
          },
        });
        return animalTreatmentRecords
          .map((at) => ({
            ...at.treatment,
            animals: at.treatment.animalTreatments.map((at2) => at2.animal),
          }))
          .sort((a, b) => b.startDate.getTime() - a.startDate.getTime());
      });
    },

    async updateTreatment(id: string, data: TreatmentUpdateInput): Promise<Treatment> {
      const { animalIds, ...treatmentData } = data;

      return rlsDb.rls(async (tx) => {
        // Update treatment fields
        const [treatment] = await tx.update(treatments).set(treatmentData).where(eq(treatments.id, id)).returning();

        // If animalIds provided, replace all animal associations
        if (animalIds !== undefined) {
          await tx.delete(animalTreatments).where(eq(animalTreatments.treatmentId, id));

          if (animalIds.length > 0) {
            await tx.insert(animalTreatments).values(
              animalIds.map((animalId) => ({
                ...farmIdColumnValue,
                animalId,
                treatmentId: id,
              }))
            );
          }
        }

        return treatment;
      });
    },

    async deleteTreatment(id: string): Promise<void> {
      return rlsDb.rls(async (tx) => {
        await tx.delete(treatments).where(eq(treatments.id, id));
      });
    },
  };
}
