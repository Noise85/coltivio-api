import ExcelJS from "exceljs";
import { TFunction } from "i18next";
import { differenceInCalendarDays } from "date-fns";
import { MeadowJournalEntry } from "../animals/outdoor-journal";

const THIN_SIDE: Partial<ExcelJS.Border> = { style: "thin", color: { argb: "FFB4C6E7" } };
const CELL_BORDER: Partial<ExcelJS.Borders> = { top: THIN_SIDE, bottom: THIN_SIDE, left: THIN_SIDE, right: THIN_SIDE };

// Meadow sheet: which herd was on which meadow, for how long and with how many animals. Skipped without entries.
export function addMeadowSheet(
  workbook: ExcelJS.Workbook,
  meadowEntries: MeadowJournalEntry[],
  t: TFunction,
  locale: string
) {
  if (meadowEntries.length === 0) return;

  const meadowSheet = workbook.addWorksheet(t("outdoor_journal_report.meadows_sheet"));
  meadowSheet.columns = [
    { header: t("outdoor_journal_report.meadow"), width: 28 },
    { header: t("outdoor_journal_report.meadow_size"), width: 12 },
    { header: t("outdoor_journal_report.herd"), width: 24 },
    { header: t("outdoor_journal_report.type"), width: 14 },
    { header: t("outdoor_journal_report.from"), width: 12 },
    { header: t("outdoor_journal_report.to"), width: 12 },
    { header: t("outdoor_journal_report.days"), width: 8 },
    { header: t("outdoor_journal_report.animal_count"), width: 16 },
  ];
  const meadowHeaderRow = meadowSheet.getRow(1);
  meadowHeaderRow.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF4472C4" } };
    cell.border = CELL_BORDER;
  });

  for (const entry of meadowEntries) {
    const meadowRow = meadowSheet.addRow([
      entry.meadowName,
      Math.round(entry.meadowSize / 100),
      entry.herdName,
      t(`outdoor_journal_report.types.${entry.type}`),
      entry.startDate.toLocaleDateString(locale),
      entry.endDate.toLocaleDateString(locale),
      differenceInCalendarDays(entry.endDate, entry.startDate) + 1,
      entry.animalCount,
    ]);
    meadowRow.eachCell((cell) => {
      cell.border = CELL_BORDER;
    });
  }
}
