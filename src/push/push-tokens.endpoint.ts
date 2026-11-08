import createHttpError from "http-errors";
import { z } from "zod";
import { authenticatedEndpointFactory } from "../endpoint-factory";
import { isExpoPushToken } from "./expo-client";

export const registerPushTokenEndpoint = authenticatedEndpointFactory.build({
  method: "post",
  input: z.object({
    token: z.string(),
    platform: z.enum(["ios", "android"]).optional(),
  }),
  output: z.object({}),
  handler: async ({ input, ctx }) => {
    if (!isExpoPushToken(input.token)) {
      throw createHttpError(400, "Invalid Expo push token");
    }
    await ctx.pushTokens.registerToken(ctx.user.id, input.token, input.platform);
    return {};
  },
});

// DELETE reads input from the query string: /v1/me/push-tokens?token=...
export const unregisterPushTokenEndpoint = authenticatedEndpointFactory.build({
  method: "delete",
  input: z.object({ token: z.string() }),
  output: z.object({}),
  handler: async ({ input, ctx }) => {
    await ctx.pushTokens.unregisterToken(input.token);
    return {};
  },
});
