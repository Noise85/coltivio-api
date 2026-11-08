// Creates the seed auth user via the public signup endpoint (no admin JWT
// needed), captures the generated UUID, then loads seed.sql with that UUID
// substituted in.
//
// Rewritten from the former seed-auth.sh so the whole `yarn db:reset` chain
// runs in one command on every platform. The shell version depended on bash +
// python3 + curl + sed, which is brittle on Windows (bare `bash` resolves to
// WSL, `python3` to the Microsoft Store stub). This needs only Node (already a
// prerequisite), the Supabase CLI, and psql.

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DB_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const PLACEHOLDER_UUID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SIGNUP_URL = "http://127.0.0.1:54321/auth/v1/signup";
const EMAIL = "farmA@test.ch";
const PASSWORD = "123456";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const seedSqlPath = join(scriptDir, "..", "supabase", "seed.sql");

function readApiKey() {
  const env = execSync("supabase status -o env", { encoding: "utf8" });
  const find = (name) => {
    const match = env.match(new RegExp(`^${name}=(.*)$`, "m"));
    return match ? match[1].trim().replace(/^"|"$/g, "") : "";
  };
  // Newer CLI calls it PUBLISHABLE_KEY; older ones ANON_KEY.
  return find("PUBLISHABLE_KEY") || find("ANON_KEY");
}

async function main() {
  const apiKey = readApiKey();
  if (!apiKey) {
    console.error(
      "Could not read PUBLISHABLE_KEY/ANON_KEY from `supabase status`. Is Supabase running?",
    );
    process.exit(1);
  }

  console.log("Creating auth users...");
  const response = await fetch(SIGNUP_URL, {
    method: "POST",
    headers: { apikey: apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  const body = await response.json();
  const userId = body?.user?.id;
  if (!userId) {
    console.error(
      `Failed to get user ID from signup response: ${JSON.stringify(body)}`,
    );
    process.exit(1);
  }
  console.log(`Auth user created: ${userId}`);

  console.log("Seeding database...");
  const sql = readFileSync(seedSqlPath, "utf8").replaceAll(
    PLACEHOLDER_UUID,
    userId,
  );
  execSync(`psql "${DB_URL}"`, { input: sql, stdio: ["pipe", "inherit", "inherit"] });
  console.log("Done.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
