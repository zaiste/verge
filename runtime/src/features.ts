/**
 * Small built-in features controlled by [plugin.features] flags, replacing
 * the one-trick workshop.py and solorace.py plugins.
 */
import type { Config } from "./config";
import type { Engine } from "./engine";
import type { EventBus } from "./events";
import type { Game } from "./game";
import type { PlayerStore } from "./players";
import type { Player } from "./players";

const CS_WORKSHOP_ITEMS = 715;

export function registerFeatures(
  config: Config,
  engine: Engine,
  events: EventBus,
  game: Game,
  store: PlayerStore,
): void {
  // workshop: force clients to download extra Steam Workshop items.
  if (config.features.workshop.length > 0) {
    events.on("map", "core", async () => {
      const current = (await engine.rpc("get_configstring", CS_WORKSHOP_ITEMS))
        .split(" ")
        .filter(Boolean);
      const merged = [...new Set([...current, ...config.features.workshop])];
      await engine.rpc("set_configstring", CS_WORKSHOP_ITEMS, merged.join(" ") + " ");
    });
  }

  // solorace: keep a race server running with fewer than 2 players.
  if (config.features.solorace) {
    const isRace = () => game.typeShort === "race";

    events.on("new_game", "core", async () => {
      if (isRace()) {
        await engine.rpc("set_cvar", "g_doWarmup", "0");
        await engine.rpc("allow_single_player", true);
      } else {
        await engine.rpc("set_cvar", "g_doWarmup", "1");
      }
    });

    events.on("team_switch", "core", async (_player, oldTeam) => {
      if (isRace() && oldTeam === "free" && game.state === "in_progress" &&
          store.byTeam("free").length === 0) {
        await engine.rpc("console_command", "map_restart");
      }
    });

    events.on("player_disconnect", "core", async (player: Player) => {
      if (isRace() && player.team === "free" && store.byTeam("free").length === 1) {
        await engine.rpc("console_command", "map_restart");
      }
    });
  }
}
