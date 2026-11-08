import { ez } from "express-zod-api";
import createHttpError from "http-errors";
import { z } from "zod";
import {
  animalCateogrySchema,
  animalSexSchema,
  animalTypeSchema,
  animalUsageSchema,
  deathReasonSchema,
  frequencySchema,
  outdoorScheduleTypeSchema,
  weekdaySchema,
} from "../db/schema";
import { earTagSchema } from "../ear-tags/ear-tags.endpoint";
import { permissionFarmEndpoint } from "../endpoint-factory";

const animalsRead = permissionFarmEndpoint("animals", "read");
const animalsWrite = permissionFarmEndpoint("animals", "write");
import { treatmentSchema } from "../treatments/treatments.endpoint";

export const animalSchema = z.object({
  id: z.string(),
  farmId: z.string(),
  name: z.string(),
  type: animalTypeSchema,
  sex: animalSexSchema,
  dateOfBirth: ez.dateOut(),
  registered: z.boolean(),
  usage: animalUsageSchema,
  earTagId: z.string().nullable(),
  get earTag() {
    return earTagSchema.nullable();
  },
  motherId: z.string().nullable(),
  fatherId: z.string().nullable(),
  dateOfDeath: ez.dateOut().nullable(),
  deathReason: deathReasonSchema.nullable(),
  herdId: z.string().nullable(),
});

const herdSchema = z.object({
  id: z.string(),
  farmId: z.string(),
  name: z.string(),
});

const recurrenceSchema = z.object({
  id: z.string(),
  frequency: frequencySchema,
  interval: z.number(),
  byWeekday: z.array(weekdaySchema).nullable(),
  byMonthDay: z.number().nullable(),
  until: z.string().nullable(),
  count: z.number().nullable(),
});

const outdoorScheduleSchema = z.object({
  id: z.string(),
  farmId: z.string(),
  herdId: z.string(),
  meadowId: z.string().nullable(),
  meadow: z.object({ id: z.string(), name: z.string(), size: z.number() }).nullable().optional(),
  startDate: ez.dateOut(),
  endDate: ez.dateOut().nullable(),
  type: outdoorScheduleTypeSchema,
  notes: z.string().nullable(),
  recurrence: recurrenceSchema.nullable(),
});

const herdWithRelationsSchema = herdSchema.extend({
  animals: z.array(animalSchema),
  outdoorSchedules: z.array(outdoorScheduleSchema),
});

const createOutdoorScheduleSchema = z.object({
  startDate: ez.dateIn(),
  endDate: ez.dateIn().optional().nullable(),
  type: outdoorScheduleTypeSchema,
  notes: z.string().optional().nullable(),
  meadowId: z.string().optional().nullable(),
  recurrence: z
    .object({
      frequency: frequencySchema,
      interval: z.number(),
      byWeekday: z.array(weekdaySchema).optional().nullable(),
      byMonthDay: z.number().optional().nullable(),
      until: z.string().optional().nullable(),
      count: z.number().optional().nullable(),
    })
    .optional()
    .nullable(),
});

const updateOutdoorScheduleSchema = createOutdoorScheduleSchema.partial();

const createHerdSchema = z.object({
  name: z.string(),
  animalIds: z.array(z.string()),
  outdoorSchedules: z.array(createOutdoorScheduleSchema).optional(),
  // Day from which added/removed animals count as (no longer) in the herd. Defaults to today.
  effectiveDate: ez.dateIn().optional().nullable(),
});
const updateHerdSchema = createHerdSchema.partial();

const customOutdoorJournalCategorySchema = z.object({
  id: z.string(),
  farmId: z.string(),
  animalId: z.string(),
  startDate: ez.dateOut(),
  endDate: ez.dateOut().nullable(),
  category: animalCateogrySchema,
});

