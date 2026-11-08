import { ez } from "express-zod-api";
import createHttpError from "http-errors";
import { z } from "zod";
import {
  animalTypeSchema,
  parasiteCheckMethodSchema,
  parasiteResultGradeSchema,
  parasiteTypeSchema,
  taskStatusSchema,
} from "../db/schema";
import { permissionFarmEndpoint } from "../endpoint-factory";

const parasiteChecksRead = permissionFarmEndpoint("animals", "read");
const parasiteChecksWrite = permissionFarmEndpoint("animals", "write");

// A result is either a count per gram or a grade (+/++/+++)
const fecResultSchema = z.object({
  parasiteType: parasiteTypeSchema,
  countPerGram: z.number().nullable(),
  grade: parasiteResultGradeSchema.nullable(),
});

const fecResultInputSchema = z
  .object({
    parasiteType: parasiteTypeSchema,
    countPerGram: z.number().min(0).optional().nullable(),
    grade: parasiteResultGradeSchema.optional().nullable(),
  })
  .refine(
    (result) => ((result.countPerGram ?? null) !== null) !== ((result.grade ?? null) !== null),
    "A result needs either a count or a grade"
  );

export const parasiteCheckSchema = z.object({
  id: z.string(),
  farmId: z.string(),
  date: ez.dateOut(),
  name: z.string().nullable(),
  method: parasiteCheckMethodSchema,
  labName: z.string().nullable(),
  notes: z.string().nullable(),
  previousCheckId: z.string().nullable(),
  treatmentId: z.string().nullable(),
  createdBy: z.string().nullable(),
  createdAt: ez.dateOut(),
  updatedAt: ez.dateOut(),
  animalType: animalTypeSchema.nullable(),
  treatment: z.object({ id: z.string(), name: z.string(), startDate: ez.dateOut() }).nullable(),
  animals: z.array(
    z.object({
      animalId: z.string(),
      name: z.string(),
      earTagNumber: z.string().nullable(),
      famachaScore: z.number().nullable(),
    })
  ),
  fecSamples: z.array(
    z.object({
      id: z.string(),
      label: z.string().nullable(),
      pooled: z.boolean(),
      animalIds: z.array(z.string()),
      results: z.array(fecResultSchema),
    })
  ),
  followUpTasks: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      dueDate: ez.dateOut().nullable(),
      status: taskStatusSchema,
    })
  ),
  summary: z.object({
    animalCount: z.number(),
    famachaAverage: z.number().nullable(),
    famachaDistribution: z.array(z.object({ score: z.number(), count: z.number() })),
    fecByParasite: z.array(
      z.object({
        parasiteType: parasiteTypeSchema,
        sampleCount: z.number(),
        minCountPerGram: z.number(),
        avgCountPerGram: z.number(),
        maxCountPerGram: z.number(),
      })
    ),
    gradesByParasite: z.array(
      z.object({
        parasiteType: parasiteTypeSchema,
        sampleCount: z.number(),
        // Own enum instance: the shared one is also used as nullable above, and the
        // documentation would then mark this field nullable too
        highestGrade: z.enum(parasiteResultGradeSchema.options),
        averageGrade: z.number(),
      })
    ),
  }),
  comparisonToPrevious: z
    .object({
      previousCheckId: z.string(),
      previousDate: ez.dateOut(),
      famachaBeforeAverage: z.number().nullable(),
      famachaAfterAverage: z.number().nullable(),
      famachaAverageChange: z.number().nullable(),
      fecReduction: z.array(
        z.object({
          parasiteType: parasiteTypeSchema,
          beforeAvgCountPerGram: z.number(),
          afterAvgCountPerGram: z.number(),
          afterSampleCount: z.number(),
          reductionPercent: z.number().nullable(),
        })
      ),
    })
    .nullable(),
  rechecks: z.array(
    z.object({
      id: z.string(),
      date: ez.dateOut(),
      name: z.string().nullable(),
      method: parasiteCheckMethodSchema,
      treatment: z.object({ id: z.string(), name: z.string(), startDate: ez.dateOut() }).nullable(),
      animals: z.array(z.object({ animalId: z.string(), famachaScore: z.number().nullable() })),
      famachaAverage: z.number().nullable(),
      famachaBeforeAverage: z.number().nullable(),
      famachaAfterAverage: z.number().nullable(),
      famachaAverageChange: z.number().nullable(),
      fecReduction: z.array(
        z.object({
          parasiteType: parasiteTypeSchema,
          beforeAvgCountPerGram: z.number(),
          afterAvgCountPerGram: z.number(),
          afterSampleCount: z.number(),
          reductionPercent: z.number().nullable(),
        })
      ),
    })
  ),
});

