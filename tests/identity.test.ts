import { describe, expect, test } from "bun:test";
import { createTestServer } from "../testkit/src/fixtures";

const CS_PLAYERS = 529;

describe("identity: clan tags", () => {
  test("!clan stores the tag and applies it via configstring and userinfo", async () => {
    const server = await createTestServer({ plugins: ["identity"] });
    const { info } = await server.connect({ name: "Sarge" });

    await server.chat(info.clientId, "!clan QLX");
    expect(server.runtime.db.get(`minqlx:players:${info.steamId}:clantag`)).toBe("QLX");
    // Applied immediately to the player's configstring.
    const cs = server.engine.configstrings.get(CS_PLAYERS + info.clientId) ?? "";
    expect(cs).toContain("cn\\QLX");
    expect(cs).toContain("xcn\\QLX");
    // Announced in chat.
    expect(server.messagesTo(null).some((m) => m.includes("changed clan tag to QLX"))).toBe(true);

    // Any later userinfo update gets the tag merged in (cn/xcn keys).
    const res = await server.clientCommand(info.clientId, 'userinfo "\\name\\Sarge\\rate\\25000"');
    expect(typeof res).toBe("string");
    expect(res).toContain("\\cn\\QLX");
    expect(res).toContain("\\xcn\\QLX");
  });

  test("!clan without args clears a stored tag", async () => {
    const server = await createTestServer({ plugins: ["identity"] });
    const { info } = await server.connect({ name: "Sarge" });
    await server.chat(info.clientId, "!clan TAG");
    await server.chat(info.clientId, "!clan");
    expect(server.runtime.db.get(`minqlx:players:${info.steamId}:clantag`)).toBeNull();
    const cs = server.engine.configstrings.get(CS_PLAYERS + info.clientId) ?? "";
    expect(cs).not.toContain("cn\\TAG");
    expect(server.messagesTo(info.clientId).some((m) => m.includes("clan tag has been cleared"))).toBe(true);
  });

  test("clan tags longer than 5 clean characters are rejected", async () => {
    const server = await createTestServer({ plugins: ["identity"] });
    const { info } = await server.connect({ name: "Sarge" });
    await server.chat(info.clientId, "!clan TOOLONG");
    expect(server.runtime.db.get(`minqlx:players:${info.steamId}:clantag`)).toBeNull();
    expect(server.messagesTo(info.clientId).some((m) => m.includes("at most 5 characters"))).toBe(true);
  });
});

describe("identity: names", () => {
  test("!name registers a colored name and persists across reconnects", async () => {
    const server = await createTestServer({ plugins: ["identity"] });
    const sid = "76561198000000123";
    const { info } = await server.connect({ name: "Keel", steamId: sid });

    await server.chat(info.clientId, "!name ^1Keel");
    expect(server.runtime.db.get(`minqlx:players:${sid}:colored_name`)).toBe("^7^1Keel");
    expect(server.messagesTo(info.clientId).some((m) => m.includes("has been registered"))).toBe(true);
    // The name was applied through a userinfo rewrite.
    const applied = server.engine
      .callsTo("client_command")
      .filter((c) => c.args[0] === info.clientId)
      .map((c) => String(c.args[1]));
    expect(applied.some((c) => c.includes("name\\^7^1Keel"))).toBe(true);

    // Reconnect: the registered name is re-applied on load.
    await server.disconnect(info.clientId);
    server.engine.clearCalls();
    const again = await server.connect({ name: "Keel", steamId: sid });
    const reApplied = server.engine
      .callsTo("client_command")
      .filter((c) => c.args[0] === again.info.clientId)
      .map((c) => String(c.args[1]));
    expect(reApplied.some((c) => c.includes("name\\^7^1Keel"))).toBe(true);
  });

  test("!name rejects names not matching the Steam name when enforcing", async () => {
    const server = await createTestServer({ plugins: ["identity"] });
    const { info } = await server.connect({ name: "Keel" });
    await server.chat(info.clientId, "!name ^2Xaero");
    expect(server.runtime.db.get(`minqlx:players:${info.steamId}:colored_name`)).toBeNull();
    expect(
      server.messagesTo(info.clientId).some((m) => m.includes("must match your current Steam name")),
    ).toBe(true);
  });

  test("enforcement can be disabled via config", async () => {
    const server = await createTestServer({
      plugins: ["identity"],
      pluginConfig: { identity: { enforce_steam_name: false } },
    });
    const { info } = await server.connect({ name: "Keel" });
    await server.chat(info.clientId, "!name ^2Xaero");
    expect(server.runtime.db.get(`minqlx:players:${info.steamId}:colored_name`)).toBe("^7^2Xaero");
  });

  test("registered name is merged into userinfo when renaming to the Steam name", async () => {
    const server = await createTestServer({ plugins: ["identity"] });
    const sid = "76561198000000456";
    const { info } = await server.connect({
      name: "Keel",
      steamId: sid,
      userinfo: "\\name\\KeelOld\\rate\\25000",
    });
    server.runtime.db.set(`minqlx:players:${sid}:colored_name`, "^1Keel");

    // Renaming to the recorded Steam name swaps in the registered name.
    const res = await server.clientCommand(info.clientId, 'userinfo "\\name\\Keel\\rate\\25000"');
    expect(res).toContain("name\\^1Keel");

    // Renaming to anything else resets the registered name.
    await server.clientCommand(info.clientId, 'userinfo "\\name\\Other\\rate\\25000"');
    expect(server.runtime.db.get(`minqlx:players:${sid}:colored_name`)).toBeNull();
    expect(
      server.messagesTo(info.clientId).some((m) => m.includes("registered name has been reset")),
    ).toBe(true);
  });

  test("!name without args removes the registered name", async () => {
    const server = await createTestServer({ plugins: ["identity"] });
    const { info } = await server.connect({ name: "Keel" });
    await server.chat(info.clientId, "!name ^4Keel");
    expect(server.runtime.db.get(`minqlx:players:${info.steamId}:colored_name`)).toBe("^7^4Keel");
    await server.chat(info.clientId, "!name");
    expect(server.runtime.db.get(`minqlx:players:${info.steamId}:colored_name`)).toBeNull();
    expect(server.messagesTo(info.clientId).some((m) => m.includes("has been removed"))).toBe(true);
  });
});
