#define _GNU_SOURCE

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <time.h>
#include <signal.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <sys/stat.h>

#include "shim_internal.h"
#include "../core/common.h"

#define MAX_LINE_SIZE   (1 << 20) // 1 MiB: drop the connection past this
#define OUT_BUF_SIZE    (1 << 19) // 512 KiB pending-write buffer
#define MAX_WAIT_DEPTH  16

typedef struct {
    unsigned id;
    int done;
    hook_result_t result;
    char str[4096];
} hook_wait_t;

static struct {
    int listen_fd;
    int conn_fd;
    int hello_received;
    unsigned subs;
    int frame_every;
    unsigned frame_counter;

    pid_t child_pid;
    int no_spawn;
    long long next_spawn_at_ms; // monotonic deadline for respawn
    int backoff_ms;

    char socket_path[512];
    char bun_path[512];
    char entry_path[512];
    int hook_timeout_ms;

    // Incoming line accumulator.
    char* in_buf;
    size_t in_len;
    size_t in_cap;

    // Outgoing buffer for partial writes.
    char* out_buf;
    size_t out_len;

    hook_wait_t wait_stack[MAX_WAIT_DEPTH];
    int wait_depth;
    unsigned next_hook_id;

    FILE* trace; // MINQLX_TRACE: tee all protocol traffic to a JSONL file
} shim = { .listen_fd = -1, .conn_fd = -1, .backoff_ms = 1000 };

static long long now_ms(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (long long)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}

static void trace_line(const char* dir, const char* line) {
    if (!shim.trace)
        return;
    fprintf(shim.trace, "{\"dir\":\"%s\",\"msg\":%s}\n", dir, line);
    fflush(shim.trace);
}

static void drop_connection(const char* why) {
    if (shim.conn_fd != -1) {
        DebugPrint("Dropping sidecar connection: %s\n", why);
        close(shim.conn_fd);
        shim.conn_fd = -1;
    }
    shim.hello_received = 0;
    shim.subs = 0;
    shim.frame_every = 0;
    shim.in_len = 0;
    shim.out_len = 0;
    // Pending waits can never complete now; fail them as pass-through.
    for (int i = 0; i < shim.wait_depth; i++) {
        if (!shim.wait_stack[i].done) {
            shim.wait_stack[i].done = 1;
            shim.wait_stack[i].result = HOOK_PASS;
        }
    }
}

int Shim_IsConnected(void) {
    return shim.conn_fd != -1 && shim.hello_received;
}

int Shim_IsSubscribed(int sub_bit) {
    return Shim_IsConnected() && (shim.subs & sub_bit);
}

/*
 * ================================================================
 *                         child process
 * ================================================================
*/

static void spawn_sidecar(void) {
    if (shim.no_spawn)
        return;

    pid_t pid = fork();
    if (pid < 0) {
        DebugPrint("fork() failed: %s\n", strerror(errno));
        return;
    }
    if (pid == 0) {
        setenv("MINQLX_SOCKET", shim.socket_path, 1);
        char* const argv[] = { shim.bun_path, shim.entry_path, NULL };
        execvp(shim.bun_path, argv);
        fprintf(stderr, DEBUG_PRINT_PREFIX "execvp(%s) failed: %s\n",
                shim.bun_path, strerror(errno));
        _exit(127);
    }
    shim.child_pid = pid;
    DebugPrint("Spawned sidecar: %s %s (pid %d)\n", shim.bun_path, shim.entry_path, pid);
}

static void supervise_child(void) {
    if (shim.no_spawn)
        return;

    if (shim.child_pid > 0) {
        int status;
        pid_t res = waitpid(shim.child_pid, &status, WNOHANG);
        if (res == shim.child_pid) {
            if (WIFEXITED(status))
                DebugPrint("Sidecar exited with status %d.\n", WEXITSTATUS(status));
            else if (WIFSIGNALED(status))
                DebugPrint("Sidecar killed by signal %d.\n", WTERMSIG(status));
            shim.child_pid = 0;
            drop_connection("sidecar process exited");
            shim.next_spawn_at_ms = now_ms() + shim.backoff_ms;
            DebugPrint("Respawning sidecar in %d ms.\n", shim.backoff_ms);
            if (shim.backoff_ms < 30000)
                shim.backoff_ms *= 2;
        }
        return;
    }

    if (shim.next_spawn_at_ms && now_ms() >= shim.next_spawn_at_ms) {
        shim.next_spawn_at_ms = 0;
        spawn_sidecar();
    }
}

