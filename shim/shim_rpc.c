#define _GNU_SOURCE

#include <stdio.h>
#include <string.h>
#include <math.h>

#include "shim_internal.h"
#include "../core/common.h"
#include "../core/quake_common.h"

// Engine call bodies transliterated from python_embed.c. Field-by-field
// behavior (validation ranges, special cases, return values) is kept
// identical to the Python module unless noted.

#define NUM_WEAPONS_SEQ  15 // g, mg, sg, gl, rl, lg, rg, pg, bfg, gh, ng, pl, cg, hmg, hands
#define NUM_POWERUPS_SEQ 6  // quad, battlesuit, haste, invisibility, regeneration, invulnerability

static char err_buf[256];

static const char* errf(const char* fmt, int a, int b) {
    snprintf(err_buf, sizeof(err_buf), fmt, a, b);
    return err_buf;
}

static int arg_int(const cJSON* args, int i, int* out) {
    const cJSON* v = cJSON_GetArrayItem((cJSON*)args, i);
    if (!cJSON_IsNumber(v))
        return 0;
    *out = (int)v->valuedouble;
    return 1;
}

static int arg_bool(const cJSON* args, int i, int* out) {
    const cJSON* v = cJSON_GetArrayItem((cJSON*)args, i);
    if (!cJSON_IsBool(v))
        return 0;
    *out = cJSON_IsTrue(v);
    return 1;
}

static const char* arg_str(const cJSON* args, int i) {
    return cJSON_GetStringValue(cJSON_GetArrayItem((cJSON*)args, i));
}

// Validates a client_id argument at args[idx]. Returns 0 and sets *err on
// invalid input. check_client: also require the entity to have a client
// struct, putting false into *fallback for the caller to return.
static int get_client_id(const cJSON* args, int idx, int* out, const char** err) {
    if (!arg_int(args, idx, out)) {
        *err = "client_id must be a number";
        return 0;
    }
    if (*out < 0 || *out >= sv_maxclients->integer) {
        *err = errf("client_id needs to be a number from 0 to %d.", sv_maxclients->integer, 0);
        return 0;
    }
    return 1;
}

/*
 * ================================================================
 *                    player info / state / stats
 * ================================================================
*/

static cJSON* make_player_info(int client_id) {
    cJSON* info = cJSON_CreateObject();
    cJSON_AddNumberToObject(info, "clientId", client_id);

    if (g_entities[client_id].client != NULL) {
        if (g_entities[client_id].client->pers.connected == CON_DISCONNECTED) {
            cJSON_AddStringToObject(info, "name", "");
            cJSON_AddNumberToObject(info, "team", TEAM_SPECTATOR);
        }
        else {
            cJSON_AddStringToObject(info, "name", g_entities[client_id].client->pers.netname);
            cJSON_AddNumberToObject(info, "team", g_entities[client_id].client->sess.sessionTeam);
        }
        cJSON_AddNumberToObject(info, "privileges", g_entities[client_id].client->sess.privileges);
    }
    else {
        cJSON_AddStringToObject(info, "name", "");
        cJSON_AddNumberToObject(info, "team", TEAM_SPECTATOR);
        cJSON_AddNumberToObject(info, "privileges", -1);
    }

    cJSON_AddNumberToObject(info, "connectionState", svs->clients[client_id].state);
    cJSON_AddStringToObject(info, "userinfo", svs->clients[client_id].userinfo);

    // SteamID64 exceeds double/JS-number precision: always a string on the wire.
    char steam_id[32];
    snprintf(steam_id, sizeof(steam_id), "%lld", (long long)svs->clients[client_id].steam_id);
    cJSON_AddStringToObject(info, "steamId", steam_id);

    return info;
}

static cJSON* rpc_player_info(const cJSON* args, const char** err) {
    int i;
    if (!get_client_id(args, 0, &i, err))
        return NULL;
    if (allow_free_client != i && svs->clients[i].state == CS_FREE)
        return cJSON_CreateNull();
    return make_player_info(i);
}

static cJSON* rpc_players_info(const cJSON* args, const char** err) {
    cJSON* ret = cJSON_CreateArray();
    for (int i = 0; i < sv_maxclients->integer; i++) {
        if (svs->clients[i].state == CS_FREE)
            cJSON_AddItemToArray(ret, cJSON_CreateNull());
        else
            cJSON_AddItemToArray(ret, make_player_info(i));
    }
    return ret;
}

static cJSON* rpc_get_userinfo(const cJSON* args, const char** err) {
    int i;
    if (!get_client_id(args, 0, &i, err))
        return NULL;
    if (allow_free_client != i && svs->clients[i].state == CS_FREE)
        return cJSON_CreateNull();
    return cJSON_CreateString(svs->clients[i].userinfo);
}

