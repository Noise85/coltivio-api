import { and, eq, inArray, isNull, ne, SQL, sql } from "drizzle-orm";
import createHttpError from "http-errors";
import escapeRegExp from "lodash/escapeRegExp";
import { CropRotation, expandRecurrence } from "../crop-rotations/crop-rotations";
import { TFunction } from "i18next";
import { RlsDb, Transaction } from "../db/db";
import { CodedError } from "../errors";
import {
  cropProtectionApplications,
  cropRotations,
  farmIdColumnValue,
  fertilizerApplications,
  harvests,
  plots,
  tillages,
} from "../db/schema";
import { MultiPolygon } from "../geo/geojson";
import { getParcelsForEnvelopes } from "../geoadmin/geoadmin";
import { parseShapefileZip, ShapefileParseError, ShapefilePlotFields } from "./plot-shapefile-import";
import {
  findPresentOverlayExternalIds,
  insertPlotOverlays,
  isIgnoredUsage,
  isOverlayUsage,
  PlotOverlayInput,
} from "./plot-overlays";
import { createPlotsWithCrops, PlotWithCropInput } from "./create-plots-with-crops";
import { repairedMultiPolygon } from "./plot-geometry";
import { isKnownUsageCode } from "../crops/codeToCropsMapper";

export type SplitPlotInput = {
  geometry: MultiPolygon;
  name: string;
  size: number;
};

export type PlotCreateInput = Omit<typeof plots.$inferInsert, "id" | "farmId" | "geometry" | "archivedAt"> & {
  geometry: MultiPolygon;
};
export type PlotUpdateInput = Partial<Omit<PlotCreateInput, "archivedAt">> & { archived?: boolean };
export type Plot = Omit<typeof plots.$inferSelect, "geometry"> & {
  geometry: MultiPolygon;
  currentCropRotation: CropRotation | null;
};
export type ShapefileImportCompleteness = "full" | "partial" | "geometries_only";
export type ShapefileImportPreviewRow = Omit<ShapefilePlotFields, "size" | "usedDefaults"> & {
  rowNumber: number;
  size: number;
  geometry: MultiPolygon | null;
  overlappingPlotIds: string[];
};
export type ShapefileImportOverlayRow = {
  rowNumber: number;
  externalId: string;
  name: string;
  localId: string | null;
  usage: number;
  usageName: string | null;
  size: number;
  geometry: MultiPolygon;
  alreadyPresent: boolean;
};
export type ShapefileImportPreview = {
  format: { name: string; label: string; geometryOnly: boolean };
  completeness: ShapefileImportCompleteness;
  rows: ShapefileImportPreviewRow[];
  overlays: ShapefileImportOverlayRow[];
};

// An import row conflicts with an existing plot if they share more than 1% of the smaller one. Borders
// digitised slightly differently by two sources leave slivers along shared edges (up to a few hundred m² on
// large plots), which are noise and not conflicts. The ratio needs no metric projection.
function overlapsSignificantly(existingGeometry: SQL, importGeometry: SQL): SQL {
  return sql`ST_Intersects(${existingGeometry}, ${importGeometry})
    AND ST_Area(ST_Intersection(${existingGeometry}, ${importGeometry}))
      > 0.01 * LEAST(ST_Area(${existingGeometry}), ST_Area(${importGeometry}))`;
}

// Area in m² of the given geometry, in the Swiss projection like everywhere else
function areaSquareMeters(geometry: SQL): SQL<number> {
  return sql<number>`ST_Area(ST_Transform(${geometry}, 2056))`;
}

// Gaps between merged plots narrower than twice this are closed. Digitising gaps between neighbouring plots are
// centimetres; real features (ditches, paths, streams) are wider and must stay.
const MERGE_GAP_TOLERANCE_METERS = 0.25;

