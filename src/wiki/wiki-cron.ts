import cron from "node-cron";
import { and, eq, isNull, ne } from "drizzle-orm";
import { captureException } from "@sentry/node";
import { adminDrizzle } from "../db/db";
import { wikiEntries, wikiEntryImages } from "../db/schema";
import { wikiStorage } from "../supabase/supabase";

async function cleanupOrphanedWikiImages(): Promise<void> {
  // Find image rows whose entryId has no matching wiki_entries row
  const orphans = await adminDrizzle
    .select({
      id: wikiEntryImages.id,
      storagePath: wikiEntryImages.storagePath,
      entryId: wikiEntryImages.entryId,
    })
    .from(wikiEntryImages)
    .leftJoin(wikiEntries, eq(wikiEntryImages.entryId, wikiEntries.id))
    .where(isNull(wikiEntries.id));

  for (const orphan of orphans) {
    // Check if another image row shares the same storage path (e.g. approval copy)
    const siblings = await adminDrizzle
      .select({ id: wikiEntryImages.id })
      .from(wikiEntryImages)
      .where(and(eq(wikiEntryImages.storagePath, orphan.storagePath), ne(wikiEntryImages.id, orphan.id)));

    if (siblings.length === 0) {
      // No other row references this path — safe to delete from storage
      const { error } = await wikiStorage.remove([orphan.storagePath]);
      if (error) {
        // Keep the DB row so the next cron run can retry the storage deletion
        console.error(`[wiki-cron] Failed to delete storage file ${orphan.storagePath}:`, error.message);
        continue;
      }
    }

    await adminDrizzle.delete(wikiEntryImages).where(eq(wikiEntryImages.id, orphan.id));
  }

  if (orphans.length > 0) {
    console.log(`[wiki-cron] Cleaned up ${orphans.length} orphaned image(s)`);
  }
}

export function startWikiImageCleanupCron(): void {
  cron.schedule("0 0 * * *", async () => {
    try {
      await cleanupOrphanedWikiImages();
    } catch (err) {
      captureException(err);
      console.error("[wiki-cron] Orphaned image cleanup failed:", err);
    }
  });
}
