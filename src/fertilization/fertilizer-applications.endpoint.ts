import { ez } from "express-zod-api";
import createHttpError from "http-errors";
import { z } from "zod";
import { ensureDateRange } from "../date-utils";
import {
  fertilizationMethodSchema,
  fertilizerApplicationUnitSchema,
  fertilizerUnitSchema,
  multiPolygonSchema,
} from "../db/schema";
import { permissionFarmEndpoint } from "../endpoint-factory";

const fertilizationRead = permissionFarmEndpoint("field_calendar", "read");
const fertilizationWrite = permissionFarmEndpoint("field_calendar", "write");
import { fertilizerSchema } from "./fertilizers.endpoint";

const plotMinimalSchema = z.object({
  id: z.string(),
  name: z.string(),
});

export const fertilizerApplicationSchema = z.object({
  id: z.string(),
  farmId: z.string(),
  createdAt: ez.dateOut(),
  createdBy: z.string().nullable(),
  plotId: z.string(),
  date: ez.dateOut(),
  unit: fertilizerApplicationUnitSchema,
  method: fertilizationMethodSchema.nullable(),
  amountPerUnit: z.number(),
  numberOfUnits: z.number(),
  fertilizerId: z.string(),
  geometry: multiPolygonSchema,
  size: z.number(),
  additionalNotes: z.string().nullable(),
  plot: plotMinimalSchema,
  fertilizer: fertilizerSchema,
});

const fertilizerApplicationResponseSchema = fertilizerApplicationSchema;

export const getFertilizerApplicationsForFarmEndpoint = fertilizationRead.build({
  method: "get",
  input: z.object({
    fromDate: ez.dateIn().optional(),
    toDate: ez.dateIn().optional(),
  }),
  output: z.object({
    result: z.array(fertilizerApplicationResponseSchema),
    count: z.number(),
  }),
  handler: async ({ input, ctx: { fertilizerApplications, farmId } }) => {
    const { from, to } = ensureDateRange(input.fromDate, input.toDate);
    const result = await fertilizerApplications.getFertilizerApplicationsForFarm(farmId, from, to);

    return {
      result,
      count: result.length,
    };
  },
});

export const getFertilizerApplicationsForPlotEndpoint = fertilizationRead.build({
  method: "get",
  input: z.object({ plotId: z.string() }),
  output: z.object({
    result: fertilizerApplicationResponseSchema.omit({ plot: true }).array(),
    count: z.number(),
  }),
  handler: async ({ input, ctx: { fertilizerApplications } }) => {
    const result = await fertilizerApplications.getFertilizerApplicationsForPlot(input.plotId);

    return {
      result,
      count: result.length,
    };
  },
});

export const getFertilizerApplicationByIdEndpoint = fertilizationRead.build({
  method: "get",
  input: z.object({ fertilizerApplicationId: z.string() }),
  output: fertilizerApplicationResponseSchema,
  handler: async ({ input, ctx: { fertilizerApplications } }) => {
    const fertilizerApplication = await fertilizerApplications.getFertilizerApplicationById(
      input.fertilizerApplicationId
    );
    if (!fertilizerApplication) {
      throw createHttpError(404, "Fertilizer Application not found");
    }
    return fertilizerApplication;
  },
});

export const createFertilizerApplicationsEndpoint = fertilizationWrite.build({
  method: "post",
  input: z.object({
    date: ez.dateIn(),
    unit: fertilizerApplicationUnitSchema,
    method: fertilizationMethodSchema.optional(),
    amountPerUnit: z.number(),
    fertilizerId: z.string(),
    additionalNotes: z.string().optional(),
    plots: z
      .object({
        plotId: z.string(),
        numberOfUnits: z.number(),
        geometry: multiPolygonSchema,
        size: z.number(),
      })
      .array(),
  }),
  output: z.object({
    result: fertilizerApplicationResponseSchema.array(),
    count: z.number(),
  }),
  handler: async ({ input, ctx: { user, fertilizerApplications } }) => {
    const result = await fertilizerApplications.createFertilizerApplications({
      ...input,
      createdBy: user.id,
    });
    return {
      result,
      count: result.length,
    };
  },
});

export const updateFertilizerApplicationEndpoint = fertilizationWrite.build({
  method: "patch",
  // plot, geometry and size can't be changed after creation
  input: z.object({
    fertilizerApplicationId: z.string(),
    date: ez.dateIn().optional(),
    unit: fertilizerApplicationUnitSchema.optional(),
    method: fertilizationMethodSchema.optional().nullable(),
    amountPerUnit: z.number().optional(),
    numberOfUnits: z.number().optional(),
    fertilizerId: z.string().optional(),
    additionalNotes: z.string().optional().nullable(),
  }),
  output: fertilizerApplicationResponseSchema,
  handler: async ({ input: { fertilizerApplicationId, ...data }, ctx: { fertilizerApplications } }) => {
    const fertilizerApplication = await fertilizerApplications.updateFertilizerApplication(
      fertilizerApplicationId,
      data
    );
    if (!fertilizerApplication) {
      throw createHttpError(404, "Fertilizer Application not found");
    }
    return fertilizerApplication;
  },
});

