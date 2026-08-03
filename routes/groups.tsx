/**
 * Clubs: the list a player picks from, and the form that starts a new one.
 *
 * This is the only screen that exists outside a club, so it is also where
 * someone with no membership lands — hence the empty state explains the two
 * ways in rather than just saying there is nothing here.
 */

import type { App } from "fresh";
import type { State } from "../main.ts";
import { Page } from "../components/Layout.tsx";
import { Alert, Button, Card, EmptyState, Field } from "../components/ui.tsx";
import {
  clientIp,
  CSRF_FIELD,
  csrfCookie,
  HttpError,
  isSecureRequest,
  requireUser,
  verifyCsrf,
} from "../lib/auth/middleware.ts";
import {
  consumeGroupInvite,
  createGroupForOwner,
  getGroupBySlug,
  InviteError,
  listGroupsForUser,
} from "../lib/data/groups.ts";
import { audit } from "../lib/data/audit.ts";
import { cleanText, slugify } from "../lib/domain/validate.ts";
import type { Group, User } from "../lib/types.ts";

interface GroupsViewProps {
  user: User;
  groups: Group[];
  csrf: string;
  error?: string;
  notice?: string;
  values?: Record<string, string>;
}

function GroupCard(props: { group: Group }) {
  return (
    <Card>
      <a
        href={`/g/${props.group.slug}/games`}
        class="flex flex-col gap-1 no-underline"
      >
        <span class="text-title-md font-headline text-on-surface">
          {props.group.name}
        </span>
        {props.group.description && (
          <span class="text-body-md text-on-surface-variant">
            {props.group.description}
          </span>
        )}
      </a>
    </Card>
  );
}

function GroupsView(props: GroupsViewProps) {
  const { groups } = props;

  return (
    <Page user={props.user} nav="games">
      <div class="max-w-xl mx-auto flex flex-col gap-6">
        <h1 class="text-headline-lg font-headline text-on-surface">
          Your clubs
        </h1>

        {props.notice && <Alert tone="success">{props.notice}</Alert>}
        {props.error && <Alert tone="error">{props.error}</Alert>}

        {groups.length === 0
          ? (
            <EmptyState title="You are not in a club yet">
              <p>
                Clubs are private. Ask an organizer for an invite link, or start
                your own below.
              </p>
            </EmptyState>
          )
          : (
            <div class="flex flex-col gap-3">
              {groups.map((group) => (
                <GroupCard
                  key={group.id}
                  group={group}
                />
              ))}
            </div>
          )}

        <Card>
          <form method="post" action="/groups" class="flex flex-col gap-5">
            <input type="hidden" name={CSRF_FIELD} value={props.csrf} />
            <h2 class="text-title-md font-headline text-on-surface">
              Start a club
            </h2>
            <Field
              label="Club name"
              name="name"
              required
              maxLength={60}
              value={props.values?.name ?? ""}
              hint="Whatever your players already call it."
            />
            <Field
              label="What it is"
              name="description"
              maxLength={140}
              value={props.values?.description ?? ""}
              hint="Optional. One line, shown on the club list."
            />
            <Button type="submit">Create club</Button>
          </form>
        </Card>
      </div>
    </Page>
  );
}

export function groupsRoutes(app: App<State>) {
  app.get("/groups", async (ctx) => {
    const user = requireUser(ctx.state.auth);
    const groups = await listGroupsForUser(ctx.state.auth.kv, user.id);
    const url = new URL(ctx.req.url);

    const response = await ctx.render(
      <GroupsView
        user={user}
        groups={groups}
        csrf={ctx.state.auth.csrfToken}
        notice={url.searchParams.get("joined")
          ? "You are in. Pick a game below."
          : undefined}
        error={url.searchParams.get("error") ?? undefined}
      />,
    );
    response.headers.append(
      "set-cookie",
      csrfCookie(ctx.state.auth.csrfToken, isSecureRequest(ctx.req)),
    );
    return response;
  });

  app.post("/groups", async (ctx) => {
    const user = requireUser(ctx.state.auth);
    const kv = ctx.state.auth.kv;
    const form = await ctx.req.formData();

    if (!verifyCsrf(ctx.req, form.get(CSRF_FIELD)?.toString() ?? null)) {
      throw new HttpError(403, "That form expired. Please try again.");
    }

    const name = cleanText(form.get("name")?.toString() ?? "", 60);
    const description = cleanText(
      form.get("description")?.toString() ?? "",
      140,
    );
    const slug = slugify(name);

    const invalid = async (error: string) => {
      const groups = await listGroupsForUser(kv, user.id);
      return await ctx.render(
        <GroupsView
          user={user}
          groups={groups}
          csrf={ctx.state.auth.csrfToken}
          error={error}
          values={{ name, description }}
        />,
      );
    };

    if (!name) return await invalid("Give the club a name.");
    // A name of only punctuation slugifies to nothing, which would make an
    // unreachable URL.
    if (!slug) return await invalid("That name needs at least one letter.");
    if (await getGroupBySlug(kv, slug)) {
      return await invalid("A club already uses that name.");
    }

    const group = await createGroupForOwner(kv, {
      name,
      slug,
      ownerId: user.id,
      description: description || undefined,
    });

    await audit(kv, {
      actorId: user.id,
      action: "group.created",
      targetId: group.id,
      groupId: group.id,
      after: { name: group.name, slug: group.slug },
      ip: clientIp(ctx.req),
    });

    return ctx.redirect(`/g/${group.slug}/games`);
  });

  // Invite links are shared as-is, so this path stays short and outside any
  // club prefix — the token names the club, and the recipient does not have to
  // already know its slug.
  app.get("/invite/:token", async (ctx) => {
    const user = requireUser(ctx.state.auth);
    const kv = ctx.state.auth.kv;

    try {
      const group = await consumeGroupInvite(kv, ctx.params.token!, user.id);
      return ctx.redirect(`/g/${group.slug}/games?joined=1`);
    } catch (error) {
      if (error instanceof InviteError) {
        return ctx.redirect(
          `/groups?error=${encodeURIComponent(error.message)}`,
        );
      }
      throw error;
    }
  });
}
