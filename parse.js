// Parses AMC's server-rendered response.
//
// AMC is a Next.js app. The showtimes page ships its data as an RSC (React
// Server Components) stream embedded in the HTML, where quotes are
// backslash-escaped. Two things we pull out:
//   • the movie table:  \"name\":\"Moana\",\"slug\":\"moana-72474\",\"movieId\":72474
//   • each showtime:     \"showtimeId\":N ... \"status\":\"..\" ..
//                        \"showDateTimeUtc\":\"ISO\" ... aria-describedby\":\"<slug> ..
// Each showtime's aria-describedby starts with its movie slug, so we map
// showtime → movie title. (The <time datetime> tags only exist post-hydration,
// so we parse the RSC, not the DOM.)

// showtimeId + status + UTC start time + the movie slug that follows it.
const COMBINED =
  /\\"showtimeId\\":(\d+)[\s\S]{0,200}?\\"status\\":\\"([^\\"]+)\\",\\"showDateTimeUtc\\":\\"([^\\"]+)\\"[\s\S]{0,400}?aria-describedby\\":\\"([a-z0-9-]+?-\d+)/g;

// The movie table entries: slug → human title.
const MOVIE_MAP = /\\"name\\":\\"([^\\"]+)\\",\\"slug\\":\\"([^\\"]+)\\",\\"movieId\\":\d+/g;

// Loose fallback: id + nearest UTC time (survives payload shape changes; no movie).
const LOOSE = /\\"showtimeId\\":(\d+)[\s\S]{0,160}?\\"showDateTimeUtc\\":\\"([^\\"]+)\\"/g;

// Pattern sources so the exact same logic runs inside the browser page.
export const PATTERNS = { combined: COMBINED.source, movieMap: MOVIE_MAP.source, loose: LOOSE.source };

// Decode RSC-escaped unicode (& → &) and stray escapes in a title.
export function decodeTitle(s) {
  try {
    return JSON.parse(`"${s.replace(/"/g, '\\"')}"`);
  } catch {
    return s.replace(/\\u0026/g, '&');
  }
}

// slug → readable title as a last resort: "toy-story-5-72482" → "Toy Story 5".
export function deslug(s) {
  return s
    .replace(/-\d+$/, '')
    .split('-')
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');
}

/**
 * @param {string} html raw response body for one date
 * @param {string} date the YYYY-MM-DD requested
 * @returns {Array<{id,date,dt,status,movie}>}
 */
export function parseShowtimes(html, date) {
  const slugToName = {};
  for (const m of html.matchAll(new RegExp(PATTERNS.movieMap, 'g'))) slugToName[m[2]] = decodeTitle(m[1]);

  const byId = new Map();
  for (const m of html.matchAll(new RegExp(PATTERNS.combined, 'g'))) {
    const slug = m[4];
    byId.set(m[1], { id: m[1], date, status: m[2], dt: m[3], movie: slugToName[slug] || deslug(slug) });
  }
  for (const m of html.matchAll(new RegExp(PATTERNS.loose, 'g'))) {
    if (!byId.has(m[1])) byId.set(m[1], { id: m[1], date, status: null, dt: m[2], movie: null });
  }
  return [...byId.values()];
}

/** Extract selectable dates from <select name="date">. */
export function parseDates(html) {
  const dates = new Set();
  for (const m of html.matchAll(/value="?(\d{4}-\d{2}-\d{2})"?/g)) dates.add(m[1]);
  return [...dates].sort();
}

/** Did Cloudflare hand us a challenge/block instead of showtimes? */
export function looksBlocked(status, html) {
  if (status === 403 || status === 429 || status === 503) return true;
  if (!html) return true;
  const challenged = /just a moment\.\.\.|cf-chl-|_cf_chl_opt|attention required/i.test(html);
  const hasContent = html.includes('Showtime Group Results') || html.includes('showtimeId');
  return challenged && !hasContent;
}
