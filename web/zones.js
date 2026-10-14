// The rocket's worlds: the home planet and three zones, each its own 512-block planet (the same size and bend as home,
// rules.js) from its own seed and terrain (zonegen.js). Shared by the game and the world server: everything that can
// be tuned about the zones, the rocket, the boss and PvP is here (what they pay is in rewards.js: ZONE_PAY,
// BOSS_POOL; each zone's `capMul` here multiplies a wallet's daily cap while it earns there).
//
// - Home: the town and its villagers (worldgen.js, town.js). The rocket stands on the launch pad in the north-east.
// - Deepvein, the 2x $MINE zone: rocky, full of caves and ore; everything earned there pays double; monsters come day
//   and night, more of them and tougher; its edits are kept a week at a time, so it grows back every Monday.
// - Cinderfall, the boss zone: a volcanic world with an arena north of the pad, where Ashgrim, the Cinder Colossus,
//   fights everyone in it at once. The world server runs the boss; the games animate it from what the server says.
// - Red Mesa, the PvP zone: mesas and canyons where players can hit each other (nowhere else), except on the pad.
//   A player beaten there drops everything they carry in a loot chest for the first to open it.
//
// Every zone's landing pad is in the middle of its planet; nobody mines, builds or fights within PAD_R of it.

import { TOWN, SPAWN, protectedAt, wrapDelta, wrapDist } from "./rules.js";
import { LAUNCH } from "./town.js";
import { DIAMOND, GOLD, CRYSTAL, IRON, CRYSTAL_SWORD } from "./blocks.js";
import { ZONE_PAY, BOSS_POOL } from "./rewards.js";

/// The rocket's tickets, in $MINE (each zone's `ticket` below): one ticket for each trip out (home to a zone, or a
/// zone to another), with no time limit (stay in a zone as long as you like; the world server remembers each wallet's
/// zone, so a reload or a dropped connection lands you back there). The way home is always free; from home, the next
/// trip out needs a new ticket. Deepvein and Cinderfall 2,100 each (about $5 at a $50K market cap), Red Mesa 210
/// ($0.50). Tickets are paid in full to the treasury, as Courier World's moon tickets are: nothing is burned.
/// Buying one: a signed-in player pays the zone's `ticket` on-chain (MinePayments.pay, kind 1, after approving exactly
/// that much) at the rocket's card, and the world server checks the payment's receipt and keeps the ticket for their
/// wallet (multiplayer/src/index.js buyTicket); its useTicket takes one on the way out. Guests can't fly out.
/// TICKETS_FREE = true makes every trip free again (no buying: the server's useTicket always says yes).
export const TICKETS_FREE = false;

export const PAD_R = 20; // nobody mines, builds or fights this close to a zone's landing pad
export const PAD_S = 7.5; // the pad's own blocks (plates, rim, lamp posts) reach this far from its middle
export const PAD_FLAT = 12; // the land round a zone's pad is level out to here
export const BLEND = 22; // and blends back into the wild over this many blocks
export const ROCKET_REACH = 6; // blocks: how close to the rocket's middle you can click it

const NO_PVP = "No PvP: players can't hurt each other here";
const mine = (n) => n.toLocaleString("en-US");

