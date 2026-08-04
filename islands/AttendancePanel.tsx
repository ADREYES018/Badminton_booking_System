/**
 * The organizer's attendance controls for a whole roster.
 *
 * Marking used to be one POST per button: every tap reloaded the page, and an
 * organizer working down a roster of sixteen lost their place fifteen times.
 * This collects the whole roster into one form — toggle each player, then save
 * once — so the page reloads at the end rather than throughout.
 *
 * The confirmation exists because saving is the moment attendance becomes a
 * fact about people: a no-show follows a player through their record, and the
 * dialog names how many are about to be marked each way rather than asking a
 * bare "are you sure?".
 *
 * ## Without JavaScript
 *
 * The island degrades to the plain per-player forms it replaced. Each toggle
 * is a submit button inside its own form, so with scripting off a tap posts
 * that one player exactly as before; with scripting on, the island intercepts
 * and batches. Attendance is never unreachable, which matters at a court door
 * where the organizer's phone is whatever it is.
 */

import { useState } from "preact/hooks";
import { Button } from "../components/ui.tsx";
import type { AttendancePlayer } from "../components/Attendance.tsx";

interface Props {
  slug: string;
  csrf: string;
  csrfField: string;
  players: AttendancePlayer[];
}

export default function AttendancePanel(props: Props) {
  const [marks, setMarks] = useState<Record<string, boolean | null>>(
    Object.fromEntries(props.players.map((p) => [p.userId, p.state])),
  );

  const initial = Object.fromEntries(
    props.players.map((p) => [p.userId, p.state]),
  );

  // Only players whose mark actually moved are worth saving or counting. An
  // organizer who toggled someone and toggled them back has changed nothing.
  const changed = props.players.filter((p) =>
    marks[p.userId] !== initial[p.userId]
  );
  const present = changed.filter((p) => marks[p.userId] === true).length;
  const absent = changed.filter((p) => marks[p.userId] === false).length;

  const set = (userId: string, value: boolean) => {
    setMarks((current) => ({
      ...current,
      // Tapping the active choice clears it back to unmarked, which is the
      // only way to undo a mis-tap on someone who was never marked.
      [userId]: current[userId] === value ? null : value,
    }));
  };

  const confirm = (event: Event) => {
    if (changed.length === 0) {
      event.preventDefault();
      return;
    }

    const parts = [
      present > 0 ? `${present} present` : "",
      absent > 0 ? `${absent} absent` : "",
    ].filter(Boolean).join(" and ");

    if (!globalThis.confirm(`Save attendance? Marking ${parts}.`)) {
      event.preventDefault();
    }
  };

  return (
    <form
      method="post"
      action={`/games/${props.slug}/attendance`}
      onSubmit={confirm}
      class="flex flex-col gap-4"
    >
      <input type="hidden" name={props.csrfField} value={props.csrf} />
      {/* Tells the server this is the batch form rather than a single mark. */}
      <input type="hidden" name="batch" value="1" />

      <ul class="flex flex-col gap-2">
        {props.players.map((player) => {
          const state = marks[player.userId] ?? null;
          return (
            <li
              key={player.userId}
              class="flex flex-wrap items-center gap-3 py-1"
            >
              <span class="text-body-md text-on-surface flex-1 min-w-0 truncate">
                {player.name}
              </span>

              {
                /* Submitted only for players the organizer actually marked, so
                  an untouched roster posts nothing and changes nothing. */
              }
              {state !== null && (
                <input
                  type="hidden"
                  name={`attended:${player.userId}`}
                  value={state ? "1" : "0"}
                />
              )}

              <div class="flex gap-2 shrink-0">
                <Button
                  type="button"
                  variant={state === true ? "primary" : "ghost"}
                  class="px-4 py-2"
                  aria-pressed={state === true}
                  aria-label={`Mark ${player.name} present`}
                  onClick={() => set(player.userId, true)}
                >
                  Present
                </Button>
                <Button
                  type="button"
                  variant={state === false ? "primary" : "ghost"}
                  class="px-4 py-2"
                  aria-pressed={state === false}
                  aria-label={`Mark ${player.name} absent`}
                  onClick={() => set(player.userId, false)}
                >
                  Absent
                </Button>
              </div>
            </li>
          );
        })}
      </ul>

      <div class="flex items-center justify-between gap-3">
        <span aria-live="polite" class="text-label-sm text-on-surface-variant">
          {changed.length === 0
            ? "No changes yet."
            : `${changed.length} ${
              changed.length === 1 ? "change" : "changes"
            } to save.`}
        </span>
        <Button type="submit" disabled={changed.length === 0}>
          Save changes
        </Button>
      </div>
    </form>
  );
}
