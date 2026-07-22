/**
 * Persistent state on bun:sqlite, replacing Redis. One kv table with
 * optional expiry covers everything the plugins need (permissions, bans,
 * mutes, flags). Key names mirror the Redis scheme minqlx used under a
 * "verge:" namespace, so importing an old database is a prefix rename
 * (see tools/migrate-redis.ts).
 */
import { Database } from "bun:sqlite";
import type { SteamId } from "./protocol";

export class Db {
  private db: Database;
  private getStmt;
  private setStmt;
  private delStmt;
  private keysStmt;

  constructor(
    path: string,
    private owner: SteamId,
  ) {
    this.db = new Database(path, { create: true });
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run(`CREATE TABLE IF NOT EXISTS kv (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      expires_at INTEGER
    )`);
    this.getStmt = this.db.query<{ value: string; expires_at: number | null }, [string]>(
      "SELECT value, expires_at FROM kv WHERE key = ?",
    );
    this.setStmt = this.db.query(
      "INSERT INTO kv (key, value, expires_at) VALUES (?, ?, ?) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at",
    );
    this.delStmt = this.db.query("DELETE FROM kv WHERE key = ?");
    this.keysStmt = this.db.query<{ key: string }, [string, number]>(
      "SELECT key FROM kv WHERE key GLOB ? AND (expires_at IS NULL OR expires_at > ?)",
    );
  }

  get(key: string): string | null {
    const row = this.getStmt.get(key);
    if (!row) return null;
    if (row.expires_at !== null && row.expires_at <= Date.now()) {
      this.delStmt.run(key);
      return null;
    }
    return row.value;
  }

  /** @param ttl time-to-live in seconds; omit for no expiry. A ttl of 0 (or
   * negative) writes an already-expired row, not a permanent one. */
  set(key: string, value: string | number, opts?: { ttl?: number }): void {
    const expiresAt = opts?.ttl !== undefined ? Date.now() + opts.ttl * 1000 : null;
    this.setStmt.run(key, String(value), expiresAt);
  }

  del(key: string): void {
    this.delStmt.run(key);
  }

  has(key: string): boolean {
    return this.get(key) !== null;
  }

  /** Remaining TTL in seconds, or null if the key has no expiry / is gone. */
  ttl(key: string): number | null {
    const row = this.getStmt.get(key);
    if (!row || row.expires_at === null) return null;
    const remaining = Math.ceil((row.expires_at - Date.now()) / 1000);
    return remaining > 0 ? remaining : null;
  }

  /** Keys matching a glob pattern (e.g. "verge:players:*:permission"). */
  keys(pattern: string): string[] {
    return this.keysStmt.all(pattern, Date.now()).map((r) => r.key);
  }

  /** Deletes expired rows; called periodically from the runtime. */
  sweep(): number {
    return this.db.run("DELETE FROM kv WHERE expires_at IS NOT NULL AND expires_at <= ?", [
      Date.now(),
    ]).changes;
  }

  close(): void {
    this.db.close();
  }

  // ---- permissions & flags (Redis-era key scheme) ----

  getPermission(steamId: SteamId): number {
    if (this.owner && steamId === this.owner) return 5;
    const val = this.get(`verge:players:${steamId}:permission`);
    return val === null ? 0 : parseInt(val, 10) || 0;
  }

  setPermission(steamId: SteamId, level: number): void {
    this.set(`verge:players:${steamId}:permission`, level);
  }

  hasPermission(steamId: SteamId, level = 5): boolean {
    return this.getPermission(steamId) >= level;
  }

  setFlag(steamId: SteamId, flag: string, value = true): void {
    this.set(`verge:players:${steamId}:flags:${flag}`, value ? 1 : 0);
  }

  getFlag(steamId: SteamId, flag: string, defaultValue = false): boolean {
    const val = this.get(`verge:players:${steamId}:flags:${flag}`);
    return val === null ? defaultValue : Boolean(parseInt(val, 10));
  }
}
