import { eq, sql } from "drizzle-orm";
import { TFunction } from "i18next";
import { mapCodesToCrops, UNKNOWN_CROP_CODE } from "../crops/codeToCropsMapper";
import { Transaction } from "../db/db";
import { cropRotations, cropRotationYearlyRecurrences, crops, plots } from "../db/schema";
import { MultiPolygon } from "../geo/geojson";
import { repairedMultiPolygon } from "./plot-geometry";

export type PlotWithCropInput = {
  name: string;
  localId: string | null;
  usage: number | null;
  cuttingDate: Date | null;
  size: number;
  geometry: MultiPolygon;
};

// Creates plots the way farm creation does: one crop per usage code (reusing the farm's existing crops)
// and a current-year crop rotation with yearly recurrence per plot. Shared by createFarm and the import.
export async function createPlotsWithCrops(
  tx: Transaction,
  farmId: string,
  t: TFunction,
  inputs: PlotWithCropInput[]
): Promise<string[]> {
  if (inputs.length === 0) return [];

  const createdPlots = await tx
    .insert(plots)
    .values(
      inputs.map((input) => ({
        farmId,
        name: input.name,
        localId: input.localId,
        usage: input.usage,
        cuttingDate: input.cuttingDate,
        size: input.size,
        geometry: repairedMultiPolygon(sql`ST_GeomFromGeoJSON(${JSON.stringify(input.geometry)})`),
      }))
    )
    .returning({ id: plots.id, usage: plots.usage });

  const farmCrops = await tx
    .select({ id: crops.id, name: crops.name, usageCodes: crops.usageCodes })
    .from(crops)
    .where(eq(crops.farmId, farmId));
  const cropIdByCode = new Map<number, string>();
  for (const crop of farmCrops) {
    for (const code of crop.usageCodes) cropIdByCode.set(code, crop.id);
  }

  const codes = createdPlots.map((plot) => plot.usage ?? UNKNOWN_CROP_CODE);
  const missingCodes = [...new Set(codes.filter((code) => !cropIdByCode.has(code)))];
  for (const mapped of mapCodesToCrops(missingCodes, t)) {
    const mappedCodes = mapped.usageCodes ?? [];
    const existing = farmCrops.find((crop) => crop.name === mapped.name);
    if (existing) {
      // same crop name already on the farm (e.g. Naturwiese): attach the new codes instead of duplicating it
      if (mappedCodes.length > 0) {
        const merged = [...new Set([...existing.usageCodes, ...mappedCodes])];
        await tx.update(crops).set({ usageCodes: merged }).where(eq(crops.id, existing.id));
        existing.usageCodes = merged;
      }
      for (const code of mappedCodes) cropIdByCode.set(code, existing.id);
      continue;
    }
    const [created] = await tx
      .insert(crops)
      .values({ ...mapped, farmId })
      .returning({ id: crops.id, name: crops.name, usageCodes: crops.usageCodes });
    farmCrops.push(created);
    for (const code of mappedCodes) cropIdByCode.set(code, created.id);
  }

  const currentYear = new Date().getFullYear();
  const fromDate = new Date(Date.UTC(currentYear, 0, 1));
  const toDate = new Date(Date.UTC(currentYear, 11, 31));
  const createdRotations = await tx
    .insert(cropRotations)
    .values(
      createdPlots.map((plot) => ({
        farmId,
        cropId: cropIdByCode.get(plot.usage ?? UNKNOWN_CROP_CODE)!,
        fromDate,
        toDate,
        plotId: plot.id,
      }))
    )
    .returning({ id: cropRotations.id });
  await tx.insert(cropRotationYearlyRecurrences).values(
    createdRotations.map((rotation) => ({
      farmId,
      cropRotationId: rotation.id,
      interval: 1,
    }))
  );

  return createdPlots.map((plot) => plot.id);
}
