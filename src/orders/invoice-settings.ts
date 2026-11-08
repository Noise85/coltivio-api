import { eq } from "drizzle-orm";
import { RlsDb } from "../db/db";
import { invoiceSettings, farmIdColumnValue } from "../db/schema";

export type InvoiceSettings = typeof invoiceSettings.$inferSelect;
export type InvoiceSettingsCreateInput = Omit<typeof invoiceSettings.$inferInsert, "id" | "farmId" | "updatedAt">;
export type InvoiceSettingsUpdateInput = Partial<InvoiceSettingsCreateInput>;

export function invoiceSettingsApi(rlsDb: RlsDb) {
  return {
    async listForFarm(farmId: string): Promise<InvoiceSettings[]> {
      return rlsDb.rls((tx) => tx.query.invoiceSettings.findMany({ where: { farmId } }));
    },

    async getById(id: string): Promise<InvoiceSettings | null> {
      return rlsDb.rls(async (tx) => {
        const result = await tx.query.invoiceSettings.findFirst({ where: { id } });
        return result ?? null;
      });
    },

    async create(farmId: string, input: InvoiceSettingsCreateInput): Promise<InvoiceSettings> {
      return rlsDb.rls(async (tx) => {
        const [row] = await tx
          .insert(invoiceSettings)
          .values({ ...farmIdColumnValue, ...input, updatedAt: new Date() })
          .returning();
        return row;
      });
    },

    async update(id: string, input: InvoiceSettingsUpdateInput): Promise<InvoiceSettings> {
      return rlsDb.rls(async (tx) => {
        const [row] = await tx
          .update(invoiceSettings)
          .set({ ...input, updatedAt: new Date() })
          .where(eq(invoiceSettings.id, id))
          .returning();
        return row;
      });
    },

    async delete(id: string): Promise<void> {
      await rlsDb.rls((tx) => tx.delete(invoiceSettings).where(eq(invoiceSettings.id, id)));
    },

    async upsertLogo(id: string, logoData: Buffer, logoMimeType: string): Promise<InvoiceSettings> {
      return rlsDb.rls(async (tx) => {
        const [row] = await tx
          .update(invoiceSettings)
          .set({ logoData, logoMimeType, updatedAt: new Date() })
          .where(eq(invoiceSettings.id, id))
          .returning();
        return row;
      });
    },

    async deleteLogo(id: string): Promise<void> {
      await rlsDb.rls((tx) =>
        tx
          .update(invoiceSettings)
          .set({ logoData: null, logoMimeType: null, updatedAt: new Date() })
          .where(eq(invoiceSettings.id, id))
      );
    },
  };
}
