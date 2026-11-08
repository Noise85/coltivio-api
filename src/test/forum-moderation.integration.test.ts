import { describe, it, expect, beforeEach } from "@jest/globals";
import { getAdminDb, cleanDb, createTestUser, request } from "./helpers";
import { createUserWithPaidMembership } from "./test-utils";
import { forumModerators } from "../db/schema";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createThread(jwt: string) {
  const res = await request(
    "POST",
    "/v1/forum/threads",
    { title: "Hello World", body: "My first post", type: "general" },
    jwt
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { data: { id: string } };
  return body.data.id;
}

async function makeModerator(userId: string) {
  await getAdminDb().insert(forumModerators).values({ userId });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Forum moderation — access control", () => {
  beforeEach(cleanDb);

  it("user without membership cannot set thread status", async () => {
    const { jwt: authorJwt } = await createUserWithPaidMembership("author@test.com");
    const threadId = await createThread(authorJwt);

    const { jwt: unauthedJwt } = await createTestUser("nomem@test.com", "password123");
    const res = await request("POST", `/v1/forum/threads/byId/${threadId}/status`, { status: "closed" }, unauthedJwt);
    expect(res.status).toBe(403);
  });

  it("moderator without membership cannot pin a thread", async () => {
    const { jwt: authorJwt } = await createUserWithPaidMembership("author@test.com");
    const threadId = await createThread(authorJwt);

    const { jwt: modJwt, userId: modUserId } = await createTestUser("mod@test.com", "password123");
    await makeModerator(modUserId);

    const res = await request("POST", `/v1/forum/threads/byId/${threadId}/pin`, { pinned: true }, modJwt);
    expect(res.status).toBe(403);
  });

  it("thread author with active membership can close their own thread", async () => {
    const { jwt: authorJwt } = await createUserWithPaidMembership("author@test.com");
    const threadId = await createThread(authorJwt);

    const res = await request("POST", `/v1/forum/threads/byId/${threadId}/status`, { status: "closed" }, authorJwt);
    expect(res.status).toBe(200);
  });

  it("moderator with active membership can pin a thread", async () => {
    const { jwt: authorJwt } = await createUserWithPaidMembership("author@test.com");
    const threadId = await createThread(authorJwt);

    const { jwt: modJwt, userId: modUserId } = await createUserWithPaidMembership("mod@test.com");
    await makeModerator(modUserId);

    const res = await request("POST", `/v1/forum/threads/byId/${threadId}/pin`, { pinned: true }, modJwt);
    expect(res.status).toBe(200);
  });

  it("member with membership but neither author nor moderator cannot change thread status", async () => {
    const { jwt: authorJwt } = await createUserWithPaidMembership("author@test.com");
    const threadId = await createThread(authorJwt);

    const { jwt: otherJwt } = await createUserWithPaidMembership("other@test.com");
    const res = await request("POST", `/v1/forum/threads/byId/${threadId}/status`, { status: "closed" }, otherJwt);
    expect(res.status).toBe(403);
  });

  it("moderator with active membership can close and reopen someone else's thread", async () => {
    const { jwt: authorJwt } = await createUserWithPaidMembership("author@test.com");
    const threadId = await createThread(authorJwt);

    const { jwt: modJwt, userId: modUserId } = await createUserWithPaidMembership("mod@test.com");
    await makeModerator(modUserId);

    const closeRes = await request("POST", `/v1/forum/threads/byId/${threadId}/status`, { status: "closed" }, modJwt);
    expect(closeRes.status).toBe(200);
    const reopenRes = await request("POST", `/v1/forum/threads/byId/${threadId}/status`, { status: "open" }, modJwt);
    expect(reopenRes.status).toBe(200);
  });
});

describe("Forum moderation — isForumModerator on /me", () => {
  beforeEach(cleanDb);

  async function getMe(jwt: string) {
    const res = await request("GET", "/v1/me", undefined, jwt);
    expect(res.status).toBe(200);
    return ((await res.json()) as { data: { isForumModerator: boolean } }).data;
  }

  it("is false for a regular user", async () => {
    const { jwt } = await createTestUser("user@test.com", "password123");
    expect((await getMe(jwt)).isForumModerator).toBe(false);
  });

  it("is true for a forum moderator", async () => {
    const { jwt, userId } = await createTestUser("mod@test.com", "password123");
    await makeModerator(userId);
    expect((await getMe(jwt)).isForumModerator).toBe(true);
  });
});
