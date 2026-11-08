import { describe, it, expect, beforeEach } from "@jest/globals";
import { cleanDb, request } from "./helpers";
import { createUserWithFarm } from "./test-utils";

const BASE = "/v1/orders/invoiceSettings";

type SettingsRow = {
  id: string;
  farmId: string;
  name: string;
  senderName: string;
  hasLogo: boolean;
  paymentTermsDays: number;
};

async function createSettings(jwt: string, data?: Record<string, unknown>): Promise<SettingsRow> {
  const res = await request("POST", BASE, { name: "Default", senderName: "Test Farm", ...data }, jwt);
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: SettingsRow }).data;
}

describe("Invoice Settings", () => {
  beforeEach(cleanDb);

  // ---------------------------------------------------------------------------
  // GET — list
  // ---------------------------------------------------------------------------

  it("GET returns empty array when no settings exist", async () => {
    const { jwt } = await createUserWithFarm({}, "is1@test.com");
    const res = await request("GET", BASE, undefined, jwt);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { result: SettingsRow[] } };
    expect(body.data.result).toEqual([]);
  });

  it("GET returns all settings for the farm", async () => {
    const { jwt } = await createUserWithFarm({}, "is2@test.com");
    await createSettings(jwt, { name: "Meat" });
    await createSettings(jwt, { name: "Dairy" });

    const res = await request("GET", BASE, undefined, jwt);
    const body = (await res.json()) as { data: { result: SettingsRow[] } };
    expect(body.data.result).toHaveLength(2);
    const names = body.data.result.map((r) => r.name).sort();
    expect(names).toEqual(["Dairy", "Meat"]);
  });

  // ---------------------------------------------------------------------------
  // POST — create
  // ---------------------------------------------------------------------------

  it("POST creates settings with name and returns it", async () => {
    const { jwt } = await createUserWithFarm({}, "is3@test.com");
    const row = await createSettings(jwt, { name: "Invoices A", senderName: "My Farm", paymentTermsDays: 14 });

    expect(row.name).toBe("Invoices A");
    expect(row.senderName).toBe("My Farm");
    expect(row.paymentTermsDays).toBe(14);
    expect(row.hasLogo).toBe(false);
    expect(row.id).toBeDefined();
  });

  it("POST allows multiple settings per farm", async () => {
    const { jwt } = await createUserWithFarm({}, "is4@test.com");
    const a = await createSettings(jwt, { name: "A" });
    const b = await createSettings(jwt, { name: "B" });
    expect(a.id).not.toBe(b.id);
  });

  it("POST rejects duplicate name within same farm", async () => {
    const { jwt } = await createUserWithFarm({}, "is5@test.com");
    await createSettings(jwt, { name: "Same" });
    const res = await request("POST", BASE, { name: "Same" }, jwt);
    expect(res.status).not.toBe(200);
  });

  // ---------------------------------------------------------------------------
  // PUT /:id — update
  // ---------------------------------------------------------------------------

  it("PUT updates name and fields", async () => {
    const { jwt } = await createUserWithFarm({}, "is6@test.com");
    const row = await createSettings(jwt, { name: "Old" });

    const res = await request("PUT", `${BASE}/${row.id}`, { id: row.id, name: "New", senderName: "Updated" }, jwt);
    expect(res.status).toBe(200);
    const updated = ((await res.json()) as { data: SettingsRow }).data;
    expect(updated.name).toBe("New");
    expect(updated.senderName).toBe("Updated");
  });

  it("GET list reflects update", async () => {
    const { jwt } = await createUserWithFarm({}, "is7@test.com");
    const row = await createSettings(jwt, { name: "Before" });
    await request("PUT", `${BASE}/${row.id}`, { id: row.id, name: "After" }, jwt);

    const res = await request("GET", BASE, undefined, jwt);
    const body = (await res.json()) as { data: { result: SettingsRow[] } };
    expect(body.data.result[0].name).toBe("After");
  });

  // ---------------------------------------------------------------------------
  // DELETE /:id
  // ---------------------------------------------------------------------------

  it("DELETE removes the settings row", async () => {
    const { jwt } = await createUserWithFarm({}, "is8@test.com");
    const row = await createSettings(jwt, { name: "ToDelete" });

    const delRes = await request("DELETE", `${BASE}/${row.id}`, { id: row.id }, jwt);
    expect(delRes.status).toBe(200);

    const listRes = await request("GET", BASE, undefined, jwt);
    const body = (await listRes.json()) as { data: { result: SettingsRow[] } };
    expect(body.data.result).toHaveLength(0);
  });

  it("DELETE one of multiple only removes the targeted row", async () => {
    const { jwt } = await createUserWithFarm({}, "is9@test.com");
    const a = await createSettings(jwt, { name: "Keep" });
    const b = await createSettings(jwt, { name: "Remove" });

    await request("DELETE", `${BASE}/${b.id}`, { id: b.id }, jwt);

    const listRes = await request("GET", BASE, undefined, jwt);
    const body = (await listRes.json()) as { data: { result: SettingsRow[] } };
    expect(body.data.result).toHaveLength(1);
    expect(body.data.result[0].id).toBe(a.id);
  });

  // ---------------------------------------------------------------------------
  // Logo — PUT/DELETE /:id/logo
  // ---------------------------------------------------------------------------

  it("PUT /:id/logo sets hasLogo=true", async () => {
    const { jwt } = await createUserWithFarm({}, "is10@test.com");
    const row = await createSettings(jwt, { name: "WithLogo" });

    // 1x1 white PNG in base64
    const png1x1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwADhQGAWjR9awAAAABJRU5ErkJggg==";
    const res = await request("PUT", `${BASE}/${row.id}/logo`, { id: row.id, base64: png1x1, mimeType: "png" }, jwt);
    expect(res.status).toBe(200);
    const updated = ((await res.json()) as { data: SettingsRow }).data;
    expect(updated.hasLogo).toBe(true);
  });

  it("DELETE /:id/logo sets hasLogo=false", async () => {
    const { jwt } = await createUserWithFarm({}, "is11@test.com");
    const row = await createSettings(jwt, { name: "LogoThenDelete" });

    const png1x1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwADhQGAWjR9awAAAABJRU5ErkJggg==";
    await request("PUT", `${BASE}/${row.id}/logo`, { id: row.id, base64: png1x1, mimeType: "png" }, jwt);

    const delRes = await request("DELETE", `${BASE}/${row.id}/logo`, { id: row.id }, jwt);
    expect(delRes.status).toBe(200);

    const listRes = await request("GET", BASE, undefined, jwt);
    const body = (await listRes.json()) as { data: { result: SettingsRow[] } };
    expect(body.data.result[0].hasLogo).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Farm isolation
  // ---------------------------------------------------------------------------

  it("farm A cannot see farm B settings", async () => {
    const { jwt: jwtA } = await createUserWithFarm({}, "isA@test.com");
    const { jwt: jwtB } = await createUserWithFarm({}, "isB@test.com");
    await createSettings(jwtA, { name: "FarmA Settings" });

    const res = await request("GET", BASE, undefined, jwtB);
    const body = (await res.json()) as { data: { result: SettingsRow[] } };
    expect(body.data.result).toHaveLength(0);
  });
});
