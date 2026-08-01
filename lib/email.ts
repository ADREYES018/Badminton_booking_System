/**
 * Transactional email, wrapped so the rest of the app never touches Resend
 * directly.
 *
 * With no RESEND_API_KEY set, messages are logged to the console instead of
 * sent — local development needs no third-party account, and tests never post
 * to the network.
 */

const RESEND_ENDPOINT = "https://api.resend.com/emails";

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export function appUrl(): string {
  return Deno.env.get("APP_URL") ?? "http://localhost:8000";
}

function fromAddress(): string {
  return Deno.env.get("EMAIL_FROM") ?? "Smash Club <onboarding@resend.dev>";
}

export async function sendEmail(message: EmailMessage): Promise<void> {
  const apiKey = Deno.env.get("RESEND_API_KEY");

  if (!apiKey) {
    console.info(
      `\n[email] to=${message.to}\n[email] subject=${message.subject}\n${message.text}\n`,
    );
    return;
  }

  const response = await fetch(RESEND_ENDPOINT, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: fromAddress(),
      to: [message.to],
      subject: message.subject,
      html: message.html,
      text: message.text,
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(
      `Resend rejected the message (${response.status}): ${detail}`,
    );
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * Shared shell. Inline styles only — email clients strip stylesheets, and the
 * palette mirrors the app's tokens.
 */
function layout(heading: string, bodyHtml: string): string {
  return `<!doctype html>
<html>
  <body style="margin:0;padding:24px;background:#f9fbe7;font-family:'Hanken Grotesk',Helvetica,Arial,sans-serif;color:#1a1d11;">
    <div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:16px;padding:32px;">
      <div style="font-size:13px;letter-spacing:0.12em;text-transform:uppercase;color:#506600;font-weight:700;">Smash Club</div>
      <h1 style="font-size:24px;line-height:1.2;margin:12px 0 16px;color:#1a1d11;">${
    escapeHtml(heading)
  }</h1>
      ${bodyHtml}
    </div>
    <p style="max-width:520px;margin:16px auto 0;font-size:12px;color:#444934;">
      You are receiving this because you play with Smash Club.
    </p>
  </body>
</html>`;
}

function button(href: string, label: string): string {
  return `<a href="${href}" style="display:inline-block;background:#c6f432;color:#161f00;text-decoration:none;font-weight:700;padding:14px 28px;border-radius:999px;margin:8px 0 16px;">${
    escapeHtml(label)
  }</a>`;
}

export function magicLinkEmail(
  to: string,
  token: string,
  redirectTo?: string,
): EmailMessage {
  const url = new URL("/auth/verify", appUrl());
  url.searchParams.set("token", token);
  if (redirectTo) url.searchParams.set("next", redirectTo);
  const link = url.toString();

  return {
    to,
    subject: "Your Smash Club sign-in link",
    html: layout(
      "Sign in to Smash Club",
      `<p style="font-size:16px;line-height:1.6;margin:0 0 8px;">Tap the button below to sign in. The link works once and expires in 15 minutes.</p>
       ${button(link, "Sign in")}
       <p style="font-size:13px;color:#444934;margin:0;">If the button does not work, paste this into your browser:<br>
       <span style="word-break:break-all;color:#506600;">${
        escapeHtml(link)
      }</span></p>
       <p style="font-size:13px;color:#444934;margin:16px 0 0;">Did not request this? Ignore this email and nothing will happen.</p>`,
    ),
    text: [
      "Sign in to Smash Club",
      "",
      "Open this link to sign in. It works once and expires in 15 minutes:",
      link,
      "",
      "Did not request this? Ignore this email.",
    ].join("\n"),
  };
}

/** WhatsApp deep link, used instead of the paid Business API. */
export function whatsappLink(phoneE164: string, message: string): string {
  const number = phoneE164.replace(/\D/g, "");
  return `https://wa.me/${number}?text=${encodeURIComponent(message)}`;
}
