// TESTPHASE: set UNLIMITED_TRIAL=true in .env to bypass all membership checks.
// Revert: remove the env var (or set it to anything other than "true").
const UNLIMITED_TRIAL = process.env.UNLIMITED_TRIAL === "true";

import Stripe from "stripe";
import { eq, and, or, gt } from "drizzle-orm";
import createHttpError from "http-errors";
import { captureException } from "@sentry/node";
import { RlsDb } from "../db/db";
import { getStripe, STRIPE_API_VERSION } from "../stripe/stripe";
import {
  profiles,
  userSubscriptions,
  userTrials,
  membershipPayments,
  membershipExpiryNotifications,
} from "../db/schema";
import {
  sendNewMembershipEmail,
  sendReactivationEmail,
  sendRenewalEmail,
  sendFirstPaymentEmail,
  sendPaymentFailedEmail,
  sendCancellationEmail,
} from "./membership.email";

export type MembershipStatus = {
  lastPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  autoRenewing: boolean;
  trialEnd: Date | null;
  cancelledByUser: boolean;
};

export type FarmMembershipStatus = "none" | "trial" | "active";

// Annual membership amount in CHF cents (used for manual/one-time checkout)

// Grace period: 10 days after periodEnd, users retain access
const GRACE_PERIOD_MS = 10 * 24 * 60 * 60 * 1000;

type CardDetails = {
  cardLast4: string | null;
  cardBrand: string | null;
  cardExpMonth: number | null;
  cardExpYear: number | null;
  paymentMethodType: string | null;
};

const emptyCardDetails: CardDetails = {
  cardLast4: null,
  cardBrand: null,
  cardExpMonth: null,
  cardExpYear: null,
  paymentMethodType: null,
};

async function getCardDetailsFromPaymentMethod(paymentMethodId: string | null): Promise<CardDetails> {
  if (!paymentMethodId) return emptyCardDetails;
  const pm = await getStripe().paymentMethods.retrieve(paymentMethodId);
  if (!pm.card) return { ...emptyCardDetails, paymentMethodType: pm.type };
  return {
    cardLast4: pm.card.last4,
    cardBrand: pm.card.brand,
    cardExpMonth: pm.card.exp_month,
    cardExpYear: pm.card.exp_year,
    paymentMethodType: pm.type,
  };
}

