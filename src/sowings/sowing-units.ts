import { CodedError } from "../errors";
import { z } from "zod";
import { seedQuantityKindSchema, sowingUnitSchema } from "../db/schema";

export type SowingUnit = z.infer<typeof sowingUnitSchema>;
export type SeedQuantityKind = z.infer<typeof seedQuantityKindSchema>;
// seeds and plants are both counts but never summed together
export const sowingCountUnitSchema = z.enum(["seeds", "plants"]);
export type SowingCountUnit = z.infer<typeof sowingCountUnitSchema>;

const SQUARE_METERS_PER_HECTARE = 10000;

// Base units: grams for weight, pieces for count.
// perArea units: factor converts the entered amount to base units per hectare.
// total units: factor converts the entered amount to base units.
// countUnit: what a counted piece is (null for weight).
export const sowingUnits: Record<
  SowingUnit,
  { quantityKind: SeedQuantityKind; countUnit: SowingCountUnit | null; perArea: boolean; toBaseFactor: number }
> = {
  kg_per_ha: { quantityKind: "weight", countUnit: null, perArea: true, toBaseFactor: 1000 },
  g_per_m2: { quantityKind: "weight", countUnit: null, perArea: true, toBaseFactor: SQUARE_METERS_PER_HECTARE },
  seeds_per_ha: { quantityKind: "count", countUnit: "seeds", perArea: true, toBaseFactor: 1 },
  seeds_per_m2: { quantityKind: "count", countUnit: "seeds", perArea: true, toBaseFactor: SQUARE_METERS_PER_HECTARE },
  plants_per_ha: { quantityKind: "count", countUnit: "plants", perArea: true, toBaseFactor: 1 },
  plants_per_m2: { quantityKind: "count", countUnit: "plants", perArea: true, toBaseFactor: SQUARE_METERS_PER_HECTARE },
  kg: { quantityKind: "weight", countUnit: null, perArea: false, toBaseFactor: 1000 },
  g: { quantityKind: "weight", countUnit: null, perArea: false, toBaseFactor: 1 },
  seeds: { quantityKind: "count", countUnit: "seeds", perArea: false, toBaseFactor: 1 },
  plants: { quantityKind: "count", countUnit: "plants", perArea: false, toBaseFactor: 1 },
};

// size in m²
export function computeBaseAmounts(
  amount: number,
  unit: SowingUnit,
  size: number
): { totalBaseAmount: number; baseAmountPerHectare: number } {
  const { perArea, toBaseFactor } = sowingUnits[unit];
  const hectares = size / SQUARE_METERS_PER_HECTARE;
  if (perArea) {
    const baseAmountPerHectare = amount * toBaseFactor;
    return { baseAmountPerHectare, totalBaseAmount: baseAmountPerHectare * hectares };
  }
  const totalBaseAmount = amount * toBaseFactor;
  return { totalBaseAmount, baseAmountPerHectare: hectares > 0 ? totalBaseAmount / hectares : 0 };
}

export function assertUnitMatchesQuantityKind(unit: SowingUnit, quantityKind: SeedQuantityKind) {
  if (sowingUnits[unit].quantityKind !== quantityKind) {
    throw new CodedError(
      "sowing_unit_mismatch",
      `Unit ${unit} is not compatible with seed quantity kind ${quantityKind}`
    );
  }
}
