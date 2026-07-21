/**
 * Wire protocol between the C shim (inside verge.x64.so) and this sidecar.
 * Transport: Unix domain socket, newline-delimited JSON, UTF-8 (invalid engine
 * bytes are lossily replaced on decode).
 *
 * The shim is the listener and spawns/supervises the sidecar. Nothing is
 * dispatched until the sidecar sends `hello`.
 */

/** Raw engine events, as dispatched by the shim's hooks. */
export const RAW_EVENTS = [
  "client_command",
  "server_command",
  "frame",
  "player_connect",
  "player_loaded",
  "player_disconnect",
  "new_game",
  "set_configstring",
  "rcon",
  "console_print",
  "player_spawn",
  "kamikaze_use",
  "kamikaze_explode",
  "custom_command",
] as const;

export type RawEventName = (typeof RAW_EVENTS)[number];

/**
 * Events the engine blocks on, waiting for a HookRes within the shim's
 * timeout budget (default 100 ms). All other events are fire-and-forget.
 * - `client_command` / `server_command` / `set_configstring`: false = cancel,
 *   string = replace the value.
 * - `player_connect`: string = rejection message, false = generic ban message.
 * - `console_print`: false = cancel (replacement is ignored by the engine).
 */
export const BLOCKING_EVENTS = [
  "client_command",
  "server_command",
  "set_configstring",
  "player_connect",
  "console_print",
] as const satisfies readonly RawEventName[];

/** Per-event argument tuples, matching shim_dispatch.c. */
export interface RawEventArgs {
  client_command: [clientId: number, cmd: string];
  server_command: [clientId: number, cmd: string]; // clientId -1 = broadcast
  frame: [];
  player_connect: [clientId: number, isBot: boolean];
  player_loaded: [clientId: number];
  player_disconnect: [clientId: number, reason: string];
  new_game: [restart: boolean];
  set_configstring: [index: number, value: string];
  rcon: [cmd: string];
  console_print: [ignored: number, text: string];
  player_spawn: [clientId: number];
  kamikaze_use: [clientId: number];
  kamikaze_explode: [clientId: number, isUsedOnDemand: boolean];
  custom_command: [command: string, args: string];
}

/** null/undefined = pass through, false = cancel, string = replace. */
export type HookResult = null | undefined | false | string;

// Messages: sidecar -> shim
export interface HelloMsg {
  t: "hello";
  v: 1;
  subs: RawEventName[];
  /** Dispatch the frame event every N engine frames; 0 = never. */
  frameEvery: number;
}
export interface HookResMsg {
  t: "hookres";
  id: number;
  res: HookResult;
}
export interface RpcMsg {
  t: "rpc";
  id: number;
  fn: RpcName;
  args: unknown[];
}
export type SidecarMsg = HelloMsg | HookResMsg | RpcMsg;

// Messages: shim -> sidecar
export interface EventMsg {
  t: "ev";
  name: RawEventName;
  args: unknown[];
}
export interface HookMsg {
  t: "hook";
  id: number;
  name: RawEventName;
  args: unknown[];
}
export interface RpcResMsg {
  t: "rpcres";
  id: number;
  ok: boolean;
  val?: unknown;
  err?: string;
}
export type ShimMsg = EventMsg | HookMsg | RpcResMsg;

/*
 * ================================================================
 *                        RPC data shapes
 * ================================================================
 */

/**
 * SteamID64 values exceed Number.MAX_SAFE_INTEGER, so they are strings on
 * the wire and throughout the runtime.
 */
export type SteamId = string;

export interface PlayerInfo {
  clientId: number;
  name: string;
  connectionState: number; // CS_* constant
  userinfo: string;
  steamId: SteamId;
  team: number; // TEAM_* constant
  privileges: number; // PRIV_* constant, -1 before the client struct exists
}

export type Vector3 = [x: number, y: number, z: number];

/** Indexed by weapon slot - 1 (gauntlet first); see WEAPONS in constants.ts. */
export type WeaponsTuple<T> = T[] & { length: 15 };

export interface PlayerState {
  isAlive: boolean;
  position: Vector3;
  velocity: Vector3;
  health: number;
  armor: number;
  noclip: boolean;
  weapon: number;
  weapons: boolean[]; // 15 entries
  ammo: number[]; // 15 entries
  powerups: number[]; // 6 entries: remaining ms of quad, bs, haste, invis, regen, invuln
  holdable: string | null;
  flight: [fuel: number, maxFuel: number, thrust: number, refuel: number];
  isFrozen: boolean;
}

export interface PlayerStats {
  score: number;
  kills: number;
  deaths: number;
  damageDealt: number;
  damageTaken: number;
  time: number;
  ping: number;
}

export interface ItemEntity {
  entityId: number;
  classname: string;
}

/** Typed signatures for every engine RPC implemented in shim_rpc.c. */
export interface RpcSignatures {
  player_info(clientId: number): PlayerInfo | null;
  players_info(): (PlayerInfo | null)[];
  get_userinfo(clientId: number): string | null;
  player_state(clientId: number): PlayerState | null;
  player_stats(clientId: number): PlayerStats | null;
  send_server_command(clientId: number | null, cmd: string): boolean;
  client_command(clientId: number, cmd: string): boolean;
  console_command(cmd: string): null;
  console_print(text: string): null;
  add_console_command(name: string): null;
  get_cvar(name: string): string | null;
  set_cvar(name: string, value: string, flags?: number): boolean;
  set_cvar_limit(name: string, value: string, min: string, max: string, flags?: number): null;
  get_configstring(index: number): string;
  set_configstring(index: number, value: string): null;
  kick(clientId: number, reason: string | null): null;
  force_vote(pass: boolean): boolean;
  callvote(vote: string, displayString: string, time?: number): null;
  set_privileges(clientId: number, privileges: number): boolean;
  slay_with_mod(clientId: number, meansOfDeath: number): boolean;
  player_spawn(clientId: number): boolean;
  allow_single_player(allow: boolean): null;
  set_position(clientId: number, position: Vector3): boolean;
  set_velocity(clientId: number, velocity: Vector3): boolean;
  noclip(clientId: number, activate: boolean): boolean;
  set_health(clientId: number, health: number): boolean;
  set_armor(clientId: number, armor: number): boolean;
  set_weapons(clientId: number, weapons: boolean[]): boolean;
  set_weapon(clientId: number, weapon: number): boolean;
  set_ammo(clientId: number, ammo: number[]): boolean;
  set_powerups(clientId: number, powerups: number[]): boolean;
  set_holdable(clientId: number, holdable: number): boolean;
  drop_holdable(clientId: number): boolean;
  set_flight(clientId: number, flight: [number, number, number, number]): boolean;
  set_invulnerability(clientId: number, time: number): boolean;
  set_score(clientId: number, score: number): boolean;
  spawn_item(itemId: number, x: number, y: number, z: number): boolean;
  remove_dropped_items(): boolean;
  replace_items(entity: number | string, item: number | string): boolean;
  dev_print_items(): ItemEntity[];
  force_weapon_respawn_time(time: number): boolean;
  destroy_kamikaze_timers(): boolean;
}

export type RpcName = keyof RpcSignatures;
