import { assertEquals, assertThrows } from "@std/assert";
import { appUrl } from "./email.ts";

/** Restores whatever the surrounding environment had, including unset. */
function withEnv(
  vars: Record<string, string | undefined>,
  body: () => void,
): void {
  const before = new Map<string, string | undefined>();
  for (const name of Object.keys(vars)) {
    before.set(name, Deno.env.get(name));
  }

  try {
    for (const [name, value] of Object.entries(vars)) {
      if (value === undefined) Deno.env.delete(name);
      else Deno.env.set(name, value);
    }
    body();
  } finally {
    for (const [name, value] of before) {
      if (value === undefined) Deno.env.delete(name);
      else Deno.env.set(name, value);
    }
  }
}

Deno.test("APP_URL is used verbatim when it is set", () => {
  withEnv({ APP_URL: "https://smash.example.com" }, () => {
    assertEquals(appUrl(), "https://smash.example.com");
  });
});

Deno.test("development falls back to localhost", () => {
  withEnv({ APP_URL: undefined, DENO_DEPLOYMENT_ID: undefined }, () => {
    assertEquals(appUrl(), "http://localhost:8000");
  });
});

Deno.test("a deployment without APP_URL refuses rather than sending dead links", () => {
  withEnv({ APP_URL: undefined, DENO_DEPLOYMENT_ID: "deploy-123" }, () => {
    // Silently defaulting to localhost here would build every magic link and
    // QR payload against an origin nobody can reach.
    assertThrows(() => appUrl(), Error, "APP_URL must be set");
  });
});
