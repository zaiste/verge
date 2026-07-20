/**
 * Low-level message delivery: formats and sends `print` server commands,
 * splitting long messages and carrying color codes across lines (port of
 * ChatChannel.reply).
 */
import type { Engine } from "./engine";
import { splitLongLines } from "./util";

const MAX_MSG_LENGTH = 1000;
const COLOR_TAG_RE = /\^[^^]/g;

/**
 * Sends a print message to specific clients, or to everyone when
 * `targets` is null.
 */
export async function sendPrint(
  engine: Engine,
  targets: number[] | null,
  msg: string,
  limit = 100,
  delimiter = " ",
): Promise<void> {
  // The engine doesn't support escaping double quotes.
  msg = String(msg).replace(/"/g, "'");
  let lastColor = "";

  const split = splitLongLines(msg, limit, delimiter);
  // Join split lines back up to ~1000 bytes per server command.
  const joined: string[] = [];
  for (const s of split) {
    const last = joined[joined.length - 1];
    if (last === undefined) {
      joined.push(s);
    } else {
      const merged = last + "\n" + s;
      if (new TextEncoder().encode(merged).length > MAX_MSG_LENGTH) joined.push(s);
      else joined[joined.length - 1] = merged;
    }
  }

  for (const s of joined) {
    const cmd = `print "${lastColor + s}\n"\n`;
    if (targets === null) {
      await engine.rpc("send_server_command", null, cmd);
    } else {
      for (const cid of targets) {
        await engine.rpc("send_server_command", cid, cmd);
      }
    }
    const colors = s.match(COLOR_TAG_RE);
    if (colors && colors.length > 0) lastColor = colors[colors.length - 1]!;
  }
}

/** Center-print (the big text in the middle of the screen). */
export function centerPrint(engine: Engine, targets: number[] | null, msg: string): Promise<unknown> {
  const cmd = `cp "${String(msg).replace(/"/g, "'")}"\n`;
  if (targets === null) return engine.rpc("send_server_command", null, cmd);
  return Promise.all(targets.map((cid) => engine.rpc("send_server_command", cid, cmd)));
}
