import { describe, it, expect, beforeEach } from "@jest/globals";
import { cleanDb, createTestUser, getAdminDb, request } from "./helpers";
import {
  createFarmMember,
  createFertilizer,
  createFertilizerApplication,
  createPlot,
  createUserWithFarm,
} from "./test-utils";
import { eq } from "drizzle-orm";
import { membershipPayments } from "../db/schema";

type PreviewFarm = {
  id: string;
  name: string;
  outcome: "leave" | "delete";
};

async function getPreview(jwt: string): Promise<PreviewFarm[]> {
  const res = await request("GET", "/v1/me/deletion-preview", undefined, jwt);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { data: { farms: PreviewFarm[] } };
  return body.data.farms;
}

function deleteAccount(jwt: string, email: string) {
  return request("POST", "/v1/me/deletion", { email }, jwt);
}

async function createSecondFarm(jwt: string, name: string): Promise<string> {
  const res = await request(
    "POST",
    "/v1/farm",
    { name, address: "Elsewhere", location: { type: "Point", coordinates: [9.0, 46.5] } },
    jwt
  );
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: { id: string } }).data.id;
}

describe("Account deletion", () => {
  beforeEach(cleanDb);

  it("previews what happens to each farm", async () => {
    // Sole owner of "Shared" with a member: goes with the account all the same
    const user = await createUserWithFarm({ name: "Shared" }, "preview-user@test.com");
    await createFarmMember(user.jwt, "preview-member@test.com");
    // Alone on "Solo": goes with the account
    const soloFarmId = await createSecondFarm(user.jwt, "Solo");
    // Plain member of someone else's farm: just drops out
    const other = await createUserWithFarm({ name: "Other" }, "preview-other@test.com");
    const inviteRes = await request(
      "POST",
      "/v1/farm/invites",
      { email: "preview-user@test.com", role: "member" },
      other.jwt
    );
    expect(inviteRes.status).toBe(200);
    const invite = await getAdminDb().query.farmInvites.findFirst({ where: { farmId: other.farmId } });
    expect((await request("POST", "/v1/farm/invites/accept", { code: invite!.code }, user.jwt)).status).toBe(200);

    const preview = await getPreview(user.jwt);
    const byName = Object.fromEntries(preview.map((farm) => [farm.name, farm]));

    expect(byName["Solo"]).toEqual({ id: soloFarmId, name: "Solo", outcome: "delete" });
    expect(byName["Other"]).toEqual({ id: other.farmId, name: "Other", outcome: "leave" });
    expect(byName["Shared"]).toEqual({ id: user.farmId, name: "Shared", outcome: "delete" });
  });

  it("deletes solely owned farms, leaves co-owned ones, then removes the account", async () => {
    const user = await createUserWithFarm({ name: "Shared" }, "full-user@test.com");
    const member = await createFarmMember(user.jwt, "full-member@test.com");
    const soloFarmId = await createSecondFarm(user.jwt, "Solo");
    const coOwned = await createUserWithFarm({ name: "Co-owned" }, "full-coowner@test.com");
    const inviteRes = await request(
      "POST",
      "/v1/farm/invites",
      { email: "full-user@test.com", role: "owner" },
      coOwned.jwt
    );
    expect(inviteRes.status).toBe(200);
    const invite = await getAdminDb().query.farmInvites.findFirst({ where: { farmId: coOwned.farmId } });
    expect((await request("POST", "/v1/farm/invites/accept", { code: invite!.code }, user.jwt)).status).toBe(200);

    const res = await deleteAccount(user.jwt, "Full-User@test.com ");
    expect(res.status).toBe(200);

    const db = getAdminDb();
    expect(await db.query.profiles.findFirst({ where: { id: user.userId } })).toBeUndefined();
    expect(await db.query.farms.findFirst({ where: { id: soloFarmId } })).toBeUndefined();
    expect(await db.query.farms.findFirst({ where: { id: user.farmId } })).toBeUndefined();
    // The other member of the deleted farm keeps their account
    expect(await db.query.profiles.findFirst({ where: { id: member.userId } })).toBeDefined();
    expect(await db.query.farms.findFirst({ where: { id: coOwned.farmId } })).toBeDefined();
    expect(await db.query.farmMembers.findMany({ where: { userId: user.userId } })).toHaveLength(0);
  });

  it("deletes an account without any farm", async () => {
    const { jwt, userId } = await createTestUser("nofarm@test.com", "password123");
    expect(await getPreview(jwt)).toEqual([]);

    expect((await deleteAccount(jwt, "nofarm@test.com")).status).toBe(200);
    expect(await getAdminDb().query.profiles.findFirst({ where: { id: userId } })).toBeUndefined();
  });

  it("rejects a mismatching confirmation email", async () => {
    const user = await createUserWithFarm({ name: "Solo" }, "wrongmail@test.com");

    expect((await deleteAccount(user.jwt, "someone-else@test.com")).status).toBe(400);
    expect(await getAdminDb().query.profiles.findFirst({ where: { id: user.userId } })).toBeDefined();
  });

  it("keeps the deleted user's content without an author", async () => {
    const owner = await createUserWithFarm({ name: "Kept" }, "content-owner@test.com", {
      withActiveMembership: true,
    });
    const author = await createFarmMember(owner.jwt, "content-author@test.com", {
      role: "owner",
      withActiveMembership: true,
    });
    const db = getAdminDb();
    await db
      .update(membershipPayments)
      .set({ cardBrand: "visa", cardLast4: "4242", cardExpMonth: 12, cardExpYear: 2030 })
      .where(eq(membershipPayments.userId, author.userId));

    // Farm records written by the author, e.g. for the farm inspection
    const plot = await createPlot(author.jwt);
    const fertilizer = await createFertilizer(author.jwt);
    const [application] = await createFertilizerApplication(author.jwt, plot.id, fertilizer.id);

    const threadRes = await request(
      "POST",
      "/v1/forum/threads",
      { title: "Kept thread", body: "Still here", type: "general" },
      author.jwt
    );
    expect(threadRes.status).toBe(200);
    const thread = ((await threadRes.json()) as { data: { id: string } }).data;
    const replyRes = await request(
      "POST",
      `/v1/forum/threads/byId/${thread.id}/replies`,
      { body: "Kept reply" },
      author.jwt
    );
    expect(replyRes.status).toBe(200);

    expect((await deleteAccount(author.jwt, "content-author@test.com")).status).toBe(200);

    const keptApplication = await db.query.fertilizerApplications.findFirst({ where: { id: application.id } });
    expect(keptApplication?.createdBy).toBeNull();

    const payments = await db.query.membershipPayments.findMany({ where: { userId: { isNull: true } } });
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({ cardBrand: null, cardLast4: null, cardExpMonth: null, cardExpYear: null });

    const listRes = await request("GET", "/v1/forum/threads", undefined, owner.jwt);
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as { data: { result: { id: string; creator: unknown }[] } };
    expect(list.data.result).toEqual([expect.objectContaining({ id: thread.id, createdBy: null, creator: null })]);

    const detailRes = await request("GET", `/v1/forum/threads/byId/${thread.id}`, undefined, owner.jwt);
    expect(detailRes.status).toBe(200);

    const repliesRes = await request("GET", `/v1/forum/threads/byId/${thread.id}/replies`, undefined, owner.jwt);
    expect(repliesRes.status).toBe(200);
    const replies = (await repliesRes.json()) as { data: unknown };
    expect(JSON.stringify(replies)).toContain("Kept reply");
    expect(JSON.stringify(replies)).toContain('"creator":null');
  });
});
