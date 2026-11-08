import createHttpError from "http-errors";
import { z } from "zod";
import { fertilizerTypeSchema, fertilizerUnitSchema } from "../db/schema";
import { permissionFarmEndpoint } from "../endpoint-factory";

const fertilizationRead = permissionFarmEndpoint("field_calendar", "read");
const fertilizationWrite = permissionFarmEndpoint("field_calendar", "write");

// API Schemas - decoupled from database schema for stable API contract
export const fertilizerSchema = z.object({
  id: z.string(),
  farmId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  type: fertilizerTypeSchema,
  unit: fertilizerUnitSchema,
});

const createFertilizerSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  type: fertilizerTypeSchema,
  unit: fertilizerUnitSchema,
  defaultSpreaderId: z.string().optional(),
});

const updateFertilizerSchema = createFertilizerSchema.partial();

export const getFertilizerByIdEndpoint = fertilizationRead.build({
  method: "get",
  input: z.object({ fertilizerId: z.string() }),
  output: fertilizerSchema,
  handler: async ({ input, ctx: { fertilizers } }) => {
    const fertilizer = await fertilizers.getFertilizerById(input.fertilizerId);
    if (!fertilizer) {
      throw createHttpError(404, "Fertilizer not found");
    }
    return fertilizer;
  },
});

export const getFarmFertilizersEndpoint = fertilizationRead.build({
  method: "get",
  input: z.object({}),
  output: z.object({
    result: z.array(fertilizerSchema),
    count: z.number(),
  }),
  handler: async ({ ctx: { fertilizers, farmId } }) => {
    const result = await fertilizers.getFertilizersForFarm(farmId);
    return {
      result,
      count: result.length,
    };
  },
});

export const createFertilizerEndpoint = fertilizationWrite.build({
  method: "post",
  input: createFertilizerSchema,
  output: fertilizerSchema,
  handler: async ({ input, ctx: { fertilizers } }) => {
    return fertilizers.createFertilizer(input);
  },
});

export const updateFertilizerEndpoint = fertilizationWrite.build({
  method: "patch",
  input: updateFertilizerSchema.extend({
    fertilizerId: z.string(),
  }),
  output: fertilizerSchema,
  handler: async ({ input, ctx: { fertilizers } }) => {
    return fertilizers.updateFertilizer(input.fertilizerId, input);
  },
});

export const deleteFertilizerEndpoint = fertilizationWrite.build({
  method: "delete",
  input: z.object({ fertilizerId: z.string() }),
  output: z.object({}),
  handler: async ({ input: { fertilizerId }, ctx: { fertilizers: fertilizer } }) => {
    await fertilizer.deleteFertilizer(fertilizerId);
    return {};
  },
});

export const fertilizerInUseEndpoint = fertilizationRead.build({
  method: "get",
  input: z.object({ fertilizerId: z.string() }),
  output: z.object({ inUse: z.boolean() }),
  handler: async ({ input: { fertilizerId }, ctx: { fertilizers } }) => {
    const inUse = await fertilizers.fertilizerInUse(fertilizerId);
    return { inUse };
  },
});
