import { describe, expect, test } from "bun:test";
import { createTestServer, OWNER_ID } from "../testkit/src/fixtures";
import { EventResult, Priority } from "../runtime/src/constants";
import type { Player } from "../runtime/src/players";

describe("event pipeline", () => {
  test("connect and loaded events fire with a Player", async () => {
    const server = await createTestServer();
    const seen: string[] = [];
    server.runtime.events.on("player_connect", "test", (p: Player) => void seen.push(`connect:${p.name}`));
    server.runtime.events.on("player_loaded", "test", (p: Player) => void seen.push(`loaded:${p.name}`));

    const { rejection } = await server.connect({ name: "Keel" });
    expect(rejection).toBeNull();
    expect(seen).toEqual(["connect:Keel", "loaded:Keel"]);
  });

  test("player_connect can reject with a message", async () => {
    const server = await createTestServer();
    server.runtime.events.on("player_connect", "test", (p: Player) =>
      p.name === "Banned" ? "You are banned: spam" : undefined,
    );
    const ok = await server.connect({ name: "Fine" });
    const banned = await server.connect({ name: "Banned" });
    expect(ok.rejection).toBeNull();
    expect(banned.rejection).toBe("You are banned: spam");
  });

  test("say commands parse into chat events", async () => {
    const server = await createTestServer();
    const chats: string[] = [];
    server.runtime.events.on("chat", "test", (p: Player, msg: string) => void chats.push(`${p.name}: ${msg}`));
    const { info } = await server.connect({ name: "Sarge" });
    const res = await server.chat(info.clientId, "hello world");
    expect(res).toBeNull(); // pass through
    expect(chats).toEqual(["Sarge: hello world"]);
  });

  test("chat handlers can cancel the message", async () => {
    const server = await createTestServer();
    server.runtime.events.on("chat", "test", () => EventResult.StopAll);
    const { info } = await server.connect();
    expect(await server.chat(info.clientId, "should vanish")).toBe(false);
  });

  test("client_command string replacement rewrites the command", async () => {
    const server = await createTestServer();
    server.runtime.events.on("client_command", "test", (_p: Player, cmd: string) =>
      cmd.replace("badword", "***"),
    );
    const { info } = await server.connect();
    expect(await server.clientCommand(info.clientId, 'say "badword"')).toBe('say "***"');
  });

  test("vote flow: called, started, ended", async () => {
    const server = await createTestServer();
    const events: string[] = [];
    server.runtime.events.on("vote_called", "test", (p: Player, vote: string, args: string) =>
      void events.push(`called:${vote}:${args}`),
    );
    server.runtime.events.on("vote_started", "test", (caller: Player | null, vote: string) =>
      void events.push(`started:${caller?.name}:${vote}`),
    );
    server.runtime.events.on("vote_ended", "test", (_votes, vote: string, _args, passed: boolean) =>
      void events.push(`ended:${vote}:${passed}`),
    );

    const { info } = await server.connect({ name: "Voter" });
    await server.clientCommand(info.clientId, "callvote map campgrounds");
    // The engine then sets configstring 9, which fires vote_started.
    await server.engine.raw("set_configstring", 9, "map campgrounds");
    server.engine.configstrings.set(9, "map campgrounds");
    server.engine.configstrings.set(10, "5");
    server.engine.configstrings.set(11, "1");
    await server.engine.raw("server_command", -1, 'print "Vote passed.\n"');
    // vote_ended dispatch is fire-and-forget; give the microtask a tick.
    await Bun.sleep(0);

    expect(events).toEqual([
      "called:map:campgrounds",
      "started:Voter:map",
      "ended:map:true",
    ]);
  });

  test("team switch attempt can be blocked", async () => {
    const server = await createTestServer();
    server.runtime.events.on("team_switch_attempt", "test", () => EventResult.StopAll);
    const { info } = await server.connect({ team: "spectator" });
    expect(await server.clientCommand(info.clientId, "team r")).toBe(false);
  });

  test("userinfo changes dispatch with only the changed keys", async () => {
    const server = await createTestServer();
    let changed: Map<string, string> | null = null;
    server.runtime.events.on("userinfo", "test", (_p: Player, c: Map<string, string>) => {
      changed = c;
    });
    const { info } = await server.connect({ name: "Old", userinfo: "\\name\\Old\\rate\\25000" });
    await server.clientCommand(info.clientId, 'userinfo "\\name\\New\\rate\\25000"');
    expect(changed).not.toBeNull();
    expect([...changed!.entries()]).toEqual([["name", "New"]]);
  });
});

describe("commands", () => {
  test("chat commands run with permission checks", async () => {
    const server = await createTestServer();
    const invoked: string[] = [];
    server.runtime.commands.add(
      new (await import("../runtime/src/commands")).Command("test", "hi", (player, args) => {
        invoked.push(`${player.name}:${args.join(",")}`);
      }, { permission: 2 }),
    );

    const pleb = await server.connect({ name: "Pleb" });
    await server.chat(pleb.info.clientId, "!hi there");
    expect(invoked).toEqual([]); // no permission

    const admin = await server.connect({ name: "Admin", steamId: OWNER_ID });
    await server.chat(admin.info.clientId, "!hi there");
    expect(invoked).toEqual(["Admin:!hi,there"]); // owner bypasses
  });

  test("builtin !plugins replies to the channel", async () => {
    const server = await createTestServer();
    const owner = await server.connect({ name: "Owner", steamId: OWNER_ID });
    server.engine.clearCalls();
    await server.chat(owner.info.clientId, "!plugins");
    const sent = server.engine.callsTo("send_server_command").map((c) => String(c.args[1]));
    expect(sent.some((s) => s.includes("Loaded plugins"))).toBe(true);
  });

  test("usage reply on missing args", async () => {
    const server = await createTestServer();
    const owner = await server.connect({ name: "Owner", steamId: OWNER_ID });
    server.engine.clearCalls();
    await server.chat(owner.info.clientId, "!load");
    const sent = server.messagesTo(null); // chat-channel replies broadcast
    expect(sent.some((s) => s.includes("Usage:"))).toBe(true);
  });

  test("priority order runs Highest before Normal", async () => {
    const server = await createTestServer();
    const order: string[] = [];
    server.runtime.events.on("new_game", "test", () => void order.push("normal"), Priority.Normal);
    server.runtime.events.on("new_game", "test", () => void order.push("highest"), Priority.Highest);
    await server.newGame();
    expect(order).toEqual(["highest", "normal"]);
  });
});

describe("db", () => {
  test("permissions with owner override and ttl expiry", async () => {
    const server = await createTestServer();
    const db = server.runtime.db;
    expect(db.getPermission(OWNER_ID)).toBe(5);
    expect(db.getPermission("76561198999999999")).toBe(0);
    db.setPermission("76561198999999999", 3);
    expect(db.getPermission("76561198999999999")).toBe(3);

    db.set("ban:test", "reason", { ttl: -1 }); // already expired
    expect(db.get("ban:test")).toBeNull();
    db.set("ban:test2", "reason", { ttl: 3600 });
    expect(db.get("ban:test2")).toBe("reason");
    expect(db.ttl("ban:test2")).toBeGreaterThan(3590);
  });
});
