#define _GNU_SOURCE

#include <string.h>

#include "shim_internal.h"
#include "../core/common.h"
#include "../core/quake_common.h"

int allow_free_client = -1;

// Args helpers. Strings from the engine may contain invalid UTF-8; cJSON
// passes bytes through, and the sidecar treats them lossily on decode.
static cJSON* args_is(int i, const char* s) {
    cJSON* args = cJSON_CreateArray();
    cJSON_AddItemToArray(args, cJSON_CreateNumber(i));
    cJSON_AddItemToArray(args, cJSON_CreateString(s ? s : ""));
    return args;
}

static cJSON* args_i(int i) {
    cJSON* args = cJSON_CreateArray();
    cJSON_AddItemToArray(args, cJSON_CreateNumber(i));
    return args;
}

char* ClientCommandDispatcher(int client_id, char* cmd) {
    static char buf[4096];
    switch (Shim_SendHookAndWait(SUB_CLIENT_COMMAND, "client_command",
                                 args_is(client_id, cmd), buf, sizeof(buf))) {
        case HOOK_CANCEL:  return NULL;
        case HOOK_REPLACE: return buf;
        default:           return cmd;
    }
}

char* ServerCommandDispatcher(int client_id, char* cmd) {
    static char buf[4096];
    switch (Shim_SendHookAndWait(SUB_SERVER_COMMAND, "server_command",
                                 args_is(client_id, cmd), buf, sizeof(buf))) {
        case HOOK_CANCEL:  return NULL;
        case HOOK_REPLACE: return buf;
        default:           return cmd;
    }
}

void FrameDispatcher(void) {
    void Shim_FrameEvent(void);
    Shim_FrameEvent();
}

char* ClientConnectDispatcher(int client_id, int is_bot) {
    static char buf[4096];
    cJSON* args = cJSON_CreateArray();
    cJSON_AddItemToArray(args, cJSON_CreateNumber(client_id));
    cJSON_AddItemToArray(args, cJSON_CreateBool(is_bot));

    allow_free_client = client_id;
    hook_result_t res = Shim_SendHookAndWait(SUB_PLAYER_CONNECT, "player_connect",
                                             args, buf, sizeof(buf));
    allow_free_client = -1;

    switch (res) {
        case HOOK_CANCEL:  return "You are banned from this server.";
        case HOOK_REPLACE: return buf;
        default:           return NULL; // NULL = let the client in
    }
}

int ClientLoadedDispatcher(int client_id) {
    Shim_SendEvent(SUB_PLAYER_LOADED, "player_loaded", args_i(client_id));
    return 1; // return value is ignored at the call site
}

void ClientDisconnectDispatcher(int client_id, const char* reason) {
    // Unlike the synchronous Python handler, the sidecar processes this after
    // the slot may already be CS_FREE; the runtime caches player identities.
    Shim_SendEvent(SUB_PLAYER_DISCONNECT, "player_disconnect", args_is(client_id, reason));
}

void NewGameDispatcher(int restart) {
    cJSON* args = cJSON_CreateArray();
    cJSON_AddItemToArray(args, cJSON_CreateBool(restart));
    Shim_SendEvent(SUB_NEW_GAME, "new_game", args);
}

char* SetConfigstringDispatcher(int index, char* value) {
    static char buf[4096];
    switch (Shim_SendHookAndWait(SUB_SET_CONFIGSTRING, "set_configstring",
                                 args_is(index, value), buf, sizeof(buf))) {
        case HOOK_CANCEL:  return NULL;
        case HOOK_REPLACE: return buf;
        default:           return value;
    }
}

void RconDispatcher(const char* cmd) {
    cJSON* args = cJSON_CreateArray();
    cJSON_AddItemToArray(args, cJSON_CreateString(cmd ? cmd : ""));
    Shim_SendEvent(SUB_RCON, "rcon", args);
}

char* ConsolePrintDispatcher(char* text) {
    static char buf[4096];
    // Blocking, but only when explicitly subscribed (off by default: this is
    // called for every single console line).
    switch (Shim_SendHookAndWait(SUB_CONSOLE_PRINT, "console_print",
                                 args_is(-1, text), buf, sizeof(buf))) {
        case HOOK_CANCEL:  return NULL;
        case HOOK_REPLACE: return buf; // note: My_Com_Printf ignores replacements
        default:           return text;
    }
}

void ClientSpawnDispatcher(int client_id) {
    Shim_SendEvent(SUB_PLAYER_SPAWN, "player_spawn", args_i(client_id));
}

void KamikazeUseDispatcher(int client_id) {
    Shim_SendEvent(SUB_KAMIKAZE_USE, "kamikaze_use", args_i(client_id));
}

void KamikazeExplodeDispatcher(int client_id, int is_used_on_demand) {
    cJSON* args = cJSON_CreateArray();
    cJSON_AddItemToArray(args, cJSON_CreateNumber(client_id));
    cJSON_AddItemToArray(args, cJSON_CreateBool(is_used_on_demand));
    Shim_SendEvent(SUB_KAMIKAZE_EXPLODE, "kamikaze_explode", args);
}

/*
 * ================================================================
 *                     console commands
 * ================================================================
*/

void __cdecl ShimRcon(void) {
    RconDispatcher(Cmd_Args());
}

void __cdecl ShimCommand(void) {
    if (!Shim_IsSubscribed(SUB_CUSTOM_COMMAND)) {
        Com_Printf("The command could not be handled: sidecar not connected.\n");
        return;
    }
    cJSON* args = cJSON_CreateArray();
    cJSON_AddItemToArray(args, cJSON_CreateString(Cmd_Argv(0)));
    cJSON_AddItemToArray(args, cJSON_CreateString(Cmd_Args()));
    Shim_SendEvent(SUB_CUSTOM_COMMAND, "custom_command", args);
}

void __cdecl ShimRestart(void) {
    Shim_RestartSidecar();
}
