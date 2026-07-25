# AMC Showtimes Monitor

Watches an AMC theatre's showtimes page and **pushes a phone notification when
new showtimes appear**. Runs entirely in GitHub Actions on a schedule — your
machine can stay off. No paid database, no SMS gateway, no signup beyond a
residential proxy.

## Stack (deliberately minimal)

| Concern | Choice | Why |
|---|---|---|
| Run host | **GitHub Actions** (cron) | Free, no server to keep on |
| Browser | **Playwright container image** | Chromium prebaked → no runtime install |
| Deps | **vendored `node_modules`** (dotenv + playwright JS) | CI does zero installs; instant + deterministic |
| Anti-Cloudflare | **rotating sticky residential proxy** | Datacenter IPs get challenged; residential passes |
| State | **JSON committed back to the repo** | No external DB/signup; history is browsable |
| Notifications | **ntfy.sh** | Free push, no account, no phone number |

## How it works

1. **Launch real Chromium** (one per proxy IP) and load the base showtimes page
   → Cloudflare grants a `cf_clearance` cookie bound to that IP + browser.
2. **Fetch every `?date=YYYY-MM-DD` with `fetch()` _inside_ the page** — same
   origin, cookies, TLS fingerprint and clearance as a human tab, so Cloudflare
   sees a normal browser. Concurrency-limited pool + jitter + backoff.
3. **Parse the RSC payload.** AMC is a Next.js app; showtimes live in the React
   Server Components stream (`\"showtimeId\":…,\"showDateTimeUtc\":…`) with a
   movie table (`\"name\":…,\"slug\":…`). We map each showtime → movie title.
4. **Diff against `seen.json`** (keyed by showtime id — the finest grain, so it
   catches both a whole new movie and a single added showtime).
5. **Push only genuinely-new showtimes** via ntfy, **grouped by movie**.
6. **Commit** `seen.json` / `drops.json` / `HISTORY.md` back to the repo.

```
GitHub Actions (cron, Playwright container)
      │  node index.js --once
      ▼
  Chromium (+ sticky residential IP) ──▶ amctheatres.com (Cloudflare)
      │        in-page fetch × dates
      ▼
   parse RSC ──▶ rows [{id, dt, status, movie}]
      │
      ▼
   seen.json diff ──new?──▶ ntfy push (grouped by movie)
      │
      ▼
   commit seen.json / drops.json / HISTORY.md back to repo
```

## Rate limit & Cloudflare resilience

- **In-page `fetch()`** inherits the browser's `cf_clearance` — the biggest win.
- **Sticky residential IP per browser.** `cf_clearance` is IP-bound, so each
  browser holds ONE IP for its run (via the proxy's `sessid`). IPs rotate
  between runs.
- **Roll a fresh IP on a block.** Most residential IPs clear Cloudflare; the odd
  one is pre-flagged. On a challenge we mint a new `sessid` (new IP) and retry —
  on initial establish (`AMC_MAX_ESTABLISH_TRIES`) and mid-run (`AMC_MAX_REROLLS`).
- **Stay quiet:** US-geo IP matching the theatre, real UA/timezone/viewport,
  `AMC_CONCURRENCY=3` + jitter + batch delays, and images/fonts/media blocked.

## Setup

You need two things: a **residential proxy** and an **ntfy topic**. Everything
else is already wired.

### 1. Residential proxy (sticky session)

Any rotating-residential provider with sticky sessions works. The `{session}`
placeholder is swapped for a fresh sticky id each run. Example (DataImpulse):

```
http://USER__cr.us;sessid.{session}:PASS@gw.dataimpulse.com:823
```

- `__cr.us` = US targeting (match the theatre's country).
- `sessid.{session}` = sticky IP (held ~30 min; we mint a new one per run).
- Comma-separate several URLs to run multiple IPs in parallel.

### 2. ntfy (free push, no signup)

1. Install the **ntfy** app (iOS/Android) or open https://ntfy.sh in a browser.
2. Subscribe to a **long, random topic** name (the name is the only secret).
3. Use that same topic as `NTFY_TOPIC`.

### 3. Repo Secrets / Variables

Settings → Secrets and variables → Actions:

**Secrets:** `AMC_PROXIES`, `NTFY_TOPIC`
**Variables:** `AMC_THEATRE_URL` (any AMC showtimes URL), `AMC_MAX_DATES` (how
many upcoming dates to check — controls proxy bandwidth).

The workflow (`.github/workflows/monitor.yml`) runs every 2 hours and can be
triggered by hand from the **Actions** tab (or `gh workflow run`).

## Cost & cadence

- **Compute:** free. Each run is ~1–2 min; every 2h ≈ 360 runs/mo ≈ under the
  2,000-min Free quota for a private repo. Make the repo public for unlimited
  minutes (secrets stay encrypted) if you want tighter polling.
- **Proxy:** billed per-GB. Each date ≈ 0.6 MB, so `AMC_MAX_DATES=14` ≈ ~8 MB
  per run ≈ ~3 GB/mo at the 2h cadence. Lower the cap or widen the interval to
  spend less; raise it to cover more of AMC's ~130-day window.

## Local development

```bash
nvm use 20                 # needs Node 20+
npx playwright install chromium
cp .env.example .env       # fill in NTFY_TOPIC / AMC_PROXIES, or leave blank
node index.js --once       # one pass; AMC_MAX_DATES=3 to go quick
node history.js            # view the drop log locally
```

With `AMC_PROXIES` blank it uses your home IP (fine locally). With `NTFY_TOPIC`
blank, alerts print to the console (dry-run).

## Viewing history

- **`HISTORY.md`** in the repo — every drop, newest first, committed after each
  run. Just open it on GitHub.
- **Actions → "AMC drop history" → Run workflow** — prints the same log.
- **`drops.json`** — machine-readable log.

## Notes

- **Re-vendor after changing deps:**
  `rm -rf node_modules && PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --no-audit --no-fund --ignore-scripts && rm -rf node_modules/fsevents`,
  then commit `node_modules`. Keep the `playwright` version equal to the
  container image tag in the workflow.
- Alerts fire on **additions** (new showtime ids), not status changes
  (Available→SoldOut). If AMC changes its payload, update the regexes in
  `parse.js` (strict + loose fallback).
