import Stripe from "stripe";
import { RlsDb } from "../db/db";
import { getStripe } from "../stripe/stripe";
import { donations } from "../db/schema";
import { sendDonationConfirmationEmail } from "./donations.email";

type CardDetails = {
  paymentMethodType: string | null;
  cardLast4: string | null;
  cardBrand: string | null;
};

const emptyCardDetails: CardDetails = {
  paymentMethodType: null,
  cardLast4: null,
  cardBrand: null,
};

// Card details are display-only, a Stripe hiccup here must not fail the webhook and delay recording the donation.
async function getCardDetails(paymentIntentId: string): Promise<CardDetails> {
  let paymentIntent: Stripe.PaymentIntent;
  try {
    paymentIntent = await getStripe().paymentIntents.retrieve(paymentIntentId, { expand: ["payment_method"] });
  } catch (err) {
    console.error(`Failed to fetch payment method for donation ${paymentIntentId}:`, err);
    return emptyCardDetails;
  }
  const pm = paymentIntent.payment_method;
  if (!pm || typeof pm === "string") return emptyCardDetails;
  if (!pm.card) return { ...emptyCardDetails, paymentMethodType: pm.type };
  return {
    paymentMethodType: pm.type,
    cardLast4: pm.card.last4,
    cardBrand: pm.card.brand,
  };
}

export function donationsApi(db: RlsDb) {
  return {
    async getDonations(userId: string) {
      return db.admin.query.donations.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
      });
    },

    async createDonationCheckout(
      amount: number,
      email: string,
      successUrl: string,
      cancelUrl: string,
      userId?: string,
      locale?: string
    ): Promise<{ url: string }> {
      if (amount < 100) throw new Error("Minimum donation amount is CHF 1.00 (100 cents)");

      const session = await getStripe().checkout.sessions.create({
        mode: "payment",
        payment_method_types: ["card", "twint"],
        customer_email: email,
        line_items: [
          {
            price_data: {
              currency: "chf",
              unit_amount: amount,
              product_data: { name: "Spende an Coltivio" },
            },
            quantity: 1,
          },
        ],
        success_url: successUrl,
        cancel_url: cancelUrl,
        metadata: {
          type: "donation",
          userId: userId ?? "",
          locale: locale ?? "de",
        },
      });

      return { url: session.url! };
    },

    // Native PaymentSheet equivalent of createDonationCheckout — no Stripe Customer/ephemeral key
    // needed since donations don't save a payment method or support guest re-use.
    async createDonationIntent(
      amount: number,
      email: string,
      userId?: string,
      locale?: string
    ): Promise<{ paymentIntentClientSecret: string }> {
      if (amount < 100) throw new Error("Minimum donation amount is CHF 1.00 (100 cents)");

      const paymentIntent = await getStripe().paymentIntents.create({
        amount,
        currency: "chf",
        receipt_email: email,
        payment_method_types: ["card", "twint"],
        metadata: {
          type: "donation",
          userId: userId ?? "",
          locale: locale ?? "de",
          email,
        },
      });

      return { paymentIntentClientSecret: paymentIntent.client_secret! };
    },

    async handleDonationWebhook(session: Stripe.Checkout.Session): Promise<void> {
      const userId = session.metadata?.userId || null;
      const email = session.customer_email ?? session.customer_details?.email ?? "";
      const rawPaymentIntentId =
        typeof session.payment_intent === "string" ? session.payment_intent : (session.payment_intent?.id ?? null);
      const paymentIntentId = rawPaymentIntentId ?? session.id;
      // The account may have been deleted since checkout started, the donation then stays anonymous
      const profile = userId ? await db.admin.query.profiles.findFirst({ where: { id: userId } }) : undefined;
      const cardDetails = rawPaymentIntentId ? await getCardDetails(rawPaymentIntentId) : emptyCardDetails;

      const inserted = await db.admin
        .insert(donations)
        .values({
          userId: profile?.id ?? null,
          email,
          stripePaymentId: paymentIntentId,
          amount: session.amount_total ?? 0,
          currency: session.currency ?? "chf",
          status: "succeeded",
          ...cardDetails,
        })
        .onConflictDoNothing()
        .returning({ id: donations.id });
      if (inserted.length === 0) return;

      await sendDonationConfirmationEmail({
        email,
        fullName: profile?.fullName ?? null,
        locale: session.metadata?.locale ?? "de",
        amount: session.amount_total ?? 0,
      });
    },

    // Native (PaymentSheet) equivalent — a standalone donation PaymentIntent created via
    // createDonationIntent, guarded on our own metadata.type like the membership handler.
    async handleDonationPaymentIntentWebhook(paymentIntent: Stripe.PaymentIntent): Promise<void> {
      const metadata = paymentIntent.metadata;
      if (metadata?.type !== "donation") return;
      const userId = metadata.userId || null;
      const email = metadata.email || paymentIntent.receipt_email || "";
      const profile = userId ? await db.admin.query.profiles.findFirst({ where: { id: userId } }) : undefined;
      const cardDetails = await getCardDetails(paymentIntent.id);

      const inserted = await db.admin
        .insert(donations)
        .values({
          userId: profile?.id ?? null,
          email,
          stripePaymentId: paymentIntent.id,
          amount: paymentIntent.amount,
          currency: paymentIntent.currency,
          status: "succeeded",
          ...cardDetails,
        })
        .onConflictDoNothing()
        .returning({ id: donations.id });
      if (inserted.length === 0) return;

      await sendDonationConfirmationEmail({
        email,
        fullName: profile?.fullName ?? null,
        locale: metadata.locale || "de",
        amount: paymentIntent.amount,
      });
    },
  };
}
