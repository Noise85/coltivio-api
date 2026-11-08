import { eq } from "drizzle-orm";
import { RlsDb } from "../db/db";
import { forumReplies, forumThreads } from "../db/schema";

export function forumModerationApi(db: RlsDb) {
  return {
    async isModerator(userId: string): Promise<boolean> {
      const row = await db.admin.query.forumModerators.findFirst({
        where: { userId },
      });
      return row !== undefined;
    },

    async getModeratorUserIds(): Promise<Set<string>> {
      const rows = await db.admin.query.forumModerators.findMany({});
      return new Set(rows.map((r) => r.userId));
    },

    async setThreadStatus(threadId: string, status: "open" | "closed"): Promise<void> {
      await db.admin.update(forumThreads).set({ status, updatedAt: new Date() }).where(eq(forumThreads.id, threadId));
    },

    async pinThread(threadId: string, pinned: boolean): Promise<void> {
      await db.admin
        .update(forumThreads)
        .set({ isPinned: pinned, updatedAt: new Date() })
        .where(eq(forumThreads.id, threadId));
    },

    async deleteThread(threadId: string): Promise<void> {
      await db.admin.delete(forumThreads).where(eq(forumThreads.id, threadId));
    },

    async deleteReply(replyId: string): Promise<void> {
      await db.admin.delete(forumReplies).where(eq(forumReplies.id, replyId));
    },
  };
}
