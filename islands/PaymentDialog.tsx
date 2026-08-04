/**
 * The "you are in, here is how to pay" dialog.
 *
 * Shown once, the moment someone takes a seat. Players pay before the game, so
 * the transfer details have to arrive while the player is still holding their
 * phone — a panel further down the page is something they scroll past and
 * remember about on the day.
 *
 * Everything in here also exists in `PaymentPanel` further down the page. This
 * is deliberate duplication of *presentation*, not of rules: the dialog is a
 * prompt that can be dismissed, and the panel is the permanent record of what
 * is owed. Someone who closes this without paying has lost nothing.
 *
 * With JavaScript disabled the dialog never renders, and the panel below is
 * the whole experience. Nothing here is the only route to paying.
 */

import { useEffect, useRef, useState } from "preact/hooks";
import { Alert, Button } from "../components/ui.tsx";
import type { PayoutDetails } from "../lib/types.ts";

interface Props {
  /** Formatted, because the dialog never does arithmetic. */
  owed: string;
  slug: string;
  csrf: string;
  csrfField: string;
  payout?: PayoutDetails;
  /** True when the player has already said they paid. */
  alreadyMarked: boolean;
}

/**
 * Copies text, reporting whether it worked.
 *
 * `navigator.clipboard` needs a secure context and a permission that can be
 * refused, so the older selection-based path stays as a fallback. An IBAN the
 * player has to retype by hand is a wrong transfer waiting to happen.
 */
async function copy(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    // Fall through to the legacy path rather than failing outright.
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

function CopyRow(props: { label: string; value: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");

  // Returns the button to its resting label so a second copy still reads as a
  // fresh action rather than looking already-done.
  useEffect(() => {
    if (state === "idle") return;
    const timer = setTimeout(() => setState("idle"), 2000);
    return () => clearTimeout(timer);
  }, [state]);

  return (
    <div class="flex items-center justify-between gap-3 rounded-lg bg-surface-container px-4 py-3">
      <div class="flex flex-col gap-0.5 min-w-0">
        <span class="text-label-sm text-on-surface-variant">{props.label}</span>
        <span class="text-body-md text-on-surface font-medium break-all">
          {props.value}
        </span>
      </div>
      <Button
        type="button"
        variant="ghost"
        onClick={async () => {
          setState(await copy(props.value) ? "copied" : "failed");
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
          ? `${props.label} copied`
          : state === "failed"
          ? `Could not copy ${props.label}. Select it and copy by hand.`
          : ""}
      </span>
    </div>
  );
}

export default function PaymentDialog(props: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(!props.alreadyMarked);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    // `showModal` is what traps focus and makes Escape close it, so the
    // keyboard behaviour is the platform's rather than reimplemented here.
    if (open && !node.open) node.showModal();
    if (!open && node.open) node.close();
  }, [open]);

  if (props.alreadyMarked) return null;

  return (
    <dialog
      ref={dialog}
      onClose={() => setOpen(false)}
      // `m-auto` is load-bearing: a dialog centres itself through its margin,
      // and setting a width without it pins the box to the top-left corner.
      class="backdrop:bg-black/50 bg-transparent p-0 m-auto max-w-lg w-[calc(100%-2rem)]"
    >
      <div class="bg-surface rounded-2xl p-6 flex flex-col gap-4 text-left">
        <div class="flex flex-col gap-1">
          <h2 class="text-headline-md font-headline text-on-surface">
            You are in
          </h2>
          <p class="text-body-md text-on-surface-variant">
            Your seat is held. Send{" "}
            <strong class="text-on-surface">{props.owed}</strong>{" "}
            before the game, then tap below. That tells the organizer, and they
            confirm it once it lands in the account.
          </p>
        </div>

        {props.payout
          ? (
            <div class="flex flex-col gap-2">
              <CopyRow label="IBAN" value={props.payout.iban} />
              <CopyRow label="Account name" value={props.payout.accountName} />
              <p class="text-label-sm text-on-surface-variant">
                {props.payout.bank}
              </p>
            </div>
          )
          : (
            <Alert tone="info">
              The organizer has not added bank details yet. Ask them where to
              send it.
            </Alert>
          )}

        <form
          method="post"
          action={`/games/${props.slug}/paid`}
          onSubmit={() => setPending(true)}
          class="flex flex-col gap-2"
        >
          <input type="hidden" name={props.csrfField} value={props.csrf} />
          <Button type="submit" fullWidth disabled={pending}>
            {pending ? "Telling the organizer…" : "I have paid"}
          </Button>
        </form>

        <Button
          type="button"
          variant="ghost"
          fullWidth
          onClick={() => setOpen(false)}
        >
          I will pay later
        </Button>
      </div>
    </dialog>
  );
}
