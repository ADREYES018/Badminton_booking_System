/**
 * Game detail, and every RSVP action.
 *
 * All actions are plain form POSTs that redirect. That is the source of
 * truth: it works with JavaScript disabled, survives a double submit, and
 * cannot leave the client and the server disagreeing about who has a seat.
 * `islands/RsvpButton.tsx` layers optimistic feedback on top of exactly these
 * endpoints without replacing them.
 *
 * Errors are carried back on the query string rather than rendered from the
 * POST, so a refresh after an error re-reads the game instead of resubmitting.
 */

import type { App } from "fresh";
import type { ComponentChildren } from "preact";
import type { State } from "../main.ts";
import { Page } from "../components/Layout.tsx";
import {
  Alert,
  Avatar,
  Button,
  Card,
  Chip,
  Field,
  ProgressBar,
} from "../components/ui.tsx";
import {
  GameStatusChip,
  seatsLabel,
  viewerStateOf,
} from "../components/GameCard.tsx";
import RsvpButton from "../islands/RsvpButton.tsx";
import {
  CSRF_FIELD,
  csrfCookie,
  HttpError,
  isSecureRequest,
  requireUser,
  verifyCsrf,
} from "../lib/auth/middleware.ts";
import { getGameBySlug } from "../lib/data/games.ts";
import {
  addGuest,
  confirmPromotion,
  flush,
  getSignup,
  joinGame,
  leaveGame,
  loadRoster,
  removeGuest,
  SignupError,
} from "../lib/data/signups.ts";
import { getUser } from "../lib/data/users.ts";
import { ensureDefaultGroup, ensureMembership } from "../lib/data/groups.ts";
import { sweepInBackground } from "../lib/data/sweep.ts";
import { audit, type AuditAction } from "../lib/data/audit.ts";
import { clientIp } from "../lib/auth/middleware.ts";
import {
  capacityOf,
  displaySplit,
  formatFils,
  seatsTaken,
} from "../lib/domain/money.ts";
import {
  cutoffAt,
  formatGameTime,
  formatRelative,
  isPastCutoff,
} from "../lib/domain/time.ts";
import {
  guestsAllowed,
  joinBlock,
  skillWarning,
} from "../lib/domain/join_rules.ts";
import { cleanText } from "../lib/domain/validate.ts";
import type { Game, Signup, User } from "../lib/types.ts";

interface RosterMember {
  signup: Signup;
  user: User | null;
}

interface DetailProps {
  user: User;
  game: Game;
  signup: Signup | null;
  confirmed: RosterMember[];
  pending: RosterMember[];
  waitlisted: RosterMember[];
  csrf: string;
  error?: string;
  notice?: string;
}

function Stat(props: { label: string; children: ComponentChildren }) {
  return (
    <div class="flex flex-col gap-0.5">
      <dt class="text-label-sm text-on-surface-variant">{props.label}</dt>
      <dd class="text-body-lg text-on-surface font-medium">{props.children}</dd>
    </div>
  );
}

