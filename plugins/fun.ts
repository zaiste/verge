/**
 * fun - chat-triggered sounds (port of fun.py).
 *
 * Certain chat messages ("haha yeah", "holy shit", ...) play a sound to
 * every player who hasn't disabled sounds (the "essentials:sounds_enabled"
 * db flag). A per-server cooldown stops sound spam. Also brings the
 * all-important !cookies command.
 *
 * Config keys ([plugin.fun] in verge.toml):
 *   sound_delay - minimum seconds between sounds (default 3, was
 *                 qlx_funSoundDelay)
 */
import type { Plugin } from "../runtime/src/plugin";
import { cleanText } from "../runtime/src/util";

/**
 * Ordered chat triggers; the first matching pattern wins. Patterns mirror
 * fun.py: Python's re.match anchors at the start, so those patterns carry
 * an explicit ^ here, while re.search ones don't.
 */
const TRIGGERS: [RegExp, string][] = [
  [/^haha(?:ha)?,? yeah?\W?$/i, "sound/player/lucy/taunt.wav"],
  [/^haha(?:ha)?,? yeah?,? haha\W?$/i, "sound/player/biker/taunt.wav"],
  [/^yeah?,? haha(?:ha)\W?$/i, "sound/player/razor/taunt.wav"],
  [/^duahaha(?:ha)?\W?$/i, "sound/player/keel/taunt.wav"],
  [/hahaha/i, "sound/player/santa/taunt.wav"],
  [/haahaahaa/i, "sound/player/visor/taunt.wav"],
  [/^(?:(?:gl ?hf\W?)|(?:hf\W?)|(?:gl hf\W?))/i, "sound/vo/crash_new/39_01.wav"],
  [/^(?:(?:(?:press )?f3)|ready(?: up)?\W?)/i, "sound/vo/crash_new/36_04.wav"],
  [/holy shit/i, "sound/vo_female/holy_shit"],
  [/^welcome to (?:ql|quake live)\W?$/i, "sound/vo_evil/welcome"],
  [/^go\W?$/i, "sound/vo/go"],
  [/^beep boop\W?$/i, "sound/player/tankjr/taunt.wav"],
  [/^you win\W?$/i, "sound/vo_female/you_win.wav"],
  [/^you lose\W?$/i, "sound/vo/you_lose.wav"],
  [/impressive/i, "sound/vo_female/impressive1.wav"],
  [/excellent/i, "sound/vo_evil/excellent1.wav"],
  [/^denied\W?$/i, "sound/vo/denied"],
  [/^ball'?s out\W?$/i, "sound/vo_female/balls_out"],
  [/^one\W?$/i, "sound/vo_female/one"],
  [/^two\W?$/i, "sound/vo_female/two"],
  [/^three\W?$/i, "sound/vo_female/three"],
  [/^fight\W?$/i, "sound/vo_evil/fight"],
  [/^gauntlet\W?$/i, "sound/vo_evil/gauntlet"],
  [/^humiliation\W?$/i, "sound/vo_evil/humiliation1"],
  [/^perfect\W?$/i, "sound/vo_evil/perfect"],
  [/^wa+h wa+h wa+h wa+h\W?$/i, "sound/misc/yousuck"],
  [/^a+h a+h a+h\W?$/i, "sound/player/slash/taunt.wav"],
  [/^oink\W?$/i, "sound/player/sorlag/pain50_1.wav"],
  [/^a+rgh\W?$/i, "sound/player/doom/taunt.wav"],
  [/^hah haha\W?$/i, "sound/player/hunter/taunt.wav"],
  [/^woo+hoo+\W?$/i, "sound/player/janet/taunt.wav"],
  [/^(?:ql|quake live)\W?$/i, "sound/vo_female/quake_live"],
  [/(?:\$|€|£)\d+/i, "sound/misc/chaching"],
  [/^uh ah$/i, "sound/player/mynx/taunt.wav"],
  [/^ooh+wee\W?$/i, "sound/player/anarki/taunt.wav"],
  [/^erah\W?$/i, "sound/player/bitterman/taunt.wav"],
  [/^yeahhh\W?$/i, "sound/player/major/taunt.wav"],
  [/^scream\W?$/i, "sound/player/bones/taunt.wav"],
  [/^salute\W?$/i, "sound/player/sarge/taunt.wav"],
  [/^squish\W?$/i, "sound/player/orb/taunt.wav"],
  [/^oh god\W?$/i, "sound/player/ranger/taunt.wav"],
  [/^snarl\W?$/i, "sound/player/sorlag/taunt.wav"],
];

export default {
  name: "fun",
  setup(ctx) {
    const soundDelayMs = Number(ctx.config.sound_delay ?? 3) * 1000;
    let lastSound = 0; // Epoch ms of the last played sound; 0 = never.

    async function playSound(path: string): Promise<void> {
      if (lastSound !== 0 && Date.now() - lastSound < soundDelayMs) return;
      lastSound = Date.now();

      for (const p of ctx.players()) {
        if (ctx.db.getFlag(p.steamId, "essentials:sounds_enabled", true)) {
          await ctx.engine.rpc("send_server_command", p.id, `playSound ${path}`);
        }
      }
    }

    ctx.on("chat", async (_player, msg, channel) => {
      if (channel.name !== "chat") return;

      const text = cleanText(msg);
      const match = TRIGGERS.find(([re]) => re.test(text));
      if (match) await playSound(match[1]);
    });

    ctx.command("cookies", async (player, _args, channel) => {
      const x = Math.floor(Math.random() * 101);
      if (x === 0) {
        await channel.reply(`^6♥ ^7Here you go, ${player.name}. I baked these just for you! ^6♥`);
      } else if (x === 1) {
        await channel.reply(
          `What, you thought ^6you^7 would get cookies from me, ${player.name}? Hah, think again.`,
        );
      } else if (x < 50) {
        await channel.reply(`For me? Thank you, ${player.name}!`);
      } else {
        await channel.reply(`I'm out of cookies right now, ${player.name}. Sorry!`);
      }
    });
  },
} satisfies Plugin;
