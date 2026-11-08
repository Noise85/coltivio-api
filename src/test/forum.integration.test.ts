import { describe, it, expect, beforeEach } from "@jest/globals";
import { cleanDb, createTestUser, request } from "./helpers";
import { createUserWithFarm, createUserWithPaidMembership, createUserWithTrial } from "./test-utils";

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
  const body = (await res.json()) as { data: { id: string; title: string } };
  return body.data;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Forum — access control", () => {
  beforeEach(cleanDb);

  it("unauthenticated request is rejected", async () => {
    const res = await request("GET", "/v1/forum/threads");
    expect(res.status).toBe(401);
  });

  it("authenticated user without membership cannot read threads", async () => {
    const { jwt } = await createTestUser("reader@test.com", "password123");
    const res = await request("GET", "/v1/forum/threads", undefined, jwt);
    expect(res.status).toBe(403);
  });

  it("authenticated user without membership cannot get thread by ID", async () => {
    const { jwt: posterJwt } = await createUserWithPaidMembership("poster@test.com");
    const thread = await createThread(posterJwt);

    const { jwt: readerJwt } = await createTestUser("reader@test.com", "password123");
    const res = await request("GET", `/v1/forum/threads/byId/${thread.id}`, undefined, readerJwt);
    expect(res.status).toBe(403);
  });

  it("authenticated user without membership cannot list replies", async () => {
    const { jwt: posterJwt } = await createUserWithPaidMembership("poster@test.com");
    const thread = await createThread(posterJwt);
    await request("POST", `/v1/forum/threads/byId/${thread.id}/replies`, { body: "A reply" }, posterJwt);

    const { jwt: readerJwt } = await createTestUser("reader@test.com", "password123");
    const res = await request("GET", `/v1/forum/threads/byId/${thread.id}/replies`, undefined, readerJwt);
    expect(res.status).toBe(403);
  });

  it("authenticated user without membership cannot create a thread", async () => {
    const { jwt } = await createTestUser("user@test.com", "password123");
    const res = await request("POST", "/v1/forum/threads", { title: "Nope", body: "", type: "general" }, jwt);
    expect(res.status).toBe(403);
  });

  it("user with active trial can read but not post", async () => {
    const { jwt: posterJwt } = await createUserWithPaidMembership("poster@test.com");
    await createThread(posterJwt);

    const { jwt: trialJwt } = await createUserWithTrial("trial@test.com");
    const listRes = await request("GET", "/v1/forum/threads", undefined, trialJwt);
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as { data: { total: number } };
    expect(listBody.data.total).toBe(1);

    const postRes = await request(
      "POST",
      "/v1/forum/threads",
      { title: "From trial", body: "", type: "general" },
      trialJwt
    );
    expect(postRes.status).toBe(403);
  });

  it("user with paid membership (no farm) can read and post", async () => {
    const { jwt } = await createUserWithPaidMembership("member@test.com");
    const thread = await createThread(jwt);
    expect(thread.title).toBe("Hello World");

    const replyRes = await request("POST", `/v1/forum/threads/byId/${thread.id}/replies`, { body: "Good reply" }, jwt);
    expect(replyRes.status).toBe(200);
  });

  it("user with farm and active membership can also post", async () => {
    const { jwt } = await createUserWithFarm({}, "farmmember@test.com", { withActiveMembership: true });
    const thread = await createThread(jwt);
    expect(thread.title).toBe("Hello World");
  });
});
