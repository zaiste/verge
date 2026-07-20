/**
 * Player wrapper and the connected-player store.
 *
 * Because every engine call is an async RPC, identity data (name, team,
 * steam id, ...) is cached in the store and exposed as sync properties;
 * the store is refreshed by the event pipeline on connect/loaded/
 * disconnect/spawn and on userinfo changes. Volatile data (health,
 * position, ...) is always fetched fresh via async methods.
 */
import { CONNECTION_STATES, TEAMS, type TeamName } from "./constants";
import type { Engine } from "./engine";
import type { PlayerInfo, PlayerState, PlayerStats, SteamId, Vector3 } from "./protocol";
import { sendPrint } from "./chat";
import { cleanText, parseVariables } from "./util";

export class Player {
  constructor(
    private engine: Engine,
    private info: PlayerInfo,
  ) {}

  /** Called by the store when fresh info arrives. */
  updateInfo(info: PlayerInfo): void {
    this.info = info;
  }

  get id(): number {
    return this.info.clientId;
  }
  get name(): string {
    return this.info.name;
  }
  get cleanName(): string {
    return cleanText(this.info.name);
  }
  get steamId(): SteamId {
    return this.info.steamId;
  }
  get team(): TeamName {
    return TEAMS[this.info.team] ?? "spectator";
  }
  get privileges(): number {
    return this.info.privileges;
  }
  get connectionState(): string {
    return CONNECTION_STATES[this.info.connectionState] ?? "free";
  }
  get isBot(): boolean {
    // Bots have steam_id 0.
    return this.info.steamId === "0";
  }
  /** Parsed userinfo variables (name, rate, color, ...). */
  get cvars(): Map<string, string> {
    return parseVariables(this.info.userinfo);
  }
  get ip(): string {
    return this.cvars.get("ip")?.split(":")[0] ?? "";
  }

  // ---- volatile data ----

  state(): Promise<PlayerState | null> {
    return this.engine.rpc("player_state", this.id);
  }
  stats(): Promise<PlayerStats | null> {
    return this.engine.rpc("player_stats", this.id);
  }
  async update(): Promise<void> {
    const info = await this.engine.rpc("player_info", this.id);
    if (info) this.info = info;
  }

  // ---- actions ----

  tell(msg: string): Promise<void> {
    return sendPrint(this.engine, [this.id], msg);
  }
  centerPrint(msg: string): Promise<unknown> {
    return this.engine.rpc("send_server_command", this.id, `cp "${msg}"\n`);
  }
  kick(reason = ""): Promise<null> {
    return this.engine.rpc("kick", this.id, reason);
  }
  /** Puts the player on a team (free/red/blue/spectator). */
  put(team: TeamName): Promise<null> {
    return this.engine.rpc("console_command", `put ${this.id} ${team}`);
  }
  mute(): Promise<null> {
    return this.engine.rpc("console_command", `mute ${this.id}`);
  }
  unmute(): Promise<null> {
    return this.engine.rpc("console_command", `unmute ${this.id}`);
  }
  slap(damage = 0): Promise<null> {
    return this.engine.rpc("console_command", `slap ${this.id} ${damage}`);
  }
  slay(): Promise<null> {
    return this.engine.rpc("console_command", `slay ${this.id}`);
  }
  setPrivileges(priv: number): Promise<boolean> {
    return this.engine.rpc("set_privileges", this.id, priv);
  }
  position(): Promise<Vector3 | null> {
    return this.state().then((s) => s?.position ?? null);
  }

  toString(): string {
    return `${this.cleanName}(${this.id})`;
  }
}

export class PlayerStore {
  private players = new Map<number, Player>();

  constructor(private engine: Engine) {}

  /** All connected players (bots included unless filtered). */
  all(): Player[] {
    return [...this.players.values()];
  }

  byTeam(team: TeamName): Player[] {
    return this.all().filter((p) => p.team === team);
  }

  get(clientId: number): Player | null {
    return this.players.get(clientId) ?? null;
  }

  bySteamId(steamId: SteamId): Player | null {
    return this.all().find((p) => p.steamId === steamId) ?? null;
  }

  /**
   * Returns the player for a client id, fetching info from the engine if
   * not cached yet (e.g. during the connect hook).
   */
  async ensure(clientId: number): Promise<Player | null> {
    const cached = this.players.get(clientId);
    if (cached) return cached;
    const info = await this.engine.rpc("player_info", clientId);
    if (!info) return null;
    const player = new Player(this.engine, info);
    this.players.set(clientId, player);
    return player;
  }

  /** Refreshes a single player's cached info. */
  async refresh(clientId: number): Promise<Player | null> {
    const info = await this.engine.rpc("player_info", clientId);
    if (!info) {
      this.players.delete(clientId);
      return null;
    }
    const existing = this.players.get(clientId);
    if (existing) {
      existing.updateInfo(info);
      return existing;
    }
    const player = new Player(this.engine, info);
    this.players.set(clientId, player);
    return player;
  }

  /** Full resync from the engine (startup, new game). */
  async syncAll(): Promise<void> {
    const infos = await this.engine.rpc("players_info");
    const seen = new Set<number>();
    for (const info of infos) {
      if (!info) continue;
      seen.add(info.clientId);
      const existing = this.players.get(info.clientId);
      if (existing) existing.updateInfo(info);
      else this.players.set(info.clientId, new Player(this.engine, info));
    }
    for (const id of this.players.keys()) {
      if (!seen.has(id)) this.players.delete(id);
    }
  }

  /** Drops a player from the cache (after disconnect). */
  remove(clientId: number): void {
    this.players.delete(clientId);
  }
}
