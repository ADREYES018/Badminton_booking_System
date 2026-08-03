import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { appUrl, EmailError } from "./email.ts";

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

Deno.test("a provider refusal carries its own explanation", () => {
  const rejected = new EmailError(
    403,
    JSON.stringify({
      statusCode: 403,
      message:
        "You can only send testing emails to your own email address (you@example.com).",
    }),
  );

  assertEquals(rejected.isConfiguration, true);
  assertStringIncludes(rejected.reason, "your own email address");
});

Deno.test("a provider outage is not treated as a misconfiguration", () => {
  const down = new EmailError(502, "Bad Gateway");
  assertEquals(down.isConfiguration, false);
});

Deno.test("a refusal that is not JSON still says something", () => {
  const odd = new EmailError(422, "Unprocessable Entity");
  assertEquals(odd.reason, "Unprocessable Entity");
});
