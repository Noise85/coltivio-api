import { eq, sql } from "drizzle-orm";
import createHttpError from "http-errors";
import { RlsDb } from "../db/db";
import { farmIdColumnValue, meadows } from "../db/schema";
import { MultiPolygon } from "../geo/geojson";
import { addYears } from "date-fns";
import { buildMeadowJournal, expandOutdoorSchedule, MeadowJournalEntry } from "../animals/outdoor-journal";
import { todayUtcDay } from "../animals/animals";

export type Meadow = Omit<typeof meadows.$inferSelect, "geometry"> & {
  geometry: MultiPolygon;
};

export type MeadowCreateInput = {
  name: string;
  geometry: MultiPolygon;
  additionalNotes?: string | null;
};

export type MeadowUpdateInput = Partial<MeadowCreateInput> & { archived?: boolean };

// Geometry and size (square meters via LV95) for a GeoJSON input. Meadows built from plots are merged by the client.
function geometryAndSize(geometry: MultiPolygon) {
  const geometrySql = sql<MultiPolygon>`ST_ForcePolygonCCW(ST_Multi(ST_GeomFromGeoJSON(${JSON.stringify(geometry)})))`;
  return {
    geometry: geometrySql,
    size: sql<number>`ROUND(ST_Area(ST_Transform(${geometrySql}, 2056)))`,
  };
}

export function meadowsApi(rlsDb: RlsDb) {
  return {
    async getMeadows(includeArchived: boolean = false): Promise<Meadow[]> {
      return rlsDb.rls(async (tx) => {
        return tx.query.meadows.findMany({
          where: includeArchived ? undefined : { archivedAt: { isNull: true } },
          orderBy: { name: "asc" },
          extras: {
            geometry: (t) => sql<MultiPolygon>`ST_AsGeoJSON(${t.geometry})::json`.as("geometry"),
          },
        });
      });
    },

    async getMeadowById(id: string): Promise<Meadow | undefined> {
      return rlsDb.rls(async (tx) => {
        return tx.query.meadows.findFirst({
          where: { id },
          extras: {
            geometry: (t) => sql<MultiPolygon>`ST_AsGeoJSON(${t.geometry})::json`.as("geometry"),
          },
        });
      });
    },

    async createMeadow(input: MeadowCreateInput): Promise<Meadow> {
      const [meadow] = await rlsDb.rls(async (tx) => {
        return tx
          .insert(meadows)
          .values({
            ...farmIdColumnValue,
            name: input.name,
            additionalNotes: input.additionalNotes ?? null,
            ...geometryAndSize(input.geometry),
          })
          .returning({ id: meadows.id });
      });

      const created = await this.getMeadowById(meadow.id);
      return created!;
    },

    async updateMeadow(id: string, input: MeadowUpdateInput): Promise<Meadow> {
      await rlsDb.rls(async (tx) => {
        const existing = await tx.query.meadows.findFirst({ where: { id }, columns: { id: true, archivedAt: true } });
        if (!existing) throw createHttpError(404, "Meadow not found");

        // A meadow can only be archived once no schedule on it runs today or later (open-ended, ending in the
        // future or with upcoming recurrences). Those schedules have to be ended or moved to another meadow first.
        if (input.archived && !existing.archivedAt) {
          const meadowSchedules = await tx.query.outdoorSchedules.findMany({
            where: { meadowId: id },
            with: { recurrence: true },
          });
          const today = todayUtcDay();
          const farFuture = addYears(today, 100);
          const hasRunningSchedule = meadowSchedules.some(
            (schedule) => expandOutdoorSchedule(schedule, today, farFuture).length > 0
          );
          if (hasRunningSchedule) {
            throw createHttpError(409, "Meadow has running outdoor schedules");
          }
        }

        // Only run the update if there are fields to set (avoids Drizzle "No values to set" error)
        if (
          input.name !== undefined ||
          input.additionalNotes !== undefined ||
          input.geometry ||
          input.archived !== undefined
        ) {
          await tx
            .update(meadows)
            .set({
              name: input.name,
              additionalNotes: input.additionalNotes,
              ...(input.archived !== undefined ? { archivedAt: input.archived ? new Date() : null } : {}),
              ...(input.geometry ? geometryAndSize(input.geometry) : {}),
            })
            .where(eq(meadows.id, id));
        }
      });

      const updated = await this.getMeadowById(id);
      return updated!;
    },

    // Cascades to the outdoor schedules on this meadow (via FK). Archive the meadow instead to keep its history.
    async deleteMeadow(id: string): Promise<void> {
      return rlsDb.rls(async (tx) => {
        await tx.delete(meadows).where(eq(meadows.id, id));
      });
    },

    async getMeadowUsage(meadowId: string, fromDate: Date, toDate: Date): Promise<MeadowJournalEntry[]> {
      return rlsDb.rls(async (tx) => {
        const meadow = await tx.query.meadows.findFirst({ where: { id: meadowId }, columns: { id: true } });
        if (!meadow) throw createHttpError(404, "Meadow not found");

        const herds = await tx.query.herds.findMany({
          with: {
            herdMemberships: { with: { animal: true } },
            outdoorSchedules: {
              where: { meadowId },
              with: { recurrence: true, meadow: { columns: { id: true, name: true, size: true } } },
            },
          },
        });
        return buildMeadowJournal(herds, fromDate, toDate);
      });
    },
  };
}
