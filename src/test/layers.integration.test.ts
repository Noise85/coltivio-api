import { describe, it, expect, beforeEach } from "@jest/globals";

import { cleanDb, getAdminSql, request } from "./helpers";
import { createUserWithFarm } from "./test-utils";
import { MAX_PLOT_ROWS } from "../layer/federal-farm-plots";

// Lays out small plots on a grid starting at (8, 47): 100 per row, 0.0005 degrees apart.
async function seedPlotGrid(count: number) {
  const sql = getAdminSql();
  await sql`
    INSERT INTO federal_farm_plots (id, farm_id, local_id, usage, size, cut_date, canton, geometry)
    SELECT g, 'TEST' || g, NULL, 1, 100, NULL, 'ZH',
      ST_Multi(ST_MakeEnvelope(
        8 + (g % 100) * 0.0005, 47 + (g / 100) * 0.0005,
        8 + (g % 100) * 0.0005 + 0.0004, 47 + (g / 100) * 0.0005 + 0.0004, 4326))
    FROM generate_series(0, ${count - 1}) g
  `;
}

async function getCount(path: string, jwt: string) {
  const res = await request("GET", path, undefined, jwt);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { data: { count: number } };
  return body.data.count;
}

describe("Federal plot layer limits", () => {
  // Truncating after the 10k-row seed can take longer than jest's default hook timeout
  beforeEach(cleanDb, 30_000);

  it("serves a viewport-sized bbox and caps the rows", async () => {
    const { jwt } = await createUserWithFarm();
    await seedPlotGrid(MAX_PLOT_ROWS + 1);

    // 20 columns and 20 rows of the grid, with the edges between plots
    expect(await getCount("/v1/layers/plots/bbox?xmin=7.99&ymin=46.99&xmax=8.0097&ymax=47.0097", jwt)).toBe(400);
    expect(await getCount("/v1/layers/plots/bbox?xmin=8&ymin=47&xmax=8.1&ymax=47.1", jwt)).toBe(MAX_PLOT_ROWS);
  });

  it("rejects bboxes that are too large, inverted or not numeric", async () => {
    const { jwt } = await createUserWithFarm();
    for (const query of [
      "xmin=-180&ymin=-90&xmax=180&ymax=90",
      "xmin=8&ymin=47&xmax=8.2&ymax=47.05",
      "xmin=8&ymin=47&xmax=8.05&ymax=47.2",
      "xmin=8.1&ymin=47&xmax=8&ymax=47.1",
      "xmin=abc&ymin=47&xmax=8.1&ymax=47.1",
    ]) {
      const res = await request("GET", `/v1/layers/plots/bbox?${query}`, undefined, jwt);
      expect(res.status).toBe(400);
    }
  });

  it("serves a radius search and caps the radius", async () => {
    const { jwt } = await createUserWithFarm();
    await seedPlotGrid(400);

    // 1 km reaches 18 columns of the 4-row grid, nothing else is near (9, 48)
    expect(await getCount("/v1/layers/plots/radius?longitude=8&latitude=47&radiusInKm=1", jwt)).toBe(73);
    expect(await getCount("/v1/layers/plots/radius?longitude=9&latitude=48&radiusInKm=1", jwt)).toBe(0);

    for (const query of [
      "longitude=8&latitude=47&radiusInKm=100000",
      "longitude=8&latitude=47&radiusInKm=6",
      "longitude=8&latitude=47&radiusInKm=0",
      "longitude=200&latitude=47&radiusInKm=1",
    ]) {
      const res = await request("GET", `/v1/layers/plots/radius?${query}`, undefined, jwt);
      expect(res.status).toBe(400);
    }
  });

  it("caps the federal farm id search", async () => {
    const { jwt } = await createUserWithFarm();
    await seedPlotGrid(5);

    expect(
      await getCount("/v1/layers/federalFarmIds?query=TEST&longitude=8&latitude=47&radiusInKm=3&limit=20", jwt)
    ).toBe(5);

    for (const query of [
      "query=TEST&longitude=8&latitude=47&radiusInKm=3&limit=1000",
      "query=TEST&longitude=8&latitude=47&radiusInKm=50&limit=20",
    ]) {
      const res = await request("GET", `/v1/layers/federalFarmIds?${query}`, undefined, jwt);
      expect(res.status).toBe(400);
    }
  });

  it("caps the buffer around a farm", async () => {
    const { jwt } = await createUserWithFarm();
    await seedPlotGrid(5);

    expect(await getCount("/v1/layers/plots/farms/TEST0/bbox?buffer=1", jwt)).toBe(5);
    const res = await request("GET", "/v1/layers/plots/farms/TEST0/bbox?buffer=50", undefined, jwt);
    expect(res.status).toBe(400);
  });
});
