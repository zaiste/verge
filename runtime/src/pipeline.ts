/**
 * The event pipeline: receives raw engine events from the shim, parses them
 * (port of _handlers.py's regexes), keeps the player store and configstring
 * cache fresh, and dispatches the high-level events plugins hook into.
 */
import type { Engine } from "./engine";
import type { HookResult, PlayerInfo } from "./protocol";
import type { EventBus } from "./events";
import type { CommandRegistry } from "./commands";
import { Player, type PlayerStore } from "./players";
import { CS_ROUND_STATUS, CS_SERVERINFO, CS_VOTE_NO, CS_VOTE_STRING, CS_VOTE_YES, type CsCache, type Game } from "./game";
import { ChatChannel, ClientCommandChannel, Channel, ConsoleChannel } from "./channels";
import { PRIV_ROOT, CS_ACTIVE, TEAM_SPECTATOR, type TeamName } from "./constants";
import { formatVariables, log, parseVariables } from "./util";

const RE_SAY = /^say +"?(?<msg>.+?)"?$/i;
const RE_SAY_TEAM = /^say_team +"?(?<msg>.+?)"?$/i;
const RE_CALLVOTE = /^(?:cv|callvote) +(?<cmd>[^ ]+)(?: "?(?<args>.+?)"?)?$/i;
const RE_VOTE = /^vote +(?<arg>.)/i;
const RE_TEAM = /^team +(?<arg>.)/i;
const RE_VOTE_ENDED = /^print "Vote (?<result>passed|failed)\.\n"$/;
const RE_USERINFO = /^userinfo "(?<vars>.+)"$/;
const RE_VOTE_PARSE = /^(?<cmd>[^ ]+)(?: "?(?<args>.*?)"?)?$/;

export interface Channels {
  chat: ChatChannel;
  free: ChatChannel;
  red: ChatChannel;
  blue: ChatChannel;
  spectator: ChatChannel;
  console: ConsoleChannel;
}

export class Pipeline {
  /** Caller of the current/last vote, for the vote_started event. */
  voteCaller: Player | null = null;
  private adRoundNumber = 0;
  private firstGame = true;
  private rconPlayer: Player;

  constructor(
    private engine: Engine,
    private events: EventBus,
    private commands: CommandRegistry,
    private store: PlayerStore,
    private cs: CsCache,
    private game: Game,
    private channels: Channels,
    ownerSteamId: string,
  ) {
    // A synthetic player representing the console/rcon, owner-privileged.
    const rconInfo: PlayerInfo = {
      clientId: -1,
      name: "console",
      connectionState: CS_ACTIVE,
      userinfo: "",
      steamId: ownerSteamId,
      team: TEAM_SPECTATOR,
      privileges: PRIV_ROOT,
    };
    this.rconPlayer = new Player(engine, rconInfo);
  }

  register(): void {
    this.engine.onRaw("client_command", (args) => this.onClientCommand(args[0] as number, args[1] as string));
    this.engine.onRaw("server_command", (args) => this.onServerCommand(args[0] as number, args[1] as string));
    this.engine.onRaw("player_connect", (args) => this.onPlayerConnect(args[0] as number));
    this.engine.onRaw("player_loaded", (args) => this.onPlayerLoaded(args[0] as number));
    this.engine.onRaw("player_disconnect", (args) => this.onPlayerDisconnect(args[0] as number, args[1] as string));
    this.engine.onRaw("player_spawn", (args) => this.onPlayerSpawn(args[0] as number));
    this.engine.onRaw("new_game", (args) => this.onNewGame(args[0] as boolean));
    this.engine.onRaw("set_configstring", (args) => this.onSetConfigstring(args[0] as number, args[1] as string));
    this.engine.onRaw("rcon", (args) => this.onRcon(args[0] as string));
    this.engine.onRaw("kamikaze_use", (args) => this.onKamikaze(args[0] as number, "kamikaze_use"));
    this.engine.onRaw("kamikaze_explode", (args) =>
      this.onKamikazeExplode(args[0] as number, args[1] as boolean),
    );
  }

  private teamChannel(team: TeamName): Channel {
    switch (team) {
      case "free": return this.channels.free;
      case "red": return this.channels.red;
      case "blue": return this.channels.blue;
      default: return this.channels.spectator;
    }
  }

