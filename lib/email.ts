/**
 * Transactional email, wrapped so the rest of the app never touches Google
 * directly.
 *
 * With no GMAIL_REFRESH_TOKEN set, messages are logged to the console instead
 * of sent — local development needs no Google project, and tests never post to
 * the network.
 *
 * Mail is sent as the club's own Gmail account through Google's own servers,
 * so the DKIM signature aligns with the From domain. A relay would have been
 * one API key instead of an OAuth client, but it signs as itself while
 * claiming a gmail.com From, and consumer Gmail scores that mismatch down —
 * which would land sign-in codes in spam for a player base that is mostly on
 * Gmail.
 *
 * The cost is a refresh token, which is a credential that can send as the club
 * indefinitely. It lives in the environment and is never logged, including
 * inside an EmailError.
 */

import { encodeBase64 } from "@std/encoding/base64";
import { encodeBase64Url } from "@std/encoding/base64url";
import { formatFils } from "./domain/money.ts";
import { formatGameTime } from "./domain/time.ts";

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const SEND_ENDPOINT =
  "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";

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

/**
 * Splits `EMAIL_FROM` into a display name and an address.
 *
 * There is deliberately no default. Gmail rewrites a From header it does not
 * recognise as an alias of the authorising account, so a fallback would not
 * fail — it would quietly send under a different address than the one
 * configured, which is worse than refusing.
 */
export function parseSender(
  value: string | undefined = Deno.env.get("EMAIL_FROM"),
): { name: string; email: string } {
  if (!value?.trim()) {
    throw new Error(
      "EMAIL_FROM must be set to the Gmail account that authorised " +
        'GMAIL_REFRESH_TOKEN, in the form "Smash Club <club@gmail.com>".',
    );
  }

  const angled = value.match(/^(.*)<(.+)>\s*$/);
  if (!angled) return { name: "Smash Club", email: value.trim() };

  const name = angled[1]!.trim();
  return { name: name || "Smash Club", email: angled[2]!.trim() };
}

/**
 * RFC 2047 for anything a header cannot carry as-is.
 *
 * Headers are ASCII. A player's name or a character pasted from a phone would
 * otherwise be stripped or replaced somewhere between here and the inbox.
 * Plain ASCII is left alone so an ordinary subject stays readable in a log.
 */
export function encodeHeader(value: string): string {
  // deno-lint-ignore no-control-regex
  if (!/[^\x00-\x7F]/.test(value)) return value;
  return `=?UTF-8?B?${encodeBase64(new TextEncoder().encode(value))}?=`;
}

/**
 * The RFC 2822 message Gmail sends verbatim.
 *
 * Text first and HTML second: a client renders the last part it understands,
 * so this order is what makes HTML win where it is supported without losing
 * the plain-text copy where it is not.
 */
export function buildMime(message: EmailMessage): string {
  const sender = parseSender();
  const boundary = `smash-${crypto.randomUUID()}`;
  const body = (content: string) =>
    encodeBase64(new TextEncoder().encode(content));

  return [
    `From: ${encodeHeader(sender.name)} <${sender.email}>`,
    `To: ${message.to}`,
    `Subject: ${encodeHeader(message.subject)}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    body(message.text),
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    body(message.html),
    `--${boundary}--`,
    "",
  ].join("\r\n");
}

/**
 * A live access token, minted from the refresh token and reused until it is
 * nearly stale.
 *
 * Access tokens last an hour and the deployment holds only the refresh token,
 * so without this cache every message would cost two requests. The minute of
 * margin covers clock skew and the flight time of the send that follows.
 */
let cached: { token: string; expiresAt: number } | null = null;

async function accessToken(): Promise<string> {
  if (cached && Date.now() < cached.expiresAt) return cached.token;

  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: Deno.env.get("GMAIL_CLIENT_ID") ?? "",
      client_secret: Deno.env.get("GMAIL_CLIENT_SECRET") ?? "",
      refresh_token: Deno.env.get("GMAIL_REFRESH_TOKEN") ?? "",
      grant_type: "refresh_token",
    }),
  });

  if (!response.ok) {
    // The body here describes the grant, never the credentials that were
    // sent, so it is safe to carry into the error.
    throw new EmailError(response.status, await response.text());
  }

  const granted = await response.json();
  cached = {
    token: granted.access_token,
    expiresAt: Date.now() + (granted.expires_in - 60) * 1000,
  };

  return cached.token;
}

export async function sendEmail(message: EmailMessage): Promise<void> {
  if (!Deno.env.get("GMAIL_REFRESH_TOKEN")) {
    console.info(
      `\n[email] to=${message.to}\n[email] subject=${message.subject}\n${message.text}\n`,
    );
    return;
  }

  const response = await fetch(SEND_ENDPOINT, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${await accessToken()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ raw: encodeBase64Url(buildMime(message)) }),
  });

  if (!response.ok) {
    throw new EmailError(response.status, await response.text());
  }
}

/**
 * A refusal from Google, carrying enough to act on.
 *
 * The distinction that matters is whose fault it is. A 4xx means this
 * deployment is misconfigured — a revoked refresh token, an OAuth client that
 * does not match, a From the account may not send as — and the person setting
 * it up needs to read Google's own words, not "please try again", which they
 * could follow forever without learning anything. Anything else is Google
 * having a bad day and is worth retrying.
 *
 * `detail` is a response body, so it may be shown to an operator. Nothing that
 * reaches here carries the refresh token, the client secret or an access
 * token: Google echoes the grant it refused, never the credentials it was
 * given.
 */
export class EmailError extends Error {
  readonly status: number;
  readonly detail: string;

  constructor(status: number, detail: string) {
    super(`Gmail rejected the message (${status}): ${detail}`);
    this.status = status;
    this.detail = detail;
  }

  /** True when the deployment is at fault rather than the network. */
  get isConfiguration(): boolean {
    return this.status >= 400 && this.status < 500;
  }

  /** Google's own explanation, when it gave one. */
  get reason(): string {
    try {
      const parsed = JSON.parse(this.detail);

      // A refresh token that was revoked, or that expired because the OAuth
      // consent screen was left in Testing, arrives as invalid_grant. That
      // reads as an authentication bug and is really a configuration one, and
      // the fix is in the Google Cloud console rather than in this code.
      if (parsed?.error === "invalid_grant") {
        return `${
          parsed.error_description ?? "The refresh token is no longer valid"
        } — re-authorise GMAIL_REFRESH_TOKEN, and check the OAuth consent screen is set to In production rather than Testing.`;
      }

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
