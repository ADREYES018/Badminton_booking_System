import { assertEquals } from "@std/assert";
import {
  isValidEmail,
  isValidIban,
  normalizeEmail,
  normalizeIban,
  normalizePhone,
  slugify,
} from "./validate.ts";

Deno.test("email normalization collapses case and whitespace", () => {
  assertEquals(normalizeEmail("  Player@Example.COM "), "player@example.com");
});

Deno.test("email validation accepts real addresses and rejects junk", () => {
  assertEquals(isValidEmail("player@example.com"), true);
  assertEquals(isValidEmail("first.last+tag@sub.example.co.uk"), true);
  assertEquals(isValidEmail("no-at-sign"), false);
  assertEquals(isValidEmail("missing@tld"), false);
  assertEquals(isValidEmail("spaces in@example.com"), false);
  assertEquals(isValidEmail(""), false);
});

Deno.test("UAE phone forms all normalize to one E.164 key", () => {
  // Every one of these is the same person; the unique index depends on it.
  const expected = "+971501234567";
  assertEquals(normalizePhone("0501234567"), expected);
  assertEquals(normalizePhone("050 123 4567"), expected);
  assertEquals(normalizePhone("+971 50 123 4567"), expected);
  assertEquals(normalizePhone("00971501234567"), expected);
  assertEquals(normalizePhone("971501234567"), expected);
  assertEquals(normalizePhone("501234567"), expected);
  assertEquals(normalizePhone("(050) 123-4567"), expected);
});

Deno.test("non-UAE numbers keep their own country code", () => {
  assertEquals(normalizePhone("+44 7700 900123"), "+447700900123");
  assertEquals(normalizePhone("+1 415 555 0132"), "+14155550132");
});

Deno.test("unusable phone input is rejected rather than guessed", () => {
  assertEquals(normalizePhone("12"), null);
  assertEquals(normalizePhone("not a phone"), null);
  assertEquals(normalizePhone(""), null);
});

Deno.test("IBAN normalization strips spacing and raises case", () => {
  assertEquals(
    normalizeIban("ae07 0331 2345 6789 0123 456"),
    "AE070331234567890123456",
  );
});

Deno.test("IBAN mod-97 check accepts valid numbers", () => {
  assertEquals(isValidIban("AE070331234567890123456"), true);
  assertEquals(isValidIban("AE07 0331 2345 6789 0123 456"), true);
  assertEquals(isValidIban("GB82 WEST 1234 5698 7654 32"), true);
});

Deno.test("IBAN check catches transposed digits", () => {
  // Same digits as a valid AE IBAN, two of them swapped.
  assertEquals(isValidIban("AE070331234567890123465"), false);
});

Deno.test("IBAN check rejects wrong length and malformed input", () => {
  assertEquals(isValidIban("AE0703312345"), false);
  assertEquals(isValidIban("AE07033123456789012345678"), false);
  assertEquals(isValidIban("1234567890"), false);
  assertEquals(isValidIban(""), false);
});

Deno.test("slugify produces URL-safe group and game slugs", () => {
  assertEquals(slugify("Dubai Sunday Smashers"), "dubai-sunday-smashers");
  assertEquals(slugify("  Al Quoz  Courts!!  "), "al-quoz-courts");
  assertEquals(slugify("Café Münchén"), "cafe-munchen");
});