/// key -> the zone. `pad`: the landing pad's middle block (x, z) and its floor (y). `mobs`: how many monsters a
/// player gets at most, how often (the soonest), whether they come by day too (not only at night and underground),
/// and their health and damage against home's. `sky`: its colours by day, at dusk and at night. `globe`: how it
/// looks from space on the way (its air and its polar caps). `capMul`: a wallet's daily cap (rewards.js DAILY_EARN_CAP,
/// with its NFT cap boost, boosts.js) is multiplied by this while it earns here; the world's daily cap is not. 1
/// everywhere for now (Deepvein could be 2, to go with its 2x pay).
export const ZONES = {
  home: {
    key: "home", name: "Home planet", label: "Home", seed: 0, ticket: 0, capMul: 1, pvp: false, rule: NO_PVP,
    line: "The town, the shops and the villagers. Mine and build out past the gates.",
    pad: { x: TOWN.x + LAUNCH.x, z: TOWN.z + LAUNCH.z, y: TOWN.y },
    mobs: { max: 3, everyMs: 20_000, always: false, hp: 1, damage: 1 },
    sky: { day: 0x8ec9ff, dusk: 0xf29a5c, night: 0x0b1026 },
    globe: { air: [0.42, 0.7, 1.0], cap: [236, 244, 250] },
  },
  deep: {
    key: "deep", name: "Deepvein", label: `${ZONE_PAY.deep}x Mine Zone`, seed: 1000, ticket: 2100, capMul: 1, pvp: false, rule: NO_PVP, weekly: true,
    line: `Rocky, riddled with caves and rich in ore: everything you earn pays ${ZONE_PAY.deep}x. Monsters come day and night, and they're tougher. It all grows back every Monday.`,
    pad: { x: 256, z: 256, y: 66 },
    mobs: { max: 5, everyMs: 10_000, always: true, hp: 1.5, damage: 1.5 },
    sky: { day: 0x9db0c4, dusk: 0xc48a7c, night: 0x0a0e1a },
    globe: { air: [0.62, 0.66, 0.86], cap: [150, 156, 170] },
  },
  boss: {
    key: "boss", name: "Cinderfall", label: "Boss Zone", seed: 2000, ticket: 2100, capMul: 1, pvp: false, rule: NO_PVP,
    line: `A world of ash and fire. Ashgrim, the Cinder Colossus, waits in the arena north of the pad: beat it together and share ${mine(BOSS_POOL)} $MINE.`,
    pad: { x: 256, z: 256, y: 60 },
    mobs: { max: 3, everyMs: 20_000, always: false, hp: 1, damage: 1 },
    sky: { day: 0xc98468, dusk: 0xe0603c, night: 0x1c0a08 },
    globe: { air: [1.0, 0.5, 0.28], cap: [70, 64, 66] },
  },
  pvp: {
    key: "pvp", name: "Red Mesa", label: "PvP Zone", seed: 3000, ticket: 210, capMul: 1, pvp: true,
    rule: "PvP: other players can hit you here (not on the pad)",
    line: "Mesas and canyons where players fight each other. Mining and monsters work as at home.",
    warn: "Other players can beat you here and take everything you carry: your whole inventory and the armor you wear.",
    pad: { x: 256, z: 256, y: 58 },
    mobs: { max: 3, everyMs: 20_000, always: false, hp: 1, damage: 1 },
    sky: { day: 0xeec39a, dusk: 0xf0884a, night: 0x160c1c },
    globe: { air: [1.0, 0.7, 0.45], cap: [214, 150, 110] },
  },
};
export const ZONE_KEYS = Object.keys(ZONES);
export const isZone = (k) => typeof k === "string" && Object.hasOwn(ZONES, k);
export const zoneOf = (k) => (isZone(k) ? ZONES[k] : ZONES.home);

/// Where you stand after landing: on the pad, a few steps south of the rocket, facing away from it.
export function landing(k) {
  const p = zoneOf(k).pad;
  return { x: p.x + 0.5, y: p.y + 1, z: p.z + 3.5, yaw: Math.PI };
}
/// Where a player starts and comes back after being knocked out: home's town square, or the zone's pad.
export function spawnOf(k) {
  return k === "home" || !isZone(k) ? { ...SPAWN, yaw: 0 } : landing(k);
}
/// The flat distance from (x, z) (a block or a position) to zone k's pad, the short way round.
export const padDist = (k, x, z) => { const p = zoneOf(k).pad; return wrapDist(x, z, p.x + 0.5, p.z + 0.5); };
/// Whether (x, z) is in the pad's safe area: no mining, no building, no fighting other players.
export const onPad = (k, x, z) => padDist(k, x, z) < PAD_R;

// ---------------------------------------------------------------- the boss (Cinderfall)

/// The arena: its floor's middle (x, z) and height (y), the floor's radius and the wall's outer radius. The path
/// from the pad runs straight north to its south gate.
export const ARENA = { x: 256, z: 204, y: 60, r: 17, wall: 20 };
/// The path's half width, and where it runs (z from the arena's gate to the pad's rim).
export const PATH = { half: 1, z0: ARENA.z + ARENA.wall + 1, z1: 256 - 8 };

