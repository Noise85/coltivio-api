import cron from "node-cron";
import { and, eq, gt, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { captureException } from "@sentry/node";
import { adminDrizzle } from "../db/db";
import { membershipExpiryNotifications, membershipPayments, userSubscriptions } from "../db/schema";
import { sendAccessLostEmail, sendExpiryReminderEmail, sendMembershipEndedEmail } from "./membership.email";

const TEN_DAYS_MS = 10 * 24 * 60 * 60 * 1000;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const RENEW_URL = `${process.env.APP_URL ?? "https://app.coltivio.ch"}/membership`;

// Subquery: returns the max(periodEnd) per user for succeeded payments.
// Used as a base for all three cron passes.
function buildLatestPaymentSubquery() {
  return adminDrizzle
    .select({
      // Payments of deleted accounts stay as anonymous rows, the where clause drops them: nobody to remind
      userId: sql<string>`${membershipPayments.userId}`.as("payer_id"),
      maxPeriodEnd: sql<Date>`max(${membershipPayments.periodEnd})`.as("max_period_end"),
    })
    .from(membershipPayments)
    .where(and(eq(membershipPayments.status, "succeeded"), isNotNull(membershipPayments.userId)))
    .groupBy(membershipPayments.userId)
    .as("lp");
}

// Pass 1: manual expiry day 0 — latest periodEnd is in (tenDaysAgo, now), no subscription, no prior notification
async function runExpiryReminderPass(now: Date): Promise<void> {
  const tenDaysAgo = new Date(now.getTime() - TEN_DAYS_MS);
  const lp = buildLatestPaymentSubquery();

  // Use sql template with ISO strings to avoid postgres.js raw-Date serialization issue
  // on sql<Date> subquery columns (which lose their column type encoder).
  const candidates = await adminDrizzle
    .select({ userId: lp.userId, periodEnd: lp.maxPeriodEnd })
    .from(lp)
    .leftJoin(userSubscriptions, eq(userSubscriptions.userId, lp.userId))
    .where(
      and(
        lt(lp.maxPeriodEnd, sql`${now.toISOString()}::timestamp`),
        gt(lp.maxPeriodEnd, sql`${tenDaysAgo.toISOString()}::timestamp`),
        isNull(userSubscriptions.id) // manual payment only (no auto-renewing subscription)
      )
    );

  for (const candidate of candidates) {
    // max() aggregate loses Drizzle's column decoder — coerce back to Date
    const periodEnd = new Date(candidate.periodEnd);

    const latestPayment = await adminDrizzle.query.membershipPayments.findFirst({
      where: { userId: candidate.userId, status: "succeeded" },
      orderBy: { periodEnd: "desc" },
    });
    if (latestPayment?.cancelledByUser) continue;

    // Skip if payment_failed or expiry_reminder was already sent for this period
    const existing = await adminDrizzle.query.membershipExpiryNotifications.findFirst({
      where: {
        userId: candidate.userId,
        periodEndDate: { eq: periodEnd },
        type: { in: ["payment_failed", "expiry_reminder"] },
      },
    });
    if (existing) continue;

    const inserted = await adminDrizzle
      .insert(membershipExpiryNotifications)
      .values({ userId: candidate.userId, periodEndDate: periodEnd, type: "expiry_reminder" })
      .onConflictDoNothing()
      .returning({ id: membershipExpiryNotifications.id });
    if (inserted.length === 0) continue;

    const profile = await adminDrizzle.query.profiles.findFirst({ where: { id: candidate.userId } });
    if (!profile) continue;

    await sendExpiryReminderEmail({
      email: profile.email,
      fullName: profile.fullName,
      locale: profile.locale,
      periodEnd,
      renewUrl: RENEW_URL,
    });
    console.log(`[membership-cron] expiry_reminder sent to ${profile.email}`);
  }
}

// Pass 2: access lost day +10 — latest periodEnd was (thirtyDaysAgo, tenDaysAgo), no access_lost notification yet
async function runAccessLostPass(now: Date): Promise<void> {
  const tenDaysAgo = new Date(now.getTime() - TEN_DAYS_MS);
  const thirtyDaysAgo = new Date(now.getTime() - THIRTY_DAYS_MS);
  const lp = buildLatestPaymentSubquery();

  const candidates = await adminDrizzle
    .select({ userId: lp.userId, periodEnd: lp.maxPeriodEnd })
    .from(lp)
    .where(
      and(
        lt(lp.maxPeriodEnd, sql`${tenDaysAgo.toISOString()}::timestamp`),
        gt(lp.maxPeriodEnd, sql`${thirtyDaysAgo.toISOString()}::timestamp`)
      )
    );

  for (const candidate of candidates) {
    const periodEnd = new Date(candidate.periodEnd);

    const latestPayment = await adminDrizzle.query.membershipPayments.findFirst({
      where: { userId: candidate.userId, status: "succeeded" },
      orderBy: { periodEnd: "desc" },
    });
    if (latestPayment?.cancelledByUser) continue;

    const existing = await adminDrizzle.query.membershipExpiryNotifications.findFirst({
      where: { userId: candidate.userId, periodEndDate: { eq: periodEnd }, type: "access_lost" },
    });
    if (existing) continue;

    const inserted = await adminDrizzle
      .insert(membershipExpiryNotifications)
      .values({ userId: candidate.userId, periodEndDate: periodEnd, type: "access_lost" })
      .onConflictDoNothing()
      .returning({ id: membershipExpiryNotifications.id });
    if (inserted.length === 0) continue;

    const profile = await adminDrizzle.query.profiles.findFirst({ where: { id: candidate.userId } });
    if (!profile) continue;

    await sendAccessLostEmail({
      email: profile.email,
      fullName: profile.fullName,
      locale: profile.locale,
      periodEnd,
      renewUrl: RENEW_URL,
    });
    console.log(`[membership-cron] access_lost sent to ${profile.email}`);
  }
}

// Pass 3: membership ended day +30 — latest periodEnd was before thirtyDaysAgo, no membership_ended notification yet
async function runMembershipEndedPass(now: Date): Promise<void> {
  const thirtyDaysAgo = new Date(now.getTime() - THIRTY_DAYS_MS);
  const lp = buildLatestPaymentSubquery();

  const candidates = await adminDrizzle
    .select({ userId: lp.userId, periodEnd: lp.maxPeriodEnd })
    .from(lp)
    .where(lt(lp.maxPeriodEnd, sql`${thirtyDaysAgo.toISOString()}::timestamp`));

  for (const candidate of candidates) {
    const periodEnd = new Date(candidate.periodEnd);

    const latestPayment = await adminDrizzle.query.membershipPayments.findFirst({
      where: { userId: candidate.userId, status: "succeeded" },
      orderBy: { periodEnd: "desc" },
    });
    if (latestPayment?.cancelledByUser) continue;

    const existing = await adminDrizzle.query.membershipExpiryNotifications.findFirst({
      where: { userId: candidate.userId, periodEndDate: { eq: periodEnd }, type: "membership_ended" },
    });
    if (existing) continue;

    const inserted = await adminDrizzle
      .insert(membershipExpiryNotifications)
      .values({ userId: candidate.userId, periodEndDate: periodEnd, type: "membership_ended" })
      .onConflictDoNothing()
      .returning({ id: membershipExpiryNotifications.id });
    if (inserted.length === 0) continue;

    const profile = await adminDrizzle.query.profiles.findFirst({ where: { id: candidate.userId } });
    if (!profile) continue;

    await sendMembershipEndedEmail({
      email: profile.email,
      fullName: profile.fullName,
      locale: profile.locale,
      periodEnd,
      renewUrl: RENEW_URL,
    });
    console.log(`[membership-cron] membership_ended sent to ${profile.email}`);
  }
}

async function runExpiryNotifications(): Promise<void> {
  const now = new Date();
  await runExpiryReminderPass(now);
  await runAccessLostPass(now);
  await runMembershipEndedPass(now);
}

export { runExpiryNotifications };

export function startMembershipExpiryCron(): void {
  // Run daily at 08:00 UTC
  cron.schedule("0 8 * * *", async () => {
    try {
      await runExpiryNotifications();
    } catch (err) {
      captureException(err);
      console.error("[membership-cron] Expiry notifications failed:", err);
    }
  });
}
