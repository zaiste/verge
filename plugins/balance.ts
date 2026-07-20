/**
 * balance - Elo-based team balancing (port of balance.py).
 *
 * Fetches player ratings from a qlstats-style HTTP API, caches them, and
 * suggests/executes team switches to even out the teams.
 *
 * Commands:
 *   !teams/!teens            - show team averages and a switch suggestion
 *   !balance                 - forcibly balance the teams (perm 1)
 *   !do                      - execute the suggested switch (perm 1)
 *   !agree/!a                - agree to a suggested switch (both players)
 *   !getrating/!getelo/!elo  - show a player's rating
 *   !setrating/!setelo       - set a local rating override (perm 3)
 *   !remrating/!remelo       - remove a local rating override (perm 3)
 *   !ratings/!elos/!selo     - list everyone's ratings
 *
 * Config keys ([plugin.balance] in minqlx.toml), formerly qlx_balance* cvars:
 *   use_local               - use local DB rating overrides (default true,
 *                             was qlx_balanceUseLocal)
 *   api_url                 - rating API base URL (default
 *                             "http://qlstats.net/elo/", was qlx_balanceUrl +
 *                             qlx_balanceApi)
 *   auto_balance            - auto-balance after a passed shuffle vote and
 *                             agreed suggestions (default true, was
 *                             qlx_balanceAuto)
 *   minimum_suggestion_diff - minimum rating gain before a switch is
 *                             suggested (default 25, was
 *                             qlx_balanceMinimumSuggestionDiff)
 */
import type { Plugin, PluginContext } from "../runtime/src/plugin";
import type { Player } from "../runtime/src/players";
import type { Channel } from "../runtime/src/channels";
import { EventResult } from "../runtime/src/constants";

const RATING_KEY = (steamId: string, gametype: string) =>
  `minqlx:players:${steamId}:ratings:${gametype}`;
const MAX_ATTEMPTS = 3;
const CACHE_EXPIRE_MS = 60 * 10 * 1000; // 10 minute TTL.
const DEFAULT_RATING = 1500;
const UNTRACKED_RATING = 9999;
const SUPPORTED_GAMETYPES = ["ad", "ca", "ctf", "dom", "ft", "tdm"];
// Externally supported game types, used by !getrating.
const EXT_SUPPORTED_GAMETYPES = ["ad", "ca", "ctf", "dom", "ft", "tdm", "duel", "ffa"];

interface RatingEntry {
  elo: number;
  games: number;
  local: boolean;
  /** Epoch ms when fetched; -1 = local override, never expires. */
  time: number;
}

interface ApiGametypeRating {
  elo?: number;
  games?: number;
}

interface ApiResponse {
  players?: ({ steamid: string } & Record<string, ApiGametypeRating | string>)[];
  untracked?: (string | number)[];
}

interface Teams {
  free: Player[];
  red: Player[];
  blue: Player[];
  spectator: Player[];
}

class Balance {
  /** steam id -> gametype -> rating entry. */
  readonly ratings = new Map<string, Record<string, RatingEntry>>();
  suggestedPair: [Player, Player] | null = null;
  suggestedAgree: [boolean, boolean] = [false, false];
  inCountdown = false;

  private readonly useLocal: boolean;
  private readonly apiUrl: string;
  private readonly autoBalance: boolean;
  private readonly minimumSuggestionDiff: number;

  constructor(private ctx: PluginContext) {
    this.useLocal = Boolean(ctx.config.use_local ?? true);
    const url = String(ctx.config.api_url ?? "http://qlstats.net/elo/");
    this.apiUrl = url.endsWith("/") ? url : url + "/";
    this.autoBalance = Boolean(ctx.config.auto_balance ?? true);
    this.minimumSuggestionDiff = Number(ctx.config.minimum_suggestion_diff ?? 25);
  }

  teams(): Teams {
    const teams: Teams = { free: [], red: [], blue: [], spectator: [] };
    for (const p of this.ctx.players()) teams[p.team].push(p);
    return teams;
  }

  // ---- rating cache & API ----

