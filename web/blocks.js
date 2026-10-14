// Every block in the world and every item a player can hold. Shared by the game and the multiplayer room (no DOM
// here): the room uses the hardness to check that nobody breaks blocks faster than the best pickaxe allows.

export const AIR = 0, GRASS = 1, DIRT = 2, STONE = 3, COBBLE = 4, SAND = 5, GRAVEL = 6, LOG = 7, LEAVES = 8,
  PLANKS = 9, BEDROCK = 10, WATER = 11, COAL_ORE = 12, IRON_ORE = 13, GOLD_ORE = 14, DIAMOND_ORE = 15, MINE_ORE = 16,
  SNOW = 17, SANDSTONE = 18, GLASS = 19, BRICKS = 20, TORCH = 21, CACTUS = 22, LAMP = 23, ROOF = 24,
  TALL_GRASS = 25, FLOWER_YELLOW = 26, FLOWER_RED = 27, FLOWER_BLUE = 28, BERRY_BUSH = 29, RED_MUSHROOM = 30,
  BROWN_MUSHROOM = 31, DARK_LOG = 32, DARK_LEAVES = 33, PINE_LEAVES = 34, FERN = 35, DRY_SHRUB = 36;

// Items that aren't blocks start at 64, so an item id below 64 is the block it places.
export const STICK = 64, COAL = 65, IRON = 66, GOLD = 67, DIAMOND = 68, CRYSTAL = 69,
  APPLE = 70, BERRIES = 71, MUSHROOM_STEW = 72,
  WOOD_PICK = 80, STONE_PICK = 81, IRON_PICK = 82, DIAMOND_PICK = 83,
  WOOD_SWORD = 90, STONE_SWORD = 91, IRON_SWORD = 92, DIAMOND_SWORD = 93;

