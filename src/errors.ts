import { z } from "zod";

// Machine-readable error codes returned as `code` next to `error`, so clients can show a translated message.
export const apiErrorCodeSchema = z.enum([
  // the geometry has no area left after repairing it (e.g. fewer than 3 distinct points)
  "invalid_geometry",
  // the sowing unit doesn't match the seed's quantity kind (weight vs. count)
  "sowing_unit_mismatch",
  // the referenced seed doesn't exist (or belongs to another farm)
  "seed_not_found",
  // a crop was given that differs from the crop of the seed
  "sowing_crop_mismatch",
  // a sowing or sowing preset without a seed needs a crop
  "sowing_crop_required",
  // the referenced crop or plot doesn't exist (or belongs to another farm)
  "crop_not_found",
  "plot_not_found",
  // a seed's default amount only means something together with a default unit
  "seed_default_amount_without_unit",
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