  getElo(steamId: string, gametype: string): number {
    return this.ratings.get(steamId)?.[gametype]?.elo ?? DEFAULT_RATING;
  }

  private setRatingEntry(steamId: string, gametype: string, entry: RatingEntry): void {
    let record = this.ratings.get(steamId);
    if (!record) {
      record = {};
      this.ratings.set(steamId, record);
    }
    record[gametype] = entry;
  }

  /** Drops already-cached (and unexpired) entries from the wanted map. */
  private removeCached(players: Map<string, string>): Map<string, string> {
    for (const [sid, gt] of [...players]) {
      const entry = this.ratings.get(sid)?.[gt];
      if (entry && (entry.time === -1 || Date.now() < entry.time + CACHE_EXPIRE_MS)) {
        players.delete(sid);
      }
    }
    return players;
  }

  /**
   * Ensures ratings for the given steam id -> gametype map are cached,
   * fetching from the API when necessary. Replies with an error to the
   * channel and returns false on failure.
   */
  async requestRatings(wanted: Map<string, string>, channel: Channel): Promise<boolean> {
    const players = this.removeCached(new Map(wanted));
    if (players.size === 0) return true;

    // Local overrides from the DB first.
    if (this.useLocal) {
      for (const [sid, gt] of [...players]) {
        const local = this.ctx.db.get(RATING_KEY(sid, gt));
        if (local !== null) {
          this.setRatingEntry(sid, gt, {
            elo: parseInt(local, 10),
            games: -1,
            local: true,
            time: -1,
          });
          players.delete(sid);
        }
      }
      if (players.size === 0) return true;
    }

    const status = await this.fetchRatings(players);
    if (status !== 200) {
      await channel.reply(`ERROR ${status}: Failed to fetch ratings.`);
      return false;
    }
    return true;
  }

  /** Fetches ratings from the API. Returns 200 on success, else a status. */
  private async fetchRatings(players: Map<string, string>): Promise<number> {
    let lastStatus = 0;

    for (let attempts = 0; attempts < MAX_ATTEMPTS; attempts++) {
      const url = this.apiUrl + [...players.keys()].join("+");
      let js: ApiResponse;
      try {
        const res = await fetch(url, { headers: { "X-QuakeLive-Map": this.ctx.game.map } });
        lastStatus = res.status;
        if (!res.ok) continue;
        js = (await res.json()) as ApiResponse;
      } catch {
        lastStatus = 0;
        continue;
      }
      if (!js.players) {
        lastStatus = -1;
        continue;
      }

      const now = Date.now();
      const pending = new Map(players);

      for (const p of js.players) {
        const sid = String(p.steamid);
        for (const [gt, val] of Object.entries(p)) {
          if (gt === "steamid" || typeof val !== "object" || val === null) continue;
          let elo = Number(val.elo ?? 0);
          const games = Number(val.games ?? -1);
          if (elo === 0 && games === 0) elo = DEFAULT_RATING;
          this.setRatingEntry(sid, gt, { elo, games, local: false, time: now });
          if (pending.get(sid) === gt) pending.delete(sid);
        }
        // Fill the game types the API didn't return but supports.
        const record = this.ratings.get(sid)!;
        for (const gt of SUPPORTED_GAMETYPES) {
          if (!(gt in record)) {
            record[gt] = { elo: DEFAULT_RATING, games: -1, local: false, time: now };
          }
        }
      }

      // Players the API didn't return get the default rating.
      for (const [sid, gt] of pending) {
        this.setRatingEntry(sid, gt, { elo: DEFAULT_RATING, games: -1, local: false, time: now });
      }

      // Untracked players get the untracked rating everywhere.
      for (const sid of js.untracked ?? []) {
        for (const gt of SUPPORTED_GAMETYPES) {
          this.setRatingEntry(String(sid), gt, {
            elo: UNTRACKED_RATING,
            games: -1,
            local: false,
            time: now,
          });
        }
      }

      return 200;
    }

    return lastStatus;
  }

  // ---- balancing logic ----

