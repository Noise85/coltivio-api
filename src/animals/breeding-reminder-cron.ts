import cron from "node-cron";
import i18next from "i18next";
import { and, eq, gte, inArray, isNotNull, isNull, or } from "drizzle-orm";
import { captureException } from "@sentry/node";
import { addUtcDays } from "../date-utils";
import { adminDrizzle } from "../db/db";
import {
  animalHeats,
  animals,
  breedingReminderNotifications,
  farmGestationSettings,
  farmMemberPermissions,
  farmMembers,
  profiles,
  pushTokens,
  userSettings,
} from "../db/schema";
import { sendPushMessages } from "../push/push";
import { PushMessage, PushTicket } from "../push/expo-client";
import { CRON_TIMEZONE, zurichDateString } from "../tasks/task-due-cron";
import { resolveHeatOutcomes } from "./breeding";
import { DEFAULT_GESTATION_DAYS } from "./gestation-defaults";

const MAX_ANIMAL_NAMES_IN_BODY = 3;
// Longest gestation length the settings endpoint accepts, bounds the heat query
const MAX_GESTATION_DAYS_LOOKBACK = 500;
// Days a missed reminder is still sent after its offset day (never after the expected birth)
const REMINDER_CATCH_UP_DAYS = 3;

export type BreedingReminderSendResult = { message: PushMessage; ticket: PushTicket };

