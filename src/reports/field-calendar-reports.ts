import * as Sentry from "@sentry/node";
import ExcelJS from "exceljs";
import { TFunction } from "i18next";
import { txEmailApi } from "../brevo/brevo";
import { RlsDb } from "../db/db";

export function fieldCalendarReportsApi(rlsDb: RlsDb, t: TFunction, locale: string = "de") {
  return {
    async generateReportBuffer(
      fromDate: Date,
      toDate: Date,
      cropRotations: boolean,
      tillages: boolean,
      fertilizerApplications: boolean,
      cropProtectionApplications: boolean,
      harvests: boolean
    ): Promise<{ buffer: Buffer; fileName: string }> {
      const selectedFlags = {
        cropRotations,
        tillages,
        fertilizerApplications,
        cropProtectionApplications,
        harvests,
      };
      return await rlsDb.rls(async (tx) => {
        // Plots archived before the report period are left out, plots archived during it are shown up to that day
        const plots = await tx.query.plots.findMany({
          where: { OR: [{ archivedAt: { isNull: true } }, { archivedAt: { gte: fromDate } }] },
          with: {
            cropRotations: {
              orderBy: { fromDate: "asc" },
              with: { crop: true, recurrence: true },
              // Fetch all rotations whose base starts before the range end;
              // expansion logic handles filtering overlapping occurrences
              where: { fromDate: { lte: toDate } },
            },
            tillages: {
              orderBy: { date: "desc" },
              where: {
                AND: [{ date: { gte: fromDate } }, { date: { lte: toDate } }],
              },
            },
            harvests: {
              with: { crop: true },
              orderBy: { date: "desc" },
              where: {
                AND: [{ date: { gte: fromDate } }, { date: { lte: toDate } }],
              },
            },
            fertilizerApplications: {
              with: { fertilizer: true },
              orderBy: { date: "desc" },
              where: {
                AND: [{ date: { gte: fromDate } }, { date: { lte: toDate } }],
              },
            },
            cropProtectionApplications: {
              with: { product: true },
              orderBy: { dateTime: "desc" },
              where: {
                AND: [{ dateTime: { gte: fromDate } }, { dateTime: { lte: toDate } }],
              },
            },
          },
        });

        const workbook = new ExcelJS.Workbook();

        // ── Shared timeline helpers ────────────────────────────────────────────
        // Build ordered list of { year, month } covering fromDate..toDate
        const timelineMonths: { year: number; month: number }[] = [];
        {
          let cur = new Date(fromDate.getFullYear(), fromDate.getMonth(), 1);
          const rangeEnd = new Date(toDate.getFullYear(), toDate.getMonth(), 1);
          while (cur <= rangeEnd) {
            timelineMonths.push({ year: cur.getFullYear(), month: cur.getMonth() });
            cur = new Date(cur.getFullYear(), cur.getMonth() + 1, 1);
          }
        }

        // Pastel color palette — one color per cropId, assigned in encounter order
        const CROP_COLORS = [
          "FFB7D7E8",
          "FFFFD6A5",
          "FFCAFFBF",
          "FFFFADAD",
          "FFE2CFFF",
          "FFFFFFB3",
          "FFBDE0FF",
          "FFFFC6FF",
          "FFDDE5B6",
          "FFB5EAD7",
          "FFFFCCF9",
          "FFCCE5FF",
        ];
        const cropColorMap = new Map<string, string>();
        let cropColorIndex = 0;
        const getCropColor = (cropId: string): string => {
          if (!cropColorMap.has(cropId)) {
            cropColorMap.set(cropId, CROP_COLORS[cropColorIndex % CROP_COLORS.length]);
            cropColorIndex++;
          }
          return cropColorMap.get(cropId)!;
        };

        // Format date as DD.MM without year
        const fmtDate = (d: Date) => d.toLocaleDateString(locale, { day: "2-digit", month: "2-digit" });

        const PLOT_COL = 1;
        const MONTH_START_COL = 2;

        // Write year + month header rows onto a sheet starting at startRow
        const writeTimelineHeaders = (sheet: ExcelJS.Worksheet, startRow: number) => {
          const yearRow = startRow;
          const monthRow = startRow + 1;

          // Year headers — merge consecutive months of the same year
          let yearGroupStart = 0;
          for (let i = 0; i <= timelineMonths.length; i++) {
            const isNewYear =
              i === timelineMonths.length || timelineMonths[i].year !== timelineMonths[yearGroupStart].year;
            if (isNewYear) {
              const startCol = MONTH_START_COL + yearGroupStart;
              const endCol = MONTH_START_COL + i - 1;
              if (startCol < endCol) sheet.mergeCells(yearRow, startCol, yearRow, endCol);
              const yearCell = sheet.getCell(yearRow, startCol);
              yearCell.value = timelineMonths[yearGroupStart].year;
              yearCell.font = { bold: true, color: { argb: "FFFFFFFF" } };
              yearCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF2F5496" } };
              yearCell.alignment = { horizontal: "center", vertical: "middle" };
              yearGroupStart = i;
            }
          }

          // Plot label cell
          const plotLabelCell = sheet.getCell(monthRow, PLOT_COL);
          plotLabelCell.value = t("plots.plot");
          plotLabelCell.font = { bold: true, color: { argb: "FFFFFFFF" } };
          plotLabelCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF4472C4" } };

          // Month name cells
          for (let i = 0; i < timelineMonths.length; i++) {
            const monthDate = new Date(timelineMonths[i].year, timelineMonths[i].month, 1);
            const monthCell = sheet.getCell(monthRow, MONTH_START_COL + i);
            monthCell.value = monthDate.toLocaleDateString(locale, { month: "short" });
            monthCell.font = { bold: true, color: { argb: "FFFFFFFF" } };
            monthCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF4472C4" } };
            monthCell.alignment = { horizontal: "center", vertical: "middle" };
            sheet.getColumn(MONTH_START_COL + i).width = 12;
          }
          sheet.getColumn(PLOT_COL).width = 22;
        };

        const ROW_BORDER: Partial<ExcelJS.Border> = { style: "medium", color: { argb: "FF505050" } };
        const COL_BORDER: Partial<ExcelJS.Border> = { style: "thin", color: { argb: "FF808080" } };

        // Expand a crop rotation (with optional yearly recurrence) into concrete fromDate/toDate
        // pairs that overlap [rangeFrom, rangeTo]. On archived plots occurrences end on the archive date.
        const expandCropRotation = (
          rotation: (typeof plots)[0]["cropRotations"][0],
          rangeFrom: Date,
          rangeTo: Date,
          archivedAt: Date | null
        ): { fromDate: Date; toDate: Date }[] => {
          const base = rotation.fromDate;
          const durationMs = rotation.toDate.getTime() - base.getTime();
          const rec = rotation.recurrence;
          const results: { fromDate: Date; toDate: Date }[] = [];

          let n = 0;
          while (true) {
            // Advance by interval years (n=0 is the base occurrence)
            const occFrom = new Date(
              base.getFullYear() + (rec ? rec.interval * n : 0),
              base.getMonth(),
              base.getDate()
            );
            const occTo = new Date(occFrom.getTime() + durationMs);

            if (occFrom > rangeTo) break;
            if (rec?.until && occFrom > rec.until) break;

            if (archivedAt && occFrom > archivedAt) break;

            if (occTo >= rangeFrom) {
              results.push({ fromDate: occFrom, toDate: archivedAt && occTo > archivedAt ? archivedAt : occTo });
            }

            if (!rec) break; // no recurrence, only one occurrence
            n++;
          }
          return results;
        };

        // Write rotation bars for one plot's rotations on a single sheet row.
        // Fills each month cell individually (no merging) so column borders remain visible.
        // Dark bottom border separates rows; light gray right border separates columns.
        const writeRotationBars = (
          sheet: ExcelJS.Worksheet,
          row: number,
          rotations: (typeof plots)[0]["cropRotations"],
          archivedAt: Date | null
        ) => {
          // Collect all expanded occurrences mapped to month indices
          type Occurrence = { monthIdx: number; label: string | null; cropId: string };
          const monthFill: Occurrence[] = [];

          for (const rotation of rotations) {
            const occurrences = expandCropRotation(rotation, fromDate, toDate, archivedAt);
            for (const occ of occurrences) {
              let isFirstCell = true;
              for (let i = 0; i < timelineMonths.length; i++) {
                const { year, month } = timelineMonths[i];
                const firstDay = new Date(year, month, 1);
                const lastDay = new Date(year, month + 1, 0);
                if (occ.fromDate <= lastDay && occ.toDate >= firstDay) {
                  monthFill.push({
                    monthIdx: i,
                    // Label only on the first cell of the bar
                    label: isFirstCell
                      ? `${rotation.crop.name}  ${fmtDate(occ.fromDate)} – ${fmtDate(occ.toDate)}`
                      : null,
                    cropId: rotation.cropId,
                  });
                  isFirstCell = false;
                }
              }
            }
          }

          const filledIndices = new Set(monthFill.map((f) => f.monthIdx));

          // Style all month cells — filled or empty
          for (let i = 0; i < timelineMonths.length; i++) {
            const col = MONTH_START_COL + i;
            const cell = sheet.getCell(row, col);
            cell.border = {
              bottom: ROW_BORDER,
              right: COL_BORDER,
              left: i === 0 ? COL_BORDER : undefined,
            };
            if (!filledIndices.has(i)) continue;
            const fill = monthFill.find((f) => f.monthIdx === i)!;
            cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: getCropColor(fill.cropId) } };
            if (fill.label) {
              cell.value = fill.label;
              cell.alignment = { vertical: "middle", wrapText: false };
            }
          }
        };
        // ── End shared helpers ─────────────────────────────────────────────────

        generateMainSheet();
        if (cropRotations) generateRotationTimelineSheet();
        generatePerPlotSheet();

        function generateMainSheet() {
          const tillageRows: any[][] = [];
          const fertilizerApplicationRows: any[][] = [];
          const cropProtectionApplicationRows: any[][] = [];
          const harvestRows: any[][] = [];

          for (const plot of plots) {
            if (tillages) {
              plot.tillages.forEach((tillage) => {
                tillageRows.push([
                  plot.name,
                  plot.usage,
                  tillage.date.toLocaleDateString(locale),
                  (tillage.size / 100).toFixed(2),
                  tillage.reason ? t(`tillages.reasons.${tillage.reason}`) : "",
                  t(`tillages.actions.${tillage.action}`),
                ]);
              });
            }

            if (fertilizerApplications) {
              plot.fertilizerApplications.forEach((application) => {
                fertilizerApplicationRows.push([
                  plot.name,
                  plot.usage,
                  application.date.toLocaleDateString(locale),
                  (application.size / 100).toFixed(2),
                  application.fertilizer.name,
                  t(`units.short.${application.fertilizer.unit}`),
                  t(`application_units.${application.unit}`),
                  application.numberOfUnits,
                  application.amountPerUnit,
                  application.amountPerUnit * application.numberOfUnits,
                ]);
              });
            }

            if (cropProtectionApplications) {
              plot.cropProtectionApplications.forEach((application) => {
                cropProtectionApplicationRows.push([
                  plot.name,
                  plot.usage,
                  application.dateTime.toLocaleDateString(locale, {
                    hour: "2-digit",
                    minute: "2-digit",
                  }),
                  (application.size / 100).toFixed(2),
                  application.product.name,
                  t(`units.short.${application.product.unit}`),
                  t(`application_units.${application.unit}`),
                  application.numberOfUnits,
                  application.amountPerUnit,
                  application.amountPerUnit * application.numberOfUnits,
                ]);
              });
            }

            if (harvests) {
              plot.harvests.forEach((harvest) => {
                harvestRows.push([
                  plot.name,
                  plot.usage,
                  harvest.date.toLocaleDateString(locale),
                  (harvest.size / 100).toFixed(2),
                  harvest.crop.name,
                  t(`harvests.labels.harvest_units.${harvest.unit}`),
                  harvest.conservationMethod
                    ? t(`harvests.labels.conservation_method.${harvest.conservationMethod}`)
                    : "",
                  harvest.numberOfUnits,
                  harvest.kilosPerUnit,
                  harvest.numberOfUnits * harvest.kilosPerUnit,
                ]);
              });
            }
          }

          const sheet = workbook.addWorksheet(t("field_calendar_report.sheet_titles.main_short"));
          let rowIndex = 1;
          sheet.mergeCells(`A${rowIndex}:J${rowIndex}`);
          const mainTitle = sheet.getCell(`A${rowIndex}`);
          mainTitle.value = t("field_calendar_report.sheet_titles.main", {
            fromDate: fromDate.toLocaleDateString("de", {
              hour: "2-digit",
              minute: "2-digit",
            }),
            toDate: toDate.toLocaleDateString("de", {
              hour: "2-digit",
              minute: "2-digit",
            }),
          });
          mainTitle.font = { bold: true, size: 20, color: { argb: "FFFFFFFF" } };
          mainTitle.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF2F5496" } };
          mainTitle.alignment = { vertical: "middle" };
          rowIndex += 3;

          if (tillages && tillageRows.length > 0) {
            //tillages table
            sheet.mergeCells(`A${rowIndex}:J${rowIndex}`);
            sheet.getCell(`A${rowIndex}`).value = t("tillages.tillage");
            sheet.getCell(`A${rowIndex}`).font = { bold: true, size: 14, color: { argb: "FFFFFFFF" } };
            sheet.getCell(`A${rowIndex}`).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF4472C4" } };
            rowIndex += 2;

            sheet.addTable({
              name: "main_tillages",
              ref: `A${rowIndex}`,
              headerRow: true,
              style: { showRowStripes: true },
              columns: [
                { name: t("plots.plot") },
                { name: t("plots.usage") },
                { name: t("common.date") },
                { name: t("common.size_a") },
                { name: t("common.reason") },
                { name: t("common.action") },
              ],
              rows: tillageRows,
            });
            rowIndex += tillageRows.length + 3;
          }

          if (fertilizerApplications && fertilizerApplicationRows.length > 0) {
            // table fertilizer applications
            sheet.mergeCells(`A${rowIndex}:J${rowIndex}`);
            sheet.getCell(`A${rowIndex}`).value = t("fertilizer_applications.fertilizer_application");
            sheet.getCell(`A${rowIndex}`).font = { bold: true, size: 14, color: { argb: "FFFFFFFF" } };
            sheet.getCell(`A${rowIndex}`).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF4472C4" } };
            rowIndex += 2;

            sheet.addTable({
              name: "main_fertilizer_applications",
              ref: `A${rowIndex}`,
              headerRow: true,
              style: { showRowStripes: true },
              columns: [
                { name: t("plots.plot") },
                { name: t("plots.usage") },
                { name: t("common.date") },
                { name: t("common.size_a") },
                { name: t("fertilizer_applications.fertilizer") },
                { name: t("common.unit") },
                { name: t("common.application_unit") },
                { name: t("common.number_of_application_units") },
                { name: t("common.amount_per_application_unit") },
                { name: t("common.total") },
              ],
              rows: fertilizerApplicationRows,
            });
            rowIndex += fertilizerApplicationRows.length + 3;
          }

          if (cropProtectionApplications && cropProtectionApplicationRows.length > 0) {
            // table crop protection applications
            sheet.mergeCells(`A${rowIndex}:J${rowIndex}`);
            sheet.getCell(`A${rowIndex}`).value = t("crop_protections.crop_protection");
            sheet.getCell(`A${rowIndex}`).font = { bold: true, size: 14, color: { argb: "FFFFFFFF" } };
            sheet.getCell(`A${rowIndex}`).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF4472C4" } };
            rowIndex += 2;

            sheet.addTable({
              name: "main_crop_protection_applications",
              ref: `A${rowIndex}`,
              headerRow: true,
              style: { showRowStripes: true },
              columns: [
                { name: t("plots.plot") },
                { name: t("plots.usage") },
                { name: t("common.date") },
                { name: t("common.size_a") },
                { name: t("crop_protections.product") },
                { name: t("common.unit") },
                { name: t("common.application_unit") },
                { name: t("common.number_of_application_units") },
                { name: t("common.amount_per_application_unit") },
                { name: t("common.total") },
              ],
              rows: cropProtectionApplicationRows,
            });

            rowIndex += cropProtectionApplicationRows.length + 3;
          }

          if (harvests && harvestRows.length > 0) {
            // table harvests
            sheet.mergeCells(`A${rowIndex}:J${rowIndex}`);
            sheet.getCell(`A${rowIndex}`).value = t("harvests.harvest");
            sheet.getCell(`A${rowIndex}`).font = { bold: true, size: 14, color: { argb: "FFFFFFFF" } };
            sheet.getCell(`A${rowIndex}`).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF4472C4" } };
            rowIndex += 2;

            sheet.addTable({
              name: "main_harvests",
              ref: `A${rowIndex}`,
              headerRow: true,
              style: { showRowStripes: true },
              columns: [
                { name: t("plots.plot") },
                { name: t("plots.usage") },
                { name: t("common.date") },
                { name: t("common.size_a") },
                { name: t("crops.crop") },
                { name: t("harvests.application_unit") },
                { name: t("harvests.conservation") },
                { name: t("harvests.produced_units") },
                { name: t("harvests.kilos_per_unit") },
                { name: t("harvests.total_kilos") },
              ],
              rows: harvestRows,
            });
            rowIndex += harvestRows.length + 3;
          }
        }

        function generatePerPlotSheet() {
          const sheet = workbook.addWorksheet(t("field_calendar_report.sheet_titles.per_plot_short"));
          let rowIndex = 1;

          sheet.mergeCells(`A${rowIndex}:H${rowIndex}`);
          const perPlotTitle = sheet.getCell(`A${rowIndex}`);
          perPlotTitle.value = t("field_calendar_report.sheet_titles.per_plot", {
            fromDate: fromDate.toLocaleDateString("de", {
              hour: "2-digit",
              minute: "2-digit",
            }),
            toDate: toDate.toLocaleDateString("de", {
              hour: "2-digit",
              minute: "2-digit",
            }),
          });
          perPlotTitle.font = { bold: true, size: 20, color: { argb: "FFFFFFFF" } };
          perPlotTitle.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF2F5496" } };
          perPlotTitle.alignment = { vertical: "middle" };
          rowIndex += 3;

          let plotIndex = 0;
          for (const plot of plots) {
            if (
              (Object.entries(selectedFlags) as Array<[keyof typeof selectedFlags, boolean]>).every(
                ([key, isSelected]) => !isSelected || plot[key].length === 0
              )
            ) {
              continue;
            }

            const { name, size, usage } = plot;

            // Plot banner
            sheet.mergeCells(`A${rowIndex}:H${rowIndex}`);
            const plotBanner = sheet.getCell(`A${rowIndex}`);
            plotBanner.value = `${t("plots.plot")}: ${name}`;
            plotBanner.font = { bold: true, size: 14, color: { argb: "FFFFFFFF" } };
            plotBanner.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF2F5496" } };
            plotBanner.alignment = { vertical: "middle" };
            rowIndex += 2;

            // Plot details
            const detailFill: ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFD9E2F3" } };
            sheet.getCell(`A${rowIndex}`).value = t("plots.usage");
            sheet.getCell(`A${rowIndex}`).font = { bold: true };
            sheet.getCell(`A${rowIndex}`).fill = detailFill;
            sheet.getCell(`B${rowIndex}`).value = usage ?? t("common.unknown");
            rowIndex++;
            sheet.getCell(`A${rowIndex}`).value = t("common.size_ha");
            sheet.getCell(`A${rowIndex}`).font = { bold: true };
            sheet.getCell(`A${rowIndex}`).fill = detailFill;
            sheet.getCell(`B${rowIndex}`).value = (size / 10000).toFixed(2);
            rowIndex++;
            sheet.getCell(`A${rowIndex}`).value = t("crops.crop");
            sheet.getCell(`A${rowIndex}`).font = { bold: true };
            sheet.getCell(`A${rowIndex}`).fill = detailFill;
            sheet.getCell(`B${rowIndex}`).value = plot.cropRotations[0]?.crop.name;
            rowIndex += 2;

            // Crop rotation table: one row per expanded occurrence, columns crop / from / to
            if (cropRotations && plot.cropRotations.length > 0) {
              const rotationTableRows = plot.cropRotations.flatMap((rotation) =>
                expandCropRotation(rotation, fromDate, toDate, plot.archivedAt).map((occ) => [
                  rotation.crop.name,
                  occ.fromDate.toLocaleDateString(locale),
                  occ.toDate.toLocaleDateString(locale),
                ])
              );
              if (rotationTableRows.length > 0) {
                sheet.mergeCells(`A${rowIndex}:C${rowIndex}`);
                sheet.getCell(`A${rowIndex}`).value = t("crop_rotations.crop_rotation");
                sheet.getCell(`A${rowIndex}`).font = { bold: true, size: 12, color: { argb: "FFFFFFFF" } };
                sheet.getCell(`A${rowIndex}`).fill = {
                  type: "pattern",
                  pattern: "solid",
                  fgColor: { argb: "FF4472C4" },
                };
                rowIndex++;
                sheet.addTable({
                  name: `rotations_${name}_${plotIndex}`.replace(/[^a-zA-Z0-9_]/g, "_"),
                  ref: `A${rowIndex}`,
                  headerRow: true,
                  style: { showRowStripes: true },
                  columns: [{ name: t("crops.crop") }, { name: t("common.from") }, { name: t("common.to") }],
                  rows: rotationTableRows,
                });
                rowIndex += rotationTableRows.length + 3;
              }
            }

            const addSection = <T>(
              title: string,
              headers: Array<{ key: keyof T; value: string }>,
              data: T[],
              index: number
            ) => {
              if (data.length > 0) {
                sheet.mergeCells(`A${rowIndex}:H${rowIndex}`);
                sheet.getCell(`A${rowIndex}`).value = title;
                sheet.getCell(`A${rowIndex}`).font = { bold: true, size: 12, color: { argb: "FFFFFFFF" } };
                sheet.getCell(`A${rowIndex}`).fill = {
                  type: "pattern",
                  pattern: "solid",
                  fgColor: { argb: "FF4472C4" },
                };
                rowIndex++;

                const tableRows = data.map((entry) => headers.map((header) => entry[header.key] || ""));
                sheet.addTable({
                  name: `${title}_${name}_${index}`.replace(/[^a-zA-Z0-9_]/g, "_"),
                  ref: `A${rowIndex}`,
                  headerRow: true,
                  style: { showRowStripes: true },
                  columns: headers.map((header, _i) => ({ name: header.value })),
                  rows: tableRows,
                });

                rowIndex += tableRows.length + 3;
              }
            };
            if (tillages) {
              addSection(
                t("tillages.tillage"),
                [
                  { key: "date", value: t("common.date") },
                  { key: "size", value: t("common.size_a") },
                  { key: "reason", value: t("common.reason") },
                  { key: "action", value: t("common.action") },
                ],
                plot.tillages.map((tillage) => ({
                  date: tillage.date.toLocaleDateString(locale),
                  size: (tillage.size / 100).toFixed(2),
                  reason: tillage.reason ? t(`tillages.reasons.${tillage.reason}`) : "",
                  action: t(`tillages.actions.${tillage.action}`),
                })),
                plotIndex
              );
            }

            if (fertilizerApplications) {
              addSection(
                t("fertilizer_applications.fertilizer_application"),
                [
                  { key: "date", value: t("common.date") },
                  { key: "size", value: t("common.size_a") },
                  {
                    key: "fertilizer",
                    value: t("fertilizer_applications.fertilizer"),
                  },
                  { key: "unit", value: t("common.unit") },
                  { key: "applicationUnit", value: t("common.application_unit") },
                  {
                    key: "numberOfUnits",
                    value: t("common.number_of_application_units"),
                  },
                  {
                    key: "amountPerUnit",
                    value: t("common.amount_per_application_unit"),
                  },
                  {
                    key: "total",
                    value: t("common.total"),
                  },
                ],
                plot.fertilizerApplications.map((application) => ({
                  date: application.date.toLocaleDateString(locale),
                  size: (application.size / 100).toFixed(2),
                  fertilizer: application.fertilizer.name,
                  unit: t(`units.short.${application.fertilizer.unit}`),
                  applicationUnit: t(`application_units.${application.unit}`),
                  numberOfUnits: application.numberOfUnits,
                  amountPerUnit: application.amountPerUnit,
                  total: application.amountPerUnit * application.numberOfUnits,
                })),
                plotIndex
              );
            }

            if (cropProtectionApplications) {
              addSection(
                t("crop_protections.crop_protection"),
                [
                  { key: "date", value: t("common.date") },
                  { key: "size", value: t("common.size_a") },
                  {
                    key: "product",
                    value: t("crop_protections.product"),
                  },
                  { key: "unit", value: t("common.unit") },
                  { key: "applicationUnit", value: t("common.application_unit") },
                  {
                    key: "numberOfUnits",
                    value: t("common.number_of_application_units"),
                  },
                  {
                    key: "amountPerUnit",
                    value: t("common.amount_per_application_unit"),
                  },
                  {
                    key: "total",
                    value: t("common.total"),
                  },
                ],
                plot.cropProtectionApplications.map((application) => ({
                  date: application.dateTime.toLocaleDateString(locale, {
                    hour: "2-digit",
                    minute: "2-digit",
                  }),
                  size: (application.size / 100).toFixed(2),
                  product: application.product.name,
                  unit: t(`units.short.${application.product.unit}`),
                  applicationUnit: t(`application_units.${application.unit}`),
                  numberOfUnits: application.numberOfUnits,
                  amountPerUnit: application.amountPerUnit,
                  total: application.amountPerUnit * application.numberOfUnits,
                })),
                plotIndex
              );
            }

            if (harvests) {
              addSection(
                t("harvests.harvest"),
                [
                  { key: "date", value: t("common.date") },
                  { key: "size", value: t("common.size_a") },
                  { key: "crop", value: t("crops.crop") },
                  {
                    key: "processingType",
                    value: t(`harvests.application_unit`),
                  },
                  {
                    key: "conservationMethod",
                    value: t("harvests.conservation"),
                  },
                  {
                    key: "producedUnits",
                    value: t("harvests.produced_units"),
                  },
                  {
                    key: "kilosPerUnit",
                    value: t("harvests.kilos_per_unit"),
                  },
                  {
                    key: "totalKilos",
                    value: t("harvests.total_kilos"),
                  },
                ],
                plot.harvests.map((harvest) => ({
                  date: harvest.date.toLocaleDateString(locale),
                  size: (harvest.size / 100).toFixed(2),
                  crop: harvest.crop.name,
                  processingType: t(`harvests.labels.harvest_units.${harvest.unit}`),
                  conservationMethod: harvest.conservationMethod
                    ? t(`harvests.labels.conservation_method.${harvest.conservationMethod}`)
                    : "",
                  producedUnits: harvest.numberOfUnits,
                  kilosPerUnit: harvest.kilosPerUnit,
                  totalKilos: harvest.numberOfUnits * harvest.kilosPerUnit,
                })),
                plotIndex
              );
            }
            plotIndex++;
          }
        }

        function generateRotationTimelineSheet() {
          if (timelineMonths.length === 0) return;
          const sheet = workbook.addWorksheet(t("crop_rotations.crop_rotation"));
          writeTimelineHeaders(sheet, 1);
          let rowIndex = 3;
          for (const plot of plots) {
            if (plot.cropRotations.length === 0) continue;
            const nameCell = sheet.getCell(rowIndex, PLOT_COL);
            nameCell.value = plot.name;
            nameCell.font = { bold: true };
            nameCell.alignment = { vertical: "middle" };
            nameCell.border = { bottom: ROW_BORDER };
            writeRotationBars(sheet, rowIndex, plot.cropRotations, plot.archivedAt);
            sheet.getRow(rowIndex).height = 36;
            rowIndex++;
          }
        }

        const fileName = `${t("field_calendar_report.file_name", { fromDate: fromDate.toLocaleDateString("de"), toDate: toDate.toLocaleDateString("de") })}.xlsx`;
        const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
        return { buffer, fileName };
      });
    },

    async generateReport(
      userId: string,
      fromDate: Date,
      toDate: Date,
      cropRotations: boolean,
      tillages: boolean,
      fertilizerApplications: boolean,
      cropProtectionApplications: boolean,
      harvests: boolean
    ): Promise<void> {
      const { buffer, fileName } = await this.generateReportBuffer(
        fromDate,
        toDate,
        cropRotations,
        tillages,
        fertilizerApplications,
        cropProtectionApplications,
        harvests
      );
      await rlsDb.rls(async (tx) => {
        const user = await tx.query.profiles.findFirst({
          where: { id: userId },
        });
        if (!user) {
          throw new Error(`User with id ${userId} not found`);
        }
        try {
          await txEmailApi.sendTransacEmail({
            sender: { email: "noreply@app.coltivio.ch", name: "Coltivio" },
            to: [{ email: user.email, name: user.fullName || undefined }],
            subject: fileName,
            htmlContent: `<p>${t("field_calendar_report.mail_content", { fromDate: fromDate.toLocaleDateString("de"), toDate: toDate.toLocaleDateString("de") })}</p>`,
            attachment: [
              {
                content: buffer.toString("base64"),
                name: fileName,
              },
            ],
          });
        } catch (error) {
          console.error(error);
          Sentry.captureException(error);
        }
      });
    },
  };
}
