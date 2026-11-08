import { describe, it, expect, beforeAll, beforeEach, afterEach, jest } from "@jest/globals";
import i18next from "i18next";
import { eq } from "drizzle-orm";
import de from "../../resources/locales/de.json";
import en from "../../resources/locales/en.json";
import itLocale from "../../resources/locales/it.json";
import fr from "../../resources/locales/fr.json";
import * as brevo from "../brevo/brevo";
import { forumModerators, membershipPayments, profiles } from "../db/schema";
import type { ForumReplyWithCreator, ForumThreadWithCreator } from "../forum/forum";
import { notifyNewReply, notifyNewThread } from "../forum/forum-notifications";
import { cleanDb, createTestUser, getAdminDb, request } from "./helpers";
import { createUserWithPaidMembership } from "./test-utils";

// Email helpers call getFixedT(locale), so i18next must be initialised in the worker
beforeAll(async () => {
  if (!i18next.isInitialized) {
    await i18next.init({
      resources: {
        de: { translation: de },
        en: { translation: en },
        it: { translation: itLocale },
        fr: { translation: fr },
      },
      fallbackLng: "de",
      preload: ["de", "en", "it", "fr"],
    });
  }
});

// The HTTP server runs in Jest's main process, these tests in a worker, so a spy installed here
// never sees a mail sent by an endpoint. Posts go through HTTP so the real endpoints write the
// subscription rows; the notification step is then run in this process against the same database.
let emailSpy: jest.SpiedFunction<typeof brevo.txEmailApi.sendTransacEmail>;

beforeEach(async () => {
  await cleanDb();
  emailSpy = jest.spyOn(brevo.txEmailApi, "sendTransacEmail").mockImplementation(() => Promise.resolve());
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type TestUser = { jwt: string; userId: string };

async function postThread(author: TestUser, title = "Hello World"): Promise<ForumThreadWithCreator> {
  const res = await request("POST", "/v1/forum/threads", { title, body: "My first post", type: "general" }, author.jwt);
  expect(res.status).toBe(200);
  const thread = ((await res.json()) as { data: ForumThreadWithCreator }).data;
  await notifyNewThread(thread, author.userId);
  return thread;
}

async function postReply(replier: TestUser, thread: ForumThreadWithCreator, text = "A reply"): Promise<void> {
  const res = await request("POST", `/v1/forum/threads/byId/${thread.id}/replies`, { body: text }, replier.jwt);
  expect(res.status).toBe(200);
  const reply = ((await res.json()) as { data: ForumReplyWithCreator }).data;
  await notifyNewReply(thread, reply, replier.userId);
}

async function getThread(user: TestUser, threadId: string) {
  const res = await request("GET", `/v1/forum/threads/byId/${threadId}`, undefined, user.jwt);
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: { isSubscribed?: boolean } }).data;
}

async function setSubscription(user: TestUser, threadId: string, subscribed: boolean) {
  return request("PUT", `/v1/forum/threads/byId/${threadId}/subscription`, { subscribed }, user.jwt);
}

async function makeModerator(userId: string) {
  await getAdminDb().insert(forumModerators).values({ userId });
}

async function setLocale(userId: string, locale: string) {
  await getAdminDb().update(profiles).set({ locale }).where(eq(profiles.id, userId));
}

function sentTo(): string[] {
  return emailSpy.mock.calls.map(([mail]) => mail.to?.[0]?.email ?? "").sort();
}

function mailFor(email: string) {
  const call = emailSpy.mock.calls.find(([mail]) => mail.to?.[0]?.email === email);
  expect(call).toBeDefined();
  return call![0];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Forum notifications — new thread", () => {
  it("notifies moderators but not the author", async () => {
    const mod = await createUserWithPaidMembership("mod@test.com");
    await makeModerator(mod.userId);
    const author = await createUserWithPaidMembership("author@test.com");

    await postThread(author, "Need help & advice");

    expect(sentTo()).toEqual(["mod@test.com"]);
    const mail = mailFor("mod@test.com");
    expect(mail.subject).toBe("[Treffpunkt] Need help & advice");
    expect(mail.htmlContent).toContain("Need help &amp; advice");
    expect(mail.textContent).toContain("Need help & advice");
    expect(mail.textContent).toContain("weil du den Treffpunkt moderierst");
  });

  it("does not notify a moderator about their own thread", async () => {
    const mod = await createUserWithPaidMembership("mod@test.com");
    await makeModerator(mod.userId);

    await postThread(mod);

    expect(emailSpy).not.toHaveBeenCalled();
  });

  it("moderators are notified regardless of membership", async () => {
    const mod = await createTestUser("mod@test.com", "password123");
    await makeModerator(mod.userId);
    const author = await createUserWithPaidMembership("author@test.com");

    await postThread(author);

    expect(sentTo()).toEqual(["mod@test.com"]);
  });
});

