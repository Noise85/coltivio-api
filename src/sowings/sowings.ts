import { eq, sql } from "drizzle-orm";
import createHttpError from "http-errors";
import { RlsDb } from "../db/db";
import { crops, farmIdColumnValue, plots, seeds, sowingPresets, sowings } from "../db/schema";
import { MultiPolygon } from "../geo/geojson";
import {
  assertUnitMatchesQuantityKind,
  computeBaseAmounts,
  SeedQuantityKind,
  SowingUnit,
  sowingUnits,
} from "./sowing-units";

export type SowingPreset = typeof sowingPresets.$inferSelect & {
  crop: typeof crops.$inferSelect;
  seed: typeof seeds.$inferSelect | null;
};
export type SowingPresetCreateInput = Omit<typeof sowingPresets.$inferInsert, "id" | "farmId">;
export type SowingPresetUpdateInput = Partial<SowingPresetCreateInput>;

export type SowingBatchCreateInput = {
  date: Date;
  createdBy: string;
  cropId: string;
  seedId?: string;
  unit: SowingUnit;
  additionalNotes?: string;
  plots: {
    plotId: string;
    geometry: MultiPolygon;
    size: number;
    amount: number;
  }[];
};

// plot, geometry and size are fixed once an entry is created; only values can be edited
export type SowingUpdateInput = Partial<
  Pick<typeof sowings.$inferInsert, "date" | "cropId" | "seedId" | "unit" | "amount" | "additionalNotes">
>;

export type Sowing = Omit<typeof sowings.$inferSelect, "geometry"> & {
  geometry: MultiPolygon;
  crop: typeof crops.$inferSelect;
  seed: typeof seeds.$inferSelect | null;
  plot: Pick<typeof plots.$inferSelect, "id" | "name">;
};

interface SownSeed {
  cropId: string;
  cropName: string;
  seedId: string | null;
  seedName: string | null;
  quantityKind: SeedQuantityKind;
  // grams for weight, pieces for count
  totalBaseAmount: number;
  totalSize: number;
}
interface MonthlySowing {
  year: number;
  month: number;
  sownSeeds: SownSeed[];
}
export interface SowingSummary {
  monthlySowings: MonthlySowing[];
}

