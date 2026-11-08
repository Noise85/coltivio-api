import { describe, it, expect, beforeEach } from "@jest/globals";
import ExcelJS from "exceljs";
import { eq } from "drizzle-orm";
import { cleanDb, getAdminDb, request } from "./helpers";
import * as schema from "../db/schema";
import {
  createUserWithFarm,
  createPlot,
  createCrop,
  createCropRotation,
  createAnimal,
  createHerd,
  createOutdoorSchedule,
  createTreatment,
} from "./test-utils";

// ---------------------------------------------------------------------------
// Reports - Field Calendar
// ---------------------------------------------------------------------------
// TODO: skipped due to missing ICU data in test Node.js environment
describe("Field Calendar Reports", () => {
  beforeEach(cleanDb);

  it("downloads a field calendar report as base64 PDF", async () => {
    const { jwt } = await createUserWithFarm();
    // Create some data so the report has content
    const plot = await createPlot(jwt, { name: "ReportField" });
    const crop = await createCrop(jwt, { name: "Grass", category: "grass" });
    await createCropRotation(jwt, plot.id, crop.id, {
      fromDate: "2025-01-01",
      toDate: "2025-12-31",
    });

    const res = await request(
      "POST",
      "/v1/reports/fieldcalendar/download",
      {
        fromDate: "2025-01-01",
        toDate: "2025-12-31",
        generateCropRotations: true,
        generateTillages: false,
        generateFertilizerApplications: false,
        generateCropProtectionApplications: false,
        generateHarvests: false,
      },
      jwt
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { base64: string; fileName: string };
    };
    expect(body.data.base64).toBeDefined();
    expect(body.data.base64.length).toBeGreaterThan(0);
    expect(body.data.fileName).toBeDefined();
  });
});

