import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { RlsDb } from "../db/db";
import * as tables from "../db/schema";
import { MultiPolygon } from "../geo/geojson";
import { Plot } from "../plots/plots";

export type HarvestPreset = typeof tables.harvestPresets.$inferSelect;
export type HarvestPresetCreateInput = Omit<typeof tables.harvestPresets.$inferInsert, "id" | "farmId">;
export type HarvestPresetUpdateInput = Partial<HarvestPresetCreateInput>;

export type Harvest = Omit<typeof tables.harvests.$inferSelect, "geometry"> & {
  geometry: MultiPolygon;
  crop: typeof tables.crops.$inferSelect;
  plot: Omit<Plot, "currentCropRotation">;
};

export type HarvestCreateInput = {
  date: Date;
  plotId: string;
  cropId: string;
  conservationMethod: z.infer<typeof tables.conservationMethodEnumSchema>;
  producedUnits: number;
  kilosPerUnit: number;
  createdBy: string;
  harvestCount?: number | null;
  unit: z.infer<typeof tables.harvestUnitsSchema>;
  additionalNotes?: string | null;
};
export type HarvestsBatchCreateInput = {
  date: Date;
  cropId: string;
  conservationMethod?: z.infer<typeof tables.conservationMethodEnumSchema> | null;
  kilosPerUnit: number;
  createdBy: string;
  harvestCount?: number | null;
  unit: z.infer<typeof tables.harvestUnitsSchema>;
  additionalNotes?: string | null;
  plots: {
    plotId: string;
    geometry: MultiPolygon;
    size: number;
    numberOfUnits: number;
  }[];
};
// plot, geometry and size are fixed once an entry is created; only values can be edited
export type HarvestUpdateInput = Partial<
  Pick<
    typeof tables.harvests.$inferInsert,
    | "date"
    | "cropId"
    | "conservationMethod"
    | "unit"
    | "kilosPerUnit"
    | "numberOfUnits"
    | "harvestCount"
    | "additionalNotes"
  >
>;

interface ProducedQuantity {
  totalAmountInKilos: number;
  forageName: string;
  conservationMethod: string | null;
  producedUnits: {
    unit: string;
    totalAmountInKilos: number;
    totalProducedUnits: number;
  }[];
}

interface MonthlyHarvest {
  year: number;
  month: number;
  producedQuantities: ProducedQuantity[];
}

export interface HarvestSummary {
  monthlyHarvests: MonthlyHarvest[];
}

