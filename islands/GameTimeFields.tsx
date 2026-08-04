/**
 * The start and end pair on the game form.
 *
 * Almost every game is two hours, so typing the end time is work that produces
 * the answer the organizer was going to give anyway. Picking a start fills the
 * end two hours later, and from then on the gap the organizer chose is what
 * gets preserved — someone running a three-hour session sets it once and every
 * later change to the start keeps three hours.
 *
 * The end field stays a real, editable input rather than becoming a duration
 * picker. A booking that runs to an odd time is normal, and a form that cannot
 * express it would be worse than one that guesses well.
 *
 * With JavaScript off both fields are exactly what they were: two required
 * `datetime-local` inputs the server validates. Nothing here is load-bearing.
 */

import { useRef, useState } from "preact/hooks";
import { Field } from "../components/ui.tsx";

interface Props {
  startValue: string;
  endValue: string;
  startError?: string;
  endError?: string;
}

const HOUR_MS = 60 * 60 * 1000;
const DEFAULT_LENGTH_MS = 2 * HOUR_MS;

/**
 * Formats a Date the way `datetime-local` expects.
 *
 * The input reads a wall-clock string with no zone, and `toISOString` would
 * shift it to UTC — an organizer in Dubai picking 6pm would see the end jump
 * to 4pm. Building it from the local parts keeps both fields in the same frame
 * of reference, which is the one the server then reads as Dubai time.
 */
function toLocalInput(date: Date): string {
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${
    pad(date.getDate())
  }T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function parseLocalInput(value: string): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export default function GameTimeFields(props: Props) {
  const [start, setStart] = useState(props.startValue);
  const [end, setEnd] = useState(props.endValue);

  /**
   * How long the game runs, carried across start changes.
   *
   * Seeded from the values the form was rendered with, so editing an existing
   * three-hour game and nudging its start keeps three hours rather than
   * silently shortening it to the default.
   */
  const lengthMs = useRef<number>((() => {
    const from = parseLocalInput(props.startValue);
    const to = parseLocalInput(props.endValue);
    if (!from || !to) return DEFAULT_LENGTH_MS;
    const span = to.getTime() - from.getTime();
    return span > 0 ? span : DEFAULT_LENGTH_MS;
  })());

  function onStartChange(value: string) {
    setStart(value);
    const from = parseLocalInput(value);
    if (!from) return;
    setEnd(toLocalInput(new Date(from.getTime() + lengthMs.current)));
  }

  function onEndChange(value: string) {
    setEnd(value);
    // An end the organizer set by hand redefines the length, so the next start
    // change follows their intent instead of reverting to two hours.
    const from = parseLocalInput(start);
    const to = parseLocalInput(value);
    if (!from || !to) return;
    const span = to.getTime() - from.getTime();
    if (span > 0) lengthMs.current = span;
  }

  const hours = lengthMs.current / HOUR_MS;
  const rounded = Math.round(hours * 10) / 10;

  return (
    <div class="grid gap-5 sm:grid-cols-2">
      <Field
        label="Starts"
        name="start"
        type="datetime-local"
        required
        value={start}
        error={props.startError}
        hint="Dubai time."
        onInput={(event) =>
          onStartChange((event.target as HTMLInputElement).value)}
      />
      <Field
        label="Ends"
        name="end"
        type="datetime-local"
        required
        value={end}
        error={props.endError}
        hint={start && end
          ? `${rounded} ${
            rounded === 1 ? "hour" : "hours"
          } long. Change it if that is wrong.`
          : "Fills in automatically from the start time."}
        onInput={(event) =>
          onEndChange((event.target as HTMLInputElement).value)}
      />
    </div>
  );
}
