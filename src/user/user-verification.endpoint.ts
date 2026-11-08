import { z } from "zod";
import { authenticatedEndpointFactory, publicEndpointFactory } from "../endpoint-factory";
import { resendVerificationEmail, verifyEmailToken } from "./user-verification";

// Called from the link in the verification email. No JWT: the link is often opened on a device
// that has never been logged in. It only confirms the address and does not log anyone in.
export const verifyEmailEndpoint = publicEndpointFactory.build({
  method: "post",
  input: z.object({ token: z.string() }),
  output: z.object({ verified: z.boolean() }),
  handler: async ({ input }) => verifyEmailToken(input.token),
});

export const resendVerificationEmailEndpoint = authenticatedEndpointFactory.build({
  method: "post",
  input: z.object({}),
  output: z.object({ sent: z.boolean() }),
  handler: async ({ ctx }) => {
    await resendVerificationEmail(ctx.user.id);
    return { sent: true };
  },
});
