// SQLite-backed "have I seen this showtime before?" store.
//
// Uses @libsql/client so the SAME async API works both locally (a plain file)
// and in CI/cloud (Turso serverless SQLite) — just change the URL:
//   local:  file:seen.db                (default)
//   cloud:  libsql://<db>.turso.io  + TURSO_AUTH_TOKEN
// This avoids native-module rebuilds in GitHub Actions.

import { createClient } from '@libsql/client';

export async function openDb({ url, authToken }) {
  const db = createClient({ url, authToken });

  // Every showtime we've ever seen (first_seen = when it first appeared).
  await db.execute(`
    CREATE TABLE IF NOT EXISTS seen_showtimes (
      showtime_id TEXT PRIMARY KEY,
      date        TEXT NOT NULL,
      show_dt_utc TEXT,
      status      TEXT,
      movie       TEXT,
      first_seen  TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // One row per "drop" (a batch of new showtimes we alerted on). This is the
  // durable history you can scroll back through if you miss the SMS.
  await db.execute(`
    CREATE TABLE IF NOT EXISTS drops (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      detected_at  TEXT NOT NULL DEFAULT (datetime('now')),
      count        INTEGER NOT NULL,
      showtime_ids TEXT,   -- JSON array of the new showtime ids
      summary      TEXT    -- the exact SMS body that was sent
    )
  `);

  return {
    raw: db,

    // Insert a batch, return only the genuinely-new rows (INSERT OR IGNORE +
    // changes count). Runs as one transaction/batch for speed and atomicity.
    async insertNew(rows) {
      if (!rows.length) return [];

      // Which ids already exist? (one round-trip)
      const ids = rows.map((r) => r.id);
      const placeholders = ids.map(() => '?').join(',');
      const existing = await db.execute({
        sql: `SELECT showtime_id FROM seen_showtimes WHERE showtime_id IN (${placeholders})`,
        args: ids,
      });
      const seen = new Set(existing.rows.map((r) => String(r.showtime_id)));
      const fresh = rows.filter((r) => !seen.has(String(r.id)));
      if (!fresh.length) return [];

      await db.batch(
        fresh.map((r) => ({
          sql: `INSERT OR IGNORE INTO seen_showtimes (showtime_id, date, show_dt_utc, status, movie)
                VALUES (?, ?, ?, ?, ?)`,
          args: [r.id, r.date, r.dt ?? null, r.status ?? null, r.movie ?? null],
        })),
        'write'
      );
      return fresh;
    },

    // Log a drop event (call after a successful alert).
    async recordDrop(rows, summary) {
      await db.execute({
        sql: `INSERT INTO drops (count, showtime_ids, summary) VALUES (?, ?, ?)`,
        args: [rows.length, JSON.stringify(rows.map((r) => r.id)), summary],
      });
    },

    // Most-recent drop events, newest first.
    async recentDrops(limit = 20) {
      const res = await db.execute({
        sql: `SELECT id, detected_at, count, summary FROM drops ORDER BY id DESC LIMIT ?`,
        args: [limit],
      });
      return res.rows;
    },

    // Showtimes first seen since a given ISO timestamp (per-showtime history).
    async newSince(sinceIso, limit = 200) {
      const res = await db.execute({
        sql: `SELECT showtime_id, date, show_dt_utc, status, movie, first_seen
              FROM seen_showtimes WHERE first_seen >= ? ORDER BY first_seen DESC LIMIT ?`,
        args: [sinceIso, limit],
      });
      return res.rows;
    },

    close: () => db.close(),
  };
}
