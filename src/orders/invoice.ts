import {
  Document,
  Footer,
  ITableCellBorders,
  ImageRun,
  Packer,
  Paragraph,
  Table,
  TableRow,
  TableCell,
  TextRun,
  WidthType,
  AlignmentType,
  BorderStyle,
  HeadingLevel,
  convertInchesToTwip,
} from "docx";
import { TFunction } from "i18next";
import { eq, and, sql } from "drizzle-orm";
import { orders } from "../db/schema";
import { RlsDb, rlsDb as makeRlsDb } from "../db/db";
import { SupabaseToken } from "../supabase/supabase";
import { OrderWithRelations } from "./orders";
import { InvoiceSettings } from "./invoice-settings";
import { invoiceSettingsApi } from "./invoice-settings";

const LOGO_MAX_WIDTH = 150; // pixels (twips converted internally by docx)

// Read pixel dimensions from PNG (IHDR at offset 16) or JPEG (scan for SOF marker)
function getImageDimensions(data: Buffer, mimeType: string): { width: number; height: number } {
  if (mimeType === "png") {
    return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  }
  // JPEG: scan for SOF0/SOF2 marker (0xFFC0 / 0xFFC2)
  let offset = 2;
  while (offset < data.length - 8) {
    if (data[offset] === 0xff && (data[offset + 1] === 0xc0 || data[offset + 1] === 0xc2)) {
      return {
        width: data.readUInt16BE(offset + 7),
        height: data.readUInt16BE(offset + 5),
      };
    }
    offset += 2 + data.readUInt16BE(offset + 2);
  }
  return { width: LOGO_MAX_WIDTH, height: 60 }; // fallback
}

// Scale image to LOGO_MAX_WIDTH while preserving aspect ratio
function scaleToMaxWidth(data: Buffer, mimeType: string): { width: number; height: number } {
  const { width, height } = getImageDimensions(data, mimeType);
  const scale = LOGO_MAX_WIDTH / width;
  return { width: LOGO_MAX_WIDTH, height: Math.round(height * scale) };
}

// Split text on newlines into TextRuns with line breaks for proper rendering in DOCX
function textRunsFromMultiline(text: string, size: number): TextRun[] {
  return text.split("\n").map((line, i) => new TextRun({ text: line, size, break: i === 0 ? 0 : 1 }));
}

function formatCHF(amount: number): string {
  return `CHF ${amount.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, "'")}`;
}

function formatDate(date: Date | string): string {
  const d = typeof date === "string" ? new Date(date) : date;
  return d.toLocaleDateString("de-CH", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

const noBorder: ITableCellBorders = {
  top: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" },
  bottom: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" },
  left: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" },
  right: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" },
};

const thinBorder: ITableCellBorders = {
  top: { style: BorderStyle.SINGLE, size: 4, color: "CCCCCC" },
  bottom: { style: BorderStyle.SINGLE, size: 4, color: "CCCCCC" },
  left: { style: BorderStyle.SINGLE, size: 4, color: "CCCCCC" },
  right: { style: BorderStyle.SINGLE, size: 4, color: "CCCCCC" },
};

function cell(
  text: string,
  opts: {
    bold?: boolean;
    align?: (typeof AlignmentType)[keyof typeof AlignmentType];
    borders?: ITableCellBorders;
    width?: number;
  } = {}
): TableCell {
  return new TableCell({
    borders: opts.borders ?? thinBorder,
    width: opts.width ? { size: opts.width, type: WidthType.PERCENTAGE } : undefined,
    children: [
      new Paragraph({
        alignment: opts.align ?? AlignmentType.LEFT,
        children: [new TextRun({ text, bold: opts.bold ?? false, size: 20 })],
      }),
    ],
  });
}

const PAGE_MARGIN = {
  top: convertInchesToTwip(1),
  right: convertInchesToTwip(1),
  bottom: convertInchesToTwip(1),
  left: convertInchesToTwip(1.25),
};

function buildFooter(settings: InvoiceSettings): Footer {
  const footerLines: string[] = [];
  if (settings.iban) footerLines.push(`IBAN: ${settings.iban}${settings.bankName ? `  |  ${settings.bankName}` : ""}`);
  if (settings.email) footerLines.push(settings.email);
  if (settings.phone) footerLines.push(settings.phone);
  if (settings.website) footerLines.push(settings.website);

  return new Footer({
    children: [
      new Paragraph({
        border: { top: { style: BorderStyle.SINGLE, size: 6, color: "888888" } },
        children: [],
      }),
      ...footerLines.map(
        (line) =>
          new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [new TextRun({ text: line, size: 18, color: "222222" })],
          })
      ),
    ],
  });
}

