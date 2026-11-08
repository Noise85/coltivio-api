// Shared HTML shell for all transactional emails sent through Brevo.
// Colours are the Coltivio brand palette (assets/colors.pdf, rn-app theme/theme.ts):
// primary teal, sage as the supporting tone, near-black text on an off-white ground.
export const BRAND = {
  primary: "#2a5159",
  sage: "#72aea2",
  accent: "#F4FAFB",
  text: "#212123",
  muted: "#5f6b6d",
  border: "#dde7e9",
  page: "#f6f6f6",
  white: "#ffffff",
} as const;

// Served from the landing page. The wordmark stays live text, so a client that blocks images
// still shows a proper header.
const LOGO_URL = "https://coltivio.ch/logo.png";

export function baseLayout(subtitle: string, content: string): string {
  return `<!DOCTYPE html>
<html lang="de">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:${BRAND.page};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND.page};padding:40px 16px;">
    <tr><td align="center">
      <table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;border-collapse:separate;">
        <tr><td style="background:${BRAND.white};border:1px solid ${BRAND.border};border-bottom:none;border-radius:10px 10px 0 0;padding:26px 40px 22px;">
          <table cellpadding="0" cellspacing="0"><tr>
            <td style="padding-right:12px;vertical-align:middle;">
              <img src="${LOGO_URL}" width="34" height="34" alt="Coltivio" style="display:block;width:34px;height:34px;border:0;">
            </td>
            <td style="vertical-align:middle;">
              <p style="margin:0;font-size:19px;font-weight:600;color:${BRAND.primary};letter-spacing:-.2px;">Coltivio</p>
              <p style="margin:2px 0 0;font-size:13px;color:${BRAND.muted};">${subtitle}</p>
            </td>
          </tr></table>
        </td></tr>
        <tr><td style="background:${BRAND.primary};height:3px;line-height:3px;font-size:0;">&nbsp;</td></tr>
        <tr><td style="background:${BRAND.white};padding:34px 40px;border-left:1px solid ${BRAND.border};border-right:1px solid ${BRAND.border};">${content}</td></tr>
        <tr><td style="background:${BRAND.accent};border:1px solid ${BRAND.border};border-top:none;border-radius:0 0 10px 10px;padding:20px 40px;">
          <p style="margin:0;font-size:12px;color:${BRAND.muted};">Verein AgriColtivio, Via Miadi 25, 6544 Braggio</p>
          <p style="margin:4px 0 0;font-size:12px;color:${BRAND.muted};">
            <a href="mailto:info@coltivio.ch" style="color:${BRAND.primary};text-decoration:none;">info@coltivio.ch</a>
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

// For user-written content that ends up inside the HTML body
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function ctaButton(href: string, label: string): string {
  return `<a href="${href}" style="display:inline-block;background:${BRAND.primary};color:${BRAND.white};font-size:15px;font-weight:600;padding:13px 28px;border-radius:6px;text-decoration:none;">${label}</a>`;
}
