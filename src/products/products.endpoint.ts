import createHttpError from "http-errors";
import { z } from "zod";
import { productCategorySchema, productUnitSchema } from "../db/schema";
import { permissionFarmEndpoint } from "../endpoint-factory";

const productsRead = permissionFarmEndpoint("commerce", "read");
const productsWrite = permissionFarmEndpoint("commerce", "write");

export const productSchema = z.object({
  id: z.string(),
  farmId: z.string(),
  name: z.string(),
  category: productCategorySchema,
  unit: productUnitSchema,
  pricePerUnit: z.number(),
  description: z.string().nullable(),
  active: z.boolean(),
});

const createProductSchema = z.object({
  name: z.string(),
  category: productCategorySchema,
  unit: productUnitSchema,
  pricePerUnit: z.number(),
  description: z.string().optional(),
  active: z.boolean().default(true),
});

const updateProductSchema = createProductSchema.partial();

export const getProductByIdEndpoint = productsRead.build({
  method: "get",
  input: z.object({ productId: z.string() }),
  output: productSchema,
  handler: async ({ input, ctx: { products } }) => {
    const product = await products.getProductById(input.productId);
    if (!product) {
      throw createHttpError(404, "Product not found");
    }
    return product;
  },
});

export const getFarmProductsEndpoint = productsRead.build({
  method: "get",
  input: z.object({}),
  output: z.object({
    result: z.array(productSchema),
    count: z.number(),
  }),
  handler: async ({ ctx: { products, farmId } }) => {
    const result = await products.getProductsForFarm(farmId);
    return {
      result,
      count: result.length,
    };
  },
});

export const getActiveProductsEndpoint = productsRead.build({
  method: "get",
  input: z.object({}),
  output: z.object({
    result: z.array(productSchema),
    count: z.number(),
  }),
  handler: async ({ ctx: { products, farmId } }) => {
    const result = await products.getActiveProductsForFarm(farmId);
    return {
      result,
      count: result.length,
    };
  },
});

export const createProductEndpoint = productsWrite.build({
  method: "post",
  input: createProductSchema,
  output: productSchema,
  handler: async ({ input, ctx: { products } }) => {
    return products.createProduct(input);
  },
});

export const updateProductEndpoint = productsWrite.build({
  method: "patch",
  input: updateProductSchema.extend({
    productId: z.string(),
  }),
  output: productSchema,
  handler: async ({ input, ctx: { products } }) => {
    const { productId, ...data } = input;
    return products.updateProduct(productId, data);
  },
});

export const deleteProductEndpoint = productsWrite.build({
  method: "delete",
  input: z.object({ productId: z.string() }),
  output: z.object({}),
  handler: async ({ input: { productId }, ctx: { products } }) => {
    await products.deleteProduct(productId);
    return {};
  },
});