// Builds the content nodes for a single invoice — used by both single and batch generation
export function buildInvoiceChildren(
  order: OrderWithRelations,
  settings: InvoiceSettings,
  invoiceNumber: string,
  t: TFunction
): (Paragraph | Table)[] {
  const contact = order.contact;
  const shippingDate = order.shippingDate ? formatDate(order.shippingDate) : "—";
  const introText = (settings.introText ?? "")
    .replace(/\{\{firstName\}\}/g, contact.firstName)
    .replace(/\{\{lastName\}\}/g, contact.lastName);

  const senderLines = [settings.senderName, settings.street, `${settings.zip} ${settings.city}`.trim()].filter(Boolean);

  const contactLines = [
    `${contact.firstName} ${contact.lastName}`.trim(),
    contact.street ?? "",
    `${contact.zip ?? ""} ${contact.city ?? ""}`.trim(),
  ].filter(Boolean);

  const metaRightLines: string[] = [`Lieferdatum: ${shippingDate}`];
  if (settings.email) metaRightLines.push(`E-Mail: ${settings.email}`);
  if (settings.phone) metaRightLines.push(`Tel: ${settings.phone}`);

  // Row 1: logo top-right, nothing left (omitted if no logo)
  const logoRow =
    settings.logoData && settings.logoMimeType
      ? [
          new TableRow({
            children: [
              new TableCell({
                borders: noBorder,
                width: { size: 55, type: WidthType.PERCENTAGE },
                children: [new Paragraph({ children: [] })],
              }),
              new TableCell({
                borders: noBorder,
                width: { size: 45, type: WidthType.PERCENTAGE },
                children: [
                  new Paragraph({
                    alignment: AlignmentType.RIGHT,
                    children: [
                      new ImageRun({
                        data: new Uint8Array(settings.logoData),
                        type: settings.logoMimeType as "jpg" | "png",
                        transformation: scaleToMaxWidth(settings.logoData, settings.logoMimeType),
                      }),
                    ],
                  }),
                  new Paragraph({ children: [] }),
                ],
              }),
            ],
          }),
        ]
      : [];

  // Row 2: sender left | meta right
  const contentRow = new TableRow({
    children: [
      new TableCell({
        borders: noBorder,
        width: { size: 55, type: WidthType.PERCENTAGE },
        children: senderLines.map(
          (line) =>
            new Paragraph({
              children: [new TextRun({ text: line, size: 20 })],
            })
        ),
      }),
      new TableCell({
        borders: noBorder,
        width: { size: 45, type: WidthType.PERCENTAGE },
        children: metaRightLines.map(
          (line) =>
            new Paragraph({
              alignment: AlignmentType.RIGHT,
              children: [new TextRun({ text: line, size: 20 })],
            })
        ),
      }),
    ],
  });

  const headerTable = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [...logoRow, contentRow],
  });

  const recipientParagraphs = contactLines.map(
    (line) => new Paragraph({ children: [new TextRun({ text: line, size: 20 })] })
  );

  const titleParagraph = new Paragraph({
    heading: HeadingLevel.HEADING_1,
    children: [
      new TextRun({
        text: `Rechnung Nr. ${invoiceNumber}`,
        bold: true,
        size: 32,
      }),
    ],
  });

  const introParagraph = introText ? new Paragraph({ children: textRunsFromMultiline(introText, 22) }) : null;

  const itemsHeaderRow = new TableRow({
    children: [
      cell("Pos.", { bold: true, width: 6 }),
      cell("Bezeichnung", { bold: true, width: 38 }),
      cell("Menge", { bold: true, width: 12, align: AlignmentType.RIGHT }),
      cell("Einheit", { bold: true, width: 14, align: AlignmentType.RIGHT }),
      cell("Preis/Einheit", {
        bold: true,
        width: 15,
        align: AlignmentType.RIGHT,
      }),
      cell("Gesamtpreis", {
        bold: true,
        width: 15,
        align: AlignmentType.RIGHT,
      }),
    ],
  });

  let orderTotal = 0;
  const itemRows = order.items.map((item, idx) => {
    const lineTotal = item.quantity * item.unitPrice;
    orderTotal += lineTotal;
    return new TableRow({
      children: [
        cell(String(idx + 1), { width: 6 }),
        cell(item.product.name, { width: 38 }),
        cell(String(item.quantity), { width: 12, align: AlignmentType.RIGHT }),
        cell(t(`product_units.${item.product.unit}`), { width: 14, align: AlignmentType.RIGHT }),
        cell(formatCHF(item.unitPrice), {
          width: 15,
          align: AlignmentType.RIGHT,
        }),
        cell(formatCHF(lineTotal), { width: 15, align: AlignmentType.RIGHT }),
      ],
    });
  });

  const totalRow = new TableRow({
    children: [
      new TableCell({
        borders: thinBorder,
        columnSpan: 5,
        children: [
          new Paragraph({
            alignment: AlignmentType.RIGHT,
            children: [new TextRun({ text: "Rechnungsbetrag", bold: true, size: 20 })],
          }),
        ],
      }),
      cell(formatCHF(orderTotal), {
        bold: true,
        align: AlignmentType.RIGHT,
        width: 15,
      }),
    ],
  });

  const itemsTable = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [itemsHeaderRow, ...itemRows, totalRow],
  });

  const paymentTermsParagraph = new Paragraph({
    children: [
      new TextRun({
        text: `Der Gesamtbetrag von ${formatCHF(orderTotal)} ist innert ${settings.paymentTermsDays} Tage zahlbar.`,
        size: 20,
      }),
    ],
  });

  const closingParagraph = settings.closingText
    ? new Paragraph({
        children: textRunsFromMultiline(settings.closingText, 22),
      })
    : null;

  return [
    headerTable,
    new Paragraph({ children: [] }),
    ...recipientParagraphs,
    new Paragraph({ children: [] }),
    new Paragraph({ children: [] }),
    titleParagraph,
    new Paragraph({ children: [] }),
    ...(introParagraph ? [introParagraph, new Paragraph({ children: [] })] : []),
    itemsTable,
    new Paragraph({ children: [] }),
    paymentTermsParagraph,
    ...(closingParagraph ? [new Paragraph({ children: [] }), closingParagraph] : []),
  ];
}

