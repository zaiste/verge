/**
 * Configuration: one verge.toml in the server directory, replacing the
 * qlx_* cvar sprawl. Environment variables win over the file:
 * VERGE_OWNER, VERGE_PLUGINS (comma-separated), VERGE_DATABASE.
 */
import { log } from "./util";

export interface ServerConfig {
  /** SteamID64 of the owner (permission level 5). Mandatory. */
  owner: string;
  plugins: string[];
  commandPrefix: string;
  database: string;
}

export interface StatsConfig {
  enabled: boolean;
  password: string;
}

export interface FeatureFlags {
  /** Steam Workshop item ids forced onto connecting clients (was workshop.py). */
  workshop: string[];
  /** Keep a race server running with < 2 players (was solorace.py). */
  solorace: boolean;
}

export interface Config {
  server: ServerConfig;
  stats: StatsConfig;
  features: FeatureFlags;
  /** Per-plugin sections: [plugin.<name>] in the TOML. */
  plugin: Record<string, Record<string, unknown>>;
}

const DEFAULTS: Config = {
  server: {
    owner: "",
    plugins: ["admin", "identity", "motd", "log"],
    commandPrefix: "!",
    database: "verge.db",
  },
  stats: { enabled: true, password: "" },
  features: { workshop: [], solorace: false },
  plugin: {},
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export async function loadConfig(path = process.env.VERGE_CONFIG ?? "verge.toml"): Promise<Config> {
  let raw: Record<string, unknown> = {};
  const file = Bun.file(path);
  if (await file.exists()) {
    raw = Bun.TOML.parse(await file.text()) as Record<string, unknown>;
  } else {
    log.warn(`${path} not found; using defaults (set at least server.owner!).`);
  }

  const server = isRecord(raw.server) ? raw.server : {};
  const stats = isRecord(raw.stats) ? raw.stats : {};
  const pluginRaw = isRecord(raw.plugin) ? raw.plugin : {};
  const features = isRecord(pluginRaw.features) ? pluginRaw.features : {};

  const config: Config = {
    server: {
      owner: process.env.VERGE_OWNER ?? String(server.owner ?? DEFAULTS.server.owner),
      plugins: process.env.VERGE_PLUGINS
        ? process.env.VERGE_PLUGINS.split(",").map((s) => s.trim())
        : Array.isArray(server.plugins)
          ? server.plugins.map(String)
          : DEFAULTS.server.plugins,
      commandPrefix: String(server.command_prefix ?? DEFAULTS.server.commandPrefix),
      database: process.env.VERGE_DATABASE ?? String(server.database ?? DEFAULTS.server.database),
    },
    stats: {
      enabled: Boolean(stats.enabled ?? DEFAULTS.stats.enabled),
      password: String(stats.password ?? ""),
    },
    features: {
      workshop: Array.isArray(features.workshop) ? features.workshop.map(String) : [],
      solorace: Boolean(features.solorace ?? false),
    },
    plugin: Object.fromEntries(
      Object.entries(pluginRaw).filter(([k, v]) => k !== "features" && isRecord(v)),
    ) as Record<string, Record<string, unknown>>,
  };

  if (!config.server.owner) {
    log.warn("server.owner is not set: nobody has owner permissions!");
  }
  return config;
}
