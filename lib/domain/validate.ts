/**
 * Input normalization and validation.
 *
 * Normalization matters as much as validation here: the unique indexes for
 * email and phone are only unique if every write normalizes the same way.
 */

const UAE_DIALING_CODE = "971";

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Deliberately permissive — deliverability is proven by the magic link. */
export function isValidEmail(email: string): boolean {
  const trimmed = email.trim();
  if (trimmed.length < 3 || trimmed.length > 254) return false;
  return /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(trimmed);
}

/**
 * Converts UAE-style input to E.164. Accepts "050 123 4567", "+971501234567",
 * "00971501234567" and "501234567", all of which must map to one key.
 * Returns null when the number cannot be interpreted.
 */
export function normalizePhone(input: string): string | null {
  let digits = input.replace(/[^\d+]/g, "");

  if (digits.startsWith("00")) digits = `+${digits.slice(2)}`;

  if (digits.startsWith("+")) {
    const rest = digits.slice(1);
    if (!/^\d{7,15}$/.test(rest)) return null;
    return `+${rest}`;
  }

  // Local UAE forms: leading zero, or a bare nine-digit mobile number.
  if (digits.startsWith("0")) {
    const rest = digits.slice(1);
    if (!/^\d{8,10}$/.test(rest)) return null;
    return `+${UAE_DIALING_CODE}${rest}`;
  }

  if (digits.startsWith(UAE_DIALING_CODE)) {
    if (!/^\d{7,15}$/.test(digits)) return null;
    return `+${digits}`;
  }

  if (/^\d{8,10}$/.test(digits)) return `+${UAE_DIALING_CODE}${digits}`;

  return null;
}

/** Strips formatting for storage and comparison. */
export function normalizeIban(iban: string): string {
  return iban.replace(/\s+/g, "").toUpperCase();
}

/**
 * Validates an IBAN with the ISO 13616 mod-97 checksum. Catches transposed
 * digits, which a length check alone would miss — and a wrong refund IBAN
 * means money going to a stranger.
 */
export function isValidIban(iban: string): boolean {
  const value = normalizeIban(iban);
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(value)) return false;

  // UAE IBANs are exactly 23 characters.
  if (value.startsWith("AE") && value.length !== 23) return false;

  // Move the first four characters to the end, then letters become numbers.
  const rearranged = value.slice(4) + value.slice(0, 4);
  const numeric = rearranged.replace(
    /[A-Z]/g,
    (ch) => String(ch.charCodeAt(0) - 55),
  );

  // Chunked modulo, because the full number overflows a JS integer.
  let remainder = 0;
  for (const digit of numeric) {
    remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}

export function formatIbanGroups(iban: string): string {
  return normalizeIban(iban).replace(/(.{4})/g, "$1 ").trim();
}

export interface FieldErrors {
  [field: string]: string;
}

export function isBlank(value: string | undefined | null): boolean {
  return value === undefined || value === null || value.trim().length === 0;
}

/** Trims and caps a free-text field, so KV values stay predictable. */
export function cleanText(value: string, maxLength: number): string {
  return value.trim().slice(0, maxLength);
}

/** URL-safe slug from a display name, for group and game URLs. */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}
