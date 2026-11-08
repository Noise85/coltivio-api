import { eq } from "drizzle-orm";
import { RlsDb } from "../db/db";
import {
  wikiCategories,
  wikiCategoryTranslations,
  wikiChangeRequests,
  wikiEntries,
  wikiEntryImages,
  wikiEntryTags,
  wikiEntryTranslations,
  wikiModerators,
} from "../db/schema";
import {
  WikiCategoryWithTranslations,
  WikiChangeRequestWithRelations,
  WikiEntryWithRelations,
  WikiLocale,
} from "./wiki";

// Extended type returned by review queue.
// For change_request: entry is the public entry being modified (for diff view).
// For new_entry: entry is the source private entry (optional context), may be null if deleted.
export type WikiModerationChangeRequest = WikiChangeRequestWithRelations & {
  entry: WikiEntryWithRelations | null;
};

// Shared `with` shape for review queue queries
const reviewQueueWith = {
  translations: true,
  entry: {
    with: {
      category: { with: { translations: true } },
      translations: true,
      images: true,
      tags: { with: { tag: true } },
    },
  },
} as const;

export function wikiModerationApi(db: RlsDb) {
  return {
    // Check whether a given user is registered as a wiki moderator
    async isModerator(userId: string): Promise<boolean> {
      const row = await db.admin.query.wikiModerators.findFirst({
        where: { userId },
      });
      return row !== undefined;
    },

    // Return the set of all moderator user IDs — use this for batch checks to avoid N+1 queries
    async getModeratorUserIds(): Promise<Set<string>> {
      const rows = await db.admin.query.wikiModerators.findMany({});
      return new Set(rows.map((r) => r.userId));
    },

    async promoteModerator(userId: string): Promise<void> {
      await db.admin.insert(wikiModerators).values({ userId }).onConflictDoNothing();
    },

    async demoteModerator(userId: string): Promise<void> {
      await db.admin.delete(wikiModerators).where(eq(wikiModerators.userId, userId));
    },

    async createCategory(
      slug: string,
      translations: { locale: WikiLocale; name: string }[]
    ): Promise<WikiCategoryWithTranslations> {
      const [category] = await db.admin.insert(wikiCategories).values({ slug }).returning();

      await db.admin.insert(wikiCategoryTranslations).values(
        translations.map((t) => ({
          categoryId: category.id,
          locale: t.locale,
          name: t.name,
        }))
      );

      return db.admin.query.wikiCategories.findFirst({
        where: { id: category.id },
        with: { translations: true },
      }) as Promise<WikiCategoryWithTranslations>;
    },

    async deleteCategory(categoryId: string): Promise<void> {
      await db.admin.delete(wikiCategories).where(eq(wikiCategories.id, categoryId));
    },

    // List all pending change requests with full entry context for review
    async getReviewQueue(): Promise<WikiModerationChangeRequest[]> {
      const results = await db.admin.query.wikiChangeRequests.findMany({
        where: { status: "under_review" },
        with: reviewQueueWith,
        orderBy: (cr, { asc }) => [asc(cr.createdAt)],
      });
      return results.map((cr) => ({
        ...cr,
        entry: cr.entry ? { ...cr.entry, activeChangeRequest: null } : null,
      }));
    },

    // Approve a change request:
    // - new_entry: create a new public entry from the snapshotted content; source private entry untouched
    // - change_request: merge proposed translations into the existing public entry
    async approveChangeRequest(changeRequestId: string, reviewedBy: string): Promise<void> {
      const changeRequest = await db.admin.query.wikiChangeRequests.findFirst({
        where: { id: changeRequestId, status: "under_review" },
        with: { translations: true },
      });

      if (!changeRequest) {
        throw new Error("Change request not found or already resolved");
      }

      await db.admin.transaction(async (tx) => {
        if (changeRequest.type === "new_entry") {
          if (!changeRequest.proposedCategoryId || !changeRequest.proposedFarmId) {
            throw new Error("Change request is missing required snapshot fields");
          }

          // Create the new public entry from the snapshot
          const [newEntry] = await tx
            .insert(wikiEntries)
            .values({
              status: "published",
              visibility: "public",
              createdBy: changeRequest.submittedBy,
              categoryId: changeRequest.proposedCategoryId,
              farmId: changeRequest.proposedFarmId,
              updatedAt: new Date(),
            })
            .returning();

          // Insert snapshotted translations
          if (changeRequest.translations.length > 0) {
            await tx.insert(wikiEntryTranslations).values(
              changeRequest.translations.map((t) => ({
                entryId: newEntry.id,
                locale: t.locale,
                title: t.title,
                body: t.body,
                updatedBy: reviewedBy,
                updatedAt: new Date(),
              }))
            );
          }

          // Copy images and tags from the source private entry if it still exists.
          // Images are copied (not moved) so the private entry keeps its own rows and
          // remains intact. Storage files are shared by path; the cleanup cron handles
          // orphaned files — we never delete from storage on private entry deletion.
          if (changeRequest.entryId) {
            const sourceImages = await tx.query.wikiEntryImages.findMany({
              where: { entryId: changeRequest.entryId },
            });
            if (sourceImages.length > 0) {
              await tx.insert(wikiEntryImages).values(
                sourceImages.map((img) => ({
                  entryId: newEntry.id,
                  storagePath: img.storagePath,
                  altText: img.altText,
                  uploadedBy: img.uploadedBy,
                }))
              );
            }

            const sourceTags = await tx.query.wikiEntryTags.findMany({
              where: { entryId: changeRequest.entryId },
            });
            if (sourceTags.length > 0) {
              await tx.insert(wikiEntryTags).values(sourceTags.map((t) => ({ entryId: newEntry.id, tagId: t.tagId })));
            }
          }
        } else {
          // Merge proposed translations into the canonical public entry
          if (!changeRequest.entryId) {
            throw new Error("change_request type must reference a public entry");
          }
          for (const proposed of changeRequest.translations) {
            await tx
              .insert(wikiEntryTranslations)
              .values({
                entryId: changeRequest.entryId,
                locale: proposed.locale,
                title: proposed.title,
                body: proposed.body,
                updatedBy: reviewedBy,
                updatedAt: new Date(),
              })
              .onConflictDoUpdate({
                target: [wikiEntryTranslations.entryId, wikiEntryTranslations.locale],
                set: {
                  title: proposed.title,
                  body: proposed.body,
                  updatedBy: reviewedBy,
                  updatedAt: new Date(),
                },
              });
          }
          await tx.update(wikiEntries).set({ updatedAt: new Date() }).where(eq(wikiEntries.id, changeRequest.entryId));
        }

        await tx
          .update(wikiChangeRequests)
          .set({ status: "approved", resolvedAt: new Date() })
          .where(eq(wikiChangeRequests.id, changeRequestId));
      });
    },

    // Reject a change request. The source private entry is unaffected — user can revise and resubmit.
    async rejectChangeRequest(changeRequestId: string): Promise<void> {
      const changeRequest = await db.admin.query.wikiChangeRequests.findFirst({
        where: { id: changeRequestId, status: "under_review" },
      });

      if (!changeRequest) {
        throw new Error("Change request not found or already resolved");
      }

      await db.admin.transaction(async (tx) => {
        await tx
          .update(wikiChangeRequests)
          .set({ status: "rejected", resolvedAt: new Date() })
          .where(eq(wikiChangeRequests.id, changeRequestId));
      });
    },

    // Move a CR back to draft so the submitter can revise and resubmit.
    // Same CR is reused throughout the revision cycle — notes carry the communication.
    async requestChanges(changeRequestId: string): Promise<void> {
      const changeRequest = await db.admin.query.wikiChangeRequests.findFirst({
        where: { id: changeRequestId, status: "under_review" },
      });

      if (!changeRequest) {
        throw new Error("Change request not found or not under review");
      }

      await db.admin.transaction(async (tx) => {
        await tx
          .update(wikiChangeRequests)
          .set({ status: "changes_requested" })
          .where(eq(wikiChangeRequests.id, changeRequestId));
      });
    },

    // Get a single change request with full entry context for the moderation UI
    async getChangeRequestById(id: string): Promise<WikiModerationChangeRequest | undefined> {
      const result = await db.admin.query.wikiChangeRequests.findFirst({
        where: { id },
        with: reviewQueueWith,
      });
      if (!result) return undefined;
      return { ...result, entry: result.entry ? { ...result.entry, activeChangeRequest: null } : null };
    },
  };
}
