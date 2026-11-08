import Stripe from "stripe";
import { RequestHandler } from "express";
import { getStripe } from "./stripe";
import { membershipApi } from "../membership/membership";
import { donationsApi } from "../donations/donations";
import { adminOnlyDb } from "../db/db";

const membership = membershipApi(adminOnlyDb);
const donations = donationsApi(adminOnlyDb);

export const stripeWebhookHandler: RequestHandler = async (req, res) => {
  const sig = req.headers["stripe-signature"];
  if (!sig) {
    res.status(400).send("Missing stripe-signature header");
    return;
  }

  let event: Stripe.Event;
  try {
    event = getStripe().webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET!);
  } catch (err) {
    res.status(400).send(`Webhook signature verification failed: ${(err as Error).message}`);
    return;
  }

  try {
    if (
      event.type.startsWith("checkout.session") ||
      event.type.startsWith("customer.subscription") ||
      event.type.startsWith("invoice") ||
      event.type === "payment_intent.succeeded" ||
      event.type === "setup_intent.succeeded"
    ) {
      // Internally no-ops for events it doesn't recognize as its own (e.g. metadata.type mismatch)
      await membership.handleWebhookEvent(event);
    }

    // Donation checkout completed
    if (
      event.type === "checkout.session.completed" &&
      (event.data.object as Stripe.Checkout.Session).metadata?.type === "donation"
    ) {
      await donations.handleDonationWebhook(event.data.object as Stripe.Checkout.Session);
    }

    // Native (PaymentSheet) donation PaymentIntent completed
    if (
      event.type === "payment_intent.succeeded" &&
      (event.data.object as Stripe.PaymentIntent).metadata?.type === "donation"
    ) {
      await donations.handleDonationPaymentIntentWebhook(event.data.object as Stripe.PaymentIntent);
    }

    res.json({ received: true });
  } catch (err) {
    console.error("Webhook processing error:", err);
    res.status(500).send(`Webhook processing failed: ${(err as Error).message}`);
  }
};
