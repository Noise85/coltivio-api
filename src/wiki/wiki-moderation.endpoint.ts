import createHttpError from "http-errors";
import { z } from "zod";
import { wikiLocaleSchema, wikiCategorySchema } from "../db/schema";
import { authenticatedEndpointFactory } from "../endpoint-factory";
import { wikiEntrySchema, wikiChangeRequestSchema } from "./wiki.endpoint";

// ─── Review queue ─────────────────────────────────────────────────────────────

export const getWikiReviewQueueEndpoint = authenticatedEndpointFactory.build({
  method: "get",
  input: z.object({}),
  output: z.object({
    result: z.array(
      wikiChangeRequestSchema.extend({
        // null for new_entry type when source private entry has been deleted
        entry: wikiEntrySchema.nullable(),
      })
    ),
    count: z.number(),
  }),
  handler: async ({ ctx: { wikiModeration, user } }) => {
    const isMod = await wikiModeration.isModerator(user.id);
    if (!isMod) throw createHttpError(403, "Not a wiki moderator");

    const result = await wikiModeration.getReviewQueue();
    return { result, count: result.length };
  },
});

// ─── Get single change request for review ────────────────────────────────────

export const getWikiChangeRequestForReviewEndpoint = authenticatedEndpointFactory.build({
  method: "get",
  input: z.object({ changeRequestId: z.string() }),
  output: wikiChangeRequestSchema.extend({ entry: wikiEntrySchema.nullable() }),
  handler: async ({ input, ctx: { wikiModeration, user } }) => {
    const isMod = await wikiModeration.isModerator(user.id);
    if (!isMod) throw createHttpError(403, "Not a wiki moderator");

    const cr = await wikiModeration.getChangeRequestById(input.changeRequestId);
    if (!cr) throw createHttpError(404, "Change request not found");
    return cr;
  },
});

// ─── Approve ──────────────────────────────────────────────────────────────────

export const approveWikiChangeRequestEndpoint = authenticatedEndpointFactory.build({
  method: "post",
  input: z.object({ changeRequestId: z.string() }),
  output: z.object({}),
  handler: async ({ input, ctx: { wikiModeration, user } }) => {
    const isMod = await wikiModeration.isModerator(user.id);
    if (!isMod) throw createHttpError(403, "Not a wiki moderator");

    try {
      await wikiModeration.approveChangeRequest(input.changeRequestId, user.id);
    } catch (e) {
      if (e instanceof Error) throw createHttpError(400, e.message);
      throw e;
    }
    return {};
  },
});

// ─── Reject ───────────────────────────────────────────────────────────────────

export const rejectWikiChangeRequestEndpoint = authenticatedEndpointFactory.build({
  method: "post",
  input: z.object({ changeRequestId: z.string() }),
  output: z.object({}),
  handler: async ({ input, ctx: { wikiModeration, user } }) => {
    const isMod = await wikiModeration.isModerator(user.id);
    if (!isMod) throw createHttpError(403, "Not a wiki moderator");

    await wikiModeration.rejectChangeRequest(input.changeRequestId);
    return {};
  },
});

// ─── Request changes ──────────────────────────────────────────────────────────

export const requestWikiChangesEndpoint = authenticatedEndpointFactory.build({
  method: "post",
  input: z.object({ changeRequestId: z.string() }),
  output: z.object({}),
  handler: async ({ input, ctx: { wikiModeration, user } }) => {
    const isMod = await wikiModeration.isModerator(user.id);
    if (!isMod) throw createHttpError(403, "Not a wiki moderator");

    await wikiModeration.requestChanges(input.changeRequestId);
    return {};
  },
});

// ─── Category management ──────────────────────────────────────────────────────

const categoryTranslationInputSchema = z.object({
  locale: wikiLocaleSchema,
  name: z.string().min(1),
});

export const createWikiCategoryEndpoint = authenticatedEndpointFactory.build({
  method: "post",
  input: z.object({
    slug: z
      .string()
      .min(1)
      .regex(/^[a-z0-9-]+$/),
    translations: z.array(categoryTranslationInputSchema).min(1),
  }),
  output: wikiCategorySchema,
  handler: async ({ input, ctx: { wikiModeration, user } }) => {
    const isMod = await wikiModeration.isModerator(user.id);
    if (!isMod) throw createHttpError(403, "Not a wiki moderator");

    return wikiModeration.createCategory(input.slug, input.translations);
  },
});

export const deleteWikiCategoryEndpoint = authenticatedEndpointFactory.build({
  method: "delete",
  input: z.object({ categoryId: z.string().uuid() }),
  output: z.object({}),
  handler: async ({ input, ctx: { wikiModeration, user } }) => {
    const isMod = await wikiModeration.isModerator(user.id);
    if (!isMod) throw createHttpError(403, "Not a wiki moderator");

    await wikiModeration.deleteCategory(input.categoryId);
    return {};
  },
});
