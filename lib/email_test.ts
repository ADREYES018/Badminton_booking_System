import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { decodeBase64Url } from "@std/encoding/base64url";
import {
  appUrl,
  buildMime,
  EmailError,
  encodeHeader,
  parseSender,
  paymentClaimedEmail,
  sendEmail,
} from "./email.ts";
import type { Game } from "./types.ts";

/** The fields the templates actually read. */
function testGame(): Game {
  return {
    v: 2,
    id: "g1",
    groupId: "grp1",
    slug: "sunday-x1",
    title: "Sunday Doubles",
    venue: { name: "Al Quoz Courts", address: "Street 4, Al Quoz" },
    startUtc: "2026-08-09T14:00:00.000Z",
    endUtc: "2026-08-09T16:00:00.000Z",
    courts: 2,
    courtMode: "fixed",
    playersPerCourt: 4,
    courtStatus: "reserved",
    pricePerPlayerFils: 4500,
    maxGuestsPerPlayer: 1,
    visibility: "public",
    cutoffHours: 48,
    status: "open",
    confirmedCount: 4,
    pendingCount: 0,
    waitlistCount: 0,
    guestCount: 0,
    createdBy: "u1",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  };
}

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

/** As `withEnv`, for bodies that await. */
async function withEnvAsync(
  vars: Record<string, string | undefined>,
  body: () => Promise<void>,
): Promise<void> {
  const before = new Map<string, string | undefined>();
  for (const name of Object.keys(vars)) before.set(name, Deno.env.get(name));

  try {
    for (const [name, value] of Object.entries(vars)) {
      if (value === undefined) Deno.env.delete(name);
      else Deno.env.set(name, value);
    }
    await body();
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

Deno.test("a sender in Name <addr> form splits into a name and an address", () => {
  assertEquals(parseSender("Smash Club <play@example.com>"), {
    name: "Smash Club",
    email: "play@example.com",
  });
});

Deno.test("a bare address still sends, under the club's name", () => {
  assertEquals(parseSender("play@example.com"), {
    name: "Smash Club",
    email: "play@example.com",
  });
});

Deno.test("surrounding whitespace never reaches the provider", () => {
  assertEquals(parseSender("  Smash Club  <  play@example.com  >  "), {
    name: "Smash Club",
    email: "play@example.com",
  });
});

Deno.test("an unset EMAIL_FROM names the variable rather than sending as the wrong address", () => {
  withEnv({ EMAIL_FROM: undefined }, () => {
    // Gmail silently rewrites a From it does not recognise as an alias of the
    // authorising account, so a default here would be a wrong answer with no
    // error attached.
    assertThrows(() => parseSender(), Error, "EMAIL_FROM");
  });
});

Deno.test("an ASCII subject is left alone", () => {
  // Encoding everything would be correct but unreadable in a mail log.
  assertEquals(encodeHeader("Your Smash Club code"), "Your Smash Club code");
});

Deno.test("a non-ASCII subject is encoded rather than mangled", () => {
  const encoded = encodeHeader("Café badminton");

  assertStringIncludes(encoded, "=?UTF-8?B?");
  assertStringIncludes(encoded, "?=");
  // The raw character must not survive: headers are ASCII-only and a mail
  // server is free to strip or replace anything else.
  assertEquals(encoded.includes("é"), false);
});

Deno.test("the plain-text part precedes the HTML part", () => {
  // Clients render the last part they understand, so this order is what makes
  // HTML win where it is supported and text work where it is not.
  withEnv({ EMAIL_FROM: "Smash Club <play@example.com>" }, () => {
    const mime = buildMime({
      to: "player@example.com",
      subject: "Test",
      html: "<p>Rich</p>",
      text: "Plain",
    });

    assertEquals(mime.indexOf("text/plain") < mime.indexOf("text/html"), true);
    assertStringIncludes(mime, "multipart/alternative");
    assertStringIncludes(mime, "player@example.com");
  });
});

Deno.test("with no refresh token the message is logged instead of sent", async () => {
  const lines: string[] = [];
  const realInfo = console.info;
  console.info = (...args: unknown[]) => void lines.push(args.join(" "));

  try {
    await withEnvAsync({ GMAIL_REFRESH_TOKEN: undefined }, async () => {
      await sendEmail({
        to: "player@example.com",
        subject: "Test",
        html: "<p>Test</p>",
        text: "Test",
      });
    });
  } finally {
    console.info = realInfo;
  }

  assertStringIncludes(lines.join("\n"), "player@example.com");
});

Deno.test("a send posts base64url, which has no plus or slash in it", async () => {
  const realFetch = globalThis.fetch;
  let sentRaw = "";

  globalThis.fetch = (input: string | URL | Request, init?: RequestInit) => {
    const url = input.toString();

    if (url.includes("oauth2")) {
      return Promise.resolve(
        Response.json({ access_token: "test-token", expires_in: 3600 }),
      );
    }

    sentRaw = JSON.parse(init!.body as string).raw;
    return Promise.resolve(Response.json({ id: "sent" }));
  };

  try {
    await withEnvAsync({
      GMAIL_CLIENT_ID: "id",
      GMAIL_CLIENT_SECRET: "secret",
      GMAIL_REFRESH_TOKEN: "refresh",
      EMAIL_FROM: "Smash Club <play@example.com>",
    }, async () => {
      await sendEmail({
        to: "player@example.com",
        subject: "Test",
        html: "<p>Test</p>",
        text: "Test",
      });
    });
  } finally {
    globalThis.fetch = realFetch;
  }

  // Standard base64 fails here with an unhelpful parse error from Google.
  assertEquals(sentRaw.includes("+"), false);
  assertEquals(sentRaw.includes("/"), false);
  assertStringIncludes(
    new TextDecoder().decode(decodeBase64Url(sentRaw)),
    "player@example.com",
  );
});

Deno.test("a revoked refresh token reads as configuration, not as a network fault", () => {
  // invalid_grant is what a revoked token and a consent screen left in Testing
  // both look like, and the fix for either is in the Google Cloud console.
  const rejected = new EmailError(
    400,
    JSON.stringify({
      error: "invalid_grant",
      error_description: "Token has been expired or revoked.",
    }),
  );

  assertEquals(rejected.isConfiguration, true);
  assertStringIncludes(rejected.reason, "revoked");
});

Deno.test("the payment notice names the player, the amount and the game", () => {
  withEnv({ APP_URL: "https://smash.example" }, () => {
    const message = paymentClaimedEmail(
      "organizer@example.com",
      testGame(),
      "Rana",
      4500,
    );

    assertEquals(message.to, "organizer@example.com");
    assertStringIncludes(message.subject, "Rana");
    assertStringIncludes(message.subject, "AED 45");
    assertStringIncludes(message.subject, "Sunday Doubles");
    // The link has to reach the game, since confirming happens there.
    assertStringIncludes(message.html, "https://smash.example/games/sunday-x1");
    assertStringIncludes(message.text, "https://smash.example/games/sunday-x1");
  });
});

Deno.test("the payment notice says the money is not confirmed yet", () => {
  withEnv({ APP_URL: "https://smash.example" }, () => {
    // An organizer who reads a claim as settled and skips the statement is the
    // failure the two-step confirmation exists to prevent.
    const message = paymentClaimedEmail(
      "organizer@example.com",
      testGame(),
      "Rana",
      4500,
    );

    assertStringIncludes(message.text, "Nothing is settled until you confirm");
    assertStringIncludes(message.html, "their word, not the bank");
  });
});

Deno.test("a player name that would break the markup is escaped", () => {
  withEnv({ APP_URL: "https://smash.example" }, () => {
    const message = paymentClaimedEmail(
      "organizer@example.com",
      testGame(),
      '<script>alert("x")</script>',
      4500,
    );

    assertEquals(message.html.includes("<script>"), false);
    assertStringIncludes(message.html, "&lt;script&gt;");
  });
});
