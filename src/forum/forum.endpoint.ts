import { captureException } from "@sentry/node";
import createHttpError from "http-errors";
import { z } from "zod";
import { forumThreadStatusSchema, forumThreadTypeSchema } from "../db/schema";
import { userMembershipEndpointFactory, userPaidMembershipEndpointFactory } from "../endpoint-factory";
import { notifyNewReply, notifyNewThread } from "./forum-notifications";

const profileSnippetSchema = z.object({
  id: z.string(),
  fullName: z.string().nullable(),
});

export const forumThreadSchema = z.object({
  id: z.string(),
  title: z.string(),
  body: z.string(),
  type: forumThreadTypeSchema,
  status: forumThreadStatusSchema,
  isPinned: z.boolean(),
  createdBy: z.string().nullable(),
  createdAt: z.string().or(z.date()),
  updatedAt: z.string().or(z.date()),
  creator: profileSnippetSchema.nullable(),
  replyCount: z.number().optional(),
  isSubscribed: z.boolean().optional(),
});

export const forumReplySchema = z.object({
  id: z.string(),
  threadId: z.string(),
  body: z.string(),
  createdBy: z.string().nullable(),
  createdAt: z.string().or(z.date()),
  updatedAt: z.string().or(z.date()),
  creator: profileSnippetSchema.nullable(),
});

export const listForumThreadsEndpoint = userMembershipEndpointFactory.build({
  method: "get",
  input: z.object({
    type: forumThreadTypeSchema.optional(),
    status: forumThreadStatusSchema.optional(),
    search: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    offset: z.coerce.number().int().min(0).default(0),
  }),
  output: z.object({
    result: z.array(forumThreadSchema),
    total: z.number(),
  }),
  handler: async ({ input, ctx: { forum } }) => {
    const { threads, total } = await forum.listThreads({
      type: input.type,
      status: input.status,
      search: input.search,
      limit: input.limit,
      offset: input.offset,
    });
    return { result: threads, total };
  },
});

export const createForumThreadEndpoint = userPaidMembershipEndpointFactory.build({
  method: "post",
  input: z.object({
    title: z.string().min(1),
    body: z.string().default(""),
    type: forumThreadTypeSchema.default("general"),
  }),
  output: forumThreadSchema,
  handler: async ({ input, ctx: { forum, user } }) => {
    const thread = await forum.createThread(user.id, {
      title: input.title,
      body: input.body,
      type: input.type,
    });
    notifyNewThread(thread, user.id).catch(captureException);
    return thread;
  },
});

export const getForumThreadByIdEndpoint = userMembershipEndpointFactory.build({
  method: "get",
  input: z.object({ threadId: z.string() }),
  output: forumThreadSchema,
  handler: async ({ input, ctx: { forum, user } }) => {
    const thread = await forum.getThreadById(input.threadId, user.id);
    if (!thread) throw createHttpError(404, "Thread not found");
    return thread;
  },
});

export const setForumThreadSubscriptionEndpoint = userMembershipEndpointFactory.build({
  method: "put",
  input: z.object({
    threadId: z.string(),
    subscribed: z.boolean(),
  }),
  output: z.object({ subscribed: z.boolean() }),
  handler: async ({ input, ctx: { forum, user } }) => {
    await forum.setSubscription(input.threadId, user.id, input.subscribed);
    return { subscribed: input.subscribed };
  },
});

export const updateForumThreadEndpoint = userPaidMembershipEndpointFactory.build({
  method: "patch",
  input: z.object({
    threadId: z.string(),
    title: z.string().min(1).optional(),
    body: z.string().optional(),
  }),
  output: forumThreadSchema,
  handler: async ({ input, ctx: { forum, user } }) => {
    const { threadId, ...data } = input;
    const thread = await forum.getThreadById(threadId);
    if (!thread) throw createHttpError(404, "Thread not found");
    if (thread.createdBy !== user.id) throw createHttpError(403, "You can only edit your own threads");

    return forum.updateThread(threadId, user.id, data);
  },
});

export const deleteForumThreadEndpoint = userPaidMembershipEndpointFactory.build({
  method: "delete",
  input: z.object({ threadId: z.string() }),
  output: z.object({}),
  handler: async ({ input, ctx: { forum, forumModeration, user } }) => {
    const thread = await forum.getThreadById(input.threadId);
    if (!thread) throw createHttpError(404, "Thread not found");

    const isMod = await forumModeration.isModerator(user.id);
    if (!isMod && thread.createdBy !== user.id) throw createHttpError(403, "You can only delete your own threads");

    await forumModeration.deleteThread(input.threadId);
    return {};
  },
});

export const listForumRepliesEndpoint = userMembershipEndpointFactory.build({
  method: "get",
  input: z.object({ threadId: z.string() }),
  output: z.object({
    result: z.array(forumReplySchema),
    count: z.number(),
  }),
  handler: async ({ input, ctx: { forum } }) => {
    const result = await forum.listReplies(input.threadId);
    return { result, count: result.length };
  },
});

export const addForumReplyEndpoint = userPaidMembershipEndpointFactory.build({
  method: "post",
  input: z.object({
    threadId: z.string(),
    body: z.string().min(1),
  }),
  output: forumReplySchema,
  handler: async ({ input, ctx: { forum, user } }) => {
    const thread = await forum.getThreadById(input.threadId);
    if (!thread) throw createHttpError(404, "Thread not found");
    if (thread.status === "closed") throw createHttpError(400, "Cannot reply to a closed thread");

    const reply = await forum.addReply(input.threadId, user.id, input.body);
    notifyNewReply(thread, reply, user.id).catch(captureException);
    return reply;
  },
});

export const updateForumReplyEndpoint = userPaidMembershipEndpointFactory.build({
  method: "patch",
  input: z.object({
    replyId: z.string(),
    body: z.string().min(1),
  }),
  output: forumReplySchema,
  handler: async ({ input, ctx: { forum, user } }) => {
    return forum.updateReply(input.replyId, user.id, input.body);
  },
});

export const deleteForumReplyEndpoint = userPaidMembershipEndpointFactory.build({
  method: "delete",
  input: z.object({ replyId: z.string() }),
  output: z.object({}),
  handler: async ({ input, ctx: { forum, forumModeration, user } }) => {
    const reply = await forum.getReplyById(input.replyId);
    if (!reply) throw createHttpError(404, "Reply not found");

    const isMod = await forumModeration.isModerator(user.id);
    if (!isMod && reply.createdBy !== user.id) throw createHttpError(403, "You can only delete your own replies");

    await forumModeration.deleteReply(input.replyId);
    return {};
  },
});
