#!/usr/bin/env bun
/**
 * One-shot best-effort migration of a minqlx Redis database into the
 * SQLite kv store. Copies all string keys under minqlx:* (permissions,
 * flags, bans, mutes, clan tags), preserving TTLs.
 *
 *   bun tools/migrate-redis.ts [redis-url] [sqlite-path]
 *   e.g. bun tools/migrate-redis.ts redis://localhost:6379/0 verge.db
 *
 * Non-string types (sets/zsets used by some third-party plugins) are
 * reported but not migrated.
 */
import { RedisClient } from "bun";
import { Db } from "../runtime/src/db";

const redisUrl = process.argv[2] ?? "redis://localhost:6379";
const sqlitePath = process.argv[3] ?? "verge.db";

const redis = new RedisClient(redisUrl);
const db = new Db(sqlitePath, "");

let migrated = 0;
const skipped: string[] = [];

let cursor = "0";
do {
  const [next, keys] = (await redis.send("SCAN", [cursor, "MATCH", "minqlx:*", "COUNT", "500"])) as [
    string,
    string[],
  ];
  cursor = next;
  for (const key of keys) {
    const type = (await redis.send("TYPE", [key])) as string;
    if (type !== "string") {
      skipped.push(`${key} (${type})`);
      continue;
    }
    const value = await redis.get(key);
    if (value === null) continue;
    const pttl = (await redis.send("PTTL", [key])) as number;
    // The kv scheme is otherwise unchanged; only the namespace is renamed.
    const target = `verge:${key.slice("minqlx:".length)}`;
    db.set(target, value, pttl > 0 ? { ttl: Math.ceil(pttl / 1000) } : undefined);
    migrated++;
  }
} while (cursor !== "0");

console.log(`Migrated ${migrated} keys from ${redisUrl} to ${sqlitePath}.`);
if (skipped.length > 0) {
  console.log(`Skipped ${skipped.length} non-string keys:`);
  for (const s of skipped) console.log(`  - ${s}`);
}
redis.close();
db.close();
