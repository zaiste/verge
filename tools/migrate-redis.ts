#!/usr/bin/env bun
/**
 * One-shot best-effort migration of a minqlx Redis database into the
 * SQLite kv store. Copies all string keys under minqlx:* (permissions,
 * flags, clan tags), preserving TTLs, and converts minqlx's zset-based
 * bans/silences (ban.py/silence.py stored a zset of ids scored by expiry
 * plus a hash per id) into verge's single JSON record with a TTL.
 *
 *   bun tools/migrate-redis.ts [redis-url] [sqlite-path]
 *   e.g. bun tools/migrate-redis.ts redis://localhost:6379/0 verge.db
 *
 * Other non-string types (sets/zsets used by some third-party plugins)
 * are reported but not migrated.
 */
import { RedisClient } from "bun";
import { Db } from "../runtime/src/db";

const redisUrl = process.argv[2] ?? "redis://localhost:6379";
const sqlitePath = process.argv[3] ?? "verge.db";

const redis = new RedisClient(redisUrl);
const db = new Db(sqlitePath, "");

let migrated = 0;
const skipped: string[] = [];

// minqlx:players:<sid>:bans / :silences zsets; their per-id detail hashes
// are consumed by the conversion, not skipped.
const PUNISH_ZSET_RE = /^minqlx:players:(\d+):(bans|silences)$/;
const PUNISH_HASH_RE = /^minqlx:players:\d+:(bans|silences):\d+$/;
const punishments: { key: string; sid: string; kind: "bans" | "silences" }[] = [];

/** HGETALL comes back as a flat [field, value, ...] array or an object,
 * depending on protocol version. */
function toRecord(reply: unknown): Record<string, string> {
  if (Array.isArray(reply)) {
    const out: Record<string, string> = {};
    for (let i = 0; i + 1 < reply.length; i += 2) out[String(reply[i])] = String(reply[i + 1]);
    return out;
  }
  return (reply ?? {}) as Record<string, string>;
}

let cursor = "0";
do {
  const [next, keys] = (await redis.send("SCAN", [cursor, "MATCH", "minqlx:*", "COUNT", "500"])) as [
    string,
    string[],
  ];
  cursor = next;
  for (const key of keys) {
    const type = (await redis.send("TYPE", [key])) as string;
    if (type === "string") {
      const value = await redis.get(key);
      if (value === null) continue;
      const pttl = (await redis.send("PTTL", [key])) as number;
      // The kv scheme is otherwise unchanged; only the namespace is renamed.
      const target = `verge:${key.slice("minqlx:".length)}`;
      db.set(target, value, pttl > 0 ? { ttl: Math.ceil(pttl / 1000) } : undefined);
      migrated++;
      continue;
    }
    const zm = PUNISH_ZSET_RE.exec(key);
    if (type === "zset" && zm) {
      punishments.push({ key, sid: zm[1]!, kind: zm[2] as "bans" | "silences" });
      continue;
    }
    if (type === "hash" && PUNISH_HASH_RE.test(key)) continue; // handled via its zset
    skipped.push(`${key} (${type})`);
  }
} while (cursor !== "0");

// Convert the longest still-active ban/silence per player (matching ban.py's
// is_banned, which honored the latest-expiring entry).
const nowSec = Date.now() / 1000;
let converted = 0;
for (const { key, sid, kind } of punishments) {
  const entries = (await redis.send("ZRANGEBYSCORE", [
    key,
    String(nowSec),
    "+inf",
    "WITHSCORES",
  ])) as string[];
  let best: { id: string; score: number } | null = null;
  for (let i = 0; i + 1 < entries.length; i += 2) {
    const score = Number(entries[i + 1]);
    if (!best || score > best.score) best = { id: String(entries[i]), score };
  }
  if (!best) continue; // no active entry; nothing to carry over
  const hash = toRecord(await redis.send("HGETALL", [`${key}:${best.id}`]));
  const record = {
    expires: hash.expires ?? "",
    reason: hash.reason ?? "",
    issued: hash.issued ?? "",
    issuedBy: hash.issued_by ?? "",
  };
  const target = `verge:players:${sid}:${kind === "bans" ? "ban" : "silence"}`;
  db.set(target, JSON.stringify(record), { ttl: Math.ceil(best.score - nowSec) });
  converted++;
}

console.log(`Migrated ${migrated} keys from ${redisUrl} to ${sqlitePath}.`);
if (converted > 0) console.log(`Converted ${converted} active ban/silence record(s).`);
if (skipped.length > 0) {
  console.log(`Skipped ${skipped.length} non-string keys:`);
  for (const s of skipped) console.log(`  - ${s}`);
}
redis.close();
db.close();