  teamAverage(team: Player[], gametype: string): number {
    if (team.length === 0) return 0;
    let sum = 0;
    for (const p of team) sum += this.getElo(p.steamId, gametype);
    return sum / team.length;
  }

  /**
   * Suggests the red/blue swap that most reduces the team rating
   * difference, or null if no swap improves it.
   */
  suggestSwitch(
    teams: Teams,
    gametype: string,
  ): { pair: [Player, Player]; improvement: number } | null {
    const curDiff = Math.abs(
      this.teamAverage(teams.red, gametype) - this.teamAverage(teams.blue, gametype),
    );
    let minDiff = 999999;
    let bestPair: [Player, Player] | null = null;

    for (const redP of teams.red) {
      for (const blueP of teams.blue) {
        const r = teams.red.filter((p) => p !== redP).concat(blueP);
        const b = teams.blue.filter((p) => p !== blueP).concat(redP);
        const diff = Math.abs(this.teamAverage(r, gametype) - this.teamAverage(b, gametype));
        if (diff < minDiff) {
          minDiff = diff;
          bestPair = [redP, blueP];
        }
      }
    }

    if (bestPair && minDiff < curDiff) {
      return { pair: bestPair, improvement: curDiff - minDiff };
    }
    return null;
  }

  private formatAverages(avgRed: number, avgBlue: number): string {
    const red = Math.round(avgRed);
    const blue = Math.round(avgBlue);
    const diff = Math.abs(red - blue);
    if (red > blue) return `^1${red} ^7vs ^4${blue}^7 - DIFFERENCE: ^1${diff}`;
    if (red < blue) return `^1${red} ^7vs ^4${blue}^7 - DIFFERENCE: ^4${diff}`;
    return `^1${red} ^7vs ^4${blue}^7 - Holy shit!`;
  }

  /** Swaps two players' teams. */
  private async switchPlayers(p1: Player, p2: Player): Promise<void> {
    const t1 = p1.team;
    const t2 = p2.team;
    if (t1 === t2) return;
    await p1.put(t2);
    await p2.put(t1);
  }

  async executeSuggestion(): Promise<void> {
    if (!this.suggestedPair) return;
    const [p1, p2] = this.suggestedPair;
    await p1.update();
    await p2.update();

    // Bail if either player is no longer on the server.
    const present =
      this.ctx.player(p1.id)?.steamId === p1.steamId &&
      this.ctx.player(p2.id)?.steamId === p2.steamId;

    if (present && p1.team !== "spectator" && p2.team !== "spectator") {
      await this.switchPlayers(p1, p2);
    }

    this.suggestedPair = null;
    this.suggestedAgree = [false, false];
  }

  // ---- command callbacks ----

  /**
   * Resolves a command argument to a steam id: 0-63 is a client id, anything
   * else is a SteamID64. Returns null (after telling the player) on error.
   */
  private async resolveSteamId(
    player: Player,
    arg: string,
  ): Promise<{ steamId: string; target: Player | null } | null> {
    if (!/^\d+$/.test(arg)) {
      await player.tell("Invalid ID. Use either a client ID or a SteamID64.");
      return null;
    }
    const num = Number(arg);
    if (num >= 0 && num < 64) {
      const target = this.ctx.player(num);
      if (!target) {
        await player.tell("Invalid client ID. Use either a client ID or a SteamID64.");
        return null;
      }
      return { steamId: target.steamId, target };
    }
    return { steamId: arg, target: null };
  }

  async cmdGetRating(player: Player, args: string[], channel: Channel): Promise<unknown> {
    let steamId = player.steamId;
    let gt: string;

    if (args.length > 1) {
      const resolved = await this.resolveSteamId(player, args[1]!);
      if (!resolved) return EventResult.StopAll;
      steamId = resolved.steamId;
    }

    if (args.length > 2) {
      gt = args[2]!.toLowerCase();
      if (!EXT_SUPPORTED_GAMETYPES.includes(gt)) {
        await player.tell(
          `Invalid gametype. Supported gametypes: ${EXT_SUPPORTED_GAMETYPES.join(", ")}`,
        );
        return EventResult.StopAll;
      }
    } else {
      gt = this.ctx.game.typeShort;
      if (!EXT_SUPPORTED_GAMETYPES.includes(gt)) {
        await player.tell("This game mode is not supported by the balance plugin.");
        return EventResult.StopAll;
      }
    }

    if (!(await this.requestRatings(new Map([[steamId, gt]]), channel))) return;
    const name = this.ctx.players().find((p) => p.steamId === steamId)?.name ?? steamId;
    await channel.reply(
      `${name} has a rating of ^6${this.getElo(steamId, gt)}^7 in ${gt.toUpperCase()}.`,
    );
  }

