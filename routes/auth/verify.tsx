/**
 * Where a sign-in code is checked. Opens a session and sends new users to
 * onboarding.
 *
 * There is no `GET` here. Sign-in used to be a link in an email, which mail
 * providers fetch before their recipient sees it — a single-use link was
 * routinely spent by that fetch, and its owner was told it had expired. A code
 * cannot be followed, so nothing can spend it on the reader's behalf.
 */

import type { App } from "fresh";
import type { State } from "../../main.ts";
import { Page } from "../../components/Layout.tsx";
import { LogoVertical } from "../../components/LogoVertical.tsx";
import { Alert, LinkButton } from "../../components/ui.tsx";
import {
  clientIp,
  CSRF_FIELD,
  isSecureRequest,
  verifyCsrf,
} from "../../lib/auth/middleware.ts";
import { createSession, sessionCookie } from "../../lib/auth/session.ts";
import { verifyLoginCode } from "../../lib/auth/session.ts";
import { findOrCreateUser, isProfileComplete } from "../../lib/data/users.ts";
import { CodePage } from "./login.tsx";

function VerifyFailed(props: { message: string }) {
  return (
    <Page bare>
      <div class="w-full max-w-sm flex flex-col items-center text-center gap-6">
        <LogoVertical class="w-40 h-auto text-on-surface" />
        <h1 class="text-headline-lg text-on-surface">That did not work</h1>
        <Alert tone="error">{props.message}</Alert>
        <LinkButton href="/auth/login" fullWidth>
          Start again
        </LinkButton>
      </div>
    </Page>
  );
}

/** Only same-origin relative paths, so sign-in cannot bounce users offsite. */
function safeRedirect(next: string | undefined): string | null {
  if (!next) return null;
  if (!next.startsWith("/") || next.startsWith("//")) return null;
  return next;
}

export function verifyRoute(app: App<State>) {
  // Someone who lands here without a code — a stale bookmark, a back button —
  // gets the form rather than an error about a thing they did not do.
  app.get("/auth/verify", (ctx) => ctx.redirect("/auth/login"));

  app.post("/auth/verify", async (ctx) => {
    const form = await ctx.req.formData();
    const csrf = ctx.state.auth.csrfToken;
    const email = form.get("email")?.toString().trim() ?? "";
    const code = form.get("code")?.toString().trim() ?? "";
    const next = form.get("next")?.toString() || undefined;

    if (!verifyCsrf(ctx.req, form.get(CSRF_FIELD)?.toString() ?? null)) {
      return await ctx.render(
        <VerifyFailed message="That page went stale. Ask for a new code." />,
      );
    }

    if (!email) {
      return await ctx.render(
        <VerifyFailed message="We lost track of which address that code was for." />,
      );
    }

    const kv = ctx.state.auth.kv;
    const result = await verifyLoginCode(kv, email, code);

    if (!result.ok) {
      // A wrong digit is worth another go on the same screen; the other two
      // mean the code is gone and only a new one will do.
      if (result.reason === "wrong") {
        return await ctx.render(
          <CodePage
            csrf={csrf}
            email={email}
            next={next}
            error="That code is not right. Check the email and try again."
          />,
        );
      }

      return await ctx.render(
        <VerifyFailed
          message={result.reason === "exhausted"
            ? "Too many wrong tries, so that code has been cancelled. Ask for a new one."
            : "That code has expired or has already been used. Ask for a new one."}
        />,
      );
    }

    const { user, created } = await findOrCreateUser(kv, result.claim.email);
    const session = await createSession(kv, user, {
      ip: clientIp(ctx.req),
      userAgent: ctx.req.headers.get("user-agent") ?? undefined,
    });

    // New accounts, and anyone who skipped onboarding, finish their profile
    // before they can RSVP.
    const destination = created || !isProfileComplete(user)
      ? "/profile/setup"
      : safeRedirect(result.claim.redirectTo ?? next) ?? "/games";

    const response = ctx.redirect(destination);
    response.headers.append(
      "set-cookie",
      sessionCookie(session.id, isSecureRequest(ctx.req)),
    );
    return response;
  });
}
