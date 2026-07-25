#!/usr/bin/env node
// Film at Lincoln Center monitor: fetch the JSON API → diff against SQLite-free
// JSON state → ntfy push on new showtimes. Same behavior as the AMC monitor,
// but browser-free (the FLC API needs no scraping). One call covers every date.

import { config } from './config.js';
import { openDb } from './db.js';
import { fetchFilmlincRows } from './filmlinc.js';
import { makeNotifier, formatAlert, formatHistoryMarkdown } from './notify.js';

const log = (...a) => console.log(new Date().toISOString(), ...a);
const LABEL = 'Film at Lincoln Center';

async function main() {
  const db = await openDb({
    stateFile: 'seen-filmlinc.json',
    dropsFile: 'drops-filmlinc.json',
    historyFile: 'HISTORY-FILMLINC.md',
    historyTitle: 'Film at Lincoln Center',
  });
  const notifier = makeNotifier(config.notify);
  log(`notify channel: ${notifier.channel}`);

  try {
    const rows = await fetchFilmlincRows();
    log(`fetched ${rows.length} showtimes`);
    if (!rows.length) {
      log('no showtimes returned — API hiccup?; skipping');
      return;
    }

    const fresh = await db.insertNew(rows);
    if (!fresh.length) {
      log('no new showtimes');
      return;
    }

    fresh.sort((a, b) => (a.dt || '').localeCompare(b.dt || ''));
    log(`${fresh.length} NEW showtimes`);

    const body = formatAlert(fresh, LABEL);
    const click = fresh.find((r) => r.url)?.url || 'https://www.filmlinc.org/now-playing/';
    await notifier.send(body, { title: `${LABEL}: ${fresh.length} new`, click });

    const markdown = formatHistoryMarkdown(fresh, LABEL);
    await db.recordDrop(fresh, body, markdown);
  } catch (e) {
    // Soft-fail: a transient API blip shouldn't red-X the run (retries next tick).
    log(`::warning:: cycle failed (transient?), will retry next run: ${e.message}`);
  } finally {
    db.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
