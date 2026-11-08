import { ez } from "express-zod-api";
import { z } from "zod";
import { paymentMethodSchema } from "../db/schema";

export const paymentSchema = z.object({
  id: z.string(),
  farmId: z.string(),
  contactId: z.string(),
  sponsorshipId: z.string().nullable(),
  orderId: z.string().nullable(),
  date: ez.dateOut(),
  amount: z.number(),
  currency: z.string(),
  method: paymentMethodSchema,
  notes: z.string().nullable(),
});
