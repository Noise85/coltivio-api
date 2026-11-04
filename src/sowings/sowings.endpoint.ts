import { ez } from "express-zod-api";
import createHttpError from "http-errors";
import { z } from "zod";
import { cropSchema } from "../crops/crops.endpoint";
import { ensureDateRange } from "../date-utils";
import { multiPolygonSchema, seedQuantityKindSchema, sowingUnitSchema } from "../db/schema";
import { permissionFarmEndpoint } from "../endpoint-factory";
import { seedSchema } from "../seeds/seeds.endpoint";
import { sowingUnits } from "./sowing-units";

const sowingsRead = permissionFarmEndpoint("field_calendar", "read");
const sowingsWrite = permissionFarmEndpoint("field_calendar", "write");

const plotMinimalSchema = z.object({
  id: z.string(),
  name: z.string(),
});

const sowingSeedSchema = seedSchema.omit({ crop: true });

export const sowingSchema = z.object({
  id: z.string(),
  farmId: z.string(),
  createdAt: ez.dateOut(),
  createdBy: z.string().nullable(),
  plotId: z.string(),
  date: ez.dateOut(),
  cropId: z.string(),
  crop: cropSchema.omit({ family: true }),
  seedId: z.string().nullable(),
  seed: sowingSeedSchema.nullable(),
  unit: sowingUnitSchema,
  amount: z.number(),
  // grams for weight, pieces for count
  totalBaseAmount: z.number(),
  baseAmountPerHectare: z.number(),
  geometry: multiPolygonSchema,
  size: z.number(),
  additionalNotes: z.string().nullable(),
  plot: plotMinimalSchema,
});

export const getSowingUnitsEndpoint = sowingsRead.build({
  method: "get",
  input: z.object({}),
  output: z.object({
    result: z.array(
      z.object({
        unit: sowingUnitSchema,
        quantityKind: seedQuantityKindSchema,
        perArea: z.boolean(),
      })
    ),
    count: z.number(),
  }),
  handler: async () => {
    const result = sowingUnitSchema.options.map((unit) => ({
      unit,
      quantityKind: sowingUnits[unit].quantityKind,
      perArea: sowingUnits[unit].perArea,
    }));
    return { result, count: result.length };
  },
});

export const getSowingsForFarmEndpoint = sowingsRead.build({
  method: "get",
  input: z.object({
    fromDate: ez.dateIn().optional(),
    toDate: ez.dateIn().optional(),
  }),
  output: z.object({
    result: z.array(sowingSchema),
    count: z.number(),
  }),
  handler: async ({ input, ctx: { sowings, farmId } }) => {
    const { from, to } = ensureDateRange(input.fromDate, input.toDate);
    const result = await sowings.getSowingsForFarm(farmId, from, to);
    return { result, count: result.length };
  },
});

export const getSowingsForPlotEndpoint = sowingsRead.build({
  method: "get",
  input: z.object({ plotId: z.string() }),
  output: z.object({
    result: sowingSchema.omit({ plot: true }).array(),
    count: z.number(),
  }),
  handler: async ({ input, ctx: { sowings } }) => {
    const result = await sowings.getSowingsForPlot(input.plotId);
    return { result, count: result.length };
  },
});

export const getSowingByIdEndpoint = sowingsRead.build({
  method: "get",
  input: z.object({ sowingId: z.string() }),
  output: sowingSchema,
  handler: async ({ input, ctx: { sowings } }) => {
    const sowing = await sowings.getSowingById(input.sowingId);
    if (!sowing) {
      throw createHttpError(404, "Sowing not found");
    }
    return sowing;
  },
});

export const createSowingsEndpoint = sowingsWrite.build({
  method: "post",
  input: z.object({
    date: ez.dateIn(),
    // required without a seed, otherwise taken from the seed
    cropId: z.string().optional(),
    seedId: z.string().optional(),
    unit: sowingUnitSchema,
    additionalNotes: z.string().optional(),
    plots: z
      .object({
        plotId: z.string(),
        // per-area units: rate for this plot; total units: amount sown on this plot
        amount: z.number().nonnegative(),
        geometry: multiPolygonSchema,
        size: z.number(),
      })
      .array()
      .min(1),
  }),
  output: z.object({
    result: sowingSchema.array(),
    count: z.number(),
  }),
  handler: async ({ input, ctx: { user, sowings } }) => {
    const result = await sowings.createSowings({ ...input, createdBy: user.id });
    return { result, count: result.length };
  },
});

