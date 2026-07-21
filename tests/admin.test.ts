import { describe, expect, test } from "bun:test";
import { createTestServer, OWNER_ID, type TestServer } from "../testkit/src/fixtures";
import { parseLength } from "../plugins/admin";

const OFFLINE_SID = "76561198999999999";

async function adminServer(pluginConfig: Record<string, unknown> = {}) {
  const server = await createTestServer({
    plugins: ["admin"],
    pluginConfig: { admin: pluginConfig },
  });
  const admin = await server.connect({ name: "Admin", steamId: OWNER_ID });
  return { server, adminId: admin.info.clientId };
}

function consoleCommands(server: TestServer): string[] {
  return server.engine.callsTo("console_command").map((c) => String(c.args[0]));
}

describe("admin: ban flow", () => {
  test("ban by client id kicks, blocks reconnect, unban allows again", async () => {
    const { server, adminId } = await adminServer();
    const target = await server.connect({ name: "Woodpecker" });
    const sid = target.info.steamId;

    await server.chat(adminId, "!ban 1 5 minutes Very rude!");

    // Kicked with the ban message.
    const kicks = server.engine.callsTo("kick");
    expect(kicks.some((c) => c.args[0] === 1)).toBe(true);
    expect(String(kicks[0]!.args[1])).toContain("has been banned until");

    // Reconnect is rejected with the Python-era message.
    const again = await server.connect({ name: "Woodpecker", steamId: sid });
    expect(typeof again.rejection).toBe("string");
    expect(String(again.rejection)).toStartWith("You are banned until");
    expect(String(again.rejection)).toContain("Very rude!");

    // Ban record uses the historical key scheme, with a ttl.
    const key = `verge:players:${sid}:ban`;
    expect(server.runtime.db.get(key)).not.toBeNull();
    expect(server.runtime.db.ttl(key)).toBeGreaterThan(290);

    // Unban clears it; reconnect works.
    server.engine.clearCalls();
    await server.chat(adminId, `!unban ${sid}`);
    expect(server.messagesTo(null).some((m) => m.includes("has been unbanned"))).toBe(true);
    const back = await server.connect({ name: "Woodpecker", steamId: sid });
    expect(back.rejection).toBeNull();
  });

  test("ban without reason rejects with plain until-message", async () => {
    const { server, adminId } = await adminServer();
    await server.chat(adminId, `!ban ${OFFLINE_SID} 1 day`);
    const joined = await server.connect({ steamId: OFFLINE_SID });
    expect(String(joined.rejection)).toStartWith("You are banned until");
    expect(String(joined.rejection)).toEndWith(".");
  });

  test("ban expires via ttl", async () => {
    const { server, adminId } = await adminServer();
    await server.chat(adminId, `!ban ${OFFLINE_SID} 5 minutes spam`);

    const key = `verge:players:${OFFLINE_SID}:ban`;
    const record = server.runtime.db.get(key);
    expect(record).not.toBeNull();

    // Simulate the ban running out by rewriting the record as already expired.
    server.runtime.db.set(key, record!, { ttl: -1 });
    const joined = await server.connect({ steamId: OFFLINE_SID });
    expect(joined.rejection).toBeNull();
  });

  test("!tempban is a ban alias and duration parsing matches ban.py", async () => {
    const { server, adminId } = await adminServer();
    await server.chat(adminId, `!tempban ${OFFLINE_SID} 2 days griefing`);
    const ttl = server.runtime.db.ttl(`verge:players:${OFFLINE_SID}:ban`);
    expect(ttl).toBeGreaterThan(2 * 86400 - 5);
    expect(ttl).toBeLessThanOrEqual(2 * 86400);

    // ban.py's LENGTH_REGEX semantics.
    expect(parseLength("5 minutes")).toBe(300);
    expect(parseLength("1 second")).toBe(1);
    expect(parseLength("3 hours")).toBe(10800);
    expect(parseLength("2 weeks")).toBe(2 * 604800);
    expect(parseLength("1 month")).toBe(30 * 86400);
    expect(parseLength("50 years")).toBe(50 * 52 * 604800);
    expect(parseLength("soon")).toBeNull();
    expect(parseLength("5 fortnights")).toBeNull();
  });

  test("permission level 5 players cannot be banned", async () => {
    const { server, adminId } = await adminServer();
    server.engine.clearCalls();
    await server.chat(adminId, `!ban ${OWNER_ID} 1 day`);
    expect(server.messagesTo(null).some((m) => m.includes("cannot be banned"))).toBe(true);
    expect(server.runtime.db.get(`verge:players:${OWNER_ID}:ban`)).toBeNull();
  });

  test("checkban reports active bans", async () => {
    const { server, adminId } = await adminServer();
    await server.chat(adminId, `!ban ${OFFLINE_SID} 1 hour flooding`);
    server.engine.clearCalls();
    await server.chat(adminId, `!checkban ${OFFLINE_SID}`);
    expect(server.messagesTo(null).some((m) => m.includes("is banned until"))).toBe(true);

    server.engine.clearCalls();
    await server.chat(adminId, "!checkban 76561198111111111");
    expect(server.messagesTo(null).some((m) => m.includes("is not banned"))).toBe(true);
  });
});

