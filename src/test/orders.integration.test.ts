import { describe, it, expect, beforeEach } from "@jest/globals";
import { cleanDb, request } from "./helpers";
import { createUserWithFarm, createContact, createProduct, createOrder, createPayment } from "./test-utils";

describe("Orders", () => {
  beforeEach(cleanDb);

  it("creates an order and retrieves it by id with items and contact", async () => {
    const { jwt } = await createUserWithFarm({}, undefined);
    const contact = await createContact(jwt);
    const product = await createProduct(jwt, { pricePerUnit: 30 });

    const order = await createOrder(jwt, contact.id, [{ productId: product.id, quantity: 2 }]);

    expect(order.contactId).toBe(contact.id);
    expect(order.status).toBe("pending");

    const res = await request("GET", `/v1/orders/byId/${order.id}`, undefined, jwt);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown> };
    const fetched = body.data;

    expect(fetched.id).toBe(order.id);
    expect(fetched.contact).toBeDefined();
    expect((fetched.contact as Record<string, unknown>).id).toBe(contact.id);
    expect(Array.isArray(fetched.items)).toBe(true);
    const items = fetched.items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    expect(items[0].quantity).toBe(2);
    expect((items[0].product as Record<string, unknown>).id).toBe(product.id);
    expect(Array.isArray(fetched.payments)).toBe(true);
    expect(fetched.sponsorshipProgram).toBeUndefined();
  });

  it("creates an order directly with status confirmed", async () => {
    const { jwt } = await createUserWithFarm({}, undefined);
    const contact = await createContact(jwt);
    const product = await createProduct(jwt);

    const order = await createOrder(jwt, contact.id, [{ productId: product.id, quantity: 1 }], { status: "confirmed" });

    expect(order.status).toBe("confirmed");
  });

  describe("GET /v1/orders — paidInFull flag", () => {
    it("returns paidInFull=false when no payments exist", async () => {
      const { jwt } = await createUserWithFarm({}, undefined);
      const contact = await createContact(jwt);
      // pricePerUnit=50, qty=2 → total=100
      const product = await createProduct(jwt, { pricePerUnit: 50 });
      await createOrder(jwt, contact.id, [{ productId: product.id, quantity: 2 }]);

      const res = await request("GET", "/v1/orders", undefined, jwt);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: { result: Array<Record<string, unknown>> } };
      const orders = body.data.result;
      expect(orders).toHaveLength(1);
      expect(orders[0].paidInFull).toBe(false);
    });

    it("returns paidInFull=false when payments are insufficient", async () => {
      const { jwt } = await createUserWithFarm({}, undefined);
      const contact = await createContact(jwt);
      const product = await createProduct(jwt, { pricePerUnit: 50 });
      const order = await createOrder(jwt, contact.id, [{ productId: product.id, quantity: 2 }]);

      // Pay only 80 of 100
      await createPayment(jwt, contact.id, { orderId: order.id, amount: 80 });

      const res = await request("GET", "/v1/orders", undefined, jwt);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: { result: Array<Record<string, unknown>> } };
      expect(body.data.result[0].paidInFull).toBe(false);
    });

    it("returns paidInFull=true when payments cover the order total", async () => {
      const { jwt } = await createUserWithFarm({}, undefined);
      const contact = await createContact(jwt);
      const product = await createProduct(jwt, { pricePerUnit: 50 });
      const order = await createOrder(jwt, contact.id, [{ productId: product.id, quantity: 2 }]);

      // Pay exact total (100)
      await createPayment(jwt, contact.id, { orderId: order.id, amount: 100 });

      const res = await request("GET", "/v1/orders", undefined, jwt);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: { result: Array<Record<string, unknown>> } };
      expect(body.data.result[0].paidInFull).toBe(true);
    });

    it("includes items and contact in the list response", async () => {
      const { jwt } = await createUserWithFarm({}, undefined);
      const contact = await createContact(jwt);
      const product = await createProduct(jwt, { pricePerUnit: 25 });
      await createOrder(jwt, contact.id, [{ productId: product.id, quantity: 3 }]);

      const res = await request("GET", "/v1/orders", undefined, jwt);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: { result: Array<Record<string, unknown>> } };
      const order = body.data.result[0];

      expect(order.contact).toBeDefined();
      expect((order.contact as Record<string, unknown>).id).toBe(contact.id);
      expect(Array.isArray(order.items)).toBe(true);
      const items = order.items as Array<Record<string, unknown>>;
      expect(items).toHaveLength(1);
      expect(items[0].quantity).toBe(3);
    });

    it("uses overridden unitPrice when provided on create", async () => {
      const { jwt } = await createUserWithFarm({}, undefined);
      const contact = await createContact(jwt);
      const product = await createProduct(jwt, { pricePerUnit: 50 });

      const order = await createOrder(jwt, contact.id, [{ productId: product.id, quantity: 2, unitPrice: 10 }]);

      const res = await request("GET", `/v1/orders/byId/${order.id}`, undefined, jwt);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: { items: Array<{ unitPrice: number }> } };
      expect(body.data.items[0].unitPrice).toBe(10);
    });

    it("falls back to product price when unitPrice not provided on create", async () => {
      const { jwt } = await createUserWithFarm({}, undefined);
      const contact = await createContact(jwt);
      const product = await createProduct(jwt, { pricePerUnit: 50 });

      const order = await createOrder(jwt, contact.id, [{ productId: product.id, quantity: 1 }]);

      const res = await request("GET", `/v1/orders/byId/${order.id}`, undefined, jwt);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: { items: Array<{ unitPrice: number }> } };
      expect(body.data.items[0].unitPrice).toBe(50);
    });

    it("uses overridden unitPrice when adding an item via addOrderItem", async () => {
      const { jwt } = await createUserWithFarm({}, undefined);
      const contact = await createContact(jwt);
      const product = await createProduct(jwt, { pricePerUnit: 80 });
      const order = await createOrder(jwt, contact.id, [{ productId: product.id, quantity: 1 }]);

      // Add a second item with a custom price
      const addRes = await request(
        "POST",
        `/v1/orders/byId/${order.id}/items`,
        { productId: product.id, quantity: 3, unitPrice: 20 },
        jwt
      );
      expect(addRes.status).toBe(200);
      const body = (await addRes.json()) as { data: { unitPrice: number } };
      expect(body.data.unitPrice).toBe(20);
    });
  });
});
