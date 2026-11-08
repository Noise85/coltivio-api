import { ez } from "express-zod-api";
import createHttpError from "http-errors";
import { z } from "zod";
import { animalSchema } from "../animals/animals.endpoint";
import { drugDosePerUnitSchema, drugDoseUnitSchema } from "../db/schema";
import { drugSchema } from "../drugs/drugs.endpoint";
import { permissionFarmEndpoint } from "../endpoint-factory";

const treatmentsRead = permissionFarmEndpoint("animals", "read");
const treatmentsWrite = permissionFarmEndpoint("animals", "write");

export const treatmentSchema = z.object({
  id: z.string(),
  farmId: z.string(),
  drugId: z.string().nullable(),
  drugDoseUnit: drugDoseUnitSchema.nullable(),
  drugDosePerUnit: drugDosePerUnitSchema.nullable(),
  drugDoseValue: z.number().nullable(),
  drugReceivedFrom: z.string().nullable(),
  isAntibiotic: z.boolean(),
  criticalAntibiotic: z.boolean(),
  antibiogramAvailable: z.boolean(),
  startDate: ez.dateOut(),
  endDate: ez.dateOut(),
  name: z.string(),
  notes: z.string().nullable(),
  milkUsableDate: ez.dateOut().nullable(),
  meatUsableDate: ez.dateOut().nullable(),
  organsUsableDate: ez.dateOut().nullable(),
  createdAt: ez.dateOut(),
  createdBy: z.string().nullable(),
});

export const treatmentWithRelationsSchema = treatmentSchema.extend({
  get animals() {
    return z.array(animalSchema);
  },
  get drug() {
    return drugSchema.nullable();
  },
});

const createTreatmentSchema = z.object({
  animalIds: z.array(z.string()).min(1),
  drugId: z.string().optional().nullable(),
  startDate: ez.dateIn(),
  endDate: ez.dateIn(),
  name: z.string().min(1),
  notes: z.string().optional(),
  milkUsableDate: ez.dateIn().optional().nullable(),
  meatUsableDate: ez.dateIn().optional().nullable(),
  organsUsableDate: ez.dateIn().optional().nullable(),
  drugDoseUnit: drugDoseUnitSchema.optional().nullable(),
  drugDosePerUnit: drugDosePerUnitSchema.optional().nullable(),
  drugDoseValue: z.number().optional().nullable(),
  drugReceivedFrom: z.string().optional().nullable(),
  isAntibiotic: z.boolean().optional().default(false),
  criticalAntibiotic: z.boolean(),
  antibiogramAvailable: z.boolean(),
});

const updateTreatmentSchema = createTreatmentSchema.partial().extend({
  treatmentId: z.string(),
});

export const getTreatmentByIdEndpoint = treatmentsRead.build({
  method: "get",
  input: z.object({ treatmentId: z.string() }),
  output: treatmentWithRelationsSchema,
  handler: async ({ input, ctx: { treatments } }) => {
    const treatment = await treatments.getTreatmentById(input.treatmentId);
    if (!treatment) {
      throw createHttpError(404, "Treatment not found");
    }
    return treatment;
  },
});

export const getFarmTreatmentsEndpoint = treatmentsRead.build({
  method: "get",
  input: z.object({}),
  output: z.object({
    result: z.array(treatmentWithRelationsSchema),
    count: z.number(),
  }),
  handler: async ({ ctx: { treatments, farmId } }) => {
    const result = await treatments.getTreatmentsForFarm(farmId);
    return { result: result as any, count: result.length };
  },
});

// export const getAnimalTreatmentsEndpoint = treatmentsRead.build({
//   method: "get",
//   input: z.object({ animalId: z.string() }),
//   output: z.object({
//     result: z.array(treatmentWithRelationsSchema),
//     count: z.number(),
//   }),
//   handler: async ({ input, ctx: { treatments } }) => {
//     const result = await treatments.getTreatmentsForAnimal(input.animalId);
//     return { result: result as any, count: result.length };
//   },
// });

export const createTreatmentEndpoint = treatmentsWrite.build({
  method: "post",
  input: createTreatmentSchema,
  output: treatmentSchema,
  handler: async ({ input, ctx: { treatments, user } }) => {
    return treatments.createTreatment(input, user.id);
  },
});

export const updateTreatmentEndpoint = treatmentsWrite.build({
  method: "patch",
  input: updateTreatmentSchema,
  output: treatmentSchema,
  handler: async ({ input, ctx: { treatments } }) => {
    const { treatmentId, ...data } = input;
    return treatments.updateTreatment(treatmentId, data);
  },
});

export const deleteTreatmentEndpoint = treatmentsWrite.build({
  method: "delete",
  input: z.object({ treatmentId: z.string() }),
  output: z.object({}),
  handler: async ({ input: { treatmentId }, ctx: { treatments } }) => {
    await treatments.deleteTreatment(treatmentId);
    return {};
  },
});
