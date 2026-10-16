// NFT boosts: what the NFTs a player uses add to their mining. Shared by the game (to break blocks faster, walk faster
// and show it) and the world server (which works out each signed-in player's boost from what the chain says they own,
// and applies it when it credits $MINE and checks how fast blocks break). Every tunable number is here.
//
// Boosts only reward active play: they make blocks break faster, make each block, monster and boss share pay more,
// and raise how much a player can earn in a day. Nothing pays for holding or waiting: an NFT in a wallet earns nothing
// by itself. A DEGEN deployed as an autopilot bot (bots-rules.js) mines only while its player is in the game and
// active, with its own DEGEN's boost alone (itemBoost, never the player's), up to a daily cap of its own (dailyCap with
// that boost's cap). The stats, in whole percent:
//   speed  blocks break this much faster (the world server allows it in its break-rate check);
//   earn   every block, monster and boss share pays this much more $MINE (the server adds it when it credits);
//   cap    the player's daily cap (rewards.js DAILY_EARN_CAP, times the zone's capMul in zones.js) is this much higher
//          (and a bot's own cap, from its DEGEN's);
//   move   walking (and, once there are vehicles, driving) is this much faster. Only the game uses it: the server's
//          speed check (40 blocks a second) allows far more than the fastest boosted walk.
// A player uses one item per slot (a Crafter, a skin, a companion, an aura, a vehicle); the slots' boosts add up, and
// each total is clamped to MAX. The world's daily cap (rewards.js WORLD_DAILY_CAP) holds whatever anyone's boost.
// Guests earn nothing, so they get no boost.
//
// How the server knows: a Crafter's boost comes from `["wear", tokenId]` (ownerOf on MineWorldCrafters, its rarity
// from the revealed seed, degen-skin.js rarityOf, and its level from CrafterLevels.levelOf); any other slot's from
// `["equip", slot, tokenId]` (ownerOf on that slot's contract, and its tier from it). It checks again every few
// minutes while the player earns, so a token sold or upgraded mid-session is noticed (and at once, on `["recheck"]`,
// which the game sends right after its player levels up the Crafter they wear). It sends the player
// `["boost", speed, earn, cap, move, sources, dailyCap]` (sources: [slot, label, speed, earn, cap, move] for each item).
//
// HOW TO PLUG IN A NEW COLLECTION (skins, companions, auras and vehicles have a slot waiting below):
//  1. The contract: an ERC-721 with `ownerOf(uint256)` and a view that says each token's tier,
//     `tierOf(uint256) returns (uint256)`: 0 Common, 1 Rare, 2 Legendary (TIERS). If the tier is a trait instead (as
//     the Crafters' rarity is), give the slot a `tierOf` name of your own and teach the world server's `readTier`
//     (multiplayer/src/index.js) to work it out, as it does for "rarity".
//  2. Its address: set the slot's `contract` below to its Robinhood Chain address. That also turns the slot's
//     "Coming soon" off in the Mining Site panel. (The world server prefers the slot's `env` variable when it's set,
//     e.g. SKINS_ADDRESS in multiplayer/.dev.vars for a local chain, or in wrangler.toml [vars].)
//  3. Its boosts: tune the slot's `tiers` (one row per tier; the numbers there now are placeholders). A collection
//     with levels gets a `levels` entry like the Crafter's (a contract with `levelOf(uint256)` and a table).
//  4. Deploy the world server and the site. The game equips an item with net.equip(slot, tokenId) (["equip", slot,
//     tokenId], or null to take it off); the panel lists only Crafters today, so its slot needs a picker that lists
//     the wallet's tokens (chain.js, as `tokensOfOwner` does for the Crafters) and calls net.equip.
// A brand new slot is one more entry in SLOTS (and a line in the panel's list comes with it).

import { DAILY_EARN_CAP, UNIT } from "./rewards.js";
import { zoneOf } from "./zones.js";

/// The stats, and the most each one's total can be across all slots, in percent.
export const STATS = ["speed", "earn", "cap", "move"];
export const MAX = { speed: 150, earn: 150, cap: 300, move: 100 };

/// A token's tier is an index into this (the same three as the DEGENs' rarities, degen-skin.js RARITIES).
export const TIERS = ["Common", "Rare", "Legendary"];

/// What a Crafter's level (bought on-chain, CrafterLevels) adds on top of its rarity's boost. Every Crafter is level 1
/// until it's upgraded. To add levels 6 and up, add rows here (and the levels on-chain, CrafterLevels.addLevel): a
/// level past the last row counts as the last row, so the contract can never get ahead of this table.
export const CRAFTER_LEVELS = {
  1: {},
  2: { speed: 5, earn: 5, cap: 10 },
  3: { speed: 15, earn: 15, cap: 30 },
  4: { speed: 30, earn: 30, cap: 60 },
  5: { speed: 50, earn: 50, cap: 100 },
};

