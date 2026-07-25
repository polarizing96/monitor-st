// Core scraper.
//
// Strategy that survives Cloudflare + the rate limit:
//  1. Launch a REAL Chromium (one per proxy IP). Datacenter IPs get challenged,
//     so in the cloud each browser rides a sticky residential session.
//  2. Navigate the base showtimes page once → Cloudflare hands us a cf_clearance
//     cookie bound to that IP + browser.
//  3. Fetch every ?date=YYYY-MM-DD with fetch() INSIDE the page. Same origin,
//     cookies, TLS/JA3 fingerprint and clearance → not a bot to Cloudflare.
//  4. Parse the RSC payload in-page; return only small row objects.
//  5. Concurrency-limited pool + jittered backoff per request.
//  6. RESILIENCE: most residential IPs clear Cloudflare, but the odd one is
//     pre-flagged. On a block we ROLL A FRESH STICKY IP (new sessid) and retry —
//     on initial establish (up to maxEstablishTries) and mid-run (maxRerolls).
//  7. Multiple proxies => multiple browsers in parallel (IP diversity + speed).

import { chromium } from 'playwright';
import { PATTERNS, parseDates, FORMAT_NAMES } from './parse.js';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const rand = () => Math.random();
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

const CONTEXT_OPTS = {
  userAgent: UA,
  viewport: { width: 1280, height: 900 },
  locale: 'en-US',
  timezoneId: 'America/New_York',
};

function isChallengeTitle(t) {
  return /just a moment|attention required|access denied/i.test(t || '');
}

/**
 * Bring up ONE working worker for a spec, rolling a fresh residential IP on each
 * failed attempt. Returns { browser, context, page, label, proxyUrl }.
 */
async function establishWorker(spec, cfg, log) {
  let lastErr;
  for (let t = 1; t <= cfg.maxEstablishTries; t++) {
    const proxyUrl = spec.proxyTemplate
      ? withSession(spec.proxyTemplate, `${spec.sessionBase}-${spec.seq++}`)
      : null;

    // --no-sandbox: required to launch Chromium as root inside the CI container.
    const launchOpts = {
      headless: cfg.headless,
      args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-setuid-sandbox'],
    };
    if (proxyUrl) launchOpts.proxy = toProxyOption(proxyUrl);

    let browser;
    try {
      browser = await chromium.launch(launchOpts);
      const context = await browser.newContext(CONTEXT_OPTS);
      // Save residential-proxy bandwidth (billed per-GB): drop images/fonts/media.
      // Do NOT block scripts/styles — Cloudflare's challenge needs JS to run.
      await context.route('**/*', (route) => {
        const t = route.request().resourceType();
        return t === 'image' || t === 'media' || t === 'font' ? route.abort() : route.continue();
      });
      const page = await context.newPage();

      // Fast-fail: a dead/slow residential IP shouldn't stall us — bail quickly
      // and roll to a fresh IP instead of waiting out long timeouts.
      await page.goto(spec.theatreUrl, { waitUntil: 'domcontentloaded', timeout: cfg.establishTimeoutMs });
      // The <select name="date"> element confirms Cloudflare cleared us to the
      // real page. (Its <option>s are hydrated client-side and can be empty here,
      // so we read the date list via an in-page fetch instead — see readDates.)
      await page.waitForSelector('select[name="date"]', { timeout: cfg.selectorTimeoutMs });

      log(`[${spec.label}] session established${proxyUrl ? ` (fresh IP, try ${t})` : ''}`);
      return { browser, context, page, label: spec.label, proxyUrl };
    } catch (e) {
      const title = browser ? await titleOf(browser) : '';
      lastErr = new Error(isChallengeTitle(title) ? `Cloudflare block ("${title}")` : e.message);
      log(`[${spec.label}] establish try ${t}/${cfg.maxEstablishTries} failed: ${lastErr.message}`);
      if (browser) await browser.close().catch(() => {});
      if (t < cfg.maxEstablishTries) await sleep(pick({ min: 1500, max: 4000 }));
    }
  }
  throw new Error(`[${spec.label}] could not establish after ${cfg.maxEstablishTries} tries: ${lastErr?.message}`);
}

async function titleOf(browser) {
  try {
    const pages = browser.contexts()[0]?.pages() || [];
    return pages.length ? await pages[0].title() : '';
  } catch {
    return '';
  }
}

/**
 * Read the selectable dates + a friendly theatre label. Dates come from an
 * IN-PAGE fetch of the base page (its RSC payload reliably contains every date),
 * not the hydrated DOM — the client-rendered <option>s can be empty when read.
 */
async function readDatesAndLabel(worker, theatreUrl) {
  const path = new URL(theatreUrl).pathname;
  const html = await worker.page.evaluate(
    async (p) => (await fetch(p, { credentials: 'include', headers: { Accept: 'text/html' } })).text(),
    path
  );
  const dates = parseDates(html).filter(Boolean);
  const title = await worker.page.title().catch(() => '');
  const label = title.replace(/ Showtimes.*$/i, '').trim() || 'theatre';
  return { dates, theatreLabel: label };
}

/**
 * Fetch + parse a set of dates from inside one worker's page: concurrency-limited
 * pool, per-request jitter and exponential backoff. Returns { results, hardBlock }.
 */
