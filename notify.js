// Notifier. Default channel is ntfy.sh — free, no signup, no phone number:
// install the ntfy app, subscribe to a secret topic, and we POST alerts to it;
// they arrive as phone push notifications. Uses Node's global fetch (no deps).
//
// Channels, in priority order:
//   1. ntfy         — set NTFY_TOPIC (optionally NTFY_SERVER for self-host)
//   2. webhook      — set NOTIFY_WEBHOOK (Discord/Slack-style JSON POST)
//   3. dry-run      — nothing configured → log to console
//
// A long, random NTFY_TOPIC acts as its own password (topics are public by
// name on the shared ntfy.sh server).

export function makeNotifier(cfg) {
  if (cfg.ntfyTopic) {
    // JSON publishing (POST base URL) — headers are ByteString-only, so a title
    // with an em-dash/unicode breaks the header form. JSON body is UTF-8 safe.
    const base = cfg.ntfyServer.replace(/\/$/, '');
    return {
      ready: true,
      channel: 'ntfy',
      async send(text, { title = 'Showtimes', click } = {}) {
        const payload = { topic: cfg.ntfyTopic, title, message: text, priority: 5, tags: ['clapper', 'ticket'] };
        if (click) {
          payload.click = click;
          payload.actions = [{ action: 'view', label: 'Open', url: click }];
        }
        const res = await fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        if (!res.ok) throw new Error(`ntfy ${res.status}: ${await res.text().catch(() => '')}`);
      },
    };
  }

  if (cfg.webhook) {
    return {
      ready: true,
      channel: 'webhook',
      async send(text) {
        // Works for Discord ({content}) and Slack ({text}); send both keys.
        const res = await fetch(cfg.webhook, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ content: text, text }),
        });
        if (!res.ok) throw new Error(`webhook ${res.status}`);
      },
    };
  }

  return {
    ready: false,
    channel: 'dry-run',
    async send(text) {
      console.log(`[notify:dry-run]\n${text}`);
    },
  };
}

// Turn a list of new showtimes into an alert body, GROUPED BY MOVIE so it's
// clear at a glance which films got new showtimes and when:
//
//   AMC Lincoln Square 13 — 12 new showtimes · 2 movies
//
//   🎬 Spider-Man: Brand New Day (10)
//     Tue 7/28: 12:30pm, 4:00pm, 7:30pm
//     Wed 7/29: 1:00pm
//   🎬 The Odyssey (2)
//     Tue 7/28: 6:00pm, 9:30pm
const MAX_MOVIES = 25;

// Each showtime deep-links to AMC. On iOS with the AMC app installed this
// universal-links straight into the app; otherwise it opens the website.
const AMC = 'https://www.amctheatres.com';
export const showtimeUrl = (id) => `${AMC}/showtimes/${id}`;

// Build a movie → format → date → [{t,id}] tree. Rows are sorted by start time
// first, so every level comes out in chronological / earliest-first order.
function groupRows(newRows) {
  const rows = [...newRows].sort((a, b) => (a.dt || '').localeCompare(b.dt || ''));
  const movies = new Map();
  for (const r of rows) {
    const mv = r.movie || 'Other';
    const fmt = r.format || ''; // '' = standard/no premium format
    const d = r.dt ? localDate(r.dt) : r.date;
    if (!movies.has(mv)) movies.set(mv, new Map());
    const byFmt = movies.get(mv);
    if (!byFmt.has(fmt)) byFmt.set(fmt, new Map());
    const byDate = byFmt.get(fmt);
    if (!byDate.has(d)) byDate.set(d, []);
    // Time shown: an explicit r.timeLabel (LC's pre-formatted "2:00pm"/"Multiple
    // Times") wins; otherwise render r.dt (UTC ISO) to ET. r.url = per-showtime
    // deep link (FLC/TDF/LC); else fall back to AMC.
    const t = r.timeLabel != null ? r.timeLabel : r.dt ? localTime(r.dt) : '?';
    byDate.get(d).push({ t, id: r.id, url: r.url || showtimeUrl(r.id) });
  }
  return movies;
}

// "Sat 7/25: 6:00am, 2:00pm · Sun 7/26: 6:00am"  (render=each time -> string)
const joinDates = (byDate, render) =>
  [...byDate].map(([d, times]) => `${d}: ${times.map(render).join(', ')}`).join(' · ');

