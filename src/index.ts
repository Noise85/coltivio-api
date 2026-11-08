import "dotenv/config";
import { startServer } from "./rest-server";
import { startWikiImageCleanupCron } from "./wiki/wiki-cron";
import { startMembershipExpiryCron } from "./membership/membership-expiry-cron";
import { startTaskDueCron } from "./tasks/task-due-cron";

startServer().catch((err) => console.error(err));
startWikiImageCleanupCron();
startMembershipExpiryCron();
startTaskDueCron();
