import createHttpError from "http-errors";
import { z } from "zod";
import { preferredCommunicationSchema } from "../db/schema";
import { permissionFarmEndpoint } from "../endpoint-factory";

const contactsRead = permissionFarmEndpoint("commerce", "read");
const contactsWrite = permissionFarmEndpoint("commerce", "write");
import { paymentSchema } from "../payments/payment-schema";
import { sponsorshipWithRelationsSchema } from "../sponsorships/sponsorships.endpoint";
import { orderSchema } from "../orders/orders.endpoint";
import { animalSchema } from "../animals/animals.endpoint";

export const contactSchema = z.object({
  id: z.string(),
  farmId: z.string(),
  firstName: z.string(),
  lastName: z.string(),
  street: z.string().nullable(),
  city: z.string().nullable(),
  zip: z.string().nullable(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  preferredCommunication: preferredCommunicationSchema.nullable(),
  labels: z.array(z.string()),
});

export const contactWithRelationsSchema = contactSchema.extend({
  get payments() {
    return z.array(paymentSchema);
  },
  get sponsorships() {
    return z.array(
      sponsorshipWithRelationsSchema
        .omit({ contact: true, payments: true })
        .extend({ animal: animalSchema.omit({ earTag: true }) })
    );
  },
  get orders() {
    return z.array(orderSchema);
  },
});

const createContactSchema = z.object({
  firstName: z.string(),
  lastName: z.string(),
  street: z.string().optional(),
  city: z.string().optional(),
  zip: z.string().optional(),
  phone: z.string().optional(),
  email: z.string().optional(),
  preferredCommunication: preferredCommunicationSchema.optional(),
  labels: z.array(z.string()).default([]),
});

const updateContactSchema = createContactSchema.partial();

export const getContactByIdEndpoint = contactsRead.build({
  method: "get",
  input: z.object({ contactId: z.string() }),
  output: contactWithRelationsSchema,
  handler: async ({ input, ctx: { contacts } }) => {
    const contact = await contacts.getContactById(input.contactId);
    if (!contact) {
      throw createHttpError(404, "Contact not found");
    }
    return contact;
  },
});

export const getFarmContactsEndpoint = contactsRead.build({
  method: "get",
  input: z.object({}),
  output: z.object({
    result: z.array(contactSchema),
    count: z.number(),
  }),
  handler: async ({ ctx: { contacts, farmId } }) => {
    const result = await contacts.getContactsForFarm(farmId);
    return {
      result,
      count: result.length,
    };
  },
});

export const createContactEndpoint = contactsWrite.build({
  method: "post",
  input: createContactSchema,
  output: contactSchema,
  handler: async ({ input, ctx: { contacts } }) => {
    console.log("CREATE CONTACT");
    return contacts.createContact(input);
  },
});

export const updateContactEndpoint = contactsWrite.build({
  method: "patch",
  input: updateContactSchema.extend({
    contactId: z.string(),
  }),
  output: contactSchema,
  handler: async ({ input, ctx: { contacts } }) => {
    const { contactId, ...data } = input;
    return contacts.updateContact(contactId, data);
  },
});

export const deleteContactEndpoint = contactsWrite.build({
  method: "delete",
  input: z.object({ contactId: z.string() }),
  output: z.object({}),
  handler: async ({ input: { contactId }, ctx: { contacts } }) => {
    await contacts.deleteContact(contactId);
    return {};
  },
});
