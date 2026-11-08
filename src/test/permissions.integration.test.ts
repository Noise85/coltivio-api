import { describe, it, expect, beforeEach } from "@jest/globals";

import { cleanDb, request } from "./helpers";
import { createUserWithFarm, createFarmMember, grantMemberWriteAccess } from "./test-utils";

const ALL_FEATURES = ["animals", "field_calendar", "commerce", "tasks"] as const;

const NEW_ANIMAL = {
  name: "Bella",
  type: "cow",
  sex: "female",
  dateOfBirth: "2022-01-01",
  usage: "milk",
  registered: true,
};

// ---------------------------------------------------------------------------
// Invite-based permission initialisation
// ---------------------------------------------------------------------------
describe("Invite permissions", () => {
  beforeEach(cleanDb);

  it("accepting invite without permissions initialises all features to none", async () => {
    const { jwt: ownerJwt } = await createUserWithFarm({}, undefined, { withActiveMembership: true });
    const { userId: memberId } = await createFarmMember(ownerJwt, "member@test.com");

    const res = await request("GET", `/v1/farm/members/byId/${memberId}/permissions`, undefined, ownerJwt);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { result: Array<{ feature: string; access: string }> } };
    expect(body.data.result).toHaveLength(ALL_FEATURES.length);
    expect(body.data.result.every((p) => p.access === "none")).toBe(true);
  });

  it("accepting invite with permissions sets correct access, rest default to none", async () => {
    const { jwt: ownerJwt } = await createUserWithFarm({}, undefined, { withActiveMembership: true });
    const { userId: memberId } = await createFarmMember(ownerJwt, "member@test.com", {
      permissions: [
        { feature: "animals", access: "write" },
        { feature: "field_calendar", access: "read" },
      ],
    });

    const res = await request("GET", `/v1/farm/members/byId/${memberId}/permissions`, undefined, ownerJwt);
    const body = (await res.json()) as { data: { result: Array<{ feature: string; access: string }> } };
    const permMap = Object.fromEntries(body.data.result.map((p) => [p.feature, p.access]));

    expect(permMap["animals"]).toBe("write");
    expect(permMap["field_calendar"]).toBe("read");
    // Everything else is "none"
    ALL_FEATURES.filter((f) => f !== "animals" && f !== "field_calendar").forEach((f) => {
      expect(permMap[f]).toBe("none");
    });
  });

  it("GET /me returns farmPermissions for the current user", async () => {
    const { jwt: ownerJwt } = await createUserWithFarm({}, undefined, { withActiveMembership: true });
    const { jwt: memberJwt } = await createFarmMember(ownerJwt, "member@test.com", {
      permissions: [{ feature: "animals", access: "write" }],
    });

    const res = await request("GET", "/v1/me", undefined, memberJwt);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { farmPermissions: Array<{ feature: string; access: string }> };
    };
    const animalsPermission = body.data.farmPermissions.find((p) => p.feature === "animals");
    expect(animalsPermission?.access).toBe("write");
  });
});

// ---------------------------------------------------------------------------
// Permission management endpoints
// ---------------------------------------------------------------------------
describe("Permission management", () => {
  beforeEach(cleanDb);

  it("owner can update a member's permission for a feature", async () => {
    const { jwt: ownerJwt } = await createUserWithFarm({}, undefined, { withActiveMembership: true });
    const { userId: memberId } = await createFarmMember(ownerJwt, "member@test.com");

    const res = await request(
      "PUT",
      `/v1/farm/members/byId/${memberId}/permissions/byFeature/animals`,
      { access: "write" },
      ownerJwt
    );
    expect(res.status).toBe(200);

    const listRes = await request("GET", `/v1/farm/members/byId/${memberId}/permissions`, undefined, ownerJwt);
    const body = (await listRes.json()) as { data: { result: Array<{ feature: string; access: string }> } };
    const animals = body.data.result.find((p) => p.feature === "animals");
    expect(animals?.access).toBe("write");
  });

  it("owner can reset a feature permission (DELETE removes the row, falls back to none)", async () => {
    const { jwt: ownerJwt } = await createUserWithFarm({}, undefined, { withActiveMembership: true });
    const { userId: memberId } = await createFarmMember(ownerJwt, "member@test.com");

    await grantMemberWriteAccess(ownerJwt, memberId, "animals");

    const deleteRes = await request(
      "DELETE",
      `/v1/farm/members/byId/${memberId}/permissions/byFeature/animals`,
      undefined,
      ownerJwt
    );
    expect(deleteRes.status).toBe(200);

    // Row is deleted — GET /me or list will reflect absence (falls back to "none" in logic)
    const listRes = await request("GET", `/v1/farm/members/byId/${memberId}/permissions`, undefined, ownerJwt);
    const body = (await listRes.json()) as { data: { result: Array<{ feature: string; access: string }> } };
    const animals = body.data.result.find((p) => p.feature === "animals");
    expect(animals).toBeUndefined();
  });

  it("member cannot grant permissions (owner-only)", async () => {
    const { jwt: ownerJwt } = await createUserWithFarm({}, undefined, { withActiveMembership: true });
    const { jwt: memberJwt, userId: memberId } = await createFarmMember(ownerJwt, "member@test.com");

    const res = await request(
      "PUT",
      `/v1/farm/members/byId/${memberId}/permissions/byFeature/animals`,
      { access: "write" },
      memberJwt
    );
    expect(res.status).toBe(403);
  });

  it("PUT permission is idempotent — last value wins", async () => {
    const { jwt: ownerJwt } = await createUserWithFarm({}, undefined, { withActiveMembership: true });
    const { userId: memberId } = await createFarmMember(ownerJwt, "member@test.com");

    await grantMemberWriteAccess(ownerJwt, memberId, "animals");
    const res = await request(
      "PUT",
      `/v1/farm/members/byId/${memberId}/permissions/byFeature/animals`,
      { access: "read" },
      ownerJwt
    );
    expect(res.status).toBe(200);

    const listRes = await request("GET", `/v1/farm/members/byId/${memberId}/permissions`, undefined, ownerJwt);
    const body = (await listRes.json()) as { data: { result: Array<{ feature: string; access: string }> } };
    const animals = body.data.result.find((p) => p.feature === "animals");
    expect(animals?.access).toBe("read");
  });
});

