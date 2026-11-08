import { describe, it, expect, beforeEach } from "@jest/globals";
import { cleanDb, createTestUser, getAdminDb, request } from "./helpers";
import { createAnimal, createUserWithFarm } from "./test-utils";
import { animalJournalEntries, animalJournalImages } from "../db/schema";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createJournalEntry(jwt: string, animalId: string, data?: Record<string, unknown>) {
  const res = await request(
    "POST",
    `/v1/animals/byId/${animalId}/journal`,
    { title: "First checkup", date: "2024-06-01", content: "All good.", ...data },
    jwt
  );
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: Record<string, unknown> }).data;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Animal Journal — entry CRUD", () => {
  beforeEach(cleanDb);

  it("creates a journal entry for an animal", async () => {
    const { jwt, farmId } = await createUserWithFarm({}, "test@test.com", { withActiveMembership: true });
    const animal = await createAnimal(jwt);

    const res = await request(
      "POST",
      `/v1/animals/byId/${animal.id}/journal`,
      { title: "Health check", date: "2024-06-01", content: "Healthy." },
      jwt
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data.title).toBe("Health check");
    expect(body.data.animalId).toBe(animal.id);
    expect(body.data.farmId).toBe(farmId);
    expect(body.data.content).toBe("Healthy.");

    // Verify in DB
    const db = getAdminDb();
    const entry = await db.query.animalJournalEntries.findFirst({
      where: { id: body.data.id as string },
    });
    expect(entry).toBeDefined();
    expect(entry!.title).toBe("Health check");
  });

  it("creates an entry without content", async () => {
    const { jwt } = await createUserWithFarm({}, "test@test.com", { withActiveMembership: true });
    const animal = await createAnimal(jwt);

    const res = await request(
      "POST",
      `/v1/animals/byId/${animal.id}/journal`,
      { title: "Quick note", date: "2024-06-01" },
      jwt
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { content: unknown } };
    expect(body.data.content).toBeNull();
  });

  it("lists journal entries for an animal, newest date first", async () => {
    const { jwt } = await createUserWithFarm({}, "test@test.com", { withActiveMembership: true });
    const animal = await createAnimal(jwt);

    await createJournalEntry(jwt, animal.id, { date: "2024-01-01", title: "Old entry" });
    await createJournalEntry(jwt, animal.id, { date: "2024-06-15", title: "New entry" });

    const res = await request("GET", `/v1/animals/byId/${animal.id}/journal`, undefined, jwt);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { entries: { title: string }[] } };
    expect(body.data.entries).toHaveLength(2);
    expect(body.data.entries[0].title).toBe("New entry");
    expect(body.data.entries[1].title).toBe("Old entry");
  });

  it("gets a single journal entry by id", async () => {
    const { jwt } = await createUserWithFarm({}, "test@test.com", { withActiveMembership: true });
    const animal = await createAnimal(jwt);
    const entry = await createJournalEntry(jwt, animal.id);

    const res = await request("GET", `/v1/animals/journal/byId/${entry.id}`, undefined, jwt);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data.id).toBe(entry.id);
    expect(body.data.images).toEqual([]);
  });

  it("updates title, date, and content", async () => {
    const { jwt } = await createUserWithFarm({}, "test@test.com", { withActiveMembership: true });
    const animal = await createAnimal(jwt);
    const entry = await createJournalEntry(jwt, animal.id);

    const res = await request(
      "PATCH",
      `/v1/animals/journal/byId/${entry.id}`,
      { title: "Updated title", content: "Updated content" },
      jwt
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data.title).toBe("Updated title");
    expect(body.data.content).toBe("Updated content");
  });

  it("deletes a journal entry", async () => {
    const { jwt } = await createUserWithFarm({}, "test@test.com", { withActiveMembership: true });
    const animal = await createAnimal(jwt);
    const entry = await createJournalEntry(jwt, animal.id);

    const res = await request("DELETE", `/v1/animals/journal/byId/${entry.id}`, undefined, jwt);
    expect(res.status).toBe(200);

    const db = getAdminDb();
    const dbEntry = await db.query.animalJournalEntries.findFirst({
      where: { id: entry.id as string },
    });
    expect(dbEntry).toBeUndefined();
  });

  it("returns 404 for non-existent animal on create", async () => {
    const { jwt } = await createUserWithFarm({}, "test@test.com", { withActiveMembership: true });

    const res = await request(
      "POST",
      `/v1/animals/byId/00000000-0000-0000-0000-000000000000/journal`,
      { title: "Test", date: "2024-06-01" },
      jwt
    );
    expect(res.status).toBe(404);
  });

  it("requires authentication", async () => {
    const { jwt } = await createUserWithFarm({}, "test@test.com", { withActiveMembership: true });
    const animal = await createAnimal(jwt);

    const res = await request("GET", `/v1/animals/byId/${animal.id}/journal`);
    expect(res.status).toBe(401);
  });
});