void Shim_RestartSidecar(void) {
    DebugPrint("Restarting sidecar...\n");
    drop_connection("restart requested");
    if (shim.child_pid > 0)
        kill(shim.child_pid, SIGTERM);
    shim.backoff_ms = 1000;
    // supervise_child() reaps it and respawns on the next tick.
}

/*
 * ================================================================
 *                       socket read/write
 * ================================================================
*/

static void flush_out_buf(void) {
    while (shim.out_len > 0 && shim.conn_fd != -1) {
        ssize_t n = write(shim.conn_fd, shim.out_buf, shim.out_len);
        if (n > 0) {
            memmove(shim.out_buf, shim.out_buf + n, shim.out_len - n);
            shim.out_len -= n;
        }
        else if (n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK))
            return;
        else if (n < 0 && errno == EINTR)
            continue;
        else {
            drop_connection("write failed");
            return;
        }
    }
}

// Queues (and opportunistically flushes) one NDJSON line. Takes ownership of json.
static void send_json(cJSON* json) {
    char* line = cJSON_PrintUnformatted(json);
    cJSON_Delete(json);
    if (!line)
        return;
    if (shim.conn_fd == -1) {
        free(line);
        return;
    }
    trace_line("out", line);

    size_t len = strlen(line);
    if (shim.out_len + len + 1 > OUT_BUF_SIZE) {
        free(line);
        drop_connection("output buffer full (sidecar stuck?)");
        return;
    }
    memcpy(shim.out_buf + shim.out_len, line, len);
    shim.out_buf[shim.out_len + len] = '\n';
    shim.out_len += len + 1;
    free(line);
    flush_out_buf();
}

static void handle_hello(cJSON* msg) {
    shim.subs = 0;
    cJSON* subs = cJSON_GetObjectItemCaseSensitive(msg, "subs");
    cJSON* sub;
    cJSON_ArrayForEach(sub, subs) {
        const char* s = cJSON_GetStringValue(sub);
        if (!s) continue;
        else if (!strcmp(s, "client_command"))    shim.subs |= SUB_CLIENT_COMMAND;
        else if (!strcmp(s, "server_command"))    shim.subs |= SUB_SERVER_COMMAND;
        else if (!strcmp(s, "frame"))             shim.subs |= SUB_FRAME;
        else if (!strcmp(s, "player_connect"))    shim.subs |= SUB_PLAYER_CONNECT;
        else if (!strcmp(s, "player_loaded"))     shim.subs |= SUB_PLAYER_LOADED;
        else if (!strcmp(s, "player_disconnect")) shim.subs |= SUB_PLAYER_DISCONNECT;
        else if (!strcmp(s, "new_game"))          shim.subs |= SUB_NEW_GAME;
        else if (!strcmp(s, "set_configstring"))  shim.subs |= SUB_SET_CONFIGSTRING;
        else if (!strcmp(s, "rcon"))              shim.subs |= SUB_RCON;
        else if (!strcmp(s, "console_print"))     shim.subs |= SUB_CONSOLE_PRINT;
        else if (!strcmp(s, "player_spawn"))      shim.subs |= SUB_PLAYER_SPAWN;
        else if (!strcmp(s, "kamikaze_use"))      shim.subs |= SUB_KAMIKAZE_USE;
        else if (!strcmp(s, "kamikaze_explode"))  shim.subs |= SUB_KAMIKAZE_EXPLODE;
        else if (!strcmp(s, "custom_command"))    shim.subs |= SUB_CUSTOM_COMMAND;
        else DebugPrint("hello: unknown subscription '%s'\n", s);
    }
    cJSON* fe = cJSON_GetObjectItemCaseSensitive(msg, "frameEvery");
    shim.frame_every = cJSON_IsNumber(fe) ? (int)fe->valuedouble : 0;
    shim.hello_received = 1;
    DebugPrint("Sidecar ready (subs: 0x%x, frameEvery: %d).\n", shim.subs, shim.frame_every);
}

