/**
 * The "you are off the roster" confirmation.
 *
 * Shown once, on the redirect that follows cancelling a spot. Cancelling sends
 * the player to the games list rather than back to the game they just left —
 * there is nothing there for them any more — and arriving on a different page
 * with only a banner to explain it reads as having been bounced somewhere
 * rather than as the cancellation having worked.
 *
 * When the cutoff has passed the share is still owed, and that is the one
 * thing a player must not miss. It is stated here rather than left to the
 * banner behind the dialog.
 *
 * With JavaScript off the dialog never renders and the `notice` banner on the
 * list below says the same thing. Nothing here is the only route to anything.
 */

import { useEffect, useRef, useState } from "preact/hooks";
import { Button } from "../components/ui.tsx";

interface Props {
  /** The game they left, so the confirmation names what it is confirming. */
  title: string;
  /**
   * Set when the cancellation happened after the cutoff, which leaves the
   * share owed. The wording changes rather than a line being appended: an
   * unconditional "you are all set" above a warning would contradict it.
   */
  owed?: boolean;
}

export default function SpotCancelledDialog(props: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(true);

  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    // `showModal` is what traps focus and wires Escape, so the keyboard
    // behaviour is the platform's rather than reimplemented here.
    if (open && !node.open) node.showModal();
    if (!open && node.open) node.close();
  }, [open]);

  return (
    <dialog
      ref={dialog}
      onClose={() => setOpen(false)}
      class="backdrop:bg-black/50 bg-transparent p-0 m-auto max-w-lg w-[calc(100%-2rem)]"
    >
      <div class="bg-surface rounded-2xl p-6 flex flex-col gap-4 text-left">
        <div class="flex flex-col gap-1">
          <h2 class="text-headline-md font-headline text-on-surface">
            Your spot is cancelled
          </h2>
          <p class="text-body-md text-on-surface-variant">
            You are off the roster for{" "}
            <strong class="text-on-surface">{props.title}</strong>.
          </p>
        </div>

        {props.owed && (
          <div class="rounded-lg bg-surface-container px-4 py-3">
            <p class="text-body-md text-on-surface">
              The cutoff had passed, so your share is still owed. The court was
              booked either way — settle it with the organizer.
            </p>
          </div>
        )}

        <Button type="button" fullWidth onClick={() => setOpen(false)}>
          OK
        </Button>
      </div>
    </dialog>
  );
}
