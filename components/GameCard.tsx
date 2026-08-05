/**
 * A game, summarised.
 *
 * Used for the list and for the detail header, so the two can never drift into
 * describing the same game differently.
 *
 * The card leads with the three things a player decides on — when, where, and
 * what it costs — and states the roster as a number rather than only a bar,
 * because "3 spots left" answers the question and a filled bar does not.
 */

import { SPORT_LABELS } from "../lib/types.ts";
import type { Game, Signup, Sport } from "../lib/types.ts";
import { formatFils, seatsRemaining } from "../lib/domain/money.ts";
import { capacityOf, seatsTaken } from "../lib/domain/money.ts";
import { formatGameTime, formatRelative } from "../lib/domain/time.ts";
import { cutoffAt } from "../lib/domain/time.ts";
import { Card, Chip, cx, ProgressBar } from "./ui.tsx";

/** Status line describing where the viewer stands with this game. */
export type ViewerState =
  | "none"
  | "confirmed"
  | "pending_confirm"
  | "waitlisted";

export function viewerStateOf(signup: Signup | null): ViewerState {
  if (!signup) return "none";
  if (signup.status === "confirmed") return "confirmed";
  if (signup.status === "pending_confirm") return "pending_confirm";
  if (signup.status === "waitlisted") return "waitlisted";
  return "none";
}

const iconProps = {
  width: 16,
  height: 16,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  "stroke-width": 2,
  "stroke-linecap": "round" as const,
  "stroke-linejoin": "round" as const,
  "aria-hidden": true,
};

function VenueIcon() {
  return (
    <svg {...iconProps}>
      <path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z" />
      <circle cx="12" cy="10" r="3" />
    </svg>
  );
}

