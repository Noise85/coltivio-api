import { eq } from "drizzle-orm";
import { RlsDb } from "../db/db";
import { contacts, farmIdColumnValue } from "../db/schema";
import { Payment } from "../payments/payments";
import { SponsorshipWithRelations } from "../sponsorships/sponsorships";
import { Order } from "../orders/orders";
import { Animal } from "../animals/animals";

export type ContactCreateInput = Omit<typeof contacts.$inferInsert, "id" | "farmId">;
export type ContactUpdateInput = Partial<ContactCreateInput>;
export type Contact = typeof contacts.$inferSelect;

export type ContactWithRelations = Contact & {
  payments: Payment[];
  sponsorships: Array<
    Omit<
      Omit<SponsorshipWithRelations, "animal"> & {
        animal: Omit<Animal, "earTag">;
      },
      "contact" | "payments"
    >
  >;
  orders: Order[];
};

export function contactsApi(rlsDb: RlsDb) {
  return {
    async createContact(contactInput: ContactCreateInput): Promise<Contact> {
      return rlsDb.rls(async (tx) => {
        const [contact] = await tx
          .insert(contacts)
          .values({ ...farmIdColumnValue, ...contactInput })
          .returning();
        return contact;
      });
    },

    async getContactById(id: string): Promise<ContactWithRelations | undefined> {
      return rlsDb.rls(async (tx) => {
        return tx.query.contacts.findFirst({
          where: { id },
          with: {
            payments: true,
            sponsorships: {
              with: {
                animal: true,
                sponsorshipProgram: true,
              },
            },
            orders: true,
          },
        });
      });
    },

    async getContactsForFarm(farmId: string): Promise<Contact[]> {
      return rlsDb.rls(async (tx) => {
        return tx.select().from(contacts).where(eq(contacts.farmId, farmId));
      });
    },

    async updateContact(id: string, data: ContactUpdateInput): Promise<Contact> {
      return rlsDb.rls(async (tx) => {
        const [contact] = await tx.update(contacts).set(data).where(eq(contacts.id, id)).returning();
        return contact;
      });
    },

    async deleteContact(id: string): Promise<void> {
      return rlsDb.rls(async (tx) => {
        await tx.delete(contacts).where(eq(contacts.id, id));
      });
    },
  };
}
