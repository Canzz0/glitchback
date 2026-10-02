/**
 * Turns a concrete path into a route pattern when the widget was not given
 * `getRoute`: "/products/8421/reviews" → "/products/:id/reviews".
 *
 * Only segments that are clearly identifiers are replaced. Human-readable
 * slugs without a numeric tail ("/blog/my-first-post") cannot be told apart
 * from fixed paths, so they are kept; pass `getRoute` for those pages.
 */
const ID_PATTERNS: RegExp[] = [
  /^\d+$/, // 8421
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, // UUID
  /^(?=[0-9a-f]*\d)[0-9a-f]{8,}$/i, // hashes, Mongo ObjectId
  /^(?=\w*\d)(?=\w*[a-z])\w{16,}$/i, // cuid / nanoid style tokens (a hyphenated slug is not an id)
];
/** "red-sneakers-p-12345", "urun-adi-98765" → slug that ends in a numeric id. */
const SLUG_WITH_ID = /^[\p{L}\d]+(?:-[\p{L}\d]+)*-\d{3,}$/u;

export function normaliseRoute(pathname: string): string {
  const segments = pathname.split("/").map((seg) => {
    if (!seg) return seg;
    let decoded = seg;
    try {
      decoded = decodeURIComponent(seg);
    } catch {}
    if (SLUG_WITH_ID.test(decoded)) return ":slug";
    if (ID_PATTERNS.some((re) => re.test(decoded))) return ":id";
    return seg;
  });
  const out = segments.join("/");
  return out.length > 1 ? out.replace(/\/+$/, "") : out || "/";
}

/**
 * The widget falls back to location.pathname when the app has no getRoute.
 * A route equal to the page's pathname is therefore treated as "not given"
 * and normalised; a real pattern from getRoute ("/products/:id") is kept.
 */
export function deriveRoute(url: string, route: string | undefined): string {
  let pathname = "/";
  try {
    pathname = new URL(url, "http://x.invalid").pathname;
  } catch {}
  if (route && route !== pathname) return route;
  return normaliseRoute(route ?? pathname);
}
