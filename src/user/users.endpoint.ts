import createHttpError from "http-errors";
import { z } from "zod";
import { farmEndpointFactory, authenticatedEndpointFactory } from "../endpoint-factory";
import { farmPermissionFeatureSchema } from "../db/schema";
import { deletionOutcomeSchema } from "./users";

const farmPermissionSchema = z.object({
  feature: farmPermissionFeatureSchema,
  access: z.enum(["none", "read", "write"]),
});

export const userSchema = z.object({
  id: z.string(),
  email: z.string(),
  fullName: z.string().nullable(),
  emailVerified: z.boolean(),
  farmId: z.string().nullable(),
  farmRole: z.enum(["owner", "member"]).nullable(),
  isWikiModerator: z.boolean(),
  isForumModerator: z.boolean(),
});

// Extended schema for GET /me — includes the caller's explicit permission grants.
// Owners always have full access so farmPermissions is empty for them.
// Members default to "none" for unlisted features.
const myProfileSchema = userSchema.extend({
  farmPermissions: z.array(farmPermissionSchema),
  taskPushNotifications: z.boolean(),
});

const updatedProfileSchema = userSchema.extend({
  taskPushNotifications: z.boolean(),
});

const updateUserSchema = z
  .object({
    fullName: z.string().optional(),
    newsletterConsent: z.boolean().optional(),
    taskPushNotifications: z.boolean().optional(),
  })
  .partial();

export const getMyUserProfileEndpoint = authenticatedEndpointFactory.build({
  method: "get",
  input: z.object({}),
  output: myProfileSchema,
  handler: async ({ ctx }) => {
    const [user, isWikiModerator, isForumModerator, farmPermissions, settings] = await Promise.all([
      ctx.users.getUserById(ctx.user.id),
      ctx.wikiModeration.isModerator(ctx.user.id),
      ctx.forumModeration.isModerator(ctx.user.id),
      ctx.farmPermissions.listPermissionsForUser(ctx.user.id),
      ctx.users.getSettings(ctx.user.id),
    ]);
    return {
      ...user,
      ...settings,
      farmId: ctx.farmContext.farmId,
      farmRole: ctx.farmContext.farmRole,
      isWikiModerator,
      isForumModerator,
      farmPermissions,
    };
  },
});

export const getUserProfileByIdEndpoint = farmEndpointFactory.build({
  method: "get",
  input: z.object({ userId: z.string() }),
  output: userSchema,
  handler: async ({ input, ctx }) => {
    const [user, isWikiModerator, isForumModerator, member] = await Promise.all([
      ctx.users.getUserById(input.userId),
      ctx.wikiModeration.isModerator(input.userId),
      ctx.forumModeration.isModerator(input.userId),
      ctx.farms.getFarmMember(ctx.farmId, input.userId),
    ]);
    if (!member) {
      throw createHttpError(404, "User not found");
    }
    return { ...user, farmId: ctx.farmId, farmRole: member.role, isWikiModerator, isForumModerator };
  },
});

export const getFarmUsersEndpoint = farmEndpointFactory.build({
  method: "get",
  input: z.object({}),
  output: z.object({
    result: z.array(userSchema),
    count: z.number(),
  }),
  handler: async ({ ctx }) => {
    const [users, wikiModeratorIds, forumModeratorIds] = await Promise.all([
      ctx.farms.getFarmUsers(ctx.farmId),
      ctx.wikiModeration.getModeratorUserIds(),
      ctx.forumModeration.getModeratorUserIds(),
    ]);
    const result = users.map((u) => ({
      ...u,
      isWikiModerator: wikiModeratorIds.has(u.id),
      isForumModerator: forumModeratorIds.has(u.id),
    }));
    return { result, count: result.length };
  },
});

export const updateUserProfileEndpoint = authenticatedEndpointFactory.build({
  method: "patch",
  input: updateUserSchema,
  output: updatedProfileSchema,
  handler: async ({ input, ctx }) => {
    const { newsletterConsent, taskPushNotifications, ...profileInput } = input;
    if (newsletterConsent !== undefined) {
      await ctx.users.setNewsletterConsent(ctx.user.id, newsletterConsent);
    }
    // Drizzle rejects an empty update set, so a settings-only PATCH just reads the profile back
    const hasProfileChanges = Object.keys(profileInput).length > 0;
    const [user, isWikiModerator, isForumModerator, settings] = await Promise.all([
      hasProfileChanges ? ctx.users.updateUser(ctx.user.id, profileInput) : ctx.users.getUserById(ctx.user.id),
      ctx.wikiModeration.isModerator(ctx.user.id),
      ctx.forumModeration.isModerator(ctx.user.id),
      taskPushNotifications !== undefined
        ? ctx.users.updateSettings(ctx.user.id, { taskPushNotifications })
        : ctx.users.getSettings(ctx.user.id),
    ]);
    return {
      ...user,
      ...settings,
      farmId: ctx.farmContext.farmId,
      farmRole: ctx.farmContext.farmRole,
      isWikiModerator,
      isForumModerator,
    };
  },
});

const deletionPreviewFarmSchema = z.object({
  id: z.string(),
  name: z.string(),
  outcome: deletionOutcomeSchema,
});

export const getAccountDeletionPreviewEndpoint = authenticatedEndpointFactory.build({
  method: "get",
  input: z.object({}),
  output: z.object({ farms: z.array(deletionPreviewFarmSchema) }),
  handler: async ({ ctx }) => {
    return { farms: await ctx.users.getDeletionPreview(ctx.user.id) };
  },
});

export const deleteAccountEndpoint = authenticatedEndpointFactory.build({
  method: "post",
  input: z.object({
    // Typed by the user as confirmation
    email: z.string(),
  }),
  output: z.object({}),
  handler: async ({ input, ctx }) => {
    if (input.email.trim().toLowerCase() !== ctx.user.email.trim().toLowerCase()) {
      throw createHttpError(400, "Email does not match");
    }
    await ctx.users.deleteAccount(ctx.user.id);
    return {};
  },
});

export const leaveFarmEndpoint = farmEndpointFactory.build({
  method: "delete",
  input: z.object({}),
  output: z.object({}),
  handler: async ({ ctx }) => {
    await ctx.farms.leaveFarm(ctx.user.id, ctx.farmId);
    return {};
  },
});

export const kickFarmMemberEndpoint = farmEndpointFactory.build({
  method: "delete",
  input: z.object({ userId: z.string() }),
  output: z.object({}),
  handler: async ({ input, ctx }) => {
    if (ctx.farmRole !== "owner") {
      throw createHttpError(403, "Only farm owners can kick members");
    }
    await ctx.farms.kickMember(input.userId, ctx.user.id, ctx.farmId);
    return {};
  },
});

export const changeFarmMemberRoleEndpoint = farmEndpointFactory.build({
  method: "patch",
  input: z.object({ userId: z.string(), role: z.enum(["owner", "member"]) }),
  output: userSchema,
  handler: async ({ input, ctx }) => {
    if (ctx.farmRole !== "owner") {
      throw createHttpError(403, "Only farm owners can change member roles");
    }
    const [updatedProfile, isWikiModerator, isForumModerator] = await Promise.all([
      ctx.farms.changeMemberRole(input.userId, ctx.user.id, ctx.farmId, input.role),
      ctx.wikiModeration.isModerator(input.userId),
      ctx.forumModeration.isModerator(input.userId),
    ]);
    return { ...updatedProfile, isWikiModerator, isForumModerator };
  },
});