static cJSON* rpc_player_state(const cJSON* args, const char** err) {
    int i;
    if (!get_client_id(args, 0, &i, err))
        return NULL;
    if (!g_entities[i].client)
        return cJSON_CreateNull();

    playerState_t* ps = &g_entities[i].client->ps;
    cJSON* state = cJSON_CreateObject();
    cJSON_AddBoolToObject(state, "isAlive", ps->pm_type == 0);

    double pos[3] = { ps->origin[0], ps->origin[1], ps->origin[2] };
    double vel[3] = { ps->velocity[0], ps->velocity[1], ps->velocity[2] };
    cJSON_AddItemToObject(state, "position", cJSON_CreateDoubleArray(pos, 3));
    cJSON_AddItemToObject(state, "velocity", cJSON_CreateDoubleArray(vel, 3));

    cJSON_AddNumberToObject(state, "health", g_entities[i].health);
    cJSON_AddNumberToObject(state, "armor", ps->stats[STAT_ARMOR]);
    cJSON_AddBoolToObject(state, "noclip", g_entities[i].client->noclip);
    cJSON_AddNumberToObject(state, "weapon", ps->weapon);

    cJSON* weapons = cJSON_CreateArray();
    cJSON* ammo = cJSON_CreateArray();
    for (int w = 0; w < NUM_WEAPONS_SEQ; w++) {
        cJSON_AddItemToArray(weapons, cJSON_CreateBool(ps->stats[STAT_WEAPONS] & (1 << (w + 1))));
        cJSON_AddItemToArray(ammo, cJSON_CreateNumber(ps->ammo[w + 1]));
    }
    cJSON_AddItemToObject(state, "weapons", weapons);
    cJSON_AddItemToObject(state, "ammo", ammo);

    cJSON* powerups = cJSON_CreateArray();
    for (int p = 0; p < NUM_POWERUPS_SEQ; p++) {
        int index = p + PW_QUAD;
        if (index == PW_FLIGHT) // flight is not a real powerup; report invuln instead
            index = PW_INVULNERABILITY;
        int remaining = ps->powerups[index];
        if (remaining) // remaining time, not absolute expiry time
            remaining -= level->time;
        cJSON_AddItemToArray(powerups, cJSON_CreateNumber(remaining));
    }
    cJSON_AddItemToObject(state, "powerups", powerups);

    switch (ps->stats[STAT_HOLDABLE_ITEM]) {
        case 0:  cJSON_AddItemToObject(state, "holdable", cJSON_CreateNull()); break;
        case 27: cJSON_AddStringToObject(state, "holdable", "teleporter"); break;
        case 28: cJSON_AddStringToObject(state, "holdable", "medkit"); break;
        case 34: cJSON_AddStringToObject(state, "holdable", "flight"); break;
        case 37: cJSON_AddStringToObject(state, "holdable", "kamikaze"); break;
        case 38: cJSON_AddStringToObject(state, "holdable", "portal"); break;
        case 39: cJSON_AddStringToObject(state, "holdable", "invulnerability"); break;
        default: cJSON_AddStringToObject(state, "holdable", "unknown");
    }

    int flight[4] = {
        ps->stats[STAT_CUR_FLIGHT_FUEL], ps->stats[STAT_MAX_FLIGHT_FUEL],
        ps->stats[STAT_FLIGHT_THRUST], ps->stats[STAT_FLIGHT_REFUEL],
    };
    cJSON_AddItemToObject(state, "flight", cJSON_CreateIntArray(flight, 4));

    cJSON_AddBoolToObject(state, "isFrozen", ps->pm_type == 4);
    return state;
}

static cJSON* rpc_player_stats(const cJSON* args, const char** err) {
    int i;
    if (!get_client_id(args, 0, &i, err))
        return NULL;
    if (!g_entities[i].client)
        return cJSON_CreateNull();

    cJSON* stats = cJSON_CreateObject();
    int score = g_entities[i].client->sess.sessionTeam == TEAM_SPECTATOR ?
        0 : g_entities[i].client->ps.persistant[PERS_ROUND_SCORE];
    cJSON_AddNumberToObject(stats, "score", score);
    cJSON_AddNumberToObject(stats, "kills", g_entities[i].client->expandedStats.numKills);
    cJSON_AddNumberToObject(stats, "deaths", g_entities[i].client->expandedStats.numDeaths);
    cJSON_AddNumberToObject(stats, "damageDealt", g_entities[i].client->expandedStats.totalDamageDealt);
    cJSON_AddNumberToObject(stats, "damageTaken", g_entities[i].client->expandedStats.totalDamageTaken);
    cJSON_AddNumberToObject(stats, "time", level->time - g_entities[i].client->pers.enterTime);
    cJSON_AddNumberToObject(stats, "ping", g_entities[i].client->ps.ping);
    return stats;
}

/*
 * ================================================================
 *                    commands / console / cvars
 * ================================================================
*/

static cJSON* rpc_send_server_command(const cJSON* args, const char** err) {
    const cJSON* client_id = cJSON_GetArrayItem((cJSON*)args, 0);
    const char* cmd = arg_str(args, 1);
    if (!cmd) {
        *err = "command must be a string";
        return NULL;
    }

    if (cJSON_IsNull(client_id)) {
        My_SV_SendServerCommand(NULL, "%s\n", cmd); // send to all
        return cJSON_CreateBool(1);
    }
    if (cJSON_IsNumber(client_id)) {
        int i = (int)client_id->valuedouble;
        if (i >= 0 && i < sv_maxclients->integer) {
            if (svs->clients[i].state != CS_ACTIVE)
                return cJSON_CreateBool(0);
            My_SV_SendServerCommand(&svs->clients[i], "%s\n", cmd);
            return cJSON_CreateBool(1);
        }
    }
    *err = errf("client_id needs to be a number from 0 to %d, or null.", sv_maxclients->integer, 0);
    return NULL;
}

