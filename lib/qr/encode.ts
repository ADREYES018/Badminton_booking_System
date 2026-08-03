/**
 * A QR encoder for short ASCII payloads.
 *
 * Scoped deliberately: byte mode, error correction level M, versions 1–6.
 * That covers check-in tokens (about sixty characters) with room to spare and
 * nothing else. A general-purpose library would be several hundred kilobytes
 * shipped into a PWA that otherwise sends one small island; this is a few
 * hundred lines that do one job.
 *
 * The scope limit is enforced rather than assumed — `encodeQr` throws on a
 * payload it cannot hold, instead of emitting a matrix that scans as garbage.
 *
 * Reference: ISO/IEC 18004. The tables below are the standard's, transcribed.
 */

export class QrError extends Error {}

/** Data codeword capacity at error correction level M, versions 1–6. */
const DATA_CODEWORDS_M = [16, 28, 44, 64, 86, 108];

/** Error correction codewords per block, level M, versions 1–6. */
const EC_CODEWORDS_PER_BLOCK_M = [10, 16, 26, 18, 24, 16];

/** Number of error correction blocks, level M, versions 1–6. */
const EC_BLOCKS_M = [1, 1, 1, 2, 2, 4];

/** Row/column coordinates of alignment pattern centres, by version. */
const ALIGNMENT_CENTRES: number[][] = [
  [],
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
];

// ---- Galois field arithmetic (GF(256), primitive polynomial 0x11d) --------

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);

{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]!;
}

function gfMultiply(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a]! + LOG[b]!]!;
}

/**
 * The generator polynomial for `degree` error correction codewords.
 *
 * Coefficients run highest power first, so `poly[0]` is always 1 and the
 * divisor lines up with the remainder loop below. The two have to agree about
 * that ordering: reversed, the arithmetic still runs and still produces
 * plausible bytes, which is precisely why it needs a fixture test rather than
 * a glance.
 */
function generatorPolynomial(degree: number): Uint8Array {
  let poly = Uint8Array.from([1]);

  for (let i = 0; i < degree; i++) {
    // Multiply by (x - a^i).
    const next = new Uint8Array(poly.length + 1);
    for (let j = 0; j < poly.length; j++) {
      next[j] = next[j]! ^ poly[j]!;
      next[j + 1] = next[j + 1]! ^ gfMultiply(poly[j]!, EXP[i]!);
    }
    poly = next;
  }

  return poly;
}

/** Reed–Solomon remainder for one block. */
function errorCorrection(data: Uint8Array, ecCount: number): Uint8Array {
  const generator = generatorPolynomial(ecCount);
  const remainder = new Uint8Array(ecCount);

  for (const byte of data) {
    const factor = byte ^ remainder[0]!;
    remainder.copyWithin(0, 1);
    remainder[ecCount - 1] = 0;

    for (let i = 0; i < ecCount; i++) {
      remainder[i] = remainder[i]! ^ gfMultiply(generator[i + 1]!, factor);
    }
  }

  return remainder;
}

// ---- Bit stream -----------------------------------------------------------

class BitBuffer {
  private bits: number[] = [];

  push(value: number, length: number): void {
    for (let i = length - 1; i >= 0; i--) {
      this.bits.push((value >>> i) & 1);
    }
  }

  get length(): number {
    return this.bits.length;
  }

  /** Pads to a byte boundary and returns the codewords. */
  toCodewords(capacity: number): Uint8Array {
    // Terminator: up to four zero bits, truncated if the capacity is tight.
    const terminator = Math.min(4, capacity * 8 - this.bits.length);
    this.push(0, terminator);
    while (this.bits.length % 8 !== 0) this.bits.push(0);

    const bytes = new Uint8Array(capacity);
    for (let i = 0; i < this.bits.length; i += 8) {
      let byte = 0;
      for (let j = 0; j < 8; j++) byte = (byte << 1) | this.bits[i + j]!;
      bytes[i / 8] = byte;
    }

    // Alternating pad bytes, per the standard.
    const pads = [0xec, 0x11];
    for (let i = this.bits.length / 8, p = 0; i < capacity; i++, p++) {
      bytes[i] = pads[p % 2]!;
    }

    return bytes;
  }
}

// ---- Matrix ---------------------------------------------------------------

/** -1 is unset, 0 light, 1 dark. Function patterns are marked reserved. */
interface Canvas {
  size: number;
  modules: Int8Array;
  reserved: Uint8Array;
}

