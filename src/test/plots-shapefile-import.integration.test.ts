import { describe, it, expect, beforeEach } from "@jest/globals";
import JSZip from "jszip";
import { sql } from "drizzle-orm";

import { cleanDb, getAdminDb, request } from "./helpers";
import * as schema from "../db/schema";
import { createUserWithFarm } from "./test-utils";
import federalFarmPlotsFixture from "./fixtures/federal-farm-plots.json";

// All shapefiles are generated here: no customer exports in the repo. The federal fixture holds public
// federal plot data of two farms with the farm and parcel ids replaced. The DBF layouts mirror the
// LAWIS / LAWISplus "Geometriedaten exportieren" file (betriebsansicht-kul) and the Acorda shape export.

type ParseError = { code: string; value?: string };

type PreviewRow = {
  rowNumber: number;
  externalId: string | null;
  name: string;
  localId: string | null;
  usage: number | null;
  usageName: string | null;
  size: number;
  cuttingDate: string | null;
  municipality: string | null;
  geometry: { type: "MultiPolygon"; coordinates: number[][][][] } | null;
  overlappingPlotIds: string[];
  parseErrors: ParseError[];
};

type OverlayRow = {
  rowNumber: number;
  externalId: string;
  name: string;
  localId: string | null;
  usage: number;
  usageName: string | null;
  size: number;
  geometry: { type: "MultiPolygon"; coordinates: number[][][][] };
  alreadyPresent: boolean;
};

type PreviewResponse = {
  data: {
    format: { name: string; label: string; geometryOnly: boolean };
    completeness: "full" | "partial" | "geometries_only";
    rows: PreviewRow[];
    overlays: OverlayRow[];
  };
};

type CommitResponse = { data: { created: number; overlaysCreated: number; overlaysSkipped: number } };

// ---- Shapefile builders ----

type Ring = number[][];

// Minimal polygon shapefile (type 5). Each record is a list of rings: the first one is the outer ring
// (clockwise), further ones are holes (counter clockwise). Coordinates in LV95.
function buildPolygonShp(records: Ring[][]) {
  const recordBuffers = records.map((rings) => {
    const pointCount = rings.reduce((sum, ring) => sum + ring.length, 0);
    const contentLength = 4 + 32 + 4 + 4 + rings.length * 4 + pointCount * 16;
    const record = Buffer.alloc(8 + contentLength);
    record.writeInt32BE(0, 0);
    record.writeInt32BE(contentLength / 2, 4);
    record.writeInt32LE(5, 8);
    const points = rings.flat();
    record.writeDoubleLE(Math.min(...points.map((p) => p[0])), 12);
    record.writeDoubleLE(Math.min(...points.map((p) => p[1])), 20);
    record.writeDoubleLE(Math.max(...points.map((p) => p[0])), 28);
    record.writeDoubleLE(Math.max(...points.map((p) => p[1])), 36);
    record.writeInt32LE(rings.length, 44);
    record.writeInt32LE(pointCount, 48);
    let partStart = 0;
    rings.forEach((ring, index) => {
      record.writeInt32LE(partStart, 52 + index * 4);
      partStart += ring.length;
    });
    const pointsOffset = 52 + rings.length * 4;
    points.forEach(([x, y], index) => {
      record.writeDoubleLE(x, pointsOffset + index * 16);
      record.writeDoubleLE(y, pointsOffset + 8 + index * 16);
    });
    return record;
  });
  const body = Buffer.concat(recordBuffers);
  const header = Buffer.alloc(100);
  header.writeInt32BE(9994, 0);
  header.writeInt32BE((100 + body.length) / 2, 24);
  header.writeInt32LE(1000, 28);
  header.writeInt32LE(5, 32);
  const allPoints = records.flat(2);
  header.writeDoubleLE(Math.min(...allPoints.map((p) => p[0])), 36);
  header.writeDoubleLE(Math.min(...allPoints.map((p) => p[1])), 44);
  header.writeDoubleLE(Math.max(...allPoints.map((p) => p[0])), 52);
  header.writeDoubleLE(Math.max(...allPoints.map((p) => p[1])), 60);
  return Buffer.concat([header, body]);
}

// Clockwise rectangle (outer ring orientation in shapefiles) with its lower left corner at (x, y).
function rect(x: number, y: number, width: number, height: number): Ring {
  return [
    [x, y],
    [x, y + height],
    [x + width, y + height],
    [x + width, y],
    [x, y],
  ];
}

function square(x: number, y: number, side: number): Ring {
  return rect(x, y, side, side);
}

