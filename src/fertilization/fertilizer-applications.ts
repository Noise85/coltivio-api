import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { RlsDb } from "../db/db";
import {
  farmIdColumnValue,
  fertilizerApplications,
  fertilizers,
  plots,
  fertilizerUnitSchema,
  fertilizationMethodSchema,
  fertilizerApplicationUnitSchema,
  fertilizerApplicationPresets,
} from "../db/schema";
import { MultiPolygon } from "../geo/geojson";

export type FertilizerApplicationPreset = typeof fertilizerApplicationPresets.$inferSelect & {
  fertilizer: typeof fertilizers.$inferSelect;
};
export type FertilizerApplicationPresetCreateInput = Omit<
  typeof fertilizerApplicationPresets.$inferInsert,
  "id" | "farmId"
>;
export type FertilizerApplicationPresetUpdateInput = Partial<FertilizerApplicationPresetCreateInput>;

export type FertilizerApplicationUnit = z.infer<typeof fertilizerApplicationUnitSchema>;
export type FertilizerUnit = z.infer<typeof fertilizerUnitSchema>;
export type FertilizationMethod = z.infer<typeof fertilizationMethodSchema>;

type _CreateFertilizerApplicationInput = {
  plotId: string;
  date: Date;
  createdBy: string;
  unit: FertilizerApplicationUnit;
  method: FertilizationMethod;
  fertilizerId: string;
  amountPerApplication: number;
  numberOfApplications: number;
  geometry: MultiPolygon;
  size: number;
  additionalNotes?: string;
};
export type FertilizerApplicationApplicationBatchCreateInput = {
  date: Date;
  createdBy: string;
  unit: FertilizerApplicationUnit;
  method?: FertilizationMethod;
  fertilizerId: string;
  amountPerUnit: number;
  additionalNotes?: string;
  plots: {
    plotId: string;
    geometry: MultiPolygon;
    size: number;
    numberOfUnits: number;
  }[];
};

// plot, geometry and size are fixed once an entry is created; only values can be edited
export type FertilizerApplicationUpdateInput = Partial<
  Pick<
    typeof fertilizerApplications.$inferInsert,
    "date" | "unit" | "method" | "amountPerUnit" | "numberOfUnits" | "fertilizerId" | "additionalNotes"
  >
>;

type FertilizerApplication = Omit<typeof fertilizerApplications.$inferSelect, "geometry"> & {
  geometry: MultiPolygon;
  fertilizer: typeof fertilizers.$inferSelect;
  plot: Pick<typeof plots.$inferSelect, "id" | "name">;
};

interface AppliedFertilizer {
  totalAmount: number;
  totalProducedUnits: number;
  fertilizerName: string;
  unit: FertilizerUnit;
}
interface MonthlyApplication {
  year: number;
  month: number;
  appliedFertilizers: AppliedFertilizer[];
}

export interface FertilizationApplicationSummary {
  monthlyApplications: MonthlyApplication[];
}

