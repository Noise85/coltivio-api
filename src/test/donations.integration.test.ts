// jest.mock is hoisted before imports by Jest
jest.mock("../stripe/stripe");

import { describe, it, expect, beforeEach, afterEach, beforeAll, jest } from "@jest/globals";
import Stripe from "stripe";
import i18next from "i18next";
import de from "../../resources/locales/de.json";
import en from "../../resources/locales/en.json";
import itLocale from "../../resources/locales/it.json";
import fr from "../../resources/locales/fr.json";
import { cleanDb, getAdminDb, createTestUser, request } from "./helpers";
import * as schema from "../db/schema";
import { getStripe } from "../stripe/stripe";
import { adminOnlyDb } from "../db/db";
import { donationsApi } from "../donations/donations";
import * as brevo from "../brevo/brevo";

beforeAll(async () => {
  if (!i18next.isInitialized) {
    await i18next.init({
      resources: {
        de: { translation: de },
        en: { translation: en },
        it: { translation: itLocale },
        fr: { translation: fr },
      },
      fallbackLng: "de",
      preload: ["de", "en", "it", "fr"],
    });
  }
});

let emailSpy: jest.SpiedFunction<typeof brevo.txEmailApi.sendTransacEmail>;

beforeEach(() => {
  emailSpy = jest.spyOn(brevo.txEmailApi, "sendTransacEmail").mockImplementation(() => Promise.resolve());
});

afterEach(() => {
  emailSpy.mockRestore();
  jest.clearAllMocks();
});

const mockGetStripe = jest.mocked(getStripe);

function makePaymentMethod(overrides: Partial<Stripe.PaymentMethod> = {}): Stripe.PaymentMethod {
  return {
    id: "pm_test",
    type: "card",
    card: { brand: "visa", last4: "4242", exp_month: 12, exp_year: 2030 },
    ...overrides,
  } as unknown as Stripe.PaymentMethod;
}

function buildStripeMock(opts: { paymentMethod?: Stripe.PaymentMethod | null } = {}) {
  const paymentMethod = opts.paymentMethod === undefined ? makePaymentMethod() : opts.paymentMethod;
  const checkoutCreate = jest.fn(async (_params: Stripe.Checkout.SessionCreateParams) => ({
    url: "https://checkout.stripe.com/test",
  }));
  const paymentIntentCreate = jest.fn(async (_params: Stripe.PaymentIntentCreateParams) => ({
    client_secret: "pi_secret_test",
  }));
  const paymentIntentRetrieve = jest.fn(async (id: string) => ({ id, payment_method: paymentMethod }));
  const stripe = {
    checkout: { sessions: { create: checkoutCreate } },
    paymentIntents: { create: paymentIntentCreate, retrieve: paymentIntentRetrieve },
  } as unknown as Stripe;
  return { stripe, checkoutCreate, paymentIntentCreate, paymentIntentRetrieve };
}

let donationCounter = 0;

async function insertDonation(
  userId: string | null,
  opts?: { amount?: number; currency?: string; status?: "pending" | "succeeded" | "failed" | "refunded" }
) {
  donationCounter += 1;
  const db = getAdminDb();
  const [donation] = await db
    .insert(schema.donations)
    .values({
      userId,
      email: "donor@example.com",
      stripePaymentId: `pi_donation_test_${donationCounter}_${Date.now()}`,
      amount: opts?.amount ?? 1000,
      currency: opts?.currency ?? "chf",
      status: opts?.status ?? "succeeded",
    })
    .returning();
  return donation!;
}