function ClockIcon() {
  return (
    <svg {...iconProps}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}

/**
 * Marks a game that is not simply open to anyone who finds it.
 *
 * Sized from the surrounding text rather than fixed, so it sits on a chip and
 * beside a heading without a second copy.
 */
export function LockIcon(props: { size?: number }) {
  const size = props.size ?? 16;
  return (
    <svg {...iconProps} width={size} height={size}>
      <rect x="4" y="10" width="16" height="11" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
    </svg>
  );
}

/**
 * Whether a game keeps people out, and how.
 *
 * Two different restrictions with one shared symbol: a password game anyone can
 * see but not join without the code, and an unlisted one that is only reachable
 * by link. Both are "not open to everyone", which is what the lock says; the
 * label carries the difference.
 */
export function accessLabel(game: Game): string | null {
  if (game.visibility === "password") return "Code needed";
  if (game.visibility === "unlisted") return "Unlisted";
  return null;
}

/** The lock chip, absent for a public game. */
export function AccessChip(props: { game: Game }) {
  const label = accessLabel(props.game);
  if (!label) return null;
  return (
    <Chip tone="neutral">
      <span class="inline-flex items-center gap-1">
        <LockIcon size={12} />
        {label}
      </span>
    </Chip>
  );
}

/**
 * A glyph per sport, so a list of five sports is scannable without reading.
 *
 * Drawn rather than lettered because the point is telling them apart at a
 * glance; two sports starting with "P" would defeat an initial. Each is built
 * from the same stroke primitives as the icons above so they sit together, and
 * each is a silhouette of the implement — the one thing about a racquet sport
 * that is unambiguous at 20 pixels.
 *
 * Decorative: every card already names its sport in the link's accessible
 * label, so these are hidden from assistive technology rather than repeating it.
 */
export function SportIcon(props: { sport: Sport; size?: number }) {
  const size = props.size ?? 16;
  const common = { ...iconProps, width: size, height: size };

  switch (props.sport) {
    case "badminton":
      // Shuttlecock: skirt flaring from a corked base.
      return (
        <svg {...common}>
          <path d="M12 3 6 14l6 4 6-4-6-11Z" />
          <path d="M8.5 9h7M12 3v15" />
          <circle cx="12" cy="20" r="1.8" />
        </svg>
      );
    case "pickleball":
      // Paddle with the perforated face the sport is known for.
      return (
        <svg {...common}>
          <rect x="4" y="2" width="12" height="14" rx="6" />
          <path d="M14 15.5 19 21" />
          <circle cx="8.5" cy="7" r="0.6" />
          <circle cx="11.5" cy="10" r="0.6" />
        </svg>
      );
    case "table_tennis":
      // Round bat and ball.
      return (
        <svg {...common}>
          <circle cx="10" cy="9" r="6" />
          <path d="M13.5 14 18 20" />
          <circle cx="19" cy="7" r="1.8" />
        </svg>
      );
    case "squash":
      // Small-headed racquet with strings, plus the low-bouncing ball.
      return (
        <svg {...common}>
          <ellipse cx="9.5" cy="8" rx="5.5" ry="6.5" />
          <path d="M9.5 1.5v13M4 8h11" />
          <path d="M12 13.5 17 20" />
          <circle cx="19" cy="16" r="1.6" />
        </svg>
      );
    case "padel":
      // Solid paddle, stubbier than pickleball's and shown face-on.
      return (
        <svg {...common}>
          <path d="M12 2c4.4 0 7 3 7 7s-2.6 7-7 7-7-3-7-7 2.6-7 7-7Z" />
          <path d="M12 16v6" />
          <circle cx="9.5" cy="8" r="0.6" />
          <circle cx="14.5" cy="8" r="0.6" />
          <circle cx="12" cy="11" r="0.6" />
        </svg>
      );
  }
}

/** Roster state as a phrase, since a bar alone does not say how many are left. */
export function seatsLabel(game: Game): string {
  const left = seatsRemaining(game);
  if (left === 0) return "Full — join the waitlist";
  if (left === 1) return "1 spot left";
  return `${left} spots left`;
}

export function GameStatusChip(props: { game: Game }) {
  const { game } = props;

  if (game.status === "cancelled") return <Chip tone="error">Cancelled</Chip>;
  if (game.status === "completed") return <Chip tone="neutral">Played</Chip>;
  if (game.status === "draft") return <Chip tone="neutral">Draft</Chip>;

  const left = seatsRemaining(game);
  if (left === 0) return <Chip tone="warning">Waitlist</Chip>;
  if (left <= 2) return <Chip tone="warning">{seatsLabel(game)}</Chip>;
  return <Chip tone="success">{seatsLabel(game)}</Chip>;
}

/** Where the viewer stands, as text — for a label that cannot carry a chip. */
function viewerStateLabel(state: ViewerState): string {
  switch (state) {
    case "confirmed":
      return "You are in.";
    case "pending_confirm":
      return "Confirm your seat.";
    case "waitlisted":
      return "You are on the waitlist.";
    case "none":
      return "";
  }
}

/** Where the viewer stands, when they are involved at all. */
export function ViewerStateChip(props: { state: ViewerState }) {
  switch (props.state) {
    case "confirmed":
      return <Chip tone="success">You are in</Chip>;
    case "pending_confirm":
      return <Chip tone="warning">Confirm your seat</Chip>;
    case "waitlisted":
      return <Chip tone="info">On the waitlist</Chip>;
    case "none":
      return null;
  }
}

/**
 * What a seat costs.
 *
 * The organizer sets this outright, so it is stated plainly — there is no
 * estimate to hedge and no figure that moves as the roster fills.
 */
export function CostLine(props: { game: Game; class?: string }) {
  return (
    <div class={cx("flex items-baseline gap-2", props.class)}>
      <span class="text-headline-md text-on-surface font-headline">
        {formatFils(props.game.pricePerPlayerFils)}
      </span>
      <span class="text-label-sm text-on-surface-variant">per player</span>
    </div>
  );
}

export function GameCard(
  props: { game: Game; viewer?: ViewerState; href?: string },
) {
  const { game } = props;
  const viewer = props.viewer ?? "none";
  const href = props.href ?? `/games/${game.slug}`;
  const cutoff = cutoffAt(game.startUtc, game.cutoffHours);
  const cutoffPassed = new Date() >= cutoff;
  const inactive = game.status === "cancelled" || game.status === "completed";

  return (
    <Card
      class={cx(
        "transition-shadow hover:shadow-float focus-within:shadow-float",
        // A cancelled or played game is dimmed as well as chipped, so its state
        // does not rest on chip colour alone.
        inactive && "opacity-70",
      )}
    >
      <a
        href={href}
        // The link wraps the whole card, so its accessible name would otherwise
        // be every figure inside it read as one run-on sentence.
        aria-label={[
          `${game.title},`,
          `${SPORT_LABELS[game.sport]}.`,
          `${
            formatGameTime(game.startUtc, game.endUtc)
          } at ${game.venue.name}.`,
          game.status === "cancelled"
            ? "Cancelled."
            : game.status === "completed"
            ? "Played."
            : `${seatsLabel(game)}.`,
          viewerStateLabel(viewer),
          // The chips are aria-hidden, so the lock reaches a screen reader
          // here or not at all.
          accessLabel(game),
        ].filter(Boolean).join(" ")}
        class="flex flex-col gap-3 no-underline text-inherit cursor-pointer
               rounded-lg focus-visible:outline-2 focus-visible:outline-primary
               focus-visible:outline-offset-4"
      >
        <div class="flex items-start justify-between gap-3">
          <div class="flex items-start gap-2.5 min-w-0">
            {
              /* Sits with the title rather than in the detail list below: the
                 sport is how a player decides whether the card is for them at
                 all, which comes before when and where. */
            }
            <span
              aria-hidden="true"
              class="mt-1 shrink-0 text-on-surface-variant"
              title={SPORT_LABELS[game.sport]}
            >
              <SportIcon sport={game.sport} size={20} />
            </span>
            <h3
              class={cx(
                "text-headline-md font-headline text-on-surface",
                game.status === "cancelled" && "line-through",
              )}
            >
              {game.title}
            </h3>
          </div>
          <div
            aria-hidden="true"
            class="flex flex-col items-end gap-1.5 shrink-0"
          >
            <GameStatusChip game={game} />
            <ViewerStateChip state={viewer} />
            <AccessChip game={game} />
          </div>
        </div>

        {
          /*
          The link's aria-label already carries the time, venue and seat count.
          Hiding the visual copy stops a screen reader announcing each figure a
          second time.
        */
        }
        <dl
          aria-hidden="true"
          class="flex flex-col gap-1.5 text-body-md text-on-surface-variant"
        >
          <div class="flex items-center gap-2">
            <dt class="sr-only-text">When</dt>
            <ClockIcon />
            <dd>{formatGameTime(game.startUtc, game.endUtc)}</dd>
          </div>
          <div class="flex items-center gap-2">
            <dt class="sr-only-text">Where</dt>
            <VenueIcon />
            <dd>{game.venue.name}</dd>
          </div>
        </dl>

        <div aria-hidden="true">
          <ProgressBar
            value={seatsTaken(game)}
            max={capacityOf(game)}
            label="Spots filled"
          />
        </div>

        <div class="flex items-end justify-between gap-3 pt-1">
          <CostLine game={game} />
          {!cutoffPassed && (
            <span class="text-label-sm text-on-surface-variant text-right">
              Free cancellation
              <br />
              until {formatRelative(cutoff.toISOString())}
            </span>
          )}
        </div>
      </a>
    </Card>
  );
}