// ---------------------------------------------------------------------------
// Read access enforcement
// ---------------------------------------------------------------------------
describe("Read access enforcement", () => {
  beforeEach(cleanDb);

  it("member with none cannot read feature (403)", async () => {
    const { jwt: ownerJwt } = await createUserWithFarm({}, undefined, { withActiveMembership: true });
    const { jwt: memberJwt } = await createFarmMember(ownerJwt, "member@test.com");
    // Default is "none" — reads blocked
    const res = await request("GET", "/v1/animals", undefined, memberJwt);
    expect(res.status).toBe(403);
  });

  it("member with read access can read but not write", async () => {
    const { jwt: ownerJwt } = await createUserWithFarm({}, undefined, { withActiveMembership: true });
    const { jwt: memberJwt, userId: memberId } = await createFarmMember(ownerJwt, "member@test.com");

    await request(
      "PUT",
      `/v1/farm/members/byId/${memberId}/permissions/byFeature/animals`,
      { access: "read" },
      ownerJwt
    );

    const readRes = await request("GET", "/v1/animals", undefined, memberJwt);
    expect(readRes.status).toBe(200);

    const writeRes = await request("POST", "/v1/animals", NEW_ANIMAL, memberJwt);
    expect(writeRes.status).toBe(403);
  });

  it("member with write access can both read and write", async () => {
    const { jwt: ownerJwt } = await createUserWithFarm({}, undefined, { withActiveMembership: true });
    const { jwt: memberJwt, userId: memberId } = await createFarmMember(ownerJwt, "member@test.com");

    await grantMemberWriteAccess(ownerJwt, memberId, "animals");

    const writeRes = await request("POST", "/v1/animals", NEW_ANIMAL, memberJwt);
    expect(writeRes.status).toBe(200);

    const readRes = await request("GET", "/v1/animals", undefined, memberJwt);
    expect(readRes.status).toBe(200);
  });

  it("member loses read access after being set back to none", async () => {
    const { jwt: ownerJwt } = await createUserWithFarm({}, undefined, { withActiveMembership: true });
    const { jwt: memberJwt, userId: memberId } = await createFarmMember(ownerJwt, "member@test.com");

    await request(
      "PUT",
      `/v1/farm/members/byId/${memberId}/permissions/byFeature/animals`,
      { access: "read" },
      ownerJwt
    );
    expect((await request("GET", "/v1/animals", undefined, memberJwt)).status).toBe(200);

    await request(
      "PUT",
      `/v1/farm/members/byId/${memberId}/permissions/byFeature/animals`,
      { access: "none" },
      ownerJwt
    );
    expect((await request("GET", "/v1/animals", undefined, memberJwt)).status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Write access enforcement
// ---------------------------------------------------------------------------
describe("Write access enforcement", () => {
  beforeEach(cleanDb);

  it("owner can always write regardless of permissions", async () => {
    const { jwt } = await createUserWithFarm({}, undefined, { withActiveMembership: true });
    const res = await request("POST", "/v1/animals", NEW_ANIMAL, jwt);
    expect(res.status).toBe(200);
  });

  it("member is blocked from writing with none access (403)", async () => {
    const { jwt: ownerJwt } = await createUserWithFarm({}, undefined, { withActiveMembership: true });
    const { jwt: memberJwt } = await createFarmMember(ownerJwt, "member@test.com");

    const res = await request("POST", "/v1/animals", NEW_ANIMAL, memberJwt);
    expect(res.status).toBe(403);
  });

  it("member can write after owner grants write access", async () => {
    const { jwt: ownerJwt } = await createUserWithFarm({}, undefined, { withActiveMembership: true });
    const { jwt: memberJwt, userId: memberId } = await createFarmMember(ownerJwt, "member@test.com");

    await grantMemberWriteAccess(ownerJwt, memberId, "animals");

    const res = await request("POST", "/v1/animals", NEW_ANIMAL, memberJwt);
    expect(res.status).toBe(200);
  });

  it("member is blocked after write access is revoked (set to none)", async () => {
    const { jwt: ownerJwt } = await createUserWithFarm({}, undefined, { withActiveMembership: true });
    const { jwt: memberJwt, userId: memberId } = await createFarmMember(ownerJwt, "member@test.com");

    await grantMemberWriteAccess(ownerJwt, memberId, "animals");
    await request(
      "PUT",
      `/v1/farm/members/byId/${memberId}/permissions/byFeature/animals`,
      { access: "none" },
      ownerJwt
    );

    const res = await request("POST", "/v1/animals", NEW_ANIMAL, memberJwt);
    expect(res.status).toBe(403);
  });

  it("write permission is feature-scoped — does not affect other features", async () => {
    const { jwt: ownerJwt } = await createUserWithFarm({}, undefined, { withActiveMembership: true });
    const { jwt: memberJwt, userId: memberId } = await createFarmMember(ownerJwt, "member@test.com");

    await grantMemberWriteAccess(ownerJwt, memberId, "animals");

    const res = await request("POST", "/v1/crops", { name: "Wheat", category: "grain" }, memberJwt);
    expect(res.status).toBe(403);
  });
});
