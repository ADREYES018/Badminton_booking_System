/**
 * Getting a player to the court.
 *
 * The address is stored as free text an organizer typed, which is what a
 * person reads but not something a map can be trusted to resolve — "Test
 * Courts, Al Quoz" finds the right building; "the usual place" finds nothing.
 * Coordinates, when an organizer supplied them, are unambiguous, so they win.
 */

import type { Venue } from "../types.ts";

/**
 * A Google Maps link for a venue.
 *
 * Uses the documented `maps.google.com/?q=` form, which works in a browser and
 * hands off to the Maps app on both phone platforms — a platform-specific
 * scheme would strand whichever half of the club is on the other one.
 *
 * Coordinates are preferred over the address because a search string is a
 * guess: it can land on a similarly named place in another city, and a player
 * following it would end up confidently in the wrong car park.
 */
export function mapsUrl(venue: Venue): string {
  const query = venue.lat !== undefined && venue.lng !== undefined
    ? `${venue.lat},${venue.lng}`
    : [venue.name, venue.address].filter(Boolean).join(", ");

  return `https://maps.google.com/?q=${encodeURIComponent(query)}`;
}
