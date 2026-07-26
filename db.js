// State store backed by plain JSON files committed to the repo. No external
// service or signup: the GitHub Actions runner reads these at start and commits
// them back at the end (see the workflow). Durable, free, and human-browsable.
//
//   seen.json   — every showtime id we've seen (dedup source of truth)
//   drops.json  — machine log of every alert batch
//   HISTORY.md  — same log, human-readable, so you can scroll it on GitHub
//
// Same async API the rest of the app expects.

import { readFile, writeFile, rename } from 'node:fs/promises';

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return fallback;
    throw e;
  }
}

// Write atomically (temp + rename) so a crash mid-write can't corrupt state.
async function writeJson(path, data) {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2));
  await rename(tmp, path);
}

const nowIso = () => new Date().toISOString();

// Human-readable Eastern timestamp for the history log header.
function readableStamp() {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      weekday: 'short', month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit',
    }).format(new Date()) + ' ET';
  } catch {
    return nowIso();
  }
}

export async function openDb({ stateFile = 'seen.json', dropsFile = 'drops.json', historyFile = 'HISTORY.md', historyTitle = 'Showtimes' } = {}) {
  // seen: { [showtimeId]: {date, dt, status, movie, first_seen} }
  const seen = await readJson(stateFile, {});
  const drops = await readJson(dropsFile, []);

  return {
    // Returns { fresh, changed }:
    //  • fresh   = rows whose id we've never seen (new showtimes)
    //  • changed = rows whose status changed since last seen (e.g. ComingSoon →
    //              Sellable, Sellable → AlmostFull → SoldOut), each with prevStatus
    async insertNew(rows) {
      const fresh = [];
      const changed = [];
      for (const r of rows) {
        const prev = seen[r.id];
        if (!prev) {
          seen[r.id] = {
            date: r.date,
            dt: r.dt ?? null,
            status: r.status ?? null,
            movie: r.movie ?? null,
            first_seen: nowIso(),
          };
          fresh.push(r);
        } else if (r.status != null && prev.status !== r.status) {
          changed.push({ ...r, prevStatus: prev.status ?? null });
          prev.status = r.status;
          prev.status_changed = nowIso();
        }
      }
      if (fresh.length || changed.length) await writeJson(stateFile, seen);
      return { fresh, changed };
    },

    async recordDrop(rows, summary, markdown) {
      const entry = {
        detected_at: nowIso(),
        count: rows.length,
        showtime_ids: rows.map((r) => r.id),
        summary,
      };
      drops.push(entry);
      await writeJson(dropsFile, drops);

      // Prepend a clean markdown block (newest first) to the human-readable log.
      const stamp = readableStamp();
      const block = `## ${stamp} · ${entry.count} new\n\n${markdown || summary}\n`;
      const header = `# ${historyTitle} — drop history\n\n`;
      let existing = '';
      try {
        existing = await readFile(historyFile, 'utf8');
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
      const prior = existing.startsWith(header) ? existing.slice(header.length) : existing;
      await writeFile(historyFile, `${header}${block}\n${prior}`.trimEnd() + '\n');
    },

    async recentDrops(limit = 20) {
      return [...drops].reverse().slice(0, limit).map((d, i) => ({
        id: drops.length - i,
        detected_at: d.detected_at,
        count: d.count,
        summary: d.summary,
      }));
    },

    async newSince(sinceIso, limit = 500) {
      return Object.entries(seen)
        .filter(([, v]) => v.first_seen >= sinceIso)
        .sort((a, b) => b[1].first_seen.localeCompare(a[1].first_seen))
        .slice(0, limit)
        .map(([id, v]) => ({ showtime_id: id, ...v }));
    },

    close() {},
  };
}
