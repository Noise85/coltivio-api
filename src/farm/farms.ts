import createHttpError from "http-errors";
import { and, count, eq, getTableColumns, isNull, sql } from "drizzle-orm";
import { TFunction } from "i18next";
import {} from "../crop-rotations/crop-rotations";
import { createPlotsWithCrops, PlotWithCropInput } from "../plots/create-plots-with-crops";
import { insertPlotOverlays, isIgnoredUsage, isOverlayUsage, PlotOverlayInput } from "../plots/plot-overlays";
import { AnimalType, computeActiveCropRotations } from "../dashboard/dashboard";
import { RlsDb } from "../db/db";
import * as tables from "../db/schema";
import { MultiPolygon, Point } from "../geo/geojson";
import { User } from "../user/users";

const farmSelectColumns = {
  ...getTableColumns(tables.farms),
  location: sql<Point>`extensions.ST_AsGeoJSON(${tables.farms.location})::json`,
};

export type FarmCreateInput = {
  name: string;
  address: string;
  federalId?: string | null;
  tvdNumber?: string | null;
  location: Point;
};

export interface FarmStats {
  plots: { total: number; totalAreaM2: number };
  animals: { totalLiving: number; byType: { type: AnimalType; count: number }[] };
  cropRotations: {
    active: { cropName: string; category: string; plotCount: number; totalAreaM2: number }[];
  };
}

