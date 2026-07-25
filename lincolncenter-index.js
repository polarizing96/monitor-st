#!/usr/bin/env node
// Lincoln Center monitor: fetch the next N months of the calendar (browser-free
// JSON endpoint), diff against JSON state, ntfy on new events. LC events have
// fuzzy times ("Multiple Times"), so alerts group by event → dates.

import { config } from './config.js';
import { openDb } from './db.js';
import { fetchLincolnCenterRows } from './lincolncenter.js';
import { makeNotifier } from './notify.js';

const log = (...a) => console.log(new Date().toISOString(), ...a);
const LABEL = 'Lincoln Center';
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS = Number(process.env.LC_MONTHS || 6);

const fmtDate = (iso) => { const [, m, d] = iso.split('-'); return `${MON[+m - 1]} ${+d}`; };

function groupByEvent(rows) {
  const m = new Map();
  for (const r of [...rows].sort((a, b) => a.date.localeCompare(b.date))) {
    if (!m.has(r.movie)) m.set(r.movie, { org: r.format, url: r.url, items: [] });
    m.get(r.movie).items.push(r);
  }
  return [...m.entries()];
}
const datesFor = (g) => [...new Set(g.items.map((r) => (r.time && !/multiple/i.test(r.time) ? `${fmtDate(r.date)} ${r.time}` : fmtDate(r.date))))];

function alertBody(fresh) {
  const n = fresh.length;
  const events = groupByEvent(fresh);
  const blocks = events.slice(0, 25).map(([title, g]) => `🎭 ${title}${g.org ? ` (${g.org})` : ''}\n  ${datesFor(g).join(', ')}`);
  if (events.length > 25) blocks.push(`…+${events.length - 25} more events`);
  return `${LABEL} — ${n} new showtime${n === 1 ? '' : 's'} · ${events.length} event${events.length === 1 ? '' : 's'}\n\n${blocks.join('\n')}`;
}

function historyMarkdown(fresh) {
  const n = fresh.length;
  const events = groupByEvent(fresh);
  const out = [`**${LABEL}** — ${n} new showtime${n === 1 ? '' : 's'} across ${events.length} events`, ''];
  for (const [title, g] of events) out.push(`- [${title}](${g.url})${g.org ? ` — ${g.org}` : ''}: ${datesFor(g).join(', ')}`);
  return out.join('\n').trim();
}

async function main() {
  const db = await openDb({
    stateFile: 'seen-lincolncenter.json',
    dropsFile: 'drops-lincolncenter.json',
    historyFile: 'HISTORY-LINCOLNCENTER.md',
    historyTitle: 'Lincoln Center',
  });
  const notifier = makeNotifier(config.notify);
  log(`notify channel: ${notifier.channel}`);

  try {
    const rows = await fetchLincolnCenterRows({ months: MONTHS }, log);
    log(`fetched ${rows.length} events across ${MONTHS} months`);
    if (!rows.length) {
      log('no events parsed — endpoint change?; skipping (no state change)');
      return;
    }
    const fresh = await db.insertNew(rows);
    if (!fresh.length) {
      log('no new events');
      return;
    }
    fresh.sort((a, b) => a.date.localeCompare(b.date));
    log(`${fresh.length} NEW events`);

    const body = alertBody(fresh);
    const click = 'https://www.lincolncenter.org/lincoln-center-at-home/calendar';
    await notifier.send(body, { title: `${LABEL}: ${fresh.length} new`, click });
    await db.recordDrop(fresh, body, historyMarkdown(fresh));
  } catch (e) {
    log(`::warning:: cycle failed (transient?), will retry next run: ${e.message}`);
  } finally {
    db.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
