/**
 * Test helpers. Every case gets a fresh in-memory KV database, so tests never
 * touch the developer's local data and never leak state between cases.
 */

import { encodeBase64 } from "@std/encoding/base64";
import { resetKeyCache } from "../crypto.ts";

/** Opens an isolated in-memory database. Pass ":memory:" to Deno.openKv. */
export async function openTestKv(): Promise<Deno.Kv> {
  return await Deno.openKv(":memory:");
}

/**
 * Runs a test body against a throwaway database, closing it afterwards even if
 * the body throws.
 */
export async function withTestKv<T>(
  fn: (kv: Deno.Kv) => Promise<T>,
): Promise<T> {
  const kv = await openTestKv();
  try {
    return await fn(kv);
  } finally {
    kv.close();
  }
}

/**
 * Installs deterministic test secrets. Real keys never appear in tests, and
 * the crypto key cache is reset so the new values take effect.
 */
export function setTestEnv(): void {
  const key = encodeBase64(new Uint8Array(32).fill(7));
  Deno.env.set("IBAN_ENC_KEY", key);
  Deno.env.set("APP_SECRET", encodeBase64(new Uint8Array(32).fill(9)));
  Deno.env.set("APP_URL", "http://localhost:8000");
  resetKeyCache();
}
