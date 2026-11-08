import createHttpError from "http-errors";
import { z } from "zod";
import {
  wikiEntryStatusSchema,
  wikiVisibilitySchema,
  wikiLocaleSchema,
  wikiChangeRequestStatusSchema,
  wikiChangeRequestTypeSchema,
  wikiCategorySchema,
} from "../db/schema";
import { authenticatedEndpointFactory, farmEndpointFactory } from "../endpoint-factory";
import { captureException } from "@sentry/node";
import { notifyModeratorsNewReview } from "../email/mailer";

// ─── Shared output schemas ───────────────────────────────────────────────────

export const wikiTranslationSchema = z.object({
  id: z.string(),
  entryId: z.string(),
  locale: wikiLocaleSchema,
  title: z.string(),
  body: z.string(),
  updatedBy: z.string().nullable(),
  updatedAt: z.string().or(z.date()),
});

export const wikiTagSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  createdBy: z.string().nullable(),
  createdAt: z.string().or(z.date()),
});

export const wikiEntryTagSchema = z.object({
  id: z.string(),
  entryId: z.string(),
  tagId: z.string(),
  tag: wikiTagSchema,
});

export const wikiImageSchema = z.object({
  id: z.string(),
  entryId: z.string(),
  storagePath: z.string(),
  altText: z.string().nullable(),
  uploadedBy: z.string().nullable(),
  createdAt: z.string().or(z.date()),
});

export const wikiChangeRequestSchema = z.object({
  id: z.string(),
  entryId: z.string().nullable(),
  type: wikiChangeRequestTypeSchema,
  status: wikiChangeRequestStatusSchema,
  submittedBy: z.string().nullable(),
  proposedCategoryId: z.string().nullable(),
  proposedFarmId: z.string().nullable(),
  createdAt: z.string().or(z.date()),
  resolvedAt: z.string().or(z.date()).nullable(),
  translations: z.array(
    z.object({
      id: z.string(),
      changeRequestId: z.string(),
      locale: wikiLocaleSchema,
      title: z.string(),
      body: z.string(),
    })
  ),
});

export const wikiEntrySchema = z.object({
  id: z.string(),
  status: wikiEntryStatusSchema,
  visibility: wikiVisibilitySchema,
  createdBy: z.string().nullable(),
  farmId: z.string(),
  categoryId: z.string(),
  category: wikiCategorySchema,
  createdAt: z.string().or(z.date()),
  updatedAt: z.string().or(z.date()),
  translations: z.array(wikiTranslationSchema),
  images: z.array(wikiImageSchema),
  tags: z.array(wikiEntryTagSchema),
  activeChangeRequest: wikiChangeRequestSchema.nullable(),
});

// ─── Input schemas ───────────────────────────────────────────────────────────

const translationInputSchema = z.object({
  locale: wikiLocaleSchema,
  title: z.string(),
  body: z.string(),
});

const createEntryInputSchema = z.object({
  id: z.string().optional(), // Pre-generated UUID for image upload flow
  categoryId: z.string().uuid(),
  translations: z.array(translationInputSchema).min(1),
  tagIds: z.array(z.string()).optional(),
});

const updateEntryInputSchema = z.object({
  categoryId: z.string().uuid().optional(),
  translations: z.array(translationInputSchema).optional(),
  tagIds: z.array(z.string()).optional(),
});

// ─── List published entries ──────────────────────────────────────────────────

export const listPublishedWikiEntriesEndpoint = authenticatedEndpointFactory.build({
  method: "get",
  input: z.object({
    locale: wikiLocaleSchema.optional(),
    categorySlug: z.string().optional(),
    tagSlug: z.string().optional(),
    search: z.string().optional(),
  }),
  output: z.object({
    result: z.array(wikiEntrySchema),
    count: z.number(),
  }),
  handler: async ({ input, ctx: { wiki } }) => {
    const result = await wiki.listPublished({
      locale: input.locale,
      categorySlug: input.categorySlug,
      tagSlug: input.tagSlug,
      search: input.search,
    });
    return { result, count: result.length };
  },
});

// ─── Get entry by ID (private or public, RLS-scoped) ─────────────────────────

export const getWikiEntryByIdEndpoint = authenticatedEndpointFactory.build({
  method: "get",
  input: z.object({ entryId: z.string() }),
  output: wikiEntrySchema,
  handler: async ({ input, ctx: { wiki } }) => {
    const entry = await wiki.getById(input.entryId);
    if (!entry) throw createHttpError(404, "Wiki entry not found");
    return entry;
  },
});

// ─── Get farm entries ─────────────────────────────────────────────────────────

export const getMyWikiEntriesEndpoint = farmEndpointFactory.build({
  method: "get",
  input: z.object({}),
  output: z.object({
    result: z.array(wikiEntrySchema),
    count: z.number(),
  }),
  handler: async ({ ctx: { wiki, farmId } }) => {
    const result = await wiki.getFarmEntries(farmId);
    return { result, count: result.length };
  },
});

