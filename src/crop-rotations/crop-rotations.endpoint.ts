import { ez } from "express-zod-api";
import createHttpError from "http-errors";
import { z } from "zod";
import { cropSchema } from "../crops/crops.endpoint";
import { ensureDateRange } from "../date-utils";
import { permissionFarmEndpoint } from "../endpoint-factory";

const cropRotationsRead = permissionFarmEndpoint("field_calendar", "read");
const cropRotationsWrite = permissionFarmEndpoint("field_calendar", "write");

export const cropRotationSchema = z.object({
  id: z.string(),
  farmId: z.string(),
  plotId: z.string(),
  cropId: z.string(),
  sowingDate: ez.dateOut().nullable(),
  fromDate: ez.dateOut(),
  toDate: ez.dateOut(),
  crop: cropSchema,
});

const recurrenceSchema = z.object({
  interval: z.number().int().min(1).default(1),
  until: ez.dateIn().optional(),
});

const recurrenceOutSchema = z.object({
  id: z.string(),
  interval: z.number(),
  until: ez.dateOut().nullable(),
});

export const cropRotationWithRecurrenceSchema = cropRotationSchema.extend({
  recurrence: recurrenceOutSchema.nullable(),
});

const createCropRotationSchema = z.object({
  plotId: z.string(),
  cropId: z.string(),
  sowingDate: ez.dateIn().optional(),
  fromDate: ez.dateIn(),
  toDate: ez.dateIn(),
  recurrence: recurrenceSchema.optional(),
});

const updateCropRotationSchema = z.object({
  cropId: z.string().optional(),
  sowingDate: ez.dateIn().optional(),
  fromDate: ez.dateIn().optional(),
  toDate: ez.dateIn().optional(),
  recurrence: recurrenceSchema.optional().nullable(),
});

export const getCropRotationsForPlotEndpoint = cropRotationsRead.build({
  method: "get",
  input: z.object({
    plotId: z.string(),
    fromDate: ez.dateIn(),
    toDate: ez.dateIn(),
  }),
  output: z.object({
    result: z.array(cropRotationWithRecurrenceSchema),
    count: z.number(),
  }),
  handler: async ({ input, ctx: { cropRotations } }) => {
    const result = await cropRotations.getCropRotationsForPlot(input.plotId, input.fromDate, input.toDate);
    return {
      result,
      count: result.length,
    };
  },
});

const booleanQueryParam = (defaultValue: boolean) =>
  z
    .string()
    .optional()
    .transform((val) => (val === undefined ? defaultValue : val === "true"));

export const getCropRotationsForPlotsEndpoint = cropRotationsRead.build({
  method: "get",
  input: z.object({
    plotIds: z.preprocess((val) => (typeof val === "string" ? [val] : val), z.array(z.string()).min(1)),
    onlyCurrent: booleanQueryParam(true),
    expand: booleanQueryParam(true),
    withRecurrences: booleanQueryParam(false),
    fromDate: ez.dateIn(),
    toDate: ez.dateIn(),
  }),
  output: z.object({
    result: z.array(cropRotationWithRecurrenceSchema),
    count: z.number(),
  }),
  handler: async ({ input, ctx: { cropRotations } }) => {
    const result = await cropRotations.getCropRotationsForPlots(
      input.plotIds,
      input.onlyCurrent,
      input.fromDate,
      input.toDate,
      { expand: input.expand, withRecurrences: input.withRecurrences }
    );
    return {
      result,
      count: result.length,
    };
  },
});

export const getCropRotationByIdEndpoint = cropRotationsRead.build({
  method: "get",
  input: z.object({ rotationId: z.string() }),
  output: cropRotationWithRecurrenceSchema,
  handler: async ({ input: { rotationId }, ctx: { cropRotations } }) => {
    const result = await cropRotations.getCropRotationById(rotationId);
    if (!result) {
      throw createHttpError(404, "Crop rotation not found");
    }
    return result;
  },
});

