// Daily digest data layer: fetch ALL showtimes for a single target date across
// every source (AMC, FLC, TDF, Lincoln Center). Each source is best-effort — a
// failure logs a warning and is skipped, so the digest still goes out.

import { config } from './config.js';
import { scrape } from './scraper.js';
import { fetchFilmlincRows } from './filmlinc.js';
import { fetchTdfShowtimes } from './tdf.js';
import { fetchLincolnCenterRows } from './lincolncenter.js';

/** All showtimes on `date` (YYYY-MM-DD) across sources, tagged with `source`. */
export async function fetchDayRows(date, log = console.log) {
  const all = [];
  const add = (rows, source) => {
    for (const r of rows || []) if (r.date === date) all.push({ ...r, source });
  };

  // AMC — browser + residential proxy; fetch just the one date.
  try {
    const { rows } = await scrape({ ...config, onlyDates: [date] }, log);
    add(rows, 'AMC');
    log(`[digest] AMC: ${rows.filter((r) => r.date === date).length} on ${date}`);
  } catch (e) {
    log(`::warning:: [digest] AMC failed: ${e.message}`);
  }

  // Film at Lincoln Center — public JSON API.
  try {
    const rows = await fetchFilmlincRows();
    add(rows, 'FLC');
    log(`[digest] FLC: ${rows.filter((r) => r.date === date).length} on ${date}`);
  } catch (e) {
    log(`::warning:: [digest] FLC failed: ${e.message}`);
  }

  // TDF — browser login (needs creds).
  try {
    if (process.env.TDF_USERNAME && process.env.TDF_PASSWORD) {
      const rows = await fetchTdfShowtimes(
        { username: process.env.TDF_USERNAME, password: process.env.TDF_PASSWORD, headless: config.headless },
        log
      );
      add(rows, 'TDF');
      log(`[digest] TDF: ${rows.filter((r) => r.date === date).length} on ${date}`);
    } else {
      log('[digest] TDF skipped (no creds)');
    }
  } catch (e) {
    log(`::warning:: [digest] TDF failed: ${e.message}`);
  }

  // Lincoln Center — browser-free calendar (2 months covers today/tomorrow).
  try {
    const rows = await fetchLincolnCenterRows({ months: 2 }, log);
    add(rows, 'LC');
    log(`[digest] LC: ${rows.filter((r) => r.date === date).length} on ${date}`);
  } catch (e) {
    log(`::warning:: [digest] LC failed: ${e.message}`);
  }

  return all;
}
