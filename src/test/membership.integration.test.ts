// jest.mock is hoisted before imports by Jest
jest.mock("../stripe/stripe");

import { describe, it, expect, beforeEach, beforeAll, afterEach, jest } from "@jest/globals";
import i18next from "i18next";
import de from "../../resources/locales/de.json";
import en from "../../resources/locales/en.json";
import itLocale from "../../resources/locales/it.json";
import fr from "../../resources/locales/fr.json";
import Stripe from "stripe";
import { adminOnlyDb } from "../db/db";
import { getAdminDb, cleanDb, createTestUser } from "./helpers";
import { createUserWithFarm } from "./test-utils";
import { membershipApi } from "../membership/membership";
import { runExpiryNotifications } from "../membership/membership-expiry-cron";
import { eq } from "drizzle-orm";
import { membershipPayments, userSubscriptions, membershipExpiryNotifications, userTrials } from "../db/schema";
import * as brevo from "../brevo/brevo";
import { getStripe } from "../stripe/stripe";

// ---------------------------------------------------------------------------
// i18next initialization — email functions call getFixedT(locale)
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Stripe mock
// ---------------------------------------------------------------------------
const mockGetStripe = jest.mocked(getStripe);

// ---------------------------------------------------------------------------
// Email spy
// ---------------------------------------------------------------------------
let emailSpy: jest.SpiedFunction<typeof brevo.txEmailApi.sendTransacEmail>;

beforeEach(async () => {
  await cleanDb();
  emailSpy = jest.spyOn(brevo.txEmailApi, "sendTransacEmail").mockImplementation(() => Promise.resolve());
});

