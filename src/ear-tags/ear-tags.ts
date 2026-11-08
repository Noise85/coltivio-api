import { and, eq, inArray, isNotNull, notInArray } from "drizzle-orm";
import { RlsDb } from "../db/db";
import { animals, earTags, farmIdColumnValue } from "../db/schema";
import { Animal } from "../animals/animals";

export type EarTag = typeof earTags.$inferSelect;
export type EarTagWithAssignment = EarTag & { animal: Animal | null };

export function earTagsApi(rlsDb: RlsDb) {
  return {
    async getEarTagsForFarm(farmId: string): Promise<EarTagWithAssignment[]> {
      return rlsDb.rls(async (tx) => {
        return tx.query.earTags.findMany({
          where: { farmId },
          with: {
            animal: {
              with: {
                earTag: true,
              },
            },
          },
        });
      });
    },

    // Get only unassigned ear tags
    async getAvailableEarTagsForFarm(farmId: string): Promise<EarTag[]> {
      return rlsDb.rls(async (tx) => {
        // Get IDs of ear tags that are assigned to animals
        const assignedTagIds = tx
          .select({ earTagId: animals.earTagId })
          .from(animals)
          .where(and(eq(animals.farmId, farmId), isNotNull(animals.earTagId)));

        // Get ear tags that are not in the assigned list
        const tags = await tx
          .select()
          .from(earTags)
          .where(and(eq(earTags.farmId, farmId), notInArray(earTags.id, assignedTagIds)));
        return tags;
      });
    },

    // Create a range of ear tag numbers (e.g., from "CH001" to "CH010")
    async createEarTagRange(fromNumber: string, toNumber: string): Promise<EarTag[]> {
      return rlsDb.rls(async (tx) => {
        // Extract prefix and numeric parts from both numbers
        const fromMatch = fromNumber.match(/^([A-Za-z]*)(\d+)$/);
        const toMatch = toNumber.match(/^([A-Za-z]*)(\d+)$/);

        if (!fromMatch || !toMatch) {
          throw new Error("Invalid ear tag format. Expected format: PREFIX + NUMBER (e.g., CH001)");
        }

        const [, fromPrefix, fromNumStr] = fromMatch;
        const [, toPrefix, toNumStr] = toMatch;

        if (fromPrefix !== toPrefix) {
          throw new Error("Prefix must be the same for both range boundaries");
        }

        const fromNum = parseInt(fromNumStr, 10);
        const toNum = parseInt(toNumStr, 10);

        if (fromNum > toNum) {
          throw new Error("Start number must be less than or equal to end number");
        }

        const padding = fromNumStr.length;
        const tagsToCreate: { number: string }[] = [];

        for (let i = fromNum; i <= toNum; i++) {
          const paddedNum = i.toString().padStart(padding, "0");
          tagsToCreate.push({ number: `${fromPrefix}${paddedNum}` });
        }

        const createdTags = await tx
          .insert(earTags)
          .values(
            tagsToCreate.map((tag) => ({
              ...farmIdColumnValue,
              ...tag,
            }))
          )
          .returning();

        return createdTags;
      });
    },

    // Delete a range of ear tag numbers (only unassigned ones)
    async deleteEarTagRange(
      farmId: string,
      fromNumber: string,
      toNumber: string
    ): Promise<{ deletedCount: number; skippedAssigned: string[] }> {
      return rlsDb.rls(async (tx) => {
        // Extract prefix and numeric parts from both numbers
        const fromMatch = fromNumber.match(/^([A-Za-z]*)(\d+)$/);
        const toMatch = toNumber.match(/^([A-Za-z]*)(\d+)$/);

        if (!fromMatch || !toMatch) {
          throw new Error("Invalid ear tag format. Expected format: PREFIX + NUMBER (e.g., CH001)");
        }

        const [, fromPrefix, fromNumStr] = fromMatch;
        const [, toPrefix, toNumStr] = toMatch;

        if (fromPrefix !== toPrefix) {
          throw new Error("Prefix must be the same for both range boundaries");
        }

        const fromNum = parseInt(fromNumStr, 10);
        const toNum = parseInt(toNumStr, 10);

        if (fromNum > toNum) {
          throw new Error("Start number must be less than or equal to end number");
        }

        // Generate all numbers in range
        const padding = fromNumStr.length;
        const numbersInRange: string[] = [];
        for (let i = fromNum; i <= toNum; i++) {
          const paddedNum = i.toString().padStart(padding, "0");
          numbersInRange.push(`${fromPrefix}${paddedNum}`);
        }

        // Find all ear tags in range with their assignment status
        const tagsInRange = await tx
          .select({
            id: earTags.id,
            number: earTags.number,
            animalId: animals.id,
          })
          .from(earTags)
          .leftJoin(animals, eq(animals.earTagId, earTags.id))
          .where(and(eq(earTags.farmId, farmId), inArray(earTags.number, numbersInRange)));

        // Separate assigned and unassigned tags
        const assignedNumbers: string[] = [];
        const unassignedTagIds: string[] = [];

        for (const tag of tagsInRange) {
          if (tag.animalId) {
            assignedNumbers.push(tag.number);
          } else {
            unassignedTagIds.push(tag.id);
          }
        }

        // Delete only unassigned tags
        if (unassignedTagIds.length > 0) {
          await tx.delete(earTags).where(inArray(earTags.id, unassignedTagIds));
        }

        return {
          deletedCount: unassignedTagIds.length,
          skippedAssigned: assignedNumbers,
        };
      });
    },

    async getEarTagById(id: string): Promise<EarTagWithAssignment | undefined> {
      return rlsDb.rls(async (tx) => {
        return tx.query.earTags.findFirst({
          where: { id },
          with: {
            animal: {
              with: {
                earTag: true,
              },
            },
          },
        });
      });
    },

    // Batch create ear tags from an array of numbers
    async createEarTags(numbers: string[]): Promise<EarTag[]> {
      if (numbers.length === 0) return [];
      return rlsDb.rls(async (tx) => {
        const createdTags = await tx
          .insert(earTags)
          .values(numbers.map((number) => ({ ...farmIdColumnValue, number })))
          .returning();
        return createdTags;
      });
    },
  };
}
