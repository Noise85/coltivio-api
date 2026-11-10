import { captureException } from "@sentry/node";
import { ensureHttpError, ResultHandler } from "express-zod-api";
import createHttpError, { HttpError } from "http-errors";
import { z } from "zod";
import { ApiErrorCode, apiErrorCodeSchema, CodedError } from "./errors";
// initializes Sentry before the first error can be captured
import "./sentry";

// Maps domain errors (CodedError) and HTTP errors to the JSON error response, reports server errors to Sentry
export const apiResultHandler = new ResultHandler({
  positive: (data) => ({
    schema: z.object({ data }),
    mimeType: "application/json",
  }),
  negative: z.object({ error: z.string(), code: apiErrorCodeSchema.optional() }),
  handler: ({ error, input, output, request, response, logger }) => {
    if (error) {
      const code = error instanceof CodedError ? error.code : undefined;
      const httpError = code ? createHttpError(statusByErrorCode[code], error.message) : ensureHttpError(error);
      if (!httpError.expose) {
        logger.error("Server side error", { error, url: request.url, input });
      } else {
        logger.debug("Client side error", { error, url: request.url, input });
      }
      if (httpError.statusCode >= 500) {
        captureException(error, {
          extra: {
            input,
            request: {
              method: request.method,
              path: request.path,
              query: request.query,
              body: request.body,
            },
          },
        });
      }
      // coded errors carry a client-safe message, so it is not replaced by the generic status text
      const message = code ? httpError.message : getPublicErrorMessage(httpError);
      return void response.status(httpError.statusCode).json({ error: message, code });
    }
    response.status(200).json({ data: output });
  },
});

const statusByErrorCode: Record<ApiErrorCode, number> = {
  invalid_geometry: 400,
  sowing_unit_mismatch: 400,
  seed_not_found: 400,
  sowing_crop_mismatch: 400,
  sowing_crop_required: 400,
  crop_not_found: 400,
  plot_not_found: 400,
  seed_default_amount_without_unit: 400,
};

const getPublicErrorMessage = (error: HttpError): string =>
  process.env.NODE_ENV === "production" && !error.expose
    ? createHttpError(error.statusCode).message // default message for that code
    : error.message;
