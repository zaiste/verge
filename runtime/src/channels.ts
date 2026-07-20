/**
 * Channels: where a message came from and where replies go (port of
 * _commands.py's channel classes).
 */
import { sendPrint } from "./chat";
import type { Engine } from "./engine";
import type { Player, PlayerStore } from "./players";
import type { TeamName } from "./constants";

export abstract class Channel {
  constructor(readonly name: string) {}
  abstract reply(msg: string, limit?: number, delimiter?: string): Promise<void>;
  toString(): string {
    return this.name;
  }
}

const CHAT_CHANNEL_NAMES: Record<TeamName | "all", string> = {
  all: "chat",
  free: "free_chat",
  red: "red_team_chat",
  blue: "blue_team_chat",
  spectator: "spectator_chat",
};

/** In-game chat, to everyone or to one team. */
export class ChatChannel extends Channel {
  constructor(
    private engine: Engine,
    private store: PlayerStore,
    readonly team: TeamName | "all" = "all",
  ) {
    super(CHAT_CHANNEL_NAMES[team]);
  }

  reply(msg: string, limit = 100, delimiter = " "): Promise<void> {
    const targets = this.team === "all" ? null : this.store.byTeam(this.team).map((p) => p.id);
    if (targets !== null && targets.length === 0) return Promise.resolve();
    return sendPrint(this.engine, targets, msg, limit, delimiter);
  }
}

/** Private message to one player. */
export class TellChannel extends Channel {
  constructor(
    private engine: Engine,
    readonly recipient: Player,
  ) {
    super("tell");
  }

  reply(msg: string, limit = 100, delimiter = " "): Promise<void> {
    return sendPrint(this.engine, [this.recipient.id], msg, limit, delimiter);
  }
}

/** Replies go to the server console. */
export class ConsoleChannel extends Channel {
  constructor(private engine: Engine) {
    super("console");
  }

  async reply(msg: string): Promise<void> {
    await this.engine.rpc("console_print", String(msg));
  }
}

/** Command executed via a client command (e.g. typed in the console as /cmd);
 * replies go privately to the player. */
export class ClientCommandChannel extends Channel {
  private tellChannel: TellChannel;

  constructor(engine: Engine, readonly recipient: Player) {
    super("client_command");
    this.tellChannel = new TellChannel(engine, recipient);
  }

  reply(msg: string, limit = 100, delimiter = " "): Promise<void> {
    return this.tellChannel.reply(msg, limit, delimiter);
  }
}
