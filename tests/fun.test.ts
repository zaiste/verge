import { expect, test } from "bun:test";
import { createTestServer } from "../testkit/src/fixtures";

/** Every playSound command sent so far, as [clientId, soundPath] pairs. */
function sounds(server: Awaited<ReturnType<typeof createTestServer>>) {
  return server.engine
    .callsTo("send_server_command")
    .filter((c) => String(c.args[1]).startsWith("playSound"))
    .map((c) => [c.args[0], String(c.args[1]).replace("playSound ", "")] as const);
}

test("a chat trigger plays its sound to every player", async () => {
  const server = await createTestServer({ plugins: ["fun"] });
  const a = await server.connect({ name: "A" });
  const b = await server.connect({ name: "B" });

  await server.chat(a.info.clientId, "hahaha yeah");

  expect(sounds(server)).toEqual([
    [a.info.clientId, "sound/player/lucy/taunt.wav"],
    [b.info.clientId, "sound/player/lucy/taunt.wav"],
  ]);
});

test("triggers are matched in order, so the most specific one wins", async () => {
  const server = await createTestServer({ plugins: ["fun"], pluginConfig: { fun: { sound_delay: 0 } } });
  const a = await server.connect({ name: "A" });

  // "haha yeah" matches its own pattern before the looser /hahaha/ entry.
  await server.chat(a.info.clientId, "haha yeah");
  expect(sounds(server)[0]?.[1]).toBe("sound/player/lucy/taunt.wav");

  await server.chat(a.info.clientId, "glhf");
  expect(sounds(server)[1]?.[1]).toBe("sound/vo/crash_new/39_01.wav");
});

test("the cooldown swallows a second trigger", async () => {
  const server = await createTestServer({ plugins: ["fun"], pluginConfig: { fun: { sound_delay: 60 } } });
  const a = await server.connect({ name: "A" });

  await server.chat(a.info.clientId, "hahaha yeah");
  expect(sounds(server).length).toBe(1);

  await server.chat(a.info.clientId, "holy shit");
  expect(sounds(server).length).toBe(1);
});

test("players who disabled sounds are skipped", async () => {
  const server = await createTestServer({ plugins: ["fun"], pluginConfig: { fun: { sound_delay: 0 } } });
  const a = await server.connect({ name: "A" });
  const b = await server.connect({ name: "B" });
  server.runtime.db.setFlag(b.info.steamId, "essentials:sounds_enabled", false);

  await server.chat(a.info.clientId, "hahaha yeah");

  expect(sounds(server).map(([id]) => id)).toEqual([a.info.clientId]);
});

test("non-matching chat and team chat stay silent", async () => {
  const server = await createTestServer({ plugins: ["fun"], pluginConfig: { fun: { sound_delay: 0 } } });
  const a = await server.connect({ name: "A" });

  await server.chat(a.info.clientId, "just talking about the map");
  expect(sounds(server).length).toBe(0);

  // The plugin only listens on the main chat channel.
  await server.clientCommand(a.info.clientId, 'say_team "hahaha yeah"');
  expect(sounds(server).length).toBe(0);
});

test("!cookies always answers the caller by name", async () => {
  const server = await createTestServer({ plugins: ["fun"] });
  const a = await server.connect({ name: "Keel" });

  await server.chat(a.info.clientId, "!cookies");

  // The chat channel broadcasts, so the reply goes out to everyone.
  const replies = server.messagesTo(null).join("");
  expect(replies).toContain("Keel");
});