static cJSON* rpc_client_command(const cJSON* args, const char** err) {
    int i;
    const char* cmd = arg_str(args, 1);
    if (!get_client_id(args, 0, &i, err))
        return NULL;
    if (!cmd) {
        *err = "command must be a string";
        return NULL;
    }
    if (svs->clients[i].state == CS_FREE || svs->clients[i].state == CS_ZOMBIE)
        return cJSON_CreateBool(0);
    My_SV_ExecuteClientCommand(&svs->clients[i], (char*)cmd, qtrue);
    return cJSON_CreateBool(1);
}

static cJSON* rpc_console_command(const cJSON* args, const char** err) {
    const char* cmd = arg_str(args, 0);
    if (!cmd) {
        *err = "command must be a string";
        return NULL;
    }
    Cmd_ExecuteString((char*)cmd);
    return cJSON_CreateNull();
}

static cJSON* rpc_get_cvar(const cJSON* args, const char** err) {
    const char* name = arg_str(args, 0);
    if (!name) {
        *err = "cvar name must be a string";
        return NULL;
    }
    cvar_t* cvar = Cvar_FindVar((char*)name);
    return cvar ? cJSON_CreateString(cvar->string) : cJSON_CreateNull();
}

static cJSON* rpc_set_cvar(const cJSON* args, const char** err) {
    const char* name = arg_str(args, 0);
    const char* value = arg_str(args, 1);
    int flags = 0;
    arg_int(args, 2, &flags); // optional
    if (!name || !value) {
        *err = "cvar name and value must be strings";
        return NULL;
    }

    cvar_t* var = Cvar_FindVar((char*)name);
    if (!var) {
        Cvar_Get((char*)name, (char*)value, flags);
        return cJSON_CreateBool(1);
    }
    Cvar_Set2((char*)name, (char*)value, flags == -1 ? qtrue : qfalse);
    return cJSON_CreateBool(0);
}

static cJSON* rpc_set_cvar_limit(const cJSON* args, const char** err) {
    const char* name = arg_str(args, 0);
    const char* value = arg_str(args, 1);
    const char* min = arg_str(args, 2);
    const char* max = arg_str(args, 3);
    int flags = 0;
    arg_int(args, 4, &flags); // optional
    if (!name || !value || !min || !max) {
        *err = "set_cvar_limit takes (name, value, min, max[, flags]) as strings";
        return NULL;
    }
    Cvar_GetLimit((char*)name, (char*)value, (char*)min, (char*)max, flags);
    return cJSON_CreateNull();
}

static cJSON* rpc_console_print(const cJSON* args, const char** err) {
    const char* text = arg_str(args, 0);
    if (!text) {
        *err = "text must be a string";
        return NULL;
    }
    My_Com_Printf("%s\n", text);
    return cJSON_CreateNull();
}

static cJSON* rpc_add_console_command(const cJSON* args, const char** err) {
    const char* cmd = arg_str(args, 0);
    if (!cmd) {
        *err = "command name must be a string";
        return NULL;
    }
    Cmd_AddCommand((char*)cmd, ShimCommand);
    return cJSON_CreateNull();
}

/*
 * ================================================================
 *                        configstrings
 * ================================================================
*/

static cJSON* rpc_get_configstring(const cJSON* args, const char** err) {
    int i;
    char csbuffer[4096];
    if (!arg_int(args, 0, &i) || i < 0 || i > MAX_CONFIGSTRINGS) {
        *err = errf("index needs to be a number from 0 to %d.", MAX_CONFIGSTRINGS, 0);
        return NULL;
    }
    SV_GetConfigstring(i, csbuffer, sizeof(csbuffer));
    return cJSON_CreateString(csbuffer);
}

static cJSON* rpc_set_configstring(const cJSON* args, const char** err) {
    int i;
    const char* cs = arg_str(args, 1);
    if (!arg_int(args, 0, &i) || i < 0 || i > MAX_CONFIGSTRINGS) {
        *err = errf("index needs to be a number from 0 to %d.", MAX_CONFIGSTRINGS, 0);
        return NULL;
    }
    if (!cs) {
        *err = "configstring must be a string";
        return NULL;
    }
    My_SV_SetConfigstring(i, (char*)cs);
    return cJSON_CreateNull();
}

/*
 * ================================================================
 *                    moderation / votes
 * ================================================================
*/

static cJSON* rpc_kick(const cJSON* args, const char** err) {
    int i;
    if (!get_client_id(args, 0, &i, err))
        return NULL;
    if (svs->clients[i].state != CS_ACTIVE) {
        *err = "client_id must be the ID of an active player.";
        return NULL;
    }
    const char* reason = arg_str(args, 1);
    if (!reason || !reason[0])
        reason = "was kicked.";
    My_SV_DropClient(&svs->clients[i], reason);
    return cJSON_CreateNull();
}

