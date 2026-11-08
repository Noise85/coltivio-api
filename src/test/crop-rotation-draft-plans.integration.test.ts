import { describe, it, expect, beforeEach } from "@jest/globals";
import { cleanDb, getAdminDb, request } from "./helpers";
import { createUserWithFarm, createPlot, createCrop, createCropRotation } from "./test-utils";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type ApiRotation = {
  id: string;
  cropId: string;
  fromDate: string;
  toDate: string;
  recurrence: { id: string; interval: number; until: string | null } | null;
  crop: { id: string; name: string };
};

type ApiPlot = {
  id: string;
  plotId: string;
  rotations: ApiRotation[];
};

type ApiPlan = {
  id: string;
  farmId: string;
  name: string;
  createdAt: string;
  updatedAt: string;
};

type ApiPlanWithPlots = ApiPlan & { plots: ApiPlot[] };

async function createDraftPlan(jwt: string, name: string, plots: object[] = []): Promise<ApiPlanWithPlots> {
  const res = await request("POST", "/v1/cropRotations/draftPlans", { name, plots }, jwt);
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: ApiPlanWithPlots }).data;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Draft Crop Rotation Plans", () => {
  beforeEach(cleanDb);

  it("creates a draft plan with no plots", async () => {
    const { jwt, farmId } = await createUserWithFarm({}, "test@test.com", { withActiveMembership: true });

    const plan = await createDraftPlan(jwt, "Season 2026");

    expect(plan.name).toBe("Season 2026");
    expect(plan.farmId).toBe(farmId);
    expect(plan.plots).toHaveLength(0);

    const db = getAdminDb();
    const dbPlan = await db.query.cropRotationDraftPlans.findFirst({ where: { id: plan.id } });
    expect(dbPlan!.name).toBe("Season 2026");
  });

  it("creates a draft plan with plots and rotations", async () => {
    const { jwt } = await createUserWithFarm({}, "test@test.com", { withActiveMembership: true });
    const plot = await createPlot(jwt, { name: "North Field" });
    const crop = await createCrop(jwt, { name: "Winter Wheat" });

    const plan = await createDraftPlan(jwt, "Draft A", [
      {
        plotId: plot.id,
        rotations: [{ cropId: crop.id, fromDate: "2026-03-01", toDate: "2026-10-31" }],
      },
    ]);

    expect(plan.plots).toHaveLength(1);
    expect(plan.plots[0].plotId).toBe(plot.id);
    expect(plan.plots[0].rotations).toHaveLength(1);
    expect(plan.plots[0].rotations[0].cropId).toBe(crop.id);
    expect(plan.plots[0].rotations[0].crop.name).toBe("Winter Wheat");
    expect(plan.plots[0].rotations[0].recurrence).toBeNull();
  });

  it("creates a draft plan plot with a rotation with recurrence", async () => {
    const { jwt } = await createUserWithFarm({}, "test@test.com", { withActiveMembership: true });
    const plot = await createPlot(jwt);
    const crop = await createCrop(jwt);

    const plan = await createDraftPlan(jwt, "Recurring Plan", [
      {
        plotId: plot.id,
        rotations: [
          {
            cropId: crop.id,
            fromDate: "2026-03-01",
            toDate: "2026-10-31",
            recurrenceInterval: 2,
            recurrenceUntil: "2030-12-31",
          },
        ],
      },
    ]);

    expect(plan.plots[0].rotations[0].recurrence).not.toBeNull();
    expect(plan.plots[0].rotations[0].recurrence!.interval).toBe(2);
    expect(plan.plots[0].rotations[0].recurrence!.id).toBeDefined();
  });

  it("creates a draft plan with a plot that has no rotations (in-scope but empty)", async () => {
    const { jwt } = await createUserWithFarm({}, "test@test.com", { withActiveMembership: true });
    const plot = await createPlot(jwt);

    const plan = await createDraftPlan(jwt, "Empty Plot Plan", [{ plotId: plot.id, rotations: [] }]);

    expect(plan.plots).toHaveLength(1);
    expect(plan.plots[0].plotId).toBe(plot.id);
    expect(plan.plots[0].rotations).toHaveLength(0);
  });

  it("lists draft plans without plots", async () => {
    const { jwt } = await createUserWithFarm({}, "test@test.com", { withActiveMembership: true });
    await createDraftPlan(jwt, "Plan 1");
    await createDraftPlan(jwt, "Plan 2");

    const res = await request("GET", "/v1/cropRotations/draftPlans", undefined, jwt);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { result: ApiPlan[]; count: number } };
    expect(body.data.count).toBe(2);
    expect((body.data.result[0] as { plots?: unknown }).plots).toBeUndefined();
  });

  it("gets a draft plan by id with plots", async () => {
    const { jwt } = await createUserWithFarm({}, "test@test.com", { withActiveMembership: true });
    const plot = await createPlot(jwt);
    const crop = await createCrop(jwt);
    const created = await createDraftPlan(jwt, "Detailed Plan", [
      { plotId: plot.id, rotations: [{ cropId: crop.id, fromDate: "2026-01-01", toDate: "2026-06-30" }] },
    ]);

    const res = await request("GET", `/v1/cropRotations/draftPlans/byId/${created.id}`, undefined, jwt);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: ApiPlanWithPlots };
    expect(body.data.id).toBe(created.id);
    expect(body.data.plots).toHaveLength(1);
    expect(body.data.plots[0].rotations[0].crop.id).toBe(crop.id);
  });

  it("returns 404 for unknown draft plan id", async () => {
    const { jwt } = await createUserWithFarm({}, "test@test.com", { withActiveMembership: true });
    const res = await request(
      "GET",
      "/v1/cropRotations/draftPlans/byId/00000000-0000-0000-0000-000000000000",
      undefined,
      jwt
    );
    expect(res.status).toBe(404);
  });

  it("updates the plan name only", async () => {
    const { jwt } = await createUserWithFarm({}, "test@test.com", { withActiveMembership: true });
    const plan = await createDraftPlan(jwt, "Original Name");

    const res = await request("PATCH", `/v1/cropRotations/draftPlans/byId/${plan.id}`, { name: "New Name" }, jwt);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: ApiPlanWithPlots };
    expect(body.data.name).toBe("New Name");
  });

  it("replaces all plots when updating with plots", async () => {
    const { jwt } = await createUserWithFarm({}, "test@test.com", { withActiveMembership: true });
    const plot1 = await createPlot(jwt, { name: "Plot 1" });
    const plot2 = await createPlot(jwt, { name: "Plot 2" });
    const crop = await createCrop(jwt);

    const plan = await createDraftPlan(jwt, "Plan", [
      { plotId: plot1.id, rotations: [{ cropId: crop.id, fromDate: "2026-01-01", toDate: "2026-06-30" }] },
    ]);
    expect(plan.plots).toHaveLength(1);

    // Replace with two plot entries on plot2
    const res = await request(
      "PATCH",
      `/v1/cropRotations/draftPlans/byId/${plan.id}`,
      {
        plots: [
          {
            plotId: plot2.id,
            rotations: [
              { cropId: crop.id, fromDate: "2026-01-01", toDate: "2026-06-30" },
              { cropId: crop.id, fromDate: "2026-07-01", toDate: "2026-12-31" },
            ],
          },
        ],
      },
      jwt
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: ApiPlanWithPlots };
    expect(body.data.plots).toHaveLength(1);
    expect(body.data.plots[0].plotId).toBe(plot2.id);
    expect(body.data.plots[0].rotations).toHaveLength(2);

    const db = getAdminDb();
    const dbEntries = await db.query.cropRotationDraftPlanEntries.findMany({
      where: { draftPlanPlotId: body.data.plots[0].id },
    });
    expect(dbEntries).toHaveLength(2);
  });

  it("deletes a draft plan and cascades plots and entries", async () => {
    const { jwt } = await createUserWithFarm({}, "test@test.com", { withActiveMembership: true });
    const plot = await createPlot(jwt);
    const crop = await createCrop(jwt);
    const plan = await createDraftPlan(jwt, "To Delete", [
      { plotId: plot.id, rotations: [{ cropId: crop.id, fromDate: "2026-01-01", toDate: "2026-12-31" }] },
    ]);

    const del = await request("DELETE", `/v1/cropRotations/draftPlans/byId/${plan.id}`, undefined, jwt);
    expect(del.status).toBe(200);

    const db = getAdminDb();
    const dbPlan = await db.query.cropRotationDraftPlans.findFirst({ where: { id: plan.id } });
    expect(dbPlan).toBeUndefined();
    const dbPlots = await db.query.cropRotationDraftPlanPlots.findMany({ where: { draftPlanId: plan.id } });
    expect(dbPlots).toHaveLength(0);
  });

  it("applies a draft plan and creates real crop rotations", async () => {
    const { jwt } = await createUserWithFarm({}, "test@test.com", { withActiveMembership: true });
    const plot1 = await createPlot(jwt, { name: "P1" });
    const plot2 = await createPlot(jwt, { name: "P2" });
    const crop = await createCrop(jwt, { name: "Rye" });

    const plan = await createDraftPlan(jwt, "Apply Me", [
      { plotId: plot1.id, rotations: [{ cropId: crop.id, fromDate: "2026-03-01", toDate: "2026-10-31" }] },
      { plotId: plot2.id, rotations: [{ cropId: crop.id, fromDate: "2026-04-01", toDate: "2026-09-30" }] },
    ]);

    const res = await request("POST", `/v1/cropRotations/draftPlans/byId/${plan.id}/apply`, undefined, jwt);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { result: unknown[]; count: number } };
    expect(body.data.count).toBe(2);

    const db = getAdminDb();
    const rotations = await db.query.cropRotations.findMany({ where: { cropId: crop.id } });
    expect(rotations).toHaveLength(2);

    // Draft is deleted after apply
    const dbPlan = await db.query.cropRotationDraftPlans.findFirst({ where: { id: plan.id } });
    expect(dbPlan).toBeUndefined();
  });

  it("apply replaces existing rotations for the affected plot", async () => {
    const { jwt } = await createUserWithFarm({}, "test@test.com", { withActiveMembership: true });
    const plot = await createPlot(jwt);
    const crop = await createCrop(jwt);

    await createCropRotation(jwt, plot.id, crop.id, { fromDate: "2026-03-01", toDate: "2026-10-31" });

    // Draft with different dates on the same plot — should replace, not conflict
    const plan = await createDraftPlan(jwt, "Replace Plan", [
      { plotId: plot.id, rotations: [{ cropId: crop.id, fromDate: "2026-05-01", toDate: "2026-12-31" }] },
    ]);

    const res = await request("POST", `/v1/cropRotations/draftPlans/byId/${plan.id}/apply`, undefined, jwt);
    expect(res.status).toBe(200);

    const db = getAdminDb();
    const rotations = await db.query.cropRotations.findMany({ where: { plotId: plot.id } });
    expect(rotations).toHaveLength(1);
    expect(rotations[0].fromDate.toISOString().startsWith("2026-05-01")).toBe(true);
  });

  it("apply with empty rotations for a plot clears that plot's rotations", async () => {
    const { jwt } = await createUserWithFarm({}, "test@test.com", { withActiveMembership: true });
    const plot = await createPlot(jwt);
    const crop = await createCrop(jwt);

    await createCropRotation(jwt, plot.id, crop.id, { fromDate: "2026-03-01", toDate: "2026-10-31" });

    // Draft includes the plot with no rotations — should clear it
    const plan = await createDraftPlan(jwt, "Clear Plan", [{ plotId: plot.id, rotations: [] }]);

    const res = await request("POST", `/v1/cropRotations/draftPlans/byId/${plan.id}/apply`, undefined, jwt);
    expect(res.status).toBe(200);

    const db = getAdminDb();
    const rotations = await db.query.cropRotations.findMany({ where: { plotId: plot.id } });
    expect(rotations).toHaveLength(0);
  });

  it("apply only touches plots included — leaves other plots untouched", async () => {
    const { jwt } = await createUserWithFarm({}, "test@test.com", { withActiveMembership: true });
    const plotA = await createPlot(jwt, { name: "Plot A" });
    const plotB = await createPlot(jwt, { name: "Plot B" });
    const crop = await createCrop(jwt);

    const existingRotation = await createCropRotation(jwt, plotA.id, crop.id, {
      fromDate: "2026-01-01",
      toDate: "2026-06-30",
    });

    // Draft only has entries for plot B — plot A is not included
    const plan = await createDraftPlan(jwt, "Only Plot B", [
      { plotId: plotB.id, rotations: [{ cropId: crop.id, fromDate: "2026-03-01", toDate: "2026-10-31" }] },
    ]);

    const res = await request("POST", `/v1/cropRotations/draftPlans/byId/${plan.id}/apply`, undefined, jwt);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { result: { plotId: string }[]; count: number } };
    expect(body.data.count).toBe(1);
    expect(body.data.result[0].plotId).toBe(plotB.id);

    const db = getAdminDb();
    const plotARotations = await db.query.cropRotations.findMany({ where: { plotId: plotA.id } });
    expect(plotARotations).toHaveLength(1);
    expect(plotARotations[0].id).toBe(existingRotation.id);
  });

  it("does not expose draft plans from another farm", async () => {
    const { jwt: jwt1 } = await createUserWithFarm({}, "farm1@test.com", { withActiveMembership: true });
    const { jwt: jwt2 } = await createUserWithFarm({}, "farm2@test.com", { withActiveMembership: true });

    await createDraftPlan(jwt1, "Farm 1 Plan");

    const res = await request("GET", "/v1/cropRotations/draftPlans", undefined, jwt2);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { count: number } };
    expect(body.data.count).toBe(0);
  });
});
