import { describe, it, expect, beforeEach } from "@jest/globals";

import { cleanDb, getAdminDb, request } from "./helpers";
import * as schema from "../db/schema";
import { createUserWithFarm, createCropProtectionProduct } from "./test-utils";

// ---------------------------------------------------------------------------
// Crop Protection Products CRUD
// ---------------------------------------------------------------------------
describe("Crop Protection Products CRUD", () => {
  beforeEach(cleanDb);

  it("creates a product and retrieves it by id", async () => {
    const { jwt, farmId } = await createUserWithFarm();
    const product = await createCropProtectionProduct(jwt, {
      name: "Roundup",
      unit: "l",
    });

    expect(product.name).toBe("Roundup");
    expect(product.unit).toBe("l");
    expect(product.farmId).toBe(farmId);

    // Verify DB
    const db = getAdminDb();
    const dbProduct = await db.query.cropProtectionProducts.findFirst({
      where: { id: product.id },
    });
    expect(dbProduct!.name).toBe("Roundup");
    expect(dbProduct!.unit).toBe("l");
    expect(dbProduct!.farmId).toBe(farmId);

    // GET by id
    const getRes = await request("GET", `/v1/cropProtectionProducts/byId/${product.id}`, undefined, jwt);
    expect(getRes.status).toBe(200);
  });

  it("lists products for farm", async () => {
    const { jwt } = await createUserWithFarm();
    await createCropProtectionProduct(jwt, { name: "P1" });
    await createCropProtectionProduct(jwt, { name: "P2" });

    const res = await request("GET", "/v1/cropProtectionProducts", undefined, jwt);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { count: number } };
    expect(body.data.count).toBe(2);
  });

  it("updates a product", async () => {
    const { jwt } = await createUserWithFarm();
    const product = await createCropProtectionProduct(jwt, { name: "OldName" });

    const res = await request(
      "PATCH",
      `/v1/cropProtectionProducts/byId/${product.id}`,
      { name: "NewName", description: "Broad spectrum herbicide" },
      jwt
    );
    expect(res.status).toBe(200);

    // Verify DB
    const db = getAdminDb();
    const dbProduct = await db.query.cropProtectionProducts.findFirst({
      where: { id: product.id },
    });
    expect(dbProduct!.name).toBe("NewName");
    expect(dbProduct!.description).toBe("Broad spectrum herbicide");
  });

  it("deletes a product", async () => {
    const { jwt } = await createUserWithFarm();
    const product = await createCropProtectionProduct(jwt);

    const res = await request("DELETE", `/v1/cropProtectionProducts/byId/${product.id}`, undefined, jwt);
    expect(res.status).toBe(200);

    // Verify DB
    const db = getAdminDb();
    const dbProduct = await db.query.cropProtectionProducts.findFirst({
      where: { id: product.id },
    });
    expect(dbProduct).toBeUndefined();
  });

  it("checks if product is in use (false when unused)", async () => {
    const { jwt } = await createUserWithFarm();
    const product = await createCropProtectionProduct(jwt);

    const res = await request("GET", `/v1/cropProtectionProducts/byId/${product.id}/inUse`, undefined, jwt);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { inUse: boolean } };
    expect(body.data.inUse).toBe(false);
  });
});
