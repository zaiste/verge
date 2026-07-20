/**
 * In-process Engine implementation for tests: no socket, no server. Serves
 * canned state (players, cvars, configstrings), records every RPC, and
 * offers simulation helpers that push raw events through the real pipeline.
 */
import type { Engine, RawHandler } from "../../runtime/src/engine";
import type {
  HookResult,
  PlayerInfo,
  RawEventName,
  RpcName,
  RpcSignatures,
} from "../../runtime/src/protocol";

export interface RpcCall {
  fn: RpcName;
  args: unknown[];
}

export class MockEngine implements Engine {
  calls: RpcCall[] = [];
  cvars = new Map<string, string>([
    ["sv_maxclients", "24"],
    ["zmq_stats_enable", "1"],
    ["mapname", "campgrounds"],
    ["g_factory", "ca"],
  ]);
  configstrings = new Map<number, string>([
    [0, "\\mapname\\campgrounds\\g_gametype\\4\\g_gameState\\PRE_GAME\\sv_hostname\\testserver"],
  ]);
  playerInfos = new Map<number, PlayerInfo>();
  private handlers = new Map<RawEventName, RawHandler>();
  started = false;

  /** RPCs recorded with a given name. */
  callsTo(fn: RpcName): RpcCall[] {
    return this.calls.filter((c) => c.fn === fn);
  }

  clearCalls(): void {
    this.calls = [];
  }

  async rpc<K extends RpcName>(
    fn: K,
    ...args: Parameters<RpcSignatures[K]>
  ): Promise<ReturnType<RpcSignatures[K]>> {
    this.calls.push({ fn, args });
    type R = ReturnType<RpcSignatures[K]>;
    switch (fn) {
      case "player_info":
        return (this.playerInfos.get(args[0] as number) ?? null) as R;
      case "players_info": {
        const maxclients = parseInt(this.cvars.get("sv_maxclients") ?? "24", 10);
        const list: (PlayerInfo | null)[] = [];
        for (let i = 0; i < maxclients; i++) list.push(this.playerInfos.get(i) ?? null);
        return list as R;
      }
      case "get_userinfo":
        return (this.playerInfos.get(args[0] as number)?.userinfo ?? null) as R;
      case "get_cvar":
        return (this.cvars.get(args[0] as string) ?? null) as R;
      case "set_cvar":
        this.cvars.set(args[0] as string, args[1] as string);
        return true as R;
      case "get_configstring":
        return (this.configstrings.get(args[0] as number) ?? "") as R;
      case "set_configstring":
        this.configstrings.set(args[0] as number, args[1] as string);
        return null as R;
      case "kick": {
        // Kicking removes the player, like the real engine would.
        this.playerInfos.delete(args[0] as number);
        return null as R;
      }
      case "player_state":
      case "player_stats":
        return null as R;
      case "send_server_command":
      case "client_command":
      case "set_privileges":
      case "force_vote":
        return true as R;
      default:
        return null as R;
    }
  }

  onRaw(name: RawEventName, handler: RawHandler): void {
    this.handlers.set(name, handler);
  }

  async start(): Promise<void> {
    this.started = true;
  }

  /** Fires a raw event through the pipeline, returning the hook result. */
  async raw(name: RawEventName, ...args: unknown[]): Promise<HookResult | void> {
    const handler = this.handlers.get(name);
    if (!handler) return null;
    return handler(args);
  }
}
