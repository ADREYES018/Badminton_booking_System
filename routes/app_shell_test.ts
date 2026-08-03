/**
 * The document shell must actually carry the compiled stylesheet.
 *
 * Tailwind compiles through Vite, so a stylesheet nothing imports is copied
 * rather than compiled — the browser then receives design tokens and an
 * `@import` it cannot follow, and every page renders as unstyled HTML. That
 * shipped once. Nothing failed: the build succeeded, the tests passed, and the
 * page was served with a stylesheet link pointing at a file with no rules in
 * it.
 *
 * These tests run against the built output rather than the dev server, because
 * that is what a deployment serves.
 */

import { assertEquals, assertMatch, assertStringIncludes } from "@std/assert";

const BUILT = new URL("../_fresh/client/", import.meta.url);

/** Skipped rather than failed when the build has not been run. */
async function builtCss(): Promise<{ name: string; css: string } | null> {
  try {
    for await (const entry of Deno.readDir(new URL("assets/", BUILT))) {
      if (entry.isFile && entry.name.endsWith(".css")) {
        return {
          name: entry.name,
          css: await Deno.readTextFile(new URL(`assets/${entry.name}`, BUILT)),
        };
      }
    }
  } catch {
    return null;
  }
  return null;
}

Deno.test("the built stylesheet is compiled Tailwind, not its source", async () => {
  const built = await builtCss();
  if (!built) {
    console.info("skipped: run `deno task build` first");
    return;
  }

  // The source starts with this. Seeing it in the output means the file was
  // copied past Tailwind rather than through it.
  assertEquals(built.css.includes('@import "tailwindcss"'), false);

  // A handful of utilities the app cannot render without.
  for (const rule of [".flex{", ".rounded-full{", ".bg-lime{"]) {
    assertStringIncludes(built.css, rule);
  }

  // Compiled Tailwind for this app is tens of kilobytes; the bare token file
  // is six.
  assertEquals(
    built.css.length > 15_000,
    true,
    `stylesheet is only ${built.css.length} bytes`,
  );
});

Deno.test("the stylesheet is hashed, so a change cannot be served from cache", async () => {
  const built = await builtCss();
  if (!built) {
    console.info("skipped: run `deno task build` first");
    return;
  }
  assertMatch(built.name, /-[A-Za-z0-9_-]{8,}\.css$/);
});

Deno.test("the shell does not link a stylesheet by hand", async () => {
  const shell = await Deno.readTextFile(
    new URL("../routes/_app.tsx", import.meta.url),
  );
  // Vite injects the compiled, hashed stylesheet. A hardcoded path survives
  // the build, resolves to nothing, and takes every style with it.
  assertEquals(shell.includes('href="/styles.css"'), false);
});
