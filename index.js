#!/usr/bin/env node
// Orchestrator: scrape → diff against SQLite → text on new showtimes.
// Run once (CI/cron) with --once, or loop locally.

import { config } from './config.js';
import { openDb } from './db.js';
import { scrape } from './scraper.js';
import { makeNotifier, formatAlert, formatHistoryMarkdown } from './notify.js';

const once = process.argv.includes('--once') || !config.loop;
const log = (...a) => console.log(new Date().toISOString(), ...a);

async function runCycle(db, notifier) {
  const t0 = Date.now();
  const { rows, theatreLabel, datesChecked } = await scrape(config, log);
  log(`scraped ${rows.length} showtimes over ${datesChecked} dates in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  if (!rows.length) {
    log('no showtimes parsed — likely blocked or an empty theatre; skipping notify');
    return;
  }

  const fresh = await db.insertNew(rows);
  if (!fresh.length) {
    log('no new showtimes');
    return;
  }

  fresh.sort((a, b) => (a.dt || '').localeCompare(b.dt || ''));
  log(`${fresh.length} NEW showtimes`);

  const body = formatAlert(fresh, theatreLabel);
  // Tapping the push lands on the theatre's showtimes for the earliest new date.
  const earliestDate = fresh.map((r) => r.date).sort()[0];
  const click = `${config.theatreUrl}?date=${earliestDate}`;
  await notifier.send(body, { title: `${theatreLabel}: ${fresh.length} new`, click });

  const markdown = formatHistoryMarkdown(fresh, theatreLabel);
  await db.recordDrop(fresh, body, markdown); // durable, readable history
}

async function main() {
  const db = await openDb(config.db);
  const notifier = makeNotifier(config.notify);
  log(`notify channel: ${notifier.channel}`);

  try {
    if (once) {
      await runCycle(db, notifier);
    } else {
      // Continuous local mode.
      for (;;) {
        try {
          await runCycle(db, notifier);
        } catch (e) {
          log('cycle error:', e.message);
        }
        log(`sleeping ${(config.pollIntervalMs / 60000).toFixed(0)} min`);
        await new Promise((r) => setTimeout(r, config.pollIntervalMs));
      }
    }
  } finally {
    db.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
