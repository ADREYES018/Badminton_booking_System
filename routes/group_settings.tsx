/**
 * Club settings: what it is called, how long before a game its roster
 * closes, and where the money goes.
 *
 * The payout details are shown to every member on a game they owe for, so
 * this form is the one place they can be set.
 */

import type { App } from "fresh";
import type { State } from "../main.ts";
import { Page } from "../components/Layout.tsx";
import { Alert, Button, Card, Field } from "../components/ui.tsx";
import {
  assertOrganizer,
  clientIp,
  CSRF_FIELD,
  csrfCookie,
  HttpError,
  isSecureRequest,
  resolveGroupAccess,
  verifyCsrf,
} from "../lib/auth/middleware.ts";
import { updateGroup, updatePayout } from "../lib/data/groups.ts";
import { audit } from "../lib/data/audit.ts";
import {
  cleanText,
  formatIbanGroups,
  isValidIban,
  normalizeIban,
} from "../lib/domain/validate.ts";
import type { Group, User } from "../lib/types.ts";

interface SettingsProps {
  user: User;
  group: Group;
  csrf: string;
  error?: string;
  notice?: string;
  values?: Record<string, string>;
}

function SettingsPage(props: SettingsProps) {
  const { group, values = {} } = props;
  const field = (name: string, fallback: string) => values[name] ?? fallback;

  return (
    <Page user={props.user} nav="games" groupSlug={group.slug}>
      <div class="max-w-xl mx-auto flex flex-col gap-6">
        <div>
          <a
            href={`/g/${group.slug}/members`}
            class="text-label font-bold text-on-surface-variant hover:text-primary transition-colors"
          >
            ← Members
          </a>
          <h1 class="text-headline-lg font-headline text-on-surface mt-2">
            Club settings
          </h1>
        </div>

        {props.notice && <Alert tone="success">{props.notice}</Alert>}
        {props.error && <Alert tone="error">{props.error}</Alert>}

        <Card>
          <form
            method="post"
            action={`/g/${group.slug}/settings`}
            class="flex flex-col gap-5"
          >
            <input type="hidden" name={CSRF_FIELD} value={props.csrf} />

            <Field
              label="Club name"
              name="name"
              required
              maxLength={60}
              value={field("name", group.name)}
              hint="The web address does not change when you rename the club."
            />

            <Field
              label="What it is"
              name="description"
              maxLength={140}
              value={field("description", group.description ?? "")}
              hint="Optional. One line, shown on the club list."
            />

            <Field
              label="Roster closes this many hours before a game"
              name="cutoffHours"
              type="number"
              min={1}
              max={336}
              required
              value={field("cutoffHours", String(group.defaultCutoffHours))}
              hint="The starting point for a new game. Each game can override it."
            />

            <fieldset class="border border-outline-variant rounded-lg p-4 flex flex-col gap-4">
              <legend class="text-label font-bold text-on-surface-variant px-2">
                Where players send their share
              </legend>
              <p class="text-label-sm text-on-surface-variant">
                Shown in full to any member who owes for a game, so they can
                make the transfer. Leave blank until you have an account to
                collect into.
              </p>

              <Field
                label="Bank"
                name="bank"
                maxLength={80}
                value={field("bank", group.payout?.bank ?? "")}
                placeholder="Emirates NBD"
              />

              <Field
                label="Account name"
                name="accountName"
                maxLength={80}
                value={field("accountName", group.payout?.accountName ?? "")}
                placeholder="Smash Club"
              />

              <Field
                label="IBAN"
                name="iban"
                maxLength={42}
                value={field(
                  "iban",
                  group.payout ? formatIbanGroups(group.payout.iban) : "",
                )}
                placeholder="AE07 0331 2345 6789 0123 456"
              />
            </fieldset>

            <Button type="submit">Save settings</Button>
          </form>
        </Card>
      </div>
    </Page>
  );
}

export function groupSettingsRoutes(app: App<State>) {
  app.get("/g/:groupSlug/settings", async (ctx) => {
    const access = assertOrganizer(
      await resolveGroupAccess(ctx.state.auth, ctx.params.groupSlug!),
    );
    const url = new URL(ctx.req.url);

    const response = await ctx.render(
      <SettingsPage
        user={access.user}
        group={access.group}
        csrf={ctx.state.auth.csrfToken}
        notice={url.searchParams.get("notice") ?? undefined}
      />,
    );
    response.headers.append(
      "set-cookie",
      csrfCookie(ctx.state.auth.csrfToken, isSecureRequest(ctx.req)),
    );
    return response;
  });

  app.post("/g/:groupSlug/settings", async (ctx) => {
    const access = assertOrganizer(
      await resolveGroupAccess(ctx.state.auth, ctx.params.groupSlug!),
    );
    const kv = ctx.state.auth.kv;
    const group = access.group;
    const form = await ctx.req.formData();

    if (!verifyCsrf(ctx.req, form.get(CSRF_FIELD)?.toString() ?? null)) {
      throw new HttpError(403, "That form expired. Please try again.");
    }

    const name = cleanText(form.get("name")?.toString() ?? "", 60);
    const description = cleanText(
      form.get("description")?.toString() ?? "",
      140,
    );
    const cutoffHours = Number(form.get("cutoffHours")?.toString() ?? "");
    const bank = cleanText(form.get("bank")?.toString() ?? "", 80);
    const accountName = cleanText(
      form.get("accountName")?.toString() ?? "",
      80,
    );
    const iban = normalizeIban(form.get("iban")?.toString() ?? "");

    const invalid = async (error: string) =>
      await ctx.render(
        <SettingsPage
          user={access.user}
          group={group}
          csrf={ctx.state.auth.csrfToken}
          error={error}
          values={{
            name,
            description,
            cutoffHours: String(cutoffHours),
            bank,
            accountName,
            iban,
          }}
        />,
      );

    if (!name) return await invalid("Give the club a name.");
    if (
      !Number.isInteger(cutoffHours) || cutoffHours < 1 || cutoffHours > 336
    ) {
      return await invalid("The cutoff must be between 1 and 336 hours.");
    }

    if (iban && !isValidIban(iban)) {
      return await invalid("That does not look like a valid IBAN.");
    }

    // Payout details are all or nothing. A partial set tells a player where to
    // send money without telling them how, which is worse than none at all.
    const payoutFields = [bank, accountName, iban].filter(Boolean);
    if (payoutFields.length > 0 && payoutFields.length < 3) {
      return await invalid(
        "Payment details need the bank, the account name and the IBAN.",
      );
    }

    await updateGroup(kv, group.id, {
      name,
      description: description || null,
      defaultCutoffHours: cutoffHours,
    });

    await updatePayout(
      kv,
      group.id,
      payoutFields.length === 3 ? { bank, accountName, iban } : null,
    );

    await audit(kv, {
      actorId: access.user.id,
      action: "group.updated",
      targetId: group.id,
      groupId: group.id,
      before: { name: group.name, cutoffHours: group.defaultCutoffHours },
      after: { name, cutoffHours },
      ip: clientIp(ctx.req),
    });

    return ctx.redirect(`/g/${group.slug}/settings?notice=Settings+saved.`);
  });
}
