import ExcelJS from "exceljs";
import { TFunction } from "i18next";
import { AnimalType } from "../animals/animals";
import { RlsDb } from "../db/db";
import { writeTreatmentTable } from "./treatment-report-sheet";

export function treatmentReportsApi(rlsDb: RlsDb, t: TFunction, locale: string = "de") {
  return {
    async generateReportBuffer(
      fromDate: Date,
      toDate: Date,
      animalTypes?: AnimalType[]
    ): Promise<{ buffer: Buffer; fileName: string }> {
      return await rlsDb.rls(async (tx) => {
        const treatments = await tx.query.treatments.findMany({
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

        for (const treatment of treatments) {
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

        const workbook = new ExcelJS.Workbook();

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

        const fileName = `${t("treatment_report.file_name", { fromDate: fromDate.toLocaleDateString(locale), toDate: toDate.toLocaleDateString(locale) })}.xlsx`;
        const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
        return { buffer, fileName };
      });
    },
  };
}
