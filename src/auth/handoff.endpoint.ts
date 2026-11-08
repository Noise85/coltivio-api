import { z } from "zod";
import { adminOnlyDb } from "../db/db";
import { authenticatedEndpointFactory, publicEndpointFactory } from "../endpoint-factory";
import { handoffApi } from "./handoff";

export const createHandoffTokenEndpoint = authenticatedEndpointFactory.build({
  method: "post",
  input: z.object({}),
  output: z.object({ token: z.string(), expiresAt: z.date() }),
  handler: async ({ input: {}, ctx }) => ctx.handoff.createHandoffToken(ctx.user.id),
});

export const exchangeHandoffTokenEndpoint = publicEndpointFactory.build({
  method: "post",
  input: z.object({ token: z.string(), redirectTo: z.string().url() }),
  output: z.object({ url: z.string() }),
  handler: async ({ input }) => {
    const api = handoffApi(adminOnlyDb);
    return api.exchangeHandoffToken(input.token, input.redirectTo);
  },
});