static cJSON* rpc_force_vote(const cJSON* args, const char** err) {
    int pass;
    if (!arg_bool(args, 0, &pass)) {
        *err = "pass must be a boolean";
        return NULL;
    }
    if (!level->voteTime)
        return cJSON_CreateBool(0); // no active vote
    if (pass) {
        // Tell the server every client voted yes: passes on the next frame.
        for (int i = 0; i < sv_maxclients->integer; i++) {
            if (svs->clients[i].state == CS_ACTIVE)
                g_entities[i].client->pers.voteState = VOTE_YES;
        }
    }
    else
        level->voteTime -= 30000; // vote is "over": fails right away
    return cJSON_CreateBool(1);
}

static cJSON* rpc_callvote(const cJSON* args, const char** err) {
    const char* vote = arg_str(args, 0);
    const char* vote_disp = arg_str(args, 1);
    int vote_time = 30;
    arg_int(args, 2, &vote_time); // optional
    if (!vote || !vote_disp) {
        *err = "callvote takes (vote, display_string[, time])";
        return NULL;
    }
    char buf[64];
    strncpy(level->voteString, vote, sizeof(level->voteString) - 1);
    level->voteString[sizeof(level->voteString) - 1] = 0;
    strncpy(level->voteDisplayString, vote_disp, sizeof(level->voteDisplayString) - 1);
    level->voteDisplayString[sizeof(level->voteDisplayString) - 1] = 0;
    level->voteTime = (level->time - 30000) + vote_time * 1000;
    level->voteYes = 0;
    level->voteNo = 0;
    for (int i = 0; i < sv_maxclients->integer; i++)
        if (g_entities[i].client)
            g_entities[i].client->pers.voteState = VOTE_PENDING;
    My_SV_SetConfigstring(CS_VOTE_STRING, level->voteDisplayString);
    snprintf(buf, sizeof(buf), "%d", level->voteTime);
    My_SV_SetConfigstring(CS_VOTE_TIME, buf);
    My_SV_SetConfigstring(CS_VOTE_YES, "0");
    My_SV_SetConfigstring(CS_VOTE_NO, "0");
    return cJSON_CreateNull();
}

static cJSON* rpc_set_privileges(const cJSON* args, const char** err) {
    int i, priv;
    if (!get_client_id(args, 0, &i, err))
        return NULL;
    if (!arg_int(args, 1, &priv)) {
        *err = "privileges must be a number";
        return NULL;
    }
    if (!g_entities[i].client)
        return cJSON_CreateBool(0);
    g_entities[i].client->sess.privileges = priv;
    return cJSON_CreateBool(1);
}

static cJSON* rpc_allow_single_player(const cJSON* args, const char** err) {
    int x;
    if (!arg_bool(args, 0, &x)) {
        *err = "argument must be a boolean";
        return NULL;
    }
    level->mapIsTrainingMap = x ? qtrue : qfalse;
    return cJSON_CreateNull();
}

static cJSON* rpc_player_spawn(const cJSON* args, const char** err) {
    int i;
    if (!get_client_id(args, 0, &i, err))
        return NULL;
    if (!g_entities[i].client)
        return cJSON_CreateBool(0);
    g_entities[i].client->ps.pm_type = PM_NORMAL;
    My_ClientSpawn(&g_entities[i]);
    return cJSON_CreateBool(1);
}

static cJSON* rpc_slay_with_mod(const cJSON* args, const char** err) {
    int i, mod;
    if (!get_client_id(args, 0, &i, err))
        return NULL;
    if (!arg_int(args, 1, &mod)) {
        *err = "means of death must be a number";
        return NULL;
    }
    if (!g_entities[i].client)
        return cJSON_CreateBool(0);
    if (g_entities[i].health <= 0)
        return cJSON_CreateBool(1);

    gentity_t* ent = &g_entities[i];
    int damage = g_entities[i].health + (mod == MOD_KAMIKAZE ? 100000 : 0);
    g_entities[i].client->ps.stats[STAT_ARMOR] = 0;
    // self damage = half damage, so multiplying by 2
    G_Damage(ent, ent, ent, NULL, NULL, damage * 2, DAMAGE_NO_PROTECTION, mod);
    return cJSON_CreateBool(1);
}

/*
 * ================================================================
 *                  player physics / state mutation
 * ================================================================
*/

// Common pattern: (client_id, ...) mutation that returns false when the
// entity has no client struct.
#define REQUIRE_CLIENT(args, i, err) \
    do { \
        if (!get_client_id(args, 0, &(i), err)) return NULL; \
        if (!g_entities[i].client) return cJSON_CreateBool(0); \
    } while (0)

static int get_vec3(const cJSON* args, int idx, float out[3]) {
    const cJSON* v = cJSON_GetArrayItem((cJSON*)args, idx);
    if (!cJSON_IsArray(v) || cJSON_GetArraySize((cJSON*)v) != 3)
        return 0;
    for (int i = 0; i < 3; i++) {
        const cJSON* n = cJSON_GetArrayItem((cJSON*)v, i);
        if (!cJSON_IsNumber(n))
            return 0;
        out[i] = (float)n->valuedouble;
    }
    return 1;
}

