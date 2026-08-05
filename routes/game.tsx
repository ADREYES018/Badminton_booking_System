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
  AccessChip,
  GameStatusChip,
  seatsLabel,
  viewerStateOf,
} from "../components/GameCard.tsx";
import RsvpButton from "../islands/RsvpButton.tsx";
import PaymentDialog from "../islands/PaymentDialog.tsx";
import GamePostedDialog from "../islands/GamePostedDialog.tsx";
import ShareLink from "../islands/ShareLink.tsx";
import OrganizerContact from "../islands/OrganizerContact.tsx";
import { hasBill, PaymentPanel } from "../components/PaymentPanel.tsx";
import { ResultsPanel } from "../components/ResultsPanel.tsx";
import { AttendanceChip, playersFrom } from "../components/Attendance.tsx";
import AttendancePanel from "../islands/AttendancePanel.tsx";
import { CheckinCode } from "../components/CheckinCode.tsx";
import { checkinVersionOf, mintCheckinToken } from "../lib/domain/checkin.ts";
import {
  assertNotBlocked,
  CSRF_FIELD,
  csrfCookie,
  HttpError,
  isSecureRequest,
  loadGameAccess,
  requireGameOrganizer,
  requireUser,
} from "../lib/auth/middleware.ts";
import {
  codeMatches,
  hasUnlocked,
  recordUnlock,
} from "../lib/domain/game_access.ts";
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
  promotePlayer,
  removeGuest,
} from "../lib/data/signups.ts";
import { getUser } from "../lib/data/users.ts";
import { listMatchesForGame } from "../lib/data/matches.ts";
import { sweepInBackground } from "../lib/data/sweep.ts";
import {
  amountOwed,
  capacityOf,
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
import { mapsUrl } from "../lib/domain/venue.ts";
import {
  accessDecidedEmail,
  accessRequestedEmail,
  appUrl,
  sendEmail,
} from "../lib/email.ts";
import {
  approveAccess,
  getAccessRequest,
  listAccessRequests,
  rejectAccess,
  requestAccess,
} from "../lib/data/access_requests.ts";
import { SPORT_LABELS } from "../lib/types.ts";
import type {
  AccessRequest,
  Game,
  Match,
  PayoutDetails,
  Signup,
  User,
} from "../lib/types.ts";

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
  /**
   * The club this game belongs to, for links back into its own screens.
   * Absent for a clubless game, which has no club screens to link to.
   */
  groupSlug?: string;
  /**
   * Whether this viewer may take a seat.
   *
   * True for every game except a password one whose code they have not
   * entered. The page itself is readable either way.
   */
  unlocked: boolean;
  /**
   * This viewer's own standing request, when they have made one. Drives
   * whether the locked panel offers to ask or reports on an ask already made.
   */
  accessRequest?: AccessRequest;
  /**
   * Requests still waiting on an answer, for the organizer. Each carries the
   * asker so the list reads as people rather than as ids.
   */
  pendingAccess?: { request: AccessRequest; user: User | null }[];
  matches: Match[];
  /** Minted per request for a confirmed player once the cutoff has passed. */
  checkinToken?: string;
  /**
   * Whoever runs this game, for the contact card.
   *
   * Set only when the viewer holds a place on the roster and the organizer has
   * a number to reach. A phone number is personal data and a public game's URL
   * is not a credential, so this is withheld from passers-by rather than
   * rendered and hidden.
   */
  organizerContact?: { name: string; phone: string };
  /**
   * Raises the payment dialog, set only on the redirect that follows taking a
   * seat. A reload drops it, so the prompt appears once rather than every time
   * the player opens the game.
   */
  promptPayment?: boolean;
  /**
   * Raises the "your game is posted" confirmation, set only on the redirect
   * that follows creating one. A reload drops it.
   */
  justPosted?: boolean;
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
  props: {
    title: string;
    members: RosterMember[];
    note?: string;
    /** Set for an organizer, who may drop a player from the roster. */
    remove?: { slug: string; csrf: string; viewerId: string };
    /**
     * Set on the waitlist for an organizer, who may seat someone ahead of
     * their turn or past the stated capacity.
     */
    promote?: { slug: string; csrf: string };
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
            <AttendanceChip signup={signup} />
            {
              /* Removing someone from the roster. Offered only to whoever runs
                 the game, and never against themselves — an organizer dropping
                 their own seat uses "Cancel my spot" like anyone else, which
                 goes through the same refund and waitlist rules. */
            }
            {
              /* Seating someone off the waitlist. Offered on the waitlist
                 only, and regardless of remaining seats — the organizer
                 decides how many can actually play. */
            }
            {props.promote && (
              <form
                method="post"
                action={`/games/${props.promote.slug}/promote`}
                class="shrink-0"
              >
                <input
                  type="hidden"
                  name={CSRF_FIELD}
                  value={props.promote.csrf}
                />
                <input type="hidden" name="userId" value={signup.userId} />
                <Button
                  type="submit"
                  variant="secondary"
                  class="px-4 py-2"
                  aria-label={`Give ${
                    user?.name ?? "this player"
                  } a spot in this game`}
                >
                  Give a spot
                </Button>
              </form>
            )}
            {props.remove && signup.userId !== props.remove.viewerId && (
              <form
                method="post"
                action={`/games/${props.remove.slug}/remove`}
                class="shrink-0"
              >
                <input
                  type="hidden"
                  name={CSRF_FIELD}
                  value={props.remove.csrf}
                />
                <input type="hidden" name="userId" value={signup.userId} />
                <Button
                  type="submit"
                  variant="ghost"
                  class="px-4 py-2"
                  aria-label={`Remove ${
                    user?.name ?? "this player"
                  } from this game`}
                >
                  Remove
                </Button>
              </form>
            )}
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

  // Someone who followed a shared link can read the whole page, so a password
  // game shows everything but the way in — the panel tells them what stands
  // between them and a seat rather than an RSVP button that would refuse them.
  if (!props.unlocked) {
    return (
      <Card class="flex flex-col gap-3">
        <div class="flex flex-col gap-1">
          <h2 class="text-body-lg font-bold text-on-surface">
            This game needs a code
          </h2>
          <p class="text-label-sm text-on-surface-variant">
            The organizer gives it to the players they want. Enter it once and
            you are in for good.
          </p>
        </div>
        <form
          method="post"
          action={`/games/${game.slug}/unlock`}
          class="flex flex-col gap-3"
        >
          <input type="hidden" name={CSRF_FIELD} value={csrf} />
          <Field
            label="Six-digit code"
            name="joinCode"
            required
            inputMode="numeric"
            maxLength={6}
            placeholder="000000"
          />
          <Button type="submit" variant="primary">Unlock this game</Button>
        </form>

        {
          /* The other way in, for someone who has the link but knows nobody
             holding the code. Without this the lock is a dead end rather than
             a door, and the game's only route in is already knowing someone. */
        }
        <div class="border-t border-outline-variant/40 pt-3 flex flex-col gap-3">
          {props.accessRequest?.status === "pending"
            ? (
              <p class="text-label-sm text-on-surface-variant">
                You have asked the organizer to let you in. They will get back
                to you.
              </p>
            )
            : props.accessRequest?.status === "rejected"
            ? (
              <p class="text-label-sm text-on-surface-variant">
                The organizer turned down your last request. You can ask again
                if something has changed.
              </p>
            )
            : (
              <p class="text-label-sm text-on-surface-variant">
                No code? Ask the organizer and they can let you straight in.
              </p>
            )}

          {props.accessRequest?.status !== "pending" && (
            <form
              method="post"
              action={`/games/${game.slug}/access/request`}
              class="flex flex-col gap-3"
            >
              <input type="hidden" name={CSRF_FIELD} value={csrf} />
              <Field
                label="Anything to tell them? (optional)"
                name="message"
                maxLength={280}
                placeholder="I play with Sam on Tuesdays"
              />
              <Button type="submit" variant="secondary">
                Ask to join
              </Button>
            </form>
          )}
        </div>
      </Card>
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
                    formatFils(game.pricePerPlayerFils)
                  }, added to what you owe.`}
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
  // There is nothing to report a result about until people have played.
  const started = new Date(game.startUtc).getTime() <= Date.now();
  // Attendance is only meaningful once the roster is settled.
  const pastCutoff = isPastCutoff(game.startUtc, game.cutoffHours);
  // A cancelled game's roster is a record of who was on it, not a list to
  // manage, so the remove controls come off with the game.
  const remove = props.isOrganizer && game.status !== "cancelled"
    ? { slug: game.slug, csrf: props.csrf, viewerId: user.id }
    : undefined;

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
            <div class="flex flex-col items-end gap-1.5 shrink-0">
              <GameStatusChip game={game} />
              <AccessChip game={game} />
            </div>
          </div>
          <p class="text-body-lg text-on-surface-variant">
            {formatGameTime(game.startUtc, game.endUtc)}
          </p>
        </header>

        {
          /*
          The organizer's toolbar for this game.

          These used to sit far down the page, below the payment panels, so an
          organizer who opened their own game had to scroll past everything a
          player sees to reach the two screens only they can use. Sitting under
          the header puts them where the page says whose game this is.

          Editing points at the club-free path, which checks the same rights
          and works for a game with no club at all. Settlement lives under a
          club, so a clubless game has no screen to link to — its organizer
          settles up from the roster below.
        */
        }
        {props.isOrganizer && (
          <nav
            aria-label="Organizer tools"
            class="flex flex-wrap items-center gap-2 -mt-2"
          >
            <a
              href={`/games/${game.slug}/edit`}
              class="inline-flex items-center gap-1.5 rounded-full border border-outline-variant bg-surface-container px-4 py-2 text-label font-bold text-on-surface hover:border-primary hover:text-primary transition-colors"
            >
              Edit game settings
            </a>
            {props.groupSlug && (
              <a
                href={`/g/${props.groupSlug}/organizer/games/${game.slug}/settlement`}
                class="inline-flex items-center gap-1.5 rounded-full border border-outline-variant bg-surface-container px-4 py-2 text-label font-bold text-on-surface hover:border-primary hover:text-primary transition-colors"
              >
                View settlement
              </a>
            )}
          </nav>
        )}

        <Card class="flex flex-col gap-5">
          <dl class="grid grid-cols-2 gap-4">
            <Stat label="Venue">
              <a
                href={mapsUrl(game.venue)}
                target="_blank"
                rel="noopener noreferrer"
                class="text-primary hover:underline"
              >
                {game.venue.name}
              </a>
            </Stat>
            <Stat label="Sport">{SPORT_LABELS[game.sport]}</Stat>
            <Stat label="Courts">{game.courts}</Stat>
            <Stat label="Price per player">
              {formatFils(game.pricePerPlayerFils)}
            </Stat>
            <Stat label="You owe">
              {formatFils(amountOwed(props.signup ?? { guests: [] }, game))}
            </Stat>
          </dl>

          <a
            href={mapsUrl(game.venue)}
            target="_blank"
            rel="noopener noreferrer"
            class="text-label-sm text-on-surface-variant hover:text-primary transition-colors w-fit"
          >
            {game.venue.address} — open in Maps
          </a>

          <ProgressBar
            value={seatsTaken(game)}
            max={capacityOf(game)}
            label={seatsLabel(game)}
          />

          {!game.rosterFrozenAt && (
            <p class="text-label-sm text-on-surface-variant">
              The roster closes {formatRelative(
                cutoffAt(game.startUtc, game.cutoffHours).toISOString(),
              )}. The price is fixed — it does not change as people join.
            </p>
          )}
        </Card>

        {
          /*
          The join code, shown to whoever runs the game for as long as the game
          exists.

          The posted-game dialog also carries it, but that is one dismissible
          moment and needs JavaScript — an organizer who closed it, reopened the
          page later, or has scripting off would otherwise have no way back to a
          code that is the only route into their own game.
        */
        }
        {
          /* Shown for every game, public included: a game nobody has been told
             about is a game nobody joins, and "anyone can find it" is not the
             same as anyone having found it. */
        }
        {game.status !== "cancelled" && (
          <ShareLink
            url={new URL(`/games/${game.slug}`, appUrl()).toString()}
            title={game.title}
          />
        )}

        {props.organizerContact && (
          <OrganizerContact
            name={props.organizerContact.name}
            phone={props.organizerContact.phone}
          />
        )}

        {props.isOrganizer && game.visibility === "password" &&
          game.joinCode && (
          <Card class="flex flex-col gap-1">
            <span class="text-label font-bold text-on-surface-variant">
              Join code
            </span>
            <span class="text-headline-md font-headline text-on-surface tabular-nums tracking-[0.2em]">
              {game.joinCode}
            </span>
            <span class="text-label-sm text-on-surface-variant">
              Players need this as well as the link. Anyone can see the game;
              only this code lets them take a seat.
            </span>
          </Card>
        )}

        {props.checkinToken && <CheckinCode token={props.checkinToken} />}

        {hasBill(props.signup) && (
          <PaymentPanel
            signup={props.signup}
            game={game}
            slug={game.slug}
            csrf={props.csrf}
            csrfField={CSRF_FIELD}
            payout={props.payout}
          />
        )}

        {props.justPosted && props.isOrganizer && (
          <GamePostedDialog
            title={game.title}
            url={new URL(`/games/${game.slug}`, appUrl()).toString()}
            joinCode={game.joinCode}
          />
        )}

        {props.promptPayment && props.signup && (
          <PaymentDialog
            owed={formatFils(amountOwed(props.signup, game))}
            slug={game.slug}
            csrf={props.csrf}
            csrfField={CSRF_FIELD}
            payout={props.payout}
            alreadyMarked={props.signup.payment !== "unpaid"}
          />
        )}

        <ActionPanel {...props} />

        {
          /* Waiting requests, for whoever runs the game. Above the roster
             because it is the one thing here that is waiting on them — the
             roster is a record, this is a queue. */
        }
        {props.isOrganizer && props.pendingAccess &&
          props.pendingAccess.length > 0 && (
          <Card class="flex flex-col gap-4">
            <div class="flex flex-col gap-1">
              <h2 class="text-body-lg font-bold text-on-surface">
                Asking to join
              </h2>
              <p class="text-label-sm text-on-surface-variant">
                Letting someone in means they can take a seat without the code.
                It does not put them on the roster — they still join themselves.
              </p>
            </div>
            <ul class="flex flex-col gap-3">
              {props.pendingAccess.map(({ request, user }) => (
                <li
                  key={request.userId}
                  class="flex flex-wrap items-center gap-3"
                >
                  <Avatar
                    name={user?.name ?? "Player"}
                    userId={request.userId}
                    hasPhoto={user?.hasPhoto}
                    size={36}
                  />
                  <div class="flex flex-col min-w-0 flex-1">
                    <span class="text-body-md text-on-surface truncate">
                      {user?.name ?? "Player"}
                    </span>
                    {request.message && (
                      <span class="text-label-sm text-on-surface-variant">
                        “{request.message}”
                      </span>
                    )}
                  </div>
                  <div class="flex gap-1 shrink-0">
                    <form
                      method="post"
                      action={`/games/${game.slug}/access/decide`}
                    >
                      <input
                        type="hidden"
                        name={CSRF_FIELD}
                        value={props.csrf}
                      />
                      <input
                        type="hidden"
                        name="userId"
                        value={request.userId}
                      />
                      <input type="hidden" name="decision" value="approve" />
                      <Button
                        type="submit"
                        variant="secondary"
                        class="px-4 py-2"
                        aria-label={`Let ${user?.name ?? "this player"} in`}
                      >
                        Let them in
                      </Button>
                    </form>
                    <form
                      method="post"
                      action={`/games/${game.slug}/access/decide`}
                    >
                      <input
                        type="hidden"
                        name={CSRF_FIELD}
                        value={props.csrf}
                      />
                      <input
                        type="hidden"
                        name="userId"
                        value={request.userId}
                      />
                      <input type="hidden" name="decision" value="reject" />
                      <Button
                        type="submit"
                        variant="ghost"
                        class="px-4 py-2"
                        aria-label={`Turn down ${user?.name ?? "this player"}`}
                      >
                        No
                      </Button>
                    </form>
                  </div>
                </li>
              ))}
            </ul>
          </Card>
        )}

        <Card class="flex flex-col gap-6">
          <RosterList
            title="Playing"
            members={props.confirmed}
            remove={remove}
          />
          <RosterList
            title="Holding a spot"
            members={props.pending}
            note="Offered a spot and yet to confirm."
            remove={remove}
          />
          <RosterList
            title="Waitlist"
            members={props.waitlisted}
            note={props.isOrganizer
              ? "In the order they joined. Giving someone a spot works even when the game is full."
              : "In the order they joined."}
            remove={remove}
            promote={props.isOrganizer && game.status !== "cancelled"
              ? { slug: game.slug, csrf: props.csrf }
              : undefined}
          />
          {props.confirmed.length === 0 && props.waitlisted.length === 0 && (
            <p class="text-body-md text-on-surface-variant text-center py-4">
              Nobody has joined yet. Be the first.
            </p>
          )}
        </Card>

        {
          /*
          Attendance is its own panel rather than a control per roster row: it
          is one task the organizer does once, at the door, and batching it
          means the page reloads when they are finished instead of after every
          player. Only after the cutoff, when the roster is settled and there
          is something to take attendance of.
        */
        }
        {props.isOrganizer && pastCutoff && props.confirmed.length > 0 && (
          <Card class="flex flex-col gap-4">
            <div class="flex flex-col gap-1">
              <h2 class="text-body-lg font-bold text-on-surface">Attendance</h2>
              <p class="text-label-sm text-on-surface-variant">
                Mark who turned up, then save. A no-show counts against that
                player's record.
              </p>
            </div>
            <AttendancePanel
              slug={game.slug}
              csrf={props.csrf}
              csrfField={CSRF_FIELD}
              players={playersFrom(props.confirmed)}
            />
          </Card>
        )}

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

/**
 * Tells whoever runs the game that someone is asking to be let in.
 *
 * Deliberately not awaited into the player's response and deliberately never
 * throwing: the request is already recorded by the time this runs, and a mail
 * provider having a bad minute must not turn a successful ask into an error
 * the player sees and retries into a duplicate.
 *
 * Goes to the game's creator rather than a club's owner — for this decision
 * the person who set the code is the one who knows who should have it.
 */
function notifyOrganizerOfRequest(
  kv: Deno.Kv,
  game: Game,
  player: User,
  message?: string,
): void {
  (async () => {
    const organizer = await getUser(kv, game.createdBy);
    if (!organizer?.email) return;
    await sendEmail(
      accessRequestedEmail(organizer.email, game, player.name, message),
    );
  })().catch((error) => {
    console.error(`Access request notice failed for game ${game.id}`, error);
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
    // One read covers both: the group carries the payout details a player
    // needs to transfer their share, and the access flag decides whether the
    // organizer's controls render.
    const [signup, roster, access, matches] = await Promise.all([
      getSignup(kv, game.id, user.id),
      loadDetail(kv, game),
      loadGameAccess(ctx.state.auth, game),
      listMatchesForGame(kv, game.id),
    ]);

    // Any signed-in reader who has the URL may see the page — that is how a
    // link shared into a chat brings someone in, and it is the whole mechanism
    // behind an unlisted game. What the organizer's choice actually gates is
    // the seat, which `unlocked` decides.
    const unlocked = await hasUnlocked(kv, game, user.id, access.isOrganizer);

    // The player's permanent code, shown to anyone holding a seat. It is the
    // same code everywhere, so there is nothing to withhold until the cutoff.
    const checkinToken = signup?.status === "confirmed" &&
        game.status !== "cancelled"
      ? await mintCheckinToken(user.id, checkinVersionOf(user))
      : undefined;

    // The organizer's number, for players who hold a place on this roster.
    // Anyone signed in may read the page, so gating on a signup rather than on
    // the page being reachable is what keeps a phone number from being handed
    // to whoever opens a shared link. The organizer is excluded because it
    // would be their own number.
    const onRoster = signup?.status === "confirmed" ||
      signup?.status === "pending_confirm" || signup?.status === "waitlisted";

    // Loaded whenever there is no club to be paid through, since then the
    // organizer's own details are the only answer to "where do I send it?".
    const organizer = onRoster || !access.group
      ? await getUser(kv, game.createdBy)
      : null;

    // Contact stays gated on holding a place — a phone number is personal data
    // and a shared link is not a credential. The organizer is excluded because
    // it would be their own number.
    const organizerContact = onRoster && game.createdBy !== user.id &&
        organizer?.phone
      ? { name: organizer.name, phone: organizer.phone }
      : undefined;

    // A club's account first: a game posted under a club is the club's to
    // collect for. Only a clubless game falls back to whoever posted it.
    const payout = access.group?.payout ?? organizer?.payout;

    // Only a locked game can have requests, so a public one skips both reads.
    const locked = game.visibility !== "public";
    const accessRequest = locked && !access.isOrganizer
      ? await getAccessRequest(kv, game.id, user.id) ?? undefined
      : undefined;

    const pendingAccess = locked && access.isOrganizer
      ? await Promise.all(
        (await listAccessRequests(kv, game.id))
          .filter((request) => request.status === "pending")
          .map(async (request) => ({
            request,
            user: await getUser(kv, request.userId),
          })),
      )
      : undefined;

    const response = await ctx.render(
      <GameDetail
        user={user}
        game={game}
        signup={signup}
        csrf={ctx.state.auth.csrfToken}
        payout={payout}
        isOrganizer={access.isOrganizer}
        groupSlug={access.group?.slug}
        unlocked={unlocked}
        matches={matches}
        checkinToken={checkinToken}
        organizerContact={organizerContact}
        accessRequest={accessRequest}
        pendingAccess={pendingAccess}
        promptPayment={url.searchParams.get("pay") === "1"}
        justPosted={url.searchParams.get("posted") === "1"}
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
      act(ctx, async ({ user, kv, game, access }) => {
        // The page is open to anyone signed in; the seat is what the organizer
        // gates. A password game needs the code entered first, and this is the
        // check that enforces it — the hidden form is not access control.
        assertNotBlocked(access.membership);
        if (!await hasUnlocked(kv, game, user.id, access.isOrganizer)) {
          throw new HttpError(403, "This game needs its code before you join.");
        }

        const result = await joinGame(kv, game.id, user);
        await flush(kv, result.effects);

        // `pay=1` is what raises the payment dialog on the page they land on.
        // It rides on the redirect rather than being inferred from the notice
        // text, and only for a seat actually taken — a waitlisted player owes
        // nothing until they are promoted and accept.
        return result.outcome === "confirmed"
          ? {
            action: "signup.joined",
            notice: "You are in. See you on court.",
            redirect: backToGame(game.slug, {
              notice: "You are in. See you on court.",
              pay: "1",
            }),
          }
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

        const owed = result.signup.payment === "forfeited";
        const notice = owed
          ? "You are off the roster. The cutoff has passed, so your share is still owed."
          : "You are off the roster.";

        // Back to the list rather than the game just left: there is nothing on
        // that page for someone no longer on its roster. `cancelled` raises the
        // confirmation on arrival, so landing somewhere else reads as the
        // cancellation having worked rather than as having been bounced.
        return {
          action: "signup.left",
          notice,
          redirect: new Response(null, {
            status: 303,
            headers: {
              location: `/games?${new URLSearchParams({
                notice,
                cancelled: game.title,
                ...(owed ? { owed: "1" } : {}),
              })}`,
            },
          }),
        };
      }),
  );

  /**
   * The organizer dropping someone from the roster.
   *
   * The same backend call a player's own cancellation makes, with
   * `byOrganizer` set — which is what stops the removal charging them. A
   * player who cancels late forfeits their share because the court is booked
   * either way; someone removed by the organizer chose nothing, so billing
   * them would be the app taking the organizer's side of a disagreement.
   *
   * Freeing a seat promotes the next player on the waitlist, exactly as a
   * voluntary cancellation does.
   */
  app.post(
    "/games/:slug/remove",
    (ctx) =>
      act(ctx, async ({ user, kv, form, game }) => {
        await requireGameOrganizer(ctx.state.auth, game);

        const userId = form.get("userId")?.toString() ?? "";
        if (!userId) throw new HttpError(400, "No player was named.");

        // An organizer leaves by cancelling their own spot, which applies the
        // ordinary cutoff rules to them as it does to everyone else.
        if (userId === user.id) {
          return backToGame(game.slug, {
            error: "Use “Cancel my spot” to take yourself off the roster.",
          });
        }

        const removed = await getUser(kv, userId);
        const result = await leaveGame(kv, game.id, userId, {
          byOrganizer: true,
        });
        await flush(kv, result.effects);

        return {
          action: "signup.left",
          notice: `${removed?.name ?? "That player"} is off the roster.`,
        };
      }),
  );

  /**
   * Asking the organizer to be let into a locked game.
   *
   * Open to anyone signed in who can reach the page, which is the same set who
   * can already read it. The lock is on the seat, not on the asking.
   */
  app.post(
    "/games/:slug/access/request",
    (ctx) =>
      act(ctx, async ({ user, kv, form, game, access }) => {
        assertNotBlocked(access.membership);

        const message = cleanText(form.get("message")?.toString() ?? "", 280);
        const request = await requestAccess(kv, game, user.id, message);

        // Mail is best-effort: the request is already recorded, and a provider
        // having a bad minute must not turn a successful ask into an error the
        // player sees and retries.
        notifyOrganizerOfRequest(kv, game, user, request.message);

        return {
          action: "game.access_requested",
          notice: "Asked. The organizer will let you know.",
        };
      }),
  );

  /** The organizer's answer. Approving records the unlock; it takes no seat. */
  app.post(
    "/games/:slug/access/decide",
    (ctx) =>
      act(ctx, async ({ user, kv, form, game }) => {
        await requireGameOrganizer(ctx.state.auth, game);

        const userId = form.get("userId")?.toString() ?? "";
        if (!userId) throw new HttpError(400, "No player was named.");
        const approve = form.get("decision") === "approve";

        const player = await getUser(kv, userId);
        if (approve) {
          await approveAccess(kv, game.id, userId, user.id);
        } else {
          await rejectAccess(kv, game.id, userId, user.id);
        }

        if (player?.email) {
          sendEmail(accessDecidedEmail(player.email, game, approve)).catch(
            (error) =>
              console.error(`Access decision notice failed: ${game.id}`, error),
          );
        }

        return {
          action: approve ? "game.access_approved" : "game.access_rejected",
          // Named where we know the name, so the notice reads as a sentence
          // either way rather than agreeing with a pronoun that is not there.
          notice: approve
            ? `${player?.name ?? "They"} can take a seat now.`
            : player
            ? `${player.name} was turned down.`
            : "They were turned down.",
        };
      }),
  );

  /**
   * The organizer seating someone off the waitlist ahead of their turn, or
   * when the roster is already full.
   *
   * Deliberately not capacity-checked — see `promotePlayer`. The organizer is
   * the authority on how many can actually play; the seat count is their own
   * earlier estimate rather than a rule to enforce against them.
   */
  app.post(
    "/games/:slug/promote",
    (ctx) =>
      act(ctx, async ({ kv, form, game }) => {
        await requireGameOrganizer(ctx.state.auth, game);

        const userId = form.get("userId")?.toString() ?? "";
        if (!userId) throw new HttpError(400, "No player was named.");

        const promoted = await getUser(kv, userId);
        await promotePlayer(kv, game.id, userId);

        // Distinct from `signup.promotion_confirmed`, which is the player
        // accepting an offered seat. This is the organizer overriding both the
        // queue order and the capacity.
        return {
          action: "signup.force_promoted",
          notice: `${promoted?.name ?? "That player"} is on the roster.`,
        };
      }),
  );

  app.post(
    "/games/:slug/confirm",
    (ctx) =>
      act(ctx, async ({ user, kv, game }) => {
        await confirmPromotion(kv, game.id, user.id);
        // Accepting an offered seat is the same event as joining, as far as
        // owing money goes, so it raises the same dialog.
        return {
          action: "signup.promotion_confirmed",
          notice: "Your spot is confirmed.",
          redirect: backToGame(game.slug, {
            notice: "Your spot is confirmed.",
            pay: "1",
          }),
        };
      }),
  );

  /**
   * Entering a password game's code.
   *
   * A wrong code is a plain refusal with no counter behind it. Six digits is
   * guessable given enough tries, but what is behind it is a badminton roster
   * rather than an account, and locking the form would hand anyone a way to
   * shut real players out of a game by guessing at them.
   */
  app.post(
    "/games/:slug/unlock",
    (ctx) =>
      act(ctx, async ({ user, kv, form, game }) => {
        const submitted = form.get("joinCode")?.toString() ?? "";

        if (!codeMatches(game, submitted)) {
          return backToGame(game.slug, {
            error: "That code does not match this game.",
          });
        }

        await recordUnlock(kv, game.id, user.id);
        return {
          action: "game.unlocked",
          notice: "That is the one. You can take a seat now.",
        };
      }),
  );

  app.post(
    "/games/:slug/guests",
    (ctx) =>
      act(ctx, async ({ user, kv, form, game, access }) => {
        // A guest rides on a seat their host already holds, and `addGuest`
        // refuses without one — so holding the seat is the only check needed.
        assertNotBlocked(access.membership);

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
