import i18next, { TFunction } from "i18next";
import { txEmailApi } from "../brevo/brevo";
import { baseLayout, ctaButton } from "../email/layout";

const SENDER = { email: "noreply@app.coltivio.ch", name: "Coltivio" };

function formatCHF(cents: number, locale: string): string {
  return new Intl.NumberFormat(locale, { style: "currency", currency: "CHF" }).format(cents / 100);
}

function formatDate(date: Date, locale: string): string {
  return date.toLocaleDateString(locale, { day: "2-digit", month: "long", year: "numeric" });
}

function cardLine(label: string, brand: string | null, last4: string | null): string {
  if (!brand || !last4) return "";
  const brandLabel = brand.charAt(0).toUpperCase() + brand.slice(1);
  return `<tr>
    <td style="padding:4px 0;color:#5f6b6d;font-size:14px;">${label}</td>
    <td style="padding:4px 0;font-size:14px;text-align:right;">${brandLabel} ****${last4}</td>
  </tr>`;
}

function featureList(items: string[]): string {
  return items.map((item) => `<li>${item}</li>`).join("");
}

function receiptHtml(
  t: TFunction,
  amount: number,
  periodEnd: Date,
  locale: string,
  cardBrand: string | null,
  cardLast4: string | null
): string {
  return `
    <div style="background:#F4FAFB;border:1px solid #dde7e9;border-radius:10px;padding:20px 24px;margin-bottom:28px;">
      <table width="100%" cellpadding="0" cellspacing="0">
        <tr>
          <td style="padding:4px 0;color:#5f6b6d;font-size:14px;">${t("membership_email.product_name")}</td>
          <td style="padding:4px 0;font-size:14px;text-align:right;">${t("membership_email.product_name")}</td>
        </tr>
        <tr>
          <td style="padding:4px 0;color:#5f6b6d;font-size:14px;">${t("membership_email.valid_until")}</td>
          <td style="padding:4px 0;font-size:14px;text-align:right;">${formatDate(periodEnd, locale)}</td>
        </tr>
        ${cardLine(t("membership_email.payment_method"), cardBrand, cardLast4)}
        <tr><td colspan="2" style="padding:12px 0 4px;"><hr style="border:none;border-top:1px solid #dde7e9;margin:0;"></td></tr>
        <tr>
          <td style="padding:4px 0;font-size:15px;font-weight:600;color:#212123;">${t("membership_email.amount")}</td>
          <td style="padding:4px 0;font-size:15px;font-weight:700;color:#2a5159;text-align:right;">${formatCHF(amount, locale)}</td>
        </tr>
      </table>
    </div>`;
}

// One list of what the membership actually is: a say in the software and support for keeping a
// non-profit tool running. Not a feature unlock, the app is free for everyone.
function welcomeBody(t: TFunction, _locale: string): string {
  const benefits = t("membership_email.new.benefits", { returnObjects: true }) as string[];
  return `
    <p style="margin:0 0 16px;font-size:15px;color:#212123;line-height:1.65;">${t("membership_email.new.welcome")}</p>
    <p style="margin:0 0 24px;font-size:15px;color:#212123;line-height:1.65;">${t("membership_email.new.carried_by_members")}</p>

    <p style="margin:0 0 12px;font-size:15px;font-weight:600;color:#2a5159;">${t("membership_email.new.benefits_title")}</p>
    <ul style="margin:0 0 24px;padding-left:20px;color:#212123;font-size:14px;line-height:1.8;">${featureList(benefits)}</ul>

    <p style="margin:0;font-size:13px;color:#5f6b6d;line-height:1.6;">
      ${t("membership_email.contact_question")} <a href="mailto:info@coltivio.ch" style="color:#2a5159;text-decoration:none;">info@coltivio.ch</a>.
      ${t("membership_email.contact_newsletter")} <a href="https://coltivio.ch" style="color:#2a5159;text-decoration:none;">coltivio.ch</a>.
    </p>`;
}

export type MembershipEmailParams = {
  email: string;
  fullName: string | null;
  locale: string;
  amount: number;
  periodEnd: Date;
  cardBrand: string | null;
  cardLast4: string | null;
};

