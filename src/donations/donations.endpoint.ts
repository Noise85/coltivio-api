import { z } from "zod";
import { authenticatedEndpointFactory, optionalUserEndpointFactory } from "../endpoint-factory";
import { donationsApi } from "./donations";
import { adminOnlyDb } from "../db/db";
import { donationStatusSchema } from "../db/schema";

const api = donationsApi(adminOnlyDb);

const donationSchema = z.object({
  id: z.string(),
  userId: z.string().nullable(),
  email: z.string(),
  amount: z.number(),
  currency: z.string(),
  status: donationStatusSchema,
  paymentMethodType: z.string().nullable(),
  cardLast4: z.string().nullable(),
  cardBrand: z.string().nullable(),
  createdAt: z.date(),
});

export const getMyDonationsEndpoint = authenticatedEndpointFactory.build({
  method: "get",
  input: z.object({}),
  output: z.object({
    result: z.array(donationSchema),
    count: z.number(),
  }),
  handler: async ({ ctx }) => {
    const result = await ctx.donations.getDonations(ctx.user.id);
    return { result, count: result.length };
  },
});

export const createDonationCheckoutEndpoint = optionalUserEndpointFactory.build({
  method: "post",
  input: z.object({
    amount: z.number().int().min(100),
    email: z.email(),
    successUrl: z.string().url(),
    cancelUrl: z.string().url(),
  }),
  output: z.object({ url: z.string() }),
  handler: async ({ input, ctx }) => {
    return api.createDonationCheckout(
      input.amount,
      input.email,
      input.successUrl,
      input.cancelUrl,
      ctx.userId ?? undefined,
      ctx.preferredLanguage
    );
  },
});

export const createDonationIntentEndpoint = optionalUserEndpointFactory.build({
  method: "post",
  input: z.object({
    amount: z.number().int().min(100),
    email: z.email(),
  }),
  output: z.object({ paymentIntentClientSecret: z.string() }),
  handler: async ({ input, ctx }) => {
    return api.createDonationIntent(input.amount, input.email, ctx.userId ?? undefined, ctx.preferredLanguage);
  },
});