/// Ashgrim, the Cinder Colossus: an original creature, a giant of cooled lava with a molten heart. The world server
/// keeps its health and picks each move; every game in the zone animates the move from the same start time, so the
/// boss looks the same to all and nothing is sent while it moves. Hits on it are checked by the server (rate, damage
/// at most blocks.js BEST_DAMAGE, distance to it).
export const BOSS = {
  name: "Ashgrim", title: "the Cinder Colossus", hp: 1500, respawnMs: 10 * 60_000,
  body: 2.4, // its half width, in blocks (it stands about 9 tall)
  height: 9,
  hitRange: 10.5, // the room counts a hit from this close to its middle (its body, your reach, and some latency)
  engage: 30, // players this close to the arena's middle are in the fight
  roam: 11, // it walks no further than this from the arena's middle
  walkSpeed: 2.6, // blocks a second
  slam: { windupMs: 1300, ms: 2300, radius: 6.5, damage: 8 }, // both fists on the ground: a ring of fire round it
  rock: { windupMs: 900, flightMs: 1300, ms: 2700, radius: 2.6, damage: 6 }, // a molten rock thrown at someone
  summon: { ms: 2600, count: 3, everyMs: 30_000, below: 0.6 }, // monsters called up once it's hurt (under 60%)
  restMs: [450, 1000], // a breath between moves
  healMs: 90_000, // left alone this long (nobody in the fight), it heals back to full and forgets the fight
  // What everyone who did at least 5% of the damage gets, and the top hitter on top of that.
  loot: [[DIAMOND, 2], [GOLD, 4], [IRON, 6], [CRYSTAL, 1]],
  topLoot: [[CRYSTAL, 3], [DIAMOND, 3]],
  rareLoot: [CRYSTAL_SWORD, 0.15], // and a one in seven chance of this for the top hitter
};
/// Where the boss's middle is at time t (ms, the server's clock), from its current move { act, t0, ms, from, to }.
export function bossAt(s, t) {
  if (s.act !== "walk") return { x: s.to[0], z: s.to[1] };
  const k = Math.max(0, Math.min(1, (t - s.t0) / s.ms));
  return { x: s.from[0] + (s.to[0] - s.from[0]) * k, z: s.from[1] + (s.to[1] - s.from[1]) * k };
}
export const inArena = (x, z, extra = 0) => Math.hypot(wrapDelta(x - ARENA.x), wrapDelta(z - ARENA.z)) < ARENA.wall + extra;
const onPath = (x, z) => Math.abs(wrapDelta(x - ARENA.x)) <= PATH.half + 1 && z >= PATH.z0 - 1 && z <= PATH.z1 + 1;

// ---------------------------------------------------------------- PvP (Red Mesa)

/// reach: how far (between the two players' positions as the server last heard them) a hit can come from;
/// everyMs: the shortest time between two hits from one player (a sword swings every 500 ms);
/// killMs: a knock-out counts as a PvP one (and drops a chest) only this soon after a checked hit from that player;
/// chestMs: how long a loot chest stays; chestReach: how close you must be to open one; maxStacks: what a chest holds.
export const PVP = { reach: 6.5, everyMs: 380, killMs: 6000, chestMs: 3 * 60_000, chestReach: 6, maxStacks: 40 };
/// Whether players can hurt each other at (x, z) in zone k: only in a PvP zone, and never on its pad.
export const pvpAt = (k, x, z) => zoneOf(k).pvp && !onPad(k, x, z);

// ---------------------------------------------------------------- what's protected, and where monsters come

/// Nobody breaks or places blocks here: home's town; a zone's pad; Cinderfall's arena and the path to it.
export function protectedIn(k, x, z) {
  if (k === "home" || !isZone(k)) return protectedAt(x, z);
  if (padDist(k, x + 0.5, z + 0.5) < PAD_R) return true;
  return k === "boss" && (inArena(x + 0.5, z + 0.5, 2) || onPath(x, z));
}
/// No wandering monsters here (the boss calls its own): the town, the pads, and Cinderfall's arena.
export function calmAt(k, x, z) {
  if (k === "home" || !isZone(k)) return protectedAt(x, z) || wrapDist(x, z, TOWN.x, TOWN.z) < 80;
  if (padDist(k, x, z) < PAD_R + 16) return true;
  return k === "boss" && inArena(x, z, BOSS.engage - ARENA.wall + 8);
}

// ---------------------------------------------------------------- Deepvein's week

const DAY = 86_400_000, WEEK = 7 * DAY;
/// The week number of time `ms`: weeks start on Monday 00:00 UTC (1970-01-05 was a Monday).
export const weekOf = (ms) => Math.floor((ms - 4 * DAY) / WEEK);
/// When the next week starts.
export const nextWeekAt = (ms) => (weekOf(ms) + 1) * WEEK + 4 * DAY;
