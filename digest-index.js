#!/usr/bin/env node
// Daily digest: send ALL showtimes for a single day, sorted venue → show → time.
//   DIGEST_MODE=today     → today's showtimes    (run at ~9 AM ET)
//   DIGEST_MODE=tomorrow  → tomorrow's showtimes (run at ~9 PM ET)
// Aggregates across AMC / FLC / TDF / Lincoln Center. Sends via ntfy; also logs
// the digest to a dated file for the record.

import { readFile, writeFile } from 'node:fs/promises';
import { config } from './config.js';
import { makeNotifier } from './notify.js';
import { fetchDayRows } from './digest.js';

const log = (...a) => console.log(new Date().toISOString(), ...a);
const MODE = (process.env.DIGEST_MODE || 'today').toLowerCase();
const ET = 'America/New_York';

// ET calendar date, offset days from now.
function etDate(offset) {
  const et = new Date(new Date().toLocaleString('en-US', { timeZone: ET }));
  et.setDate(et.getDate() + offset);
  return `${et.getFullYear()}-${String(et.getMonth() + 1).padStart(2, '0')}-${String(et.getDate()).padStart(2, '0')}`;
}

const timeOf = (r) =>
  r.timeLabel != null
    ? r.timeLabel
    : r.dt
    ? new Intl.DateTimeFormat('en-US', { timeZone: ET, hour: 'numeric', minute: '2-digit' }).format(new Date(r.dt)).replace(' ', '').toLowerCase()
    : '?';

// A format only adds info if it isn't just the venue (AMC's IMAX/70mm/Dolby do).
const usefulFormat = (r) => (r.format && r.venue && !r.format.includes(r.venue) && r.format !== r.venue ? r.format : '');

const humanDate = (iso) =>
  new Intl.DateTimeFormat('en-US', { timeZone: ET, weekday: 'long', month: 'long', day: 'numeric' }).format(new Date(`${iso}T12:00:00Z`));

function buildDigest(rows, date) {
  // venue → show → format → sorted unique times (each with its url)
  const cmp = (a, b) =>
    `${(a.venue || '').toLowerCase()}|${(a.movie || '').toLowerCase()}|${a.dt || a.timeLabel || ''}`.localeCompare(
      `${(b.venue || '').toLowerCase()}|${(b.movie || '').toLowerCase()}|${b.dt || b.timeLabel || ''}`
    );
  const venues = new Map();
  for (const r of [...rows].sort(cmp)) {
    const v = r.venue || r.source || 'Other';
    if (!venues.has(v)) venues.set(v, new Map());
    const shows = venues.get(v);
    if (!shows.has(r.movie)) shows.set(r.movie, new Map());
    const byFmt = shows.get(r.movie);
    const f = usefulFormat(r);
    if (!byFmt.has(f)) byFmt.set(f, []);
    byFmt.get(f).push({ t: timeOf(r), url: r.url });
  }

  const dedupeTimes = (arr) => [...new Map(arr.map((x) => [x.t, x])).values()];

  const text = [`🎭 Showtimes — ${humanDate(date)}\n${rows.length} showtimes · ${venues.size} venues`, ''];
  const md = [`## ${humanDate(date)} · ${rows.length} showtimes · ${venues.size} venues`, ''];
  for (const [venue, shows] of venues) {
    text.push(`━ ${venue} ━`);
    md.push(`### ${venue}`);
    for (const [show, byFmt] of shows) {
      for (const [fmt, times] of byFmt) {
        const uniq = dedupeTimes(times);
        const label = fmt ? `${show} · ${fmt}` : show;
        text.push(`  ${label} — ${uniq.map((x) => x.t).join(', ')}`);
        md.push(`- **${label}** — ${uniq.map((x) => `[${x.t}](${x.url})`).join(', ')}`);
      }
    }
    text.push('');
    md.push('');
  }
  return { text: text.join('\n').trim(), md: md.join('\n').trim() };
}

async function main() {
  const date = etDate(MODE === 'tomorrow' ? 1 : 0);
  log(`digest mode=${MODE} → date=${date}`);
  const notifier = makeNotifier(config.notify);
  log(`notify channel: ${notifier.channel}`);

  const rows = await fetchDayRows(date, log);
  log(`total ${rows.length} showtimes on ${date}`);

  const { text, md } = buildDigest(rows, date);
  const title = `Showtimes ${MODE === 'tomorrow' ? 'tomorrow' : 'today'} — ${humanDate(date)}`;
  const body = rows.length ? text : `${title}\n\nNo showtimes found for ${humanDate(date)}.`;
  await notifier.send(body, { title, click: 'https://www.lincolncenter.org/lincoln-center-at-home/calendar' });

  // Prepend to a durable digest log (newest first).
  const HEADER = '# Daily showtimes digest\n\n';
  let prior = '';
  try {
    const existing = await readFile('HISTORY-DIGEST.md', 'utf8');
    prior = existing.startsWith(HEADER) ? existing.slice(HEADER.length) : existing;
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  await writeFile('HISTORY-DIGEST.md', `${HEADER}${md}\n\n${prior}`.trimEnd() + '\n');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
