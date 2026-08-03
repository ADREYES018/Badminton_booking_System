/**
 * Doubles results for one game: reporting them, and confirming them.
 *
 * The rule this exists to express is that a result counts only when the loser
 * agrees. Anyone on the roster may report a score, which means anyone may
 * report a wrong one in their own favour, so the confirm and dispute controls
 * appear only to a player on the losing side.
 *
 * That is a courtesy, not the control. `confirmMatch` refuses a winner who
 * forges the POST regardless of what this renders.
 */

import { Button, Card, Chip, Field, Select } from "./ui.tsx";
import type { Match, User } from "../lib/types.ts";

export interface ResultsPanelProps {
  matches: Match[];
  /** Confirmed players, the only people who can appear in a result. */
  roster: Array<{ userId: string; user: User | null }>;
  viewerId: string;
  slug: string;
  csrf: string;
  csrfField: string;
  /** Reporting opens once the game has started; there is nothing to report before. */
  canReport: boolean;
}

/** Which user ids are on the losing side of a decided score. */
export function losingSide(match: Match): readonly string[] {
  return match.scoreA > match.scoreB ? match.sideB : match.sideA;
}

/**
 * Whether this viewer may confirm or dispute this result.
 *
 * Pending only — a confirmed or rejected match is settled — and only for the
 * side that lost, which is the side with a reason to object.
 */
export function canRuleOn(match: Match, viewerId: string): boolean {
  return match.status === "pending" && losingSide(match).includes(viewerId);
}

function MatchStatusChip(props: { status: Match["status"] }) {
  switch (props.status) {
    case "confirmed":
      return <Chip tone="success">Confirmed</Chip>;
    case "rejected":
      return <Chip tone="error">Disputed</Chip>;
    default:
      return <Chip tone="warning">Awaiting the losing side</Chip>;
  }
}

/** One side's two players, named. */
function SideNames(
  props: { ids: readonly string[]; names: Map<string, string> },
) {
  return (
    <span class="text-body-md text-on-surface">
      {props.ids.map((id) => props.names.get(id) ?? "Player").join(" & ")}
    </span>
  );
}

function MatchRow(
  props: {
    match: Match;
    names: Map<string, string>;
    viewerId: string;
    slug: string;
    csrf: string;
    csrfField: string;
  },
) {
  const { match, names, viewerId, slug, csrf, csrfField } = props;
  const aWon = match.scoreA > match.scoreB;
  const mayRule = canRuleOn(match, viewerId);
  const onLosingSide = losingSide(match).includes(viewerId);

  return (
    <li class="flex flex-col gap-3 py-4">
      <div class="flex items-center gap-3">
        <div class="flex flex-col gap-1 flex-1 min-w-0">
          <div class="flex items-center gap-2">
            <SideNames ids={match.sideA} names={names} />
            {aWon && <Chip tone="success">W</Chip>}
          </div>
          <div class="flex items-center gap-2">
            <SideNames ids={match.sideB} names={names} />
            {!aWon && <Chip tone="success">W</Chip>}
          </div>
        </div>
        <p class="text-headline-md font-headline text-on-surface tabular-nums shrink-0">
          {match.scoreA}–{match.scoreB}
        </p>
      </div>

      <div class="flex flex-wrap items-center gap-2">
        <MatchStatusChip status={match.status} />

        {mayRule && (
          <>
            <form
              method="post"
              action={`/games/${slug}/results/confirm`}
            >
              <input type="hidden" name={csrfField} value={csrf} />
              <input type="hidden" name="matchId" value={match.id} />
              <Button type="submit" variant="secondary" class="px-4 py-2">
                That's right
              </Button>
            </form>
            <form
              method="post"
              action={`/games/${slug}/results/dispute`}
            >
              <input type="hidden" name={csrfField} value={csrf} />
              <input type="hidden" name="matchId" value={match.id} />
              <Button type="submit" variant="ghost" class="px-4 py-2">
                Dispute
              </Button>
            </form>
          </>
        )}

        {match.status === "pending" && !onLosingSide && (
          <span class="text-label-sm text-on-surface-variant">
            Waiting for the other side to confirm.
          </span>
        )}
      </div>
    </li>
  );
}

/**
 * The report form.
 *
 * Validation is deliberately left to `reportMatch` — duplicate players, a
 * draw, negative scores and a reporter who did not play are all refused
 * there, and repeating those rules here would mean maintaining them twice.
 */
function ReportForm(
  props: {
    roster: ResultsPanelProps["roster"];
    slug: string;
    csrf: string;
    csrfField: string;
  },
) {
  const options = props.roster.map(({ userId, user }) => (
    <option key={userId} value={userId}>{user?.name ?? "Player"}</option>
  ));

  const picker = (name: string, label: string) => (
    <Select label={label} name={name} required>
      <option value="">Pick a player</option>
      {options}
    </Select>
  );

  return (
    <form
      method="post"
      action={`/games/${props.slug}/results`}
      class="flex flex-col gap-4"
    >
      <input type="hidden" name={props.csrfField} value={props.csrf} />

      <fieldset class="flex flex-col gap-3">
        <legend class="text-label font-bold text-on-surface-variant mb-1">
          Side A
        </legend>
        {picker("a1", "Player one")}
        {picker("a2", "Player two")}
        <Field
          label="Score"
          name="scoreA"
          type="number"
          min={0}
          required
          inputMode="numeric"
        />
      </fieldset>

      <fieldset class="flex flex-col gap-3">
        <legend class="text-label font-bold text-on-surface-variant mb-1">
          Side B
        </legend>
        {picker("b1", "Player one")}
        {picker("b2", "Player two")}
        <Field
          label="Score"
          name="scoreB"
          type="number"
          min={0}
          required
          inputMode="numeric"
        />
      </fieldset>

      <Button type="submit" variant="secondary">Record this result</Button>
      <p class="text-label-sm text-on-surface-variant">
        The losing side confirms it before it counts toward anyone's record.
      </p>
    </form>
  );
}

export function ResultsPanel(props: ResultsPanelProps) {
  const { matches, roster, viewerId, slug, csrf, csrfField, canReport } = props;

  const names = new Map(
    roster.map(({ userId, user }) => [userId, user?.name ?? "Player"]),
  );

  // Four players are needed for a doubles result; below that there is nothing
  // worth offering a form for.
  const enoughPlayers = roster.length >= 4;

  return (
    <Card class="flex flex-col gap-5">
      <h2 class="text-body-lg font-bold text-on-surface">Results</h2>

      {matches.length > 0
        ? (
          <ul class="flex flex-col divide-y divide-outline-variant">
            {matches.map((match) => (
              <MatchRow
                key={match.id}
                match={match}
                names={names}
                viewerId={viewerId}
                slug={slug}
                csrf={csrf}
                csrfField={csrfField}
              />
            ))}
          </ul>
        )
        : (
          <p class="text-body-md text-on-surface-variant">
            No results yet.
          </p>
        )}

      {canReport && enoughPlayers && (
        <details class="border-t border-outline-variant pt-4">
          <summary class="text-label font-bold text-on-surface cursor-pointer">
            Record a result
          </summary>
          <div class="pt-4">
            <ReportForm
              roster={roster}
              slug={slug}
              csrf={csrf}
              csrfField={csrfField}
            />
          </div>
        </details>
      )}
    </Card>
  );
}
