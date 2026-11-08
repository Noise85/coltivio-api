import { describe, it, expect, beforeEach } from "@jest/globals";
import { cleanDb, createTestUser, getAdminDb, request } from "./helpers";
import { createUserWithFarm, grantMemberWriteAccess } from "./test-utils";
import { farmMemberPermissions } from "../db/schema";

/**
 * Invites an already-existing test user (not freshly created, unlike createFarmMember) to a
 * farm and accepts on their behalf. Used to build users who belong to multiple farms.
 * Emails must be lowercase — GoTrue normalizes profile emails to lowercase, and invite
 * acceptance does an exact-match check against the stored (unnormalized) invite email.
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

describe("Multi-farm security", () => {
  beforeEach(cleanDb);

  // ---------------------------------------------------------------------------
  // Cross-farm targeting: owner of Farm A must not be able to affect a user's
  // membership/permissions on Farm B just by knowing their user id.
  // ---------------------------------------------------------------------------

  it("owner cannot kick a user who is only a member of a different farm", async () => {
    const ownerA = await createUserWithFarm({ name: "Farm A" }, "kicksecownera@test.com");
    const outsider = await createUserWithFarm({ name: "Farm B" }, "kicksecoutsider@test.com");

    const res = await request(
      "DELETE",
      `/v1/farm/members/byId/${outsider.userId}`,
      undefined,
      ownerA.jwt,
      ownerA.farmId
    );
    expect(res.status).toBe(404);

    // Outsider's own farm membership is untouched
    const db = getAdminDb();
    const membership = await db.query.farmMembers.findFirst({ where: { userId: outsider.userId } });
    expect(membership?.farmId).toBe(outsider.farmId);
  });

  it("owner cannot change the role of a user who is only a member of a different farm", async () => {
    const ownerA = await createUserWithFarm({ name: "Farm A" }, "rolesecownera@test.com");
    const outsider = await createUserWithFarm({ name: "Farm B" }, "rolesecoutsider@test.com");

    const res = await request(
      "PATCH",
      `/v1/farm/members/byId/${outsider.userId}/role`,
      { role: "owner" },
      ownerA.jwt,
      ownerA.farmId
    );
    expect(res.status).toBe(404);

    const db = getAdminDb();
    const membership = await db.query.farmMembers.findFirst({ where: { userId: outsider.userId } });
    expect(membership?.role).toBe("owner"); // unchanged (still owner of their own farm)
    expect(membership?.farmId).toBe(outsider.farmId);
  });

  it("owner cannot grant feature permissions to a user who is not a member of their farm", async () => {
    const ownerA = await createUserWithFarm({ name: "Farm A" }, "grantsecownera@test.com");
    const outsider = await createUserWithFarm({ name: "Farm B" }, "grantsecoutsider@test.com");

    const res = await request(
      "PUT",
      `/v1/farm/members/byId/${outsider.userId}/permissions/byFeature/animals`,
      { access: "write" },
      ownerA.jwt,
      ownerA.farmId
    );
    expect(res.status).toBe(404);

    const db = getAdminDb();
    const rows = await db.query.farmMemberPermissions.findMany({ where: { userId: outsider.userId } });
    expect(rows.every((r) => r.farmId !== ownerA.farmId)).toBe(true);
  });

  it("owner cannot reset feature permissions for a user who is not a member of their farm", async () => {
    const ownerA = await createUserWithFarm({ name: "Farm A" }, "resetsecownera@test.com");
    const outsider = await createUserWithFarm({ name: "Farm B" }, "resetsecoutsider@test.com");

    const res = await request(
      "DELETE",
      `/v1/farm/members/byId/${outsider.userId}/permissions/byFeature/animals`,
      undefined,
      ownerA.jwt,
      ownerA.farmId
    );
    expect(res.status).toBe(404);
  });

  it(
    "accepting an invite still succeeds cleanly (no 500) even if a stale permission row " +
      "already exists for that (farm, user, feature)",
    async () => {
      const owner = await createUserWithFarm({ name: "Farm A" }, "staleowner@test.com");
      const { jwt: memberJwt, userId: memberId } = await createTestUser("stalemember@test.com", "password123");

      // Simulate a stray/stale row directly (the exact scenario the app-layer 404 above now
      // prevents going forward, but defense in depth should still hold if one exists anyway —
      // e.g. left over from before the membership check existed, or restored from a backup).
      const db = getAdminDb();
      await db
        .insert(farmMemberPermissions)
        .values({ farmId: owner.farmId, userId: memberId, feature: "animals", access: "read" });

      const inviteRes = await request("POST", "/v1/farm/invites", { email: "stalemember@test.com" }, owner.jwt);
      expect(inviteRes.status).toBe(200);
      const invite = await db.query.farmInvites.findFirst({ where: { email: "stalemember@test.com" } });

      const acceptRes = await request("POST", "/v1/farm/invites/accept", { code: invite!.code }, memberJwt);
      expect(acceptRes.status).toBe(200);

      // The stale grant should have been overwritten by the invite's own (default "none") grant,
      // not silently left in place, and not duplicated.
      const rows = await db.query.farmMemberPermissions.findMany({
        where: { farmId: owner.farmId, userId: memberId, feature: "animals" },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].access).toBe("none");
    }
  );

  // ---------------------------------------------------------------------------
  // Profile visibility must track the caller's *current active* farm, not any farm the
  // caller and target have ever shared.
  // ---------------------------------------------------------------------------

  it("profile is readable via a shared farm but not via a farm the target doesn't belong to", async () => {
    const viewer = await createUserWithFarm({ name: "Shared Farm" }, "viewerprofile@test.com");
    const { jwt: targetJwt, userId: targetId } = await createUserWithFarm(
      { name: "Target's Own Farm" },
      "targetprofile@test.com"
    );

    // Viewer creates a second farm the target is never invited to.
    const soloFarmRes = await request(
      "POST",
      "/v1/farm",
      { name: "Viewer Solo Farm", address: "Nowhere", location: { type: "Point", coordinates: [11.0, 44.0] } },
      viewer.jwt
    );
    const soloFarmId = ((await soloFarmRes.json()) as { data: { id: string } }).data.id;

    // Bring the target into the viewer's *shared* farm.
    await inviteExistingUserToFarm(viewer.jwt, "targetprofile@test.com", targetJwt, viewer.farmId, "member");

    // Readable when the viewer's active farm is the one they actually share.
    const okRes = await request("GET", `/v1/users/byId/${targetId}`, undefined, viewer.jwt, viewer.farmId);
    expect(okRes.status).toBe(200);

    // Not readable when the viewer switches to a farm the target isn't in, even though the two
    // have shared a farm before / still do elsewhere.
    const blockedRes = await request("GET", `/v1/users/byId/${targetId}`, undefined, viewer.jwt, soloFarmId);
    expect(blockedRes.status).toBe(404);
  });

  // ---------------------------------------------------------------------------
  // Revocation: kicking a member must immediately invalidate their access to that farm,
  // even though their JWT is still otherwise valid.
  // ---------------------------------------------------------------------------

  it("a kicked member's farm header is rejected immediately after being kicked", async () => {
    const owner = await createUserWithFarm({ name: "Farm A" }, "revokeowner@test.com", {
      withActiveMembership: true,
    });
    const { jwt: memberJwt, userId: memberId } = await createTestUser("revokemember@test.com", "password123");
    await inviteExistingUserToFarm(owner.jwt, "revokemember@test.com", memberJwt, owner.farmId, "member");

    const kickRes = await request("DELETE", `/v1/farm/members/byId/${memberId}`, undefined, owner.jwt, owner.farmId);
    expect(kickRes.status).toBe(200);

    const afterKickRes = await request("GET", "/v1/farm", undefined, memberJwt, owner.farmId);
    expect(afterKickRes.status).toBe(403);
  });

  // ---------------------------------------------------------------------------
  // The dropped profiles.farmId/farmRole columns must not be resurrectable via input.
  // ---------------------------------------------------------------------------

  it("PATCH /v1/me silently ignores an attempt to smuggle farmId/farmRole in the body", async () => {
    const user = await createUserWithFarm({ name: "Farm A" }, "smuggle@test.com");

    const res = await request(
      "PATCH",
      "/v1/me",
      { fullName: "Still Me", farmId: "00000000-0000-0000-0000-000000000000", farmRole: "owner" } as Record<
        string,
        unknown
      >,
      user.jwt
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { fullName: string; farmId: string } };
    expect(body.data.fullName).toBe("Still Me");
    // farmId in the response reflects the real resolved active farm, not the smuggled value
    expect(body.data.farmId).toBe(user.farmId);
  });

  // ---------------------------------------------------------------------------
  // Permission listing must stay scoped to the caller's current active farm even when the
  // target user has permission rows on multiple farms.
  // ---------------------------------------------------------------------------

  it("listing a member's permissions never leaks rows from the caller's other farm", async () => {
    const ownerA = await createUserWithFarm({ name: "Farm A" }, "listpermownera@test.com", {
      withActiveMembership: true,
    });
    const ownerB = await createUserWithFarm({ name: "Farm B" }, "listpermownerb@test.com", {
      withActiveMembership: true,
    });
    const { jwt: memberJwt, userId: memberId } = await createTestUser("listpermmember@test.com", "password123");

    await inviteExistingUserToFarm(ownerA.jwt, "listpermmember@test.com", memberJwt, ownerA.farmId, "member");
    await inviteExistingUserToFarm(ownerB.jwt, "listpermmember@test.com", memberJwt, ownerB.farmId, "member");
    await grantMemberWriteAccess(ownerA.jwt, memberId, "animals");
    await grantMemberWriteAccess(ownerB.jwt, memberId, "tasks");

    const resA = await request(
      "GET",
      `/v1/farm/members/byId/${memberId}/permissions`,
      undefined,
      ownerA.jwt,
      ownerA.farmId
    );
    expect(resA.status).toBe(200);
    const bodyA = (await resA.json()) as { data: { result: { farmId: string; feature: string }[] } };
    expect(bodyA.data.result.every((r) => r.farmId === ownerA.farmId)).toBe(true);
    expect(bodyA.data.result.some((r) => r.feature === "tasks" && r.farmId === ownerB.farmId)).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Pre-existing invariant, re-verified after the farm_members rewrite: the last owner of a
  // farm can't be kicked or demoted, leaving the farm ownerless.
  // ---------------------------------------------------------------------------

  it("cannot kick the only owner of a farm", async () => {
    const owner = await createUserWithFarm({ name: "Farm A" }, "onlyownerkick@test.com");
    const res = await request("DELETE", `/v1/farm/members/byId/${owner.userId}`, undefined, owner.jwt, owner.farmId);
    expect(res.status).toBe(400);
  });

  it("cannot demote the only owner of a farm", async () => {
    const owner = await createUserWithFarm({ name: "Farm A" }, "onlyownerdemote@test.com");
    const res = await request(
      "PATCH",
      `/v1/farm/members/byId/${owner.userId}/role`,
      { role: "member" },
      owner.jwt,
      owner.farmId
    );
    expect(res.status).toBe(400);
  });

  it("the only owner of a farm cannot leave it", async () => {
    const owner = await createUserWithFarm({ name: "Farm A" }, "onlyownerleave@test.com");
    const res = await request("DELETE", "/v1/farm/members/me", undefined, owner.jwt, owner.farmId);
    expect(res.status).toBe(400);

    const db = getAdminDb();
    const membership = await db.query.farmMembers.findFirst({ where: { userId: owner.userId } });
    expect(membership).toBeDefined();
  });

  // ---------------------------------------------------------------------------
  // Deleting your account through one farm's "delete farm + account" flow must not be able to
  // strand or orphan a completely different farm you also own.
  // ---------------------------------------------------------------------------

  it("blocks account deletion if the user is the sole owner of another farm", async () => {
    const user = await createUserWithFarm({ name: "Farm A" }, "deleteguarda@test.com");
    const secondFarmRes = await request(
      "POST",
      "/v1/farm",
      { name: "Farm B", address: "Elsewhere", location: { type: "Point", coordinates: [12.0, 43.0] } },
      user.jwt
    );
    const farmB = ((await secondFarmRes.json()) as { data: { id: string } }).data.id;

    const res = await request("DELETE", "/v1/farm?deleteAccount=true", undefined, user.jwt, user.farmId);
    expect(res.status).toBe(409);

    // Nothing was deleted: neither Farm A (the one targeted) nor the account.
    const db = getAdminDb();
    const farmARow = await db.query.farms.findFirst({ where: { id: user.farmId } });
    expect(farmARow).toBeDefined();
    const farmBRow = await db.query.farms.findFirst({ where: { id: farmB } });
    expect(farmBRow).toBeDefined();
    const profile = await db.query.profiles.findFirst({ where: { id: user.userId } });
    expect(profile).toBeDefined();
  });

  it("allows account deletion when the other farm still has a remaining owner", async () => {
    const user = await createUserWithFarm({ name: "Farm A" }, "deleteallowa@test.com");
    const coOwner = await createUserWithFarm({ name: "Farm B" }, "deletecoowner@test.com");
    await inviteExistingUserToFarm(coOwner.jwt, "deleteallowa@test.com", user.jwt, coOwner.farmId, "owner");

    const res = await request("DELETE", "/v1/farm?deleteAccount=true", undefined, user.jwt, user.farmId);
    expect(res.status).toBe(200);

    const db = getAdminDb();
    expect(await db.query.farms.findFirst({ where: { id: user.farmId } })).toBeUndefined();
    expect(await db.query.profiles.findFirst({ where: { id: user.userId } })).toBeUndefined();
    // Farm B survives with its remaining owner untouched.
    const farmBRow = await db.query.farms.findFirst({ where: { id: coOwner.farmId } });
    expect(farmBRow).toBeDefined();
    const remainingMembership = await db.query.farmMembers.findFirst({ where: { userId: coOwner.userId } });
    expect(remainingMembership?.role).toBe("owner");
  });

  it("allows account deletion when the user is only a plain member of the other farm", async () => {
    const otherOwner = await createUserWithFarm({ name: "Farm B" }, "deleteotherowner@test.com");
    const user = await createUserWithFarm({ name: "Farm A" }, "deleteallowb@test.com");
    await inviteExistingUserToFarm(otherOwner.jwt, "deleteallowb@test.com", user.jwt, otherOwner.farmId, "member");

    const res = await request("DELETE", "/v1/farm?deleteAccount=true", undefined, user.jwt, user.farmId);
    expect(res.status).toBe(200);

    const db = getAdminDb();
    expect(await db.query.profiles.findFirst({ where: { id: user.userId } })).toBeUndefined();
    // Farm B is untouched — still owned by otherOwner, this user's membership row is just gone.
    const farmBRow = await db.query.farms.findFirst({ where: { id: otherOwner.farmId } });
    expect(farmBRow).toBeDefined();
    const staleMembership = await db.query.farmMembers.findFirst({
      where: { farmId: otherOwner.farmId, userId: user.userId },
    });
    expect(staleMembership).toBeUndefined();
  });
});
