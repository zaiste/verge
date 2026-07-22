/**
 * Live smoke test: drives a real QLDS through a scripted scenario using
 * bots as clients and asserts on the events that come back. Not part of
 * the default plugin set — load it via config on a disposable server:
 *
 *   [server] plugins = ["admin", "smoketest"]
 *
 * Results are printed to the server console as [SMOKE] lines, ending with
 * [SMOKE] DONE passed=N failed=N.
 *
 * Techniques:
 * - console_command("addbot ...") creates real client entities
 * - the client_command RPC injects chat/votes as if a client typed them
 * - console_command("verge ...") round-trips the rcon/owner command path
 */
import type { Plugin, PluginContext } from "../runtime/src/plugin";
import type { Player } from "../runtime/src/players";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

class Smoke {
  passed = 0;
  failed = 0;

  constructor(private ctx: PluginContext) {}

  private async report(name: string, ok: boolean, detail = "") {
    if (ok) this.passed++;
    else this.failed++;
    await this.ctx.consolePrint(
      `[SMOKE] ${ok ? "PASS" : "FAIL"}: ${name}${detail ? ` (${detail})` : ""}`,
    );
  }

  /** Waits until fn returns truthy or the timeout elapses. */
  private async until<T>(fn: () => T | undefined | null | false, timeoutMs: number): Promise<T | null> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const val = fn();
      if (val) return val;
      if (Date.now() > deadline) return null;
      await wait(250);
    }
  }

  /** Collects events of a type while running an action. */
  private collect<E extends Parameters<PluginContext["on"]>[0]>(event: E): unknown[][] {
    const seen: unknown[][] = [];
    this.ctx.on(event, ((...args: unknown[]) => {
      seen.push(args);
    }) as never);
    return seen;
  }

  async run(): Promise<void> {
    const { ctx } = this;
    await ctx.consolePrint("[SMOKE] starting live scenario...");

    // --- start clean: the factory may have auto-filled bots ---
    await ctx.engine.rpc("console_command", "bot_minplayers 0");
    for (const b of ctx.players().filter((p) => p.isBot)) {
      await b.kick("smoke reset");
    }
    const empty = await this.until(
      () => (ctx.players().filter((p) => p.isBot).length === 0 ? true : undefined),
      15000,
    );
    await this.report(
      "cleared pre-existing bots",
      empty === true,
      `bots=${ctx.players().filter((p) => p.isBot).length}`,
    );
    if (!empty) return this.finish();

    // --- bots connect as real clients ---
    const connects = this.collect("player_connect");
    await ctx.engine.rpc("console_command", "addbot sarge 1");
    await ctx.engine.rpc("console_command", "addbot doom 1");
    const bots = await this.until(() => {
      const b = ctx.players().filter((p) => p.isBot);
      return b.length >= 2 ? b : null;
    }, 20000);
    await this.report("bots joined as clients", bots !== null, `players=${ctx.players().length}`);
    if (!bots) return this.finish();
    await this.report("player_connect fired for bots", connects.length >= 2, `events=${connects.length}`);
    const bot = bots[0]!;
    // Bots get the same pseudo steam id every run; drop permissions a
    // previous scenario may have persisted so "unprivileged" holds.
    for (const b of bots) ctx.db.setPermission(b.steamId, 0);

    // --- chat pipeline: injected say goes through the full regex path ---
    const chats = this.collect("chat");
    await ctx.engine.rpc("client_command", bot.id, 'say "hello from the smoke test"');
    await wait(500);
    const chatSeen = chats.some((a) => String(a[1]).includes("hello from the smoke test"));
    await this.report("chat event from injected say", chatSeen);

    // --- permission gate: unprivileged !kick must not act ---
    const other = bots[1]!;
    await ctx.engine.rpc("client_command", bot.id, `say "!kick ${other.id}"`);
    await wait(1000);
    await this.report("unprivileged !kick ignored", ctx.player(other.id) !== null);

    // Command replies travel over RPCs that call the ORIGINAL engine
    // functions (never the hooked ones), so a plugin cannot observe its own
    // reply text as an event — every assertion below is on game/db state.

    // --- rcon path: owner-level !setperm must land in the database ---
    await ctx.engine.rpc("console_command", `verge !setperm ${bot.id} 2`);
    const perm = await this.until(
      () => (ctx.db.getPermission(bot.steamId) === 2 ? true : undefined),
      3000,
    );
    await this.report("rcon !setperm wrote permission", perm === true);

    // --- rcon !slap: observable as a health drop ---
    const before = (await bot.state())?.health ?? 0;
    await ctx.engine.rpc("console_command", `verge !slap ${bot.id} 30`);
    let after = before;
    const slapDeadline = Date.now() + 3000;
    while (Date.now() < slapDeadline) {
      after = (await bot.state())?.health ?? after;
      if (after < before) break;
      await wait(250);
    }
    await this.report("rcon !slap damaged bot", after < before, `health ${before}->${after}`);

    // --- chat command by the now-privileged client: !slay ---
    // slay gibs by writing health directly, bypassing the game's die path,
    // so no PLAYER_DEATH reaches the stats feed — watch the forced respawn
    // instead (which also covers the player_spawn event).
    const spawns = this.collect("player_spawn");
    await ctx.engine.rpc("client_command", bot.id, `say "!slay ${other.id}"`);
    const slain = await this.until(
      () => spawns.some((a) => (a[0] as Player).id === other.id) || undefined,
      10000,
    );
    await this.report("chat !slay gibbed target (respawn seen)", slain !== null);

    // --- team switch: put the bot on a team, expect the stats event ---
    const switches = this.collect("team_switch");
    await ctx.engine.rpc("console_command", `put ${bot.id} red`);
    const switched = await this.until(
      () => switches.some((a) => (a[0] as Player).id === bot.id) || undefined,
      8000,
    );
    await bot.update();
    await this.report("put moved bot to red", bot.team === "red", `team=${bot.team}`);
    await this.report("team_switch stats event", switched !== null);

    // --- vote flow: callvote injected as the client ---
    const votesCalled = this.collect("vote_called");
    const votesStarted = this.collect("vote_started");
    await ctx.engine.rpc("client_command", bot.id, "callvote map_restart");
    await wait(1500);
    await this.report("vote_called from injected callvote", votesCalled.length > 0);
    await this.report("vote_started via configstring", votesStarted.length > 0);
    await ctx.engine.rpc("force_vote", false); // clean up the vote

    // --- kill/death events from bots fighting (ZMQ stats feed) ---
    await ctx.engine.rpc("console_command", `put ${other.id} red`);
    const deaths = this.collect("death");
    const died = await this.until(() => deaths.length > 0 || undefined, 45000);
    await this.report("death event from ZMQ stats", died !== null, `deaths=${deaths.length}`);

    // --- bounds: configstring index 1024 must be an RPC error, not a
    // Com_Error that drops the whole server ---
    let csRejected = false;
    try {
      await ctx.engine.rpc("set_configstring", 1024, "overflow");
    } catch {
      csRejected = true;
    }
    const aliveAfter = (await ctx.engine.rpc("get_cvar", "sv_maxclients")) !== null;
    await this.report("configstring 1024 rejected, server alive", csRejected && aliveAfter);

    // --- moderation: owner kick via rcon actually removes the client ---
    await ctx.engine.rpc("console_command", `verge !kick ${other.id}`);
    const kicked = await this.until(() => (ctx.player(other.id) === null ? true : undefined), 5000);
    await this.report("rcon !kick removed bot", kicked === true);

    await this.finish();
  }

  private async finish() {
    await this.ctx.consolePrint(
      `[SMOKE] DONE passed=${this.passed} failed=${this.failed}`,
    );
  }
}

export default {
  name: "smoketest",
  setup(ctx) {
    let started = false;
    const kickoff = () => {
      if (started) return;
      started = true;
      // Give the map a moment to settle before scripting against it.
      ctx.delay(3000, () => {
        new Smoke(ctx).run().catch((e) => {
          void ctx.consolePrint(`[SMOKE] CRASHED: ${e instanceof Error ? e.stack : e}`);
        });
      });
    };
    ctx.on("new_game", kickoff);
  },
} satisfies Plugin;
