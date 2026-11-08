import ExcelJS from "exceljs";
import { TFunction } from "i18next";
import { getDaysInMonth } from "date-fns";
import { RlsDb, Transaction } from "../db/db";
import { AnimalType, AnimalCategory } from "../animals/animals";
import { buildMeadowJournal, expandOutdoorSchedule } from "../animals/outdoor-journal";
import { mapAnimalToCategory } from "../animals/animal-key-mapping";
import { writeTreatmentTable } from "./treatment-report-sheet";
import { addMeadowSheet } from "./meadow-report-sheet";

export function animalsReportsApi(rlsDb: RlsDb, t: TFunction, locale: string = "de") {
  return {
    async generateReportBuffer(
      fromDate: Date,
      toDate: Date,
      treatments: boolean,
      outdoorJournal: boolean,
      treatmentAnimalTypes?: AnimalType[]
    ): Promise<{ buffer: Buffer; fileName: string }> {
      return await rlsDb.rls(async (tx) => {
        const workbook = new ExcelJS.Workbook();

        if (treatments) await addTreatmentSheets(tx, workbook, treatmentAnimalTypes);
        if (outdoorJournal) await addOutdoorJournalSheet(tx, workbook);

        const fileName = `${t("animals_report.file_name", { fromDate: fromDate.toLocaleDateString(locale), toDate: toDate.toLocaleDateString(locale) })}.xlsx`;
        const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
        return { buffer, fileName };
      });

      async function addTreatmentSheets(tx: Transaction, workbook: ExcelJS.Workbook, animalTypes?: AnimalType[]) {
        const treatmentEntries = await tx.query.treatments.findMany({
          where: {
            AND: [{ startDate: { gte: fromDate } }, { startDate: { lte: toDate } }],
          },
          with: {
            drug: true,
            animalTreatments: {
              with: {
                animal: {
                  with: { earTag: true },
                },
              },
            },
          },
          orderBy: { startDate: "desc" },
        });

        // Flatten treatments into rows grouped by animal type
        const rowsByType = new Map<AnimalType, (string | number)[][]>();

        for (const treatment of treatmentEntries) {
          for (const at of treatment.animalTreatments) {
            const animal = at.animal;
            if (animalTypes && animalTypes.length > 0 && !animalTypes.includes(animal.type)) {
              continue;
            }

            if (!rowsByType.has(animal.type)) {
              rowsByType.set(animal.type, []);
            }

            const earTagNumber = animal.earTag?.number ?? "";
            const animalLabel = earTagNumber ? `${earTagNumber} - ${animal.name}` : animal.name;

            // Calculate withdrawal days from usable dates
            const endDate = treatment.endDate;
            const milkDays = treatment.milkUsableDate
              ? Math.ceil((treatment.milkUsableDate.getTime() - endDate.getTime()) / (1000 * 60 * 60 * 24))
              : "";
            const meatDays = treatment.meatUsableDate
              ? Math.ceil((treatment.meatUsableDate.getTime() - endDate.getTime()) / (1000 * 60 * 60 * 24))
              : "";
            const organsDays = treatment.organsUsableDate
              ? Math.ceil((treatment.organsUsableDate.getTime() - endDate.getTime()) / (1000 * 60 * 60 * 24))
              : "";

            // Format dose: e.g. "5 ml / kg"
            let dose = "";
            if (treatment.drugDoseValue != null && treatment.drugDoseUnit) {
              dose = `${treatment.drugDoseValue} ${t(`drug_dose_units.${treatment.drugDoseUnit}`)}`;
              if (treatment.drugDosePerUnit) {
                dose += ` / ${t(`drug_dose_per_units.${treatment.drugDosePerUnit}`)}`;
              }
            }

            const checkmark = "✓";

            rowsByType
              .get(animal.type)!
              .push([
                treatment.startDate.toLocaleDateString(locale),
                treatment.endDate.toLocaleDateString(locale),
                animalLabel,
                treatment.name,
                treatment.drug?.name ?? "",
                dose,
                treatment.isAntibiotic ? checkmark : "",
                treatment.criticalAntibiotic ? checkmark : "",
                treatment.antibiogramAvailable ? checkmark : "",
                milkDays,
                meatDays,
                organsDays,
                treatment.milkUsableDate?.toLocaleDateString(locale) ?? "",
                treatment.meatUsableDate?.toLocaleDateString(locale) ?? "",
                treatment.organsUsableDate?.toLocaleDateString(locale) ?? "",
                treatment.drugReceivedFrom ?? "",
              ]);
          }
        }

        // Process requested types, or all types that have data
        const typesToProcess = animalTypes && animalTypes.length > 0 ? animalTypes : Array.from(rowsByType.keys());

        for (const type of typesToProcess) {
          const rows = rowsByType.get(type);
          if (!rows || rows.length === 0) continue;

          const sheetName = t(`animal_types.${type}`);
          const sheet = workbook.addWorksheet(sheetName);

          let rowIndex = 1;
          sheet.getCell(`A${rowIndex}`).value = t("treatment_report.title", {
            fromDate: fromDate.toLocaleDateString(locale),
            toDate: toDate.toLocaleDateString(locale),
          });
          sheet.getCell(`A${rowIndex}`).font = { bold: true, size: 18 };
          rowIndex += 3;

          writeTreatmentTable(sheet, rowIndex, rows, t);
        }
      }

      async function addOutdoorJournalSheet(tx: Transaction, workbook: ExcelJS.Workbook) {
        const herds = await tx.query.herds.findMany({
          with: {
            herdMemberships: {
              with: { animal: true },
            },
            outdoorSchedules: {
              with: { recurrence: true, meadow: { columns: { id: true, name: true, size: true } } },
            },
          },
        });

        // Pre-expand all outdoor schedules into concrete date ranges
        type ExpandedOccurrence = {
          herdId: string;
          type: "pasture" | "exercise_yard";
          startDate: Date;
          endDate: Date;
        };
        const allOccurrences: ExpandedOccurrence[] = [];
        for (const herd of herds) {
          for (const schedule of herd.outdoorSchedules) {
            const ranges = expandOutdoorSchedule(schedule, fromDate, toDate);
            for (const range of ranges) {
              allOccurrences.push({
                herdId: herd.id,
                type: schedule.type,
                startDate: range.startDate,
                endDate: range.endDate,
              });
            }
          }
        }

        const herdById = new Map(herds.map((h) => [h.id, h]));

        // Collect all months in the range
        type MonthKey = { year: number; month: number };
        const months: MonthKey[] = [];
        const cursor = new Date(fromDate.getFullYear(), fromDate.getMonth(), 1);
        const lastMonth = new Date(toDate.getFullYear(), toDate.getMonth(), 1);
        while (cursor <= lastMonth) {
          months.push({ year: cursor.getFullYear(), month: cursor.getMonth() });
          cursor.setMonth(cursor.getMonth() + 1);
        }

        // Build day-by-day matrix per month: for each category, whether pasture/exerciseYard was active
        type DayFlags = { pasture: boolean; exerciseYard: boolean };
        const monthlyData: Map<AnimalCategory, DayFlags[]>[] = [];
        const allCategories = new Set<AnimalCategory>();

        for (const { year, month } of months) {
          const days = getDaysInMonth(new Date(year, month));
          const monthData = new Map<AnimalCategory, DayFlags[]>();

          for (let day = 1; day <= days; day++) {
            const date = new Date(year, month, day);
            if (date < fromDate || date > toDate) continue;

            for (const occ of allOccurrences) {
              if (date < occ.startDate || date > occ.endDate) continue;
              const herd = herdById.get(occ.herdId);
              if (!herd) continue;

              for (const membership of herd.herdMemberships) {
                if (membership.fromDate > date) continue;
                if (membership.toDate && membership.toDate < date) continue;
                if (membership.animal.dateOfDeath && membership.animal.dateOfDeath < date) continue;

                const category = mapAnimalToCategory(membership.animal, date);
                if (!category) continue;
                allCategories.add(category);

                if (!monthData.has(category)) {
                  monthData.set(
                    category,
                    Array.from({ length: days }, () => ({
                      pasture: false,
                      exerciseYard: false,
                    }))
                  );
                }
                const dayFlags = monthData.get(category)![day - 1];
                if (occ.type === "pasture") dayFlags.pasture = true;
                else dayFlags.exerciseYard = true;
              }
            }
          }

          monthlyData.push(monthData);
        }

        const sortedCategories = Array.from(allCategories).sort();
        const numCats = sortedCategories.length;
        const numMonths = months.length;
        const totalDataCols = numMonths * numCats;

        const thinSide: Partial<ExcelJS.Border> = { style: "thin", color: { argb: "FFB4C6E7" } };
        const thickSide: Partial<ExcelJS.Border> = { style: "medium", color: { argb: "FF2F5496" } };
        const border: Partial<ExcelJS.Borders> = { top: thinSide, bottom: thinSide, left: thinSide, right: thinSide };
        // Thick left/right borders at month boundaries
        const borderFor = (c: number): Partial<ExcelJS.Borders> => ({
          top: thinSide,
          bottom: thinSide,
          left: c === 0 ? thickSide : thinSide,
          right: c === numCats - 1 ? thickSide : thinSide,
        });

        const sheet = workbook.addWorksheet(
          t("outdoor_journal_report.title", {
            fromDate: fromDate.toLocaleDateString(locale),
            toDate: toDate.toLocaleDateString(locale),
          })
        );
        sheet.pageSetup = { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0 };

        // Column for month m, category c: 2 + m * numCats + c
        const colFor = (m: number, c: number) => 2 + m * numCats + c;

        sheet.getColumn(1).width = 8;
        for (let col = 2; col <= 1 + totalDataCols; col++) {
          sheet.getColumn(col).width = 8;
        }

        let rowIndex = 1;

        // Header row 1: Report title
        sheet.mergeCells(rowIndex, 1, rowIndex, 1 + totalDataCols);
        const titleCell = sheet.getCell(rowIndex, 1);
        titleCell.value = t("outdoor_journal_report.title", {
          fromDate: fromDate.toLocaleDateString(locale),
          toDate: toDate.toLocaleDateString(locale),
        });
        titleCell.font = { bold: true, size: 16, color: { argb: "FFFFFFFF" } };
        titleCell.alignment = { horizontal: "center", vertical: "middle" };
        titleCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF2F5496" } };
        rowIndex++;

        // Header row 2: "Tag" merged with row 3, month names each spanning numCats columns
        sheet.mergeCells(rowIndex, 1, rowIndex + 1, 1);
        const tagCell = sheet.getCell(rowIndex, 1);
        tagCell.value = t("outdoor_journal_report.day");
        tagCell.font = { bold: true, color: { argb: "FFFFFFFF" } };
        tagCell.alignment = { horizontal: "center", vertical: "middle" };
        tagCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF4472C4" } };
        tagCell.border = { top: thinSide, bottom: thinSide, left: thinSide, right: thickSide };

        for (let m = 0; m < numMonths; m++) {
          const startCol = colFor(m, 0);
          const endCol = colFor(m, numCats - 1);
          if (endCol > startCol) sheet.mergeCells(rowIndex, startCol, rowIndex, endCol);
          const monthCell = sheet.getCell(rowIndex, startCol);
          monthCell.value = t(`outdoor_journal_report.months.${months[m].month}` as `outdoor_journal_report.months.0`);
          monthCell.font = { bold: true, color: { argb: "FFFFFFFF" } };
          monthCell.alignment = { horizontal: "center" };
          monthCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF4472C4" } };
          monthCell.border = { top: thinSide, bottom: thinSide, left: thickSide, right: thickSide };
        }
        rowIndex++;

        // Header row 3: Category names repeated under each month
        for (let m = 0; m < numMonths; m++) {
          for (let c = 0; c < numCats; c++) {
            const catCell = sheet.getCell(rowIndex, colFor(m, c));
            catCell.value = sortedCategories[c];
            catCell.font = { bold: true, color: { argb: "FFFFFFFF" } };
            catCell.alignment = { horizontal: "center" };
            catCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF5B9BD5" } };
            catCell.border = borderFor(c);
          }
        }
        rowIndex++;

        // Day rows (1-31), columns = month * category grid
        const pastureCount = Array.from({ length: numMonths }, () => new Array(numCats).fill(0));
        const exerciseYardCount = Array.from({ length: numMonths }, () => new Array(numCats).fill(0));

        for (let day = 1; day <= 31; day++) {
          const dayCell = sheet.getCell(rowIndex, 1);
          dayCell.value = day;
          dayCell.alignment = { horizontal: "center" };
          dayCell.border = border;

          for (let m = 0; m < numMonths; m++) {
            const { year, month } = months[m];
            const daysInMonth = getDaysInMonth(new Date(year, month));

            for (let c = 0; c < numCats; c++) {
              const cell = sheet.getCell(rowIndex, colFor(m, c));
              cell.alignment = { horizontal: "center" };
              cell.border = borderFor(c);

              if (day > daysInMonth) continue;

              const dayFlags = monthlyData[m].get(sortedCategories[c])?.[day - 1];
              if (dayFlags) {
                if (dayFlags.pasture && dayFlags.exerciseYard) {
                  cell.value = "W/L";
                  pastureCount[m][c]++;
                  exerciseYardCount[m][c]++;
                } else if (dayFlags.pasture) {
                  cell.value = "W";
                  pastureCount[m][c]++;
                } else if (dayFlags.exerciseYard) {
                  cell.value = "L";
                  exerciseYardCount[m][c]++;
                }
              }
            }
          }
          rowIndex++;
        }

        // Total Weide row
        const pastureLabelCell = sheet.getCell(rowIndex, 1);
        pastureLabelCell.value = t("outdoor_journal_report.total_pasture");
        pastureLabelCell.font = { bold: true };
        pastureLabelCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFD9E2F3" } };
        pastureLabelCell.border = border;
        for (let m = 0; m < numMonths; m++) {
          for (let c = 0; c < numCats; c++) {
            const cell = sheet.getCell(rowIndex, colFor(m, c));
            cell.value = pastureCount[m][c] || "";
            cell.alignment = { horizontal: "center" };
            cell.font = { bold: true };
            cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFD9E2F3" } };
            cell.border = borderFor(c);
          }
        }
        rowIndex++;

        // Total Laufhof row
        const yardLabelCell = sheet.getCell(rowIndex, 1);
        yardLabelCell.value = t("outdoor_journal_report.total_exercise_yard");
        yardLabelCell.font = { bold: true };
        yardLabelCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFD9E2F3" } };
        yardLabelCell.border = border;
        for (let m = 0; m < numMonths; m++) {
          for (let c = 0; c < numCats; c++) {
            const cell = sheet.getCell(rowIndex, colFor(m, c));
            cell.value = exerciseYardCount[m][c] || "";
            cell.alignment = { horizontal: "center" };
            cell.font = { bold: true };
            cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFD9E2F3" } };
            cell.border = borderFor(c);
          }
        }

        addMeadowSheet(workbook, buildMeadowJournal(herds, fromDate, toDate), t, locale);
      }
    },
  };
}
