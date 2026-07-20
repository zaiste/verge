/** Constants formerly exposed by the C module via PyModule_AddIntMacro. */

export const EventResult = {
  /** Continue execution normally. */
  None: 0,
  /** Stop any further handlers from being called. */
  Stop: 1,
  /** Let other handlers run, but cancel the event at the engine level. */
  StopEvent: 2,
  /** Stop handlers AND cancel the event. */
  StopAll: 3,
  /** Command handlers only: reply with the command's usage string. */
  Usage: 4,
} as const;
export type EventResultValue = (typeof EventResult)[keyof typeof EventResult];

export const Priority = {
  Highest: 0,
  High: 1,
  Normal: 2,
  Low: 3,
  Lowest: 4,
} as const;
export type PriorityValue = (typeof Priority)[keyof typeof Priority];
export const PRIORITY_LEVELS = [0, 1, 2, 3, 4] as const;

// Privileges (sess.privileges).
export const PRIV_NONE = 0x0;
export const PRIV_MOD = 0x1;
export const PRIV_ADMIN = 0x2;
export const PRIV_ROOT = 0x3;
export const PRIV_BANNED = 0xffffffff;

// Connection states (clientState_t).
export const CS_FREE = 0;
export const CS_ZOMBIE = 1;
export const CS_CONNECTED = 2;
export const CS_PRIMED = 3;
export const CS_ACTIVE = 4;

// Teams (team_t).
export const TEAM_FREE = 0;
export const TEAM_RED = 1;
export const TEAM_BLUE = 2;
export const TEAM_SPECTATOR = 3;

/** Team number -> name, as used across the plugin API. */
export const TEAMS = ["free", "red", "blue", "spectator"] as const;
export type TeamName = (typeof TEAMS)[number];

/** Connection state number -> name. */
export const CONNECTION_STATES = ["free", "zombie", "connected", "primed", "active"] as const;
export type ConnectionStateName = (typeof CONNECTION_STATES)[number];

/** Gametype number -> long name (gaps are unused ids). */
export const GAMETYPES: Record<number, string> = {
  0: "Free for All", 1: "Duel", 2: "Race", 3: "Team Deathmatch", 4: "Clan Arena",
  5: "Capture the Flag", 6: "One Flag", 8: "Harvester", 9: "Freeze Tag",
  10: "Domination", 11: "Attack and Defend", 12: "Red Rover",
};

/** Gametype number -> short name. */
export const GAMETYPES_SHORT: Record<number, string> = {
  0: "ffa", 1: "duel", 2: "race", 3: "tdm", 4: "ca", 5: "ctf", 6: "1f",
  8: "har", 9: "ft", 10: "dom", 11: "ad", 12: "rr",
};

/**
 * Weapon slot -> short name. Index 0 is unused; slots 1-15 match the
 * engine's weapon numbers. The protocol's 15-element weapons/ammo arrays
 * are indexed by slot - 1.
 */
export const WEAPONS: Record<number, string> = {
  1: "g", 2: "mg", 3: "sg", 4: "gl", 5: "rl", 6: "lg", 7: "rg", 8: "pg",
  9: "bfg", 10: "gh", 11: "ng", 12: "pl", 13: "cg", 14: "hmg", 15: "hands",
};

// Cvar flags.
export const CVAR_ARCHIVE = 1;
export const CVAR_USERINFO = 2;
export const CVAR_SERVERINFO = 4;
export const CVAR_SYSTEMINFO = 8;
export const CVAR_INIT = 16;
export const CVAR_LATCH = 32;
export const CVAR_ROM = 64;
export const CVAR_USER_CREATED = 128;
export const CVAR_TEMP = 256;
export const CVAR_CHEAT = 512;
export const CVAR_NORESTART = 1024;

// Means of death (meansOfDeath_t), for slay_with_mod and stats events.
export const MOD_UNKNOWN = 0;
export const MOD_SHOTGUN = 1;
export const MOD_GAUNTLET = 2;
export const MOD_MACHINEGUN = 3;
export const MOD_GRENADE = 4;
export const MOD_GRENADE_SPLASH = 5;
export const MOD_ROCKET = 6;
export const MOD_ROCKET_SPLASH = 7;
export const MOD_PLASMA = 8;
export const MOD_PLASMA_SPLASH = 9;
export const MOD_RAILGUN = 10;
export const MOD_LIGHTNING = 11;
export const MOD_BFG = 12;
export const MOD_BFG_SPLASH = 13;
export const MOD_WATER = 14;
export const MOD_SLIME = 15;
export const MOD_LAVA = 16;
export const MOD_CRUSH = 17;
export const MOD_TELEFRAG = 18;
export const MOD_FALLING = 19;
export const MOD_SUICIDE = 20;
export const MOD_TARGET_LASER = 21;
export const MOD_TRIGGER_HURT = 22;
export const MOD_NAIL = 23;
export const MOD_CHAINGUN = 24;
export const MOD_PROXIMITY_MINE = 25;
export const MOD_KAMIKAZE = 26;
export const MOD_JUICED = 27;
export const MOD_GRAPPLE = 28;
export const MOD_SWITCH_TEAMS = 29;
export const MOD_HMG = 32;
export const MOD_RAILGUN_HEADSHOT = 33;
