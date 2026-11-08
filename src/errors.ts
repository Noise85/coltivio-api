import { z } from "zod";

// Machine-readable error codes returned as `code` next to `error`, so clients can show a translated message.
export const apiErrorCodeSchema = z.enum([
  // the geometry has no area left after repairing it (e.g. fewer than 3 distinct points)
  "invalid_geometry",
]);
export type ApiErrorCode = z.infer<typeof apiErrorCodeSchema>;

// Thrown by the domain layer. The result handler maps the code to an HTTP status and returns it to the client.
export class CodedError extends Error {
  readonly code: ApiErrorCode;

  constructor(code: ApiErrorCode, message: string) {
    super(message);
    this.name = "CodedError";
    this.code = code;
  }
}
