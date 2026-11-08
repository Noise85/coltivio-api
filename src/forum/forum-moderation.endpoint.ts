import createHttpError from "http-errors";
import { z } from "zod";
import { userMembershipEndpointFactory } from "../endpoint-factory";

// ─── Set thread status (open / closed) ───────────────────────────────────────

export const setForumThreadStatusEndpoint = userMembershipEndpointFactory.build({
  method: "post",
  input: z.object({
    threadId: z.string(),
    status: z.enum(["open", "closed"]),
  }),
  output: z.object({}),
  handler: async ({ input, ctx: { forum, forumModeration, user } }) => {
    const thread = await forum.getThreadById(input.threadId);
    if (!thread) throw createHttpError(404, "Thread not found");

    const isMod = await forumModeration.isModerator(user.id);
    if (!isMod && thread.createdBy !== user.id)
      throw createHttpError(403, "Only the thread author or a moderator can change thread status");

    await forumModeration.setThreadStatus(input.threadId, input.status);
    return {};
  },
});

// ─── Pin / unpin thread ───────────────────────────────────────────────────────

export const pinForumThreadEndpoint = userMembershipEndpointFactory.build({
  method: "post",
  input: z.object({
    threadId: z.string(),
    pinned: z.boolean(),
  }),
  output: z.object({}),
  handler: async ({ input, ctx: { forumModeration, user } }) => {
    const isMod = await forumModeration.isModerator(user.id);
    if (!isMod) throw createHttpError(403, "Not a forum moderator");

    await forumModeration.pinThread(input.threadId, input.pinned);
    return {};
  },
});
