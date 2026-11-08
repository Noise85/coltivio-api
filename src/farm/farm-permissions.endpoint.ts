import createHttpError from "http-errors";
import { z } from "zod";
import { farmEndpointFactory, ownerOnlyEndpointFactory } from "../endpoint-factory";
import { farmPermissionFeatureSchema } from "../db/schema";

const permissionSchema = z.object({
  id: z.string(),
  farmId: z.string(),
  userId: z.string(),
  feature: farmPermissionFeatureSchema,
  access: z.enum(["none", "read", "write"]),
});

export const listMemberPermissionsEndpoint = farmEndpointFactory.build({
  method: "get",
  input: z.object({ userId: z.string() }),
  output: z.object({ result: z.array(permissionSchema) }),
  handler: async ({ input, ctx }) => {
    const result = await ctx.farmPermissions.listPermissionsForUser(input.userId);
    return { result };
  },
});

export const setMemberPermissionEndpoint = ownerOnlyEndpointFactory.build({
  method: "put",
  input: z.object({
    userId: z.string(),
    feature: farmPermissionFeatureSchema,
    access: z.enum(["none", "read", "write"]),
  }),
  output: z.object({}),
  handler: async ({ input, ctx }) => {
    const member = await ctx.farms.getFarmMember(ctx.farmId, input.userId);
    if (!member) {
      throw createHttpError(404, "Member not found in this farm");
    }
    await ctx.farmPermissions.setFeatureAccess(input.userId, ctx.farmId, input.feature, input.access);
    return {};
  },
});

export const resetMemberPermissionEndpoint = ownerOnlyEndpointFactory.build({
  method: "delete",
  input: z.object({ userId: z.string(), feature: farmPermissionFeatureSchema }),
  output: z.object({}),
  handler: async ({ input, ctx }) => {
    const member = await ctx.farms.getFarmMember(ctx.farmId, input.userId);
    if (!member) {
      throw createHttpError(404, "Member not found in this farm");
    }
    await ctx.farmPermissions.resetFeatureAccess(input.userId, ctx.farmId, input.feature);
    return {};
  },
});
