import { describe, it, expect, beforeEach } from "@jest/globals";
import { eq, sql } from "drizzle-orm";

import { cleanDb, getAdminDb, request } from "./helpers";
import * as schema from "../db/schema";
import { createUserWithFarm, createPlot, TEST_GEOMETRY } from "./test-utils";

// ---------------------------------------------------------------------------
// Plots CRUD
// ---------------------------------------------------------------------------
describe("Plots CRUD", () => {
  beforeEach(cleanDb);

  it("creates a plot and retrieves it by id", async () => {
    const { jwt, farmId } = await createUserWithFarm();
    const plot = await createPlot(jwt, { name: "Field A", size: 5000 });

    expect(plot.name).toBe("Field A");
    expect(plot.size).toBe(5000);
    expect(plot.farmId).toBe(farmId);

    // Verify DB
    const db = getAdminDb();
    const dbPlot = await db.query.plots.findFirst({
      where: { id: plot.id },
    });
    expect(dbPlot!.name).toBe("Field A");
    expect(dbPlot!.size).toBe(5000);
    expect(dbPlot!.farmId).toBe(farmId);

    // GET by id
    const getRes = await request("GET", `/v1/plots/byId/${plot.id}`, undefined, jwt);
    expect(getRes.status).toBe(200);
    const getBody = (await getRes.json()) as { data: { id: string } };
    expect(getBody.data.id).toBe(plot.id);
  });

  it("lists plots for farm", async () => {
    const { jwt } = await createUserWithFarm();
    await createPlot(jwt, { name: "P1" });
    await createPlot(jwt, { name: "P2" });

    const res = await request("GET", "/v1/plots", undefined, jwt);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { count: number } };
    expect(body.data.count).toBe(2);
  });

  it("updates a plot", async () => {
    const { jwt } = await createUserWithFarm();
    const plot = await createPlot(jwt, { name: "OldName", size: 5000 });

    const res = await request(
      "PATCH",
      `/v1/plots/byId/${plot.id}`,
      { name: "NewName", size: 8000, additionalNotes: "Wet corner" },
      jwt
    );
    expect(res.status).toBe(200);

    // Verify DB
    const db = getAdminDb();
    const dbPlot = await db.query.plots.findFirst({
      where: { id: plot.id },
    });
    expect(dbPlot!.name).toBe("NewName");
    expect(dbPlot!.size).toBe(8000);
    expect(dbPlot!.additionalNotes).toBe("Wet corner");
  });

  it("archives a plot: hidden from the list, not clipped by new overlapping plots, and can be unarchived", async () => {
    const { jwt } = await createUserWithFarm();
    const archivedPlot = await createPlot(jwt, { name: "Old", size: 5000 });

    const archiveRes = await request("PATCH", `/v1/plots/byId/${archivedPlot.id}`, { archived: true }, jwt);
    expect(archiveRes.status).toBe(200);
    const archived = ((await archiveRes.json()) as { data: { archivedAt: string | null } }).data;
    expect(archived.archivedAt).not.toBeNull();

    // Same geometry as the archived plot: would clip it to nothing if it weren't archived
    await createPlot(jwt, { name: "New", size: 5000 });

    const listRes = await request("GET", "/v1/plots", undefined, jwt);
    const list = ((await listRes.json()) as { data: { result: { name: string }[] } }).data.result;
    expect(list.map((plot) => plot.name)).toEqual(["New"]);

    const listAllRes = await request("GET", "/v1/plots?includeArchived=true", undefined, jwt);
    const listAll = ((await listAllRes.json()) as { data: { result: { name: string }[] } }).data.result;
    expect(listAll.map((plot) => plot.name)).toEqual(["New", "Old"]);

    const db = getAdminDb();
    const dbArchivedPlot = await db.query.plots.findFirst({ where: { id: archivedPlot.id } });
    expect(dbArchivedPlot!.size).toBe(5000);

    const unarchiveRes = await request("PATCH", `/v1/plots/byId/${archivedPlot.id}`, { archived: false }, jwt);
    const unarchived = ((await unarchiveRes.json()) as { data: { archivedAt: string | null } }).data;
    expect(unarchived.archivedAt).toBeNull();
  });

  it("deletes a plot", async () => {
    const { jwt } = await createUserWithFarm();
    const plot = await createPlot(jwt);

    const res = await request("DELETE", `/v1/plots/byId/${plot.id}`, undefined, jwt);
    expect(res.status).toBe(200);

    // Verify DB
    const db = getAdminDb();
    const dbPlot = await db.query.plots.findFirst({
      where: { id: plot.id },
    });
    expect(dbPlot).toBeUndefined();
  });

  it("splits a plot with keep_reference strategy", async () => {
    const { jwt } = await createUserWithFarm();
    const plot = await createPlot(jwt, { name: "Original", size: 10000 });

    const subGeometry1 = {
      type: "MultiPolygon" as const,
      coordinates: [
        [
          [
            [8.0, 47.0],
            [8.05, 47.0],
            [8.05, 47.1],
            [8.0, 47.1],
            [8.0, 47.0],
          ],
        ],
      ],
    };
    const subGeometry2 = {
      type: "MultiPolygon" as const,
      coordinates: [
        [
          [
            [8.05, 47.0],
            [8.1, 47.0],
            [8.1, 47.1],
            [8.05, 47.1],
            [8.05, 47.0],
          ],
        ],
      ],
    };

    const res = await request(
      "POST",
      `/v1/plots/byId/${plot.id}/split`,
      {
        strategy: "keep_reference",
        subPlots: [
          { geometry: subGeometry1, name: "Split A", size: 5000 },
          { geometry: subGeometry2, name: "Split B", size: 5000 },
        ],
      },
      jwt
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { result: Array<{ id: string; name: string; size: number }> };
    };
    expect(body.data.result.length).toBeGreaterThanOrEqual(2);

    // Verify DB: new plots exist
    const db = getAdminDb();
    const names = body.data.result.map((p) => p.name);
    expect(names).toContain("Split A");
    expect(names).toContain("Split B");
  });

  it("merges plots with keep_reference strategy", async () => {
    const { jwt } = await createUserWithFarm();
    const p1 = await createPlot(jwt, { name: "M1", size: 3000 });
    const p2 = await createPlot(jwt, { name: "M2", size: 4000 });

    const res = await request(
      "POST",
      "/v1/plots/merge",
      {
        strategy: "keep_reference",
        plotIds: [p1.id, p2.id],
        name: "Merged Field",
      },
      jwt
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { id: string; name: string };
    };
    expect(body.data.name).toBe("Merged Field");

    // Verify DB
    const db = getAdminDb();
    const dbMerged = await db.query.plots.findFirst({
      where: { id: body.data.id },
    });
    expect(dbMerged!.name).toBe("Merged Field");
  });

  it("archives the kept original plot on split when archiveReference is set", async () => {
    const { jwt } = await createUserWithFarm();
    const plot = await createPlot(jwt, { name: "Original" });
    const half = (west: number) => ({
      type: "MultiPolygon" as const,
      coordinates: [
        [
          [
            [west, 47.0],
            [west + 0.05, 47.0],
            [west + 0.05, 47.1],
            [west, 47.1],
            [west, 47.0],
          ],
        ],
      ],
    });

    const res = await request(
      "POST",
      `/v1/plots/byId/${plot.id}/split`,
      {
        strategy: "keep_reference",
        archiveReference: true,
        subPlots: [
          { geometry: half(8.0), name: "Split A", size: 5000 },
          { geometry: half(8.05), name: "Split B", size: 5000 },
        ],
      },
      jwt
    );
    expect(res.status).toBe(200);

    const db = getAdminDb();
    const original = await db.query.plots.findFirst({ where: { id: plot.id } });
    expect(original!.archivedAt).not.toBeNull();
    expect(original!.size).toBe(0);
    const subPlots = await db.query.plots.findMany({ where: { name: { in: ["Split A", "Split B"] } } });
    expect(subPlots.map((subPlot) => subPlot.archivedAt)).toEqual([null, null]);
  });

  it("archives the kept source plots on merge only when archiveReference is set", async () => {
    const { jwt } = await createUserWithFarm();
    const archivedSource1 = await createPlot(jwt, { name: "A1" });
    const archivedSource2 = await createPlot(jwt, { name: "A2" });

    const res = await request(
      "POST",
      "/v1/plots/merge",
      {
        strategy: "keep_reference",
        archiveReference: true,
        plotIds: [archivedSource1.id, archivedSource2.id],
        name: "Merged",
      },
      jwt
    );
    expect(res.status).toBe(200);
    const merged = ((await res.json()) as { data: { id: string } }).data;

    const db = getAdminDb();
    const sources = await db.query.plots.findMany({
      where: { id: { in: [archivedSource1.id, archivedSource2.id] } },
    });
    expect(sources.every((source) => source.archivedAt !== null)).toBe(true);
    const mergedPlot = await db.query.plots.findFirst({ where: { id: merged.id } });
    expect(mergedPlot!.archivedAt).toBeNull();
    // archiveReference is not stored as plot data
    expect(mergedPlot!.name).toBe("Merged");

    // without the option the source plots stay active
    const activeSource1 = await createPlot(jwt, { name: "B1" });
    const activeSource2 = await createPlot(jwt, { name: "B2" });
    const res2 = await request(
      "POST",
      "/v1/plots/merge",
      { strategy: "keep_reference", plotIds: [activeSource1.id, activeSource2.id], name: "Merged 2" },
      jwt
    );
    expect(res2.status).toBe(200);
    const activeSources = await db.query.plots.findMany({
      where: { id: { in: [activeSource1.id, activeSource2.id] } },
    });
    expect(activeSources.every((source) => source.archivedAt === null)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Invalid geometries
// ---------------------------------------------------------------------------
describe("Plot geometry validation", () => {
  beforeEach(cleanDb);

  // Edges cross in the middle of the square
  const BOWTIE_RING = [
    [8.0, 47.0],
    [8.1, 47.1],
    [8.1, 47.0],
    [8.0, 47.1],
    [8.0, 47.0],
  ];

  async function isStoredGeometryValid(plotId: string) {
    const db = getAdminDb();
    const [row] = await db
      .select({ isValid: sql<boolean>`ST_IsValid(${schema.plots.geometry})` })
      .from(schema.plots)
      .where(eq(schema.plots.id, plotId));
    return row.isValid;
  }

  it("repairs a self-intersecting plot on create", async () => {
    const { jwt } = await createUserWithFarm();
    const plot = await createPlot(jwt, { geometry: { type: "MultiPolygon", coordinates: [[BOWTIE_RING]] } });

    expect(await isStoredGeometryValid(plot.id)).toBe(true);
  });

  it("repairs a self-intersecting plot on update", async () => {
    const { jwt } = await createUserWithFarm();
    const plot = await createPlot(jwt);

    const res = await request(
      "PATCH",
      `/v1/plots/byId/${plot.id}`,
      { geometry: { type: "MultiPolygon", coordinates: [[BOWTIE_RING]] } },
      jwt
    );
    expect(res.status).toBe(200);
    expect(await isStoredGeometryValid(plot.id)).toBe(true);
  });

  it("cuts a new plot out of an overlapping plot that is stored invalid", async () => {
    const { jwt } = await createUserWithFarm();
    const invalidPlot = await createPlot(jwt, { name: "Invalid" });
    const db = getAdminDb();
    await db.execute(sql`
      update ${schema.plots}
      set geometry = ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify({ type: "MultiPolygon", coordinates: [[BOWTIE_RING]] })}), 4326)
      where id = ${invalidPlot.id}
    `);
    expect(await isStoredGeometryValid(invalidPlot.id)).toBe(false);

    const newPlot = await createPlot(jwt, {
      name: "New",
      geometry: {
        type: "MultiPolygon",
        coordinates: [
          [
            [
              [8.05, 47.0],
              [8.15, 47.0],
              [8.15, 47.1],
              [8.05, 47.1],
              [8.05, 47.0],
            ],
          ],
        ],
      },
    });

    expect(await isStoredGeometryValid(newPlot.id)).toBe(true);
    expect(await isStoredGeometryValid(invalidPlot.id)).toBe(true);
  });

  it("merges adjacent plots into one valid polygon", async () => {
    const { jwt } = await createUserWithFarm();
    const square = (west: number) => ({
      type: "MultiPolygon",
      coordinates: [
        [
          [
            [west, 47.0],
            [west + 0.1, 47.0],
            [west + 0.1, 47.1],
            [west, 47.1],
            [west, 47.0],
          ],
        ],
      ],
    });
    const left = await createPlot(jwt, { name: "Left", geometry: square(8.0) });
    const right = await createPlot(jwt, { name: "Right", geometry: square(8.1) });
    const separate = await createPlot(jwt, { name: "Separate", geometry: square(8.3) });

    const res = await request(
      "POST",
      "/v1/plots/merge",
      { strategy: "delete_and_migrate", plotIds: [left.id, right.id, separate.id], name: "Merged" },
      jwt
    );
    expect(res.status).toBe(200);
    const merged = ((await res.json()) as { data: { id: string; size: number } }).data;

    expect(await isStoredGeometryValid(merged.id)).toBe(true);
    const db = getAdminDb();
    const [row] = await db
      .select({ parts: sql<number>`ST_NumGeometries(${schema.plots.geometry})` })
      .from(schema.plots)
      .where(eq(schema.plots.id, merged.id));
    // the adjacent plots became one part, the separate plot stays its own part
    expect(row.parts).toBe(2);
    expect(merged.size).toBeGreaterThan(0);
  });

  it("closes small gaps between merged plots", async () => {
    const { jwt } = await createUserWithFarm();
    // ~20 cm gap along the shared border, as with plots digitised separately
    const gap = 0.0000025;
    const rectangle = (west: number, east: number) => ({
      type: "MultiPolygon",
      coordinates: [
        [
          [
            [west, 47.0],
            [east, 47.0],
            [east, 47.001],
            [west, 47.001],
            [west, 47.0],
          ],
        ],
      ],
    });
    const left = await createPlot(jwt, { name: "Left", geometry: rectangle(8.0, 8.001) });
    const right = await createPlot(jwt, { name: "Right", geometry: rectangle(8.001 + gap, 8.002) });

    const res = await request(
      "POST",
      "/v1/plots/merge",
      { strategy: "delete_and_migrate", plotIds: [left.id, right.id], name: "Merged" },
      jwt
    );
    expect(res.status).toBe(200);
    const merged = ((await res.json()) as { data: { id: string } }).data;

    const db = getAdminDb();
    const [row] = await db
      .select({
        parts: sql<number>`ST_NumGeometries(${schema.plots.geometry})`,
        holes: sql<number>`ST_NumInteriorRings(ST_GeometryN(${schema.plots.geometry}, 1))`,
        // the outline is kept: area of the merged plot vs. the bounding box of both plots
        areaRatio: sql<number>`ST_Area(${schema.plots.geometry}) / ST_Area(ST_Envelope(${schema.plots.geometry}))`,
      })
      .from(schema.plots)
      .where(eq(schema.plots.id, merged.id));
    expect(row.parts).toBe(1);
    expect(row.holes).toBe(0);
    expect(row.areaRatio).toBeCloseTo(1, 3);
  });

  it("keeps a real gap between merged plots, like a ditch", async () => {
    const { jwt } = await createUserWithFarm();
    // ~1 m gap along the shared border
    const gap = 0.0000132;
    const rectangle = (west: number, east: number) => ({
      type: "MultiPolygon",
      coordinates: [
        [
          [
            [west, 47.0],
            [east, 47.0],
            [east, 47.001],
            [west, 47.001],
            [west, 47.0],
          ],
        ],
      ],
    });
    const left = await createPlot(jwt, { name: "Left", geometry: rectangle(8.0, 8.001) });
    const right = await createPlot(jwt, { name: "Right", geometry: rectangle(8.001 + gap, 8.002) });

    const res = await request(
      "POST",
      "/v1/plots/merge",
      { strategy: "delete_and_migrate", plotIds: [left.id, right.id], name: "Merged" },
      jwt
    );
    expect(res.status).toBe(200);
    const merged = ((await res.json()) as { data: { id: string } }).data;

    const db = getAdminDb();
    const [row] = await db
      .select({ parts: sql<number>`ST_NumGeometries(${schema.plots.geometry})` })
      .from(schema.plots)
      .where(eq(schema.plots.id, merged.id));
    expect(row.parts).toBe(2);
  });

  it.each(["delete_and_migrate", "keep_reference"])(
    "keeps the corners of merged plots sharp and does not overlap neighbouring plots (%s)",
    async (strategy) => {
      const { jwt } = await createUserWithFarm();
      // ~20 cm gap between the two plots that are merged into an L shape
      const gap = 0.0000025;
      const rectangle = (west: number, south: number, east: number, north: number) => ({
        type: "MultiPolygon",
        coordinates: [
          [
            [
              [west, south],
              [east, south],
              [east, north],
              [west, north],
              [west, south],
            ],
          ],
        ],
      });
      const left = await createPlot(jwt, { name: "Left", geometry: rectangle(8.0, 47.0, 8.001, 47.002) });
      const bottom = await createPlot(jwt, { name: "Bottom", geometry: rectangle(8.001 + gap, 47.0, 8.002, 47.001) });
      // fills the inner corner of the L, not merged
      const neighbour = await createPlot(jwt, {
        name: "Neighbour",
        geometry: rectangle(8.001 + gap, 47.001, 8.002, 47.002),
      });

      const res = await request(
        "POST",
        "/v1/plots/merge",
        { strategy, plotIds: [left.id, bottom.id], name: "Merged" },
        jwt
      );
      expect(res.status).toBe(200);
      const merged = ((await res.json()) as { data: { id: string } }).data;

      const db = getAdminDb();
      const [row] = await db.execute<{ points: number; overlap: number; neighbourValid: boolean }>(sql`
      SELECT
        ST_NPoints(merged.geometry) AS points,
        ST_Area(ST_Transform(ST_Intersection(merged.geometry, neighbour.geometry), 2056)) AS overlap,
        ST_IsValid(neighbour.geometry) AS "neighbourValid"
      FROM ${schema.plots} merged, ${schema.plots} neighbour
      WHERE merged.id = ${merged.id} AND neighbour.id = ${neighbour.id}
    `);
      // an L shape has 6 corners plus the closing point, and closing the gap leaves two points on the bottom edge;
      // round joins would add an arc of ~8 points at the inner corner
      expect(row.points).toBeLessThanOrEqual(9);
      expect(row.overlap).toBeLessThan(0.001);
      expect(row.neighbourValid).toBe(true);
    }
  );

  it("does not cut neighbouring plots with the new geometry of an archived plot", async () => {
    const { jwt } = await createUserWithFarm();
    const neighbour = await createPlot(jwt, { name: "Neighbour", size: 1234 });
    const archivedPlot = await createPlot(jwt, {
      name: "Archived",
      geometry: {
        type: "MultiPolygon",
        coordinates: [
          [
            [
              [8.2, 47.0],
              [8.3, 47.0],
              [8.3, 47.1],
              [8.2, 47.1],
              [8.2, 47.0],
            ],
          ],
        ],
      },
    });

    const res = await request(
      "PATCH",
      `/v1/plots/byId/${archivedPlot.id}`,
      { archived: true, geometry: TEST_GEOMETRY },
      jwt
    );
    expect(res.status).toBe(200);

    const db = getAdminDb();
    const [row] = await db
      .select({
        size: schema.plots.size,
        unchanged: sql<boolean>`ST_Equals(${schema.plots.geometry}, ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(TEST_GEOMETRY)}), 4326))`,
      })
      .from(schema.plots)
      .where(eq(schema.plots.id, neighbour.id));
    expect(row.size).toBe(1234);
    expect(row.unchanged).toBe(true);
  });

  it("rejects a split with a sub-plot without area", async () => {
    const { jwt } = await createUserWithFarm();
    const plot = await createPlot(jwt, { name: "Original" });
    const collinearGeometry = {
      type: "MultiPolygon",
      coordinates: [
        [
          [
            [8.0, 47.0],
            [8.05, 47.0],
            [8.1, 47.0],
            [8.0, 47.0],
          ],
        ],
      ],
    };

    const res = await request(
      "POST",
      `/v1/plots/byId/${plot.id}/split`,
      {
        strategy: "keep_reference",
        subPlots: [
          { geometry: TEST_GEOMETRY, name: "Split A", size: 5000 },
          { geometry: collinearGeometry, name: "Split B", size: 0 },
        ],
      },
      jwt
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("invalid_geometry");

    const db = getAdminDb();
    expect(await db.query.plots.findMany()).toHaveLength(1);
  });

  it("returns 404 when updating the geometry of a plot that does not exist", async () => {
    const { jwt } = await createUserWithFarm();

    const res = await request(
      "PATCH",
      "/v1/plots/byId/00000000-0000-0000-0000-000000000000",
      { geometry: TEST_GEOMETRY },
      jwt
    );
    expect(res.status).toBe(404);
  });

  it("leaves a plot that only shares a border with a new plot unchanged", async () => {
    const { jwt } = await createUserWithFarm();
    // Size differs from the geometry's area: it would be replaced if the neighbour were rewritten
    const neighbour = await createPlot(jwt, { name: "Neighbour", size: 1234 });

    await createPlot(jwt, {
      name: "New",
      geometry: {
        type: "MultiPolygon",
        coordinates: [
          [
            [
              [8.1, 47.0],
              [8.2, 47.0],
              [8.2, 47.1],
              [8.1, 47.1],
              [8.1, 47.0],
            ],
          ],
        ],
      },
    });

    const db = getAdminDb();
    const [row] = await db
      .select({
        size: schema.plots.size,
        unchanged: sql<boolean>`ST_Equals(${schema.plots.geometry}, ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(TEST_GEOMETRY)}), 4326))`,
      })
      .from(schema.plots)
      .where(eq(schema.plots.id, neighbour.id));
    expect(row.size).toBe(1234);
    expect(row.unchanged).toBe(true);
  });

  it("removes repeated points, which clients report as crossing edges", async () => {
    const { jwt } = await createUserWithFarm();
    // same point three times in a row, the last one a fraction of a millimetre off (as left by a cut)
    const plot = await createPlot(jwt, {
      geometry: {
        type: "MultiPolygon",
        coordinates: [
          [
            [
              [8.0, 47.0],
              [8.001, 47.0],
              [8.001, 47.001],
              [8.001, 47.001],
              [8.0010000001, 47.0010000001],
              [8.0, 47.001],
              [8.0, 47.0],
            ],
          ],
        ],
      },
    });

    const res = await request("GET", `/v1/plots/byId/${plot.id}`, undefined, jwt);
    const body = (await res.json()) as { data: { geometry: { coordinates: number[][][][] } } };
    const ring = body.data.geometry.coordinates[0][0];
    expect(ring).toHaveLength(5);
    const hasConsecutiveDuplicate = ring.some(
      (point, index) => index > 0 && point[0] === ring[index - 1][0] && point[1] === ring[index - 1][1]
    );
    expect(hasConsecutiveDuplicate).toBe(false);
  });

  it("rejects a geometry without area with an error code", async () => {
    const { jwt } = await createUserWithFarm();
    const collinearRing = [
      [8.0, 47.0],
      [8.1, 47.0],
      [8.2, 47.0],
      [8.0, 47.0],
    ];

    const res = await request(
      "POST",
      "/v1/plots",
      { name: "Line", size: 0, geometry: { type: "MultiPolygon", coordinates: [[collinearRing]] } },
      jwt
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; code?: string };
    expect(body.code).toBe("invalid_geometry");

    const db = getAdminDb();
    expect(await db.query.plots.findMany()).toHaveLength(0);
  });
});
