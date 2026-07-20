/**
 * log - chat and command logging to rotating files (port of log.py).
 *
 * Writes "[YYYY-MM-DD HH:MM:SS] message" lines to <dir>/chat.log with
 * simple size-based rotation (chat.log -> chat.log.1 -> ... -> chat.log.N),
 * mirroring Python's RotatingFileHandler. The directory defaults to
 * "chatlogs/" relative to the working directory.
 */
import type { Plugin } from "../runtime/src/plugin";
import { Priority } from "../runtime/src/constants";
import { cleanText } from "../runtime/src/util";
import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import path from "node:path";

/** Was qlx_chatlogs. */
const DEFAULT_MAX_LOGS = 3;
/** Was qlx_chatlogsSize (3 MB). */
const DEFAULT_MAX_SIZE = 3_000_000;

function stringSetting(value: unknown, fallback: string): string {
  return value === undefined || value === null ? fallback : String(value);
}

function numberSetting(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  return value !== undefined && value !== null && Number.isFinite(n) ? n : fallback;
}

function timestamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
}

export default {
  name: "log",

  setup(ctx) {
    const dir = stringSetting(ctx.config.dir, "chatlogs");
    const maxLogs = numberSetting(ctx.config.max_logs, DEFAULT_MAX_LOGS);
    const maxSize = numberSetting(ctx.config.max_size, DEFAULT_MAX_SIZE);

    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "chat.log");

    function rotate(): void {
      if (maxLogs < 1) {
        rmSync(file, { force: true });
        return;
      }
      rmSync(`${file}.${maxLogs}`, { force: true });
      for (let i = maxLogs - 1; i >= 1; i--) {
        if (existsSync(`${file}.${i}`)) renameSync(`${file}.${i}`, `${file}.${i + 1}`);
      }
      renameSync(file, `${file}.1`);
    }

    function write(msg: string): void {
      const line = `[${timestamp()}] ${msg}\n`;
      const size = Bun.file(file).size;
      if (size > 0 && size + Buffer.byteLength(line) > maxSize) rotate();
      appendFileSync(file, line, "utf8");
    }

    write(`============================= Logger started @ ${new Date().toISOString()} =============================`);

    ctx.on(
      "player_connect",
      (player) => {
        write(`${player.cleanName}:${player.steamId}:${player.ip} connected.`);
      },
      Priority.Lowest,
    );

    ctx.on(
      "player_disconnect",
      (player, reason) => {
        if (reason && !["?", "!", "."].includes(reason[reason.length - 1]!)) {
          reason += ".";
        }
        write(cleanText(`${player}:${player.steamId} ${reason}`));
      },
      Priority.Lowest,
    );

    ctx.on(
      "chat",
      (player, msg, channel) => {
        const channelName = channel.name !== "chat" ? `[${channel.name.toUpperCase()}] ` : "";
        write(cleanText(`${channelName}<${player}:${player.steamId}> ${msg}`));
      },
      Priority.Lowest,
    );

    ctx.on(
      "command",
      (caller, _cmd, msg) => {
        write(cleanText(`[CMD] <${caller}:${caller.steamId}> ${msg}`));
      },
      Priority.Lowest,
    );
  },
} satisfies Plugin;
