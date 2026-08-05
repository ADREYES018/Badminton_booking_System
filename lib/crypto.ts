/**
 * Cryptographic primitives: IBAN encryption at rest, token hashing, and the
 * rotating HMAC used by QR check-in.
 *
 * Keys come from the environment only. Nothing here writes a secret to a log.
 */

import { decodeBase64, encodeBase64 } from "@std/encoding/base64";
import type { EncryptedField } from "./types.ts";

const IV_LENGTH = 12; // 96-bit nonce, the size AES-GCM is specified for.

/**
 * Copies bytes into a plain ArrayBuffer-backed view. WebCrypto rejects
 * SharedArrayBuffer-backed views, which is what the loose Uint8Array type
 * coming back from KV permits.
 */
function toArrayBufferView(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  copy.set(bytes);
  return copy;
}

function requireEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) {
    throw new Error(
      `Missing required environment variable ${name}. See .env.example.`,
    );
  }
  return value;
}

/**
 * Fails at boot when a secret is missing, rather than on the first request
 * that happens to need one.
 *
 * Both keys are built lazily, so a server started without them serves most of
 * the app perfectly well and then throws a 500 somewhere specific — a game
 * page minting a check-in QR, say. The action that led there has already
 * succeeded by then, which makes the failure read as a bug in whatever button
 * was pressed rather than as missing configuration.
 *
 * Called for its throw; the keys it builds are the same cached promises every
 * later caller gets.
 */
export async function assertSecretsPresent(): Promise<void> {
  await Promise.all([getIbanKey(), getAppSecret()]);
}

let ibanKeyPromise: Promise<CryptoKey> | null = null;

/** AES-256-GCM key for player refund IBANs, from IBAN_ENC_KEY. */
function getIbanKey(): Promise<CryptoKey> {
  if (ibanKeyPromise) return ibanKeyPromise;
  ibanKeyPromise = (async () => {
    const raw = toArrayBufferView(decodeBase64(requireEnv("IBAN_ENC_KEY")));
    if (raw.length !== 32) {
      throw new Error("IBAN_ENC_KEY must decode to exactly 32 bytes");
    }
    return await crypto.subtle.importKey("raw", raw, "AES-GCM", false, [
      "encrypt",
      "decrypt",
    ]);
  })();
  return ibanKeyPromise;
}

let appSecretPromise: Promise<CryptoKey> | null = null;

/** HMAC-SHA-256 key for session ids and QR tokens, from APP_SECRET. */
function getAppSecret(): Promise<CryptoKey> {
  if (appSecretPromise) return appSecretPromise;
  appSecretPromise = (async () => {
    const raw = toArrayBufferView(decodeBase64(requireEnv("APP_SECRET")));
    if (raw.length < 32) {
      throw new Error("APP_SECRET must decode to at least 32 bytes");
    }
    return await crypto.subtle.importKey(
      "raw",
      raw,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"],
    );
  })();
  return appSecretPromise;
}

/** Test hook: forces keys to be re-read after the environment changes. */
export function resetKeyCache(): void {
  ibanKeyPromise = null;
  appSecretPromise = null;
}

export async function encryptSecret(
  plaintext: string,
): Promise<EncryptedField> {
  const key = await getIbanKey();
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const encoded = new TextEncoder().encode(plaintext);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoded,
  );
  return { ciphertext: new Uint8Array(ciphertext), iv };
}

/**
 * Decrypts a stored secret. Callers must have already checked authorization
 * and must write an audit entry — decryption is never silent.
 */
export async function decryptSecret(field: EncryptedField): Promise<string> {
  const key = await getIbanKey();
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: toArrayBufferView(field.iv) },
    key,
    toArrayBufferView(field.ciphertext),
  );
  return new TextDecoder().decode(plaintext);
}

/** Random URL-safe token. Used for magic links, session ids, and slugs. */
export function randomToken(bytes = 32): string {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  return encodeBase64(buf)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

/**
 * SHA-256, hex encoded. Magic-link tokens are stored hashed so a database read
 * never yields a usable login link.
 */
export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Constant-time comparison, so token checks leak no timing information. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export async function hmacHex(message: string): Promise<string> {
  const key = await getAppSecret();
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(message),
  );
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Hashes a per-game join password. PBKDF2 with a random salt — these are
 * low-value shared secrets, but they are still never stored in clear.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const derived = await pbkdf2(password, salt);
  return `${encodeBase64(salt)}:${encodeBase64(derived)}`;
}

export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const [saltPart, hashPart] = stored.split(":");
  if (!saltPart || !hashPart) return false;
  const salt = toArrayBufferView(decodeBase64(saltPart));
  const derived = await pbkdf2(password, salt);
  return timingSafeEqual(encodeBase64(derived), hashPart);
}

async function pbkdf2(
  password: string,
  salt: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 100_000, hash: "SHA-256" },
    keyMaterial,
    256,
  );
  return new Uint8Array(bits);
}

/** Masks an IBAN for display, keeping only the last four characters. */
export function maskIban(iban: string): string {
  const cleaned = iban.replace(/\s+/g, "");
  return cleaned.length <= 4 ? "••••" : `•••• ${cleaned.slice(-4)}`;
}

export function ibanLast4(iban: string): string {
  return iban.replace(/\s+/g, "").slice(-4);
}
