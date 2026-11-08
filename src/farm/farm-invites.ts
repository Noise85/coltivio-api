import crypto from "crypto";
import createHttpError from "http-errors";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { TFunction } from "i18next";
import { RlsDb } from "../db/db";
import * as tables from "../db/schema";
import { FarmPermissionFeature } from "../db/schema";
import { User } from "../user/users";
import { sendFarmInviteEmail } from "./farm-invites.email";

export type InvitePermission = { feature: FarmPermissionFeature; access: "none" | "read" | "write" };

const INVITE_TTL_DAYS = 7;

export type FarmInvite = typeof tables.farmInvites.$inferSelect;

export function farmInvitesApi(rlsDb: RlsDb, t: TFunction) {
  return {
    async createInvite(
      farmId: string,
      email: string,
      createdBy: string,
      role: "owner" | "member" = "member",
      permissions: InvitePermission[] = []
    ): Promise<FarmInvite> {
      return rlsDb.rls(async (tx) => {
        // Reject if a profile with that email already belongs to this farm
        const existingProfile = await tx.query.profiles.findFirst({ where: { email } });
        if (existingProfile) {
          const existingMembership = await tx.query.farmMembers.findFirst({
            where: { farmId, userId: existingProfile.id },
          });
          if (existingMembership) {
            throw createHttpError(409, "User is already a member of this farm");
          }
        }

        const code = crypto.randomBytes(4).toString("hex").toUpperCase();
        const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000);

        const [invite] = await tx
          .insert(tables.farmInvites)
          .values({ farmId, email, code, role, createdBy, expiresAt })
          .returning();

        if (permissions.length > 0) {
          await tx
            .insert(tables.farmInvitePermissions)
            .values(permissions.map((p) => ({ inviteId: invite.id, feature: p.feature, access: p.access })));
        }

        // Fetch farm name for the email
        const farm = await tx.query.farms.findFirst({ where: { id: farmId } });
        await sendFarmInviteEmail(email, code, farm?.name ?? "a farm", t);

        return invite;
      });
    },

    async acceptInvite(code: string, user: User): Promise<User & { farmId: string; farmRole: "owner" | "member" }> {
      return rlsDb.admin.transaction(async (tx) => {
        const invite = await tx.query.farmInvites.findFirst({
          where: { code },
          with: { permissions: true },
        });

        if (!invite) {
          throw createHttpError(404, "Invite not found");
        }
        if (invite.usedAt !== null) {
          throw createHttpError(410, "Invite has already been used");
        }
        if (invite.expiresAt < new Date()) {
          throw createHttpError(410, "Invite has expired");
        }
        if (user.email !== invite.email) {
          throw createHttpError(403, "This invite was sent to a different email address");
        }
        const existingMembership = await tx.query.farmMembers.findFirst({
          where: { farmId: invite.farmId, userId: user.id },
        });
        if (existingMembership) {
          throw createHttpError(409, "You are already a member of this farm");
        }

        // Assign user to the farm with the role specified on the invite
        await tx.insert(tables.farmMembers).values({ farmId: invite.farmId, userId: user.id, role: invite.role });

        await tx
          .update(tables.farmInvites)
          .set({ usedAt: sql`now()` })
          .where(eq(tables.farmInvites.id, invite.id));

        // Initialize permissions for all features. Use the invite's explicit grants where
        // provided; everything else defaults to "none" (deny by default).
        const grantMap = new Map(
          invite.permissions.map((p) => [p.feature as FarmPermissionFeature, p.access as "none" | "read" | "write"])
        );
        const allFeatures = tables.farmPermissionFeatureEnum.enumValues;
        // Upsert (not plain insert): defense in depth against a stray pre-existing row for this
        // (farmId, userId, feature) — e.g. left over from before a farm's owner is required to
        // target only current members when granting permissions — colliding with the unique
        // constraint and turning a normal invite-accept into an unhandled 500.
        await tx
          .insert(tables.farmMemberPermissions)
          .values(
            allFeatures.map((feature) => ({
              userId: user.id,
              farmId: invite.farmId,
              feature,
              access: (grantMap.get(feature) ?? "none") as "none" | "read" | "write",
            }))
          )
          .onConflictDoUpdate({
            target: [
              tables.farmMemberPermissions.farmId,
              tables.farmMemberPermissions.userId,
              tables.farmMemberPermissions.feature,
            ],
            set: { access: sql`excluded.access` },
          });

        return { ...user, farmId: invite.farmId, farmRole: invite.role };
      });
    },

    async listInvites(farmId: string): Promise<FarmInvite[]> {
      return rlsDb.rls(async (tx) => {
        return tx
          .select()
          .from(tables.farmInvites)
          .where(
            and(
              eq(tables.farmInvites.farmId, farmId),
              isNull(tables.farmInvites.usedAt),
              gt(tables.farmInvites.expiresAt, new Date())
            )
          );
      });
    },

    async revokeInvite(id: string): Promise<void> {
      await rlsDb.rls(async (tx) => {
        await tx.delete(tables.farmInvites).where(eq(tables.farmInvites.id, id));
      });
    },
  };
}
