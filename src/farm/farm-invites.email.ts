import { TFunction } from "i18next";
import { txEmailApi } from "../brevo/brevo";

export async function sendFarmInviteEmail(email: string, code: string, farmName: string, t: TFunction) {
  if (process.env.NODE_ENV !== "production") return;
  const subject = t("farm_invite.subject", { farmName });
  const body = t("farm_invite.body", { farmName });
  const codeLabel = t("farm_invite.code_label");
  const expiry = t("farm_invite.expiry");
  await txEmailApi.sendTransacEmail({
    to: [{ email }],
    sender: { email: "noreply@app.coltivio.ch", name: "Coltivio" },
    subject,
    textContent: `${codeLabel}: ${code}\n\n${expiry}`,
    htmlContent: `<p>${body}</p><p>${codeLabel}: <strong>${code}</strong></p><p>${expiry}</p>`,
  });
}
