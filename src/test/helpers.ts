import crypto from "crypto";
import { GoTrueClient } from "@supabase/auth-js";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "../db/schema";
import { relations } from "../db/schema";

// Helper to create a typed drizzle instance (used for ReturnType inference)
function createAdminDb() {
  const client = postgres(process.env.DATABASE_URL!, { prepare: false });
  return drizzle({ client, schema, relations, casing: "snake_case" });
}

// Lazy singleton admin DB for direct state verification in tests
let _adminSql: ReturnType<typeof postgres> | null = null;
let _adminDb: ReturnType<typeof createAdminDb> | null = null;

export function getAdminSql() {
  if (!_adminSql) {
    _adminSql = postgres(process.env.DATABASE_URL!, { prepare: false });
  }
  return _adminSql;
}

export function getAdminDb() {
  if (!_adminDb) {
    _adminDb = drizzle({
      client: getAdminSql(),
      schema,
      relations,
      casing: "snake_case",
    });
  }
  return _adminDb;
}

/**
 * Creates a user via GoTrue admin API and signs in to get a JWT.
 * Uses GoTrueClient directly because @supabase/supabase-js appends /auth/v1
 * to the URL, but our test GoTrue container serves at the root.
 */
export async function createTestUser(email: string, password: string) {
  const gotrue = new GoTrueClient({
    url: process.env.GOTRUE_URL!,
    headers: {
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY!}`,
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY!,
    },
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false,
  });

  const { data: createData, error: createError } = await gotrue.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (createError) throw createError;

  const { data: signInData, error: signInError } = await gotrue.signInWithPassword({ email, password });
  if (signInError) throw signInError;

  // Confirmed and handled by default, otherwise the first request of every test sends a verification or
  // welcome mail
  await getAdminDb()
    .update(schema.profiles)
    .set({ emailVerified: true, verificationHandledAt: new Date() })
    .where(eq(schema.profiles.id, createData.user.id));

  return {
    jwt: signInData.session!.access_token,
    userId: createData.user.id,
  };
}

/**
 * Truncates all public tables and deletes auth users.
 * Call in beforeEach for test isolation.
 */
export async function cleanDb() {
  const sql = getAdminSql();

  const tables = await sql`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public'
  `;

  if (tables.length > 0) {
    const tableNames = tables.map((t) => `"${t.tablename}"`).join(", ");
    await sql.unsafe(`TRUNCATE ${tableNames} CASCADE`);
  }

  // Delete auth users (profiles already removed by truncate)
  await sql`DELETE FROM auth.users`;
}

/**
 * Fetch wrapper that prepends the test server base URL.
 */
export async function request(
  method: string,
  path: string,
  body?: Record<string, unknown>,
  jwt?: string,
  farmId?: string
) {
  const baseUrl = process.env.SERVER_URL!;
  const url = `${baseUrl}${path}`;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (jwt) {
    headers["Authorization"] = `Bearer ${jwt}`;
  }
  if (farmId) {
    headers["x-farm-id"] = farmId;
  }

  return fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
}

/**
 * Like `request` but accepts arbitrary headers for negative auth tests.
 */
export async function rawRequest(
  method: string,
  path: string,
  options?: {
    body?: Record<string, unknown> | string;
    headers?: Record<string, string>;
  }
) {
  const baseUrl = process.env.SERVER_URL!;
  const url = `${baseUrl}${path}`;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...options?.headers,
  };

  const body =
    typeof options?.body === "string" ? options.body : options?.body ? JSON.stringify(options.body) : undefined;

  return fetch(url, { method, headers, body });
}

/**
 * Signs a test JWT using HMAC-SHA256. Used for crafting malformed/expired tokens.
 * The secret must match the GoTrue JWT_SECRET from docker-compose.test.yml.
 */
export function signTestJwt(
  payload: Record<string, unknown>,
  secret: string,
  options?: { expiresInSeconds?: number }
): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const body = Buffer.from(
    JSON.stringify({
      iat: now,
      exp: now + (options?.expiresInSeconds ?? 3600),
      ...payload,
    })
  ).toString("base64url");
  const signature = crypto.createHmac("sha256", secret).update(`${header}.${body}`).digest("base64url");
  return `${header}.${body}.${signature}`;
}
