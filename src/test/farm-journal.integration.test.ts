import { describe, it, expect, beforeEach } from "@jest/globals";
import { cleanDb, getAdminDb, request } from "./helpers";
import { createFarmMember, createUserWithFarm, grantMemberWriteAccess } from "./test-utils";
import { farmJournalImages } from "../db/schema";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createJournalEntry(jwt: string, data?: Record<string, unknown>) {
  const res = await request(
    "POST",
    "/v1/farm/journal",
    { title: "Barn repair", date: "2024-06-01", content: "Fixed the roof.", ...data },
    jwt
  );
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: Record<string, unknown> }).data;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Farm Journal — entry CRUD", () => {
  beforeEach(cleanDb);

  it("creates a journal entry for the farm", async () => {
    const { jwt, farmId, userId } = await createUserWithFarm({}, "test@test.com", { withActiveMembership: true });

    const res = await request(
      "POST",
      "/v1/farm/journal",
      { title: "Vet visit", date: "2024-06-01", content: "Routine check." },
      jwt
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data.title).toBe("Vet visit");
    expect(body.data.farmId).toBe(farmId);
    expect(body.data.createdBy).toBe(userId);
    expect(body.data.content).toBe("Routine check.");

    const db = getAdminDb();
    const entry = await db.query.farmJournalEntries.findFirst({
      where: { id: body.data.id as string },
    });
    expect(entry).toBeDefined();
    expect(entry!.title).toBe("Vet visit");
  });

  it("creates an entry without content", async () => {
    const { jwt } = await createUserWithFarm({}, "test@test.com", { withActiveMembership: true });

    const res = await request("POST", "/v1/farm/journal", { title: "Quick note", date: "2024-06-01" }, jwt);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { content: unknown } };
    expect(body.data.content).toBeNull();
  });

  it("rejects an empty title", async () => {
    const { jwt } = await createUserWithFarm({}, "test@test.com", { withActiveMembership: true });

    const res = await request("POST", "/v1/farm/journal", { title: "", date: "2024-06-01" }, jwt);
    expect(res.status).toBe(400);
  });

  it("lists journal entries, newest date first", async () => {
    const { jwt } = await createUserWithFarm({}, "test@test.com", { withActiveMembership: true });

    await createJournalEntry(jwt, { date: "2024-01-01", title: "Old entry" });
    await createJournalEntry(jwt, { date: "2024-06-15", title: "New entry" });

    const res = await request("GET", "/v1/farm/journal", undefined, jwt);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { entries: Record<string, unknown>[] } };
    expect(body.data.entries).toHaveLength(2);
    expect(body.data.entries[0].title).toBe("New entry");
    expect(body.data.entries[1].title).toBe("Old entry");
    expect(body.data.entries[0]).not.toHaveProperty("images");
  });

  it("gets a single journal entry by id", async () => {
    const { jwt } = await createUserWithFarm({}, "test@test.com", { withActiveMembership: true });
    const entry = await createJournalEntry(jwt);

    const res = await request("GET", `/v1/farm/journal/byId/${entry.id}`, undefined, jwt);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data.id).toBe(entry.id);
    expect(body.data.images).toEqual([]);
  });

  it("returns 404 for a non-existent entry", async () => {
    const { jwt } = await createUserWithFarm({}, "test@test.com", { withActiveMembership: true });

    const res = await request("GET", "/v1/farm/journal/byId/00000000-0000-0000-0000-000000000000", undefined, jwt);
    expect(res.status).toBe(404);
  });

  it("updates title, date, and content", async () => {
    const { jwt } = await createUserWithFarm({}, "test@test.com", { withActiveMembership: true });
    const entry = await createJournalEntry(jwt);

    const res = await request(
      "PATCH",
      `/v1/farm/journal/byId/${entry.id}`,
      { title: "Updated title", date: "2024-07-01", content: "Updated content" },
      jwt
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data.title).toBe("Updated title");
    expect(body.data.content).toBe("Updated content");
    expect(String(body.data.date)).toContain("2024-07-01");
  });

  it("deletes a journal entry", async () => {
    const { jwt } = await createUserWithFarm({}, "test@test.com", { withActiveMembership: true });
    const entry = await createJournalEntry(jwt);

    const res = await request("DELETE", `/v1/farm/journal/byId/${entry.id}`, undefined, jwt);
    expect(res.status).toBe(200);

    const db = getAdminDb();
    const dbEntry = await db.query.farmJournalEntries.findFirst({
      where: { id: entry.id as string },
    });
    expect(dbEntry).toBeUndefined();
  });

  it("requires authentication", async () => {
    const res = await request("GET", "/v1/farm/journal");
    expect(res.status).toBe(401);
  });
});