describe("Donations — GET /v1/donations", () => {
  beforeEach(cleanDb);

  it("returns the authenticated user's donations ordered newest first, without stripePaymentId", async () => {
    const { jwt, userId } = await createTestUser("donor@test.com", "password123");
    const older = await insertDonation(userId, { amount: 500 });
    await new Promise((r) => setTimeout(r, 10));
    const newer = await insertDonation(userId, { amount: 1500 });

    const res = await request("GET", "/v1/donations", undefined, jwt);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        result: Array<{ id: string; amount: number; currency: string; status: string; createdAt: string }>;
        count: number;
      };
    };

    expect(body.data.count).toBe(2);
    expect(body.data.result).toHaveLength(2);
    expect(body.data.result[0].id).toBe(newer.id);
    expect(body.data.result[0].amount).toBe(1500);
    expect(body.data.result[1].id).toBe(older.id);
    expect(body.data.result[0]).not.toHaveProperty("stripePaymentId");
  });

  it("returns an empty list for a user with no donations", async () => {
    const { jwt } = await createTestUser("no-donations@test.com", "password123");

    const res = await request("GET", "/v1/donations", undefined, jwt);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { result: unknown[]; count: number } };

    expect(body.data.count).toBe(0);
    expect(body.data.result).toEqual([]);
  });

  it("does not return other users' donations or anonymous donations", async () => {
    const { jwt, userId } = await createTestUser("mine@test.com", "password123");
    const { userId: otherUserId } = await createTestUser("other@test.com", "password123");
    const mine = await insertDonation(userId);
    await insertDonation(otherUserId);
    await insertDonation(null);

    const res = await request("GET", "/v1/donations", undefined, jwt);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { result: Array<{ id: string }>; count: number } };

    expect(body.data.count).toBe(1);
    expect(body.data.result[0].id).toBe(mine.id);
  });

  it("rejects unauthenticated requests", async () => {
    const res = await request("GET", "/v1/donations");
    expect(res.status).toBe(401);
  });
});

// Business-logic layer only — express-zod-api is ESM-only and can't be required from a Jest test
// file under this repo's CJS ts-jest config, so (like every other Stripe-touching test here) this
// calls donationsApi directly rather than through the endpoint/HTTP layer.
describe("Donations — createDonationCheckout/createDonationIntent forward userId to Stripe", () => {
  beforeEach(cleanDb);

  const api = donationsApi(adminOnlyDb);

  it("checkout: sets metadata.userId when a userId is passed", async () => {
    const { stripe, checkoutCreate } = buildStripeMock();
    mockGetStripe.mockReturnValue(stripe);

    await api.createDonationCheckout(
      1000,
      "donor@test.com",
      "https://example.com/success",
      "https://example.com/cancel",
      "user-123"
    );

    expect(checkoutCreate.mock.calls[0][0].metadata?.userId).toBe("user-123");
  });

  it("checkout: falls back to an empty userId for anonymous donations", async () => {
    const { stripe, checkoutCreate } = buildStripeMock();
    mockGetStripe.mockReturnValue(stripe);

    await api.createDonationCheckout(
      1000,
      "donor@test.com",
      "https://example.com/success",
      "https://example.com/cancel"
    );

    expect(checkoutCreate.mock.calls[0][0].metadata?.userId).toBe("");
  });

  it("intent: sets metadata.userId when a userId is passed", async () => {
    const { stripe, paymentIntentCreate } = buildStripeMock();
    mockGetStripe.mockReturnValue(stripe);

    await api.createDonationIntent(1000, "donor@test.com", "user-456");

    expect(paymentIntentCreate.mock.calls[0][0].metadata?.userId).toBe("user-456");
  });

  it("intent: falls back to an empty userId for anonymous donations", async () => {
    const { stripe, paymentIntentCreate } = buildStripeMock();
    mockGetStripe.mockReturnValue(stripe);

    await api.createDonationIntent(1000, "donor@test.com");

    expect(paymentIntentCreate.mock.calls[0][0].metadata?.userId).toBe("");
  });
});

function makeCheckoutSession(overrides: Partial<Stripe.Checkout.Session> = {}): Stripe.Checkout.Session {
  return {
    id: "cs_test_default",
    payment_intent: "pi_test_default",
    amount_total: 1000,
    currency: "chf",
    customer_email: "donor@test.com",
    customer_details: null,
    metadata: { type: "donation", userId: "", locale: "de" },
    ...overrides,
  } as unknown as Stripe.Checkout.Session;
}

