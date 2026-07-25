// Lincoln Center calendar monitor.
//
// The calendar is server-rendered and browser-free: each month is available at
//   GET /ajaxCalendar/{Month YYYY}   (e.g. "/ajaxCalendar/September 2026")
// returning JSON whose model embeds the month's calendar HTML. We fetch the next
// N months, parse the events out of each day block, and normalize to rows.
//
// "New showtime" = a new (event, date) — keyed by link + date.

const BASE = 'https://www.lincolncenter.org';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const MONTH_NUM = Object.fromEntries(MONTH_NAMES.map((m, i) => [m, i + 1]));

/** "Sunday, August 30, 2026" → "2026-08-30" (no tz math — parse the string). */
function toISODate(s) {
  const m = s.match(/([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})/);
  if (!m) return null;
  const mo = MONTH_NUM[m[1]];
  if (!mo) return null;
  return `${m[3]}-${String(mo).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}`;
}

/** Upcoming month labels: current + next (count-1), e.g. ["July 2026", ...]. */
function upcomingMonths(count, now = new Date()) {
  const out = [];
  let y = now.getUTCFullYear();
  let mo = now.getUTCMonth(); // 0-based
  for (let i = 0; i < count; i++) {
    out.push(`${MONTH_NAMES[mo]} ${y}`);
    if (++mo > 11) { mo = 0; y++; }
  }
  return out;
}

/** Pull the calendar HTML out of an /ajaxCalendar JSON response (or raw text). */
function extractHtml(raw) {
  try {
    const j = JSON.parse(raw);
    const find = (o, d = 0) => {
      if (d > 7 || o == null) return null;
      if (typeof o === 'string') return o.includes('cal-day-show') ? o : null;
      if (typeof o === 'object') for (const k of Object.keys(o)) { const r = find(o[k], d + 1); if (r) return r; }
      return null;
    };
    const h = find(j);
    if (h) return h;
  } catch {}
  // fallback: unescape embedded HTML in the raw text
  return raw.replace(/\\"/g, '"').replace(/\\\//g, '/');
}

const strip = (s) => s.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&#\d+;/g, '').replace(/\s+/g, ' ').trim();

/** Parse events from one month's calendar HTML → [{date,title,org,time,link}]. */
function parseMonth(html) {
  const rows = [];
  // Split into per-day segments by the data-date marker.
  const dayRe = /data-date="([^"]+)"([\s\S]*?)(?=data-date="|$)/g;
  let d;
  while ((d = dayRe.exec(html))) {
    const isoDate = toISODate(d[1]);
    if (!isoDate) continue;
    const seg = d[2];
    // Each event is a cal-day-show block.
    for (const block of seg.split('cal-day-show-border-cont').slice(1)) {
      const link = (block.match(/<a\s+href=["']([^"']+)["']/) || [])[1];
      const title = (block.match(/class="show-name">([^<]+)</) || [])[1];
      if (!link || !title) continue;
      const org = strip((block.match(/show-org[\s\S]*?<a[^>]*>([^<]+)</) || [])[1] || '');
      // NB: anchor to the exact span — "show-time" is also a prefix of "show-time-price".
      const time = strip((block.match(/class="show-time">([^<]*)</) || [])[1] || '');
      rows.push({ date: isoDate, title: strip(title), org, time, link: link.startsWith('http') ? link : BASE + link });
    }
  }
  return rows;
}

/**
 * Fetch the next `months` months and return de-duplicated event rows.
 * @returns {Array<{id,date,dt,movie,format,status,url,time}>}
 */
export async function fetchLincolnCenterRows({ months = 6 } = {}, log = console.log) {
  const labels = upcomingMonths(months);
  const todayISO = new Date().toISOString().slice(0, 10); // skip past dates
  const byId = new Map();
  for (const label of labels) {
    let raw;
    try {
      const res = await fetch(`${BASE}/ajaxCalendar/${encodeURIComponent(label)}`, {
        headers: { 'User-Agent': UA, Accept: 'application/json, text/html' },
      });
      if (!res.ok) { log(`[lc] ${label}: HTTP ${res.status}`); continue; }
      raw = await res.text();
    } catch (e) { log(`[lc] ${label}: ${e.message}`); continue; }

    const events = parseMonth(extractHtml(raw));
    for (const e of events) {
      if (e.date < todayISO) continue; // upcoming only
      // Include the time so multiple showtimes on the same day aren't collapsed.
      const id = `${e.date}|${e.time}|${e.link}`;
      if (byId.has(id)) continue;
      // Pre-formatted time label ("2:00pm") or a bucket ("Multiple Times"/"All Day").
      const timeLabel = /^\d/.test(e.time) ? e.time.replace(/\s+/g, '').toLowerCase() : e.time || 'Multiple Times';
      const org = e.org || 'Lincoln Center';
      byId.set(id, {
        id,
        date: e.date,
        dt: `${e.date}T12:00:00Z`, // noon UTC → correct ET date in the shared formatter
        movie: e.title,
        venue: org, // LC's cleanest venue signal is the presenting org
        format: org,
        timeLabel, // shared formatter shows this instead of deriving from dt
        status: null,
        url: e.link,
      });
    }
    log(`[lc] ${label}: ${events.length} events`);
  }
  return [...byId.values()];
}
