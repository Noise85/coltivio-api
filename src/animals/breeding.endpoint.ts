import { ez } from "express-zod-api";
import createHttpError from "http-errors";
import { z } from "zod";
import { animalTypeSchema } from "../db/schema";
import { ownerOnlyEndpointFactory, permissionFarmEndpoint } from "../endpoint-factory";

const animalsRead = permissionFarmEndpoint("animals", "read");
const animalsWrite = permissionFarmEndpoint("animals", "write");

export const animalHeatSchema = z.object({
  id: z.string(),
  farmId: z.string(),
  animalId: z.string(),
  date: ez.dateOut(),
  mated: z.boolean(),
  sireId: z.string().nullable(),
  sireName: z.string().nullable(),
  notes: z.string().nullable(),
  createdAt: ez.dateOut(),
  createdBy: z.string().nullable(),
});

// Expected birth (mated heats only) and whether a later heat showed the mating didn't work
const heatOutcomeFields = {
  expectedBirthDate: ez.dateOut().nullable().optional(),
  conceptionFailed: z.boolean().optional(),
};

const animalHeatWithOutcomeSchema = animalHeatSchema.extend(heatOutcomeFields);

const breedingCalendarEntrySchema = animalHeatSchema.extend({
  expectedBirthDate: ez.dateOut().nullable(),
  conceptionFailed: z.boolean(),
  animal: z.object({
    id: z.string(),
    name: z.string(),
    type: animalTypeSchema,
    earTagNumber: z.string().nullable(),
  }),
  sire: z.object({ id: z.string(), name: z.string() }).nullable(),
});

const gestationSettingSchema = z.object({
  animalType: animalTypeSchema,
  gestationDays: z.number(),
  isDefault: z.boolean(),
});

export const listAnimalHeatsEndpoint = animalsRead.build({
  method: "get",
  input: z.object({ animalId: z.string() }),
  output: z.object({ result: z.array(animalHeatWithOutcomeSchema) }),
  handler: async ({ input, ctx: { breeding, farmId } }) => {
    return { result: await breeding.listHeats(input.animalId, farmId) };
  },
});

export const createAnimalHeatEndpoint = animalsWrite.build({
  method: "post",
  input: z.object({
    animalId: z.string(),
    date: ez.dateIn(),
    mated: z.boolean().optional(),
    sireId: z.string().optional().nullable(),
    sireName: z.string().optional().nullable(),
    notes: z.string().optional().nullable(),
  }),
  output: animalHeatSchema,
  handler: async ({ input, ctx: { breeding, user } }) => {
    const { animalId, ...heatInput } = input;
    const heat = await breeding.createHeat(animalId, user.id, heatInput);
    if (!heat) throw createHttpError(404, "Animal or sire not found");
    return heat;
  },
});

export const updateAnimalHeatEndpoint = animalsWrite.build({
  method: "patch",
  input: z.object({
    heatId: z.string(),
    date: ez.dateIn().optional(),
    mated: z.boolean().optional(),
    sireId: z.string().optional().nullable(),
    sireName: z.string().optional().nullable(),
    notes: z.string().optional().nullable(),
  }),
  output: animalHeatSchema,
  handler: async ({ input, ctx: { breeding } }) => {
    const { heatId, ...updateInput } = input;
    const heat = await breeding.updateHeat(heatId, updateInput);
    if (!heat) throw createHttpError(404, "Heat entry or sire not found");
    return heat;
  },
});

export const deleteAnimalHeatEndpoint = animalsWrite.build({
  method: "delete",
  input: z.object({ heatId: z.string() }),
  output: z.object({}),
  handler: async ({ input, ctx: { breeding } }) => {
    const deleted = await breeding.deleteHeat(input.heatId);
    if (!deleted) throw createHttpError(404, "Heat entry not found");
    return {};
  },
});

export const getBreedingCalendarEndpoint = animalsRead.build({
  method: "get",
  input: z.object({
    from: ez.dateIn().optional(),
    to: ez.dateIn().optional(),
  }),
  output: z.object({ result: z.array(breedingCalendarEntrySchema) }),
  handler: async ({ input, ctx: { breeding, farmId } }) => {
    return { result: await breeding.getCalendar(farmId, input.from, input.to) };
  },
});

export const getGestationSettingsEndpoint = animalsRead.build({
  method: "get",
  input: z.object({}),
  output: z.object({ result: z.array(gestationSettingSchema) }),
  handler: async ({ ctx: { breeding, farmId } }) => {
    return { result: await breeding.getGestationSettings(farmId) };
  },
});

export const updateGestationSettingsEndpoint = ownerOnlyEndpointFactory.build({
  method: "put",
  input: z.object({
    // null resets the animal type to its default
    settings: z.array(
      z.object({ animalType: animalTypeSchema, gestationDays: z.number().int().min(1).max(500).nullable() })
    ),
  }),
  output: z.object({ result: z.array(gestationSettingSchema) }),
  handler: async ({ input, ctx: { breeding, farmId } }) => {
    return { result: await breeding.updateGestationSettings(farmId, input.settings) };
  },
});