/// The slots, in the order they're shown. For each: its name; where its contract is (`contract`: the address once it's
/// issued, null until then; `env`: the world server's variable that overrides it); how a token's tier is read
/// (`tierOf`: "rarity" for the Crafters' traits, otherwise the name of a `(uint256) returns (uint256)` view on the
/// contract); `tiers`: the boost for each tier (Common, Rare, Legendary); and `levels` if tokens have levels.
export const SLOTS = {
  crafter: {
    name: "DEGEN", env: "CRAFTERS_ADDRESS", contract: null, live: true, // (its address is the Crafters' own setting)
    tierOf: "rarity",
    tiers: [{ speed: 5, earn: 5, cap: 10 }, { speed: 10, earn: 10, cap: 25 }, { speed: 20, earn: 20, cap: 50 }],
    levels: { env: "LEVELS_ADDRESS", contract: null, fn: "levelOf", table: CRAFTER_LEVELS },
  },
  skin: {
    name: "Skin", env: "SKINS_ADDRESS", contract: null, tierOf: "tierOf",
    tiers: [{ earn: 3 }, { earn: 6, cap: 10 }, { earn: 10, cap: 20 }],
  },
  companion: {
    name: "Companion", env: "COMPANIONS_ADDRESS", contract: null, tierOf: "tierOf",
    tiers: [{ speed: 5 }, { speed: 10, cap: 10 }, { speed: 20, cap: 25 }],
  },
  aura: {
    name: "Aura", env: "AURAS_ADDRESS", contract: null, tierOf: "tierOf",
    tiers: [{ earn: 5 }, { earn: 10 }, { earn: 15, speed: 10 }],
  },
  vehicle: {
    name: "Vehicle", env: "VEHICLES_ADDRESS", contract: null, tierOf: "tierOf",
    tiers: [{ move: 20 }, { move: 35, cap: 5 }, { move: 50, cap: 10 }],
  },
};
export const SLOT_KEYS = Object.keys(SLOTS);
export const isSlot = (s) => typeof s === "string" && Object.hasOwn(SLOTS, s);
/// Whether a slot's collection is out (the panel shows the others as "Coming soon").
export const issued = (slot) => !!(SLOTS[slot].live || SLOTS[slot].contract);

const zero = () => ({ speed: 0, earn: 0, cap: 0, move: 0 });
function add(into, b) {
  for (const k of STATS) into[k] += b?.[k] ?? 0;
  return into;
}

/// The row of a level table for `level`: the highest row at or below it (so a level past the table counts as its top).
export function levelRow(table, level) {
  const want = Math.max(1, Math.floor(Number(level)) || 1);
  const at = Object.keys(table).map(Number).filter((l) => l <= want);
  return at.length ? table[Math.max(...at)] : {};
}

/// One item's boost: its tier's row, plus its level's row if the slot has levels. `label` names it for people
/// ("Legendary Crafter L3").
export function itemBoost(slot, tier, level = 1) {
  const S = SLOTS[slot];
  const b = add(zero(), S.tiers[tier]);
  if (S.levels) add(b, levelRow(S.levels.table, level));
  return { slot, label: `${TIERS[tier]} ${S.name}${S.levels ? ` L${Math.max(1, Math.floor(level) || 1)}` : ""}`, ...b };
}

/// A player's boost from the items they use: `items` maps a slot to { tier, level } (one item a slot; anything that
/// isn't a known slot and tier is ignored). The totals, each clamped to MAX, and `sources`: each item's own boost.
export function boostOf(items) {
  const total = zero(), sources = [];
  for (const slot of SLOT_KEYS) {
    const it = items?.[slot];
    if (!it || !Number.isInteger(it.tier) || !SLOTS[slot].tiers[it.tier]) continue;
    const s = itemBoost(slot, it.tier, it.level);
    sources.push(s);
    add(total, s);
  }
  for (const k of STATS) total[k] = Math.min(MAX[k], Math.max(0, total[k]));
  return { ...total, sources };
}
export const NO_BOOST = boostOf({});

/// A player's daily cap (or one bot's, from its own DEGEN's cap boost) in ledger units (rewards.js UNIT) with a cap
/// boost of `capPct`, while it earns in `zone`.
export const dailyCap = (capPct, zone) => Math.round((DAILY_EARN_CAP * UNIT * (100 + capPct) * (zoneOf(zone).capMul ?? 1)) / 100);
/// What something worth `units` pays with an earn boost of `earnPct` (whole units: the ledger's are).
export const withEarn = (units, earnPct) => Math.round((units * (100 + earnPct)) / 100);
/// The seconds a block takes to break with a speed boost of `speedPct`, from what it takes without one.
export const withSpeed = (seconds, speedPct) => (seconds * 100) / (100 + speedPct);
/// A walking speed with a move boost of `movePct`.
export const withMove = (speed, movePct) => (speed * (100 + movePct)) / 100;

/// The boost in a few words: "+35% speed, +35% $MINE, +80% daily cap" (what's zero is left out; "" for none).
export function describe(b) {
  const parts = [];
  if (b.speed) parts.push(`+${b.speed}% speed`);
  if (b.earn) parts.push(`+${b.earn}% $MINE`);
  if (b.cap) parts.push(`+${b.cap}% daily cap`);
  if (b.move) parts.push(`+${b.move}% move`);
  return parts.join(", ");
}

/// The boost on the wire, after "boost": [speed, earn, cap, move, sources], sources as [slot, label, speed, earn, cap,
/// move] (the room adds the wallet's daily cap where it is). And back.
export const packBoost = (b) => [b.speed, b.earn, b.cap, b.move, b.sources.map((s) => [s.slot, s.label, s.speed, s.earn, s.cap, s.move])];
export function unpackBoost(m) {
  const n = (v) => (Number.isFinite(v) ? v : 0);
  const sources = (Array.isArray(m?.[4]) ? m[4] : []).filter(Array.isArray)
    .map(([slot, label, speed, earn, cap, move]) => ({ slot: String(slot), label: String(label), speed: n(speed), earn: n(earn), cap: n(cap), move: n(move) }));
  return { speed: n(m?.[0]), earn: n(m?.[1]), cap: n(m?.[2]), move: n(m?.[3]), sources };
}
