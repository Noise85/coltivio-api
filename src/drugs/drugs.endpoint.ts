import createHttpError from "http-errors";
import { z } from "zod";
import { animalTypeSchema, drugDosePerUnitSchema, drugDoseUnitSchema } from "../db/schema";
import { permissionFarmEndpoint } from "../endpoint-factory";

const treatmentsRead = permissionFarmEndpoint("animals", "read");
const treatmentsWrite = permissionFarmEndpoint("animals", "write");

export const drugTreatmentSchema = z.object({
  id: z.string(),
  drugId: z.string(),
  animalType: animalTypeSchema,
  doseUnit: drugDoseUnitSchema,
  dosePerUnit: drugDosePerUnitSchema,
  doseValue: z.number().positive(),
  milkWaitingDays: z.number().int(),
  meatWaitingDays: z.number().int(),
  organsWaitingDays: z.number().int(),
});

export const drugSchema = z.object({
  id: z.string(),
  farmId: z.string(),
  name: z.string(),
  notes: z.string().nullable(),
  isAntibiotic: z.boolean(),
  criticalAntibiotic: z.boolean(),
  receivedFrom: z.string(),
  drugTreatment: z.array(drugTreatmentSchema),
});

const createDrugTreatmentSchema = z.object({
  animalType: animalTypeSchema,
  doseValue: z.number().positive(),
  doseUnit: drugDoseUnitSchema,
  dosePerUnit: drugDosePerUnitSchema,
  milkWaitingDays: z.number().int().min(0),
  meatWaitingDays: z.number().int().min(0),
  organsWaitingDays: z.number().int().min(0),
});

const createDrugSchema = z.object({
  name: z.string().min(1),
  isAntibiotic: z.boolean().optional().default(false),
  criticalAntibiotic: z.boolean(),
  receivedFrom: z.string(),
  notes: z.string().optional(),
  drugTreatment: z.array(createDrugTreatmentSchema),
});

const updateDrugSchema = z.object({
  name: z.string().min(1).optional(),
  isAntibiotic: z.boolean().optional(),
  criticalAntibiotic: z.boolean().optional(),
  notes: z.string().optional(),
  drugTreatment: z.array(createDrugTreatmentSchema).optional(),
});

export const getDrugByIdEndpoint = treatmentsRead.build({
  method: "get",
  input: z.object({ drugId: z.string() }),
  output: drugSchema,
  handler: async ({ input, ctx: { drugs } }) => {
    const drug = await drugs.getDrugById(input.drugId);
    if (!drug) {
      throw createHttpError(404, "Drug not found");
    }
    return drug;
  },
});

export const getFarmDrugsEndpoint = treatmentsRead.build({
  method: "get",
  input: z.object({}),
  output: z.object({
    result: z.array(drugSchema),
    count: z.number(),
  }),
  handler: async ({ ctx: { drugs, farmId } }) => {
    const result = await drugs.getDrugsForFarm(farmId);
    return { result, count: result.length };
  },
});

export const createDrugEndpoint = treatmentsWrite.build({
  method: "post",
  input: createDrugSchema,
  output: drugSchema,
  handler: async ({ input, ctx: { drugs } }) => {
    return drugs.createDrug(input);
  },
});

export const updateDrugEndpoint = treatmentsWrite.build({
  method: "patch",
  input: updateDrugSchema.extend({ drugId: z.string() }),
  output: drugSchema,
  handler: async ({ input, ctx: { drugs } }) => {
    const { drugId, ...data } = input;
    return drugs.updateDrug(drugId, data);
  },
});

export const deleteDrugEndpoint = treatmentsWrite.build({
  method: "delete",
  input: z.object({ drugId: z.string() }),
  output: z.object({}),
  handler: async ({ input: { drugId }, ctx: { drugs } }) => {
    await drugs.deleteDrug(drugId);
    return {};
  },
});

export const drugInUseEndpoint = treatmentsRead.build({
  method: "get",
  input: z.object({ drugId: z.string() }),
  output: z.object({ inUse: z.boolean() }),
  handler: async ({ input, ctx: { drugs } }) => {
    const inUse = await drugs.drugInUse(input.drugId);
    return { inUse };
  },
});
