#ifndef _GNU_SOURCE
#define _GNU_SOURCE
#endif

#include <stdlib.h>
#include <stdio.h>
#include <inttypes.h>

#include "quake_common.h"
#include "common.h"

#include "../shim/dispatch.h"

void __cdecl SendServerCommand(void) {
    SV_SendServerCommand(NULL, "%s\n", Cmd_Args());
}

void __cdecl CenterPrint(void) {
    SV_SendServerCommand(NULL, "cp \"%s\"\n", Cmd_Args());
}

void __cdecl RegularPrint(void) {
    SV_SendServerCommand(NULL, "print \"%s\n\"\n", Cmd_Args());
}

void __cdecl Slap(void) {
    int dmg = 0;
    int argc = Cmd_Argc();
    if (argc < 2) {
        Com_Printf("Usage: %s <client_id> [damage]\n", Cmd_Argv(0));
        return;
    }
    int i = atoi(Cmd_Argv(1));
    if (i < 0 || i > sv_maxclients->integer) {
        Com_Printf("client_id must be a number between 0 and %d\n.", sv_maxclients->integer);
        return;
    }
    else if (argc > 2)
        dmg = atoi(Cmd_Argv(2));
    
    if (g_entities[i].inuse && g_entities[i].health > 0) {
        Com_Printf("Slapping...\n");
        if (dmg)
            SV_SendServerCommand(NULL, "print \"%s^7 was slapped for %d damage!\n\"\n", svs->clients[i].name, dmg);
        else
            SV_SendServerCommand(NULL, "print \"%s^7 was slapped!\n\"\n", svs->clients[i].name);
        g_entities[i].client->ps.velocity[0] += RandomFloatWithNegative() * 200.0f;
        g_entities[i].client->ps.velocity[1] += RandomFloatWithNegative() * 200.0f;
        g_entities[i].client->ps.velocity[2] += 300.0f;
        g_entities[i].health -= dmg; // Will be 0 if argument wasn't passed.
        if (g_entities[i].health > 0)
            G_AddEvent(&g_entities[i], EV_PAIN, 99); // 99 health = pain100_1.wav
        else
            G_AddEvent(&g_entities[i], EV_DEATH1, g_entities[i].s.number);
    }
    else
        Com_Printf("The player is currently not active.\n");
}

void __cdecl Slay(void) {
    int argc = Cmd_Argc();
    if (argc < 2) {
        Com_Printf("Usage: %s <client_id>\n", Cmd_Argv(0));
        return;
    }
    int i = atoi(Cmd_Argv(1));
    if (i < 0 || i > sv_maxclients->integer) {
        Com_Printf("client_id must be a number between 0 and %d\n.", sv_maxclients->integer);
        return;
    }
    else if (g_entities[i].inuse && g_entities[i].health > 0) {
        Com_Printf("Slaying player...\n");
        SV_SendServerCommand(NULL, "print \"%s^7 was slain!\n\"\n", svs->clients[i].name);
        DebugPrint("Slaying '%s'!\n", svs->clients[i].name);
		g_entities[i].health = -40;
		G_AddEvent(&g_entities[i], EV_GIB_PLAYER, g_entities[i].s.number);
    }
    else
        Com_Printf("The player is currently not active.\n");
}

// The qlx/qlxrestart console commands live in shim/shim_dispatch.c as
// ShimRcon/ShimCommand/ShimRestart.