export function fertilizerApplicationsApi(rlsDb: RlsDb) {
  return {
    async createFertilizerApplications({
      plots,
      ...base
    }: FertilizerApplicationApplicationBatchCreateInput): Promise<FertilizerApplication[]> {
      const result = await rlsDb.rls(async (tx) => {
        return tx
          .insert(fertilizerApplications)
          .values(
            plots.map((plot) => ({
              ...farmIdColumnValue,
              ...base,
              ...plot,
              geometry: sql<MultiPolygon>`ST_GeomFromGeoJSON(${JSON.stringify(plot.geometry)})`,
            }))
          )
          .returning({ id: fertilizerApplications.id });
      });
      return this.getFertilizerApplicationsByIds(result.map((application) => application.id))!;
    },
    async getFertilizerApplicationsByIds(ids: string[]): Promise<FertilizerApplication[]> {
      return rlsDb.rls(async (tx) => {
        return tx.query.fertilizerApplications.findMany({
          where: { id: { in: ids } },
          with: {
            fertilizer: true,
            plot: {
              columns: {
                id: true,
                name: true,
              },
            },
          },
          extras: {
            geometry: (t) => sql<MultiPolygon>`ST_AsGeoJSON(${t.geometry})::json`.as("geometry"),
          },
        });
      });
    },

    async getFertilizerApplicationById(id: string): Promise<FertilizerApplication | undefined> {
      return rlsDb.rls(async (tx) => {
        return tx.query.fertilizerApplications.findFirst({
          where: { id },
          with: {
            fertilizer: true,
            plot: {
              columns: {
                id: true,
                name: true,
              },
            },
          },
          extras: {
            geometry: (t) => sql<MultiPolygon>`ST_AsGeoJSON(${t.geometry})::json`.as("geometry"),
          },
        });
      });
    },

    async getFertilizerApplicationsForFarm(
      farmId: string,
      fromDate: Date,
      toDate: Date
    ): Promise<FertilizerApplication[]> {
      return rlsDb.rls(async (tx) => {
        return tx.query.fertilizerApplications.findMany({
          where: {
            farmId,
            AND: [{ date: { gte: fromDate } }, { date: { lte: toDate } }],
          },
          with: {
            plot: {
              columns: {
                id: true,
                name: true,
              },
            },
            fertilizer: true,
          },
          extras: {
            geometry: (t) => sql<MultiPolygon>`ST_AsGeoJSON(${t.geometry})::json`.as("geometry"),
          },
          orderBy: { date: "desc" },
        });
      });
    },

    async getFertilizerApplicationsForPlot(plotId: string): Promise<Omit<FertilizerApplication, "plot">[]> {
      return rlsDb.rls(async (tx) => {
        return tx.query.fertilizerApplications.findMany({
          where: { plotId },
          with: {
            fertilizer: true,
          },
          extras: {
            geometry: (t) => sql<MultiPolygon>`ST_AsGeoJSON(${t.geometry})::json`.as("geometry"),
          },
          orderBy: { date: "desc" },
        });
      });
    },

    async updateFertilizerApplication(
      id: string,
      data: FertilizerApplicationUpdateInput
    ): Promise<FertilizerApplication | undefined> {
      const { date, unit, method, amountPerUnit, numberOfUnits, fertilizerId, additionalNotes } = data;
      const values = { date, unit, method, amountPerUnit, numberOfUnits, fertilizerId, additionalNotes };
      const hasValues = Object.values(values).some((value) => value !== undefined);
      if (hasValues) {
        await rlsDb.rls(async (tx) => {
          await tx.update(fertilizerApplications).set(values).where(eq(fertilizerApplications.id, id));
        });
      }
      return this.getFertilizerApplicationById(id);
    },

    async deleteFertilizerApplication(id: string): Promise<void> {
      await rlsDb.rls(async (tx) => {
        await tx.delete(fertilizerApplications).where(eq(fertilizerApplications.id, id));
      });
    },

    async getFertilizerApplicationYears(): Promise<string[]> {
      return rlsDb.rls(async (tx) => {
        const result = await tx.query.fertilizerApplications.findMany({
          columns: {
            date: true,
          },
          orderBy: { date: "desc" },
        });

        return Array.from(new Set(result.map((application) => application.date.getFullYear().toString())));
      });
    },

    async getFertilizerApplicationSummaryForFarm(farmId: string): Promise<FertilizationApplicationSummary> {
      // return { monthlyApplications: [] };
      return rlsDb.rls(async (tx) => {
        const result = await tx.query.fertilizerApplications.findMany({
          where: { farmId },
          columns: {
            numberOfUnits: true,
            amountPerUnit: true,
            unit: true,
            date: true,
          },
          with: {
            fertilizer: {
              columns: {
                name: true,
                unit: true,
              },
            },
          },
        });
        return mapToMonthlySummary(result);
      });
    },
    async getFertilizerApplicationSummaryForPlot(plotId: string): Promise<FertilizationApplicationSummary> {
      return rlsDb.rls(async (tx) => {
        const result = await tx.query.fertilizerApplications.findMany({
          where: { plotId },
          columns: {
            numberOfUnits: true,
            amountPerUnit: true,
            unit: true,
            date: true,
          },
          with: {
            fertilizer: {
              columns: {
                name: true,
                unit: true,
              },
            },
          },
        });
        return mapToMonthlySummary(result);
      });
    },
    async createFertilizerApplicationPreset(
      input: FertilizerApplicationPresetCreateInput
    ): Promise<FertilizerApplicationPreset> {
      const result = await rlsDb.rls(async (tx) => {
        const [preset] = await tx
          .insert(fertilizerApplicationPresets)
          .values({ ...farmIdColumnValue, ...input })
          .returning();
        return preset;
      });
      const preset = await this.getFertilizerApplicationPresetById(result.id);
      return preset!;
    },
    async getFertilizerApplicationPresets(): Promise<FertilizerApplicationPreset[]> {
      return rlsDb.rls(async (tx) => {
        return tx.query.fertilizerApplicationPresets.findMany({
          with: { fertilizer: true },
          orderBy: { name: "asc" },
        });
      });
    },
    async getFertilizerApplicationPresetById(id: string): Promise<FertilizerApplicationPreset | undefined> {
      return rlsDb.rls(async (tx) => {
        return tx.query.fertilizerApplicationPresets.findFirst({
          where: { id },
          with: { fertilizer: true },
        });
      });
    },
    async updateFertilizerApplicationPreset(
      id: string,
      input: FertilizerApplicationPresetUpdateInput
    ): Promise<FertilizerApplicationPreset> {
      const result = await rlsDb.rls(async (tx) => {
        const [preset] = await tx
          .update(fertilizerApplicationPresets)
          .set(input)
          .where(eq(fertilizerApplicationPresets.id, id))
          .returning();
        return preset;
      });
      const preset = await this.getFertilizerApplicationPresetById(result.id);
      return preset!;
    },
    async deleteFertilizerApplicationPreset(id: string): Promise<void> {
      return rlsDb.rls(async (tx) => {
        await tx.delete(fertilizerApplicationPresets).where(eq(fertilizerApplicationPresets.id, id));
      });
    },
  };

  function mapToMonthlySummary(
    result: {
      numberOfUnits: number;
      amountPerUnit: number;
      date: Date;
      fertilizer: { name: string; unit: FertilizerUnit };
    }[]
  ) {
    const applications = result.reduce<{
      [key: string]: {
        month: number;
        year: number;
        appliedFertilizers: Record<
          string,
          { totalAmount: number; totalProducedUnits: number; unit: FertilizerUnit; fertilizerName: string }
        >;
      };
    }>((acc, application) => {
      const date = application.date;
      const year = date.getFullYear();
      const month = date.getMonth(); // getMonth() is zero-based
      const fertilizerName = application.fertilizer.name;

      const key = `${year}-${month}`;
      if (!acc[key]) {
        acc[key] = {
          month,
          year,
          appliedFertilizers: {
            [fertilizerName]: {
              totalAmount: 0,
              totalProducedUnits: 0,
              unit: application.fertilizer.unit,
              fertilizerName,
            },
          },
        };
      }
      if (!acc[key].appliedFertilizers[fertilizerName]) {
        acc[key].appliedFertilizers[fertilizerName] = {
          totalAmount: application.numberOfUnits * application.amountPerUnit,
          totalProducedUnits: application.numberOfUnits,
          unit: application.fertilizer.unit,
          fertilizerName,
        };
      } else {
        acc[key].appliedFertilizers[fertilizerName].totalAmount +=
          application.numberOfUnits * application.amountPerUnit;
        acc[key].appliedFertilizers[fertilizerName].totalProducedUnits += application.numberOfUnits;
      }
      return acc;
    }, {});
    return {
      monthlyApplications: Object.values(applications).map(({ year, month, appliedFertilizers }) => ({
        year,
        month,
        appliedFertilizers: Object.values(appliedFertilizers),
      })),
    };
  }
}