static void handle_rpc(cJSON* msg) {
    cJSON* id = cJSON_GetObjectItemCaseSensitive(msg, "id");
    cJSON* fn = cJSON_GetObjectItemCaseSensitive(msg, "fn");
    cJSON* args = cJSON_GetObjectItemCaseSensitive(msg, "args");
    if (!cJSON_IsNumber(id) || !cJSON_IsString(fn))
        return;

    const char* err = NULL;
    cJSON* val = Shim_ExecuteRpc(fn->valuestring, args, &err);

    cJSON* res = cJSON_CreateObject();
    cJSON_AddStringToObject(res, "t", "rpcres");
    cJSON_AddNumberToObject(res, "id", id->valuedouble);
    if (val) {
        cJSON_AddBoolToObject(res, "ok", 1);
        cJSON_AddItemToObject(res, "val", val);
    }
    else {
        cJSON_AddBoolToObject(res, "ok", 0);
        cJSON_AddStringToObject(res, "err", err ? err : "unknown error");
    }
    send_json(res);
}

static void handle_hookres(cJSON* msg) {
    cJSON* id = cJSON_GetObjectItemCaseSensitive(msg, "id");
    if (!cJSON_IsNumber(id))
        return;
    unsigned uid = (unsigned)id->valuedouble;

    for (int i = 0; i < shim.wait_depth; i++) {
        hook_wait_t* w = &shim.wait_stack[i];
        if (w->id != uid || w->done)
            continue;
        cJSON* res = cJSON_GetObjectItemCaseSensitive(msg, "res");
        if (cJSON_IsString(res)) {
            w->result = HOOK_REPLACE;
            strncpy(w->str, res->valuestring, sizeof(w->str) - 1);
            w->str[sizeof(w->str) - 1] = 0;
        }
        else if (cJSON_IsFalse(res))
            w->result = HOOK_CANCEL;
        else
            w->result = HOOK_PASS;
        w->done = 1;
        return;
    }
    // Not on the wait stack: a reply that already timed out. Drop it.
}

static void process_line(char* line) {
    trace_line("in", line);
    cJSON* msg = cJSON_Parse(line);
    if (!msg) {
        DebugPrint("Bad JSON from sidecar, dropping connection.\n");
        drop_connection("protocol error");
        return;
    }
    const char* t = cJSON_GetStringValue(cJSON_GetObjectItemCaseSensitive(msg, "t"));
    if (t && !strcmp(t, "rpc"))
        handle_rpc(msg);
    else if (t && !strcmp(t, "hookres"))
        handle_hookres(msg);
    else if (t && !strcmp(t, "hello"))
        handle_hello(msg);
    else
        DebugPrint("Unknown message type from sidecar.\n");
    cJSON_Delete(msg);
}

// Reads whatever is available and processes complete lines. Returns 1 if any
// message was processed.
static int read_and_process(void) {
    if (shim.conn_fd == -1)
        return 0;

    int processed = 0;
    char chunk[65536];
    for (;;) {
        ssize_t n = read(shim.conn_fd, chunk, sizeof(chunk));
        if (n > 0) {
            if (shim.in_len + n > MAX_LINE_SIZE) {
                drop_connection("input line too long");
                return processed;
            }
            if (shim.in_len + n > shim.in_cap) {
                shim.in_cap = (shim.in_len + n) * 2;
                shim.in_buf = realloc(shim.in_buf, shim.in_cap);
            }
            memcpy(shim.in_buf + shim.in_len, chunk, n);
            shim.in_len += n;

            // Process complete lines.
            size_t start = 0;
            for (size_t i = 0; i < shim.in_len; i++) {
                if (shim.in_buf[i] != '\n')
                    continue;
                shim.in_buf[i] = 0;
                if (i > start)
                    process_line(shim.in_buf + start);
                processed = 1;
                start = i + 1;
                if (shim.conn_fd == -1)
                    return processed; // connection dropped while processing
            }
            memmove(shim.in_buf, shim.in_buf + start, shim.in_len - start);
            shim.in_len -= start;
        }
        else if (n == 0) {
            drop_connection("sidecar closed the socket");
            return processed;
        }
        else if (errno == EAGAIN || errno == EWOULDBLOCK)
            return processed;
        else if (errno == EINTR)
            continue;
        else {
            drop_connection("read failed");
            return processed;
        }
    }
}