/// hardness: seconds-ish (see breakTime); tier: the pickaxe needed for a drop (0 hand, 1 wood, 2 stone, 3 iron);
/// tex: atlas tile names (top, side, bottom); light: how much it glows (0..1); leaves: a leafy block (apples, sticks);
/// plant: drawn as two crossed pictures, not a cube (walk through it, it breaks at a touch).
const B = (id, name, o = {}) => ({
  id, name, solid: true, opaque: true, cutout: false, liquid: false, hardness: 1, tier: 0, drop: id, light: 0,
  placeable: true, leaves: false, plant: false, ...o,
});
const PLANT = { solid: false, opaque: false, cutout: true, plant: true, hardness: 0 };
export const BLOCKS = [];
for (const b of [
  B(AIR, "Air", { solid: false, opaque: false, hardness: 0, drop: null, placeable: false }),
  B(GRASS, "Grass", { hardness: 0.6, drop: DIRT, tex: ["grass_top", "grass_side", "dirt"] }),
  B(DIRT, "Dirt", { hardness: 0.5, tex: ["dirt"] }),
  B(STONE, "Stone", { hardness: 1.5, tier: 1, drop: COBBLE, tex: ["stone"] }),
  B(COBBLE, "Cobblestone", { hardness: 2, tier: 1, tex: ["cobble"] }),
  B(SAND, "Sand", { hardness: 0.5, tex: ["sand"] }),
  B(GRAVEL, "Gravel", { hardness: 0.6, tex: ["gravel"] }),
  B(LOG, "Log", { hardness: 2, tex: ["log_top", "log_side", "log_top"] }),
  B(LEAVES, "Leaves", { opaque: false, cutout: true, leaves: true, hardness: 0.2, drop: null, tex: ["leaves"] }),
  B(PLANKS, "Planks", { hardness: 2, tex: ["planks"] }),
  B(BEDROCK, "Bedrock", { hardness: Infinity, drop: null, placeable: false, tex: ["bedrock"] }),
  B(WATER, "Water", { solid: false, opaque: false, liquid: true, hardness: Infinity, drop: null, placeable: false, tex: ["water"] }),
  B(COAL_ORE, "Coal ore", { hardness: 3, tier: 1, drop: COAL, placeable: false, tex: ["coal_ore"] }),
  B(IRON_ORE, "Iron ore", { hardness: 3, tier: 2, drop: IRON, placeable: false, tex: ["iron_ore"] }),
  B(GOLD_ORE, "Gold ore", { hardness: 3, tier: 3, drop: GOLD, placeable: false, tex: ["gold_ore"] }),
  B(DIAMOND_ORE, "Diamond ore", { hardness: 3, tier: 3, drop: DIAMOND, placeable: false, tex: ["diamond_ore"] }),
  B(MINE_ORE, "$MINE crystal ore", { hardness: 4, tier: 3, drop: CRYSTAL, placeable: false, light: 0.45, tex: ["mine_ore"] }),
  B(SNOW, "Snowy grass", { hardness: 0.6, drop: DIRT, tex: ["snow_top", "snow_side", "dirt"] }),
  B(SANDSTONE, "Sandstone", { hardness: 0.8, tier: 1, tex: ["sandstone"] }),
  B(GLASS, "Glass", { opaque: false, cutout: true, hardness: 0.3, drop: null, tex: ["glass"] }),
  B(BRICKS, "Stone bricks", { hardness: 2, tier: 1, tex: ["bricks"] }),
  B(TORCH, "Torch", { solid: false, opaque: false, cutout: true, hardness: 0.05, light: 1, tex: ["torch"] }),
  B(CACTUS, "Cactus", { opaque: false, cutout: true, hardness: 0.4, tex: ["cactus_top", "cactus_side", "cactus_top"] }),
  B(LAMP, "Crystal lamp", { hardness: 0.3, light: 1, tex: ["lamp"] }),
  B(ROOF, "Roof tiles", { hardness: 2, tier: 1, tex: ["roof"] }),
  B(TALL_GRASS, "Tall grass", { ...PLANT, drop: null, placeable: false, tex: ["tall_grass"] }),
  B(FLOWER_YELLOW, "Buttercup", { ...PLANT, tex: ["flower_yellow"] }),
  B(FLOWER_RED, "Firebloom", { ...PLANT, tex: ["flower_red"] }),
  B(FLOWER_BLUE, "Bluebell", { ...PLANT, tex: ["flower_blue"] }),
  B(BERRY_BUSH, "Berry bush", { ...PLANT, drop: null, placeable: false, tex: ["berry_bush"] }),
  B(RED_MUSHROOM, "Red mushroom", { ...PLANT, tex: ["red_mushroom"] }),
  B(BROWN_MUSHROOM, "Brown mushroom", { ...PLANT, tex: ["brown_mushroom"] }),
  B(DARK_LOG, "Dark log", { hardness: 2, tex: ["dark_log_top", "dark_log_side", "dark_log_top"] }),
  B(DARK_LEAVES, "Dark leaves", { opaque: false, cutout: true, leaves: true, hardness: 0.2, drop: null, tex: ["dark_leaves"] }),
  B(PINE_LEAVES, "Pine needles", { opaque: false, cutout: true, leaves: true, hardness: 0.2, drop: null, tex: ["pine_leaves"] }),
  B(FERN, "Fern", { ...PLANT, drop: null, placeable: false, tex: ["fern"] }),
  B(DRY_SHRUB, "Dry shrub", { ...PLANT, drop: null, placeable: false, tex: ["dry_shrub"] }),
]) BLOCKS[b.id] = b;

/// Pickaxes and swords: tier (what a pickaxe can harvest), speed (how fast it breaks blocks) and damage (per hit).
export const TOOLS = {
  [WOOD_PICK]: { kind: "pick", tier: 1, speed: 2 },
  [STONE_PICK]: { kind: "pick", tier: 2, speed: 4 },
  [IRON_PICK]: { kind: "pick", tier: 3, speed: 6 },
  [DIAMOND_PICK]: { kind: "pick", tier: 4, speed: 8 },
  [WOOD_SWORD]: { kind: "sword", damage: 4 },
  [STONE_SWORD]: { kind: "sword", damage: 5 },
  [IRON_SWORD]: { kind: "sword", damage: 6 },
  [DIAMOND_SWORD]: { kind: "sword", damage: 7 },
};
export const HAND_DAMAGE = 1;
export const BEST_SPEED = 8; // the diamond pickaxe
export const BEST_DAMAGE = 7; // the diamond sword

/// Seconds to break `block` holding `item`, and whether it drops anything.
export function breakTime(block, item) {
  const b = BLOCKS[block];
  const tool = TOOLS[item];
  const tier = tool?.kind === "pick" ? tool.tier : 0;
  const speed = tool?.kind === "pick" ? tool.speed : 1;
  if (b.tier > tier) return { seconds: b.hardness * 5, drops: false };
  return { seconds: (b.hardness * 1.5) / speed, drops: true };
}