// ─── Create wiki entry (DRAFT) ───────────────────────────────────────────────

export const createWikiEntryEndpoint = farmEndpointFactory.build({
  method: "post",
  input: createEntryInputSchema,
  output: wikiEntrySchema,
  handler: async ({ input, ctx: { wiki, user, farmId } }) => {
    return wiki.createEntry(user.id, farmId, {
      ...input,
      translations: input.translations.filter((t) => t.title.trim().length > 0),
    });
  },
});

// ─── Update wiki entry ───────────────────────────────────────────────────────

export const updateWikiEntryEndpoint = farmEndpointFactory.build({
  method: "patch",
  input: updateEntryInputSchema.extend({ entryId: z.string() }),
  output: wikiEntrySchema,
  handler: async ({ input, ctx: { wiki, user } }) => {
    const { entryId, ...data } = input;
    // RLS enforces farm membership and private-only updates
    const entry = await wiki.getById(entryId);
    if (!entry) throw createHttpError(404, "Wiki entry not found");
    if (entry.visibility !== "private") throw createHttpError(400, "Only private entries can be updated");
    return wiki.updateEntry(entryId, user.id, {
      ...data,
      translations: data.translations?.filter((t) => t.title.trim().length > 0),
    });
  },
});

// ─── Delete wiki entry ───────────────────────────────────────────────────────

export const deleteWikiEntryEndpoint = farmEndpointFactory.build({
  method: "delete",
  input: z.object({ entryId: z.string() }),
  output: z.object({}),
  handler: async ({ input, ctx: { wiki, wikiModeration, user } }) => {
    const entry = await wiki.getById(input.entryId);
    if (!entry) throw createHttpError(404, "Wiki entry not found");

    if (entry.visibility === "public") {
      // Public entries can only be deleted by moderators
      const isMod = await wikiModeration.isModerator(user.id);
      if (!isMod) throw createHttpError(403, "Only moderators can delete public entries");
    }
    // Private entries: RLS enforces farm membership — getById returns 404 if not a farm member

    await wiki.deleteEntry(input.entryId);
    return {};
  },
});

// ─── Submit entry for public review ─────────────────────────────────────────

export const submitWikiEntryEndpoint = farmEndpointFactory.build({
  method: "post",
  input: z.object({ entryId: z.string() }),
  output: wikiChangeRequestSchema,
  handler: async ({ input, ctx: { wiki, user } }) => {
    const entry = await wiki.getById(input.entryId);
    if (!entry) throw createHttpError(404, "Wiki entry not found");
    if (entry.visibility !== "private") throw createHttpError(400, "Only private entries can be submitted");
    // RLS enforces farm membership — any farm member can submit
    const cr = await wiki.submitForReview(input.entryId, user.id);
    notifyModeratorsNewReview(cr.id, cr.type).catch(captureException);
    return cr;
  },
});

// ─── Create change request on existing public entry ──────────────────────────

export const createWikiChangeRequestEndpoint = authenticatedEndpointFactory.build({
  method: "post",
  input: z.object({
    entryId: z.string(),
    translations: z.array(translationInputSchema).min(1),
  }),
  output: wikiChangeRequestSchema,
  handler: async ({ input, ctx: { wiki, user } }) => {
    const { entryId, translations } = input;
    const entry = await wiki.getById(entryId);
    if (!entry) throw createHttpError(404, "Wiki entry not found");
    if (entry.visibility !== "public")
      throw createHttpError(400, "Can only request changes on published public entries");
    const cr = await wiki.createChangeRequest(entryId, user.id, { translations });
    notifyModeratorsNewReview(cr.id, cr.type).catch(captureException);
    return cr;
  },
});

// ─── Draft change request: update ────────────────────────────────────────────

export const updateWikiChangeRequestDraftEndpoint = authenticatedEndpointFactory.build({
  method: "patch",
  input: z.object({
    changeRequestId: z.string(),
    translations: z.array(translationInputSchema).optional(),
    proposedCategoryId: z.string().uuid().optional(),
    proposedFarmId: z.string().uuid().nullable().optional(),
  }),
  output: wikiChangeRequestSchema,
  handler: async ({ input, ctx: { wiki, user } }) => {
    const { changeRequestId, ...data } = input;
    return wiki.updateDraftChangeRequest(changeRequestId, user.id, data);
  },
});

// ─── Draft change request: submit ────────────────────────────────────────────

export const submitWikiChangeRequestDraftEndpoint = authenticatedEndpointFactory.build({
  method: "post",
  input: z.object({ changeRequestId: z.string() }),
  output: wikiChangeRequestSchema,
  handler: async ({ input, ctx: { wiki, user } }) => {
    return wiki.submitDraftChangeRequest(input.changeRequestId, user.id);
  },
});

// ─── Image: request signed upload URL ────────────────────────────────────────

