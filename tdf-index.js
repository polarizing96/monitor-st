#!/usr/bin/env node
// TDF Broadway + Off-Broadway SHOWTIMES monitor: log into the member store, list
// every Broadway/Off-Broadway performance (show + date/time), diff against JSON
// state, ntfy on new showtimes. Browser-based (Salesforce SPA login). Reuses the
// shared movie→format→date→times formatter since TDF now carries real dates.

import { config } from './config.js';
import { openDb } from './db.js';
import { fetchTdfShowtimes } from './tdf.js';
import { makeNotifier, formatAlert, formatHistoryMarkdown } from './notify.js';

const log = (...a) => console.log(new Date().toISOString(), ...a);
const LABEL = 'TDF (Broadway/Off-Broadway)';

async function main() {
  const db = await openDb({
    stateFile: 'seen-tdf.json',
    dropsFile: 'drops-tdf.json',
    historyFile: 'HISTORY-TDF.md',
    historyTitle: 'TDF Broadway / Off-Broadway showtimes',
  });
  const notifier = makeNotifier(config.notify);
  log(`notify channel: ${notifier.channel}`);

  const username = process.env.TDF_USERNAME;
  const password = process.env.TDF_PASSWORD;
  if (!username || !password) {
    log('::warning:: TDF_USERNAME/TDF_PASSWORD not set; skipping');
    db.close();
    return;
  }

  try {
    const rows = await fetchTdfShowtimes({ username, password, headless: config.headless }, log);
    log(`fetched ${rows.length} Broadway/Off-Broadway showtimes`);
    if (!rows.length) {
      log('no showtimes returned — login or API issue?; skipping (no state change)');
      return;
    }
    const { fresh } = await db.insertNew(rows);
    if (!fresh.length) {
      log('no new showtimes');
      return;
    }

    fresh.sort((a, b) => (a.dt || '').localeCompare(b.dt || ''));
    log(`${fresh.length} NEW showtimes`);

    const body = formatAlert(fresh, LABEL, 'show');
    const click = fresh.find((r) => r.url)?.url || 'https://members.tdf.org/store/';
    await notifier.send(body, { title: `TDF: ${fresh.length} new showtime${fresh.length === 1 ? '' : 's'}`, click });
    await db.recordDrop(fresh, body, formatHistoryMarkdown(fresh, LABEL, 'show'));
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
