import { eq } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import createHttpError from "http-errors";
import { RlsDb } from "../db/db";
import { animalJournalEntries, animalJournalImages } from "../db/schema";
import { animalJournalStorage } from "../supabase/supabase";

// Signed download URL expiry in seconds (1 hour)
const SIGNED_URL_EXPIRY_SECONDS = 3600;

// Shape produced by requestSignedImageUrl: "<entryUuid>/<randomUuid>.<ext>". Validating the
// whole path (rather than only its prefix) keeps traversal segments out of the storage key.
const STORAGE_PATH_PATTERN = /^[0-9a-f-]{36}\/[0-9a-f-]{36}\.[a-z0-9]{1,5}$/i;

export type AnimalJournalImage = {
  id: string;
  journalEntryId: string;
  storagePath: string;
  createdAt: Date;
  signedUrl: string;
};

export type AnimalJournalEntry = typeof animalJournalEntries.$inferSelect;

export type AnimalJournalEntryWithImages = AnimalJournalEntry & {
  images: AnimalJournalImage[];
};

export type AnimalJournalEntryCreateInput = {
  title: string;
  date: Date;
  content?: string;
};

export type AnimalJournalEntryUpdateInput = {
  title?: string;
  date?: Date;
  content?: string;
};

async function attachSignedUrls(images: (typeof animalJournalImages.$inferSelect)[]): Promise<AnimalJournalImage[]> {
  return Promise.all(
    images.map(async (image) => {
      const { data, error } = await animalJournalStorage.createSignedUrl(image.storagePath, SIGNED_URL_EXPIRY_SECONDS);
      if (error || !data) {
        throw new Error(`Failed to create signed URL: ${error?.message}`);
      }
      return { ...image, signedUrl: data.signedUrl };
    })
  );
}

export function animalJournalApi(db: RlsDb) {
  async function listEntries(animalId: string, farmId: string): Promise<AnimalJournalEntry[]> {
    return db.rls(async (tx) => {
      return tx.query.animalJournalEntries.findMany({
        where: { animalId, farmId },
        orderBy: (t, { desc }) => [desc(t.date), desc(t.createdAt)],
      });
    });
  }

  async function getEntry(entryId: string): Promise<AnimalJournalEntryWithImages> {
    const entry = await db.rls(async (tx) => {
      return tx.query.animalJournalEntries.findFirst({
        where: { id: entryId },
        with: { images: true },
      });
    });
    if (!entry) throw createHttpError(404, "Journal entry not found");
    return { ...entry, images: await attachSignedUrls(entry.images) };
  }

  async function createEntry(
    animalId: string,
    farmId: string,
    createdBy: string,
    input: AnimalJournalEntryCreateInput
  ): Promise<AnimalJournalEntry> {
    return db.rls(async (tx) => {
      // Verify animal belongs to this farm (RLS will also enforce, but gives a better error)
      const animal = await tx.query.animals.findFirst({ where: { id: animalId, farmId } });
      if (!animal) throw createHttpError(404, "Animal not found");

      const [entry] = await tx
        .insert(animalJournalEntries)
        .values({ animalId, farmId, createdBy, ...input })
        .returning();
      return entry;
    });
  }

  async function updateEntry(entryId: string, input: AnimalJournalEntryUpdateInput): Promise<AnimalJournalEntry> {
    return db.rls(async (tx) => {
      const [updated] = await tx
        .update(animalJournalEntries)
        .set({ ...input, updatedAt: new Date() })
        .where(eq(animalJournalEntries.id, entryId))
        .returning();
      if (!updated) throw createHttpError(404, "Journal entry not found");
      return updated;
    });
  }

  async function deleteEntry(entryId: string): Promise<void> {
    return db.rls(async (tx) => {
      const entry = await tx.query.animalJournalEntries.findFirst({
        where: { id: entryId },
        with: { images: true },
      });
      if (!entry) return;

      // Delete images first (while RLS can still resolve them via the entry FK join)
      if (entry.images.length > 0) {
        await tx.delete(animalJournalImages).where(eq(animalJournalImages.journalEntryId, entryId));
      }

      await tx.delete(animalJournalEntries).where(eq(animalJournalEntries.id, entryId));

      // Best-effort storage cleanup
      if (entry.images.length > 0) {
        await animalJournalStorage.remove(entry.images.map((img) => img.storagePath));
      }
    });
  }

  async function assertEntryInCurrentFarm(journalEntryId: string): Promise<void> {
    const entry = await db.rls((tx) => tx.query.animalJournalEntries.findFirst({ where: { id: journalEntryId } }));
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

    const { data, error } = await animalJournalStorage.createSignedUploadUrl(path);
    if (error || !data) {
      throw new Error(`Failed to create signed upload URL: ${error?.message}`);
    }
    return { signedUrl: data.signedUrl, path };
  }

  async function registerImage(journalEntryId: string, storagePath: string): Promise<AnimalJournalImage> {
    await assertEntryInCurrentFarm(journalEntryId);

    // Path must be scoped to the journal entry folder and match the shape we hand out
    if (!STORAGE_PATH_PATTERN.test(storagePath) || !storagePath.startsWith(`${journalEntryId}/`)) {
      throw createHttpError(400, "Invalid storage path for this journal entry");
    }

    const [image] = await db.rls((tx) =>
      tx.insert(animalJournalImages).values({ journalEntryId, storagePath }).returning()
    );

    const { data, error } = await animalJournalStorage.createSignedUrl(image.storagePath, SIGNED_URL_EXPIRY_SECONDS);
    if (error || !data) {
      throw new Error(`Failed to create signed URL: ${error?.message}`);
    }
    return { ...image, signedUrl: data.signedUrl };
  }

  async function deleteImage(imageId: string): Promise<void> {
    return db.rls(async (tx) => {
      const image = await tx.query.animalJournalImages.findFirst({ where: { id: imageId } });
      if (!image) return;

      await tx.delete(animalJournalImages).where(eq(animalJournalImages.id, imageId));

      // Best-effort storage removal
      await animalJournalStorage.remove([image.storagePath]);
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
