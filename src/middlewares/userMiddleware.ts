import { z } from "zod";
import { Middleware } from "express-zod-api";

export const userMiddleware = new Middleware({
  security: {
    // this information is optional and used for generating documentation
    type: "header",
    name: "token",
  },
  input: z.object({}),
  handler: async ({ input: {}, ctx: _ctx, request: _request, logger }) => {
    logger.debug("Checking the key and token");
    // const user = await db.Users.findOne({ key });
    // if (!user) {
    //   throw createHttpError(401, "Invalid key");
    // }
    // if (request.headers.token !== user.token) {
    //   throw createHttpError(401, "Invalid token");
    // }
    return { token: { claims: { userId: "1" } } };
  },
});
