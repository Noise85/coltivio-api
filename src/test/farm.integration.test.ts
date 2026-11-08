import { describe, it, expect, beforeEach } from "@jest/globals";

import { cleanDb, createTestUser, getAdminDb, request } from "./helpers";
import * as schema from "../db/schema";
import {
  createUserWithFarm,
  createFarmMember,
  createPlot,
  createAnimal,
  createCrop,
  createCropRotation,
} from "./test-utils";

// ---------------------------------------------------------------------------
// Farm CRUD
// ---------------------------------------------------------------------------
describe("Farm CRUD", () => {
  beforeEach(cleanDb);

  it("creates a farm and retrieves it", async () => {
    const { jwt, farmId } = await createUserWithFarm({ name: "Sunshine Farm", address: "42 Alpine Rd" }, undefined, {
      withActiveMembership: true,
    });

    // Verify DB
    const db = getAdminDb();
    const dbFarm = await db.query.farms.findFirst({
      where: { id: farmId },
    });
    expect(dbFarm!.name).toBe("Sunshine Farm");
    expect(dbFarm!.address).toBe("42 Alpine Rd");

    // Verify API
    const res = await request("GET", "/v1/farm", undefined, jwt);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { id: string; name: string; address: string; location: { coordinates: number[] } };
    };
    expect(body.data.id).toBe(farmId);
    expect(body.data.name).toBe("Sunshine Farm");
    expect(body.data.address).toBe("42 Alpine Rd");
    expect(body.data.location.coordinates).toEqual([8.5, 47.3]);
  });

  it("allows creating a second farm for the same user", async () => {
    const { jwt } = await createUserWithFarm({}, undefined, { withActiveMembership: true });
    const res = await request(
      "POST",
      "/v1/farm",
      {
        name: "Second Farm",
        address: "Somewhere",
        location: { type: "Point", coordinates: [8.0, 47.0] },
      },
      jwt
    );
    expect(res.status).toBe(200);

    // Verify DB: now two farms, both owned by the same user
    const db = getAdminDb();
    const farms = await db.query.farms.findMany({});
    expect(farms).toHaveLength(2);
  });

  it("updates a farm", async () => {
    const { jwt, farmId } = await createUserWithFarm({ name: "OldName" }, undefined, { withActiveMembership: true });

    const res = await request("PATCH", "/v1/farm", { name: "NewName", address: "New Address 1" }, jwt);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { name: string; address: string };
    };
    expect(body.data.name).toBe("NewName");
    expect(body.data.address).toBe("New Address 1");

    // Verify DB
    const db = getAdminDb();
    const dbFarm = await db.query.farms.findFirst({
      where: { id: farmId },
    });
    expect(dbFarm!.name).toBe("NewName");
    expect(dbFarm!.address).toBe("New Address 1");
  });

  it("updates farm federalId and tvdId", async () => {
    const { jwt, farmId } = await createUserWithFarm({}, undefined, { withActiveMembership: true });

    const res = await request("PATCH", "/v1/farm", { federalId: "CH-1234", tvdId: "TVD-5678" }, jwt);
    expect(res.status).toBe(200);

    // Verify DB
    const db = getAdminDb();
    const dbFarm = await db.query.farms.findFirst({
      where: { id: farmId },
    });
    expect(dbFarm!.federalId).toBe("CH-1234");
    expect(dbFarm!.tvdId).toBe("TVD-5678");
  });

  it("deletes a farm without deleting account", async () => {
    const { jwt, farmId, userId } = await createUserWithFarm({}, undefined, { withActiveMembership: true });

    const res = await request("DELETE", "/v1/farm?deleteAccount=false", undefined, jwt);
    expect(res.status).toBe(200);

    // Verify DB: farm gone, user profile still exists
    const db = getAdminDb();
    const dbFarm = await db.query.farms.findFirst({
      where: { id: farmId },
    });
    expect(dbFarm).toBeUndefined();

    const dbProfile = await db.query.profiles.findFirst({
      where: { id: userId },
    });
    expect(dbProfile).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------
describe("Users", () => {
  beforeEach(cleanDb);

  it("retrieves own user profile", async () => {
    const { jwt, userId } = await createUserWithFarm({}, undefined, { withActiveMembership: true });

    const res = await request("GET", "/v1/me", undefined, jwt);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { id: string; email: string; farmId: string | null };
    };
    expect(body.data.id).toBe(userId);
    expect(body.data.email).toBe("test@test.com");
    expect(body.data.farmId).not.toBeNull();
  });

  it("updates own user profile", async () => {
    const { jwt, userId } = await createUserWithFarm({}, undefined, { withActiveMembership: true });

    const res = await request("PATCH", "/v1/me", { fullName: "John Doe" }, jwt);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { fullName: string | null } };
    expect(body.data.fullName).toBe("John Doe");

    // Verify DB
    const db = getAdminDb();
    const dbProfile = await db.query.profiles.findFirst({
      where: { id: userId },
    });
    expect(dbProfile!.fullName).toBe("John Doe");
  });

  it("lists farm users", async () => {
    const { jwt } = await createUserWithFarm({}, undefined, { withActiveMembership: true });

    const res = await request("GET", "/v1/users", undefined, jwt);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { result: unknown[]; count: number };
    };
    expect(body.data.count).toBe(1);
  });

  it("retrieves user by id", async () => {
    const { jwt, userId } = await createUserWithFarm({}, undefined, { withActiveMembership: true });

    const res = await request("GET", `/v1/users/byId/${userId}`, undefined, jwt);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { id: string } };
    expect(body.data.id).toBe(userId);
  });
});