// Sends one push per (user, farm, days until birth) listing the animals expected to give birth in that many days.
// Recipients are farm owners and members with animals access who configured at least one reminder offset.
async function runBreedingReminderNotifications(now: Date = new Date()): Promise<BreedingReminderSendResult[]> {
  const todayString = zurichDateString(now);
  const today = new Date(`${todayString}T00:00:00Z`);

  const optedInUsers = await adminDrizzle
    .select({
      userId: userSettings.userId,
      locale: profiles.locale,
      daysBefore1: userSettings.breedingReminderDaysBefore1,
      daysBefore2: userSettings.breedingReminderDaysBefore2,
    })
    .from(userSettings)
    .innerJoin(profiles, eq(profiles.id, userSettings.userId))
    .where(
      or(isNotNull(userSettings.breedingReminderDaysBefore1), isNotNull(userSettings.breedingReminderDaysBefore2))
    );
  if (optedInUsers.length === 0) return [];
  const optedInUserIds = optedInUsers.map((user) => user.userId);

  const [members, animalPermissions] = await Promise.all([
    adminDrizzle
      .select({ farmId: farmMembers.farmId, userId: farmMembers.userId, role: farmMembers.role })
      .from(farmMembers)
      .where(inArray(farmMembers.userId, optedInUserIds)),
    adminDrizzle
      .select({ farmId: farmMemberPermissions.farmId, userId: farmMemberPermissions.userId })
      .from(farmMemberPermissions)
      .where(
        and(
          inArray(farmMemberPermissions.userId, optedInUserIds),
          eq(farmMemberPermissions.feature, "animals"),
          inArray(farmMemberPermissions.access, ["read", "write"])
        )
      ),
  ]);
  const memberKey = (farmId: string, userId: string) => `${farmId}:${userId}`;
  const usersWithAnimalAccess = new Set(
    animalPermissions.map((permission) => memberKey(permission.farmId, permission.userId))
  );
  const recipientMembers = members.filter(
    (member) => member.role === "owner" || usersWithAnimalAccess.has(memberKey(member.farmId, member.userId))
  );
  if (recipientMembers.length === 0) return [];
  const farmIds = [...new Set(recipientMembers.map((member) => member.farmId))];

  // All heats, not only mated ones: a later heat shows that an earlier mating didn't work
  const [recentHeats, gestationSettings] = await Promise.all([
    adminDrizzle
      .select({
        id: animalHeats.id,
        animalId: animalHeats.animalId,
        farmId: animalHeats.farmId,
        date: animalHeats.date,
        mated: animalHeats.mated,
        animalName: animals.name,
        animalType: animals.type,
      })
      .from(animalHeats)
      .innerJoin(animals, eq(animals.id, animalHeats.animalId))
      .where(
        and(
          inArray(animalHeats.farmId, farmIds),
          isNull(animals.dateOfDeath),
          gte(animalHeats.date, addUtcDays(today, -MAX_GESTATION_DAYS_LOOKBACK))
        )
      ),
    adminDrizzle.select().from(farmGestationSettings).where(inArray(farmGestationSettings.farmId, farmIds)),
  ]);
  if (recentHeats.length === 0) return [];

  const gestationDaysByFarmAndType = new Map(
    gestationSettings.map((setting) => [`${setting.farmId}:${setting.animalType}`, setting.gestationDays])
  );
  const outcomes = resolveHeatOutcomes(
    recentHeats,
    (heat) =>
      gestationDaysByFarmAndType.get(`${heat.farmId}:${heat.animalType}`) ?? DEFAULT_GESTATION_DAYS[heat.animalType]
  );
  // Days from today until the expected birth, for matings that are still expected to lead to a birth
  const heatsWithDaysUntilBirth = recentHeats.flatMap((heat) => {
    const expectedBirthDate = outcomes.get(heat.id)?.expectedBirthDate;
    if (!expectedBirthDate) return [];
    const daysUntilBirth = Math.round((expectedBirthDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
    if (daysUntilBirth < 0) return [];
    return [{ heatId: heat.id, farmId: heat.farmId, animalName: heat.animalName, expectedBirthDate, daysUntilBirth }];
  });

  // A reminder is due from its offset day on and is caught up for a few days, e.g. when the cron didn't run
  // or the push failed, or when the offset was set after its day had already passed. reminderDate is the
  // offset day itself, so each offset is sent at most once per user and mating.
  const userById = new Map(optedInUsers.map((user) => [user.userId, user]));
  const candidates: {
    heatId: string;
    userId: string;
    reminderDate: Date;
    farmId: string;
    daysUntilBirth: number;
  }[] = [];
  for (const member of recipientMembers) {
    const user = userById.get(member.userId);
    if (!user) continue;
    const offsets = new Set([user.daysBefore1, user.daysBefore2].filter((offset) => offset !== null));
    for (const heat of heatsWithDaysUntilBirth) {
      if (heat.farmId !== member.farmId) continue;
      for (const offset of offsets) {
        const daysLate = offset - heat.daysUntilBirth;
        if (daysLate < 0 || daysLate > REMINDER_CATCH_UP_DAYS) continue;
        candidates.push({
          heatId: heat.heatId,
          userId: member.userId,
          reminderDate: addUtcDays(heat.expectedBirthDate, -offset),
          farmId: heat.farmId,
          daysUntilBirth: heat.daysUntilBirth,
        });
      }
    }
  }
  if (candidates.length === 0) return [];

  // Claim notifications first — only rows actually inserted get sent, so reruns and parallel instances don't double-notify
  const claimKey = (heatId: string, userId: string, reminderDate: Date) =>
    `${heatId}:${userId}:${reminderDate.toISOString().slice(0, 10)}`;
  const claimed = await adminDrizzle
    .insert(breedingReminderNotifications)
    .values(candidates.map(({ heatId, userId, reminderDate }) => ({ heatId, userId, reminderDate })))
    .onConflictDoNothing()
    .returning({
      heatId: breedingReminderNotifications.heatId,
      userId: breedingReminderNotifications.userId,
      reminderDate: breedingReminderNotifications.reminderDate,
    });
  if (claimed.length === 0) return [];
  const claimedKeys = new Set(claimed.map((claim) => claimKey(claim.heatId, claim.userId, claim.reminderDate)));

  const heatById = new Map(heatsWithDaysUntilBirth.map((heat) => [heat.heatId, heat]));
  const digests = new Map<
    string,
    {
      userId: string;
      farmId: string;
      daysUntilBirth: number;
      heatIds: string[];
      animalNames: string[];
      claims: { heatId: string; userId: string; reminderDate: Date }[];
    }
  >();
  for (const candidate of candidates) {
    if (!claimedKeys.has(claimKey(candidate.heatId, candidate.userId, candidate.reminderDate))) continue;
    const heat = heatById.get(candidate.heatId);
    if (!heat) continue;
    const digestKey = `${candidate.farmId}:${candidate.userId}:${candidate.daysUntilBirth}`;
    const digest = digests.get(digestKey) ?? {
      userId: candidate.userId,
      farmId: candidate.farmId,
      daysUntilBirth: candidate.daysUntilBirth,
      heatIds: [],
      animalNames: [],
      claims: [],
    };
    digest.claims.push({ heatId: candidate.heatId, userId: candidate.userId, reminderDate: candidate.reminderDate });
    // Two offsets caught up on the same day still mention the animal once
    if (!digest.heatIds.includes(heat.heatId)) {
      digest.heatIds.push(heat.heatId);
      digest.animalNames.push(heat.animalName);
    }
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
  // Digest of each message, to release the claims of digests whose pushes all failed
  const messageDigestKeys: string[] = [];
  for (const [digestKey, digest] of digests) {
    const userTokens = tokensByUserId.get(digest.userId);
    if (!userTokens) continue;
    const t = i18next.getFixedT(userById.get(digest.userId)?.locale ?? "de");
    const shownNames = digest.animalNames.slice(0, MAX_ANIMAL_NAMES_IN_BODY).join(", ");
    const names = digest.animalNames.length > MAX_ANIMAL_NAMES_IN_BODY ? `${shownNames}, …` : shownNames;
    const body =
      digest.daysUntilBirth === 0
        ? t("breeding_reminder_push.body_today", { names })
        : digest.daysUntilBirth === 1
          ? t("breeding_reminder_push.body_tomorrow", { names })
          : t("breeding_reminder_push.body_in_days", { names, days: digest.daysUntilBirth });
    const title = t("breeding_reminder_push.title");
    for (const token of userTokens) {
      messages.push({
        to: token,
        title,
        body,
        data: { type: "breeding_due", farmId: digest.farmId, heatIds: digest.heatIds },
      });
      messageDigestKeys.push(digestKey);
    }
  }
  if (messages.length === 0) return [];

  const tickets = await sendPushMessages(messages);
  const results = messages.map((message, index) => ({ message, ticket: tickets[index] }));

  // Not a single push of the digest went out: release its claims so the next run catches it up
  const deliveredDigestKeys = new Set(messageDigestKeys.filter((_digestKey, index) => tickets[index]?.status === "ok"));
  for (const [digestKey, digest] of digests) {
    if (!messageDigestKeys.includes(digestKey) || deliveredDigestKeys.has(digestKey)) continue;
    for (const claim of digest.claims) {
      await adminDrizzle
        .delete(breedingReminderNotifications)
        .where(
          and(
            eq(breedingReminderNotifications.heatId, claim.heatId),
            eq(breedingReminderNotifications.userId, claim.userId),
            eq(breedingReminderNotifications.reminderDate, claim.reminderDate)
          )
        );
    }
  }
  await adminDrizzle
    .update(pushTokens)
    .set({ lastUsedAt: now })
    .where(
      inArray(
        pushTokens.token,
        messages.map((message) => message.to)
      )
    );
  console.log(`[breeding-reminder-cron] sent ${messages.length} push notifications for ${digests.size} digests`);
  return results;
}

export { runBreedingReminderNotifications };

export function startBreedingReminderCron(): void {
  // Run daily at 09:00 Zurich time
  cron.schedule(
    "0 9 * * *",
    async () => {
      try {
        await runBreedingReminderNotifications();
      } catch (err) {
        captureException(err);
        console.error("[breeding-reminder-cron] Breeding reminder notifications failed:", err);
      }
    },
    { timezone: CRON_TIMEZONE }
  );
}