describe("admin: silence flow", () => {
  test("silence mutes now, re-mutes on rejoin, unsilence lifts it", async () => {
    const { server, adminId } = await adminServer();
    const target = await server.connect({ name: "Loudmouth" });
    const sid = target.info.steamId;

    await server.chat(adminId, "!silence 1 5 minutes flaming");
    expect(consoleCommands(server)).toContain("mute 1");
    expect(server.messagesTo(null).some((m) => m.includes("has been silenced"))).toBe(true);

    // Chat from the silenced player is blocked and they get told why.
    const blocked = await server.chat(1, "hello");
    expect(blocked).toBe(false);
    expect(
      server.messagesTo(1).some((m) => m.includes("You are muted on this server until")),
    ).toBe(true);

    // Rejoin: the persistent silence re-mutes on load.
    await server.disconnect(1);
    server.engine.clearCalls();
    const rejoined = await server.connect({ name: "Loudmouth", steamId: sid });
    expect(rejoined.rejection).toBeNull();
    expect(consoleCommands(server)).toContain(`mute ${rejoined.info.clientId}`);
    expect(
      server
        .messagesTo(rejoined.info.clientId)
        .some((m) => m.includes("You are muted on this server until")),
    ).toBe(true);

    // Unsilence unmutes and chat flows again.
    server.engine.clearCalls();
    await server.chat(adminId, `!unsilence ${rejoined.info.clientId}`);
    expect(consoleCommands(server)).toContain(`unmute ${rejoined.info.clientId}`);
    expect(server.messagesTo(null).some((m) => m.includes("has been unsilenced"))).toBe(true);
    expect(await server.chat(rejoined.info.clientId, "free at last")).toBeNull();
  });

  test("expired silence unmutes lazily on the next chat attempt", async () => {
    const { server, adminId } = await adminServer();
    const target = await server.connect({ name: "Chatty" });
    await server.chat(adminId, "!silence 1 3 seconds");

    expect(await server.chat(1, "hey")).toBe(false);

    // Force-expire the silence record (ttl semantics).
    const key = `verge:players:${target.info.steamId}:silence`;
    server.runtime.db.set(key, server.runtime.db.get(key) ?? "{}", { ttl: -1 });

    server.engine.clearCalls();
    expect(await server.chat(1, "hey again")).toBeNull(); // passes through
    expect(consoleCommands(server)).toContain("unmute 1");
  });

  test("players with permission 2+ cannot be silenced", async () => {
    const { server, adminId } = await adminServer();
    const target = await server.connect({ name: "Mod" });
    server.runtime.db.setPermission(target.info.steamId, 2);
    server.engine.clearCalls();
    await server.chat(adminId, "!silence 1 1 day");
    expect(server.messagesTo(null).some((m) => m.includes("cannot be silenced"))).toBe(true);
    expect(server.runtime.db.get(`verge:players:${target.info.steamId}:silence`)).toBeNull();
  });
});