describe("Animal Journal — farm isolation", () => {
  beforeEach(cleanDb);

  it("farm A cannot read farm B journal entries", async () => {
    const { jwt: jwtA } = await createUserWithFarm({}, "a@test.com", { withActiveMembership: true });
    const { jwt: jwtB } = await createUserWithFarm({}, "b@test.com", { withActiveMembership: true });

    const animalA = await createAnimal(jwtA);
    const entry = await createJournalEntry(jwtA, animalA.id);

    // Farm B cannot get farm A's entry
    const res = await request("GET", `/v1/animals/journal/byId/${entry.id}`, undefined, jwtB);
    expect(res.status).toBe(404);
  });

  it("farm A cannot update farm B journal entries", async () => {
    const { jwt: jwtA } = await createUserWithFarm({}, "a@test.com", { withActiveMembership: true });
    const { jwt: jwtB } = await createUserWithFarm({}, "b@test.com", { withActiveMembership: true });

    const animalA = await createAnimal(jwtA);
    const entry = await createJournalEntry(jwtA, animalA.id);

    const res = await request("PATCH", `/v1/animals/journal/byId/${entry.id}`, { title: "Hacked" }, jwtB);
    expect(res.status).toBe(404);
  });

  it("farm A cannot delete farm B journal entries", async () => {
    const { jwt: jwtA } = await createUserWithFarm({}, "a@test.com", { withActiveMembership: true });
    const { jwt: jwtB } = await createUserWithFarm({}, "b@test.com", { withActiveMembership: true });

    const animalA = await createAnimal(jwtA);
    const entry = await createJournalEntry(jwtA, animalA.id);

    const res = await request("DELETE", `/v1/animals/journal/byId/${entry.id}`, undefined, jwtB);
    expect(res.status).toBe(200); // RLS silently no-ops the delete for a different farm

    // Entry must still exist
    const db = getAdminDb();
    const dbEntry = await db.query.animalJournalEntries.findFirst({
      where: { id: entry.id as string },
    });
    expect(dbEntry).toBeDefined();
  });

  it("farm B cannot list farm A's animal journal", async () => {
    const { jwt: jwtA } = await createUserWithFarm({}, "a@test.com", { withActiveMembership: true });
    const { jwt: jwtB } = await createUserWithFarm({}, "b@test.com", { withActiveMembership: true });

    const animalA = await createAnimal(jwtA);
    await createJournalEntry(jwtA, animalA.id);

    // Farm B tries to list entries for farm A's animal — RLS returns empty
    const res = await request("GET", `/v1/animals/byId/${animalA.id}/journal`, undefined, jwtB);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { entries: unknown[] } };
    expect(body.data.entries).toHaveLength(0);
  });

  it("farm A cannot create journal entry for farm B animal", async () => {
    const { jwt: jwtA } = await createUserWithFarm({}, "a@test.com", { withActiveMembership: true });
    const { jwt: jwtB } = await createUserWithFarm({}, "b@test.com", { withActiveMembership: true });

    const animalB = await createAnimal(jwtB);

    const res = await request(
      "POST",
      `/v1/animals/byId/${animalB.id}/journal`,
      { title: "Cross-farm entry", date: "2024-06-01" },
      jwtA
    );
    expect(res.status).toBe(404);
  });
});