  async cmdSetRating(player: Player, args: string[], channel: Channel): Promise<unknown> {
    if (args.length < 3) return EventResult.Usage;

    const resolved = await this.resolveSteamId(player, args[1]!);
    if (!resolved) return EventResult.StopAll;
    const { steamId, target } = resolved;

    const rating = parseInt(args[2]!, 10);
    if (!/^-?\d+$/.test(args[2]!) || Number.isNaN(rating)) {
      await player.tell("Invalid rating.");
      return EventResult.StopAll;
    }

    const name = target ? target.name : steamId;
    const gt = this.ctx.game.typeShort;
    this.ctx.db.set(RATING_KEY(steamId, gt), rating);

    // If we have the player cached, update the entry.
    const record = this.ratings.get(steamId);
    if (record?.[gt]) {
      record[gt] = { ...record[gt], elo: rating, local: true, time: -1 };
    }

    await channel.reply(`${name}'s ${gt.toUpperCase()} rating has been set to ^6${rating}^7.`);
  }

  async cmdRemRating(player: Player, args: string[], channel: Channel): Promise<unknown> {
    if (args.length < 2) return EventResult.Usage;

    const resolved = await this.resolveSteamId(player, args[1]!);
    if (!resolved) return EventResult.StopAll;
    const { steamId, target } = resolved;

    const name = target ? target.name : steamId;
    const gt = this.ctx.game.typeShort;
    this.ctx.db.del(RATING_KEY(steamId, gt));

    // If we have the player cached, remove the game type.
    const record = this.ratings.get(steamId);
    if (record?.[gt]) delete record[gt];

    await channel.reply(`${name}'s locally set ${gt.toUpperCase()} rating has been deleted.`);
  }

  async cmdBalance(player: Player, _args: string[], _channel: Channel): Promise<unknown> {
    const gt = this.ctx.game.typeShort;
    if (!SUPPORTED_GAMETYPES.includes(gt)) {
      await player.tell("This game mode is not supported by the balance plugin.");
      return EventResult.StopAll;
    }

    const teams = this.teams();
    if ((teams.red.length + teams.blue.length) % 2 !== 0) {
      await player.tell("The total number of players should be an even number.");
      return EventResult.StopAll;
    }

    await this.balanceTeams(this.ctx.channels.chat);
  }

  async balanceTeams(channel: Channel): Promise<void> {
    const gt = this.ctx.game.typeShort;
    const teams = this.teams();
    const wanted = new Map([...teams.red, ...teams.blue].map((p) => [p.steamId, gt] as const));
    if (!(await this.requestRatings(wanted, channel))) return;

    // People may have joined while we were requesting ratings; refetch.
    const fresh = this.teams();
    const current = [...fresh.red, ...fresh.blue];
    for (const p of current) {
      if (!wanted.has(p.steamId)) {
        await this.balanceTeams(channel);
        return;
      }
    }

    // Even out the number of players on each team first.
    const diff = fresh.red.length - fresh.blue.length;
    if (Math.abs(diff) > 1) {
      const [from, to] = diff > 0 ? (["red", "blue"] as const) : (["blue", "red"] as const);
      for (let i = 0; i < Math.abs(diff) - 1; i++) {
        const p = fresh[from].pop()!;
        await p.put(to);
        fresh[to].push(p);
      }
    }

    // Keep applying the best switch until no switch improves the teams.
    let switched = false;
    let suggestion = this.suggestSwitch(fresh, gt);
    while (suggestion) {
      switched = true;
      const [p1, p2] = suggestion.pair;
      await this.switchPlayers(p1, p2);
      fresh.blue = fresh.blue.filter((p) => p !== p2).concat(p1);
      fresh.red = fresh.red.filter((p) => p !== p1).concat(p2);
      suggestion = this.suggestSwitch(fresh, gt);
    }

    if (switched) {
      await this.ctx.msg(
        this.formatAverages(this.teamAverage(fresh.red, gt), this.teamAverage(fresh.blue, gt)),
      );
    } else {
      await channel.reply("Teams are good! Nothing to balance.");
    }
  }