/// The quickest anyone can break `block`: with the best pickaxe. The room refuses breaks faster than this.
export function fastestBreak(block) {
  return (BLOCKS[block].hardness * 1.5) / BEST_SPEED;
}

const ITEM_NAMES = {
  [STICK]: "Stick", [COAL]: "Coal", [IRON]: "Iron", [GOLD]: "Gold", [DIAMOND]: "Diamond", [CRYSTAL]: "$MINE crystal",
  [APPLE]: "Apple", [BERRIES]: "Berries", [MUSHROOM_STEW]: "Mushroom stew",
  [WOOD_PICK]: "Wooden pickaxe", [STONE_PICK]: "Stone pickaxe", [IRON_PICK]: "Iron pickaxe", [DIAMOND_PICK]: "Diamond pickaxe",
  [WOOD_SWORD]: "Wooden sword", [STONE_SWORD]: "Stone sword", [IRON_SWORD]: "Iron sword", [DIAMOND_SWORD]: "Diamond sword",
};
export function itemName(id) {
  return id < 64 ? BLOCKS[id]?.name ?? "?" : ITEM_NAMES[id] ?? "?";
}
export const isTool = (id) => !!TOOLS[id];
export const stackSize = (id) => (isTool(id) ? 1 : 64);

/// Food: the hunger points (out of 20) each one gives back when eaten.
export const FOODS = { [APPLE]: 4, [BERRIES]: 2, [MUSHROOM_STEW]: 8 };

/// What breaking `block` gives the player, as [[item, count], ...]. `canHarvest` is breakTime's `drops` (the tool was
/// good enough for the block's own drop); `rand` returns 0..1. Leaves sometimes give a stick, oak and dark leaves
/// sometimes an apple; a berry bush gives 1-3 berries.
export function dropsFor(block, rand = Math.random, canHarvest = true) {
  const b = BLOCKS[block];
  if (!b) return [];
  const out = [];
  if (canHarvest && b.drop !== null) out.push([b.drop, 1]);
  if (b.leaves) {
    if (rand() < 0.12) out.push([STICK, 1]);
    if ((block === LEAVES || block === DARK_LEAVES) && rand() < 0.05) out.push([APPLE, 1]);
  }
  if (block === BERRY_BUSH) out.push([BERRIES, 1 + Math.floor(rand() * 3)]);
  if (block === DRY_SHRUB && rand() < 0.3) out.push([STICK, 1]);
  return out;
}

/// Crafting: no grid, just a list of what you can make from what you hold.
export const RECIPES = [
  { out: PLANKS, n: 4, need: { [LOG]: 1 } },
  { out: PLANKS, n: 4, need: { [DARK_LOG]: 1 } },
  { out: STICK, n: 4, need: { [PLANKS]: 2 } },
  { out: TORCH, n: 4, need: { [COAL]: 1, [STICK]: 1 } },
  { out: WOOD_PICK, n: 1, need: { [PLANKS]: 3, [STICK]: 2 } },
  { out: STONE_PICK, n: 1, need: { [COBBLE]: 3, [STICK]: 2 } },
  { out: IRON_PICK, n: 1, need: { [IRON]: 3, [STICK]: 2 } },
  { out: DIAMOND_PICK, n: 1, need: { [DIAMOND]: 3, [STICK]: 2 } },
  { out: WOOD_SWORD, n: 1, need: { [PLANKS]: 2, [STICK]: 1 } },
  { out: STONE_SWORD, n: 1, need: { [COBBLE]: 2, [STICK]: 1 } },
  { out: IRON_SWORD, n: 1, need: { [IRON]: 2, [STICK]: 1 } },
  { out: DIAMOND_SWORD, n: 1, need: { [DIAMOND]: 2, [STICK]: 1 } },
  { out: BRICKS, n: 4, need: { [COBBLE]: 4 } },
  { out: GLASS, n: 2, need: { [SAND]: 2, [COAL]: 1 } },
  { out: SANDSTONE, n: 1, need: { [SAND]: 4 } },
  { out: LAMP, n: 2, need: { [CRYSTAL]: 1, [GLASS]: 1 } },
  { out: ROOF, n: 4, need: { [BRICKS]: 2, [DIRT]: 2 } },
  { out: MUSHROOM_STEW, n: 1, need: { [RED_MUSHROOM]: 1, [BROWN_MUSHROOM]: 1, [PLANKS]: 1 } },
];