describe("Farm Journal — farm isolation", () => {
  beforeEach(cleanDb);

  it("farm B cannot list farm A journal entries", async () => {
    const { jwt: jwtA } = await createUserWithFarm({}, "a@test.com", { withActiveMembership: true });
    const { jwt: jwtB } = await createUserWithFarm({}, "b@test.com", { withActiveMembership: true });

    await createJournalEntry(jwtA);

    const res = await request("GET", "/v1/farm/journal", undefined, jwtB);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { entries: unknown[] } };
    expect(body.data.entries).toHaveLength(0);
  });

  it("farm A cannot read farm B journal entries", async () => {
    const { jwt: jwtA } = await createUserWithFarm({}, "a@test.com", { withActiveMembership: true });
    const { jwt: jwtB } = await createUserWithFarm({}, "b@test.com", { withActiveMembership: true });

    const entry = await createJournalEntry(jwtA);

    const res = await request("GET", `/v1/farm/journal/byId/${entry.id}`, undefined, jwtB);
    expect(res.status).toBe(404);
  });

  it("farm A cannot update farm B journal entries", async () => {
    const { jwt: jwtA } = await createUserWithFarm({}, "a@test.com", { withActiveMembership: true });
    const { jwt: jwtB } = await createUserWithFarm({}, "b@test.com", { withActiveMembership: true });

    const entry = await createJournalEntry(jwtA);

    const res = await request("PATCH", `/v1/farm/journal/byId/${entry.id}`, { title: "Hacked" }, jwtB);
    expect(res.status).toBe(404);
  });

  it("farm A cannot delete farm B journal entries", async () => {
    const { jwt: jwtA } = await createUserWithFarm({}, "a@test.com", { withActiveMembership: true });
    const { jwt: jwtB } = await createUserWithFarm({}, "b@test.com", { withActiveMembership: true });

    const entry = await createJournalEntry(jwtA);

    const res = await request("DELETE", `/v1/farm/journal/byId/${entry.id}`, undefined, jwtB);
    expect(res.status).toBe(200); // RLS silently no-ops

    const db = getAdminDb();
    const dbEntry = await db.query.farmJournalEntries.findFirst({
      where: { id: entry.id as string },
    });
    expect(dbEntry).toBeDefined();
  });
});

describe("Farm Journal — owner only", () => {
  beforeEach(cleanDb);

  it("non-owner member cannot access any journal endpoint", async () => {
    const { jwt: ownerJwt } = await createUserWithFarm({}, "owner@test.com", { withActiveMembership: true });
    const { jwt: memberJwt, userId: memberId } = await createFarmMember(ownerJwt, "member@test.com", {
      withActiveMembership: true,
    });
    await grantMemberWriteAccess(ownerJwt, memberId, "animals");

    const entry = await createJournalEntry(ownerJwt);

    const memberRequests: [string, string, Record<string, unknown> | undefined][] = [
      ["GET", "/v1/farm/journal", undefined],
      ["POST", "/v1/farm/journal", { title: "x", date: "2024-06-01" }],
      ["GET", `/v1/farm/journal/byId/${entry.id}`, undefined],
      ["PATCH", `/v1/farm/journal/byId/${entry.id}`, { title: "hacked" }],
      ["DELETE", `/v1/farm/journal/byId/${entry.id}`, undefined],
      ["POST", "/v1/farm/journal/images/signedUrl", { journalEntryId: entry.id, filename: "a.jpg" }],
    ];
    for (const [method, path, body] of memberRequests) {
      const res = await request(method, path, body, memberJwt);
      expect(res.status).toBe(403);
    }

    const db = getAdminDb();
    const dbEntry = await db.query.farmJournalEntries.findFirst({ where: { id: String(entry.id) } });
    expect(dbEntry?.title).toBe("Barn repair");
  });
});

