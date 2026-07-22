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
#include <pthread.h>
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

    // Sidecar processes are created by a broker: a single-threaded helper
    // forked once at startup. Creating processes from this multithreaded
    // engine process later is not reliable (fork/posix_spawn can deadlock
    // on other threads' locks), and the broker also guarantees the sidecar
    // dies with the server. Protocol on the socketpair: we send 's'=spawn,
    // 'k'=kill; the broker sends 'x' when the sidecar exits.
    int broker_fd;
    int child_alive;
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
    int in_rpc; // depth of execute_rpc calls on the main thread

    // Outgoing buffer for partial writes.
    char* out_buf;
    size_t out_len;

    hook_wait_t wait_stack[MAX_WAIT_DEPTH];
    int wait_depth;
    unsigned next_hook_id;

    FILE* trace; // VERGE_TRACE: tee all protocol traffic to a JSONL file

    // An idle QLDS stops running frames entirely, so child supervision and
    // socket accept can't rely on Shim_Tick: a small supervisor thread does
    // both. It never calls engine functions and never executes RPCs (those
    // stay on the engine main thread); all shim state is guarded by `lock`
    // (recursive: nested dispatches re-enter from the main thread).
    pthread_mutex_t lock;
    pthread_t supervisor;
    pthread_t main_thread;
    int supervisor_running;

    // RPCs received off the main thread wait here until the next Shim_Tick:
    // engine functions may only run on the engine main thread.
    cJSON* pending_rpcs[256];
    int pending_rpc_count;
} shim = { .listen_fd = -1, .conn_fd = -1, .broker_fd = -1, .backoff_ms = 1000 };

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
    for (int i = 0; i < shim.pending_rpc_count; i++)
        cJSON_Delete(shim.pending_rpcs[i]);
    shim.pending_rpc_count = 0;
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

extern char** environ;

// Runs in the broker child process: single-threaded, so fork is safe here
// forever. Spawns/kills the sidecar on command and reports exits. Exits
// (killing the sidecar) when the engine end of the socketpair closes.
static void broker_process(int cmd_fd) {
    signal(SIGPIPE, SIG_IGN);

    static char socket_env[1024];
    snprintf(socket_env, sizeof(socket_env), "VERGE_SOCKET=%s", shim.socket_path);
    static char* envp[1024];
    int n = 0;
    envp[n++] = socket_env;
    for (int i = 0; environ[i] && n < 1022; i++) {
        if (strncmp(environ[i], "VERGE_SOCKET=", 13) != 0)
            envp[n++] = environ[i];
    }
    envp[n] = NULL;
    char* const argv[] = { shim.bun_path, shim.entry_path, NULL };

    pid_t child = 0;
    for (;;) {
        struct pollfd pfd = { .fd = cmd_fd, .events = POLLIN };
        poll(&pfd, 1, 200);

        if (pfd.revents & (POLLIN | POLLHUP | POLLERR)) {
            char cmd;
            ssize_t r = read(cmd_fd, &cmd, 1);
            if (r == 0 || (r < 0 && errno != EAGAIN && errno != EINTR)) {
                // Engine is gone: take the sidecar with us.
                if (child > 0)
                    kill(child, SIGKILL);
                _exit(0);
            }
            if (r == 1 && cmd == 's') {
                pid_t pid = fork();
                if (pid == 0) {
                    execve(shim.bun_path, argv, envp);
                    _exit(127);
                }
                if (pid > 0) {
                    child = pid;
                    DebugPrint("Spawned sidecar: %s %s (pid %d)\n",
                               shim.bun_path, shim.entry_path, pid);
                }
            }
            else if (r == 1 && cmd == 'k' && child > 0)
                kill(child, SIGKILL);
        }

        int status;
        pid_t r2;
        while ((r2 = waitpid(-1, &status, WNOHANG)) > 0) {
            if (r2 == child) {
                child = 0;
                char x = 'x';
                if (write(cmd_fd, &x, 1) != 1)
                    _exit(0);
            }
        }
    }
}

