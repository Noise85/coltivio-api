import path from "path";
import os from "os";
import fs from "fs";

const TEMP_FILE = path.join(os.tmpdir(), "coltivio-test-env.json");

const testEnv = JSON.parse(fs.readFileSync(TEMP_FILE, "utf-8")) as Record<string, string>;

process.env.DATABASE_URL = testEnv.DATABASE_URL;
process.env.APP_DATABASE_URL = testEnv.APP_DATABASE_URL;
process.env.SUPABASE_API_URL = testEnv.SUPABASE_API_URL;
process.env.SUPABASE_SERVICE_ROLE_KEY = testEnv.SUPABASE_SERVICE_ROLE_KEY;
process.env.GOTRUE_URL = testEnv.GOTRUE_URL;
process.env.SERVER_URL = testEnv.SERVER_URL;
