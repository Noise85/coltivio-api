import crypto from "crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import createHttpError from "http-errors";
import { adminDrizzle } from "../db/db";
import { emailVerificationTokens, profiles } from "../db/schema";
import { markNewsletterContactVerified } from "../brevo/brevo";
import { sendVerificationEmail, sendWelcomeEmail } from "./user.email";

const TOKEN_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days, a verification mail may sit unread for days
const RESEND_COOLDOWN_MS = 5 * 60 * 1000;

const APP_URL = process.env.APP_URL ?? "https://app.coltivio.ch";
const MEMBERSHIP_URL = `${APP_URL}/membership`;

function verifyUrl(token: string): string {
  return `${APP_URL}/auth/verify?token=${token}`;
}

async function mintToken(userId: string): Promise<string> {
  const token = crypto.randomBytes(32).toString("hex");
  await adminDrizzle.insert(emailVerificationTokens).values({
    userId,
    token,
    expiresAt: new Date(Date.now() + TOKEN_TTL_MS),
  });
  return token;
}

// Claimed conditionally because clients fire several requests at once after login. A failed send keeps
// the timestamp, so a Brevo outage does not turn every request into a retry.
export async function sendVerificationEmailIfNeeded(userId: string): Promise<void> {
  const [profile] = await adminDrizzle
    .update(profiles)
    .set({ verificationHandledAt: new Date() })
    .where(and(eq(profiles.id, userId), eq(profiles.emailVerified, false), isNull(profiles.verificationHandledAt)))
    .returning({ email: profiles.email, fullName: profiles.fullName, locale: profiles.locale });
  if (!profile) return;

  const token = await mintToken(userId);
  await sendVerificationEmail({
    email: profile.email,
    fullName: profile.fullName,
    locale: profile.locale,
    verifyUrl: verifyUrl(token),
  });
}

// Earlier tokens stay valid until the address is confirmed, so the first mail still works after asking
// for a second one.
export async function resendVerificationEmail(userId: string): Promise<void> {
  const profile = await adminDrizzle.query.profiles.findFirst({ where: { id: userId } });
  if (!profile) throw createHttpError(404, "User not found");
  if (profile.emailVerified) throw createHttpError(409, "Email already verified");

  const [latest] = await adminDrizzle
    .select({ createdAt: emailVerificationTokens.createdAt })
    .from(emailVerificationTokens)
    .where(eq(emailVerificationTokens.userId, userId))
    .orderBy(desc(emailVerificationTokens.createdAt))
    .limit(1);

  if (latest && Date.now() - latest.createdAt.getTime() < RESEND_COOLDOWN_MS) {
    throw createHttpError(429, "A verification email was sent recently. Please wait a few minutes.");
  }

  if (!profile.verificationHandledAt) {
    await adminDrizzle.update(profiles).set({ verificationHandledAt: new Date() }).where(eq(profiles.id, userId));
  }

  const token = await mintToken(userId);
  await sendVerificationEmail({
    email: profile.email,
    fullName: profile.fullName,
    locale: profile.locale,
    verifyUrl: verifyUrl(token),
  });
}

// A repeated click on a confirmed address is not an error. On an unconfirmed one, the used token belongs
// to an earlier address of the account.
async function confirmedOrGone(userId: string): Promise<{ verified: true }> {
  const profile = await adminDrizzle.query.profiles.findFirst({ where: { id: userId } });
  if (profile?.emailVerified) return { verified: true };
  throw createHttpError(410, "Verification token already used");
}

// Shared by the verification link and a confirmed address change
async function completeVerification(userId: string): Promise<void> {
  // Used tokens stay, so a second click on the link still answers "verified"
  await adminDrizzle
    .delete(emailVerificationTokens)
    .where(and(eq(emailVerificationTokens.userId, userId), isNull(emailVerificationTokens.usedAt)));

  const profile = await adminDrizzle.query.profiles.findFirst({ where: { id: userId } });
  if (!profile) return;

  // Claimed conditionally, so a second token or a later address change does not resend it
  const [claimedWelcome] = await adminDrizzle
    .update(profiles)
    .set({ welcomeEmailSentAt: new Date() })
    .where(and(eq(profiles.id, profile.id), isNull(profiles.welcomeEmailSentAt)))
    .returning({ id: profiles.id });

  if (claimedWelcome) {
    await sendWelcomeEmail({
      email: profile.email,
      fullName: profile.fullName,
      locale: profile.locale,
      membershipUrl: MEMBERSHIP_URL,
    });
  }

  await markNewsletterContactVerified({ userId: profile.id, email: profile.email });
}

export async function verifyEmailToken(token: string): Promise<{ verified: true }> {
  const row = await adminDrizzle.query.emailVerificationTokens.findFirst({ where: { token } });

  if (!row) throw createHttpError(400, "Invalid verification token");
  if (row.usedAt) return confirmedOrGone(row.userId);
  if (row.expiresAt < new Date()) throw createHttpError(400, "Verification token expired");

  // One transaction, so a concurrent exchange of the same token waits and then sees the confirmed address
  const claimed = await adminDrizzle.transaction(async (tx) => {
    const [claimedToken] = await tx
      .update(emailVerificationTokens)
      .set({ usedAt: new Date() })
      .where(and(eq(emailVerificationTokens.id, row.id), isNull(emailVerificationTokens.usedAt)))
      .returning({ id: emailVerificationTokens.id });
    if (!claimedToken) return false;
    await tx.update(profiles).set({ emailVerified: true }).where(eq(profiles.id, row.userId));
    return true;
  });
  if (!claimed) return confirmedOrGone(row.userId);

  await completeVerification(row.userId);
  return { verified: true };
}

// Supabase changes the address only once the new one is confirmed, so the update_profile trigger keeps the
// account verified and clears verification_handled_at. The first request afterwards finishes the change.
export async function completeAddressChangeIfNeeded(userId: string): Promise<void> {
  const [claimed] = await adminDrizzle
    .update(profiles)
    .set({ verificationHandledAt: new Date() })
    .where(and(eq(profiles.id, userId), eq(profiles.emailVerified, true), isNull(profiles.verificationHandledAt)))
    .returning({ id: profiles.id });
  if (claimed) await completeVerification(userId);
}
