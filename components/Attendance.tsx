/**
 * Reading and marking attendance.
 *
 * Shared between the game page, where an organizer works through the roster
 * after the cutoff, and the check-in screen, where the same controls sit under
 * the scanner for whoever's phone is flat.
 *
 * One copy rather than two: the three-state rule below is the kind of thing
 * that drifts when it is written twice, and Phase 3 already found one bug in
 * exactly that rule.
 */

import { Button, Chip } from "./ui.tsx";
import type { Signup } from "../lib/types.ts";

/**
 * Present, absent, or not yet marked.
 *
 * Three states, not two: `attendedAt` alone cannot tell "nobody has marked
 * this player" apart from "marked as a no-show", and treating the absence of
 * a mark as a no-show would count every unmarked player against themselves.
 */
export function attendanceOf(signup: Signup): boolean | null {
  if (signup.attendedAt !== undefined) return true;
  if (signup.markedAbsentAt !== undefined) return false;
  return null;
}

/** How many of these signups have been marked present. */
export function presentCount(signups: Signup[]): number {
  return signups.filter((signup) => attendanceOf(signup) === true).length;
}

/**
 * An attendance mark, as everyone but the organizer sees it.
 *
 * An unmarked player renders nothing at all. "Not marked yet" is the normal
 * state before an organizer works through the roster, and labelling it would
 * read as a verdict.
 */
export function AttendanceChip(props: { signup: Signup }) {
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
export function AttendanceToggle(
  props: {
    signup: Signup;
    slug: string;
    csrf: string;
    csrfField: string;
    name: string;
  },
) {
  const state = attendanceOf(props.signup);

  const button = (attended: boolean, label: string) => (
    <form method="post" action={`/games/${props.slug}/attendance`}>
      <input type="hidden" name={props.csrfField} value={props.csrf} />
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