// Forked while the engine process is still effectively single-threaded.
static void start_broker(void) {
    int sv[2];
    if (socketpair(AF_UNIX, SOCK_STREAM, 0, sv) == -1) {
        DebugPrint("socketpair() failed: %s. Running without sidecar.\n", strerror(errno));
        return;
    }
    pid_t pid = fork();
    if (pid < 0) {
        DebugPrint("fork() for broker failed: %s. Running without sidecar.\n", strerror(errno));
        close(sv[0]);
        close(sv[1]);
        return;
    }
    if (pid == 0) {
        close(sv[0]);
        // Don't leak the broker's command channel into sidecars.
        fcntl(sv[1], F_SETFD, FD_CLOEXEC);
        broker_process(sv[1]);
        _exit(0); // unreachable
    }
    close(sv[1]);
    shim.broker_fd = sv[0];
    fcntl(shim.broker_fd, F_SETFL, fcntl(shim.broker_fd, F_GETFL, 0) | O_NONBLOCK);
    fcntl(shim.broker_fd, F_SETFD, FD_CLOEXEC);
}

static void spawn_sidecar(void) {
    if (shim.no_spawn || shim.broker_fd == -1)
        return;
    shim.child_alive = 1;
    char s = 's';
    if (write(shim.broker_fd, &s, 1) != 1)
        DebugPrint("Failed to signal the spawn broker: %s\n", strerror(errno));
}

static void supervise_child(void) {
    if (shim.no_spawn || shim.broker_fd == -1)
        return;

    char c;
    while (read(shim.broker_fd, &c, 1) == 1) {
        if (c != 'x')
            continue;
        DebugPrint("Sidecar exited.\n");
        shim.child_alive = 0;
        drop_connection("sidecar process exited");
        shim.next_spawn_at_ms = now_ms() + shim.backoff_ms;
        DebugPrint("Respawning sidecar in %d ms.\n", shim.backoff_ms);
        if (shim.backoff_ms < 30000)
            shim.backoff_ms *= 2;
    }

    if (!shim.child_alive && shim.next_spawn_at_ms && now_ms() >= shim.next_spawn_at_ms) {
        shim.next_spawn_at_ms = 0;
        spawn_sidecar();
    }
}

