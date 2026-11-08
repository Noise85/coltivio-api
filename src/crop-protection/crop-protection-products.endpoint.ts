import createHttpError from "http-errors";
import { z } from "zod";
import { cropProtectionUnitSchema } from "../db/schema";
import { permissionFarmEndpoint } from "../endpoint-factory";

const cropProtectionRead = permissionFarmEndpoint("field_calendar", "read");
const cropProtectionWrite = permissionFarmEndpoint("field_calendar", "write");

// API Schemas - decoupled from database schema for stable API contract
export const cropProtectionProductSchema = z.object({
  id: z.string(),
  farmId: z.string(),
  name: z.string(),
  unit: cropProtectionUnitSchema,
  description: z.string().nullable(),
});

const createCropProtectionProductSchema = z.object({
  name: z.string(),
  unit: cropProtectionUnitSchema,
  description: z.string().optional(),
  defaultEquipmentId: z.string().optional(),
});

const updateCropProtectionProductSchema = createCropProtectionProductSchema.partial();

export const getCropProtectionProductByIdEndpoint = cropProtectionRead.build({
  method: "get",
  input: z.object({ cropProtectionProductId: z.string() }),
  output: cropProtectionProductSchema,
  handler: async ({ input, ctx: { cropProtectionProducts } }) => {
    const cropProtectionProduct = await cropProtectionProducts.getCropProtectionProductById(
      input.cropProtectionProductId
    );
    if (!cropProtectionProduct) {
      throw createHttpError(404, "CropProtectionProduct not found");
    }
    return cropProtectionProduct;
  },
});

export const getFarmCropProtectionProductsEndpoint = cropProtectionRead.build({
  method: "get",
  input: z.object({}),
  output: z.object({
    result: z.array(cropProtectionProductSchema),
    count: z.number(),
  }),
  handler: async ({ ctx: { cropProtectionProducts, farmId } }) => {
    const result = await cropProtectionProducts.getCropProtectionProductsForFarm(farmId);
    return {
      result,
      count: result.length,
    };
  },
});

export const createCropProtectionProductEndpoint = cropProtectionWrite.build({
  method: "post",
  input: createCropProtectionProductSchema,
  output: cropProtectionProductSchema,
  handler: async ({ input, ctx: { cropProtectionProducts } }) => {
    return cropProtectionProducts.createCropProtectionProduct(input);
  },
});

export const updateCropProtectionProductEndpoint = cropProtectionWrite.build({
  method: "patch",
  input: updateCropProtectionProductSchema.extend({
    cropProtectionProductId: z.string(),
  }),
  output: cropProtectionProductSchema,
  handler: async ({ input, ctx: { cropProtectionProducts } }) => {
    return cropProtectionProducts.updateCropProtectionProduct(input.cropProtectionProductId, input);
  },
});

export const deleteCropProtectionProductEndpoint = cropProtectionWrite.build({
  method: "delete",
  input: z.object({ cropProtectionProductId: z.string() }),
  output: z.object({}),
  handler: async ({ input: { cropProtectionProductId }, ctx: { cropProtectionProducts: cropProtectionProduct } }) => {
    await cropProtectionProduct.deleteCropProtectionProduct(cropProtectionProductId);
    return {};
  },
});

export const cropProtectionProductInUseEndpoint = cropProtectionRead.build({
  method: "get",
  input: z.object({ cropProtectionProductId: z.string() }),
  output: z.object({ inUse: z.boolean() }),
  handler: async ({ input: { cropProtectionProductId }, ctx: { cropProtectionProducts } }) => {
    const inUse = await cropProtectionProducts.cropProtectionProductInUse(cropProtectionProductId);
    return { inUse };
  },
});
