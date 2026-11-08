import createHttpError from "http-errors";
import { ez } from "express-zod-api";
import { z } from "zod";
import { multiPolygonSchema } from "../db/schema";
import { cropRotationSchema } from "../crop-rotations/crop-rotations.endpoint";
import { permissionFarmEndpoint } from "../endpoint-factory";

const plotsRead = permissionFarmEndpoint("field_calendar", "read");
const plotsWrite = permissionFarmEndpoint("field_calendar", "write");

export const plotSchema = z.object({
  id: z.string(),
  farmId: z.string(),
  name: z.string(),
  localId: z.string().nullable(),
  usage: z.number().nullable(),
  cuttingDate: ez.dateOut().nullable(),
  geometry: multiPolygonSchema,
  size: z.number(),
  additionalNotes: z.string().nullable(),
  archivedAt: ez.dateOut().nullable(),
  currentCropRotation: cropRotationSchema.nullable(),
});

const createPlotSchema = z.object({
  name: z.string(),
  localId: z.string().optional(),
  usage: z.number().optional(),
  additionalUsages: z.string().optional(),
  cuttingDate: ez.dateIn().nullable().optional(),
  geometry: multiPolygonSchema,
  size: z.number(),
  additionalNotes: z.string().optional(),
});

const updatePlotSchema = z.object({
  name: z.string().optional(),
  localId: z.string().optional(),
  usage: z.number().optional(),
  additionalUsages: z.string().optional(),
  cuttingDate: ez.dateIn().nullable().optional(),
  geometry: multiPolygonSchema.optional(),
  size: z.number().optional(),
  additionalNotes: z.string().optional(),
  archived: z.boolean().optional(),
});

export const getPlotByIdEndpoint = plotsRead.build({
  method: "get",
  input: z.object({ plotId: z.string() }),
  output: plotSchema,
  handler: async ({ input, ctx: { plots } }) => {
    const plot = await plots.getPlotById(input.plotId);
    if (!plot) {
      throw createHttpError(404, "Plot not found");
    }
    return plot;
  },
});

export const getFarmPlotsEndpoint = plotsRead.build({
  method: "get",
  input: z.object({
    includeArchived: z
      .enum(["true", "false"])
      .optional()
      .transform((value) => value === "true"),
  }),
  output: z.object({
    result: z.array(plotSchema),
    count: z.number(),
  }),
  handler: async ({ input, ctx: { plots, farmId } }) => {
    const result = await plots.getPlotsForFarm(farmId, input.includeArchived);
    return {
      result,
      count: result.length,
    };
  },
});

export const createPlotEndpoint = plotsWrite.build({
  method: "post",
  input: createPlotSchema,
  output: plotSchema,
  handler: async ({ input, ctx: { plots } }) => {
    return plots.createPlot(input);
  },
});

const shapefileImportPreviewRowSchema = z.object({
  rowNumber: z.number(),
  externalId: z.string().nullable(),
  name: z.string(),
  localId: z.string().nullable(),
  usage: z.number().nullable(),
  usageName: z.string().nullable(),
  size: z.number(),
  cuttingDate: ez.dateOut().nullable(),
  municipality: z.string().nullable(),
  geometry: multiPolygonSchema.nullable(),
  overlappingPlotIds: z.array(z.string()),
  // code is translated by the client, value is the offending attribute if any
  parseErrors: z.array(z.object({ code: z.string(), value: z.string().optional() })),
});

const shapefileImportOverlaySchema = z.object({
  externalId: z.string(),
  name: z.string(),
  localId: z.string().nullable(),
  usage: z.number(),
  usageName: z.string().nullable(),
  size: z.number(),
  // own instance: the OpenAPI generator would otherwise reuse the nullable variant from the row schema above
  geometry: z.object(multiPolygonSchema.shape),
});

export const previewPlotShapefileImportEndpoint = plotsWrite.build({
  method: "post",
  input: z.object({ file: ez.upload() }),
  output: z.object({
    format: z.object({ name: z.string(), label: z.string(), geometryOnly: z.boolean() }),
    // full: all attributes read from the file, partial: some rows use defaults (name or usage),
    // geometries_only: attributes not recognised, all rows use defaults
    completeness: z.enum(["full", "partial", "geometries_only"]),
    rows: z.array(shapefileImportPreviewRowSchema),
    // overlay elements (trees, Ackerschonstreifen) that are stored apart from the plots
    overlays: z.array(shapefileImportOverlaySchema.extend({ rowNumber: z.number(), alreadyPresent: z.boolean() })),
  }),
  handler: async ({ input, ctx: { plots } }) => {
    return plots.previewShapefileImport(input.file.data);
  },
});