export function membershipApi(db: RlsDb) {
  async function profileExists(userId: string): Promise<boolean> {
    return !!(await db.admin.query.profiles.findFirst({ where: { id: userId }, columns: { id: true } }));
  }

  // A payment can land after its account was deleted. The money still has to be on record, but
  // there is nobody left to link it to or mail, so it gets refunded by hand.
  async function recordPaymentForDeletedAccount(payment: {
    stripePaymentId: string;
    stripeSubscriptionId?: string;
    amount: number;
    currency: string;
    periodEnd: Date;
  }): Promise<void> {
    await db.admin
      .insert(membershipPayments)
      .values({ ...payment, userId: null, status: "succeeded" })
      .onConflictDoNothing();
    captureException(new Error("Membership payment for a deleted account, refund manually"), { extra: payment });
  }

  // Get or create a Stripe Customer for the user, storing the ID on their profile
  async function getOrCreateStripeCustomer(userId: string): Promise<string> {
    const profile = await db.admin.query.profiles.findFirst({ where: { id: userId } });
    if (!profile) throw new Error(`Profile ${userId} not found`);

    if (profile.stripeCustomerId) return profile.stripeCustomerId;

    const customer = await getStripe().customers.create({
      metadata: { userId },
      name: profile.fullName ?? profile.email,
      email: profile.email,
    });

    await db.admin.update(profiles).set({ stripeCustomerId: customer.id }).where(eq(profiles.id, userId));

    return customer.id;
  }

  // Fetch all userIds who are members of the given farm
  async function getUserIdsForFarm(farmId: string): Promise<string[]> {
    const members = await db.admin.query.farmMembers.findMany({
      where: { farmId },
    });
    return members.map((m) => m.userId);
  }

  // There's at most one userSubscriptions row per user (unique on userId, upserted on create).
  // Trusted as-is — kept in sync by customer.subscription.updated/deleted webhooks, the same way
  // membershipPayments is trusted without re-checking Stripe on every read.
  async function getUserSubscriptionRow(userId: string) {
    return db.admin.query.userSubscriptions.findFirst({ where: { userId } });
  }

  // Only one payment mechanism can be active at a time: a second subscription, or a manual
  // top-up, is blocked while an existing subscription row exists — even if auto-renew has already
  // been disabled on it (it's still live, and still billing-relevant, until its period actually
  // ends). Switching from subscription to manual (or starting a fresh subscription) requires
  // waiting for the current one to actually end.
  //
  // Row existence alone isn't proof of that, though: createSubscriptionIntent inserts the row as
  // soon as the Stripe subscription is created, before the user has actually paid (there's no
  // checkout.session.completed event to hang the insert off for the native PaymentSheet flow). If
  // the user aborts the payment sheet, Stripe leaves the subscription "incomplete" — and later
  // "incomplete_expired" — without ever sending customer.subscription.deleted, so the row would
  // otherwise wrongly block every retry forever. Heal that specific case here. This deliberately
  // doesn't extend to a stale "canceled" row — that one only self-heals via an explicit mutating
  // action (see updateSubscriptionOrHeal), same as before.
  async function hasLiveSubscription(userId: string): Promise<boolean> {
    const row = await getUserSubscriptionRow(userId);
    if (!row) return false;

    const stripeSubscription = await getStripe().subscriptions.retrieve(row.stripeSubscriptionId);
    if (stripeSubscription.status === "incomplete" || stripeSubscription.status === "incomplete_expired") {
      if (stripeSubscription.status === "incomplete") {
        await getStripe().subscriptions.cancel(row.stripeSubscriptionId);
      }
      await db.admin.delete(userSubscriptions).where(eq(userSubscriptions.userId, userId));
      return false;
    }

    return true;
  }

  // Applies a Stripe subscription update. If Stripe rejects it, don't assume why — verify the
  // subscription's actual state first. Only if Stripe confirms it's genuinely canceled there (e.g.
  // a missed customer.subscription.deleted webhook left this row stale) do we clean up the local
  // row and report it gone; any other error is a real failure and gets rethrown untouched.
  async function updateSubscriptionOrHeal(
    userId: string,
    stripeSubscriptionId: string,
    params: Stripe.SubscriptionUpdateParams
  ): Promise<Stripe.Subscription | null> {
    try {
      return await getStripe().subscriptions.update(stripeSubscriptionId, params);
    } catch (err) {
      const current = await getStripe().subscriptions.retrieve(stripeSubscriptionId);
      if (current.status !== "canceled") throw err;
      await db.admin.delete(userSubscriptions).where(eq(userSubscriptions.userId, userId));
      return null;
    }
  }

  // Looks at the user's prior succeeded payment (if any) to work out both the new periodEnd and
  // which welcome/renewal/reactivation email fits — shared by both manual-payment webhook
  // branches (Checkout Session and native PaymentSheet).
  async function getManualPaymentContext(
    userId: string
  ): Promise<{ periodEnd: Date; isFirstMembership: boolean; wasStillActive: boolean }> {
    const latestPayment = await db.admin.query.membershipPayments.findFirst({
      where: { userId, status: "succeeded" },
      orderBy: { periodEnd: "desc" },
    });
    const now = new Date();
    const wasStillActive = latestPayment !== undefined && latestPayment.periodEnd > now;
    // Early renewal stacks the new year on top of remaining paid-for days instead of throwing
    // them away; a lapsed or first-time payment starts the new period from today.
    const base = wasStillActive ? latestPayment.periodEnd : now;
    const periodEnd = new Date(base);
    periodEnd.setFullYear(periodEnd.getFullYear() + 1);
    return { periodEnd, isFirstMembership: latestPayment === undefined, wasStillActive };
  }

  return {
    async getFarmMembershipStatus(farmId: string): Promise<FarmMembershipStatus> {
      if (UNLIMITED_TRIAL) return "trial";
      const userIds = await getUserIdsForFarm(farmId);
      if (userIds.length === 0) return "none";

      const now = new Date();
      const active = await db.admin.query.membershipPayments.findFirst({
        where: { userId: { in: userIds }, status: "succeeded", periodEnd: { gt: now } },
      });
      if (active) return "active";

      const trial = await db.admin.query.userTrials.findFirst({
        where: { userId: { in: userIds }, endsAt: { gt: now } },
      });
      return trial ? "trial" : "none";
    },

    // User-scoped active check (trial OR paid).
    async isActiveUser(userId: string): Promise<boolean> {
      if (UNLIMITED_TRIAL) return true;
      const now = new Date();
      const activeTrial = await db.admin.query.userTrials.findFirst({
        where: { userId, endsAt: { gt: now } },
      });
      if (activeTrial) return true;

      const active = await db.admin
        .select({ id: membershipPayments.id })
        .from(membershipPayments)
        .where(
          and(
            eq(membershipPayments.userId, userId),
            eq(membershipPayments.status, "succeeded"),
            // Non-cancelled: grace period beyond periodEnd. Cancelled (Austritt): access only
            // until periodEnd, no grace — but not cut off early either, they paid for that period.
            or(
              and(
                eq(membershipPayments.cancelledByUser, false),
                gt(membershipPayments.periodEnd, new Date(now.getTime() - GRACE_PERIOD_MS))
              ),
              and(eq(membershipPayments.cancelledByUser, true), gt(membershipPayments.periodEnd, now))
            )
          )
        )
        .limit(1);
      return active.length > 0;
    },

    // User-scoped paid-only check (excludes trial). Used for forum write operations.
    async isPaidUser(userId: string): Promise<boolean> {
      if (UNLIMITED_TRIAL) return true;
      const now = new Date();
      const active = await db.admin
        .select({ id: membershipPayments.id })
        .from(membershipPayments)
        .where(
          and(
            eq(membershipPayments.userId, userId),
            eq(membershipPayments.status, "succeeded"),
            or(
              and(
                eq(membershipPayments.cancelledByUser, false),
                gt(membershipPayments.periodEnd, new Date(now.getTime() - GRACE_PERIOD_MS))
              ),
              and(eq(membershipPayments.cancelledByUser, true), gt(membershipPayments.periodEnd, now))
            )
          )
        )
        .limit(1);
      return active.length > 0;
    },

    async startTrial(userId: string): Promise<{ trialEnd: Date }> {
      // Trial eligibility is per-user (userTrials.userId is unique) — a user can now belong to
      // multiple farms, so a farm-wide "one trial per farm" rule no longer has a well-defined
      // single farm to check against.
      const existing = await db.admin.query.userTrials.findFirst({ where: { userId } });
      if (existing) throw createHttpError(409, "Trial already used for this user");

      const endsAt = new Date();
      endsAt.setDate(endsAt.getDate() + 30);
      await db.admin.insert(userTrials).values({ userId, endsAt });
      return { trialEnd: endsAt };
    },

    // Stripe Subscription checkout (yearly, auto-renewing).
    async createSubscriptionCheckout(
      userId: string,
      locale: string,
      successUrl: string,
      cancelUrl: string
    ): Promise<{ url: string }> {
      if (await hasLiveSubscription(userId)) {
        throw createHttpError(409, "You already have an active subscription");
      }

      const priceId = process.env.STRIPE_MEMBERSHIP_PRICE_ID_YEARLY;
      if (!priceId) throw new Error("STRIPE_MEMBERSHIP_PRICE_ID_YEARLY env var not set");

      const customerId = await getOrCreateStripeCustomer(userId);

      // If an active trial exists, delay billing until it ends
      const now = new Date();
      const activeTrial = await db.admin.query.userTrials.findFirst({
        where: { userId, endsAt: { gt: now } },
      });

      const session = await getStripe().checkout.sessions.create({
        customer: customerId,
        mode: "subscription",
        payment_method_types: ["card"],
        line_items: [
          {
            price: priceId,
            quantity: 1,
          },
        ],
        success_url: successUrl,
        cancel_url: cancelUrl,
        metadata: { type: "membership", userId },
        subscription_data: activeTrial ? { trial_end: Math.floor(activeTrial.endsAt.getTime() / 1000) } : undefined,
        allow_promotion_codes: true,
        locale: locale as "de" | "en" | "it" | "fr",
      });

      return { url: session.url! };
    },

    // One-time annual payment checkout (no auto-renew)
    async createManualCheckout(
      userId: string,
      locale: string,
      successUrl: string,
      cancelUrl: string
    ): Promise<{ url: string }> {
      if (await hasLiveSubscription(userId)) {
        throw createHttpError(
          409,
          "You have an active subscription — cancel it and wait for it to end before making a one-time payment"
        );
      }

      const priceId = process.env.STRIPE_MEMBERSHIP_PRICE_ID_MANUAL;
      if (!priceId) throw new Error("STRIPE_MEMBERSHIP_PRICE_ID_MANUAL env var not set");

      const customerId = await getOrCreateStripeCustomer(userId);

      const session = await getStripe().checkout.sessions.create({
        customer: customerId,
        mode: "payment",
        payment_method_types: ["card", "twint"],
        line_items: [
          {
            price: priceId,
            quantity: 1,
          },
        ],
        success_url: successUrl,
        cancel_url: cancelUrl,
        metadata: { type: "membership", userId },
        locale: locale as "de" | "en" | "it" | "fr",
      });

      return { url: session.url! };
    },

    // Stripe Setup mode checkout to update payment method on an existing subscription
    async createPaymentMethodSetup(userId: string, successUrl: string, cancelUrl: string): Promise<{ url: string }> {
      const customerId = await getOrCreateStripeCustomer(userId);

      const session = await getStripe().checkout.sessions.create({
        customer: customerId,
        mode: "setup",
        currency: "chf",
        success_url: successUrl,
        cancel_url: cancelUrl,
        metadata: { type: "payment_method_setup", userId },
      });

      return { url: session.url! };
    },

    // Native PaymentSheet equivalent of createSubscriptionCheckout — returns a client secret
    // instead of a hosted checkout URL, for the mobile app's in-app payment UI.
    async createSubscriptionIntent(
      userId: string
    ): Promise<{ paymentIntentClientSecret: string; customerId: string; ephemeralKeySecret: string }> {
      if (await hasLiveSubscription(userId)) {
        throw createHttpError(409, "You already have an active subscription");
      }

      const priceId = process.env.STRIPE_MEMBERSHIP_PRICE_ID_YEARLY;
      if (!priceId) throw new Error("STRIPE_MEMBERSHIP_PRICE_ID_YEARLY env var not set");

      const customerId = await getOrCreateStripeCustomer(userId);
      const ephemeralKey = await getStripe().ephemeralKeys.create(
        { customer: customerId },
        { apiVersion: STRIPE_API_VERSION }
      );

      // If an active trial exists, delay billing until it ends — same as createSubscriptionCheckout
      const now = new Date();
      const activeTrial = await db.admin.query.userTrials.findFirst({
        where: { userId, endsAt: { gt: now } },
      });

      const subscription = await getStripe().subscriptions.create({
        customer: customerId,
        items: [{ price: priceId }],
        payment_behavior: "default_incomplete",
        payment_settings: { save_default_payment_method: "on_subscription" },
        expand: ["latest_invoice.confirmation_secret"],
        trial_end: activeTrial ? Math.floor(activeTrial.endsAt.getTime() / 1000) : undefined,
        metadata: { type: "membership", userId },
      });

      // Register the subscription locally right away rather than waiting for a webhook — there's
      // no checkout.session.completed event for this native flow, and invoice.payment_succeeded
      // (renewals) looks this row up by stripeSubscriptionId.
      await db.admin
        .insert(userSubscriptions)
        .values({ userId, stripeSubscriptionId: subscription.id, cancelAtPeriodEnd: false })
        .onConflictDoUpdate({
          target: userSubscriptions.userId,
          set: { stripeSubscriptionId: subscription.id, cancelAtPeriodEnd: false },
        });

      const invoice = subscription.latest_invoice as Stripe.Invoice;
      const clientSecret = invoice.confirmation_secret?.client_secret;
      if (!clientSecret) throw new Error(`Subscription ${subscription.id}'s invoice has no confirmation_secret`);

      return { paymentIntentClientSecret: clientSecret, customerId, ephemeralKeySecret: ephemeralKey.secret! };
    },

    // Native PaymentSheet equivalent of createManualCheckout (one-time payment, Twint-eligible).
    async createManualIntent(
      userId: string
    ): Promise<{ paymentIntentClientSecret: string; customerId: string; ephemeralKeySecret: string }> {
      if (await hasLiveSubscription(userId)) {
        throw createHttpError(
          409,
          "You have an active subscription — cancel it and wait for it to end before making a one-time payment"
        );
      }

      const priceId = process.env.STRIPE_MEMBERSHIP_PRICE_ID_MANUAL;
      if (!priceId) throw new Error("STRIPE_MEMBERSHIP_PRICE_ID_MANUAL env var not set");

      const price = await getStripe().prices.retrieve(priceId);
      if (!price.unit_amount) throw new Error(`Price ${priceId} has no unit_amount`);

      const customerId = await getOrCreateStripeCustomer(userId);
      const ephemeralKey = await getStripe().ephemeralKeys.create(
        { customer: customerId },
        { apiVersion: STRIPE_API_VERSION }
      );

      const paymentIntent = await getStripe().paymentIntents.create({
        amount: price.unit_amount,
        currency: price.currency,
        customer: customerId,
        payment_method_types: ["card", "twint"],
        metadata: { type: "membership", userId },
      });

      return {
        paymentIntentClientSecret: paymentIntent.client_secret!,
        customerId,
        ephemeralKeySecret: ephemeralKey.secret!,
      };
    },

    // Native PaymentSheet equivalent of createPaymentMethodSetup.
    async createPaymentMethodIntent(
      userId: string
    ): Promise<{ setupIntentClientSecret: string; customerId: string; ephemeralKeySecret: string }> {
      const customerId = await getOrCreateStripeCustomer(userId);
      const ephemeralKey = await getStripe().ephemeralKeys.create(
        { customer: customerId },
        { apiVersion: STRIPE_API_VERSION }
      );

      const setupIntent = await getStripe().setupIntents.create({
        customer: customerId,
        metadata: { type: "payment_method_setup", userId },
      });

      return {
        setupIntentClientSecret: setupIntent.client_secret!,
        customerId,
        ephemeralKeySecret: ephemeralKey.secret!,
      };
    },

    async reactivateSubscription(userId: string): Promise<{ cancelAtPeriodEnd: boolean }> {
      const latestPayment = await db.admin.query.membershipPayments.findFirst({
        where: { userId, status: "succeeded" },
        orderBy: { periodEnd: "desc" },
      });
      const subscription = await getUserSubscriptionRow(userId);

      // One-time payment user, or a subscription that turns out to be stale (already canceled on
      // Stripe, e.g. a missed customer.subscription.deleted webhook) — just clear the cancelled
      // flag, no Stripe subscription to touch.
      const updated = subscription
        ? await updateSubscriptionOrHeal(userId, subscription.stripeSubscriptionId, { cancel_at_period_end: false })
        : null;

      if (updated) {
        await db.admin
          .update(userSubscriptions)
          .set({ cancelAtPeriodEnd: false })
          .where(eq(userSubscriptions.userId, userId));
      }

      if (latestPayment) {
        await db.admin
          .update(membershipPayments)
          .set({ cancelledByUser: false })
          .where(eq(membershipPayments.id, latestPayment.id));

        const profile = await db.admin.query.profiles.findFirst({ where: { id: userId } });
        if (profile) {
          await sendReactivationEmail({
            email: profile.email,
            fullName: profile.fullName,
            locale: profile.locale,
            periodEnd: latestPayment.periodEnd,
          });
        }
      }

      return { cancelAtPeriodEnd: false };
    },

    async getStatus(userId: string): Promise<MembershipStatus> {
      // Find the latest succeeded payment (may be expired)
      const latestPayment = await db.admin.query.membershipPayments.findFirst({
        where: { userId, status: "succeeded" },
        orderBy: { periodEnd: "desc" },
      });

      const subscription = await getUserSubscriptionRow(userId);

      const trial = await db.admin.query.userTrials.findFirst({ where: { userId } });

      return {
        lastPeriodEnd: latestPayment?.periodEnd ?? null,
        cancelAtPeriodEnd: subscription?.cancelAtPeriodEnd ?? false,
        autoRenewing: subscription !== undefined,
        trialEnd: trial?.endsAt ?? null,
        cancelledByUser: latestPayment?.cancelledByUser ?? false,
      };
    },

    async cancelSubscription(userId: string): Promise<{ cancelAtPeriodEnd: boolean }> {
      // Mark the latest succeeded payment so the expiry cron skips this user
      const latestPayment = await db.admin.query.membershipPayments.findFirst({
        where: { userId, status: "succeeded" },
        orderBy: { periodEnd: "desc" },
      });

      const subscription = await getUserSubscriptionRow(userId);

      if (subscription) {
        const updated = await updateSubscriptionOrHeal(userId, subscription.stripeSubscriptionId, {
          cancel_at_period_end: true,
        });
        if (updated) {
          await db.admin
            .update(userSubscriptions)
            .set({ cancelAtPeriodEnd: true })
            .where(eq(userSubscriptions.userId, userId));
        }
      }

      if (latestPayment) {
        await db.admin
          .update(membershipPayments)
          .set({ cancelledByUser: true })
          .where(and(eq(membershipPayments.id, latestPayment.id)));

        const profile = await db.admin.query.profiles.findFirst({ where: { id: userId } });
        if (profile) {
          await sendCancellationEmail({
            email: profile.email,
            fullName: profile.fullName,
            locale: profile.locale,
            periodEnd: latestPayment.periodEnd,
            reactivateUrl: `${process.env.APP_URL ?? "https://app.coltivio.ch"}/membership`,
          });
        }
      }

      return { cancelAtPeriodEnd: true };
    },

    // Lightweight alternative to cancelSubscription: stops the subscription from renewing
    // without it being a formal Vereins-Austritt. Unlike cancelSubscription, the member stays
    // active (isActiveUser/isPaidUser only key off cancelledByUser, not cancelAtPeriodEnd) until
    // their current paid period naturally runs out — no cancellation email, cancelledByUser
    // stays false so the expiry-reminder cron still nudges them before it lapses.
    async disableAutoRenew(userId: string): Promise<{ cancelAtPeriodEnd: boolean }> {
      const subscription = await getUserSubscriptionRow(userId);
      if (!subscription) throw createHttpError(400, "No auto-renewing subscription to disable");

      const updated = await updateSubscriptionOrHeal(userId, subscription.stripeSubscriptionId, {
        cancel_at_period_end: true,
      });
      if (!updated) throw createHttpError(400, "No auto-renewing subscription to disable");

      await db.admin
        .update(userSubscriptions)
        .set({ cancelAtPeriodEnd: true })
        .where(eq(userSubscriptions.userId, userId));

      return { cancelAtPeriodEnd: true };
    },

    async getPayments(userId: string) {
      return db.admin.query.membershipPayments.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
      });
    },

    async handleWebhookEvent(event: Stripe.Event): Promise<void> {
      if (event.type === "checkout.session.completed") {
        const session = event.data.object as Stripe.Checkout.Session;
        const userId = session.metadata?.userId;
        if (!userId) return;

        // Payment method setup: attach the new card to the existing subscription
        if (session.mode === "setup" && session.metadata?.type === "payment_method_setup" && session.setup_intent) {
          const setupIntentId =
            typeof session.setup_intent === "string" ? session.setup_intent : session.setup_intent.id;
          const setupIntent = await getStripe().setupIntents.retrieve(setupIntentId);
          const sub = await db.admin.query.userSubscriptions.findFirst({ where: { userId } });
          if (sub && setupIntent.payment_method) {
            await getStripe().subscriptions.update(sub.stripeSubscriptionId, {
              default_payment_method: setupIntent.payment_method as string,
            });
          }
          return;
        }

        if (session.mode === "subscription" && session.subscription) {
          const stripeSubscriptionId =
            typeof session.subscription === "string" ? session.subscription : session.subscription.id;

          const stripeSubscription = await getStripe().subscriptions.retrieve(stripeSubscriptionId);

          if (!(await profileExists(userId))) {
            const invoice = stripeSubscription.latest_invoice;
            if (invoice) {
              const stripeInvoice =
                typeof invoice === "string" ? await getStripe().invoices.retrieve(invoice) : invoice;
              await recordPaymentForDeletedAccount({
                stripePaymentId: stripeInvoice.id,
                stripeSubscriptionId,
                amount: stripeInvoice.amount_paid,
                currency: stripeInvoice.currency,
                periodEnd: new Date((stripeSubscription.items.data[0]?.current_period_end ?? 0) * 1000),
              });
            }
            return;
          }

          // Upsert userSubscriptions row
          await db.admin
            .insert(userSubscriptions)
            .values({
              userId,
              stripeSubscriptionId,
              cancelAtPeriodEnd: stripeSubscription.cancel_at_period_end,
            })
            .onConflictDoUpdate({
              target: userSubscriptions.userId,
              set: { stripeSubscriptionId, cancelAtPeriodEnd: stripeSubscription.cancel_at_period_end },
            });

          const firstItem = stripeSubscription.items.data[0];
          const periodEnd = new Date((firstItem?.current_period_end ?? 0) * 1000);

          const invoice = stripeSubscription.latest_invoice;
          if (invoice) {
            const stripeInvoice = typeof invoice === "string" ? await getStripe().invoices.retrieve(invoice) : invoice;

            const pmId =
              typeof stripeSubscription.default_payment_method === "string"
                ? stripeSubscription.default_payment_method
                : (stripeSubscription.default_payment_method?.id ?? null);
            const cardDetails = await getCardDetailsFromPaymentMethod(pmId);

            const isFirstMembership = !(await db.admin.query.membershipPayments.findFirst({
              where: { userId, status: "succeeded" },
            }));

            // Gate the email on whether this insert actually happened (not a conflict no-op) —
            // this same underlying invoice can also reach us via invoice.payment_succeeded
            // (Stripe sends both events for a subscription's first invoice), so this insert may
            // already have happened by the time either handler runs.
            const inserted = await db.admin
              .insert(membershipPayments)
              .values({
                userId,
                stripePaymentId: stripeInvoice.id,
                stripeSubscriptionId,
                amount: stripeInvoice.amount_paid,
                currency: stripeInvoice.currency,
                status: "succeeded",
                periodEnd,
                ...cardDetails,
              })
              .onConflictDoNothing()
              .returning({ id: membershipPayments.id });

            if (inserted.length > 0) {
              const profile = await db.admin.query.profiles.findFirst({ where: { id: userId } });
              if (profile) {
                if (isFirstMembership) {
                  await sendNewMembershipEmail({
                    email: profile.email,
                    fullName: profile.fullName,
                    locale: profile.locale,
                    amount: stripeInvoice.amount_paid,
                    periodEnd,
                    cardBrand: cardDetails.cardBrand,
                    cardLast4: cardDetails.cardLast4,
                  });
                } else {
                  await sendReactivationEmail({
                    email: profile.email,
                    fullName: profile.fullName,
                    locale: profile.locale,
                    periodEnd,
                  });
                }
              }
            }
          }
        } else if (session.mode === "payment" && session.metadata?.type === "membership") {
          const { periodEnd, isFirstMembership, wasStillActive } = await getManualPaymentContext(userId);

          const paymentIntentId =
            typeof session.payment_intent === "string"
              ? session.payment_intent
              : (session.payment_intent?.id ?? session.id);

          if (!(await profileExists(userId))) {
            if (session.amount_total == null) throw new Error(`Missing amount_total on session ${session.id}`);
            await recordPaymentForDeletedAccount({
              stripePaymentId: paymentIntentId,
              amount: session.amount_total,
              currency: session.currency ?? "chf",
              periodEnd,
            });
            return;
          }

          const paymentIntent = await getStripe().paymentIntents.retrieve(paymentIntentId, {
            expand: ["payment_method"],
          });
          const pmId =
            typeof paymentIntent.payment_method === "string"
              ? paymentIntent.payment_method
              : (paymentIntent.payment_method?.id ?? null);
          const cardDetails = await getCardDetailsFromPaymentMethod(pmId);

          if (session.amount_total == null) throw new Error(`Missing amount_total on session ${session.id}`);
          const amount = session.amount_total;
          // Gate the email on whether this insert actually happened — the same PaymentIntent
          // also fires payment_intent.succeeded (handled below), which could process first.
          const inserted = await db.admin
            .insert(membershipPayments)
            .values({
              userId,
              stripePaymentId: paymentIntentId,
              amount,
              currency: session.currency ?? "chf",
              status: "succeeded",
              periodEnd,
              ...cardDetails,
            })
            .onConflictDoNothing()
            .returning({ id: membershipPayments.id });

          if (inserted.length > 0) {
            const profile = await db.admin.query.profiles.findFirst({ where: { id: userId } });
            if (profile) {
              if (isFirstMembership) {
                await sendNewMembershipEmail({
                  email: profile.email,
                  fullName: profile.fullName,
                  locale: profile.locale,
                  amount,
                  periodEnd,
                  cardBrand: cardDetails.cardBrand,
                  cardLast4: cardDetails.cardLast4,
                });
              } else if (wasStillActive) {
                // Renewed before their prior period ran out — "renewed", not "welcome back".
                await sendRenewalEmail({
                  email: profile.email,
                  fullName: profile.fullName,
                  locale: profile.locale,
                  amount,
                  periodEnd,
                  cardBrand: cardDetails.cardBrand,
                  cardLast4: cardDetails.cardLast4,
                });
              } else {
                await sendReactivationEmail({
                  email: profile.email,
                  fullName: profile.fullName,
                  locale: profile.locale,
                  periodEnd,
                });
              }
            }
          }
        }
      } else if (event.type === "invoice.payment_succeeded") {
        const invoice = event.data.object as Stripe.Invoice;
        const subRef = invoice.parent?.subscription_details?.subscription;
        const stripeSubscriptionId = typeof subRef === "string" ? subRef : subRef?.id;

        if (!stripeSubscriptionId) return;

        // Look up userId from userSubscriptions
        const sub = await db.admin.query.userSubscriptions.findFirst({
          where: { stripeSubscriptionId },
        });
        if (!sub) return;

        const stripeSubscription = await getStripe().subscriptions.retrieve(stripeSubscriptionId);
        const firstItem = stripeSubscription.items.data[0];
        const periodEnd = new Date((firstItem?.current_period_end ?? 0) * 1000);

        const pmId =
          typeof stripeSubscription.default_payment_method === "string"
            ? stripeSubscription.default_payment_method
            : (stripeSubscription.default_payment_method?.id ?? null);
        const cardDetails = await getCardDetailsFromPaymentMethod(pmId);

        // Was this the very first successful payment for this user, before this insert? Needed to
        // pick the right email below, for both the "creation" and "cycle" branches.
        const isFirstMembership = !(await db.admin.query.membershipPayments.findFirst({
          where: { userId: sub.userId, status: "succeeded" },
        }));

        // Gate emails on whether this insert actually happened — for a subscription created via
        // the (still-supported) Checkout Session flow, checkout.session.completed's subscription
        // branch already inserted this same invoice, so this becomes a safe no-op here.
        const inserted = await db.admin
          .insert(membershipPayments)
          .values({
            userId: sub.userId,
            stripePaymentId: invoice.id,
            stripeSubscriptionId,
            amount: invoice.amount_paid,
            currency: invoice.currency,
            status: "succeeded",
            periodEnd,
            ...cardDetails,
          })
          .onConflictDoNothing()
          .returning({ id: membershipPayments.id });

        if (inserted.length === 0) {
          // Already recorded by another handler for this same invoice — nothing left to do.
        } else if (invoice.billing_reason === "subscription_create") {
          // The only event for a natively-created subscription's first invoice (no Checkout
          // Session involved) — mirrors checkout.session.completed's subscription-mode welcome email.
          const profile = await db.admin.query.profiles.findFirst({ where: { id: sub.userId } });
          if (profile) {
            if (isFirstMembership) {
              await sendNewMembershipEmail({
                email: profile.email,
                fullName: profile.fullName,
                locale: profile.locale,
                amount: invoice.amount_paid,
                periodEnd,
                cardBrand: cardDetails.cardBrand,
                cardLast4: cardDetails.cardLast4,
              });
            } else {
              await sendReactivationEmail({
                email: profile.email,
                fullName: profile.fullName,
                locale: profile.locale,
                periodEnd,
              });
            }
          }
        } else if (invoice.billing_reason === "subscription_cycle") {
          const profile = await db.admin.query.profiles.findFirst({ where: { id: sub.userId } });
          if (profile) {
            // If the only previous payment was $0 (trial checkout), this is the first real charge
            const previousNonZeroPayment = await db.admin.query.membershipPayments.findFirst({
              where: { userId: sub.userId, status: "succeeded" },
              orderBy: { createdAt: "asc" },
            });
            const isFirstRealPayment = !previousNonZeroPayment || previousNonZeroPayment.amount === 0;

            if (isFirstRealPayment) {
              await sendFirstPaymentEmail({
                email: profile.email,
                fullName: profile.fullName,
                locale: profile.locale,
                amount: invoice.amount_paid,
                periodEnd,
                cardBrand: cardDetails.cardBrand,
                cardLast4: cardDetails.cardLast4,
              });
            } else {
              await sendRenewalEmail({
                email: profile.email,
                fullName: profile.fullName,
                locale: profile.locale,
                amount: invoice.amount_paid,
                periodEnd,
                cardBrand: cardDetails.cardBrand,
                cardLast4: cardDetails.cardLast4,
              });
            }
          }
        }
      } else if (event.type === "invoice.payment_failed") {
        const invoice = event.data.object as Stripe.Invoice;
        const subRef = invoice.parent?.subscription_details?.subscription;
        const stripeSubscriptionId = typeof subRef === "string" ? subRef : subRef?.id;

        if (!stripeSubscriptionId) return;

        const sub = await db.admin.query.userSubscriptions.findFirst({
          where: { stripeSubscriptionId },
        });
        if (!sub) return;

        await db.admin
          .insert(membershipPayments)
          .values({
            userId: sub.userId,
            stripePaymentId: invoice.id,
            stripeSubscriptionId,
            amount: invoice.amount_due,
            currency: invoice.currency,
            status: "failed",
            periodEnd: new Date(0),
          })
          .onConflictDoNothing();

        // Find the latest succeeded payment to use as the expiry reference date
        const latestSucceeded = await db.admin.query.membershipPayments.findFirst({
          where: { userId: sub.userId, status: "succeeded" },
          orderBy: { periodEnd: "desc" },
        });

        if (latestSucceeded) {
          const inserted = await db.admin
            .insert(membershipExpiryNotifications)
            .values({ userId: sub.userId, periodEndDate: latestSucceeded.periodEnd, type: "payment_failed" })
            .onConflictDoNothing()
            .returning({ id: membershipExpiryNotifications.id });

          if (inserted.length > 0) {
            const profile = await db.admin.query.profiles.findFirst({ where: { id: sub.userId } });
            if (profile) {
              await sendPaymentFailedEmail({
                email: profile.email,
                fullName: profile.fullName,
                locale: profile.locale,
                periodEnd: latestSucceeded.periodEnd,
                renewUrl: `${process.env.APP_URL ?? "https://app.coltivio.ch"}/membership`,
              });
            }
          }
        }
      } else if (event.type === "customer.subscription.updated") {
        const stripeSubscription = event.data.object as Stripe.Subscription;

        // A subscription created via createSubscriptionIntent that never got paid transitions
        // straight to "incomplete_expired" without ever firing customer.subscription.deleted —
        // clean up the row here too, as a safety net alongside the on-demand healing in
        // hasLiveSubscription, so it doesn't linger for users who never retry.
        if (stripeSubscription.status === "incomplete_expired") {
          await db.admin
            .delete(userSubscriptions)
            .where(eq(userSubscriptions.stripeSubscriptionId, stripeSubscription.id));
          return;
        }

        await db.admin
          .update(userSubscriptions)
          .set({ cancelAtPeriodEnd: stripeSubscription.cancel_at_period_end })
          .where(eq(userSubscriptions.stripeSubscriptionId, stripeSubscription.id));
      } else if (event.type === "customer.subscription.deleted") {
        const stripeSubscription = event.data.object as Stripe.Subscription;
        await db.admin
          .delete(userSubscriptions)
          .where(eq(userSubscriptions.stripeSubscriptionId, stripeSubscription.id));
      } else if (event.type === "payment_intent.succeeded") {
        // Native (PaymentSheet) equivalent of the checkout.session.completed "payment" branch —
        // a standalone one-time membership PaymentIntent created via createManualIntent. Guarded
        // on our own metadata.type so a subscription invoice's own PaymentIntent (which also
        // fires this event, but never carries this metadata) is correctly ignored here.
        const paymentIntent = event.data.object as Stripe.PaymentIntent;
        const metadata = paymentIntent.metadata;
        if (metadata?.type !== "membership" || !metadata.userId) return;
        const userId = metadata.userId;

        const pmId =
          typeof paymentIntent.payment_method === "string"
            ? paymentIntent.payment_method
            : (paymentIntent.payment_method?.id ?? null);
        const cardDetails = await getCardDetailsFromPaymentMethod(pmId);

        const { periodEnd, isFirstMembership, wasStillActive } = await getManualPaymentContext(userId);

        if (!(await profileExists(userId))) {
          await recordPaymentForDeletedAccount({
            stripePaymentId: paymentIntent.id,
            amount: paymentIntent.amount,
            currency: paymentIntent.currency,
            periodEnd,
          });
          return;
        }

        const inserted = await db.admin
          .insert(membershipPayments)
          .values({
            userId,
            stripePaymentId: paymentIntent.id,
            amount: paymentIntent.amount,
            currency: paymentIntent.currency,
            status: "succeeded",
            periodEnd,
            ...cardDetails,
          })
          .onConflictDoNothing()
          .returning({ id: membershipPayments.id });

        if (inserted.length > 0) {
          const profile = await db.admin.query.profiles.findFirst({ where: { id: userId } });
          if (profile) {
            if (isFirstMembership) {
              await sendNewMembershipEmail({
                email: profile.email,
                fullName: profile.fullName,
                locale: profile.locale,
                amount: paymentIntent.amount,
                periodEnd,
                cardBrand: cardDetails.cardBrand,
                cardLast4: cardDetails.cardLast4,
              });
            } else if (wasStillActive) {
              // Renewed before their prior period ran out — "renewed", not "welcome back".
              await sendRenewalEmail({
                email: profile.email,
                fullName: profile.fullName,
                locale: profile.locale,
                amount: paymentIntent.amount,
                periodEnd,
                cardBrand: cardDetails.cardBrand,
                cardLast4: cardDetails.cardLast4,
              });
            } else {
              await sendReactivationEmail({
                email: profile.email,
                fullName: profile.fullName,
                locale: profile.locale,
                periodEnd,
              });
            }
          }
        }
      } else if (event.type === "setup_intent.succeeded") {
        // Native (PaymentSheet) equivalent of the checkout.session.completed "setup" branch —
        // attach the newly-collected card as the subscription's default payment method.
        const setupIntent = event.data.object as Stripe.SetupIntent;
        const metadata = setupIntent.metadata;
        if (metadata?.type !== "payment_method_setup" || !metadata.userId) return;
        const userId = metadata.userId;

        const sub = await db.admin.query.userSubscriptions.findFirst({ where: { userId } });
        if (sub && setupIntent.payment_method) {
          await getStripe().subscriptions.update(sub.stripeSubscriptionId, {
            default_payment_method: setupIntent.payment_method as string,
          });
        }
      }
    },
  };
}