  private async onClientCommand(clientId: number, cmd: string): Promise<HookResult> {
    const player = await this.store.ensure(clientId);
    if (!player) return null;

    const original = cmd;
    const ret = await this.events.dispatch("client_command", player, cmd);
    if (ret === false) return false;
    if (typeof ret === "string") cmd = ret;

    // The client_command event doubles as a command source (e.g. /cmd in
    // the console instead of chat).
    const ccRet = await this.commands.handleInput(
      player,
      cmd,
      new ClientCommandChannel(this.engine, player),
    );
    if (ccRet === false) return false;

    let m = RE_SAY.exec(cmd);
    if (m?.groups) {
      const msg = m.groups.msg!.replace(/"/g, "");
      if (!(await this.dispatchChat(player, msg, this.channels.chat))) return false;
      return done(original, cmd);
    }

    m = RE_SAY_TEAM.exec(cmd);
    if (m?.groups) {
      const msg = m.groups.msg!.replace(/"/g, "");
      if (!(await this.dispatchChat(player, msg, this.teamChannel(player.team)))) return false;
      return done(original, cmd);
    }

    m = RE_CALLVOTE.exec(cmd);
    if (m?.groups && !this.game.isVoteActive) {
      this.voteCaller = player;
      const res = await this.events.dispatch(
        "vote_called",
        player,
        m.groups.cmd!,
        m.groups.args ?? "",
      );
      if (res === false) return false;
      return done(original, cmd);
    }

    m = RE_VOTE.exec(cmd);
    if (m?.groups && this.game.isVoteActive) {
      const arg = m.groups.arg!.toLowerCase();
      if (arg === "y" || arg === "1") {
        if ((await this.events.dispatch("vote", player, true)) === false) return false;
      } else if (arg === "n" || arg === "2") {
        if ((await this.events.dispatch("vote", player, false)) === false) return false;
      }
      return done(original, cmd);
    }

    m = RE_TEAM.exec(cmd);
    if (m?.groups) {
      const arg = m.groups.arg!.toLowerCase();
      if (arg !== player.team[0]) {
        const target =
          arg === "f" ? "free" : arg === "r" ? "red" : arg === "b" ? "blue" :
          arg === "s" ? "spectator" : arg === "a" ? "any" : "";
        if (target) {
          const res = await this.events.dispatch("team_switch_attempt", player, player.team, target);
          if (res === false) return false;
        }
      }
      return done(original, cmd);
    }

    m = RE_USERINFO.exec(cmd);
    if (m?.groups) {
      const newInfo = parseVariables(m.groups.vars!);
      const oldInfo = player.cvars;
      const changed = new Map<string, string>();
      for (const [key, value] of newInfo) {
        if (!oldInfo.has(key) || oldInfo.get(key) !== value) changed.set(key, value);
      }
      if (changed.size > 0) {
        const res = await this.events.dispatch("userinfo", player, changed);
        if (res === false) return false;
        if (res instanceof Map) {
          for (const [key, value] of res) newInfo.set(key, value);
          cmd = `userinfo "${formatVariables(newInfo).slice(1)}"`;
        }
      }
    }

    return done(original, cmd);
  }

  private async dispatchChat(player: Player, msg: string, channel: Channel): Promise<boolean> {
    // Commands first (so !cmd works), then the chat event.
    const cmdRet = await this.commands.handleInput(player, msg, channel);
    if (cmdRet === false) return false;
    const ret = await this.events.dispatch("chat", player, msg, channel);
    return ret !== false;
  }

  private async onServerCommand(clientId: number, cmd: string): Promise<HookResult> {
    const player = clientId >= 0 ? this.store.get(clientId) : null;
    if (clientId >= 0 && !player) return null;

    const original = cmd;
    const ret = await this.events.dispatch("server_command", player, cmd);
    if (ret === false) return false;
    if (typeof ret === "string") cmd = ret;

    const m = RE_VOTE_ENDED.exec(cmd);
    if (m?.groups) {
      const passed = m.groups.result === "passed";
      const cs = this.cs.get(CS_VOTE_STRING);
      if (!cs) {
        log.warn("vote_ended went off without an active vote string.");
      } else {
        const vm = RE_VOTE_PARSE.exec(cs);
        const votes: [number, number] = [
          parseInt(this.cs.get(CS_VOTE_YES), 10) || 0,
          parseInt(this.cs.get(CS_VOTE_NO), 10) || 0,
        ];
        void this.events.dispatch("vote_ended", votes, vm?.groups?.cmd ?? "", vm?.groups?.args ?? "", passed);
      }
    }

    return done(original, cmd);
  }

  private async onPlayerConnect(clientId: number): Promise<HookResult> {
    const player = await this.store.refresh(clientId);
    if (!player) return null;
    const res = await this.events.dispatch("player_connect", player);
    if (res === false) return false; // generic ban message
    if (typeof res === "string") return res; // custom rejection message
    return null;
  }

  private async onPlayerLoaded(clientId: number): Promise<void> {
    const player = await this.store.refresh(clientId);
    if (player) await this.events.dispatch("player_loaded", player);
  }

  private async onPlayerDisconnect(clientId: number, reason: string): Promise<void> {
    const player = this.store.get(clientId) ?? (await this.store.refresh(clientId));
    if (player) await this.events.dispatch("player_disconnect", player, reason);
    this.store.remove(clientId);
  }

  private async onPlayerSpawn(clientId: number): Promise<void> {
    const player = await this.store.refresh(clientId);
    if (player) await this.events.dispatch("player_spawn", player);
  }

  private async onNewGame(restart: boolean): Promise<void> {
    await this.cs.prefetch();
    await this.store.syncAll();

    if (this.firstGame) {
      this.firstGame = false;
      const zmq = await this.engine.rpc("get_cvar", "zmq_stats_enable");
      if (!zmq || !parseInt(zmq, 10)) {
        log.warn(
          'Some events will not work because ZMQ stats is not enabled. Launch with "zmq_stats_enable 1".',
        );
      }
    }

    if (!restart) {
      const mapname = (await this.engine.rpc("get_cvar", "mapname")) ?? "";
      const factory = (await this.engine.rpc("get_cvar", "g_factory")) ?? "";
      await this.events.dispatch("map", mapname, factory);
    }
    await this.events.dispatch("new_game");
  }

  private async onSetConfigstring(index: number, value: string): Promise<HookResult> {
    const original = value;
    const res = await this.events.dispatch("set_configstring", index, value);
    if (res === false) return false;
    if (typeof res === "string") value = res;

    if (index === CS_VOTE_STRING && value) {
      const parts = value.split(" ");
      const vote = parts[0] ?? "";
      const args = parts.slice(1).join(" ");
      void this.events.dispatch("vote_started", this.voteCaller, vote, args);
      this.voteCaller = null;
    } else if (index === CS_SERVERINFO) {
      const oldState = parseVariables(this.cs.get(CS_SERVERINFO)).get("g_gameState");
      const newState = parseVariables(value).get("g_gameState");
      if (oldState && newState && oldState !== newState) {
        if (oldState === "PRE_GAME" && newState === "COUNT_DOWN") {
          this.adRoundNumber = 1;
          void this.events.dispatch("game_countdown");
        }
        // game_start comes from the ZMQ stats feed, not from here.
      }
    } else if (index === CS_ROUND_STATUS) {
      const cvars = parseVariables(value);
      if (cvars.size > 0) {
        let roundNumber: number;
        if (cvars.has("turn")) {
          // Attack & Defend counts rounds oddly.
          if (parseInt(cvars.get("state") ?? "0", 10) === 0) return done(original, value);
          if (cvars.has("round")) {
            roundNumber = parseInt(cvars.get("round")!, 10) * 2 + 1 + parseInt(cvars.get("turn")!, 10);
            this.adRoundNumber = roundNumber;
          } else {
            roundNumber = this.adRoundNumber;
          }
        } else {
          roundNumber = parseInt(cvars.get("round") ?? "0", 10);
        }
        if (roundNumber) {
          void this.events.dispatch(
            cvars.has("time") ? "round_countdown" : "round_start",
            roundNumber,
          );
        }
      }
    }

    // Keep the cache in sync with what the engine will actually store.
    this.cs.set(index, value);
    return done(original, value);
  }

  private async onRcon(cmd: string): Promise<void> {
    await this.commands.handleInput(this.rconPlayer, cmd, this.channels.console);
  }

  private async onKamikaze(clientId: number, event: "kamikaze_use"): Promise<void> {
    const player = this.store.get(clientId);
    if (player) await this.events.dispatch(event, player);
  }

  private async onKamikazeExplode(clientId: number, isUsedOnDemand: boolean): Promise<void> {
    const player = this.store.get(clientId);
    if (player) await this.events.dispatch("kamikaze_explode", player, isUsedOnDemand);
  }
}

/** null = pass unchanged; string = replacement (only when actually changed). */
function done(original: string, current: string): HookResult {
  return current === original ? null : current;
}
