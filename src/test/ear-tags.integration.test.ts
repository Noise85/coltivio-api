import { describe, it, expect, beforeEach } from "@jest/globals";
import { cleanDb, getAdminDb, request } from "./helpers";
import * as schema from "../db/schema";
import { createUserWithFarm } from "./test-utils";

// ---------------------------------------------------------------------------
// Ear Tags
// ---------------------------------------------------------------------------
describe("Ear Tags", () => {
  beforeEach(cleanDb);

  it("creates a range of ear tags", async () => {
    const { jwt, farmId } = await createUserWithFarm();

    const res = await request("POST", "/v1/earTags/range", { fromNumber: "CH100", toNumber: "CH105" }, jwt);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { result: Array<{ number: string; farmId: string }>; count: number };
    };
    expect(body.data.count).toBe(6); // 100..105 inclusive
    expect(body.data.result[0].number).toBe("CH100");
    expect(body.data.result[0].farmId).toBe(farmId);

    // Verify DB
    const db = getAdminDb();
    const dbTags = await db.query.earTags.findMany({});
    expect(dbTags).toHaveLength(6);
    expect(dbTags.every((t) => t.farmId === farmId)).toBe(true);
    const numbers = dbTags.map((t) => t.number).sort();
    expect(numbers[0]).toBe("CH100");
    expect(numbers[5]).toBe("CH105");
  });

  it("lists all ear tags", async () => {
    const { jwt } = await createUserWithFarm();
    await request("POST", "/v1/earTags/range", { fromNumber: "CH001", toNumber: "CH003" }, jwt);

    const res = await request("GET", "/v1/earTags", undefined, jwt);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { count: number } };
    expect(body.data.count).toBe(3);
  });

  it("lists available (unassigned) ear tags", async () => {
    const { jwt } = await createUserWithFarm();
    await request("POST", "/v1/earTags/range", { fromNumber: "CH010", toNumber: "CH012" }, jwt);

    const res = await request("GET", "/v1/earTags/available", undefined, jwt);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { count: number } };
    // All should be available since none are assigned
    expect(body.data.count).toBe(3);
  });

  it("deletes a range of ear tags", async () => {
    const { jwt } = await createUserWithFarm();
    await request("POST", "/v1/earTags/range", { fromNumber: "CH020", toNumber: "CH025" }, jwt);

    const delRes = await request("DELETE", "/v1/earTags/range?fromNumber=CH020&toNumber=CH022", undefined, jwt);
    expect(delRes.status).toBe(200);
    const delBody = (await delRes.json()) as {
      data: { deletedCount: number; skippedAssigned: string[] };
    };
    expect(delBody.data.deletedCount).toBe(3);
    expect(delBody.data.skippedAssigned).toHaveLength(0);

    // Verify DB: 3 remaining
    const db = getAdminDb();
    const dbTags = await db.query.earTags.findMany({});
    expect(dbTags).toHaveLength(3);
    const remaining = dbTags.map((t) => t.number).sort();
    expect(remaining).toEqual(["CH023", "CH024", "CH025"]);
  });
});
