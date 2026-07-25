// Central configuration. Everything is overridable via environment variables so
// you can keep secrets out of the repo (see .env.example).

import 'dotenv/config';

export const config = {
  // The theatre showtimes page. The scraper only needs the pathname; the query
  // string (?date=...) is added per request.
  theatreUrl:
    process.env.AMC_THEATRE_URL ||
    'https://www.amctheatres.com/movie-theatres/new-york-city/amc-lincoln-square-13/showtimes',

  // How many dates to fetch concurrently INSIDE one browser context.
  // Validated safe at 3 against Cloudflare; keep it modest.
  concurrency: intEnv('AMC_CONCURRENCY', 3),

  // Dates are fetched in batches; SQLite + SMS run between batches so progress
  // is never lost if the process dies. Also matches "in batches" in the spec.
  batchSize: intEnv('AMC_BATCH_SIZE', 9),

  // Random pause between batches (milliseconds) to look human and stay under the
  // rate limit. A value is picked uniformly in [min, max] each time.
  batchDelayMs: { min: intEnv('AMC_BATCH_DELAY_MIN', 1500), max: intEnv('AMC_BATCH_DELAY_MAX', 4000) },

  // Per-request jitter inside a batch (ms) so the N concurrent fetches don't all
  // hit the origin on the exact same millisecond.
  requestJitterMs: intEnv('AMC_REQUEST_JITTER', 400),

  // Retry / backoff for blocked or failed requests.
  maxRetries: intEnv('AMC_MAX_RETRIES', 4),
  backoffBaseMs: intEnv('AMC_BACKOFF_BASE', 1200),

  // Cloudflare resilience: how many fresh residential IPs to try when a session
  // gets challenged (each try = a new sticky sessid = new IP), and how many
  // times to re-roll the IP if a block happens mid-run.
  maxEstablishTries: intEnv('AMC_MAX_ESTABLISH_TRIES', 5),
  maxRerolls: intEnv('AMC_MAX_REROLLS', 3),

  // How many future dates to check at most (AMC exposes ~130). null = all.
  maxDates: process.env.AMC_MAX_DATES ? intEnv('AMC_MAX_DATES') : null,

  // Run continuously on an interval, or just once. --once flag overrides to false.
  loop: boolEnv('AMC_LOOP', true),
  pollIntervalMs: intEnv('AMC_POLL_INTERVAL', 15 * 60 * 1000), // 15 min

  headless: boolEnv('AMC_HEADLESS', true),

  // ---- State store (JSON files committed back to the repo) ------------------
  // No external DB / signup. The Actions runner reads these at start and commits
  // them back after each run (see the workflow's "commit state" step).
  db: {
    stateFile: process.env.AMC_STATE_FILE || 'seen.json',
    dropsFile: process.env.AMC_DROPS_FILE || 'drops.json',
    historyFile: process.env.AMC_HISTORY_FILE || 'HISTORY.md',
  },

  // ---- Proxy rotation (residential, sticky-session) -------------------------
  // cf_clearance is bound to the exit IP, so each browser context needs a STABLE
  // IP for its lifetime. Provide sticky-session residential proxy URL(s).
  //   AMC_PROXIES="http://user-session-{session}:pass@gw.provider.com:7777"
  // - Multiple comma-separated URLs => one browser/IP per URL, run in parallel.
  // - A single URL containing {session} => we mint a fresh sticky session id
  //   each poll cycle so the IP rotates cycle-to-cycle (stable within a cycle).
  // Empty => single direct connection (your home IP; fine for local runs).
  proxies: (process.env.AMC_PROXIES || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  // ---- Notifications (ntfy.sh by default; free, no signup) ------------------
  // Install the ntfy app, subscribe to a secret topic, set NTFY_TOPIC.
  // Falls back to a generic webhook, then to console dry-run.
  notify: {
    ntfyTopic: process.env.NTFY_TOPIC || '',
    ntfyServer: process.env.NTFY_SERVER || 'https://ntfy.sh',
    webhook: process.env.NOTIFY_WEBHOOK || '',
  },
};

function intEnv(name, dflt) {
  const v = process.env[name];
  if (v === undefined || v === '') return dflt;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : dflt;
}
function boolEnv(name, dflt) {
  const v = process.env[name];
  if (v === undefined || v === '') return dflt;
  return /^(1|true|yes|on)$/i.test(v);
}
