import { eq, sql } from "drizzle-orm";
import { RlsDb } from "../db/db";
import {
  farmIdColumnValue,
  cropProtectionApplications,
  cropProtectionUnitSchema,
  cropProtectionApplicationPresets,
} from "../db/schema";
import { MultiPolygon } from "../geo/geojson";
import { Plot } from "../plots/plots";
import { CropProtectionProduct } from "./crop-protection-products";
import { z } from "zod";

export type CropProtectionApplicationPreset = typeof cropProtectionApplicationPresets.$inferSelect;
export type CropProtectionApplicationPresetCreateInput = Omit<
  typeof cropProtectionApplicationPresets.$inferInsert,
  "id" | "farmId"
>;
export type CropProtectionApplicationPresetUpdateInput = Partial<CropProtectionApplicationPresetCreateInput>;

export type CropProtectionUnit = z.infer<typeof cropProtectionUnitSchema>;

export type CropProtectionApplicationCreateInput = Omit<
  typeof cropProtectionApplications.$inferInsert,
  "id" | "farmId" | "geometry"
> & {
  geometry: MultiPolygon;
};

export type CropProtectionApplicationBatchCreateInput = {
  createdBy: string;
  dateTime: Date;
  method?: CropProtectionApplication["method"];
  unit: CropProtectionApplication["unit"];
  additionalNotes?: string;
  productId: string;
  amountPerUnit: number;
  plots: {
    plotId: string;
    geometry: MultiPolygon;
    size: number;
    numberOfUnits: number;
  }[];
};
// plot, geometry and size are fixed once an entry is created; only values can be edited
export type CropProtectionApplicationUpdateInput = Partial<
  Pick<
    typeof cropProtectionApplications.$inferInsert,
    "dateTime" | "productId" | "method" | "amountPerUnit" | "numberOfUnits" | "unit" | "additionalNotes"
  >
>;

export type CropProtectionApplication = typeof cropProtectionApplications.$inferSelect & {
  geometry: MultiPolygon;
  product: CropProtectionProduct;
  plot: Omit<Plot, "currentCropRotation" | "geometry">;
};

interface AppliedCropProtection {
  totalAmount: number;
  totalProducedUnits: number;
  productName: string;
  unit: CropProtectionUnit;
}
interface MonthlyApplication {
  year: number;
  month: number;
  appliedCropProtections: AppliedCropProtection[];
}

export interface CropProtectionApplicationSummary {
  monthlyApplications: MonthlyApplication[];
}

