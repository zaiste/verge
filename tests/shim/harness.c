/*
 * Exercises the real IPC layer (shim/shim_ipc.c) against a real Bun sidecar,
 * with the engine stubbed out. The engine half of the shim can only be
 * tested on a live QLDS; this covers the half that can run anywhere, which
 * is where the protocol bugs have actually been.
 *
 * Scenarios:
 *   1. sidecar spawn and the hello handshake
 *   2. blocking hook round-trip
 *   3. fire-and-forget event delivery, and the RPC burst it provokes
 *   4. re-entrancy: an RPC that dispatches a hook while a burst of further
 *      RPCs is already sitting in the read buffer. The hook's wait loop
 *      reads that buffer again, so an outer reader holding indices into it
 *      would see them shift underneath -- that defect corrupted framing and
 *      eventually segfaulted a live server.
 *   5. parked-RPC drain order: interleaved mutating/read-only RPCs execute
 *      once each, in arrival order, across the park-and-drain boundary
 *   6. hook timeout: an unanswered hook passes through after
 *      VERGE_HOOK_TIMEOUT_MS, the connection survives, and the eventual
 *      late reply is dropped as stale
 *   7. sidecar death mid-hook-wait: the wait breaks to HOOK_PASS and the
 *      broker respawns the sidecar
 *   8. oversized line: a line past MAX_LINE_SIZE drops the connection
 *      (bounded memory), followed by another respawn
 *
 *   make check-shim
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <stdarg.h>
#include <time.h>

#include "shim/shim_internal.h"

#define MAX_RECORDED 256
#define MUT_BURST 8
#define HOOK_TIMEOUT_MS 1500

static int verbose;
static const char* recorded[MAX_RECORDED];
static int recorded_count;
static int nested_hook_result = -1;

void DebugPrint(const char* fmt, ...) {
    if (!verbose)
        return;
    va_list args;
    va_start(args, fmt);
    printf("[shim] ");
    vprintf(fmt, args);
    va_end(args);
}

// Mirrors the real classification in shim_rpc.c: reads run inline, even
// inside a hook wait; anything that mutates engine state is deferred.
int Shim_RpcIsReadOnly(const char* fn) {
    return !strcmp(fn, "get_cvar") || !strcmp(fn, "player_info");
}

cJSON* Shim_ExecuteRpc(const char* fn, const cJSON* args, const char** err) {
    (void)err;
    const char* arg0 = cJSON_GetStringValue(cJSON_GetArrayItem((cJSON*)args, 0));
    if (recorded_count < MAX_RECORDED)
        recorded[recorded_count++] = strdup(arg0 ? arg0 : fn);

    // Stands in for an engine call that broadcasts: executing it dispatches
    // a hook, and the shim re-enters its own reader while waiting.
    if (!strcmp(fn, "console_command")) {
        char buf[4096];
        cJSON* hook_args = cJSON_CreateArray();
        cJSON_AddItemToArray(hook_args, cJSON_CreateNumber(-1));
        cJSON_AddItemToArray(hook_args, cJSON_CreateString("print \"nested\"\n"));
        nested_hook_result = Shim_SendHookAndWait(SUB_SERVER_COMMAND, "server_command",
                                                  hook_args, buf, sizeof(buf));
    }
    return cJSON_CreateNull();
}

static int fail(const char* what) {
    printf("[harness] FAIL: %s\n", what);
    Shim_Shutdown();
    return 1;
}

static long long wall_ms(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (long long)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}

void Shim_FrameEvent(void);

// Pumps frames (as G_RunFrame would) until pred() or the frame budget runs out.
static int pump_until(int (*pred)(void), int max_frames) {
    for (int i = 0; i < max_frames; i++) {
        if (pred())
            return 1;
        Shim_FrameEvent();
        usleep(25000);
    }
    return pred();
}

static int want_recorded;
static int pred_connected(void) { return Shim_IsConnected(); }
static int pred_disconnected(void) { return !Shim_IsConnected(); }
static int pred_recorded(void) { return recorded_count >= want_recorded; }

// A plain blocking hook round-trip; cmd selects the echo-sidecar behaviour.
static hook_result_t send_hook(const char* cmd) {
    char buf[4096];
    cJSON* args = cJSON_CreateArray();
    cJSON_AddItemToArray(args, cJSON_CreateNumber(5));
    cJSON_AddItemToArray(args, cJSON_CreateString(cmd));
    return Shim_SendHookAndWait(SUB_CLIENT_COMMAND, "client_command", args, buf, sizeof(buf));
}

static void send_rcon(const char* what) {
    cJSON* args = cJSON_CreateArray();
    cJSON_AddItemToArray(args, cJSON_CreateString(what));
    Shim_SendEvent(SUB_RCON, "rcon", args);
}

int main(int argc, char** argv) {
    verbose = argc > 1 && !strcmp(argv[1], "-v");
    const char* burst_env = getenv("HARNESS_BURST");
    int burst = burst_env ? atoi(burst_env) : 24;

    char timeout_str[16];
    snprintf(timeout_str, sizeof(timeout_str), "%d", HOOK_TIMEOUT_MS);
    setenv("VERGE_HOOK_TIMEOUT_MS", timeout_str, 1);
    if (!getenv("VERGE_ENTRY"))
        setenv("VERGE_ENTRY", "tests/shim/echo-sidecar.ts", 1);
    if (!getenv("VERGE_SOCKET"))
        setenv("VERGE_SOCKET", "/tmp/verge-harness.sock", 1); // sun_path is short

    Shim_Initialize();

    // Scenario 1: spawn + hello.
    if (!pump_until(pred_connected, 800))
        return fail("sidecar never connected");
    printf("[harness] PASS: sidecar spawned and sent hello\n");

    // Scenario 2: a plain blocking hook, before any nesting.
    if (send_hook("say hello") != HOOK_PASS)
        return fail("blocking hook did not pass through");
    printf("[harness] PASS: blocking hook round-trip\n");

    // Scenarios 3 and 4: the event makes the sidecar send the nesting
    // trigger plus a burst of RPCs in one write.
    cJSON* ng_args = cJSON_CreateArray();
    cJSON_AddItemToArray(ng_args, cJSON_CreateBool(0));
    Shim_SendEvent(SUB_NEW_GAME, "new_game", ng_args);
    want_recorded = burst + 1;
    if (!pump_until(pred_recorded, 400)) {
        printf("[harness] FAIL: %d of %d RPCs executed (lost to framing?)\n",
               recorded_count, burst + 1);
        Shim_Shutdown();
        return 1;
    }
    printf("[harness] PASS: event delivered, %d RPCs executed\n", recorded_count);

    if (nested_hook_result != HOOK_PASS)
        return fail("hook dispatched from inside an RPC did not complete");
    printf("[harness] PASS: hook dispatched from inside an RPC completed\n");

    // Every burst RPC must appear exactly once, in the order sent: a reader
    // that mangles its buffer drops, duplicates, or reorders them.
    if (strcmp(recorded[0], "nest"))
        return fail("first RPC was not the nesting trigger");
    for (int i = 0; i < burst; i++) {
        char want[32];
        snprintf(want, sizeof(want), "filler_%d", i);
        if (strcmp(recorded[i + 1], want)) {
            printf("[harness] FAIL: RPC %d was '%s', expected '%s'\n",
                   i + 1, recorded[i + 1], want);
            Shim_Shutdown();
            return 1;
        }
    }
    printf("[harness] PASS: %d RPCs executed once each, in order, across the nested read\n",
           burst);

    // Scenario 5: interleaved mutating/read-only RPCs. Mutating ones are
    // parked (always when read off-main, and inside waits on-main) and
    // drained at the top of a frame; arrival order must survive.
    int before = recorded_count;
    send_rcon("mutburst");
    want_recorded = before + 2 * MUT_BURST;
    if (!pump_until(pred_recorded, 400))
        return fail("mutburst RPCs did not all execute");
    for (int i = 0; i < MUT_BURST; i++) {
        char want_mut[32], want_ro[32];
        snprintf(want_mut, sizeof(want_mut), "mut_%d", i);
        snprintf(want_ro, sizeof(want_ro), "roint_%d", i);
        if (strcmp(recorded[before + 2 * i], want_mut) ||
                strcmp(recorded[before + 2 * i + 1], want_ro)) {
            printf("[harness] FAIL: drain order broke at pair %d: '%s', '%s'\n",
                   i, recorded[before + 2 * i], recorded[before + 2 * i + 1]);
            Shim_Shutdown();
            return 1;
        }
    }
    printf("[harness] PASS: %d parked/inline RPCs drained in arrival order\n", 2 * MUT_BURST);

    // Scenario 6: unanswered hook -> pass-through at the timeout, connection
    // intact. The sidecar replies 1 s after the timeout; that stale reply
    // must be dropped, which scenario 7's hook implicitly verifies.
    long long t0 = wall_ms();
    if (send_hook("say noreply") != HOOK_PASS)
        return fail("timed-out hook did not pass through");
    long long elapsed = wall_ms() - t0;
    if (elapsed < HOOK_TIMEOUT_MS - 100)
        return fail("hook returned before the timeout could have elapsed");
    if (!Shim_IsConnected())
        return fail("connection did not survive a hook timeout");
    printf("[harness] PASS: unanswered hook passed through after %lld ms\n", elapsed);

    // Scenario 7: sidecar exits mid-wait without replying. The wait must
    // break to HOOK_PASS, and the broker must respawn the sidecar.
    if (send_hook("say die") != HOOK_PASS)
        return fail("hook did not pass through when the sidecar died mid-wait");
    if (Shim_IsConnected())
        return fail("connection outlived the sidecar");
    printf("[harness] PASS: sidecar death mid-wait broke to pass-through\n");
    if (!pump_until(pred_connected, 800))
        return fail("sidecar was not respawned after dying");
    printf("[harness] PASS: sidecar respawned and reconnected\n");

    // Scenario 8: a single line past MAX_LINE_SIZE must drop the connection
    // (bounded memory), after which the exiting sidecar is respawned again.
    send_rcon("oversize");
    if (!pump_until(pred_disconnected, 400))
        return fail("oversized line did not drop the connection");
    printf("[harness] PASS: oversized line dropped the connection\n");
    if (!pump_until(pred_connected, 800))
        return fail("sidecar was not respawned after the oversize drop");
    if (send_hook("say hello") != HOOK_PASS)
        return fail("hook round-trip failed after respawns");
    printf("[harness] PASS: respawned sidecar serves hooks again\n");

    Shim_Shutdown();
    printf("[harness] ALL PASS\n");
    return 0;
}
