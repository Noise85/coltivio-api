import { ez } from "express-zod-api";
import createHttpError from "http-errors";
import { z } from "zod";
import { ensureDateRange } from "../date-utils";
import { multiPolygonSchema, tillageActionSchema } from "../db/schema";
import { permissionFarmEndpoint } from "../endpoint-factory";

const tillagesRead = permissionFarmEndpoint("field_calendar", "read");
const tillagesWrite = permissionFarmEndpoint("field_calendar", "write");

const plotMinimalSchema = z.object({
  id: z.string(),
  name: z.string(),
});

export const tillageSchema = z.object({
  id: z.string(),
  farmId: z.string(),
  createdAt: ez.dateOut(),
  createdBy: z.string().nullable(),
  plotId: z.string(),
  geometry: multiPolygonSchema,
  size: z.number(),
  action: tillageActionSchema,
  customAction: z.string().nullable(),
  date: ez.dateOut(),
  additionalNotes: z.string().nullable(),
  plot: plotMinimalSchema,
});

const tillagesResponseSchema = tillageSchema;

const tillageCreateSchema = z.object({
  plotId: z.string(),
  geometry: multiPolygonSchema,
  size: z.number(),
  action: tillageActionSchema,
  customAction: z.string().optional(),
  date: ez.dateIn(),
  additionalNotes: z.string().optional(),
});

export const getTillageByIdEndpoint = tillagesRead.build({
  method: "get",
  input: z.object({ tillageId: z.string() }),
  output: tillagesResponseSchema,
  handler: async ({ input, ctx: { tillages } }) => {
    const tillage = await tillages.getTillageById(input.tillageId);
    if (!tillage) {
      throw createHttpError(404, "Tillage not found");
    }
    return tillage;
  },
});
export const getPlotTillagesEndpoint = tillagesRead.build({
  method: "get",
  input: z.object({
    plotId: z.string(),
  }),
  output: z.object({
    result: z.array(tillagesResponseSchema),
    count: z.number(),
  }),
  handler: async ({ input, ctx: { tillages } }) => {
    const result = await tillages.getTillagesForPlot(input.plotId);
    return {
      result,
      count: result.length,
    };
  },
});

export const getFarmTillagesEndpoint = tillagesRead.build({
  method: "get",
  input: z.object({
    fromDate: ez.dateIn().optional(),
    toDate: ez.dateIn().optional(),
  }),
  output: z.object({
    result: z.array(tillagesResponseSchema),
    count: z.number(),
  }),
  handler: async ({ input, ctx: { tillages, farmId } }) => {
    const { from, to } = ensureDateRange(input.fromDate, input.toDate);
    const result = await tillages.getTillagesForFarm(farmId, from, to);
    return {
      result,
      count: result.length,
    };
  },
});

export const createTillageEndpoint = tillagesWrite.build({
  method: "post",
  input: tillageCreateSchema,
  output: tillagesResponseSchema,
  handler: async ({ input, ctx: { tillages, user } }) => {
    return tillages.createTillage({ ...input, createdBy: user.id });
  },
});

export const createTillagesEndpoint = tillagesWrite.build({
  method: "post",
  input: z.object({
    action: tillageActionSchema,
    customAction: z.string().optional(),
    date: ez.dateIn(),
    additionalNotes: z.string().optional(),
    plots: z
      .object({
        plotId: z.string(),
        geometry: multiPolygonSchema,
        size: z.number(),
      })
      .array(),
  }),
  output: z.object({
    result: z.array(tillagesResponseSchema),
    count: z.number(),
  }),
  handler: async ({ input, ctx: { tillages, user } }) => {
    const result = await tillages.createTillages({
      ...input,
      createdBy: user.id,
    });
    return {
      result,
      count: result.length,
    };
  },
});

export const updateTillageEndpoint = tillagesWrite.build({
  method: "patch",
  // plot, geometry and size can't be changed after creation
  input: tillageCreateSchema.omit({ plotId: true, geometry: true, size: true }).partial().extend({
    tillageId: z.string(),
    customAction: z.string().optional().nullable(),
    additionalNotes: z.string().optional().nullable(),
  }),
  output: tillagesResponseSchema,
  handler: async ({ input: { tillageId, ...data }, ctx: { tillages } }) => {
    const tillage = await tillages.updateTillage(tillageId, data);
    if (!tillage) {
      throw createHttpError(404, "Tillage not found");
    }
    return tillage;
  },
});

export const deleteTillageEndpoint = tillagesWrite.build({
  method: "delete",
  input: z.object({ tillageId: z.string() }),
  output: z.object({}),
  handler: async ({ input: { tillageId }, ctx: { tillages: tillage } }) => {
    await tillage.deleteTillage(tillageId);
    return {};
  },
});

export const getTillagesYearsEndpoint = tillagesRead.build({
  method: "get",
  input: z.object({}),
  output: z.object({
    result: z.array(z.string()),
    count: z.number(),
  }),
  handler: async ({ ctx: { tillages } }) => {
    const result = await tillages.getTillagesYears();
    return {
      result,
      count: result.length,
    };
  },
});

const tillagePresetSchema = z.object({
  id: z.string(),
  farmId: z.string(),
  name: z.string(),
  action: tillageActionSchema,
  customAction: z.string().nullable(),
});

export const getTillagePresetsEndpoint = tillagesRead.build({
  method: "get",
  input: z.object({}),
  output: z.object({
    result: z.array(tillagePresetSchema),
    count: z.number(),
  }),
  handler: async ({ ctx: { tillages } }) => {
    const result = await tillages.getTillagePresets();
    return { result, count: result.length };
  },
});

export const getTillagePresetByIdEndpoint = tillagesRead.build({
  method: "get",
  input: z.object({ presetId: z.string() }),
  output: tillagePresetSchema,
  handler: async ({ input, ctx: { tillages } }) => {
    const preset = await tillages.getTillagePresetById(input.presetId);
    if (!preset) {
      throw createHttpError(404, "Tillage preset not found");
    }
    return preset;
  },
});

export const createTillagePresetEndpoint = tillagesWrite.build({
  method: "post",
  input: z.object({
    name: z.string(),
    action: tillageActionSchema,
    customAction: z.string().optional(),
  }),
  output: tillagePresetSchema,
  handler: async ({ input, ctx: { tillages } }) => {
    return tillages.createTillagePreset(input);
  },
});

export const updateTillagePresetEndpoint = tillagesWrite.build({
  method: "patch",
  input: z.object({
    presetId: z.string(),
    name: z.string().optional(),
    action: tillageActionSchema.optional(),
    customAction: z.string().optional().nullable(),
  }),
  output: tillagePresetSchema,
  handler: async ({ input: { presetId, ...data }, ctx: { tillages } }) => {
    return tillages.updateTillagePreset(presetId, data);
  },
});

export const deleteTillagePresetEndpoint = tillagesWrite.build({
  method: "delete",
  input: z.object({ presetId: z.string() }),
  output: z.object({}),
  handler: async ({ input: { presetId }, ctx: { tillages } }) => {
    await tillages.deleteTillagePreset(presetId);
    return {};
  },
});
