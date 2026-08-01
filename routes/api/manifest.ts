/**
 * PWA manifest, served dynamically so the icons stay in step with the brand
 * assets without a build step.
 */

import type { App } from "fresh";
import type { State } from "../../main.ts";

const MANIFEST = {
  name: "Smash Club",
  short_name: "Smash Club",
  description: "Badminton games, RSVP and check-in for the Dubai club.",
  start_url: "/games",
  scope: "/",
  display: "standalone",
  orientation: "portrait",
  // Matches the design system's warm off-white surface.
  background_color: "#f9fbe7",
  theme_color: "#c6f432",
  categories: ["sports", "social"],
  icons: [
    {
      src: "/icons/icon-192.png",
      sizes: "192x192",
      type: "image/png",
      purpose: "any",
    },
    {
      src: "/icons/icon-512.png",
      sizes: "512x512",
      type: "image/png",
      purpose: "any",
    },
    {
      src: "/icons/icon-maskable-512.png",
      sizes: "512x512",
      type: "image/png",
      purpose: "maskable",
    },
  ],
};

export function manifestRoute(app: App<State>) {
  app.get("/manifest.webmanifest", () => {
    return new Response(JSON.stringify(MANIFEST, null, 2), {
      headers: {
        "content-type": "application/manifest+json",
        "cache-control": "public, max-age=3600",
      },
    });
  });
}
