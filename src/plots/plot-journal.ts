import { eq } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import createHttpError from "http-errors";
import { RlsDb } from "../db/db";
import { plotJournalEntries, plotJournalImages } from "../db/schema";
import { plotJournalStorage } from "../supabase/supabase";

const SIGNED_URL_EXPIRY_SECONDS = 3600;

// Shape produced by requestSignedImageUrl: "<entryUuid>/<randomUuid>.<ext>". Validating the
// whole path (rather than only its prefix) keeps traversal segments out of the storage key.
const STORAGE_PATH_PATTERN = /^[0-9a-f-]{36}\/[0-9a-f-]{36}\.[a-z0-9]{1,5}$/i;

export type PlotJournalImage = {
  id: string;
  journalEntryId: string;
  storagePath: string;
  createdAt: Date;
  signedUrl: string;
};

export type PlotJournalEntry = typeof plotJournalEntries.$inferSelect;

export type PlotJournalEntryWithImages = PlotJournalEntry & {
  images: PlotJournalImage[];
};

export type PlotJournalEntryCreateInput = {
  title: string;
  date: Date;
  content?: string;
};

export type PlotJournalEntryUpdateInput = {
  title?: string;
  date?: Date;
  content?: string;
};

async function attachSignedUrls(images: (typeof plotJournalImages.$inferSelect)[]): Promise<PlotJournalImage[]> {
  return Promise.all(
    images.map(async (image) => {
      const { data, error } = await plotJournalStorage.createSignedUrl(image.storagePath, SIGNED_URL_EXPIRY_SECONDS);
      if (error || !data) {
        throw new Error(`Failed to create signed URL: ${error?.message}`);
      }
      return { ...image, signedUrl: data.signedUrl };
    })
  );
}

export function plotJournalApi(db: RlsDb) {
  async function listEntries(plotId: string, farmId: string): Promise<PlotJournalEntry[]> {
    return db.rls(async (tx) => {
      return tx.query.plotJournalEntries.findMany({
        where: { plotId, farmId },
        orderBy: (t, { desc }) => [desc(t.date), desc(t.createdAt)],
      });
    });
  }

  async function getEntry(entryId: string): Promise<PlotJournalEntryWithImages> {
    const entry = await db.rls(async (tx) => {
      return tx.query.plotJournalEntries.findFirst({
        where: { id: entryId },
        with: { images: true },
      });
    });
    if (!entry) throw createHttpError(404, "Journal entry not found");
    return { ...entry, images: await attachSignedUrls(entry.images) };
  }

  async function createEntry(
    plotId: string,
    farmId: string,
    createdBy: string,
    input: PlotJournalEntryCreateInput
  ): Promise<PlotJournalEntry> {
    return db.rls(async (tx) => {
      const plot = await tx.query.plots.findFirst({ where: { id: plotId, farmId } });
      if (!plot) throw createHttpError(404, "Plot not found");

      const [entry] = await tx
        .insert(plotJournalEntries)
        .values({ plotId, farmId, createdBy, ...input })
        .returning();
      return entry;
    });
  }

  async function updateEntry(entryId: string, input: PlotJournalEntryUpdateInput): Promise<PlotJournalEntry> {
    return db.rls(async (tx) => {
      const [updated] = await tx
        .update(plotJournalEntries)
        .set({ ...input, updatedAt: new Date() })
        .where(eq(plotJournalEntries.id, entryId))
        .returning();
      if (!updated) throw createHttpError(404, "Journal entry not found");
      return updated;
    });
  }

  async function deleteEntry(entryId: string): Promise<void> {
    return db.rls(async (tx) => {
      const entry = await tx.query.plotJournalEntries.findFirst({
        where: { id: entryId },
        with: { images: true },
      });
      if (!entry) return;

      // Delete images first (while RLS can still resolve them via the entry join)
      if (entry.images.length > 0) {
        await tx.delete(plotJournalImages).where(eq(plotJournalImages.journalEntryId, entryId));
      }

      await tx.delete(plotJournalEntries).where(eq(plotJournalEntries.id, entryId));

      // Best-effort storage cleanup
      if (entry.images.length > 0) {
        await plotJournalStorage.remove(entry.images.map((img) => img.storagePath));
      }
    });
  }

  async function assertEntryInCurrentFarm(journalEntryId: string): Promise<void> {
    const entry = await db.rls((tx) => tx.query.plotJournalEntries.findFirst({ where: { id: journalEntryId } }));
    if (!entry) {
      throw createHttpError(404, "Journal entry not found");
    }
  }

  async function requestSignedImageUrl(
    journalEntryId: string,
    filename: string
  ): Promise<{ signedUrl: string; path: string }> {
    await assertEntryInCurrentFarm(journalEntryId);

    // The extension comes from a client-supplied filename, so normalise it here rather than
    // letting an arbitrary string into the storage key. Expo's asset.fileName is optional, so
    // a filename with no extension is a normal case and falls back to "bin".
    const rawExt = filename.split(".").pop() ?? "";
    const ext = /^[a-z0-9]{1,5}$/i.test(rawExt) ? rawExt.toLowerCase() : "bin";
    const path = `${journalEntryId}/${uuidv4()}.${ext}`;

    const { data, error } = await plotJournalStorage.createSignedUploadUrl(path);
    if (error || !data) {
      throw new Error(`Failed to create signed upload URL: ${error?.message}`);
    }
    return { signedUrl: data.signedUrl, path };
  }

  async function registerImage(journalEntryId: string, storagePath: string): Promise<PlotJournalImage> {
    await assertEntryInCurrentFarm(journalEntryId);

    // Path must be scoped to the journal entry folder and match the shape we hand out
    if (!STORAGE_PATH_PATTERN.test(storagePath) || !storagePath.startsWith(`${journalEntryId}/`)) {
      throw createHttpError(400, "Invalid storage path for this journal entry");
    }

    const [image] = await db.rls((tx) =>
      tx.insert(plotJournalImages).values({ journalEntryId, storagePath }).returning()
    );

    const { data, error } = await plotJournalStorage.createSignedUrl(image.storagePath, SIGNED_URL_EXPIRY_SECONDS);
    if (error || !data) {
      throw new Error(`Failed to create signed URL: ${error?.message}`);
    }
    return { ...image, signedUrl: data.signedUrl };
  }

  async function deleteImage(imageId: string): Promise<void> {
    return db.rls(async (tx) => {
      const image = await tx.query.plotJournalImages.findFirst({ where: { id: imageId } });
      if (!image) return;

      await tx.delete(plotJournalImages).where(eq(plotJournalImages.id, imageId));

      // Best-effort storage removal
      await plotJournalStorage.remove([image.storagePath]);
    });
  }

  return {
    listEntries,
    getEntry,
    createEntry,
    updateEntry,
    deleteEntry,
    requestSignedImageUrl,
    registerImage,
    deleteImage,
  };
}
