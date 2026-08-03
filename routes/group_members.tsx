/**
 * The club roster, and the three ways someone gets onto it.
 *
 * An organizer can mint an invite link, add an address that already has an
 * account, or approve someone who asked. Everything on this page is an
 * organizer's decision — nothing here happens on its own.
 */

import type { App } from "fresh";
import type { State } from "../main.ts";
import { Page } from "../components/Layout.tsx";
import { Alert, Avatar, Button, Card, Chip, Field } from "../components/ui.tsx";
import {
  assertOrganizer,
  clientIp,
  CSRF_FIELD,
  csrfCookie,
  HttpError,
  isSecureRequest,
  requireUser,
  resolveGroupAccess,
  verifyCsrf,
} from "../lib/auth/middleware.ts";
import {
  addMemberByEmail,
  decideJoinRequest,
  issueGroupInvite,
  listJoinRequests,
  listMembers,
  MembershipError,
  requestToJoin,
  setMemberBlocked,
  setMemberRole,
} from "../lib/data/groups.ts";
import { getUser } from "../lib/data/users.ts";
import { audit } from "../lib/data/audit.ts";
import { formatRelative } from "../lib/domain/time.ts";
import type { Group, JoinRequest, Membership, User } from "../lib/types.ts";

interface Listed {
  membership: Membership;
  user: User | null;
}

interface Pending {
  request: JoinRequest;
  user: User | null;
}

interface MembersProps {
  user: User;
  group: Group;
  members: Listed[];
  pending: Pending[];
  csrf: string;
  inviteUrl?: string;
  error?: string;
  notice?: string;
}

function nameOf(user: User | null): string {
  return user?.name || user?.email || "Someone";
}

function MemberRow(
  props: { entry: Listed; group: Group; csrf: string },
) {
  const { membership, user } = props.entry;
  const base = `/g/${props.group.slug}/members/${membership.userId}`;
  const isOwner = props.group.ownerId === membership.userId;
  // The owner's own rights are not a lever anyone gets to pull, including
  // themselves — a club with nobody able to administer it is unrecoverable.
  const mutable = !isOwner;

  return (
    <li class="flex flex-wrap items-center gap-3 py-3">
      <Avatar
        name={nameOf(user)}
        userId={membership.userId}
        hasPhoto={user?.hasPhoto}
        size={40}
      />
      <div class="flex-1 min-w-0">
        <p class="text-body-md text-on-surface truncate">{nameOf(user)}</p>
        <p class="text-label-sm text-on-surface-variant truncate">
          {user?.email}
        </p>
      </div>

      {isOwner && <Chip tone="info">Owner</Chip>}
      {membership.role === "organizer" && !isOwner && (
        <Chip tone="success">Organizer</Chip>
      )}
      {membership.blocked && <Chip tone="error">Blocked</Chip>}

      {mutable && (
        <div class="flex items-center gap-2">
          <form method="post" action={`${base}/role`}>
            <input type="hidden" name={CSRF_FIELD} value={props.csrf} />
            <input
              type="hidden"
              name="role"
              value={membership.role === "organizer" ? "player" : "organizer"}
            />
            <Button type="submit" variant="ghost" class="px-4 py-2 text-[13px]">
              {membership.role === "organizer"
                ? "Make player"
                : "Make organizer"}
            </Button>
          </form>

          <form method="post" action={`${base}/block`}>
            <input type="hidden" name={CSRF_FIELD} value={props.csrf} />
            <input
              type="hidden"
              name="blocked"
              value={membership.blocked ? "false" : "true"}
            />
            <Button
              type="submit"
              variant={membership.blocked ? "ghost" : "danger"}
              class="px-4 py-2 text-[13px]"
            >
              {membership.blocked ? "Unblock" : "Block"}
            </Button>
          </form>
        </div>
      )}
    </li>
  );
}

