import i18next from "i18next";
import { txEmailApi } from "../brevo/brevo";
import { BRAND, baseLayout } from "../email/layout";

const SENDER = { email: "noreply@app.coltivio.ch", name: "Coltivio" };

function formatCHF(cents: number, locale: string): string {
  return new Intl.NumberFormat(locale, { style: "currency", currency: "CHF" }).format(cents / 100);
}

export type DonationEmailParams = {
  email: string;
  fullName: string | null;
  locale: string;
  amount: number;
};

export async function sendDonationConfirmationEmail(params: DonationEmailParams): Promise<void> {
  const { email, fullName, locale, amount } = params;
  const t = i18next.getFixedT(locale);

  const greeting = fullName ? t("donation_email.greeting", { name: fullName }) : t("donation_email.greeting_anonymous");

  const html = baseLayout(
    t("donation_email.subtitle"),
    `
    <h1 style="margin:0 0 16px;font-size:22px;font-weight:600;color:${BRAND.text};">${greeting}</h1>
    <p style="margin:0 0 28px;font-size:15px;color:${BRAND.text};line-height:1.65;">${t("donation_email.intro")}</p>

    <p style="margin:0 0 10px;font-size:14px;font-weight:600;color:${BRAND.primary};">${t("donation_email.receipt_title")}</p>
    <div style="background:${BRAND.accent};border:1px solid ${BRAND.border};border-left:3px solid ${BRAND.sage};border-radius:6px;padding:20px 24px;">
      <table width="100%" cellpadding="0" cellspacing="0">
        <tr>
          <td style="padding:4px 0;color:${BRAND.muted};font-size:14px;">${t("donation_email.product_name")}</td>
          <td style="padding:4px 0;font-size:14px;text-align:right;color:${BRAND.text};">Coltivio</td>
        </tr>
        <tr><td colspan="2" style="padding:12px 0 4px;"><hr style="border:none;border-top:1px solid ${BRAND.border};margin:0;"></td></tr>
        <tr>
          <td style="padding:4px 0;font-size:15px;font-weight:600;color:${BRAND.text};">${t("donation_email.amount")}</td>
          <td style="padding:4px 0;font-size:15px;font-weight:700;color:${BRAND.primary};text-align:right;">${formatCHF(amount, locale)}</td>
        </tr>
      </table>
    </div>
  `
  );

  await txEmailApi.sendTransacEmail({
    to: [{ email, name: fullName ?? undefined }],
    sender: SENDER,
    subject: t("donation_email.subject"),
    htmlContent: html,
    textContent: [
      greeting,
      "",
      t("donation_email.intro"),
      "",
      `${t("donation_email.amount")}: ${formatCHF(amount, locale)}`,
    ].join("\n"),
  });
}