describe("Animal Journal — image registration", () => {
  beforeEach(cleanDb);

  it("farm B cannot request a signed upload URL for farm A's animal journal entry", async () => {
    const { jwt: jwtA } = await createUserWithFarm({}, "a@test.com", { withActiveMembership: true });
    const { jwt: jwtB } = await createUserWithFarm({}, "b@test.com", { withActiveMembership: true });

    const animalA = await createAnimal(jwtA);
    const entryA = await createJournalEntry(jwtA, animalA.id);

    const res = await request(
      "POST",
      "/v1/animals/journal/images/signedUrl",
      { journalEntryId: entryA.id, filename: "evil.jpg" },
      jwtB
    );
    expect(res.status).toBe(404);
  });

  it("farm B cannot register an image against farm A's animal journal entry", async () => {
    const { jwt: jwtA } = await createUserWithFarm({}, "a@test.com", { withActiveMembership: true });
    const { jwt: jwtB } = await createUserWithFarm({}, "b@test.com", { withActiveMembership: true });

    const animalA = await createAnimal(jwtA);
    const entryA = await createJournalEntry(jwtA, animalA.id);

    const res = await request(
      "POST",
      "/v1/animals/journal/images",
      { journalEntryId: entryA.id, storagePath: `${entryA.id}/11111111-1111-4111-8111-111111111111.jpg` },
      jwtB
    );
    expect(res.status).toBe(404);

    // No row may have been written for farm A's entry
    const db = getAdminDb();
    const images = await db.query.animalJournalImages.findMany({
      where: { journalEntryId: entryA.id as string },
    });
    expect(images).toHaveLength(0);
  });

  it("rejects a storage path whose extension is not a normal file extension", async () => {
    const { jwt } = await createUserWithFarm({}, "test@test.com", { withActiveMembership: true });
    const animal = await createAnimal(jwt);
    const entry = await createJournalEntry(jwt, animal.id);

    // requestSignedImageUrl normalises the extension, so a path like this can never come
    // from the server — a client sending one is constructing the path itself.
    const res = await request(
      "POST",
      "/v1/animals/journal/images",
      { journalEntryId: entry.id, storagePath: `${entry.id}/33333333-3333-4333-8333-333333333333.image_1756713600000` },
      jwt
    );
    expect(res.status).toBe(400);
  });

  it("rejects a storage path containing traversal segments", async () => {
    const { jwt } = await createUserWithFarm({}, "test@test.com", { withActiveMembership: true });
    const animal = await createAnimal(jwt);
    const entry = await createJournalEntry(jwt, animal.id);

    const res = await request(
      "POST",
      "/v1/animals/journal/images",
      { journalEntryId: entry.id, storagePath: `${entry.id}/../../wiki-images/evil.jpg` },
      jwt
    );
    expect(res.status).toBe(400);
  });

  it("registers an image on the caller's own journal entry", async () => {
    const { jwt } = await createUserWithFarm({}, "test@test.com", { withActiveMembership: true });
    const animal = await createAnimal(jwt);
    const entry = await createJournalEntry(jwt, animal.id);
    const storagePath = `${entry.id}/22222222-2222-4222-8222-222222222222.jpg`;

    const res = await request("POST", "/v1/animals/journal/images", { journalEntryId: entry.id, storagePath }, jwt);
    // Storage is not available in the test environment, so the signed-URL step after the
    // insert may fail — what matters is that the ownership guard let the request through
    // and the row was written under RLS.
    expect(res.status).not.toBe(404);
    expect(res.status).not.toBe(400);

    const db = getAdminDb();
    const images = await db.query.animalJournalImages.findMany({
      where: { journalEntryId: entry.id as string },
    });
    expect(images).toHaveLength(1);
    expect(images[0].storagePath).toBe(storagePath);
  });

  it("rejects registerImage with path not scoped to the journal entry", async () => {
    const { jwt } = await createUserWithFarm({}, "test@test.com", { withActiveMembership: true });
    const animal = await createAnimal(jwt);
    const entry = await createJournalEntry(jwt, animal.id);

    const res = await request(
      "POST",
      "/v1/animals/journal/images",
      { journalEntryId: entry.id, storagePath: "some-other-folder/image.jpg" },
      jwt
    );
    expect(res.status).toBe(400);
  });

  it("deletes an image record", async () => {
    const { jwt } = await createUserWithFarm({}, "test@test.com", { withActiveMembership: true });
    const animal = await createAnimal(jwt);
    const entry = await createJournalEntry(jwt, animal.id);

    // Seed an image directly in DB (bypasses storage)
    const db = getAdminDb();
    const [image] = await db
      .insert(animalJournalImages)
      .values({ journalEntryId: entry.id as string, storagePath: `${entry.id}/test.jpg` })
      .returning();

    // Delete via API — storage remove is best-effort and will silently fail in test env
    const res = await request("DELETE", `/v1/animals/journal/images/byId/${image.id}`, undefined, jwt);
    expect(res.status).toBe(200);

    const dbImage = await db.query.animalJournalImages.findFirst({ where: { id: image.id } });
    expect(dbImage).toBeUndefined();
  });

  it("deleted entry cascades image DB records", async () => {
    const { jwt } = await createUserWithFarm({}, "test@test.com", { withActiveMembership: true });
    const animal = await createAnimal(jwt);
    const entry = await createJournalEntry(jwt, animal.id);

    // Seed images directly in DB
    const db = getAdminDb();
    await db.insert(animalJournalImages).values([
      { journalEntryId: entry.id as string, storagePath: `${entry.id}/img1.jpg` },
      { journalEntryId: entry.id as string, storagePath: `${entry.id}/img2.jpg` },
    ]);

    // Note: deleteEntry fetches images and attempts storage removal (will silently fail in test env),
    // then deletes the entry. We verify DB records are gone.
    await request("DELETE", `/v1/animals/journal/byId/${entry.id}`, undefined, jwt);

    const images = await db.query.animalJournalImages.findMany({
      where: { journalEntryId: entry.id as string },
    });
    expect(images).toHaveLength(0);
  });
});
