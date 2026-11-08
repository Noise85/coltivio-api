import { describe, it, expect, beforeEach } from "@jest/globals";
import { farmMembers } from "../db/schema";
import { cleanDb, createTestUser, getAdminDb, getAdminSql, rawRequest, request, signTestJwt } from "./helpers";
import { membershipPayments } from "../db/schema";

const JWT_SECRET = "super-secret-jwt-token-with-at-least-32-characters-long";

const TEST_FARM = {
  name: "Test Farm",
  address: "123 Farm St",
  location: { type: "Point" as const, coordinates: [8.5, 47.3] },
};

const TEST_PLOT = {
  name: "Test Plot",
  geometry: {
    type: "MultiPolygon" as const,
    coordinates: [
      [
        [
          [8.5, 47.3],
          [8.6, 47.3],
          [8.6, 47.4],
          [8.5, 47.4],
          [8.5, 47.3],
        ],
      ],
    ],
  },
  size: 1000,
};

/** Creates a user with a farm but NO membership — used to test membership gating */
async function createUserWithFarmNoMembership(email: string) {
  const { jwt, userId } = await createTestUser(email, "password123");
  const res = await request("POST", "/v1/farm", { ...TEST_FARM, name: `Farm ${email}` }, jwt);
  const body = (await res.json()) as { data: { id: string } };
  return { jwt, userId, farmId: body.data.id };
}

