/**
 * Transactional email, wrapped so the rest of the app never touches Resend
 * directly.
 *
 * With no RESEND_API_KEY set, messages are logged to the console instead of
 * sent — local development needs no third-party account, and tests never post
 * to the network.
 */

import { formatFils } from "./domain/money.ts";
import { formatGameTime } from "./domain/time.ts";

const RESEND_ENDPOINT = "https://api.resend.com/emails";

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
}

/**
 * The public origin every magic link and QR payload is built from.
 *
 * Getting this wrong is silent and total: links point somewhere that is not
 * the app, and nobody can sign in. Development falls back to localhost, but a
 * deployment with `APP_URL` unset is refused rather than left to hand out dead
 * links — `DENO_DEPLOYMENT_ID` is set by Deno Deploy and by nothing else.
 */
export function appUrl(): string {
  const configured = Deno.env.get("APP_URL");
  if (configured) return configured;

  if (Deno.env.get("DENO_DEPLOYMENT_ID")) {
    throw new Error(
      "APP_URL must be set in a deployment: magic links and QR codes are " +
        "built from it, and a wrong value locks everyone out.",
    );
  }

  return "http://localhost:8000";
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
    throw new EmailError(response.status, detail);
  }
}

/**
 * A refusal from the mail provider, carrying enough to act on.
 *
 * The distinction that matters is whose fault it is. A 4xx means this
 * deployment is misconfigured — an unverified sending domain, a bad key, a
 * recipient the account is not allowed to write to — and the person setting it
 * up needs to read the provider's own words, not "please try again", which
 * they could follow forever without learning anything. Anything else is the
 * provider having a bad day and is worth retrying.
 */
export class EmailError extends Error {
  readonly status: number;
  readonly detail: string;

  constructor(status: number, detail: string) {
    super(`Resend rejected the message (${status}): ${detail}`);
    this.status = status;
    this.detail = detail;
  }

  /** True when the deployment is at fault rather than the network. */
  get isConfiguration(): boolean {
    return this.status >= 400 && this.status < 500;
  }

  /** The provider's own explanation, when it gave one. */
  get reason(): string {
    try {
      const parsed = JSON.parse(this.detail);
      const message = parsed?.message ?? parsed?.error?.message;
      if (typeof message === "string" && message.trim()) return message.trim();
    } catch {
      // Not JSON. The raw body is still better than nothing.
    }
    return this.detail.slice(0, 300) || `HTTP ${this.status}`;
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

/**
 * The sign-in code, spaced for reading.
 *
 * A code carries no link, so there is nothing for a mail provider to fetch on
 * the recipient's behalf and nothing it can spend before they arrive. The
 * subject line carries the code too, since that is often all someone sees on a
 * lock screen.
 */
export function magicLinkEmail(to: string, code: string): EmailMessage {
  const spaced = `${code.slice(0, 3)} ${code.slice(3)}`;

  return {
    to,
    subject: `${spaced} is your Smash Club code`,
    html: layout(
      "Your sign-in code",
      `<p style="font-size:16px;line-height:1.6;margin:0 0 16px;">Type this code into the app to sign in. It works once and expires in 15 minutes.</p>
       <p style="font-size:38px;font-weight:800;letter-spacing:0.18em;color:#161f00;margin:0 0 16px;text-align:center;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;">${
        escapeHtml(spaced)
      }</p>
       <p style="font-size:13px;color:#444934;margin:0;">Did not request this? Ignore this email and nothing will happen. Nobody can sign in without the code.</p>`,
    ),
    text: [
      "Your Smash Club sign-in code",
      "",
      spaced,
      "",
      "Type it into the app. It works once and expires in 15 minutes.",
      "",
      "Did not request this? Ignore this email.",
    ].join("\n"),
  };
}

/**
 * Reminder about an upcoming game.
 *
 * Each tag answers a different question, so they do not share copy. "pay"
 * fires at the cutoff and is about money; the countdown reminders are about
 * turning up, and mention money only if it is still outstanding.
 */
export function reminderEmail(
  to: string,
  game: import("./types.ts").Game,
  tag: import("./types.ts").ReminderTag,
  owedFils: number,
): EmailMessage {
  const url = new URL(`/games/${game.slug}`, appUrl()).toString();
  const when = formatGameTime(game.startUtc, game.endUtc);
  const amount = formatFils(owedFils);

  const copy: Record<typeof tag, { subject: string; lead: string }> = {
    pay: {
      subject: `The roster is set for ${game.title} — you owe ${amount}`,
      lead:
        `The roster has closed, so your share is settled at <strong>${amount}</strong>. ` +
        `Send it to the club account and mark it paid on the game page.`,
    },
    t36: {
      subject: `${game.title} is in a day and a half`,
      lead: `${when} at ${
        escapeHtml(game.venue.name)
      }. Your share is ${amount}.`,
    },
    t24: {
      subject: `${game.title} is tomorrow`,
      lead: `${when} at ${
        escapeHtml(game.venue.name)
      }. Your share is ${amount}.`,
    },
    t3: {
      subject: `${game.title} starts in about three hours`,
      lead:
        `${when} at ${
          escapeHtml(game.venue.name)
        }. See you on court — bring a ` +
        `spare shirt.`,
    },
  };

  const { subject, lead } = copy[tag];

  return {
    to,
    subject,
    html: layout(
      game.title,
      `<p style="font-size:16px;line-height:1.6;margin:0 0 8px;">${lead}</p>
       ${button(url, "Open the game")}
       <p style="font-size:13px;color:#444934;margin:0;">${
        escapeHtml(game.venue.address)
      }</p>`,
    ),
    text: [
      subject,
      "",
      lead.replace(/<[^>]+>/g, ""),
      "",
      url,
    ].join("\n"),
  };
}

/** WhatsApp deep link, used instead of the paid Business API. */
export function whatsappLink(phoneE164: string, message: string): string {
  const number = phoneE164.replace(/\D/g, "");
  return `https://wa.me/${number}?text=${encodeURIComponent(message)}`;
}
