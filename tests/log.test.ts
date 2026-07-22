import { afterEach, expect, test } from "bun:test";
import { createTestServer } from "../testkit/src/fixtures";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function logDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "verge-log-"));
  dirs.push(dir);
  return dir;
}

const readLog = (dir: string) => readFileSync(path.join(dir, "chat.log"), "utf8");

test("connects, chat, commands and disconnects are all logged", async () => {
  const dir = logDir();
  // fun comes along only to supply a real command for the [CMD] line.
  const server = await createTestServer({
    plugins: ["log", "fun"],
    pluginConfig: { log: { dir } },
  });

  const a = await server.connect({ name: "Keel" });
  await server.chat(a.info.clientId, "hello everyone");
  await server.chat(a.info.clientId, "!cookies");
  await server.disconnect(a.info.clientId, "ragequit");

  const text = readLog(dir);
  expect(text).toContain("Logger started");
  expect(text).toContain(`Keel:${a.info.steamId}`);
  expect(text).toContain("connected.");
  expect(text).toContain(`<Keel(${a.info.clientId}):${a.info.steamId}> hello everyone`);
  expect(text).toContain("[CMD]");
  expect(text).toContain("ragequit.");
});

test("each line carries a timestamp", async () => {
  const dir = logDir();
  const server = await createTestServer({ plugins: ["log"], pluginConfig: { log: { dir } } });
  const a = await server.connect({ name: "A" });
  await server.chat(a.info.clientId, "timestamped");

  for (const line of readLog(dir).trim().split("\n")) {
    expect(line).toMatch(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}] /);
  }
});

test("colour codes are stripped from logged names and messages", async () => {
  const dir = logDir();
  const server = await createTestServer({ plugins: ["log"], pluginConfig: { log: { dir } } });
  const a = await server.connect({ name: "^1Red^7Name" });
  await server.chat(a.info.clientId, "^3coloured message");

  const text = readLog(dir);
  expect(text).toContain("RedName");
  expect(text).toContain("coloured message");
  expect(text).not.toContain("^1");
  expect(text).not.toContain("^3");
});

test("the log rotates once it would exceed max_size", async () => {
  const dir = logDir();
  const server = await createTestServer({
    plugins: ["log"],
    // Small enough that the startup banner alone nearly fills it.
    pluginConfig: { log: { dir, max_size: 200, max_logs: 2 } },
  });
  const a = await server.connect({ name: "A" });
  for (let i = 0; i < 5; i++) await server.chat(a.info.clientId, `message number ${i}`);

  expect(existsSync(path.join(dir, "chat.log"))).toBe(true);
  expect(existsSync(path.join(dir, "chat.log.1"))).toBe(true);
  // max_logs is honoured: rotation never creates a third generation.
  expect(existsSync(path.join(dir, "chat.log.3"))).toBe(false);
  // The live log holds the most recent line.
  expect(readLog(dir)).toContain("message number 4");
});
