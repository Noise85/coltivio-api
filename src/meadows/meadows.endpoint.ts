import createHttpError from "http-errors";
import { ez } from "express-zod-api";
import { z } from "zod";
import { multiPolygonSchema } from "../db/schema";
import { permissionFarmEndpoint } from "../endpoint-factory";
import { meadowJournalEntrySchema } from "../animals/animals.endpoint";

const meadowsRead = permissionFarmEndpoint("animals", "read");
const meadowsWrite = permissionFarmEndpoint("animals", "write");

const meadowSchema = z.object({
  id: z.string(),
  farmId: z.string(),
  name: z.string(),
  geometry: multiPolygonSchema,
  size: z.number(),
  additionalNotes: z.string().nullable(),
  archivedAt: ez.dateOut().nullable(),
  createdAt: ez.dateOut(),
});

const createMeadowSchema = z.object({
  name: z.string(),
  geometry: multiPolygonSchema,
  additionalNotes: z.string().optional().nullable(),
});

const updateMeadowSchema = createMeadowSchema
  .partial()
  .extend({ meadowId: z.string(), archived: z.boolean().optional() });

export const getMeadowsEndpoint = meadowsRead.build({
  method: "get",
  input: z.object({
    includeArchived: z
      .enum(["true", "false"])
      .optional()
      .transform((value) => value === "true"),
  }),
  output: z.object({
    result: z.array(meadowSchema),
    count: z.number(),
  }),
  handler: async ({ input, ctx: { meadows } }) => {
    const result = await meadows.getMeadows(input.includeArchived);
    return { result, count: result.length };
  },
});

export const getMeadowByIdEndpoint = meadowsRead.build({
  method: "get",
  input: z.object({ meadowId: z.string() }),
  output: meadowSchema,
  handler: async ({ input, ctx: { meadows } }) => {
    const meadow = await meadows.getMeadowById(input.meadowId);
    if (!meadow) {
      throw createHttpError(404, "Meadow not found");
    }
    return meadow;
  },
});

export const createMeadowEndpoint = meadowsWrite.build({
  method: "post",
  input: createMeadowSchema,
  output: meadowSchema,
  handler: async ({ input, ctx: { meadows } }) => {
    return meadows.createMeadow(input);
  },
});

export const updateMeadowEndpoint = meadowsWrite.build({
  method: "patch",
  input: updateMeadowSchema,
  output: meadowSchema,
  handler: async ({ input, ctx: { meadows } }) => {
    const { meadowId, ...data } = input;
    return meadows.updateMeadow(meadowId, data);
  },
});

export const deleteMeadowEndpoint = meadowsWrite.build({
  method: "delete",
  input: z.object({ meadowId: z.string() }),
  output: z.object({}),
  handler: async ({ input: { meadowId }, ctx: { meadows } }) => {
    await meadows.deleteMeadow(meadowId);
    return {};
  },
});

export const getMeadowUsageEndpoint = meadowsRead.build({
  method: "get",
  input: z.object({ meadowId: z.string(), fromDate: ez.dateIn(), toDate: ez.dateIn() }),
  output: z.object({
    result: z.array(meadowJournalEntrySchema),
  }),
  handler: async ({ input, ctx: { meadows } }) => {
    const result = await meadows.getMeadowUsage(input.meadowId, input.fromDate, input.toDate);
    return { result };
  },
});
