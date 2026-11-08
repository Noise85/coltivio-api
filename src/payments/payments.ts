import { eq } from "drizzle-orm";
import { RlsDb } from "../db/db";
import { payments, farmIdColumnValue } from "../db/schema";
import { Contact } from "../contacts/contacts";
import { Sponsorship } from "../sponsorships/sponsorships";
import { Order } from "../orders/orders";

export type PaymentCreateInput = Omit<typeof payments.$inferInsert, "id" | "farmId">;
export type PaymentUpdateInput = Partial<PaymentCreateInput>;
export type Payment = typeof payments.$inferSelect;

export type PaymentWithRelations = Payment & {
  contact: Contact;
  sponsorship: Sponsorship | null;
  order: Order | null;
};

export function paymentsApi(rlsDb: RlsDb) {
  return {
    async createPayment(paymentInput: PaymentCreateInput): Promise<Payment> {
      return rlsDb.rls(async (tx) => {
        const [payment] = await tx
          .insert(payments)
          .values({ ...farmIdColumnValue, ...paymentInput })
          .returning();
        return payment;
      });
    },

    async getPaymentById(id: string): Promise<PaymentWithRelations | undefined> {
      return rlsDb.rls(async (tx) => {
        return tx.query.payments.findFirst({
          where: { id },
          with: {
            contact: true,
            sponsorship: true,
            order: true,
          },
        });
      });
    },

    async getPaymentsForFarm(farmId: string): Promise<PaymentWithRelations[]> {
      return rlsDb.rls(async (tx) => {
        return tx.query.payments.findMany({
          with: {
            contact: true,
            sponsorship: true,
            order: true,
          },
          where: { farmId },
        });
      });
    },

    async getPaymentsForContact(contactId: string): Promise<Omit<PaymentWithRelations, "contact">[]> {
      return rlsDb.rls(async (tx) => {
        return tx.query.payments.findMany({
          with: {
            sponsorship: true,
            order: true,
          },
          where: { contactId },
        });
      });
    },

    async getPaymentsForOrder(orderId: string): Promise<Payment[]> {
      return rlsDb.rls(async (tx) => {
        return tx.select().from(payments).where(eq(payments.orderId, orderId));
      });
    },

    async updatePayment(id: string, data: PaymentUpdateInput): Promise<Payment> {
      return rlsDb.rls(async (tx) => {
        const [payment] = await tx.update(payments).set(data).where(eq(payments.id, id)).returning();
        return payment;
      });
    },

    async getPaymentsForSponsorship(sponsorshipId: string): Promise<Payment[]> {
      return rlsDb.rls(async (tx) => {
        return tx.select().from(payments).where(eq(payments.sponsorshipId, sponsorshipId));
      });
    },

    async deletePayment(id: string): Promise<void> {
      return rlsDb.rls(async (tx) => {
        await tx.delete(payments).where(eq(payments.id, id));
      });
    },
  };
}
