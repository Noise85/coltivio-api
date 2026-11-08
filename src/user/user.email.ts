import i18next from "i18next";
import { txEmailApi } from "../brevo/brevo";
import { BRAND, baseLayout, ctaButton } from "../email/layout";

const SENDER = { email: "noreply@app.coltivio.ch", name: "Coltivio" };

export type VerificationEmailParams = {
  email: string;
  fullName: string | null;
  locale: string;
  verifyUrl: string;
};

export type WelcomeEmailParams = {
  email: string;
  fullName: string | null;
  locale: string;
  membershipUrl: string;
};

export async function sendVerificationEmail(params: VerificationEmailParams): Promise<void> {
  const { email, fullName, locale, verifyUrl } = params;
  const t = i18next.getFixedT(locale);
  const name = fullName ?? email;

  const html = baseLayout(
    t("verification_email.subtitle"),
    `
    <h1 style="margin:0 0 16px;font-size:22px;font-weight:600;color:${BRAND.text};">${t("verification_email.greeting", { name })}</h1>
    <p style="margin:0 0 28px;font-size:15px;color:${BRAND.text};line-height:1.65;">${t("verification_email.intro")}</p>
    ${ctaButton(verifyUrl, t("verification_email.cta"))}
    <p style="margin:28px 0 0;font-size:13px;color:${BRAND.muted};line-height:1.6;">${t("verification_email.expiry_note")}</p>
    <p style="margin:6px 0 0;font-size:13px;color:${BRAND.muted};line-height:1.6;">${t("verification_email.ignore_note")}</p>
  `
  );

  await txEmailApi.sendTransacEmail({
    to: [{ email, name: fullName ?? undefined }],
    sender: SENDER,
    subject: t("verification_email.subject"),
    htmlContent: html,
    textContent: [
      t("verification_email.greeting", { name }),
      "",
      t("verification_email.intro"),
      "",
      verifyUrl,
      "",
      t("verification_email.expiry_note"),
      t("verification_email.ignore_note"),
    ].join("\n"),
  });
}

export async function sendWelcomeEmail(params: WelcomeEmailParams): Promise<void> {
  const { email, fullName, locale, membershipUrl } = params;
  const t = i18next.getFixedT(locale);
  const name = fullName ?? email;

  const html = baseLayout(
    t("welcome_email.subtitle"),
    `
    <h1 style="margin:0 0 16px;font-size:22px;font-weight:600;color:${BRAND.text};">${t("welcome_email.greeting", { name })}</h1>
    <p style="margin:0 0 28px;font-size:15px;color:${BRAND.text};line-height:1.65;">${t("welcome_email.intro")}</p>

    <p style="margin:0 0 8px;font-size:15px;font-weight:600;color:${BRAND.primary};">${t("welcome_email.verein_title")}</p>
    <p style="margin:0 0 12px;font-size:14px;color:${BRAND.text};line-height:1.7;">${t("welcome_email.verein_body")}</p>
    <p style="margin:0 0 28px;font-size:14px;color:${BRAND.muted};line-height:1.7;">${t("welcome_email.open_source")}</p>

    <div style="background:${BRAND.accent};border:1px solid ${BRAND.border};border-left:3px solid ${BRAND.sage};border-radius:6px;padding:22px 24px;margin-bottom:28px;">
      <p style="margin:0 0 8px;font-size:15px;font-weight:600;color:${BRAND.primary};">${t("welcome_email.membership_title")}</p>
      <p style="margin:0 0 12px;font-size:14px;color:${BRAND.text};line-height:1.7;">${t("welcome_email.membership_body")}</p>
      <p style="margin:0 0 18px;font-size:14px;font-weight:600;color:${BRAND.text};">${t("welcome_email.membership_price")}</p>
      ${ctaButton(membershipUrl, t("welcome_email.membership_cta"))}
    </div>

    <p style="margin:0;font-size:13px;color:${BRAND.muted};line-height:1.6;">
      ${t("welcome_email.contact")} <a href="mailto:info@coltivio.ch" style="color:${BRAND.primary};text-decoration:none;">info@coltivio.ch</a>.
    </p>
  `
  );

  await txEmailApi.sendTransacEmail({
    to: [{ email, name: fullName ?? undefined }],
    sender: SENDER,
    subject: t("welcome_email.subject"),
    htmlContent: html,
    textContent: [
      t("welcome_email.greeting", { name }),
      "",
      t("welcome_email.intro"),
      "",
      t("welcome_email.verein_title"),
      t("welcome_email.verein_body"),
      t("welcome_email.open_source"),
      "",
      t("welcome_email.membership_title"),
      t("welcome_email.membership_body"),
      t("welcome_email.membership_price"),
      membershipUrl,
    ].join("\n"),
  });
}
