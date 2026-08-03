/**
 * A player's check-in code.
 *
 * Rendered server-side as inline SVG, so it costs no client JavaScript and
 * appears with the page rather than after it. The code is minted per request
 * and expires within ten minutes, which is why it is not cached anywhere.
 *
 * The token is printed underneath as text. A camera that will not focus, a
 * cracked screen, or a phone at 1% are all more common at a badminton court
 * than any of them are in a design review, and an organizer who can type six
 * characters is not blocked by any of them.
 */

import { Card } from "./ui.tsx";
import { encodeQr, qrSvgPath, qrViewBox } from "../lib/qr/encode.ts";

export interface CheckinCodeProps {
  token: string;
  /** Rendered smaller inside a list of games. */
  compact?: boolean;
}

export function CheckinCode(props: CheckinCodeProps) {
  const matrix = encodeQr(props.token);

  return (
    <Card class="flex flex-col items-center gap-4">
      <div class="flex flex-col items-center gap-1">
        <h2 class="text-body-lg font-bold text-on-surface">
          Your check-in code
        </h2>
        <p class="text-label-sm text-on-surface-variant text-center">
          Show this at the door. It refreshes every few minutes.
        </p>
      </div>

      <svg
        viewBox={qrViewBox(matrix)}
        width={props.compact ? 160 : 220}
        height={props.compact ? 160 : 220}
        role="img"
        aria-label="Your check-in QR code"
        class="rounded-lg bg-white p-2 shadow-card"
      >
        {
          /* The quiet zone is part of the view box, so the background must
            cover it — a code drawn tight to its edge does not scan. */
        }
        <rect
          x={-4}
          y={-4}
          width={matrix.length + 8}
          height={matrix.length + 8}
          fill="#ffffff"
        />
        <path d={qrSvgPath(matrix)} fill="#000000" />
      </svg>

      <div class="flex flex-col items-center gap-1">
        <p class="text-label-sm text-on-surface-variant">
          Or read this out:
        </p>
        <code class="text-body-md font-mono text-on-surface tracking-wide break-all text-center">
          {props.token}
        </code>
      </div>
    </Card>
  );
}
