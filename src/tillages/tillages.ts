import { eq, sql } from "drizzle-orm";
import { RlsDb } from "../db/db";
import { farmIdColumnValue, tillages, tillagePresets } from "../db/schema";
import { MultiPolygon } from "../geo/geojson";
import { Plot } from "../plots/plots";

export type TillagePreset = typeof tillagePresets.$inferSelect;
export type TillagePresetCreateInput = Omit<typeof tillagePresets.$inferInsert, "id" | "farmId">;
export type TillagePresetUpdateInput = Partial<TillagePresetCreateInput>;

export type TillageCreateInput = Omit<typeof tillages.$inferInsert, "id" | "farmId" | "geometry"> & {
  geometry: MultiPolygon;
};

export type TillageBatchCreateInput = {
  createdBy: string;
  date: Date;
  action: Tillage["action"];
  customAction?: string;
  additionalNotes?: string | null;
  plots: {
    plotId: string;
    geometry: MultiPolygon;
    size: number;
  }[];
};
// plot, geometry and size are fixed once an entry is created; only values can be edited
export type TillageUpdateInput = Partial<
  Pick<typeof tillages.$inferInsert, "action" | "customAction" | "date" | "additionalNotes">
>;

export type Tillage = typeof tillages.$inferSelect & {
  geometry: MultiPolygon;
  plot: Omit<Plot, "currentCropRotation" | "geometry">;
};

export function tillagesApi(rlsDb: RlsDb) {
  return {
    async createTillage(input: TillageCreateInput): Promise<Tillage> {
      const result = await rlsDb.rls(async (tx) => {
        const [tillage] = await tx
          .insert(tillages)
          .values({
            ...farmIdColumnValue,
            ...input,
            geometry: sql<MultiPolygon>`ST_GeomFromGeoJSON(${JSON.stringify(input.geometry)})`,
          })
          .returning();
        return tillage;
      });
      const tillage = await this.getTillageById(result.id);
      return tillage!;
    },
    async createTillages({ plots, ...base }: TillageBatchCreateInput): Promise<Tillage[]> {
      const result = await rlsDb.rls(async (tx) => {
        return tx
          .insert(tillages)
          .values(
            plots.map((plot) => ({
              ...farmIdColumnValue,
              ...base,
              ...plot,
              geometry: sql<MultiPolygon>`ST_GeomFromGeoJSON(${JSON.stringify(plot.geometry)})`,
            }))
          )
          .returning({ id: tillages.id });
      });
      return this.getTillagesByIds(result.map((application) => application.id))!;
    },
    async getTillagesByIds(ids: string[]): Promise<Tillage[]> {
      return rlsDb.rls(async (tx) => {
        return tx.query.tillages.findMany({
          where: { id: { in: ids } },
          with: {
            plot: true,
          },
          extras: {
            geometry: (t) => sql<MultiPolygon>`ST_AsGeoJSON(${t.geometry})::json`.as("geometry"),
          },
        });
      });
    },
    async getTillageById(id: string): Promise<Tillage | undefined> {
      return rlsDb.rls(async (tx) => {
        return tx.query.tillages.findFirst({
          where: { id },
          with: {
            plot: true,
          },
          extras: {
            geometry: (t) => sql<MultiPolygon>`ST_AsGeoJSON(${t.geometry})::json`.as("geometry"),
          },
        });
      });
    },
    async getTillagesForFarm(farmId: string, fromDate: Date, toDate: Date): Promise<Tillage[]> {
      return rlsDb.rls(async (tx) => {
        return tx.query.tillages.findMany({
          where: {
            farmId,
            AND: [{ date: { gte: fromDate } }, { date: { lte: toDate } }],
          },
          with: {
            plot: true,
          },
          extras: {
            geometry: (t) => sql<MultiPolygon>`ST_AsGeoJSON(${t.geometry})::json`.as("geometry"),
          },
          orderBy: { date: "desc" },
        });
      });
    },
    async getTillagesForPlot(plotId: string): Promise<Tillage[]> {
      return rlsDb.rls(async (tx) => {
        return tx.query.tillages.findMany({
          where: { plotId },
          with: {
            plot: true,
          },
          extras: {
            geometry: (t) => sql<MultiPolygon>`ST_AsGeoJSON(${t.geometry})::json`.as("geometry"),
          },
          orderBy: { date: "desc" },
        });
      });
    },
    async updateTillage(id: string, data: TillageUpdateInput): Promise<Tillage | undefined> {
      const { action, customAction, date, additionalNotes } = data;
      const values = { action, customAction, date, additionalNotes };
      const hasValues = Object.values(values).some((value) => value !== undefined);
      if (hasValues) {
        await rlsDb.rls(async (tx) => {
          await tx.update(tillages).set(values).where(eq(tillages.id, id));
        });
      }
      return this.getTillageById(id);
    },
    async deleteTillage(id: string): Promise<void> {
      return rlsDb.rls(async (tx) => {
        await tx.delete(tillages).where(eq(tillages.id, id));
      });
    },
    async getTillagesYears(): Promise<string[]> {
      return rlsDb.rls(async (tx) => {
        const result = await tx.query.tillages.findMany({
          columns: {
            date: true,
          },
          orderBy: { date: "desc" },
        });

        return Array.from(new Set(result.map((application) => application.date.getFullYear().toString())));
      });
    },
    async createTillagePreset(input: TillagePresetCreateInput): Promise<TillagePreset> {
      return rlsDb.rls(async (tx) => {
        const [preset] = await tx
          .insert(tillagePresets)
          .values({ ...farmIdColumnValue, ...input })
          .returning();
        return preset;
      });
    },
    async getTillagePresets(): Promise<TillagePreset[]> {
      return rlsDb.rls(async (tx) => {
        return tx.query.tillagePresets.findMany({
          orderBy: { name: "asc" },
        });
      });
    },
    async getTillagePresetById(id: string): Promise<TillagePreset | undefined> {
      return rlsDb.rls(async (tx) => {
        return tx.query.tillagePresets.findFirst({ where: { id } });
      });
    },
    async updateTillagePreset(id: string, input: TillagePresetUpdateInput): Promise<TillagePreset> {
      return rlsDb.rls(async (tx) => {
        const [preset] = await tx.update(tillagePresets).set(input).where(eq(tillagePresets.id, id)).returning();
        return preset;
      });
    },
    async deleteTillagePreset(id: string): Promise<void> {
      return rlsDb.rls(async (tx) => {
        await tx.delete(tillagePresets).where(eq(tillagePresets.id, id));
      });
    },
  };
}
