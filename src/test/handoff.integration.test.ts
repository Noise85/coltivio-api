import { beforeEach, describe, expect, it } from "@jest/globals";
import { adminOnlyDb } from "../db/db";
import { handoffApi } from "../auth/handoff";
import { cleanDb, createTestUser } from "./helpers";

describe("handoff token exchange", () => {
  beforeEach(cleanDb);

  it("allows exactly one of two concurrent exchanges to succeed", async () => {
    const { userId } = await createTestUser(`handoff-${Date.now()}@test.ch`, "123456");
    const api = handoffApi(adminOnlyDb);
    const { token } = await api.createHandoffToken(userId);

    const results = await Promise.allSettled([
      api.exchangeHandoffToken(token, "http://localhost:3000"),
      api.exchangeHandoffToken(token, "http://localhost:3000"),
    ]);

    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.find((result) => result.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(fulfilled[0]).toMatchObject({ status: "fulfilled", value: { url: expect.any(String) } });
    expect(rejected).toBeDefined();
    if (rejected?.status === "rejected") {
      expect(rejected.reason).toMatchObject({ statusCode: 410 });
    }
  });
});
