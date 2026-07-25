#!/usr/bin/env node
// View the drop history — every batch of new showtimes we ever alerted on.
// Reads the same Turso/libSQL store, so it works from anywhere (your machine,
// the Actions "History" workflow, or `turso db shell`). Your laptop is NOT the
// source of truth — this is just a reader.
//
//   node history.js            # last 20 drops
//   node history.js 50         # last 50 drops
//   node history.js --since 2026-07-01   # showtimes first seen since a date

import { config } from './config.js';
import { openDb } from './db.js';

async function main() {
  const db = await openDb(config.db);
  try {
    const sinceIdx = process.argv.indexOf('--since');
    if (sinceIdx !== -1) {
      const since = process.argv[sinceIdx + 1];
      const rows = await db.newSince(since);
      console.log(`# ${rows.length} showtimes first seen since ${since}\n`);
      for (const r of rows) {
        console.log(`${r.first_seen}  ${r.date}  ${r.show_dt_utc || ''}  ${r.status || ''}  #${r.showtime_id}`);
      }
      return;
    }

    const limit = parseInt(process.argv[2], 10) || 20;
    const drops = await db.recentDrops(limit);
    if (!drops.length) {
      console.log('No drops recorded yet.');
      return;
    }
    console.log(`# Last ${drops.length} drops (newest first)\n`);
    for (const d of drops) {
      console.log(`── #${d.id}  ${d.detected_at}  (${d.count} new)`);
      console.log(d.summary);
      console.log('');
    }
  } finally {
    db.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
