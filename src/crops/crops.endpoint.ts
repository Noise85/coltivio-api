import createHttpError from "http-errors";
import { z } from "zod";
import { cropCategorySchema } from "../db/schema";
import { permissionFarmEndpoint } from "../endpoint-factory";

const cropsRead = permissionFarmEndpoint("field_calendar", "read");
const cropsWrite = permissionFarmEndpoint("field_calendar", "write");

export const cropFamilySchema = z.object({
  id: z.string(),
  farmId: z.string(),
  name: z.string(),
  waitingTimeInYears: z.number(),
  additionalNotes: z.string().nullable(),
});

export const cropSchema = z.object({
  id: z.string(),
  farmId: z.string(),
  name: z.string(),
  category: cropCategorySchema,
  familyId: z.string().nullable(),
  variety: z.string().nullable(),
  usageCodes: z.array(z.number()),
  waitingTimeInYears: z.number().nullable(),
  additionalNotes: z.string().nullable(),
  family: cropFamilySchema.nullable(),
});

const createCropSchema = z.object({
  name: z.string(),
  category: cropCategorySchema,
  variety: z.string().optional(),
  usageCodes: z.array(z.number()).default([]),
  waitingTimeInYears: z.number().optional(),
  familyId: z.string().optional(),
  additionalNotes: z.string().optional(),
});

const updateCropSchema = createCropSchema.partial().extend({
  waitingTimeInYears: z.number().optional().nullable(),
  familyId: z.string().optional().nullable(),
});

export const getCropByIdEndpoint = cropsRead.build({
  method: "get",
  input: z.object({ cropId: z.string() }),
  output: cropSchema,
  handler: async ({ input, ctx: { crops } }) => {
    const crop = await crops.getCropById(input.cropId);
    if (!crop) {
      throw createHttpError(404, "Crop not found");
    }
    return crop;
  },
});

export const getFarmCropsEndpoint = cropsRead.build({
  method: "get",
  input: z.object({}),
  output: z.object({
    result: z.array(cropSchema),
    count: z.number(),
  }),
  handler: async ({ ctx: { crops, farmId } }) => {
    const result = await crops.geCropsForFarm(farmId);
    return {
      result,
      count: result.length,
    };
  },
});

export const createCropEndpoint = cropsWrite.build({
  method: "post",
  input: createCropSchema,
  output: cropSchema,
  handler: async ({ input, ctx: { crops } }) => {
    return crops.createCrop(input);
  },
});

export const updateCropEndpoint = cropsWrite.build({
  method: "patch",
  input: updateCropSchema.extend({
    cropId: z.string(),
  }),
  output: cropSchema,
  handler: async ({ input, ctx: { crops } }) => {
    return crops.updateCrop(input.cropId, input);
  },
});

export const deleteCropEndpoint = cropsWrite.build({
  method: "delete",
  input: z.object({ cropId: z.string() }),
  output: z.object({}),
  handler: async ({ input: { cropId }, ctx: { crops } }) => {
    await crops.deleteCrop(cropId);
    return {};
  },
});

export const cropInUseEndpoint = cropsRead.build({
  method: "get",
  input: z.object({ cropId: z.string() }),
  output: z.object({ inUse: z.boolean() }),
  handler: async ({ input, ctx: { crops } }) => {
    return {
      inUse: await crops.cropInUse(input.cropId),
    };
  },
});

const createCropFamilySchema = z.object({
  name: z.string(),
  waitingTimeInYears: z.number().default(0),
  additionalNotes: z.string().optional(),
});

const updateCropFamilySchema = createCropFamilySchema.partial();

export const getCropFamilyByIdEndpoint = cropsRead.build({
  method: "get",
  input: z.object({ familyId: z.string() }),
  output: cropFamilySchema,
  handler: async ({ input, ctx: { crops } }) => {
    const family = await crops.getCropFamilyById(input.familyId);
    if (!family) {
      throw createHttpError(404, "Crop family not found");
    }
    return family;
  },
});

export const getFarmCropFamiliesEndpoint = cropsRead.build({
  method: "get",
  input: z.object({}),
  output: z.object({
    result: z.array(cropFamilySchema),
    count: z.number(),
  }),
  handler: async ({ ctx: { crops } }) => {
    const result = await crops.getCropFamiliesForFarm();
    return {
      result,
      count: result.length,
    };
  },
});

export const createCropFamilyEndpoint = cropsWrite.build({
  method: "post",
  input: createCropFamilySchema,
  output: cropFamilySchema,
  handler: async ({ input, ctx: { crops } }) => {
    return crops.createCropFamily(input);
  },
});

export const updateCropFamilyEndpoint = cropsWrite.build({
  method: "patch",
  input: updateCropFamilySchema.extend({
    familyId: z.string(),
  }),
  output: cropFamilySchema,
  handler: async ({ input, ctx: { crops } }) => {
    return crops.updateCropFamily(input.familyId, input);
  },
});

export const deleteCropFamilyEndpoint = cropsWrite.build({
  method: "delete",
  input: z.object({ familyId: z.string() }),
  output: z.object({}),
  handler: async ({ input: { familyId }, ctx: { crops } }) => {
    await crops.deleteCropFamily(familyId);
    return {};
  },
});

export const cropFamilyInUseEndpoint = cropsRead.build({
  method: "get",
  input: z.object({ familyId: z.string() }),
  output: z.object({ inUse: z.boolean() }),
  handler: async ({ input, ctx: { crops } }) => {
    return {
      inUse: await crops.cropFamilyInUse(input.familyId),
    };
  },
});
