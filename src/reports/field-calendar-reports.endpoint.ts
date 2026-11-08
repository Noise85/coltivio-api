import { z } from "zod";
import { permissionFarmEndpoint } from "../endpoint-factory";
import { ez } from "express-zod-api";

// Gated by plots read as the minimum — the report aggregates crop_rotations, tillages,
// fertilization, crop_protection, and harvests, but requires at least field-level access.
const plotsRead = permissionFarmEndpoint("field_calendar", "read");

const fieldCalendarReportInput = z.object({
  fromDate: ez.dateIn(),
  toDate: ez.dateIn(),
  generateCropRotations: z.boolean(),
  generateTillages: z.boolean(),
  generateFertilizerApplications: z.boolean(),
  generateCropProtectionApplications: z.boolean(),
  generateHarvests: z.boolean(),
});

export const sendFieldCalendarReport = plotsRead.build({
  method: "post",
  input: fieldCalendarReportInput,
  output: z.object({}),
  handler: async ({ input, ctx }) => {
    await ctx.fieldCalendarReports.generateReport(
      ctx.user.id,
      input.fromDate,
      input.toDate,
      input.generateCropRotations,
      input.generateTillages,
      input.generateFertilizerApplications,
      input.generateCropProtectionApplications,
      input.generateHarvests
    );
    return {};
  },
});

export const downloadFieldCalendarReport = plotsRead.build({
  method: "post",
  input: fieldCalendarReportInput,
  output: z.object({
    base64: z.string(),
    fileName: z.string(),
  }),
  handler: async ({ input, ctx }) => {
    const { buffer, fileName } = await ctx.fieldCalendarReports.generateReportBuffer(
      input.fromDate,
      input.toDate,
      input.generateCropRotations,
      input.generateTillages,
      input.generateFertilizerApplications,
      input.generateCropProtectionApplications,
      input.generateHarvests
    );
    return { base64: buffer.toString("base64"), fileName };
  },
});