function RosterList(
  props: { title: string; members: RosterMember[]; note?: string },
) {
  if (props.members.length === 0) return null;

  return (
    <section class="flex flex-col gap-3">
      <div class="flex items-baseline gap-2">
        <h3 class="text-body-lg font-bold text-on-surface">{props.title}</h3>
        <span class="text-label-sm text-on-surface-variant">
          {props.members.length}
        </span>
      </div>
      {props.note && (
        <p class="text-label-sm text-on-surface-variant">{props.note}</p>
      )}
      <ul class="flex flex-col gap-2">
        {props.members.map(({ signup, user }) => (
          <li
            key={signup.userId}
            class="flex items-center gap-3 py-1"
          >
            <Avatar
              name={user?.name ?? "Player"}
              userId={signup.userId}
              hasPhoto={user?.hasPhoto}
              size={36}
            />
            <span class="text-body-md text-on-surface flex-1 min-w-0 truncate">
              {user?.name ?? "Player"}
            </span>
            {signup.guests.map((guest) => (
              <Chip key={guest.id} tone="neutral">+1 {guest.name}</Chip>
            ))}
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * The action panel.
 *
 * What a player can do depends on where they stand, so this renders exactly
 * one primary action rather than a row of buttons that are mostly disabled.
 */
function ActionPanel(props: DetailProps) {
  const { game, signup, user, csrf } = props;
  const state = viewerStateOf(signup);
  const block = joinBlock(game);
  const warning = skillWarning(game, user);
  const cutoff = cutoffAt(game.startUtc, game.cutoffHours);
  const pastCutoff = isPastCutoff(game.startUtc, game.cutoffHours);
  const guestSlots = signup
    ? guestsAllowed(game, signup.guests.length)
    : guestsAllowed(game, 0);

  if (game.status === "cancelled") {
    return (
      <Alert tone="error">
        This game was cancelled.
        {game.cancelledReason ? ` ${game.cancelledReason}` : ""}
      </Alert>
    );
  }

  if (block) {
    return <Alert tone="info">This game is closed for sign-ups.</Alert>;
  }

  return (
    <div class="flex flex-col gap-4">
      {warning && state === "none" && <Alert tone="info">{warning}</Alert>}

      {state === "pending_confirm" && signup?.confirmDeadline && (
        <Alert tone="success">
          A spot opened up and it is yours if you want it. Confirm{" "}
          {formatRelative(signup.confirmDeadline)}{" "}
          or it passes to the next player.
        </Alert>
      )}

      {state === "waitlisted" && (
        <Alert tone="info">
          You are on the waitlist. We will offer you a spot the moment one frees
          up.
        </Alert>
      )}

      {state === "none" && (
        <RsvpButton
          action={`/games/${game.slug}/join`}
          csrf={csrf}
          csrfField={CSRF_FIELD}
          label={seatsTaken(game) >= capacityOf(game)
            ? "Join the waitlist"
            : "Join this game"}
          pendingLabel="Joining…"
        />
      )}

      {state === "pending_confirm" && (
        <RsvpButton
          action={`/games/${game.slug}/confirm`}
          csrf={csrf}
          csrfField={CSRF_FIELD}
          label="Confirm my spot"
          pendingLabel="Confirming…"
        />
      )}

      {(state === "confirmed" || state === "waitlisted" ||
        state === "pending_confirm") && (
        <form method="post" action={`/games/${game.slug}/leave`}>
          <input type="hidden" name={CSRF_FIELD} value={csrf} />
          <Button type="submit" variant="ghost" fullWidth>
            {state === "waitlisted" ? "Leave the waitlist" : "Cancel my spot"}
          </Button>
          <p class="text-label-sm text-on-surface-variant mt-2 text-center">
            {pastCutoff
              ? "The cutoff has passed — cancelling now still leaves you owing your share."
              : `Free until ${formatRelative(cutoff.toISOString())}.`}
          </p>
        </form>
      )}

      {state === "confirmed" && game.maxGuestsPerPlayer > 0 && !pastCutoff && (
        <Card class="flex flex-col gap-3">
          <h3 class="text-body-lg font-bold text-on-surface">Bring a guest</h3>

          {signup && signup.guests.length > 0 && (
            <ul class="flex flex-col gap-2">
              {signup.guests.map((guest) => (
                <li key={guest.id} class="flex items-center gap-2">
                  <span class="text-body-md text-on-surface flex-1">
                    {guest.name}
                  </span>
                  <form
                    method="post"
                    action={`/games/${game.slug}/guests/remove`}
                  >
                    <input type="hidden" name={CSRF_FIELD} value={csrf} />
                    <input type="hidden" name="guestId" value={guest.id} />
                    <Button type="submit" variant="ghost" class="px-4 py-2">
                      Remove
                    </Button>
                  </form>
                </li>
              ))}
            </ul>
          )}

          {guestSlots > 0
            ? (
              <form
                method="post"
                action={`/games/${game.slug}/guests`}
                class="flex flex-col gap-3"
              >
                <input type="hidden" name={CSRF_FIELD} value={csrf} />
                <Field
                  label="Guest name"
                  name="guestName"
                  required
                  maxLength={60}
                  placeholder="Who are you bringing?"
                  hint={`They take a seat and are charged ${
                    game.guestPricing.mode === "free"
                      ? "nothing — you cover them"
                      : game.guestPricing.mode === "flat_fee"
                      ? formatFils(game.guestPricing.feeFils)
                      : "a full share"
                  }.`}
                />
                <Button type="submit" variant="secondary">Add guest</Button>
              </form>
            )
            : (
              <p class="text-label-sm text-on-surface-variant">
                {signup && signup.guests.length >= game.maxGuestsPerPlayer
                  ? "You have added all the guests this game allows."
                  : "No seats left for a guest right now."}
              </p>
            )}
        </Card>
      )}
    </div>
  );
}

function GameDetail(props: DetailProps) {
  const { game, user } = props;
  const split = displaySplit(game);
  const empty = game.frozenPerHeadFils === undefined &&
    game.confirmedCount === 0;
  const frozen = game.frozenPerHeadFils !== undefined;

  return (
    <Page user={user} nav="games">
      <div class="flex flex-col gap-6 max-w-3xl mx-auto">
        <a
          href="/games"
          class="text-label font-bold text-on-surface-variant hover:text-primary transition-colors w-fit"
        >
          ← All games
        </a>

        {props.error && <Alert tone="error">{props.error}</Alert>}
        {props.notice && <Alert tone="success">{props.notice}</Alert>}

        <header class="flex flex-col gap-3">
          <div class="flex items-start justify-between gap-4">
            <h1 class="text-headline-lg font-headline text-on-surface">
              {game.title}
            </h1>
            <GameStatusChip game={game} />
          </div>
          <p class="text-body-lg text-on-surface-variant">
            {formatGameTime(game.startUtc, game.endUtc)}
          </p>
        </header>

        <Card class="flex flex-col gap-5">
          <dl class="grid grid-cols-2 gap-4">
            <Stat label="Venue">{game.venue.name}</Stat>
            <Stat label="Courts">
              {game.courts} × {game.playersPerCourt} players
            </Stat>
            <Stat label="Total court cost">
              {formatFils(game.totalCostFils)}
            </Stat>
            <Stat
              label={frozen
                ? "Your share"
                : empty
                ? "Your share if you join alone"
                : "Estimated share"}
            >
              {formatFils(split.perHeadFils)}
            </Stat>
          </dl>

          <p class="text-label-sm text-on-surface-variant">
            {game.venue.address}
          </p>

          <ProgressBar
            value={seatsTaken(game)}
            max={capacityOf(game)}
            label={seatsLabel(game)}
          />

          {!frozen && (
            <p class="text-label-sm text-on-surface-variant">
              The share moves as people join and settles at the cutoff,{" "}
              {formatRelative(
                cutoffAt(game.startUtc, game.cutoffHours).toISOString(),
              )}.
            </p>
          )}
        </Card>

        <ActionPanel {...props} />

        <Card class="flex flex-col gap-6">
          <RosterList title="Playing" members={props.confirmed} />
          <RosterList
            title="Holding a spot"
            members={props.pending}
            note="Offered a spot and yet to confirm."
          />
          <RosterList
            title="Waitlist"
            members={props.waitlisted}
            note="In the order they joined."
          />
          {props.confirmed.length === 0 && props.waitlisted.length === 0 && (
            <p class="text-body-md text-on-surface-variant text-center py-4">
              Nobody has joined yet. Be the first.
            </p>
          )}
        </Card>
      </div>
    </Page>
  );
}

/** Loads the roster and resolves each signup to a user for display. */
async function loadDetail(
  kv: Deno.Kv,
  game: Game,
): Promise<Pick<DetailProps, "confirmed" | "pending" | "waitlisted">> {
  const roster = await loadRoster(kv, game.id);

  const withUsers = async (signups: Signup[]): Promise<RosterMember[]> =>
    await Promise.all(
      signups.map(async (signup) => ({
        signup,
        user: await getUser(kv, signup.userId),
      })),
    );

  const [confirmed, pending, waitlisted] = await Promise.all([
    withUsers(roster.confirmed),
    withUsers(roster.pending),
    withUsers(roster.waitlisted),
  ]);

  return { confirmed, pending, waitlisted };
}

/** Redirect carrying a message, so a refresh never resubmits the action. */
function backToGame(slug: string, params: Record<string, string> = {}) {
  const query = new URLSearchParams(params).toString();
  return new Response(null, {
    status: 303,
    headers: { location: `/games/${slug}${query ? `?${query}` : ""}` },
  });
}

export function gameRoute(app: App<State>) {
  app.get("/games/:slug", async (ctx) => {
    const user = requireUser(ctx.state.auth);
    const kv = ctx.state.auth.kv;

    const game = await getGameBySlug(kv, ctx.params.slug!);
    if (!game) throw new HttpError(404, "That game could not be found");

    sweepInBackground(kv, game);

    const url = new URL(ctx.req.url);
    const [signup, roster] = await Promise.all([
      getSignup(kv, game.id, user.id),
      loadDetail(kv, game),
    ]);

    const response = await ctx.render(
      <GameDetail
        user={user}
        game={game}
        signup={signup}
        csrf={ctx.state.auth.csrfToken}
        error={url.searchParams.get("error") ?? undefined}
        notice={url.searchParams.get("notice") ?? undefined}
        {...roster}
      />,
    );
    response.headers.append(
      "set-cookie",
      csrfCookie(ctx.state.auth.csrfToken, isSecureRequest(ctx.req)),
    );
    return response;
  });

  /**
   * Shared prologue for every action: authenticate, verify CSRF, load the
   * game, and make sure the player is a member of the club.
   */
  async function begin(ctx: {
    req: Request;
    params: Record<string, string | undefined>;
    state: State;
  }) {
    const user = requireUser(ctx.state.auth);
    const kv = ctx.state.auth.kv;
    const form = await ctx.req.formData();

    if (!verifyCsrf(ctx.req, form.get(CSRF_FIELD)?.toString() ?? null)) {
      throw new HttpError(403, "That form expired. Please try again.");
    }

    const game = await getGameBySlug(kv, ctx.params.slug!);
    if (!game) throw new HttpError(404, "That game could not be found");

    const group = await ensureDefaultGroup(kv, user.id);
    await ensureMembership(kv, group.id, user.id);

    return { user, kv, form, game };
  }

  /**
   * Runs one RSVP action: perform it, flush any queue effects, record the
   * audit entry, and redirect with the resulting message.
   *
   * Every action shares this shape, including the `SignupError` catch. That
   * catch is the reason this is one helper rather than five copies — a
   * `SignupError` is a refusal the player can act on and must come back as a
   * readable message, whereas anything else is a bug and has to keep
   * propagating to the error handler. Getting that distinction wrong in one
   * copy out of five is exactly the kind of thing that goes unnoticed.
   */
  async function act(
    ctx: {
      req: Request;
      params: Record<string, string | undefined>;
      state: State;
    },
    run: (
      context: { user: User; kv: Deno.Kv; form: FormData; game: Game },
    ) => Promise<{ action: AuditAction; notice: string } | Response>,
  ): Promise<Response> {
    const context = await begin(ctx);

    try {
      const outcome = await run(context);
      // A validation failure returns its own redirect and records nothing.
      if (outcome instanceof Response) return outcome;

      await audit(context.kv, {
        actorId: context.user.id,
        action: outcome.action,
        targetId: context.game.id,
        groupId: context.game.groupId,
        ip: clientIp(ctx.req),
      });
      return backToGame(context.game.slug, { notice: outcome.notice });
    } catch (error) {
      if (error instanceof SignupError) {
        return backToGame(context.game.slug, { error: error.message });
      }
      throw error;
    }
  }

  app.post(
    "/games/:slug/join",
    (ctx) =>
      act(ctx, async ({ user, kv, game }) => {
        const result = await joinGame(kv, game.id, user);
        await flush(kv, result.effects);

        return result.outcome === "confirmed"
          ? { action: "signup.joined", notice: "You are in. See you on court." }
          : {
            action: "signup.waitlisted",
            notice:
              "You are on the waitlist — we will let you know if a spot opens.",
          };
      }),
  );

  app.post(
    "/games/:slug/leave",
    (ctx) =>
      act(ctx, async ({ user, kv, game }) => {
        const result = await leaveGame(kv, game.id, user.id);
        await flush(kv, result.effects);

        return {
          action: "signup.left",
          notice: result.signup.payment === "forfeited"
            ? "You are off the roster. The cutoff has passed, so your share is still owed."
            : "You are off the roster.",
        };
      }),
  );

  app.post(
    "/games/:slug/confirm",
    (ctx) =>
      act(ctx, async ({ user, kv, game }) => {
        await confirmPromotion(kv, game.id, user.id);
        return {
          action: "signup.promotion_confirmed",
          notice: "Your spot is confirmed.",
        };
      }),
  );

  app.post(
    "/games/:slug/guests",
    (ctx) =>
      act(ctx, async ({ user, kv, form, game }) => {
        const name = cleanText(form.get("guestName")?.toString() ?? "", 60);
        if (name.length < 2) {
          return backToGame(game.slug, {
            error:
              "Give your guest's name so the organizer knows who to expect.",
          });
        }

        await addGuest(kv, game.id, user.id, { name });
        return { action: "guest.added", notice: `${name} is on the list.` };
      }),
  );

  app.post(
    "/games/:slug/guests/remove",
    (ctx) =>
      act(ctx, async ({ user, kv, form, game }) => {
        const guestId = form.get("guestId")?.toString() ?? "";
        const result = await removeGuest(kv, game.id, user.id, guestId);
        await flush(kv, result.effects);

        return { action: "guest.removed", notice: "Guest removed." };
      }),
  );
}