describe("Farm Journal — image registration", () => {
  beforeEach(cleanDb);

  it("farm B cannot request a signed upload URL for farm A's journal entry", async () => {
    const { jwt: jwtA } = await createUserWithFarm({}, "a@test.com", { withActiveMembership: true });
    const { jwt: jwtB } = await createUserWithFarm({}, "b@test.com", { withActiveMembership: true });

    const entryA = await createJournalEntry(jwtA);

    const res = await request(
      "POST",
      "/v1/farm/journal/images/signedUrl",
      { journalEntryId: entryA.id, filename: "evil.jpg" },
      jwtB
    );
    expect(res.status).toBe(404);
  });

  it("farm B cannot register an image against farm A's journal entry", async () => {
    const { jwt: jwtA } = await createUserWithFarm({}, "a@test.com", { withActiveMembership: true });
    const { jwt: jwtB } = await createUserWithFarm({}, "b@test.com", { withActiveMembership: true });

    const entryA = await createJournalEntry(jwtA);

    const res = await request(
      "POST",
      "/v1/farm/journal/images",
      { journalEntryId: entryA.id, storagePath: `${entryA.id}/11111111-1111-4111-8111-111111111111.jpg` },
      jwtB
    );
    expect(res.status).toBe(404);

    const db = getAdminDb();
    const images = await db.query.farmJournalImages.findMany({
      where: { journalEntryId: entryA.id as string },
    });
    expect(images).toHaveLength(0);
  });

  it("rejects a storage path containing traversal segments", async () => {
    const { jwt } = await createUserWithFarm({}, "test@test.com", { withActiveMembership: true });
    const entry = await createJournalEntry(jwt);

    const res = await request(
      "POST",
      "/v1/farm/journal/images",
      { journalEntryId: entry.id, storagePath: `${entry.id}/../../wiki-images/evil.jpg` },
      jwt
    );
    expect(res.status).toBe(400);
  });

  it("rejects registerImage with path not scoped to the journal entry", async () => {
    const { jwt } = await createUserWithFarm({}, "test@test.com", { withActiveMembership: true });
    const entry = await createJournalEntry(jwt);

    const res = await request(
      "POST",
      "/v1/farm/journal/images",
      { journalEntryId: entry.id, storagePath: "some-other-folder/image.jpg" },
      jwt
    );
    expect(res.status).toBe(400);
  });

  it("registers an image on the caller's own journal entry", async () => {
    const { jwt } = await createUserWithFarm({}, "test@test.com", { withActiveMembership: true });
    const entry = await createJournalEntry(jwt);
    const storagePath = `${entry.id}/22222222-2222-4222-8222-222222222222.jpg`;

    const res = await request("POST", "/v1/farm/journal/images", { journalEntryId: entry.id, storagePath }, jwt);
    // Storage is not available in the test environment, so the signed-URL step after the
    // insert may fail — what matters is that the ownership guard let the request through.
    expect(res.status).not.toBe(404);
    expect(res.status).not.toBe(400);

    const db = getAdminDb();
    const images = await db.query.farmJournalImages.findMany({
      where: { journalEntryId: entry.id as string },
    });
    expect(images).toHaveLength(1);
    expect(images[0].storagePath).toBe(storagePath);
  });

  it("deletes an image record", async () => {
    const { jwt } = await createUserWithFarm({}, "test@test.com", { withActiveMembership: true });
    const entry = await createJournalEntry(jwt);

    const db = getAdminDb();
    const [image] = await db
      .insert(farmJournalImages)
      .values({ journalEntryId: entry.id as string, storagePath: `${entry.id}/test.jpg` })
      .returning();

    const res = await request("DELETE", `/v1/farm/journal/images/byId/${image.id}`, undefined, jwt);
    expect(res.status).toBe(200);

    const dbImage = await db.query.farmJournalImages.findFirst({ where: { id: image.id } });
    expect(dbImage).toBeUndefined();
  });

  it("deleting an entry removes its image records", async () => {
    const { jwt } = await createUserWithFarm({}, "test@test.com", { withActiveMembership: true });
    const entry = await createJournalEntry(jwt);

    const db = getAdminDb();
    await db.insert(farmJournalImages).values([
      { journalEntryId: entry.id as string, storagePath: `${entry.id}/img1.jpg` },
      { journalEntryId: entry.id as string, storagePath: `${entry.id}/img2.jpg` },
    ]);

    await request("DELETE", `/v1/farm/journal/byId/${entry.id}`, undefined, jwt);

    const images = await db.query.farmJournalImages.findMany({
      where: { journalEntryId: entry.id as string },
    });
    expect(images).toHaveLength(0);
  });
});
