import { defaultEndpointsFactory } from "express-zod-api";
import { z } from "zod";

export const healthEndpoint = defaultEndpointsFactory.build({
  method: "get",
  input: z.object({}),
  output: z.object({ status: z.string() }),
  handler: async () => {
    return { status: "ok" };
  },
});
