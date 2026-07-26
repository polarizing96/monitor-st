#!/usr/bin/env node
// Orchestrator: scrape → diff against SQLite → text on new showtimes.
// Run once (CI/cron) with --once, or loop locally.

import { config } from './config.js';
import { openDb } from './db.js';
import { scrape } from './scraper.js';
import { makeNotifier, formatAlert, formatHistoryMarkdown, formatStatusChanges } from './notify.js';

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

  const { fresh, changed } = await db.insertNew(rows);

  // 1) New showtimes.
  if (fresh.length) {
    fresh.sort((a, b) => (a.dt || '').localeCompare(b.dt || ''));
    log(`${fresh.length} NEW showtimes`);
    const body = formatAlert(fresh, theatreLabel);
    const earliestDate = fresh.map((r) => r.date).sort()[0];
    await notifier.send(body, { title: `${theatreLabel}: ${fresh.length} new`, click: `${config.theatreUrl}?date=${earliestDate}` });
    await db.recordDrop(fresh, body, formatHistoryMarkdown(fresh, theatreLabel));
  }

  // 2) Status changes on existing showtimes (Available Soon→On Sale, →Almost Full, →Sold Out).
  // insertNew already updated stored statuses; with statusAlerts off this run just
  // silently re-baselines them (no notification) — used once after deploy.
  if (changed.length && !config.statusAlerts) {
    log(`${changed.length} status changes suppressed (baseline run)`);
  } else if (changed.length) {
    log(`${changed.length} status changes`);
    const { text, md } = formatStatusChanges(changed, theatreLabel);
    const earliestDate = changed.map((r) => r.date).sort()[0];
    await notifier.send(text, { title: `${theatreLabel}: ${changed.length} status change${changed.length === 1 ? '' : 's'}`, click: `${config.theatreUrl}?date=${earliestDate}` });
    await db.recordDrop(changed, text, md);
  }

  if (!fresh.length && !changed.length) log('no new showtimes or status changes');
}

async function main() {
  const db = await openDb(config.db);
  const notifier = makeNotifier(config.notify);
  log(`notify channel: ${notifier.channel}`);

  try {
    if (once) {
      // Soft-fail: a transient proxy/Cloudflare hiccup shouldn't red-X the run
      // (it retries on the next 10-min trigger). Real breakage still shows in logs.
      try {
        await runCycle(db, notifier);
      } catch (e) {
        log(`::warning:: cycle failed (transient?), will retry next run: ${e.message}`);
      }
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