describe("admin: permissions", () => {
  test("setperm and getperm", async () => {
    const { server, adminId } = await adminServer();
    const target = await server.connect({ name: "Pleb" });

    await server.chat(adminId, "!setperm 1 3");
    expect(server.runtime.db.getPermission(target.info.steamId)).toBe(3);

    server.engine.clearCalls();
    await server.chat(adminId, `!getperm ${target.info.steamId}`);
    expect(server.messagesTo(null).some((m) => m.includes("has permission level ^63^7"))).toBe(true);

    server.engine.clearCalls();
    await server.chat(adminId, "!setperm 1 9");
    expect(server.messagesTo(null).some((m) => m.includes("Invalid permission level"))).toBe(true);
    expect(server.runtime.db.getPermission(target.info.steamId)).toBe(3);
  });

  test("getperm on the owner and myperm", async () => {
    const { server, adminId } = await adminServer();
    server.engine.clearCalls();
    await server.chat(adminId, `!getperm ${OWNER_ID}`);
    expect(server.messagesTo(null).some((m) => m.includes("That's my master."))).toBe(true);

    const pleb = await server.connect({ name: "Nobody" });
    server.engine.clearCalls();
    await server.chat(pleb.info.clientId, "!myperm");
    expect(server.messagesTo(null).some((m) => m.includes("You have permission level ^60^7"))).toBe(true);
  });

  test("granted permission unlocks commands", async () => {
    const { server, adminId } = await adminServer();
    const pleb = await server.connect({ name: "Pleb" });
    const victim = await server.connect({ name: "Victim" });

    // No permission: !kick does nothing.
    await server.chat(pleb.info.clientId, `!kick ${victim.info.clientId}`);
    expect(server.engine.callsTo("kick").length).toBe(0);

    await server.chat(adminId, `!setperm ${pleb.info.clientId} 2`);
    await server.chat(pleb.info.clientId, `!kick ${victim.info.clientId}`);
    expect(server.engine.callsTo("kick").some((c) => c.args[0] === victim.info.clientId)).toBe(true);
  });
});

describe("admin: vote handling", () => {
  test("auto-passes a winning vote after the delay", async () => {
    const server = await createTestServer({
      plugins: ["admin"],
      pluginConfig: { admin: { vote_pass_delay: 0.05 } },
    });
    const a = await server.connect({ name: "V1", team: "red" });
    await server.connect({ name: "V2", team: "red" });

    await server.clientCommand(a.info.clientId, "callvote map campgrounds");
    await server.engine.raw("set_configstring", 9, "map campgrounds");
    await server.engine.raw("set_configstring", 10, "2");
    await server.engine.raw("set_configstring", 11, "0");

    await Bun.sleep(150);
    const forced = server.engine.callsTo("force_vote");
    expect(forced.length).toBe(1);
    expect(forced[0]!.args[0]).toBe(true);
  });

  test("does not force a losing vote", async () => {
    const server = await createTestServer({
      plugins: ["admin"],
      pluginConfig: { admin: { vote_pass_delay: 0.05 } },
    });
    const a = await server.connect({ name: "V1", team: "red" });
    await server.connect({ name: "V2", team: "red" });

    await server.clientCommand(a.info.clientId, "callvote map campgrounds");
    await server.engine.raw("set_configstring", 9, "map campgrounds");
    await server.engine.raw("set_configstring", 10, "1");
    await server.engine.raw("set_configstring", 11, "2");

    await Bun.sleep(150);
    expect(server.engine.callsTo("force_vote").length).toBe(0);
  });

  test("teamsize votes outside the configured bounds are blocked", async () => {
    const server = await createTestServer({
      plugins: ["admin"],
      pluginConfig: { admin: { teamsize_minimum: 2, teamsize_maximum: 8 } },
    });
    const p = await server.connect({ name: "Caller", team: "red" });

    const tooBig = await server.clientCommand(p.info.clientId, "callvote teamsize 10");
    expect(tooBig).toBe(false);
    expect(
      server.messagesTo(p.info.clientId).some((m) => m.includes("larger than what the server allows")),
    ).toBe(true);

    const tooSmall = await server.clientCommand(p.info.clientId, "callvote teamsize 1");
    expect(tooSmall).toBe(false);
    expect(
      server.messagesTo(p.info.clientId).some((m) => m.includes("smaller than what the server allows")),
    ).toBe(true);

    const fine = await server.clientCommand(p.info.clientId, "callvote teamsize 4");
    expect(fine).not.toBe(false);
  });
});