function createCanvas(version: number): Canvas {
  const size = version * 4 + 17;
  return {
    size,
    modules: new Int8Array(size * size).fill(-1),
    reserved: new Uint8Array(size * size),
  };
}

function set(
  canvas: Canvas,
  row: number,
  col: number,
  dark: boolean,
  reserve = true,
): void {
  const index = row * canvas.size + col;
  canvas.modules[index] = dark ? 1 : 0;
  if (reserve) canvas.reserved[index] = 1;
}

function placeFinder(canvas: Canvas, row: number, col: number): void {
  for (let r = -1; r <= 7; r++) {
    for (let c = -1; c <= 7; c++) {
      const rr = row + r;
      const cc = col + c;
      if (rr < 0 || rr >= canvas.size || cc < 0 || cc >= canvas.size) continue;

      const inRing = (r >= 0 && r <= 6 && (c === 0 || c === 6)) ||
        (c >= 0 && c <= 6 && (r === 0 || r === 6));
      const inCore = r >= 2 && r <= 4 && c >= 2 && c <= 4;
      set(canvas, rr, cc, inRing || inCore);
    }
  }
}

function placeAlignment(canvas: Canvas, version: number): void {
  const centres = ALIGNMENT_CENTRES[version] ?? [];

  for (const row of centres) {
    for (const col of centres) {
      // The three finder corners already own these positions.
      const nearFinder = (row === 6 && col === 6) ||
        (row === 6 && col === canvas.size - 7) ||
        (row === canvas.size - 7 && col === 6);
      if (nearFinder) continue;

      for (let r = -2; r <= 2; r++) {
        for (let c = -2; c <= 2; c++) {
          const ring = Math.max(Math.abs(r), Math.abs(c));
          set(canvas, row + r, col + c, ring !== 1);
        }
      }
    }
  }
}

function placeTiming(canvas: Canvas): void {
  for (let i = 8; i < canvas.size - 8; i++) {
    const dark = i % 2 === 0;
    set(canvas, 6, i, dark);
    set(canvas, i, 6, dark);
  }
}

/** Reserves the format information area, filled in after masking. */
function reserveFormat(canvas: Canvas): void {
  for (let i = 0; i < 9; i++) {
    if (i !== 6) set(canvas, 8, i, false);
    if (i !== 6) set(canvas, i, 8, false);
  }
  for (let i = 0; i < 8; i++) {
    set(canvas, 8, canvas.size - 1 - i, false);
    set(canvas, canvas.size - 1 - i, 8, false);
  }
  // The single always-dark module.
  set(canvas, canvas.size - 8, 8, true);
}

/** Walks the zig-zag data path, skipping reserved modules. */
function placeData(canvas: Canvas, codewords: Uint8Array): void {
  let bitIndex = 0;
  let upward = true;

  for (let right = canvas.size - 1; right >= 1; right -= 2) {
    // Column 6 is the vertical timing pattern and is not part of the path.
    if (right === 6) right = 5;

    for (let step = 0; step < canvas.size; step++) {
      const row = upward ? canvas.size - 1 - step : step;

      for (const col of [right, right - 1]) {
        const index = row * canvas.size + col;
        if (canvas.reserved[index]) continue;

        const byte = codewords[bitIndex >> 3] ?? 0;
        const bit = (byte >>> (7 - (bitIndex & 7))) & 1;
        canvas.modules[index] = bit;
        bitIndex++;
      }
    }

    upward = !upward;
  }
}

const MASKS: Array<(row: number, col: number) => boolean> = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

function applyMask(canvas: Canvas, mask: number): void {
  const test = MASKS[mask]!;
  for (let row = 0; row < canvas.size; row++) {
    for (let col = 0; col < canvas.size; col++) {
      const index = row * canvas.size + col;
      if (canvas.reserved[index]) continue;
      if (test(row, col)) canvas.modules[index] = canvas.modules[index]! ^ 1;
    }
  }
}

/** Format bits: level M (0b00) and the mask, BCH-coded and XOR-masked. */
function formatBits(mask: number): number {
  const data = (0b00 << 3) | mask;
  let bch = data << 10;

  for (let i = 4; i >= 0; i--) {
    if (bch & (1 << (i + 10))) bch ^= 0b10100110111 << i;
  }

  return ((data << 10) | bch) ^ 0b101010000010010;
}

