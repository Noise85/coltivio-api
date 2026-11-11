import { ez } from "express-zod-api";
import createHttpError from "http-errors";
import { z } from "zod";
import { permissionFarmEndpoint } from "../endpoint-factory";

const animalsRead = permissionFarmEndpoint("animals", "read");
const animalsWrite = permissionFarmEndpoint("animals", "write");

export const animalWeightSchema = z.object({
  id: z.string(),
  farmId: z.string(),
  animalId: z.string(),
  date: ez.dateOut(),
  weightKg: z.number(),
  notes: z.string().nullable(),
  createdAt: ez.dateOut(),
  createdBy: z.string().nullable(),
});

export const listAnimalWeightsEndpoint = animalsRead.build({
  method: "get",
  input: z.object({ animalId: z.string() }),
  output: z.object({ result: z.array(animalWeightSchema) }),
  handler: async ({ input, ctx: { animalWeights } }) => {
    return { result: await animalWeights.listWeights(input.animalId) };
  },
});

export const createAnimalWeightEndpoint = animalsWrite.build({
  method: "post",
  input: z.object({
    animalId: z.string(),
    date: ez.dateIn(),
    weightKg: z.number().positive(),
    notes: z.string().optional().nullable(),
  }),
  output: animalWeightSchema,
  handler: async ({ input, ctx: { animalWeights, user } }) => {
    const { animalId, ...weightInput } = input;
    const weight = await animalWeights.createWeight(animalId, user.id, weightInput);
    if (!weight) throw createHttpError(404, "Animal not found");
    return weight;
  },
});

export const updateAnimalWeightEndpoint = animalsWrite.build({
  method: "patch",
  input: z.object({
    weightId: z.string(),
    date: ez.dateIn().optional(),
    weightKg: z.number().positive().optional(),
    notes: z.string().optional().nullable(),
  }),
  output: animalWeightSchema,
  handler: async ({ input, ctx: { animalWeights } }) => {
    const { weightId, ...updateInput } = input;
    const weight = await animalWeights.updateWeight(weightId, updateInput);
    if (!weight) throw createHttpError(404, "Weight entry not found");
    return weight;
  },
});

export const deleteAnimalWeightEndpoint = animalsWrite.build({
  method: "delete",
  input: z.object({ weightId: z.string() }),
  output: z.object({}),
  handler: async ({ input, ctx: { animalWeights } }) => {
    const deleted = await animalWeights.deleteWeight(input.weightId);
    if (!deleted) throw createHttpError(404, "Weight entry not found");
    return {};
  },
});
