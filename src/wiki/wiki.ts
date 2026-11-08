import { and, eq, inArray, or } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { RlsDb } from "../db/db";
import {
  wikiCategories,
  wikiCategoryTranslations,
  wikiEntries,
  wikiEntryImages,
  wikiEntryTags,
  wikiEntryTranslations,
  wikiChangeRequests,
  wikiChangeRequestNotes,
  wikiChangeRequestTranslations,
  wikiTags,
  currentFarmId,
} from "../db/schema";
import { wikiStorage } from "../supabase/supabase";

export type WikiLocale = "de" | "en" | "it" | "fr";

export type WikiEntryTranslationInput = {
  locale: WikiLocale;
  title: string;
  body: string;
};

export type WikiEntryCreateInput = {
  id?: string; // Pre-generated UUID to associate images before entry creation
  categoryId: string;
  translations: WikiEntryTranslationInput[];
  tagIds?: string[];
};

export type WikiEntryUpdateInput = {
  categoryId?: string;
  translations?: WikiEntryTranslationInput[];
  tagIds?: string[];
};

export type WikiChangeRequestInput = {
  translations: WikiEntryTranslationInput[];
};

export type WikiCategory = typeof wikiCategories.$inferSelect;
export type WikiCategoryTranslation = typeof wikiCategoryTranslations.$inferSelect;
export type WikiCategoryWithTranslations = WikiCategory & {
  translations: WikiCategoryTranslation[];
};

export type WikiEntry = typeof wikiEntries.$inferSelect;
export type WikiEntryTranslation = typeof wikiEntryTranslations.$inferSelect;
export type WikiEntryImage = typeof wikiEntryImages.$inferSelect;
export type WikiTag = typeof wikiTags.$inferSelect;
export type WikiChangeRequest = typeof wikiChangeRequests.$inferSelect;
export type WikiChangeRequestTranslation = typeof wikiChangeRequestTranslations.$inferSelect;
export type WikiChangeRequestNote = typeof wikiChangeRequestNotes.$inferSelect;

export type WikiEntryTagWithTag = {
  id: string;
  entryId: string;
  tagId: string;
  tag: WikiTag;
};

export type WikiEntryWithRelations = WikiEntry & {
  category: WikiCategoryWithTranslations;
  translations: WikiEntryTranslation[];
  images: WikiEntryImage[];
  tags: WikiEntryTagWithTag[];
  activeChangeRequest: WikiChangeRequestWithRelations | null;
};

export type WikiChangeRequestWithRelations = WikiChangeRequest & {
  translations: WikiChangeRequestTranslation[];
};

// Shared query `with` shape for wiki entries (no changeRequests — added per-query where needed)
const entryWithRelations = {
  category: { with: { translations: true } },
  translations: true,
  images: true,
  tags: { with: { tag: true } },
} as const;

