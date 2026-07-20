const COLOR_TAG_RE = /\^[^^]/g;

/** Strips Quake color codes (^1, ^7, ...) from a string. */
export function cleanText(text: string): string {
  return text.replace(COLOR_TAG_RE, "");
}

/**
 * Parses a Quake variable string ("\key\value\key\value") into a Map.
 * Insertion order is preserved (Maps are ordered), which matters when the
 * string is serialized back (userinfo).
 */
export function parseVariables(varstr: string): Map<string, string> {
  const res = new Map<string, string>();
  if (!varstr.trim()) return res;
  const vars = varstr.replace(/^\\+/, "").split("\\");
  for (let i = 0; i + 1 < vars.length; i += 2) {
    res.set(vars[i]!, vars[i + 1]!);
  }
  if (vars.length % 2 !== 0) {
    log.warn(`Uneven number of keys and values: ${varstr}`);
  }
  return res;
}

/** Serializes a Map back into "\key\value\..." form. */
export function formatVariables(vars: Map<string, string>): string {
  let out = "";
  for (const [key, value] of vars) out += `\\${key}\\${value}`;
  return out;
}

/**
 * Splits a message into lines no longer than `limit`, breaking on
 * `delimiter` where possible (port of AbstractChannel.split_long_lines).
 */
export function splitLongLines(msg: string, limit = 100, delimiter = " "): string[] {
  const res: string[] = [];
  while (msg) {
    const nl = msg.indexOf("\n");
    if (nl >= 0 && nl <= limit) {
      res.push(msg.slice(0, nl));
      msg = msg.slice(nl + 1);
      continue;
    }
    if (msg.length < limit) {
      res.push(msg);
      break;
    }
    let length = 0;
    for (;;) {
      const i = msg.slice(length).indexOf(delimiter);
      if (i === -1 || i + length > limit) {
        if (!length) length = limit + 1;
        res.push(msg.slice(0, length - 1));
        msg = msg.slice(length + delimiter.length - 1);
        break;
      }
      length += i + 1;
    }
  }
  return res;
}

/** Timestamped logging to stdout/stderr (inherited by the server console). */
function stamp(): string {
  return new Date().toISOString().slice(11, 19);
}

export const log = {
  debug(...args: unknown[]) {
    if (process.env.MINQLX_DEBUG) console.log(`[minqlx ${stamp()}]`, ...args);
  },
  info(...args: unknown[]) {
    console.log(`[minqlx ${stamp()}]`, ...args);
  },
  warn(...args: unknown[]) {
    console.warn(`[minqlx ${stamp()}] WARNING:`, ...args);
  },
  error(...args: unknown[]) {
    console.error(`[minqlx ${stamp()}] ERROR:`, ...args);
  },
};
