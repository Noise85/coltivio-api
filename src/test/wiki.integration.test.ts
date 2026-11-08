import { describe, it, expect, beforeEach } from "@jest/globals";
import { cleanDb, createTestUser, getAdminDb, request } from "./helpers";
import { createUserWithFarm, createFarmMember } from "./test-utils";
import { wikiCategories, wikiCategoryTranslations, wikiModerators } from "../db/schema";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function seedCategory() {
  const db = getAdminDb();
  const [cat] = await db.insert(wikiCategories).values({ slug: "plants" }).returning();
  await db.insert(wikiCategoryTranslations).values({ categoryId: cat.id, locale: "en", name: "Plants" });
  return cat;
}

async function seedModerator(userId: string) {
  const db = getAdminDb();
  await db.insert(wikiModerators).values({ userId });
}

// Creates an entry with an empty-title translation (gets filtered out in handler → no DB rows)
async function createEntry(jwt: string, categoryId: string) {
  const res = await request(
    "POST",
    "/v1/wiki",
    { categoryId, translations: [{ locale: "en", title: "", body: "" }] },
    jwt
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { data: { id: string; status: string } };
  return body.data;
}

// Adds a real translation via PATCH so the entry has content for submission
async function addTranslation(jwt: string, entryId: string) {
  const res = await request(
    "PATCH",
    `/v1/wiki/byId/${entryId}`,
    { translations: [{ locale: "en", title: "Tomato", body: "A red fruit." }] },
    jwt
  );
  expect(res.status).toBe(200);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Wiki — entry lifecycle", () => {
  beforeEach(cleanDb);

  it("creates a private draft entry", async () => {
    const { jwt, userId, farmId } = await createUserWithFarm({});
    const cat = await seedCategory();

    const entry = await createEntry(jwt, cat.id);

    expect(entry.status).toBe("draft");

    const db = getAdminDb();
    const dbEntry = await db.query.wikiEntries.findFirst({ where: { id: entry.id } });
    expect(dbEntry!.status).toBe("draft");
    expect(dbEntry!.visibility).toBe("private");
    expect(dbEntry!.createdBy).toBe(userId);
    expect(dbEntry!.farmId).toBe(farmId);
  });

  it("submits entry for review — entry becomes under_review, CR created", async () => {
    const { jwt } = await createUserWithFarm({});
    const cat = await seedCategory();

    const entry = await createEntry(jwt, cat.id);
    await addTranslation(jwt, entry.id);

    const res = await request("POST", `/v1/wiki/byId/${entry.id}/submit`, {}, jwt);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { id: string; status: string; type: string } };
    expect(body.data.status).toBe("under_review");
    expect(body.data.type).toBe("new_entry");

    // Private entry stays draft — status is not synced to the CR
    const getRes = await request("GET", `/v1/wiki/byId/${entry.id}`, undefined, jwt);
    expect(getRes.status).toBe(200);
    const getBody = (await getRes.json()) as { data: { status: string } };
    expect(getBody.data.status).toBe("draft");
  });

  it("blocks submitting an entry without translations", async () => {
    const { jwt } = await createUserWithFarm({});
    const cat = await seedCategory();

    const entry = await createEntry(jwt, cat.id);
    const res = await request("POST", `/v1/wiki/byId/${entry.id}/submit`, {}, jwt);
    expect(res.status).toBe(500); // throws inside wiki.ts
  });

  it("blocks duplicate submission while CR is active", async () => {
    const { jwt } = await createUserWithFarm({});
    const cat = await seedCategory();

    const entry = await createEntry(jwt, cat.id);
    await addTranslation(jwt, entry.id);
    await request("POST", `/v1/wiki/byId/${entry.id}/submit`, {}, jwt);

    const res = await request("POST", `/v1/wiki/byId/${entry.id}/submit`, {}, jwt);
    expect(res.status).toBe(500);
  });

  it("moderator approves new_entry CR — source entry stays draft, CR becomes approved", async () => {
    const { jwt: userJwt } = await createUserWithFarm({});
    const { jwt: modJwt, userId: modId } = await createTestUser("mod@test.com", "password123");
    await seedModerator(modId);
    const cat = await seedCategory();

    const entry = await createEntry(userJwt, cat.id);
    await addTranslation(userJwt, entry.id);
    const submitRes = await request("POST", `/v1/wiki/byId/${entry.id}/submit`, {}, userJwt);
    const cr = ((await submitRes.json()) as { data: { id: string } }).data;

    const approveRes = await request("POST", `/v1/wiki/changeRequests/byId/${cr.id}/approve`, {}, modJwt);
    expect(approveRes.status).toBe(200);

    const db = getAdminDb();
    const dbEntry = await db.query.wikiEntries.findFirst({ where: { id: entry.id } });
    expect(dbEntry!.status).toBe("draft"); // private entry always stays draft

    const dbCr = await db.query.wikiChangeRequests.findFirst({ where: { id: cr.id } });
    expect(dbCr!.status).toBe("approved");
  });

  it("moderator rejects CR — entry reverts to draft", async () => {
    const { jwt: userJwt } = await createUserWithFarm({});
    const { jwt: modJwt, userId: modId } = await createTestUser("mod@test.com", "password123");
    await seedModerator(modId);
    const cat = await seedCategory();

    const entry = await createEntry(userJwt, cat.id);
    await addTranslation(userJwt, entry.id);
    const submitRes = await request("POST", `/v1/wiki/byId/${entry.id}/submit`, {}, userJwt);
    const cr = ((await submitRes.json()) as { data: { id: string } }).data;

    const rejectRes = await request("POST", `/v1/wiki/changeRequests/byId/${cr.id}/reject`, {}, modJwt);
    expect(rejectRes.status).toBe(200);

    const db = getAdminDb();
    const dbEntry = await db.query.wikiEntries.findFirst({ where: { id: entry.id } });
    expect(dbEntry!.status).toBe("draft");

    const dbCr = await db.query.wikiChangeRequests.findFirst({ where: { id: cr.id } });
    expect(dbCr!.status).toBe("rejected");
  });

  it("moderator requests changes — CR becomes changes_requested, entry reverts to draft", async () => {
    const { jwt: userJwt } = await createUserWithFarm({});
    const { jwt: modJwt, userId: modId } = await createTestUser("mod@test.com", "password123");
    await seedModerator(modId);
    const cat = await seedCategory();

    const entry = await createEntry(userJwt, cat.id);
    await addTranslation(userJwt, entry.id);
    const submitRes = await request("POST", `/v1/wiki/byId/${entry.id}/submit`, {}, userJwt);
    const cr = ((await submitRes.json()) as { data: { id: string } }).data;

    const changesRes = await request("POST", `/v1/wiki/changeRequests/byId/${cr.id}/requestChanges`, {}, modJwt);
    expect(changesRes.status).toBe(200);

    const db = getAdminDb();
    const dbEntry = await db.query.wikiEntries.findFirst({ where: { id: entry.id } });
    expect(dbEntry!.status).toBe("draft");

    const dbCr = await db.query.wikiChangeRequests.findFirst({ where: { id: cr.id } });
    expect(dbCr!.status).toBe("changes_requested");
  });

  it("user resubmits after changes_requested — CR goes back to under_review", async () => {
    const { jwt: userJwt } = await createUserWithFarm({});
    const { jwt: modJwt, userId: modId } = await createTestUser("mod@test.com", "password123");
    await seedModerator(modId);
    const cat = await seedCategory();

    const entry = await createEntry(userJwt, cat.id);
    await addTranslation(userJwt, entry.id);
    const submitRes = await request("POST", `/v1/wiki/byId/${entry.id}/submit`, {}, userJwt);
    const cr = ((await submitRes.json()) as { data: { id: string } }).data;

    await request("POST", `/v1/wiki/changeRequests/byId/${cr.id}/requestChanges`, {}, modJwt);

    // Update the draft CR and resubmit
    const resubmitRes = await request("POST", `/v1/wiki/myChangeRequestDrafts/byId/${cr.id}/submit`, {}, userJwt);
    expect(resubmitRes.status).toBe(200);
    const resubmitBody = (await resubmitRes.json()) as { data: { status: string } };
    expect(resubmitBody.data.status).toBe("under_review");

    const db = getAdminDb();
    const dbEntry = await db.query.wikiEntries.findFirst({ where: { id: entry.id } });
    expect(dbEntry!.status).toBe("draft"); // private entry always stays draft
  });

  it("non-moderator cannot approve a CR", async () => {
    const { jwt: userJwt } = await createUserWithFarm({});
    const { jwt: otherJwt } = await createTestUser("other@test.com", "password123");
    const cat = await seedCategory();

    const entry = await createEntry(userJwt, cat.id);
    await addTranslation(userJwt, entry.id);
    const submitRes = await request("POST", `/v1/wiki/byId/${entry.id}/submit`, {}, userJwt);
    const cr = ((await submitRes.json()) as { data: { id: string } }).data;

    const res = await request("POST", `/v1/wiki/changeRequests/byId/${cr.id}/approve`, {}, otherJwt);
    expect(res.status).toBe(403);
  });

  it("farm member can see a farm-scoped entry created by another farm member in the list", async () => {
    const { jwt: ownerJwt } = await createUserWithFarm({});
    const { jwt: memberJwt } = await createFarmMember(ownerJwt, "member@test.com");
    const cat = await seedCategory();

    // Owner creates a farm-scoped entry (draft, private) — farmId comes from ctx
    const res = await request(
      "POST",
      "/v1/wiki",
      { categoryId: cat.id, translations: [{ locale: "en", title: "Farm Guide", body: "Content." }] },
      ownerJwt
    );
    expect(res.status).toBe(200);

    // Member lists wiki entries — should see the farm entry even though it's not published+public
    const listRes = await request("GET", "/v1/wiki", undefined, memberJwt);
    expect(listRes.status).toBe(200);
    const body = (await listRes.json()) as { data: { result: Array<{ id: string }>; count: number } };
    expect(body.data.count).toBe(1);
  });

  it("farm member can edit an entry created by another farm member", async () => {
    const { jwt: ownerJwt } = await createUserWithFarm({});
    const { jwt: memberJwt } = await createFarmMember(ownerJwt, "member@test.com");
    const cat = await seedCategory();

    const entry = await createEntry(ownerJwt, cat.id);

    // Farm member edits the owner's entry
    const updateRes = await request(
      "PATCH",
      `/v1/wiki/byId/${entry.id}`,
      { translations: [{ locale: "en", title: "Updated by Member", body: "Updated content." }] },
      memberJwt
    );
    expect(updateRes.status).toBe(200);

    const db = getAdminDb();
    const dbTranslations = await db.query.wikiEntryTranslations.findMany({ where: { entryId: entry.id } });
    expect(dbTranslations[0].title).toBe("Updated by Member");
  });

  it("farm member can submit an entry created by another farm member", async () => {
    const { jwt: ownerJwt } = await createUserWithFarm({});
    const { jwt: memberJwt } = await createFarmMember(ownerJwt, "member@test.com");
    const cat = await seedCategory();

    const entry = await createEntry(ownerJwt, cat.id);
    await addTranslation(ownerJwt, entry.id);

    const res = await request("POST", `/v1/wiki/byId/${entry.id}/submit`, {}, memberJwt);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { status: string } };
    expect(body.data.status).toBe("under_review");
  });

  it("user without a farm cannot create wiki entries", async () => {
    const { jwt } = await createTestUser("noFarm@test.com", "password123");
    const cat = await seedCategory();

    const res = await request(
      "POST",
      "/v1/wiki",
      { categoryId: cat.id, translations: [{ locale: "en", title: "Test", body: "" }] },
      jwt
    );
    expect(res.status).toBe(400); // farmEndpointFactory returns 400 when no farm
  });

  it("getFarmEntries returns all farm entries", async () => {
    const { jwt } = await createUserWithFarm({});
    const cat = await seedCategory();

    await createEntry(jwt, cat.id);

    const res = await request("GET", "/v1/wiki/myEntries", undefined, jwt);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { result: Array<{ status: string }>; count: number } };
    expect(body.data.count).toBe(1);
    expect(body.data.result[0].status).toBe("draft");
  });
});
