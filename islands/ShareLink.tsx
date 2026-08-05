/**
 * The invite link, copyable, on every game.
 *
 * Sharing is how a game fills, and that is as true of a public game as of an
 * unlisted one — "anyone can find it" is not the same as anyone having found
 * it. The link used to appear only in the dialog that follows posting, which
 * left an organizer who dismissed it with nothing but the address bar.
 *
 * Shown to everyone rather than only the organizer: a player who wants a
 * friend in a game is doing the same job, and the URL is not a secret. What is
 * secret on a password game is the code, which stays organizer-only.
 *
 * With JavaScript off the link is still there as text and as a real anchor —
 * only the copy button needs scripting, and it degrades to selecting by hand.
 */

import { useEffect, useState } from "preact/hooks";
import { Button, Card } from "../components/ui.tsx";

interface Props {
  /** Absolute, so what is copied works when pasted into a chat. */
  url: string;
  /**
   * Native share sheet text. On a phone this is the path most people take, so
   * it carries the game's name rather than a bare URL.
   */
  title: string;
}

/**
 * Copies text, reporting whether it worked.
 *
 * `navigator.clipboard` needs a secure context and a permission that can be
 * refused, so the older selection path stays as a fallback and a failure is
 * surfaced rather than swallowed — a link someone thinks they copied and did
 * not is worse than one they know they must select by hand.
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

export default function ShareLink(props: Props) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  // Read after mount: the server has no navigator, and rendering the share
  // button from a guess would flash the wrong control on every phone.
  const [canShare, setCanShare] = useState(false);

  useEffect(() => setCanShare(typeof navigator.share === "function"), []);

  useEffect(() => {
    if (state === "idle") return;
    const timer = setTimeout(() => setState("idle"), 2000);
    return () => clearTimeout(timer);
  }, [state]);

  return (
    <Card class="flex flex-col gap-2">
      <span class="text-label font-bold text-on-surface-variant">
        Invite link
      </span>
      <div class="flex items-center justify-between gap-3">
        <a
          href={props.url}
          class="text-label-sm text-on-surface-variant break-all min-w-0 no-underline hover:underline"
        >
          {props.url}
        </a>
        <div class="flex gap-1 shrink-0">
          {canShare && (
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                // A cancelled share sheet rejects, and that is not an error
                // worth reporting — the player simply changed their mind.
                navigator.share({ title: props.title, url: props.url }).catch(
                  () => {},
                );
              }}
            >
              Share
            </Button>
          )}
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
        </div>
      </div>
      <span aria-live="polite" class="sr-only">
        {state === "copied"
          ? "Link copied"
          : state === "failed"
          ? "Could not copy the link. Select it and copy by hand."
          : ""}
      </span>
    </Card>
  );
}