export function farmsApi(rlsDb: RlsDb, t: TFunction) {
  return {
    async getFarmById(farmId: string) {
      return rlsDb.rls(async (tx) => {
        const [farm] = await tx.select(farmSelectColumns).from(tables.farms).where(eq(tables.farms.id, farmId));
        return farm;
      });
    },
    async getFarmStats(farmId: string): Promise<FarmStats> {
      return rlsDb.rls(async (tx) => {
        const [[plotsAgg], livingAnimalsByType, activeCropRotations] = await Promise.all([
          tx
            .select({
              count: count(),
              totalAreaM2: sql<number>`COALESCE(SUM(${tables.plots.size}), 0)`,
            })
            .from(tables.plots)
            .where(eq(tables.plots.farmId, farmId)),

          tx
            .select({ type: tables.animals.type, count: count() })
            .from(tables.animals)
            .where(and(eq(tables.animals.farmId, farmId), isNull(tables.animals.dateOfDeath)))
            .groupBy(tables.animals.type),

          tx.query.cropRotations.findMany({
            where: { farmId },
            with: {
              crop: { with: { family: true } },
              recurrence: true,
              plot: { columns: { size: true } },
            },
          }),
        ]);

        const totalLivingAnimals = livingAnimalsByType.reduce((sum, row) => sum + row.count, 0);

        return {
          plots: {
            total: plotsAgg?.count ?? 0,
            totalAreaM2: Number(plotsAgg?.totalAreaM2 ?? 0),
          },
          animals: {
            totalLiving: totalLivingAnimals,
            byType: livingAnimalsByType.map((r) => ({ type: r.type, count: r.count })),
          },
          cropRotations: {
            active: computeActiveCropRotations(activeCropRotations),
          },
        };
      });
    },
    async createFarm(userId: string, farm: FarmCreateInput) {
      // we need to bypass rls because farm is not yet created, so the returning statement would fail
      return rlsDb.admin.transaction(async (tx) => {
        const { location, ...rest } = farm;
        const [createdFarm] = await tx
          .insert(tables.farms)
          .values({
            ...rest,
            location: sql`ST_GeomFromGeoJSON(${JSON.stringify(location)})`,
          })
          .returning(farmSelectColumns);

        // assign user to farm as owner
        await tx.insert(tables.farmMembers).values({ farmId: createdFarm.id, userId, role: "owner" });

        if (!farm.federalId) {
          await tx
            .insert(tables.crops)
            .values([
              {
                farmId: createdFarm.id,
                name: t("crops.natural_meadow"),
                category: "grass",
              },
            ])
            .returning();
        }

        if (farm.federalId) {
          // geometry plus usage identifies a plot, the federal table has no stable id. The same area can carry
          // several usages (e.g. 921 and 922 on one orchard), but identical rows are delivered more than once.
          const geometryHash = sql<string>`md5(ST_AsBinary(${tables.federalFarmPlots.geometry}))`;
          const federalFarmPlots = await tx
            .selectDistinctOn([geometryHash, tables.federalFarmPlots.usage], {
              localId: tables.federalFarmPlots.localId,
              usage: tables.federalFarmPlots.usage,
              size: tables.federalFarmPlots.size,
              cuttingDate: tables.federalFarmPlots.cuttingDate,
              geometry: sql<MultiPolygon>`ST_AsGeoJSON(${tables.federalFarmPlots.geometry})::json`,
              geometryHash,
            })
            .from(tables.federalFarmPlots)
            .where(eq(tables.federalFarmPlots.federalFarmId, farm.federalId))
            .orderBy(geometryHash, tables.federalFarmPlots.usage, tables.federalFarmPlots.id);
          // DISTINCT ON dictates the query order, sort by parcel number afterwards (nulls last, as before)
          federalFarmPlots.sort((a, b) => {
            if (a.localId === b.localId) return 0;
            if (a.localId === null) return 1;
            if (b.localId === null) return -1;
            return a.localId < b.localId ? -1 : 1;
          });

          const plotInputs: PlotWithCropInput[] = [];
          const overlayInputs: PlotOverlayInput[] = [];
          for (const [index, plot] of federalFarmPlots.entries()) {
            const name = plot.localId ?? `${index + 1}`;
            if (isIgnoredUsage(plot.usage)) continue;
            if (isOverlayUsage(plot.usage)) {
              overlayInputs.push({
                name,
                localId: plot.localId,
                usage: plot.usage,
                usageName: null,
                size: plot.size,
                geometry: plot.geometry,
                externalId: `${plot.geometryHash}:${plot.usage}`,
              });
            } else {
              plotInputs.push({
                name,
                localId: plot.localId,
                usage: plot.usage,
                cuttingDate: plot.cuttingDate,
                size: plot.size,
                geometry: plot.geometry,
              });
            }
          }
          await createPlotsWithCrops(tx, createdFarm.id, t, plotInputs);
          await insertPlotOverlays(tx, createdFarm.id, "federal", overlayInputs);
        }

        return createdFarm;
      });
    },
    async getFarmUsers(farmId: string): Promise<(User & { farmId: string; farmRole: "owner" | "member" })[]> {
      return rlsDb.rls(async (tx) => {
        const rows = await tx
          .select({ ...getTableColumns(tables.profiles), farmRole: tables.farmMembers.role })
          .from(tables.farmMembers)
          .innerJoin(tables.profiles, eq(tables.farmMembers.userId, tables.profiles.id))
          .where(eq(tables.farmMembers.farmId, farmId));
        return rows.map((row) => ({ ...row, farmId }));
      });
    },
    async listFarmsForUser(userId: string) {
      // Bypasses RLS deliberately, hard-scoped to the authenticated caller's own id (never
      // client input): the farms table's own RLS policy only allows seeing the currently-active
      // farm, which would otherwise hide the user's other farms from this exact query.
      return rlsDb.admin
        .select({ ...farmSelectColumns, role: tables.farmMembers.role })
        .from(tables.farmMembers)
        .innerJoin(tables.farms, eq(tables.farmMembers.farmId, tables.farms.id))
        .where(eq(tables.farmMembers.userId, userId));
    },
    async getFarmMember(farmId: string, userId: string) {
      const [member] = await rlsDb.admin
        .select()
        .from(tables.farmMembers)
        .where(and(eq(tables.farmMembers.farmId, farmId), eq(tables.farmMembers.userId, userId)));
      return member;
    },
    async updateFarm(farmId: string, data: Partial<FarmCreateInput>) {
      return rlsDb.rls(async (tx) => {
        const { location, ...rest } = data;
        const [updatedFarm] = await tx
          .update(tables.farms)
          .set({
            ...rest,
            location: location ? sql`ST_GeomFromGeoJSON(${JSON.stringify(location)})` : undefined,
          })
          .where(eq(tables.farms.id, farmId))
          .returning(farmSelectColumns);
        return updatedFarm;
      });
    },
    async deleteFarm(farmId: string) {
      return rlsDb.rls(async (tx) => {
        return tx.delete(tables.farms).where(eq(tables.farms.id, farmId));
      });
    },
    async kickMember(targetUserId: string, callerUserId: string, farmId: string) {
      return rlsDb.admin.transaction(async (tx) => {
        const members = await tx.query.farmMembers.findMany({ where: { farmId } });

        const caller = members.find((m) => m.userId === callerUserId);
        if (!caller || caller.role !== "owner") {
          throw createHttpError(403, "Only farm owners can kick members");
        }

        const target = members.find((m) => m.userId === targetUserId);
        if (!target) {
          throw createHttpError(404, "Member not found in this farm");
        }

        if (target.role === "owner") {
          const ownerCount = members.filter((m) => m.role === "owner").length;
          if (ownerCount <= 1) {
            throw createHttpError(400, "Cannot remove the only owner");
          }
        }

        await tx
          .delete(tables.farmMembers)
          .where(and(eq(tables.farmMembers.farmId, farmId), eq(tables.farmMembers.userId, targetUserId)));

        // Also clean up this user's permissions for this farm, so a stale grant/deny can't
        // resurface if they're invited back to the same farm later.
        await tx
          .delete(tables.farmMemberPermissions)
          .where(
            and(eq(tables.farmMemberPermissions.farmId, farmId), eq(tables.farmMemberPermissions.userId, targetUserId))
          );
      });
    },
    // Self-service removal: unlike kickMember, any current member (not just owners) can call
    // this on themselves — the only restriction is the same "don't strand the farm" rule that
    // already applies to kick/demote.
    async leaveFarm(userId: string, farmId: string) {
      return rlsDb.admin.transaction(async (tx) => {
        const members = await tx.query.farmMembers.findMany({ where: { farmId } });

        const self = members.find((m) => m.userId === userId);
        if (!self) {
          throw createHttpError(404, "You are not a member of this farm");
        }

        if (self.role === "owner") {
          const ownerCount = members.filter((m) => m.role === "owner").length;
          if (ownerCount <= 1) {
            throw createHttpError(
              400,
              "You are the only owner of this farm — transfer ownership or delete the farm instead of leaving"
            );
          }
        }

        await tx
          .delete(tables.farmMembers)
          .where(and(eq(tables.farmMembers.farmId, farmId), eq(tables.farmMembers.userId, userId)));

        await tx
          .delete(tables.farmMemberPermissions)
          .where(and(eq(tables.farmMemberPermissions.farmId, farmId), eq(tables.farmMemberPermissions.userId, userId)));
      });
    },
    async changeMemberRole(targetUserId: string, callerId: string, farmId: string, newRole: "owner" | "member") {
      return rlsDb.admin.transaction(async (tx) => {
        const members = await tx.query.farmMembers.findMany({ where: { farmId } });

        const caller = members.find((m) => m.userId === callerId);
        if (!caller || caller.role !== "owner") {
          throw createHttpError(403, "Only farm owners can change member roles");
        }

        const target = members.find((m) => m.userId === targetUserId);
        if (!target) {
          throw createHttpError(404, "Member not found in this farm");
        }

        if (newRole === "member" && target.role === "owner") {
          const ownerCount = members.filter((m) => m.role === "owner").length;
          if (ownerCount <= 1) {
            throw createHttpError(400, "Cannot demote the only owner");
          }
        }

        const [updatedMember] = await tx
          .update(tables.farmMembers)
          .set({ role: newRole })
          .where(and(eq(tables.farmMembers.farmId, farmId), eq(tables.farmMembers.userId, targetUserId)))
          .returning();

        const [updatedProfile] = await tx.select().from(tables.profiles).where(eq(tables.profiles.id, targetUserId));

        return { ...updatedProfile, farmId, farmRole: updatedMember.role };
      });
    },
  };
}
