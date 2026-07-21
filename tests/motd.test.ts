import { describe, expect, test } from "bun:test";
import { createTestServer, OWNER_ID } from "../testkit/src/fixtures";

const MOTD_KEY = "verge:motd";
// delay_ms 0 keeps tests fast; a short sleep lets the delayed send run.
const cfg = { motd: { delay_ms: 0 } };

describe("motd", () => {
  test("motd is shown and sounded to a loading player", async () => {
    const server = await createTestServer({ plugins: ["motd"], pluginConfig: cfg });
    server.runtime.db.set(MOTD_KEY, "Welcome to the server!\\nHave fun!");

    const { info } = await server.connect({ name: "Visitor" });
    await Bun.sleep(20);

    const msgs = server.messagesTo(info.clientId);
    expect(msgs.some((m) => m.includes("Message of the Day"))).toBe(true);
    expect(msgs.some((m) => m.includes("Welcome to the server!"))).toBe(true);
    expect(msgs.some((m) => m.includes("Have fun!"))).toBe(true);
    expect(msgs.some((m) => m.startsWith("playSound"))).toBe(true);
  });

  test("no sound when the player disabled sounds or sound is off", async () => {
    const server = await createTestServer({
      plugins: ["motd"],
      pluginConfig: { motd: { delay_ms: 0, sound: "0" } },
    });
    server.runtime.db.set(MOTD_KEY, "Hello");
    const { info } = await server.connect({ name: "Visitor" });
    await Bun.sleep(20);
    const msgs = server.messagesTo(info.clientId);
    expect(msgs.some((m) => m.includes("Hello"))).toBe(true);
    expect(msgs.some((m) => m.startsWith("playSound"))).toBe(false);
  });

  test("nothing is sent when no motd is set", async () => {
    const server = await createTestServer({ plugins: ["motd"], pluginConfig: cfg });
    const { info } = await server.connect({ name: "Visitor" });
    await Bun.sleep(20);
    expect(server.messagesTo(info.clientId)).toEqual([]);
  });

  test("!setmotd is gated on permission level 4", async () => {
    const server = await createTestServer({ plugins: ["motd"], pluginConfig: cfg });

    const pleb = await server.connect({ name: "Pleb" });
    await server.chat(pleb.info.clientId, "!setmotd Sneaky motd");
    expect(server.runtime.db.get(MOTD_KEY)).toBeNull();

    const owner = await server.connect({ name: "Owner", steamId: OWNER_ID });
    await server.chat(owner.info.clientId, "!setmotd Hi there");
    expect(server.runtime.db.get(MOTD_KEY)).toBe("Hi there");
    expect(server.messagesTo(owner.info.clientId).some((m) => m.includes("The MOTD has been set."))).toBe(true);

    // A level-4 (non-owner) admin is allowed too.
    server.runtime.db.setPermission(pleb.info.steamId, 4);
    await server.chat(pleb.info.clientId, "!setmotd Admin motd");
    expect(server.runtime.db.get(MOTD_KEY)).toBe("Admin motd");
  });

  test("!getmotd, !addmotd and !clearmotd", async () => {
    const server = await createTestServer({ plugins: ["motd"], pluginConfig: cfg });
    const owner = await server.connect({ name: "Owner", steamId: OWNER_ID });
    const id = owner.info.clientId;

    await server.chat(id, "!getmotd");
    expect(server.messagesTo(id).some((m) => m.includes("No MOTD has been set."))).toBe(true);

    await server.chat(id, "!setmotd First line");
    await server.chat(id, "!addmotd second part");
    expect(server.runtime.db.get(MOTD_KEY)).toBe("First line second part");

    await server.chat(id, "!getmotd");
    expect(server.messagesTo(id).some((m) => m.includes("First line second part"))).toBe(true);

    await server.chat(id, "!clearmotd");
    expect(server.runtime.db.get(MOTD_KEY)).toBeNull();
    expect(server.messagesTo(id).some((m) => m.includes("The MOTD has been cleared."))).toBe(true);
  });
});
