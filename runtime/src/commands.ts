/**
 * Chat/console command registry with permission levels 0-5 (port of
 * _commands.py's Command and CommandInvoker).
 */
import { EventResult, PRIORITY_LEVELS, Priority, type PriorityValue } from "./constants";
import type { Channel } from "./channels";
import type { Db } from "./db";
import type { EventBus } from "./events";
import type { Player } from "./players";
import { log } from "./util";

/** Handlers receive msg.split() including the command word at args[0]. */
export type CommandHandler = (
  player: Player,
  args: string[],
  channel: Channel,
) => unknown | Promise<unknown>;

export interface CommandOptions {
  /** Permission level 0-5 required in chat channels (0 = everyone). */
  permission?: number;
  /** Channel names this command works in; empty = all. */
  channels?: string[];
  excludeChannels?: string[];
  priority?: PriorityValue;
  /** For client_command channels: pass the command on to the engine. */
  clientCmdPass?: boolean;
  /** Permission level required when invoked as a client command. */
  clientCmdPerm?: number;
  /** Whether the command needs the command prefix (default true). */
  prefix?: boolean;
  usage?: string;
}

export class Command {
  readonly names: string[];
  readonly permission: number;
  readonly channels: string[];
  readonly excludeChannels: string[];
  readonly clientCmdPass: boolean;
  readonly clientCmdPerm: number;
  readonly prefix: boolean;
  readonly usage: string;

  constructor(
    readonly plugin: string,
    name: string | string[],
    readonly handler: CommandHandler,
    opts: CommandOptions = {},
  ) {
    this.names = (Array.isArray(name) ? name : [name]).map((n) => n.toLowerCase());
    this.permission = opts.permission ?? 0;
    this.channels = opts.channels ?? [];
    this.excludeChannels = opts.excludeChannels ?? [];
    this.clientCmdPass = opts.clientCmdPass ?? false;
    this.clientCmdPerm = opts.clientCmdPerm ?? 5;
    this.prefix = opts.prefix ?? true;
    this.usage = opts.usage ?? "";
  }

  toString(): string {
    return this.names[0]!;
  }
}

export class CommandRegistry {
  private commands: Command[][] = PRIORITY_LEVELS.map(() => []);

  constructor(
    private db: Db,
    private events: EventBus,
    private commandPrefix: string,
  ) {}

  all(): Command[] {
    return this.commands.flat();
  }

  add(command: Command, priority: PriorityValue = Priority.Normal): void {
    this.commands[priority]!.push(command);
  }

  remove(command: Command): void {
    for (const level of this.commands) {
      const i = level.indexOf(command);
      if (i !== -1) {
        level.splice(i, 1);
        return;
      }
    }
  }

  removePlugin(plugin: string): void {
    for (const level of this.commands) {
      for (let i = level.length - 1; i >= 0; i--) {
        if (level[i]!.plugin === plugin) level.splice(i, 1);
      }
    }
  }

  private isEligibleName(cmd: Command, name: string): boolean {
    if (cmd.prefix) {
      if (!name.startsWith(this.commandPrefix)) return false;
      name = name.slice(this.commandPrefix.length);
    }
    return cmd.names.includes(name.toLowerCase());
  }

  private isEligibleChannel(cmd: Command, channel: Channel): boolean {
    if (cmd.excludeChannels.includes(channel.name)) return false;
    return cmd.channels.length === 0 || cmd.channels.includes(channel.name);
  }

  private isEligiblePlayer(cmd: Command, player: Player, isClientCmd: boolean): boolean {
    const required = isClientCmd ? cmd.clientCmdPerm : cmd.permission;
    if (required === 0) return true;
    return this.db.getPermission(player.steamId) >= required;
  }

  /**
   * Processes input from a channel. Returns:
   * - false: cancel the underlying engine event
   * - true/undefined: pass through
   */
  async handleInput(player: Player, msg: string, channel: Channel): Promise<boolean | undefined> {
    if (!msg.trim()) return undefined;

    const name = msg.trim().split(" ", 1)[0]!.toLowerCase();
    const isClientCmd = channel.name === "client_command";
    let passThrough = true;

    for (const level of this.commands) {
      for (const cmd of [...level]) {
        if (
          !this.isEligibleName(cmd, name) ||
          !this.isEligibleChannel(cmd, channel) ||
          !this.isEligiblePlayer(cmd, player, isClientCmd)
        )
          continue;

        // Client commands don't pass through to the engine unless the
        // command explicitly asks for it (avoids "unknown cmd" spam).
        if (isClientCmd) passThrough = cmd.clientCmdPass;

        if ((await this.events.dispatch("command", player, cmd, msg)) === false) return true;

        let res: unknown;
        try {
          res = await cmd.handler(player, msg.split(" ").filter(Boolean), channel);
        } catch (e) {
          log.error(`command '${cmd}' in plugin '${cmd.plugin}' threw:`, e);
          continue;
        }
        if (res === EventResult.Stop) return undefined;
        if (res === EventResult.StopEvent) passThrough = false;
        else if (res === EventResult.StopAll) return false;
        else if (res === EventResult.Usage && cmd.usage) {
          await channel.reply(`^7Usage: ^6${name} ${cmd.usage}`);
        } else if (res !== undefined && res !== null && res !== EventResult.None) {
          log.warn(`command '${cmd}' returned unknown value:`, res);
        }
      }
    }
    return passThrough;
  }
}
