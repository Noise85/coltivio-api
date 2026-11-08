import { eq } from "drizzle-orm";
import { RlsDb } from "../db/db";
import { sponsorshipPrograms, farmIdColumnValue } from "../db/schema";

export type SponsorshipProgramCreateInput = Omit<typeof sponsorshipPrograms.$inferInsert, "id" | "farmId">;
export type SponsorshipProgramUpdateInput = Partial<SponsorshipProgramCreateInput>;
export type SponsorshipPrograms = typeof sponsorshipPrograms.$inferSelect;

export function sponsorshipProgramsApi(rlsDb: RlsDb) {
  return {
    async createSponsorshipProgram(input: SponsorshipProgramCreateInput): Promise<SponsorshipPrograms> {
      return rlsDb.rls(async (tx) => {
        const [sponsorshipProgram] = await tx
          .insert(sponsorshipPrograms)
          .values({ ...farmIdColumnValue, ...input })
          .returning();
        return sponsorshipProgram;
      });
    },

    async getSponsorshipProgramById(id: string): Promise<SponsorshipPrograms | undefined> {
      return rlsDb.rls(async (tx) => {
        const [sponsorshipProgram] = await tx.select().from(sponsorshipPrograms).where(eq(sponsorshipPrograms.id, id));
        return sponsorshipProgram;
      });
    },

    async getSponsorshipProgramsForFarm(farmId: string): Promise<SponsorshipPrograms[]> {
      return rlsDb.rls(async (tx) => {
        return tx.select().from(sponsorshipPrograms).where(eq(sponsorshipPrograms.farmId, farmId));
      });
    },

    async updateSponsorshipProgram(id: string, data: SponsorshipProgramUpdateInput): Promise<SponsorshipPrograms> {
      return rlsDb.rls(async (tx) => {
        const [sponsorshipProgram] = await tx
          .update(sponsorshipPrograms)
          .set(data)
          .where(eq(sponsorshipPrograms.id, id))
          .returning();
        return sponsorshipProgram;
      });
    },

    async deleteSponsorshipProgram(id: string): Promise<void> {
      return rlsDb.rls(async (tx) => {
        await tx.delete(sponsorshipPrograms).where(eq(sponsorshipPrograms.id, id));
      });
    },
  };
}
