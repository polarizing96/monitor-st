#!/usr/bin/env node
// TDF Broadway + Off-Broadway monitor: log into the member store, list the
// watched shows, diff against JSON state, ntfy on new shows. Browser-based
// (Salesforce SPA login). Own state files + a TDF-specific alert format (no
// per-date times, so it groups by type → show).

import { config } from './config.js';
import { openDb } from './db.js';
import { fetchTdfShows } from './tdf.js';
import { makeNotifier } from './notify.js';

const log = (...a) => console.log(new Date().toISOString(), ...a);

const TYPE_ORDER = { Broadway: 0, 'Off Broadway': 1 };
function groupByType(rows) {
  const byType = new Map();
  for (const r of rows) {
    const t = r.type || 'Show';
    if (!byType.has(t)) byType.set(t, []);
    byType.get(t).push(r);
  }
  for (const list of byType.values()) list.sort((a, b) => a.movie.localeCompare(b.movie));
  return [...byType.entries()].sort((a, b) => (TYPE_ORDER[a[0]] ?? 9) - (TYPE_ORDER[b[0]] ?? 9));
}

function alertBody(fresh) {
  const n = fresh.length;
  const blocks = groupByType(fresh).map(([type, shows]) => {
    const lines = shows.map((s) => `• ${s.movie}${s.format ? ` — ${s.format}` : ''}`);
    return `🎭 ${type} (${shows.length})\n${lines.join('\n')}`;
  });
  return `TDF — ${n} new show${n === 1 ? '' : 's'}\n\n${blocks.join('\n')}`;
}

function historyMarkdown(fresh) {
  const n = fresh.length;
  const out = [`**TDF** — ${n} new show${n === 1 ? '' : 's'}`, ''];
  for (const [type, shows] of groupByType(fresh)) {
    out.push(`**${type}** (${shows.length})`);
    for (const s of shows) out.push(`- [${s.movie}](${s.url})${s.format ? ` — ${s.format}` : ''}`);
    out.push('');
  }
  return out.join('\n').trim();
}

async function main() {
  const db = await openDb({
    stateFile: 'seen-tdf.json',
    dropsFile: 'drops-tdf.json',
    historyFile: 'HISTORY-TDF.md',
    historyTitle: 'TDF Broadway / Off-Broadway',
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
    const rows = await fetchTdfShows({ username, password, headless: config.headless }, log);
    log(`fetched ${rows.length} Broadway/Off-Broadway shows`);
    if (!rows.length) {
      log('no shows returned — login or API issue?; skipping (no state change)');
      return;
    }
    const fresh = await db.insertNew(rows);
    if (!fresh.length) {
      log('no new shows');
      return;
    }
    log(`${fresh.length} NEW shows`);
    const body = alertBody(fresh);
    await notifier.send(body, { title: `TDF: ${fresh.length} new show${fresh.length === 1 ? '' : 's'}`, click: 'https://members.tdf.org/store/' });
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
