/**
 * The "your game is posted" confirmation.
 *
 * Shown once, on the redirect that follows creating a game. Posting is the end
 * of a long form, and landing silently on a page that looks like every other
 * game page leaves the organizer wondering whether it worked.
 *
 * It carries the share link because that is the next thing they do — a game
 * nobody has been told about is a game nobody joins. For a password game it
 * carries the code too, since that is the only moment it is guaranteed to be
 * in front of them.
 *
 * With JavaScript off the dialog never renders and the game page below is
 * unchanged. Nothing here is the only route to anything.
 */

import { useEffect, useRef, useState } from "preact/hooks";
import { Button } from "../components/ui.tsx";

interface Props {
  title: string;
  /** Absolute, so what is copied works when pasted into a chat. */
  url: string;
  /** Only set when the game is password-protected. */
  joinCode?: string;
}

/**
 * Copies text, reporting whether it worked.
 *
 * `navigator.clipboard` needs a secure context and a permission that can be
 * refused, so the older selection path stays as a fallback and a failure is
 * surfaced rather than swallowed — a link the organizer thinks they copied
 * and did not is worse than one they know they must select by hand.
 */
async function copy(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    // Fall through to the legacy path.
  }

  try {
    const field = document.createElement("textarea");
    field.value = value;
    field.setAttribute("readonly", "");
    field.style.position = "fixed";
    field.style.opacity = "0";
    document.body.appendChild(field);
    field.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(field);
    return ok;
  } catch {
    return false;
  }
}

export default function GamePostedDialog(props: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(true);
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");

  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    // `showModal` is what traps focus and wires Escape, so the keyboard
    // behaviour is the platform's rather than reimplemented here.
    if (open && !node.open) node.showModal();
    if (!open && node.open) node.close();
  }, [open]);

  useEffect(() => {
    if (state === "idle") return;
    const timer = setTimeout(() => setState("idle"), 2000);
    return () => clearTimeout(timer);
  }, [state]);

  return (
    <dialog
      ref={dialog}
      onClose={() => setOpen(false)}
      class="backdrop:bg-black/50 bg-transparent p-0 m-auto max-w-lg w-[calc(100%-2rem)]"
    >
      <div class="bg-surface rounded-2xl p-6 flex flex-col gap-4 text-left">
        <div class="flex flex-col gap-1">
          <h2 class="text-headline-md font-headline text-on-surface">
            Your game is posted
          </h2>
          <p class="text-body-md text-on-surface-variant">
            <strong class="text-on-surface">{props.title}</strong>{" "}
            is live. Share the link and players can take a seat.
          </p>
        </div>

        <div class="flex items-center justify-between gap-3 rounded-lg bg-surface-container px-4 py-3">
          <span class="text-label-sm text-on-surface-variant break-all min-w-0">
            {props.url}
          </span>
          <Button
            type="button"
            variant="ghost"
            onClick={async () => {
              setState(await copy(props.url) ? "copied" : "failed");
            }}
          >
            {state === "copied"
              ? "Copied"
              : state === "failed"
              ? "Copy failed"
              : "Copy"}
          </Button>
          <span aria-live="polite" class="sr-only">
            {state === "copied"
              ? "Link copied"
              : state === "failed"
              ? "Could not copy the link. Select it and copy by hand."
              : ""}
          </span>
        </div>

        {props.joinCode && (
          <div class="flex flex-col gap-1 rounded-lg bg-surface-container px-4 py-3">
            <span class="text-label-sm text-on-surface-variant">
              Join code
            </span>
            <span class="text-headline-md font-headline text-on-surface tabular-nums tracking-[0.2em]">
              {props.joinCode}
            </span>
            <span class="text-label-sm text-on-surface-variant">
              Players need this as well as the link.
            </span>
          </div>
        )}

        <Button type="button" fullWidth onClick={() => setOpen(false)}>
          Done
        </Button>
      </div>
    </dialog>
  );
}
