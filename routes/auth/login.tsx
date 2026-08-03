/**
 * Magic-link request screen.
 *
 * The response is deliberately identical whether or not the address is known,
 * so this form cannot be used to enumerate members.
 */

import type { App } from "fresh";
import type { State } from "../../main.ts";
import { Page } from "../../components/Layout.tsx";
import { LogoVertical } from "../../components/LogoVertical.tsx";
import { Alert, Button, Field } from "../../components/ui.tsx";
import {
  clientIp,
  CSRF_FIELD,
  csrfCookie,
  isSecureRequest,
  verifyCsrf,
} from "../../lib/auth/middleware.ts";
import {
  issueMagicToken,
  LOGIN_RATE,
  rateLimit,
} from "../../lib/auth/session.ts";
import { isValidEmail, normalizeEmail } from "../../lib/domain/validate.ts";
import { EmailError, magicLinkEmail, sendEmail } from "../../lib/email.ts";

function LoginPage(
  props: { csrf: string; error?: string; sent?: string; next?: string },
) {
  if (props.sent) {
    return (
      <Page bare>
        <div class="w-full max-w-sm flex flex-col items-center text-center gap-6">
          <LogoVertical class="w-40 h-auto text-on-surface" />
          <div>
            <h1 class="text-headline-lg text-on-surface mb-2">
              Check your email
            </h1>
            <p class="text-body-md text-on-surface-variant">
              If an account can be created for{" "}
              <span class="font-bold text-on-surface">{props.sent}</span>, a
              sign-in link is on its way. It expires in 15 minutes.
            </p>
          </div>
          <a
            href="/auth/login"
            class="text-label font-bold text-primary hover:underline"
          >
            Use a different email
          </a>
        </div>
      </Page>
    );
  }

  return (
    <Page bare>
      <div class="w-full max-w-sm flex flex-col gap-8">
        <div class="flex flex-col items-center text-center gap-4">
          <LogoVertical class="w-44 h-auto text-on-surface" />
          <h1 class="text-headline-lg text-on-surface">Welcome to the club</h1>
          <p class="text-body-md text-on-surface-variant">
            No passwords here. We email you a link that signs you straight in.
          </p>
        </div>

        {props.error && <Alert tone="error">{props.error}</Alert>}

        <form method="post" class="flex flex-col gap-5">
          <input type="hidden" name={CSRF_FIELD} value={props.csrf} />
          {props.next && <input type="hidden" name="next" value={props.next} />}
          <Field
            label="Email address"
            name="email"
            type="email"
            inputMode="email"
            autoComplete="email"
            required
            placeholder="you@email.com"
          />
          <Button type="submit" fullWidth>Send me a sign-in link</Button>
        </form>
      </div>
    </Page>
  );
}

export function loginRoutes(app: App<State>) {
  app.get("/auth/login", async (ctx) => {
    if (ctx.state.auth.user) return ctx.redirect("/games");

    const url = new URL(ctx.req.url);
    const next = url.searchParams.get("next") ?? undefined;
    const csrf = ctx.state.auth.csrfToken;

    const response = await ctx.render(<LoginPage csrf={csrf} next={next} />);
    response.headers.append(
      "set-cookie",
      csrfCookie(csrf, isSecureRequest(ctx.req)),
    );
    return response;
  });

  app.post("/auth/login", async (ctx) => {
    const form = await ctx.req.formData();
    const csrf = ctx.state.auth.csrfToken;

    if (!verifyCsrf(ctx.req, form.get(CSRF_FIELD)?.toString() ?? null)) {
      return ctx.render(
        <LoginPage csrf={csrf} error="That form expired. Please try again." />,
      );
    }

    const email = form.get("email")?.toString().trim() ?? "";
    const next = form.get("next")?.toString() || undefined;

    if (!isValidEmail(email)) {
      return ctx.render(
        <LoginPage
          csrf={csrf}
          error="That does not look like an email address."
          next={next}
        />,
      );
    }

    const kv = ctx.state.auth.kv;
    const ip = clientIp(ctx.req);
    const normalized = normalizeEmail(email);

    // Two limits: one stops a single inbox being flooded, the other stops one
    // source spraying many addresses.
    const byEmail = await rateLimit(
      kv,
      "login_email",
      normalized,
      LOGIN_RATE.perEmail.limit,
      LOGIN_RATE.perEmail.windowMs,
    );
    const byIp = ip
      ? await rateLimit(
        kv,
        "login_ip",
        ip,
        LOGIN_RATE.perIp.limit,
        LOGIN_RATE.perIp.windowMs,
      )
      : { allowed: true };

    if (!byEmail.allowed || !byIp.allowed) {
      return ctx.render(
        <LoginPage
          csrf={csrf}
          error="Too many sign-in attempts. Try again in a few minutes."
          next={next}
        />,
      );
    }

    const { token } = await issueMagicToken(kv, email, {
      ip,
      redirectTo: next,
    });

    try {
      await sendEmail(magicLinkEmail(email, token, next));
    } catch (error) {
      console.error("Failed to send magic link", error);

      // A misconfigured deployment cannot send to anyone, and "please try
      // again" invites someone to retry forever without ever learning why.
      // The provider's own words are what the person setting this up needs,
      // and they describe the sending account rather than the recipient, so
      // showing them tells an outsider nothing about who has an account here.
      const detail = error instanceof EmailError && error.isConfiguration
        ? ` The mail provider said: ${error.reason}`
        : "";

      return ctx.render(
        <LoginPage
          csrf={csrf}
          error={`We could not send that email.${detail}`}
          next={next}
        />,
      );
    }

    // Always the same confirmation, so the form reveals nothing about who is
    // already a member.
    return ctx.render(<LoginPage csrf={csrf} sent={email} />);
  });
}
