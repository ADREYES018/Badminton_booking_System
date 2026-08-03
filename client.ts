/**
 * Client entry point.
 *
 * Its only job is to pull the stylesheet into Vite's module graph. Tailwind
 * compiles through Vite, so a stylesheet nothing imports is never processed —
 * it gets copied verbatim, `@import "tailwindcss"` and all, and the browser
 * receives design tokens with no utility classes behind them. Vite injects the
 * compiled, hashed stylesheet into the document itself, so nothing links it by
 * hand.
 */

import "./assets/styles.css";