export function harvestsApi(rlsDb: RlsDb) {
  return {
    async createHarvests({ plots, ...base }: HarvestsBatchCreateInput): Promise<Harvest[]> {
      const result = await rlsDb.rls(async (tx) => {
        const harvests = await tx
          .insert(tables.harvests)
          .values(
            plots.map((plot) => ({
              ...tables.farmIdColumnValue,
              ...base,
              ...plot,
              geometry: sql<MultiPolygon>`ST_GeomFromGeoJSON(${JSON.stringify(plot.geometry)})`,
            }))
          )
          .returning({
            id: tables.harvests.id,
          });

        return harvests;
      });
      return this.getHarvestsByIds(result.map((harvest) => harvest.id))!;
    },
    async updateHarvest(id: string, data: HarvestUpdateInput): Promise<Harvest | undefined> {
      const { date, cropId, conservationMethod, unit, kilosPerUnit, numberOfUnits, harvestCount, additionalNotes } =
        data;
      const values = {
        date,
        cropId,
        conservationMethod,
        unit,
        kilosPerUnit,
        numberOfUnits,
        harvestCount,
        additionalNotes,
      };
      const hasValues = Object.values(values).some((value) => value !== undefined);
      if (hasValues) {
        await rlsDb.rls(async (tx) => {
          await tx.update(tables.harvests).set(values).where(eq(tables.harvests.id, id));
        });
      }
      return this.getHarvestById(id);
    },
    async deleteHarvest(id: string): Promise<void> {
      return rlsDb.rls(async (tx) => {
        await tx.delete(tables.harvests).where(eq(tables.harvests.id, id));
      });
    },
    async getHarvestsByIds(ids: string[]): Promise<Harvest[]> {
      return rlsDb.rls(async (tx) => {
        return tx.query.harvests.findMany({
          where: { id: { in: ids } },
          with: {
            crop: true,
            plot: {
              extras: {
                geometry: (t) => sql<MultiPolygon>`ST_AsGeoJSON(${t.geometry})::json`.as("geometry"),
              },
            },
          },
          extras: {
            geometry: (t) => sql<MultiPolygon>`ST_AsGeoJSON(${t.geometry})::json`.as("geometry"),
          },
        });
      });
    },
    async getHarvestById(id: string): Promise<Harvest | undefined> {
      return rlsDb.rls(async (tx) => {
        return tx.query.harvests.findFirst({
          where: { id },
          with: {
            crop: true,
            plot: {
              extras: {
                geometry: (t) => sql<MultiPolygon>`ST_AsGeoJSON(${t.geometry})::json`.as("geometry"),
              },
            },
          },
          extras: {
            geometry: (t) => sql<MultiPolygon>`ST_AsGeoJSON(${t.geometry})::json`.as("geometry"),
          },
        });
      });
    },
    async getHarvestsForFarm(farmId: string, fromDate: Date, toDate: Date): Promise<Harvest[]> {
      return rlsDb.rls(async (tx) => {
        return tx.query.harvests.findMany({
          where: {
            farmId,
            AND: [{ date: { gte: fromDate } }, { date: { lte: toDate } }],
          },
          with: {
            crop: true,
            plot: {
              extras: {
                geometry: (t) => sql<MultiPolygon>`ST_AsGeoJSON(${t.geometry})::json`.as("geometry"),
              },
            },
          },
          extras: {
            geometry: (t) => sql<MultiPolygon>`ST_AsGeoJSON(${t.geometry})::json`.as("geometry"),
          },
          orderBy: { date: "desc" },
        });
      });
    },
    async getHarvestsForPlot(plotId: string): Promise<Omit<Harvest, "plot">[]> {
      return rlsDb.rls(async (tx) => {
        return tx.query.harvests.findMany({
          where: { plotId },
          with: {
            crop: true,
          },
          extras: {
            geometry: (t) => sql<MultiPolygon>`ST_AsGeoJSON(${t.geometry})::json`.as("geometry"),
          },
          orderBy: { date: "desc" },
        });
      });
    },

    async getHarvestYears(): Promise<string[]> {
      return rlsDb.rls(async (tx) => {
        const result = await tx.query.harvests.findMany({
          columns: {
            date: true,
          },
          orderBy: { date: "desc" },
        });
        return Array.from(new Set(result.map((application) => application.date.getFullYear().toString())));
      });
    },
    async getHarvestSummaryForFarm(farmId: string): Promise<HarvestSummary> {
      return rlsDb.rls(async (tx) => {
        const results = await tx.query.harvests.findMany({
          where: { farmId },
          columns: {
            geometry: false,
          },
          with: {
            crop: true,
          },
        });

        return mapToMonthlySummaries(results);
      });
    },
    async getHarvestSummaryForPlot(plotId: string): Promise<HarvestSummary> {
      return rlsDb.rls(async (tx) => {
        const results = await tx.query.harvests.findMany({
          where: { plotId },
          columns: {
            geometry: false,
          },
          with: {
            crop: true,
          },
        });

        return mapToMonthlySummaries(results);
      });
    },
    async createHarvestPreset(input: HarvestPresetCreateInput): Promise<HarvestPreset> {
      return rlsDb.rls(async (tx) => {
        const [preset] = await tx
          .insert(tables.harvestPresets)
          .values({ ...tables.farmIdColumnValue, ...input })
          .returning();
        return preset;
      });
    },
    async getHarvestPresets(): Promise<HarvestPreset[]> {
      return rlsDb.rls(async (tx) => {
        return tx.query.harvestPresets.findMany({
          orderBy: { name: "asc" },
        });
      });
    },
    async getHarvestPresetById(id: string): Promise<HarvestPreset | undefined> {
      return rlsDb.rls(async (tx) => {
        return tx.query.harvestPresets.findFirst({ where: { id } });
      });
    },
    async updateHarvestPreset(id: string, input: HarvestPresetUpdateInput): Promise<HarvestPreset> {
      return rlsDb.rls(async (tx) => {
        const [preset] = await tx
          .update(tables.harvestPresets)
          .set(input)
          .where(eq(tables.harvestPresets.id, id))
          .returning();
        return preset;
      });
    },
    async deleteHarvestPreset(id: string): Promise<void> {
      return rlsDb.rls(async (tx) => {
        await tx.delete(tables.harvestPresets).where(eq(tables.harvestPresets.id, id));
      });
    },
  };

  function mapToMonthlySummaries(harvests: Omit<Harvest, "geometry" | "plot">[]): HarvestSummary {
    const monthlyHarvests = harvests.reduce<
      Record<
        string,
        {
          year: number;
          month: number;
          producedQuantities: Record<
            string,
            {
              totalAmountInKilos: number;
              forageName: string;
              conservationMethod: string | null;
              producedUnits: {
                [unit: string]: {
                  unit: string;
                  totalAmountInKilos: number;
                  totalProducedUnits: number;
                };
              };
            }
          >;
        }
      >
    >((acc, harvest) => {
      const date = harvest.date;
      const year = date.getFullYear();
      const month = date.getMonth(); // getMonth() is zero-based
      const forageKey = `${harvest.crop.name}-${harvest.conservationMethod}`;

      const key = `${year}-${month}`;
      if (!acc[key]) {
        acc[key] = {
          year,
          month,
          producedQuantities: {},
        };
      }

      if (!acc[key].producedQuantities[forageKey]) {
        acc[key].producedQuantities[forageKey] = {
          forageName: harvest.crop.name,
          totalAmountInKilos: 0,
          conservationMethod: harvest.conservationMethod,
          producedUnits: {},
        };
      }

      if (!acc[key].producedQuantities[forageKey].producedUnits[harvest.unit]) {
        acc[key].producedQuantities[forageKey].producedUnits[harvest.unit] = {
          unit: harvest.unit,
          totalAmountInKilos: 0,
          totalProducedUnits: 0,
        };
      }

      acc[key].producedQuantities[forageKey].totalAmountInKilos += harvest.numberOfUnits * harvest.kilosPerUnit;
      acc[key].producedQuantities[forageKey].producedUnits[harvest.unit].totalAmountInKilos +=
        harvest.numberOfUnits * harvest.kilosPerUnit;
      acc[key].producedQuantities[forageKey].producedUnits[harvest.unit].totalProducedUnits += harvest.numberOfUnits;

      return acc;
    }, {});

    return {
      monthlyHarvests: Object.values(monthlyHarvests)
        .map((monthlyHarvest) => ({
          ...monthlyHarvest,
          producedQuantities: Object.values(monthlyHarvest.producedQuantities).map((producedQuantity) => ({
            ...producedQuantity,
            producedUnits: Object.values(producedQuantity.producedUnits),
          })),
        }))
        .sort((a, b) => {
          if (a.year === b.year) {
            return a.month - b.month;
          }
          return a.year - b.year;
        }),
    };
  }
}