export function sowingsApi(rlsDb: RlsDb) {
  async function assertSeedUnitCompatible(seedId: string | null | undefined, unit: SowingUnit) {
    if (!seedId) {
      return;
    }
    const seed = await rlsDb.rls(async (tx) => tx.query.seeds.findFirst({ where: { id: seedId } }));
    if (!seed) {
      throw createHttpError(400, "Seed not found");
    }
    assertUnitMatchesQuantityKind(unit, seed.quantityKind);
  }

  return {
    async createSowings({ plots: plotInputs, ...base }: SowingBatchCreateInput): Promise<Sowing[]> {
      await assertSeedUnitCompatible(base.seedId, base.unit);
      const result = await rlsDb.rls(async (tx) => {
        return tx
          .insert(sowings)
          .values(
            plotInputs.map((plot) => ({
              ...farmIdColumnValue,
              ...base,
              ...plot,
              ...computeBaseAmounts(plot.amount, base.unit, plot.size),
              geometry: sql<MultiPolygon>`ST_GeomFromGeoJSON(${JSON.stringify(plot.geometry)})`,
            }))
          )
          .returning({ id: sowings.id });
      });
      return this.getSowingsByIds(result.map((sowing) => sowing.id));
    },

    async getSowingsByIds(ids: string[]): Promise<Sowing[]> {
      return rlsDb.rls(async (tx) => {
        return tx.query.sowings.findMany({
          where: { id: { in: ids } },
          with: { crop: true, seed: true, plot: { columns: { id: true, name: true } } },
          extras: {
            geometry: (t) => sql<MultiPolygon>`ST_AsGeoJSON(${t.geometry})::json`.as("geometry"),
          },
        });
      });
    },

    async getSowingById(id: string): Promise<Sowing | undefined> {
      return rlsDb.rls(async (tx) => {
        return tx.query.sowings.findFirst({
          where: { id },
          with: { crop: true, seed: true, plot: { columns: { id: true, name: true } } },
          extras: {
            geometry: (t) => sql<MultiPolygon>`ST_AsGeoJSON(${t.geometry})::json`.as("geometry"),
          },
        });
      });
    },

    async getSowingsForFarm(farmId: string, fromDate: Date, toDate: Date): Promise<Sowing[]> {
      return rlsDb.rls(async (tx) => {
        return tx.query.sowings.findMany({
          where: {
            farmId,
            AND: [{ date: { gte: fromDate } }, { date: { lte: toDate } }],
          },
          with: { crop: true, seed: true, plot: { columns: { id: true, name: true } } },
          extras: {
            geometry: (t) => sql<MultiPolygon>`ST_AsGeoJSON(${t.geometry})::json`.as("geometry"),
          },
          orderBy: { date: "desc" },
        });
      });
    },

    async getSowingsForPlot(plotId: string): Promise<Omit<Sowing, "plot">[]> {
      return rlsDb.rls(async (tx) => {
        return tx.query.sowings.findMany({
          where: { plotId },
          with: { crop: true, seed: true },
          extras: {
            geometry: (t) => sql<MultiPolygon>`ST_AsGeoJSON(${t.geometry})::json`.as("geometry"),
          },
          orderBy: { date: "desc" },
        });
      });
    },

    async updateSowing(id: string, data: SowingUpdateInput): Promise<Sowing | undefined> {
      const existingSowing = await this.getSowingById(id);
      if (!existingSowing) {
        return undefined;
      }
      const { date, cropId, seedId, unit, amount, additionalNotes } = data;
      const resultingUnit = unit ?? existingSowing.unit;
      const resultingAmount = amount ?? existingSowing.amount;
      const resultingSeedId = seedId === undefined ? existingSowing.seedId : seedId;
      if (unit !== undefined || seedId !== undefined) {
        await assertSeedUnitCompatible(resultingSeedId, resultingUnit);
      }
      const values = {
        date,
        cropId,
        seedId,
        unit,
        amount,
        additionalNotes,
        ...computeBaseAmounts(resultingAmount, resultingUnit, existingSowing.size),
      };
      await rlsDb.rls(async (tx) => {
        await tx.update(sowings).set(values).where(eq(sowings.id, id));
      });
      return this.getSowingById(id);
    },

    async deleteSowing(id: string): Promise<void> {
      await rlsDb.rls(async (tx) => {
        await tx.delete(sowings).where(eq(sowings.id, id));
      });
    },

    async getSowingYears(): Promise<string[]> {
      return rlsDb.rls(async (tx) => {
        const result = await tx.query.sowings.findMany({
          columns: { date: true },
          orderBy: { date: "desc" },
        });
        return Array.from(new Set(result.map((sowing) => sowing.date.getFullYear().toString())));
      });
    },

    async getSowingSummaryForFarm(farmId: string): Promise<SowingSummary> {
      return rlsDb.rls(async (tx) => {
        const result = await tx.query.sowings.findMany({
          where: { farmId },
          columns: { date: true, unit: true, totalBaseAmount: true, size: true, cropId: true, seedId: true },
          with: { crop: { columns: { name: true } }, seed: { columns: { name: true } } },
        });
        return mapToMonthlySummary(result);
      });
    },

    async getSowingSummaryForPlot(plotId: string): Promise<SowingSummary> {
      return rlsDb.rls(async (tx) => {
        const result = await tx.query.sowings.findMany({
          where: { plotId },
          columns: { date: true, unit: true, totalBaseAmount: true, size: true, cropId: true, seedId: true },
          with: { crop: { columns: { name: true } }, seed: { columns: { name: true } } },
        });
        return mapToMonthlySummary(result);
      });
    },

    async createSowingPreset(input: SowingPresetCreateInput): Promise<SowingPreset> {
      await assertSeedUnitCompatible(input.seedId, input.unit);
      const [createdPreset] = await rlsDb.rls(async (tx) => {
        return tx
          .insert(sowingPresets)
          .values({ ...farmIdColumnValue, ...input })
          .returning({ id: sowingPresets.id });
      });
      const preset = await this.getSowingPresetById(createdPreset.id);
      return preset!;
    },
    async getSowingPresets(): Promise<SowingPreset[]> {
      return rlsDb.rls(async (tx) => {
        return tx.query.sowingPresets.findMany({
          with: { crop: true, seed: true },
          orderBy: { name: "asc" },
        });
      });
    },
    async getSowingPresetById(id: string): Promise<SowingPreset | undefined> {
      return rlsDb.rls(async (tx) => {
        return tx.query.sowingPresets.findFirst({
          where: { id },
          with: { crop: true, seed: true },
        });
      });
    },
    async updateSowingPreset(id: string, input: SowingPresetUpdateInput): Promise<SowingPreset | undefined> {
      const existingPreset = await this.getSowingPresetById(id);
      if (!existingPreset) {
        return undefined;
      }
      if (input.unit !== undefined || input.seedId !== undefined) {
        await assertSeedUnitCompatible(
          input.seedId === undefined ? existingPreset.seedId : input.seedId,
          input.unit ?? existingPreset.unit
        );
      }
      await rlsDb.rls(async (tx) => {
        await tx.update(sowingPresets).set(input).where(eq(sowingPresets.id, id));
      });
      return this.getSowingPresetById(id);
    },
    async deleteSowingPreset(id: string): Promise<void> {
      return rlsDb.rls(async (tx) => {
        await tx.delete(sowingPresets).where(eq(sowingPresets.id, id));
      });
    },
  };

  function mapToMonthlySummary(
    result: {
      date: Date;
      unit: SowingUnit;
      totalBaseAmount: number;
      size: number;
      cropId: string;
      seedId: string | null;
      crop: { name: string };
      seed: { name: string } | null;
    }[]
  ): SowingSummary {
    const months = new Map<string, { year: number; month: number; sownSeeds: Map<string, SownSeed> }>();
    for (const sowing of result) {
      const year = sowing.date.getFullYear();
      const month = sowing.date.getMonth(); // zero-based, like the other summaries
      const monthKey = `${year}-${month}`;
      let monthEntry = months.get(monthKey);
      if (!monthEntry) {
        monthEntry = { year, month, sownSeeds: new Map() };
        months.set(monthKey, monthEntry);
      }
      // weight and count can never be summed together, so the kind is part of the key
      const quantityKind = sowingUnits[sowing.unit].quantityKind;
      const seedKey = `${sowing.cropId}-${sowing.seedId ?? "none"}-${quantityKind}`;
      const sownSeed = monthEntry.sownSeeds.get(seedKey);
      if (sownSeed) {
        sownSeed.totalBaseAmount += sowing.totalBaseAmount;
        sownSeed.totalSize += sowing.size;
      } else {
        monthEntry.sownSeeds.set(seedKey, {
          cropId: sowing.cropId,
          cropName: sowing.crop.name,
          seedId: sowing.seedId,
          seedName: sowing.seed?.name ?? null,
          quantityKind,
          totalBaseAmount: sowing.totalBaseAmount,
          totalSize: sowing.size,
        });
      }
    }
    return {
      monthlySowings: Array.from(months.values()).map(({ year, month, sownSeeds }) => ({
        year,
        month,
        sownSeeds: Array.from(sownSeeds.values()),
      })),
    };
  }
}
