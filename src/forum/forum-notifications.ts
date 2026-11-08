import { captureException } from "@sentry/node";
import { and, eq } from "drizzle-orm";
import { adminDrizzle, adminOnlyDb } from "../db/db";
import { forumModerators, forumThreadSubscriptions, profiles } from "../db/schema";
import { membershipApi } from "../membership/membership";
import { ForumNotificationReason, sendForumNotificationEmail, toExcerpt } from "./forum.email";
import type { ForumReplyWithCreator, ForumThreadWithCreator } from "./forum";

const APP_URL = process.env.APP_URL ?? "https://app.coltivio.ch";

type Recipient = {
  id: string;
  email: string;
  fullName: string | null;
  locale: string;
  reason: ForumNotificationReason;
};

const recipientColumns = {
  id: profiles.id,
  email: profiles.email,
  fullName: profiles.fullName,
  locale: profiles.locale,
};

// Profiles of other users are hidden by RLS, so recipient lookup runs with the admin pool.
// Moderators always receive mail. Subscribers need a verified address and the same active membership
// that reading the Treffpunkt requires, otherwise the link leads to a page they cannot open.
async function collectRecipients(threadId: string | null, actorId: string): Promise<Recipient[]> {
  const byId = new Map<string, Recipient>();

  const moderators = await adminDrizzle
    .select(recipientColumns)
    .from(forumModerators)
    .innerJoin(profiles, eq(profiles.id, forumModerators.userId));
  for (const row of moderators) byId.set(row.id, { ...row, reason: "moderator" });

  if (threadId) {
    const subscribers = await adminDrizzle
      .select(recipientColumns)
      .from(forumThreadSubscriptions)
      .innerJoin(profiles, eq(profiles.id, forumThreadSubscriptions.userId))
      .where(
        and(
          eq(forumThreadSubscriptions.threadId, threadId),
          eq(forumThreadSubscriptions.subscribed, true),
          eq(profiles.emailVerified, true)
        )
      );
    const membership = membershipApi(adminOnlyDb);
    for (const row of subscribers) {
      if (byId.has(row.id) || row.id === actorId) continue;
      if (await membership.isActiveUser(row.id)) byId.set(row.id, { ...row, reason: "subscribed" });
    }
  }

  byId.delete(actorId);
  return [...byId.values()];
}

async function sendToAll(
  recipients: Recipient[],
  params: { kind: "new_thread" | "reply"; authorName: string | null; thread: ForumThreadWithCreator; body: string }
): Promise<void> {
  const results = await Promise.allSettled(
    recipients.map((recipient) =>
      sendForumNotificationEmail({
        email: recipient.email,
        fullName: recipient.fullName,
        locale: recipient.locale,
        kind: params.kind,
        authorName: params.authorName,
        threadTitle: params.thread.title,
        excerpt: toExcerpt(params.body),
        threadUrl: `${APP_URL}/treffpunkt/${params.thread.id}`,
        reason: recipient.reason,
      })
    )
  );
  for (const result of results) {
    if (result.status === "rejected") captureException(result.reason);
  }
}

export async function notifyNewThread(thread: ForumThreadWithCreator, actorId: string): Promise<void> {
  const recipients = await collectRecipients(null, actorId);
  await sendToAll(recipients, {
    kind: "new_thread",
    authorName: thread.creator?.fullName ?? null,
    thread,
    body: thread.body,
  });
}

export async function notifyNewReply(
  thread: ForumThreadWithCreator,
  reply: ForumReplyWithCreator,
  actorId: string
): Promise<void> {
  const recipients = await collectRecipients(thread.id, actorId);
  await sendToAll(recipients, {
    kind: "reply",
    authorName: reply.creator?.fullName ?? null,
    thread,
    body: reply.body,
  });
}