export const commitPlotShapefileImportEndpoint = plotsWrite.build({
  method: "post",
  input: z
    .object({
      // format name from the preview, stored as the source of the overlays
      format: z.string(),
      rows: z.array(createPlotSchema),
      overlays: z.array(shapefileImportOverlaySchema).default([]),
    })
    .refine((body) => body.rows.length + body.overlays.length > 0, { message: "nothing to import" }),
  output: z.object({ created: z.number(), overlaysCreated: z.number(), overlaysSkipped: z.number() }),
  handler: async ({ input, ctx: { plots, farmId } }) => {
    return plots.commitShapefileImport(
      farmId,
      input.format,
      input.rows.map((row) => ({
        name: row.name,
        localId: row.localId ?? null,
        usage: row.usage ?? null,
        cuttingDate: row.cuttingDate ?? null,
        size: row.size,
        geometry: row.geometry,
      })),
      input.overlays
    );
  },
});

export const updatePlotEndpoint = plotsWrite.build({
  method: "patch",
  input: updatePlotSchema.extend({
    plotId: z.string(),
  }),
  output: plotSchema,
  handler: async ({ input, ctx: { plots } }) => {
    return plots.updatePlot(input.plotId, input);
  },
});

export const deletePlotEndpoint = plotsWrite.build({
  method: "delete",
  input: z.object({ plotId: z.string() }),
  output: z.object({}),
  handler: async ({ input: { plotId }, ctx: { plots: plot } }) => {
    await plot.deletePlot(plotId);
    return {};
  },
});

const subPlotSchema = z.object({
  geometry: multiPolygonSchema,
  name: z.string(),
  size: z.number(),
});

const splitPlotInputSchema = z.discriminatedUnion("strategy", [
  z.object({
    plotId: z.string(),
    strategy: z.literal("keep_reference"),
    originalPlotName: z.string().optional(),
    // archive the kept original plot, which has no area left
    archiveReference: z.boolean().optional(),
    subPlots: z.array(subPlotSchema).min(1),
  }),
  z.object({
    plotId: z.string(),
    strategy: z.literal("delete_and_migrate"),
    migrateToIndex: z.number().int().min(0),
    subPlots: z.array(subPlotSchema).min(1),
  }),
]);

export const splitPlotEndpoint = plotsWrite.build({
  method: "post",
  input: splitPlotInputSchema,
  output: z.object({ result: z.array(plotSchema) }),
  handler: async ({ input, ctx: { plots } }) => {
    const { plotId, subPlots, ...strategyOptions } = input;
    const result = await plots.splitPlot(plotId, subPlots, strategyOptions);
    return { result };
  },
});

const mergePlotsInputSchema = z.discriminatedUnion("strategy", [
  z.object({
    strategy: z.literal("keep_reference"),
    // archive the kept source plots, which have no area left
    archiveReference: z.boolean().optional(),
    plotIds: z.array(z.string()).min(2),
    name: z.string(),
    localId: z.string().optional(),
    usage: z.number().optional(),
    additionalUsages: z.string().optional(),
    cuttingDate: ez.dateIn().nullable().optional(),
    additionalNotes: z.string().optional(),
  }),
  z.object({
    strategy: z.literal("delete_and_migrate"),
    plotIds: z.array(z.string()).min(2),
    name: z.string(),
    localId: z.string().optional(),
    usage: z.number().optional(),
    additionalUsages: z.string().optional(),
    cuttingDate: ez.dateIn().nullable().optional(),
    additionalNotes: z.string().optional(),
  }),
]);

export const mergePlotsEndpoint = plotsWrite.build({
  method: "post",
  input: mergePlotsInputSchema,
  output: plotSchema,
  handler: async ({ input, ctx: { plots } }) => {
    if (input.strategy === "keep_reference") {
      const { strategy, plotIds, archiveReference, ...plotData } = input;
      return plots.mergePlots(plotIds, plotData, { strategy, archiveReference });
    }
    const { strategy, plotIds, ...plotData } = input;
    return plots.mergePlots(plotIds, plotData, { strategy });
  },
});

export const syncMissingLocalIdsEndpoint = plotsWrite.build({
  method: "post",
  input: z.object({}),
  output: z.object({}),
  handler: async ({ ctx: { plots } }) => {
    await plots.syncMissingLocalIds();
    return {};
  },
});