export function wikiApi(db: RlsDb) {
  return {
    // List published public entries, optionally filtered by categorySlug, tagSlug, or search
    async listPublished(params: {
      locale?: WikiLocale;
      categorySlug?: string;
      tagSlug?: string;
      search?: string;
    }): Promise<WikiEntryWithRelations[]> {
      return db.rls(async (tx) => {
        // Resolve categorySlug → categoryId
        let categoryId: string | undefined;
        if (params.categorySlug) {
          const cat = await tx.query.wikiCategories.findFirst({
            where: { slug: params.categorySlug },
          });
          if (!cat) return [];
          categoryId = cat.id;
        }

        // Resolve tagSlug → entry IDs via junction table
        let tagEntryIds: string[] | undefined;
        if (params.tagSlug) {
          const tag = await tx.query.wikiTags.findFirst({
            where: { slug: params.tagSlug },
          });
          if (!tag) return [];
          const tagLinks = await tx.query.wikiEntryTags.findMany({
            where: { tagId: tag.id },
          });
          tagEntryIds = tagLinks.map((l) => l.entryId);
          if (tagEntryIds.length === 0) return [];
        }

        // Match (published+public) OR (belongs to the current farm via session config)
        let baseWhere = or(
          and(eq(wikiEntries.status, "published"), eq(wikiEntries.visibility, "public")),
          eq(wikiEntries.farmId, currentFarmId)
        );
        if (categoryId) baseWhere = and(baseWhere, eq(wikiEntries.categoryId, categoryId));
        if (tagEntryIds) baseWhere = and(baseWhere, inArray(wikiEntries.id, tagEntryIds));

        const matchingIds = await tx.select({ id: wikiEntries.id }).from(wikiEntries).where(baseWhere);
        if (matchingIds.length === 0) return [];

        const entries = await tx.query.wikiEntries.findMany({
          where: { id: { in: matchingIds.map((r) => r.id) } },
          with: entryWithRelations,
        });

        const mapped = entries.map((e) => ({ ...e, activeChangeRequest: null }));

        // Client-side search filter on title/body (v1 — full-text via tsvector can be added later)
        if (params.search) {
          const lowerSearch = params.search.toLowerCase();
          return mapped.filter((entry) =>
            entry.translations.some(
              (t) => t.title.toLowerCase().includes(lowerSearch) || t.body.toLowerCase().includes(lowerSearch)
            )
          );
        }

        return mapped;
      });
    },

    // Get all entries belonging to a farm (all statuses, RLS enforces farm membership)
    async getFarmEntries(farmId: string): Promise<WikiEntryWithRelations[]> {
      return db.rls(async (tx) => {
        const entries = await tx.query.wikiEntries.findMany({
          where: { farmId },
          with: {
            ...entryWithRelations,
            changeRequests: {
              where: { status: { in: ["draft", "under_review", "changes_requested"] } },
              with: { translations: true },
              limit: 1,
            },
          },
          orderBy: (entry, { desc }) => [desc(entry.updatedAt)],
        });
        return entries.map((e) => ({ ...e, activeChangeRequest: e.changeRequests[0] ?? null }));
      });
    },

    // Get any entry by id (RLS ensures the requester has access)
    async getById(id: string): Promise<WikiEntryWithRelations | undefined> {
      return db.rls(async (tx) => {
        const entry = await tx.query.wikiEntries.findFirst({
          where: { id },
          with: {
            ...entryWithRelations,
            changeRequests: {
              where: { status: { in: ["draft", "under_review", "changes_requested"] } },
              with: { translations: true },
              limit: 1,
            },
          },
        });
        if (!entry) return undefined;
        return { ...entry, activeChangeRequest: entry.changeRequests[0] ?? null };
      });
    },

    // Create a new wiki entry as DRAFT with initial translations and tags
    async createEntry(createdBy: string, farmId: string, input: WikiEntryCreateInput): Promise<WikiEntryWithRelations> {
      return db.rls(async (tx) => {
        const entryId = input.id ?? uuidv4();

        await tx.insert(wikiEntries).values({
          id: entryId,
          status: "draft",
          visibility: "private",
          createdBy,
          categoryId: input.categoryId,
          farmId,
        });

        if (input.translations.length > 0) {
          await tx.insert(wikiEntryTranslations).values(
            input.translations.map((t) => ({
              entryId,
              locale: t.locale,
              title: t.title,
              body: t.body,
              updatedBy: createdBy,
            }))
          );
        }

        if (input.tagIds && input.tagIds.length > 0) {
          await tx.insert(wikiEntryTags).values(input.tagIds.map((tagId) => ({ entryId, tagId })));
        }

        const created = await tx.query.wikiEntries.findFirst({
          where: { id: entryId },
          with: entryWithRelations,
        });
        return { ...created!, activeChangeRequest: null };
      });
    },

    // Update a draft entry's category, translations (upsert per locale), and tags
    async updateEntry(
      entryId: string,
      updatedBy: string,
      input: WikiEntryUpdateInput
    ): Promise<WikiEntryWithRelations> {
      return db.rls(async (tx) => {
        if (input.categoryId) {
          await tx
            .update(wikiEntries)
            .set({ categoryId: input.categoryId, updatedAt: new Date() })
            .where(eq(wikiEntries.id, entryId));
        }

        // Upsert translations — update in-place (no version history in v1)
        if (input.translations) {
          for (const t of input.translations) {
            await tx
              .insert(wikiEntryTranslations)
              .values({
                entryId,
                locale: t.locale,
                title: t.title,
                body: t.body,
                updatedBy,
                updatedAt: new Date(),
              })
              .onConflictDoUpdate({
                target: [wikiEntryTranslations.entryId, wikiEntryTranslations.locale],
                set: {
                  title: t.title,
                  body: t.body,
                  updatedBy,
                  updatedAt: new Date(),
                },
              });
          }
        }

        // Replace tag associations if provided
        if (input.tagIds !== undefined) {
          await tx.delete(wikiEntryTags).where(eq(wikiEntryTags.entryId, entryId));

          if (input.tagIds.length > 0) {
            await tx.insert(wikiEntryTags).values(input.tagIds.map((tagId) => ({ entryId, tagId })));
          }
        }

        const updated = await tx.query.wikiEntries.findFirst({
          where: { id: entryId },
          with: entryWithRelations,
        });
        return { ...updated!, activeChangeRequest: null };
      });
    },

    // Delete a wiki entry and its image DB rows.
    // Storage files are NOT deleted here — the same file may be referenced by another entry
    // (e.g. a public entry created from this private one). The cleanup cron handles orphans.
    // Authorization (owner vs moderator) is enforced in the endpoint handler.
    async deleteEntry(entryId: string): Promise<void> {
      await db.admin.transaction(async (tx) => {
        // No FK cascade on wiki_entry_images.entry_id — delete explicitly
        await tx.delete(wikiEntryImages).where(eq(wikiEntryImages.entryId, entryId));
        await tx.delete(wikiEntries).where(eq(wikiEntries.id, entryId));
      });
    },

    // Submit a private entry for public review — snapshots content into a new_entry change request.
    // The source private entry is untouched and remains fully editable by the owner.
    async submitForReview(entryId: string, submittedBy: string): Promise<WikiChangeRequestWithRelations> {
      return db.rls(async (tx) => {
        const entry = await tx.query.wikiEntries.findFirst({
          where: { id: entryId },
          with: { translations: true },
        });

        if (!entry) throw new Error("Entry not found");
        if (entry.visibility !== "private") throw new Error("Only private entries can be submitted");
        if (entry.translations.length === 0) throw new Error("Entry must have at least one translation");

        // Prevent duplicate submissions while an active CR exists for this entry
        const existing = await tx.query.wikiChangeRequests.findFirst({
          where: { entryId, status: { in: ["draft", "under_review", "changes_requested"] } },
        });
        if (existing)
          throw new Error(
            "This entry already has an active change request. Edit the existing draft or wait for the review to complete."
          );

        const [changeRequest] = await tx
          .insert(wikiChangeRequests)
          .values({
            entryId, // back-reference to the source private entry
            type: "new_entry",
            status: "under_review",
            submittedBy,
            proposedCategoryId: entry.categoryId,
            proposedFarmId: entry.farmId,
          })
          .returning();

        // Snapshot translations from the private entry
        await tx.insert(wikiChangeRequestTranslations).values(
          entry.translations.map((t) => ({
            changeRequestId: changeRequest.id,
            locale: t.locale,
            title: t.title,
            body: t.body,
          }))
        );

        const created = await tx.query.wikiChangeRequests.findFirst({
          where: { id: changeRequest.id },
          with: { translations: true },
        });
        return created!;
      });
    },

    // Submit a change request against an existing published public entry
    async createChangeRequest(
      entryId: string,
      submittedBy: string,
      input: WikiChangeRequestInput
    ): Promise<WikiChangeRequestWithRelations> {
      return db.rls(async (tx) => {
        const [changeRequest] = await tx
          .insert(wikiChangeRequests)
          .values({
            entryId,
            type: "change_request",
            status: "under_review",
            submittedBy,
          })
          .returning();

        if (input.translations.length > 0) {
          await tx.insert(wikiChangeRequestTranslations).values(
            input.translations.map((t) => ({
              changeRequestId: changeRequest.id,
              locale: t.locale,
              title: t.title,
              body: t.body,
            }))
          );
        }

        const created = await tx.query.wikiChangeRequests.findFirst({
          where: { id: changeRequest.id },
          with: { translations: true },
        });
        return created!;
      });
    },

    // Request a signed upload URL from Supabase Storage for a wiki image.
    // If the entry already exists, the caller's farm must own it.
    // If it doesn't exist yet (pre-upload flow), the URL is issued — registerImage will
    // enforce farm ownership when the entry is created and the image is registered.
    async requestSignedImageUrl(
      entryId: string,
      farmId: string,
      filename: string
    ): Promise<{ signedUrl: string; path: string }> {
      const existingEntry = await db.admin.query.wikiEntries.findFirst({
        where: { id: entryId },
      });
      if (existingEntry && existingEntry.farmId !== farmId) {
        throw new Error("This entry does not belong to your farm");
      }

      const ext = filename.split(".").pop() ?? "bin";
      const path = `${entryId}/${uuidv4()}.${ext}`;

      const { data, error } = await wikiStorage.createSignedUploadUrl(path);
      if (error || !data) {
        throw new Error(`Failed to create signed upload URL: ${error?.message}`);
      }

      return { signedUrl: data.signedUrl, path };
    },

    // Register an image after the client has uploaded it directly to Supabase Storage.
    // Uses admin to bypass RLS because images may be registered before the entry is created
    // (pre-generated UUID flow). Auth is enforced upstream via the signed URL step.
    async registerImage(
      entryId: string,
      storagePath: string,
      uploadedBy: string,
      farmId: string
    ): Promise<{ id: string; publicUrl: string }> {
      // Ensure the storage path is scoped to this entry's folder to prevent
      // a user from registering paths that belong to other entries
      if (!storagePath.startsWith(`${entryId}/`)) {
        throw new Error("Invalid storage path for this entry");
      }

      // If the entry already exists, verify it belongs to the caller's farm
      const existingEntry = await db.admin.query.wikiEntries.findFirst({
        where: { id: entryId },
      });
      if (existingEntry && existingEntry.farmId !== farmId) {
        throw new Error("This entry does not belong to your farm");
      }

      const [image] = await db.admin.insert(wikiEntryImages).values({ entryId, storagePath, uploadedBy }).returning();

      const { data } = wikiStorage.getPublicUrl(storagePath);
      return { id: image.id, publicUrl: data.publicUrl };
    },

    // Delete an image from storage and remove the DB row (RLS enforces ownership via entry)
    async deleteImage(imageId: string): Promise<void> {
      return db.rls(async (tx) => {
        const image = await tx.query.wikiEntryImages.findFirst({
          where: { id: imageId },
        });

        if (!image) return;

        await tx.delete(wikiEntryImages).where(eq(wikiEntryImages.id, imageId));

        // Best-effort storage removal; orphan cleanup job handles stragglers
        await wikiStorage.remove([image.storagePath]);
      });
    },

    // Get or create a tag by name/slug
    async upsertTag(name: string, slug: string, createdBy: string): Promise<WikiTag> {
      return db.rls(async (tx) => {
        const existing = await tx.query.wikiTags.findFirst({
          where: { slug },
        });
        if (existing) return existing;

        const [tag] = await tx.insert(wikiTags).values({ name, slug, createdBy }).returning();
        return tag;
      });
    },

    // List all tags visible to authenticated users
    async listTags(): Promise<WikiTag[]> {
      return db.rls(async (tx) => {
        return tx.query.wikiTags.findMany({});
      });
    },

    // Get the authenticated user's own submitted change requests
    async getMyChangeRequests(submittedBy: string): Promise<WikiChangeRequestWithRelations[]> {
      return db.rls(async (tx) => {
        return tx.query.wikiChangeRequests.findMany({
          where: { submittedBy },
          with: { translations: true },
          orderBy: (cr, { desc }) => [desc(cr.createdAt)],
        });
      });
    },

    // Update a draft change request's content (translations + snapshot fields for new_entry type).
    // Only the submitter can edit their own draft.
    async updateDraftChangeRequest(
      changeRequestId: string,
      submittedBy: string,
      input: {
        translations?: WikiEntryTranslationInput[];
        proposedCategoryId?: string;
        proposedFarmId?: string | null;
      }
    ): Promise<WikiChangeRequestWithRelations> {
      return db.rls(async (tx) => {
        const cr = await tx.query.wikiChangeRequests.findFirst({
          where: { id: changeRequestId, submittedBy, status: { in: ["draft", "changes_requested"] } },
        });
        if (!cr) throw new Error("Draft change request not found");

        if (input.proposedCategoryId || input.proposedFarmId !== undefined) {
          await tx
            .update(wikiChangeRequests)
            .set({
              ...(input.proposedCategoryId ? { proposedCategoryId: input.proposedCategoryId } : {}),
              ...(input.proposedFarmId !== undefined ? { proposedFarmId: input.proposedFarmId } : {}),
            })
            .where(eq(wikiChangeRequests.id, changeRequestId));
        }

        if (input.translations) {
          for (const t of input.translations.filter((t) => t.title.trim().length > 0)) {
            await tx
              .insert(wikiChangeRequestTranslations)
              .values({ changeRequestId, locale: t.locale, title: t.title, body: t.body })
              .onConflictDoUpdate({
                target: [wikiChangeRequestTranslations.changeRequestId, wikiChangeRequestTranslations.locale],
                set: { title: t.title, body: t.body },
              });
          }
        }

        const updated = await tx.query.wikiChangeRequests.findFirst({
          where: { id: changeRequestId },
          with: { translations: true },
        });
        return updated!;
      });
    },

    // Submit a draft change request for moderator review.
    async submitDraftChangeRequest(
      changeRequestId: string,
      submittedBy: string
    ): Promise<WikiChangeRequestWithRelations> {
      return db.rls(async (tx) => {
        const cr = await tx.query.wikiChangeRequests.findFirst({
          where: { id: changeRequestId, submittedBy, status: { in: ["draft", "changes_requested"] } },
          with: { translations: true },
        });
        if (!cr) throw new Error("Draft change request not found");
        if (cr.translations.length === 0) throw new Error("At least one translation is required before submitting");

        await tx
          .update(wikiChangeRequests)
          .set({ status: "under_review" })
          .where(eq(wikiChangeRequests.id, changeRequestId));

        const updated = await tx.query.wikiChangeRequests.findFirst({
          where: { id: changeRequestId },
          with: { translations: true },
        });
        return updated!;
      });
    },

    // Fetch a change request by ID — authorization is enforced by the calling endpoint
    async getChangeRequestById(changeRequestId: string): Promise<WikiChangeRequestWithRelations | undefined> {
      return db.admin.query.wikiChangeRequests.findFirst({
        where: { id: changeRequestId },
        with: { translations: true },
      });
    },

    // Add a note to a change request (submitter or moderator, auth checked in endpoint)
    async addChangeRequestNote(
      changeRequestId: string,
      authorId: string,
      body: string
    ): Promise<WikiChangeRequestNote> {
      const [note] = await db.admin
        .insert(wikiChangeRequestNotes)
        .values({ changeRequestId, authorId, body })
        .returning();
      return note;
    },

    // Get all notes for a change request (visible to submitter via RLS)
    async getChangeRequestNotes(changeRequestId: string): Promise<WikiChangeRequestNote[]> {
      return db.admin.query.wikiChangeRequestNotes.findMany({
        where: { changeRequestId },
        orderBy: (n, { asc }) => [asc(n.createdAt)],
      });
    },

    // List all categories with their translations (public read)
    async listCategories(): Promise<WikiCategoryWithTranslations[]> {
      return db.rls(async (tx) => {
        return tx.query.wikiCategories.findMany({
          with: { translations: true },
          orderBy: (cat, { asc }) => [asc(cat.createdAt)],
        });
      });
    },
  };
}
