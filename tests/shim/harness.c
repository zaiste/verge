/*
 * Exercises the real IPC layer (shim/shim_ipc.c) against a real Bun sidecar,
 * with the engine stubbed out. The engine half of the shim can only be
 * tested on a live QLDS; this covers the half that can run anywhere, which
 * is where the protocol bugs have actually been.
 *
 * Scenarios:
 *   1. sidecar spawn and the hello handshake
 *   2. fire-and-forget event delivery, and the RPC it provokes
 *   3. blocking hook round-trip
 *   4. re-entrancy: an RPC that dispatches a hook while a burst of further
 *      RPCs is already sitting in the read buffer. The hook's wait loop
 *      reads that buffer again, so an outer reader holding indices into it
 *      would see them shift underneath -- that defect corrupted framing and
 *      eventually segfaulted a live server.
 *
 *   make check-shim
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <stdarg.h>

#include "shim/shim_internal.h"

#define MAX_RECORDED 256

static int verbose;
static const char* recorded[MAX_RECORDED];
static int recorded_count;
static int nested_hook_result = -1;
static int nested_depth;

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
        nested_depth++;
        char buf[4096];
        cJSON* hook_args = cJSON_CreateArray();
        cJSON_AddItemToArray(hook_args, cJSON_CreateNumber(-1));
        cJSON_AddItemToArray(hook_args, cJSON_CreateString("print \"nested\"\n"));
        nested_hook_result = Shim_SendHookAndWait(SUB_SERVER_COMMAND, "server_command",
                                                  hook_args, buf, sizeof(buf));
        nested_depth--;
    }
    return cJSON_CreateNull();
}

static int fail(const char* what) {
    printf("[harness] FAIL: %s\n", what);
    Shim_Shutdown();
    return 1;
}

int main(int argc, char** argv) {
    verbose = argc > 1 && !strcmp(argv[1], "-v");
    const char* burst_env = getenv("HARNESS_BURST");
    int burst = burst_env ? atoi(burst_env) : 24;

    setenv("VERGE_HOOK_TIMEOUT_MS", "5000", 1);
    if (!getenv("VERGE_ENTRY"))
        setenv("VERGE_ENTRY", "tests/shim/echo-sidecar.ts", 1);
    if (!getenv("VERGE_SOCKET"))
        setenv("VERGE_SOCKET", "/tmp/verge-harness.sock", 1); // sun_path is short

    Shim_Initialize();

    void Shim_FrameEvent(void);
    int hello_ok = 0, hook_ok = 0, event_sent = 0;

    for (int frame = 0; frame < 800; frame++) { // 800 * 25ms = 20s budget
        Shim_FrameEvent();
        usleep(25000); // as G_RunFrame would

        if (!hello_ok && Shim_IsConnected()) {
            hello_ok = 1;
            printf("[harness] PASS: sidecar spawned and sent hello (frame %d)\n", frame);
        }

        // Scenario 3: a plain blocking hook, before any nesting.
        if (hello_ok && !hook_ok) {
            char buf[4096];
            cJSON* args = cJSON_CreateArray();
            cJSON_AddItemToArray(args, cJSON_CreateNumber(5));
            cJSON_AddItemToArray(args, cJSON_CreateString("say hello"));
            if (Shim_SendHookAndWait(SUB_CLIENT_COMMAND, "client_command",
                                     args, buf, sizeof(buf)) != HOOK_PASS)
                return fail("blocking hook did not pass through");
            hook_ok = 1;
            printf("[harness] PASS: blocking hook round-trip\n");
        }

        // Scenarios 2 and 4: the event makes the sidecar send the nesting
        // trigger plus a burst of RPCs in one write.
        if (hook_ok && !event_sent) {
            event_sent = 1;
            cJSON* args = cJSON_CreateArray();
            cJSON_AddItemToArray(args, cJSON_CreateBool(0));
            Shim_SendEvent(SUB_NEW_GAME, "new_game", args);
        }

        if (event_sent && recorded_count >= burst + 1)
            break;
    }

    if (!hello_ok)
        return fail("sidecar never connected");
    if (recorded_count < burst + 1) {
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

    Shim_Shutdown();
    printf("[harness] ALL PASS\n");
    return 0;
}
