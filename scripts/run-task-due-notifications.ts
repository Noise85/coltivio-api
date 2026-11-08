// Runs the daily task due push notifications once, for local testing on a device.
// Usage: npx ts-node scripts/run-task-due-notifications.ts
// To resend for the same tasks: delete from task_due_notifications;
import "dotenv/config";
// Side effect import: initializes i18next with the locale resources used for the push texts
import "../src/rest-server";
import { and, eq, inArray, sql } from "drizzle-orm";
import { adminDrizzle } from "../src/db/db";
import {
  farmMemberPermissions,
  farmMembers,
  pushTokens,
  taskDueNotifications,
  tasks,
  userSettings,
} from "../src/db/schema";
import { CRON_TIMEZONE, runTaskDueNotifications, zurichDateString } from "../src/tasks/task-due-cron";
import { fetchPushReceipts } from "../src/push/expo-client";

// Expo needs a moment until delivery receipts are available
const RECEIPT_DELAY_MS = 5000;

// Explains for every open task due today who would get a push and why not.
// Runs before the cron, since the cron records sent notifications and a second look would only show "already notified".
// Mirrors the rules in runTaskDueNotifications — keep both in sync.
async function printDiagnostics(today: string) {
  console.log(`today (Zurich): ${today}`);

  const dueTasks = await adminDrizzle
    .select({
      id: tasks.id,
      name: tasks.name,
      farmId: tasks.farmId,
      assigneeId: tasks.assigneeId,
      createdAt: tasks.createdAt,
      createdOnDueDay: sql<boolean>`(${tasks.createdAt} at time zone 'UTC' at time zone ${CRON_TIMEZONE})::date >= ${today}::date`,
    })
    .from(tasks)
    .where(and(eq(tasks.status, "todo"), eq(tasks.dueDate, sql`${today}::date`)));
  if (dueTasks.length === 0) {
    console.log("no open tasks due today");
    return;
  }

  const farmIds = [...new Set(dueTasks.map((task) => task.farmId))];
  const members = await adminDrizzle
    .select({ farmId: farmMembers.farmId, userId: farmMembers.userId, role: farmMembers.role })
    .from(farmMembers)
    .where(inArray(farmMembers.farmId, farmIds));
  const userIds = [...new Set(members.map((member) => member.userId))];
  const [taskPermissions, settings, tokens, sentNotifications] = await Promise.all([
    adminDrizzle
      .select({
        farmId: farmMemberPermissions.farmId,
        userId: farmMemberPermissions.userId,
        access: farmMemberPermissions.access,
      })
      .from(farmMemberPermissions)
      .where(and(inArray(farmMemberPermissions.farmId, farmIds), eq(farmMemberPermissions.feature, "tasks"))),
    adminDrizzle.select().from(userSettings).where(inArray(userSettings.userId, userIds)),
    adminDrizzle.select().from(pushTokens).where(inArray(pushTokens.userId, userIds)),
    adminDrizzle
      .select()
      .from(taskDueNotifications)
      .where(
        inArray(
          taskDueNotifications.taskId,
          dueTasks.map((task) => task.id)
        )
      ),
  ]);

  for (const task of dueTasks) {
    console.log(`\ntask "${task.name}" (${task.id}), createdAt ${task.createdAt.toISOString()}`);
    if (task.createdOnDueDay) {
      console.log("  SKIP: created on its due day");
      continue;
    }

    const farmMembersOfTask = members.filter((member) => member.farmId === task.farmId);
    let recipientIds: string[];
    if (task.assigneeId) {
      if (!farmMembersOfTask.some((member) => member.userId === task.assigneeId)) {
        console.log(`  SKIP: assignee ${task.assigneeId} is no longer a farm member`);
        continue;
      }
      console.log(`  assigned to ${task.assigneeId}`);
      recipientIds = [task.assigneeId];
    } else {
      console.log("  unassigned, checking all farm members:");
      recipientIds = [];
      for (const member of farmMembersOfTask) {
        const access =
          member.role === "owner"
            ? "owner"
            : (taskPermissions.find(
                (permission) => permission.farmId === task.farmId && permission.userId === member.userId
              )?.access ?? "none");
        if (access === "none") {
          console.log(`  - user ${member.userId}: SKIP no tasks access`);
        } else {
          recipientIds.push(member.userId);
        }
      }
    }

    for (const userId of recipientIds) {
      const userTokens = tokens.filter((token) => token.userId === userId);
      const reasons: string[] = [];
      if (settings.find((setting) => setting.userId === userId)?.taskPushNotifications === false) {
        reasons.push("task push notifications disabled");
      }
      if (sentNotifications.some((notification) => notification.taskId === task.id && notification.userId === userId)) {
        reasons.push("already notified for this due date (task_due_notifications)");
      }
      if (userTokens.length === 0) reasons.push("no registered push tokens");
      const status = reasons.length > 0 ? `SKIP ${reasons.join(", ")}` : `will send to ${userTokens.length} token(s)`;
      console.log(`  - user ${userId}: ${status}`);
    }
  }
  console.log("");
}

async function main() {
  const now = new Date();
  await printDiagnostics(zurichDateString(now));

  const results = await runTaskDueNotifications(now);
  if (results.length === 0) {
    console.log("Nothing sent");
    return;
  }

  const ticketIdToToken = new Map<string, string>();
  for (const { message, ticket } of results) {
    console.log(`sent to ${message.to}: "${message.title}" / "${message.body}"`);
    if (ticket.status === "ok") {
      console.log(`  ticket ok (${ticket.id})`);
      ticketIdToToken.set(ticket.id, message.to);
    } else {
      console.log(`  ticket ERROR ${ticket.details?.error ?? ""} — ${ticket.message}`);
    }
  }
  if (ticketIdToToken.size === 0) return;

  console.log(`\nWaiting ${RECEIPT_DELAY_MS / 1000}s for delivery receipts...`);
  await new Promise((resolve) => setTimeout(resolve, RECEIPT_DELAY_MS));
  const receipts = await fetchPushReceipts([...ticketIdToToken.keys()]);
  for (const [ticketId, token] of ticketIdToToken) {
    const receipt = receipts[ticketId];
    if (!receipt) {
      console.log(`receipt for ${token}: not available yet, try again later with ticket id ${ticketId}`);
    } else if (receipt.status === "ok") {
      console.log(`receipt for ${token}: ok — delivered to APNs/FCM`);
    } else {
      console.log(`receipt for ${token}: ERROR ${receipt.details?.error ?? ""} — ${receipt.message}`);
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
