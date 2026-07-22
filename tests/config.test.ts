/**
 * loadConfig: TOML parsing, defaulting, [plugin.*] sections, feature flags,
 * and environment overrides — previously bypassed by every fixture.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { unlinkSync, writeFileSync } from "node:fs";
import { loadConfig } from "../runtime/src/config";

const files: string[] = [];
const ENV_KEYS = ["VERGE_OWNER", "VERGE_PLUGINS", "VERGE_DATABASE"] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

function tomlFile(content: string): string {
  const path = `${tmpdir()}/verge-config-${process.pid}-${files.length}.toml`;
  writeFileSync(path, content);
  files.push(path);
  return path;
}

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  for (const f of files.splice(0)) {
    try {
      unlinkSync(f);
    } catch {}
  }
});

describe("loadConfig", () => {
  test("parses a full verge.toml", async () => {
    const path = tomlFile(`
[server]
owner = "76561198000000001"
plugins = ["admin", "fun"]
command_prefix = "."
database = "custom.db"

[stats]
enabled = false
password = "hunter2"

[plugin.features]
workshop = ["123", "456"]
solorace = true

[plugin.motd]
sound = false
delay_ms = 500
`);
    const config = await loadConfig(path);
    expect(config.server.owner).toBe("76561198000000001");
    expect(config.server.plugins).toEqual(["admin", "fun"]);
    expect(config.server.commandPrefix).toBe(".");
    expect(config.server.database).toBe("custom.db");
    expect(config.stats).toEqual({ enabled: false, password: "hunter2" });
    expect(config.features).toEqual({ workshop: ["123", "456"], solorace: true });
    expect(config.plugin.motd).toEqual({ sound: false, delay_ms: 500 });
    // "features" is a flag section, not a plugin.
    expect(config.plugin.features).toBeUndefined();
  });

  test("a missing file falls back to defaults", async () => {
    const config = await loadConfig(`${tmpdir()}/verge-no-such-file.toml`);
    expect(config.server.owner).toBe("");
    expect(config.server.plugins).toEqual(["admin", "identity", "motd", "log"]);
    expect(config.server.commandPrefix).toBe("!");
    expect(config.server.database).toBe("verge.db");
    expect(config.stats.enabled).toBe(true);
  });

  test("environment variables override the file", async () => {
    const path = tomlFile(`
[server]
owner = "76561198000000001"
plugins = ["admin"]
database = "file.db"
`);
    process.env.VERGE_OWNER = "76561198000000002";
    process.env.VERGE_PLUGINS = "fun, log";
    process.env.VERGE_DATABASE = ":memory:";

    const config = await loadConfig(path);
    expect(config.server.owner).toBe("76561198000000002");
    expect(config.server.plugins).toEqual(["fun", "log"]);
    expect(config.server.database).toBe(":memory:");
  });
});
