// Core scraper.
//
// Strategy that survives Cloudflare + the rate limit:
//  1. Launch a REAL Chromium (one per proxy IP). Datacenter IPs get challenged,
//     so in the cloud each browser must ride a sticky residential session.
//  2. Navigate the base showtimes page once → Cloudflare hands us a cf_clearance
//     cookie bound to that IP + browser.
//  3. Fetch every ?date=YYYY-MM-DD with fetch() INSIDE the page. Same origin,
//     same cookies, same TLS/JA3 fingerprint, same clearance → not a bot to CF.
//  4. Parse the RSC payload in-page and return only small row objects.
//  5. Concurrency-limited pool + jittered backoff per request; on a block we
//     re-navigate to refresh clearance and retry the un-fetched dates.
//  6. Multiple proxies => multiple browsers in parallel (IP diversity + speed).

import { chromium } from 'playwright';
import { PATTERNS, parseDates } from './parse.js';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const rand = () => Math.random(); // isolated so tests can stub if needed
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pick = ({ min, max }) => Math.floor(min + rand() * (max - min));

/** Substitute a fresh sticky-session id into a proxy URL template ({session}). */
function withSession(proxyUrl, sessionId) {
  return proxyUrl.includes('{session}') ? proxyUrl.replaceAll('{session}', sessionId) : proxyUrl;
}

/** Parse "http://user:pass@host:port" into Playwright's proxy option shape. */
function toProxyOption(proxyUrl) {
  const u = new URL(proxyUrl);
  const opt = { server: `${u.protocol}//${u.host}` };
  if (u.username) opt.username = decodeURIComponent(u.username);
  if (u.password) opt.password = decodeURIComponent(u.password);
  return opt;
}

async function launchWorker({ proxyUrl, headless, theatreUrl, label }, log) {
  const launchOpts = { headless, args: ['--disable-blink-features=AutomationControlled'] };
  if (proxyUrl) launchOpts.proxy = toProxyOption(proxyUrl);

  const browser = await chromium.launch(launchOpts);
  const context = await browser.newContext({
    userAgent: UA,
    viewport: { width: 1280, height: 900 },
    locale: 'en-US',
    timezoneId: 'America/New_York',
  });
  const page = await context.newPage();

  const worker = { browser, context, page, label, theatreUrl };
  await establish(worker, log);
  return worker;
}