const checkAnimalInputSchema = z.object({
  animalId: z.string(),
  famachaScore: z.number().int().min(1).max(5).optional().nullable(),
});

const fecSampleInputSchema = z.object({
  label: z.string().optional().nullable(),
  animalIds: z.array(z.string()).min(1),
  results: z
    .array(fecResultInputSchema)
    .refine(
      (results) => new Set(results.map((result) => result.parasiteType)).size === results.length,
      "Each parasite type may only appear once per sample"
    ),
});

const checkFieldsSchema = z.object({
  date: ez.dateIn(),
  name: z.string().optional().nullable(),
  method: parasiteCheckMethodSchema,
  animals: z.array(checkAnimalInputSchema).min(1),
  fecSamples: z.array(fecSampleInputSchema).optional(),
  labName: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
  previousCheckId: z.string().optional().nullable(),
  treatmentId: z.string().optional().nullable(),
});

const createCheckSchema = checkFieldsSchema.extend({
  // Optional re-check reminder task
  followUp: z
    .object({
      dueDate: ez.dateIn(),
      name: z.string().min(1).optional(),
      assigneeId: z.string().optional(),
    })
    .optional(),
});

const updateCheckSchema = checkFieldsSchema.partial().extend({
  checkId: z.string(),
});

const dateRangeSchema = z.object({
  from: ez.dateIn().optional(),
  to: ez.dateIn().optional(),
});

export const listParasiteChecksEndpoint = parasiteChecksRead.build({
  method: "get",
  input: dateRangeSchema.extend({
    animalId: z.string().optional(),
  }),
  output: z.object({
    result: z.array(parasiteCheckSchema),
    count: z.number(),
  }),
  handler: async ({ input, ctx: { parasiteChecks } }) => {
    const result = await parasiteChecks.listChecks(input);
    return { result, count: result.length };
  },
});

export const getParasiteCheckEndpoint = parasiteChecksRead.build({
  method: "get",
  input: z.object({ checkId: z.string() }),
  output: parasiteCheckSchema,
  handler: async ({ input, ctx: { parasiteChecks } }) => {
    const check = await parasiteChecks.getCheck(input.checkId);
    if (!check) {
      throw createHttpError(404, "Parasite check not found");
    }
    return check;
  },
});

export const createParasiteCheckEndpoint = parasiteChecksWrite.build({
  method: "post",
  input: createCheckSchema,
  output: parasiteCheckSchema,
  handler: async ({ input, ctx: { parasiteChecks, user } }) => {
    return parasiteChecks.createCheck(input, user.id);
  },
});

export const updateParasiteCheckEndpoint = parasiteChecksWrite.build({
  method: "patch",
  input: updateCheckSchema,
  output: parasiteCheckSchema,
  handler: async ({ input, ctx: { parasiteChecks } }) => {
    const { checkId, ...data } = input;
    return parasiteChecks.updateCheck(checkId, data);
  },
});

export const deleteParasiteCheckEndpoint = parasiteChecksWrite.build({
  method: "delete",
  input: z.object({ checkId: z.string() }),
  output: z.object({}),
  handler: async ({ input, ctx: { parasiteChecks } }) => {
    await parasiteChecks.deleteCheck(input.checkId);
    return {};
  },
});

export const getAnimalParasiteHistoryEndpoint = parasiteChecksRead.build({
  method: "get",
  input: dateRangeSchema.extend({ animalId: z.string() }),
  output: z.object({
    checks: z.array(
      z.object({
        checkId: z.string(),
        date: ez.dateOut(),
        method: parasiteCheckMethodSchema,
        famachaScore: z.number().nullable(),
      })
    ),
    fecResults: z.array(
      z.object({
        checkId: z.string(),
        sampleId: z.string(),
        date: ez.dateOut(),
        pooled: z.boolean(),
        poolSize: z.number(),
        results: z.array(fecResultSchema),
      })
    ),
    treatments: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        startDate: ez.dateOut(),
        endDate: ez.dateOut(),
        drugName: z.string().nullable(),
      })
    ),
  }),
  handler: async ({ input, ctx: { parasiteChecks } }) => {
    const { animalId, ...range } = input;
    return parasiteChecks.getAnimalParasiteHistory(animalId, range);
  },
});
