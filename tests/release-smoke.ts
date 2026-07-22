#!/usr/bin/env bun
/**
 * Release-artifact smoke test: boots the *packaged* runtime under the
 * *packaged* bun against a fake shim socket and asserts it speaks the
 * protocol (a well-formed hello as the first frame). This is the only gate
 * that exercises the tarball's contents rather than a fresh build.
 *
 *   bun tests/release-smoke.ts /path/to/extracted-tarball
 */
import { tmpdir } from "node:os";

const pkg = process.argv[2];
if (!pkg) {
  console.error("usage: bun tests/release-smoke.ts <extracted-tarball-dir>");
  process.exit(2);
}

const sockPath = `${tmpdir()}/verge-smoke-${process.pid}.sock`;
let buffer = "";
let resolveHello!: (msg: Record<string, unknown>) => void;
const hello = new Promise<Record<string, unknown>>((r) => (resolveHello = r));

Bun.listen<undefined>({
  unix: sockPath,
  socket: {
    data(_s, chunk) {
      buffer += new TextDecoder().decode(chunk);
      const line = buffer.split("\n")[0];
      if (buffer.includes("\n") && line) resolveHello(JSON.parse(line));
    },
  },
});

const child = Bun.spawn([`${pkg}/bun`, "verge/main.js"], {
  cwd: pkg,
  env: { ...process.env, VERGE_SOCKET: sockPath, VERGE_DATABASE: ":memory:" },
  stdout: "inherit",
  stderr: "inherit",
});

const timeout = new Promise<never>((_, reject) =>
  setTimeout(() => reject(new Error("no hello within 30 s")), 30000),
);

try {
  const msg = await Promise.race([hello, timeout]);
  if (msg.t !== "hello" || !Array.isArray(msg.subs) || (msg.subs as unknown[]).length === 0) {
    throw new Error(`first frame is not a valid hello: ${JSON.stringify(msg).slice(0, 200)}`);
  }
  console.log(`[smoke] OK: packaged runtime sent hello with ${(msg.subs as unknown[]).length} subscriptions.`);
  process.exit(0);
} catch (e) {
  console.error(`[smoke] FAIL: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
} finally {
  child.kill();
}
