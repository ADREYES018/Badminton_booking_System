import { assertEquals, assertStringIncludes } from "@std/assert";
import { mapsUrl } from "./venue.ts";

Deno.test("coordinates are preferred over the typed address", () => {
  const url = mapsUrl({
    name: "Al Quoz Courts",
    address: "Street 4, Al Quoz",
    lat: 25.1412,
    lng: 55.2312,
  });

  assertEquals(url, "https://maps.google.com/?q=25.1412%2C55.2312");
});

Deno.test("without coordinates the name and address are searched together", () => {
  // The name alone finds the wrong branch of a chain; the address alone can be
  // a whole street.
  const url = mapsUrl({ name: "Al Quoz Courts", address: "Street 4, Al Quoz" });

  assertStringIncludes(url, encodeURIComponent("Al Quoz Courts, Street 4"));
});

Deno.test("a venue with no address still produces a usable search", () => {
  const url = mapsUrl({ name: "Al Quoz Courts", address: "" });
  assertEquals(url, "https://maps.google.com/?q=Al%20Quoz%20Courts");
});

Deno.test("an address that would break a URL is escaped", () => {
  // Ampersands and hashes in a typed address must not be read as query
  // structure — a venue called "Courts #3 & 4" would otherwise truncate.
  const url = mapsUrl({ name: "Courts #3 & 4", address: "Dubai" });
  assertStringIncludes(url, "%23");
  assertStringIncludes(url, "%26");
  assertEquals(url.includes("&"), false);
  assertEquals(url.includes("#"), false);
});
