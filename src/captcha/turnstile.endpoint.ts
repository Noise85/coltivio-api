import { z } from "zod";
import { publicEndpointFactory } from "../endpoint-factory";

const turnstileResponseSchema = z.object({
  success: z.boolean(),
});

export const verifyCaptchaEndpoint = publicEndpointFactory.build({
  method: "post",
  input: z.object({ token: z.string() }),
  output: turnstileResponseSchema,
  handler: async ({ input: { token } }) => {
    const secretKey = process.env.TURNSTILE_SECRET_KEY;
    if (!secretKey) {
      throw new Error("TURNSTILE_SECRET_KEY is not set");
    }

    const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        secret: secretKey,
        response: token,
      }),
    });

    const data = await response.json();
    return turnstileResponseSchema.parse(data);
  },
});
