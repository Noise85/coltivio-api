import { eq } from "drizzle-orm";
import { RlsDb } from "../db/db";
import { pushTokens } from "../db/schema";

export function pushTokensApi(db: RlsDb) {
  return {
    async registerToken(userId: string, token: string, platform: "ios" | "android" | undefined): Promise<void> {
      // Admin upsert: when a device switches accounts, the existing row belongs to another user
      // and RLS would block reassigning it. userId comes from the verified JWT.
      await db.admin
        .insert(pushTokens)
        .values({ userId, token, platform })
        .onConflictDoUpdate({
          target: pushTokens.token,
          set: { userId, platform: platform ?? null, createdAt: new Date() },
        });
    },

    async unregisterToken(token: string): Promise<void> {
      // RLS restricts this to the caller's own tokens
      await db.rls(async (tx) => {
        await tx.delete(pushTokens).where(eq(pushTokens.token, token));
      });
    },
  };
}