static cJSON* rpc_set_position(const cJSON* args, const char** err) {
    int i;
    float pos[3];
    REQUIRE_CLIENT(args, i, err);
    if (!get_vec3(args, 1, pos)) {
        *err = "position must be an array of 3 numbers";
        return NULL;
    }
    for (int k = 0; k < 3; k++)
        g_entities[i].client->ps.origin[k] = pos[k];
    return cJSON_CreateBool(1);
}

static cJSON* rpc_set_velocity(const cJSON* args, const char** err) {
    int i;
    float vel[3];
    REQUIRE_CLIENT(args, i, err);
    if (!get_vec3(args, 1, vel)) {
        *err = "velocity must be an array of 3 numbers";
        return NULL;
    }
    for (int k = 0; k < 3; k++)
        g_entities[i].client->ps.velocity[k] = vel[k];
    return cJSON_CreateBool(1);
}

static cJSON* rpc_noclip(const cJSON* args, const char** err) {
    int i, activate;
    REQUIRE_CLIENT(args, i, err);
    if (!arg_bool(args, 1, &activate)) {
        *err = "activate must be a boolean";
        return NULL;
    }
    if ((activate && g_entities[i].client->noclip) ||
            (!activate && !g_entities[i].client->noclip))
        return cJSON_CreateBool(0); // no change
    g_entities[i].client->noclip = activate ? qtrue : qfalse;
    return cJSON_CreateBool(1);
}

static cJSON* rpc_set_health(const cJSON* args, const char** err) {
    int i, health;
    REQUIRE_CLIENT(args, i, err);
    if (!arg_int(args, 1, &health)) {
        *err = "health must be a number";
        return NULL;
    }
    g_entities[i].health = health;
    return cJSON_CreateBool(1);
}

static cJSON* rpc_set_armor(const cJSON* args, const char** err) {
    int i, armor;
    REQUIRE_CLIENT(args, i, err);
    if (!arg_int(args, 1, &armor)) {
        *err = "armor must be a number";
        return NULL;
    }
    g_entities[i].client->ps.stats[STAT_ARMOR] = armor;
    return cJSON_CreateBool(1);
}

static cJSON* rpc_set_weapons(const cJSON* args, const char** err) {
    int i, flags = 0;
    REQUIRE_CLIENT(args, i, err);
    const cJSON* weapons = cJSON_GetArrayItem((cJSON*)args, 1);
    if (!cJSON_IsArray(weapons) || cJSON_GetArraySize((cJSON*)weapons) != NUM_WEAPONS_SEQ) {
        *err = errf("weapons must be an array of %d booleans", NUM_WEAPONS_SEQ, 0);
        return NULL;
    }
    for (int w = 0; w < NUM_WEAPONS_SEQ; w++) {
        const cJSON* v = cJSON_GetArrayItem((cJSON*)weapons, w);
        if (!cJSON_IsBool(v)) {
            *err = errf("weapons[%d] is not a boolean", w, 0);
            return NULL;
        }
        flags |= cJSON_IsTrue(v) ? (1 << (w + 1)) : 0;
    }
    g_entities[i].client->ps.stats[STAT_WEAPONS] = flags;
    return cJSON_CreateBool(1);
}

static cJSON* rpc_set_weapon(const cJSON* args, const char** err) {
    int i, weapon;
    REQUIRE_CLIENT(args, i, err);
    if (!arg_int(args, 1, &weapon) || weapon < 0 || weapon >= MAX_WEAPONS) {
        *err = "weapon must be a number from 0 to 15.";
        return NULL;
    }
    g_entities[i].client->ps.weapon = weapon;
    return cJSON_CreateBool(1);
}

static cJSON* rpc_set_ammo(const cJSON* args, const char** err) {
    int i;
    REQUIRE_CLIENT(args, i, err);
    const cJSON* ammos = cJSON_GetArrayItem((cJSON*)args, 1);
    if (!cJSON_IsArray(ammos) || cJSON_GetArraySize((cJSON*)ammos) != NUM_WEAPONS_SEQ) {
        *err = errf("ammo must be an array of %d integers", NUM_WEAPONS_SEQ, 0);
        return NULL;
    }
    for (int w = 0; w < NUM_WEAPONS_SEQ; w++) {
        const cJSON* v = cJSON_GetArrayItem((cJSON*)ammos, w);
        if (!cJSON_IsNumber(v)) {
            *err = errf("ammo[%d] is not an integer", w, 0);
            return NULL;
        }
        g_entities[i].client->ps.ammo[w + 1] = (int)v->valuedouble;
    }
    return cJSON_CreateBool(1);
}

static cJSON* rpc_set_powerups(const cJSON* args, const char** err) {
    int i;
    REQUIRE_CLIENT(args, i, err);
    const cJSON* powerups = cJSON_GetArrayItem((cJSON*)args, 1);
    if (!cJSON_IsArray(powerups) || cJSON_GetArraySize((cJSON*)powerups) != NUM_POWERUPS_SEQ) {
        *err = errf("powerups must be an array of %d integers", NUM_POWERUPS_SEQ, 0);
        return NULL;
    }
    for (int p = 0; p < NUM_POWERUPS_SEQ; p++) {
        const cJSON* v = cJSON_GetArrayItem((cJSON*)powerups, p);
        if (!cJSON_IsNumber(v)) {
            *err = errf("powerups[%d] is not an integer", p, 0);
            return NULL;
        }
        // Slot 5 would be flight, which isn't a real powerup: write
        // invulnerability instead (mirrors python_embed.c).
        int slot = p;
        if (slot + PW_QUAD == PW_FLIGHT)
            slot = PW_INVULNERABILITY - PW_QUAD;
        int t = (int)v->valuedouble;
        g_entities[i].client->ps.powerups[slot + PW_QUAD] =
            t ? level->time - (level->time % 1000) + t : 0;
    }
    return cJSON_CreateBool(1);
}

