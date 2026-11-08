import { and, asc, desc, eq, ilike, or, sql } from "drizzle-orm";
import { RlsDb } from "../db/db";
import { forumReplies, forumThreads, forumThreadSubscriptions, profileNamesView } from "../db/schema";

export type ForumThreadType = "question" | "feature_request" | "bug_report" | "general";
export type ForumThreadStatus = "open" | "closed";

export type ForumThread = typeof forumThreads.$inferSelect;
export type ForumReply = typeof forumReplies.$inferSelect;

type ProfileSnippet = { id: string; fullName: string | null };

// creator is null once the author deleted their account, the post itself stays
export type ForumThreadWithCreator = ForumThread & {
  creator: ProfileSnippet | null;
  replyCount?: number;
  isSubscribed?: boolean;
};
export type ForumReplyWithCreator = ForumReply & { creator: ProfileSnippet | null };

// SQL expression for last activity: most recent reply createdAt, falling back to thread createdAt
const lastActivityAt = sql<Date>`COALESCE(MAX(${forumReplies.createdAt}), ${forumThreads.createdAt})`;

export function forumApi(db: RlsDb) {
  return {
    async listThreads(params: {
      type?: ForumThreadType;
      status?: ForumThreadStatus;
      search?: string;
      limit?: number;
      offset?: number;
    }): Promise<{ threads: ForumThreadWithCreator[]; total: number }> {
      return db.rls(async (tx) => {
        const conditions = [
          ...(params.type ? [eq(forumThreads.type, params.type)] : []),
          ...(params.status ? [eq(forumThreads.status, params.status)] : []),
          ...(params.search
            ? [or(ilike(forumThreads.title, `%${params.search}%`), ilike(forumThreads.body, `%${params.search}%`))]
            : []),
        ];
        const whereClause = conditions.length > 0 ? and(...conditions) : undefined;
        const limit = params.limit ?? 20;
        const offset = params.offset ?? 0;

        // profile_names is a security-definer view (owner=postgres) that exposes only
        // id + full_name, bypassing profiles RLS so we can show author names across farms
        const [rows, [{ total }]] = await Promise.all([
          tx
            .select({
              thread: forumThreads,
              creatorId: profileNamesView.id,
              creatorFullName: profileNamesView.fullName,
              lastActivityAt,
              replyCount: sql<number>`COUNT(${forumReplies.id})::int`,
            })
            .from(forumThreads)
            .leftJoin(profileNamesView, eq(profileNamesView.id, forumThreads.createdBy))
            .leftJoin(forumReplies, eq(forumReplies.threadId, forumThreads.id))
            .where(whereClause)
            .groupBy(forumThreads.id, profileNamesView.id, profileNamesView.fullName)
            .orderBy(desc(forumThreads.isPinned), desc(lastActivityAt))
            .limit(limit)
            .offset(offset),
          tx
            .select({ total: sql<number>`COUNT(DISTINCT ${forumThreads.id})::int` })
            .from(forumThreads)
            .where(whereClause),
        ]);

        const threads = rows.map((row) => ({
          ...row.thread,
          creator: row.creatorId ? { id: row.creatorId, fullName: row.creatorFullName } : null,
          replyCount: row.replyCount,
        }));

        return { threads, total };
      });
    },

    async getThreadById(id: string, userId?: string): Promise<ForumThreadWithCreator | undefined> {
      return db.rls(async (tx) => {
        const [row] = await tx
          .select({
            thread: forumThreads,
            creatorId: profileNamesView.id,
            creatorFullName: profileNamesView.fullName,
            subscribed: forumThreadSubscriptions.subscribed,
          })
          .from(forumThreads)
          .leftJoin(profileNamesView, eq(profileNamesView.id, forumThreads.createdBy))
          .leftJoin(
            forumThreadSubscriptions,
            userId
              ? and(eq(forumThreadSubscriptions.threadId, forumThreads.id), eq(forumThreadSubscriptions.userId, userId))
              : sql`false`
          )
          .where(eq(forumThreads.id, id))
          .limit(1);

        if (!row) return undefined;
        return {
          ...row.thread,
          creator: row.creatorId ? { id: row.creatorId, fullName: row.creatorFullName } : null,
          ...(userId ? { isSubscribed: row.subscribed ?? false } : {}),
        };
      });
    },

    async setSubscription(threadId: string, userId: string, subscribed: boolean): Promise<void> {
      await db.rls(async (tx) => {
        await tx
          .insert(forumThreadSubscriptions)
          .values({ threadId, userId, subscribed })
          .onConflictDoUpdate({
            target: [forumThreadSubscriptions.threadId, forumThreadSubscriptions.userId],
            set: { subscribed, updatedAt: new Date() },
          });
      });
    },

    async createThread(
      createdBy: string,
      input: { title: string; body: string; type: ForumThreadType }
    ): Promise<ForumThreadWithCreator> {
      return db.rls(async (tx) => {
        const [thread] = await tx
          .insert(forumThreads)
          .values({ title: input.title, body: input.body, type: input.type, createdBy })
          .returning();

        await tx.insert(forumThreadSubscriptions).values({ threadId: thread.id, userId: createdBy, subscribed: true });

        const [row] = await tx
          .select({
            thread: forumThreads,
            creatorId: profileNamesView.id,
            creatorFullName: profileNamesView.fullName,
          })
          .from(forumThreads)
          .leftJoin(profileNamesView, eq(profileNamesView.id, forumThreads.createdBy))
          .where(eq(forumThreads.id, thread.id))
          .limit(1);

        return { ...row.thread, creator: row.creatorId ? { id: row.creatorId, fullName: row.creatorFullName } : null };
      });
    },

    async updateThread(
      threadId: string,
      updatedBy: string,
      input: { title?: string; body?: string }
    ): Promise<ForumThreadWithCreator> {
      return db.rls(async (tx) => {
        const [existing] = await tx
          .select({ createdBy: forumThreads.createdBy })
          .from(forumThreads)
          .where(eq(forumThreads.id, threadId))
          .limit(1);

        if (!existing) throw new Error("Thread not found");
        if (existing.createdBy !== updatedBy) throw new Error("You can only edit your own threads");

        await tx
          .update(forumThreads)
          .set({
            ...(input.title !== undefined ? { title: input.title } : {}),
            ...(input.body !== undefined ? { body: input.body } : {}),
            updatedAt: new Date(),
          })
          .where(eq(forumThreads.id, threadId));

        const [row] = await tx
          .select({
            thread: forumThreads,
            creatorId: profileNamesView.id,
            creatorFullName: profileNamesView.fullName,
          })
          .from(forumThreads)
          .leftJoin(profileNamesView, eq(profileNamesView.id, forumThreads.createdBy))
          .where(eq(forumThreads.id, threadId))
          .limit(1);

        return { ...row.thread, creator: row.creatorId ? { id: row.creatorId, fullName: row.creatorFullName } : null };
      });
    },

    async deleteThread(threadId: string): Promise<void> {
      await db.rls(async (tx) => {
        await tx.delete(forumThreads).where(eq(forumThreads.id, threadId));
      });
    },

    async listReplies(threadId: string): Promise<ForumReplyWithCreator[]> {
      return db.rls(async (tx) => {
        const rows = await tx
          .select({
            reply: forumReplies,
            creatorId: profileNamesView.id,
            creatorFullName: profileNamesView.fullName,
          })
          .from(forumReplies)
          .leftJoin(profileNamesView, eq(profileNamesView.id, forumReplies.createdBy))
          .where(eq(forumReplies.threadId, threadId))
          .orderBy(asc(forumReplies.createdAt));

        return rows.map((row) => ({
          ...row.reply,
          creator: row.creatorId ? { id: row.creatorId, fullName: row.creatorFullName } : null,
        }));
      });
    },

    async addReply(threadId: string, createdBy: string, body: string): Promise<ForumReplyWithCreator> {
      return db.rls(async (tx) => {
        const [reply] = await tx.insert(forumReplies).values({ threadId, body, createdBy }).returning();

        await tx
          .insert(forumThreadSubscriptions)
          .values({ threadId, userId: createdBy, subscribed: true })
          .onConflictDoNothing();

        const [row] = await tx
          .select({
            reply: forumReplies,
            creatorId: profileNamesView.id,
            creatorFullName: profileNamesView.fullName,
          })
          .from(forumReplies)
          .leftJoin(profileNamesView, eq(profileNamesView.id, forumReplies.createdBy))
          .where(eq(forumReplies.id, reply.id))
          .limit(1);

        return { ...row.reply, creator: row.creatorId ? { id: row.creatorId, fullName: row.creatorFullName } : null };
      });
    },

    async updateReply(replyId: string, updatedBy: string, body: string): Promise<ForumReplyWithCreator> {
      return db.rls(async (tx) => {
        const [existing] = await tx
          .select({ createdBy: forumReplies.createdBy })
          .from(forumReplies)
          .where(eq(forumReplies.id, replyId))
          .limit(1);

        if (!existing) throw new Error("Reply not found");
        if (existing.createdBy !== updatedBy) throw new Error("You can only edit your own replies");

        await tx.update(forumReplies).set({ body, updatedAt: new Date() }).where(eq(forumReplies.id, replyId));

        const [row] = await tx
          .select({
            reply: forumReplies,
            creatorId: profileNamesView.id,
            creatorFullName: profileNamesView.fullName,
          })
          .from(forumReplies)
          .leftJoin(profileNamesView, eq(profileNamesView.id, forumReplies.createdBy))
          .where(eq(forumReplies.id, replyId))
          .limit(1);

        return { ...row.reply, creator: row.creatorId ? { id: row.creatorId, fullName: row.creatorFullName } : null };
      });
    },

    async getReplyById(replyId: string): Promise<ForumReplyWithCreator | undefined> {
      return db.rls(async (tx) => {
        const [row] = await tx
          .select({
            reply: forumReplies,
            creatorId: profileNamesView.id,
            creatorFullName: profileNamesView.fullName,
          })
          .from(forumReplies)
          .leftJoin(profileNamesView, eq(profileNamesView.id, forumReplies.createdBy))
          .where(eq(forumReplies.id, replyId))
          .limit(1);

        if (!row) return undefined;
        return { ...row.reply, creator: row.creatorId ? { id: row.creatorId, fullName: row.creatorFullName } : null };
      });
    },

    async deleteReply(replyId: string): Promise<void> {
      await db.rls(async (tx) => {
        await tx.delete(forumReplies).where(eq(forumReplies.id, replyId));
      });
    },
  };
}