describe("Forum notifications — replies", () => {
  it("notifies author and moderator, not the replier, each exactly once", async () => {
    const mod = await createUserWithPaidMembership("mod@test.com");
    await makeModerator(mod.userId);
    const author = await createUserWithPaidMembership("author@test.com");
    const replier = await createUserWithPaidMembership("replier@test.com");

    const thread = await postThread(author);
    emailSpy.mockClear();

    await postReply(replier, thread, "Here is my answer");

    expect(sentTo()).toEqual(["author@test.com", "mod@test.com"]);
    const authorMail = mailFor("author@test.com");
    expect(authorMail.subject).toBe("Re: [Treffpunkt] Hello World");
    expect(authorMail.textContent).toContain("Here is my answer");
    expect(authorMail.textContent).toContain("weil du diesen Beitrag abonniert hast");
    expect(mailFor("mod@test.com").textContent).toContain("weil du den Treffpunkt moderierst");
  });

  it("sends one mail when the author is also a moderator", async () => {
    const author = await createUserWithPaidMembership("author@test.com");
    await makeModerator(author.userId);
    const replier = await createUserWithPaidMembership("replier@test.com");

    const thread = await postThread(author);
    await postReply(replier, thread);

    expect(sentTo()).toEqual(["author@test.com"]);
  });

  it("auto-subscribes the replier to later replies", async () => {
    const author = await createUserWithPaidMembership("author@test.com");
    const first = await createUserWithPaidMembership("first@test.com");
    const second = await createUserWithPaidMembership("second@test.com");

    const thread = await postThread(author);
    await postReply(first, thread);
    emailSpy.mockClear();

    await postReply(second, thread);

    expect(sentTo()).toEqual(["author@test.com", "first@test.com"]);
  });

  it("uses the recipient's locale", async () => {
    const author = await createUserWithPaidMembership("author@test.com");
    await setLocale(author.userId, "fr");
    const replier = await createUserWithPaidMembership("replier@test.com");

    const thread = await postThread(author);
    await postReply(replier, thread);

    expect(mailFor("author@test.com").textContent).toContain("a répondu à cette contribution");
  });

  it("skips subscribers whose membership has lapsed", async () => {
    const author = await createUserWithPaidMembership("author@test.com");
    const replier = await createUserWithPaidMembership("replier@test.com");

    const thread = await postThread(author);
    await getAdminDb().delete(membershipPayments).where(eq(membershipPayments.userId, author.userId));

    await postReply(replier, thread);

    expect(emailSpy).not.toHaveBeenCalled();
  });

  it("skips subscribers with an unverified email address", async () => {
    const author = await createUserWithPaidMembership("author@test.com");
    const replier = await createUserWithPaidMembership("replier@test.com");

    const thread = await postThread(author);
    await getAdminDb().update(profiles).set({ emailVerified: false }).where(eq(profiles.id, author.userId));

    await postReply(replier, thread);

    expect(emailSpy).not.toHaveBeenCalled();
  });
});

describe("Forum notifications — subscription", () => {
  it("author is subscribed by default, a stranger is not", async () => {
    const author = await createUserWithPaidMembership("author@test.com");
    const reader = await createUserWithPaidMembership("reader@test.com");
    const thread = await postThread(author);

    expect((await getThread(author, thread.id)).isSubscribed).toBe(true);
    expect((await getThread(reader, thread.id)).isSubscribed).toBe(false);
  });

  it("author can unsubscribe and stops receiving reply mails", async () => {
    const mod = await createUserWithPaidMembership("mod@test.com");
    await makeModerator(mod.userId);
    const author = await createUserWithPaidMembership("author@test.com");
    const replier = await createUserWithPaidMembership("replier@test.com");

    const thread = await postThread(author);
    emailSpy.mockClear();

    const res = await setSubscription(author, thread.id, false);
    expect(res.status).toBe(200);
    expect((await getThread(author, thread.id)).isSubscribed).toBe(false);

    await postReply(replier, thread);

    expect(sentTo()).toEqual(["mod@test.com"]);
  });

  it("replying again after unsubscribing keeps the mute", async () => {
    const author = await createUserWithPaidMembership("author@test.com");
    const replier = await createUserWithPaidMembership("replier@test.com");
    const third = await createUserWithPaidMembership("third@test.com");

    const thread = await postThread(author);
    await postReply(replier, thread);
    await setSubscription(replier, thread.id, false);
    await postReply(replier, thread, "second reply");
    expect((await getThread(replier, thread.id)).isSubscribed).toBe(false);
    emailSpy.mockClear();

    await postReply(third, thread);

    expect(sentTo()).toEqual(["author@test.com"]);
  });

  it("a reader can subscribe and then receives reply mails", async () => {
    const author = await createUserWithPaidMembership("author@test.com");
    const reader = await createUserWithPaidMembership("reader@test.com");
    const replier = await createUserWithPaidMembership("replier@test.com");

    const thread = await postThread(author);
    const res = await setSubscription(reader, thread.id, true);
    expect(res.status).toBe(200);
    expect((await getThread(reader, thread.id)).isSubscribed).toBe(true);

    await postReply(replier, thread);

    expect(sentTo()).toEqual(["author@test.com", "reader@test.com"]);
  });

  it("requires membership", async () => {
    const author = await createUserWithPaidMembership("author@test.com");
    const thread = await postThread(author);

    const noMember = await createTestUser("nomem@test.com", "password123");
    expect((await setSubscription(noMember, thread.id, true)).status).toBe(403);
  });
});