static cJSON* rpc_set_holdable(const cJSON* args, const char** err) {
    int i, item;
    REQUIRE_CLIENT(args, i, err);
    if (!arg_int(args, 1, &item)) {
        *err = "holdable must be a number";
        return NULL;
    }
    if (item == 37) // kamikaze
        g_entities[i].client->ps.eFlags |= EF_KAMIKAZE;
    else
        g_entities[i].client->ps.eFlags &= ~EF_KAMIKAZE;
    g_entities[i].client->ps.stats[STAT_HOLDABLE_ITEM] = item;
    return cJSON_CreateBool(1);
}

static void __cdecl Switch_Touch_Item(gentity_t* ent) {
    ent->touch = (void*)Touch_Item;
    ent->think = G_FreeEntity;
    ent->nextthink = level->time + 29000;
}

static void __cdecl My_Touch_Item(gentity_t* ent, gentity_t* other, trace_t* trace) {
    if (ent->parent == other)
        return;
    Touch_Item(ent, other, trace);
}

static cJSON* rpc_drop_holdable(const cJSON* args, const char** err) {
    int i;
    vec3_t velocity;
    REQUIRE_CLIENT(args, i, err);

    // removing kamikaze flag (surrounding skulls)
    g_entities[i].client->ps.eFlags &= ~EF_KAMIKAZE;

    int item = g_entities[i].client->ps.stats[STAT_HOLDABLE_ITEM];
    if (item == 0)
        return cJSON_CreateBool(0);

    vec_t angle = g_entities[i].s.apos.trBase[1] * (M_PI * 2 / 360);
    velocity[0] = 150 * cos(angle);
    velocity[1] = 150 * sin(angle);
    velocity[2] = 250;

    gentity_t* entity = LaunchItem(bg_itemlist + item, g_entities[i].s.pos.trBase, velocity);
    entity->touch = (void*)My_Touch_Item;
    entity->parent = &g_entities[i];
    entity->think = Switch_Touch_Item;
    entity->nextthink = level->time + 1000;
    entity->s.pos.trTime = level->time - 500;

    g_entities[i].client->ps.stats[STAT_HOLDABLE_ITEM] = 0;
    return cJSON_CreateBool(1);
}

static cJSON* rpc_set_flight(const cJSON* args, const char** err) {
    int i;
    REQUIRE_CLIENT(args, i, err);
    const cJSON* flight = cJSON_GetArrayItem((cJSON*)args, 1);
    if (!cJSON_IsArray(flight) || cJSON_GetArraySize((cJSON*)flight) != 4) {
        *err = "flight must be an array of 4 integers (fuel, maxFuel, thrust, refuel)";
        return NULL;
    }
    int vals[4];
    for (int k = 0; k < 4; k++) {
        const cJSON* v = cJSON_GetArrayItem((cJSON*)flight, k);
        if (!cJSON_IsNumber(v)) {
            *err = errf("flight[%d] is not an integer", k, 0);
            return NULL;
        }
        vals[k] = (int)v->valuedouble;
    }
    g_entities[i].client->ps.stats[STAT_CUR_FLIGHT_FUEL] = vals[0];
    g_entities[i].client->ps.stats[STAT_MAX_FLIGHT_FUEL] = vals[1];
    g_entities[i].client->ps.stats[STAT_FLIGHT_THRUST] = vals[2];
    g_entities[i].client->ps.stats[STAT_FLIGHT_REFUEL] = vals[3];
    return cJSON_CreateBool(1);
}

static cJSON* rpc_set_invulnerability(const cJSON* args, const char** err) {
    int i, time;
    REQUIRE_CLIENT(args, i, err);
    if (!arg_int(args, 1, &time) || time <= 0) {
        *err = "time needs to be a positive integer.";
        return NULL;
    }
    g_entities[i].client->invulnerabilityTime = level->time + time;
    return cJSON_CreateBool(1);
}

static cJSON* rpc_set_score(const cJSON* args, const char** err) {
    int i, score;
    REQUIRE_CLIENT(args, i, err);
    if (!arg_int(args, 1, &score)) {
        *err = "score must be a number";
        return NULL;
    }
    g_entities[i].client->ps.persistant[PERS_ROUND_SCORE] = score;
    return cJSON_CreateBool(1);
}

/*
 * ================================================================
 *                       items / entities
 * ================================================================
*/

static cJSON* rpc_destroy_kamikaze_timers(const cJSON* args, const char** err) {
    for (int i = 0; i < MAX_GENTITIES; i++) {
        gentity_t* ent = &g_entities[i];
        if (!ent->inuse)
            continue;
        // removing kamikaze skull from dead body
        if (ent->client && ent->health <= 0)
            ent->client->ps.eFlags &= ~EF_KAMIKAZE;
        if (strcmp(ent->classname, "kamikaze timer") == 0)
            G_FreeEntity(ent);
    }
    return cJSON_CreateBool(1);
}

