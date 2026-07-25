// Parses AMC's server-rendered response.
//
// AMC is a Next.js app. The showtimes page ships its data as an RSC (React
// Server Components) stream embedded in the HTML, where every showtime is a JSON
// object whose quotes are backslash-escaped, e.g.:
//   \"showtimeId\":144316403,\"policyCodes\":[],\"hasTrailers\":true,
//   \"status\":\"AlmostFull\",\"showDateTimeUtc\":\"2026-07-31T13:00:00.000Z\"
// The <time datetime> attributes only exist AFTER client hydration, so we parse
// the RSC payload directly rather than the DOM.

// Strict: full object shape → id + status + UTC start time.
const STRICT =
  /\\"showtimeId\\":(\d+),\\"policyCodes\\":\[[^\]]*\],\\"hasTrailers\\":(?:true|false),\\"status\\":\\"([^\\"]+)\\",\\"showDateTimeUtc\\":\\"([^\\"]+)\\"/g;

// Loose fallback: id followed (within a small window) by its UTC start time.
// Survives minor field-order / field-set changes in AMC's payload.
const LOOSE = /\\"showtimeId\\":(\d+)[\s\S]{0,160}?\\"showDateTimeUtc\\":\\"([^\\"]+)\\"/g;

// Pattern sources so the same parsing logic can be reconstructed inside the
// browser page (single source of truth, shared by Node and page.evaluate).
export const PATTERNS = { strict: STRICT.source, loose: LOOSE.source };

/**
 * @param {string} html  raw response body for one date
 * @param {string} date  the YYYY-MM-DD the request was for
 * @returns {Array<{id,date,dt,status,movie}>} unique showtimes for that date
 */
export function parseShowtimes(html, date) {
  const byId = new Map();

  for (const m of html.matchAll(STRICT)) {
    byId.set(m[1], { id: m[1], date, status: m[2], dt: m[3], movie: null });
  }
  // Fill anything the strict pass missed.
  for (const m of html.matchAll(LOOSE)) {
    if (!byId.has(m[1])) byId.set(m[1], { id: m[1], date, status: null, dt: m[2], movie: null });
  }

  return [...byId.values()];
}

/** Extract the selectable dates from <select name="date">. */
export function parseDates(html) {
  // Options render server-side as <option value="2026-07-25">…; the first
  // ("Today") has an empty value which we skip.
  const dates = new Set();
  for (const m of html.matchAll(/value="?(\d{4}-\d{2}-\d{2})"?/g)) dates.add(m[1]);
  return [...dates].sort();
}

/** Did Cloudflare hand us a challenge/block instead of real showtimes? */
export function looksBlocked(status, html) {
  if (status === 403 || status === 429 || status === 503) return true;
  if (!html) return true;
  const challenged = /just a moment\.\.\.|cf-chl-|_cf_chl_opt|turnstile\/v0\/api\.js\?[^"]*cData/i.test(html);
  // The real page always contains this aria-label; a challenge page won't.
  const hasContent = html.includes('Showtime Group Results') || html.includes('showtimeId');
  return challenged && !hasContent;
}