const animalWithRelationsSchema = animalSchema.extend({
  get earTag() {
    return earTagSchema.nullable();
  },
  // if we do animalSchema.nullable(), all schemas referencing animal in this object will be nullable
  mother: z.union([animalSchema, z.null()]),
  father: z.union([animalSchema, z.null()]),
  childrenAsMother: z.array(animalSchema),
  childrenAsFather: z.array(animalSchema),
  get treatments() {
    return z.array(treatmentSchema);
  },
  herd: herdSchema.optional().nullable(),
  customOutdoorJournalCategories: z.array(customOutdoorJournalCategorySchema),
});

const createAnimalSchema = z.object({
  name: z.string(),
  type: animalTypeSchema,
  sex: animalSexSchema,
  dateOfBirth: ez.dateIn(),
  registered: z.boolean(),
  usage: animalUsageSchema,
  earTagId: z.string().optional().nullable(),
  motherId: z.string().optional().nullable(),
  fatherId: z.string().optional().nullable(),
  dateOfDeath: ez.dateIn().optional().nullable(),
  deathReason: deathReasonSchema.optional().nullable(),
  herdId: z.string().optional().nullable(),
  // Day from which a herdId change applies. Defaults to today.
  herdEffectiveDate: ez.dateIn().optional().nullable(),
});

const updateAnimalSchema = createAnimalSchema.partial();

export const getAnimalByIdEndpoint = animalsRead.build({
  method: "get",
  input: z.object({ animalId: z.string() }),
  output: animalWithRelationsSchema,
  handler: async ({ input, ctx: { animals } }) => {
    const animal = await animals.getAnimalById(input.animalId);
    if (!animal) {
      throw createHttpError(404, "Animal not found");
    }
    return animal;
  },
});

export const getFarmAnimalsEndpoint = animalsRead.build({
  method: "get",
  input: z.object({
    animalTypes: z.preprocess((val) => (typeof val === "string" ? [val] : val), z.array(animalTypeSchema)).optional(),
    onlyLiving: z
      .string()
      .optional()
      .transform((value) => value === "true")
      .default(true),
  }),
  output: z.object({
    result: z.array(
      animalSchema.extend({
        milkAndMeatUsable: z.boolean(),
      })
    ),
    count: z.number(),
  }),
  handler: async ({ input, ctx: { animals, farmId } }) => {
    const result = await animals.getAnimalsForFarm(farmId, input.onlyLiving, input.animalTypes);
    return {
      result,
      count: result.length,
    };
  },
});

export const createAnimalEndpoint = animalsWrite.build({
  method: "post",
  input: createAnimalSchema,
  output: animalSchema,
  handler: async ({ input, ctx: { animals } }) => {
    return animals.createAnimal(input);
  },
});

export const updateAnimalEndpoint = animalsWrite.build({
  method: "patch",
  input: updateAnimalSchema.extend({
    animalId: z.string(),
  }),
  output: animalSchema,
  handler: async ({ input, ctx: { animals } }) => {
    const { animalId, ...data } = input;
    return animals.updateAnimal(animalId, data);
  },
});

export const updateAnimalsEndpoint = animalsWrite.build({
  method: "patch",
  input: z.object({
    animals: z.array(
      updateAnimalSchema.extend({
        id: z.string(),
      })
    ),
  }),
  output: z.object({
    result: z.array(animalSchema),
    count: z.number(),
  }),
  handler: async ({ input, ctx: { animals } }) => {
    const result = await animals.updateAnimals(input.animals);
    return {
      result,
      count: result.length,
    };
  },
});

export const batchUpdateAnimalsEndpoint = animalsWrite.build({
  method: "patch",
  input: z.object({
    animalIds: z.array(z.string()),
    data: z.object({
      type: animalTypeSchema.optional(),
      usage: animalUsageSchema.optional(),
      registered: z.boolean().optional(),
      dateOfDeath: ez.dateIn().optional(),
      deathReason: deathReasonSchema.optional(),
      motherId: z.string().optional(),
      fatherId: z.string().optional(),
    }),
  }),
  output: z.object({
    result: z.array(animalSchema),
    count: z.number(),
  }),
  handler: async ({ input, ctx: { animals } }) => {
    console.log(input.data);
    const result = await animals.batchUpdateAnimals(input.animalIds, input.data);
    return {
      result,
      count: result.length,
    };
  },
});

