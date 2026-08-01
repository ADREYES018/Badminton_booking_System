/**
 * Generates the two 32-byte secrets the app needs.
 *
 *   deno run -A tools/genkey.ts
 *
 * Copy the output into .env. Changing IBAN_ENC_KEY makes every stored IBAN
 * undecryptable, so generate it once and keep it safe.
 */

import { encodeBase64 } from "@std/encoding/base64";

function key(): string {
  return encodeBase64(crypto.getRandomValues(new Uint8Array(32)));
}

console.log(`IBAN_ENC_KEY=${key()}`);
console.log(`APP_SECRET=${key()}`);
