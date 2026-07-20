/**
 * The event bus: typed high-level events with 5 priority levels and the
 * classic minqlx return-value semantics (port of _events.py).
 *
 * Handler return values:
 * - undefined / EventResult.None: continue
 * - EventResult.Stop: stop further handlers, don't cancel the event
 * - EventResult.StopEvent: keep running handlers, cancel at engine level
 * - EventResult.StopAll: stop handlers AND cancel
 * - a string (on string-replace events): replace the value going forward
 */
import { EventResult, PRIORITY_LEVELS, Priority, type PriorityValue } from "./constants";
import { log } from "./util";
import type { Player } from "./players";
import type { Channel } from "./channels";
import type { Command } from "./commands";

export interface GameEvents {
  chat: [player: Player, msg: string, channel: Channel];
  client_command: [player: Player, cmd: string];
  server_command: [player: Player | null, cmd: string];
  console_print: [text: string];
  set_configstring: [index: number, value: string];
  frame: [];
  command: [caller: Player, cmd: Command, msg: string];
  player_connect: [player: Player];
  player_loaded: [player: Player];
  player_disconnect: [player: Player, reason: string];
  player_spawn: [player: Player];
  kamikaze_use: [player: Player];
  kamikaze_explode: [player: Player, isUsedOnDemand: boolean];
  userinfo: [player: Player, changed: Map<string, string>];
  vote_called: [player: Player, vote: string, args: string];
  vote_started: [caller: Player | null, vote: string, args: string];
  vote_ended: [votes: [number, number], vote: string, args: string, passed: boolean];
  vote: [player: Player, yes: boolean];
  team_switch: [player: Player, oldTeam: string, newTeam: string];
  team_switch_attempt: [player: Player, oldTeam: string, newTeam: string];
  map: [mapname: string, factory: string];
  new_game: [];
  game_countdown: [];
  game_start: [data: Record<string, unknown>];
  game_end: [data: Record<string, unknown>];
  round_countdown: [round: number];
  round_start: [round: number];
  round_end: [data: Record<string, unknown>];
  kill: [victim: Player, killer: Player | null, data: Record<string, unknown>];
  death: [victim: Player, killer: Player | null, data: Record<string, unknown>];
  stats: [stats: Record<string, unknown>];
  unload: [plugin: string];
}

export type EventName = keyof GameEvents;

export type EventHandler<E extends EventName> = (
  ...args: GameEvents[E]
) => unknown | Promise<unknown>;

interface HookEntry {
  plugin: string;
  handler: (...args: unknown[]) => unknown;
}

/** Events where a string return value replaces the value at args[index]. */
const STRING_REPLACE_ARG: Partial<Record<EventName, number>> = {
  client_command: 1,
  server_command: 1,
  console_print: 0,
  set_configstring: 1,
};

/** Events where a string return value immediately cancels with that value
 * (player_connect: the string is the rejection message). */
const STRING_RETURNS: EventName[] = ["player_connect"];

const NO_DEBUG: EventName[] = [
  "frame", "set_configstring", "stats", "server_command", "death", "kill",
  "command", "console_print",
];

export type DispatchResult = boolean | string | Map<string, string>;

export class EventBus {
  private hooks = new Map<EventName, HookEntry[][]>();

  on<E extends EventName>(
    event: E,
    plugin: string,
    handler: EventHandler<E>,
    priority: PriorityValue = Priority.Normal,
  ): void {
    let levels = this.hooks.get(event);
    if (!levels) {
      levels = PRIORITY_LEVELS.map(() => []);
      this.hooks.set(event, levels);
    }
    levels[priority]!.push({ plugin, handler: handler as (...args: unknown[]) => unknown });
  }

  off<E extends EventName>(event: E, plugin: string, handler: EventHandler<E>): void {
    const levels = this.hooks.get(event);
    if (!levels) return;
    for (const level of levels) {
      const i = level.findIndex((h) => h.plugin === plugin && h.handler === handler);
      if (i !== -1) {
        level.splice(i, 1);
        return;
      }
    }
  }

  /** Removes every hook a plugin registered (unload). */
  removePlugin(plugin: string): void {
    for (const levels of this.hooks.values()) {
      for (const level of levels) {
        for (let i = level.length - 1; i >= 0; i--) {
          if (level[i]!.plugin === plugin) level.splice(i, 1);
        }
      }
    }
  }

  /**
   * Runs all handlers for an event. Returns:
   * - true: proceed normally
   * - false: cancel the event at the engine level
   * - string: replacement value (for string-replace events) or the
   *   rejection message (player_connect)
   */
  async dispatch<E extends EventName>(event: E, ...args: GameEvents[E]): Promise<DispatchResult> {
    if (!NO_DEBUG.includes(event)) {
      const dbg = `${event}(${args.map((a) => String(a)).join(", ")})`;
      log.debug(dbg.length > 100 ? dbg.slice(0, 99) + ")" : dbg);
    }

    const levels = this.hooks.get(event);
    if (!levels) return true;

    const currentArgs: unknown[] = [...args];
    let returnValue: DispatchResult = true;
    const replaceArg = STRING_REPLACE_ARG[event];

    for (const level of levels) {
      for (const { plugin, handler } of [...level]) {
        let res: unknown;
        try {
          res = await handler(...currentArgs);
        } catch (e) {
          log.error(`event '${event}' handler in plugin '${plugin}' threw:`, e);
          continue;
        }
        if (res === undefined || res === null || res === EventResult.None) continue;
        if (res === EventResult.Stop) return true;
        if (res === EventResult.StopEvent) {
          returnValue = false;
          continue;
        }
        if (res === EventResult.StopAll) return false;
        if (typeof res === "string") {
          if (replaceArg !== undefined) {
            currentArgs[replaceArg] = res;
            if (returnValue !== false) returnValue = res;
            continue;
          }
          if (STRING_RETURNS.includes(event)) return res;
        }
        if (event === "userinfo" && res instanceof Map) {
          // The pipeline merges the returned map into the userinfo command.
          if (returnValue !== false) returnValue = res;
          continue;
        }
        log.warn(`handler in plugin '${plugin}' returned unknown value for '${event}':`, res);
      }
    }
    return returnValue;
  }
}
