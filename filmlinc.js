// Film at Lincoln Center showtimes, from their public JSON API.
//
// Unlike AMC, FLC exposes ONE endpoint that returns every film × showtime ×
// date (~11 months out) in a single call — no browser, no proxy, no Cloudflare
// challenge, no per-date loop. We just fetch, flatten, and normalize into the
// same row shape the shared db/notify code expects.

const API = 'https://api.filmlinc.org/showtimes';

const VENUE_SHORT = {
  'Walter Reade Theater': 'Walter Reade',
  'Francesca Beale Theater': 'Francesca Beale',
  'Howard Gilman Theater': 'Howard Gilman',
  'Pass Venue': 'Pass',
};

/** Fetch + normalize all FLC showtimes → [{id,date,dt,movie,format,status,url}]. */
export async function fetchFilmlincRows() {
  const res = await fetch(API, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`filmlinc api ${res.status}`);
  const data = await res.json();

  const rows = [];
  for (const film of data.films || []) {
    for (const s of film.showtimes || []) {
      // "format" groups the alert: venue + any notable attribute tags.
      const venue = VENUE_SHORT[s.venue] || s.venue || '';
      const tags = [];
      if (s.openCaptions) tags.push('Open Captions');
      if (s.specialEvent) tags.push('Special Event');
      if (s.freeEvent) tags.push('Free');
      const format = venue + (tags.length ? ` (${tags.join(', ')})` : '');

      rows.push({
        id: String(s.id),
        date: s.date, // YYYY-MM-DD
        // Normalize to UTC ISO so sorting is correct across DST; rendered in ET.
        dt: s.dateTimeET ? new Date(s.dateTimeET).toISOString() : null,
        movie: film.title,
        venue: venue || 'Film at Lincoln Center',
        format,
        status: s.status || null,
        url: s.ticketsUrl || `https://www.filmlinc.org/films/${film.slug}/`,
      });
    }
  }
  return rows;
}