// ---------------------------------------------------------------------------
// Farm Invites (with role)
// ---------------------------------------------------------------------------
describe("Farm Invites", () => {
  beforeEach(cleanDb);

  it("creates an invite with default member role", async () => {
    const { jwt } = await createUserWithFarm({}, undefined, { withActiveMembership: true });

    const res = await request("POST", "/v1/farm/invites", { email: "member@test.com" }, jwt);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { email: string; role: string } };
    expect(body.data.email).toBe("member@test.com");
    expect(body.data.role).toBe("member");
  });

  it("creates an invite with owner role", async () => {
    const { jwt } = await createUserWithFarm({}, undefined, { withActiveMembership: true });

    const res = await request("POST", "/v1/farm/invites", { email: "co-owner@test.com", role: "owner" }, jwt);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { role: string } };
    expect(body.data.role).toBe("owner");
  });

  it("accepted invite assigns the role from the invite", async () => {
    const { jwt: ownerJwt } = await createUserWithFarm({}, undefined, { withActiveMembership: true });
    const { userId: memberId } = await createFarmMember(ownerJwt, "member@test.com", { role: "member" });

    const db = getAdminDb();
    const membership = await db.query.farmMembers.findFirst({ where: { userId: memberId } });
    expect(membership?.role).toBe("member");
  });

  it("accepted invite with owner role sets the invitee as owner", async () => {
    const { jwt: ownerJwt } = await createUserWithFarm({}, undefined, { withActiveMembership: true });
    const { userId: coOwnerId } = await createFarmMember(ownerJwt, "coowner@test.com", { role: "owner" });

    const db = getAdminDb();
    const membership = await db.query.farmMembers.findFirst({ where: { userId: coOwnerId } });
    expect(membership?.role).toBe("owner");
  });

  it("non-owner cannot create invites", async () => {
    const { jwt: ownerJwt } = await createUserWithFarm({}, undefined, { withActiveMembership: true });
    const { jwt: memberJwt } = await createFarmMember(ownerJwt, "member@test.com");

    const res = await request("POST", "/v1/farm/invites", { email: "another@test.com" }, memberJwt);
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Owner-only actions
// ---------------------------------------------------------------------------
describe("Owner-only actions", () => {
  beforeEach(cleanDb);

  it("member cannot update farm settings", async () => {
    const { jwt: ownerJwt } = await createUserWithFarm({ name: "Owner Farm" }, undefined, {
      withActiveMembership: true,
    });
    const { jwt: memberJwt } = await createFarmMember(ownerJwt, "member@test.com");

    const res = await request("PATCH", "/v1/farm", { name: "Hacked" }, memberJwt);
    expect(res.status).toBe(403);
  });

  it("owner can update farm settings", async () => {
    const { jwt } = await createUserWithFarm({ name: "Original Name" }, undefined, { withActiveMembership: true });

    const res = await request("PATCH", "/v1/farm", { name: "Updated Name" }, jwt);
    expect(res.status).toBe(200);
  });

  it("member cannot kick other members", async () => {
    const { jwt: ownerJwt, userId: ownerId } = await createUserWithFarm({}, undefined, { withActiveMembership: true });
    const { jwt: memberJwt } = await createFarmMember(ownerJwt, "member@test.com");

    const res = await request("DELETE", `/v1/farm/members/byId/${ownerId}`, undefined, memberJwt);
    expect(res.status).toBe(403);
  });

  it("member cannot change member roles", async () => {
    const { jwt: ownerJwt, userId: ownerId } = await createUserWithFarm({}, undefined, { withActiveMembership: true });
    const { jwt: memberJwt } = await createFarmMember(ownerJwt, "member@test.com");

    const res = await request("PATCH", `/v1/farm/members/byId/${ownerId}/role`, { role: "member" }, memberJwt);
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Farm Stats
// ---------------------------------------------------------------------------
describe("Farm Stats", () => {
  beforeEach(cleanDb);

  it("returns plot totals", async () => {
    const { jwt } = await createUserWithFarm();
    // Distinct, non-overlapping geometries: plots.ts auto-clips overlapping plots on insert,
    // which would otherwise zero out one plot's stored size.
    await createPlot(jwt, {
      size: 10000,
      geometry: {
        type: "MultiPolygon",
        coordinates: [
          [
            [
              [8.0, 47.0],
              [8.1, 47.0],
              [8.1, 47.1],
              [8.0, 47.1],
              [8.0, 47.0],
            ],
          ],
        ],
      },
    });
    await createPlot(jwt, {
      size: 5000,
      geometry: {
        type: "MultiPolygon",
        coordinates: [
          [
            [
              [9.0, 47.0],
              [9.1, 47.0],
              [9.1, 47.1],
              [9.0, 47.1],
              [9.0, 47.0],
            ],
          ],
        ],
      },
    });

    const res = await request("GET", "/v1/farm/stats", undefined, jwt);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { plots: { total: number; totalAreaM2: number } };
    };
    expect(body.data.plots.total).toBe(2);
    expect(body.data.plots.totalAreaM2).toBe(15000);
  });

  it("counts only living animals", async () => {
    const { jwt } = await createUserWithFarm();
    await createAnimal(jwt, { name: "Alive" });
    await createAnimal(jwt, { name: "Dead", dateOfDeath: "2024-01-01" });

    const res = await request("GET", "/v1/farm/stats", undefined, jwt);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { animals: { totalLiving: number; byType: { type: string; count: number }[] } };
    };
    expect(body.data.animals.totalLiving).toBe(1);
    expect(body.data.animals.byType).toEqual([{ type: "cow", count: 1 }]);
  });

  it("returns active crop rotations", async () => {
    const { jwt } = await createUserWithFarm();
    const plot = await createPlot(jwt, { size: 10000 });
    const crop = await createCrop(jwt, { name: "SummaryWheat", category: "grain" });

    const now = new Date();
    const fromDate = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString().slice(0, 10);
    const toDate = new Date(now.getFullYear(), now.getMonth() + 1, 28).toISOString().slice(0, 10);
    await createCropRotation(jwt, plot.id, crop.id, { fromDate, toDate });

    const res = await request("GET", "/v1/farm/stats", undefined, jwt);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        cropRotations: { active: { cropName: string; category: string; plotCount: number; totalAreaM2: number }[] };
      };
    };
    const active = body.data.cropRotations.active.find((r) => r.cropName === "SummaryWheat");
    expect(active).toBeDefined();
    expect(active!.plotCount).toBe(1);
    expect(active!.totalAreaM2).toBe(10000);
  });
});