static void accept_if_pending(void) {
    if (shim.listen_fd == -1)
        return;
    int fd = accept(shim.listen_fd, NULL, NULL);
    if (fd < 0)
        return;
    if (shim.conn_fd != -1)
        drop_connection("new sidecar connection replaces the old one");
    fcntl(fd, F_SETFL, fcntl(fd, F_GETFL, 0) | O_NONBLOCK);
    shim.conn_fd = fd;
    shim.in_len = 0;
    shim.out_len = 0;
    shim.backoff_ms = 1000; // healthy again: reset backoff
    DebugPrint("Sidecar connected.\n");
}

void Shim_Tick(void) {
    supervise_child();
    accept_if_pending();
    flush_out_buf();
    read_and_process();
}

/*
 * ================================================================
 *                      events and hooks
 * ================================================================
*/

static cJSON* make_msg(const char* t, const char* name, cJSON* args) {
    cJSON* msg = cJSON_CreateObject();
    cJSON_AddStringToObject(msg, "t", t);
    cJSON_AddStringToObject(msg, "name", name);
    cJSON_AddItemToObject(msg, "args", args ? args : cJSON_CreateArray());
    return msg;
}

void Shim_SendEvent(int sub_bit, const char* name, cJSON* args) {
    if (!Shim_IsSubscribed(sub_bit)) {
        cJSON_Delete(args);
        return;
    }
    cJSON* msg = make_msg("ev", name, args);
    send_json(msg);
}

hook_result_t Shim_SendHookAndWait(int sub_bit, const char* name, cJSON* args,
                                   char* buf, size_t buf_size) {
    // Give a just-(re)connected sidecar a chance before deciding to pass through.
    accept_if_pending();

    if (!Shim_IsSubscribed(sub_bit) || shim.wait_depth >= MAX_WAIT_DEPTH) {
        cJSON_Delete(args);
        return HOOK_PASS;
    }

    unsigned id = ++shim.next_hook_id;
    cJSON* msg = make_msg("hook", name, args);
    cJSON_AddNumberToObject(msg, "id", id);
    send_json(msg);
    if (shim.conn_fd == -1) // send_json may have dropped the connection
        return HOOK_PASS;

    hook_wait_t* w = &shim.wait_stack[shim.wait_depth++];
    w->id = id;
    w->done = 0;
    w->result = HOOK_PASS;
    w->str[0] = 0;

    long long deadline = now_ms() + shim.hook_timeout_ms;
    while (!w->done) {
        long long remaining = deadline - now_ms();
        if (remaining <= 0) {
            DebugPrint("Hook '%s' (id %u) timed out after %d ms; passing through.\n",
                       name, id, shim.hook_timeout_ms);
            break;
        }
        struct pollfd pfd = { .fd = shim.conn_fd, .events = POLLIN };
        if (shim.out_len > 0)
            pfd.events |= POLLOUT;
        int res = poll(&pfd, 1, (int)remaining);
        if (res < 0 && errno != EINTR) {
            drop_connection("poll failed");
            break;
        }
        if (pfd.revents & POLLOUT)
            flush_out_buf();
        read_and_process(); // executes nested RPCs, may complete our wait
        if (shim.conn_fd == -1)
            break;
    }

    hook_result_t result = w->done ? w->result : HOOK_PASS;
    if (result == HOOK_REPLACE) {
        strncpy(buf, w->str, buf_size - 1);
        buf[buf_size - 1] = 0;
    }
    shim.wait_depth--; // ids of abandoned (timed-out) waits are simply forgotten;
                       // late replies won't match anything and get dropped
    return result;
}

/*
 * ================================================================
 *                       init / shutdown
 * ================================================================
*/

