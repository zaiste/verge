/**
 * StatsListener event derivation: MATCH_REPORT dedup, death/kill dispatch,
 * bot resolution by name, and team_switch revert — the feed-parsing half
 * that unit tests can cover without a live ZMQ publisher.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { StatsListener } from "../runtime/src/stats";
import { EventBus } from "../runtime/src/events";
import type { Engine } from "../runtime/src/engine";
import type { PlayerStore } from "../runtime/src/players";
import { EventResult } from "../runtime/src/constants";

interface FakePlayer {
  steamId: string;
  name: string;
  team: string;
  puts: string[];
  updates: number;
  update(): Promise<void>;
  put(team: string): Promise<void>;
}

function fakePlayer(steamId: string, name: string, team = "red"): FakePlayer {
  return {
    steamId,
    name,
    team,
    puts: [],
    updates: 0,
    async update() {
      this.updates++;
    },
    async put(t: string) {
      this.puts.push(t);
    },
  };
}

let players: FakePlayer[];
let events: EventBus;
let dispatched: { event: string; args: unknown[] }[];
let listener: { handle(stats: unknown): Promise<void> };

function record(event: string) {
  events.on(event as never, "test", ((...args: unknown[]) => {
    dispatched.push({ event, args });
  }) as never);
}

beforeEach(() => {
  players = [];
  events = new EventBus();
  dispatched = [];
  const store = {
    bySteamId: (sid: string) => players.find((p) => p.steamId === sid) ?? null,
    all: () => players,
  } as unknown as PlayerStore;
  // handle() never touches the engine; only start() does.
  listener = new StatsListener({} as Engine, events, store, "") as unknown as {
    handle(stats: unknown): Promise<void>;
  };
  for (const e of ["game_start", "game_end", "round_end", "death", "kill", "team_switch"]) record(e);
});

describe("stats listener", () => {
  test("MATCH_REPORT only becomes game_end after a MATCH_STARTED", async () => {
    // Map change: MATCH_REPORT with no game in progress must be swallowed.
    await listener.handle({ TYPE: "MATCH_REPORT", DATA: { ABORTED: true } });
    expect(dispatched.filter((d) => d.event === "game_end")).toHaveLength(0);

    await listener.handle({ TYPE: "MATCH_STARTED", DATA: { MAP: "campgrounds" } });
    await listener.handle({ TYPE: "MATCH_REPORT", DATA: { ABORTED: false } });
    expect(dispatched.map((d) => d.event)).toEqual(["game_start", "game_end"]);

    // And the flag resets: a second report is a map change again.
    await listener.handle({ TYPE: "MATCH_REPORT", DATA: {} });
    expect(dispatched.filter((d) => d.event === "game_end")).toHaveLength(1);
  });

  test("PLAYER_DEATH dispatches death always, kill only with a killer", async () => {
    const victim = fakePlayer("76561198000000010", "victim");
    const killer = fakePlayer("76561198000000011", "killer");
    players.push(victim, killer);

    await listener.handle({
      TYPE: "PLAYER_DEATH",
      DATA: { VICTIM: { STEAM_ID: victim.steamId }, KILLER: null, MOD: "FALLING" },
    });
    expect(dispatched.map((d) => d.event)).toEqual(["death"]);

    await listener.handle({
      TYPE: "PLAYER_DEATH",
      DATA: { VICTIM: { STEAM_ID: victim.steamId }, KILLER: { STEAM_ID: killer.steamId }, MOD: "ROCKET" },
    });
    expect(dispatched.map((d) => d.event)).toEqual(["death", "death", "kill"]);
    expect(dispatched[2]!.args[1]).toBe(killer);
  });

  test("bots (STEAM_ID 0) resolve by name", async () => {
    const bot = fakePlayer("9007199254740993", "Anarki");
    players.push(bot);

    await listener.handle({
      TYPE: "PLAYER_DEATH",
      DATA: { VICTIM: { STEAM_ID: 0, NAME: "Anarki" }, KILLER: null },
    });
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]!.args[0]).toBe(bot);
  });

  test("an unknown victim is dropped rather than dispatched as null", async () => {
    await listener.handle({
      TYPE: "PLAYER_DEATH",
      DATA: { VICTIM: { STEAM_ID: "76561198999999999" }, KILLER: null },
    });
    expect(dispatched).toHaveLength(0);
  });

  test("team_switch refreshes the player and reverts on cancel", async () => {
    const p = fakePlayer("76561198000000012", "switcher", "spectator");
    players.push(p);
    events.on("team_switch" as never, "test", (() => EventResult.StopEvent) as never);

    await listener.handle({
      TYPE: "PLAYER_SWITCHTEAM",
      DATA: { KILLER: { STEAM_ID: p.steamId, OLD_TEAM: "SPECTATOR", TEAM: "RED" } },
    });

    expect(p.updates).toBe(1);
    expect(dispatched.map((d) => d.event)).toEqual(["team_switch"]);
    expect(dispatched[0]!.args.slice(1)).toEqual(["spectator", "red"]);
    expect(p.puts).toEqual(["spectator"]);
  });

  test("a same-team SWITCHTEAM report is ignored", async () => {
    const p = fakePlayer("76561198000000013", "stay");
    players.push(p);
    await listener.handle({
      TYPE: "PLAYER_SWITCHTEAM",
      DATA: { KILLER: { STEAM_ID: p.steamId, OLD_TEAM: "RED", TEAM: "RED" } },
    });
    expect(dispatched).toHaveLength(0);
    expect(p.updates).toBe(0);
  });
});
