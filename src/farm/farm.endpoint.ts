import createHttpError from "http-errors";
import { z } from "zod";
import { animalTypeSchema } from "../db/schema";
import { authenticatedEndpointFactory, farmEndpointFactory } from "../endpoint-factory";

const pointSchema = z.object({
  type: z.literal("Point"),
  coordinates: z.tuple([z.number(), z.number()]),
});

const farmBaseSchema = z.object({
  id: z.string(),
  federalId: z.string().nullable(),
  tvdId: z.string().nullable(),
  name: z.string(),
  address: z.string(),
  location: pointSchema,
});

export const farmSchema = farmBaseSchema.extend({
  membership: z.object({ status: z.enum(["none", "trial", "active"]) }),
});

const createFarmSchema = z.object({
  name: z.string(),
  federalId: z.string().optional().nullable(),
  address: z.string(),
  location: pointSchema,
});

const updateFarmSchema = z.object({
  name: z.string().optional(),
  location: pointSchema.optional(),
  address: z.string().optional(),
  federalId: z.string().optional(),
  tvdId: z.string().optional(),
});

export const getFarmEndpoint = farmEndpointFactory.build({
  method: "get",
  input: z.object({}),
  output: farmSchema,
  handler: async ({ ctx }) => {
    const [farm, status] = await Promise.all([
      ctx.farms.getFarmById(ctx.farmId),
      ctx.membership.getFarmMembershipStatus(ctx.farmId),
    ]);
    if (!farm) {
      throw createHttpError(404, "Farm not found");
    }

    return { ...farm, membership: { status } };
  },
});

export const createFarmEndpoint = authenticatedEndpointFactory.build({
  method: "post",
  input: createFarmSchema,
  output: farmBaseSchema,
  handler: async ({ input, ctx }) => {
    return ctx.farms.createFarm(ctx.user.id, input);
  },
});

const myFarmSchema = farmBaseSchema.pick({ id: true, name: true, address: true }).extend({
  role: z.enum(["owner", "member"]),
});

export const listMyFarmsEndpoint = authenticatedEndpointFactory.build({
  method: "get",
  input: z.object({}),
  output: z.object({ result: z.array(myFarmSchema), count: z.number() }),
  handler: async ({ ctx }) => {
    const result = await ctx.farms.listFarmsForUser(ctx.user.id);
    return { result, count: result.length };
  },
});

export const updateFarmEndpoint = farmEndpointFactory.build({
  method: "patch",
  input: updateFarmSchema,
  output: farmSchema,
  handler: async ({ input, ctx }) => {
    if (ctx.farmRole !== "owner") {
      throw createHttpError(403, "Only farm owners can update farm settings");
    }
    const [farm, status] = await Promise.all([
      ctx.farms.updateFarm(ctx.farmId, input),
      ctx.membership.getFarmMembershipStatus(ctx.farmId),
    ]);
    return { ...farm, membership: { status } };
  },
});

const farmStatsSchema = z.object({
  plots: z.object({
    total: z.number(),
    totalAreaM2: z.number(),
  }),
  animals: z.object({
    totalLiving: z.number(),
    byType: z.array(z.object({ type: animalTypeSchema, count: z.number() })),
  }),
  cropRotations: z.object({
    active: z.array(
      z.object({ cropName: z.string(), category: z.string(), plotCount: z.number(), totalAreaM2: z.number() })
    ),
  }),
});

export const getFarmStatsEndpoint = farmEndpointFactory.build({
  method: "get",
  input: z.object({}),
  output: farmStatsSchema,
  handler: async ({ ctx }) => {
    return ctx.farms.getFarmStats(ctx.farmId);
  },
});

export const deleteFarmEndpoint = farmEndpointFactory.build({
  method: "delete",
  input: z.object({
    deleteAccount: z.string().transform((value) => value === "true"),
  }),
  output: z.object({}),
  handler: async ({ input, ctx }) => {
    if (ctx.farmRole !== "owner") {
      throw createHttpError(403, "Only farm owners can delete the farm");
    }
    if (input.deleteAccount) {
      // Offered when deleting the user's last farm (and used by older app versions). This flow never
      // shows which other farms would go with the account, so any such farm blocks up front, with
      // neither the farm nor the account touched.
      const preview = await ctx.users.getDeletionPreview(ctx.user.id);
      if (preview.some((farm) => farm.id !== ctx.farmId && farm.outcome === "delete")) {
        throw createHttpError(
          409,
          "You are the only owner of another farm. Delete your account from your profile instead."
        );
      }
    }
    await ctx.farms.deleteFarm(ctx.farmId);
    if (input.deleteAccount) {
      await ctx.users.deleteAccount(ctx.user.id);
    }
    return {};
  },
});