export function cropProtectionApplicationsApi(rlsDb: RlsDb) {
  return {
    async createCropProtectionApplication(
      input: CropProtectionApplicationCreateInput
    ): Promise<CropProtectionApplication> {
      const result = await rlsDb.rls(async (tx) => {
        const [cropProtectionApplication] = await tx
          .insert(cropProtectionApplications)
          .values({
            ...farmIdColumnValue,
            ...input,
            geometry: sql<MultiPolygon>`ST_GeomFromGeoJSON(${JSON.stringify(input.geometry)})`,
          })
          .returning();
        return cropProtectionApplication;
      });
      const cropProtectionApplication = await this.getCropProtectionApplicationById(result.id);
      return cropProtectionApplication!;
    },
    async createCropProtectionApplications({
      plots,
      ...base
    }: CropProtectionApplicationBatchCreateInput): Promise<CropProtectionApplication[]> {
      const result = await rlsDb.rls(async (tx) => {
        return tx
          .insert(cropProtectionApplications)
          .values(
            plots.map((plot) => ({
              ...farmIdColumnValue,
              ...base,
              ...plot,
              geometry: sql<MultiPolygon>`ST_GeomFromGeoJSON(${JSON.stringify(plot.geometry)})`,
            }))
          )
          .returning({ id: cropProtectionApplications.id });
      });
      return this.getCropProtectionApplicationsByIds(result.map((application) => application.id))!;
    },
    async getCropProtectionApplicationsByIds(ids: string[]): Promise<CropProtectionApplication[]> {
      return rlsDb.rls(async (tx) => {
        return tx.query.cropProtectionApplications.findMany({
          where: { id: { in: ids } },
          with: {
            plot: true,
            product: true,
          },
          extras: {
            geometry: (t) => sql<MultiPolygon>`ST_AsGeoJSON(${t.geometry})::json`.as("geometry"),
          },
        });
      });
    },
    async getCropProtectionApplicationById(id: string): Promise<CropProtectionApplication | undefined> {
      return rlsDb.rls(async (tx) => {
        return tx.query.cropProtectionApplications.findFirst({
          where: { id },
          with: {
            plot: true,
            product: true,
          },
          extras: {
            geometry: (t) => sql<MultiPolygon>`ST_AsGeoJSON(${t.geometry})::json`.as("geometry"),
          },
        });
      });
    },
    async getCropProtectionApplicationsForPlot(plotId: string): Promise<CropProtectionApplication[]> {
      return rlsDb.rls(async (tx) => {
        return tx.query.cropProtectionApplications.findMany({
          where: { plotId },
          with: {
            plot: true,
            product: true,
          },
          extras: {
            geometry: (t) => sql<MultiPolygon>`ST_AsGeoJSON(${t.geometry})::json`.as("geometry"),
          },
          orderBy: { dateTime: "desc" },
        });
      });
    },
    async getCropProtectionApplicationsForFarm(
      farmId: string,
      fromDate: Date,
      toDate: Date
    ): Promise<CropProtectionApplication[]> {
      return rlsDb.rls(async (tx) => {
        return tx.query.cropProtectionApplications.findMany({
          where: {
            farmId,
            AND: [{ dateTime: { gte: fromDate } }, { dateTime: { lte: toDate } }],
          },
          with: {
            plot: true,
            product: true,
          },
          extras: {
            geometry: (t) => sql<MultiPolygon>`ST_AsGeoJSON(${t.geometry})::json`.as("geometry"),
          },
          orderBy: { dateTime: "desc" },
        });
      });
    },
    async updateCropProtectionApplication(
      id: string,
      data: CropProtectionApplicationUpdateInput
    ): Promise<CropProtectionApplication | undefined> {
      const { dateTime, productId, method, amountPerUnit, numberOfUnits, unit, additionalNotes } = data;
      const values = { dateTime, productId, method, amountPerUnit, numberOfUnits, unit, additionalNotes };
      const hasValues = Object.values(values).some((value) => value !== undefined);
      if (hasValues) {
        await rlsDb.rls(async (tx) => {
          await tx.update(cropProtectionApplications).set(values).where(eq(cropProtectionApplications.id, id));
        });
      }
      return this.getCropProtectionApplicationById(id);
    },
    async deleteCropProtectionApplication(id: string): Promise<void> {
      return rlsDb.rls(async (tx) => {
        await tx.delete(cropProtectionApplications).where(eq(cropProtectionApplications.id, id));
      });
    },
    async getCropProtectionApplicationYears(): Promise<string[]> {
      return rlsDb.rls(async (tx) => {
        const result = await tx.query.cropProtectionApplications.findMany({
          columns: {
            dateTime: true,
          },
          orderBy: { dateTime: "asc" },
        });

        return Array.from(new Set(result.map((application) => application.dateTime.getFullYear().toString())));
      });
    },
    async getCropProtectionApplicationSummaryForFarm(): Promise<CropProtectionApplicationSummary> {
      return rlsDb.rls(async (tx) => {
        const result = await tx.query.cropProtectionApplications.findMany({
          with: { product: true },
        });
        return mapToMonthlySummary(result);
      });
    },
    async getCropProtectionApplicationSummaryForPlot(plotId: string): Promise<CropProtectionApplicationSummary> {
      return rlsDb.rls(async (tx) => {
        const result = await tx.query.cropProtectionApplications.findMany({
          with: { product: true },
          where: { plotId },
        });
        return mapToMonthlySummary(result);
      });
    },
    async createCropProtectionApplicationPreset(
      input: CropProtectionApplicationPresetCreateInput
    ): Promise<CropProtectionApplicationPreset> {
      return rlsDb.rls(async (tx) => {
        const [preset] = await tx
          .insert(cropProtectionApplicationPresets)
          .values({ ...farmIdColumnValue, ...input })
          .returning();
        return preset;
      });
    },
    async getCropProtectionApplicationPresets(): Promise<CropProtectionApplicationPreset[]> {
      return rlsDb.rls(async (tx) => {
        return tx.query.cropProtectionApplicationPresets.findMany({
          orderBy: { name: "asc" },
        });
      });
    },
    async getCropProtectionApplicationPresetById(id: string): Promise<CropProtectionApplicationPreset | undefined> {
      return rlsDb.rls(async (tx) => {
        return tx.query.cropProtectionApplicationPresets.findFirst({
          where: { id },
        });
      });
    },
    async updateCropProtectionApplicationPreset(
      id: string,
      input: CropProtectionApplicationPresetUpdateInput
    ): Promise<CropProtectionApplicationPreset> {
      return rlsDb.rls(async (tx) => {
        const [preset] = await tx
          .update(cropProtectionApplicationPresets)
          .set(input)
          .where(eq(cropProtectionApplicationPresets.id, id))
          .returning();
        return preset;
      });
    },
    async deleteCropProtectionApplicationPreset(id: string): Promise<void> {
      return rlsDb.rls(async (tx) => {
        await tx.delete(cropProtectionApplicationPresets).where(eq(cropProtectionApplicationPresets.id, id));
      });
    },
  };
}

function mapToMonthlySummary(
  result: {
    numberOfUnits: number;
    amountPerUnit: number;
    dateTime: Date;
    product: { id: string; name: string; unit: CropProtectionUnit };
  }[]
) {
  const applications = result.reduce<{
    [key: string]: {
      month: number;
      year: number;
      appliedCropProtections: Record<
        string,
        { totalAmount: number; totalProducedUnits: number; unit: CropProtectionUnit; productName: string }
      >;
    };
  }>((acc, application) => {
    const date = application.dateTime;
    const year = date.getFullYear();
    const month = date.getMonth(); // getMonth() is zero-based
    const product = application.product;

    const key = `${year}-${month}`;
    if (!acc[key]) {
      acc[key] = {
        month,
        year,
        appliedCropProtections: {
          [product.id]: {
            totalAmount: application.numberOfUnits * application.amountPerUnit,
            totalProducedUnits: application.numberOfUnits,
            unit: application.product.unit,
            productName: product.name,
          },
        },
      };
    } else if (!acc[key].appliedCropProtections[product.id]) {
      acc[key].appliedCropProtections[product.id] = {
        totalAmount: application.numberOfUnits * application.amountPerUnit,
        totalProducedUnits: application.numberOfUnits,
        unit: application.product.unit,
        productName: product.name,
      };
    } else {
      acc[key].appliedCropProtections[product.id].totalAmount += application.numberOfUnits * application.amountPerUnit;
      acc[key].appliedCropProtections[product.id].totalProducedUnits += application.numberOfUnits;
    }
    return acc;
  }, {});
  return {
    monthlyApplications: Object.values(applications).map(({ year, month, appliedCropProtections }) => ({
      year,
      month,
      appliedCropProtections: Object.values(appliedCropProtections),
    })),
  };
}
