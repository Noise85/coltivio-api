import ExcelJS from "exceljs";
import createHttpError from "http-errors";
import { TFunction } from "i18next";
import JSZip from "jszip";

const SPREADSHEET_MAIN_NS_PREFIX = /xmlns:(\w+)="http:\/\/schemas\.openxmlformats\.org\/spreadsheetml\/2006\/main"/;

// The TVD export since October 2026 is written with a prefixed namespace (<x:row>) and without
// row/cell references, both of which ExcelJS cannot read.
function stripSpreadsheetNamespacePrefix(xml: string): string {
  const prefix = xml.match(SPREADSHEET_MAIN_NS_PREFIX)?.[1];
  if (!prefix) {
    return xml;
  }
  return xml.replace(new RegExp(`<(/?)${prefix}:`, "g"), "<$1").replace(`xmlns:${prefix}=`, "xmlns=");
}

function columnLetters(columnNumber: number): string {
  let letters = "";
  let n = columnNumber;
  while (n > 0) {
    const remainder = (n - 1) % 26;
    letters = String.fromCharCode(65 + remainder) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

function columnNumber(letters: string): number {
  return [...letters].reduce((acc, ch) => acc * 26 + ch.charCodeAt(0) - 64, 0);
}

// Fills in missing r attributes, assuming rows and cells without one follow their predecessor.
function addMissingCellReferences(xml: string): string {
  let rowNumber = 0;
  return xml.replace(/<row\b([^>]*?)(\/>|>([\s\S]*?)<\/row>)/g, (_match, rowAttrs: string, _tail, content?: string) => {
    const explicitRow = rowAttrs.match(/\br="(\d+)"/);
    rowNumber = explicitRow ? Number(explicitRow[1]) : rowNumber + 1;
    const attrs = explicitRow ? rowAttrs : ` r="${rowNumber}"${rowAttrs}`;
    if (content === undefined) {
      return `<row${attrs}/>`;
    }
    let cellColumn = 0;
    const cells = content.replace(/<c\b([^>]*?)(\/?)>/g, (_cell, cellAttrs: string, selfClose: string) => {
      const explicitRef = cellAttrs.match(/\br="([A-Z]+)\d+"/);
      if (explicitRef) {
        cellColumn = columnNumber(explicitRef[1]);
        return `<c${cellAttrs}${selfClose}>`;
      }
      cellColumn += 1;
      return `<c r="${columnLetters(cellColumn)}${rowNumber}"${cellAttrs}${selfClose}>`;
    });
    return `<row${attrs}>${cells}</row>`;
  });
}

async function normalizeXlsx(fileBuffer: Buffer): Promise<Buffer> {
  const zip = await JSZip.loadAsync(fileBuffer);
  for (const name of Object.keys(zip.files)) {
    if (!name.endsWith(".xml")) {
      continue;
    }
    const original = await zip.file(name)!.async("string");
    let xml = stripSpreadsheetNamespacePrefix(original);
    if (name.startsWith("xl/worksheets/")) {
      xml = addMissingCellReferences(xml);
    }
    if (xml !== original) {
      zip.file(name, xml);
    }
  }
  return zip.generateAsync({ type: "nodebuffer" });
}

// Loads the first worksheet of an uploaded TVD export, or throws a localized 400 if the file can't be read.
export async function loadImportWorksheet(fileBuffer: Buffer, t: TFunction): Promise<ExcelJS.Worksheet> {
  let worksheet: ExcelJS.Worksheet | undefined;
  try {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load((await normalizeXlsx(fileBuffer)) as unknown as ExcelJS.Buffer);
    worksheet = workbook.worksheets[0];
  } catch (error) {
    console.error("[animals-import] Could not read Excel file", error);
  }
  if (!worksheet) {
    throw createHttpError(400, t("animal_import.error_file_unreadable"));
  }
  return worksheet;
}