function makeDonationPaymentIntent(overrides: Partial<Stripe.PaymentIntent> = {}): Stripe.PaymentIntent {
  return {
    id: "pi_test_default",
    amount: 1000,
    currency: "chf",
    receipt_email: "donor@test.com",
    metadata: { type: "donation", userId: "", locale: "de", email: "donor@test.com" },
    ...overrides,
  } as unknown as Stripe.PaymentIntent;
}

describe("Donations — webhook handlers record the payment method used", () => {
  beforeEach(cleanDb);

  const api = donationsApi(adminOnlyDb);

  it("checkout: stores card details for a card payment", async () => {
    const { stripe } = buildStripeMock({ paymentMethod: makePaymentMethod() });
    mockGetStripe.mockReturnValue(stripe);

    await api.handleDonationWebhook(makeCheckoutSession({ id: "cs_card", payment_intent: "pi_card" }));

    const donation = await getAdminDb().query.donations.findFirst({ where: { stripePaymentId: "pi_card" } });
    expect(donation?.paymentMethodType).toBe("card");
    expect(donation?.cardBrand).toBe("visa");
    expect(donation?.cardLast4).toBe("4242");
  });

  it("checkout: stores paymentMethodType without card details for twint", async () => {
    const twint = makePaymentMethod({ type: "twint", card: undefined });
    const { stripe } = buildStripeMock({ paymentMethod: twint });
    mockGetStripe.mockReturnValue(stripe);

    await api.handleDonationWebhook(makeCheckoutSession({ id: "cs_twint", payment_intent: "pi_twint" }));

    const donation = await getAdminDb().query.donations.findFirst({ where: { stripePaymentId: "pi_twint" } });
    expect(donation?.paymentMethodType).toBe("twint");
    expect(donation?.cardBrand).toBeNull();
    expect(donation?.cardLast4).toBeNull();
  });

  it("intent: stores card details for a card payment", async () => {
    const { stripe } = buildStripeMock({ paymentMethod: makePaymentMethod() });
    mockGetStripe.mockReturnValue(stripe);

    await api.handleDonationPaymentIntentWebhook(makeDonationPaymentIntent({ id: "pi_intent_card" }));

    const donation = await getAdminDb().query.donations.findFirst({ where: { stripePaymentId: "pi_intent_card" } });
    expect(donation?.paymentMethodType).toBe("card");
    expect(donation?.cardBrand).toBe("visa");
    expect(donation?.cardLast4).toBe("4242");
  });

  it("still records the donation when fetching the payment method fails", async () => {
    const { stripe, paymentIntentRetrieve } = buildStripeMock();
    paymentIntentRetrieve.mockRejectedValue(new Error("Stripe unavailable"));
    mockGetStripe.mockReturnValue(stripe);
    const consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    await api.handleDonationPaymentIntentWebhook(makeDonationPaymentIntent({ id: "pi_intent_stripe_down" }));

    const donation = await getAdminDb().query.donations.findFirst({
      where: { stripePaymentId: "pi_intent_stripe_down" },
    });
    expect(donation?.status).toBe("succeeded");
    expect(donation?.paymentMethodType).toBeNull();
    expect(donation?.cardLast4).toBeNull();
    consoleErrorSpy.mockRestore();
  });

  it("intent: stores paymentMethodType without card details for twint", async () => {
    const twint = makePaymentMethod({ type: "twint", card: undefined });
    const { stripe } = buildStripeMock({ paymentMethod: twint });
    mockGetStripe.mockReturnValue(stripe);

    await api.handleDonationPaymentIntentWebhook(makeDonationPaymentIntent({ id: "pi_intent_twint" }));

    const donation = await getAdminDb().query.donations.findFirst({ where: { stripePaymentId: "pi_intent_twint" } });
    expect(donation?.paymentMethodType).toBe("twint");
    expect(donation?.cardBrand).toBeNull();
    expect(donation?.cardLast4).toBeNull();
  });
});
