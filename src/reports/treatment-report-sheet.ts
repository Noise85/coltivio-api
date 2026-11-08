import ExcelJS from "exceljs";
import { TFunction } from "i18next";

const HEADER_FILL: ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF4472C4" } };
const HEADER_FONT: Partial<ExcelJS.Font> = { bold: true, color: { argb: "FFFFFFFF" } };
const THIN_SIDE: Partial<ExcelJS.Border> = { style: "thin", color: { argb: "FFB4C6E7" } };
const CELL_BORDER: Partial<ExcelJS.Borders> = { top: THIN_SIDE, bottom: THIN_SIDE, left: THIN_SIDE, right: THIN_SIDE };
const STRIPE_FILL: ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF2F2F2" } };

// Column widths for the 16 treatment columns, in Excel character units
const COLUMN_WIDTHS = [12, 12, 20, 22, 20, 14, 12, 16, 13, 10, 10, 10, 12, 12, 12, 20];

/**
 * Writes the two-row grouped header (e.g. "Absetzfrist" spanning Milch/Fleisch/Organe)
 * followed by the data rows, starting at `startRow`. Returns the next free row.
 */
export function writeTreatmentTable(
  sheet: ExcelJS.Worksheet,
  startRow: number,
  rows: (string | number)[][],
  t: TFunction
): number {
  COLUMN_WIDTHS.forEach((width, i) => {
    sheet.getColumn(i + 1).width = width;
  });

  const headerRow = startRow;
  const subHeaderRow = startRow + 1;

  // Columns that have no overarching group header — their label spans both header rows
  const singleColumns: { col: number; label: string }[] = [
    { col: 3, label: t("treatment_report.columns.animal") },
    { col: 4, label: t("treatment_report.columns.treatment_reason") },
    { col: 5, label: t("treatment_report.columns.drug") },
    { col: 6, label: t("treatment_report.columns.dose") },
    { col: 7, label: t("treatment_report.columns.is_antibiotic") },
    { col: 8, label: t("treatment_report.columns.critical_antibiotic") },
    { col: 9, label: t("treatment_report.columns.antibiogram") },
    { col: 16, label: t("treatment_report.columns.drug_origin") },
  ];

  for (const { col, label } of singleColumns) {
    sheet.mergeCells(headerRow, col, subHeaderRow, col);
    const cell = sheet.getCell(headerRow, col);
    cell.value = label;
    cell.font = HEADER_FONT;
    cell.fill = HEADER_FILL;
    cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
    cell.border = CELL_BORDER;
  }

  // Columns grouped under a shared header spanning multiple columns
  const groupedColumns: { startCol: number; endCol: number; group: string; subLabels: string[] }[] = [
    {
      startCol: 1,
      endCol: 2,
      group: t("treatment_report.groups.treatment"),
      subLabels: [t("treatment_report.columns.start"), t("treatment_report.columns.end")],
    },
    {
      startCol: 10,
      endCol: 12,
      group: t("treatment_report.groups.withdrawal_period"),
      subLabels: [
        t("treatment_report.columns.milk"),
        t("treatment_report.columns.meat"),
        t("treatment_report.columns.organs"),
      ],
    },
    {
      startCol: 13,
      endCol: 15,
      group: t("treatment_report.groups.release_date"),
      subLabels: [
        t("treatment_report.columns.milk"),
        t("treatment_report.columns.meat"),
        t("treatment_report.columns.organs"),
      ],
    },
  ];

  for (const { startCol, endCol, group, subLabels } of groupedColumns) {
    sheet.mergeCells(headerRow, startCol, headerRow, endCol);
    const groupCell = sheet.getCell(headerRow, startCol);
    groupCell.value = group;
    groupCell.font = HEADER_FONT;
    groupCell.fill = HEADER_FILL;
    groupCell.alignment = { horizontal: "center", vertical: "middle" };
    for (let col = startCol; col <= endCol; col++) {
      sheet.getCell(headerRow, col).border = CELL_BORDER;
      sheet.getCell(headerRow, col).fill = HEADER_FILL;
    }
    subLabels.forEach((label, i) => {
      const cell = sheet.getCell(subHeaderRow, startCol + i);
      cell.value = label;
      cell.font = HEADER_FONT;
      cell.fill = HEADER_FILL;
      cell.alignment = { horizontal: "center", vertical: "middle" };
      cell.border = CELL_BORDER;
    });
  }

  sheet.getRow(headerRow).height = 20;
  sheet.getRow(subHeaderRow).height = 20;

  const dataStartRow = subHeaderRow + 1;
  rows.forEach((rowValues, i) => {
    const row = sheet.getRow(dataStartRow + i);
    rowValues.forEach((value, colIdx) => {
      const cell = row.getCell(colIdx + 1);
      cell.value = value;
      cell.border = CELL_BORDER;
      cell.alignment = { vertical: "middle" };
      if (i % 2 === 1) cell.fill = STRIPE_FILL;
    });
  });

  return dataStartRow + rows.length;
}
