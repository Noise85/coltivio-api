import { inArray, sql } from "drizzle-orm";
import { Transaction } from "../db/db";
import { plotOverlays } from "../db/schema";
import { MultiPolygon } from "../geo/geojson";

// Federal usage codes for elements that lie on top of a plot instead of being one: tree types
// (921 to 928, counted in Stueck), Ackerschonstreifen (950) and Getreide in weiter Reihe (951).
export const OVERLAY_USAGE_CODES: ReadonlySet<number> = new Set([921, 922, 923, 924, 925, 926, 927, 928, 950, 951]);

export function isOverlayUsage(usage: number | null | undefined): boolean {
  return usage !== null && usage !== undefined && OVERLAY_USAGE_CODES.has(usage);
}

// Usage codes left out of farm creation and the import entirely. 595 (regionsspezifische BFF auf offener
// Ackerfläche) is an overlay on 601 in some cantons (AG) and a tiny standalone plot in others (VS).
export const IGNORED_USAGE_CODES: ReadonlySet<number> = new Set([595]);

export function isIgnoredUsage(usage: number | null | undefined): boolean {
  return usage !== null && usage !== undefined && IGNORED_USAGE_CODES.has(usage);
}

export type PlotOverlayInput = {
  name: string;
  localId: string | null;
  usage: number;
  usageName: string | null;
  size: number;
  geometry: MultiPolygon;
  externalId: string;
};

// Inserts overlays, skipping those the farm already has (same external id).
export async function insertPlotOverlays(
  tx: Transaction,
  farmId: string,
  source: string,
  inputs: PlotOverlayInput[]
): Promise<{ created: number; skipped: number }> {
  if (inputs.length === 0) return { created: 0, skipped: 0 };
  const inserted = await tx
    .insert(plotOverlays)
    .values(
      inputs.map((input) => ({
        farmId,
        name: input.name,
        localId: input.localId,
        usage: input.usage,
        usageName: input.usageName,
        size: input.size,
        externalId: input.externalId,
        source,
        geometry: sql`ST_GeomFromGeoJSON(${JSON.stringify(input.geometry)})`,
      }))
    )
    .onConflictDoNothing({ target: [plotOverlays.farmId, plotOverlays.externalId] })
    .returning({ id: plotOverlays.id });
  return { created: inserted.length, skipped: inputs.length - inserted.length };
}

// External ids of the given list that already exist for the current farm (RLS scoped).
export async function findPresentOverlayExternalIds(tx: Transaction, externalIds: string[]): Promise<Set<string>> {
  if (externalIds.length === 0) return new Set();
  const rows = await tx
    .select({ externalId: plotOverlays.externalId })
    .from(plotOverlays)
    .where(inArray(plotOverlays.externalId, externalIds));
  return new Set(rows.map((row) => row.externalId));
}
