import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "./schema";
import { relations } from "./schema";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import { SupabaseToken } from "../supabase/supabase";

export type Transaction = Parameters<Parameters<typeof clientDrizzle.transaction>[0]>[0];

const client = postgres(process.env.APP_DATABASE_URL!, { prepare: false });
const adminClient = postgres(process.env.DATABASE_URL!, { prepare: false });

export async function disconnect() {
  await adminClient.end();
  await client.end();
}

export const clientDrizzle = drizzle({
  client,
  schema,
  relations,
  casing: "snake_case",
});
export const adminDrizzle = drizzle({
  client: adminClient,
  schema,
  relations,
  casing: "snake_case",
});

// Whitelist of allowed Supabase roles to prevent SQL injection in SET ROLE
const ALLOWED_ROLES = ["anon", "authenticated", "service_role"] as const;
type AllowedRole = (typeof ALLOWED_ROLES)[number];

function validateRole(role: string | undefined): AllowedRole {
  if (role && ALLOWED_ROLES.includes(role as AllowedRole)) {
    return role as AllowedRole;
  }
  return "anon";
}

export type RlsDb = ReturnType<typeof rlsDb>;

// Admin-only RlsDb — no JWT context, bypasses RLS entirely. Use in webhook handlers and background jobs.
export const adminOnlyDb: RlsDb = {
  admin: adminDrizzle,
  rls: () => {
    throw new Error("rls() not available in admin-only context — use db.admin");
  },
};
const RLS_STATEMENT_TIMEOUT = "10s";

export function rlsDb(token: SupabaseToken, farmId?: string | null) {
  const validatedRole = validateRole(token.role);

  async function rls<T>(transaction: (sql: Transaction) => T | Promise<T>): Promise<T> {
    return clientDrizzle.transaction(async (tx) => {
      try {
        await tx.execute(sql`select set_config('request.jwt.claim.sub', ${token.sub ?? ""}, TRUE)`);
        if (farmId) {
          await tx.execute(sql`select set_config('request.farm_id', ${farmId}, TRUE)`);
        }

        // Using sql.raw() is safe here because validatedRole is guaranteed to be one of the ALLOWED_ROLES
        await tx.execute(sql`set local role ${sql.raw(validatedRole)}`);
        // Bounds runaway queries such as oversized plot layer requests. Set per
        // transaction rather than via ALTER ROLE: on hosted Supabase the
        // migration user may not alter rls_client, and SET LOCAL ROLE would not
        // apply the target role's settings anyway.
        await tx.execute(sql`set local statement_timeout = ${sql.raw(`'${RLS_STATEMENT_TIMEOUT}'`)}`);
        const result = await transaction(tx);
        await tx.execute(sql`select set_config('request.jwt.claim.sub', NULL, TRUE)`);
        if (farmId) {
          await tx.execute(sql`select set_config('request.farm_id', NULL, TRUE)`);
        }
        await tx.execute(sql`reset role`);
        return result;
      } finally {
      }
    }) as Promise<T>;
  }
  return {
    admin: adminDrizzle,
    rls,
  };
}