export const deleteFertilizerApplicationEndpoint = fertilizationWrite.build({
  method: "delete",
  input: z.object({ fertilizerApplicationId: z.string() }),
  output: z.object({}),
  handler: async ({ input, ctx: { fertilizerApplications } }) => {
    await fertilizerApplications.deleteFertilizerApplication(input.fertilizerApplicationId);
    return {};
  },
});

export const getFertilizerApplicationYearsEndpoint = fertilizationRead.build({
  method: "get",
  input: z.object({}),
  output: z.object({
    result: z.array(z.string()),
    count: z.number(),
  }),
  handler: async ({ ctx: { fertilizerApplications } }) => {
    const result = await fertilizerApplications.getFertilizerApplicationYears();
    return {
      result,
      count: result.length,
    };
  },
});
const fertilizerApplicationSummaryResponseSchema = z.object({
  monthlyApplications: z.array(
    z.object({
      year: z.number(),
      month: z.number(),
      appliedFertilizers: z.array(
        z.object({
          totalAmount: z.number(),
          totalProducedUnits: z.number(),
          fertilizerName: z.string(),
          unit: fertilizerUnitSchema,
        })
      ),
    })
  ),
});

export const getFertilizerApplicationSummaryForFarmEndpoint = fertilizationRead.build({
  method: "get",
  input: z.object({}),
  output: fertilizerApplicationSummaryResponseSchema,
  handler: async ({ ctx: { fertilizerApplications, farmId } }) => {
    return fertilizerApplications.getFertilizerApplicationSummaryForFarm(farmId);
  },
});

export const getFertilizerApplicationSummaryForPlotEndpoint = fertilizationRead.build({
  method: "get",
  input: z.object({ plotId: z.string() }),
  output: fertilizerApplicationSummaryResponseSchema,
  handler: async ({ input, ctx: { fertilizerApplications } }) => {
    return fertilizerApplications.getFertilizerApplicationSummaryForPlot(input.plotId);
  },
});

const fertilizerApplicationPresetSchema = z.object({
  id: z.string(),
  farmId: z.string(),
  name: z.string(),
  fertilizerId: z.string(),
  unit: fertilizerApplicationUnitSchema,
  method: fertilizationMethodSchema.nullable(),
  amountPerUnit: z.number(),
  fertilizer: fertilizerSchema,
});

export const getFertilizerApplicationPresetsEndpoint = fertilizationRead.build({
  method: "get",
  input: z.object({}),
  output: z.object({
    result: z.array(fertilizerApplicationPresetSchema),
    count: z.number(),
  }),
  handler: async ({ ctx: { fertilizerApplications } }) => {
    const result = await fertilizerApplications.getFertilizerApplicationPresets();
    return { result, count: result.length };
  },
});

export const getFertilizerApplicationPresetByIdEndpoint = fertilizationRead.build({
  method: "get",
  input: z.object({ presetId: z.string() }),
  output: fertilizerApplicationPresetSchema,
  handler: async ({ input, ctx: { fertilizerApplications } }) => {
    const preset = await fertilizerApplications.getFertilizerApplicationPresetById(input.presetId);
    if (!preset) {
      throw createHttpError(404, "Fertilizer application preset not found");
    }
    return preset;
  },
});

export const createFertilizerApplicationPresetEndpoint = fertilizationWrite.build({
  method: "post",
  input: z.object({
    name: z.string(),
    fertilizerId: z.string(),
    unit: fertilizerApplicationUnitSchema,
    method: fertilizationMethodSchema.optional(),
    amountPerUnit: z.number(),
  }),
  output: fertilizerApplicationPresetSchema,
  handler: async ({ input, ctx: { fertilizerApplications } }) => {
    return fertilizerApplications.createFertilizerApplicationPreset(input);
  },
});

export const updateFertilizerApplicationPresetEndpoint = fertilizationWrite.build({
  method: "patch",
  input: z.object({
    presetId: z.string(),
    name: z.string().optional(),
    fertilizerId: z.string().optional(),
    unit: fertilizerApplicationUnitSchema.optional(),
    method: fertilizationMethodSchema.optional().nullable(),
    amountPerUnit: z.number().optional(),
  }),
  output: fertilizerApplicationPresetSchema,
  handler: async ({ input: { presetId, ...data }, ctx: { fertilizerApplications } }) => {
    return fertilizerApplications.updateFertilizerApplicationPreset(presetId, data);
  },
});

export const deleteFertilizerApplicationPresetEndpoint = fertilizationWrite.build({
  method: "delete",
  input: z.object({ presetId: z.string() }),
  output: z.object({}),
  handler: async ({ input: { presetId }, ctx: { fertilizerApplications } }) => {
    await fertilizerApplications.deleteFertilizerApplicationPreset(presetId);
    return {};
  },
});