void Shim_Initialize(void) {
    const char* env;

    env = getenv("MINQLX_SOCKET");
    snprintf(shim.socket_path, sizeof(shim.socket_path), "%s", env ? env : "minqlx.sock");

    env = getenv("MINQLX_BUN");
    if (env)
        snprintf(shim.bun_path, sizeof(shim.bun_path), "%s", env);
    else {
        struct stat st;
        // Prefer the bundled bun binary next to the server, fall back to PATH.
        snprintf(shim.bun_path, sizeof(shim.bun_path), "%s",
                 stat("./bun", &st) == 0 ? "./bun" : "bun");
    }

    env = getenv("MINQLX_ENTRY");
    snprintf(shim.entry_path, sizeof(shim.entry_path), "%s", env ? env : "minqlx/main.js");

    env = getenv("MINQLX_HOOK_TIMEOUT_MS");
    shim.hook_timeout_ms = env ? atoi(env) : 100;
    if (shim.hook_timeout_ms <= 0)
        shim.hook_timeout_ms = 100;

    shim.no_spawn = getenv("MINQLX_NO_SPAWN") != NULL;

    env = getenv("MINQLX_TRACE");
    if (env) {
        shim.trace = fopen(env, "a");
        if (!shim.trace)
            DebugPrint("Could not open trace file %s: %s\n", env, strerror(errno));
    }

    shim.out_buf = malloc(OUT_BUF_SIZE);
    shim.in_cap = 65536;
    shim.in_buf = malloc(shim.in_cap);

    // Don't die on writes to a closed socket.
    signal(SIGPIPE, SIG_IGN);

    shim.listen_fd = socket(AF_UNIX, SOCK_STREAM, 0);
    if (shim.listen_fd == -1) {
        DebugPrint("socket() failed: %s. Running without sidecar.\n", strerror(errno));
        return;
    }

    struct sockaddr_un addr = { .sun_family = AF_UNIX };
    if (strlen(shim.socket_path) >= sizeof(addr.sun_path)) {
        DebugPrint("Socket path too long (max %zu): %s. Running without sidecar.\n",
                   sizeof(addr.sun_path) - 1, shim.socket_path);
        close(shim.listen_fd);
        shim.listen_fd = -1;
        return;
    }
    snprintf(addr.sun_path, sizeof(addr.sun_path), "%s", shim.socket_path);
    unlink(shim.socket_path); // stale socket from a previous run
    if (bind(shim.listen_fd, (struct sockaddr*)&addr, sizeof(addr)) == -1 ||
            listen(shim.listen_fd, 1) == -1) {
        DebugPrint("bind/listen on %s failed: %s. Running without sidecar.\n",
                   shim.socket_path, strerror(errno));
        close(shim.listen_fd);
        shim.listen_fd = -1;
        return;
    }
    fcntl(shim.listen_fd, F_SETFL, fcntl(shim.listen_fd, F_GETFL, 0) | O_NONBLOCK);
    DebugPrint("minqlx %s listening on %s (hook timeout %d ms).\n",
               MINQLX_VERSION, shim.socket_path, shim.hook_timeout_ms);

    if (shim.no_spawn)
        DebugPrint("MINQLX_NO_SPAWN set: start the sidecar manually.\n");
    else
        spawn_sidecar();
}

void Shim_Shutdown(void) {
    drop_connection("shutdown");
    if (shim.listen_fd != -1) {
        close(shim.listen_fd);
        shim.listen_fd = -1;
    }
    if (shim.child_pid > 0)
        kill(shim.child_pid, SIGTERM);
    unlink(shim.socket_path);
}

/*
 * ================================================================
 *                    frame tick entry point
 * ================================================================
*/

// Called from FrameDispatcher (i.e. every G_RunFrame, engine main thread).
void Shim_FrameEvent(void);
void Shim_FrameEvent(void) {
    Shim_Tick();
    if (shim.frame_every > 0 && Shim_IsSubscribed(SUB_FRAME)) {
        if (++shim.frame_counter >= (unsigned)shim.frame_every) {
            shim.frame_counter = 0;
            Shim_SendEvent(SUB_FRAME, "frame", NULL);
        }
    }
}