export const getCropRotationsForFarmEndpoint = cropRotationsRead.build({
  method: "get",
  input: z.object({
    fromDate: ez.dateIn().optional(),
    toDate: ez.dateIn().optional(),
    expand: booleanQueryParam(true),
    withRecurrences: booleanQueryParam(false),
  }),
  output: z.object({
    result: z.array(
      cropRotationWithRecurrenceSchema.extend({
        plot: z.object({ name: z.string() }),
      })
    ),
    count: z.number(),
  }),
  handler: async ({ input, ctx: { cropRotations } }) => {
    const { from, to } = ensureDateRange(input.fromDate, input.toDate);
    const result = await cropRotations.getCropRotationsForFarm(from, to, {
      expand: input.expand,
      withRecurrences: input.withRecurrences,
    });
    return {
      result,
      count: result.length,
    };
  },
});

export const createCropRotationEndpoint = cropRotationsWrite.build({
  method: "post",
  input: createCropRotationSchema,
  output: cropRotationSchema,
  handler: async ({ input, ctx: { cropRotations } }) => {
    return cropRotations.createCropRotation(input);
  },
});

export const createCropRotationsByPlotEndpoint = cropRotationsWrite.build({
  method: "post",
  input: z.object({
    plotId: z.string(),
    crops: z.array(
      z.object({
        cropId: z.string(),
        sowingDate: ez.dateIn().optional(),
        fromDate: ez.dateIn(),
        toDate: ez.dateIn(),
        recurrence: recurrenceSchema.optional(),
      })
    ),
  }),
  output: z.object({
    result: cropRotationSchema.array(),
    count: z.number(),
  }),
  handler: async ({ input, ctx: { cropRotations } }) => {
    const result = await cropRotations.createCropRotationsByPlot(input);
    return {
      result,
      count: result.length,
    };
  },
});

export const planCropRotationsEndpoint = cropRotationsWrite.build({
  method: "patch",
  input: z.object({
    plots: z.array(
      z.object({
        plotId: z.string(),
        rotations: z.array(
          z.object({
            cropId: z.string(),
            sowingDate: ez.dateIn().optional(),
            fromDate: ez.dateIn(),
            toDate: ez.dateIn(),
            recurrence: recurrenceSchema.optional(),
          })
        ),
      })
    ),
  }),
  output: z.object({
    result: cropRotationSchema.array(),
    count: z.number(),
  }),
  handler: async ({ input, ctx: { cropRotations } }) => {
    try {
      const result = await cropRotations.planCropRotations(input);
      return { result, count: result.length };
    } catch (err) {
      if (err instanceof Error && err.message.includes("Overlapping")) {
        throw createHttpError(409, err.message);
      }
      throw err;
    }
  },
});

export const createCropRotationsByCropEndpoint = cropRotationsWrite.build({
  method: "post",
  input: z.object({
    cropId: z.string(),
    plots: z.array(createCropRotationSchema),
  }),
  output: z.object({
    result: cropRotationSchema.array(),
    count: z.number(),
  }),
  handler: async ({ input, ctx: { cropRotations } }) => {
    const result = await cropRotations.createCropRotationsByCrop(input);
    return {
      result,
      count: result.length,
    };
  },
});

export const updateCropRotationEndpoint = cropRotationsWrite.build({
  method: "patch",
  input: updateCropRotationSchema.extend({ rotationId: z.string() }),
  output: cropRotationSchema,
  handler: async ({ input: { rotationId, ...data }, ctx: { cropRotations } }) => {
    return cropRotations.updateCropRotation(rotationId, data);
  },
});

export const deleteCropRotationEndpoint = cropRotationsWrite.build({
  method: "delete",
  input: z.object({ rotationId: z.string() }),
  output: z.object({}),
  handler: async ({ input: { rotationId }, ctx: { cropRotations } }) => {
    await cropRotations.deleteCropRotation(rotationId);
    return {};
  },
});

export const getCropRotationYearsEndpoint = cropRotationsRead.build({
  method: "get",
  input: z.object({}),
  output: z.object({
    result: z.array(z.string()),
    count: z.number(),
  }),
  handler: async ({ ctx: { cropRotations } }) => {
    const result = await cropRotations.getCropRotationYears();
    return {
      result,
      count: result.length,
    };
  },
});
