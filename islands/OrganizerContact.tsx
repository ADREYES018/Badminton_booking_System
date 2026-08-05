/**
 * How to reach whoever runs the game.
 *
 * Most of what players need to ask — running late, where exactly is the
 * entrance, is there a spare racket — is a message, not a feature. WhatsApp is
 * how that conversation actually happens here, so the number links straight
 * into it rather than only sitting on the page to be copied by hand.
 *
 * Shown to people on the roster rather than to anyone who opens the page: a
 * phone number is personal data, and a public game's URL is not a credential.
 * That decision is the route's; this renders what it is given.
 *
 * With JavaScript off the WhatsApp link and the `tel:` link both still work —
 * they are plain anchors. Only the copy button needs scripting.
 */

import { useEffect, useState } from "preact/hooks";
import { Button, Card } from "../components/ui.tsx";
import { whatsappLink, whatsappNumber } from "../lib/domain/contact.ts";

interface Props {
  name: string;
  /** E.164, as stored. */
  phone: string;
}

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

export default function OrganizerContact(props: Props) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");

  useEffect(() => {
    if (state === "idle") return;
    const timer = setTimeout(() => setState("idle"), 2000);
    return () => clearTimeout(timer);
  }, [state]);

  const digits = whatsappNumber(props.phone);

  return (
    <Card class="flex flex-col gap-2">
      <span class="text-label font-bold text-on-surface-variant">
        Organizer
      </span>
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div class="flex flex-col min-w-0">
          <span class="text-body-md text-on-surface">{props.name}</span>
          <a
            href={`tel:${props.phone}`}
            class="text-label-sm text-on-surface-variant no-underline hover:underline"
          >
            {props.phone}
          </a>
        </div>
        <div class="flex gap-1 shrink-0">
          {digits && (
            <a
              href={whatsappLink(props.phone)}
              target="_blank"
              rel="noopener noreferrer"
              class="inline-flex items-center gap-1.5 rounded-full bg-surface-container px-4 py-2
                     text-label font-bold text-on-surface-variant no-underline
                     hover:text-primary transition-colors"
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="currentColor"
                aria-hidden="true"
              >
                <path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.75.46 3.45 1.32 4.95L2 22l5.25-1.38a9.9 9.9 0 0 0 4.79 1.22h.01c5.46 0 9.91-4.45 9.91-9.91 0-2.65-1.03-5.14-2.9-7.01A9.82 9.82 0 0 0 12.04 2Zm0 18.15h-.01a8.2 8.2 0 0 1-4.19-1.15l-.3-.18-3.12.82.83-3.04-.2-.31a8.18 8.18 0 0 1-1.26-4.38c0-4.54 3.7-8.24 8.25-8.24a8.2 8.2 0 0 1 8.24 8.25c0 4.54-3.7 8.23-8.24 8.23Zm4.52-6.16c-.25-.12-1.47-.72-1.69-.81-.23-.08-.39-.12-.56.13-.16.24-.64.8-.78.97-.15.16-.29.18-.54.06-.25-.13-1.05-.39-1.99-1.23-.74-.66-1.23-1.47-1.38-1.72-.14-.25-.01-.38.11-.5.11-.11.25-.29.37-.44.13-.15.17-.25.25-.42.08-.16.04-.31-.02-.43-.06-.12-.56-1.34-.76-1.84-.2-.48-.4-.42-.56-.43h-.47c-.16 0-.43.06-.65.31-.22.25-.85.84-.85 2.03s.87 2.35.99 2.51c.12.17 1.72 2.62 4.16 3.67.58.25 1.03.4 1.39.51.58.19 1.11.16 1.53.1.47-.07 1.47-.6 1.68-1.18.2-.58.2-1.07.14-1.18-.06-.11-.22-.17-.47-.29Z" />
              </svg>
              WhatsApp
            </a>
          )}
          <Button
            type="button"
            variant="ghost"
            onClick={async () => {
              setState(await copy(props.phone) ? "copied" : "failed");
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
          ? "Number copied"
          : state === "failed"
          ? "Could not copy the number. Select it and copy by hand."
          : ""}
      </span>
    </Card>
  );
}