export const updateSowingEndpoint = sowingsWrite.build({
  method: "patch",
  // plot, geometry and size can't be changed after creation
  input: z.object({
    sowingId: z.string(),
    date: ez.dateIn().optional(),
    cropId: z.string().optional(),
    seedId: z.string().optional().nullable(),
    unit: sowingUnitSchema.optional(),
    amount: z.number().nonnegative().optional(),
    additionalNotes: z.string().optional().nullable(),
  }),
  output: sowingSchema,
  handler: async ({ input: { sowingId, ...data }, ctx: { sowings } }) => {
    const sowing = await sowings.updateSowing(sowingId, data);
    if (!sowing) {
      throw createHttpError(404, "Sowing not found");
    }
    return sowing;
  },
});

export const deleteSowingEndpoint = sowingsWrite.build({
  method: "delete",
  input: z.object({ sowingId: z.string() }),
  output: z.object({}),
  handler: async ({ input, ctx: { sowings } }) => {
    await sowings.deleteSowing(input.sowingId);
    return {};
  },
});

export const getSowingYearsEndpoint = sowingsRead.build({
  method: "get",
  input: z.object({}),
  output: z.object({
    result: z.array(z.string()),
    count: z.number(),
  }),
  handler: async ({ ctx: { sowings } }) => {
    const result = await sowings.getSowingYears();
    return { result, count: result.length };
  },
});

const sowingSummaryResponseSchema = z.object({
  monthlySowings: z.array(
    z.object({
      year: z.number(),
      month: z.number(),
      sownSeeds: z.array(
        z.object({
          cropId: z.string(),
          cropName: z.string(),
          seedId: z.string().nullable(),
          seedName: z.string().nullable(),
          quantityKind: seedQuantityKindSchema,
          totalBaseAmount: z.number(),
          totalSize: z.number(),
        })
      ),
    })
  ),
});

export const getSowingSummaryForFarmEndpoint = sowingsRead.build({
  method: "get",
  input: z.object({}),
  output: sowingSummaryResponseSchema,
  handler: async ({ ctx: { sowings, farmId } }) => {
    return sowings.getSowingSummaryForFarm(farmId);
  },
});

export const getSowingSummaryForPlotEndpoint = sowingsRead.build({
  method: "get",
  input: z.object({ plotId: z.string() }),
  output: sowingSummaryResponseSchema,
  handler: async ({ input, ctx: { sowings } }) => {
    return sowings.getSowingSummaryForPlot(input.plotId);
  },
});

const sowingPresetSchema = z.object({
  id: z.string(),
  farmId: z.string(),
  name: z.string(),
  cropId: z.string(),
  crop: cropSchema.omit({ family: true }),
  seedId: z.string().nullable(),
  seed: sowingSeedSchema.nullable(),
  unit: sowingUnitSchema,
  amount: z.number(),
});

export const getSowingPresetsEndpoint = sowingsRead.build({
  method: "get",
  input: z.object({}),
  output: z.object({
    result: z.array(sowingPresetSchema),
    count: z.number(),
  }),
  handler: async ({ ctx: { sowings } }) => {
    const result = await sowings.getSowingPresets();
    return { result, count: result.length };
  },
});

export const getSowingPresetByIdEndpoint = sowingsRead.build({
  method: "get",
  input: z.object({ presetId: z.string() }),
  output: sowingPresetSchema,
  handler: async ({ input, ctx: { sowings } }) => {
    const preset = await sowings.getSowingPresetById(input.presetId);
    if (!preset) {
      throw createHttpError(404, "Sowing preset not found");
    }
    return preset;
  },
});

export const createSowingPresetEndpoint = sowingsWrite.build({
  method: "post",
  input: z.object({
    name: z.string(),
    // required without a seed, otherwise taken from the seed
    cropId: z.string().optional(),
    seedId: z.string().optional(),
    unit: sowingUnitSchema,
    amount: z.number().nonnegative(),
  }),
  output: sowingPresetSchema,
  handler: async ({ input, ctx: { sowings } }) => {
    return sowings.createSowingPreset(input);
  },
});

export const updateSowingPresetEndpoint = sowingsWrite.build({
  method: "patch",
  input: z.object({
    presetId: z.string(),
    name: z.string().optional(),
    cropId: z.string().optional(),
    seedId: z.string().optional().nullable(),
    unit: sowingUnitSchema.optional(),
    amount: z.number().nonnegative().optional(),
  }),
  output: sowingPresetSchema,
  handler: async ({ input: { presetId, ...data }, ctx: { sowings } }) => {
    const preset = await sowings.updateSowingPreset(presetId, data);
    if (!preset) {
      throw createHttpError(404, "Sowing preset not found");
    }
    return preset;
  },
});

export const deleteSowingPresetEndpoint = sowingsWrite.build({
  method: "delete",
  input: z.object({ presetId: z.string() }),
  output: z.object({}),
  handler: async ({ input: { presetId }, ctx: { sowings } }) => {
    await sowings.deleteSowingPreset(presetId);
    return {};
  },
});