/**
 * Writes both copies of the format information.
 *
 * The coordinates are listed rather than derived. The standard's layout skips
 * the timing row and column at irregular points, and every attempt to express
 * that as arithmetic here produced a matrix that looked right and did not
 * scan — the bit values were correct while two of the fifteen positions were
 * not. A table is checkable against the specification line by line.
 *
 * Index is the bit number, **most significant first** — bit 14 of the format
 * value lands at the first coordinate. Getting this backwards produces a
 * matrix whose format area is a valid-looking mirror of the right answer and
 * which no scanner will read.
 */
function placeFormat(canvas: Canvas, mask: number): void {
  const bits = formatBits(mask);
  const n = canvas.size;

  const aroundTopLeft: Array<[number, number]> = [
    [0, 8],
    [1, 8],
    [2, 8],
    [3, 8],
    [4, 8],
    [5, 8],
    [7, 8],
    [8, 8],
    [8, 7],
    [8, 5],
    [8, 4],
    [8, 3],
    [8, 2],
    [8, 1],
    [8, 0],
  ];

  const splitCopy: Array<[number, number]> = [
    [n - 1, 8],
    [n - 2, 8],
    [n - 3, 8],
    [n - 4, 8],
    [n - 5, 8],
    [n - 6, 8],
    [n - 7, 8],
    [8, n - 8],
    [8, n - 7],
    [8, n - 6],
    [8, n - 5],
    [8, n - 4],
    [8, n - 3],
    [8, n - 2],
    [8, n - 1],
  ];

  for (let i = 0; i < 15; i++) {
    const dark = ((bits >>> (14 - i)) & 1) === 1;
    const [r1, c1] = aroundTopLeft[i]!;
    const [r2, c2] = splitCopy[i]!;
    set(canvas, r1, c1, dark);
    set(canvas, r2, c2, dark);
  }
}

/**
 * Penalty score for one masked matrix, per the standard's four rules.
 *
 * The mask with the lowest score is chosen. Scoring badly here does not break
 * a scan outright, but it is what keeps large same-colour regions and
 * finder-lookalike runs out of the data area.
 */
function penalty(canvas: Canvas): number {
  const { size, modules } = canvas;
  const at = (r: number, c: number) => modules[r * size + c]!;
  let score = 0;

  // Rule 1: runs of five or more identical modules in a row or column.
  for (let i = 0; i < size; i++) {
    for (const horizontal of [true, false]) {
      let run = 1;
      for (let j = 1; j < size; j++) {
        const current = horizontal ? at(i, j) : at(j, i);
        const previous = horizontal ? at(i, j - 1) : at(j - 1, i);
        if (current === previous) {
          run++;
        } else {
          if (run >= 5) score += 3 + (run - 5);
          run = 1;
        }
      }
      if (run >= 5) score += 3 + (run - 5);
    }
  }

  // Rule 2: 2x2 blocks of one colour.
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = at(r, c);
      if (v === at(r, c + 1) && v === at(r + 1, c) && v === at(r + 1, c + 1)) {
        score += 3;
      }
    }
  }

  // Rule 3: finder-like 1:1:3:1:1 patterns with four light modules beside.
  const pattern = [1, 0, 1, 1, 1, 0, 1];
  const matches = (get: (k: number) => number, start: number): boolean => {
    for (let k = 0; k < 7; k++) if (get(start + k) !== pattern[k]) return false;
    return true;
  };

  for (let i = 0; i < size; i++) {
    for (let j = 0; j + 7 <= size; j++) {
      for (const horizontal of [true, false]) {
        const get = (k: number) => horizontal ? at(i, k) : at(k, i);
        if (!matches(get, j)) continue;

        const before = j - 4 >= 0 &&
          [1, 2, 3, 4].every((k) => get(j - k) === 0);
        const after = j + 10 <= size &&
          [7, 8, 9, 10].every((k) => get(j + k) === 0);
        if (before || after) score += 40;
      }
    }
  }

  // Rule 4: deviation from an even split of dark and light.
  let dark = 0;
  for (const value of modules) if (value === 1) dark++;
  const percent = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(percent - 50) / 5) * 10;

  return score;
}

