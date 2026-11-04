import createHttpError from "http-errors";
import { z } from "zod";
import { cropSchema } from "../crops/crops.endpoint";
import { seedQuantityKindSchema, sowingUnitSchema } from "../db/schema";
import { permissionFarmEndpoint } from "../endpoint-factory";

const seedsRead = permissionFarmEndpoint("field_calendar", "read");
const seedsWrite = permissionFarmEndpoint("field_calendar", "write");

export const seedSchema = z.object({
  id: z.string(),
  farmId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  cropId: z.string().nullable(),
  crop: cropSchema.omit({ family: true }).nullable(),
  quantityKind: seedQuantityKindSchema,
  defaultAmount: z.number().nullable(),
  defaultUnit: sowingUnitSchema.nullable(),
});

const createSeedSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  cropId: z.string().optional(),
  quantityKind: seedQuantityKindSchema,
  defaultAmount: z.number().optional(),
  defaultUnit: sowingUnitSchema.optional(),
});

// quantityKind can't be changed after creation, a new seed has to be created instead
const updateSeedSchema = z.object({
  name: z.string().optional(),
  description: z.string().optional().nullable(),
  cropId: z.string().optional().nullable(),
  defaultAmount: z.number().optional().nullable(),
  defaultUnit: sowingUnitSchema.optional().nullable(),
});

export const getSeedByIdEndpoint = seedsRead.build({
  method: "get",
  input: z.object({ seedId: z.string() }),
  output: seedSchema,
  handler: async ({ input, ctx: { seeds } }) => {
    const seed = await seeds.getSeedById(input.seedId);
    if (!seed) {
      throw createHttpError(404, "Seed not found");
    }
    return seed;
  },
});

export const getFarmSeedsEndpoint = seedsRead.build({
  method: "get",
  input: z.object({}),
  output: z.object({
    result: z.array(seedSchema),
    count: z.number(),
  }),
  handler: async ({ ctx: { seeds, farmId } }) => {
    const result = await seeds.getSeedsForFarm(farmId);
    return { result, count: result.length };
  },
});

export const createSeedEndpoint = seedsWrite.build({
  method: "post",
  input: createSeedSchema,
  output: seedSchema,
  handler: async ({ input, ctx: { seeds } }) => {
    return seeds.createSeed(input);
  },
});

export const updateSeedEndpoint = seedsWrite.build({
  method: "patch",
  input: updateSeedSchema.extend({ seedId: z.string() }),
  output: seedSchema,
  handler: async ({ input: { seedId, ...data }, ctx: { seeds } }) => {
    const seed = await seeds.updateSeed(seedId, data);
    if (!seed) {
      throw createHttpError(404, "Seed not found");
    }
    return seed;
  },
});

export const deleteSeedEndpoint = seedsWrite.build({
  method: "delete",
  input: z.object({ seedId: z.string() }),
  output: z.object({}),
  handler: async ({ input: { seedId }, ctx: { seeds } }) => {
    if (await seeds.seedInUse(seedId)) {
      throw createHttpError(409, "Seed is used by sowings");
    }
    await seeds.deleteSeed(seedId);
    return {};
  },
});

export const seedInUseEndpoint = seedsRead.build({
  method: "get",
  input: z.object({ seedId: z.string() }),
  output: z.object({ inUse: z.boolean() }),
  handler: async ({ input: { seedId }, ctx: { seeds } }) => {
    const inUse = await seeds.seedInUse(seedId);
    return { inUse };
  },
});
