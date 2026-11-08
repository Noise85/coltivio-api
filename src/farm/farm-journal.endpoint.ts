import { ez } from "express-zod-api";
import { z } from "zod";
import { ownerOnlyEndpointFactory } from "../endpoint-factory";

const journalImageSchema = z.object({
  id: z.string(),
  journalEntryId: z.string(),
  storagePath: z.string(),
  createdAt: ez.dateOut(),
  signedUrl: z.string(),
});

const journalEntrySchema = z.object({
  id: z.string(),
  farmId: z.string(),
  title: z.string(),
  date: ez.dateOut(),
  content: z.string().nullable(),
  createdBy: z.string().nullable(),
  createdAt: ez.dateOut(),
  updatedAt: ez.dateOut(),
});

const journalEntryWithImagesSchema = journalEntrySchema.extend({
  images: z.array(journalImageSchema),
});

export const listFarmJournalEntriesEndpoint = ownerOnlyEndpointFactory.build({
  method: "get",
  input: z.object({}),
  output: z.object({ entries: z.array(journalEntrySchema) }),
  handler: async ({ ctx: { farmJournal, farmId } }) => {
    const entries = await farmJournal.listEntries(farmId);
    return { entries };
  },
});

export const createFarmJournalEntryEndpoint = ownerOnlyEndpointFactory.build({
  method: "post",
  input: z.object({
    title: z.string().min(1),
    date: ez.dateIn(),
    content: z.string().optional(),
  }),
  output: journalEntrySchema,
  handler: async ({ input, ctx: { farmJournal, farmId, user } }) => {
    return farmJournal.createEntry(farmId, user.id, input);
  },
});

export const getFarmJournalEntryEndpoint = ownerOnlyEndpointFactory.build({
  method: "get",
  input: z.object({ entryId: z.string() }),
  output: journalEntryWithImagesSchema,
  handler: async ({ input, ctx: { farmJournal } }) => {
    return farmJournal.getEntry(input.entryId);
  },
});

export const updateFarmJournalEntryEndpoint = ownerOnlyEndpointFactory.build({
  method: "patch",
  input: z.object({
    entryId: z.string(),
    title: z.string().min(1).optional(),
    date: ez.dateIn().optional(),
    content: z.string().optional(),
  }),
  output: journalEntrySchema,
  handler: async ({ input, ctx: { farmJournal } }) => {
    const { entryId, ...updateInput } = input;
    return farmJournal.updateEntry(entryId, updateInput);
  },
});

export const deleteFarmJournalEntryEndpoint = ownerOnlyEndpointFactory.build({
  method: "delete",
  input: z.object({ entryId: z.string() }),
  output: z.object({}),
  handler: async ({ input, ctx: { farmJournal } }) => {
    await farmJournal.deleteEntry(input.entryId);
    return {};
  },
});

export const requestFarmJournalImageSignedUrlEndpoint = ownerOnlyEndpointFactory.build({
  method: "post",
  input: z.object({
    journalEntryId: z.string(),
    filename: z.string().min(1),
  }),
  output: z.object({
    signedUrl: z.string(),
    path: z.string(),
  }),
  handler: async ({ input, ctx: { farmJournal } }) => {
    return farmJournal.requestSignedImageUrl(input.journalEntryId, input.filename);
  },
});

export const registerFarmJournalImageEndpoint = ownerOnlyEndpointFactory.build({
  method: "post",
  input: z.object({
    journalEntryId: z.string(),
    storagePath: z.string().min(1),
  }),
  output: journalImageSchema,
  handler: async ({ input, ctx: { farmJournal } }) => {
    return farmJournal.registerImage(input.journalEntryId, input.storagePath);
  },
});

export const deleteFarmJournalImageEndpoint = ownerOnlyEndpointFactory.build({
  method: "delete",
  input: z.object({ imageId: z.string() }),
  output: z.object({}),
  handler: async ({ input, ctx: { farmJournal } }) => {
    await farmJournal.deleteImage(input.imageId);
    return {};
  },
});
