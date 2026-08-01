/**
 * Magic-link landing route. Redeems the token, opens a session, and sends new
 * users to onboarding.
 */

import type { App } from "fresh";
import type { State } from "../../main.ts";
import { Page } from "../../components/Layout.tsx";
import { LogoVertical } from "../../components/LogoVertical.tsx";
import { Alert, LinkButton } from "../../components/ui.tsx";
import { clientIp, isSecureRequest } from "../../lib/auth/middleware.ts";
import {
  consumeMagicToken,
  createSession,
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

/** Only same-origin relative paths, so the link cannot bounce users offsite. */
function safeRedirect(next: string | undefined): string | null {
  if (!next) return null;
  if (!next.startsWith("/") || next.startsWith("//")) return null;
  return next;
}

export function verifyRoute(app: App<State>) {
  app.get("/auth/verify", async (ctx) => {
    const url = new URL(ctx.req.url);
    const token = url.searchParams.get("token");

    if (!token) {
      return ctx.render(
        <VerifyFailed message="That link is missing its token." />,
      );
    }

    const kv = ctx.state.auth.kv;
    const claim = await consumeMagicToken(kv, token);

    if (!claim) {
      return ctx.render(
        <VerifyFailed message="This link has already been used or has expired. Links last 15 minutes and work once." />,
      );
    }

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
