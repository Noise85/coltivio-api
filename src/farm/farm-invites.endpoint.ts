import { z } from "zod";
import { authenticatedEndpointFactory, ownerOnlyEndpointFactory } from "../endpoint-factory";
import { farmPermissionFeatureSchema } from "../db/schema";
import { userSchema } from "../user/users.endpoint";

const inviteSchema = z.object({
  id: z.string(),
  farmId: z.string(),
  email: z.string(),
  role: z.enum(["owner", "member"]),
  createdBy: z.string().nullable(),
  expiresAt: z.string().or(z.date()),
  usedAt: z.string().or(z.date()).nullable(),
});

export const listFarmInvitesEndpoint = ownerOnlyEndpointFactory.build({
  method: "get",
  input: z.object({}),
  output: z.object({ result: z.array(inviteSchema), count: z.number() }),
  handler: async ({ ctx }) => {
    const result = await ctx.farmInvites.listInvites(ctx.farmId);
    return { result, count: result.length };
  },
});

const invitePermissionSchema = z.object({
  feature: farmPermissionFeatureSchema,
  access: z.enum(["none", "read", "write"]),
});

export const createFarmInviteEndpoint = ownerOnlyEndpointFactory.build({
  method: "post",
  input: z.object({
    email: z.string().email(),
    role: z.enum(["owner", "member"]).default("member"),
    // Per-feature access to grant on acceptance. Unlisted features default to "none".
    permissions: z.array(invitePermissionSchema).optional(),
  }),
  output: inviteSchema,
  handler: async ({ input, ctx }) => {
    return ctx.farmInvites.createInvite(ctx.farmId, input.email, ctx.user.id, input.role, input.permissions ?? []);
  },
});

export const revokeFarmInviteEndpoint = ownerOnlyEndpointFactory.build({
  method: "delete",
  input: z.object({ inviteId: z.string() }),
  output: z.object({}),
  handler: async ({ input, ctx }) => {
    await ctx.farmInvites.revokeInvite(input.inviteId);
    return {};
  },
});

export const acceptFarmInviteEndpoint = authenticatedEndpointFactory.build({
  method: "post",
  input: z.object({ code: z.string() }),
  output: userSchema,
  handler: async ({ input, ctx }) => {
    const updatedUser = await ctx.farmInvites.acceptInvite(input.code, ctx.user);
    const [isWikiModerator, isForumModerator] = await Promise.all([
      ctx.wikiModeration.isModerator(updatedUser.id),
      ctx.forumModeration.isModerator(updatedUser.id),
    ]);
    return { ...updatedUser, isWikiModerator, isForumModerator };
  },
});