// Cuts the given (already repaired) geometry out of all other active plots it overlaps. The overlapping plots
// are repaired first, so a plot that was stored invalid does not block saving new ones.
// Plots that only share a border are left alone: cutting changes nothing there, but the repair would rewrite
// them (e.g. join the parts of an old merged plot) and replace their size.
async function cutOutOfOverlappingPlots(tx: Transaction, plotId: string, geometry: string) {
  const repairedPlotGeometry = repairedMultiPolygon(sql`${plots.geometry}`);
  const remainingGeometry = sql`ST_Difference(${repairedPlotGeometry}, ${geometry})`;
  await tx
    .update(plots)
    .set({
      geometry: repairedMultiPolygon(remainingGeometry),
      size: areaSquareMeters(remainingGeometry),
    })
    .where(
      and(
        ne(plots.id, plotId),
        isNull(plots.archivedAt),
        sql`ST_Intersects(${plots.geometry}, ${geometry})`,
        sql`NOT ST_Touches(${repairedPlotGeometry}, ${geometry})`
      )
    );
}

export function plotsApi(rlsDb: RlsDb, t: TFunction) {
  return {
    async createPlot(plotInput: PlotCreateInput): Promise<Plot> {
      const [plotId] = await this.createPlots([plotInput]);
      const plot = await this.getPlotById(plotId);
      return plot!;
    },

    // Creates all plots in a single transaction. Each new plot is cut out of the existing plots it overlaps.
    async createPlots(plotInputs: PlotCreateInput[]): Promise<string[]> {
      return rlsDb.rls(async (tx) => {
        const createdPlotIds: string[] = [];
        for (const plotInput of plotInputs) {
          const [plot] = await tx
            .insert(plots)
            .values({
              ...plotInput,
              ...farmIdColumnValue,
              geometry: repairedMultiPolygon(sql`ST_GeomFromGeoJSON(${JSON.stringify(plotInput.geometry)})`),
            })
            .returning({ id: plots.id, geom: plots.geometry, isEmpty: sql<boolean>`ST_IsEmpty(${plots.geometry})` });
          if (plot.isEmpty) {
            throw new CodedError("invalid_geometry", "Plot geometry has no area");
          }

          await cutOutOfOverlappingPlots(tx, plot.id, plot.geom);
          createdPlotIds.push(plot.id);
        }
        return createdPlotIds;
      });
    },

    async previewShapefileImport(zipBuffer: Buffer): Promise<ShapefileImportPreview> {
      const { srid, format, features } = await parseShapefileZip(zipBuffer);
      return rlsDb.rls(async (tx) => {
        type ProcessedFeature = {
          rowNumber: number;
          fields: ShapefilePlotFields;
          parseErrors: ShapefileParseError[];
          geometry: MultiPolygon | null;
          area: number | null;
          geometryHash: string | null;
          overlappingPlotIds: string[];
        };
        const processed: ProcessedFeature[] = [];
        // set as soon as any row needed a default name or usage
        let anyRowUsedDefaults = false;
        for (const [index, feature] of features.entries()) {
          const rowNumber = index + 1;
          const fields = format.toPlotFields(feature.properties, `${t("plots.plot")} ${rowNumber}`);
          if (fields.usedDefaults) {
            anyRowUsedDefaults = true;
          }
          const parseErrors = [...fields.parseErrors];
          if (feature.rings.length === 0) {
            parseErrors.push({ code: "missing_geometry" });
            processed.push({
              rowNumber,
              fields,
              parseErrors,
              geometry: null,
              area: null,
              geometryHash: null,
              overlappingPlotIds: [],
            });
            continue;
          }

          // Same steps as "Fix geometries" + "Promote to multipart" in QGIS: assemble polygons (with holes)
          // from the rings, reproject to WGS84, make valid, keep only polygon parts and force a MultiPolygon.
          const ringsGeoJson = JSON.stringify({ type: "MultiLineString", coordinates: feature.rings });
          const [result] = await tx.execute<{
            geometry: MultiPolygon | null;
            area: number | null;
            geometry_hash: string | null;
            overlapping_plot_ids: string[];
          }>(sql`
            WITH import_geometry AS (
              SELECT ST_ForcePolygonCCW(ST_Multi(ST_CollectionExtract(ST_MakeValid(
                ST_Transform(ST_BuildArea(ST_SetSRID(ST_GeomFromGeoJSON(${ringsGeoJson}), ${srid}::int)), 4326),
                'method=structure'), 3))) AS geom
            )
            SELECT
              CASE WHEN ST_IsEmpty(import_geometry.geom) THEN NULL ELSE ST_AsGeoJSON(import_geometry.geom)::json END AS geometry,
              ST_Area(ST_Transform(import_geometry.geom, 2056)) AS area,
              CASE WHEN ST_IsEmpty(import_geometry.geom) THEN NULL ELSE md5(ST_AsBinary(import_geometry.geom)) END AS geometry_hash,
              COALESCE((
                SELECT json_agg(${plots.id})
                FROM ${plots}
                WHERE ${plots.archivedAt} IS NULL
                  AND ${overlapsSignificantly(sql`${plots.geometry}`, sql`import_geometry.geom`)}
              ), '[]'::json) AS overlapping_plot_ids
            FROM import_geometry
          `);

          if (!result?.geometry) {
            parseErrors.push({ code: "invalid_geometry" });
          }
          processed.push({
            rowNumber,
            fields,
            parseErrors,
            geometry: result?.geometry ?? null,
            area: result?.area ?? null,
            geometryHash: result?.geometry_hash ?? null,
            overlappingPlotIds: result?.overlapping_plot_ids ?? [],
          });
        }

        // Overlay elements (trees, Ackerschonstreifen) are stored apart from the plots. Rows without a
        // geometry stay in the plot list so the user sees the error.
        const isOverlayRow = (row: ProcessedFeature) => row.geometry !== null && isOverlayUsage(row.fields.usage);
        const importedRows = processed.filter((row) => !isIgnoredUsage(row.fields.usage));
        const plotRows = importedRows.filter((row) => !isOverlayRow(row));
        const overlayRows = importedRows.filter(isOverlayRow);

        // A parcel number that repeats in the file (several Kulturen on one parcel) gets the crop appended
        // to its name, e.g. "306 Winterweizen", so the plots can be told apart.
        const localIdCounts = new Map<string, number>();
        for (const row of plotRows) {
          if (row.fields.localId !== null) {
            localIdCounts.set(row.fields.localId, (localIdCounts.get(row.fields.localId) ?? 0) + 1);
          }
        }
        const nameFor = (row: ProcessedFeature) => {
          const { localId, name, usage, usageName } = row.fields;
          if (localId === null || name !== localId || (localIdCounts.get(localId) ?? 0) < 2) return name;
          const label =
            usage !== null && isKnownUsageCode(usage)
              ? // @ts-ignore the code list is not part of the typed keys, same cast as in codeToCropsMapper
                (t(`crops.codes.${usage}`) as string)
              : (usageName ?? String(row.rowNumber));
          return `${localId} ${label}`;
        };

        // without an id in the file, geometry plus usage identifies the overlay (one area can carry several tree types)
        const overlayExternalId = (row: ProcessedFeature) =>
          row.fields.externalId ?? `${row.geometryHash}:${row.fields.usage}`;
        const presentOverlayIds = await findPresentOverlayExternalIds(tx, overlayRows.map(overlayExternalId));

        let completeness: ShapefileImportCompleteness = "full";
        if (format.geometryOnly) {
          completeness = "geometries_only";
        } else if (anyRowUsedDefaults) {
          completeness = "partial";
        }
        return {
          format: { name: format.name, label: format.label, geometryOnly: format.geometryOnly },
          completeness,
          rows: plotRows.map((row) => ({
            rowNumber: row.rowNumber,
            externalId: row.fields.externalId,
            name: nameFor(row),
            localId: row.fields.localId,
            usage: row.fields.usage,
            usageName: row.fields.usageName,
            size: row.fields.size ?? Math.round(row.area ?? 0),
            cuttingDate: row.fields.cuttingDate,
            municipality: row.fields.municipality,
            geometry: row.geometry,
            overlappingPlotIds: row.overlappingPlotIds,
            parseErrors: row.parseErrors,
          })),
          overlays: overlayRows.map((row) => ({
            rowNumber: row.rowNumber,
            externalId: overlayExternalId(row),
            name: row.fields.name,
            localId: row.fields.localId,
            usage: row.fields.usage!,
            usageName: row.fields.usageName,
            size: row.fields.size ?? Math.round(row.area ?? 0),
            geometry: row.geometry!,
            alreadyPresent: presentOverlayIds.has(overlayExternalId(row)),
          })),
        };
      });
    },

    // Writes the rows the user selected in the import preview. Unlike manual plot creation, existing plots
    // are never cut: the whole import fails if a row overlaps one of them.
    async commitShapefileImport(
      farmId: string,
      source: string,
      rows: PlotWithCropInput[],
      overlays: PlotOverlayInput[]
    ): Promise<{ created: number; overlaysCreated: number; overlaysSkipped: number }> {
      const nonOverlayUsages = overlays.filter((overlay) => !isOverlayUsage(overlay.usage)).map((o) => o.usage);
      if (nonOverlayUsages.length > 0) {
        throw createHttpError(400, `Overlays with a usage code that is not an overlay: ${nonOverlayUsages.join(", ")}`);
      }
      return rlsDb.rls(async (tx) => {
        if (rows.length > 0) {
          // checked in the same transaction as the insert, the preview may be outdated
          const overlaps = await tx.execute<{ row_number: number; plot_id: string }>(sql`
            SELECT import_rows.row_number, ${plots.id} AS plot_id
            FROM json_array_elements(${JSON.stringify(rows.map((row) => row.geometry))}::json)
              WITH ORDINALITY AS import_rows(geometry, row_number)
            JOIN ${plots}
              ON ${plots.archivedAt} IS NULL
              AND ${overlapsSignificantly(sql`${plots.geometry}`, sql`ST_GeomFromGeoJSON(import_rows.geometry::text)`)}
            ORDER BY import_rows.row_number
          `);
          if (overlaps.length > 0) {
            const conflicts = overlaps.map((overlap) => `row ${overlap.row_number} overlaps plot ${overlap.plot_id}`);
            throw createHttpError(409, `Import overlaps existing plots: ${conflicts.join(", ")}`);
          }
        }
        const plotIds = await createPlotsWithCrops(tx, farmId, t, rows);
        const overlayResult = await insertPlotOverlays(tx, farmId, source, overlays);
        return {
          created: plotIds.length,
          overlaysCreated: overlayResult.created,
          overlaysSkipped: overlayResult.skipped,
        };
      });
    },

    async getPlotById(id: string): Promise<Plot | undefined> {
      return rlsDb.rls(async (tx) => {
        const today = new Date();
        const plot = await tx.query.plots.findFirst({
          where: { id },
          with: {
            cropRotations: {
              where: {
                fromDate: { lte: today },
                OR: [
                  { toDate: { gte: today } },
                  {
                    recurrence: {
                      OR: [{ until: { isNull: true } }, { until: { gte: today } }],
                    },
                  },
                ],
              },
              orderBy: { fromDate: "desc" },
              with: {
                crop: { with: { family: true } },
                recurrence: true,
              },
            },
          },
          extras: {
            geometry: (t) => sql<MultiPolygon>`ST_AsGeoJSON(${t.geometry})::json`.as("geometry"),
          },
        });
        if (plot) {
          const { cropRotations, ...rest } = plot;
          const [currentRotation] = cropRotations;
          return {
            ...rest,
            currentCropRotation: currentRotation
              ? (expandRecurrence(currentRotation, today, today).find(
                  (rotation) => rotation.fromDate <= today && rotation.toDate >= today
                ) ?? null)
              : null,
          };
        }
      });
    },

    async getPlotsForFarm(farmId: string, includeArchived: boolean = false): Promise<Plot[]> {
      return rlsDb.rls(async (tx) => {
        const today = new Date();
        const plots = await tx.query.plots.findMany({
          where: includeArchived ? { farmId } : { farmId, archivedAt: { isNull: true } },
          orderBy: (plots, { asc }) => [asc(plots.name), asc(plots.localId), asc(plots.usage)],
          with: {
            cropRotations: {
              orderBy: { fromDate: "desc" },
              where: {
                fromDate: { lte: today },
                OR: [
                  { toDate: { gte: today } },
                  {
                    recurrence: {
                      OR: [{ until: { isNull: true } }, { until: { gte: today } }],
                    },
                  },
                ],
              },
              with: {
                crop: { with: { family: true } },
                recurrence: true,
              },
            },
          },
          extras: {
            geometry: (t) => sql<MultiPolygon>`ST_AsGeoJSON(${t.geometry})::json`.as("geometry"),
          },
        });
        return plots.map(({ cropRotations, ...plot }) => ({
          ...plot,
          currentCropRotation: cropRotations[0]
            ? (expandRecurrence(cropRotations[0], today, today).find(
                (rotation) => rotation.fromDate <= today && rotation.toDate >= today
              ) ?? null)
            : null,
        }));
      });
    },

    async updatePlot(id: string, data: PlotUpdateInput): Promise<Plot> {
      const { archived, ...plotData } = data;
      const result = await rlsDb.rls(async (tx) => {
        const [plot] = await tx
          .update(plots)
          .set({
            ...plotData,
            ...(archived !== undefined ? { archivedAt: archived ? new Date() : null } : {}),
            geometry: data.geometry
              ? repairedMultiPolygon(sql`ST_GeomFromGeoJSON(${JSON.stringify(data.geometry)})`)
              : undefined,
          })
          .where(eq(plots.id, id))
          .returning({
            id: plots.id,
            geometry: plots.geometry,
            archivedAt: plots.archivedAt,
            isEmpty: sql<boolean>`ST_IsEmpty(${plots.geometry})`,
          });
        if (!plot) throw createHttpError(404, "Plot not found");

        if (data.geometry) {
          if (plot.isEmpty) {
            throw new CodedError("invalid_geometry", "Plot geometry has no area");
          }
          // Archived plots may overlap active ones, so they don't cut anything
          if (!plot.archivedAt) {
            await cutOutOfOverlappingPlots(tx, plot.id, plot.geometry);
          }
        }
        return plot;
      });
      const plot = await this.getPlotById(result.id);
      return plot!;
    },

    async deletePlot(id: string): Promise<void> {
      return rlsDb.rls(async (tx) => {
        await tx.delete(plots).where(eq(plots.id, id));
      });
    },

    async splitPlot(
      plotId: string,
      subPlots: SplitPlotInput[],
      options:
        | { strategy: "keep_reference"; originalPlotName?: string; archiveReference?: boolean }
        | { strategy: "delete_and_migrate"; migrateToIndex: number }
    ): Promise<Plot[]> {
      const createdIds = await rlsDb.rls(async (tx) => {
        const originalPlot = await tx.query.plots.findFirst({
          where: { id: plotId },
        });
        if (!originalPlot) throw new Error("Plot not found");

        const ids: string[] = [];

        // Create sub-plots
        for (const subPlot of subPlots) {
          const geometry = repairedMultiPolygon(sql`ST_GeomFromGeoJSON(${JSON.stringify(subPlot.geometry)})`);
          const [created] = await tx
            .insert(plots)
            .values({
              ...farmIdColumnValue,
              name: subPlot.name,
              size: subPlot.size,
              usage: originalPlot.usage,
              cuttingDate: originalPlot.cuttingDate,
              localId: originalPlot.localId,
              geometry,
            })
            .returning({ id: plots.id, isEmpty: sql<boolean>`ST_IsEmpty(${plots.geometry})` });
          if (created.isEmpty) {
            throw new CodedError("invalid_geometry", "Sub-plot geometry has no area");
          }
          ids.push(created.id);
        }

        if (options.strategy === "keep_reference") {
          // Original plot is kept as a reference only (for field calendar etc.) with no area.
          // All area goes to the sub-plots.
          await tx
            .update(plots)
            .set({
              geometry: sql<MultiPolygon>`ST_GeomFromGeoJSON(${JSON.stringify({ type: "MultiPolygon", coordinates: [] })})`,
              size: 0,
              ...(options.originalPlotName ? { name: options.originalPlotName } : {}),
              ...(options.archiveReference ? { archivedAt: new Date() } : {}),
            })
            .where(eq(plots.id, plotId));
        } else {
          // Migrate all historical references to the chosen sub-plot, then delete original
          const targetId = ids[options.migrateToIndex];
          if (!targetId) throw new Error("migrateToIndex out of bounds");

          const migrationTables = [
            cropRotations,
            tillages,
            cropProtectionApplications,
            harvests,
            fertilizerApplications,
          ] as const;
          for (const table of migrationTables) {
            await tx.update(table).set({ plotId: targetId }).where(eq(table.plotId, plotId));
          }

          await tx.delete(plots).where(eq(plots.id, plotId));
        }

        return ids;
      });

      // Fetch and return all created sub-plots
      const result: Plot[] = [];
      for (const id of createdIds) {
        const plot = await this.getPlotById(id);
        if (plot) result.push(plot);
      }
      return result;
    },

    async mergePlots(
      plotIds: string[],
      plotData: {
        name: string;
        localId?: string;
        usage?: number;
        additionalUsages?: string;
        cuttingDate?: Date | null;
        additionalNotes?: string;
      },
      options: { strategy: "keep_reference"; archiveReference?: boolean } | { strategy: "delete_and_migrate" }
    ): Promise<Plot> {
      const newPlotId = await rlsDb.rls(async (tx) => {
        // Union of the source plots: adjacent plots become one polygon, plots that don't touch stay separate parts.
        // Collecting them instead would keep the shared edges, which makes the MultiPolygon invalid.
        // Neighbouring plots rarely share the exact same border, so the union keeps thin slivers (holes or notches)
        // where they don't quite touch. Growing the union and shrinking it back (in metres) closes those gaps.
        // Mitre joins keep the corners sharp; round joins would turn every inner corner into an arc of extra vertices
        // that also reaches into neighbouring plots.
        const unionGeometry = sql`(SELECT ST_Transform(ST_Buffer(ST_Buffer(ST_Transform(ST_Union(${repairedMultiPolygon(sql`${plots.geometry}`)}), 2056), ${MERGE_GAP_TOLERANCE_METERS}, 'join=mitre'), ${-MERGE_GAP_TOLERANCE_METERS}, 'join=mitre'), 4326) FROM ${plots} WHERE ${inArray(plots.id, plotIds)})`;
        const collectedGeometry = repairedMultiPolygon(unionGeometry);

        const [newPlot] = await tx
          .insert(plots)
          .values({
            ...farmIdColumnValue,
            name: plotData.name,
            localId: plotData.localId,
            usage: plotData.usage,
            cuttingDate: plotData.cuttingDate,
            size: areaSquareMeters(collectedGeometry),
            geometry: collectedGeometry,
          })
          .returning({ id: plots.id, geometry: plots.geometry, isEmpty: sql<boolean>`ST_IsEmpty(${plots.geometry})` });
        if (newPlot.isEmpty) {
          throw new CodedError("invalid_geometry", "Merged plot geometry has no area");
        }

        if (options.strategy === "delete_and_migrate") {
          // Migrate relation tables (excluding cropRotations) from source plots to new plot
          const migrationTables = [tillages, cropProtectionApplications, harvests, fertilizerApplications] as const;
          for (const table of migrationTables) {
            await tx.update(table).set({ plotId: newPlot.id }).where(inArray(table.plotId, plotIds));
          }

          // Delete source plots (cascade deletes their crop rotations)
          await tx.delete(plots).where(inArray(plots.id, plotIds));
        } else {
          // Set the source plots geometry and size to empty
          await tx
            .update(plots)
            .set({
              geometry: sql<MultiPolygon>`ST_GeomFromGeoJSON(${JSON.stringify({
                type: "MultiPolygon",
                coordinates: [],
              })})`,
              size: 0,
              ...(options.archiveReference ? { archivedAt: new Date() } : {}),
            })
            .where(inArray(plots.id, plotIds));
        }

        // Closing the gaps can grow the merged plot slightly into neighbouring plots; the source plots are
        // already empty or deleted at this point, so only other plots are cut
        await cutOutOfOverlappingPlots(tx, newPlot.id, newPlot.geometry);

        return newPlot.id;
      });

      const plot = await this.getPlotById(newPlotId);
      return plot!;
    },

    async syncMissingLocalIds(): Promise<void> {
      return rlsDb.rls(async (tx) => {
        const clusters = await tx.$with("clusters").as(
          tx
            .select({
              farmId: plots.farmId,
              cluster: sql`UNNEST(ST_ClusterWithin(${plots.geometry}, 0.0005) over (partition by ${plots.farmId}))`.as(
                "cluster"
              ),
            })
            .from(plots)
            .where(isNull(plots.localId))
        );

        const envelopes = await tx.$with("envelopes").as(
          tx
            .select({
              farmId: clusters.farmId,
              box: sql`ST_Extent(${clusters.cluster})`.as("box"),
            })
            .from(clusters)
            .groupBy(clusters.farmId, clusters.cluster)
        );

        const selectEsriEnvelope = sql<string>` 
        ST_XMin(${envelopes.box})::TEXT || ',' ||
        ST_YMin(${envelopes.box})::TEXT || ',' ||
        ST_XMax(${envelopes.box})::TEXT || ',' ||
        ST_YMax(${envelopes.box})::TEXT
        `;
        const plotGroups = await tx
          .with(clusters, envelopes)
          .select({ farmId: envelopes.farmId, envelope: selectEsriEnvelope })
          .from(envelopes);

        const geoAdminParcels = await getParcelsForEnvelopes(plotGroups.map((group) => group.envelope));

        const candidates = await tx.query.plots.findMany({
          where: { localId: { isNull: true } },
        });
        const plotIds = candidates.map((candidate) => candidate.id);
        // Only generated names give way to the parcel number: "3" from farm creation, "Schlag 3" from a file
        // import. Names the farmer chose (e.g. from the Acorda export) are kept.
        const defaultNamePattern = `^(${escapeRegExp(t("plots.plot"))} )?[0-9]+$`;

        for (const parcel of geoAdminParcels) {
          if (parcel.properties.number) {
            await tx
              .update(plots)
              .set({
                localId: parcel.properties.number,
                name: sql`CASE WHEN ${plots.name} ~ ${defaultNamePattern} THEN ${parcel.properties.number} ELSE ${plots.name} END`,
              })
              .where(
                and(
                  inArray(plots.id, plotIds),
                  sql`ST_Within(${plots.geometry}, ST_Buffer(ST_MakeValid(ST_GeomFromGeoJSON(${JSON.stringify(parcel.geometry)})), 0.0001))`
                )
              );
          }
        }
      });
    },
  };
}
