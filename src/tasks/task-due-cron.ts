import cron from "node-cron";
import i18next from "i18next";
import { and, eq, inArray, sql } from "drizzle-orm";
import { captureException } from "@sentry/node";
import { adminDrizzle } from "../db/db";
import {
  farmMemberPermissions,
  farmMembers,
  profiles,
  pushTokens,
  taskDueNotifications,
  tasks,
  userSettings,
} from "../db/schema";
import { sendPushMessages } from "../push/push";
import { PushMessage, PushTicket } from "../push/expo-client";

export const CRON_TIMEZONE = "Europe/Zurich";
const MAX_TASK_NAMES_IN_BODY = 3;

// YYYY-MM-DD of the given instant in Zurich time (en-CA formats as ISO date)
export function zurichDateString(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: CRON_TIMEZONE }).format(now);
}

export type TaskDueSendResult = { message: PushMessage; ticket: PushTicket };

// Sends one digest push per (user, farm) for open tasks due today.
// Assigned tasks go to the assignee, unassigned tasks to every member with tasks access (owners always have it).
// Returns the sent messages with their Expo tickets.
async function runTaskDueNotifications(now: Date = new Date()): Promise<TaskDueSendResult[]> {
  const today = zurichDateString(now);

  const dueTasks = await adminDrizzle
    .select({
      id: tasks.id,
      name: tasks.name,
      farmId: tasks.farmId,
      assigneeId: tasks.assigneeId,
      dueDate: tasks.dueDate,
    })
    .from(tasks)
    .where(
      and(
        eq(tasks.status, "todo"),
        eq(tasks.dueDate, sql`${today}::date`),
        // Tasks created on their due day are skipped, the creator already knows about them.
        // created_at is stored as UTC without time zone, so convert to the Zurich date before comparing.
        sql`(${tasks.createdAt} at time zone 'UTC' at time zone ${CRON_TIMEZONE})::date < ${today}::date`
      )
    );
  if (dueTasks.length === 0) return [];

  const farmIds = [...new Set(dueTasks.map((task) => task.farmId))];
  const [members, taskPermissions] = await Promise.all([
    adminDrizzle
      .select({ farmId: farmMembers.farmId, userId: farmMembers.userId, role: farmMembers.role })
      .from(farmMembers)
      .where(inArray(farmMembers.farmId, farmIds)),
    adminDrizzle
      .select({ farmId: farmMemberPermissions.farmId, userId: farmMemberPermissions.userId })
      .from(farmMemberPermissions)
      .where(
        and(
          inArray(farmMemberPermissions.farmId, farmIds),
          eq(farmMemberPermissions.feature, "tasks"),
          inArray(farmMemberPermissions.access, ["read", "write"])
        )
      ),
  ]);

  const memberKey = (farmId: string, userId: string) => `${farmId}:${userId}`;
  const memberKeys = new Set(members.map((member) => memberKey(member.farmId, member.userId)));
  const usersWithTaskAccess = new Set(
    taskPermissions.map((permission) => memberKey(permission.farmId, permission.userId))
  );
  const membersWithTaskAccessByFarm = new Map<string, string[]>();
  for (const member of members) {
    if (member.role !== "owner" && !usersWithTaskAccess.has(memberKey(member.farmId, member.userId))) continue;
    const farmUserIds = membersWithTaskAccessByFarm.get(member.farmId) ?? [];
    farmUserIds.push(member.userId);
    membersWithTaskAccessByFarm.set(member.farmId, farmUserIds);
  }

  // Resolve candidate recipients per task
  const candidates: { taskId: string; userId: string; dueDate: Date }[] = [];
  for (const task of dueTasks) {
    if (!task.dueDate) continue;
    if (task.assigneeId) {
      // Assignee may have left the farm since the task was assigned
      if (memberKeys.has(memberKey(task.farmId, task.assigneeId))) {
        candidates.push({ taskId: task.id, userId: task.assigneeId, dueDate: task.dueDate });
      }
      continue;
    }
    for (const userId of membersWithTaskAccessByFarm.get(task.farmId) ?? []) {
      candidates.push({ taskId: task.id, userId, dueDate: task.dueDate });
    }
  }
  if (candidates.length === 0) return [];

  const candidateUserIds = [...new Set(candidates.map((candidate) => candidate.userId))];
  const recipientProfiles = await adminDrizzle
    .select({ id: profiles.id, locale: profiles.locale })
    .from(profiles)
    // Opt-in: no settings row means notifications disabled
    .innerJoin(userSettings, eq(userSettings.userId, profiles.id))
    .where(and(inArray(profiles.id, candidateUserIds), eq(userSettings.taskPushNotifications, true)));
  const localeByUserId = new Map(recipientProfiles.map((profile) => [profile.id, profile.locale]));
  const optedInCandidates = candidates.filter((candidate) => localeByUserId.has(candidate.userId));
  if (optedInCandidates.length === 0) return [];

  // Claim notifications first — only rows actually inserted get sent, so reruns and parallel instances don't double-notify
  const claimed = await adminDrizzle
    .insert(taskDueNotifications)
    .values(optedInCandidates)
    .onConflictDoNothing()
    .returning({ taskId: taskDueNotifications.taskId, userId: taskDueNotifications.userId });
  if (claimed.length === 0) return [];

  const taskById = new Map(dueTasks.map((task) => [task.id, task]));
  const digests = new Map<string, { userId: string; farmId: string; taskIds: string[]; taskNames: string[] }>();
  for (const claim of claimed) {
    const task = taskById.get(claim.taskId);
    if (!task) continue;
    const digestKey = memberKey(task.farmId, claim.userId);
    const digest = digests.get(digestKey) ?? {
      userId: claim.userId,
      farmId: task.farmId,
      taskIds: [],
      taskNames: [],
    };
    digest.taskIds.push(task.id);
    digest.taskNames.push(task.name);
    digests.set(digestKey, digest);
  }

  const recipientUserIds = [...new Set([...digests.values()].map((digest) => digest.userId))];
  const tokens = await adminDrizzle
    .select({ userId: pushTokens.userId, token: pushTokens.token })
    .from(pushTokens)
    .where(inArray(pushTokens.userId, recipientUserIds));
  const tokensByUserId = new Map<string, string[]>();
  for (const { userId, token } of tokens) {
    tokensByUserId.set(userId, [...(tokensByUserId.get(userId) ?? []), token]);
  }

  const messages: PushMessage[] = [];
  for (const digest of digests.values()) {
    const userTokens = tokensByUserId.get(digest.userId);
    if (!userTokens) continue;
    const t = i18next.getFixedT(localeByUserId.get(digest.userId) ?? "de");
    // Body is just the task name(s), the app icon already says where the push comes from
    const shownNames = digest.taskNames.slice(0, MAX_TASK_NAMES_IN_BODY).join(", ");
    const body = digest.taskNames.length > MAX_TASK_NAMES_IN_BODY ? `${shownNames}, …` : shownNames;
    const title = t("task_due_push.title");
    for (const token of userTokens) {
      messages.push({
        to: token,
        title,
        body,
        data: { type: "tasks_due", farmId: digest.farmId, taskIds: digest.taskIds },
      });
    }
  }
  if (messages.length === 0) return [];

  const tickets = await sendPushMessages(messages);
  const results = messages.map((message, index) => ({ message, ticket: tickets[index] }));
  await adminDrizzle
    .update(pushTokens)
    .set({ lastUsedAt: now })
    .where(
      inArray(
        pushTokens.token,
        messages.map((message) => message.to)
      )
    );
  console.log(`[task-due-cron] sent ${messages.length} push notifications for ${digests.size} digests`);
  return results;
}

export { runTaskDueNotifications };

export function startTaskDueCron(): void {
  // Run daily at 09:00 Zurich time
  cron.schedule(
    "0 9 * * *",
    async () => {
      try {
        await runTaskDueNotifications();
      } catch (err) {
        captureException(err);
        console.error("[task-due-cron] Task due notifications failed:", err);
      }
    },
    { timezone: CRON_TIMEZONE }
  );
}