// Counter clockwise rectangle, used as a hole
function hole(x: number, y: number, width: number, height: number): Ring {
  return rect(x, y, width, height).reverse();
}

// DBF (dBase III) with character fields only, latin1 encoded like the LAWIS exports
function buildDbf(fieldNames: string[], records: string[][], fieldLength = 64) {
  const headerLength = 32 + fieldNames.length * 32 + 1;
  const recordLength = 1 + fieldNames.length * fieldLength;
  const buffer = Buffer.alloc(headerLength + records.length * recordLength + 1, " ");
  buffer.fill(0, 0, headerLength);
  buffer[0] = 0x03;
  buffer.writeUInt32LE(records.length, 4);
  buffer.writeUInt16LE(headerLength, 8);
  buffer.writeUInt16LE(recordLength, 10);
  fieldNames.forEach((name, index) => {
    const descriptor = 32 + index * 32;
    buffer.write(name, descriptor, "latin1");
    buffer[descriptor + 11] = "C".charCodeAt(0);
    buffer[descriptor + 16] = fieldLength;
  });
  buffer[headerLength - 1] = 0x0d;
  records.forEach((record, recordIndex) => {
    const recordStart = headerLength + recordIndex * recordLength;
    buffer[recordStart] = 0x20;
    record.forEach((value, fieldIndex) => {
      buffer.write(value, recordStart + 1 + fieldIndex * fieldLength, fieldLength, "latin1");
    });
  });
  buffer[buffer.length - 1] = 0x1a;
  return buffer;
}

const KUL_FIELDS = [
  "LNFCode",
  "Ident",
  "BweNr",
  "FlaeLN",
  "Bez",
  "Art",
  "Stueck",
  "AVParz",
  "Jahr",
  "FlaeALN",
  "Nutzung",
  "VertragsNr",
  "VertragsID",
  "Betrieb",
  "Person",
  "Gemeinde",
];

type KulRecord = {
  code: string;
  ident: string;
  parcel: string;
  // in Aren
  areaLn?: string;
  areaAln?: string;
  usage?: string;
  municipality?: string;
};

function buildKulDbf(records: KulRecord[]) {
  return buildDbf(
    KUL_FIELDS,
    records.map((record) => [
      record.code,
      record.ident,
      `63.${record.parcel}.0`,
      record.areaLn ?? "",
      record.usage ? `${record.code} - ${record.usage}` : "",
      "NF",
      "",
      record.parcel,
      "2026",
      record.areaAln ?? "",
      record.usage ?? "",
      "",
      "",
      "ZZ0001/ 1/1",
      "ZZ000001",
      record.municipality ?? "Testhausen",
    ])
  );
}

// Field names as in Agridea's sample file, cut to 10 characters by the DBF format
const ACORDA_FIELDS = ["id", "exploitati", "parcel_nam", "affectatio", "surface", "surfaceArr", "zone"];

type AcordaRecord = {
  id: string;
  name: string;
  // "<code> <French crop name>"
  affectation: string;
  // in Aren
  area: string;
};

function buildAcordaZip(shapes: Ring[][], records: AcordaRecord[]) {
  const dbf = buildDbf(
    ACORDA_FIELDS,
    records.map((record) => [
      record.id,
      "ZZ-1234",
      record.name,
      record.affectation,
      record.area,
      String(Math.round(Number.parseFloat(record.area) || 0)),
      "31",
    ])
  );
  return buildZip({ "export/export.shp": buildPolygonShp(shapes), "export/export.dbf": dbf });
}

// Minimal DBF with a single unknown character field "Foo": the API falls back to geometry only.
function buildUnknownDbf(numberOfRecords: number) {
  return buildDbf(
    ["Foo"],
    Array.from({ length: numberOfRecords }, () => [""]),
    10
  );
}

async function buildZip(files: Record<string, Buffer>) {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(files)) zip.file(name, content);
  return zip.generateAsync({ type: "nodebuffer" });
}

async function buildKulZip(shapes: Ring[][], records: KulRecord[], basename = "export/betriebsansicht-kul_poly") {
  return buildZip({ [`${basename}.shp`]: buildPolygonShp(shapes), [`${basename}.dbf`]: buildKulDbf(records) });
}

// ---- The sample farm: four Kulturen on three parcels, laid out so none of them overlap ----

const ORIGIN_X = 2_700_000;
const ORIGIN_Y = 1_150_000;