// Compact plain-text body for the ntfy push (single newlines are fine there).
export function formatAlert(newRows, theatreLabel, unit = 'movie') {
  const n = newRows.length;
  const movies = [...groupRows(newRows)];
  const blocks = movies.slice(0, MAX_MOVIES).map(([movie, byFmt]) => {
    const lines = [...byFmt].map(([fmt, byDate]) => {
      const seg = joinDates(byDate, (x) => x.t);
      return fmt ? `  ${fmt} — ${seg}` : `  ${seg}`;
    });
    return `🎬 ${movie}\n${lines.join('\n')}`;
  });
  if (movies.length > MAX_MOVIES) blocks.push(`…+${movies.length - MAX_MOVIES} more ${unit}s`);
  const header = `${theatreLabel} — ${n} new showtime${n === 1 ? '' : 's'} · ${movies.length} ${unit}${movies.length === 1 ? '' : 's'}`;
  return `${header}\n\n${blocks.join('\n')}`;
}

// Proper markdown for HISTORY.md: bold movie, a bold format sub-bullet per
// format, and every time a link to its showtime. Renders cleanly on GitHub and
// each link opens the AMC app/site.
export function formatHistoryMarkdown(newRows, theatreLabel, unit = 'movie') {
  const n = newRows.length;
  const movies = [...groupRows(newRows)];
  const out = [`**${theatreLabel}** — ${n} new showtime${n === 1 ? '' : 's'} across ${movies.length} ${unit}${movies.length === 1 ? '' : 's'}`, ''];
  for (const [movie, byFmt] of movies) {
    out.push(`**${movie}**`);
    for (const [fmt, byDate] of byFmt) {
      const seg = joinDates(byDate, (x) => `[${x.t}](${x.url})`);
      out.push(fmt ? `- **${fmt}** — ${seg}` : `- ${seg}`);
    }
    out.push('');
  }
  return out.join('\n').trim();
}

// Friendly labels for AMC status codes (extend as needed).
const STATUS_LABELS = {
  comingsoon: 'Available Soon',
  sellable: 'On Sale',
  almostfull: 'Almost Full',
  soldout: 'Sold Out',
  available: 'Available',
  standby: 'Standby',
  limited: 'Limited',
};
const statusLabel = (s) => STATUS_LABELS[String(s || '').toLowerCase()] || s || '?';

// Alert for status TRANSITIONS (e.g. Available Soon → On Sale, → Sold Out).
// Returns { text } for ntfy and { md } for HISTORY. Rows carry prevStatus.
export function formatStatusChanges(changed, theatreLabel) {
  const byMovie = new Map();
  for (const r of [...changed].sort((a, b) => (a.dt || '').localeCompare(b.dt || ''))) {
    const k = r.movie || 'Other';
    if (!byMovie.has(k)) byMovie.set(k, []);
    byMovie.get(k).push(r);
  }
  const whenOf = (r) => `${r.dt ? localDate(r.dt) : r.date} ${r.timeLabel != null ? r.timeLabel : r.dt ? localTime(r.dt) : ''}`.trim();
  const transition = (r) => `${statusLabel(r.prevStatus)} → ${statusLabel(r.status)}`;
  const n = changed.length;

  const textBlocks = [...byMovie].slice(0, MAX_MOVIES).map(([m, rs]) => {
    const lines = rs.map((r) => `  ${r.format ? `${r.format} · ` : ''}${whenOf(r)}: ${transition(r)}`);
    return `🎟️ ${m}\n${lines.join('\n')}`;
  });
  const text = `${theatreLabel} — ${n} status change${n === 1 ? '' : 's'}\n\n${textBlocks.join('\n')}`;

  const out = [`**${theatreLabel}** — ${n} status change${n === 1 ? '' : 's'}`, ''];
  for (const [m, rs] of byMovie) {
    out.push(`**${m}**`);
    for (const r of rs) out.push(`- [${whenOf(r)}](${r.url || showtimeUrl(r.id)})${r.format ? ` — ${r.format}` : ''}: ${transition(r)}`);
    out.push('');
  }
  return { text, md: out.join('\n').trim() };
}

const fmt = (iso, opts) => {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', ...opts }).format(new Date(iso));
  } catch {
    return iso;
  }
};
const localDate = (iso) => fmt(iso, { weekday: 'short', month: 'numeric', day: 'numeric' });
const localTime = (iso) => fmt(iso, { hour: 'numeric', minute: '2-digit' }).replace(' ', '').toLowerCase();