static cJSON* rpc_spawn_item(const cJSON* args, const char** err) {
    int item_id, x, y, z;
    if (!arg_int(args, 0, &item_id) || !arg_int(args, 1, &x) ||
            !arg_int(args, 2, &y) || !arg_int(args, 3, &z)) {
        *err = "spawn_item takes (item_id, x, y, z) as integers";
        return NULL;
    }
    if (item_id < 1 || item_id >= bg_numItems) {
        *err = errf("item_id needs to be a number from 1 to %d.", bg_numItems, 0);
        return NULL;
    }
    vec3_t origin = { x, y, z };
    vec3_t velocity = { 0 };
    gentity_t* ent = LaunchItem(bg_itemlist + item_id, origin, velocity);
    ent->nextthink = 0;
    ent->think = 0;
    G_AddEvent(ent, EV_ITEM_RESPAWN, 0); // make item be scaled up
    return cJSON_CreateBool(1);
}

static cJSON* rpc_remove_dropped_items(const cJSON* args, const char** err) {
    for (int i = 0; i < MAX_GENTITIES; i++) {
        gentity_t* ent = &g_entities[i];
        if (ent->inuse && (ent->flags & FL_DROPPED_ITEM))
            G_FreeEntity(ent);
    }
    return cJSON_CreateBool(1);
}

static void replace_item_core(gentity_t* ent, int item_id) {
    char csbuffer[4096];
    if (item_id) {
        ent->s.modelindex = item_id;
        ent->classname = bg_itemlist[item_id].classname;
        ent->item = &bg_itemlist[item_id];
        // this forces the client to load the new item
        SV_GetConfigstring(CS_ITEMS, csbuffer, sizeof(csbuffer));
        csbuffer[item_id] = '1';
        My_SV_SetConfigstring(CS_ITEMS, csbuffer);
    }
    else
        G_FreeEntity(ent);
}

static cJSON* rpc_replace_items(const cJSON* args, const char** err) {
    const cJSON* arg1 = cJSON_GetArrayItem((cJSON*)args, 0);
    const cJSON* arg2 = cJSON_GetArrayItem((cJSON*)args, 1);
    int entity_id = 0, item_id = 0;
    const char* entity_classname = NULL;
    const char* item_classname = NULL;

    if (cJSON_IsNumber(arg1))
        entity_id = (int)arg1->valuedouble;
    else if (cJSON_IsString(arg1))
        entity_classname = arg1->valuestring;
    else {
        *err = "entity needs to be an integer or a string.";
        return NULL;
    }

    if (cJSON_IsNumber(arg2))
        item_id = (int)arg2->valuedouble;
    else if (cJSON_IsString(arg2))
        item_classname = arg2->valuestring;
    else {
        *err = "item needs to be an integer or a string.";
        return NULL;
    }

    if (item_classname) {
        for (int i = 1; i < bg_numItems; i++) {
            if (strcmp(bg_itemlist[i].classname, item_classname) == 0) {
                item_id = i;
                break;
            }
        }
        if (item_id == 0) {
            snprintf(err_buf, sizeof(err_buf), "invalid item classname: %s.", item_classname);
            *err = err_buf;
            return NULL;
        }
    }
    else if (item_id < 0 || item_id >= bg_numItems) {
        *err = errf("item_id needs to be between 0 and %d.", bg_numItems - 1, 0);
        return NULL;
    }
    // item_id == 0 with no classname removes the item.

    if (!entity_classname) {
        if (entity_id < 0 || entity_id >= MAX_GENTITIES) {
            *err = errf("entity_id needs to be between 0 and %d.", MAX_GENTITIES - 1, 0);
            return NULL;
        }
        if (!g_entities[entity_id].inuse) {
            *err = errf("entity #%d is not in use.", entity_id, 0);
            return NULL;
        }
        if (g_entities[entity_id].s.eType != ET_ITEM) {
            *err = errf("entity #%d is not an item. Cannot replace it.", entity_id, 0);
            return NULL;
        }
        replace_item_core(&g_entities[entity_id], item_id);
        return cJSON_CreateBool(1);
    }

    int found = 0;
    for (int i = 0; i < MAX_GENTITIES; i++) {
        gentity_t* ent = &g_entities[i];
        if (!ent->inuse || ent->s.eType != ET_ITEM)
            continue;
        if (strcmp(ent->classname, entity_classname) == 0) {
            found = 1;
            replace_item_core(ent, item_id);
        }
    }
    return cJSON_CreateBool(found);
}

static cJSON* rpc_dev_print_items(const cJSON* args, const char** err) {
    // Unlike the Python original (which printed via server commands), just
    // return the list: the sidecar decides where to print it.
    cJSON* items = cJSON_CreateArray();
    for (int i = 0; i < MAX_GENTITIES; i++) {
        gentity_t* ent = &g_entities[i];
        if (!ent->inuse || ent->s.eType != ET_ITEM)
            continue;
        cJSON* item = cJSON_CreateObject();
        cJSON_AddNumberToObject(item, "entityId", i);
        cJSON_AddStringToObject(item, "classname", ent->classname);
        cJSON_AddItemToArray(items, item);
    }
    return items;
}

