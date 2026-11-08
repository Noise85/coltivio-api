import { eq } from "drizzle-orm";
import { RlsDb } from "../db/db";
import { sponsorships, payments, farmIdColumnValue } from "../db/schema";
import { Animal } from "../animals/animals";
import { Contact } from "../contacts/contacts";
import { Payment } from "../payments/payments";
import { SponsorshipPrograms } from "./sponsorship-programs";

export type SponsorshipCreateInput = Omit<typeof sponsorships.$inferInsert, "id" | "farmId">;
export type SponsorshipUpdateInput = Partial<SponsorshipCreateInput>;
export type Sponsorship = typeof sponsorships.$inferSelect;

export type SponsorshipWithRelations = Sponsorship & {
  sponsorshipProgram: SponsorshipPrograms;
  animal: Animal;
  contact: Contact;
  payments: Payment[];
};

export function sponsorshipsApi(rlsDb: RlsDb) {
  return {
    async createSponsorship(sponsorshipInput: SponsorshipCreateInput): Promise<Sponsorship> {
      return rlsDb.rls(async (tx) => {
        const [sponsorship] = await tx
          .insert(sponsorships)
          .values({ ...farmIdColumnValue, ...sponsorshipInput })
          .returning();
        return sponsorship;
      });
    },

    async getSponsorshipById(id: string): Promise<SponsorshipWithRelations | undefined> {
      return rlsDb.rls(async (tx) => {
        return tx.query.sponsorships.findFirst({
          where: { id },
          with: {
            sponsorshipProgram: true,
            animal: {
              with: {
                earTag: true,
              },
            },
            contact: true,
            payments: true,
          },
        });
      });
    },

    async getSponsorshipsForFarm(farmId: string, onlyActive: boolean): Promise<SponsorshipWithRelations[]> {
      return rlsDb.rls(async (tx) => {
        return tx.query.sponsorships.findMany({
          with: {
            sponsorshipProgram: true,
            animal: {
              with: {
                earTag: true,
              },
            },
            contact: true,
            payments: true,
          },
          where: onlyActive
            ? {
                farmId,
                endDate: { OR: [{ gte: new Date() }, { isNull: true }] },
              }
            : { farmId },
        });
      });
    },

    async getSponsorshipsForContact(
      contactId: string,
      onlyActive: boolean
    ): Promise<Array<Omit<SponsorshipWithRelations, "contact">>> {
      return rlsDb.rls(async (tx) => {
        return tx.query.sponsorships.findMany({
          with: {
            sponsorshipProgram: true,
            animal: {
              with: {
                earTag: true,
              },
            },
            payments: true,
          },
          where: onlyActive
            ? {
                contactId: contactId,
                endDate: { OR: [{ gte: new Date() }, { isNull: true }] },
              }
            : { contactId: contactId },
        });
      });
    },

    async getSponsorshipsForAnimal(
      animalId: string,
      onlyActive: boolean
    ): Promise<Array<Omit<SponsorshipWithRelations, "animal">>> {
      return rlsDb.rls(async (tx) => {
        return tx.query.sponsorships.findMany({
          with: {
            sponsorshipProgram: true,
            contact: true,
            payments: true,
          },
          where: onlyActive
            ? {
                animalId: animalId,
                endDate: { OR: [{ gte: new Date() }, { isNull: true }] },
              }
            : { animalId: animalId },
        });
      });
    },

    async getPaymentsForSponsorship(sponsorshipId: string): Promise<Payment[]> {
      return rlsDb.rls(async (tx) => {
        return tx.select().from(payments).where(eq(payments.sponsorshipId, sponsorshipId));
      });
    },

    async updateSponsorship(id: string, data: SponsorshipUpdateInput): Promise<Sponsorship> {
      return rlsDb.rls(async (tx) => {
        const [sponsorship] = await tx.update(sponsorships).set(data).where(eq(sponsorships.id, id)).returning();
        return sponsorship;
      });
    },

    async deleteSponsorship(id: string): Promise<void> {
      return rlsDb.rls(async (tx) => {
        await tx.delete(sponsorships).where(eq(sponsorships.id, id));
      });
    },
  };
}
