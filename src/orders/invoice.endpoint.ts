import { z } from "zod";
import createHttpError from "http-errors";
import { farmEndpointFactory } from "../endpoint-factory";

export const downloadInvoiceEndpoint = farmEndpointFactory.build({
  method: "post",
  input: z.object({ orderId: z.string(), settingsId: z.string() }),
  output: z.object({ base64: z.string(), fileName: z.string() }),
  handler: async ({ input, ctx }) => {
    try {
      return await ctx.invoices.downloadInvoice(input.orderId, ctx.farmId, input.settingsId, ctx.token);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Unknown error";
      if (msg === "Order not found") throw createHttpError(404, msg);
      if (msg === "Invoice settings not configured") throw createHttpError(400, msg);
      throw e;
    }
  },
});

export const downloadInvoicesBatchEndpoint = farmEndpointFactory.build({
  method: "post",
  input: z.object({
    orderIds: z.array(z.string()).min(1).max(100),
    settingsId: z.string(),
    mode: z.enum(["single", "zip"]).default("single"),
  }),
  output: z.object({ base64: z.string(), fileName: z.string() }),
  handler: async ({ input, ctx }) => {
    try {
      return await ctx.invoices.downloadInvoicesBatch(
        input.orderIds,
        ctx.farmId,
        input.settingsId,
        ctx.token,
        input.mode
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Unknown error";
      if (msg.startsWith("Order not found")) throw createHttpError(404, msg);
      if (msg === "Invoice settings not configured") throw createHttpError(400, msg);
      throw e;
    }
  },
});
