import { eq, sql } from "drizzle-orm";
import { RlsDb } from "../db/db";
import { crops, farmIdColumnValue, plots, seeds, sowingPresets, sowings } from "../db/schema";
import { CodedError } from "../errors";
import { MultiPolygon } from "../geo/geojson";
import {
  SeedQuantityKind,
  SowingCountUnit,
  SowingUnit,
  assertUnitMatchesQuantityKind,
  computeBaseAmounts,
  sowingUnits,
} from "./sowing-units";

export type SowingPreset = typeof sowingPresets.$inferSelect & {
  crop: typeof crops.$inferSelect;
  seed: typeof seeds.$inferSelect | null;
};
// cropId can be omitted when a seed is given, it's taken from the seed
export type SowingPresetCreateInput = Omit<typeof sowingPresets.$inferInsert, "id" | "farmId" | "cropId"> & {
  cropId?: string;
};
export type SowingPresetUpdateInput = Partial<SowingPresetCreateInput>;

export type SowingBatchCreateInput = {
  date: Date;
  createdBy: string;
  // can be omitted when a seed is given, it's taken from the seed
  cropId?: string;
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
  countUnit: SowingCountUnit | null;
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
  // With a seed the crop is the seed's crop (a different cropId is rejected) and the unit must fit
  // the seed's quantity kind. Without a seed the cropId is required. Returns the resulting cropId.
  async function resolveCropForSeed({
    seedId,
    cropId,
    unit,
  }: {
    seedId: string | null | undefined;
    cropId: string | undefined;
    unit: SowingUnit;
  }): Promise<string> {
    if (seedId) {
      const seed = await rlsDb.rls(async (tx) => tx.query.seeds.findFirst({ where: { id: seedId } }));
      if (!seed) {
        throw new CodedError("seed_not_found", "Seed not found");
      }
      assertUnitMatchesQuantityKind(unit, seed.quantityKind);
      if (cropId && cropId !== seed.cropId) {
        throw new CodedError("sowing_crop_mismatch", "Crop does not match the crop of the seed");
      }
      return seed.cropId;
    }
    if (!cropId) {
      throw new CodedError("sowing_crop_required", "cropId is required when no seed is given");
    }
    // foreign keys bypass RLS, so a crop of another farm has to be caught here
    const crop = await rlsDb.rls(async (tx) => tx.query.crops.findFirst({ where: { id: cropId } }));
    if (!crop) {
      throw new CodedError("crop_not_found", "Crop not found");
    }
    return cropId;
  }

  return {
    async createSowings({ plots: plotInputs, ...base }: SowingBatchCreateInput): Promise<Sowing[]> {
      const cropId = await resolveCropForSeed({ seedId: base.seedId, cropId: base.cropId, unit: base.unit });
      // foreign keys bypass RLS, so plots of another farm have to be caught here
      const plotIds = [...new Set(plotInputs.map((plot) => plot.plotId))];
      const visiblePlots = await rlsDb.rls(async (tx) =>
        tx.query.plots.findMany({ where: { id: { in: plotIds } }, columns: { id: true } })
      );
      if (visiblePlots.length !== plotIds.length) {
        throw new CodedError("plot_not_found", "Plot not found");
      }
      const result = await rlsDb.rls(async (tx) => {
        return tx
          .insert(sowings)
          .values(
            plotInputs.map((plot) => ({
              ...farmIdColumnValue,
              ...base,
              cropId,
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
      // a newly chosen seed brings its own crop, otherwise the current crop stays
      const resultingCropId = await resolveCropForSeed({
        seedId: resultingSeedId,
        cropId: cropId ?? (seedId ? undefined : existingSowing.cropId),
        unit: resultingUnit,
      });
      const values = {
        date,
        cropId: resultingCropId,
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
      const cropId = await resolveCropForSeed({ seedId: input.seedId, cropId: input.cropId, unit: input.unit });
      const [createdPreset] = await rlsDb.rls(async (tx) => {
        return tx
          .insert(sowingPresets)
          .values({ ...farmIdColumnValue, ...input, cropId })
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
      const cropId = await resolveCropForSeed({
        seedId: input.seedId === undefined ? existingPreset.seedId : input.seedId,
        cropId: input.cropId ?? (input.seedId ? undefined : existingPreset.cropId),
        unit: input.unit ?? existingPreset.unit,
      });
      await rlsDb.rls(async (tx) => {
        await tx
          .update(sowingPresets)
          .set({ ...input, cropId })
          .where(eq(sowingPresets.id, id));
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
      // weight, seeds and plants can never be summed together, so they're part of the key
      const { quantityKind, countUnit } = sowingUnits[sowing.unit];
      const seedKey = `${sowing.cropId}-${sowing.seedId ?? "none"}-${quantityKind}-${countUnit ?? "weight"}`;
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
          countUnit,
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
