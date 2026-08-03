/**
 * The organizer's camera scanner.
 *
 * Uses the browser's own `BarcodeDetector` rather than a bundled decode
 * library. Where it is missing — Firefox, older Safari — the scanner says so
 * and points at the manual toggles below it, which already do this job. That
 * is a real fallback rather than a degraded one: before this phase, marking
 * the roster by hand was the only way.
 *
 * This is the one place in the app that talks JSON. Every other action is a
 * form POST that redirects, but reloading between players would drop the
 * camera stream and the organizer's place in the queue.
 */

import { useEffect, useRef, useState } from "preact/hooks";
import { Alert, Button } from "../components/ui.tsx";

interface Props {
  slug: string;
  csrf: string;
  csrfField: string;
}

interface Seen {
  name: string;
  at: number;
}

/** Not in the DOM types yet; present on Chrome and Safari 17+. */
interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<Array<{ rawValue: string }>>;
}

declare global {
  var BarcodeDetector: {
    new (options?: { formats?: string[] }): BarcodeDetectorLike;
  } | undefined;
}

export default function CheckinScanner(props: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [running, setRunning] = useState(false);
  const [supported, setSupported] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [recent, setRecent] = useState<Seen[]>([]);

  // Tokens already sent, so a code held in frame for a second does not post
  // thirty times. setAttendance is idempotent, but the network calls are not
  // free and the flashing feedback would be unreadable.
  const sent = useRef(new Set<string>());

  useEffect(() => {
    setSupported(typeof globalThis.BarcodeDetector !== "undefined");
  }, []);

  useEffect(() => {
    if (!running) return;

    let stream: MediaStream | null = null;
    let cancelled = false;
    let timer = 0;

    const start = async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          // The rear camera is the one pointed at a queue.
          video: { facingMode: "environment" },
        });
        if (cancelled) return;

        const video = videoRef.current;
        if (!video) return;
        video.srcObject = stream;
        await video.play();

        const detector = new globalThis.BarcodeDetector!({
          formats: ["qr_code"],
        });

        const tick = async () => {
          if (cancelled || !videoRef.current) return;

          try {
            const codes = await detector.detect(videoRef.current);
            for (const code of codes) await submit(code.rawValue);
          } catch {
            // A frame that fails to decode is the normal case, not an error.
          }

          timer = setTimeout(tick, 250);
        };

        tick();
      } catch (cause) {
        if (cancelled) return;
        setError(
          cause instanceof Error && cause.name === "NotAllowedError"
            ? "Camera access was declined. Mark players present below instead."
            : "The camera could not be started. Mark players present below instead.",
        );
        setRunning(false);
      }
    };

    start();

    return () => {
      cancelled = true;
      clearTimeout(timer);
      stream?.getTracks().forEach((track) => track.stop());
    };
  }, [running]);

  const submit = async (token: string) => {
    if (sent.current.has(token)) return;
    sent.current.add(token);

    const body = new FormData();
    body.set(props.csrfField, props.csrf);
    body.set("token", token);

    try {
      const response = await fetch(`/games/${props.slug}/checkin`, {
        method: "POST",
        body,
      });
      const result = await response.json();

      if (result.ok) {
        setError(null);
        setRecent((seen) =>
          [{ name: result.name, at: Date.now() }, ...seen]
            .slice(0, 5)
        );
      } else {
        setError(result.error ?? "That code could not be read.");
        // A refused code may become valid — a stale one refreshes on the
        // player's screen — so it is not remembered as already sent.
        sent.current.delete(token);
      }
    } catch {
      setError("That did not reach the server. Check the connection.");
      sent.current.delete(token);
    }
  };

  if (!supported) {
    return (
      <Alert tone="info">
        This browser cannot scan codes. Mark players present using the roster
        below.
      </Alert>
    );
  }

  return (
    <div class="flex flex-col gap-3">
      {error && <Alert tone="error">{error}</Alert>}

      {running
        ? (
          <div class="flex flex-col gap-3">
            <video
              ref={videoRef}
              muted
              playsInline
              class="w-full rounded-xl bg-surface-container aspect-[4/3] object-cover"
            />
            <Button variant="ghost" onClick={() => setRunning(false)}>
              Stop scanning
            </Button>
          </div>
        )
        : (
          <Button onClick={() => setRunning(true)} fullWidth>
            Start scanning
          </Button>
        )}

      {recent.length > 0 && (
        <ul class="flex flex-col gap-1" aria-live="polite">
          {recent.map((seen) => (
            <li
              key={`${seen.name}-${seen.at}`}
              class="text-body-md text-on-surface"
            >
              ✓ {seen.name} checked in
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
