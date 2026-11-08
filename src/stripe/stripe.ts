import Stripe from "stripe";

let _stripe: Stripe | null = null;

// Exported so mobile-SDK-facing code (ephemeral keys) can pass the same version the
// client Stripe SDK expects, without duplicating the literal.
export const STRIPE_API_VERSION = "2026-02-25.clover";

// Lazy singleton — only instantiated on first use so importing this module
// during build/doc generation doesn't require STRIPE_SECRET_KEY to be set.
export function getStripe(): Stripe {
  if (!_stripe) {
    if (!process.env.STRIPE_SECRET_KEY) {
      throw new Error("STRIPE_SECRET_KEY env var not set");
    }
    _stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
      apiVersion: STRIPE_API_VERSION,
    });
  }
  return _stripe;
}
