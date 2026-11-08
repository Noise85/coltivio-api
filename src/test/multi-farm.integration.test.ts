import { describe, it, expect, beforeEach } from "@jest/globals";
import { cleanDb, getAdminDb, request, rawRequest, createTestUser } from "./helpers";
import { createUserWithFarm, grantMemberWriteAccess } from "./test-utils";

/**
 * Invites an already-existing test user (not freshly created, unlike createFarmMember) to a
 * farm and accepts on their behalf. Used to build users who belong to multiple farms.
 */
async function inviteExistingUserToFarm(
  ownerJwt: string,
  targetEmail: string,
  targetJwt: string,
  farmId: string,
  role: "owner" | "member" = "member"
) {
  const inviteRes = await request("POST", "/v1/farm/invites", { email: targetEmail, role }, ownerJwt, farmId);
  expect(inviteRes.status).toBe(200);

  const db = getAdminDb();
  const invite = await db.query.farmInvites.findFirst({ where: { email: targetEmail, farmId } });
  expect(invite).toBeDefined();

  const acceptRes = await request("POST", "/v1/farm/invites/accept", { code: invite!.code }, targetJwt);
  expect(acceptRes.status).toBe(200);
}

describe("Multi-farm support", () => {
  beforeEach(cleanDb);

  it("lists all of a user's farms with the correct per-farm role", async () => {
    const owner = await createUserWithFarm({ name: "Farm A" }, "owner@test.com");
    const { jwt: memberJwt, userId: memberId } = await createTestUser("member@test.com", "password123");
    await inviteExistingUserToFarm(owner.jwt, "member@test.com", memberJwt, owner.farmId, "member");

    // Give the member their own second farm too
    const secondFarmRes = await request(
      "POST",
      "/v1/farm",
      { name: "Farm B", address: "Elsewhere", location: { type: "Point", coordinates: [9.0, 46.0] } },
      memberJwt
    );
    expect(secondFarmRes.status).toBe(200);
    const secondFarm = (await secondFarmRes.json()) as { data: { id: string } };

    const res = await request("GET", "/v1/farms", undefined, memberJwt);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { result: { id: string; role: string }[]; count: number } };
    expect(body.data.count).toBe(2);
    const byId = new Map(body.data.result.map((f) => [f.id, f.role]));
    expect(byId.get(owner.farmId)).toBe("member");
    expect(byId.get(secondFarm.data.id)).toBe("owner");
    void memberId;
  });

  it("requires the x-farm-id header once a user belongs to 2+ farms, but auto-defaults with only one", async () => {
    const owner = await createUserWithFarm({ name: "Farm A" }, "owner2@test.com");

    // Single-farm: no header needed, matches today's behavior exactly.
    const soloRes = await request("GET", "/v1/farm", undefined, owner.jwt);
    expect(soloRes.status).toBe(200);

    // Add a second farm for the same user.
    const secondFarmRes = await request(
      "POST",
      "/v1/farm",
      { name: "Farm A2", address: "Nowhere", location: { type: "Point", coordinates: [9.5, 46.5] } },
      owner.jwt
    );
    expect(secondFarmRes.status).toBe(200);

    // Now ambiguous without a header.
    const ambiguousRes = await request("GET", "/v1/farm", undefined, owner.jwt);
    expect(ambiguousRes.status).toBe(400);
    const ambiguousBody = (await ambiguousRes.json()) as { error: string };
    expect(ambiguousBody.error).toContain("X-Farm-Id");
  });

  it("user with 0 farms still gets the unchanged 'no farm' error", async () => {
    const { jwt } = await createTestUser("nofarm2@test.com", "password123");
    const res = await request("GET", "/v1/plots", undefined, jwt);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("no farm");
  });

  it("isolates data between two farms owned by the same user, switched via header", async () => {
    const owner = await createUserWithFarm({ name: "Farm A" }, "switcher@test.com");
    const secondFarmRes = await request(
      "POST",
      "/v1/farm",
      { name: "Farm B", address: "Over there", location: { type: "Point", coordinates: [10.0, 45.0] } },
      owner.jwt
    );
    const farmB = ((await secondFarmRes.json()) as { data: { id: string } }).data.id;

    const cropARes = await request(
      "POST",
      "/v1/crops",
      { name: "Wheat A", category: "grain" },
      owner.jwt,
      owner.farmId
    );
    expect(cropARes.status).toBe(200);
    const cropBRes = await request("POST", "/v1/crops", { name: "Wheat B", category: "grain" }, owner.jwt, farmB);
    expect(cropBRes.status).toBe(200);

    // Both farms also carry the auto-created "natural meadow" default crop (see farms.ts
    // createFarm), so assert containment of our own crop plus absence of the other farm's,
    // rather than an exact list match.
    const listARes = await request("GET", "/v1/crops", undefined, owner.jwt, owner.farmId);
    const listA = (await listARes.json()) as { data: { result: { name: string }[] } };
    const namesA = listA.data.result.map((c) => c.name);
    expect(namesA).toContain("Wheat A");
    expect(namesA).not.toContain("Wheat B");

    const listBRes = await request("GET", "/v1/crops", undefined, owner.jwt, farmB);
    const listB = (await listBRes.json()) as { data: { result: { name: string }[] } };
    const namesB = listB.data.result.map((c) => c.name);
    expect(namesB).toContain("Wheat B");
    expect(namesB).not.toContain("Wheat A");
  });

  it("rejects an x-farm-id header for a farm the user is not a member of", async () => {
    const userA = await createUserWithFarm({ name: "Farm A" }, "isofarma@test.com");
    const userB = await createUserWithFarm({ name: "Farm B" }, "isofarmb@test.com");

    const res = await request("GET", "/v1/farm", undefined, userA.jwt, userB.farmId);
    expect(res.status).toBe(403);
  });

  it("lets a client with a stale x-farm-id recover via the non-farm endpoints", async () => {
    const userA = await createUserWithFarm({ name: "Farm A" }, "stalefarma@test.com");
    const userB = await createUserWithFarm({ name: "Farm B" }, "stalefarmb@test.com");

    // Listing farms must work despite the bad header — this is how the client discovers a valid one.
    const listRes = await request("GET", "/v1/farms", undefined, userA.jwt, userB.farmId);
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as { data: { result: { id: string }[]; count: number } };
    expect(listBody.data.count).toBe(1);
    expect(listBody.data.result[0].id).toBe(userA.farmId);

    // /me reports no farm rather than rejecting, which is the client's signal to re-select one.
    const meRes = await request("GET", "/v1/me", undefined, userA.jwt, userB.farmId);
    expect(meRes.status).toBe(200);
    const meBody = (await meRes.json()) as { data: { farmId: string | null; farmRole: string | null } };
    expect(meBody.data.farmId).toBeNull();
    expect(meBody.data.farmRole).toBeNull();

    // Farm-scoped endpoints still reject, with no fallback to the user's own farm.
    const farmRes = await request("GET", "/v1/farm", undefined, userA.jwt, userB.farmId);
    expect(farmRes.status).toBe(403);
  });

  it("enforces per-farm role: owner on one farm, member on another", async () => {
    const ownerOfA = await createUserWithFarm({ name: "Farm A" }, "roleownera@test.com");
    const { jwt: userJwt } = await createTestUser("roleuser@test.com", "password123");

    // userJwt creates and owns their own farm...
    const ownFarmRes = await request(
      "POST",
      "/v1/farm",
      { name: "Own Farm", address: "Home", location: { type: "Point", coordinates: [7.0, 47.0] } },
      userJwt
    );
    const ownFarmId = ((await ownFarmRes.json()) as { data: { id: string } }).data.id;

    // ...but is only a member on Farm A.
    await inviteExistingUserToFarm(ownerOfA.jwt, "roleuser@test.com", userJwt, ownerOfA.farmId, "member");

    const updateOwnFarm = await request("PATCH", "/v1/farm", { name: "Renamed" }, userJwt, ownFarmId);
    expect(updateOwnFarm.status).toBe(200);

    const updateOtherFarm = await request("PATCH", "/v1/farm", { name: "Hacked" }, userJwt, ownerOfA.farmId);
    expect(updateOtherFarm.status).toBe(403);
  });

  it("scopes farmMemberPermissions per farm, not just per user", async () => {
    const ownerA = await createUserWithFarm({ name: "Farm A" }, "permownera@test.com", { withActiveMembership: true });
    const ownerB = await createUserWithFarm({ name: "Farm B" }, "permownerb@test.com", { withActiveMembership: true });
    const { jwt: memberJwt, userId: memberId } = await createTestUser("permmember@test.com", "password123");

    await inviteExistingUserToFarm(ownerA.jwt, "permmember@test.com", memberJwt, ownerA.farmId, "member");
    await inviteExistingUserToFarm(ownerB.jwt, "permmember@test.com", memberJwt, ownerB.farmId, "member");

    await grantMemberWriteAccess(ownerA.jwt, memberId, "animals");

    const createOnA = await request(
      "POST",
      "/v1/animals",
      {
        name: "Bella",
        type: "cow",
        sex: "female",
        dateOfBirth: "2020-01-15",
        registered: true,
        usage: "milk",
      },
      memberJwt,
      ownerA.farmId
    );
    expect(createOnA.status).toBe(200);

    const createOnB = await request(
      "POST",
      "/v1/animals",
      {
        name: "Bella",
        type: "cow",
        sex: "female",
        dateOfBirth: "2020-01-15",
        registered: true,
        usage: "milk",
      },
      memberJwt,
      ownerB.farmId
    );
    expect(createOnB.status).toBe(403);
  });

  it("allows accepting a farm invite while already owning another farm", async () => {
    const ownerA = await createUserWithFarm({ name: "Farm A" }, "multiownera@test.com");
    const other = await createUserWithFarm({ name: "Other Farm" }, "multiother@test.com");

    await inviteExistingUserToFarm(ownerA.jwt, "multiother@test.com", other.jwt, ownerA.farmId, "member");

    const db = getAdminDb();
    const memberships = await db.query.farmMembers.findMany({ where: { userId: other.userId } });
    expect(memberships).toHaveLength(2);
  });

  it("still rejects accepting an invite to a farm you're already a member of", async () => {
    const owner = await createUserWithFarm({ name: "Farm A" }, "dupowner@test.com");
    const { jwt: memberJwt, userId: memberId } = await createTestUser("dupmember@test.com", "password123");
    await inviteExistingUserToFarm(owner.jwt, "dupmember@test.com", memberJwt, owner.farmId, "member");

    // Owner invites the same (already-member) email again
    const inviteRes = await request("POST", "/v1/farm/invites", { email: "dupmember@test.com" }, owner.jwt);
    expect(inviteRes.status).toBe(409);
    void memberId;
  });

  it("kicking a member removes only that farm's membership and permission rows", async () => {
    const ownerA = await createUserWithFarm({ name: "Farm A" }, "kickownera@test.com", { withActiveMembership: true });
    const ownerB = await createUserWithFarm({ name: "Farm B" }, "kickownerb@test.com", { withActiveMembership: true });
    const { jwt: memberJwt, userId: memberId } = await createTestUser("kickmember@test.com", "password123");

    await inviteExistingUserToFarm(ownerA.jwt, "kickmember@test.com", memberJwt, ownerA.farmId, "member");
    await inviteExistingUserToFarm(ownerB.jwt, "kickmember@test.com", memberJwt, ownerB.farmId, "member");
    await grantMemberWriteAccess(ownerA.jwt, memberId, "animals");
    await grantMemberWriteAccess(ownerB.jwt, memberId, "animals");

    const kickRes = await request("DELETE", `/v1/farm/members/byId/${memberId}`, undefined, ownerA.jwt, ownerA.farmId);
    expect(kickRes.status).toBe(200);

    const db = getAdminDb();
    const memberships = await db.query.farmMembers.findMany({ where: { userId: memberId } });
    expect(memberships).toHaveLength(1);
    expect(memberships[0].farmId).toBe(ownerB.farmId);

    const permissions = await db.query.farmMemberPermissions.findMany({ where: { userId: memberId } });
    expect(permissions.every((p) => p.farmId === ownerB.farmId)).toBe(true);
    expect(permissions.some((p) => p.farmId === ownerA.farmId)).toBe(false);
  });

  it("rejects a malformed x-farm-id header with 400, not a 500", async () => {
    const { jwt } = await createTestUser("malformed@test.com", "password123");
    const res = await rawRequest("GET", "/v1/me", {
      headers: { Authorization: `Bearer ${jwt}`, "x-farm-id": "not-a-uuid" },
    });
    expect(res.status).toBe(400);
  });

  it("a plain member can leave a farm on their own, keeping their other farms intact", async () => {
    const owner = await createUserWithFarm({ name: "Farm A" }, "leavemembera@test.com");
    const { jwt: memberJwt, userId: memberId } = await createUserWithFarm({ name: "Farm B" }, "leavememberb@test.com");
    await inviteExistingUserToFarm(owner.jwt, "leavememberb@test.com", memberJwt, owner.farmId, "member");
    await grantMemberWriteAccess(owner.jwt, memberId, "animals");

    const leaveRes = await request("DELETE", "/v1/farm/members/me", undefined, memberJwt, owner.farmId);
    expect(leaveRes.status).toBe(200);

    const db = getAdminDb();
    const memberships = await db.query.farmMembers.findMany({ where: { userId: memberId } });
    expect(memberships).toHaveLength(1);
    expect(memberships[0].farmId).not.toBe(owner.farmId); // still in their own Farm B

    const permissions = await db.query.farmMemberPermissions.findMany({
      where: { farmId: owner.farmId, userId: memberId },
    });
    expect(permissions).toHaveLength(0);
  });

  it("an owner can leave a farm when another owner remains", async () => {
    const ownerA = await createUserWithFarm({ name: "Farm A" }, "leaveownera@test.com");
    const { jwt: ownerBJwt, userId: ownerBId } = await createTestUser("leaveownerb@test.com", "password123");
    await inviteExistingUserToFarm(ownerA.jwt, "leaveownerb@test.com", ownerBJwt, ownerA.farmId, "owner");

    const leaveRes = await request("DELETE", "/v1/farm/members/me", undefined, ownerA.jwt, ownerA.farmId);
    expect(leaveRes.status).toBe(200);

    const db = getAdminDb();
    expect(await db.query.farmMembers.findFirst({ where: { userId: ownerA.userId } })).toBeUndefined();
    const remaining = await db.query.farmMembers.findFirst({ where: { userId: ownerBId } });
    expect(remaining?.role).toBe("owner");
    // The farm itself is untouched, just ownerA's membership is gone.
    expect(await db.query.farms.findFirst({ where: { id: ownerA.farmId } })).toBeDefined();
  });
});
