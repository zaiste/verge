/**
 * Tests for the balance plugin (port of the behavior covered by
 * minqlx-plugins/tests/test_balance.py plus the fetch/caching layer).
 * The rating API is faked by monkeypatching globalThis.fetch.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createTestServer, OWNER_ID, type TestServer } from "../testkit/src/fixtures";

const API_URL = "http://qlstats.test/elo/";

let fetchCalls: string[] = [];
/** steam id -> "ca" elo served by the fake API. */
let apiElos: Record<string, number> = {};
const realFetch = globalThis.fetch;

beforeEach(() => {
  fetchCalls = [];
  apiElos = {};
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    fetchCalls.push(url);
    const sids = url.slice(url.lastIndexOf("/") + 1).split("+");
    const players = sids.map((sid) => ({
      steamid: sid,
      ca: { elo: apiElos[sid] ?? 1500, games: 10 },
    }));
    return new Response(JSON.stringify({ players }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

async function balanceServer(config: Record<string, unknown> = {}): Promise<TestServer> {
  const server = await createTestServer({
    plugins: ["balance"],
    pluginConfig: { balance: { api_url: API_URL, ...config } },
  });
  // The configstring cache (game type, state) is primed on new_game.
  await server.newGame();
  return server;
}

interface Sides {
  red: [string, number][];
  blue: [string, number][];
}

/** Connects named players with fixed steam ids and registers their API elos. */
async function connectTeams(server: TestServer, sides: Sides): Promise<Record<string, number>> {
  const ids: Record<string, number> = {};
  let sid = 76561198000100000n;
  for (const team of ["red", "blue"] as const) {
    for (const [name, elo] of sides[team]) {
      const steamId = String(sid++);
      apiElos[steamId] = elo;
      const { info } = await server.connect({ name, team, steamId });
      ids[name] = info.clientId;
    }
  }
  return ids;
}

describe("balance: rating fetching and caching", () => {
  test("!teams fetches ratings from the API once and caches them", async () => {
    const server = await balanceServer();
    const ids = await connectTeams(server, {
      red: [["Keel", 1600]],
      blue: [["Sarge", 1400]],
    });

    await server.chat(ids.Keel!, "!teams");
    expect(fetchCalls.length).toBe(1);
    expect(fetchCalls[0]!.startsWith(API_URL)).toBe(true);
    // Both steam ids requested in one call, joined with "+".
    expect(fetchCalls[0]!.slice(API_URL.length).split("+").length).toBe(2);

    // Second invocation is served entirely from the cache.
    await server.chat(ids.Keel!, "!teams");
    expect(fetchCalls.length).toBe(1);
  });

  test("ratings cache is reset when a new game starts in warmup", async () => {
    const server = await balanceServer();
    const ids = await connectTeams(server, {
      red: [["Evmoncer", 1443]],
      blue: [["FalseMan", 1394]],
    });

    await server.chat(ids.Evmoncer!, "!teams");
    expect(fetchCalls.length).toBe(1);

    // The mock engine's serverinfo says PRE_GAME, i.e. warmup.
    await server.newGame();

    await server.chat(ids.Evmoncer!, "!teams");
    expect(fetchCalls.length).toBe(2);
  });

  test("!elo reports the caller's rating from the API", async () => {
    const server = await balanceServer();
    const ids = await connectTeams(server, {
      red: [["Xaero", 1777]],
      blue: [],
    });

    await server.chat(ids.Xaero!, "!elo");
    const sent = server.messagesTo(null).join("\n");
    expect(sent).toContain("Xaero has a rating of ^61777^7 in CA.");
  });
});

describe("balance: !teams output", () => {
  test("shows both team averages and the rating difference", async () => {
    const server = await balanceServer();
    const ids = await connectTeams(server, {
      red: [
        ["RedAce", 1600],
        ["RedTwo", 1400],
      ],
      blue: [
        ["BlueOne", 1300],
        ["BlueTwo", 1100],
      ],
    });

    await server.chat(ids.RedAce!, "!teams");
    const sent = server.messagesTo(null).join("\n");
    // red avg 1500, blue avg 1200, diff 300 (red is higher -> red color).
    expect(sent).toContain("^11500 ^7vs ^41200^7 - DIFFERENCE: ^1300");
  });

  test("suggests the swap that minimizes the rating difference", async () => {
    const server = await balanceServer();
    const ids = await connectTeams(server, {
      red: [
        ["RedAce", 2000],
        ["RedTwo", 1600],
        ["RedThree", 1200],
      ],
      blue: [
        ["BlueOne", 1400],
        ["BlueTwo", 1300],
        ["BlueThree", 900],
      ],
    });

    await server.chat(ids.RedAce!, "!teams");
    const sent = server.messagesTo(null).join("\n");
    // Of all nine red/blue swaps, RedAce<->BlueOne is the unique best: it
    // leaves a difference of 0, while every other swap leaves 67+.
    expect(sent).toContain("SUGGESTION: switch ^6RedAce^7 with ^6BlueOne^7.");
  });

  test("says teams look good when no swap improves them enough", async () => {
    const server = await balanceServer();
    const ids = await connectTeams(server, {
      red: [
        ["RedAce", 1500],
        ["RedTwo", 1300],
      ],
      blue: [
        ["BlueOne", 1500],
        ["BlueTwo", 1300],
      ],
    });

    await server.chat(ids.RedAce!, "!teams");
    const sent = server.messagesTo(null).join("\n");
    expect(sent).not.toContain("SUGGESTION");
    expect(sent).toContain("look ");
  });

  test("accepts a float minimum_suggestion_diff without blowing up", async () => {
    // Port of test_float_suggestion_diff.
    const server = await balanceServer({ minimum_suggestion_diff: 1.2 });
    const ids = await connectTeams(server, {
      red: [
        ["eugene", 31.44],
        ["Xaero", 25.12],
        ["fast4you", 19.41],
        ["sugafree", 16.44],
      ],
      blue: [
        ["#Syrumz", 34.11],
        ["indie", 30.57],
        ["Sh@z@m", 26.89],
        ["lookaround", 18.34],
      ],
    });

    await server.chat(ids.eugene!, "!teams");
    const sent = server.messagesTo(null).join("\n");
    expect(sent).toContain("DIFFERENCE");
  });
});

describe("balance: executing suggestions", () => {
  test("!do performs the suggested switch", async () => {
    const server = await balanceServer();
    const ids = await connectTeams(server, {
      red: [
        ["RedAce", 2000],
        ["RedTwo", 1600],
        ["RedThree", 1200],
      ],
      blue: [
        ["BlueOne", 1400],
        ["BlueTwo", 1300],
        ["BlueThree", 900],
      ],
    });
    const owner = await server.connect({ name: "Owner", steamId: OWNER_ID });

    await server.chat(ids.RedAce!, "!teams");
    server.engine.clearCalls();
    await server.chat(owner.info.clientId, "!do");

    const puts = server.engine
      .callsTo("console_command")
      .map((c) => String(c.args[0]))
      .filter((c) => c.startsWith("put "));
    expect(puts).toEqual([`put ${ids.RedAce} blue`, `put ${ids.BlueOne} red`]);
  });

  test("!balance switches players until teams are even", async () => {
    const server = await balanceServer();
    const ids = await connectTeams(server, {
      red: [
        ["RedTwo", 1300],
        ["Owner", 1700],
      ],
      blue: [
        ["BlueOne", 1000],
        ["BlueTwo", 750],
      ],
    });
    // !balance needs permission level 1; reuse a red slot for the owner.
    server.engine.playerInfos.get(ids.Owner!)!.steamId = OWNER_ID;
    apiElos[OWNER_ID] = 1700;
    await server.runtime.store.syncAll();

    await server.chat(ids.Owner!, "!balance");

    const puts = server.engine
      .callsTo("console_command")
      .map((c) => String(c.args[0]))
      .filter((c) => c.startsWith("put "));
    expect(puts).toEqual([`put ${ids.RedTwo} blue`, `put ${ids.BlueTwo} red`]);

    const sent = server.messagesTo(null).join("\n");
    expect(sent).toContain("DIFFERENCE");
  });
});

describe("balance: local rating overrides", () => {
  test("!setrating stores a local rating served without an API call", async () => {
    const server = await balanceServer();
    const player = await server.connect({ name: "Anarki", team: "red" });
    const owner = await server.connect({ name: "Owner", steamId: OWNER_ID });

    await server.chat(owner.info.clientId, `!setrating ${player.info.clientId} 1234`);
    let sent = server.messagesTo(null).join("\n");
    expect(sent).toContain("Anarki's CA rating has been set to ^61234^7.");
    expect(server.runtime.db.get(`minqlx:players:${player.info.steamId}:ratings:ca`)).toBe("1234");

    server.engine.clearCalls();
    await server.chat(player.info.clientId, "!elo");
    expect(fetchCalls.length).toBe(0); // local rating, no API hit
    sent = server.messagesTo(null).join("\n");
    expect(sent).toContain("Anarki has a rating of ^61234^7 in CA.");
  });

  test("!remrating deletes the local override", async () => {
    const server = await balanceServer();
    const player = await server.connect({ name: "Anarki", team: "red" });
    const owner = await server.connect({ name: "Owner", steamId: OWNER_ID });

    await server.chat(owner.info.clientId, `!setrating ${player.info.clientId} 1234`);
    await server.chat(owner.info.clientId, `!remrating ${player.info.clientId}`);

    const sent = server.messagesTo(null).join("\n");
    expect(sent).toContain("Anarki's locally set CA rating has been deleted.");
    expect(server.runtime.db.get(`minqlx:players:${player.info.steamId}:ratings:ca`)).toBeNull();
  });
});

describe("balance: !ratings listing", () => {
  test("lists each team's players with their ratings", async () => {
    const server = await balanceServer();
    const ids = await connectTeams(server, {
      red: [
        ["RedAce", 1600],
        ["RedTwo", 1400],
      ],
      blue: [["BlueOne", 1200]],
    });

    await server.chat(ids.RedAce!, "!ratings");
    const sent = server.messagesTo(null).join("\n");
    // Red line sorted by rating, red color; blue line in blue color.
    expect(sent).toContain("RedAce: ^11600^7, RedTwo: ^11400^7");
    expect(sent).toContain("BlueOne: ^41200^7");
  });
});
