#ifndef SHIM_DISPATCH_H
#define SHIM_DISPATCH_H

#include "../core/common.h"

// Starts the IPC listener and spawns the sidecar. Never fatal: on failure the
// server simply runs as vanilla QLDS and the shim keeps retrying via respawn.
void Shim_Initialize(void);
void Shim_Shutdown(void);
void Shim_RestartSidecar(void);

// Console command handlers registered by InitializeStatic().
void __cdecl ShimRcon(void);    // "verge" — forwards to the rcon event.
void __cdecl ShimCommand(void); // handler for commands added via add_console_command.
void __cdecl ShimRestart(void); // "vergerestart" — restarts the sidecar.

// Lets player-info RPCs read a client slot that is still CS_FREE while
// we're inside the connect hook for that client.
extern int allow_free_client;

/* Dispatchers called from the engine hooks (all on the engine main thread).
 * Return contract matches the original Python dispatchers:
 * NULL = cancel the engine action, string = replacement value, or the
 * original pointer passed through. */
char* ClientCommandDispatcher(int client_id, char* cmd);
char* ServerCommandDispatcher(int client_id, char* cmd);
void FrameDispatcher(void);
char* ClientConnectDispatcher(int client_id, int is_bot);
int ClientLoadedDispatcher(int client_id);
void ClientDisconnectDispatcher(int client_id, const char* reason);
void NewGameDispatcher(int restart);
char* SetConfigstringDispatcher(int index, char* value);
void RconDispatcher(const char* cmd);
char* ConsolePrintDispatcher(char* text);
void ClientSpawnDispatcher(int client_id);
void KamikazeUseDispatcher(int client_id);
void KamikazeExplodeDispatcher(int client_id, int is_used_on_demand);

#endif /* SHIM_DISPATCH_H */
