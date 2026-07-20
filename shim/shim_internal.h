#ifndef SHIM_INTERNAL_H
#define SHIM_INTERNAL_H

#include "cJSON.h"
#include "dispatch.h"

// Bit per subscribable event, set from the sidecar's hello message.
enum {
    SUB_CLIENT_COMMAND    = 1 << 0,
    SUB_SERVER_COMMAND    = 1 << 1,
    SUB_FRAME             = 1 << 2,
    SUB_PLAYER_CONNECT    = 1 << 3,
    SUB_PLAYER_LOADED     = 1 << 4,
    SUB_PLAYER_DISCONNECT = 1 << 5,
    SUB_NEW_GAME          = 1 << 6,
    SUB_SET_CONFIGSTRING  = 1 << 7,
    SUB_RCON              = 1 << 8,
    SUB_CONSOLE_PRINT     = 1 << 9,
    SUB_PLAYER_SPAWN      = 1 << 10,
    SUB_KAMIKAZE_USE      = 1 << 11,
    SUB_KAMIKAZE_EXPLODE  = 1 << 12,
    SUB_CUSTOM_COMMAND    = 1 << 13,
};

// Result of a blocking hook round-trip.
typedef enum {
    HOOK_PASS,   // no subscriber, timeout, or explicit null: engine proceeds unchanged
    HOOK_CANCEL, // res was false: cancel the engine action
    HOOK_REPLACE // res was a string: use the replacement value
} hook_result_t;

// shim_ipc.c
int Shim_IsConnected(void);
int Shim_IsSubscribed(int sub_bit);
void Shim_Tick(void); // supervision + accept + drain; called every frame and before waits
void Shim_SendEvent(int sub_bit, const char* name, cJSON* args); // takes ownership of args
// Takes ownership of args. On HOOK_REPLACE, the replacement is copied into buf.
hook_result_t Shim_SendHookAndWait(int sub_bit, const char* name, cJSON* args,
                                   char* buf, size_t buf_size);

// shim_rpc.c — executes one engine RPC; returns the JSON value to send back
// (never NULL on success). On failure returns NULL and sets *err to a static
// or cJSON-lifetime error string.
cJSON* Shim_ExecuteRpc(const char* fn, const cJSON* args, const char** err);
// 1 if the RPC has no engine side effects (safe to run inside a hook wait).
int Shim_RpcIsReadOnly(const char* fn);

#endif /* SHIM_INTERNAL_H */
