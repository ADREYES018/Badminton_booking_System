/**
 * Game detail, and every RSVP action.
 *
 * All actions are plain form POSTs that redirect. That is the source of
 * truth: it works with JavaScript disabled, survives a double submit, and
 * cannot leave the client and the server disagreeing about who has a seat.
 * `islands/RsvpButton.tsx` layers feedback on top of exactly these endpoints
 * without replacing them.
 *
 * Errors are carried back on the query string rather than rendered from the
 * POST, so a refresh after an error re-reads the game instead of resubmitting.
 *
 * The payment, results and attendance actions live in `game_actions.tsx` and
 * share the `act` helper from `game_action.ts`.
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
import { hasBill, PaymentPanel } from "../components/PaymentPanel.tsx";
import { ResultsPanel } from "../components/ResultsPanel.tsx";
import {
  CSRF_FIELD,
  csrfCookie,
  HttpError,
  isSecureRequest,
  loadGroupAccess,
  requireUser,
} from "../lib/auth/middleware.ts";
import { act, backToGame } from "./game_action.ts";
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
} from "../lib/data/signups.ts";
import { getUser } from "../lib/data/users.ts";
import { listMatchesForGame } from "../lib/data/matches.ts";
import { sweepInBackground } from "../lib/data/sweep.ts";
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
import type { Game, Match, PayoutDetails, Signup, User } from "../lib/types.ts";

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
  /** Where to send the money. Absent until an organizer fills it in. */
  payout?: PayoutDetails;
  /** Organizers see the settlement link and the attendance controls. */
  isOrganizer: boolean;
  matches: Match[];
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

/**
 * Present, absent, or not yet marked.
 *
 * Three states, not two: `attendedAt` alone cannot tell "nobody has marked
 * this player" apart from "marked as a no-show", and treating the absence of
 * a mark as a no-show would count every unmarked player against themselves.
 */
function attendanceOf(signup: Signup): boolean | null {
  if (signup.attendedAt !== undefined) return true;
  if (signup.markedAbsentAt !== undefined) return false;
  return null;
}

/**
 * An attendance mark, as everyone but the organizer sees it.
 *
 * An unmarked player renders nothing at all. "Not marked yet" is the normal
 * state before an organizer works through the roster, and labelling it would
 * read as a verdict.
 */
function AttendanceChip(props: { signup: Signup }) {
  const state = attendanceOf(props.signup);
  if (state === null) return null;
  return state
    ? <Chip tone="success">Played</Chip>
    : <Chip tone="neutral">No-show</Chip>;
}

/**
 * The organizer's attendance controls for one player.
 *
 * Both buttons always render, with the current state shown as active rather
 * than hidden, so a mis-mark can be corrected — which `setAttendance`
 * supports, moving the count between columns rather than adding to both.
 */
function AttendanceToggle(
  props: { signup: Signup; slug: string; csrf: string; name: string },
) {
  const state = attendanceOf(props.signup);

  const button = (attended: boolean, label: string) => (
    <form method="post" action={`/games/${props.slug}/attendance`}>
      <input type="hidden" name={CSRF_FIELD} value={props.csrf} />
      <input type="hidden" name="userId" value={props.signup.userId} />
      <input type="hidden" name="attended" value={attended ? "1" : "0"} />
      <Button
        type="submit"
        variant={state === attended ? "primary" : "ghost"}
        class="px-4 py-2"
        aria-pressed={state === attended}
        aria-label={`Mark ${props.name} ${label.toLowerCase()}`}
      >
        {label}
      </Button>
    </form>
  );

  return (
    <div class="flex gap-2 shrink-0">
      {button(true, "Present")}
      {button(false, "Absent")}
    </div>
  );
}

function RosterList(
  props: {
    title: string;
    members: RosterMember[];
    note?: string;
    /** Set only for the confirmed list once the cutoff has passed. */
    attendance?: { slug: string; csrf: string };
  },
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
            class="flex flex-wrap items-center gap-3 py-1"
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
            {props.attendance
              ? (
                <AttendanceToggle
                  signup={signup}
                  slug={props.attendance.slug}
                  csrf={props.attendance.csrf}
                  name={user?.name ?? "this player"}
                />
              )
              : <AttendanceChip signup={signup} />}
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
  // There is nothing to report a result about until people have played.
  const started = new Date(game.startUtc).getTime() <= Date.now();
  // Attendance is only meaningful once the roster is settled.
  const pastCutoff = isPastCutoff(game.startUtc, game.cutoffHours);

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

        {hasBill(props.signup) && (
          <PaymentPanel
            signup={props.signup}
            slug={game.slug}
            csrf={props.csrf}
            csrfField={CSRF_FIELD}
            payout={props.payout}
          />
        )}

        {props.isOrganizer && frozen && (
          <a
            href={`/organizer/games/${game.slug}/settlement`}
            class="text-label font-bold text-primary hover:underline w-fit"
          >
            View settlement →
          </a>
        )}

        <ActionPanel {...props} />

        <Card class="flex flex-col gap-6">
          <RosterList
            title="Playing"
            members={props.confirmed}
            attendance={props.isOrganizer && pastCutoff
              ? { slug: game.slug, csrf: props.csrf }
              : undefined}
          />
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

        {started && (
          <ResultsPanel
            matches={props.matches}
            roster={props.confirmed.map(({ signup, user }) => ({
              userId: signup.userId,
              user,
            }))}
            viewerId={user.id}
            slug={game.slug}
            csrf={props.csrf}
            csrfField={CSRF_FIELD}
            canReport={viewerStateOf(props.signup) === "confirmed"}
          />
        )}
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

export function gameRoute(app: App<State>) {
  app.get("/games/:slug", async (ctx) => {
    const user = requireUser(ctx.state.auth);
    const kv = ctx.state.auth.kv;

    const game = await getGameBySlug(kv, ctx.params.slug!);
    if (!game) throw new HttpError(404, "That game could not be found");

    sweepInBackground(kv, game);

    const url = new URL(ctx.req.url);
    // One read covers both: the group carries the payout details a player
    // needs to transfer their share, and the access flag decides whether the
    // organizer's controls render.
    const [signup, roster, access, matches] = await Promise.all([
      getSignup(kv, game.id, user.id),
      loadDetail(kv, game),
      loadGroupAccess(ctx.state.auth, game.groupId),
      listMatchesForGame(kv, game.id),
    ]);

    const response = await ctx.render(
      <GameDetail
        user={user}
        game={game}
        signup={signup}
        csrf={ctx.state.auth.csrfToken}
        payout={access.group.payout}
        isOrganizer={access.isOrganizer}
        matches={matches}
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