export const deleteAnimalEndpoint = animalsWrite.build({
  method: "delete",
  input: z.object({ animalId: z.string() }),
  output: z.object({}),
  handler: async ({ input: { animalId }, ctx: { animals } }) => {
    await animals.deleteAnimal(animalId);
    return {};
  },
});

export const deleteAnimalsEndpoint = animalsWrite.build({
  method: "delete",
  input: z.object({ animalIds: z.array(z.string()) }),
  output: z.object({}),
  handler: async ({ input: { animalIds }, ctx: { animals } }) => {
    await animals.deleteAnimals(animalIds);
    return {};
  },
});

export const setCustomOutdoorJournalCategoriesEndpoint = animalsWrite.build({
  method: "put",
  input: z.object({
    animalId: z.string(),
    entries: z.array(
      z.object({
        startDate: ez.dateIn(),
        endDate: ez.dateIn().optional().nullable(),
        category: animalCateogrySchema,
      })
    ),
  }),
  output: z.object({
    result: z.array(customOutdoorJournalCategorySchema),
  }),
  handler: async ({ input, ctx: { animals } }) => {
    const result = await animals.setCustomOutdoorJournalCategories(input.animalId, input.entries);
    return { result };
  },
});

export const getAnimalChildrenEndpoint = animalsRead.build({
  method: "get",
  input: z.object({ animalId: z.string() }),
  output: z.object({
    result: z.array(animalSchema),
    count: z.number(),
  }),
  handler: async ({ input, ctx: { animals } }) => {
    const result = await animals.getChildrenOfAnimal(input.animalId);
    return {
      result,
      count: result.length,
    };
  },
});

const familyTreeNodeSchema = z.object({
  id: z.string(),
  name: z.string(),
  earTagNumber: z.string().nullable(),
  dateOfBirth: ez.dateOut(),
  dateOfDeath: ez.dateOut().nullable(),
  sex: animalSexSchema,
});

const familyTreeEdgeSchema = z.object({
  parentId: z.string(),
  childId: z.string(),
  relation: z.enum(["mother", "father"]),
});

export const getFamilyTreeEndpoint = animalsRead.build({
  method: "get",
  input: z.object({ type: animalTypeSchema }),
  output: z.object({
    nodes: z.array(familyTreeNodeSchema),
    edges: z.array(familyTreeEdgeSchema),
  }),
  handler: async ({ input, ctx: { animals, farmId } }) => {
    return animals.getFamilyTree(farmId, input.type);
  },
});

const skippedRowSchema = z.object({
  row: z.number(),
  earTagNumber: z.string().nullable(),
  name: z.string().nullable(),
  reason: z.string(),
});

const importSummarySchema = z.object({
  totalRows: z.number(),
  imported: z.number(),
  skipped: z.number(),
});

export const importAnimalsFromExcelEndpoint = animalsWrite.build({
  method: "post",
  input: z.object({
    file: ez.upload(),
    type: animalTypeSchema,
    skipHeaderRow: z
      .string()
      .optional()
      .transform((val) => val !== "false")
      .default(true),
  }),
  output: z.object({
    skipped: z.array(skippedRowSchema),
    summary: importSummarySchema,
  }),
  handler: async ({ input, ctx: { animals, farmId, preferredLanguage } }) => {
    const { file, type, skipHeaderRow } = input;
    return animals.importFromExcel(file.data, type, skipHeaderRow, farmId, preferredLanguage);
  },
});

const parsedImportRowSchema = z.object({
  rowNumber: z.number(),
  earTagNumber: z.string().nullable(),
  earTagId: z.string().nullable(),
  earTagAssigned: z.boolean(),
  assignedToAnimalId: z.string().nullable(),
  assignedToAnimalName: z.string().nullable(),
  name: z.string().nullable(),
  sex: animalSexSchema.nullable(),
  dateOfBirth: ez.dateOut().nullable(),
  usage: animalUsageSchema.nullable(),
  dateOfDeath: ez.dateOut().nullable(),
  deathReason: deathReasonSchema.nullable(),
  motherEarTagNumber: z.string().nullable(),
  fatherEarTagNumber: z.string().nullable(),
  parseErrors: z.array(z.string()),
});