function MembersPage(props: MembersProps) {
  const { group, members, pending, csrf } = props;

  return (
    <Page user={props.user} nav="games" groupSlug={group.slug}>
      <div class="max-w-3xl mx-auto flex flex-col gap-6">
        <div class="flex items-start justify-between gap-4">
          <div>
            <h1 class="text-headline-lg font-headline text-on-surface">
              Members
            </h1>
            <p class="text-body-md text-on-surface-variant mt-1">
              {group.name}
            </p>
          </div>
          <a
            href={`/g/${group.slug}/settings`}
            class="text-label font-bold text-on-surface-variant hover:text-primary transition-colors"
          >
            Club settings →
          </a>
        </div>

        {props.notice && <Alert tone="success">{props.notice}</Alert>}
        {props.error && <Alert tone="error">{props.error}</Alert>}

        {props.inviteUrl && (
          <Alert tone="success">
            <div class="flex flex-col gap-2">
              <p>
                Send this link to one person. It works once and expires in a
                week.
              </p>
              <code class="block break-all rounded-lg bg-surface-container px-3 py-2 text-label-sm text-on-surface">
                {props.inviteUrl}
              </code>
            </div>
          </Alert>
        )}

        {pending.length > 0 && (
          <Card class="flex flex-col gap-3">
            <h2 class="text-body-lg font-bold text-on-surface">
              Asked to join ({pending.length})
            </h2>
            <ul class="flex flex-col divide-y divide-outline-variant">
              {pending.map(({ request, user }) => (
                <li
                  key={request.userId}
                  class="flex flex-wrap items-center gap-3 py-3"
                >
                  <Avatar
                    name={nameOf(user)}
                    userId={request.userId}
                    hasPhoto={user?.hasPhoto}
                    size={40}
                  />
                  <div class="flex-1 min-w-0">
                    <p class="text-body-md text-on-surface truncate">
                      {nameOf(user)}
                    </p>
                    <p class="text-label-sm text-on-surface-variant">
                      Asked {formatRelative(request.requestedAt)}
                      {request.message ? ` · "${request.message}"` : ""}
                    </p>
                  </div>
                  <div class="flex items-center gap-2">
                    {(["approved", "rejected"] as const).map((decision) => (
                      <form
                        key={decision}
                        method="post"
                        action={`/g/${group.slug}/requests/${request.userId}`}
                      >
                        <input
                          type="hidden"
                          name={CSRF_FIELD}
                          value={csrf}
                        />
                        <input
                          type="hidden"
                          name="decision"
                          value={decision}
                        />
                        <Button
                          type="submit"
                          variant={decision === "approved"
                            ? "primary"
                            : "ghost"}
                          class="px-4 py-2 text-[13px]"
                        >
                          {decision === "approved" ? "Approve" : "Decline"}
                        </Button>
                      </form>
                    ))}
                  </div>
                </li>
              ))}
            </ul>
          </Card>
        )}

        <Card class="flex flex-col gap-3">
          <h2 class="text-body-lg font-bold text-on-surface">
            On the roster ({members.length})
          </h2>
          <ul class="flex flex-col divide-y divide-outline-variant">
            {members.map((entry) => (
              <MemberRow
                key={entry.membership.userId}
                entry={entry}
                group={group}
                csrf={csrf}
              />
            ))}
          </ul>
        </Card>

        <div class="grid gap-4 md:grid-cols-2">
          <Card>
            <form
              method="post"
              action={`/g/${group.slug}/invite`}
              class="flex flex-col gap-3"
            >
              <input type="hidden" name={CSRF_FIELD} value={csrf} />
              <h2 class="text-body-lg font-bold text-on-surface">
                Invite link
              </h2>
              <p class="text-label-sm text-on-surface-variant">
                For someone without an account yet. Good for one person.
              </p>
              <Button type="submit" variant="secondary">Create a link</Button>
            </form>
          </Card>

          <Card>
            <form
              method="post"
              action={`/g/${group.slug}/members`}
              class="flex flex-col gap-3"
            >
              <input type="hidden" name={CSRF_FIELD} value={csrf} />
              <h2 class="text-body-lg font-bold text-on-surface">
                Add by email
              </h2>
              <Field
                label="Email address"
                name="email"
                type="email"
                required
                placeholder="player@example.com"
                hint="They need an account already."
              />
              <Button type="submit" variant="secondary">Add to club</Button>
            </form>
          </Card>
        </div>
      </div>
    </Page>
  );
}

