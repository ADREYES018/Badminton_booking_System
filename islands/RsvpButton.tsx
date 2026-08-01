/**
 * Progressive enhancement over a plain form POST.
 *
 * With JavaScript disabled this is exactly a `<form method="post">` and a
 * submit button — the server handles it, redirects, and the page reloads. That
 * path is the source of truth and is what the route tests exercise.
 *
 * With JavaScript, the only thing added is feedback: the button disables and
 * changes label on submit. It does not intercept the request, post JSON, or
 * guess at the outcome. Optimistically flipping a seat to "joined" would be a
 * lie whenever the seat was taken half a second earlier, and the server is the
 * only party that knows which of two simultaneous taps won.
 *
 * The submission still navigates, so the button re-renders from real state.
 */

import { useState } from "preact/hooks";
import { Button } from "../components/ui.tsx";

interface Props {
  action: string;
  csrf: string;
  csrfField: string;
  label: string;
  pendingLabel: string;
  variant?: "primary" | "secondary" | "ghost" | "danger";
}

export default function RsvpButton(props: Props) {
  const [pending, setPending] = useState(false);

  return (
    <form
      method="post"
      action={props.action}
      // Guards against a double tap on a slow connection producing two
      // requests. The server rejects the duplicate anyway; this stops the
      // player seeing a confusing error for something they did right.
      onSubmit={() => setPending(true)}
    >
      <input type="hidden" name={props.csrfField} value={props.csrf} />
      <Button
        type="submit"
        variant={props.variant ?? "primary"}
        fullWidth
        disabled={pending}
        aria-busy={pending ? "true" : undefined}
      >
        {pending ? props.pendingLabel : props.label}
      </Button>
    </form>
  );
}