  async cmdTeams(player: Player, _args: string[], channel: Channel): Promise<unknown> {
    const gt = this.ctx.game.typeShort;
    if (!SUPPORTED_GAMETYPES.includes(gt)) {
      await player.tell("This game mode is not supported by the balance plugin.");
      return EventResult.StopAll;
    }

    const teams = this.teams();
    if (teams.red.length !== teams.blue.length) {
      await player.tell("Both teams should have the same number of players.");
      return EventResult.StopAll;
    }

    await this.reportTeams(channel);
  }

  async reportTeams(channel: Channel): Promise<void> {
    const gt = this.ctx.game.typeShort;
    const teams = this.teams();
    const wanted = new Map([...teams.red, ...teams.blue].map((p) => [p.steamId, gt] as const));
    if (!(await this.requestRatings(wanted, channel))) return;

    // People may have joined while we were requesting ratings; refetch.
    const fresh = this.teams();
    for (const p of [...fresh.red, ...fresh.blue]) {
      if (!wanted.has(p.steamId)) {
        await this.reportTeams(channel);
        return;
      }
    }

    const avgRed = this.teamAverage(fresh.red, gt);
    const avgBlue = this.teamAverage(fresh.blue, gt);
    await channel.reply(this.formatAverages(avgRed, avgBlue));

    const suggestion = this.suggestSwitch(fresh, gt);
    if (suggestion && suggestion.improvement >= this.minimumSuggestionDiff) {
      const [p1, p2] = suggestion.pair;
      await channel.reply(
        `SUGGESTION: switch ^6${p1.cleanName}^7 with ^6${p2.cleanName}^7. ` +
          "Mentioned players can type !a to agree.",
      );
      if (
        !this.suggestedPair ||
        this.suggestedPair[0] !== p1 ||
        this.suggestedPair[1] !== p2
      ) {
        this.suggestedPair = [p1, p2];
        this.suggestedAgree = [false, false];
      }
    } else {
      await channel.reply(
        Math.floor(Math.random() * 100) === 0 ? "Teens look ^6good!" : "Teams look good!",
      );
      this.suggestedPair = null;
    }
  }

  async cmdDo(): Promise<void> {
    if (this.suggestedPair) await this.executeSuggestion();
  }

  async cmdAgree(player: Player): Promise<void> {
    if (!this.suggestedPair || (this.suggestedAgree[0] && this.suggestedAgree[1])) return;
    const [p1, p2] = this.suggestedPair;

    if (p1 === player) this.suggestedAgree[0] = true;
    else if (p2 === player) this.suggestedAgree[1] = true;

    if (this.suggestedAgree[0] && this.suggestedAgree[1]) {
      // If the game's in progress and we're not in the round countdown,
      // wait for the next round.
      if (this.ctx.game.state === "in_progress" && !this.inCountdown) {
        await this.ctx.msg("The switch will be executed at the start of next round.");
        return;
      }
      await this.executeSuggestion();
    }
  }

  async cmdRatings(player: Player, _args: string[], channel: Channel): Promise<unknown> {
    const gt = this.ctx.game.typeShort;
    if (!EXT_SUPPORTED_GAMETYPES.includes(gt)) {
      await player.tell("This game mode is not supported by the balance plugin.");
      return EventResult.StopAll;
    }

    await this.reportRatings(channel);
  }