export async function sendNewMembershipEmail(params: MembershipEmailParams): Promise<void> {
  const { email, fullName, locale, amount, periodEnd, cardBrand, cardLast4 } = params;
  const t = i18next.getFixedT(locale);
  const name = fullName ?? email;

  const html = baseLayout(
    t("membership_email.subtitle"),
    `
    <h1 style="margin:0 0 20px;font-size:24px;font-weight:700;color:#212123;">${t("membership_email.new.greeting", { name })}</h1>
    ${welcomeBody(t, locale)}
    <p style="margin:24px 0 10px;font-size:14px;font-weight:600;color:#212123;">${t("membership_email.new.receipt_title")}</p>
    ${receiptHtml(t, amount, periodEnd, locale, cardBrand, cardLast4)}
  `
  );

  await txEmailApi.sendTransacEmail({
    to: [{ email, name: fullName ?? undefined }],
    sender: SENDER,
    subject: t("membership_email.new.subject"),
    htmlContent: html,
    textContent: [
      t("membership_email.new.greeting", { name }),
      "",
      t("membership_email.new.welcome"),
      t("membership_email.new.carried_by_members"),
      "",
      t("membership_email.new.benefits_title"),
      ...(t("membership_email.new.benefits", { returnObjects: true }) as string[]).map((item) => `- ${item}`),
      "",
      `${t("membership_email.valid_until")}: ${formatDate(periodEnd, locale)}`,
      `${t("membership_email.amount")}: ${formatCHF(amount, locale)}`,
    ].join("\n"),
  });
}

export async function sendFirstPaymentEmail(params: MembershipEmailParams): Promise<void> {
  const { email, fullName, locale, amount, periodEnd, cardBrand, cardLast4 } = params;
  const t = i18next.getFixedT(locale);
  const name = fullName ?? email;

  const html = baseLayout(
    t("membership_email.subtitle"),
    `
    <h1 style="margin:0 0 8px;font-size:24px;font-weight:700;color:#212123;">${t("membership_email.first_payment.greeting", { name })}</h1>
    <p style="margin:0 0 24px;font-size:15px;color:#212123;line-height:1.6;">${t("membership_email.first_payment.intro")}</p>
    <p style="margin:0 0 10px;font-size:14px;font-weight:600;color:#212123;">${t("membership_email.first_payment.receipt_title")}</p>
    ${receiptHtml(t, amount, periodEnd, locale, cardBrand, cardLast4)}
  `
  );

  await txEmailApi.sendTransacEmail({
    to: [{ email, name: fullName ?? undefined }],
    sender: SENDER,
    subject: t("membership_email.first_payment.subject"),
    htmlContent: html,
    textContent: [
      t("membership_email.first_payment.greeting", { name }),
      "",
      t("membership_email.first_payment.intro"),
      "",
      `${t("membership_email.valid_until")}: ${formatDate(periodEnd, locale)}`,
      `${t("membership_email.amount")}: ${formatCHF(amount, locale)}`,
    ].join("\n"),
  });
}

export async function sendRenewalEmail(params: MembershipEmailParams): Promise<void> {
  const { email, fullName, locale, amount, periodEnd, cardBrand, cardLast4 } = params;
  const t = i18next.getFixedT(locale);
  const name = fullName ?? email;

  const html = baseLayout(
    t("membership_email.subtitle"),
    `
    <h1 style="margin:0 0 8px;font-size:24px;font-weight:700;color:#212123;">${t("membership_email.renewal.greeting", { name })}</h1>
    <p style="margin:0 0 24px;font-size:15px;color:#212123;line-height:1.6;">${t("membership_email.renewal.intro")}</p>
    <p style="margin:0 0 10px;font-size:14px;font-weight:600;color:#212123;">${t("membership_email.renewal.receipt_title")}</p>
    ${receiptHtml(t, amount, periodEnd, locale, cardBrand, cardLast4)}
  `
  );

  await txEmailApi.sendTransacEmail({
    to: [{ email, name: fullName ?? undefined }],
    sender: SENDER,
    subject: t("membership_email.renewal.subject"),
    htmlContent: html,
    textContent: [
      t("membership_email.renewal.greeting", { name }),
      "",
      t("membership_email.renewal.intro"),
      "",
      `${t("membership_email.valid_until")}: ${formatDate(periodEnd, locale)}`,
      `${t("membership_email.amount")}: ${formatCHF(amount, locale)}`,
    ].join("\n"),
  });
}

