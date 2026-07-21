/**
 * motd - message of the day (port of motd.py).
 *
 * Shows (and sounds) the MOTD to players shortly after they load. The MOTD
 * itself lives in the db under "verge:motd"; literal "\n" sequences in it
 * split it into multiple lines, like the original.
 */
import type { Plugin } from "../runtime/src/plugin";
import type { Player } from "../runtime/src/players";
import { EventResult, Priority } from "../runtime/src/constants";

const MOTD_KEY = "verge:motd";
/** Was qlx_motdSound. */
const DEFAULT_SOUND = "sound/vo/crash_new/37b_07_alt.wav";
/** Was qlx_motdHeader. */
const DEFAULT_HEADER = "^6======= ^7Message of the Day ^6=======^7";
/** The original delayed the MOTD by 2 seconds (@minqlx.delay(2)). */
const DEFAULT_DELAY_MS = 2000;

function stringSetting(value: unknown, fallback: string): string {
  return value === undefined || value === null ? fallback : String(value);
}

function numberSetting(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  return value !== undefined && value !== null && Number.isFinite(n) ? n : fallback;
}

export default {
  name: "motd",

  setup(ctx) {
    // sound = "0", "" or false disables the welcome sound.
    const sound = ctx.config.sound === false ? "" : stringSetting(ctx.config.sound, DEFAULT_SOUND);
    const header = stringSetting(ctx.config.header, DEFAULT_HEADER);
    const delayMs = numberSetting(ctx.config.delay_ms, DEFAULT_DELAY_MS);

    async function sendMotd(player: Player, motd: string): Promise<void> {
      for (const line of header.split("\\n")) await player.tell(line);
      for (const line of motd.split("\\n")) await player.tell(line);
    }

    // Lowest priority so that ban-like plugins get to kick first.
    ctx.on(
      "player_loaded",
      (player) => {
        ctx.delay(delayMs, () => {
          void (async () => {
            const motd = ctx.db.get(MOTD_KEY);
            if (motd === null) return;
            const soundEnabled =
              sound !== "" &&
              sound !== "0" &&
              ctx.db.getFlag(player.steamId, "essentials:sounds_enabled", true);
            if (soundEnabled) {
              await ctx.engine.rpc("send_server_command", player.id, `playSound ${sound}\n`);
            }
            await sendMotd(player, motd);
          })();
        });
      },
      Priority.Lowest,
    );

    ctx.command(["setmotd", "newmotd"], { permission: 4, usage: "<motd>" }, async (player, args) => {
      if (args.length < 2) return EventResult.Usage;
      ctx.db.set(MOTD_KEY, args.slice(1).join(" "));
      await player.tell("The MOTD has been set.");
      return EventResult.StopEvent;
    });

    ctx.command(["getmotd", "motd"], async (player) => {
      const motd = ctx.db.get(MOTD_KEY);
      if (motd !== null) await sendMotd(player, motd);
      else await player.tell("No MOTD has been set.");
      return EventResult.StopEvent;
    });

    ctx.command(["clearmotd", "removemotd", "remmmotd"], { permission: 4 }, async (player) => {
      ctx.db.del(MOTD_KEY);
      await player.tell("The MOTD has been cleared.");
      return EventResult.StopEvent;
    });

    ctx.command("addmotd", { permission: 4, usage: "<more_motd>" }, async (player, args) => {
      if (args.length < 2) return EventResult.Usage;
      const motd = ctx.db.get(MOTD_KEY);
      if (motd === null) {
        ctx.db.set(MOTD_KEY, args.slice(1).join(" "));
        await player.tell("No MOTD was set, so a new one was made.");
      } else {
        const sep = motd.length > 2 && motd.endsWith("\\n") ? "" : " ";
        ctx.db.set(MOTD_KEY, motd + sep + args.slice(1).join(" "));
        await player.tell("The MOTD has been updated.");
      }
      return EventResult.StopEvent;
    });
  },
} satisfies Plugin;
