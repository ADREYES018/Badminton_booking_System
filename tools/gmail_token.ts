/**
 * Mints a GMAIL_REFRESH_TOKEN by walking Google's consent flow.
 *
 *   deno run -A tools/gmail_token.ts
 *
 * Reads GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET from the environment or, when
 * they are absent, asks for them. Opens the consent screen, catches the
 * redirect on localhost and prints the line to paste into the deployment.
 *
 * The redirect lands on this machine rather than on a hosted page, so the
 * authorisation code never leaves it. Google requires the exact URI below to be
 * listed on the OAuth client — an unlisted one is refused before consent.
 *
 * `access_type=offline` is what asks for a refresh token at all, and
 * `prompt=consent` is what makes Google hand one over again on a repeat
 * authorisation. Without the second, a second run returns an access token and
 * no refresh token, which reads as the script being broken.
 */

const PORT = 8111;
const REDIRECT_URI = `http://localhost:${PORT}/callback`;
const SCOPE = "https://www.googleapis.com/auth/gmail.send";
const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

function ask(label: string): string {
  const value = prompt(`${label}:`)?.trim();
  if (!value) {
    console.error(`\n${label} is required. Nothing was changed.`);
    Deno.exit(1);
  }
  return value;
}

const clientId = Deno.env.get("GMAIL_CLIENT_ID") ?? ask("GMAIL_CLIENT_ID");
const clientSecret = Deno.env.get("GMAIL_CLIENT_SECRET") ??
  ask("GMAIL_CLIENT_SECRET");

const authUrl = new URL(AUTH_ENDPOINT);
authUrl.search = new URLSearchParams({
  client_id: clientId,
  redirect_uri: REDIRECT_URI,
  response_type: "code",
  scope: SCOPE,
  access_type: "offline",
  prompt: "consent",
}).toString();

console.log("\nAdd this exact redirect URI to the OAuth client first:");
console.log(`  ${REDIRECT_URI}\n`);
console.log("Then sign in as the club's Gmail account at:\n");
console.log(`  ${authUrl}\n`);
console.log("Waiting for the redirect…");

/** Resolves with the authorisation code once Google redirects back. */
const code = await new Promise<string>((resolve, reject) => {
  const server = Deno.serve({ port: PORT, onListen: () => {} }, (request) => {
    const url = new URL(request.url);
    if (url.pathname !== "/callback") return new Response("", { status: 404 });

    const error = url.searchParams.get("error");
    const received = url.searchParams.get("code");

    // The server is shut down from inside its own handler, so the response has
    // to be built before the shutdown is scheduled.
    const body = error
      ? `Authorisation failed: ${error}. Return to the terminal.`
      : "Authorised. Return to the terminal — you can close this tab.";
    const response = new Response(body, {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });

    queueMicrotask(() => {
      server.shutdown();
      if (error) reject(new Error(error));
      else if (received) resolve(received);
      else reject(new Error("Google redirected back without a code."));
    });

    return response;
  });
});

const response = await fetch(TOKEN_ENDPOINT, {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    redirect_uri: REDIRECT_URI,
    grant_type: "authorization_code",
  }),
});

const granted = await response.json();

if (!response.ok) {
  console.error(`\nGoogle refused the exchange (${response.status}):`);
  console.error(granted.error_description ?? granted.error ?? "");
  Deno.exit(1);
}

if (!granted.refresh_token) {
  console.error(
    "\nGoogle returned no refresh token. That happens when this account has " +
      "already authorised this client and consent was not re-prompted. " +
      "Revoke the app at https://myaccount.google.com/permissions and run " +
      "this again.",
  );
  Deno.exit(1);
}

console.log(`\nGMAIL_REFRESH_TOKEN=${granted.refresh_token}\n`);
console.log(
  "Paste that into the deployment's environment variables, then redeploy.\n" +
    "If the OAuth consent screen is still in Testing, this token expires in\n" +
    "seven days — publish the app to stop that.",
);