export type ReactivationEmailParams = {
  email: string;
  fullName: string | null;
  locale: string;
  periodEnd: Date;
};

export type ExpiryEmailParams = {
  email: string;
  fullName: string | null;
  locale: string;
  periodEnd: Date;
  renewUrl: string;
};

export async function sendPaymentFailedEmail(params: ExpiryEmailParams): Promise<void> {
  const { email, fullName, locale, periodEnd, renewUrl } = params;
  const t = i18next.getFixedT(locale);
  const name = fullName ?? email;

  const html = baseLayout(
    t("membership_email.subtitle"),
    `
    <h1 style="margin:0 0 16px;font-size:24px;font-weight:700;color:#212123;">${t("membership_email.payment_failed.greeting", { name })}</h1>
    <p style="margin:0 0 24px;font-size:15px;color:#212123;line-height:1.6;">${t("membership_email.payment_failed.intro", { date: formatDate(periodEnd, locale) })}</p>
    ${ctaButton(renewUrl, t("membership_email.payment_failed.cta"))}
  `
  );

  await txEmailApi.sendTransacEmail({
    to: [{ email, name: fullName ?? undefined }],
    sender: SENDER,
    subject: t("membership_email.payment_failed.subject"),
    htmlContent: html,
    textContent: [
      t("membership_email.payment_failed.greeting", { name }),
      "",
      t("membership_email.payment_failed.intro", { date: formatDate(periodEnd, locale) }),
      "",
      renewUrl,
    ].join("\n"),
  });
}

export async function sendExpiryReminderEmail(params: ExpiryEmailParams): Promise<void> {
  const { email, fullName, locale, periodEnd, renewUrl } = params;
  const t = i18next.getFixedT(locale);
  const name = fullName ?? email;

  const html = baseLayout(
    t("membership_email.subtitle"),
    `
    <h1 style="margin:0 0 16px;font-size:24px;font-weight:700;color:#212123;">${t("membership_email.expiry_reminder.greeting", { name })}</h1>
    <p style="margin:0 0 24px;font-size:15px;color:#212123;line-height:1.6;">${t("membership_email.expiry_reminder.intro", { date: formatDate(periodEnd, locale) })}</p>
    ${ctaButton(renewUrl, t("membership_email.expiry_reminder.cta"))}
  `
  );

  await txEmailApi.sendTransacEmail({
    to: [{ email, name: fullName ?? undefined }],
    sender: SENDER,
    subject: t("membership_email.expiry_reminder.subject"),
    htmlContent: html,
    textContent: [
      t("membership_email.expiry_reminder.greeting", { name }),
      "",
      t("membership_email.expiry_reminder.intro", { date: formatDate(periodEnd, locale) }),
      "",
      renewUrl,
    ].join("\n"),
  });
}

export async function sendAccessLostEmail(params: ExpiryEmailParams): Promise<void> {
  const { email, fullName, locale, periodEnd, renewUrl } = params;
  const t = i18next.getFixedT(locale);
  const name = fullName ?? email;

  const html = baseLayout(
    t("membership_email.subtitle"),
    `
    <h1 style="margin:0 0 16px;font-size:24px;font-weight:700;color:#212123;">${t("membership_email.access_lost.greeting", { name })}</h1>
    <p style="margin:0 0 24px;font-size:15px;color:#212123;line-height:1.6;">${t("membership_email.access_lost.intro", { date: formatDate(periodEnd, locale) })}</p>
    ${ctaButton(renewUrl, t("membership_email.access_lost.cta"))}
  `
  );

  await txEmailApi.sendTransacEmail({
    to: [{ email, name: fullName ?? undefined }],
    sender: SENDER,
    subject: t("membership_email.access_lost.subject"),
    htmlContent: html,
    textContent: [
      t("membership_email.access_lost.greeting", { name }),
      "",
      t("membership_email.access_lost.intro", { date: formatDate(periodEnd, locale) }),
      "",
      renewUrl,
    ].join("\n"),
  });
}

