/** Test fixtures and the simulated-server harness. */
import { Runtime } from "../../runtime/src/runtime";
import type { Config } from "../../runtime/src/config";
import type { HookResult, PlayerInfo, SteamId } from "../../runtime/src/protocol";
import { CS_ACTIVE, TEAM_SPECTATOR, TEAMS } from "../../runtime/src/constants";
import { MockEngine } from "./mock-engine";
import path from "node:path";

export const OWNER_ID: SteamId = "76561198000000001";

let nextSteamId = 76561198100000000n;

export interface FakePlayerOpts {
  id?: number;
  name?: string;
  steamId?: SteamId;
  team?: (typeof TEAMS)[number];
  privileges?: number;
  userinfo?: string;
}

export function fakePlayerInfo(opts: FakePlayerOpts = {}): PlayerInfo {
  const name = opts.name ?? "TestPlayer";
  return {
    clientId: opts.id ?? 0,
    name,
    connectionState: CS_ACTIVE,
    userinfo: opts.userinfo ?? `\\name\\${name}\\cl_wwwDownload\\1`,
    steamId: opts.steamId ?? String(nextSteamId++),
    team: opts.team ? TEAMS.indexOf(opts.team) : TEAM_SPECTATOR,
    privileges: opts.privileges ?? 0,
  };
}

export interface TestServer {
  runtime: Runtime;
  engine: MockEngine;
  /** Adds a player and runs the connect + loaded events. */
  connect(opts?: FakePlayerOpts): Promise<{ info: PlayerInfo; rejection: HookResult | void }>;
  disconnect(id: number, reason?: string): Promise<void>;
  /** Sends a chat line (through the real say parsing). */
  chat(id: number, msg: string): Promise<HookResult | void>;
  clientCommand(id: number, cmd: string): Promise<HookResult | void>;
  newGame(): Promise<void>;
  /** All text sent to a client (or broadcast when id is null). */
  messagesTo(id: number | null): string[];
}

export async function createTestServer(opts: {
  plugins?: string[];
  pluginConfig?: Record<string, Record<string, unknown>>;
  owner?: SteamId;
} = {}): Promise<TestServer> {
  const engine = new MockEngine();
  const config: Config = {
    server: {
      owner: opts.owner ?? OWNER_ID,
      plugins: opts.plugins ?? [],
      commandPrefix: "!",
      database: ":memory:",
    },
    stats: { enabled: false, password: "" },
    features: { workshop: [], solorace: false },
    plugin: opts.pluginConfig ?? {},
  };
  const pluginsDir = path.resolve(import.meta.dir, "../../plugins");
  const runtime = new Runtime(engine, config, pluginsDir);
  await runtime.start();

  return {
    runtime,
    engine,
    async connect(playerOpts = {}) {
      const info = fakePlayerInfo({ id: engine.playerInfos.size, ...playerOpts });
      engine.playerInfos.set(info.clientId, info);
      const rejection = await engine.raw("player_connect", info.clientId, false);
      if (rejection === null || rejection === undefined) {
        await engine.raw("player_loaded", info.clientId);
      } else {
        engine.playerInfos.delete(info.clientId);
      }
      return { info, rejection };
    },
    async disconnect(id, reason = "disconnected") {
      await engine.raw("player_disconnect", id, reason);
      engine.playerInfos.delete(id);
    },
    chat(id, msg) {
      return engine.raw("client_command", id, `say "${msg}"`);
    },
    clientCommand(id, cmd) {
      return engine.raw("client_command", id, cmd);
    },
    async newGame() {
      await engine.raw("new_game", false);
    },
    messagesTo(id) {
      return engine
        .callsTo("send_server_command")
        .filter((c) => c.args[0] === id)
        .map((c) => String(c.args[1]));
    },
  };
}
