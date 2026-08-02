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

import type { Game, Signup } from "../lib/types.ts";
import {
  displaySplit,
  formatFils,
  seatsRemaining,
} from "../lib/domain/money.ts";
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
 * The per-head figure.
 *
 * Before the cutoff this moves as people join, so it is labelled an estimate —
 * showing a firm price that later changes is worse than admitting it is not
 * settled yet.
 */
export function CostLine(props: { game: Game; class?: string }) {
  const { game } = props;
  const split = displaySplit(game);
  const frozen = game.frozenPerHeadFils !== undefined;
  const empty = !frozen && game.confirmedCount === 0;

  return (
    <div class={cx("flex items-baseline gap-2", props.class)}>
      <span class="text-headline-md text-on-surface font-headline">
        {formatFils(split.perHeadFils)}
      </span>
      <span class="text-label-sm text-on-surface-variant">
        {frozen ? "per player" : empty
          // Quoting the full cost would be wrong, and quoting zero worse.
          ? "if you join alone — less as others do"
          : "per player, estimated"}
      </span>
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
          `${
            formatGameTime(game.startUtc, game.endUtc)
          } at ${game.venue.name}.`,
          game.status === "cancelled"
            ? "Cancelled."
            : game.status === "completed"
            ? "Played."
            : `${seatsLabel(game)}.`,
          viewerStateLabel(viewer),
        ].filter(Boolean).join(" ")}
        class="flex flex-col gap-3 no-underline text-inherit cursor-pointer
               rounded-lg focus-visible:outline-2 focus-visible:outline-primary
               focus-visible:outline-offset-4"
      >
        <div class="flex items-start justify-between gap-3">
          <h3
            class={cx(
              "text-headline-md font-headline text-on-surface",
              game.status === "cancelled" && "line-through",
            )}
          >
            {game.title}
          </h3>
          <div
            aria-hidden="true"
            class="flex flex-col items-end gap-1.5 shrink-0"
          >
            <GameStatusChip game={game} />
            <ViewerStateChip state={viewer} />
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
