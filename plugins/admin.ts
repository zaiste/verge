/**
 * admin — consolidated port of the classic Python admin plugins:
 * essentials.py, ban.py, silence.py and permission.py.
 *
 * Not ported (and why):
 * - essentials !rcon, !db — relied on console-print redirection / raw Redis access.
 * - essentials !sounds/!sound/!music/!stopsound/!stopmusic — no sound RPCs in the runtime.
 * - essentials !help/!about/!version — printed Python module versions.
 * - essentials !mappool + map-pool vote enforcement — read a mappool file from disk;
 *   no mappool contract in the TS runtime yet.
 * - essentials per-player name/IP history on connect (Redis sets/lists) — only
 *   last_seen is kept (used by !seen).
 *
 * Renames / semantic changes:
 * - !ban and !tempban are aliases for the time-based ban (ban.py's format:
 *   "<id> <length> seconds|minutes|hours|days|weeks|months|years [reason]");
 *   essentials' old "tempban until the map ends" lives on as !kickban.
 * - Bans and silences are single kv records with a ttl instead of Redis zsets:
 *   verge:players:<steamId>:ban and :silence. Leaver counts (games_completed/
 *   games_left) and last_seen keep their original key names.
 * - !ban/!silence/!unban/!unsilence also act on a *connected* player when given
 *   a SteamID64 (Python only kicked/muted when given a client id).
 * - Config ([plugin.admin] in verge.toml) replaces the qlx_* cvars:
 *     vote_pass            (qlx_votepass, default true)
 *     vote_pass_threshold  (qlx_votepassThreshold, default 0.33)
 *     vote_pass_delay      (seconds before a winning vote is forced, default 29)
 *     teamsize_minimum     (qlx_teamsizeMinimum, default 1)
 *     teamsize_maximum     (qlx_teamsizeMaximum, default 8)
 *     leaver_ban           (qlx_leaverBan, default false)
 *     leaver_ban_threshold (qlx_leaverBanThreshold, default 0.63)
 *     leaver_warn_threshold(qlx_leaverBanWarnThreshold, default 0.78)
 *     leaver_min_games     (qlx_leaverBanMinimumGames, default 15)
 * - game_start/game_end/team_switch handlers (leaver tracking) are registered
 *   but stay dormant until the ZMQ stats feed is wired up.
 */
import type { Plugin, PluginContext } from "../runtime/src/plugin";
import type { Player } from "../runtime/src/players";
import type { CommandHandler, CommandOptions } from "../runtime/src/commands";
import type { SteamId } from "../runtime/src/protocol";
import { EventResult, PRIV_ADMIN, PRIV_MOD, PRIV_NONE, Priority } from "../runtime/src/constants";
import { cleanText } from "../runtime/src/util";

const playerKey = (sid: SteamId) => `verge:players:${sid}`;
const banKey = (sid: SteamId) => `${playerKey(sid)}:ban`;
const silenceKey = (sid: SteamId) => `${playerKey(sid)}:silence`;

interface PunishmentRecord {
  expires: string;
  reason: string;
  issued: string;
  issuedBy: SteamId;
}

// ---- duration parsing (ban.py's LENGTH_REGEX) ----

const LENGTH_RE = /^([0-9]+) (second|minute|hour|day|week|month|year)s?$/;
const SCALE_SECONDS: Record<string, number> = {
  second: 1,
  minute: 60,
  hour: 3600,
  day: 86400,
  week: 604800,
  month: 86400 * 30,
  year: 604800 * 52,
};

/** Parses e.g. "5 minutes" or "2 days" into seconds; null when unparsable. */
export function parseLength(text: string): number | null {
  const m = LENGTH_RE.exec(text);
  if (!m) return null;
  return parseInt(m[1]!, 10) * SCALE_SECONDS[m[2]!]!;
}

// ---- date formatting ("%Y-%m-%d %H:%M:%S", kept for Redis-import compat) ----

const pad = (n: number) => String(n).padStart(2, "0");

function formatDate(d: Date): string {
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

function parseDate(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(s);
  if (!m) return null;
  return new Date(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!);
}

// ---- config helpers ----

function cfgBool(cfg: Record<string, unknown>, key: string, def: boolean): boolean {
  const v = cfg[key];
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") return !["", "0", "false", "no"].includes(v.toLowerCase());
  return def;
}

function cfgNum(cfg: Record<string, unknown>, key: string, def: number): number {
  const v = cfg[key];
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))) return Number(v);
  return def;
}

const randInt = (min: number, max: number) => min + Math.floor(Math.random() * (max - min + 1));

