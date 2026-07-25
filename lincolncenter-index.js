#!/usr/bin/env node
// Lincoln Center monitor: fetch the next N months of the calendar (browser-free
// JSON endpoint), diff against JSON state, ntfy on new events. LC events have
// fuzzy times ("Multiple Times"), so alerts group by event → dates.

import { config } from './config.js';
import { openDb } from './db.js';
import { fetchLincolnCenterRows } from './lincolncenter.js';
import { makeNotifier, formatAlert, formatHistoryMarkdown } from './notify.js';

const log = (...a) => console.log(new Date().toISOString(), ...a);
const LABEL = 'Lincoln Center';
const MONTHS = Number(process.env.LC_MONTHS || 6);

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

    const body = formatAlert(fresh, LABEL, 'event');
    const click = 'https://www.lincolncenter.org/lincoln-center-at-home/calendar';
    await notifier.send(body, { title: `${LABEL}: ${fresh.length} new`, click });
    await db.recordDrop(fresh, body, formatHistoryMarkdown(fresh, LABEL, 'event'));
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