describe("admin: representative commands", () => {
  test("!kick by client id, with invalid-id handling", async () => {
    const { server, adminId } = await adminServer();
    const target = await server.connect({ name: "Bye" });

    await server.chat(adminId, `!kick ${target.info.clientId} being rude`);
    const kicks = server.engine.callsTo("kick");
    expect(kicks.some((c) => c.args[0] === target.info.clientId && c.args[1] === "being rude")).toBe(true);

    server.engine.clearCalls();
    await server.chat(adminId, "!kick 42");
    expect(server.engine.callsTo("kick").length).toBe(0);
    expect(server.messagesTo(null).some((m) => m.includes("Invalid ID."))).toBe(true);
  });

  test("!mute and !unmute, refusing self-mute", async () => {
    const { server, adminId } = await adminServer();
    await server.connect({ name: "Noisy" });

    await server.chat(adminId, "!mute 1");
    expect(consoleCommands(server)).toContain("mute 1");

    await server.chat(adminId, "!unmute 1");
    expect(consoleCommands(server)).toContain("unmute 1");

    server.engine.clearCalls();
    await server.chat(adminId, `!mute ${adminId}`);
    expect(consoleCommands(server)).not.toContain(`mute ${adminId}`);
    expect(server.messagesTo(null).some((m) => m.includes("I refuse."))).toBe(true);
  });

  test("!teamsize sets the size and announces it", async () => {
    const { server, adminId } = await adminServer();
    await server.chat(adminId, "!teamsize 5");
    expect(consoleCommands(server)).toContain("teamsize 5");
    expect(server.messagesTo(null).some((m) => m.includes("teamsize has been set to ^65^7"))).toBe(true);
  });

  test("!cointoss and !switch", async () => {
    const { server, adminId } = await adminServer();
    const red = await server.connect({ name: "Redguy", team: "red" });
    const blue = await server.connect({ name: "Blueguy", team: "blue" });

    server.engine.clearCalls();
    await server.chat(adminId, "!cointoss");
    expect(server.messagesTo(null).some((m) => m.includes("The coin is:"))).toBe(true);

    await server.chat(adminId, `!switch ${red.info.clientId} ${blue.info.clientId}`);
    const puts = consoleCommands(server);
    expect(puts).toContain(`put ${red.info.clientId} blue`);
    expect(puts).toContain(`put ${blue.info.clientId} red`);
  });

  test("!seen reports last-seen based on the stored key", async () => {
    const { server, adminId } = await adminServer();
    const target = await server.connect({ name: "Ghost" });
    const sid = target.info.steamId;

    server.engine.clearCalls();
    await server.chat(adminId, `!seen ${sid}`);
    expect(server.messagesTo(null).some((m) => m.includes("currently on this very server"))).toBe(true);

    // Disconnect stamps last_seen.
    await server.disconnect(target.info.clientId);
    expect(server.runtime.db.get(`verge:players:${sid}:last_seen`)).not.toBeNull();
    server.engine.clearCalls();
    await server.chat(adminId, `!seen ${sid}`);
    expect(server.messagesTo(null).some((m) => m.includes("hour(s) and ^60^7 minute(s) ago"))).toBe(true);

    server.engine.clearCalls();
    await server.chat(adminId, "!seen 76561198123456789");
    expect(server.messagesTo(null).some((m) => m.includes("I have never seen"))).toBe(true);
  });
});