export default {
  name: "admin",
  setup(ctx: PluginContext) {
    const conf = {
      votePass: cfgBool(ctx.config, "vote_pass", true),
      votePassThreshold: cfgNum(ctx.config, "vote_pass_threshold", 0.33),
      votePassDelay: cfgNum(ctx.config, "vote_pass_delay", 29),
      teamsizeMin: cfgNum(ctx.config, "teamsize_minimum", 1),
      teamsizeMax: cfgNum(ctx.config, "teamsize_maximum", 8),
      leaverBan: cfgBool(ctx.config, "leaver_ban", false),
      leaverBanThreshold: cfgNum(ctx.config, "leaver_ban_threshold", 0.63),
      leaverWarnThreshold: cfgNum(ctx.config, "leaver_warn_threshold", 0.78),
      leaverMinGames: cfgNum(ctx.config, "leaver_min_games", 15),
    };

    // ---- state ----
    let voteCount = 0;
    let lastVote = 0;
    /** Recently executed commands; index 0 is the one currently running. */
    const recentCmds: { name: string; msg: string }[] = [];
    const recentDcs: { name: string; steamId: SteamId; at: number }[] = [];
    /** red/blue players when the current game started (leaver tracking). */
    const playersStart = new Map<SteamId, string>();
    const pendingWarnings = new Map<SteamId, number>();
    /** Players we engine-muted, so an expired silence can be unmuted lazily. */
    const mutedByUs = new Set<SteamId>();

    // ---- shared helpers ----

    const readRecord = (key: string): PunishmentRecord | null => {
      const raw = ctx.db.get(key);
      if (!raw) return null;
      try {
        return JSON.parse(raw) as PunishmentRecord;
      } catch {
        return null;
      }
    };

    const isBanned = (sid: SteamId) => readRecord(banKey(sid));
    const isSilenced = (sid: SteamId) => readRecord(silenceKey(sid));

    const silencedMessage = (rec: PunishmentRecord) =>
      rec.reason
        ? `You are muted on this server until ^6${rec.expires}^7: ${rec.reason}`
        : `You are muted on this server until ^6${rec.expires}^7.`;

    const incr = (key: string) => {
      ctx.db.set(key, (parseInt(ctx.db.get(key) ?? "0", 10) || 0) + 1);
    };

    interface Resolved {
      steamId: SteamId;
      player: Player | null;
      name: string;
    }

    /** Python's "client id (0-63) or SteamID64" argument convention. */
    const resolveIdent = (arg: string): Resolved | string => {
      if (!/^\d+$/.test(arg)) return "Invalid ID. Use either a client ID or a SteamID64.";
      const n = Number(arg);
      if (n < 64) {
        const p = ctx.player(n);
        if (!p) return "Invalid client ID. Use either a client ID or a SteamID64.";
        return { steamId: p.steamId, player: p, name: p.name };
      }
      const online = ctx.players().find((p) => p.steamId === arg) ?? null;
      return { steamId: arg, player: online, name: online?.name ?? arg };
    };

    /** Connected player by client id argument, essentials-style. */
    const targetById = (arg: string | undefined): Player | null => {
      if (!arg || !/^\d+$/.test(arg)) return null;
      const i = parseInt(arg, 10);
      if (i < 0 || i >= 64) return null;
      return ctx.player(i);
    };

    const teamPlayers = () => ctx.players().filter((p) => p.team === "red" || p.team === "blue");

    const leaveStatus = (sid: SteamId): { action: "warn" | "ban"; ratio: number } | null => {
      if (!conf.leaverBan) return null;
      const completedRaw = ctx.db.get(`${playerKey(sid)}:games_completed`);
      const leftRaw = ctx.db.get(`${playerKey(sid)}:games_left`);
      if (completedRaw === null || leftRaw === null) return null;
      const completed = parseInt(completedRaw, 10) || 0;
      const left = parseInt(leftRaw, 10) || 0;
      const total = completed + left;
      if (!total) return null;

      const min = conf.leaverMinGames;
      // Under the minimum, rate them as if they completed every remaining game.
      const ratio = total < min ? (completed + (min - total)) / min : completed / total;

      let action: "warn" | "ban" | null = null;
      if (ratio <= conf.leaverWarnThreshold && (ratio > conf.leaverBanThreshold || total < min)) {
        action = "warn";
      } else if (ratio <= conf.leaverBanThreshold && total >= min) {
        action = "ban";
      }
      return action ? { action, ratio: completed / total } : null;
    };

    /** Registers a command whose client-command permission mirrors its chat
     * permission (Python's add_command default). */
    const cmd = (names: string | string[], opts: CommandOptions, handler: CommandHandler) =>
      ctx.command(names, { clientCmdPerm: opts.permission ?? 0, ...opts }, handler);

    // ================================================================
    //                            EVENTS
    // ================================================================

    ctx.on(
      "player_connect",
      (player) => {
        const status = leaveStatus(player.steamId);
        if (status?.action === "ban") {
          return "You have been banned from this server for leaving too many games.";
        }
        if (status?.action === "warn") pendingWarnings.set(player.steamId, status.ratio);

        const banned = isBanned(player.steamId);
        if (banned) {
          return banned.reason
            ? `You are banned until ${banned.expires}: ${banned.reason}`
            : `You are banned until ${banned.expires}.`;
        }
      },
      Priority.High,
    );

    // Persistent mutes: re-mute silenced players when they finish loading.
    ctx.on("player_loaded", async (player) => {
      const silenced = isSilenced(player.steamId);
      if (!silenced) return;
      mutedByUs.add(player.steamId);
      await player.mute();
      await player.tell(silencedMessage(silenced));
    });

    // Leaver warning, delayed so the player actually sees it.
    ctx.on("player_loaded", (player) => {
      const ratio = pendingWarnings.get(player.steamId);
      if (ratio === undefined) return;
      pendingWarnings.delete(player.steamId);
      ctx.delay(4000, () => {
        const p = ctx.player(player.id);
        if (!p || p.steamId !== player.steamId) return;
        void p.tell(
          `^7You have only completed ^6${Math.round(ratio * 1000) / 10}^7 percent of your games.`,
        );
        void p.tell("^7If you keep leaving you ^6will^7 be banned.");
      });
    });

    ctx.on("player_disconnect", (player) => {
      recentDcs.unshift({ name: player.name, steamId: player.steamId, at: Date.now() });
      if (recentDcs.length > 10) recentDcs.pop();
      ctx.db.set(`${playerKey(player.steamId)}:last_seen`, formatDate(new Date()));
      mutedByUs.delete(player.steamId);

      // Leaving with uneven teams doesn't count as a leave.
      if (teamPlayers().length % 2 !== 0) playersStart.delete(player.steamId);
    });

    // Block chat from silenced players; unmute lazily once the silence expired.
    ctx.on(
      "client_command",
      async (player, command) => {
        const lc = command.toLowerCase();
        if (!lc.startsWith("say ") && !lc.startsWith("say_team ")) return;
        const silenced = isSilenced(player.steamId);
        if (silenced) {
          await player.tell(silencedMessage(silenced));
          return EventResult.StopAll;
        }
        if (mutedByUs.delete(player.steamId)) await player.unmute();
      },
      Priority.High,
    );

    // Silenced players can't dodge the mute by renaming.
    ctx.on(
      "userinfo",
      (player, changed) => {
        if (!changed.has("name") || !isSilenced(player.steamId)) return;
        changed.set("name", player.name.replace(/\^7$/, ""));
        return changed;
      },
      Priority.High,
    );

    ctx.on("vote_called", (caller, vote, args) => {
      if (vote.toLowerCase() === "teamsize") {
        if (!/^\s*\d+\s*$/.test(args)) return;
        const size = parseInt(args, 10);
        if (size > conf.teamsizeMax) {
          void caller.tell("The team size is larger than what the server allows.");
          return EventResult.StopAll;
        }
        if (size < conf.teamsizeMin) {
          void caller.tell("The team size is smaller than what the server allows.");
          return EventResult.StopAll;
        }
      }

      if (conf.votePass) {
        const voteId = ++voteCount;
        lastVote = voteId;
        ctx.delay(conf.votePassDelay * 1000, () => void forceVotePass(voteId));
      }
    });

    async function forceVotePass(voteId: number): Promise<void> {
      if (lastVote !== voteId) return; // not the vote we should be resolving
      if (!ctx.game.isVoteActive) return;
      const [yes, no] = ctx.game.voteCounts;
      if (yes <= no) return;
      if (conf.votePassThreshold > 0) {
        const active = ctx.players().filter((p) => p.team !== "spectator");
        if (active.length === 0) return;
        if ((yes + no) / active.length < conf.votePassThreshold) return;
      }
      await ctx.engine.rpc("force_vote", true);
    }

    ctx.on(
      "command",
      (caller, _command, msg) => {
        recentCmds.unshift({ name: caller.name, msg });
        if (recentCmds.length > 11) recentCmds.pop();
      },
      Priority.Low,
    );

    // ---- leaver tracking; game_* / team_switch fire once ZMQ stats land ----

    ctx.on("game_countdown", () => {
      if (conf.leaverBan) {
        void ctx.msg("Leavers are being kept track of. Repeat offenders ^6will^7 be banned.");
      }
    });

    ctx.on("game_start", () => {
      // Teams can be reset mid-event; sample them a second later.
      ctx.delay(1000, () => {
        playersStart.clear();
        for (const p of teamPlayers()) playersStart.set(p.steamId, p.cleanName);
      });
    });

    ctx.on("game_end", (data) => {
      if (data.ABORTED) {
        playersStart.clear();
        return;
      }
      const end = new Set(teamPlayers().map((p) => p.steamId));
      const leavers: string[] = [];
      for (const [sid, name] of [...playersStart]) {
        if (end.has(sid)) continue;
        leavers.push(name);
        playersStart.delete(sid);
        incr(`${playerKey(sid)}:games_left`);
      }
      for (const sid of playersStart.keys()) incr(`${playerKey(sid)}:games_completed`);
      if (leavers.length) {
        void ctx.msg(`^7Leavers: ^6${leavers.join(" ")}`);
        playersStart.clear();
      }
    });

    ctx.on("team_switch", (player, oldTeam, newTeam) => {
      // Spectating with even teams doesn't count as a leave.
      if ((oldTeam === "red" || oldTeam === "blue") && newTeam === "spectator") {
        if (teamPlayers().length % 2 === 0) playersStart.delete(player.steamId);
      }
      // Joining mid-game makes you a participant.
      if (
        oldTeam === "spectator" &&
        (newTeam === "red" || newTeam === "blue") &&
        ctx.game.state === "in_progress"
      ) {
        playersStart.set(player.steamId, player.cleanName);
      }
    });

    // ================================================================
    //                       BANS (ban.py)
    // ================================================================

    cmd(
      ["ban", "tempban"],
      { permission: 2, usage: "<id> <length> seconds|minutes|hours|days|... [reason]" },
      async (player, args, channel) => {
        if (args.length < 4) return EventResult.Usage;
        const r = resolveIdent(args[1]!);
        if (typeof r === "string") return channel.reply(r);

        if (ctx.db.hasPermission(r.steamId, 5)) {
          return channel.reply(`^6${r.name}^7 has permission level 5 and cannot be banned.`);
        }

        const seconds = parseLength(`${args[2]} ${args[3]}`.toLowerCase());
        if (seconds === null) return EventResult.Usage;
        if (seconds <= 0) return;
        const reason = args.slice(4).join(" ");

        const now = new Date();
        const expires = formatDate(new Date(now.getTime() + seconds * 1000));
        const record: PunishmentRecord = {
          expires,
          reason,
          issued: formatDate(now),
          issuedBy: player.steamId,
        };
        ctx.db.set(banKey(r.steamId), JSON.stringify(record), { ttl: seconds });

        if (r.player) {
          await r.player.kick(`has been banned until ^6${expires}^7: ${reason}`);
        } else {
          await channel.reply(`^6${r.name} ^7has been banned. Ban expires on ^6${expires}^7.`);
        }
      },
    );

    cmd("unban", { permission: 2, usage: "<id>" }, async (_player, args, channel) => {
      if (args.length < 2) return EventResult.Usage;
      const r = resolveIdent(args[1]!);
      if (typeof r === "string") return channel.reply(r);

      if (!ctx.db.has(banKey(r.steamId))) {
        return channel.reply(`^7 No active bans on ^6${r.name}^7 found.`);
      }
      ctx.db.del(banKey(r.steamId));
      await channel.reply(`^6${r.name}^7 has been unbanned.`);
    });

    cmd("checkban", { usage: "<id>" }, async (_player, args, channel) => {
      if (args.length < 2) return EventResult.Usage;
      const r = resolveIdent(args[1]!);
      if (typeof r === "string") return channel.reply(r);

      const banned = isBanned(r.steamId);
      if (banned) {
        return channel.reply(
          banned.reason
            ? `^6${r.name}^7 is banned until ^6${banned.expires}^7 for the following reason:^6 ${banned.reason}`
            : `^6${r.name}^7 is banned until ^6${banned.expires}^7.`,
        );
      }
      if (leaveStatus(r.steamId)?.action === "ban") {
        return channel.reply(`^6${r.name} ^7is banned for having left too many games.`);
      }
      await channel.reply(`^6${r.name} ^7is not banned.`);
    });

    cmd("forgive", { permission: 2, usage: "<id> [leaves_to_forgive]" }, async (_player, args, channel) => {
      if (args.length < 2) return EventResult.Usage;
      const r = resolveIdent(args[1]!);
      if (typeof r === "string") return channel.reply(r);

      const base = playerKey(r.steamId);
      const known =
        ctx.db.has(`${base}:games_left`) ||
        ctx.db.has(`${base}:games_completed`) ||
        ctx.db.has(`${base}:last_seen`);
      if (!known) return channel.reply(`I do not know ^6${r.name}^7.`);

      const leaves = parseInt(ctx.db.get(`${base}:games_left`) ?? "0", 10) || 0;
      if (leaves <= 0) {
        return channel.reply(`^6${r.name}^7's leaves are already at ^6${leaves}^7.`);
      }

      let toForgive = 1;
      if (args.length > 2) {
        if (!/^\d+$/.test(args[2]!)) {
          return channel.reply("Unintelligible number of leaves to forgive. Please use numbers.");
        }
        toForgive = parseInt(args[2]!, 10);
      }

      const newLeaves = leaves - toForgive;
      if (newLeaves <= 0) {
        ctx.db.set(`${base}:games_left`, 0);
        await channel.reply(`^6${r.name}^7's leaves have been reduced to ^60^7.`);
      } else {
        ctx.db.set(`${base}:games_left`, newLeaves);
        await channel.reply(
          `^6${toForgive}^7 games have been forgiven, putting ^6${r.name}^7 at ^6${newLeaves}^7 leaves.`,
        );
      }
    });

    // ================================================================
    //                     SILENCES (silence.py)
    // ================================================================

    cmd(
      "silence",
      { permission: 2, usage: "<id> <length> seconds|minutes|hours|days|... [reason]" },
      async (player, args, channel) => {
        if (args.length < 4) return EventResult.Usage;
        const r = resolveIdent(args[1]!);
        if (typeof r === "string") return channel.reply(r);

        if (ctx.db.hasPermission(r.steamId, 2)) {
          return channel.reply(`^6${r.name}^7 has permission level 2 or more and cannot be silenced.`);
        }

        const seconds = parseLength(`${args[2]} ${args[3]}`.toLowerCase());
        if (seconds === null) return EventResult.Usage;
        if (seconds <= 0) return;
        const reason = args.slice(4).join(" ");

        const now = new Date();
        const expires = formatDate(new Date(now.getTime() + seconds * 1000));
        const record: PunishmentRecord = {
          expires,
          reason,
          issued: formatDate(now),
          issuedBy: player.steamId,
        };
        ctx.db.set(silenceKey(r.steamId), JSON.stringify(record), { ttl: seconds });

        if (r.player) {
          mutedByUs.add(r.steamId);
          await r.player.mute();
        }
        await channel.reply(`^6${r.name} ^7has been silenced. Silence expires on ^6${expires}^7.`);
      },
    );

    cmd("unsilence", { permission: 2, usage: "<id>" }, async (_player, args, channel) => {
      if (args.length < 2) return EventResult.Usage;
      const r = resolveIdent(args[1]!);
      if (typeof r === "string") return channel.reply(r);

      if (!ctx.db.has(silenceKey(r.steamId))) {
        return channel.reply(`^7 No active silences on ^6${r.name}^7 found.`);
      }
      ctx.db.del(silenceKey(r.steamId));
      mutedByUs.delete(r.steamId);
      if (r.player) await r.player.unmute();
      await channel.reply(`^6${r.name}^7 has been unsilenced.`);
    });

    cmd("checksilence", { usage: "<id>" }, async (_player, args, channel) => {
      if (args.length < 2) return EventResult.Usage;
      const r = resolveIdent(args[1]!);
      if (typeof r === "string") return channel.reply(r);

      const silenced = isSilenced(r.steamId);
      if (silenced) {
        return channel.reply(
          silenced.reason
            ? `^6${r.name}^7 is silenced until ^6${silenced.expires}^7 for the following reason:^6 ${silenced.reason}`
            : `^6${r.name}^7 is silenced until ^6${silenced.expires}^7.`,
        );
      }
      await channel.reply(`^6${r.name} ^7is not silenced.`);
    });

    // ================================================================
    //                   PERMISSIONS (permission.py)
    // ================================================================

    cmd("setperm", { permission: 5, usage: "<id> <level>" }, async (_player, args, channel) => {
      if (args.length < 3) return EventResult.Usage;
      const r = resolveIdent(args[1]!);
      if (typeof r === "string") return channel.reply(r);

      if (!/^\d$/.test(args[2]!) || Number(args[2]) > 5) {
        return channel.reply("Invalid permission level. Use a level between 0 and 5.");
      }
      const level = Number(args[2]);
      ctx.db.setPermission(r.steamId, level);
      await channel.reply(`^6${r.name}^7 was given permission level ^6${level}^7.`);
    });

    cmd("getperm", { permission: 5, usage: "<id>" }, async (_player, args, channel) => {
      if (args.length < 2) return EventResult.Usage;
      const r = resolveIdent(args[1]!);
      if (typeof r === "string") return channel.reply(r);

      if (r.steamId === ctx.owner) return channel.reply("That's my master.");
      const perm = ctx.db.getPermission(r.steamId);
      await channel.reply(`^6${r.name}^7 has permission level ^6${perm}^7.`);
    });

    cmd(
      "myperm",
      {
        channels: ["chat", "red_team_chat", "blue_team_chat", "spectator_chat", "free_chat", "client_command"],
      },
      async (player, _args, channel) => {
        if (player.steamId === ctx.owner) {
          return channel.reply("You can do anything to me, master.");
        }
        await channel.reply(`You have permission level ^6${ctx.db.getPermission(player.steamId)}^7.`);
      },
    );

    // ================================================================
    //                    ESSENTIALS (essentials.py)
    // ================================================================

    cmd("id", { permission: 1, usage: "[part_of_name] ..." }, async (player, args) => {
      const listAlternatives = (players: Player[]) =>
        player.tell(players.map((p) => `  ${p.id}^6:^7 ${p.name}`).join("\n"));

      const all = ctx.players();
      if (all.length === 0) {
        await player.tell("There are no players connected at the moment.");
      } else if (args.length === 1) {
        await player.tell("All connected players:");
        await listAlternatives(all);
      } else {
        const matched: Player[] = [];
        for (const token of args.slice(1)) {
          const t = cleanText(token).toLowerCase();
          for (const p of all) {
            if (p.cleanName.toLowerCase().includes(t) && !matched.includes(p)) matched.push(p);
          }
        }
        if (matched.length) {
          await player.tell(`A total of ^6${matched.length}^7 players matched:`);
          await listAlternatives(matched);
        } else {
          await player.tell("Sorry, but no players matched your tokens.");
        }
      }
      return EventResult.StopAll;
    });

    cmd("players", { permission: 1 }, async (player) => {
      const all = ctx.players();
      if (all.length === 0) {
        await player.tell("There are no players connected at the moment.");
        return EventResult.StopAll;
      }
      const lines = [`ID | ${"SteamID64".padEnd(17)} | ${"IP Address".padEnd(15)} | Name`];
      for (const p of all) {
        lines.push(
          `${String(p.id).padStart(2)} | ${p.steamId.padEnd(17)} | ${p.ip.padEnd(15)} | ${p.name}`,
        );
      }
      await player.tell(lines.join("\n"));
      return EventResult.StopAll;
    });

    cmd(["disconnects", "dcs"], { permission: 1 }, async (player) => {
      if (recentDcs.length === 0) {
        await player.tell("No players have disconnected yet.");
      } else {
        await player.tell(`The most recent ^6${recentDcs.length}^7 player disconnects:`);
        for (const dc of recentDcs) {
          const secondsAgo = Math.round((Date.now() - dc.at) / 1000);
          await player.tell(`  ${dc.name} (${dc.steamId}): ^6${secondsAgo}^7 seconds ago`);
        }
      }
      return EventResult.StopAll;
    });

    cmd(["commands", "cmds"], { permission: 2 }, async (player) => {
      if (recentCmds.length === 1) {
        await player.tell("No commands have been recorded yet.");
      } else {
        await player.tell(`The most recent ^6${recentCmds.length - 1}^7 commands executed:`);
        for (const c of recentCmds.slice(1)) {
          await player.tell(`  ${c.name} executed: ${c.msg}`);
        }
      }
      return EventResult.StopAll;
    });

    cmd("shuffle", { permission: 1 }, async () => {
      await ctx.game.shuffle();
    });

    cmd(["pause", "timeout"], { permission: 1 }, async () => {
      await ctx.engine.rpc("console_command", "pause");
    });

    cmd(["unpause", "timein"], { permission: 1 }, async () => {
      await ctx.engine.rpc("console_command", "unpause");
    });

    cmd("slap", { permission: 2, usage: "<id> [damage]" }, async (player, args) => {
      if (args.length < 2) return EventResult.Usage;
      const target = targetById(args[1]);
      if (!target) {
        await player.tell("Invalid ID.");
        return EventResult.StopAll;
      }
      let dmg = 0;
      if (args.length > 2) {
        if (!/^-?\d+$/.test(args[2]!)) {
          await player.tell("Invalid damage value.");
          return EventResult.StopAll;
        }
        dmg = parseInt(args[2]!, 10);
      }
      await target.slap(dmg);
      return EventResult.StopAll;
    });

    cmd("slay", { permission: 2, usage: "<id>" }, async (player, args) => {
      if (args.length < 2) return EventResult.Usage;
      const target = targetById(args[1]);
      if (!target) {
        await player.tell("Invalid ID.");
        return EventResult.StopAll;
      }
      await target.slay();
      return EventResult.StopAll;
    });

    cmd("kick", { permission: 2, usage: "<id>" }, async (_player, args, channel) => {
      if (args.length < 2) return EventResult.Usage;
      const target = targetById(args[1]);
      if (!target) return channel.reply("Invalid ID.");
      await target.kick(args.slice(2).join(" "));
    });

    // Engine-level tempban: keeps the player out for the rest of the map.
    cmd("kickban", { permission: 2, usage: "<id>" }, async (_player, args, channel) => {
      if (args.length < 2) return EventResult.Usage;
      const target = targetById(args[1]);
      if (!target) return channel.reply("Invalid ID.");
      await ctx.engine.rpc("console_command", `tempban ${target.id}`);
    });

    cmd("yes", { permission: 2 }, async (_player, _args, channel) => {
      if (!ctx.game.isVoteActive) return channel.reply("There is no active vote!");
      await ctx.engine.rpc("force_vote", true);
    });

    cmd("no", { permission: 2 }, async (_player, _args, channel) => {
      if (!ctx.game.isVoteActive) return channel.reply("There is no active vote!");
      await ctx.engine.rpc("force_vote", false);
    });

    cmd("random", { permission: 1, usage: "<limit>" }, async (player, args, channel) => {
      if (args.length < 2) return EventResult.Usage;
      const limit = /^\d+$/.test(args[1]!) ? parseInt(args[1]!, 10) : 0;
      if (limit < 1) {
        await player.tell("Invalid upper limit. Use a positive integer.");
        return EventResult.StopAll;
      }
      await channel.reply(`^3Random number is: ^5${randInt(1, limit)}`);
    });

    cmd("cointoss", { permission: 1 }, async (_player, _args, channel) => {
      await channel.reply(`^3The coin is: ^5${randInt(0, 1) ? "HEADS" : "TAILS"}`);
    });

    cmd("switch", { permission: 1, usage: "<id> <id>" }, async (_player, args, channel) => {
      if (args.length < 3) return EventResult.Usage;
      const p1 = targetById(args[1]);
      if (!p1) return channel.reply("The first ID is invalid.");
      const p2 = targetById(args[2]);
      if (!p2) return channel.reply("The second ID is invalid.");
      if (p1.team === p2.team) return channel.reply("Both players are on the same team.");
      const [t1, t2] = [p1.team, p2.team];
      await p1.put(t2);
      await p2.put(t1);
    });

    const putCommand = (names: string | string[], team: "red" | "blue" | "spectator" | "free") =>
      cmd(names, { permission: 1, usage: "<id>" }, async (_player, args, channel) => {
        if (args.length < 2) return EventResult.Usage;
        const target = targetById(args[1]);
        if (!target) return channel.reply("Invalid ID.");
        await target.put(team);
      });

    putCommand("red", "red");
    putCommand("blue", "blue");
    putCommand(["spectate", "spec", "spectator"], "spectator");
    putCommand("free", "free");

    const privCommand = (name: string, priv: number) =>
      cmd(name, { permission: 5, usage: "<id>" }, async (_player, args, channel) => {
        if (args.length < 2) return EventResult.Usage;
        const target = targetById(args[1]);
        if (!target) return channel.reply("Invalid ID.");
        await target.setPrivileges(priv);
      });

    privCommand("addmod", PRIV_MOD);
    privCommand("addadmin", PRIV_ADMIN);
    privCommand("demote", PRIV_NONE);

    cmd("mute", { permission: 1, usage: "<id>" }, async (player, args, channel) => {
      if (args.length < 2) return EventResult.Usage;
      const target = targetById(args[1]);
      if (!target) return channel.reply("Invalid ID.");
      if (target.id === player.id) return channel.reply("I refuse.");
      await target.mute();
    });

    cmd("unmute", { permission: 1, usage: "<id>" }, async (_player, args, channel) => {
      if (args.length < 2) return EventResult.Usage;
      const target = targetById(args[1]);
      if (!target) return channel.reply("Invalid ID.");
      await target.unmute();
    });

    const lockCommand = (name: "lock" | "unlock") =>
      cmd(name, { permission: 1, usage: "[team]" }, async (player, args) => {
        if (args.length > 1) {
          const initial = args[1]![0]!.toLowerCase();
          const team = initial === "s" ? "spectator" : initial === "r" ? "red" : initial === "b" ? "blue" : null;
          if (!team) {
            await player.tell("Invalid team.");
            return EventResult.StopAll;
          }
          await ctx.engine.rpc("console_command", `${name} ${team}`);
        } else {
          await ctx.engine.rpc("console_command", name);
        }
      });

    lockCommand("lock");
    lockCommand("unlock");

    cmd("allready", { permission: 2 }, async (_player, _args, channel) => {
      if (ctx.game.state !== "warmup") {
        return channel.reply("But the game's already in progress, you silly goose!");
      }
      await ctx.engine.rpc("console_command", "allready");
    });

    cmd("abort", { permission: 2 }, async (_player, _args, channel) => {
      if (ctx.game.state === "warmup") {
        return channel.reply("But the game isn't even on, you doofus!");
      }
      await ctx.game.abort();
    });

    cmd(["map", "changemap"], { permission: 2, usage: "<mapname> [factory]" }, async (_player, args) => {
      if (args.length < 2) return EventResult.Usage;
      await ctx.game.changeMap(args[1]!, args[2]);
    });

    cmd("seen", { usage: "<steam_id>" }, async (_player, args, channel) => {
      if (args.length < 2) return EventResult.Usage;
      const arg = args[1]!;
      if (!/^\d+$/.test(arg)) return channel.reply("Unintelligible SteamID64.");
      if (Number(arg) < 64) return channel.reply("Invalid SteamID64.");

      const online = ctx.players().find((p) => p.steamId === arg);
      if (online) {
        return channel.reply(`That would be ${online.name}^7, who is currently on this very server!`);
      }

      const name = arg === ctx.owner ? "my ^6master^7" : "that player";
      const stored = ctx.db.get(`verge:players:${arg}:last_seen`);
      const then = stored ? parseDate(stored) : null;
      if (!then) return channel.reply(`^7I have never seen ${name} before.`);

      const totalMinutes = Math.max(0, Math.floor((Date.now() - then.getTime()) / 60000));
      const days = Math.floor(totalMinutes / 1440);
      const hours = Math.floor((totalMinutes % 1440) / 60);
      const minutes = totalMinutes % 60;
      if (days > 0) {
        await channel.reply(
          `^7I saw ${name} ^6${days}^7 day(s), ^6${hours}^7 hour(s) and ^6${minutes}^7 minute(s) ago.`,
        );
      } else {
        await channel.reply(`^7I saw ${name} ^6${hours}^7 hour(s) and ^6${minutes}^7 minute(s) ago.`);
      }
    });

    cmd("time", { usage: "[timezone_offset]" }, async (_player, args, channel) => {
      let tz = -Math.round(new Date().getTimezoneOffset() / 60);
      if (args.length > 1) {
        if (!/^[+-]?\d+$/.test(args[1]!)) return channel.reply("Unintelligible time zone offset.");
        tz = parseInt(args[1]!, 10);
      }
      const now = new Date(Date.now() + tz * 3600_000);
      const t = `${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}:${pad(now.getUTCSeconds())}`;
      if (tz > 0) await channel.reply(`The current time is: ^6${t} UTC+${tz}`);
      else if (tz < 0) await channel.reply(`The current time is: ^6${t} UTC${tz}`);
      else await channel.reply(`The current time is: ^6${t} UTC`);
    });

    cmd(["teamsize", "ts"], { permission: 2, usage: "<size>" }, async (player, args, channel) => {
      if (args.length < 2) return EventResult.Usage;
      if (!/^\d+$/.test(args[1]!)) {
        await channel.reply("^7Unintelligible size.");
        return;
      }
      const size = parseInt(args[1]!, 10);
      await ctx.game.setTeamsize(size);
      await ctx.msg(`The teamsize has been set to ^6${size}^7 by ${player.name}.`);
      return EventResult.StopAll;
    });
  },
} satisfies Plugin;
