/**
 * The runtime container: wires all services together, loads/unloads/reloads
 * plugins, and starts the engine connection.
 */
import path from "node:path";
import type { Config } from "./config";
import type { Engine } from "./engine";
import { EventBus } from "./events";
import { CommandRegistry } from "./commands";
import { Db } from "./db";
import { CsCache, Game } from "./game";
import { PlayerStore } from "./players";
import { ChatChannel, ConsoleChannel } from "./channels";
import { Pipeline, type Channels } from "./pipeline";
import { clearTrackedTimer, createContext, type Plugin, type PluginRegistration, type RuntimeServices } from "./plugin";
import { RAW_EVENTS, type RawEventName } from "./protocol";
import { Command } from "./commands";
import { EventResult } from "./constants";
import { StatsListener } from "./stats";
import { registerFeatures } from "./features";
import { log } from "./util";

/** Events the runtime subscribes to (frame and console_print stay off). */
const SUBSCRIPTIONS: RawEventName[] = RAW_EVENTS.filter(
  (e) => e !== "frame" && e !== "console_print",
);

export class Runtime {
  readonly events = new EventBus();
  readonly db: Db;
  readonly store: PlayerStore;
  readonly cs: CsCache;
  readonly game: Game;
  readonly commands: CommandRegistry;
  readonly channels: Channels;
  readonly pipeline: Pipeline;
  private plugins = new Map<string, PluginRegistration>();
  private services: RuntimeServices;
  private stats: StatsListener | null = null;

  constructor(
    readonly engine: Engine,
    readonly config: Config,
    private pluginsDir = process.env.VERGE_PLUGINS_DIR ??
      path.join(path.dirname(Bun.main), "plugins"),
  ) {
    this.db = new Db(config.server.database, config.server.owner);
    this.store = new PlayerStore(engine);
    this.cs = new CsCache(engine);
    this.game = new Game(engine, this.cs);
    this.commands = new CommandRegistry(this.db, this.events, config.server.commandPrefix);
    this.channels = {
      chat: new ChatChannel(engine, this.store, "all"),
      free: new ChatChannel(engine, this.store, "free"),
      red: new ChatChannel(engine, this.store, "red"),
      blue: new ChatChannel(engine, this.store, "blue"),
      spectator: new ChatChannel(engine, this.store, "spectator"),
      console: new ConsoleChannel(engine),
    };
    this.pipeline = new Pipeline(
      engine, this.events, this.commands, this.store, this.cs, this.game,
      this.channels, config.server.owner,
    );
    this.services = {
      engine, events: this.events, commands: this.commands, store: this.store,
      db: this.db, game: this.game, channels: this.channels, config,
    };
  }

  async start(): Promise<void> {
    this.pipeline.register();
    this.registerBuiltinCommands();
    registerFeatures(this.config, this.engine, this.events, this.game, this.store);

    // Must be registered before lateInit() can dispatch new_game.
    if (this.config.stats.enabled) {
      let statsStarted = false;
      this.events.on("new_game", "core", () => {
        if (statsStarted) return;
        statsStarted = true;
        this.stats = new StatsListener(this.engine, this.events, this.store, this.config.stats.password);
        this.stats.start().catch((e) => log.error("stats listener failed to start:", e));
      });
    }
    for (const name of this.config.server.plugins) {
      try {
        await this.loadPlugin(name);
      } catch (e) {
        log.error(`failed to load plugin '${name}':`, e);
      }
    }
    await this.engine.start(SUBSCRIPTIONS);
    await this.pipeline.lateInit();
    // Expired-key cleanup once an hour.
    setInterval(() => this.db.sweep(), 3600_000).unref?.();
    log.info(`runtime ready: ${this.plugins.size} plugin(s) loaded.`);
  }

  /** Plugin management commands, formerly plugin_manager.py. */
  private registerBuiltinCommands(): void {
    const mgr = (
      name: string,
      usage: string,
      fn: (arg: string) => Promise<string>,
    ): Command =>
      new Command("core", name, async (_player, args, channel) => {
        if (usage && args.length < 2) return EventResult.Usage;
        try {
          await channel.reply(await fn(args[1] ?? ""));
        } catch (e) {
          await channel.reply(`^1Error: ^7${e instanceof Error ? e.message : String(e)}`);
        }
      }, { permission: 5, usage });

    this.commands.add(mgr("load", "<plugin>", async (name) => {
      await this.loadPlugin(name);
      return `Plugin ^6${name}^7 loaded.`;
    }));
    this.commands.add(mgr("unload", "<plugin>", async (name) => {
      await this.unloadPlugin(name);
      return `Plugin ^6${name}^7 unloaded.`;
    }));
    this.commands.add(mgr("reload", "<plugin>", async (name) => {
      await this.reloadPlugin(name);
      return `Plugin ^6${name}^7 reloaded.`;
    }));
    this.commands.add(mgr("plugins", "", async () =>
      `Loaded plugins: ^6${this.loadedPlugins().join("^7, ^6")}`,
    ));
  }

  loadedPlugins(): string[] {
    return [...this.plugins.keys()];
  }

  private resolvePluginPath(name: string): string | null {
    for (const ext of [".js", ".ts"]) {
      const p = path.join(this.pluginsDir, name + ext);
      if (Bun.file(p).size > 0) return p;
    }
    return null;
  }

  async loadPlugin(name: string): Promise<void> {
    if (this.plugins.has(name)) throw new Error(`Plugin '${name}' is already loaded.`);
    const modPath = this.resolvePluginPath(name);
    if (!modPath) throw new Error(`Plugin '${name}' not found in ${this.pluginsDir}.`);

    // Cache-busting query so a reload picks up edits.
    const mod = (await import(`${modPath}?t=${Date.now()}`)) as { default?: Plugin };
    const plugin = mod.default;
    if (!plugin || typeof plugin.setup !== "function") {
      throw new Error(`Plugin '${name}' does not default-export a { name, setup } object.`);
    }

    const { ctx, timers } = createContext(name, this.services);
    try {
      const teardown = await plugin.setup(ctx);
      this.plugins.set(name, { plugin, teardown: teardown ?? undefined, timers });
      log.info(`loaded plugin '${name}'.`);
    } catch (e) {
      // Roll back whatever setup managed to register.
      this.events.removePlugin(name);
      this.commands.removePlugin(name);
      for (const t of timers) clearTrackedTimer(t);
      throw e;
    }
  }

  async unloadPlugin(name: string): Promise<void> {
    const reg = this.plugins.get(name);
    if (!reg) throw new Error(`Plugin '${name}' is not loaded.`);
    await this.events.dispatch("unload", name);
    try {
      await reg.teardown?.unload?.();
    } catch (e) {
      log.error(`plugin '${name}' unload() threw:`, e);
    }
    this.events.removePlugin(name);
    this.commands.removePlugin(name);
    for (const t of reg.timers) clearTrackedTimer(t);
    this.plugins.delete(name);
    log.info(`unloaded plugin '${name}'.`);
  }

  async reloadPlugin(name: string): Promise<void> {
    if (this.plugins.has(name)) await this.unloadPlugin(name);
    await this.loadPlugin(name);
  }
}