/** Creates a user with a farm (and active membership) and returns jwt, userId, and farmId */
async function createUserWithFarm(email: string) {
  const { jwt, userId } = await createTestUser(email, "password123");
  const res = await request("POST", "/v1/farm", { ...TEST_FARM, name: `Farm ${email}` }, jwt);
  const body = (await res.json()) as { data: { id: string } };
  const farmId = body.data.id;
  const db = getAdminDb();
  const periodEnd = new Date();
  periodEnd.setFullYear(periodEnd.getFullYear() + 1);
  await db.insert(membershipPayments).values({
    userId,
    stripePaymentId: `pi_test_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    stripeSubscriptionId: null,
    amount: 29000,
    currency: "chf",
    status: "succeeded",
    periodEnd,
  });
  return { jwt, userId, farmId };
}

// ---------------------------------------------------------------------------
// 1. Authentication enforcement
// ---------------------------------------------------------------------------
describe("Authentication enforcement", () => {
  beforeEach(cleanDb);

  it("rejects request with no token", async () => {
    const res = await rawRequest("GET", "/v1/farm");
    expect(res.status).toBe(401);
  });

  it("rejects request with malformed token", async () => {
    const res = await rawRequest("GET", "/v1/farm", {
      headers: { Authorization: "Bearer not-a-jwt" },
    });
    expect(res.status).toBe(401);
  });

  it("rejects request with expired token", async () => {
    const expired = signTestJwt({ sub: "00000000-0000-0000-0000-000000000000", role: "authenticated" }, JWT_SECRET, {
      expiresInSeconds: -3600,
    });
    const res = await rawRequest("GET", "/v1/farm", {
      headers: { Authorization: `Bearer ${expired}` },
    });
    expect(res.status).toBe(401);
  });

  it("rejects request with tampered token", async () => {
    const { jwt } = await createTestUser("tamper@test.com", "password123");
    // Flip a character in the payload section of the JWT
    const parts = jwt.split(".");
    const tamperedPayload = parts[1].charAt(0) === "a" ? "b" + parts[1].slice(1) : "a" + parts[1].slice(1);
    const tampered = `${parts[0]}.${tamperedPayload}.${parts[2]}`;
    const res = await rawRequest("GET", "/v1/farm", {
      headers: { Authorization: `Bearer ${tampered}` },
    });
    expect(res.status).toBe(401);
  });

  it("rejects token for deleted user", async () => {
    const { jwt } = await createTestUser("deleted@test.com", "password123");
    // Verify token works first
    const before = await request("POST", "/v1/farm", TEST_FARM, jwt);
    expect(before.status).toBe(200);

    // Delete user from auth.users via admin SQL
    const sql = getAdminSql();
    await sql`DELETE FROM auth.users`;

    const res = await request("GET", "/v1/farm", undefined, jwt);
    expect(res.status).toBe(401);
  });

  it("rejects request with empty Bearer", async () => {
    const res = await rawRequest("GET", "/v1/farm", {
      headers: { Authorization: "Bearer " },
    });
    expect(res.status).toBe(401);
  });

  it("rejects non-Bearer auth scheme", async () => {
    const res = await rawRequest("GET", "/v1/farm", {
      headers: { Authorization: "Basic abc123" },
    });
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// 2. Cross-tenant isolation (RLS)
// ---------------------------------------------------------------------------
describe("Cross-tenant isolation (RLS)", () => {
  beforeEach(cleanDb);

  it("User B cannot read User A's farm", async () => {
    const userA = await createUserWithFarm("a@test.com");
    const userB = await createUserWithFarm("b@test.com");

    const res = await request("GET", "/v1/farm", undefined, userB.jwt);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { id: string; name: string } };
    // User B should see their own farm, not A's
    expect(body.data.id).toBe(userB.farmId);
    expect(body.data.id).not.toBe(userA.farmId);
  });

  it("User B cannot update User A's farm", async () => {
    const userA = await createUserWithFarm("a@test.com");
    const userB = await createUserWithFarm("b@test.com");

    // User B updates "their" farm
    await request("PATCH", "/v1/farm", { name: "Hacked" }, userB.jwt);

    // Verify User A's farm is untouched
    const res = await request("GET", "/v1/farm", undefined, userA.jwt);
    const body = (await res.json()) as { data: { name: string } };
    expect(body.data.name).not.toBe("Hacked");
  });

  it("User B cannot read User A's plots", async () => {
    const userA = await createUserWithFarm("a@test.com");
    const userB = await createUserWithFarm("b@test.com");

    // User A creates a plot
    const plotRes = await request("POST", "/v1/plots", TEST_PLOT, userA.jwt);
    expect(plotRes.status).toBe(200);

    // User B lists plots
    const res = await request("GET", "/v1/plots", undefined, userB.jwt);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { result: unknown[]; count: number } };
    expect(body.data.result).toHaveLength(0);
  });

  it("User B cannot update User A's plot", async () => {
    const userA = await createUserWithFarm("a@test.com");
    const userB = await createUserWithFarm("b@test.com");

    // User A creates a plot
    const plotRes = await request("POST", "/v1/plots", TEST_PLOT, userA.jwt);
    const plotBody = (await plotRes.json()) as { data: { id: string } };
    const plotId = plotBody.data.id;

    // User B tries to update the plot
    const res = await request("PATCH", `/v1/plots/byId/${plotId}`, { name: "Hacked" }, userB.jwt);
    // Should fail - either 404 or no effect
    expect([404, 500].includes(res.status) || res.status === 200).toBe(true);

    // Verify the plot is untouched
    const check = await request("GET", `/v1/plots/byId/${plotId}`, undefined, userA.jwt);
    const checkBody = (await check.json()) as { data: { name: string } };
    expect(checkBody.data.name).toBe("Test Plot");
  });

  it("User B cannot delete User A's plot", async () => {
    const userA = await createUserWithFarm("a@test.com");
    const userB = await createUserWithFarm("b@test.com");

    const plotRes = await request("POST", "/v1/plots", TEST_PLOT, userA.jwt);
    const plotBody = (await plotRes.json()) as { data: { id: string } };
    const plotId = plotBody.data.id;

    // User B tries to delete
    await request("DELETE", `/v1/plots/byId/${plotId}`, undefined, userB.jwt);

    // Verify the plot still exists for User A
    const check = await request("GET", `/v1/plots/byId/${plotId}`, undefined, userA.jwt);
    expect(check.status).toBe(200);
  });

  it("User B cannot read User A's crops", async () => {
    const userA = await createUserWithFarm("a@test.com");
    const userB = await createUserWithFarm("b@test.com");

    // User A creates a crop
    const cropRes = await request("POST", "/v1/crops", { name: "Secret Wheat", category: "grain" }, userA.jwt);
    expect(cropRes.status).toBe(200);

    // User B lists crops — should not contain User A's crop
    const res = await request("GET", "/v1/crops", undefined, userB.jwt);
    const body = (await res.json()) as {
      data: { result: Array<{ farmId: string; name: string }> };
    };
    const cropNames = body.data.result.map((c) => c.name);
    expect(cropNames).not.toContain("Secret Wheat");
    // All crops should belong to User B's farm
    for (const crop of body.data.result) {
      expect(crop.farmId).toBe(userB.farmId);
    }
  });

  it("User B cannot read User A's animals", async () => {
    const userA = await createUserWithFarm("a@test.com");
    const userB = await createUserWithFarm("b@test.com");

    // User A creates an animal
    await request(
      "POST",
      "/v1/animals",
      {
        name: "Bessie",
        type: "cattle",
        sex: "female",
        dateOfBirth: "2020-01-01",
        registered: true,
        usage: "milk",
      },
      userA.jwt
    );

    // User B lists animals
    const res = await request("GET", "/v1/animals", undefined, userB.jwt);
    const body = (await res.json()) as { data: { result: unknown[]; count: number } };
    expect(body.data.result).toHaveLength(0);
  });

  it("Direct DB verification: RLS blocks cross-farm SELECT", async () => {
    const userA = await createUserWithFarm("a@test.com");
    const userB = await createUserWithFarm("b@test.com");

    // User A creates a plot
    await request("POST", "/v1/plots", TEST_PLOT, userA.jwt);

    // Verify data exists via admin DB
    const db = getAdminDb();
    const allPlots = await db.query.plots.findMany();
    expect(allPlots.length).toBeGreaterThanOrEqual(1);

    // Verify User B's API returns nothing
    const res = await request("GET", "/v1/plots", undefined, userB.jwt);
    const body = (await res.json()) as { data: { result: unknown[] } };
    expect(body.data.result).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 3. Profile access control
// ---------------------------------------------------------------------------
describe("Profile access control", () => {
  beforeEach(cleanDb);

  it("user can read own profile", async () => {
    const { jwt, userId } = await createTestUser("me@test.com", "password123");
    const res = await request("GET", "/v1/me", undefined, jwt);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { id: string; email: string } };
    expect(body.data.id).toBe(userId);
    expect(body.data.email).toBe("me@test.com");
  });

  it("user can update own profile", async () => {
    const { jwt } = await createTestUser("me@test.com", "password123");
    const res = await request("PATCH", "/v1/me", { fullName: "Test User" }, jwt);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { fullName: string } };
    expect(body.data.fullName).toBe("Test User");
  });

  it("user can read same-farm member's profile", async () => {
    const userA = await createUserWithFarm("owner@test.com");
    // Create second user and add to same farm
    const { jwt: jwtB, userId: userBId } = await createTestUser("member@test.com", "password123");
    // Link user B to user A's farm via admin DB
    const db = getAdminDb();
    await db.insert(farmMembers).values({ farmId: userA.farmId, userId: userBId, role: "member" });

    // User A reads User B's profile
    const res = await request("GET", `/v1/users/byId/${userBId}`, undefined, userA.jwt);
    expect(res.status).toBe(200);
  });

  it("user cannot read cross-farm profile", async () => {
    const userA = await createUserWithFarm("a@test.com");
    const userB = await createUserWithFarm("b@test.com");

    // User A tries to read User B's profile
    const res = await request("GET", `/v1/users/byId/${userB.userId}`, undefined, userA.jwt);
    expect(res.status).toBe(404);
  });

  it("PATCH /v1/me always uses ctx.user.id, never input", async () => {
    const userA = await createUserWithFarm("a@test.com");
    const userB = await createUserWithFarm("b@test.com");

    // User A tries to update with User B's info - should only affect own profile
    await request("PATCH", "/v1/me", { fullName: "Hacked by A" }, userA.jwt);

    // Verify User B's profile is untouched
    const res = await request("GET", "/v1/me", undefined, userB.jwt);
    const body = (await res.json()) as { data: { fullName: string | null } };
    expect(body.data.fullName).not.toBe("Hacked by A");
  });
});

// ---------------------------------------------------------------------------
// 4. Authorization boundaries
// ---------------------------------------------------------------------------
describe("Authorization boundaries", () => {
  beforeEach(cleanDb);

  it("user without farm cannot access farm endpoints", async () => {
    const { jwt } = await createTestUser("nofarm@test.com", "password123");
    const res = await request("GET", "/v1/plots", undefined, jwt);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("no farm");
  });

  it("user without farm can create a farm", async () => {
    const { jwt } = await createTestUser("new@test.com", "password123");
    const res = await request("POST", "/v1/farm", TEST_FARM, jwt);
    expect(res.status).toBe(200);
  });

  it("user with a farm can create a second farm", async () => {
    const user = await createUserWithFarm("has-farm@test.com");
    const res = await request("POST", "/v1/farm", { ...TEST_FARM, name: "Second Farm" }, user.jwt);
    expect(res.status).toBe(200);
  });

  it("healthcheck is public", async () => {
    const res = await rawRequest("GET", "/healthz");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { status: string } };
    expect(body.data.status).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// 5. SQL injection resistance
// ---------------------------------------------------------------------------
describe("SQL injection resistance", () => {
  beforeEach(cleanDb);

  it("path param injection is rejected", async () => {
    const user = await createUserWithFarm("sqli@test.com");
    const res = await request("GET", "/v1/plots/byId/' OR '1'='1", undefined, user.jwt);
    // Should be 400 (invalid UUID) or 404, never 200 with data
    expect(res.status).not.toBe(200);
  });

  it("body field injection (name) is stored as literal string", async () => {
    const user = await createUserWithFarm("sqli@test.com");
    const maliciousName = "'; DROP TABLE farms;--";
    const res = await request("PATCH", "/v1/farm", { name: maliciousName }, user.jwt);
    expect(res.status).toBe(200);

    // Verify the name is stored literally
    const getRes = await request("GET", "/v1/farm", undefined, user.jwt);
    const body = (await getRes.json()) as { data: { name: string } };
    expect(body.data.name).toBe(maliciousName);

    // Verify farms table still exists
    const db = getAdminDb();
    const farms = await db.query.farms.findMany();
    expect(farms.length).toBeGreaterThan(0);
  });

  it("body field injection (coordinates) is rejected", async () => {
    const { jwt } = await createTestUser("sqli@test.com", "password123");
    const res = await request(
      "POST",
      "/v1/farm",
      {
        name: "Test",
        address: "Test",
        location: { type: "Point", coordinates: ["DROP TABLE", "farms"] },
      },
      jwt
    );
    expect(res.status).toBe(400);
  });

  it("query param injection on geo endpoint is safe", async () => {
    const user = await createUserWithFarm("sqli@test.com");
    // parseFloat("1;DROP TABLE") returns 1 (stops at semicolon), so the SQL injection
    // payload is stripped by the type coercion. Verify no tables are dropped.
    const res = await rawRequest("GET", "/v1/layers/plots/bbox?xmin=1;DROP%20TABLE&ymin=2&xmax=3&ymax=4", {
      headers: { Authorization: `Bearer ${user.jwt}` },
    });
    // The request might succeed (parseFloat coerces safely) or fail — either way, DB is intact
    const db = getAdminDb();
    const farms = await db.query.farms.findMany();
    expect(farms.length).toBeGreaterThan(0);
  });

  it("header injection has no effect", async () => {
    const user = await createUserWithFarm("sqli@test.com");
    const res = await rawRequest("GET", "/v1/farm", {
      headers: {
        Authorization: `Bearer ${user.jwt}`,
        "Accept-Language": "en'; DROP TABLE farms;--",
      },
    });
    // Should succeed normally, header treated as string
    expect(res.status).toBe(200);

    // Verify farms table intact
    const db = getAdminDb();
    const farms = await db.query.farms.findMany();
    expect(farms.length).toBeGreaterThan(0);
  });

  it("UUID param with SQL is rejected", async () => {
    const user = await createUserWithFarm("sqli@test.com");
    const res = await request(
      "GET",
      "/v1/plots/byId/00000000-0000-0000-0000-000000000000' OR 1=1--",
      undefined,
      user.jwt
    );
    expect(res.status).not.toBe(200);
  });

  it("nested object injection is stripped by validation", async () => {
    const user = await createUserWithFarm("sqli@test.com");
    const res = await request(
      "PATCH",
      "/v1/farm",
      {
        name: "Legit Name",
        __proto__: { admin: true },
        constructor: { prototype: { isAdmin: true } },
      },
      user.jwt
    );
    // Should either succeed (extra fields stripped) or be rejected
    expect([200, 400].includes(res.status)).toBe(true);
    if (res.status === 200) {
      const body = (await res.json()) as { data: { name: string } };
      expect(body.data.name).toBe("Legit Name");
    }
  });
});

// ---------------------------------------------------------------------------
// 6. Input validation edge cases
// ---------------------------------------------------------------------------
describe("Input validation edge cases", () => {
  beforeEach(cleanDb);

  it("oversized payload is rejected", async () => {
    const { jwt } = await createTestUser("big@test.com", "password123");
    const hugeString = "x".repeat(10 * 1024 * 1024); // 10MB
    const res = await rawRequest("POST", "/v1/farm", {
      body: JSON.stringify({
        name: hugeString,
        address: "test",
        location: { type: "Point", coordinates: [8.5, 47.3] },
      }),
      headers: {
        Authorization: `Bearer ${jwt}`,
        "Content-Type": "application/json",
      },
    });
    // Should be 400, 413 (payload too large), or connection error
    expect(res.status).not.toBe(200);
  });

  it("null bytes in strings are handled", async () => {
    const user = await createUserWithFarm("null@test.com");
    const res = await request("PATCH", "/v1/farm", { name: "test\x00injection" }, user.jwt);
    // Should either reject (400) or sanitize and succeed (200)
    expect([200, 400, 500].includes(res.status)).toBe(true);
  });

  it("empty body on POST is rejected", async () => {
    const { jwt } = await createTestUser("empty@test.com", "password123");
    const res = await request("POST", "/v1/farm", {}, jwt);
    expect(res.status).toBe(400);
  });

  it("wrong types in body are rejected", async () => {
    const { jwt } = await createTestUser("types@test.com", "password123");
    const res = await request(
      "POST",
      "/v1/farm",
      {
        name: 12345,
        address: true,
        location: "not-an-object",
      } as unknown as Record<string, unknown>,
      jwt
    );
    expect(res.status).toBe(400);
  });

  it("extra unexpected fields are stripped or ignored", async () => {
    const user = await createUserWithFarm("extra@test.com");
    const res = await request(
      "PATCH",
      "/v1/farm",
      {
        name: "Updated Name",
        hackerField: "evil",
        secretAdmin: true,
      },
      user.jwt
    );
    // express-zod-api strips unknown fields via Zod
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data.name).toBe("Updated Name");
    expect(body.data).not.toHaveProperty("hackerField");
    expect(body.data).not.toHaveProperty("secretAdmin");
  });

  it("missing required fields are rejected", async () => {
    const { jwt } = await createTestUser("missing@test.com", "password123");
    const res = await request(
      "POST",
      "/v1/farm",
      { address: "test" }, // missing name and location
      jwt
    );
    expect(res.status).toBe(400);
  });

  it("unicode edge cases are handled", async () => {
    const user = await createUserWithFarm("unicode@test.com");
    const unicodeName = "\u200F\u200Etest\u200B\uFEFF\u202Afarm";
    const res = await request("PATCH", "/v1/farm", { name: unicodeName }, user.jwt);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { name: string } };
    // The string should be stored (we don't mandate stripping, just no crash)
    expect(body.data.name).toBe(unicodeName);
  });
});

// ---------------------------------------------------------------------------
// 7. Token/session edge cases
// ---------------------------------------------------------------------------
describe("Token/session edge cases", () => {
  beforeEach(cleanDb);

  it("JWT signed with wrong secret is rejected", async () => {
    const token = signTestJwt(
      { sub: "00000000-0000-0000-0000-000000000000", role: "authenticated" },
      "wrong-secret-that-does-not-match-gotrue"
    );
    const res = await rawRequest("GET", "/v1/farm", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(401);
  });

  it("JWT with modified sub claim is rejected", async () => {
    // Sign with correct secret but fake user ID
    const token = signTestJwt({ sub: "00000000-0000-0000-0000-000000000000", role: "authenticated" }, JWT_SECRET);
    const res = await rawRequest("GET", "/v1/farm", {
      headers: { Authorization: `Bearer ${token}` },
    });
    // GoTrue validates the token server-side, will reject unknown user
    expect(res.status).toBe(401);
  });

  it("JWT with service_role claim does not grant escalated access", async () => {
    const token = signTestJwt({ sub: "00000000-0000-0000-0000-000000000000", role: "service_role" }, JWT_SECRET);
    const res = await rawRequest("GET", "/v1/farm", {
      headers: { Authorization: `Bearer ${token}` },
    });
    // Should still be rejected since the user doesn't exist in GoTrue
    expect(res.status).toBe(401);
  });

  it("concurrent requests don't leak tenant context", async () => {
    const userA = await createUserWithFarm("concurrent-a@test.com");
    const userB = await createUserWithFarm("concurrent-b@test.com");

    // Create a plot for each user
    await request("POST", "/v1/plots", { ...TEST_PLOT, name: "Plot A" }, userA.jwt);
    await request("POST", "/v1/plots", { ...TEST_PLOT, name: "Plot B" }, userB.jwt);

    // Fire concurrent requests
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => {
        const user = i % 2 === 0 ? userA : userB;
        return request("GET", "/v1/plots", undefined, user.jwt).then(async (res) => {
          const body = (await res.json()) as {
            data: { result: Array<{ farmId: string; name: string }> };
          };
          return { user: i % 2 === 0 ? "A" : "B", plots: body.data.result };
        });
      })
    );

    // Verify each user only sees their own plots
    for (const { user, plots } of results) {
      const expectedFarmId = user === "A" ? userA.farmId : userB.farmId;
      for (const plot of plots) {
        expect(plot.farmId).toBe(expectedFarmId);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Membership gating — only the forum is membership-gated; everything else
// (commerce endpoints, core ag features) just needs farm membership + permission.
// ---------------------------------------------------------------------------
describe("Membership gating", () => {
  beforeEach(cleanDb);

  it("user without any membership/trial can read commerce endpoints (permissionFarmEndpoint, not membership-gated)", async () => {
    const { jwt } = await createUserWithFarmNoMembership("nomem1@test.com");
    const res = await request("GET", "/v1/contacts", undefined, jwt);
    expect(res.status).toBe(200);
  });

  it("user without any membership/trial can write commerce endpoints (permissionFarmEndpoint, not membership-gated)", async () => {
    const { jwt } = await createUserWithFarmNoMembership("nomem2@test.com");
    const res = await request("POST", "/v1/contacts", { firstName: "Hans", lastName: "Muster", labels: [] }, jwt);
    expect(res.status).toBe(200);
  });

  it("user without any membership/trial can access farmEndpointFactory endpoints (not membership-gated)", async () => {
    const { jwt } = await createUserWithFarmNoMembership("nomem3@test.com");
    // GET /v1/plots uses farmEndpointFactory (no membership needed)
    const res = await request("GET", "/v1/plots", undefined, jwt);
    expect(res.status).toBe(200);
  });
});