export const previewAnimalImportEndpoint = animalsWrite.build({
  method: "post",
  input: z.object({
    file: ez.upload(),
    skipHeaderRow: z
      .string()
      .optional()
      .transform((val) => val !== "false")
      .default(true),
  }),
  output: z.object({
    rows: z.array(parsedImportRowSchema),
  }),
  handler: async ({ input, ctx: { animals, farmId, preferredLanguage } }) => {
    const rows = await animals.parseImportPreview(input.file.data, input.skipHeaderRow, farmId, preferredLanguage);
    return { rows };
  },
});

const commitImportRowSchema = z.object({
  earTagNumber: z.string().nullable().optional(),
  earTagId: z.string().nullable().optional(),
  name: z.string(),
  sex: animalSexSchema,
  dateOfBirth: ez.dateIn(),
  usage: animalUsageSchema,
  dateOfDeath: ez.dateIn().nullable().optional(),
  deathReason: deathReasonSchema.nullable().optional(),
  motherEarTagNumber: z.string().nullable().optional(),
  fatherEarTagNumber: z.string().nullable().optional(),
  mergeAnimalId: z.string().nullable().optional(),
});

export const commitAnimalImportEndpoint = animalsWrite.build({
  method: "post",
  input: z.object({
    type: animalTypeSchema,
    rows: z.array(commitImportRowSchema),
  }),
  output: z.object({
    created: z.number(),
    merged: z.number(),
    skipped: z.array(z.object({ index: z.number(), reason: z.string() })),
  }),
  handler: async ({ input, ctx: { animals, farmId } }) => {
    return animals.commitImport(input.rows, input.type, farmId);
  },
});

// --- Outdoor Journal ---

const outdoorJournalEntrySchema = z.object({
  category: animalCateogrySchema,
  startDate: ez.dateOut(),
  endDate: ez.dateOut(),
  animalCount: z.number(),
});

export const meadowJournalEntrySchema = z.object({
  meadowId: z.string(),
  meadowName: z.string(),
  meadowSize: z.number(),
  herdId: z.string(),
  herdName: z.string(),
  type: outdoorScheduleTypeSchema,
  startDate: ez.dateOut(),
  endDate: ez.dateOut(),
  animalCount: z.number(),
  // Only animal types present in the stay, e.g. { cow: 12, sheep: 3 }
  animalCountsByType: z.partialRecord(animalTypeSchema, z.number()),
});

export const getOutdoorJournalEndpoint = animalsRead.build({
  method: "get",
  input: z.object({ fromDate: ez.dateIn(), toDate: ez.dateIn() }),
  output: z.object({
    entries: z.array(outdoorJournalEntrySchema),
    uncategorizedAnimals: z.array(animalSchema),
    meadowEntries: z.array(meadowJournalEntrySchema).optional(),
  }),
  handler: async ({ input, ctx: { animals, farmId } }) => {
    return animals.getOutdoorJournal(farmId, input.fromDate, input.toDate);
  },
});

// --- Herd Endpoints ---

export const getFarmHerdsEndpoint = animalsRead.build({
  method: "get",
  input: z.object({}),
  output: z.object({
    result: z.array(herdWithRelationsSchema),
    count: z.number(),
  }),
  handler: async ({ ctx: { animals, farmId } }) => {
    const result = await animals.getHerdsForFarm(farmId);
    return { result, count: result.length };
  },
});

export const createHerdEndpoint = animalsWrite.build({
  method: "post",
  input: createHerdSchema,
  output: herdSchema,
  handler: async ({ input, ctx: { animals } }) => {
    const { animalIds, outdoorSchedules, effectiveDate, ...herdData } = input;
    return animals.createHerd(herdData, animalIds, outdoorSchedules, effectiveDate);
  },
});

