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
    const url = `${cfg.ntfyServer.replace(/\/$/, '')}/${cfg.ntfyTopic}`;
    return {
      ready: true,
      channel: 'ntfy',
      async send(text, title = 'AMC showtimes') {
        const res = await fetch(url, {
          method: 'POST',
          body: text,
          headers: { Title: title, Priority: 'high', Tags: 'clapper,ticket' },
        });
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
const MAX_MOVIES = 20;

export function formatAlert(newRows, theatreLabel) {
  const n = newRows.length;

  const byMovie = new Map();
  for (const r of newRows) {
    const key = r.movie || 'Other';
    if (!byMovie.has(key)) byMovie.set(key, []);
    byMovie.get(key).push(r);
  }

  const earliest = (rows) => rows.reduce((min, r) => (r.dt && r.dt < min ? r.dt : min), '9999');
  const movies = [...byMovie.entries()].sort((a, b) => earliest(a[1]).localeCompare(earliest(b[1])));

  const blocks = movies.slice(0, MAX_MOVIES).map(([movie, rows]) => {
    const byDate = new Map();
    for (const r of [...rows].sort((x, y) => (x.dt || '').localeCompare(y.dt || ''))) {
      const d = r.dt ? localDate(r.dt) : r.date;
      if (!byDate.has(d)) byDate.set(d, []);
      byDate.get(d).push(r.dt ? localTime(r.dt) : '?');
    }
    const dateLines = [...byDate.entries()].map(([d, times]) => `  ${d}: ${times.join(', ')}`);
    return `🎬 ${movie} (${rows.length})\n${dateLines.join('\n')}`;
  });
  if (movies.length > MAX_MOVIES) blocks.push(`…+${movies.length - MAX_MOVIES} more movies`);

  const header = `${theatreLabel} — ${n} new showtime${n === 1 ? '' : 's'} · ${byMovie.size} movie${byMovie.size === 1 ? '' : 's'}`;
  return `${header}\n\n${blocks.join('\n')}`;
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