  async reportRatings(channel: Channel): Promise<void> {
    const gt = this.ctx.game.typeShort;
    const wanted = new Map(this.ctx.players().map((p) => [p.steamId, gt] as const));
    if (!(await this.requestRatings(wanted, channel))) return;

    // People may have joined while we were requesting ratings; refetch.
    for (const p of this.ctx.players()) {
      if (!wanted.has(p.steamId)) {
        await this.reportRatings(channel);
        return;
      }
    }

    const teams = this.teams();
    const line = (team: Player[], color: string): string =>
      [...team]
        .sort((a, b) => this.getElo(b.steamId, gt) - this.getElo(a.steamId, gt))
        .map((p) => `${p.cleanName}: ${color}${this.getElo(p.steamId, gt)}^7`)
        .join(", ");

    if (teams.free.length) await channel.reply(line(teams.free, "^6"));
    if (teams.red.length) await channel.reply(line(teams.red, "^1"));
    if (teams.blue.length) await channel.reply(line(teams.blue, "^4"));
    if (teams.spectator.length) await channel.reply(line(teams.spectator, ""));
  }

  // ---- event handlers ----

  handleRoundCountdown(): void {
    if (this.suggestedAgree[0] && this.suggestedAgree[1]) {
      // Delay the switch a tick so the countdown sound/text isn't lost.
      this.ctx.delay(0, () => void this.executeSuggestion());
    }
    this.inCountdown = true;
  }

  handleRoundStart(): void {
    this.inCountdown = false;
  }

  handleVoteEnded(_votes: [number, number], vote: string, _args: string, passed: boolean): void {
    if (!passed || vote !== "shuffle" || !this.autoBalance) return;
    const gt = this.ctx.game.typeShort;
    if (!SUPPORTED_GAMETYPES.includes(gt)) return;

    this.ctx.delay(3500, () => {
      const teams = this.teams();
      if ((teams.red.length + teams.blue.length) % 2 !== 0) {
        void this.ctx.msg(
          "Teams were ^6NOT^7 balanced due to the total number of players being an odd number.",
        );
        return;
      }
      void this.balanceTeams(this.ctx.channels.chat);
    });
  }

  handlePlayerDisconnect(player: Player): void {
    // Keep the data if another client shares this steam id.
    for (const p of this.ctx.players()) {
      if (p.steamId === player.steamId && p.id !== player.id) return;
    }
    this.ratings.delete(player.steamId);
  }

  handleNewGame(): void {
    // Reset the ratings cache when a new game starts in warmup.
    if (this.ctx.game.state === "warmup") this.ratings.clear();
  }
}

export default {
  name: "balance",
  setup(ctx) {
    const balance = new Balance(ctx);

    ctx.on("round_countdown", () => balance.handleRoundCountdown());
    ctx.on("round_start", () => balance.handleRoundStart());
    ctx.on("vote_ended", (votes, vote, args, passed) =>
      balance.handleVoteEnded(votes, vote, args, passed),
    );
    ctx.on("player_disconnect", (player) => balance.handlePlayerDisconnect(player));
    ctx.on("new_game", () => balance.handleNewGame());

    ctx.command(["setrating", "setelo"], { permission: 3, usage: "<id> <rating>" }, (p, a, c) =>
      balance.cmdSetRating(p, a, c),
    );
    ctx.command(["getrating", "getelo", "elo"], { usage: "<id> [gametype]" }, (p, a, c) =>
      balance.cmdGetRating(p, a, c),
    );
    ctx.command(["remrating", "remelo"], { permission: 3, usage: "<id>" }, (p, a, c) =>
      balance.cmdRemRating(p, a, c),
    );
    ctx.command("balance", { permission: 1 }, (p, a, c) => balance.cmdBalance(p, a, c));
    ctx.command(["teams", "teens"], (p, a, c) => balance.cmdTeams(p, a, c));
    ctx.command("do", { permission: 1 }, () => balance.cmdDo());
    ctx.command(["agree", "a"], { clientCmdPerm: 0 }, (p) => balance.cmdAgree(p));
    ctx.command(["ratings", "elos", "selo"], (p, a, c) => balance.cmdRatings(p, a, c));
  },
} satisfies Plugin;
