/**
 * Magic-link landing route. Redeems the token, opens a session, and sends new
 * users to onboarding.
 *
 * The link is confirmed rather than consumed on arrival: opening it shows a
 * button, and only submitting that button spends the token. Mail providers
 * fetch links before the recipient ever sees them — to scan for malware, to
 * build a preview — and a token spent on `GET` is gone by the time its owner
 * clicks, which reads as "this link has expired" on a link seconds old.
 * Scanners do not submit forms.
 */

import type { App } from "fresh";
import type { State } from "../../main.ts";
import { Page } from "../../components/Layout.tsx";
import { LogoVertical } from "../../components/LogoVertical.tsx";
import { Alert, Button, LinkButton } from "../../components/ui.tsx";
import {
  clientIp,
  CSRF_FIELD,
  csrfCookie,
  isSecureRequest,
  verifyCsrf,
} from "../../lib/auth/middleware.ts";
import {
  consumeMagicToken,
  createSession,
  peekMagicToken,
  sessionCookie,
} from "../../lib/auth/session.ts";
import { findOrCreateUser, isProfileComplete } from "../../lib/data/users.ts";

function VerifyFailed(props: { message: string }) {
  return (
    <Page bare>
      <div class="w-full max-w-sm flex flex-col items-center text-center gap-6">
        <LogoVertical class="w-40 h-auto text-on-surface" />
        <h1 class="text-headline-lg text-on-surface">Link did not work</h1>
        <Alert tone="error">{props.message}</Alert>
        <LinkButton href="/auth/login" fullWidth>
          Get a new link
        </LinkButton>
      </div>
    </Page>
  );
}

function ConfirmSignIn(props: { token: string; email: string; csrf: string }) {
  return (
    <Page bare>
      <div class="w-full max-w-sm flex flex-col items-center text-center gap-6">
        <LogoVertical class="w-40 h-auto text-on-surface" />
        <h1 class="text-headline-lg text-on-surface">Welcome back</h1>
        <p class="text-body-md text-on-surface-variant">
          Signing in as <span class="font-bold">{props.email}</span>.
        </p>
        <form method="post" action="/auth/verify" class="w-full">
          <input type="hidden" name={CSRF_FIELD} value={props.csrf} />
          <input type="hidden" name="token" value={props.token} />
          <Button type="submit" fullWidth>Sign in</Button>
        </form>
      </div>
    </Page>
  );
}

const EXPIRED =
  "This link has already been used or has expired. Links last 15 minutes and work once.";

/** Only same-origin relative paths, so the link cannot bounce users offsite. */
function safeRedirect(next: string | undefined): string | null {
  if (!next) return null;
  if (!next.startsWith("/") || next.startsWith("//")) return null;
  return next;
}

export function verifyRoute(app: App<State>) {
  app.get("/auth/verify", async (ctx) => {
    const token = new URL(ctx.req.url).searchParams.get("token");

    if (!token) {
      return await ctx.render(
        <VerifyFailed message="That link is missing its token." />,
      );
    }

    const claim = await peekMagicToken(ctx.state.auth.kv, token);
    if (!claim) return await ctx.render(<VerifyFailed message={EXPIRED} />);

    // The recipient arrives from their inbox with no CSRF cookie yet, so the
    // page that offers to sign them in has to establish one.
    const response = await ctx.render(
      <ConfirmSignIn
        token={token}
        email={claim.email}
        csrf={ctx.state.auth.csrfToken}
      />,
    );
    response.headers.append(
      "set-cookie",
      csrfCookie(ctx.state.auth.csrfToken, isSecureRequest(ctx.req)),
    );
    return response;
  });

  app.post("/auth/verify", async (ctx) => {
    const form = await ctx.req.formData();
    const token = form.get("token")?.toString();

    if (!verifyCsrf(ctx.req, form.get(CSRF_FIELD)?.toString() ?? null)) {
      return await ctx.render(
        <VerifyFailed message="That page went stale. Ask for a new link." />,
      );
    }

    if (!token) {
      return await ctx.render(
        <VerifyFailed message="That link is missing its token." />,
      );
    }

    const kv = ctx.state.auth.kv;
    const claim = await consumeMagicToken(kv, token);
    if (!claim) return await ctx.render(<VerifyFailed message={EXPIRED} />);

    const { user, created } = await findOrCreateUser(kv, claim.email);
    const session = await createSession(kv, user, {
      ip: clientIp(ctx.req),
      userAgent: ctx.req.headers.get("user-agent") ?? undefined,
    });

    // New accounts, and anyone who skipped onboarding, finish their profile
    // before they can RSVP.
    const destination = created || !isProfileComplete(user)
      ? "/profile/setup"
      : safeRedirect(claim.redirectTo) ?? "/games";

    const response = ctx.redirect(destination);
    response.headers.append(
      "set-cookie",
      sessionCookie(session.id, isSecureRequest(ctx.req)),
    );
    return response;
  });
}
