import { assertEquals, assertNotEquals, assertRejects } from "@std/assert";
import {
  decryptSecret,
  encryptSecret,
  hashPassword,
  ibanLast4,
  maskIban,
  randomToken,
  sha256Hex,
  timingSafeEqual,
  verifyPassword,
} from "./crypto.ts";
import { setTestEnv } from "./testing/kv_test_helper.ts";

setTestEnv();

Deno.test("IBAN encryption round-trips", async () => {
  const iban = "AE070331234567890123456";
  const encrypted = await encryptSecret(iban);
  assertEquals(await decryptSecret(encrypted), iban);
});

Deno.test("ciphertext never contains the plaintext", async () => {
  const iban = "AE070331234567890123456";
  const encrypted = await encryptSecret(iban);
  const asText = new TextDecoder().decode(encrypted.ciphertext);
  assertEquals(asText.includes(iban), false);
  assertEquals(asText.includes("0331234567"), false);
});

Deno.test("same plaintext encrypts differently each time", async () => {
  const a = await encryptSecret("AE070331234567890123456");
  const b = await encryptSecret("AE070331234567890123456");
  // A fresh IV per encryption means identical inputs must not collide.
  assertNotEquals(
    Array.from(a.ciphertext).join(","),
    Array.from(b.ciphertext).join(","),
  );
});

Deno.test("tampered ciphertext fails authentication", async () => {
  const encrypted = await encryptSecret("AE070331234567890123456");
  encrypted.ciphertext.set([encrypted.ciphertext[0]! ^ 0xff], 0);
  // AES-GCM authenticates, so a flipped bit must throw rather than decode.
  await assertRejects(() => decryptSecret(encrypted));
});

Deno.test("random tokens are URL-safe and unique", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 200; i++) {
    const token = randomToken();
    assertEquals(/^[A-Za-z0-9_-]+$/.test(token), true);
    assertEquals(seen.has(token), false);
    seen.add(token);
  }
});

Deno.test("sha256Hex is stable and hex encoded", async () => {
  const hash = await sha256Hex("smash");
  assertEquals(/^[0-9a-f]{64}$/.test(hash), true);
  assertEquals(await sha256Hex("smash"), hash);
  assertNotEquals(await sha256Hex("smash2"), hash);
});

Deno.test("timingSafeEqual compares correctly", () => {
  assertEquals(timingSafeEqual("abc123", "abc123"), true);
  assertEquals(timingSafeEqual("abc123", "abc124"), false);
  assertEquals(timingSafeEqual("abc", "abcdef"), false);
});

Deno.test("join password hashing verifies and rejects", async () => {
  const stored = await hashPassword("court-night");
  assertEquals(await verifyPassword("court-night", stored), true);
  assertEquals(await verifyPassword("wrong", stored), false);
});

Deno.test("password hash is salted per call", async () => {
  const a = await hashPassword("court-night");
  const b = await hashPassword("court-night");
  assertNotEquals(a, b);
  // Both still verify despite differing hashes.
  assertEquals(await verifyPassword("court-night", a), true);
  assertEquals(await verifyPassword("court-night", b), true);
});

Deno.test("malformed stored password hash is rejected, not thrown", async () => {
  assertEquals(await verifyPassword("x", "garbage"), false);
  assertEquals(await verifyPassword("x", ""), false);
});

Deno.test("IBAN masking exposes only the last four digits", () => {
  assertEquals(maskIban("AE07 0331 2345 6789 0123 456"), "•••• 3456");
  assertEquals(ibanLast4("AE07 0331 2345 6789 0123 456"), "3456");
  assertEquals(maskIban("123"), "••••");
});