/** The smallest version at level M that holds this many bytes. */
function versionFor(byteLength: number): number {
  for (let version = 1; version <= 6; version++) {
    // Mode indicator (4 bits) + length field + payload, in codewords.
    const lengthBits = 8;
    const needed = Math.ceil((4 + lengthBits + byteLength * 8) / 8);
    if (needed <= DATA_CODEWORDS_M[version - 1]!) return version;
  }

  throw new QrError(
    `Payload of ${byteLength} bytes is too long for this encoder`,
  );
}

/** Interleaves data and error correction blocks, per the standard. */
function interleave(data: Uint8Array, version: number): Uint8Array {
  const blockCount = EC_BLOCKS_M[version - 1]!;
  const ecPerBlock = EC_CODEWORDS_PER_BLOCK_M[version - 1]!;

  const shortLength = Math.floor(data.length / blockCount);
  const longCount = data.length % blockCount;

  const dataBlocks: Uint8Array[] = [];
  const ecBlocks: Uint8Array[] = [];

  let offset = 0;
  for (let i = 0; i < blockCount; i++) {
    const length = shortLength + (i >= blockCount - longCount ? 1 : 0);
    const block = data.subarray(offset, offset + length);
    offset += length;

    dataBlocks.push(block);
    ecBlocks.push(errorCorrection(block, ecPerBlock));
  }

  const out: number[] = [];
  const longest = Math.max(...dataBlocks.map((b) => b.length));

  for (let i = 0; i < longest; i++) {
    for (const block of dataBlocks) {
      if (i < block.length) out.push(block[i]!);
    }
  }
  for (let i = 0; i < ecPerBlock; i++) {
    for (const block of ecBlocks) out.push(block[i]!);
  }

  return Uint8Array.from(out);
}

/**
 * Encodes an ASCII payload as a QR matrix.
 *
 * Returns row-major booleans, dark as `true`. The caller decides how to draw
 * it — this module has no opinion about pixels.
 */
export function encodeQr(payload: string): boolean[][] {
  const bytes = new TextEncoder().encode(payload);
  if (bytes.length !== payload.length) {
    throw new QrError("This encoder handles ASCII payloads only");
  }

  const version = versionFor(bytes.length);
  const capacity = DATA_CODEWORDS_M[version - 1]!;

  const buffer = new BitBuffer();
  buffer.push(0b0100, 4); // Byte mode.
  buffer.push(bytes.length, 8); // Length field, versions 1–9.
  for (const byte of bytes) buffer.push(byte, 8);

  const codewords = interleave(buffer.toCodewords(capacity), version);

  // Every mask is built and scored; the best is kept. Building eight small
  // matrices costs nothing at this size and removes a judgement call.
  let best: Canvas | null = null;
  let bestScore = Infinity;

  for (let mask = 0; mask < 8; mask++) {
    const canvas = createCanvas(version);
    placeFinder(canvas, 0, 0);
    placeFinder(canvas, 0, canvas.size - 7);
    placeFinder(canvas, canvas.size - 7, 0);
    placeAlignment(canvas, version);
    placeTiming(canvas);
    reserveFormat(canvas);
    placeData(canvas, codewords);
    applyMask(canvas, mask);
    placeFormat(canvas, mask);

    const score = penalty(canvas);
    if (score < bestScore) {
      bestScore = score;
      best = canvas;
    }
  }

  const canvas = best!;
  const matrix: boolean[][] = [];
  for (let row = 0; row < canvas.size; row++) {
    const line: boolean[] = [];
    for (let col = 0; col < canvas.size; col++) {
      line.push(canvas.modules[row * canvas.size + col] === 1);
    }
    matrix.push(line);
  }

  return matrix;
}

/**
 * Renders a matrix as an SVG path.
 *
 * One path rather than one rect per module: a version-4 code is 33x33, and a
 * thousand elements is a needless amount of DOM for something that never
 * changes. The quiet zone is included because scanners need it.
 */
export function qrSvgPath(matrix: boolean[][]): string {
  const parts: string[] = [];

  for (let row = 0; row < matrix.length; row++) {
    for (let col = 0; col < matrix[row]!.length; col++) {
      if (matrix[row]![col]) parts.push(`M${col} ${row}h1v1h-1z`);
    }
  }

  return parts.join("");
}

/** The side length in modules, quiet zone included. */
export const QUIET_ZONE = 4;

export function qrViewBox(matrix: boolean[][]): string {
  const size = matrix.length + QUIET_ZONE * 2;
  return `${-QUIET_ZONE} ${-QUIET_ZONE} ${size} ${size}`;
}
