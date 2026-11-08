import { addYears, isWithinInterval } from "date-fns";
import { eq } from "drizzle-orm";
import { Crop } from "../crops/crops";
import { RlsDb } from "../db/db";
import { cropRotationYearlyRecurrences, cropRotations, farmIdColumnValue } from "../db/schema";

export type CropRotation = typeof cropRotations.$inferSelect & {
  crop: Crop;
};
export type CropRotationWithPlotName = CropRotation & {
  plot: { name: string };
};

export type CropRotationWithRecurrence = CropRotation & {
  recurrence: typeof cropRotationYearlyRecurrences.$inferSelect | null;
};

// Stricter type for API responses where recurrence is always defined (null or object)
export type CropRotationWithRecurrenceResult = CropRotation & {
  recurrence: Pick<typeof cropRotationYearlyRecurrences.$inferSelect, "id" | "interval" | "until"> | null;
};

export type CropRotationCreateInput = Omit<typeof cropRotations.$inferInsert, "id" | "farmId">;

export type CropRotationRecurrenceInput = Omit<
  typeof cropRotationYearlyRecurrences.$inferInsert,
  "id" | "cropRotationId" | "farmId"
>;

export type CropRotationByCropCreateManyInput = {
  cropId: string;
  plots: Array<
    CropRotationCreateInput & {
      recurrence?: CropRotationRecurrenceInput;
    }
  >;
};

export type CropRotationByPlotCreateManyInput = {
  plotId: string;
  crops: Array<{
    cropId: string;
    sowingDate?: Date;
    fromDate: Date;
    toDate: Date;
    recurrence?: CropRotationRecurrenceInput;
  }>;
};

export type CropRotationsPlanInput = {
  plots: Array<{
    plotId: string;
    rotations: Array<{
      cropId: string;
      sowingDate?: Date;
      fromDate: Date;
      toDate: Date;
      recurrence?: CropRotationRecurrenceInput;
    }>;
  }>;
};

export type CropRotationUpdateInput = Partial<CropRotationCreateInput> & {
  recurrence?: CropRotationRecurrenceInput | null;
};

// Expands a crop rotation with recurrence into multiple entries based on the query date range
export function expandRecurrence(
  rotation: CropRotationWithRecurrence,
  queryFromDate: Date,
  queryToDate: Date
): CropRotationWithRecurrenceResult[] {
  if (!rotation.recurrence) {
    // No recurrence, return as-is if within range
    const rotationStart = rotation.fromDate;
    const rotationEnd = rotation.toDate;
    if (
      isWithinInterval(rotationStart, {
        start: queryFromDate,
        end: queryToDate,
      }) ||
      isWithinInterval(rotationEnd, {
        start: queryFromDate,
        end: queryToDate,
      }) ||
      (rotationStart <= queryFromDate && rotationEnd >= queryToDate)
    ) {
      return [rotation];
    }
    return [];
  }

  return expandOccurrences(rotation, queryFromDate, queryToDate).map(([fromDate, toDate]) => ({
    ...rotation,
    fromDate,
    toDate,
  }));
}

export type DateRangeWithRecurrence = {
  fromDate: Date;
  toDate: Date;
  recurrence?: { interval: number; until: Date | null } | null;
};

const MAX_OCCURRENCES = 1000;

function expandOccurrences(range: DateRangeWithRecurrence, queryFrom: Date, queryTo: Date): [Date, Date][] {
  if (!range.recurrence) {
    return [[range.fromDate, range.toDate]];
  }

  const { interval, until } = range.recurrence;
  const occurrences: [Date, Date][] = [];

  for (let n = 0; n < MAX_OCCURRENCES; n++) {
    const start = addYears(range.fromDate, n * interval);
    const end = addYears(range.toDate, n * interval);
    if (until && start > until) break;
    if (start > queryTo) break;
    if (end >= queryFrom) {
      occurrences.push([start, end]);
    }
  }

  return occurrences;
}