afterEach(() => {
  emailSpy.mockRestore();
  jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

let paymentCounter = 0;

async function insertPayment(
  userId: string,
  periodEnd: Date,
  opts?: {
    status?: "succeeded" | "failed" | "pending";
    stripePaymentId?: string;
    stripeSubscriptionId?: string;
    amount?: number;
  }
) {
  paymentCounter += 1;
  const db = getAdminDb();
  await db.insert(membershipPayments).values({
    userId,
    stripePaymentId: opts?.stripePaymentId ?? `pi_test_${paymentCounter}_${Date.now()}`,
    stripeSubscriptionId: opts?.stripeSubscriptionId ?? null,
    amount: opts?.amount ?? 29000,
    currency: "chf",
    status: opts?.status ?? "succeeded",
    periodEnd,
  });
}

async function insertSubscription(userId: string, stripeSubscriptionId?: string) {
  const subId = stripeSubscriptionId ?? `sub_test_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const db = getAdminDb();
  await db.insert(userSubscriptions).values({
    userId,
    stripeSubscriptionId: subId,
    cancelAtPeriodEnd: false,
  });
  return subId;
}

async function insertNotification(
  userId: string,
  periodEndDate: Date,
  type: "payment_failed" | "expiry_reminder" | "access_lost" | "membership_ended"
) {
  const db = getAdminDb();
  await db.insert(membershipExpiryNotifications).values({ userId, periodEndDate, type });
}

// ---------------------------------------------------------------------------
// Stripe fixture builders
// ---------------------------------------------------------------------------

function daysFromNow(n: number): Date {
  return new Date(Date.now() + n * 24 * 60 * 60 * 1000);
}

function daysAgo(n: number): Date {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000);
}

function makeStripeSubscription(overrides: Record<string, unknown> = {}): Stripe.Subscription {
  const periodEnd = daysFromNow(365);
  return {
    id: "sub_default",
    cancel_at_period_end: false,
    items: {
      data: [{ current_period_end: Math.floor(periodEnd.getTime() / 1000) }],
    },
    latest_invoice: "in_default",
    default_payment_method: null,
    ...overrides,
  } as unknown as Stripe.Subscription;
}

function makeStripeInvoice(overrides: Record<string, unknown> = {}): Stripe.Invoice {
  return {
    id: "in_default",
    amount_paid: 29000,
    currency: "chf",
    billing_reason: "subscription_create",
    parent: {
      subscription_details: { subscription: "sub_default" },
    },
    ...overrides,
  } as unknown as Stripe.Invoice;
}

function makePaymentMethod(overrides: Record<string, unknown> = {}): Stripe.PaymentMethod {
  return {
    id: "pm_default",
    type: "card",
    card: {
      last4: "4242",
      brand: "visa",
      exp_month: 12,
      exp_year: 2027,
    },
    ...overrides,
  } as unknown as Stripe.PaymentMethod;
}

function makePaymentIntent(overrides: Record<string, unknown> = {}): Stripe.PaymentIntent {
  return {
    id: "pi_default",
    payment_method: "pm_default",
    ...overrides,
  } as unknown as Stripe.PaymentIntent;
}

function makeSetupIntent(overrides: Record<string, unknown> = {}): Stripe.SetupIntent {
  return {
    id: "si_default",
    payment_method: "pm_default",
    ...overrides,
  } as unknown as Stripe.SetupIntent;
}

/** Build a partial Stripe-like mock. The cast is unavoidable for test fixtures. */
function buildStripeMock(opts: {
  subscription?: Stripe.Subscription;
  invoice?: Stripe.Invoice;
  paymentMethod?: Stripe.PaymentMethod | null;
  paymentIntent?: Stripe.PaymentIntent;
  setupIntent?: Stripe.SetupIntent;
  checkoutSessionUrl?: string;
}): Stripe {
  const subscription = opts.subscription ?? makeStripeSubscription();
  const invoice = opts.invoice ?? makeStripeInvoice();
  const paymentMethod = opts.paymentMethod ?? makePaymentMethod();
  const paymentIntent = opts.paymentIntent ?? makePaymentIntent();
  const setupIntent = opts.setupIntent ?? makeSetupIntent();
  const checkoutSessionUrl = opts.checkoutSessionUrl ?? "https://checkout.stripe.com/test";
  return {
    subscriptions: {
      retrieve: jest.fn().mockImplementation(async () => subscription),
      update: jest.fn().mockImplementation(async () => ({})),
      create: jest.fn().mockImplementation(async () => subscription),
      cancel: jest.fn().mockImplementation(async () => ({})),
    },
    invoices: {
      retrieve: jest.fn().mockImplementation(async () => invoice),
    },
    paymentMethods: {
      retrieve: jest.fn().mockImplementation(async () => paymentMethod),
    },
    paymentIntents: {
      retrieve: jest.fn().mockImplementation(async () => paymentIntent),
      create: jest.fn().mockImplementation(async () => ({ ...paymentIntent, client_secret: "pi_secret_test" })),
    },
    setupIntents: {
      retrieve: jest.fn().mockImplementation(async () => setupIntent),
    },
    ephemeralKeys: {
      create: jest.fn().mockImplementation(async () => ({ secret: "ek_secret_test" })),
    },
    customers: {
      create: jest.fn().mockImplementation(async () => ({ id: "cus_test" })),
    },
    prices: {
      retrieve: jest.fn().mockImplementation(async () => ({
        unit_amount: 29000,
        currency: "chf",
      })),
    },
    checkout: {
      sessions: {
        create: jest.fn().mockImplementation(async () => ({ url: checkoutSessionUrl })),
      },
    },
  } as unknown as Stripe;
}

// ---------------------------------------------------------------------------
// Stripe event builders
// ---------------------------------------------------------------------------

function makeCheckoutSubscriptionEvent(userId: string, subId: string, invoiceId = "in_123"): Stripe.Event {
  return {
    type: "checkout.session.completed",
    data: {
      object: {
        mode: "subscription",
        subscription: subId,
        metadata: { userId, type: "membership" },
        setup_intent: null,
      },
    },
  } as unknown as Stripe.Event;
}

function makeCheckoutPaymentEvent(userId: string, paymentIntentId: string): Stripe.Event {
  return {
    type: "checkout.session.completed",
    data: {
      object: {
        mode: "payment",
        payment_intent: paymentIntentId,
        amount_total: 29000,
        currency: "chf",
        metadata: { userId, type: "membership" },
        setup_intent: null,
      },
    },
  } as unknown as Stripe.Event;
}

function makeCheckoutSetupEvent(userId: string, setupIntentId: string): Stripe.Event {
  return {
    type: "checkout.session.completed",
    data: {
      object: {
        mode: "setup",
        setup_intent: setupIntentId,
        payment_intent: null,
        subscription: null,
        metadata: { userId, type: "payment_method_setup" },
      },
    },
  } as unknown as Stripe.Event;
}

function makeInvoiceSucceededEvent(
  subId: string,
  invoiceId: string,
  overrides: Record<string, unknown> = {}
): Stripe.Event {
  return {
    type: "invoice.payment_succeeded",
    data: {
      object: {
        id: invoiceId,
        amount_paid: 29000,
        currency: "chf",
        billing_reason: "subscription_create",
        parent: { subscription_details: { subscription: subId } },
        ...overrides,
      },
    },
  } as unknown as Stripe.Event;
}

function makeInvoiceFailedEvent(subId: string, invoiceId: string): Stripe.Event {
  return {
    type: "invoice.payment_failed",
    data: {
      object: {
        id: invoiceId,
        amount_due: 29000,
        currency: "chf",
        parent: { subscription_details: { subscription: subId } },
      },
    },
  } as unknown as Stripe.Event;
}

function makeSubscriptionUpdatedEvent(subId: string, cancelAtPeriodEnd: boolean, status?: string): Stripe.Event {
  return {
    type: "customer.subscription.updated",
    data: {
      object: { id: subId, cancel_at_period_end: cancelAtPeriodEnd, status },
    },
  } as unknown as Stripe.Event;
}

function makeSubscriptionDeletedEvent(subId: string): Stripe.Event {
  return {
    type: "customer.subscription.deleted",
    data: {
      object: { id: subId },
    },
  } as unknown as Stripe.Event;
}

function makePaymentIntentSucceededEvent(userId: string, paymentIntent: Stripe.PaymentIntent): Stripe.Event {
  return {
    type: "payment_intent.succeeded",
    data: {
      object: { ...paymentIntent, metadata: { userId, type: "membership" } },
    },
  } as unknown as Stripe.Event;
}

// ---------------------------------------------------------------------------
// A. checkout.session.completed — subscription
// ---------------------------------------------------------------------------
describe("checkout.session.completed — subscription", () => {
  it("first-time subscription inserts payment + subscription + sends welcome email", async () => {
    const { userId } = await createTestUser("a1@test.com", "password123");
    const api = membershipApi(adminOnlyDb);

    const periodEnd = daysFromNow(365);
    const sub = makeStripeSubscription({
      id: "sub_a1",
      latest_invoice: "in_a1",
      items: { data: [{ current_period_end: Math.floor(periodEnd.getTime() / 1000) }] },
    });
    const invoice = makeStripeInvoice({ id: "in_a1", amount_paid: 29000 });
    mockGetStripe.mockReturnValue(buildStripeMock({ subscription: sub, invoice }));

    await api.handleWebhookEvent(makeCheckoutSubscriptionEvent(userId, "sub_a1", "in_a1"));

    const db = getAdminDb();
    const payment = await db.query.membershipPayments.findFirst({ where: { userId, status: "succeeded" } });
    expect(payment).toBeDefined();
    expect(payment!.stripeSubscriptionId).toBe("sub_a1");

    const subRow = await db.query.userSubscriptions.findFirst({ where: { userId } });
    expect(subRow).toBeDefined();
    expect(subRow!.stripeSubscriptionId).toBe("sub_a1");

    expect(emailSpy).toHaveBeenCalledTimes(1);
    expect(emailSpy.mock.calls[0]?.[0]?.subject).toContain("Willkommen");
    expect(emailSpy.mock.calls[0]?.[0]?.to?.[0]?.email).toBe("a1@test.com");
  });

  it("$0 first invoice (promotion code) sends the normal welcome email with receipt, no trial block", async () => {
    const { userId } = await createTestUser("a2@test.com", "password123");
    const api = membershipApi(adminOnlyDb);

    const sub = makeStripeSubscription({ id: "sub_a2", latest_invoice: "in_a2" });
    const invoice = makeStripeInvoice({ id: "in_a2", amount_paid: 0, amount_due: 0 });
    mockGetStripe.mockReturnValue(buildStripeMock({ subscription: sub, invoice }));

    await api.handleWebhookEvent(makeCheckoutSubscriptionEvent(userId, "sub_a2", "in_a2"));

    expect(emailSpy).toHaveBeenCalledTimes(1);
    const sent = emailSpy.mock.calls[0]?.[0];
    expect(sent?.subject).toContain("deine Mitgliedschaft ist aktiv");
    expect(sent?.htmlContent).toContain("Zahlungsbestätigung");
    expect(sent?.htmlContent).not.toContain("Testphase");
  });

  it("reactivation (prior succeeded payment) sends reactivation email", async () => {
    const { userId } = await createTestUser("a3@test.com", "password123");
    await insertPayment(userId, daysFromNow(30), { stripePaymentId: "pi_prior_a3" });
    const api = membershipApi(adminOnlyDb);

    const periodEnd = daysFromNow(365);
    const sub = makeStripeSubscription({
      id: "sub_a3",
      latest_invoice: "in_a3",
      items: { data: [{ current_period_end: Math.floor(periodEnd.getTime() / 1000) }] },
    });
    const invoice = makeStripeInvoice({ id: "in_a3", amount_paid: 29000 });
    mockGetStripe.mockReturnValue(buildStripeMock({ subscription: sub, invoice }));

    await api.handleWebhookEvent(makeCheckoutSubscriptionEvent(userId, "sub_a3", "in_a3"));

    expect(emailSpy).toHaveBeenCalledTimes(1);
    // Reactivation subject contains "zurück"
    expect(emailSpy.mock.calls[0]?.[0]?.subject).toContain("zurück");
  });

  it("upserts userSubscriptions row if user already has one", async () => {
    const { userId } = await createTestUser("a4@test.com", "password123");
    await insertSubscription(userId, "sub_a4_old");
    const api = membershipApi(adminOnlyDb);

    const periodEnd = daysFromNow(365);
    const sub = makeStripeSubscription({
      id: "sub_a4_new",
      latest_invoice: null,
      items: { data: [{ current_period_end: Math.floor(periodEnd.getTime() / 1000) }] },
    });
    mockGetStripe.mockReturnValue(buildStripeMock({ subscription: sub }));

    await expect(api.handleWebhookEvent(makeCheckoutSubscriptionEvent(userId, "sub_a4_new"))).resolves.not.toThrow();

    const db = getAdminDb();
    const subRow = await db.query.userSubscriptions.findFirst({ where: { userId } });
    expect(subRow!.stripeSubscriptionId).toBe("sub_a4_new");
  });

  it("missing userId in metadata returns early — no DB writes", async () => {
    const api = membershipApi(adminOnlyDb);
    mockGetStripe.mockReturnValue(buildStripeMock({}));

    const event = {
      type: "checkout.session.completed",
      data: { object: { mode: "subscription", subscription: "sub_x", metadata: {} } },
    } as unknown as Stripe.Event;

    await api.handleWebhookEvent(event);

    const db = getAdminDb();
    const payments = await db.query.membershipPayments.findMany({});
    expect(payments).toHaveLength(0);
    expect(emailSpy).not.toHaveBeenCalled();
  });

  it("setup mode — updates subscription payment method, no email, no payment row", async () => {
    const { userId } = await createTestUser("a6@test.com", "password123");
    const subId = await insertSubscription(userId, "sub_a6");
    const api = membershipApi(adminOnlyDb);

    mockGetStripe.mockReturnValue(
      buildStripeMock({ setupIntent: makeSetupIntent({ id: "si_a6", payment_method: "pm_a6" }) })
    );

    await api.handleWebhookEvent(makeCheckoutSetupEvent(userId, "si_a6"));

    const db = getAdminDb();
    const payments = await db.query.membershipPayments.findMany({});
    expect(payments).toHaveLength(0);
    expect(emailSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// B. checkout.session.completed — manual payment
// ---------------------------------------------------------------------------
describe("checkout.session.completed — manual payment", () => {
  it("first manual payment inserts row and sends welcome email", async () => {
    const { userId } = await createTestUser("b1@test.com", "password123");
    const api = membershipApi(adminOnlyDb);

    const pm = makePaymentMethod({ id: "pm_b1", card: { last4: "0001", brand: "visa", exp_month: 1, exp_year: 2030 } });
    const pi = makePaymentIntent({ id: "pi_b1", payment_method: "pm_b1" });
    mockGetStripe.mockReturnValue(buildStripeMock({ paymentMethod: pm, paymentIntent: pi }));

    await api.handleWebhookEvent(makeCheckoutPaymentEvent(userId, "pi_b1"));

    const db = getAdminDb();
    const payment = await db.query.membershipPayments.findFirst({ where: { userId, status: "succeeded" } });
    expect(payment).toBeDefined();
    expect(payment!.amount).toBe(29000);

    // periodEnd should be ~1 year from now (within a 5-minute window)
    const expectedEnd = new Date();
    expectedEnd.setFullYear(expectedEnd.getFullYear() + 1);
    const diffMs = Math.abs(payment!.periodEnd.getTime() - expectedEnd.getTime());
    expect(diffMs).toBeLessThan(5 * 60 * 1000);

    expect(emailSpy).toHaveBeenCalledTimes(1);
    expect(emailSpy.mock.calls[0]?.[0]?.subject).toContain("Willkommen");
  });

  it("manual renewal after the membership lapsed sends reactivation ('welcome back') email", async () => {
    const { userId } = await createTestUser("b2@test.com", "password123");
    await insertPayment(userId, daysAgo(5), { stripePaymentId: "pi_b2_prior" });
    const api = membershipApi(adminOnlyDb);

    const pi = makePaymentIntent({ id: "pi_b2_new", payment_method: null });
    mockGetStripe.mockReturnValue(buildStripeMock({ paymentIntent: pi, paymentMethod: null }));

    await api.handleWebhookEvent(makeCheckoutPaymentEvent(userId, "pi_b2_new"));

    expect(emailSpy).toHaveBeenCalledTimes(1);
    expect(emailSpy.mock.calls[0]?.[0]?.subject).toContain("zurück");
  });

  it("manual renewal while still active sends a renewal email, not 'welcome back'", async () => {
    const { userId } = await createTestUser("b2b@test.com", "password123");
    await insertPayment(userId, daysFromNow(10), { stripePaymentId: "pi_b2b_prior" });
    const api = membershipApi(adminOnlyDb);

    const pi = makePaymentIntent({ id: "pi_b2b_new", payment_method: null });
    mockGetStripe.mockReturnValue(buildStripeMock({ paymentIntent: pi, paymentMethod: null }));

    await api.handleWebhookEvent(makeCheckoutPaymentEvent(userId, "pi_b2b_new"));

    expect(emailSpy).toHaveBeenCalledTimes(1);
    expect(emailSpy.mock.calls[0]?.[0]?.subject).toContain("erneuert");
  });

  it("early renewal (still in current period) stacks the new year on top of the remaining time", async () => {
    const { userId } = await createTestUser("b4@test.com", "password123");
    const currentPeriodEnd = daysFromNow(10);
    await insertPayment(userId, currentPeriodEnd, { stripePaymentId: "pi_b4_prior" });
    const api = membershipApi(adminOnlyDb);

    const pi = makePaymentIntent({ id: "pi_b4_new", payment_method: null });
    mockGetStripe.mockReturnValue(buildStripeMock({ paymentIntent: pi, paymentMethod: null }));

    await api.handleWebhookEvent(makeCheckoutPaymentEvent(userId, "pi_b4_new"));

    const db = getAdminDb();
    const newPayment = await db.query.membershipPayments.findFirst({ where: { stripePaymentId: "pi_b4_new" } });
    const expectedEnd = new Date(currentPeriodEnd);
    expectedEnd.setFullYear(expectedEnd.getFullYear() + 1);
    expect(newPayment!.periodEnd.getTime()).toBeCloseTo(expectedEnd.getTime(), -3);
  });

  it("renewal after the period already lapsed resets from today (no stacking across a gap)", async () => {
    const { userId } = await createTestUser("b5@test.com", "password123");
    await insertPayment(userId, daysAgo(30), { stripePaymentId: "pi_b5_prior" });
    const api = membershipApi(adminOnlyDb);

    const pi = makePaymentIntent({ id: "pi_b5_new", payment_method: null });
    mockGetStripe.mockReturnValue(buildStripeMock({ paymentIntent: pi, paymentMethod: null }));

    await api.handleWebhookEvent(makeCheckoutPaymentEvent(userId, "pi_b5_new"));

    const db = getAdminDb();
    const newPayment = await db.query.membershipPayments.findFirst({ where: { stripePaymentId: "pi_b5_new" } });
    const expectedEnd = new Date();
    expectedEnd.setFullYear(expectedEnd.getFullYear() + 1);
    const diffMs = Math.abs(newPayment!.periodEnd.getTime() - expectedEnd.getTime());
    expect(diffMs).toBeLessThan(5 * 60 * 1000);
  });

  it("Twint payment (no card) sends email without card info", async () => {
    const { userId } = await createTestUser("b3@test.com", "password123");
    const api = membershipApi(adminOnlyDb);

    const pm = { id: "pm_b3", type: "twint", card: null } as unknown as Stripe.PaymentMethod;
    const pi = makePaymentIntent({ id: "pi_b3", payment_method: "pm_b3" });
    mockGetStripe.mockReturnValue(buildStripeMock({ paymentMethod: pm, paymentIntent: pi }));

    await api.handleWebhookEvent(makeCheckoutPaymentEvent(userId, "pi_b3"));

    expect(emailSpy).toHaveBeenCalledTimes(1);

    const db = getAdminDb();
    const payment = await db.query.membershipPayments.findFirst({ where: { userId } });
    expect(payment!.cardLast4).toBeNull();
    expect(payment!.cardBrand).toBeNull();
    expect(payment!.paymentMethodType).toBe("twint");
  });
});

// ---------------------------------------------------------------------------
// B2. payment_intent.succeeded — manual payment (native PaymentSheet)
// ---------------------------------------------------------------------------
describe("payment_intent.succeeded — manual payment (native)", () => {
  it("first manual payment inserts row and sends welcome email", async () => {
    const { userId } = await createTestUser("b6@test.com", "password123");
    const api = membershipApi(adminOnlyDb);

    const pm = makePaymentMethod({ id: "pm_b6", card: { last4: "0006", brand: "visa", exp_month: 1, exp_year: 2030 } });
    mockGetStripe.mockReturnValue(buildStripeMock({ paymentMethod: pm }));

    const pi = makePaymentIntent({ id: "pi_b6", payment_method: "pm_b6", amount: 29000, currency: "chf" });
    await api.handleWebhookEvent(makePaymentIntentSucceededEvent(userId, pi));

    const db = getAdminDb();
    const payment = await db.query.membershipPayments.findFirst({ where: { userId, status: "succeeded" } });
    expect(payment).toBeDefined();
    expect(payment!.amount).toBe(29000);
    expect(emailSpy).toHaveBeenCalledTimes(1);
  });

  it("early renewal (still in current period) stacks the new year on top of the remaining time", async () => {
    const { userId } = await createTestUser("b7@test.com", "password123");
    const currentPeriodEnd = daysFromNow(10);
    await insertPayment(userId, currentPeriodEnd, { stripePaymentId: "pi_b7_prior" });
    const api = membershipApi(adminOnlyDb);

    mockGetStripe.mockReturnValue(buildStripeMock({ paymentMethod: null }));
    const pi = makePaymentIntent({ id: "pi_b7_new", payment_method: null, amount: 29000, currency: "chf" });
    await api.handleWebhookEvent(makePaymentIntentSucceededEvent(userId, pi));

    const db = getAdminDb();
    const newPayment = await db.query.membershipPayments.findFirst({ where: { stripePaymentId: "pi_b7_new" } });
    const expectedEnd = new Date(currentPeriodEnd);
    expectedEnd.setFullYear(expectedEnd.getFullYear() + 1);
    expect(newPayment!.periodEnd.getTime()).toBeCloseTo(expectedEnd.getTime(), -3);

    expect(emailSpy).toHaveBeenCalledTimes(1);
    expect(emailSpy.mock.calls[0]?.[0]?.subject).toContain("erneuert");
  });
});

// ---------------------------------------------------------------------------
// C. invoice.payment_succeeded
// ---------------------------------------------------------------------------
describe("invoice.payment_succeeded", () => {
  it("subscription_create — inserts payment and sends welcome email (native PaymentSheet subscription, no Checkout Session)", async () => {
    const { userId } = await createTestUser("c1@test.com", "password123");
    await insertSubscription(userId, "sub_c1");
    const api = membershipApi(adminOnlyDb);

    const sub = makeStripeSubscription({ id: "sub_c1" });
    mockGetStripe.mockReturnValue(buildStripeMock({ subscription: sub }));

    await api.handleWebhookEvent(
      makeInvoiceSucceededEvent("sub_c1", "in_c1", { billing_reason: "subscription_create" })
    );

    const db = getAdminDb();
    const payment = await db.query.membershipPayments.findFirst({ where: { userId } });
    expect(payment).toBeDefined();
    expect(emailSpy).toHaveBeenCalledTimes(1);
    expect(emailSpy.mock.calls[0]?.[0]?.subject).toContain("Willkommen");
  });

  it("subscription_create — already recorded via checkout.session.completed — no duplicate email", async () => {
    const { userId } = await createTestUser("c1b@test.com", "password123");
    await insertSubscription(userId, "sub_c1b");
    // Simulates checkout.session.completed's subscription branch having already inserted this
    // same invoice (Checkout Session flow, as opposed to the native PaymentSheet flow above).
    await insertPayment(userId, daysFromNow(365), {
      stripePaymentId: "in_c1b",
      stripeSubscriptionId: "sub_c1b",
    });
    const api = membershipApi(adminOnlyDb);

    const sub = makeStripeSubscription({ id: "sub_c1b" });
    mockGetStripe.mockReturnValue(buildStripeMock({ subscription: sub }));

    await api.handleWebhookEvent(
      makeInvoiceSucceededEvent("sub_c1b", "in_c1b", { billing_reason: "subscription_create" })
    );

    expect(emailSpy).not.toHaveBeenCalled();
  });

  it("subscription_cycle after $0 sends first payment email", async () => {
    const { userId } = await createTestUser("c2@test.com", "password123");
    await insertSubscription(userId, "sub_c2");
    // Prior $0 payment (trial checkout)
    await insertPayment(userId, daysFromNow(30), {
      stripePaymentId: "in_c2_trial",
      stripeSubscriptionId: "sub_c2",
      amount: 0,
    });
    const api = membershipApi(adminOnlyDb);

    const sub = makeStripeSubscription({ id: "sub_c2" });
    mockGetStripe.mockReturnValue(buildStripeMock({ subscription: sub }));

    await api.handleWebhookEvent(
      makeInvoiceSucceededEvent("sub_c2", "in_c2_cycle", { billing_reason: "subscription_cycle", amount_paid: 29000 })
    );

    expect(emailSpy).toHaveBeenCalledTimes(1);
    expect(emailSpy.mock.calls[0]?.[0]?.subject).toContain("abgerechnet");
  });

  it("subscription_cycle with prior non-zero payment sends renewal email", async () => {
    const { userId } = await createTestUser("c3@test.com", "password123");
    await insertSubscription(userId, "sub_c3");
    await insertPayment(userId, daysFromNow(30), {
      stripePaymentId: "in_c3_prior",
      stripeSubscriptionId: "sub_c3",
      amount: 29000,
    });
    const api = membershipApi(adminOnlyDb);

    const sub = makeStripeSubscription({ id: "sub_c3" });
    mockGetStripe.mockReturnValue(buildStripeMock({ subscription: sub }));

    await api.handleWebhookEvent(
      makeInvoiceSucceededEvent("sub_c3", "in_c3_cycle", { billing_reason: "subscription_cycle", amount_paid: 29000 })
    );

    expect(emailSpy).toHaveBeenCalledTimes(1);
    expect(emailSpy.mock.calls[0]?.[0]?.subject).toContain("erneuert");
  });

  it("no matching userSubscription — early return, no DB writes", async () => {
    const api = membershipApi(adminOnlyDb);
    const sub = makeStripeSubscription({ id: "sub_nobody" });
    mockGetStripe.mockReturnValue(buildStripeMock({ subscription: sub }));

    await api.handleWebhookEvent(makeInvoiceSucceededEvent("sub_nobody", "in_nobody"));

    const db = getAdminDb();
    const payments = await db.query.membershipPayments.findMany({});
    expect(payments).toHaveLength(0);
    expect(emailSpy).not.toHaveBeenCalled();
  });

  it("idempotency — same invoice twice inserts only one row, one email", async () => {
    const { userId } = await createTestUser("c5@test.com", "password123");
    await insertSubscription(userId, "sub_c5");
    const api = membershipApi(adminOnlyDb);

    const sub = makeStripeSubscription({ id: "sub_c5" });
    mockGetStripe.mockReturnValue(buildStripeMock({ subscription: sub }));

    const event = makeInvoiceSucceededEvent("sub_c5", "in_c5_idem", {
      billing_reason: "subscription_cycle",
      amount_paid: 29000,
    });
    await api.handleWebhookEvent(event);
    await api.handleWebhookEvent(event);

    const db = getAdminDb();
    const payments = await db.query.membershipPayments.findMany({ where: { userId } });
    expect(payments).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// D. invoice.payment_failed
// ---------------------------------------------------------------------------
describe("invoice.payment_failed", () => {
  it("happy path — inserts failed payment, notification, sends payment_failed email", async () => {
    const { userId } = await createTestUser("d1@test.com", "password123");
    const periodEnd = daysFromNow(5);
    await insertSubscription(userId, "sub_d1");
    await insertPayment(userId, periodEnd, { stripePaymentId: "in_d1_succeeded", stripeSubscriptionId: "sub_d1" });
    const api = membershipApi(adminOnlyDb);
    mockGetStripe.mockReturnValue(buildStripeMock({}));

    await api.handleWebhookEvent(makeInvoiceFailedEvent("sub_d1", "in_d1_failed"));

    const db = getAdminDb();
    const failedPayment = await db.query.membershipPayments.findFirst({ where: { userId, status: "failed" } });
    expect(failedPayment).toBeDefined();
    expect(failedPayment!.periodEnd.getTime()).toBe(0);

    const notification = await db.query.membershipExpiryNotifications.findFirst({ where: { userId } });
    expect(notification).toBeDefined();
    expect(notification!.type).toBe("payment_failed");

    expect(emailSpy).toHaveBeenCalledTimes(1);
    expect(emailSpy.mock.calls[0]?.[0]?.to?.[0]?.email).toBe("d1@test.com");
    expect(emailSpy.mock.calls[0]?.[0]?.subject).toContain("Zahlung fehlgeschlagen");
  });

  it("idempotency — firing twice sends email only once", async () => {
    const { userId } = await createTestUser("d2@test.com", "password123");
    await insertSubscription(userId, "sub_d2");
    await insertPayment(userId, daysFromNow(5), { stripePaymentId: "in_d2_ok", stripeSubscriptionId: "sub_d2" });
    const api = membershipApi(adminOnlyDb);
    mockGetStripe.mockReturnValue(buildStripeMock({}));

    await api.handleWebhookEvent(makeInvoiceFailedEvent("sub_d2", "in_d2_failed_1"));
    await api.handleWebhookEvent(makeInvoiceFailedEvent("sub_d2", "in_d2_failed_2"));

    // Second firing: notification already exists → no new email
    expect(emailSpy).toHaveBeenCalledTimes(1);
  });

  it("no prior succeeded payment — inserts failed row but no notification, no email", async () => {
    const { userId } = await createTestUser("d3@test.com", "password123");
    await insertSubscription(userId, "sub_d3");
    const api = membershipApi(adminOnlyDb);
    mockGetStripe.mockReturnValue(buildStripeMock({}));

    await api.handleWebhookEvent(makeInvoiceFailedEvent("sub_d3", "in_d3_fail"));

    const db = getAdminDb();
    const failedPayment = await db.query.membershipPayments.findFirst({ where: { userId, status: "failed" } });
    expect(failedPayment).toBeDefined();

    const notification = await db.query.membershipExpiryNotifications.findFirst({ where: { userId } });
    expect(notification).toBeUndefined();
    expect(emailSpy).not.toHaveBeenCalled();
  });

  it("no matching subscription — early return, no DB writes", async () => {
    const api = membershipApi(adminOnlyDb);
    mockGetStripe.mockReturnValue(buildStripeMock({}));

    await api.handleWebhookEvent(makeInvoiceFailedEvent("sub_nobody", "in_nobody"));

    const db = getAdminDb();
    const payments = await db.query.membershipPayments.findMany({});
    expect(payments).toHaveLength(0);
    expect(emailSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// E. customer.subscription.updated
// ---------------------------------------------------------------------------
describe("customer.subscription.updated", () => {
  it("sets cancelAtPeriodEnd to true", async () => {
    const { userId } = await createTestUser("e1@test.com", "password123");
    await insertSubscription(userId, "sub_e1");
    const api = membershipApi(adminOnlyDb);
    mockGetStripe.mockReturnValue(buildStripeMock({}));

    await api.handleWebhookEvent(makeSubscriptionUpdatedEvent("sub_e1", true));

    const db = getAdminDb();
    const subRow = await db.query.userSubscriptions.findFirst({ where: { userId } });
    expect(subRow!.cancelAtPeriodEnd).toBe(true);
  });

  it("sets cancelAtPeriodEnd to false (reactivation)", async () => {
    const { userId } = await createTestUser("e2@test.com", "password123");
    const db = getAdminDb();
    await db.insert(userSubscriptions).values({
      userId,
      stripeSubscriptionId: "sub_e2",
      cancelAtPeriodEnd: true,
    });
    const api = membershipApi(adminOnlyDb);
    mockGetStripe.mockReturnValue(buildStripeMock({}));

    await api.handleWebhookEvent(makeSubscriptionUpdatedEvent("sub_e2", false));

    const subRow = await db.query.userSubscriptions.findFirst({ where: { userId } });
    expect(subRow!.cancelAtPeriodEnd).toBe(false);
  });

  it("missing subscription row — no error", async () => {
    const api = membershipApi(adminOnlyDb);
    mockGetStripe.mockReturnValue(buildStripeMock({}));

    await expect(api.handleWebhookEvent(makeSubscriptionUpdatedEvent("sub_nobody", true))).resolves.not.toThrow();
  });

  it("incomplete_expired — deletes the stale row instead of updating cancelAtPeriodEnd", async () => {
    // An "incomplete" subscription (never paid, e.g. an aborted PaymentSheet) transitions straight
    // to "incomplete_expired" after ~23h without Stripe ever firing customer.subscription.deleted —
    // this is the safety-net cleanup for that case, alongside the on-demand heal in
    // hasLiveSubscription.
    const { userId } = await createTestUser("e3@test.com", "password123");
    await insertSubscription(userId, "sub_e3");
    const api = membershipApi(adminOnlyDb);
    mockGetStripe.mockReturnValue(buildStripeMock({}));

    await api.handleWebhookEvent(makeSubscriptionUpdatedEvent("sub_e3", false, "incomplete_expired"));

    const db = getAdminDb();
    const subRow = await db.query.userSubscriptions.findFirst({ where: { userId } });
    expect(subRow).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// F. customer.subscription.deleted
// ---------------------------------------------------------------------------
describe("customer.subscription.deleted", () => {
  it("deletes the userSubscriptions row", async () => {
    const { userId } = await createTestUser("f1@test.com", "password123");
    await insertSubscription(userId, "sub_f1");
    const api = membershipApi(adminOnlyDb);
    mockGetStripe.mockReturnValue(buildStripeMock({}));

    await api.handleWebhookEvent(makeSubscriptionDeletedEvent("sub_f1"));

    const db = getAdminDb();
    const subRow = await db.query.userSubscriptions.findFirst({ where: { userId } });
    expect(subRow).toBeUndefined();
  });

  it("no row present — no error", async () => {
    const api = membershipApi(adminOnlyDb);
    mockGetStripe.mockReturnValue(buildStripeMock({}));

    await expect(api.handleWebhookEvent(makeSubscriptionDeletedEvent("sub_nobody"))).resolves.not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// G. Grace period access control
// ---------------------------------------------------------------------------
describe("grace period access control", () => {
  it('getFarmMembershipStatus — active payment = "active"', async () => {
    const { farmId, userId } = await createUserWithFarm({}, "g_k@test.com");
    await insertPayment(userId, daysFromNow(30));
    const api = membershipApi(adminOnlyDb);
    expect(await api.getFarmMembershipStatus(farmId)).toBe("active");
  });

  it('getFarmMembershipStatus — trial only = "trial"', async () => {
    const { farmId, userId } = await createUserWithFarm({}, "g_l@test.com");
    const db = getAdminDb();
    await db.insert(userTrials).values({ userId, endsAt: daysFromNow(15) });
    const api = membershipApi(adminOnlyDb);
    expect(await api.getFarmMembershipStatus(farmId)).toBe("trial");
  });

  it('getFarmMembershipStatus — nothing = "none"', async () => {
    const { farmId } = await createUserWithFarm({}, "g_m@test.com");
    const api = membershipApi(adminOnlyDb);
    expect(await api.getFarmMembershipStatus(farmId)).toBe("none");
  });
});

// ---------------------------------------------------------------------------
// H. startTrial
// ---------------------------------------------------------------------------
describe("startTrial", () => {
  it("creates trial ending 30 days out", async () => {
    const { userId } = await createUserWithFarm({}, "h1@test.com");
    const api = membershipApi(adminOnlyDb);

    const { trialEnd } = await api.startTrial(userId);

    const expected = new Date();
    expected.setDate(expected.getDate() + 30);
    const diffMs = Math.abs(trialEnd.getTime() - expected.getTime());
    expect(diffMs).toBeLessThan(5 * 60 * 1000);

    const db = getAdminDb();
    const trial = await db.query.userTrials.findFirst({ where: { userId } });
    expect(trial).toBeDefined();
  });

  it("second call for same farm throws 409", async () => {
    const { userId } = await createUserWithFarm({}, "h2@test.com");
    const api = membershipApi(adminOnlyDb);
    await api.startTrial(userId);

    await expect(api.startTrial(userId)).rejects.toThrow("Trial already used");
  });

  it("user without farm — second call throws 409", async () => {
    const { userId } = await createTestUser("h4@test.com", "password123");
    const api = membershipApi(adminOnlyDb);
    await api.startTrial(userId);

    await expect(api.startTrial(userId)).rejects.toThrow("Trial already used");
  });
});

// ---------------------------------------------------------------------------
// I. Checkout session creation
// ---------------------------------------------------------------------------
describe("createSubscriptionCheckout", () => {
  beforeEach(() => {
    process.env.STRIPE_MEMBERSHIP_PRICE_ID_YEARLY = "price_yearly_test";
  });

  it("returns checkout url and calls Stripe with price id directly", async () => {
    const { userId } = await createTestUser("i1@test.com", "password123");
    const stripeMock = buildStripeMock({ checkoutSessionUrl: "https://checkout.stripe.com/sub" });
    mockGetStripe.mockReturnValue(stripeMock);
    const api = membershipApi(adminOnlyDb);

    const { url } = await api.createSubscriptionCheckout(userId, "de", "https://success.com", "https://cancel.com");

    expect(url).toBe("https://checkout.stripe.com/sub");
    const createCall = jest.mocked(stripeMock.checkout.sessions.create);
    expect(createCall).toHaveBeenCalledTimes(1);
    const args = createCall.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(args.mode).toBe("subscription");
    expect(args.locale).toBe("de");
    const lineItem = (args.line_items as { price: string }[])[0];
    expect(lineItem.price).toBe("price_yearly_test");
  });

  it("applies trial_end when active trial exists", async () => {
    const { userId } = await createTestUser("i2@test.com", "password123");
    const db = getAdminDb();
    const trialEnd = daysFromNow(15);
    await db.insert(userTrials).values({ userId, endsAt: trialEnd });

    const stripeMock = buildStripeMock({});
    mockGetStripe.mockReturnValue(stripeMock);
    const api = membershipApi(adminOnlyDb);

    await api.createSubscriptionCheckout(userId, "en", "https://success.com", "https://cancel.com");

    const createCall = jest.mocked(stripeMock.checkout.sessions.create);
    const args = createCall.mock.calls[0]?.[0] as Record<string, unknown>;
    expect((args.subscription_data as { trial_end: number }).trial_end).toBeCloseTo(
      Math.floor(trialEnd.getTime() / 1000),
      -2
    );
  });

  it("throws when STRIPE_MEMBERSHIP_PRICE_ID_YEARLY is not set", async () => {
    delete process.env.STRIPE_MEMBERSHIP_PRICE_ID_YEARLY;
    const { userId } = await createTestUser("i3@test.com", "password123");
    const api = membershipApi(adminOnlyDb);
    mockGetStripe.mockReturnValue(buildStripeMock({}));

    await expect(api.createSubscriptionCheckout(userId, "de", "https://s.com", "https://c.com")).rejects.toThrow(
      "STRIPE_MEMBERSHIP_PRICE_ID_YEARLY"
    );
  });

  it("rejects when the user already has a live subscription", async () => {
    const { userId } = await createTestUser("i3b@test.com", "password123");
    await insertSubscription(userId, "sub_i3b");
    mockGetStripe.mockReturnValue(buildStripeMock({ subscription: makeStripeSubscription({ id: "sub_i3b" }) }));
    const api = membershipApi(adminOnlyDb);

    await expect(api.createSubscriptionCheckout(userId, "de", "https://s.com", "https://c.com")).rejects.toThrow(
      "active subscription"
    );
  });

  it("rejects even when auto-renew has already been disabled on the existing subscription", async () => {
    const { userId } = await createTestUser("i3c@test.com", "password123");
    await insertSubscription(userId, "sub_i3c");
    mockGetStripe.mockReturnValue(
      buildStripeMock({ subscription: makeStripeSubscription({ id: "sub_i3c", cancel_at_period_end: true }) })
    );
    const api = membershipApi(adminOnlyDb);

    await expect(api.createSubscriptionCheckout(userId, "de", "https://s.com", "https://c.com")).rejects.toThrow(
      "active subscription"
    );
  });

  it("stays blocked by a stale row until an explicit action self-heals it (no proactive Stripe check)", async () => {
    // createSubscriptionCheckout only checks whether a local row exists — it doesn't ask Stripe
    // whether it's still genuinely live. A stale row (Stripe already canceled it) still blocks
    // until something that actually mutates the subscription (disableAutoRenew here) verifies
    // against Stripe and cleans it up.
    const { userId } = await createTestUser("i3e@test.com", "password123");
    await insertSubscription(userId, "sub_i3e");
    const api = membershipApi(adminOnlyDb);

    mockGetStripe.mockReturnValue(
      buildStripeMock({ subscription: makeStripeSubscription({ id: "sub_i3e", status: "canceled" }) })
    );
    await expect(api.createSubscriptionCheckout(userId, "de", "https://s.com", "https://c.com")).rejects.toThrow(
      "active subscription"
    );

    const stripeMock = buildStripeMock({ subscription: makeStripeSubscription({ id: "sub_i3e", status: "canceled" }) });
    jest.mocked(stripeMock.subscriptions.update).mockRejectedValueOnce(new Error("canceled subscription"));
    mockGetStripe.mockReturnValue(stripeMock);
    await expect(api.disableAutoRenew(userId)).rejects.toThrow();

    mockGetStripe.mockReturnValue(buildStripeMock({ checkoutSessionUrl: "https://checkout.stripe.com/sub2" }));
    const { url } = await api.createSubscriptionCheckout(userId, "de", "https://s.com", "https://c.com");
    expect(url).toBe("https://checkout.stripe.com/sub2");
  });
});

describe("createSubscriptionIntent", () => {
  beforeEach(() => {
    process.env.STRIPE_MEMBERSHIP_PRICE_ID_YEARLY = "price_yearly_test";
  });

  it("rejects when the user already has a live subscription", async () => {
    const { userId } = await createTestUser("i3d@test.com", "password123");
    await insertSubscription(userId, "sub_i3d");
    mockGetStripe.mockReturnValue(buildStripeMock({ subscription: makeStripeSubscription({ id: "sub_i3d" }) }));
    const api = membershipApi(adminOnlyDb);

    await expect(api.createSubscriptionIntent(userId)).rejects.toThrow("active subscription");
  });

  it("self-heals a stale 'incomplete' row from an aborted PaymentSheet payment and lets the retry succeed", async () => {
    // Mirrors the real bug: createSubscriptionIntent inserts the row before payment is confirmed,
    // so an aborted payment sheet leaves Stripe's subscription stuck "incomplete" and the local row
    // would otherwise block every retry with a 409 forever.
    const { userId } = await createTestUser("i3f@test.com", "password123");
    await insertSubscription(userId, "sub_i3f_stale");
    const api = membershipApi(adminOnlyDb);

    const staleSubscription = makeStripeSubscription({ id: "sub_i3f_stale", status: "incomplete" });
    const newSubscription = makeStripeSubscription({
      id: "sub_i3f_new",
      latest_invoice: { confirmation_secret: { client_secret: "seti_new_secret" } },
    });
    const stripeMock = buildStripeMock({ subscription: staleSubscription });
    jest
      .mocked(stripeMock.subscriptions.create)
      .mockResolvedValueOnce(newSubscription as unknown as Stripe.Response<Stripe.Subscription>);
    mockGetStripe.mockReturnValue(stripeMock);

    const result = await api.createSubscriptionIntent(userId);

    expect(result.paymentIntentClientSecret).toBe("seti_new_secret");
    expect(jest.mocked(stripeMock.subscriptions.cancel)).toHaveBeenCalledWith("sub_i3f_stale");

    const db = getAdminDb();
    const subRow = await db.query.userSubscriptions.findFirst({ where: { userId } });
    expect(subRow!.stripeSubscriptionId).toBe("sub_i3f_new");
  });

  it("self-heals a stale 'incomplete_expired' row without trying to re-cancel it on Stripe", async () => {
    const { userId } = await createTestUser("i3g@test.com", "password123");
    await insertSubscription(userId, "sub_i3g_stale");
    const api = membershipApi(adminOnlyDb);

    const staleSubscription = makeStripeSubscription({ id: "sub_i3g_stale", status: "incomplete_expired" });
    const newSubscription = makeStripeSubscription({
      id: "sub_i3g_new",
      latest_invoice: { confirmation_secret: { client_secret: "seti_new_secret_2" } },
    });
    const stripeMock = buildStripeMock({ subscription: staleSubscription });
    jest
      .mocked(stripeMock.subscriptions.create)
      .mockResolvedValueOnce(newSubscription as unknown as Stripe.Response<Stripe.Subscription>);
    mockGetStripe.mockReturnValue(stripeMock);

    const result = await api.createSubscriptionIntent(userId);

    expect(result.paymentIntentClientSecret).toBe("seti_new_secret_2");
    expect(jest.mocked(stripeMock.subscriptions.cancel)).not.toHaveBeenCalled();
  });
});

describe("createManualCheckout", () => {
  beforeEach(() => {
    process.env.STRIPE_MEMBERSHIP_PRICE_ID_MANUAL = "price_manual_test";
  });

  it("returns checkout url and calls Stripe with price id directly", async () => {
    const { userId } = await createTestUser("i4@test.com", "password123");
    const stripeMock = buildStripeMock({ checkoutSessionUrl: "https://checkout.stripe.com/manual" });
    mockGetStripe.mockReturnValue(stripeMock);
    const api = membershipApi(adminOnlyDb);

    const { url } = await api.createManualCheckout(userId, "fr", "https://success.com", "https://cancel.com");

    expect(url).toBe("https://checkout.stripe.com/manual");
    const createCall = jest.mocked(stripeMock.checkout.sessions.create);
    expect(createCall).toHaveBeenCalledTimes(1);
    const args = createCall.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(args.mode).toBe("payment");
    expect(args.locale).toBe("fr");
    const lineItem = (args.line_items as { price: string }[])[0];
    expect(lineItem.price).toBe("price_manual_test");
  });

  it("throws when STRIPE_MEMBERSHIP_PRICE_ID_MANUAL is not set", async () => {
    delete process.env.STRIPE_MEMBERSHIP_PRICE_ID_MANUAL;
    const { userId } = await createTestUser("i5@test.com", "password123");
    const api = membershipApi(adminOnlyDb);
    mockGetStripe.mockReturnValue(buildStripeMock({}));

    await expect(api.createManualCheckout(userId, "de", "https://s.com", "https://c.com")).rejects.toThrow(
      "STRIPE_MEMBERSHIP_PRICE_ID_MANUAL"
    );
  });

  it("rejects when the user has a live subscription", async () => {
    const { userId } = await createTestUser("i6@test.com", "password123");
    await insertSubscription(userId, "sub_i6");
    const api = membershipApi(adminOnlyDb);
    mockGetStripe.mockReturnValue(buildStripeMock({ subscription: makeStripeSubscription({ id: "sub_i6" }) }));

    await expect(api.createManualCheckout(userId, "de", "https://s.com", "https://c.com")).rejects.toThrow(
      "active subscription"
    );
  });

  it("rejects even when auto-renew has already been disabled — must wait for it to actually end", async () => {
    const { userId } = await createTestUser("i6b@test.com", "password123");
    await insertSubscription(userId, "sub_i6b");
    const api = membershipApi(adminOnlyDb);
    mockGetStripe.mockReturnValue(
      buildStripeMock({ subscription: makeStripeSubscription({ id: "sub_i6b", cancel_at_period_end: true }) })
    );

    await expect(api.createManualCheckout(userId, "de", "https://s.com", "https://c.com")).rejects.toThrow(
      "active subscription"
    );
  });

  it("stays blocked by a stale row until an explicit action self-heals it", async () => {
    const { userId } = await createTestUser("i7@test.com", "password123");
    await insertSubscription(userId, "sub_i7");
    const api = membershipApi(adminOnlyDb);

    mockGetStripe.mockReturnValue(
      buildStripeMock({ subscription: makeStripeSubscription({ id: "sub_i7", status: "canceled" }) })
    );
    await expect(api.createManualCheckout(userId, "de", "https://s.com", "https://c.com")).rejects.toThrow(
      "active subscription"
    );

    const stripeMock = buildStripeMock({ subscription: makeStripeSubscription({ id: "sub_i7", status: "canceled" }) });
    jest.mocked(stripeMock.subscriptions.update).mockRejectedValueOnce(new Error("canceled subscription"));
    mockGetStripe.mockReturnValue(stripeMock);
    await expect(api.disableAutoRenew(userId)).rejects.toThrow();

    const db = getAdminDb();
    const sub = await db.query.userSubscriptions.findFirst({ where: { userId } });
    expect(sub).toBeUndefined();

    mockGetStripe.mockReturnValue(buildStripeMock({ checkoutSessionUrl: "https://checkout.stripe.com/manual" }));
    const { url } = await api.createManualCheckout(userId, "de", "https://s.com", "https://c.com");
    expect(url).toBe("https://checkout.stripe.com/manual");
  });
});

describe("createManualIntent", () => {
  beforeEach(() => {
    process.env.STRIPE_MEMBERSHIP_PRICE_ID_MANUAL = "price_manual_test";
  });

  it("rejects when the user has a live subscription", async () => {
    const { userId } = await createTestUser("i8@test.com", "password123");
    await insertSubscription(userId, "sub_i8");
    const api = membershipApi(adminOnlyDb);
    mockGetStripe.mockReturnValue(buildStripeMock({ subscription: makeStripeSubscription({ id: "sub_i8" }) }));

    await expect(api.createManualIntent(userId)).rejects.toThrow("active subscription");
  });
});

// ---------------------------------------------------------------------------
// I. getStatus / getPayments
// ---------------------------------------------------------------------------
describe("getStatus / getPayments", () => {
  it("no membership — all nulls/false", async () => {
    const { userId } = await createTestUser("i1@test.com", "password123");
    const api = membershipApi(adminOnlyDb);

    const status = await api.getStatus(userId);
    expect(status.lastPeriodEnd).toBeNull();
    expect(status.cancelAtPeriodEnd).toBe(false);
    expect(status.autoRenewing).toBe(false);
    expect(status.trialEnd).toBeNull();
  });

  it("subscription + payment reflects correct fields", async () => {
    const { userId } = await createTestUser("i2@test.com", "password123");
    const periodEnd = daysFromNow(365);
    await insertPayment(userId, periodEnd, { stripePaymentId: "pi_i2", stripeSubscriptionId: "sub_i2" });
    await insertSubscription(userId, "sub_i2");
    const api = membershipApi(adminOnlyDb);

    const status = await api.getStatus(userId);
    expect(status.lastPeriodEnd?.getTime()).toBeCloseTo(periodEnd.getTime(), -3);
    expect(status.autoRenewing).toBe(true);
    expect(status.cancelAtPeriodEnd).toBe(false);
  });

  it("reports a stale row as autoRenewing (no proactive Stripe check — self-heals only on a mutating action)", async () => {
    // getStatus is a pure DB read now — it trusts userSubscriptions without asking Stripe, the
    // same way it already trusts membershipPayments. A row left behind by a missed
    // customer.subscription.deleted webhook shows as auto-renewing until something that mutates
    // it (cancel/disable/reactivate) verifies against Stripe and cleans it up.
    const { userId } = await createTestUser("i2b@test.com", "password123");
    await insertPayment(userId, daysFromNow(365), { stripePaymentId: "pi_i2b" }); // no stripeSubscriptionId
    await insertSubscription(userId, "sub_i2b_stale");
    const api = membershipApi(adminOnlyDb);

    const status = await api.getStatus(userId);
    expect(status.autoRenewing).toBe(true);
  });

  it("reports cancelAtPeriodEnd from the local row, no Stripe call", async () => {
    const { userId } = await createTestUser("i2c@test.com", "password123");
    await insertPayment(userId, daysFromNow(10), { stripePaymentId: "pi_i2c_sub", stripeSubscriptionId: "sub_i2c" });
    await insertSubscription(userId, "sub_i2c");
    const db = getAdminDb();
    await db.update(userSubscriptions).set({ cancelAtPeriodEnd: true }).where(eq(userSubscriptions.userId, userId));
    const api = membershipApi(adminOnlyDb);

    const status = await api.getStatus(userId);
    expect(status.autoRenewing).toBe(true);
    expect(status.cancelAtPeriodEnd).toBe(true);
  });

  it("getPayments returns payments ordered by createdAt desc", async () => {
    const { userId } = await createTestUser("i3@test.com", "password123");
    await insertPayment(userId, daysAgo(10), { stripePaymentId: "pi_i3_old", amount: 29000 });
    // Small sleep to ensure different createdAt timestamps
    await new Promise((resolve) => setTimeout(resolve, 10));
    await insertPayment(userId, daysFromNow(355), { stripePaymentId: "pi_i3_new", amount: 29000 });
    const api = membershipApi(adminOnlyDb);

    const payments = await api.getPayments(userId);
    expect(payments).toHaveLength(2);
    // Most recent first
    expect(payments[0].stripePaymentId).toBe("pi_i3_new");
    expect(payments[1].stripePaymentId).toBe("pi_i3_old");
  });
});

// ---------------------------------------------------------------------------
// J. Cron: expiry_reminder (day 0 — expired but within 10 days)
// ---------------------------------------------------------------------------
describe("cron: expiry_reminder", () => {
  it("manual payment 1 day ago → expiry_reminder notification + email", async () => {
    const { userId } = await createTestUser("j1@test.com", "password123");
    await insertPayment(userId, daysAgo(1));

    await runExpiryNotifications();

    const db = getAdminDb();
    const notification = await db.query.membershipExpiryNotifications.findFirst({ where: { userId } });
    expect(notification?.type).toBe("expiry_reminder");
    expect(emailSpy).toHaveBeenCalledTimes(1);
    expect(emailSpy.mock.calls[0]?.[0]?.to?.[0]?.email).toBe("j1@test.com");
  });

  it("manual payment 9 days ago → expiry_reminder email (within window)", async () => {
    const { userId } = await createTestUser("j2@test.com", "password123");
    await insertPayment(userId, daysAgo(9));

    await runExpiryNotifications();

    expect(emailSpy).toHaveBeenCalledTimes(1);
  });

  it("manual payment 11 days ago → no expiry_reminder (outside window, belongs to access_lost pass)", async () => {
    const { userId } = await createTestUser("j3@test.com", "password123");
    await insertPayment(userId, daysAgo(11));

    await runExpiryNotifications();

    const db = getAdminDb();
    const notification = await db.query.membershipExpiryNotifications.findFirst({
      where: { userId, type: "expiry_reminder" },
    });
    expect(notification).toBeUndefined();
  });

  it("subscription present + expired → no expiry_reminder (auto-renewing excluded)", async () => {
    const { userId } = await createTestUser("j4@test.com", "password123");
    await insertPayment(userId, daysAgo(1));
    await insertSubscription(userId, "sub_j4");

    await runExpiryNotifications();

    // Expiry reminder pass skips users with active subscription
    const db = getAdminDb();
    const notification = await db.query.membershipExpiryNotifications.findFirst({
      where: { userId, type: "expiry_reminder" },
    });
    expect(notification).toBeUndefined();
  });

  it("prior payment_failed notification → no expiry_reminder email", async () => {
    const { userId } = await createTestUser("j5@test.com", "password123");
    const periodEnd = daysAgo(1);
    await insertPayment(userId, periodEnd);
    await insertNotification(userId, periodEnd, "payment_failed");

    await runExpiryNotifications();

    expect(emailSpy).not.toHaveBeenCalled();
  });

  it("prior expiry_reminder → idempotent, no duplicate email", async () => {
    const { userId } = await createTestUser("j6@test.com", "password123");
    const periodEnd = daysAgo(1);
    await insertPayment(userId, periodEnd);

    await runExpiryNotifications();
    expect(emailSpy).toHaveBeenCalledTimes(1);

    // Second run — notification already exists
    await runExpiryNotifications();
    expect(emailSpy).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// K. Cron: access_lost (day +10)
// ---------------------------------------------------------------------------
describe("cron: access_lost", () => {
  it("periodEnd 11 days ago → access_lost notification + email", async () => {
    const { userId } = await createTestUser("k1@test.com", "password123");
    await insertPayment(userId, daysAgo(11));

    await runExpiryNotifications();

    const db = getAdminDb();
    const notification = await db.query.membershipExpiryNotifications.findFirst({ where: { userId } });
    expect(notification?.type).toBe("access_lost");
    expect(emailSpy).toHaveBeenCalledTimes(1);
  });

  it("periodEnd 29 days ago → access_lost email (within window)", async () => {
    const { userId } = await createTestUser("k2@test.com", "password123");
    await insertPayment(userId, daysAgo(29));

    await runExpiryNotifications();

    expect(emailSpy).toHaveBeenCalledTimes(1);
  });

  it("periodEnd 31 days ago → no access_lost (outside window, belongs to membership_ended)", async () => {
    const { userId } = await createTestUser("k3@test.com", "password123");
    await insertPayment(userId, daysAgo(31));

    await runExpiryNotifications();

    const db = getAdminDb();
    const notification = await db.query.membershipExpiryNotifications.findFirst({
      where: { userId, type: "access_lost" },
    });
    expect(notification).toBeUndefined();
  });

  it("prior access_lost notification → idempotent, no duplicate email", async () => {
    const { userId } = await createTestUser("k4@test.com", "password123");
    const periodEnd = daysAgo(11);
    await insertPayment(userId, periodEnd);

    await runExpiryNotifications();
    expect(emailSpy).toHaveBeenCalledTimes(1);

    await runExpiryNotifications();
    expect(emailSpy).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// L. Cron: membership_ended (day +30)
// ---------------------------------------------------------------------------
describe("cron: membership_ended", () => {
  it("periodEnd 31 days ago → membership_ended notification + email", async () => {
    const { userId } = await createTestUser("l1@test.com", "password123");
    await insertPayment(userId, daysAgo(31));

    await runExpiryNotifications();

    const db = getAdminDb();
    const notification = await db.query.membershipExpiryNotifications.findFirst({ where: { userId } });
    expect(notification?.type).toBe("membership_ended");
    expect(emailSpy).toHaveBeenCalledTimes(1);
  });

  it("prior membership_ended → idempotent, no duplicate email", async () => {
    const { userId } = await createTestUser("l2@test.com", "password123");
    await insertPayment(userId, daysAgo(31));

    await runExpiryNotifications();
    expect(emailSpy).toHaveBeenCalledTimes(1);

    await runExpiryNotifications();
    expect(emailSpy).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// M. Full timeline — three users at three stages, one cron run
// ---------------------------------------------------------------------------
describe("full timeline — three cron stages in one pass", () => {
  it("each stage user receives exactly one email in a single runExpiryNotifications call", async () => {
    const { userId: u1 } = await createTestUser("m1@test.com", "password123");
    const { userId: u2 } = await createTestUser("m2@test.com", "password123");
    const { userId: u3 } = await createTestUser("m3@test.com", "password123");

    // u1: expiry_reminder range (1 day ago)
    await insertPayment(u1, daysAgo(1));
    // u2: access_lost range (15 days ago)
    await insertPayment(u2, daysAgo(15));
    // u3: membership_ended range (35 days ago)
    await insertPayment(u3, daysAgo(35));

    await runExpiryNotifications();

    expect(emailSpy).toHaveBeenCalledTimes(3);

    const recipients = emailSpy.mock.calls.map((call) => call[0].to?.[0]?.email ?? "");
    expect(recipients).toContain("m1@test.com");
    expect(recipients).toContain("m2@test.com");
    expect(recipients).toContain("m3@test.com");
  });
});

// ---------------------------------------------------------------------------
// N0. Grace period suppressed for cancelledByUser
// ---------------------------------------------------------------------------
describe("grace period: cancelled users keep access until periodEnd, but no grace beyond it", () => {
  it('getFarmMembershipStatus — cancelled payment still in period = "active" (access lasts until periodEnd)', async () => {
    const { farmId, userId } = await createUserWithFarm({}, "n0h@test.com");
    await insertPayment(userId, daysFromNow(1));
    const db = getAdminDb();
    await db.update(membershipPayments).set({ cancelledByUser: true }).where(eq(membershipPayments.userId, userId));
    const api = membershipApi(adminOnlyDb);
    expect(await api.getFarmMembershipStatus(farmId)).toBe("active");
  });

  it("isActiveUser — cancelled payment still in period (periodEnd tomorrow) = true", async () => {
    const { userId } = await createTestUser("n0i@test.com", "password123");
    await insertPayment(userId, daysFromNow(1));
    const db = getAdminDb();
    await db.update(membershipPayments).set({ cancelledByUser: true }).where(eq(membershipPayments.userId, userId));
    const api = membershipApi(adminOnlyDb);
    expect(await api.isActiveUser(userId)).toBe(true);
  });

  it("isActiveUser — cancelled payment 5 days past periodEnd = false (no grace for cancelled)", async () => {
    const { userId } = await createTestUser("n0e@test.com", "password123");
    await insertPayment(userId, daysAgo(5));
    const db = getAdminDb();
    await db.update(membershipPayments).set({ cancelledByUser: true }).where(eq(membershipPayments.userId, userId));
    const api = membershipApi(adminOnlyDb);
    expect(await api.isActiveUser(userId)).toBe(false);
  });

  it("isPaidUser — cancelled payment 5 days past periodEnd = false (no grace for cancelled)", async () => {
    const { userId } = await createTestUser("n0f@test.com", "password123");
    await insertPayment(userId, daysAgo(5));
    const db = getAdminDb();
    await db.update(membershipPayments).set({ cancelledByUser: true }).where(eq(membershipPayments.userId, userId));
    const api = membershipApi(adminOnlyDb);
    expect(await api.isPaidUser(userId)).toBe(false);
  });

  it("isActiveUser — non-cancelled payment 5 days past periodEnd (in grace) = true", async () => {
    const { userId } = await createTestUser("n0j@test.com", "password123");
    await insertPayment(userId, daysAgo(5));
    const api = membershipApi(adminOnlyDb);
    expect(await api.isActiveUser(userId)).toBe(true);
  });

  it("isActiveUser — cancelled but active trial = true (trial unaffected)", async () => {
    const { userId } = await createTestUser("n0g@test.com", "password123");
    await insertPayment(userId, daysAgo(5));
    const db = getAdminDb();
    await db.update(membershipPayments).set({ cancelledByUser: true }).where(eq(membershipPayments.userId, userId));
    await db.insert(userTrials).values({ userId, endsAt: daysFromNow(15) });
    const api = membershipApi(adminOnlyDb);
    expect(await api.isActiveUser(userId)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// N. cancelSubscription — cancelledByUser flag
// ---------------------------------------------------------------------------
describe("cancelSubscription", () => {
  it("subscription user — sets cancelledByUser on latest payment", async () => {
    const { userId } = await createTestUser("n1@test.com", "password123");
    await insertPayment(userId, daysFromNow(30), { stripeSubscriptionId: "sub_n1" });
    await insertSubscription(userId, "sub_n1");
    const api = membershipApi(adminOnlyDb);
    mockGetStripe.mockReturnValue(buildStripeMock({}));

    await api.cancelSubscription(userId);

    const db = getAdminDb();
    const payment = await db.query.membershipPayments.findFirst({ where: { userId, status: "succeeded" } });
    expect(payment!.cancelledByUser).toBe(true);
  });

  it("one-time payment user — sets cancelledByUser on latest payment", async () => {
    const { userId } = await createTestUser("n2@test.com", "password123");
    await insertPayment(userId, daysFromNow(30));
    const api = membershipApi(adminOnlyDb);
    mockGetStripe.mockReturnValue(buildStripeMock({}));

    await api.cancelSubscription(userId);

    const db = getAdminDb();
    const payment = await db.query.membershipPayments.findFirst({ where: { userId, status: "succeeded" } });
    expect(payment!.cancelledByUser).toBe(true);
  });

  it("subscription user — sets cancelledByUser on latest of multiple payments", async () => {
    const { userId } = await createTestUser("n3@test.com", "password123");
    await insertPayment(userId, daysAgo(370), { stripeSubscriptionId: "sub_n3" });
    await insertPayment(userId, daysFromNow(30), { stripeSubscriptionId: "sub_n3" });
    await insertSubscription(userId, "sub_n3");
    const api = membershipApi(adminOnlyDb);
    mockGetStripe.mockReturnValue(buildStripeMock({}));

    await api.cancelSubscription(userId);

    const db = getAdminDb();
    const payments = await db.query.membershipPayments.findMany({ where: { userId, status: "succeeded" } });
    const latest = payments.sort((a, b) => b.periodEnd.getTime() - a.periodEnd.getTime())[0]!;
    expect(latest.cancelledByUser).toBe(true);
    // older payment should be untouched
    const older = payments.sort((a, b) => a.periodEnd.getTime() - b.periodEnd.getTime())[0]!;
    expect(older.cancelledByUser).toBe(false);
  });

  it("sends cancellation email to subscription user", async () => {
    const { userId } = await createTestUser("n_email1@test.com", "password123");
    await insertPayment(userId, daysFromNow(30), { stripeSubscriptionId: "sub_nemail1" });
    await insertSubscription(userId, "sub_nemail1");
    const api = membershipApi(adminOnlyDb);
    mockGetStripe.mockReturnValue(buildStripeMock({}));

    await api.cancelSubscription(userId);

    expect(emailSpy).toHaveBeenCalledTimes(1);
    expect(emailSpy.mock.calls[0]?.[0]?.to?.[0]?.email).toBe("n_email1@test.com");
  });

  it("sends cancellation email to one-time payment user", async () => {
    const { userId } = await createTestUser("n_email2@test.com", "password123");
    await insertPayment(userId, daysFromNow(30));
    const api = membershipApi(adminOnlyDb);
    mockGetStripe.mockReturnValue(buildStripeMock({}));

    await api.cancelSubscription(userId);

    expect(emailSpy).toHaveBeenCalledTimes(1);
    expect(emailSpy.mock.calls[0]?.[0]?.to?.[0]?.email).toBe("n_email2@test.com");
  });

  it("no succeeded payment — no error", async () => {
    const { userId } = await createTestUser("n4@test.com", "password123");
    const api = membershipApi(adminOnlyDb);
    mockGetStripe.mockReturnValue(buildStripeMock({}));

    await expect(api.cancelSubscription(userId)).resolves.toEqual({ cancelAtPeriodEnd: true });
  });

  it("stale local row for an already-Stripe-canceled subscription — self-heals instead of erroring", async () => {
    const { userId } = await createTestUser("n5@test.com", "password123");
    await insertPayment(userId, daysFromNow(30), { stripeSubscriptionId: "sub_n5" });
    await insertSubscription(userId, "sub_n5");
    const stripeMock = buildStripeMock({
      subscription: makeStripeSubscription({ id: "sub_n5", status: "canceled" }),
    });
    jest.mocked(stripeMock.subscriptions.update).mockRejectedValueOnce(new Error("canceled subscription"));
    mockGetStripe.mockReturnValue(stripeMock);
    const api = membershipApi(adminOnlyDb);

    await expect(api.cancelSubscription(userId)).resolves.toEqual({ cancelAtPeriodEnd: true });

    // The update was attempted (no proactive check) and, once it failed, Stripe was asked to
    // confirm the subscription is genuinely canceled before the local row was cleaned up.
    expect(jest.mocked(stripeMock.subscriptions.update)).toHaveBeenCalledTimes(1);
    expect(jest.mocked(stripeMock.subscriptions.retrieve)).toHaveBeenCalledWith("sub_n5");

    const db = getAdminDb();
    const subscriptionRow = await db.query.userSubscriptions.findFirst({ where: { userId } });
    expect(subscriptionRow).toBeUndefined();
    const payment = await db.query.membershipPayments.findFirst({ where: { userId, status: "succeeded" } });
    expect(payment!.cancelledByUser).toBe(true);
  });

  it("rethrows a genuine Stripe error without touching the local row (verified via retrieve, not assumed)", async () => {
    const { userId } = await createTestUser("n5b@test.com", "password123");
    await insertPayment(userId, daysFromNow(30), { stripeSubscriptionId: "sub_n5b" });
    await insertSubscription(userId, "sub_n5b");
    const stripeMock = buildStripeMock({
      subscription: makeStripeSubscription({ id: "sub_n5b" }), // still live per Stripe
    });
    jest.mocked(stripeMock.subscriptions.update).mockRejectedValueOnce(new Error("some other Stripe error"));
    mockGetStripe.mockReturnValue(stripeMock);
    const api = membershipApi(adminOnlyDb);

    await expect(api.cancelSubscription(userId)).rejects.toThrow("some other Stripe error");

    const db = getAdminDb();
    const subscriptionRow = await db.query.userSubscriptions.findFirst({ where: { userId } });
    expect(subscriptionRow).toBeDefined();
    expect(subscriptionRow!.cancelAtPeriodEnd).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// O. reactivateSubscription — clears cancelledByUser flag
// ---------------------------------------------------------------------------
describe("reactivateSubscription", () => {
  it("sends reactivation email to subscription user", async () => {
    const { userId } = await createTestUser("o_email1@test.com", "password123");
    await insertSubscription(userId, "sub_oemail1");
    await insertPayment(userId, daysFromNow(30), { stripeSubscriptionId: "sub_oemail1" });
    const api = membershipApi(adminOnlyDb);
    mockGetStripe.mockReturnValue(buildStripeMock({}));

    await api.reactivateSubscription(userId);

    expect(emailSpy).toHaveBeenCalledTimes(1);
    expect(emailSpy.mock.calls[0]?.[0]?.to?.[0]?.email).toBe("o_email1@test.com");
  });

  it("sends reactivation email to one-time payment user", async () => {
    const { userId } = await createTestUser("o_email2@test.com", "password123");
    await insertPayment(userId, daysFromNow(30));
    const api = membershipApi(adminOnlyDb);
    mockGetStripe.mockReturnValue(buildStripeMock({}));

    await api.reactivateSubscription(userId);

    expect(emailSpy).toHaveBeenCalledTimes(1);
    expect(emailSpy.mock.calls[0]?.[0]?.to?.[0]?.email).toBe("o_email2@test.com");
  });

  it("one-time payment user — clears cancelledByUser without Stripe call", async () => {
    const { userId } = await createTestUser("o0@test.com", "password123");
    await insertPayment(userId, daysFromNow(30)); // no subscription
    const db = getAdminDb();
    await db.update(membershipPayments).set({ cancelledByUser: true }).where(eq(membershipPayments.userId, userId));
    const stripeMock = buildStripeMock({});
    mockGetStripe.mockReturnValue(stripeMock);
    const api = membershipApi(adminOnlyDb);

    const result = await api.reactivateSubscription(userId);

    expect(result).toEqual({ cancelAtPeriodEnd: false });
    const payment = await db.query.membershipPayments.findFirst({ where: { userId, status: "succeeded" } });
    expect(payment!.cancelledByUser).toBe(false);
    // Stripe subscriptions.update should NOT have been called
    expect(jest.mocked(stripeMock.subscriptions.update)).not.toHaveBeenCalled();
  });

  it("clears cancelledByUser on latest payment", async () => {
    const { userId } = await createTestUser("o1@test.com", "password123");
    const db = getAdminDb();
    await insertSubscription(userId, "sub_o1");
    await insertPayment(userId, daysFromNow(30), { stripeSubscriptionId: "sub_o1" });
    // simulate a prior cancel
    await db.update(membershipPayments).set({ cancelledByUser: true }).where(eq(membershipPayments.userId, userId));
    const api = membershipApi(adminOnlyDb);
    mockGetStripe.mockReturnValue(buildStripeMock({}));

    await api.reactivateSubscription(userId);

    const payment = await db.query.membershipPayments.findFirst({ where: { userId, status: "succeeded" } });
    expect(payment!.cancelledByUser).toBe(false);
  });

  it("falls back to the one-time-payment path for a stale (already Stripe-canceled) subscription row", async () => {
    const { userId } = await createTestUser("o4@test.com", "password123");
    await insertPayment(userId, daysFromNow(30), { stripeSubscriptionId: "sub_o4" });
    await insertSubscription(userId, "sub_o4");
    const db = getAdminDb();
    await db.update(membershipPayments).set({ cancelledByUser: true }).where(eq(membershipPayments.userId, userId));
    const stripeMock = buildStripeMock({ subscription: makeStripeSubscription({ id: "sub_o4", status: "canceled" }) });
    jest.mocked(stripeMock.subscriptions.update).mockRejectedValueOnce(new Error("canceled subscription"));
    mockGetStripe.mockReturnValue(stripeMock);
    const api = membershipApi(adminOnlyDb);

    const result = await api.reactivateSubscription(userId);

    expect(result).toEqual({ cancelAtPeriodEnd: false });
    const subscriptionRow = await db.query.userSubscriptions.findFirst({ where: { userId } });
    expect(subscriptionRow).toBeUndefined();
    const payment = await db.query.membershipPayments.findFirst({ where: { userId, status: "succeeded" } });
    expect(payment!.cancelledByUser).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// O2. disableAutoRenew — lightweight, no Austritt
// ---------------------------------------------------------------------------
describe("disableAutoRenew", () => {
  it("sets cancelAtPeriodEnd on the subscription without touching cancelledByUser", async () => {
    const { userId } = await createTestUser("o2a@test.com", "password123");
    await insertSubscription(userId, "sub_o2a");
    await insertPayment(userId, daysFromNow(30), { stripeSubscriptionId: "sub_o2a" });
    const stripeMock = buildStripeMock({});
    mockGetStripe.mockReturnValue(stripeMock);
    const api = membershipApi(adminOnlyDb);

    const result = await api.disableAutoRenew(userId);

    expect(result).toEqual({ cancelAtPeriodEnd: true });
    expect(jest.mocked(stripeMock.subscriptions.update)).toHaveBeenCalledWith(
      "sub_o2a",
      expect.objectContaining({ cancel_at_period_end: true })
    );
    const db = getAdminDb();
    const sub = await db.query.userSubscriptions.findFirst({ where: { userId } });
    expect(sub!.cancelAtPeriodEnd).toBe(true);
    const payment = await db.query.membershipPayments.findFirst({ where: { userId, status: "succeeded" } });
    expect(payment!.cancelledByUser).toBe(false);
  });

  it("does not send an email", async () => {
    const { userId } = await createTestUser("o2b@test.com", "password123");
    await insertSubscription(userId, "sub_o2b");
    await insertPayment(userId, daysFromNow(30), { stripeSubscriptionId: "sub_o2b" });
    mockGetStripe.mockReturnValue(buildStripeMock({}));
    const api = membershipApi(adminOnlyDb);

    await api.disableAutoRenew(userId);

    expect(emailSpy).not.toHaveBeenCalled();
  });

  it("member stays active (isActiveUser) while the disabled period is still running", async () => {
    const { userId } = await createTestUser("o2c@test.com", "password123");
    await insertSubscription(userId, "sub_o2c");
    await insertPayment(userId, daysFromNow(30), { stripeSubscriptionId: "sub_o2c" });
    mockGetStripe.mockReturnValue(buildStripeMock({}));
    const api = membershipApi(adminOnlyDb);

    await api.disableAutoRenew(userId);

    expect(await api.isActiveUser(userId)).toBe(true);
  });

  it("throws for a user with no subscription (one-time payer)", async () => {
    const { userId } = await createTestUser("o2d@test.com", "password123");
    await insertPayment(userId, daysFromNow(30));
    const api = membershipApi(adminOnlyDb);

    await expect(api.disableAutoRenew(userId)).rejects.toThrow();
  });

  it("throws for a stale (already Stripe-canceled) subscription row, after verifying and cleaning it up", async () => {
    // A missed customer.subscription.deleted webhook left a userSubscriptions row behind after
    // Stripe already fully canceled it — the update attempt fails, Stripe confirms it's actually
    // canceled, and the stale row is cleaned up rather than surfacing a raw Stripe error.
    const { userId } = await createTestUser("o2e@test.com", "password123");
    await insertPayment(userId, daysFromNow(30)); // no stripeSubscriptionId — one-time payment
    await insertSubscription(userId, "sub_o2e_stale");
    const stripeMock = buildStripeMock({
      subscription: makeStripeSubscription({ id: "sub_o2e_stale", status: "canceled" }),
    });
    jest.mocked(stripeMock.subscriptions.update).mockRejectedValueOnce(new Error("canceled subscription"));
    mockGetStripe.mockReturnValue(stripeMock);
    const api = membershipApi(adminOnlyDb);

    await expect(api.disableAutoRenew(userId)).rejects.toThrow("No auto-renewing subscription to disable");

    const db = getAdminDb();
    const subscriptionRow = await db.query.userSubscriptions.findFirst({ where: { userId } });
    expect(subscriptionRow).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// P. getStatus — exposes cancelledByUser
// ---------------------------------------------------------------------------
describe("getStatus — cancelledByUser", () => {
  it("defaults to false when no payment exists", async () => {
    const { userId } = await createTestUser("p1@test.com", "password123");
    const api = membershipApi(adminOnlyDb);
    const status = await api.getStatus(userId);
    expect(status.cancelledByUser).toBe(false);
  });

  it("returns false when payment exists and user has not cancelled", async () => {
    const { userId } = await createTestUser("p2@test.com", "password123");
    await insertPayment(userId, daysFromNow(30));
    const api = membershipApi(adminOnlyDb);
    const status = await api.getStatus(userId);
    expect(status.cancelledByUser).toBe(false);
  });

  it("returns true after cancelSubscription", async () => {
    const { userId } = await createTestUser("p3@test.com", "password123");
    await insertPayment(userId, daysFromNow(30));
    const api = membershipApi(adminOnlyDb);
    mockGetStripe.mockReturnValue(buildStripeMock({}));

    await api.cancelSubscription(userId);

    const status = await api.getStatus(userId);
    expect(status.cancelledByUser).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Q. Cron: cancelledByUser skips all three passes
// ---------------------------------------------------------------------------
describe("cron: cancelledByUser suppresses expiry emails", () => {
  it("expiry_reminder pass — skips user with cancelledByUser=true", async () => {
    const { userId } = await createTestUser("q1@test.com", "password123");
    await insertPayment(userId, daysAgo(1));
    const db = getAdminDb();
    await db.update(membershipPayments).set({ cancelledByUser: true }).where(eq(membershipPayments.userId, userId));

    await runExpiryNotifications();

    expect(emailSpy).not.toHaveBeenCalled();
    const notification = await db.query.membershipExpiryNotifications.findFirst({ where: { userId } });
    expect(notification).toBeUndefined();
  });

  it("access_lost pass — skips user with cancelledByUser=true", async () => {
    const { userId } = await createTestUser("q2@test.com", "password123");
    await insertPayment(userId, daysAgo(15));
    const db = getAdminDb();
    await db.update(membershipPayments).set({ cancelledByUser: true }).where(eq(membershipPayments.userId, userId));

    await runExpiryNotifications();

    expect(emailSpy).not.toHaveBeenCalled();
  });

  it("membership_ended pass — skips user with cancelledByUser=true", async () => {
    const { userId } = await createTestUser("q3@test.com", "password123");
    await insertPayment(userId, daysAgo(35));
    const db = getAdminDb();
    await db.update(membershipPayments).set({ cancelledByUser: true }).where(eq(membershipPayments.userId, userId));

    await runExpiryNotifications();

    expect(emailSpy).not.toHaveBeenCalled();
  });

  it("user without cancelledByUser still receives email (regression)", async () => {
    const { userId: uCancelled } = await createTestUser("q4a@test.com", "password123");
    const { userId: uActive } = await createTestUser("q4b@test.com", "password123");
    await insertPayment(uCancelled, daysAgo(1));
    await insertPayment(uActive, daysAgo(1));
    const db = getAdminDb();
    await db.update(membershipPayments).set({ cancelledByUser: true }).where(eq(membershipPayments.userId, uCancelled));

    await runExpiryNotifications();

    expect(emailSpy).toHaveBeenCalledTimes(1);
    expect(emailSpy.mock.calls[0]?.[0]?.to?.[0]?.email).toBe("q4b@test.com");
  });

  it("cancelled then reactivated (cancelledByUser=false) → email sent again", async () => {
    const { userId } = await createTestUser("q5@test.com", "password123");
    await insertPayment(userId, daysAgo(1));
    const db = getAdminDb();
    // simulate cancel then reactivate
    await db.update(membershipPayments).set({ cancelledByUser: false }).where(eq(membershipPayments.userId, userId));

    await runExpiryNotifications();

    expect(emailSpy).toHaveBeenCalledTimes(1);
  });
});