void Shim_RestartSidecar(void) {
    DebugPrint("Restarting sidecar...\n");
    drop_connection("restart requested");
    shim.backoff_ms = 1000;
    if (shim.broker_fd != -1) {
        char k = 'k';
        if (write(shim.broker_fd, &k, 1) != 1)
            DebugPrint("Failed to signal the spawn broker: %s\n", strerror(errno));
    }
    // The broker's exit notification triggers the respawn.
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

// An "id"-less message executes without sending a reply (it was already
// acknowledged when parked).
static void execute_rpc(cJSON* msg) {
    cJSON* id = cJSON_GetObjectItemCaseSensitive(msg, "id");
    cJSON* fn = cJSON_GetObjectItemCaseSensitive(msg, "fn");
    cJSON* args = cJSON_GetObjectItemCaseSensitive(msg, "args");
    if (!cJSON_IsString(fn))
        return;

    const char* err = NULL;
    shim.in_rpc++;
    cJSON* val = Shim_ExecuteRpc(fn->valuestring, args, &err);
    shim.in_rpc--;

    if (!cJSON_IsNumber(id)) {
        if (val)
            cJSON_Delete(val);
        return;
    }
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

// Parks an RPC for the frame drain. With ack, the reply is sent NOW (the
// sidecar sees mutating RPCs as fire-and-acknowledge) and the parked copy
// is stripped of its id so execution won't reply a second time.
static void park_rpc(cJSON* msg, int ack) {
    if (shim.pending_rpc_count >= (int)(sizeof(shim.pending_rpcs) / sizeof(*shim.pending_rpcs))) {
        drop_connection("pending rpc queue full");
        return;
    }
    cJSON* dup = cJSON_Duplicate(msg, 1);
    if (ack) {
        cJSON* id = cJSON_GetObjectItemCaseSensitive(dup, "id");
        if (cJSON_IsNumber(id)) {
            cJSON* res = cJSON_CreateObject();
            cJSON_AddStringToObject(res, "t", "rpcres");
            cJSON_AddNumberToObject(res, "id", id->valuedouble);
            cJSON_AddBoolToObject(res, "ok", 1);
            cJSON_AddNullToObject(res, "val");
            send_json(res);
        }
        cJSON_DeleteItemFromObjectCaseSensitive(dup, "id");
    }
    shim.pending_rpcs[shim.pending_rpc_count++] = dup;
}

// Engine functions are not re-entrant: running an arbitrary RPC while the
// engine is blocked inside a hook dispatch (or inside another RPC) can
// recurse engine->game->engine and corrupt state. So only side-effect-free
// RPCs run inline at those points; mutating RPCs are acknowledged and parked
// for the top of the next frame — the same safe point Python minqlx's
// @next_frame used.
static void handle_rpc(cJSON* msg) {
    if (!pthread_equal(pthread_self(), shim.main_thread)) {
        park_rpc(msg, 0); // supervisor thread: reply comes at execution
        return;
    }
    const char* fn = cJSON_GetStringValue(cJSON_GetObjectItemCaseSensitive(msg, "fn"));
    if ((fn && Shim_RpcIsReadOnly(fn)) || (shim.wait_depth == 0 && !shim.in_rpc)) {
        execute_rpc(msg);
        return;
    }
    park_rpc(msg, 1);
}

static void drain_pending_rpcs(void) {
    for (int i = 0; i < shim.pending_rpc_count; i++) {
        execute_rpc(shim.pending_rpcs[i]);
        cJSON_Delete(shim.pending_rpcs[i]);
    }
    shim.pending_rpc_count = 0;
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

// Extracts, consumes, and processes ONE complete line from the input buffer.
// The line is copied out and removed from in_buf BEFORE process_line runs:
// process_line can re-enter read_and_process (an RPC that calls into the
// engine fires a blocking hook, whose wait loop reads the socket), which
// reallocs and shifts in_buf — so no pointer or index into it may live
// across the call. Returns 1 if a line was consumed.
static int process_one_buffered_line(void) {
    if (shim.conn_fd == -1 || shim.in_len == 0)
        return 0;
    char* nl = memchr(shim.in_buf, '\n', shim.in_len);
    if (!nl)
        return 0;
    size_t len = (size_t)(nl - shim.in_buf);
    char* line = malloc(len + 1);
    if (!line) {
        drop_connection("out of memory");
        return 0;
    }
    memcpy(line, shim.in_buf, len);
    line[len] = 0;
    size_t rest = shim.in_len - (len + 1);
    memmove(shim.in_buf, nl + 1, rest);
    shim.in_len = rest;
    if (len > 0)
        process_line(line);
    free(line);
    return 1;
}

// Reads whatever is available and processes complete lines. Returns 1 if any
// message was processed. Re-entrant: an outer invocation interrupted inside
// process_line resumes on a buffer the nested one left consistent.
static int read_and_process(void) {
    if (shim.conn_fd == -1)
        return 0;

    int processed = 0;
    while (process_one_buffered_line())
        processed = 1;

    char chunk[65536];
    while (shim.conn_fd != -1) {
        ssize_t n = read(shim.conn_fd, chunk, sizeof(chunk));
        if (n > 0) {
            // After the drain above, in_len only ever holds one partial line.
            if (shim.in_len + (size_t)n > MAX_LINE_SIZE) {
                drop_connection("input line too long");
                return processed;
            }
            if (shim.in_len + n > shim.in_cap) {
                size_t new_cap = (shim.in_len + n) * 2;
                char* grown = realloc(shim.in_buf, new_cap);
                if (!grown) {
                    drop_connection("out of memory growing read buffer");
                    return processed;
                }
                shim.in_buf = grown;
                shim.in_cap = new_cap;
            }
            memcpy(shim.in_buf + shim.in_len, chunk, n);
            shim.in_len += n;
            while (process_one_buffered_line())
                processed = 1;
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
    return processed;
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
    pthread_mutex_lock(&shim.lock);
    supervise_child();
    accept_if_pending();
    drain_pending_rpcs();
    flush_out_buf();
    read_and_process();
    pthread_mutex_unlock(&shim.lock);
}

static void* supervisor_main(void* arg) {
    (void)arg;
    DebugPrint("Supervisor thread running.\n");
    while (shim.supervisor_running) {
        pthread_mutex_lock(&shim.lock);
        supervise_child();
        accept_if_pending();
        flush_out_buf();
        read_and_process(); // safe: RPCs are parked, not executed, off-main
        pthread_mutex_unlock(&shim.lock);
        usleep(250000);
    }
    return NULL;
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
    pthread_mutex_lock(&shim.lock);
    if (!Shim_IsSubscribed(sub_bit)) {
        pthread_mutex_unlock(&shim.lock);
        cJSON_Delete(args);
        return;
    }
    cJSON* msg = make_msg("ev", name, args);
    send_json(msg);
    pthread_mutex_unlock(&shim.lock);
}

hook_result_t Shim_SendHookAndWait(int sub_bit, const char* name, cJSON* args,
                                   char* buf, size_t buf_size) {
    pthread_mutex_lock(&shim.lock);
    // Give a just-(re)connected sidecar a chance before deciding to pass through.
    accept_if_pending();

    if (!Shim_IsSubscribed(sub_bit) || shim.wait_depth >= MAX_WAIT_DEPTH) {
        pthread_mutex_unlock(&shim.lock);
        cJSON_Delete(args);
        return HOOK_PASS;
    }

    unsigned id = ++shim.next_hook_id;
    cJSON* msg = make_msg("hook", name, args);
    cJSON_AddNumberToObject(msg, "id", id);
    send_json(msg);
    if (shim.conn_fd == -1) { // send_json may have dropped the connection
        pthread_mutex_unlock(&shim.lock);
        return HOOK_PASS;
    }

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
        read_and_process(); // read-only RPCs run inline, may complete our wait
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
    pthread_mutex_unlock(&shim.lock);
    return result;
}

/*
 * ================================================================
 *                       init / shutdown
 * ================================================================
*/

void Shim_Initialize(void) {
    const char* env;

    env = getenv("VERGE_SOCKET");
    snprintf(shim.socket_path, sizeof(shim.socket_path), "%s", env ? env : "verge.sock");

    env = getenv("VERGE_BUN");
    if (env)
        snprintf(shim.bun_path, sizeof(shim.bun_path), "%s", env);
    else {
        struct stat st;
        // Prefer the bundled bun binary next to the server, fall back to PATH.
        snprintf(shim.bun_path, sizeof(shim.bun_path), "%s",
                 stat("./bun", &st) == 0 ? "./bun" : "bun");
    }
    // Resolve to an absolute path now: the child may only call execve
    // (no PATH search) between fork and exec.
    if (!strchr(shim.bun_path, '/')) {
        const char* path_env = getenv("PATH");
        char resolved[sizeof(shim.bun_path)] = "";
        size_t name_len = strlen(shim.bun_path);
        while (path_env && *path_env) {
            const char* colon = strchr(path_env, ':');
            size_t len = colon ? (size_t)(colon - path_env) : strlen(path_env);
            if (len + 1 + name_len + 1 <= sizeof(resolved)) {
                memcpy(resolved, path_env, len);
                resolved[len] = '/';
                memcpy(resolved + len + 1, shim.bun_path, name_len + 1);
                if (access(resolved, X_OK) == 0) {
                    memcpy(shim.bun_path, resolved, strlen(resolved) + 1);
                    break;
                }
            }
            resolved[0] = 0;
            path_env = colon ? colon + 1 : NULL;
        }
        if (!resolved[0])
            DebugPrint("Could not find '%s' in PATH; sidecar spawn will fail.\n", shim.bun_path);
    }

    env = getenv("VERGE_ENTRY");
    snprintf(shim.entry_path, sizeof(shim.entry_path), "%s", env ? env : "verge/main.js");

    env = getenv("VERGE_HOOK_TIMEOUT_MS");
    shim.hook_timeout_ms = env ? atoi(env) : 100;
    if (shim.hook_timeout_ms <= 0)
        shim.hook_timeout_ms = 100;

    shim.no_spawn = getenv("VERGE_NO_SPAWN") != NULL;

    env = getenv("VERGE_TRACE");
    if (env) {
        shim.trace = fopen(env, "a");
        if (!shim.trace)
            DebugPrint("Could not open trace file %s: %s\n", env, strerror(errno));
    }

    pthread_mutexattr_t attr;
    pthread_mutexattr_init(&attr);
    pthread_mutexattr_settype(&attr, PTHREAD_MUTEX_RECURSIVE);
    pthread_mutex_init(&shim.lock, &attr);
    shim.main_thread = pthread_self();

    shim.out_buf = malloc(OUT_BUF_SIZE);
    shim.in_cap = 65536;
    shim.in_buf = malloc(shim.in_cap);
    if (!shim.out_buf || !shim.in_buf) {
        DebugPrint("Out of memory allocating IO buffers. Running without sidecar.\n");
        free(shim.out_buf);
        free(shim.in_buf);
        shim.out_buf = NULL;
        shim.in_buf = NULL;
        return;
    }

    // The server's stdout is usually a log file; line-buffer it so shim
    // diagnostics (sidecar exits, respawns, timeouts) appear promptly.
    setvbuf(stdout, NULL, _IOLBF, 0);

    // Don't die on writes to a closed socket.
    signal(SIGPIPE, SIG_IGN);

    // Fork the spawn broker before anything else (threads, sockets): this
    // is the last moment process creation is reliably safe in-process.
    if (!shim.no_spawn)
        start_broker();

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
    memcpy(addr.sun_path, shim.socket_path, strlen(shim.socket_path) + 1);
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
    DebugPrint("verge %s listening on %s (hook timeout %d ms).\n",
               VERGE_VERSION, shim.socket_path, shim.hook_timeout_ms);

    if (shim.no_spawn)
        DebugPrint("VERGE_NO_SPAWN set: start the sidecar manually.\n");
    else
        spawn_sidecar();

    shim.supervisor_running = 1;
    if (pthread_create(&shim.supervisor, NULL, supervisor_main, NULL) != 0) {
        DebugPrint("Failed to start supervisor thread: %s\n", strerror(errno));
        shim.supervisor_running = 0;
    }
}

void Shim_Shutdown(void) {
    if (shim.supervisor_running) {
        shim.supervisor_running = 0;
        pthread_join(shim.supervisor, NULL);
    }
    pthread_mutex_lock(&shim.lock);
    drop_connection("shutdown");
    if (shim.listen_fd != -1) {
        close(shim.listen_fd);
        shim.listen_fd = -1;
    }
    if (shim.broker_fd != -1) {
        // Closing the command channel makes the broker kill the sidecar
        // and exit.
        close(shim.broker_fd);
        shim.broker_fd = -1;
    }
    unlink(shim.socket_path);
    pthread_mutex_unlock(&shim.lock);
}

// Runs at engine process exit. The broker child always leaves via _exit,
// so this never fires there. socket_path is empty iff Shim_Initialize
// never ran (e.g. preloaded into a process that isn't qzeroded).
__attribute__((destructor))
static void shim_atexit(void) {
    if (shim.socket_path[0])
        Shim_Shutdown();
}

/*
 * ================================================================
 *                    frame tick entry point
 * ================================================================
*/

// Called from FrameDispatcher (i.e. every G_RunFrame, engine main thread).
void Shim_FrameEvent(void);
void Shim_FrameEvent(void) {
#ifdef SHIM_DEBUG_TICKS
    static unsigned tick_count;
    if (++tick_count % 400 == 1)
        fprintf(stderr, "[shim] frame tick %u\n", tick_count);
#endif
    Shim_Tick();
    if (shim.frame_every > 0 && Shim_IsSubscribed(SUB_FRAME)) {
        if (++shim.frame_counter >= (unsigned)shim.frame_every) {
            shim.frame_counter = 0;
            Shim_SendEvent(SUB_FRAME, "frame", NULL);
        }
    }
}