// Check if two date ranges overlap considering yearly recurrences.
// Expands both into concrete occurrences and compares timestamps directly —
// avoids false positives from the day-of-year approach with year-spanning ranges.
function rangesOverlap(a: DateRangeWithRecurrence, b: DateRangeWithRecurrence): boolean {
  if (!a.recurrence && !b.recurrence) {
    return a.fromDate <= b.toDate && b.fromDate <= a.toDate;
  }

  // Derive a bounded expansion window from the actual dates
  const rangeStart = new Date(Math.min(a.fromDate.getFullYear(), b.fromDate.getFullYear()), 0, 1);
  const aUntilYear = a.recurrence?.until?.getFullYear() ?? null;
  const bUntilYear = b.recurrence?.until?.getFullYear() ?? null;
  const maxUntilYear = Math.max(
    aUntilYear ?? a.fromDate.getFullYear() + 100,
    bUntilYear ?? b.fromDate.getFullYear() + 100
  );
  const rangeEndYear = Math.min(maxUntilYear, rangeStart.getFullYear() + 200);
  const rangeEnd = new Date(rangeEndYear + 1, 0, 1);

  const aOccurrences = expandOccurrences(a, rangeStart, rangeEnd);
  const bOccurrences = expandOccurrences(b, rangeStart, rangeEnd);

  return aOccurrences.some(([af, at]) => bOccurrences.some(([bf, bt]) => af <= bt && at >= bf));
}

// Check for overlapping rotations - pure function taking date ranges
export function checkRotationOverlaps(ranges: DateRangeWithRecurrence[]): void {
  for (let i = 0; i < ranges.length; i++) {
    for (let j = i + 1; j < ranges.length; j++) {
      if (rangesOverlap(ranges[i], ranges[j])) {
        throw new Error("Overlapping date ranges");
      }
    }
  }
}

