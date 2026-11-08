import nodemailer from "nodemailer";
import { eq } from "drizzle-orm";
import { adminDrizzle } from "../db/db";
import { wikiModerators, profiles } from "../db/schema";

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT ?? 587),
  secure: process.env.SMTP_SECURE === "true",
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

export async function notifyModeratorsNewReview(
  changeRequestId: string,
  type: "new_entry" | "change_request"
): Promise<void> {
  if (process.env.NODE_ENV !== "production") return;
  if (!process.env.SMTP_HOST) return;

  // Fetch all moderators joined with their profile email
  const moderatorRows = await adminDrizzle
    .select({ email: profiles.email })
    .from(wikiModerators)
    .innerJoin(profiles, eq(wikiModerators.userId, profiles.id));

  if (moderatorRows.length === 0) return;

  const bccAddresses = moderatorRows.map((r) => r.email);
  const subject = type === "new_entry" ? "New wiki entry awaiting review" : "Wiki change request awaiting review";

  const reviewUrl = `${process.env.APP_URL ?? ""}/wiki/moderation/${changeRequestId}`;
  const typeLabel = type === "new_entry" ? "new entry" : "change request";

  await transporter.sendMail({
    from: process.env.SMTP_FROM ?? process.env.SMTP_USER,
    bcc: bccAddresses,
    subject,
    text: `A ${typeLabel} (ID: ${changeRequestId}) is now under review.\n\nReview it here: ${reviewUrl}`,
    html: `<p>A ${typeLabel} is now under review.</p><p><a href="${reviewUrl}">Open review #${changeRequestId}</a></p>`,
  });
}
