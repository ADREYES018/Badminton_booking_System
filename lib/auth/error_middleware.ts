/**
 * Turns thrown HttpErrors into proper responses.
 *
 * Without this an unauthenticated request produces a 500 rather than sending
 * the visitor to sign in. 401s redirect to login carrying the original path,
 * so the user lands where they were headed.
 */

import { HttpError } from "./middleware.ts";

export interface ErrorPageProps {
  status: number;
  message: string;
}

export function handleRouteError(req: Request, error: unknown): Response {
  if (!(error instanceof HttpError)) throw error;

  const url = new URL(req.url);

  if (error.status === 401) {
    const next = url.pathname + url.search;
    const target = new URL("/auth/login", url.origin);
    // Only remember a real destination; bouncing back to login would loop.
    if (next !== "/" && !next.startsWith("/auth/")) {
      target.searchParams.set("next", next);
    }
    return new Response(null, {
      status: 303,
      headers: { location: target.toString() },
    });
  }

  return new Response(renderErrorPage(error.status, error.message), {
    status: error.status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

/**
 * Minimal standalone error page. Deliberately not the app shell — that shell
 * loads the session, which is exactly what may have just failed.
 */
function renderErrorPage(status: number, message: string): string {
  const safe = message
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${status} · Smash Club</title>
</head>
<!-- Every rule here is inline. The compiled stylesheet has a hashed name this
     page cannot know, and an error page that depends on the build having
     succeeded is an error page that fails when it is most needed. -->
<body style="margin:0;background:#f9fbe7;color:#161f00;font-family:system-ui,sans-serif;">
  <main style="min-height:100dvh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:24px;text-align:center;">
    <p style="font-size:13px;letter-spacing:0.12em;text-transform:uppercase;color:#506600;font-weight:700;">Smash Club</p>
    <h1 style="font-size:32px;margin:0;">${status}</h1>
    <p style="margin:0;max-width:32rem;">${safe}</p>
    <a href="/games" style="margin-top:12px;display:inline-block;background:#c6f432;color:#161f00;text-decoration:none;font-weight:700;padding:12px 24px;border-radius:999px;">Back to games</a>
  </main>
</body>
</html>`;
}
