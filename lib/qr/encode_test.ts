/**
 * The encoder, pinned against known-good output.
 *
 * These fixtures were taken from an independent implementation and the
 * resulting images were confirmed to decode with a scanner nobody here wrote.
 * That matters: three separate bugs in the first draft — reversed format bit
 * order, a reversed generator polynomial, and a mistyped format coordinate
 * table — each produced a matrix that looked entirely plausible, had the right
 * finder patterns and the right size, and scanned as nothing at all.
 *
 * A test that only checked the encoder against itself would have passed on
 * all three.
 */

import { assertEquals, assertThrows } from "@std/assert";
import { encodeQr, QrError, qrSvgPath, qrViewBox } from "./encode.ts";

/**
 * The full module grid for "hello" at version 1, level M.
 *
 * Rows are top to bottom, `1` dark. Verified to decode as "hello".
 */
const HELLO_V1_M = [
  "111111101000001111111",
  "100000100101101000001",
  "101110101011101011101",
  "101110101010101011101",
  "101110101010101011101",
  "100000101001001000001",
  "111111101010101111111",
  "000000000010000000000",
  "001111110011001111100",
  "111010010011111001101",
  "011010100000101101110",
  "000011010001111001100",
  "010100111100100100001",
  "000000001110100101001",
  "111111100101010010110",
  "100000101010000111110",
  "101110101101010010010",
  "101110101101111101000",
  "101110101000101100100",
  "100000100101111011100",
  "111111101000100010010",
];

function render(payload: string): string[] {
  return encodeQr(payload).map((row) =>
    row.map((v) => (v ? "1" : "0")).join("")
  );
}

Deno.test("a known payload encodes to its known matrix", () => {
  assertEquals(render("hello"), HELLO_V1_M);
});

Deno.test("the version grows with the payload, and only as far as it must", () => {
  // Version 1 is 21 modules, and each version adds four.
  assertEquals(encodeQr("a").length, 21);

  // A check-in token is about sixty characters, which needs version 4.
  const token = "01KZ37G23W.01KZ37G23X.5566778.abcdef0123456789";
  assertEquals(encodeQr(token).length, 33);
});

Deno.test("a payload too long for this encoder is refused, not truncated", () => {
  // Silently emitting a matrix that scans as a prefix would be worse than
  // failing: the token would verify as someone else's, or not at all.
  assertThrows(() => encodeQr("x".repeat(200)), QrError, "too long");
});

Deno.test("non-ASCII is refused rather than mangled", () => {
  assertThrows(() => encodeQr("café"), QrError, "ASCII");
});

Deno.test("every matrix carries its three finder patterns", () => {
  const matrix = encodeQr("hello");
  const n = matrix.length;

  for (const [top, left] of [[0, 0], [0, n - 7], [n - 7, 0]]) {
    // The finder is a dark 7x7 ring with a dark 3x3 core.
    assertEquals(matrix[top!]![left!], true, `corner ${top},${left} ring`);
    assertEquals(matrix[top! + 1]![left! + 1], false, "inner light ring");
    assertEquals(matrix[top! + 3]![left! + 3], true, "core");
  }
});

Deno.test("the SVG path covers exactly the dark modules", () => {
  const matrix = encodeQr("hello");
  const dark = matrix.flat().filter(Boolean).length;

  // One "M…z" subpath per dark module.
  assertEquals(qrSvgPath(matrix).split("z").length - 1, dark);
});

Deno.test("the view box leaves a quiet zone on every side", () => {
  const matrix = encodeQr("hello");
  // Four modules of margin each side of a 21-module grid.
  assertEquals(qrViewBox(matrix), "-4 -4 29 29");
});