export const requestWikiImageSignedUrlEndpoint = farmEndpointFactory.build({
  method: "post",
  input: z.object({
    entryId: z.string(),
    filename: z.string().min(1),
  }),
  output: z.object({
    signedUrl: z.string(),
    path: z.string(),
  }),
  handler: async ({ input, ctx: { wiki, farmId } }) => {
    return wiki.requestSignedImageUrl(input.entryId, farmId, input.filename);
  },
});

// ─── Image: register after direct upload ─────────────────────────────────────

export const registerWikiImageEndpoint = farmEndpointFactory.build({
  method: "post",
  input: z.object({
    entryId: z.string(),
    storagePath: z.string().min(1),
  }),
  output: z.object({
    id: z.string(),
    publicUrl: z.string(),
  }),
  handler: async ({ input, ctx: { wiki, user, farmId } }) => {
    return wiki.registerImage(input.entryId, input.storagePath, user.id, farmId);
  },
});

// ─── Image: delete ────────────────────────────────────────────────────────────

export const deleteWikiImageEndpoint = farmEndpointFactory.build({
  method: "delete",
  input: z.object({ imageId: z.string() }),
  output: z.object({}),
  handler: async ({ input, ctx: { wiki } }) => {
    await wiki.deleteImage(input.imageId);
    return {};
  },
});

// ─── Change request notes ─────────────────────────────────────────────────────

export const wikiChangeRequestNoteSchema = z.object({
  id: z.string(),
  changeRequestId: z.string(),
  authorId: z.string().nullable(),
  body: z.string(),
  createdAt: z.string().or(z.date()),
});

export const addWikiChangeRequestNoteEndpoint = authenticatedEndpointFactory.build({
  method: "post",
  input: z.object({
    changeRequestId: z.string(),
    body: z.string().min(1),
  }),
  output: wikiChangeRequestNoteSchema,
  handler: async ({ input, ctx: { wiki, wikiModeration, user } }) => {
    const cr = await wiki.getChangeRequestById(input.changeRequestId);
    if (!cr) throw createHttpError(404, "Change request not found");

    if (cr.status === "approved" || cr.status === "rejected")
      throw createHttpError(400, "Cannot add notes to a resolved change request");

    // Only the submitter or a moderator may add notes
    const isMod = await wikiModeration.isModerator(user.id);
    if (cr.submittedBy !== user.id && !isMod)
      throw createHttpError(403, "Not authorized to add notes to this change request");

    return wiki.addChangeRequestNote(input.changeRequestId, user.id, input.body);
  },
});

export const getWikiChangeRequestNotesEndpoint = authenticatedEndpointFactory.build({
  method: "get",
  input: z.object({ changeRequestId: z.string() }),
  output: z.object({
    result: z.array(wikiChangeRequestNoteSchema),
    count: z.number(),
  }),
  handler: async ({ input, ctx: { wiki, wikiModeration, user } }) => {
    const cr = await wiki.getChangeRequestById(input.changeRequestId);
    if (!cr) throw createHttpError(404, "Change request not found");
    const isMod = await wikiModeration.isModerator(user.id);
    if (cr.submittedBy !== user.id && !isMod)
      throw createHttpError(403, "Not authorized to view notes on this change request");
    const result = await wiki.getChangeRequestNotes(input.changeRequestId);
    return { result, count: result.length };
  },
});

// ─── Tags ─────────────────────────────────────────────────────────────────────

export const listWikiTagsEndpoint = authenticatedEndpointFactory.build({
  method: "get",
  input: z.object({}),
  output: z.object({
    result: z.array(wikiTagSchema),
    count: z.number(),
  }),
  handler: async ({ ctx: { wiki } }) => {
    const result = await wiki.listTags();
    return { result, count: result.length };
  },
});

export const upsertWikiTagEndpoint = authenticatedEndpointFactory.build({
  method: "post",
  input: z.object({
    name: z.string().min(1),
    slug: z
      .string()
      .min(1)
      .regex(/^[a-z0-9-]+$/),
  }),
  output: wikiTagSchema,
  handler: async ({ input, ctx: { wiki, user } }) => {
    return wiki.upsertTag(input.name, input.slug, user.id);
  },
});

// ─── My change requests ───────────────────────────────────────────────────────

export const getMyWikiChangeRequestsEndpoint = authenticatedEndpointFactory.build({
  method: "get",
  input: z.object({}),
  output: z.object({
    result: z.array(wikiChangeRequestSchema),
    count: z.number(),
  }),
  handler: async ({ ctx: { wiki, user } }) => {
    const result = await wiki.getMyChangeRequests(user.id);
    return { result, count: result.length };
  },
});

// ─── Categories (public read) ─────────────────────────────────────────────────

export const listWikiCategoriesEndpoint = authenticatedEndpointFactory.build({
  method: "get",
  input: z.object({}),
  output: z.object({
    result: z.array(wikiCategorySchema),
    count: z.number(),
  }),
  handler: async ({ ctx: { wiki } }) => {
    const result = await wiki.listCategories();
    return { result, count: result.length };
  },
});
