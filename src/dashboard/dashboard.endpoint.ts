import { z } from "zod";
import { farmEndpointFactory } from "../endpoint-factory";
import { multiPolygonSchema } from "../db/schema";

const animalTypeSchema = z.enum(["goat", "sheep", "cow", "horse", "donkey", "pig", "deer"]);

const animalSexSchema = z.enum(["male", "female"]);

const dashboardStatsSchema = z.object({
  animals: z.object({
    total: z.number(),
    byType: z.array(z.object({ type: animalTypeSchema, count: z.number() })),
    bySex: z.array(z.object({ sex: animalSexSchema, count: z.number() })),
    bornThisYear: z.number(),
    diedThisYear: z.number(),
  }),
  harvests: z.object({
    totalKilos: z.number(),
    byCrop: z.array(
      z.object({
        cropName: z.string(),
        conservationMethod: z.string().nullable(),
        totalKilos: z.number(),
      })
    ),
    byPlot: z.array(
      z.object({
        plotId: z.string(),
        plotName: z.string(),
        totalKilos: z.number(),
        count: z.number(),
      })
    ),
  }),
  fertilizerApplications: z.object({
    totalCount: z.number(),
    byFertilizer: z.array(
      z.object({
        fertilizerName: z.string(),
        type: z.enum(["mineral", "organic"]),
        totalAmount: z.number(),
        unit: z.string(),
      })
    ),
    byPlot: z.array(z.object({ plotId: z.string(), plotName: z.string(), count: z.number() })),
  }),
  cropProtectionApplications: z.object({
    totalCount: z.number(),
    byProduct: z.array(z.object({ productName: z.string(), totalAmount: z.number(), unit: z.string() })),
    byPlot: z.array(z.object({ plotId: z.string(), plotName: z.string(), count: z.number() })),
  }),
  plots: z.object({
    total: z.number(),
    totalAreaM2: z.number(),
    byUsage: z.array(z.object({ usage: z.string(), count: z.number(), totalAreaM2: z.number() })),
  }),
  cropRotations: z.object({
    active: z.array(
      z.object({ cropName: z.string(), category: z.string(), plotCount: z.number(), totalAreaM2: z.number() })
    ),
  }),
});

const fieldEventSchema = z.object({
  id: z.string(),
  date: z.string(),
  geometry: multiPolygonSchema,
  plotId: z.string(),
  plotName: z.string(),
  type: z.enum(["harvest", "fertilizerApplication", "cropProtectionApplication", "tillage"]),
  action: z.string(),
});

export const getDashboardStatsEndpoint = farmEndpointFactory.build({
  method: "get",
  input: z.object({
    year: z
      .string()
      .optional()
      .transform((val) => (val != null ? parseInt(val, 10) : new Date().getFullYear())),
  }),
  output: dashboardStatsSchema,
  handler: async ({ input, ctx }) => {
    return ctx.dashboard.getDashboardStats(ctx.farmId, input.year);
  },
});

export const getFieldEventsEndpoint = farmEndpointFactory.build({
  method: "get",
  input: z.object({
    fromDate: z.string().date(),
    toDate: z.string().date(),
  }),
  output: z.object({ result: z.array(fieldEventSchema) }),
  handler: async ({ input, ctx }) => {
    const fromDate = new Date(input.fromDate);
    const toDate = new Date(input.toDate);
    const result = await ctx.dashboard.getFieldEvents(ctx.farmId, fromDate, toDate);
    return { result };
  },
});
