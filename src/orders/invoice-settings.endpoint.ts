import { z } from "zod";
import createHttpError from "http-errors";
import { farmEndpointFactory, permissionFarmEndpoint } from "../endpoint-factory";

const ordersWrite = permissionFarmEndpoint("commerce", "write");
import { InvoiceSettings } from "./invoice-settings";

export const invoiceSettingsSchema = z.object({
  id: z.string(),
  farmId: z.string(),
  name: z.string(),
  senderName: z.string(),
  street: z.string(),
  zip: z.string(),
  city: z.string(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  website: z.string().nullable(),
  iban: z.string().nullable(),
  bankName: z.string().nullable(),
  paymentTermsDays: z.number(),
  introText: z.string().nullable(),
  closingText: z.string().nullable(),
  hasLogo: z.boolean(),
  updatedAt: z.date(),
});

const invoiceSettingsCreateSchema = z.object({
  name: z.string(),
  senderName: z.string().optional(),
  street: z.string().optional(),
  zip: z.string().optional(),
  city: z.string().optional(),
  phone: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
  website: z.string().nullable().optional(),
  iban: z.string().nullable().optional(),
  bankName: z.string().nullable().optional(),
  paymentTermsDays: z.number().int().positive().optional(),
  introText: z.string().nullable().optional(),
  closingText: z.string().nullable().optional(),
});

const invoiceSettingsUpdateSchema = invoiceSettingsCreateSchema.partial();

type InvoiceSettingsResponse = Omit<InvoiceSettings, "logoData" | "logoMimeType"> & { hasLogo: boolean };

function toSettingsResponse(row: InvoiceSettings): InvoiceSettingsResponse {
  const { logoData, logoMimeType: _mimeType, ...rest } = row;
  return { ...rest, hasLogo: logoData !== null };
}

export const getInvoiceSettingsEndpoint = farmEndpointFactory.build({
  method: "get",
  input: z.object({}),
  output: z.object({ result: z.array(invoiceSettingsSchema) }),
  handler: async ({ ctx: { farmId, invoiceSettings } }) => {
    const rows = await invoiceSettings.listForFarm(farmId);
    return { result: rows.map(toSettingsResponse) };
  },
});

export const createInvoiceSettingsEndpoint = ordersWrite.build({
  method: "post",
  input: invoiceSettingsCreateSchema,
  output: invoiceSettingsSchema,
  handler: async ({ input, ctx: { farmId, invoiceSettings } }): Promise<InvoiceSettingsResponse> => {
    const row = await invoiceSettings.create(farmId, input);
    return toSettingsResponse(row);
  },
});

export const updateInvoiceSettingsEndpoint = ordersWrite.build({
  method: "put",
  input: z.object({ id: z.string(), ...invoiceSettingsUpdateSchema.shape }),
  output: invoiceSettingsSchema,
  handler: async ({ input, ctx: { invoiceSettings } }): Promise<InvoiceSettingsResponse> => {
    const { id, ...rest } = input;
    const row = await invoiceSettings.update(id, rest);
    if (!row) throw createHttpError(404, "Invoice settings not found");
    return toSettingsResponse(row);
  },
});

export const deleteInvoiceSettingsEndpoint = ordersWrite.build({
  method: "delete",
  input: z.object({ id: z.string() }),
  output: z.object({ success: z.boolean() }),
  handler: async ({ input, ctx: { invoiceSettings } }) => {
    await invoiceSettings.delete(input.id);
    return { success: true };
  },
});

export const uploadLogoEndpoint = ordersWrite.build({
  method: "put",
  input: z.object({
    id: z.string(),
    base64: z.string(),
    mimeType: z.enum(["jpg", "png"]),
  }),
  output: invoiceSettingsSchema,
  handler: async ({ input, ctx: { invoiceSettings } }): Promise<InvoiceSettingsResponse> => {
    // Strip data URI prefix if present (e.g. "data:image/png;base64,...")
    const raw = input.base64.replace(/^data:[^;]+;base64,/, "");
    const buffer = Buffer.from(raw, "base64");
    const row = await invoiceSettings.upsertLogo(input.id, buffer, input.mimeType);
    if (!row) throw createHttpError(404, "Invoice settings not found");
    return toSettingsResponse(row);
  },
});

export const deleteLogoEndpoint = ordersWrite.build({
  method: "delete",
  input: z.object({ id: z.string() }),
  output: z.object({ success: z.boolean() }),
  handler: async ({ input, ctx: { invoiceSettings } }) => {
    await invoiceSettings.deleteLogo(input.id);
    return { success: true };
  },
});