static cJSON* rpc_force_weapon_respawn_time(const cJSON* args, const char** err) {
    int respawn_time;
    if (!arg_int(args, 0, &respawn_time) || respawn_time < 0) {
        *err = "respawn time needs to be an integer 0 or greater";
        return NULL;
    }
    for (int i = 0; i < MAX_GENTITIES; i++) {
        gentity_t* ent = &g_entities[i];
        if (!ent->inuse || ent->s.eType != ET_ITEM || ent->item == NULL)
            continue;
        if (ent->item->giType != IT_WEAPON)
            continue;
        ent->wait = respawn_time;
    }
    return cJSON_CreateBool(1);
}

/*
 * ================================================================
 *                        dispatch table
 * ================================================================
*/

typedef cJSON* (*rpc_fn_t)(const cJSON* args, const char** err);

// What engine state an RPC needs before it is callable:
// GUARD_NONE  — engine functions only (available from startup)
// GUARD_CVARS — needs sv_maxclients/svs (available once the first game inits)
// GUARD_VM    — additionally needs the game module (g_entities/level)
enum { GUARD_NONE, GUARD_CVARS, GUARD_VM };

static const struct { const char* name; rpc_fn_t fn; int guard; } rpc_table[] = {
    { "player_info", rpc_player_info, GUARD_VM },
    { "players_info", rpc_players_info, GUARD_VM },
    { "get_userinfo", rpc_get_userinfo, GUARD_CVARS },
    { "player_state", rpc_player_state, GUARD_VM },
    { "player_stats", rpc_player_stats, GUARD_VM },
    { "send_server_command", rpc_send_server_command, GUARD_CVARS },
    { "client_command", rpc_client_command, GUARD_CVARS },
    { "console_command", rpc_console_command, GUARD_NONE },
    { "console_print", rpc_console_print, GUARD_NONE },
    { "add_console_command", rpc_add_console_command, GUARD_NONE },
    { "get_cvar", rpc_get_cvar, GUARD_NONE },
    { "set_cvar", rpc_set_cvar, GUARD_NONE },
    { "set_cvar_limit", rpc_set_cvar_limit, GUARD_NONE },
    { "get_configstring", rpc_get_configstring, GUARD_NONE },
    { "set_configstring", rpc_set_configstring, GUARD_NONE },
    { "kick", rpc_kick, GUARD_CVARS },
    { "force_vote", rpc_force_vote, GUARD_VM },
    { "callvote", rpc_callvote, GUARD_VM },
    { "set_privileges", rpc_set_privileges, GUARD_VM },
    { "slay_with_mod", rpc_slay_with_mod, GUARD_VM },
    { "player_spawn", rpc_player_spawn, GUARD_VM },
    { "allow_single_player", rpc_allow_single_player, GUARD_VM },
    { "set_position", rpc_set_position, GUARD_VM },
    { "set_velocity", rpc_set_velocity, GUARD_VM },
    { "noclip", rpc_noclip, GUARD_VM },
    { "set_health", rpc_set_health, GUARD_VM },
    { "set_armor", rpc_set_armor, GUARD_VM },
    { "set_weapons", rpc_set_weapons, GUARD_VM },
    { "set_weapon", rpc_set_weapon, GUARD_VM },
    { "set_ammo", rpc_set_ammo, GUARD_VM },
    { "set_powerups", rpc_set_powerups, GUARD_VM },
    { "set_holdable", rpc_set_holdable, GUARD_VM },
    { "drop_holdable", rpc_drop_holdable, GUARD_VM },
    { "set_flight", rpc_set_flight, GUARD_VM },
    { "set_invulnerability", rpc_set_invulnerability, GUARD_VM },
    { "set_score", rpc_set_score, GUARD_VM },
    { "spawn_item", rpc_spawn_item, GUARD_VM },
    { "remove_dropped_items", rpc_remove_dropped_items, GUARD_VM },
    { "replace_items", rpc_replace_items, GUARD_VM },
    { "dev_print_items", rpc_dev_print_items, GUARD_VM },
    { "force_weapon_respawn_time", rpc_force_weapon_respawn_time, GUARD_VM },
    { "destroy_kamikaze_timers", rpc_destroy_kamikaze_timers, GUARD_VM },
    { NULL, NULL, 0 }
};

cJSON* Shim_ExecuteRpc(const char* fn, const cJSON* args, const char** err) {
    for (int i = 0; rpc_table[i].name; i++) {
        if (strcmp(rpc_table[i].name, fn))
            continue;
        if (rpc_table[i].guard >= GUARD_CVARS && !cvars_initialized) {
            *err = "engine not fully initialized yet";
            return NULL;
        }
        if (rpc_table[i].guard >= GUARD_VM && !g_entities) {
            *err = "game module not loaded";
            return NULL;
        }
        return rpc_table[i].fn(args, err);
    }
    snprintf(err_buf, sizeof(err_buf), "unknown rpc function: %s", fn);
    *err = err_buf;
    return NULL;
}
