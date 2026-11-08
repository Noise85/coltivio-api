import { describe, it, expect, beforeEach } from "@jest/globals";
import { cleanDb, createTestUser, getAdminDb, request } from "../test/helpers";

describe("Farm CRUD", () => {
  beforeEach(async () => {
    await cleanDb();
  });

  it("creates a farm and retrieves it", async () => {
    const { jwt, userId } = await createTestUser("test@example.com", "password123");

    // Create farm via real HTTP request
    const createRes = await request(
      "POST",
      "/v1/farm",
      {
        name: "Test Farm",
        address: "123 Farm St",
        location: { type: "Point", coordinates: [8.5, 47.3] },
      },
      jwt
    );
    expect(createRes.status).toBe(200);

    const createBody = (await createRes.json()) as {
      data: { id: string; name: string };
    };
    expect(createBody.data.name).toBe("Test Farm");

    // Verify DB state directly with Drizzle
    const db = getAdminDb();
    const farms = await db.query.farms.findMany();
    expect(farms).toHaveLength(1);
    expect(farms[0].name).toBe("Test Farm");

    // Verify profile linked to farm as owner
    const membership = await db.query.farmMembers.findFirst({
      where: { userId, farmId: farms[0].id },
    });
    expect(membership?.role).toBe("owner");
  });

  it("retrieves the farm for an authenticated member", async () => {
    const { jwt } = await createTestUser("owner@example.com", "password123");

    // Create a farm first
    await request(
      "POST",
      "/v1/farm",
      {
        name: "My Farm",
        address: "456 Barn Rd",
        location: { type: "Point", coordinates: [7.4, 46.9] },
      },
      jwt
    );

    // Retrieve it
    const getRes = await request("GET", "/v1/farm", undefined, jwt);
    expect(getRes.status).toBe(200);

    const getBody = (await getRes.json()) as {
      data: { name: string; address: string };
    };
    expect(getBody.data.name).toBe("My Farm");
    expect(getBody.data.address).toBe("456 Barn Rd");
  });
});