/** Load the base page so Cloudflare grants clearance for this IP + browser. */
async function establish(worker, log) {
  const { page, theatreUrl, label } = worker;
  await page.goto(theatreUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  // Wait for the real page (date select) or give Cloudflare a moment to clear.
  try {
    await page.waitForSelector('select[name="date"]', { timeout: 30_000 });
  } catch {
    const title = await page.title().catch(() => '');
    if (/just a moment|attention required/i.test(title)) {
      throw new Error(`[${label}] Cloudflare challenge not cleared (title: "${title}")`);
    }
    // No select but not obviously challenged — continue; fetches will tell us.
    log(`[${label}] date select not found after load; continuing`);
  }
  log(`[${label}] session established`);
}

/** Read the selectable dates + a friendly theatre label from a live worker. */
async function readDatesAndLabel(worker) {
  const html = await worker.page.content();
  const dates = parseDates(html).filter((d) => d); // drop empty "Today" value
  const title = await worker.page.title().catch(() => '');
  const label = title.replace(/ Showtimes.*$/i, '').trim() || 'theatre';
  return { dates, theatreLabel: label };
}

/**
 * Fetch + parse a set of dates from inside one worker's page, with a
 * concurrency-limited pool, per-request jitter and exponential backoff.
 * Returns { results, hardBlock } — hardBlock means Cloudflare stopped us.
 */
async function fetchBatch(worker, items, cfg) {
  return worker.page.evaluate(
    async ({ items, concurrency, jitter, maxRetries, backoffBase, patterns }) => {
      const nap = (ms) => new Promise((r) => setTimeout(r, ms));
      const strict = new RegExp(patterns.strict, 'g');
      const loose = new RegExp(patterns.loose, 'g');

      const parse = (html, date) => {
        const byId = new Map();
        let m;
        strict.lastIndex = 0;
        while ((m = strict.exec(html))) byId.set(m[1], { id: m[1], date, status: m[2], dt: m[3], movie: null });
        loose.lastIndex = 0;
        while ((m = loose.exec(html))) if (!byId.has(m[1])) byId.set(m[1], { id: m[1], date, status: null, dt: m[2], movie: null });
        return [...byId.values()];
      };
      const blocked = (status, html) => {
        if (status === 403 || status === 429 || status === 503) return true;
        if (!html) return true;
        const chal = /just a moment\.\.\.|cf-chl-|_cf_chl_opt/i.test(html);
        const ok = html.includes('Showtime Group Results') || html.includes('showtimeId');
        return chal && !ok;
      };

      const results = [];
      let idx = 0;
      let hardBlock = false;

      const worker = async () => {
        while (idx < items.length && !hardBlock) {
          const it = items[idx++];
          let attempt = 0;
          for (;;) {
            try {
              if (jitter) await nap(Math.random() * jitter);
              const res = await fetch(it.url, { credentials: 'include', headers: { Accept: 'text/html' } });
              const text = await res.text();
              if (blocked(res.status, text)) {
                if (++attempt > maxRetries) {
                  hardBlock = true;
                  results.push({ date: it.date, ok: false, blocked: true });
                  break;
                }
                await nap(backoffBase * 2 ** (attempt - 1) + Math.random() * 300);
                continue;
              }
              results.push({ date: it.date, ok: true, rows: parse(text, it.date) });
              break;
            } catch (e) {
              if (++attempt > maxRetries) {
                results.push({ date: it.date, ok: false, error: String(e) });
                break;
              }
              await nap(backoffBase * 2 ** (attempt - 1));
            }
          }
        }
      };

      const n = Math.min(concurrency, items.length);
      await Promise.all(Array.from({ length: n }, worker));
      return { results, hardBlock };
    },
    {
      items,
      concurrency: cfg.concurrency,
      jitter: cfg.requestJitterMs,
      maxRetries: cfg.maxRetries,
      backoffBase: cfg.backoffBaseMs,
      patterns: PATTERNS,
    }
  );
}

/** Process one worker's assigned dates in batches, refreshing on hard blocks. */
async function runWorker(worker, items, cfg, sink, log) {
  const path = new URL(cfg.theatreUrl).pathname;
  const pending = items.map((d) => ({ date: d, url: `${path}?date=${d}` }));
  let reEstablishes = 0;

  while (pending.length) {
    const batch = pending.splice(0, cfg.batchSize);
    const { results, hardBlock } = await fetchBatch(worker, batch, cfg);

    for (const r of results) {
      if (r.ok) sink.push(...r.rows);
      else if (r.blocked) pending.push({ date: r.date, url: `${path}?date=${r.date}` }); // requeue
      else log(`[${worker.label}] ${r.date} failed: ${r.error}`);
    }

    if (hardBlock) {
      if (++reEstablishes > 3) {
        log(`[${worker.label}] repeatedly blocked; stopping this worker`);
        break;
      }
      log(`[${worker.label}] blocked — refreshing Cloudflare clearance (#${reEstablishes})`);
      await sleep(pick({ min: 4000, max: 9000 }));
      await establish(worker, log).catch((e) => log(`[${worker.label}] re-establish failed: ${e.message}`));
    }

    if (pending.length) await sleep(pick(cfg.batchDelayMs));
  }
}

/** Split an array into n roughly-equal contiguous shards. */
function shard(arr, n) {
  const out = Array.from({ length: n }, () => []);
  arr.forEach((x, i) => out[i % n].push(x));
  return out;
}

/**
 * Top-level scrape. Returns { rows, theatreLabel, datesChecked }.
 * rows = de-duplicated showtimes across all dates.
 */
export async function scrape(cfg, log = console.log) {
  // Build worker specs: one per proxy URL, or a single direct worker.
  const cycleId = Math.floor(rand() * 1e9).toString(36); // fresh sticky id per cycle
  const specs =
    cfg.proxies.length > 0
      ? cfg.proxies.map((p, i) => ({
          proxyUrl: withSession(p, `${cycleId}-${i}`),
          headless: cfg.headless,
          theatreUrl: cfg.theatreUrl,
          label: `w${i}`,
        }))
      : [{ proxyUrl: null, headless: cfg.headless, theatreUrl: cfg.theatreUrl, label: 'direct' }];

  const workers = [];
  for (const spec of specs) {
    try {
      workers.push(await launchWorker(spec, log));
    } catch (e) {
      log(`launch failed for ${spec.label}: ${e.message}`);
    }
  }
  if (!workers.length) throw new Error('no browser worker could establish a session');

  try {
    const { dates, theatreLabel } = await readDatesAndLabel(workers[0]);
    let use = dates;
    if (cfg.maxDates) use = use.slice(0, cfg.maxDates);
    log(`found ${dates.length} dates; scraping ${use.length} across ${workers.length} worker(s)`);

    const shards = shard(use, workers.length);
    const rows = [];
    await Promise.all(workers.map((w, i) => runWorker(w, shards[i], cfg, rows, log)));

    // De-dup across workers/dates by showtime id (keep first occurrence).
    const byId = new Map();
    for (const r of rows) if (!byId.has(r.id)) byId.set(r.id, r);

    return { rows: [...byId.values()], theatreLabel, datesChecked: use.length };
  } finally {
    await Promise.all(workers.map((w) => w.browser.close().catch(() => {})));
  }
}