async function fetchBatch(worker, items, cfg) {
  return worker.page.evaluate(
    async ({ items, concurrency, jitter, maxRetries, backoffBase, patterns, fetchTimeout, theatreSlug, formatNames }) => {
      const nap = (ms) => new Promise((r) => setTimeout(r, ms));

      const deslug = (s) =>
        s.replace(/-\d+$/, '').split('-').filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
      const decode = (s) => {
        try { return JSON.parse('"' + s.replace(/"/g, '\\"') + '"'); } catch { return s.replace(/\\u0026/g, '&'); }
      };

      const fmtName = (slug) => (slug in formatNames ? formatNames[slug] || null : slug || null);
      const parse = (html, date) => {
        const slugToName = {};
        for (const m of html.matchAll(new RegExp(patterns.movieMap, 'g'))) slugToName[m[2]] = decode(m[1]);
        const byId = new Map();
        for (const m of html.matchAll(new RegExp(patterns.combined, 'g'))) {
          const slug = m[4];
          byId.set(m[1], { id: m[1], date, status: m[2], dt: m[3], movie: slugToName[slug] || deslug(slug), format: null });
        }
        for (const m of html.matchAll(new RegExp(patterns.loose, 'g'))) {
          if (!byId.has(m[1])) byId.set(m[1], { id: m[1], date, status: null, dt: m[2], movie: null, format: null });
        }
        if (theatreSlug) {
          for (const m of html.matchAll(new RegExp(patterns.formatToken, 'g'))) {
            const row = byId.get(m[1]);
            if (!row) continue;
            const after = m[2].split(`-${theatreSlug}-`)[1];
            if (after) row.format = fmtName(after.replace(/-\d+-attributes$/, ''));
          }
        }
        return [...byId.values()];
      };
      const blocked = (status, html) => {
        if (status === 403 || status === 429 || status === 503) return true;
        if (!html) return true;
        const chal = /just a moment\.\.\.|cf-chl-|_cf_chl_opt|attention required/i.test(html);
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
              const res = await fetch(it.url, {
                credentials: 'include',
                headers: { Accept: 'text/html' },
                signal: AbortSignal.timeout(fetchTimeout), // don't hang on a dead IP
              });
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
      fetchTimeout: cfg.fetchTimeoutMs,
      theatreSlug: new URL(cfg.theatreUrl).pathname.split('/')[3] || '',
      formatNames: FORMAT_NAMES,
    }
  );
}

/**
 * Process one spec's dates in batches. On a hard block, close the browser and
 * ROLL A FRESH RESIDENTIAL IP, then keep going with the un-fetched dates.
 */
async function runWorker(spec, initialWorker, dates, cfg, sink, log) {
  const path = new URL(cfg.theatreUrl).pathname;
  const pending = dates.map((d) => ({ date: d, url: `${path}?date=${d}` }));
  let worker = initialWorker || (await establishWorker(spec, cfg, log));
  let rerolls = 0;

  try {
    while (pending.length) {
      const batch = pending.splice(0, cfg.batchSize);
      const { results, hardBlock } = await fetchBatch(worker, batch, cfg);

      for (const r of results) {
        if (r.ok) sink.push(...r.rows);
        else if (r.blocked) pending.push({ date: r.date, url: `${path}?date=${r.date}` }); // requeue
        else log(`[${spec.label}] ${r.date} failed: ${r.error}`);
      }

      if (hardBlock) {
        if (++rerolls > cfg.maxRerolls) {
          log(`[${spec.label}] blocked ${rerolls}× — giving up with ${pending.length} dates left`);
          break;
        }
        log(`[${spec.label}] blocked — rolling a fresh residential IP (#${rerolls})`);
        await worker.browser.close().catch(() => {});
        worker = await establishWorker(spec, cfg, log); // new IP
      }

      if (pending.length) await sleep(pick(cfg.batchDelayMs));
    }
  } finally {
    await worker.browser.close().catch(() => {});
  }
}

/** Split an array into n round-robin shards. */
function shard(arr, n) {
  const out = Array.from({ length: n }, () => []);
  arr.forEach((x, i) => out[i % n].push(x));
  return out;
}

/**
 * Top-level scrape. Returns { rows, theatreLabel, datesChecked }.
 */
export async function scrape(cfg, log = console.log) {
  const cycleId = Math.floor(rand() * 1e9).toString(36); // fresh IPs each cycle
  const specs =
    cfg.proxies.length > 0
      ? cfg.proxies.map((p, i) => ({
          proxyTemplate: p,
          sessionBase: `${cycleId}${String.fromCharCode(97 + i)}`,
          seq: 0,
          headless: cfg.headless,
          theatreUrl: cfg.theatreUrl,
          label: `w${i}`,
        }))
      : [{ proxyTemplate: null, sessionBase: cycleId, seq: 0, headless: cfg.headless, theatreUrl: cfg.theatreUrl, label: 'direct' }];

  // Bootstrap the first worker (also used to read the date list).
  const boot = await establishWorker(specs[0], cfg, log);
  const { dates, theatreLabel } = await readDatesAndLabel(boot, cfg.theatreUrl);
  // cfg.onlyDates (e.g. the digest's single day) overrides the full date list.
  // Use them directly — "today" is the empty-value option so it isn't in the
  // parsed list, but ?date=YYYY-MM-DD still serves that day's showtimes.
  let use = cfg.onlyDates && cfg.onlyDates.length ? cfg.onlyDates : dates;
  if (cfg.maxDates) use = use.slice(0, cfg.maxDates);
  log(`found ${dates.length} dates; scraping ${use.length} across ${specs.length} worker(s)`);

  const shards = shard(use, specs.length);
  const rows = [];
  await Promise.all(
    specs.map((spec, i) => runWorker(spec, i === 0 ? boot : null, shards[i], cfg, rows, log))
  );

  // De-dup across workers/dates by showtime id; stamp the theatre as the venue.
  const byId = new Map();
  for (const r of rows) if (!byId.has(r.id)) byId.set(r.id, { ...r, venue: theatreLabel });
  return { rows: [...byId.values()], theatreLabel, datesChecked: use.length };
}