describe("Field Calendar Reports with archived plots", () => {
  beforeEach(cleanDb);

  async function reportCellTexts(jwt: string, fromDate: string, toDate: string): Promise<string[]> {
    const res = await request(
      "POST",
      "/v1/reports/fieldcalendar/download",
      {
        fromDate,
        toDate,
        generateCropRotations: true,
        generateTillages: false,
        generateFertilizerApplications: false,
        generateCropProtectionApplications: false,
        generateHarvests: false,
      },
      jwt
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { base64: string } };
    const workbook = new ExcelJS.Workbook();
    const reportBytes = Buffer.from(body.data.base64, "base64");
    await workbook.xlsx.load(
      reportBytes.buffer.slice(reportBytes.byteOffset, reportBytes.byteOffset + reportBytes.byteLength)
    );
    const cellTexts: string[] = [];
    workbook.eachSheet((sheet) => {
      sheet.eachRow((row) => {
        row.eachCell((cell) => {
          cellTexts.push(String(cell.value));
        });
      });
    });
    return cellTexts;
  }

  it("shows archived plots only up to their archive date", async () => {
    const { jwt } = await createUserWithFarm();
    const crop = await createCrop(jwt, { name: "Grass", category: "grass" });
    const archivedPlot = await createPlot(jwt, { name: "ArchivedField" });
    await createCropRotation(jwt, archivedPlot.id, crop.id, { fromDate: "2025-01-01", toDate: "2025-12-31" });
    const activePlot = await createPlot(jwt, { name: "ActiveField" });
    await createCropRotation(jwt, activePlot.id, crop.id, { fromDate: "2025-01-01", toDate: "2026-12-31" });

    const archivedAt = new Date("2025-06-15T12:00:00Z");
    await getAdminDb().update(schema.plots).set({ archivedAt }).where(eq(schema.plots.id, archivedPlot.id));

    // Archived during the period: included, its crop rotation ends on the archive date
    const reportArchivedDuring = await reportCellTexts(jwt, "2025-01-01", "2025-12-31");
    expect(reportArchivedDuring.some((text) => text.includes("ArchivedField"))).toBe(true);
    expect(reportArchivedDuring).toContain(archivedAt.toLocaleDateString("de"));
    expect(reportArchivedDuring).not.toContain(new Date("2025-12-31").toLocaleDateString("de"));

    // Archived before the period: left out
    const reportArchivedBefore = await reportCellTexts(jwt, "2026-01-01", "2026-12-31");
    expect(reportArchivedBefore.some((text) => text.includes("ArchivedField"))).toBe(false);
    expect(reportArchivedBefore.some((text) => text.includes("ActiveField"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Reports - Treatment
// ---------------------------------------------------------------------------
describe("Treatment Reports", () => {
  beforeEach(cleanDb);

  it("downloads a treatment report as base64 PDF", async () => {
    const { jwt } = await createUserWithFarm();
    const animal = await createAnimal(jwt, { name: "ReportCow" });
    await createTreatment(jwt, [animal.id], {
      name: "Report Treatment",
      startDate: "2025-03-01",
      endDate: "2025-03-05",
    });

    const res = await request(
      "POST",
      "/v1/reports/treatments/download",
      {
        fromDate: "2025-01-01",
        toDate: "2025-12-31",
      },
      jwt
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { base64: string; fileName: string };
    };
    expect(body.data.base64).toBeDefined();
    expect(body.data.base64.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Reports - Outdoor Journal
// ---------------------------------------------------------------------------
describe("Outdoor Journal Reports", () => {
  beforeEach(cleanDb);

  it("downloads an outdoor journal report as base64 PDF", async () => {
    const { jwt } = await createUserWithFarm();
    const sheep = await createAnimal(jwt, {
      type: "sheep",
      sex: "female",
      dateOfBirth: "2020-01-01",
      usage: "other",
    });
    const herd = await createHerd(jwt, { animalIds: [sheep.id] });
    await createOutdoorSchedule(jwt, herd.id, {
      startDate: "2025-05-01",
      endDate: "2025-09-30",
    });

    const res = await request(
      "POST",
      "/v1/reports/outdoorjournal/download",
      {
        fromDate: "2025-01-01",
        toDate: "2025-12-31",
      },
      jwt
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { base64: string; fileName: string };
    };
    expect(body.data.base64).toBeDefined();
    expect(body.data.base64.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Reports - Animals (combined treatments + outdoor journal)
// ---------------------------------------------------------------------------
describe("Animals Reports", () => {
  beforeEach(cleanDb);

  it("downloads a combined report with both sections enabled", async () => {
    const { jwt } = await createUserWithFarm();
    const animal = await createAnimal(jwt, { name: "ReportCow" });
    await createTreatment(jwt, [animal.id], {
      name: "Report Treatment",
      startDate: "2025-03-01",
      endDate: "2025-03-05",
    });
    const sheep = await createAnimal(jwt, {
      type: "sheep",
      sex: "female",
      dateOfBirth: "2020-01-01",
      usage: "other",
    });
    const herd = await createHerd(jwt, { animalIds: [sheep.id] });
    await createOutdoorSchedule(jwt, herd.id, {
      startDate: "2025-05-01",
      endDate: "2025-09-30",
    });

    const res = await request(
      "POST",
      "/v1/reports/animals/download",
      {
        fromDate: "2025-01-01",
        toDate: "2025-12-31",
        generateTreatments: true,
        generateOutdoorJournal: true,
      },
      jwt
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { base64: string; fileName: string };
    };
    expect(body.data.base64).toBeDefined();
    expect(body.data.base64.length).toBeGreaterThan(0);
    expect(body.data.fileName).toBeDefined();
  });

  it("only includes the requested sections", async () => {
    const { jwt } = await createUserWithFarm();
    const animal = await createAnimal(jwt, { name: "ReportCow" });
    await createTreatment(jwt, [animal.id], {
      name: "Report Treatment",
      startDate: "2025-03-01",
      endDate: "2025-03-05",
    });

    const res = await request(
      "POST",
      "/v1/reports/animals/download",
      {
        fromDate: "2025-01-01",
        toDate: "2025-12-31",
        generateTreatments: true,
        generateOutdoorJournal: false,
      },
      jwt
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { base64: string; fileName: string };
    };
    expect(body.data.base64).toBeDefined();
    expect(body.data.base64.length).toBeGreaterThan(0);
  });
});
