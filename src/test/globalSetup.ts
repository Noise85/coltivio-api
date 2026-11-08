import path from "path";
import fs from "fs";
import os from "os";
import http from "http";
import crypto from "crypto";
import { execSync } from "child_process";
import { DockerComposeEnvironment, Wait } from "testcontainers";
import postgres from "postgres";

const JWT_SECRET = "super-secret-jwt-token-with-at-least-32-characters-long";
const TEMP_FILE = path.join(os.tmpdir(), "coltivio-test-env.json");
const PROJECT_ROOT = path.resolve(__dirname, "../..");

function signJwt(payload: Record<string, unknown>, secret: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(
    JSON.stringify({
      ...payload,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    })
  ).toString("base64url");
  const signature = crypto.createHmac("sha256", secret).update(`${header}.${body}`).digest("base64url");
  return `${header}.${body}.${signature}`;
}

/**
 * Lightweight proxy that strips /auth/v1 prefix and forwards to GoTrue.
 * The @supabase/supabase-js client always appends /auth/v1 to the base URL,
 * but GoTrue serves at the root.
 */
function startAuthProxy(gotrueUrl: string): Promise<http.Server> {
  return new Promise((resolve) => {
    const proxy = http.createServer((req, res) => {
      const targetPath = (req.url ?? "").replace(/^\/auth\/v1/, "") || "/";
      const target = new URL(targetPath, gotrueUrl);

      const proxyReq = http.request(
        target,
        { method: req.method, headers: { ...req.headers, host: target.host } },
        (proxyRes) => {
          res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
          proxyRes.pipe(res);
        }
      );
      proxyReq.on("error", () => {
        res.writeHead(502);
        res.end();
      });
      req.pipe(proxyReq);
    });

    proxy.listen(0, () => resolve(proxy));
  });
}

export default async function globalSetup() {
  console.log("[test] Starting docker-compose environment...");

  // 1. Start containers
  const environment = await new DockerComposeEnvironment(PROJECT_ROOT, "docker-compose.test.yml")
    .withWaitStrategy("db-1", Wait.forHealthCheck())
    .withWaitStrategy("auth-1", Wait.forHealthCheck())
    .up();

  const dbContainer = environment.getContainer("db-1");
  const authContainer = environment.getContainer("auth-1");

  const dbHost = dbContainer.getHost();
  const dbPort = dbContainer.getMappedPort(5432);
  const authHost = authContainer.getHost();
  const authPort = authContainer.getMappedPort(9999);

  // 2. Build connection strings
  const databaseUrl = `postgres://postgres:postgres@${dbHost}:${dbPort}/postgres`;
  const appDatabaseUrl = `postgres://app:postgres@${dbHost}:${dbPort}/postgres`;
  const gotrueDirectUrl = `http://${authHost}:${authPort}`;

  // 3. Start auth proxy (strips /auth/v1 prefix for supabase-js client)
  const authProxy = await startAuthProxy(gotrueDirectUrl);
  const proxyPort = (authProxy.address() as { port: number }).port;
  const supabaseApiUrl = `http://localhost:${proxyPort}`;

  // 4. Generate service_role JWT
  const serviceRoleKey = signJwt({ role: "service_role", iss: "supabase" }, JWT_SECRET);

  // 5. Run setup SQL (creates app role, farm_id(), trigger function)
  console.log("[test] Running setup SQL...");
  const adminSql = postgres(databaseUrl);
  const setupSqlContent = fs.readFileSync(path.join(PROJECT_ROOT, "scripts/setup-test-db.sql"), "utf-8");
  await adminSql.unsafe(setupSqlContent);
  await adminSql.end();

  // 6. Run drizzle migrations
  console.log("[test] Running drizzle migrations...");
  execSync("npx drizzle-kit migrate", {
    cwd: PROJECT_ROOT,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: "inherit",
  });

  // 7. Post-migration setup: create trigger, grant permissions on created tables
  console.log("[test] Running post-migration setup...");
  const postSql = postgres(databaseUrl);
  await postSql.unsafe(`
    -- Create the trigger now that profiles table exists
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_trigger WHERE tgname = 'on_auth_user_created'
      ) THEN
        CREATE TRIGGER on_auth_user_created
          AFTER INSERT ON auth.users
          FOR EACH ROW
          EXECUTE FUNCTION public.handle_new_user();
      END IF;
    END $$;

    -- Grant table permissions to authenticated role (for RLS queries)
    GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated;
    GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO authenticated;

    -- Verification state is server-side only. Without this, the "user can update own profile"
    -- RLS policy would let any logged-in user flip email_verified through PostgREST.
    -- A column-level REVOKE is a no-op while the table-level UPDATE grant stands, so drop that
    -- first and grant back only the column clients may write.
    -- Repeats the column grants from migration email_verification, which the GRANT ALL above undoes.
    REVOKE UPDATE ON public.profiles FROM authenticated;
    GRANT UPDATE (full_name) ON public.profiles TO authenticated;
  `);
  await postSql.end();

  // 8. Set env vars and start server
  process.env.DATABASE_URL = databaseUrl;
  process.env.APP_DATABASE_URL = appDatabaseUrl;
  process.env.SUPABASE_API_URL = supabaseApiUrl;
  process.env.SUPABASE_SERVICE_ROLE_KEY = serviceRoleKey;
  process.env.PORT = "0";

  console.log("[test] Starting app server...");
  const { startServer } = await import("../rest-server");
  const server = await startServer();

  const httpServer = server.servers[0];
  const address = httpServer.address();
  const serverPort = typeof address === "string" ? 0 : (address?.port ?? 0);

  // 9. Store references for teardown
  (globalThis as Record<string, unknown>).__COMPOSE__ = environment;
  (globalThis as Record<string, unknown>).__SERVER__ = server;
  (globalThis as Record<string, unknown>).__AUTH_PROXY__ = authProxy;

  // 10. Write connection info for test workers
  const testEnv = {
    DATABASE_URL: databaseUrl,
    APP_DATABASE_URL: appDatabaseUrl,
    SUPABASE_API_URL: supabaseApiUrl,
    GOTRUE_URL: gotrueDirectUrl,
    SUPABASE_SERVICE_ROLE_KEY: serviceRoleKey,
    SERVER_URL: `http://localhost:${serverPort}`,
  };
  fs.writeFileSync(TEMP_FILE, JSON.stringify(testEnv));

  console.log(`[test] Server listening on port ${serverPort}`);
  console.log(`[test] GoTrue at ${gotrueDirectUrl} (proxy at ${supabaseApiUrl})`);
  console.log(`[test] DB at ${dbHost}:${dbPort}`);
}
