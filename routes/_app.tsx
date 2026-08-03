/**
 * HTML document wrapper. Sets the PWA hooks and applies the saved colour theme
 * before first paint, so a dark-mode user never sees a light flash.
 */

import type { PageProps } from "fresh";

const THEME_BOOTSTRAP = `
(function () {
  try {
    var saved = localStorage.getItem("sc-theme");
    var dark = saved ? saved === "dark"
      : matchMedia("(prefers-color-scheme: dark)").matches;
    if (dark) document.documentElement.classList.add("dark");
  } catch (_) {}
})();
`;

export default function App({ Component }: PageProps) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1, viewport-fit=cover"
        />
        <title>Smash Club</title>
        <meta
          name="description"
          content="Badminton games, RSVP and check-in for the Dubai club."
        />
        <meta name="theme-color" content="#c6f432" />
        <link rel="manifest" href="/manifest.webmanifest" />
        <link rel="icon" href="/icons/icon-192.png" sizes="192x192" />
        <link rel="apple-touch-icon" href="/icons/icon-192.png" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-title" content="Smash Club" />
        {/* No stylesheet link: Vite injects the compiled, hashed one. */}
        <script
          // deno-lint-ignore react-no-danger -- static constant, must run before paint to avoid a light flash
          dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }}
        />
      </head>
      <body>
        <Component />
      </body>
    </html>
  );
}
