/**
 * Game state, backed by a configstring cache. The pipeline keeps the cache
 * fresh from set_configstring events; the interesting indexes are prefetched
 * on startup and new_game so reads are synchronous.
 */
import { GAMETYPES, GAMETYPES_SHORT } from "./constants";
import type { Engine } from "./engine";
import { parseVariables } from "./util";

// Configstring indexes.
export const CS_SERVERINFO = 0;
export const CS_SCORES1 = 6;
export const CS_SCORES2 = 7;
export const CS_VOTE_STRING = 9;
export const CS_VOTE_YES = 10;
export const CS_VOTE_NO = 11;
export const CS_ROUND_STATUS = 661;

const PREFETCH = [CS_SERVERINFO, CS_SCORES1, CS_SCORES2, CS_VOTE_STRING, CS_VOTE_YES, CS_VOTE_NO];

export class CsCache {
  private cache = new Map<number, string>();

  constructor(private engine: Engine) {}

  /** Cached value; empty string when unknown. */
  get(index: number): string {
    return this.cache.get(index) ?? "";
  }

  set(index: number, value: string): void {
    this.cache.set(index, value);
  }

  async fetch(index: number): Promise<string> {
    const value = await this.engine.rpc("get_configstring", index);
    this.cache.set(index, value);
    return value;
  }

  async prefetch(): Promise<void> {
    await Promise.all(PREFETCH.map((i) => this.fetch(i)));
  }
}

export class Game {
  constructor(
    private engine: Engine,
    private cs: CsCache,
  ) {}

  /** Parsed serverinfo (configstring 0). */
  get serverinfo(): Map<string, string> {
    return parseVariables(this.cs.get(CS_SERVERINFO));
  }

  get map(): string {
    return this.serverinfo.get("mapname") ?? "";
  }
  get type(): string {
    return GAMETYPES[Number(this.serverinfo.get("g_gametype") ?? -1)] ?? "unknown";
  }
  get typeShort(): string {
    return GAMETYPES_SHORT[Number(this.serverinfo.get("g_gametype") ?? -1)] ?? "N/A";
  }
  /** "warmup" | "countdown" | "in_progress" (from g_gameState). */
  get state(): string {
    switch (this.serverinfo.get("g_gameState")) {
      case "PRE_GAME":
        return "warmup";
      case "COUNT_DOWN":
        return "countdown";
      case "IN_PROGRESS":
        return "in_progress";
      default:
        return "unknown";
    }
  }
  get factory(): string {
    return this.serverinfo.get("g_factory") ?? "";
  }
  get hostname(): string {
    return this.serverinfo.get("sv_hostname") ?? "";
  }
  get redScore(): number {
    return parseInt(this.cs.get(CS_SCORES1), 10) || 0;
  }
  get blueScore(): number {
    return parseInt(this.cs.get(CS_SCORES2), 10) || 0;
  }

  get isVoteActive(): boolean {
    return this.cs.get(CS_VOTE_STRING) !== "";
  }
  get voteCounts(): [yes: number, no: number] {
    return [parseInt(this.cs.get(CS_VOTE_YES), 10) || 0, parseInt(this.cs.get(CS_VOTE_NO), 10) || 0];
  }

  // ---- actions ----

  async teamsize(): Promise<number> {
    const val = await this.engine.rpc("get_cvar", "teamsize");
    return val === null ? 0 : parseInt(val, 10) || 0;
  }
  setTeamsize(size: number): Promise<null> {
    return this.engine.rpc("console_command", `teamsize ${size}`);
  }
  changeMap(map: string, factory?: string): Promise<null> {
    return this.engine.rpc("console_command", factory ? `map ${map} ${factory}` : `map ${map}`);
  }
  abort(): Promise<null> {
    return this.engine.rpc("console_command", "map_restart");
  }
  shuffle(): Promise<null> {
    return this.engine.rpc("console_command", "forceshuffle");
  }
  addTeamScore(team: "red" | "blue", score: number): Promise<null> {
    return this.engine.rpc("console_command", `addteamscore ${team} ${score}`);
  }
}
