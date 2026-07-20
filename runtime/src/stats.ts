/**
 * QLDS ZeroMQ stats listener (port of _zmq.py): parses the JSON stat
 * events and derives game_start/game_end/round_end/death/kill/team_switch.
 */
import type { Engine } from "./engine";
import type { EventBus } from "./events";
import type { Player, PlayerStore } from "./players";
import type { TeamName } from "./constants";
import { ZmtpSub } from "./zmtp";
import { log } from "./util";

interface StatsPlayerRef {
  STEAM_ID?: string | number;
  NAME?: string;
  OLD_TEAM?: string;
  TEAM?: string;
}

interface StatsEvent {
  TYPE: string;
  DATA: Record<string, unknown>;
}

export class StatsListener {
  private sub: ZmtpSub | null = null;
  private inProgress = false;
  private stopped = false;

  constructor(
    private engine: Engine,
    private events: EventBus,
    private store: PlayerStore,
    private configPassword: string,
  ) {}

  async start(): Promise<void> {
    const enabled = await this.engine.rpc("get_cvar", "zmq_stats_enable");
    if (!enabled || !parseInt(enabled, 10)) return;

    const host = (await this.engine.rpc("get_cvar", "zmq_stats_ip")) || "127.0.0.1";
    const port =
      (await this.engine.rpc("get_cvar", "zmq_stats_port")) ||
      (await this.engine.rpc("get_cvar", "net_port")) ||
      "27960";
    const password =
      (await this.engine.rpc("get_cvar", "zmq_stats_password")) || this.configPassword;

    await this.connect(host, parseInt(port, 10), password);
  }

  stop(): void {
    this.stopped = true;
    this.sub?.close();
  }

  private async connect(host: string, port: number, password: string): Promise<void> {
    const reconnect = () => {
      if (this.stopped) return;
      setTimeout(() => {
        this.connect(host, port, password).catch((e) =>
          log.error("stats reconnect failed:", e),
        );
      }, 5000);
    };

    this.sub = new ZmtpSub({
      host,
      port,
      username: password ? "stats" : undefined,
      password: password || undefined,
      onMessage: (data) => {
        try {
          const stats = JSON.parse(new TextDecoder().decode(data)) as StatsEvent;
          void this.handle(stats);
        } catch (e) {
          log.error("bad stats JSON:", e);
        }
      },
      onError: (err) => log.error("stats connection error:", err.message),
      onClose: reconnect,
    });

    try {
      await this.sub.connect();
      log.info(`stats listener connected to tcp://${host}:${port}`);
    } catch (e) {
      log.warn(`stats connection to tcp://${host}:${port} failed; retrying in 5s.`);
      reconnect();
      throw e instanceof Error ? e : new Error(String(e));
    }
  }

  private resolvePlayer(ref: StatsPlayerRef | null | undefined): Player | null {
    if (!ref) return null;
    const sid = String(ref.STEAM_ID ?? "0");
    if (sid !== "0") return this.store.bySteamId(sid);
    // Bots have no steam id; fall back to name lookup.
    return this.store.all().find((p) => p.name === ref.NAME) ?? null;
  }

  private async handle(stats: StatsEvent): Promise<void> {
    await this.events.dispatch("stats", stats as unknown as Record<string, unknown>);
    const data = stats.DATA;

    switch (stats.TYPE) {
      case "MATCH_STARTED":
        this.inProgress = true;
        await this.events.dispatch("game_start", data);
        break;
      case "ROUND_OVER":
        await this.events.dispatch("round_end", data);
        break;
      case "MATCH_REPORT":
        // MATCH_REPORT also fires on map changes; only forward real ends.
        if (this.inProgress) await this.events.dispatch("game_end", data);
        this.inProgress = false;
        break;
      case "PLAYER_DEATH": {
        const victim = this.resolvePlayer(data.VICTIM as StatsPlayerRef);
        const killer = this.resolvePlayer(data.KILLER as StatsPlayerRef | null);
        if (!victim) break;
        await this.events.dispatch("death", victim, killer, data);
        if (killer) await this.events.dispatch("kill", victim, killer, data);
        break;
      }
      case "PLAYER_SWITCHTEAM": {
        const ref = data.KILLER as StatsPlayerRef; // yes, the feed calls it KILLER
        const player = this.resolvePlayer(ref);
        const oldTeam = (ref.OLD_TEAM ?? "").toLowerCase();
        const newTeam = (ref.TEAM ?? "").toLowerCase();
        if (player && oldTeam !== newTeam) {
          await player.update();
          const res = await this.events.dispatch("team_switch", player, oldTeam, newTeam);
          if (res === false) await player.put(oldTeam as TeamName);
        }
        break;
      }
    }
  }
}
