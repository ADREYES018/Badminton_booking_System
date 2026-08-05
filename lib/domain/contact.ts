/**
 * Reaching a person, given a stored phone number.
 *
 * Lives in the domain layer rather than in `email.ts`, where the WhatsApp
 * helper used to sit: an island renders these links, and importing the mail
 * module into the client bundle would drag MIME building and base64 encoding
 * along with it for the sake of one string.
 */

/**
 * WhatsApp wants digits only — no `+`, spaces or dashes.
 *
 * Everything else is dropped rather than rejected: a number stored as
 * "+971 50 123 4567" is perfectly good, and refusing to link it would punish
 * whoever typed it that way. An empty result means there was nothing usable,
 * which callers check before rendering a link to nowhere.
 */
export function whatsappNumber(phoneE164: string): string {
  return phoneE164.replace(/\D/g, "");
}

/** Deep link into a WhatsApp chat, used instead of the paid Business API. */
export function whatsappLink(phoneE164: string, message?: string): string {
  const number = whatsappNumber(phoneE164);
  return message
    ? `https://wa.me/${number}?text=${encodeURIComponent(message)}`
    : `https://wa.me/${number}`;
}