// parcel 101 carries Winterweizen (1 ha) and Kunstwiese (0.5 ha), parcel 102 is a Dauerwiese with a hole
// (4 ha minus 0.25 ha), parcel 103 is Wald outside the LN (FlaeALN instead of FlaeLN)
function sampleShapes(originX = ORIGIN_X, originY = ORIGIN_Y): Ring[][] {
  return [
    [square(originX, originY, 100)],
    [rect(originX + 100, originY, 100, 50)],
    [square(originX, originY + 200, 200), hole(originX + 50, originY + 250, 50, 50)],
    [square(originX + 300, originY, 50)],
  ];
}

const SAMPLE_RECORDS: KulRecord[] = [
  {
    code: "0513",
    ident: "1001",
    parcel: "101",
    areaLn: "100.00",
    usage: "Winterweizen (ohne Futterweizen der Sortenliste swiss granum)",
  },
  { code: "0601", ident: "1002", parcel: "101", areaLn: "50.00", usage: "Kunstwiesen (ohne Weiden)" },
  { code: "0613", ident: "1003", parcel: "102", areaLn: "375.00", usage: "Übrige Dauerwiesen (ohne Weiden)" },
  { code: "0901", ident: "1004", parcel: "103", areaAln: "25.00", usage: "Wald" },
];
const SAMPLE_SIZES = [10000, 5000, 37500, 2500];

// Real rows of two farms from the federal plot dataset, farm and parcel ids replaced
async function insertFederalFixture(federalFarmId: string) {
  const db = getAdminDb();
  for (const row of federalFarmPlotsFixture.filter((fixtureRow) => fixtureRow.farmId === federalFarmId)) {
    await db.execute(sql`
      insert into ${schema.federalFarmPlots} (id, farm_id, local_id, usage, size, cut_date, canton, geometry)
      values (${row.id}, ${row.farmId}, ${row.localId}, ${row.usage}, ${row.size}, ${row.cutDate}, ${row.canton},
              ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(row.geometry)}), 4326))
    `);
  }
}

