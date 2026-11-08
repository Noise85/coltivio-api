import crypto from "crypto";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import createHttpError from "http-errors";
import { RlsDb } from "../db/db";
import { handoffTokens } from "../db/schema";
import { supabase } from "../supabase/supabase";

export function handoffApi(db: RlsDb) {
  return {
    async createHandoffToken(userId: string): Promise<{ token: string; expiresAt: Date }> {
      const token = crypto.randomBytes(32).toString("hex");
      const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes

      await db.admin.insert(handoffTokens).values({ userId, token, expiresAt });

      return { token, expiresAt };
    },

    async exchangeHandoffToken(token: string, redirectTo: string): Promise<{ url: string }> {
      const [claimedToken] = await db.admin
        .update(handoffTokens)
        .set({ usedAt: sql`now()` })
        .where(
          and(eq(handoffTokens.token, token), isNull(handoffTokens.usedAt), gt(handoffTokens.expiresAt, sql`now()`))
        )
        .returning({ userId: handoffTokens.userId });

      if (!claimedToken) {
        const row = await db.admin.query.handoffTokens.findFirst({
          where: { token },
        });

        if (!row) {
          throw createHttpError(400, "Invalid handoff token");
        }
        if (row.usedAt) {
          throw createHttpError(410, "Handoff token already used");
        }
        throw createHttpError(400, "Handoff token expired");
      }

      const profile = await db.admin.query.profiles.findFirst({
        where: { id: claimedToken.userId },
      });
      if (!profile) {
        throw createHttpError(500, "User profile not found");
      }

      const { data, error } = await supabase.auth.admin.generateLink({
        type: "magiclink",
        email: profile.email,
        options: { redirectTo },
      });
      if (error || !data.properties?.action_link) {
        throw createHttpError(500, `Failed to generate magic link: ${error?.message ?? "no action_link in response"}`);
      }

      return { url: data.properties.action_link };
    },
  };
}