export function groupMemberRoutes(app: App<State>) {
  /** Loads the roster and anyone waiting on a decision. */
  async function loadPage(
    ctx: {
      state: State;
      req: Request;
      params: Record<string, string | undefined>;
    },
  ) {
    const access = assertOrganizer(
      await resolveGroupAccess(ctx.state.auth, ctx.params.groupSlug!),
    );
    const kv = ctx.state.auth.kv;
    const group = access.group;

    const [memberships, requests] = await Promise.all([
      listMembers(kv, group.id),
      listJoinRequests(kv, group.id),
    ]);

    const members: Listed[] = await Promise.all(
      memberships.map(async (membership) => ({
        membership,
        user: await getUser(kv, membership.userId),
      })),
    );

    const pending: Pending[] = await Promise.all(
      requests
        .filter((request) => request.status === "pending")
        .map(async (request) => ({
          request,
          user: await getUser(kv, request.userId),
        })),
    );

    return { access, kv, group, members, pending };
  }

  app.get("/g/:groupSlug/members", async (ctx) => {
    const { access, group, members, pending } = await loadPage(ctx);
    const url = new URL(ctx.req.url);

    const response = await ctx.render(
      <MembersPage
        user={access.user}
        group={group}
        members={members}
        pending={pending}
        csrf={ctx.state.auth.csrfToken}
        inviteUrl={url.searchParams.get("invite") ?? undefined}
        notice={url.searchParams.get("notice") ?? undefined}
        error={url.searchParams.get("error") ?? undefined}
      />,
    );
    response.headers.append(
      "set-cookie",
      csrfCookie(ctx.state.auth.csrfToken, isSecureRequest(ctx.req)),
    );
    return response;
  });

  /** Shared prologue for the organizer's actions on this page. */
  async function beginAction(
    ctx: {
      state: State;
      req: Request;
      params: Record<string, string | undefined>;
    },
  ) {
    const access = assertOrganizer(
      await resolveGroupAccess(ctx.state.auth, ctx.params.groupSlug!),
    );
    const form = await ctx.req.formData();
    if (!verifyCsrf(ctx.req, form.get(CSRF_FIELD)?.toString() ?? null)) {
      throw new HttpError(403, "That form expired. Please try again.");
    }
    return { access, form, kv: ctx.state.auth.kv, group: access.group };
  }

  /** Back to the members page carrying one message. */
  function backToMembers(
    slug: string,
    params: Record<string, string> = {},
  ): Response {
    const query = new URLSearchParams(params).toString();
    return new Response(null, {
      status: 303,
      headers: {
        location: `/g/${slug}/members${query ? `?${query}` : ""}`,
      },
    });
  }

  app.post("/g/:groupSlug/invite", async (ctx) => {
    const { access, kv, group } = await beginAction(ctx);

    const { token } = await issueGroupInvite(kv, group.id, access.user.id);
    await audit(kv, {
      actorId: access.user.id,
      action: "member.invited",
      groupId: group.id,
      ip: clientIp(ctx.req),
    });

    const origin = new URL(ctx.req.url).origin;
    return backToMembers(group.slug, {
      invite: `${origin}/invite/${token}`,
    });
  });

  app.post("/g/:groupSlug/members", async (ctx) => {
    const { access, form, kv, group } = await beginAction(ctx);
    const email = form.get("email")?.toString() ?? "";

    try {
      const membership = await addMemberByEmail(kv, group.id, email);
      await audit(kv, {
        actorId: access.user.id,
        action: "member.added",
        targetId: membership.userId,
        groupId: group.id,
        ip: clientIp(ctx.req),
      });
      return backToMembers(group.slug, { notice: "Added to the club." });
    } catch (error) {
      if (error instanceof MembershipError) {
        return backToMembers(group.slug, { error: error.message });
      }
      throw error;
    }
  });

  app.post("/g/:groupSlug/members/:userId/role", async (ctx) => {
    const { access, form, kv, group } = await beginAction(ctx);
    const userId = ctx.params.userId!;
    const role = form.get("role")?.toString() === "organizer"
      ? "organizer"
      : "player";

    // The owner always keeps their rights, so a club can never be left with
    // nobody able to administer it.
    if (userId === group.ownerId) {
      throw new HttpError(403, "The club's owner cannot be demoted.");
    }

    await setMemberRole(kv, group.id, userId, role);
    await audit(kv, {
      actorId: access.user.id,
      action: "member.role_changed",
      targetId: userId,
      groupId: group.id,
      after: { role },
      ip: clientIp(ctx.req),
    });

    return backToMembers(group.slug, { notice: `Role changed to ${role}.` });
  });

  app.post("/g/:groupSlug/members/:userId/block", async (ctx) => {
    const { access, form, kv, group } = await beginAction(ctx);
    const userId = ctx.params.userId!;
    const blocked = form.get("blocked")?.toString() === "true";

    if (userId === group.ownerId) {
      throw new HttpError(403, "The club's owner cannot be blocked.");
    }

    await setMemberBlocked(kv, group.id, userId, blocked, {
      actorId: access.user.id,
      reason: form.get("reason")?.toString(),
    });
    await audit(kv, {
      actorId: access.user.id,
      action: blocked ? "member.blocked" : "member.unblocked",
      targetId: userId,
      groupId: group.id,
      ip: clientIp(ctx.req),
    });

    return backToMembers(group.slug, {
      notice: blocked ? "Blocked." : "Unblocked.",
    });
  });

  app.post("/g/:groupSlug/requests/:userId", async (ctx) => {
    const { access, form, kv, group } = await beginAction(ctx);
    const userId = ctx.params.userId!;
    const decision = form.get("decision")?.toString() === "approved"
      ? "approved"
      : "rejected";

    try {
      await decideJoinRequest(kv, group.id, userId, decision, access.user.id);
    } catch (error) {
      if (error instanceof MembershipError) {
        return backToMembers(group.slug, { error: error.message });
      }
      throw error;
    }

    await audit(kv, {
      actorId: access.user.id,
      action: "member.request_decided",
      targetId: userId,
      groupId: group.id,
      after: { decision },
      ip: clientIp(ctx.req),
    });

    return backToMembers(group.slug, {
      notice: decision === "approved" ? "Approved." : "Declined.",
    });
  });

  // ---- The player's side --------------------------------------------------

  /**
   * Asking to join. A GET, because it is reached from a link on a club page
   * rather than a form, and it does not need protecting from a forged
   * cross-site request: the worst it can do is put the caller's own name in
   * front of an organizer, who still decides.
   */
  app.get("/g/:groupSlug/request", async (ctx) => {
    const user = requireUser(ctx.state.auth);
    const access = await resolveGroupAccess(
      ctx.state.auth,
      ctx.params.groupSlug!,
    );

    try {
      await requestToJoin(ctx.state.auth.kv, access.group.id, user.id);
    } catch (error) {
      if (error instanceof MembershipError) {
        return ctx.redirect(
          `/g/${access.group.slug}/games?error=${
            encodeURIComponent(error.message)
          }`,
        );
      }
      throw error;
    }

    return ctx.redirect(`/g/${access.group.slug}/games`);
  });
}
