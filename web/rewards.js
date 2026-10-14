// What real activity in the game earns, in $MINE. Shared by the game (to show it) and the multiplayer room (which
// keeps the ledger and signs the vouchers). To pay for a new activity, or change a rate, edit this file, then deploy
// the room and the site. Nothing pays for holding or waiting: no auto yield farming.
//
// Earnings are counted in hundredths of a $MINE, so every amount here has at most two decimals.

import {
  GRASS, DIRT, STONE, SAND, GRAVEL, LOG, DARK_LOG, SNOW, SANDSTONE, CACTUS, COAL_ORE, IRON_ORE, GOLD_ORE, DIAMOND_ORE,
  MINE_ORE,
} from "./blocks.js";

/// Breaking a natural block (one the world was made with). Blocks players placed pay nothing when broken again.
/// Leaves and plants (grass tufts, flowers, ferns, mushrooms, berry bushes) pay nothing.
export const BLOCK_REWARDS = {
  [GRASS]: 0.1, [DIRT]: 0.1, [SAND]: 0.1, [GRAVEL]: 0.1, [SNOW]: 0.1, [CACTUS]: 0.1,
  [LOG]: 0.5, [DARK_LOG]: 0.5, [STONE]: 0.5, [SANDSTONE]: 0.5,
  [COAL_ORE]: 3, [IRON_ORE]: 8, [GOLD_ORE]: 20, [DIAMOND_ORE]: 60, [MINE_ORE]: 150,
};

/// Defeating a monster.
export const MOB_REWARDS = { mudling: 6, crawler: 8, rattler: 10, golem: 25 };

/// The most one wallet earns in a UTC day, across everything. (The MiningSites contract has its own caps on what
/// it pays out a day; this one is the room's.)
export const DAILY_EARN_CAP = 3000;

export const toCents = (mine) => Math.round(mine * 100);
/// $MINE wei for an amount in hundredths.
export const centsToWei = (cents) => BigInt(cents) * 10n ** 16n;
export const fmtMine = (cents) => (cents / 100).toLocaleString("en-US", { maximumFractionDigits: 2 });