export function cropRotationsApi(rlsDb: RlsDb) {
  return {
    async getCropRotationsForPlot(
      plotId: string,
      fromDate: Date,
      toDate: Date
    ): Promise<CropRotationWithRecurrenceResult[]> {
      return rlsDb.rls(async (tx) => {
        const rotations = await tx.query.cropRotations.findMany({
          where: {
            plotId,
          },
          with: {
            crop: {
              with: { family: true },
            },
            recurrence: true,
          },
        });

        // Expand recurrences
        const expanded = rotations.flatMap((rotation) => expandRecurrence(rotation, fromDate, toDate));

        return expanded;
      });
    },

    async getCropRotationsForPlots(
      plotIds: string[],
      onlyCurrent: boolean,
      fromDate: Date,
      toDate: Date,
      options: { expand?: boolean; withRecurrences?: boolean } = {}
    ): Promise<CropRotationWithRecurrenceResult[]> {
      const { expand = true, withRecurrences = false } = options;

      return rlsDb.rls(async (tx) => {
        const rotations = await tx.query.cropRotations.findMany({
          where: {
            plotId: { in: plotIds },
          },
          orderBy: { fromDate: "desc" },
          with: {
            crop: {
              with: { family: true },
            },
            recurrence: true,
          },
        });

        // Optionally expand recurrences
        const processed = expand
          ? rotations.flatMap((rotation) => expandRecurrence(rotation, fromDate, toDate))
          : rotations;

        // Map to result type, stripping recurrence unless requested
        const result: CropRotationWithRecurrenceResult[] = processed.map((r) => ({
          ...r,
          recurrence:
            withRecurrences && r.recurrence
              ? {
                  id: r.recurrence.id,
                  interval: r.recurrence.interval,
                  until: r.recurrence.until,
                }
              : null,
        }));

        if (onlyCurrent) {
          // Group by plotId and get the current rotation for each plot
          const byPlot = new Map<string, CropRotationWithRecurrenceResult>();
          const now = new Date();
          for (const rotation of result) {
            if (rotation.fromDate <= now && rotation.toDate >= now) {
              byPlot.set(rotation.plotId, rotation);
            }
          }
          return Array.from(byPlot.values());
        }

        return result.sort((a, b) => b.fromDate.getTime() - a.fromDate.getTime());
      });
    },
    async getCropRotationById(id: string): Promise<CropRotationWithRecurrenceResult | undefined> {
      return rlsDb.rls(async (tx) => {
        return tx.query.cropRotations.findFirst({
          where: { id },
          with: {
            crop: {
              with: { family: true },
            },
            recurrence: true,
          },
        });
      });
    },

    async getCropRotationsForFarm(
      fromDate: Date,
      toDate: Date,
      options: { expand?: boolean; withRecurrences?: boolean } = {}
    ): Promise<(CropRotationWithRecurrenceResult & { plot: { name: string } })[]> {
      const { expand = true, withRecurrences = false } = options;

      return rlsDb.rls(async (tx) => {
        const rotations = await tx.query.cropRotations.findMany({
          with: {
            crop: {
              with: { family: true },
            },
            plot: { columns: { name: true } },
            recurrence: true,
          },
        });

        const processed = expand
          ? rotations.flatMap((rotation) =>
              expandRecurrence(rotation, fromDate, toDate).map((entry) => ({
                ...entry,
                plot: rotation.plot,
              }))
            )
          : rotations.map((rotation) => ({ ...rotation, plot: rotation.plot }));

        const result = processed.map((r) => ({
          ...r,
          recurrence:
            withRecurrences && r.recurrence
              ? { id: r.recurrence.id, interval: r.recurrence.interval, until: r.recurrence.until }
              : null,
        }));

        return result.sort((a, b) => b.fromDate.getTime() - a.fromDate.getTime());
      });
    },
    async createCropRotation(
      input: CropRotationCreateInput & {
        recurrence?: CropRotationRecurrenceInput;
      }
    ): Promise<CropRotation> {
      const result = await rlsDb.rls(async (tx) => {
        const { recurrence, ...rotationInput } = input;

        const [plotCrop] = await tx
          .insert(cropRotations)
          .values({
            ...rotationInput,
            ...farmIdColumnValue,
          })
          .returning();

        // Create recurrence if provided
        if (recurrence) {
          await tx.insert(cropRotationYearlyRecurrences).values({
            cropRotationId: plotCrop.id,
            ...farmIdColumnValue,
            ...recurrence,
          });
        }

        return plotCrop;
      });
      const cropRotation = await this.getCropRotationById(result.id);
      return cropRotation!;
    },
    async createCropRotationsByPlot(input: CropRotationByPlotCreateManyInput): Promise<CropRotation[]> {
      return rlsDb.rls(async (tx) => {
        if (input.crops.length === 0) {
          return [];
        }

        // Fetch existing rotations for overlap check
        const existingRotations = await tx.query.cropRotations.findMany({
          where: { plotId: input.plotId },
          with: { recurrence: true },
        });
        const existingRanges: DateRangeWithRecurrence[] = existingRotations.map((r) => ({
          fromDate: r.fromDate,
          toDate: r.toDate,
          recurrence: r.recurrence,
        }));
        const newRanges: DateRangeWithRecurrence[] = input.crops.map((c) => ({
          fromDate: c.fromDate,
          toDate: c.toDate,
          recurrence: c.recurrence
            ? {
                interval: c.recurrence.interval ?? 1,
                until: c.recurrence.until ?? null,
              }
            : null,
        }));
        checkRotationOverlaps([...existingRanges, ...newRanges]);

        // Create the rotations
        const createdCropRotations = await tx
          .insert(cropRotations)
          .values(
            input.crops.map((plotRotation) => ({
              plotId: input.plotId,
              fromDate: plotRotation.fromDate,
              toDate: plotRotation.toDate,
              cropId: plotRotation.cropId,
              sowingDate: plotRotation.sowingDate,
              ...farmIdColumnValue,
            }))
          )
          .returning();

        // Create recurrences
        for (let i = 0; i < createdCropRotations.length; i++) {
          const recurrence = input.crops[i].recurrence;
          if (recurrence) {
            await tx.insert(cropRotationYearlyRecurrences).values({
              ...farmIdColumnValue,
              cropRotationId: createdCropRotations[i].id,
              ...recurrence,
            });
          }
        }

        return tx.query.cropRotations.findMany({
          where: {
            id: {
              in: createdCropRotations.map((cropRotation) => cropRotation.id),
            },
          },
          with: {
            crop: {
              with: { family: true },
            },
          },
        });
      });
    },

    async createCropRotationsByCrop(input: CropRotationByCropCreateManyInput): Promise<CropRotation[]> {
      return rlsDb.rls(async (tx) => {
        if (input.plots.length === 0) {
          return [];
        }

        // Check for overlaps for each plot
        for (const plot of input.plots) {
          const existingRotations = await tx.query.cropRotations.findMany({
            where: { plotId: plot.plotId },
            with: { recurrence: true },
          });
          const existingRanges: DateRangeWithRecurrence[] = existingRotations.map((r) => ({
            fromDate: r.fromDate,
            toDate: r.toDate,
            recurrence: r.recurrence,
          }));
          const newRange: DateRangeWithRecurrence = {
            fromDate: plot.fromDate,
            toDate: plot.toDate,
            recurrence: plot.recurrence
              ? {
                  interval: plot.recurrence.interval ?? 1,
                  until: plot.recurrence.until ?? null,
                }
              : null,
          };
          checkRotationOverlaps([...existingRanges, newRange]);
        }

        const createdCropRotations = await tx
          .insert(cropRotations)
          .values(
            input.plots.map((plotRotation) => ({
              plotId: plotRotation.plotId,
              fromDate: plotRotation.fromDate,
              toDate: plotRotation.toDate,
              cropId: input.cropId,
              sowingDate: plotRotation.sowingDate,
              ...farmIdColumnValue,
            }))
          )
          .returning();

        // Create recurrences
        for (let i = 0; i < createdCropRotations.length; i++) {
          const recurrence = input.plots[i].recurrence;
          if (recurrence) {
            await tx.insert(cropRotationYearlyRecurrences).values({
              ...farmIdColumnValue,
              cropRotationId: createdCropRotations[i].id,
              ...recurrence,
            });
          }
        }

        return tx.query.cropRotations.findMany({
          where: {
            id: {
              in: createdCropRotations.map((cropRotation) => cropRotation.id),
            },
          },
          with: {
            crop: {
              with: { family: true },
            },
          },
        });
      });
    },

    async planCropRotations(input: CropRotationsPlanInput): Promise<CropRotation[]> {
      return rlsDb.rls(async (tx) => {
        if (input.plots.length === 0) {
          return [];
        }

        const resultIds: string[] = [];

        for (const plotPlan of input.plots) {
          // Check for overlaps among the incoming rotations themselves
          const newRanges: DateRangeWithRecurrence[] = plotPlan.rotations.map((r) => ({
            fromDate: r.fromDate,
            toDate: r.toDate,
            recurrence: r.recurrence
              ? { interval: r.recurrence.interval ?? 1, until: r.recurrence.until ?? null }
              : null,
          }));
          checkRotationOverlaps(newRanges);

          // Replace: delete all existing rotations for this plot, then create fresh
          await tx.delete(cropRotations).where(eq(cropRotations.plotId, plotPlan.plotId));

          if (plotPlan.rotations.length === 0) continue;

          const created = await tx
            .insert(cropRotations)
            .values(
              plotPlan.rotations.map((r) => ({
                plotId: plotPlan.plotId,
                cropId: r.cropId,
                fromDate: r.fromDate,
                toDate: r.toDate,
                sowingDate: r.sowingDate,
                ...farmIdColumnValue,
              }))
            )
            .returning();

          for (let i = 0; i < created.length; i++) {
            if (plotPlan.rotations[i].recurrence) {
              await tx.insert(cropRotationYearlyRecurrences).values({
                ...farmIdColumnValue,
                cropRotationId: created[i].id,
                ...plotPlan.rotations[i].recurrence,
              });
            }
            resultIds.push(created[i].id);
          }
        }

        return tx.query.cropRotations.findMany({
          where: {
            id: { in: resultIds },
          },
          with: {
            crop: {
              with: { family: true },
            },
          },
        });
      });
    },

    async updateCropRotation(id: string, data: CropRotationUpdateInput): Promise<CropRotation> {
      const result = await rlsDb.rls(async (tx) => {
        const { recurrence, ...rotationData } = data;

        // Get the current rotation to know its plotId
        const currentRotation = await tx.query.cropRotations.findFirst({
          where: { id },
          with: { recurrence: true },
        });

        if (!currentRotation) {
          throw new Error("Crop rotation not found");
        }

        // Check for overlaps if dates or recurrence are being updated
        if (rotationData.fromDate || rotationData.toDate || recurrence !== undefined) {
          // Fetch other rotations for this plot (excluding current)
          const existingRotations = await tx.query.cropRotations.findMany({
            where: { plotId: currentRotation.plotId },
            with: { recurrence: true },
          });
          const existingRanges: DateRangeWithRecurrence[] = existingRotations
            .filter((r) => r.id !== id)
            .map((r) => ({
              fromDate: r.fromDate,
              toDate: r.toDate,
              recurrence: r.recurrence,
            }));

          const updatedRange: DateRangeWithRecurrence = {
            fromDate: rotationData.fromDate ?? currentRotation.fromDate,
            toDate: rotationData.toDate ?? currentRotation.toDate,
            recurrence:
              recurrence !== undefined
                ? recurrence
                  ? {
                      interval: recurrence.interval ?? 1,
                      until: recurrence.until ?? null,
                    }
                  : null
                : currentRotation.recurrence,
          };

          checkRotationOverlaps([...existingRanges, updatedRange]);
        }

        // Update the rotation
        const [plotCrop] = await tx.update(cropRotations).set(rotationData).where(eq(cropRotations.id, id)).returning();

        // Handle recurrence updates
        if (recurrence !== undefined) {
          // Check if recurrence already exists
          const existingRecurrence = await tx.query.cropRotationRecurrences.findFirst({
            where: { cropRotationId: id },
          });

          if (recurrence === null) {
            // Delete existing recurrence if it exists
            if (existingRecurrence) {
              await tx
                .delete(cropRotationYearlyRecurrences)
                .where(eq(cropRotationYearlyRecurrences.cropRotationId, id));
            }
          } else {
            // Update or create recurrence
            if (existingRecurrence) {
              await tx
                .update(cropRotationYearlyRecurrences)
                .set(recurrence)
                .where(eq(cropRotationYearlyRecurrences.cropRotationId, id));
            } else {
              await tx.insert(cropRotationYearlyRecurrences).values({
                ...farmIdColumnValue,
                cropRotationId: id,
                ...recurrence,
              });
            }
          }
        }

        return plotCrop;
      });
      const cropRotation = await this.getCropRotationById(result.id);
      return cropRotation!;
    },

    async deleteCropRotation(id: string): Promise<void> {
      return rlsDb.rls(async (tx) => {
        await tx.delete(cropRotations).where(eq(cropRotations.id, id));
      });
    },

    async getCropRotationYears(): Promise<string[]> {
      return rlsDb.rls(async (tx) => {
        const result = await tx.query.cropRotations.findMany({
          columns: {
            fromDate: true,
          },
          orderBy: { fromDate: "desc" },
        });
        return Array.from(new Set(result.map((rotation) => rotation.fromDate.getFullYear().toString())));
      });
    },
  };
}
