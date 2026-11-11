import { describe, it, expect, beforeEach } from "@jest/globals";
import { cleanDb, getAdminDb, request } from "./helpers";
import * as schema from "../db/schema";
import { createAnimal, createUserWithFarm } from "./test-utils";

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

  it("rejects a range that overlaps existing ear tags and creates none of it", async () => {
    const { jwt } = await createUserWithFarm();
    const firstRes = await request("POST", "/v1/earTags/range", { fromNumber: "CH100", toNumber: "CH105" }, jwt);
    expect(firstRes.status).toBe(200);

    const overlappingRes = await request("POST", "/v1/earTags/range", { fromNumber: "CH103", toNumber: "CH110" }, jwt);
    expect(overlappingRes.status).toBe(409);
    const body = (await overlappingRes.json()) as { error: string; code?: string };
    expect(body.code).toBe("ear_tag_range_conflict");
    expect(body.error).toContain("CH103, CH104, CH105");

    // Nothing of the overlapping range was created, not even the free numbers 106..110
    const db = getAdminDb();
    const dbTags = await db.query.earTags.findMany({});
    expect(dbTags).toHaveLength(6);
  });

  it("rejects malformed and too large ranges with 400", async () => {
    const { jwt } = await createUserWithFarm();
    const tooLargeRes = await request("POST", "/v1/earTags/range", { fromNumber: "CH1", toNumber: "CH1001" }, jwt);
    expect(tooLargeRes.status).toBe(400);
    expect(((await tooLargeRes.json()) as { code: string }).code).toBe("invalid_ear_tag_range");
    const reversedRes = await request("POST", "/v1/earTags/range", { fromNumber: "CH10", toNumber: "CH5" }, jwt);
    expect(reversedRes.status).toBe(400);
    const malformedRes = await request("POST", "/v1/earTags/range", { fromNumber: "CH 1.", toNumber: "CH5" }, jwt);
    expect(malformedRes.status).toBe(400);
    // The largest allowed range still works
    const maxRes = await request("POST", "/v1/earTags/range", { fromNumber: "CH1", toNumber: "CH1000" }, jwt);
    expect(maxRes.status).toBe(200);
  });

  it("allows a range whose numbers only exist on another farm", async () => {
    const otherFarm = await createUserWithFarm(undefined, "other-farm@test.com");
    const otherRes = await request(
      "POST",
      "/v1/earTags/range",
      { fromNumber: "CH100", toNumber: "CH102" },
      otherFarm.jwt
    );
    expect(otherRes.status).toBe(200);

    const { jwt, farmId } = await createUserWithFarm();
    const res = await request("POST", "/v1/earTags/range", { fromNumber: "CH100", toNumber: "CH102" }, jwt);
    expect(res.status).toBe(200);

    const db = getAdminDb();
    const ownTags = await db.query.earTags.findMany({ where: { farmId } });
    expect(ownTags).toHaveLength(3);
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

  it("keeps assigned ear tags when deleting a range and rejects too large ranges", async () => {
    const { jwt } = await createUserWithFarm();
    const createRes = await request("POST", "/v1/earTags/range", { fromNumber: "CH030", toNumber: "CH032" }, jwt);
    const created = ((await createRes.json()) as { data: { result: { id: string; number: string }[] } }).data.result;
    const assignedTag = created.find((tag) => tag.number === "CH031")!;
    await createAnimal(jwt, { earTagId: assignedTag.id });

    const delRes = await request("DELETE", "/v1/earTags/range?fromNumber=CH030&toNumber=CH032", undefined, jwt);
    expect(delRes.status).toBe(200);
    const delBody = (await delRes.json()) as { data: { deletedCount: number; skippedAssigned: string[] } };
    expect(delBody.data.deletedCount).toBe(2);
    expect(delBody.data.skippedAssigned).toEqual(["CH031"]);

    // Ranges bigger than the creation limit can still be deleted (created before the limit existed)
    const largeRes = await request("DELETE", "/v1/earTags/range?fromNumber=CH1&toNumber=CH1001", undefined, jwt);
    expect(largeRes.status).toBe(200);
    const tooLargeRes = await request("DELETE", "/v1/earTags/range?fromNumber=CH1&toNumber=CH100001", undefined, jwt);
    expect(tooLargeRes.status).toBe(400);
  });

  it("deletes a single ear tag by id, also with an imported number format", async () => {
    const { jwt } = await createUserWithFarm();
    const [importedTag] = await getAdminDb()
      .insert(schema.earTags)
      .values({ farmId: (await getAdminDb().query.farms.findFirst())!.id, number: "CH 120.1234.5678.9" })
      .returning();
    const deleteRes = await request("DELETE", `/v1/earTags/byId/${importedTag.id}`, undefined, jwt);
    expect(deleteRes.status).toBe(200);
    expect(await getAdminDb().query.earTags.findFirst({ where: { id: importedTag.id } })).toBeUndefined();

    // Assigned tags are refused
    const createRes = await request("POST", "/v1/earTags/range", { fromNumber: "CH040", toNumber: "CH040" }, jwt);
    const [assignedTag] = ((await createRes.json()) as { data: { result: { id: string }[] } }).data.result;
    await createAnimal(jwt, { earTagId: assignedTag.id });
    const assignedRes = await request("DELETE", `/v1/earTags/byId/${assignedTag.id}`, undefined, jwt);
    expect(assignedRes.status).toBe(409);
    expect(((await assignedRes.json()) as { code: string }).code).toBe("ear_tag_assigned");

    // Another farm's tag isn't visible
    const { jwt: otherJwt } = await createUserWithFarm({}, "other@test.com");
    const otherRes = await request("POST", "/v1/earTags/range", { fromNumber: "CH050", toNumber: "CH050" }, otherJwt);
    const [otherTag] = ((await otherRes.json()) as { data: { result: { id: string }[] } }).data.result;
    const foreignRes = await request("DELETE", `/v1/earTags/byId/${otherTag.id}`, undefined, jwt);
    expect(foreignRes.status).toBe(404);
  });
});
