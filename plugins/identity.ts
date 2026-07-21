/**
 * identity - player display names and clan tags.
 *
 * Merged port of names.py and clan.py:
 * - !name/!setname registers a (colored) display name stored in the db and
 *   re-applied on load and on userinfo changes, optionally enforced to match
 *   the player's Steam name (colors stripped for the comparison).
 * - !clan/!setclan registers a persistent clan tag stored in the db; it is
 *   applied immediately to the player's configstring and merged into
 *   subsequent userinfo updates (cn/xcn keys) via the userinfo event.
 */
import type { Plugin } from "../runtime/src/plugin";
import type { Player } from "../runtime/src/players";
import { EventResult } from "../runtime/src/constants";
import { cleanText, formatVariables, parseVariables } from "../runtime/src/util";

/** Player configstrings start at index 529 (CS_PLAYERS). */
const CS_PLAYERS = 529;

const nameKey = (steamId: string) => `verge:players:${steamId}:colored_name`;
const tagKey = (steamId: string) => `verge:players:${steamId}:clantag`;

const EXCESSIVE_COLORS_RE = /(?:\^.)+(\^.)/g;

/** Removes excessive colors and only keeps the ones that matter. */
function cleanExcessiveColors(text: string): string {
  return text.replace(EXCESSIVE_COLORS_RE, "$1");
}

function boolSetting(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  return !["0", "false", "no", ""].includes(String(value).toLowerCase());
}

export default {
  name: "identity",

  setup(ctx) {
    /** Was qlx_enforceSteamName (default "1"). */
    const enforce = boolSetting(ctx.config.enforce_steam_name, true);

    /** Clean Steam names, keyed by SteamID64. */
    const steamNames = new Map<string, string>();
    /** Set when we changed the name ourselves, so the resulting userinfo
     * event doesn't treat it as a manual rename. */
    let nameSet = false;

    /** Rewrites the player's userinfo with a new name (the same mechanism
     * Python's Player.name setter used). */
    async function setName(player: Player, name: string): Promise<void> {
      const info = player.cvars;
      info.set("name", name);
      await ctx.engine.rpc("client_command", player.id, `userinfo "${formatVariables(info).replace(/^\\/, "")}"`);
    }

    ctx.on("player_connect", (player) => {
      steamNames.set(player.steamId, player.cleanName);
    });

    ctx.on("player_loaded", async (player) => {
      const stored = ctx.db.get(nameKey(player.steamId));
      if (stored === null) return;
      if (!enforce || cleanText(stored).toLowerCase() === player.cleanName.toLowerCase()) {
        nameSet = true;
        await setName(player, stored);
      }
    });

    ctx.on("player_disconnect", (player) => {
      steamNames.delete(player.steamId);
    });

    ctx.on("userinfo", async (player, changed) => {
      const merged = new Map<string, string>();

      // Clan tag: merge cn/xcn into every userinfo update.
      const tag = ctx.db.get(tagKey(player.steamId));
      if (tag !== null) {
        merged.set("cn", tag);
        merged.set("xcn", tag);
      }

      // Registered name handling. Skip once if our own setName caused this.
      if (nameSet) {
        nameSet = false;
      } else if (changed.has("name")) {
        const key = nameKey(player.steamId);
        const stored = ctx.db.get(key);
        const cleanChanged = cleanText(changed.get("name")!);
        if (stored === null) {
          steamNames.set(player.steamId, cleanChanged);
        } else if (steamNames.get(player.steamId) === cleanChanged) {
          merged.set("name", stored);
        } else {
          ctx.db.del(key);
          await player.tell("Your registered name has been reset.");
        }
      }

      return merged.size > 0 ? merged : undefined;
    });

    ctx.command(["name", "setname"], { usage: "<name>", clientCmdPerm: 0 }, async (player, args) => {
      const key = nameKey(player.steamId);

      if (args.length < 2) {
        if (ctx.db.get(key) === null) return EventResult.Usage;
        ctx.db.del(key);
        await player.tell("Your registered name has been removed.");
        return EventResult.StopAll;
      }

      let name = cleanExcessiveColors(args.slice(1).join(" "));
      if (new TextEncoder().encode(name).length > 36) {
        await player.tell("The name is too long. Consider using fewer colors or a shorter name.");
        return EventResult.StopAll;
      }
      if (enforce && cleanText(name).toLowerCase() !== player.cleanName.toLowerCase()) {
        await player.tell("The new name must match your current Steam name.");
        return EventResult.StopAll;
      }
      if (name.includes("\\")) {
        await player.tell("The character '^6\\^7' cannot be used. Sorry for the inconvenience.");
        return EventResult.StopAll;
      }
      if (!cleanText(name).trim()) {
        await player.tell("Blank names cannot be used. Sorry for the inconvenience.");
        return EventResult.StopAll;
      }

      nameSet = true;
      name = "^7" + name;
      await setName(player, name);
      ctx.db.set(key, name);
      await player.tell(
        `The name has been registered. To make me forget about it, a simple ^6${ctx.prefix}name^7 will do it.`,
      );
      return EventResult.StopAll;
    });

    ctx.command(["clan", "setclan"], { usage: "<clan_tag>", clientCmdPerm: 0 }, async (player, args) => {
      const csIndex = CS_PLAYERS + player.id;
      const key = tagKey(player.steamId);

      if (args.length < 2) {
        if (ctx.db.get(key) !== null) {
          ctx.db.del(key);
          const cs = parseVariables(await ctx.engine.rpc("get_configstring", csIndex));
          cs.delete("cn");
          cs.delete("xcn");
          await ctx.engine.rpc("set_configstring", csIndex, formatVariables(cs).replace(/^\\/, ""));
          await player.tell("The clan tag has been cleared.");
        } else {
          await player.tell(`Usage to set a clan tag: ^6${args[0]} <clan_tag>`);
        }
        return EventResult.StopEvent;
      }

      if (cleanText(args[1]!).length > 5) {
        await player.tell("The clan tag can only be at most 5 characters long, excluding colors.");
        return EventResult.StopEvent;
      }

      const tag = cleanExcessiveColors(args[1]!);
      const cs = parseVariables(await ctx.engine.rpc("get_configstring", csIndex));
      cs.set("xcn", tag);
      cs.set("cn", tag);
      ctx.db.set(key, tag);
      await ctx.engine.rpc("set_configstring", csIndex, formatVariables(cs).replace(/^\\/, ""));
      await ctx.msg(`${player} changed clan tag to ${tag}`);
      return EventResult.StopEvent;
    });
  },
} satisfies Plugin;