async function uploadZip(zipBuffer: Buffer, jwt: string) {
  const formData = new FormData();
  formData.append("file", new Blob([new Uint8Array(zipBuffer)], { type: "application/zip" }), "plots.zip");
  return fetch(`${process.env.SERVER_URL!}/v1/plots/import/preview`, {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}` },
    body: formData,
  });
}

async function previewZip(zipBuffer: Buffer, jwt: string) {
  const res = await uploadZip(zipBuffer, jwt);
  expect(res.status).toBe(200);
  return ((await res.json()) as PreviewResponse).data;
}

async function previewSample(jwt: string, originX = ORIGIN_X, originY = ORIGIN_Y) {
  const preview = await previewZip(await buildKulZip(sampleShapes(originX, originY), SAMPLE_RECORDS), jwt);
  expect(preview.completeness).toBe("full");
  expect(preview.format).toEqual({ name: "kul_poly", label: "LAWIS", geometryOnly: false });
  return preview;
}

function toCommitRow(row: PreviewRow) {
  return {
    name: row.name,
    localId: row.localId ?? undefined,
    usage: row.usage ?? undefined,
    size: row.size,
    geometry: row.geometry!,
  };
}

function toCommitOverlay(overlay: OverlayRow) {
  return {
    externalId: overlay.externalId,
    name: overlay.name,
    localId: overlay.localId,
    usage: overlay.usage,
    usageName: overlay.usageName,
    size: overlay.size,
    geometry: overlay.geometry,
  };
}

async function commit(
  jwt: string,
  body: { format?: string; rows?: ReturnType<typeof toCommitRow>[]; overlays?: ReturnType<typeof toCommitOverlay>[] }
) {
  return request("POST", "/v1/plots/import/commit", { format: "kul_poly", rows: [], overlays: [], ...body }, jwt);
}

async function errorMessage(res: Response) {
  const body = (await res.json()) as { error: string };
  return body.error;
}

describe("Plot shapefile import — preview + commit", () => {
  beforeEach(cleanDb);

  it("preview reads attributes and geometries of a kul export without writing to the DB", async () => {
    const { jwt } = await createUserWithFarm();
    const { rows, overlays } = await previewSample(jwt);

    expect(overlays).toHaveLength(0);
    expect(rows).toHaveLength(4);
    expect(rows[0]).toMatchObject({
      rowNumber: 1,
      externalId: "1001",
      name: "101 Winterweizen",
      localId: "101",
      usage: 513,
      usageName: "Winterweizen (ohne Futterweizen der Sortenliste swiss granum)",
      size: 10000,
      cuttingDate: null,
      municipality: "Testhausen",
      overlappingPlotIds: [],
      parseErrors: [],
    });
    // repeated parcel numbers get the crop appended, single ones stay plain
    expect(rows.map((row) => row.name)).toEqual(["101 Winterweizen", "101 Kunstwiese", "102", "103"]);
    // size from FlaeLN, for the Wald row from FlaeALN
    expect(rows.map((row) => row.size)).toEqual(SAMPLE_SIZES);
    expect(rows[2].usageName).toBe("Übrige Dauerwiesen (ohne Weiden)");

    // reprojected from LV95 to WGS84
    const [longitude, latitude] = rows[0].geometry!.coordinates[0][0][0];
    expect(longitude).toBeGreaterThan(8);
    expect(longitude).toBeLessThan(9.5);
    expect(latitude).toBeGreaterThan(46);
    expect(latitude).toBeLessThan(47);
    // the hole of parcel 102 survived as an inner ring
    expect(rows[2].geometry!.coordinates[0]).toHaveLength(2);

    // The polygon area (from the .shp) must match the declared area (from the .dbf) for every feature.
    // This catches lost holes, mixed up rings and reprojection errors.
    const db = getAdminDb();
    const geometriesJson = JSON.stringify(rows.map((row) => row.geometry));
    const areas = await db.execute<{ area: number }>(
      sql`select ST_Area(ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON(geometry), 4326), 2056)) as area
          from json_array_elements(${geometriesJson}::json) with ordinality as feature(geometry, position)
          order by position`
    );
    for (const [index, row] of rows.entries()) {
      expect(Math.abs(areas[index].area - row.size)).toBeLessThan(1);
    }

    expect(await db.$count(schema.plots)).toBe(0);
  });

  it("commit creates the plots where the file puts them, with crops and current-year rotations", async () => {
    const { jwt, farmId } = await createUserWithFarm();
    const db = getAdminDb();
    // a farm without Betriebsnummer starts with a Naturwiese crop that carries no usage codes yet
    const initialCrops = await db
      .select()
      .from(schema.crops)
      .where(sql`${schema.crops.farmId} = ${farmId}`);
    expect(initialCrops.map((crop) => crop.name)).toEqual(["Naturwiese"]);

    const { rows } = await previewSample(jwt);
    const commitRes = await commit(jwt, { rows: rows.map(toCommitRow) });
    expect(commitRes.status).toBe(200);
    expect(((await commitRes.json()) as CommitResponse).data).toEqual({
      created: 4,
      overlaysCreated: 0,
      overlaysSkipped: 0,
    });

    const listRes = await request("GET", "/v1/plots", undefined, jwt);
    const listBody = (await listRes.json()) as {
      data: { count: number; result: { name: string; localId: string | null }[] };
    };
    expect(listBody.data.count).toBe(4);
    expect(listBody.data.result.map((plot) => plot.name).sort()).toEqual([
      "101 Kunstwiese",
      "101 Winterweizen",
      "102",
      "103",
    ]);

    const invalidGeometries = await db.execute<{ id: string }>(
      sql`select ${schema.plots.id} from ${schema.plots} where ${schema.plots.farmId} = ${farmId} and not ST_IsValid(${schema.plots.geometry})`
    );
    expect(invalidGeometries).toHaveLength(0);

    // The stored polygon of row 1 must sit where the shapefile puts it: first vertex in LV95 and its area.
    const [storedPlot] = await db.execute<{ distance_to_first_vertex: number; area: number }>(
      sql`select
            ST_Distance(ST_Transform(${schema.plots.geometry}, 2056), ST_SetSRID(ST_MakePoint(${ORIGIN_X}, ${ORIGIN_Y}), 2056)) as distance_to_first_vertex,
            ST_Area(ST_Transform(${schema.plots.geometry}, 2056)) as area
          from ${schema.plots}
          where ${schema.plots.farmId} = ${farmId} and ${schema.plots.name} = '101 Winterweizen'`
    );
    expect(storedPlot.distance_to_first_vertex).toBeLessThan(0.05);
    expect(Math.abs(storedPlot.area - 10000)).toBeLessThan(1);

    // crops: Naturwiese reused for 613, one crop per further code, no duplicate names
    const crops = await db
      .select()
      .from(schema.crops)
      .where(sql`${schema.crops.farmId} = ${farmId}`);
    expect(new Set(crops.map((crop) => crop.name)).size).toBe(crops.length);
    const naturwiese = crops.find((crop) => crop.name === "Naturwiese")!;
    expect(naturwiese.id).toBe(initialCrops[0].id);
    expect(naturwiese.usageCodes).toEqual([613]);
    expect(crops.map((crop) => crop.name).sort()).toEqual(["Kunstwiese", "Naturwiese", "Wald", "Winterweizen"]);

    const rotations = await db
      .select({ fromDate: schema.cropRotations.fromDate, toDate: schema.cropRotations.toDate })
      .from(schema.cropRotations)
      .where(sql`${schema.cropRotations.farmId} = ${farmId}`);
    expect(rotations).toHaveLength(4);
    const year = new Date().getFullYear();
    for (const rotation of rotations) {
      expect(rotation.fromDate.toISOString().slice(0, 10)).toBe(`${year}-01-01`);
      expect(rotation.toDate.toISOString().slice(0, 10)).toBe(`${year}-12-31`);
    }
    expect(await db.$count(schema.cropRotationYearlyRecurrences)).toBe(4);

    // a second file elsewhere reuses the crops it shares with the first one
    const second = await previewSample(jwt, ORIGIN_X + 5000, ORIGIN_Y);
    const secondCommit = await commit(jwt, { rows: second.rows.map(toCommitRow) });
    expect(secondCommit.status).toBe(200);
    const cropsAfter = await db
      .select()
      .from(schema.crops)
      .where(sql`${schema.crops.farmId} = ${farmId}`);
    expect(cropsAfter).toHaveLength(4);
    expect(cropsAfter.filter((crop) => crop.usageCodes.includes(513))).toHaveLength(1);
    expect(await db.$count(schema.cropRotations)).toBe(8);
  });

  it("preview flags rows that overlap existing plots and commit rejects them", async () => {
    const { jwt } = await createUserWithFarm();
    const { rows } = await previewSample(jwt);

    const createRes = await request("POST", "/v1/plots", toCommitRow(rows[0]), jwt);
    expect(createRes.status).toBe(200);
    const existingPlot = ((await createRes.json()) as { data: { id: string } }).data;

    const secondPreview = await previewSample(jwt);
    expect(secondPreview.rows[0].overlappingPlotIds).toEqual([existingPlot.id]);
    // the Kunstwiese next to it only shares a border and must not be flagged
    expect(secondPreview.rows.filter((row) => row.overlappingPlotIds.length > 0).map((row) => row.rowNumber)).toEqual([
      1,
    ]);

    // the overlapping row fails the whole import, nothing is written and the existing plot stays intact
    const commitRes = await commit(jwt, { rows: rows.map(toCommitRow) });
    expect(commitRes.status).toBe(409);
    expect(JSON.stringify(await commitRes.json())).toContain(`row 1 overlaps plot ${existingPlot.id}`);
    const db = getAdminDb();
    const [existing] = await db.execute<{ area: number }>(
      sql`select ST_Area(ST_Transform(${schema.plots.geometry}, 2056)) as area from ${schema.plots} where ${schema.plots.id} = ${existingPlot.id}`
    );
    expect(existing.area).toBeGreaterThan(1000);
    expect(await db.$count(schema.plots)).toBe(1);

    // a row that only shares a border is accepted
    const neighbourRes = await commit(jwt, { rows: [toCommitRow(rows[1])] });
    expect(neighbourRes.status).toBe(200);
  });

  it("ignores sliver overlaps below 1% of the smaller plot", async () => {
    const { jwt } = await createUserWithFarm();
    const { rows } = await previewSample(jwt);
    const createRes = await request("POST", "/v1/plots", toCommitRow(rows[0]), jwt);
    expect(createRes.status).toBe(200);

    // the same 100 m square shifted by 1.5 m overlaps 150 m² (1.5%) and conflicts
    const shiftedFar = await previewSample(jwt, ORIGIN_X + 98.5, ORIGIN_Y);
    expect(shiftedFar.rows[0].overlappingPlotIds).toHaveLength(1);
    expect((await commit(jwt, { rows: [toCommitRow(shiftedFar.rows[0])] })).status).toBe(409);

    // shifted by 99.5 m it overlaps 50 m² (0.5%), a sliver from slightly different borders
    const shiftedNear = await previewSample(jwt, ORIGIN_X + 99.5, ORIGIN_Y);
    expect(shiftedNear.rows[0].overlappingPlotIds).toEqual([]);
    expect((await commit(jwt, { rows: [toCommitRow(shiftedNear.rows[0])] })).status).toBe(200);
  });

  it("leaves rows with usage 595 out of the preview", async () => {
    const { jwt } = await createUserWithFarm();
    const shapes = [...sampleShapes(), [square(ORIGIN_X + 500, ORIGIN_Y, 20)]];
    const records: KulRecord[] = [
      ...SAMPLE_RECORDS,
      { code: "0595", ident: "4001", parcel: "104", areaLn: "4.00", usage: "Übrige offene Ackerfläche" },
    ];
    const preview = await previewZip(await buildKulZip(shapes, records), jwt);
    expect(preview.rows.map((row) => row.usage)).toEqual([513, 601, 613, 901]);
    expect(preview.overlays).toEqual([]);
  });

  it("rejects overlays whose usage code is not an overlay code", async () => {
    const { jwt } = await createUserWithFarm();
    const { rows } = await previewSample(jwt);
    const commitRes = await commit(jwt, {
      overlays: [
        {
          externalId: "3001",
          name: "101",
          localId: "101",
          usage: 613,
          usageName: null,
          size: 100,
          geometry: rows[0].geometry!,
        },
      ],
    });
    expect(commitRes.status).toBe(400);
    expect(await getAdminDb().$count(schema.plotOverlays)).toBe(0);
  });

  it("keeps overlay elements apart from the plots and skips them on a second import", async () => {
    const { jwt, farmId } = await createUserWithFarm();
    // an Ackerschonstreifen and a Hochstamm-Feldobstbaum row on top of the Winterweizen parcel
    const shapes = [...sampleShapes(), [rect(ORIGIN_X, ORIGIN_Y, 100, 6)], [square(ORIGIN_X + 20, ORIGIN_Y + 20, 10)]];
    const records: KulRecord[] = [
      ...SAMPLE_RECORDS,
      { code: "0950", ident: "2001", parcel: "101", areaLn: "6.00", usage: "Ackerschonstreifen" },
      { code: "0921", ident: "2002", parcel: "101", areaLn: "1.00", usage: "Hochstamm-Feldobstbäume" },
    ];
    const zip = await buildKulZip(shapes, records);
    const preview = await previewZip(zip, jwt);
    expect(preview.rows).toHaveLength(4);
    expect(preview.overlays).toHaveLength(2);
    expect(preview.overlays[0]).toMatchObject({
      rowNumber: 5,
      externalId: "2001",
      localId: "101",
      usage: 950,
      usageName: "Ackerschonstreifen",
      size: 600,
      alreadyPresent: false,
    });
    expect(preview.overlays[1]).toMatchObject({
      rowNumber: 6,
      externalId: "2002",
      usage: 921,
      size: 100,
      alreadyPresent: false,
    });
    // overlays do not count towards the repeated parcel names and are not overlap conflicts
    expect(preview.rows.map((row) => row.name)).toEqual(["101 Winterweizen", "101 Kunstwiese", "102", "103"]);

    const commitRes = await commit(jwt, {
      rows: preview.rows.map(toCommitRow),
      overlays: preview.overlays.map(toCommitOverlay),
    });
    expect(commitRes.status).toBe(200);
    expect(((await commitRes.json()) as CommitResponse).data).toEqual({
      created: 4,
      overlaysCreated: 2,
      overlaysSkipped: 0,
    });

    const db = getAdminDb();
    const overlays = await db
      .select()
      .from(schema.plotOverlays)
      .where(sql`${schema.plotOverlays.farmId} = ${farmId}`);
    expect(overlays.map((overlay) => [overlay.externalId, overlay.usage, overlay.source, overlay.size])).toEqual([
      ["2001", 950, "kul_poly", 600],
      ["2002", 921, "kul_poly", 100],
    ]);
    expect(await db.$count(schema.plots)).toBe(4);
    // no crops or rotations for overlays
    const crops = await db
      .select()
      .from(schema.crops)
      .where(sql`${schema.crops.farmId} = ${farmId}`);
    expect(crops.some((crop) => crop.usageCodes.includes(950) || crop.usageCodes.includes(921))).toBe(false);
    expect(await db.$count(schema.cropRotations)).toBe(4);

    // second import of the same file: the plots overlap, the overlays are already there
    const secondPreview = await previewZip(zip, jwt);
    expect(secondPreview.overlays.map((overlay) => overlay.alreadyPresent)).toEqual([true, true]);
    expect(secondPreview.rows.every((row) => row.overlappingPlotIds.length > 0)).toBe(true);
    const secondCommit = await commit(jwt, { overlays: secondPreview.overlays.map(toCommitOverlay) });
    expect(secondCommit.status).toBe(200);
    expect(((await secondCommit.json()) as CommitResponse).data).toEqual({
      created: 0,
      overlaysCreated: 0,
      overlaysSkipped: 2,
    });
    expect(await db.$count(schema.plotOverlays)).toBe(2);
  });

  it("splits a real federal farm into plots and overlays, dropping duplicates but keeping every tree type", async () => {
    // LU farm: 75 rows, 23 of them overlays. 950 has the same geometry as a 516 plot, 921 rows are delivered
    // twice and 921, 922 and 924 are declared on the same orchards.
    await insertFederalFixture("TEST_OVERLAYS");
    const { farmId } = await createUserWithFarm({ federalId: "TEST_OVERLAYS" });
    const db = getAdminDb();

    const plots = await db
      .select()
      .from(schema.plots)
      .where(sql`${schema.plots.farmId} = ${farmId}`);
    expect(plots).toHaveLength(52);
    expect(plots.some((plot) => plot.usage !== null && plot.usage >= 921 && plot.usage <= 951)).toBe(false);

    const overlays = await db
      .select()
      .from(schema.plotOverlays)
      .where(sql`${schema.plotOverlays.farmId} = ${farmId}`);
    const overlayUsageCounts = new Map<number, number>();
    for (const overlay of overlays) {
      overlayUsageCounts.set(overlay.usage, (overlayUsageCounts.get(overlay.usage) ?? 0) + 1);
    }
    expect(Object.fromEntries(overlayUsageCounts)).toEqual({ 921: 8, 922: 2, 924: 6, 950: 1 });
    expect(overlays.every((overlay) => overlay.source === "federal")).toBe(true);
    expect(overlays.every((overlay) => /^[0-9a-f]{32}:\d+$/.test(overlay.externalId))).toBe(true);

    // crops and rotations only for the plots
    expect(await db.$count(schema.cropRotations, sql`${schema.cropRotations.farmId} = ${farmId}`)).toBe(52);
    const crops = await db
      .select()
      .from(schema.crops)
      .where(sql`${schema.crops.farmId} = ${farmId}`);
    const overlayCodes = [921, 922, 924, 950];
    expect(crops.some((crop) => crop.usageCodes.some((code) => overlayCodes.includes(code)))).toBe(false);
  });

  it("leaves 595 out of a real federal farm", async () => {
    // AG farm: 96 rows, 13 of them 595 (regionsspezifische BFF auf offener Ackerfläche)
    await insertFederalFixture("TEST_595");
    const { farmId } = await createUserWithFarm({ federalId: "TEST_595" });
    const db = getAdminDb();

    const plots = await db
      .select()
      .from(schema.plots)
      .where(sql`${schema.plots.farmId} = ${farmId}`);
    expect(plots).toHaveLength(83);
    expect(plots.some((plot) => plot.usage === 595)).toBe(false);
    expect(await db.$count(schema.plotOverlays, sql`${schema.plotOverlays.farmId} = ${farmId}`)).toBe(0);
  });

  it("reports partial completeness and defaults the usage when a row has no usage code", async () => {
    const { jwt } = await createUserWithFarm();
    const records = SAMPLE_RECORDS.map((record, index) => (index === 0 ? { ...record, code: "", usage: "" } : record));
    const preview = await previewZip(await buildKulZip(sampleShapes(), records), jwt);
    expect(preview.completeness).toBe("partial");
    expect(preview.rows[0]).toMatchObject({ localId: "101", usage: 613, size: 10000, parseErrors: [] });
    expect(preview.rows[1].usage).toBe(601);
  });

  it("reports an invalid usage code and an invalid size as translatable errors", async () => {
    const { jwt } = await createUserWithFarm();
    const records = SAMPLE_RECORDS.map((record, index) =>
      index === 0 ? { ...record, code: "abc" } : index === 1 ? { ...record, areaLn: "viel" } : record
    );
    const preview = await previewZip(await buildKulZip(sampleShapes(), records), jwt);
    expect(preview.rows[0].parseErrors).toEqual([{ code: "invalid_usage_code", value: "abc" }]);
    expect(preview.rows[1].parseErrors).toEqual([{ code: "invalid_size", value: "viel" }]);
    // the size falls back to the polygon area
    expect(preview.rows[1].size).toBe(5000);
  });

  it("finds the files by extension regardless of their names", async () => {
    const { jwt } = await createUserWithFarm();
    const zip = await buildZip({
      "Parzellen 2026.SHP": buildPolygonShp(sampleShapes()),
      "some/folder/attribute.dbf": buildKulDbf(SAMPLE_RECORDS),
      "index.shx": Buffer.alloc(100),
    });
    const { rows } = await previewZip(zip, jwt);
    expect(rows).toHaveLength(4);
    expect(rows[0]).toMatchObject({ localId: "101", usage: 513, size: 10000 });
  });

  it("rejects a file that is not a zip", async () => {
    const { jwt } = await createUserWithFarm();
    const res = await uploadZip(Buffer.from("not a zip"), jwt);
    expect(res.status).toBe(400);
  });

  it("imports only the geometry with defaults when the attribute fields are unknown", async () => {
    const { jwt } = await createUserWithFarm();
    const preview = await previewZip(
      await buildZip({ "plots.shp": buildPolygonShp(sampleShapes()), "plots.dbf": buildUnknownDbf(4) }),
      jwt
    );
    expect(preview.completeness).toBe("geometries_only");
    expect(preview.format).toEqual({ name: "geometry_only", label: "", geometryOnly: true });
    const rows = preview.rows;

    expect(rows).toHaveLength(4);
    expect(rows[0]).toMatchObject({
      rowNumber: 1,
      externalId: null,
      name: "Schlag 1",
      localId: null,
      usage: 613,
      usageName: null,
      municipality: null,
      overlappingPlotIds: [],
      parseErrors: [],
    });
    expect(rows[3].name).toBe("Schlag 4");
    // size is computed from the polygon
    expect(rows.map((row) => row.size)).toEqual(SAMPLE_SIZES);
    expect(rows[0].geometry?.type).toBe("MultiPolygon");
  });

  it("reads an Acorda export, including a parcel made of several polygons", async () => {
    const { jwt } = await createUserWithFarm();
    const shapes = [
      [square(ORIGIN_X, ORIGIN_Y, 100)],
      // one parcel, two separate polygons of 0.25 ha each
      [square(ORIGIN_X + 200, ORIGIN_Y, 50), square(ORIGIN_X + 300, ORIGIN_Y, 50)],
    ];
    const preview = await previewZip(
      await buildAcordaZip(shapes, [
        { id: "VD_2026_1", name: "Champ du haut", affectation: "513 Blé d'automne", area: "100.00" },
        { id: "VD_2026_2", name: "Les Grands Prés", affectation: "601 Prairies artificielles", area: "50.00" },
      ]),
      jwt
    );
    expect(preview.format).toEqual({ name: "acorda", label: "Acorda", geometryOnly: false });
    expect(preview.completeness).toBe("full");
    expect(preview.overlays).toHaveLength(0);
    expect(preview.rows[0]).toMatchObject({
      externalId: "VD_2026_1",
      name: "Champ du haut",
      // the export has no cadastral parcel number
      localId: null,
      usage: 513,
      usageName: "Blé d'automne",
      size: 10000,
      municipality: null,
      parseErrors: [],
    });
    expect(preview.rows[1]).toMatchObject({ name: "Les Grands Prés", usage: 601, size: 5000, parseErrors: [] });
    expect(preview.rows[1].geometry!.coordinates).toHaveLength(2);
  });

  it("defaults the name and usage of Acorda rows that lack them", async () => {
    const { jwt } = await createUserWithFarm();
    const shapes = [[square(ORIGIN_X, ORIGIN_Y, 100)], [square(ORIGIN_X + 200, ORIGIN_Y, 100)]];
    const preview = await previewZip(
      await buildAcordaZip(shapes, [
        { id: "NE_2026_7", name: "", affectation: "611", area: "100.00" },
        { id: "NE_2026_8", name: "Verger", affectation: "abc Inconnu", area: "" },
      ]),
      jwt
    );
    expect(preview.completeness).toBe("partial");
    expect(preview.rows[0]).toMatchObject({ name: "Schlag 1", usage: 611, usageName: null, parseErrors: [] });
    expect(preview.rows[1]).toMatchObject({
      name: "Verger",
      usage: 613,
      // without a size in the file it is computed from the polygon
      size: 10000,
      parseErrors: [{ code: "invalid_usage_code", value: "abc" }],
    });
  });

  it("rejects a dbf whose record count does not match the shapes", async () => {
    const { jwt } = await createUserWithFarm();
    const res = await uploadZip(
      await buildZip({ "plots.shp": buildPolygonShp(sampleShapes()), "plots.dbf": buildUnknownDbf(3) }),
      jwt
    );
    expect(res.status).toBe(400);
  });
});