function wrapInDocument(children: (Paragraph | Table)[], footer: Footer): Document {
  return new Document({
    sections: [
      {
        properties: { page: { margin: PAGE_MARGIN } },
        children,
        footers: { default: footer },
      },
    ],
  });
}

async function generateInvoiceDocx(
  order: OrderWithRelations,
  settings: InvoiceSettings,
  invoiceNumber: string,
  t: TFunction
): Promise<Buffer> {
  return Packer.toBuffer(
    wrapInDocument(buildInvoiceChildren(order, settings, invoiceNumber, t), buildFooter(settings))
  );
}

// Combines multiple invoices into one document, each starting on a new page
async function generateInvoicesDocxSingle(
  invoices: Array<{
    order: OrderWithRelations;
    settings: InvoiceSettings;
    invoiceNumber: string;
    t: TFunction;
  }>
): Promise<Buffer> {
  const allChildren = invoices.flatMap(({ order, settings, invoiceNumber, t }, i) => {
    const children = buildInvoiceChildren(order, settings, invoiceNumber, t);
    if (i === 0) return children;
    // Insert a page break before each subsequent invoice
    const [first, ...rest] = children;
    return [new Paragraph({ pageBreakBefore: true, children: [] }), first, ...rest];
  });
  // Use footer from the first invoice's settings (all invoices share the same farm settings)
  return Packer.toBuffer(wrapInDocument(allChildren, buildFooter(invoices[0].settings)));
}