export async function sendMembershipEndedEmail(params: ExpiryEmailParams): Promise<void> {
  const { email, fullName, locale, periodEnd: _periodEnd, renewUrl } = params;
  const t = i18next.getFixedT(locale);
  const name = fullName ?? email;

  const html = baseLayout(
    t("membership_email.subtitle"),
    `
    <h1 style="margin:0 0 16px;font-size:24px;font-weight:700;color:#212123;">${t("membership_email.membership_ended.greeting", { name })}</h1>
    <p style="margin:0 0 24px;font-size:15px;color:#212123;line-height:1.6;">${t("membership_email.membership_ended.intro")}</p>
    <a href="${renewUrl}" style="font-size:14px;color:#2a5159;text-decoration:underline;">${t("membership_email.membership_ended.cta")}</a>
  `
  );

  await txEmailApi.sendTransacEmail({
    to: [{ email, name: fullName ?? undefined }],
    sender: SENDER,
    subject: t("membership_email.membership_ended.subject"),
    htmlContent: html,
    textContent: [
      t("membership_email.membership_ended.greeting", { name }),
      "",
      t("membership_email.membership_ended.intro"),
      "",
      renewUrl,
    ].join("\n"),
  });
}

export type CancellationEmailParams = {
  email: string;
  fullName: string | null;
  locale: string;
  periodEnd: Date;
  reactivateUrl: string;
};

export async function sendCancellationEmail(params: CancellationEmailParams): Promise<void> {
  const { email, fullName, locale, periodEnd, reactivateUrl } = params;
  const t = i18next.getFixedT(locale);
  const name = fullName ?? email;

  const html = baseLayout(
    t("membership_email.subtitle"),
    `
    <h1 style="margin:0 0 16px;font-size:24px;font-weight:700;color:#212123;">${t("membership_email.cancellation.greeting", { name })}</h1>
    <p style="margin:0 0 16px;font-size:15px;color:#212123;line-height:1.6;">${t("membership_email.cancellation.intro", { date: formatDate(periodEnd, locale) })}</p>
    <p style="margin:0 0 24px;font-size:14px;color:#5f6b6d;line-height:1.6;">${t("membership_email.cancellation.reactivate_hint")}</p>
    ${ctaButton(reactivateUrl, t("membership_email.cancellation.cta"))}
  `
  );

  await txEmailApi.sendTransacEmail({
    to: [{ email, name: fullName ?? undefined }],
    sender: SENDER,
    subject: t("membership_email.cancellation.subject"),
    htmlContent: html,
    textContent: [
      t("membership_email.cancellation.greeting", { name }),
      "",
      t("membership_email.cancellation.intro", { date: formatDate(periodEnd, locale) }),
      "",
      t("membership_email.cancellation.reactivate_hint"),
      "",
      reactivateUrl,
    ].join("\n"),
  });
}

export async function sendReactivationEmail(params: ReactivationEmailParams): Promise<void> {
  const { email, fullName, locale, periodEnd } = params;
  const t = i18next.getFixedT(locale);
  const name = fullName ?? email;

  const html = baseLayout(
    t("membership_email.subtitle"),
    `
    <h1 style="margin:0 0 8px;font-size:24px;font-weight:700;color:#212123;">${t("membership_email.reactivation.greeting", { name })}</h1>
    <p style="margin:0;font-size:15px;color:#212123;line-height:1.6;">
      ${t("membership_email.reactivation.intro", { date: formatDate(periodEnd, locale) })}
    </p>
  `
  );

  await txEmailApi.sendTransacEmail({
    to: [{ email, name: fullName ?? undefined }],
    sender: SENDER,
    subject: t("membership_email.reactivation.subject"),
    htmlContent: html,
    textContent: [
      t("membership_email.reactivation.greeting", { name }),
      "",
      t("membership_email.reactivation.intro", { date: formatDate(periodEnd, locale) }),
    ].join("\n"),
  });
}
