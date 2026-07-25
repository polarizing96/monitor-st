// SMS notifier. Uses Twilio if fully configured; otherwise logs to console so
// the pipeline is testable without credentials.

import twilio from 'twilio';

export function makeNotifier(cfg) {
  const ready = cfg.accountSid && cfg.authToken && cfg.from && cfg.to;
  const client = ready ? twilio(cfg.accountSid, cfg.authToken) : null;

  return {
    ready,
    async send(text) {
      if (!ready) {
        console.log(`[sms:dry-run] ${text}`);
        return;
      }
      // Twilio SMS segments at 1600 chars; keep messages short.
      const body = text.length > 1500 ? text.slice(0, 1497) + '...' : text;
      await client.messages.create({ from: cfg.from, to: cfg.to, body });
    },
  };
}

// Turn a list of new showtimes into a compact SMS body.
export function formatAlert(newRows, theatreLabel) {
  const n = newRows.length;
  const lines = newRows.slice(0, 8).map((r) => {
    const when = r.dt ? isoToLocalShort(r.dt) : r.date;
    const movie = r.movie ? ` ${r.movie}` : '';
    return `• ${when}${movie} (#${r.id})`;
  });
  const more = n > 8 ? `\n…+${n - 8} more` : '';
  return `${theatreLabel}: ${n} new showtime${n === 1 ? '' : 's'}\n${lines.join('\n')}${more}`;
}

function isoToLocalShort(iso) {
  // Render in America/New_York (the theatre's local zone) without pulling a tz lib.
  try {
    const d = new Date(iso);
    return new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      weekday: 'short',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }).format(d);
  } catch {
    return iso;
  }
}
