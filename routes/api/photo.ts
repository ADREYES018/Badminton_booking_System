/**
 * Serves profile photos from KV.
 *
 * Photos are visible to signed-in members only — a roster avatar should not be
 * scrapeable by anyone with a user id.
 */

import type { App } from "fresh";
import type { State } from "../../main.ts";
import { requireUser } from "../../lib/auth/middleware.ts";
import { getPhoto, PHOTO_MIME } from "../../lib/data/photos.ts";

export function photoRoute(app: App<State>) {
  app.get("/api/photo/:userId", async (ctx) => {
    requireUser(ctx.state.auth);

    const userId = ctx.params.userId;
    if (!userId) return new Response("Not found", { status: 404 });

    const bytes = await getPhoto(ctx.state.auth.kv, userId);
    if (!bytes) return new Response("Not found", { status: 404 });

    // Copy into a plain ArrayBuffer-backed view; the type KV returns is wider
    // than what Response accepts as a body.
    const body = new Uint8Array(new ArrayBuffer(bytes.byteLength));
    body.set(bytes);

    return new Response(body, {
      headers: {
        "content-type": PHOTO_MIME,
        // Private: cached by the member's browser, never by a shared proxy.
        "cache-control": "private, max-age=3600",
      },
    });
  });
}
