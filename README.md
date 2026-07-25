# AMC Showtimes Monitor

Watches an AMC theatre's showtimes page and **texts you when new showtimes
appear** (e.g. a movie opens more seats or adds a date). Runs on a schedule in
GitHub Actions so your laptop can stay off.

## How it works

1. **Launch one real Chromium** (Playwright) per proxy IP.
2. **Load the base showtimes page once** → Cloudflare grants a `cf_clearance`
   cookie bound to that IP + browser.
3. **Fetch every `?date=YYYY-MM-DD` with `fetch()` _inside_ the page.** Same
   origin, cookies, TLS fingerprint and clearance as a human tab — Cloudflare
   sees a normal browser, not a bot. Requests run in a concurrency-limited pool
   with jitter + exponential backoff.
4. **Parse the RSC payload.** AMC is a Next.js app; showtimes live in the React
   Server Components stream as `\"showtimeId\":…,\"showDateTimeUtc\":…`. We read
   that directly (the `<time datetime>` tags only exist after hydration).
5. **Diff against SQLite** (`seen_showtimes`), keyed by showtime id.
6. **Text only genuinely-new ids** via Twilio.

```
GitHub Actions (cron)
      │  node index.js --once
      ▼
  scraper.js ──▶ Chromium (+ residential proxy) ──▶ amctheatres.com (Cloudflare)
      │                in-page fetch × dates
      ▼
   parse.js ──▶ rows [{id, dt, status, movie}]
      │
      ▼
    db.js (Turso/libSQL)  ──new?──▶  notify.js (Twilio SMS)
```

## Rate limit & Cloudflare resilience

The site is strictly rate-limited and behind Cloudflare. Defenses, in order of
importance:

- **In-page `fetch()`** — the single biggest win. All requests inherit the real
  browser's cookies + fingerprint + `cf_clearance`.
- **Sticky residential IP per browser.** `cf_clearance` is **IP-bound**, so a
  proxy that rotates the exit IP on every request would break mid-run. Use a
  **sticky session** (stable IP for the browser's life); rotate IPs *between*
  cycles/contexts instead.
- **Modest concurrency** (`AMC_CONCURRENCY=3`, validated safe) + per-request
  jitter + randomized delay between batches.
- **Exponential backoff & re-clearance.** On a 403/429/challenge we retry with
  backoff; on a hard block we re-navigate the base page to refresh clearance and
  requeue the un-fetched dates.
- **Parallel IPs.** Give several proxy URLs and dates are sharded across
  browsers — faster *and* spreads load across IPs.

### Rotating proxy / IP — recommended setup

Buy a **rotating residential proxy with sticky sessions** (Smartproxy, Bright
Data, Oxylabs, IPRoyal, …). Put the gateway URL in `AMC_PROXIES` and include the
`{session}` placeholder — a fresh sticky id is minted each cycle so the IP
rotates over time but stays stable within a run:

```
AMC_PROXIES=http://USER-session-{session}:PASS@gate.smartproxy.com:7000
```

Run several IPs in parallel by comma-separating full URLs:

```
AMC_PROXIES=http://u-session-a:p@gw:7000,http://u-session-b:p@gw:7000
```

Leave `AMC_PROXIES` empty to use your own IP (fine for local runs; **not** for
GitHub Actions, whose datacenter IPs get challenged).

## Setup

### 1. Local dev

```bash
nvm use 20            # needs Node 20+
npm install
npx playwright install chromium
cp .env.example .env  # fill in what you want; blank Twilio = dry-run to console
node index.js --once  # one pass;  AMC_MAX_DATES=4 to test quickly
```

State defaults to a local `seen.db` file. SMS with no Twilio creds prints
`[sms:dry-run] …` instead of texting.

### 2. Cloud state — Turso (serverless SQLite)

```bash
turso db create amc-showtimes
turso db show amc-showtimes --url          # → TURSO_DATABASE_URL
turso db tokens create amc-showtimes        # → TURSO_AUTH_TOKEN
```

### 3. GitHub Actions

Set these on the repo (Settings → Secrets and variables → Actions):

**Variables**
- `AMC_THEATRE_URL` — the showtimes URL (any AMC theatre)
- `AMC_MAX_DATES` — optional cap on dates checked

**Secrets**
- `AMC_PROXIES` — sticky residential proxy URL(s)
- `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`
- `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM`, `TWILIO_TO`

The workflow (`.github/workflows/monitor.yml`) runs every 15 min and can be
triggered by hand from the **Actions** tab. Scheduled runs are best-effort;
GitHub may delay them under load.

## Configuration

All via env (see `.env.example` / `config.js`):

| Var | Default | Meaning |
|---|---|---|
| `AMC_THEATRE_URL` | Lincoln Square 13 | Any AMC showtimes URL |
| `AMC_MAX_DATES` | all (~130) | Cap on future dates checked |
| `AMC_CONCURRENCY` | 3 | Parallel fetches per browser |
| `AMC_BATCH_SIZE` | 9 | Dates per batch (state saved between) |
| `AMC_PROXIES` | — | Sticky residential proxy URL(s) |
| `AMC_POLL_INTERVAL` | 900000 | Loop interval (ms), local mode |

## Notes

- **Personal, low-volume use.** Keep concurrency modest and intervals sane;
  don't hammer the site.
- If AMC changes its payload shape, update the regexes in `parse.js` (there's a
  strict pattern and a looser fallback).