function invoiceFileName(invoiceNumber: string, order: OrderWithRelations): string {
  const contactName = `${order.contact.firstName}_${order.contact.lastName}`.replace(/\s+/g, "_");
  return `Rechnung_${invoiceNumber.replace("/", "-")}_${contactName}.docx`;
}

// Count orders for the same farm+year with orderDate < order, plus same-date orders with id <= order.id.
// The id tiebreaker ensures two orders on the same date get distinct invoice numbers.
async function deriveInvoiceNumber(order: OrderWithRelations, farmId: string, token: SupabaseToken): Promise<string> {
  const orderYear = new Date(order.orderDate).getFullYear();
  const yearStart = new Date(orderYear, 0, 1);
  const orderDateStr = new Date(order.orderDate).toISOString().slice(0, 10);
  const db = makeRlsDb(token, farmId);
  const [row] = await db.rls((tx) =>
    tx
      .select({ count: sql<number>`count(*)::int` })
      .from(orders)
      .where(
        and(
          eq(orders.farmId, farmId),
          sql`${orders.orderDate} >= ${yearStart.toISOString().slice(0, 10)}`,
          sql`(${orders.orderDate} < ${orderDateStr} OR (${orders.orderDate} = ${orderDateStr} AND ${orders.id} <= ${order.id}))`
        )
      )
  );
  const position = row?.count ?? 1;
  return `${position}/${String(orderYear).slice(-2)}`;
}

export function invoicesApi(db: RlsDb, t: TFunction) {
  const settings = invoiceSettingsApi(db);

  return {
    async downloadInvoice(
      orderId: string,
      farmId: string,
      settingsId: string,
      token: SupabaseToken
    ): Promise<{ base64: string; fileName: string }> {
      const order = await db.rls((tx) =>
        tx.query.orders.findFirst({
          where: { id: orderId },
          with: { contact: true, items: { with: { product: true } } },
        })
      );
      if (!order) throw new Error("Order not found");
      const invoiceSettings = await settings.getById(settingsId);
      if (!invoiceSettings) throw new Error("Invoice settings not configured");
      const invoiceNumber = await deriveInvoiceNumber(order as OrderWithRelations, farmId, token);
      const buffer = await generateInvoiceDocx(order as OrderWithRelations, invoiceSettings, invoiceNumber, t);
      return {
        base64: buffer.toString("base64"),
        fileName: invoiceFileName(invoiceNumber, order as OrderWithRelations),
      };
    },

    async downloadInvoicesBatch(
      orderIds: string[],
      farmId: string,
      settingsId: string,
      token: SupabaseToken,
      mode: "single" | "zip"
    ): Promise<{ base64: string; fileName: string }> {
      const invoiceSettings = await settings.getById(settingsId);
      if (!invoiceSettings) throw new Error("Invoice settings not configured");
      const date = new Date().toISOString().slice(0, 10);

      const resolved = await Promise.all(
        orderIds.map(async (orderId) => {
          const order = await db.rls((tx) =>
            tx.query.orders.findFirst({
              where: { id: orderId },
              with: { contact: true, items: { with: { product: true } } },
            })
          );
          if (!order) throw new Error(`Order not found: ${orderId}`);
          const invoiceNumber = await deriveInvoiceNumber(order as OrderWithRelations, farmId, token);
          return { order: order as OrderWithRelations, invoiceNumber, settings: invoiceSettings, t };
        })
      );

      if (mode === "single") {
        const buffer = await generateInvoicesDocxSingle(resolved);
        return { base64: buffer.toString("base64"), fileName: `Rechnungen_${date}.docx` };
      }

      const JSZip = (await import("jszip")).default;
      const zip = new JSZip();
      await Promise.all(
        resolved.map(async ({ order, invoiceNumber }) => {
          const buffer = await generateInvoiceDocx(order, invoiceSettings, invoiceNumber, t);
          zip.file(invoiceFileName(invoiceNumber, order), buffer);
        })
      );
      const zipBuffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
      return { base64: zipBuffer.toString("base64"), fileName: `Rechnungen_${date}.zip` };
    },
  };
}
