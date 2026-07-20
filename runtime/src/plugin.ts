/**
 * The plugin API. A plugin is a module default-exporting a Plugin object:
 *
 *   import type { Plugin } from "../runtime/src/plugin";
 *   export default {
 *     name: "motd",
 *     setup(ctx) {
 *       ctx.on("player_loaded", (player) => { ... });
 *       ctx.command("setmotd", { permission: 4, usage: "<motd>" }, ...);
 *     },
 *   } satisfies Plugin;
 *
 * Plugins must only import TYPES and pure constants from the runtime —
 * all stateful services arrive via the context. (Plugins are bundled as
 * separate entrypoints; importing stateful modules would duplicate them.)
 */
import type { PriorityValue } from "./constants";
import type { Engine } from "./engine";
import type { EventBus, EventHandler, EventName } from "./events";
import { Command, type CommandHandler, type CommandOptions, type CommandRegistry } from "./commands";
import type { Db } from "./db";
import type { Game } from "./game";
import type { Player, PlayerStore } from "./players";
import type { Channels } from "./pipeline";
import type { Config } from "./config";
import type { SteamId } from "./protocol";

export interface PluginContext {
  readonly name: string;
  /** This plugin's [plugin.<name>] section from minqlx.toml. */
  readonly config: Record<string, unknown>;
  readonly fullConfig: Config;
  readonly db: Db;
  readonly game: Game;
  /** Escape hatch: raw engine RPCs. */
  readonly engine: Engine;
  readonly channels: Channels;
  readonly owner: SteamId;
  readonly prefix: string;

  /** Registers an event handler, removed automatically on unload. */
  on<E extends EventName>(event: E, handler: EventHandler<E>, priority?: PriorityValue): void;
  /** Registers a command, removed automatically on unload. */
  command(name: string | string[], handler: CommandHandler): Command;
  command(name: string | string[], opts: CommandOptions, handler: CommandHandler): Command;

  players(): Player[];
  player(clientId: number): Player | null;
  /** Broadcast a chat message to everyone. */
  msg(text: string): Promise<void>;
  consolePrint(text: string): Promise<unknown>;

  getCvar(name: string): Promise<string | null>;
  setCvar(name: string, value: string): Promise<boolean>;

  /** setTimeout tracked per plugin: cleared automatically on unload. */
  delay(ms: number, fn: () => void): void;
  /** setInterval tracked per plugin: cleared automatically on unload. */
  every(ms: number, fn: () => void): void;
}

export interface Plugin {
  name: string;
  setup(ctx: PluginContext): void | PluginTeardown | Promise<void | PluginTeardown>;
}

export interface PluginTeardown {
  unload?(): void | Promise<void>;
}

/** Identity helper for typing (safe to import: no runtime state). */
export function definePlugin(plugin: Plugin): Plugin {
  return plugin;
}

/** Everything a plugin registered, so unload can undo it. */
export interface PluginRegistration {
  plugin: Plugin;
  teardown: PluginTeardown | void;
  timers: (number | NodeJS.Timeout)[];
}

export interface RuntimeServices {
  engine: Engine;
  events: EventBus;
  commands: CommandRegistry;
  store: PlayerStore;
  db: Db;
  game: Game;
  channels: Channels;
  config: Config;
}

export function createContext(name: string, services: RuntimeServices): {
  ctx: PluginContext;
  timers: (number | NodeJS.Timeout)[];
} {
  const { engine, events, commands, store, db, game, channels, config } = services;
  const timers: (number | NodeJS.Timeout)[] = [];

  const ctx: PluginContext = {
    name,
    config: config.plugin[name] ?? {},
    fullConfig: config,
    db,
    game,
    engine,
    channels,
    owner: config.server.owner,
    prefix: config.server.commandPrefix,

    on(event, handler, priority) {
      events.on(event, name, handler, priority);
    },

    command(cmdName: string | string[], optsOrHandler: CommandOptions | CommandHandler, maybeHandler?: CommandHandler) {
      const opts = typeof optsOrHandler === "function" ? {} : optsOrHandler;
      const handler = typeof optsOrHandler === "function" ? optsOrHandler : maybeHandler!;
      const cmd = new Command(name, cmdName, handler, opts);
      commands.add(cmd, opts.priority);
      return cmd;
    },

    players: () => store.all(),
    player: (clientId) => store.get(clientId),
    msg: (text) => channels.chat.reply(text),
    consolePrint: (text) => engine.rpc("console_print", text),
    getCvar: (cvarName) => engine.rpc("get_cvar", cvarName),
    setCvar: (cvarName, value) => engine.rpc("set_cvar", cvarName, value),

    delay(ms, fn) {
      timers.push(setTimeout(fn, ms));
    },
    every(ms, fn) {
      timers.push(setInterval(fn, ms));
    },
  };

  return { ctx, timers };
}
