import { and, eq } from "drizzle-orm";
import { RlsDb } from "../db/db";
import * as tables from "../db/schema";
import { FarmPermissionFeature } from "../db/schema";

export type { FarmPermissionFeature };

export class FarmPermissions {
  constructor(private db: RlsDb) {}

  async getFeatureAccess(
    userId: string,
    farmId: string,
    feature: FarmPermissionFeature
  ): Promise<"none" | "read" | "write"> {
    const row = await this.db.rls((tx) =>
      tx.query.farmMemberPermissions.findFirst({ where: { farmId, userId, feature } })
    );
    return (row?.access as "none" | "read" | "write") ?? "none";
  }

  async listPermissionsForUser(userId: string): Promise<(typeof tables.farmMemberPermissions.$inferSelect)[]> {
    return this.db.rls((tx) => tx.query.farmMemberPermissions.findMany({ where: { userId } }));
  }

  async setFeatureAccess(
    userId: string,
    farmId: string,
    feature: FarmPermissionFeature,
    access: "none" | "read" | "write"
  ): Promise<void> {
    await this.db.admin
      .insert(tables.farmMemberPermissions)
      .values({ userId, farmId, feature, access })
      .onConflictDoUpdate({
        target: [
          tables.farmMemberPermissions.farmId,
          tables.farmMemberPermissions.userId,
          tables.farmMemberPermissions.feature,
        ],
        set: { access },
      });
  }

  async resetFeatureAccess(userId: string, farmId: string, feature: FarmPermissionFeature): Promise<void> {
    await this.db.admin
      .delete(tables.farmMemberPermissions)
      .where(
        and(
          eq(tables.farmMemberPermissions.farmId, farmId),
          eq(tables.farmMemberPermissions.userId, userId),
          eq(tables.farmMemberPermissions.feature, feature)
        )
      );
  }
}

export function farmPermissionsApi(db: RlsDb): FarmPermissions {
  return new FarmPermissions(db);
}
