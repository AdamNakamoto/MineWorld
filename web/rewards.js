// What real activity in the game earns, in $MINE. Shared by the game (to show it) and the multiplayer room (which
// keeps the ledger and signs the vouchers). To pay for a new activity, or change a rate, edit this file, then deploy
// the room and the site. Nothing pays for holding or waiting: no auto yield farming. Autopilot bots (bots-rules.js)
// earn these same block rates only while their player is in the game and active (they pause BOT_IDLE_MS after the
// player's last action the room accepts), each within a daily cap of its own.
//
// Sized for the 21,000,000 $MINE supply: half of it (10,500,000) is the mining vault, and WORLD_DAILY_CAP below pays it
// out over at least 300 days. NFT boosts (boosts.js) add a percentage on top of these rates and raise a player's
// daily cap (a bot gets its own DEGEN's boost, for its own cap); the world's cap holds whatever anyone's boost.
//
// The ledger counts UNIT ten-thousandths of a $MINE (whole numbers only), so the smallest reward (0.01) with a
// percentage boost on top (+5% = 0.0105) is still counted exactly; every amount here has at most four decimals.

import {
  GRASS, DIRT, STONE, SAND, GRAVEL, LOG, DARK_LOG, SNOW, SANDSTONE, CACTUS, COAL_ORE, IRON_ORE, GOLD_ORE, DIAMOND_ORE,
  MINE_ORE, BASALT, EMBER, ASH, RED_SAND, RED_CLAY, PALE_CLAY, DEEP_ROCK,
} from "./blocks.js";

/// Breaking a natural block (one the world was made with). Blocks players placed pay nothing when broken again.
/// Leaves and plants (grass tufts, flowers, ferns, mushrooms, berry bushes) pay nothing.
export const BLOCK_REWARDS = {
  [GRASS]: 0.01, [DIRT]: 0.01, [SAND]: 0.01, [GRAVEL]: 0.01, [SNOW]: 0.01, [CACTUS]: 0.01,
  [LOG]: 0.05, [DARK_LOG]: 0.05, [STONE]: 0.05, [SANDSTONE]: 0.05,
  [COAL_ORE]: 0.3, [IRON_ORE]: 0.8, [GOLD_ORE]: 2, [DIAMOND_ORE]: 6, [MINE_ORE]: 15,
  // The rocket's zones (zones.js).
  [ASH]: 0.01, [RED_SAND]: 0.01, [BASALT]: 0.05, [RED_CLAY]: 0.05, [PALE_CLAY]: 0.05, [DEEP_ROCK]: 0.05, [EMBER]: 0.1,
};

/// Everything earned in a zone (zones.js) is multiplied by its rate here: natural blocks and monsters alike, and a
/// bot's blocks too.
/// Deepvein is the 2x $MINE zone; the daily caps below still apply to the total (times the zone's capMul, zones.js).
export const ZONE_PAY = { home: 1, deep: 2, boss: 1, pvp: 1 };

/// Beating Cinderfall's boss pays this pool, shared by the signed-in players who hit it, by the damage each did
/// (through the same ledger and daily caps as everything else; each share gets its player's earn boost).
export const BOSS_POOL = 150;

/// Defeating a monster.
export const MOB_REWARDS = { mudling: 0.6, crawler: 0.8, rattler: 1, golem: 2.5 };

/// The most a player earns in a UTC day by their own play, across everything, before boosts: an NFT cap boost
/// (boosts.js) raises it by a percentage, and a zone's capMul (zones.js) multiplies it there. Each of the player's
/// autopilot bots (bots-rules.js) has a cap of its own, counted by its DEGEN's token id: this one, raised by that
/// DEGEN's cap boost (boosts.js dailyCap). What bots earn goes into the wallet's total but never uses up the player's
/// own cap. (The MiningSites contract has its own caps on what it pays out a day, per wallet and for everyone; this
/// one is the room's.)
export const DAILY_EARN_CAP = 300;

/// The most all players together earn in a UTC day, their bots included, boosts or not: once it's reached, nothing
/// more is counted until 00:00 UTC. It matches MiningSites' daily cap across everyone, so a day's earnings can always
/// be converted the same day; at this rate the 10.5M mining vault lasts at least 300 days.
export const WORLD_DAILY_CAP = 35_000;

/// The ledger's unit: 1 $MINE is UNIT of them. Every amount the room sends (earn, signedin, boost, bossreward,
/// botearn) is in these.
export const UNIT = 10_000;
export const toUnits = (mine) => Math.round(mine * UNIT);
/// $MINE wei (18 decimals) for an amount in units: vouchers are in wei.
export const unitsToWei = (units) => BigInt(units) * 10n ** 14n;
/// An amount in units, as $MINE for people to read (up to four decimals, as the ledger counts).
export const fmtMine = (units) => (units / UNIT).toLocaleString("en-US", { maximumFractionDigits: 4 });
