import type http from "http";
import type { StartedDockerComposeEnvironment } from "testcontainers";
import { disconnect } from "../db/db";

export default async function globalTeardown() {
  console.log("[test] Shutting down...");

  // Stop DB connections
  try {
    await disconnect();
  } catch {
    // connections may not have been established
  }

  // Stop app server
  const server = (globalThis as Record<string, unknown>).__SERVER__ as
    | { servers: Array<{ close: (cb?: () => void) => void }> }
    | undefined;
  if (server) {
    await Promise.all(server.servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
  }

  // Stop auth proxy
  const authProxy = (globalThis as Record<string, unknown>).__AUTH_PROXY__ as http.Server | undefined;
  if (authProxy) {
    await new Promise<void>((resolve) => authProxy.close(() => resolve()));
  }

  // Stop docker-compose environment
  const compose = (globalThis as Record<string, unknown>).__COMPOSE__ as StartedDockerComposeEnvironment | undefined;
  if (compose) {
    await compose.down();
  }

  console.log("[test] Teardown complete.");
}