export const getHerdByIdEndpoint = animalsRead.build({
  method: "get",
  input: z.object({ herdId: z.string() }),
  output: herdWithRelationsSchema,
  handler: async ({ input, ctx: { animals } }) => {
    const herd = await animals.getHerdById(input.herdId);
    if (!herd) {
      throw createHttpError(404, "Herd not found");
    }
    return herd;
  },
});

export const updateHerdEndpoint = animalsWrite.build({
  method: "patch",
  input: updateHerdSchema.extend({ herdId: z.string() }),
  output: herdSchema,
  handler: async ({ input, ctx: { animals } }) => {
    const { herdId, animalIds, outdoorSchedules, effectiveDate, ...data } = input;
    return animals.updateHerd(herdId, data, animalIds, outdoorSchedules, effectiveDate);
  },
});

export const deleteHerdEndpoint = animalsWrite.build({
  method: "delete",
  input: z.object({ herdId: z.string() }),
  output: z.object({}),
  handler: async ({ input: { herdId }, ctx: { animals } }) => {
    await animals.deleteHerd(herdId);
    return {};
  },
});

// --- Outdoor Schedule Endpoints ---

export const getHerdOutdoorSchedulesEndpoint = animalsRead.build({
  method: "get",
  input: z.object({ herdId: z.string() }),
  output: z.object({
    result: z.array(outdoorScheduleSchema),
    count: z.number(),
  }),
  handler: async ({ input, ctx: { animals } }) => {
    const result = await animals.getOutdoorSchedulesForHerd(input.herdId);
    return { result, count: result.length };
  },
});

export const createOutdoorScheduleEndpoint = animalsWrite.build({
  method: "post",
  input: createOutdoorScheduleSchema.extend({ herdId: z.string() }),
  output: outdoorScheduleSchema,
  handler: async ({ input, ctx: { animals } }) => {
    const { herdId, ...data } = input;
    return animals.createOutdoorSchedule(herdId, data);
  },
});

export const getOutdoorScheduleByIdEndpoint = animalsRead.build({
  method: "get",
  input: z.object({ outdoorScheduleId: z.string() }),
  output: outdoorScheduleSchema,
  handler: async ({ input, ctx: { animals } }) => {
    const schedule = await animals.getOutdoorScheduleById(input.outdoorScheduleId);
    if (!schedule) {
      throw createHttpError(404, "Outdoor schedule not found");
    }
    return schedule;
  },
});

export const updateOutdoorScheduleEndpoint = animalsWrite.build({
  method: "patch",
  input: updateOutdoorScheduleSchema.extend({
    outdoorScheduleId: z.string(),
  }),
  output: outdoorScheduleSchema,
  handler: async ({ input, ctx: { animals } }) => {
    const { outdoorScheduleId, ...data } = input;
    return animals.updateOutdoorSchedule(outdoorScheduleId, data);
  },
});

export const deleteOutdoorScheduleEndpoint = animalsWrite.build({
  method: "delete",
  input: z.object({ outdoorScheduleId: z.string() }),
  output: z.object({}),
  handler: async ({ input: { outdoorScheduleId }, ctx: { animals } }) => {
    await animals.deleteOutdoorSchedule(outdoorScheduleId);
    return {};
  },
});

// First day a herd change (effectiveDate when editing a herd) can take effect for each animal, so the clients
// only offer dates the update accepts. Earlier dates are rejected there, as they'd overlap the animal's history.
export const getEarliestHerdChangeDatesEndpoint = animalsRead.build({
  method: "get",
  input: z.object({
    animalIds: z.preprocess((val) => (typeof val === "string" ? [val] : val), z.array(z.string())),
  }),
  output: z.object({
    result: z.array(z.object({ animalId: z.string(), earliestDate: ez.dateOut().nullable() })),
  }),
  handler: async ({ input, ctx: { animals } }) => {
    return { result: await animals.getEarliestHerdChangeDates(input.animalIds) };
  },
});
