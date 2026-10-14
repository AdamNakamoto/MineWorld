// The world as it was made: terrain, biomes, caves, ores, trees, plants and the town, all from fixed seeds. The game draws chunks
// from it, and the multiplayer room asks it what a single block was (`naturalBlock`), so it can tell whether a
// broken block was really there and what it was worth. Both must agree exactly, so this file uses only integer
// hashing and plain arithmetic (no Math.random, sin or pow), which give the same answer in every JavaScript engine.
//
// The world is a small planet that wraps round in x and z (rules.js), so everything here repeats every WORLD blocks:
// every noise lattice has a whole number of cells across the world and its corners are hashed modulo that number,
// the tree and plant grids divide WORLD, and the per-block hashes take wrapped coordinates. naturalBlock wraps what
// it's given; generateChunk takes chunk numbers 0..CHUNKS-1 (others are wrapped too).

import {
  AIR, GRASS, DIRT, STONE, SAND, GRAVEL, LOG, LEAVES, PLANKS, BEDROCK, WATER, COAL_ORE, IRON_ORE, GOLD_ORE,
  DIAMOND_ORE, MINE_ORE, SNOW, SANDSTONE, GLASS, BRICKS, CACTUS, LAMP, ROOF, TALL_GRASS, FLOWER_YELLOW, FLOWER_RED,
  FLOWER_BLUE, BERRY_BUSH, RED_MUSHROOM, BROWN_MUSHROOM, DARK_LOG, DARK_LEAVES, PINE_LEAVES, FERN, DRY_SHRUB,
} from "./blocks.js";
import { WORLD, CHUNK, HEIGHT, SEA, TOWN, wrap, wrapDelta } from "./rules.js";
import { TOWN_R, TOWN_FLAT, TOWN_BLEND, townBlock } from "./town.js";

// ---------------------------------------------------------------- noise

function hash(x, y, z, s) {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(z | 0, 0x1b873593) ^ Math.imul(s, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return (h ^ (h >>> 15)) >>> 0;
}
const rand = (x, y, z, s) => hash(x, y, z, s) / 4294967296;
const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
const lerp = (a, b, t) => a + (b - a) * t;

const mod = (v, p) => ((v % p) + p) % p;

// Gradient noise that repeats every WORLD blocks in x and z: `p` lattice cells across the world (a whole number), at
// block (x, z). (x * p is a whole number and WORLD a power of two, so the lattice position is exact wherever x is
// written: x and x + WORLD land on the same cell at the same place in it.)
const G2 = [[1, 1], [-1, 1], [1, -1], [-1, -1], [1, 0], [-1, 0], [0, 1], [0, -1]];
function noise2(x, z, p, s) {
  const X = (x * p) / WORLD, Z = (z * p) / WORLD;
  const x0 = Math.floor(X), z0 = Math.floor(Z);
  const fx = X - x0, fz = Z - z0;
  const i0 = mod(x0, p), j0 = mod(z0, p);
  const i1 = i0 + 1 === p ? 0 : i0 + 1, j1 = j0 + 1 === p ? 0 : j0 + 1;
  const g = (ix, iz, dx, dz) => {
    const v = G2[hash(ix, iz, 0, s) & 7];
    return v[0] * dx + v[1] * dz;
  };
  const u = fade(fx), v = fade(fz);
  return lerp(
    lerp(g(i0, j0, fx, fz), g(i1, j0, fx - 1, fz), u),
    lerp(g(i0, j1, fx, fz - 1), g(i1, j1, fx - 1, fz - 1), u),
    v,
  );
}
/// Octaves of noise2, each with twice the cells of the last (so each still wraps).
function fbm2(x, z, p, s, octaves) {
  let sum = 0, amp = 1, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += noise2(x, z, p << i, s + i * 101) * amp;
    norm += amp;
    amp *= 0.5;
  }
  return sum / norm;
}

const G3 = [[1, 1, 0], [-1, 1, 0], [1, -1, 0], [-1, -1, 0], [1, 0, 1], [-1, 0, 1], [1, 0, -1], [-1, 0, -1],
  [0, 1, 1], [0, -1, 1], [0, 1, -1], [0, -1, -1], [1, 1, 0], [-1, 1, 0], [0, -1, 1], [0, -1, -1]];
/// 3D noise for caves: `p` cells across the world in x and z (wrapping as noise2), and one cell every `sy` blocks up.
function noise3(x, y, z, p, sy, s) {
  const X = (x * p) / WORLD, Y = y / sy, Z = (z * p) / WORLD;
  const x0 = Math.floor(X), y0 = Math.floor(Y), z0 = Math.floor(Z);
  const fx = X - x0, fy = Y - y0, fz = Z - z0;
  const i0 = mod(x0, p), k0 = mod(z0, p);
  const i1 = i0 + 1 === p ? 0 : i0 + 1, k1 = k0 + 1 === p ? 0 : k0 + 1;
  const g = (ix, iy, iz, dx, dy, dz) => {
    const v = G3[hash(ix, iy, iz, s) & 15];
    return v[0] * dx + v[1] * dy + v[2] * dz;
  };
  const u = fade(fx), v = fade(fy), w = fade(fz);
  return lerp(
    lerp(
      lerp(g(i0, y0, k0, fx, fy, fz), g(i1, y0, k0, fx - 1, fy, fz), u),
      lerp(g(i0, y0 + 1, k0, fx, fy - 1, fz), g(i1, y0 + 1, k0, fx - 1, fy - 1, fz), u),
      v,
    ),
    lerp(
      lerp(g(i0, y0, k1, fx, fy, fz - 1), g(i1, y0, k1, fx - 1, fy, fz - 1), u),
      lerp(g(i0, y0 + 1, k1, fx, fy - 1, fz - 1), g(i1, y0 + 1, k1, fx - 1, fy - 1, fz - 1), u),
      v,
    ),
    w,
  );
}

// ---------------------------------------------------------------- columns

export const PLAINS = 0, FOREST = 1, DESERT = 2, SNOWY = 3, PEAKS = 4, MEADOW = 5, DARK_FOREST = 6, TAIGA = 7,
  BEACH = 8;
export const BIOME_NAMES = ["Plains", "Forest", "Desert", "Snowy land", "Snowy peaks", "Flower meadow", "Dark forest",
  "Taiga", "Beach"];
const DARK_MIN = 120; // no dark forest (giant trees) this close to the town

/// How far (x, z) is from the town's centre, the short way round.
const townDist = (x, z) => {
  const dx = wrapDelta(x + 0.5 - TOWN.x), dz = wrapDelta(z + 0.5 - TOWN.z);
  return Math.sqrt(dx * dx + dz * dz);
};

// Feature sizes, as lattice cells across the world (WORLD / cells blocks each).
const TEMP_CELLS = 4, FOREST_CELLS = 6, DARK_CELLS = 5, MEADOW_CELLS = 8;
const LAND_CELLS = 3, HILL_CELLS = 8, MOUNTAIN_CELLS = 4, RIDGE_CELLS = 6, FLOWER_CELLS = 40;
const CAVE_CELLS = 20, CAVERN_CELLS = 13, SEA_CELLS = 5;
const MOUNTAIN_FROM = 0.08, MOUNTAIN_H = 130, SEA_FROM = -0.1, SEA_DEPTH = 70;

/// The biome the climate gives (x, z), `d` from the town, before height has its say (peaks, beaches).
function climate(x, z, d) {
  const temp = noise2(x, z, TEMP_CELLS, 5);
  if (d >= TOWN_BLEND && temp > 0.3) return DESERT;
  if (temp < -0.32) return SNOWY;
  if (temp < -0.17) return TAIGA;
  const f = noise2(x, z, FOREST_CELLS, 6);
  if (f > 0.05) return f > 0.19 && d >= DARK_MIN && noise2(x, z, DARK_CELLS, 9) > -0.1 ? DARK_FOREST : FOREST;
  return noise2(x, z, MEADOW_CELLS, 10) > 0.12 ? MEADOW : PLAINS;
}

/// The ground height and biome at (x, z), and how far it is from the town's centre.
export function column(x, z) {
  x = wrap(x);
  z = wrap(z);
  const n = fbm2(x, z, LAND_CELLS, 1, 4);
  const hills = fbm2(x, z, HILL_CELLS, 2, 3);
  const mask = noise2(x, z, MOUNTAIN_CELLS, 3);
  const ridge = 1 - Math.abs(fbm2(x, z, RIDGE_CELLS, 4, 3));
  let h = 56 + n * 16 + hills * 6;
  if (mask > MOUNTAIN_FROM) h += (mask - MOUNTAIN_FROM) * ridge * ridge * MOUNTAIN_H;
  // Seas: basins pressed down below the waterline, with beaches round them.
  const basin = noise2(x, z, SEA_CELLS, 8);
  if (basin < SEA_FROM) h -= (SEA_FROM - basin) * SEA_DEPTH;
  const d = townDist(x, z);
  if (d < TOWN_BLEND) {
    const k = d < TOWN_FLAT ? 0 : fade((d - TOWN_FLAT) / (TOWN_BLEND - TOWN_FLAT));
    h = TOWN.y + (h - TOWN.y) * k;
  }
  h = Math.floor(h);
  if (h < 6) h = 6;
  if (h > HEIGHT - 12) h = HEIGHT - 12;
  let biome;
  if (h > 96) biome = PEAKS;
  else {
    biome = climate(x, z, d);
    if (h <= SEA + 2 && biome !== DESERT && biome !== SNOWY) biome = BEACH;
  }
  return { h, biome, d };
}

// The room asks about single blocks (several around each one broken), so the columns and tree spots worked out are
// kept for a while. Every answer is the same however it's reached: this changes nothing but the speed.
const colCache = new Map();
function columnAt(x, z) {
  const k = x * 4096 + z;
  let c = colCache.get(k);
  if (!c) {
    if (colCache.size > 16384) colCache.clear();
    colCache.set(k, (c = column(x, z)));
  }
  return c;
}

function ore(x, y, z) {
  const cx = x >> 1, cy = y >> 1, cz = z >> 1;
  if (y < 16 && rand(cx, cy, cz, 21) < 0.004 && rand(x, y, z, 31) < 0.5) return DIAMOND_ORE;
  if (y < 24 && rand(cx, cy, cz, 22) < 0.002 && rand(x, y, z, 32) < 0.5) return MINE_ORE;
  if (y < 32 && rand(cx, cy, cz, 23) < 0.01 && rand(x, y, z, 33) < 0.5) return GOLD_ORE;
  if (y < 64 && rand(cx, cy, cz, 24) < 0.03 && rand(x, y, z, 34) < 0.6) return IRON_ORE;
  if (y < 110 && rand(cx, cy, cz, 25) < 0.05 && rand(x, y, z, 35) < 0.65) return COAL_ORE;
  return STONE;
}

function cave(x, y, z, h) {
  if (y < 5 || y > h || h <= SEA + 1) return false;
  const a = noise3(x, y, z, CAVE_CELLS, 16, 11), b = noise3(x, y, z, CAVE_CELLS, 16, 12);
  if (a * a + b * b < 0.011) return true;
  return y < 40 && noise3(x, y, z, CAVERN_CELLS, 22, 13) > 0.52;
}

/// The block at (x, y, z) from the ground alone (no trees, no town).
export function terrainBlock(x, y, z, col) {
  if (y === 0) return BEDROCK;
  if (y <= 2 && rand(x, y, z, 7) < (y === 1 ? 0.6 : 0.3)) return BEDROCK;
  const { h, biome } = col;
  if (y > h) return y <= SEA ? WATER : AIR;
  if (col.d > TOWN_FLAT - 2 && cave(x, y, z, h)) return AIR;
  if (y === h) {
    if (h < SEA) return h >= SEA - 3 ? SAND : GRAVEL;
    if (h <= SEA + 1 || biome === DESERT || biome === BEACH) return SAND;
    if (biome === SNOWY || biome === PEAKS) return SNOW;
    return GRASS;
  }
  if (y > h - 4) {
    if (biome === DESERT) return y > h - 3 ? SAND : SANDSTONE;
    if (h <= SEA + 1 || biome === BEACH) return SAND;
    if (biome === PEAKS) return STONE;
    return DIRT;
  }
  return ore(x, y, z);
}

// ---------------------------------------------------------------- trees, cacti and plants

const OAK = 0, PINE = 1, CACTUS_PLANT = 2, GIANT = 3;
const TRUNK = new Uint8Array(256);
TRUNK[LOG] = TRUNK[DARK_LOG] = TRUNK[CACTUS] = 1;

// Small trees: at most one in each 4 x 4 cell (WORLD / 4 cells a side, so the grid wraps), somewhere in its first 3 x 3.
// What grows there, and how likely, by biome.
const CELL = 4, CELLS = WORLD / CELL;
const SMALL_REACH = 3; // the furthest a small tree's leaves reach from its trunk (a big pine's lowest ring)
const SMALL = [];
SMALL[FOREST] = [OAK, 0.35]; SMALL[PLAINS] = [OAK, 0.04]; SMALL[MEADOW] = [OAK, 0.016]; SMALL[DARK_FOREST] = [OAK, 0.13];
SMALL[SNOWY] = [PINE, 0.09]; SMALL[TAIGA] = [PINE, 0.27]; SMALL[PEAKS] = [PINE, 0.032]; SMALL[DESERT] = [CACTUS_PLANT, 0.04];
const SMALL_MAX = 0.35, PEAK_CHANCE = 0.032;

/// Cell (i, j) of a grid with `n` cells a side, from a tree finder that works on cells 0..n-1: the same tree wherever
/// the grid is entered, moved to the side of the seam the caller is on (so a tree near x = 0 reaches over to 511).
function wrappedCell(find, n, size, i, j) {
  const wi = mod(i, n), wj = mod(j, n);
  const t = find(wi, wj);
  if (!t || (wi === i && wj === j)) return t;
  return { ...t, x: t.x + (i - wi) * size, z: t.z + (j - wj) * size };
}

const treeCache = new Map();
/// The small tree (or cactus) whose cell is (i, j), if it has one: { kind, x, z, base, height, lo, top }.
function treeIn(i, j) {
  const k = i * 4096 + j;
  let t = treeCache.get(k);
  if (t === undefined) {
    if (treeCache.size > 16384) treeCache.clear();
    treeCache.set(k, (t = findTree(i, j)));
  }
  return t;
}
function findTree(i, j) {
  const r = hash(i, j, 0, 41), at = hash(i, j, 0, 45);
  const x = i * CELL + ((at & 255) % 3), z = j * CELL + (((at >>> 8) & 255) % 3);
  const p = rand(i, j, 0, 42);
  if (p > SMALL_MAX) return null;
  const d = townDist(x, z);
  if (d < TOWN_FLAT + 4) return null;
  // The climate alone rules most cells out before the (slower) height is worked out. Height can only turn a spot into
  // peaks or a beach, so the chance here is never below the real one.
  const c = SMALL[climate(x, z, d)];
  if (p > Math.max(c ? c[1] : 0, PEAK_CHANCE)) return null;
  const col = columnAt(x, z);
  if (col.h <= SEA + 1) return null;
  const grow = SMALL[col.biome];
  if (!grow || p > grow[1]) return null;
  const top = terrainBlock(x, col.h, z, col);
  const base = col.h;
  if (grow[0] === CACTUS_PLANT) {
    if (top !== SAND) return null;
    const height = 1 + ((r >> 4) % 3);
    return { kind: CACTUS_PLANT, x, z, base, height, lo: base + 1, top: base + height };
  }
  if (top !== GRASS && top !== SNOW) return null;
  if (grow[0] === PINE) {
    const height = 6 + ((r >>> 4) % 5);
    return { kind: PINE, x, z, base, height, lo: base + 1, top: base + height + 1 };
  }
  // (r >> 4 can be negative, so some oaks are only 2 or 3 tall, their leaves reaching the ground: bushes.)
  const height = 4 + ((r >> 4) % 3);
  return { kind: OAK, x, z, base, height, lo: base + Math.min(1, height - 2), top: base + height + 1 };
}

/// An oak: a short trunk and a rounded crown (the first trees this world had, unchanged).
function oakBlock(t, x, y, z) {
  const dy = y - t.base;
  if (x === t.x && z === t.z && dy >= 1 && dy <= t.height) return LOG;
  const ly = dy - t.height; // leaves from top-2 to top+1
  if (ly < -2 || ly > 1) return AIR;
  const ax = Math.abs(x - t.x), az = Math.abs(z - t.z);
  const r = ly <= -1 ? 2 : 1;
  if (ax > r || az > r) return AIR;
  // Knock off some corners so the crowns aren't perfect cubes.
  if (ax === r && az === r && (ly === 1 || rand(x, y, z, 43) < 0.5)) return AIR;
  return LEAVES;
}

/// A pine: a tall trunk in a cone of needles, ring over ring, each wide ring with a narrower one above it.
function pineBlock(t, x, y, z) {
  const dy = y - t.base;
  if (x === t.x && z === t.z && dy >= 1 && dy <= t.height) return LOG;
  const ly = t.height + 1 - dy; // 0 at the tip
  if (ly < 0 || dy < 2) return AIR;
  const ax = x - t.x, az = z - t.z, d2 = ax * ax + az * az;
  let r2;
  if (ly <= 1) r2 = ly;
  else {
    const maxR = t.height >= 9 ? 3 : 2;
    const level = Math.min(maxR, (ly + 1) >> 1);
    const wide = (t.height - 1 - ly) % 2 === 0; // the lowest ring is a wide one
    const r = wide ? level : level - 1;
    r2 = Math.max(1, r * r + r);
  }
  if (d2 > r2) return AIR;
  if (d2 === r2 && d2 > 1 && rand(x, y, z, 44) < 0.35) return AIR;
  return PINE_LEAVES;
}

function smallBlock(t, x, y, z) {
  if (t.kind === OAK) return oakBlock(t, x, y, z);
  if (t.kind === PINE) return pineBlock(t, x, y, z);
  return x === t.x && z === t.z && y > t.base && y <= t.base + t.height ? CACTUS : AIR;
}

// Giant trees grow only in the dark forest: at most one in each 8 x 8 cell (the grid wraps), a 2 x 2 trunk of dark
// wood 14-22 tall under a wide, flat crown of dark leaves, with a few branches.
const GCELL = 8, GCELLS = WORLD / GCELL;
const GIANT_CHANCE = 0.42;
const GIANT_REACH_LO = 6, GIANT_REACH_HI = 7; // its crown spans x - 6 .. x + 7 (the trunk is x, x + 1)
const giantCache = new Map();
function giantIn(i, j) {
  const k = i * 4096 + j;
  let t = giantCache.get(k);
  if (t === undefined) {
    if (giantCache.size > 16384) giantCache.clear();
    giantCache.set(k, (t = findGiant(i, j)));
  }
  return t;
}
function findGiant(i, j) {
  const r = hash(i, j, 0, 51);
  const x = i * GCELL + 2 + (r % 5), z = j * GCELL + 2 + ((r >>> 3) % 5); // the trunk stays in its cell (2..7)
  if (rand(i, j, 0, 52) > GIANT_CHANCE) return null;
  const d = townDist(x, z);
  if (d < DARK_MIN || climate(x, z, d) !== DARK_FOREST) return null;
  const col = columnAt(x, z);
  if (col.biome !== DARK_FOREST || terrainBlock(x, col.h, z, col) !== GRASS) return null;
  const height = 14 + ((r >>> 6) % 9);
  const base = col.h;
  // Branches: up to four, one per side, from just under the crown.
  return { kind: GIANT, x, z, base, height, wide: 5 + ((r >>> 10) & 1), branches: (r >>> 12) & 15, lo: base - 6, top: base + height + 2 };
}

function giantBlock(t, x, y, z) {
  const ix = x - t.x, iz = z - t.z;
  const ly = y - t.base - t.height; // 0 at the top of the trunk
  if (ix >= 0 && ix <= 1 && iz >= 0 && iz <= 1) return ly <= 0 && y >= t.lo ? DARK_LOG : ly <= 2 ? DARK_LEAVES : AIR;
  if (ly < -4 || ly > 2) return AIR;
  // Branches reach out three blocks from the trunk, two or three below its top.
  if (ly === -3 || ly === -2) {
    const b = t.branches;
    const side = ly === -3 ? 0 : 1; // alternate sides at alternate heights
    if ((b & 1) && side === 0 && ix >= 2 && ix <= 4 && iz === 0) return DARK_LOG;
    if ((b & 2) && side === 0 && ix <= -1 && ix >= -3 && iz === 1) return DARK_LOG;
    if ((b & 4) && side === 1 && iz >= 2 && iz <= 4 && ix === 1) return DARK_LOG;
    if ((b & 8) && side === 1 && iz <= -1 && iz >= -3 && ix === 0) return DARK_LOG;
  }
  if (ly < -3) return AIR;
  // The crown, in half blocks from the trunk's middle (so the sums stay whole numbers).
  const ex = 2 * ix - 1, ez = 2 * iz - 1, d2 = ex * ex + ez * ez;
  const w = t.wide;
  const R = ly === 2 ? 5 : ly === 1 ? 2 * w - 3 : ly >= -1 ? 2 * w + 1 : ly === -2 ? 2 * w - 1 : 2 * w - 5;
  if (d2 > R * R) return AIR;
  if (d2 > (R - 2) * (R - 2) && rand(x, y, z, 53) < 0.4) return AIR; // a ragged edge
  return DARK_LEAVES;
}

const treeBlock = (t, x, y, z) => (t.kind === GIANT ? giantBlock(t, x, y, z) : smallBlock(t, x, y, z));
/// The lowest block tree `t` can put in column (x, z) (only its trunk goes all the way down).
function treeBottom(t, x, z) {
  if (t.kind === GIANT) return x - t.x >= 0 && x - t.x <= 1 && z - t.z >= 0 && z - t.z <= 1 ? t.lo : t.base + t.height - 3;
  if (x === t.x && z === t.z) return t.lo;
  return t.kind === OAK ? t.base + t.height - 2 : t.base + 2;
}
const reachLo = (t) => (t.kind === GIANT ? GIANT_REACH_LO : t.kind === CACTUS_PLANT ? 0 : t.kind === OAK ? 2 : SMALL_REACH);
const reachHi = (t) => (t.kind === GIANT ? GIANT_REACH_HI : t.kind === CACTUS_PLANT ? 0 : t.kind === OAK ? 2 : SMALL_REACH);

/// Trees that could reach the box [x0, x1] x [z0, z1]: the giants first, then the small ones, each in cell order (the
/// order decides overlaps, so it must be the same for a whole chunk and for a single block).
/// Trees that could reach the box [x0, x1] x [z0, z1]: the giants first, then the small ones, each in cell order (the
/// order decides overlaps, so it must be the same for a whole chunk and for a single block). Cells past the seam are
/// the ones from the other side, moved over (wrappedCell), so a box at the edge sees the trees across it.
function treesNear(x0, z0, x1, z1) {
  const out = [];
  for (let i = Math.floor((x0 - GIANT_REACH_HI - 7) / GCELL); i <= Math.floor((x1 + GIANT_REACH_LO - 2) / GCELL); i++) {
    for (let j = Math.floor((z0 - GIANT_REACH_HI - 7) / GCELL); j <= Math.floor((z1 + GIANT_REACH_LO - 2) / GCELL); j++) {
      const t = wrappedCell(giantIn, GCELLS, GCELL, i, j);
      if (t && t.x + GIANT_REACH_HI >= x0 && t.x - GIANT_REACH_LO <= x1 && t.z + GIANT_REACH_HI >= z0 && t.z - GIANT_REACH_LO <= z1) out.push(t);
    }
  }
  for (let i = Math.floor((x0 - SMALL_REACH - 2) / CELL); i <= Math.floor((x1 + SMALL_REACH) / CELL); i++) {
    for (let j = Math.floor((z0 - SMALL_REACH - 2) / CELL); j <= Math.floor((z1 + SMALL_REACH) / CELL); j++) {
      const t = wrappedCell(treeIn, CELLS, CELL, i, j);
      if (t && t.x + reachHi(t) >= x0 && t.x - reachLo(t) <= x1 && t.z + reachHi(t) >= z0 && t.z - reachLo(t) <= z1) out.push(t);
    }
  }
  return out;
}

/// Where trees overlap, the first trunk (in treesNear's order) wins, and otherwise the last leaves.
function treeAt(trees, x, y, z) {
  let leaves = AIR;
  for (const t of trees) {
    if (y > t.top || y < t.lo) continue;
    const b = treeBlock(t, x, y, z);
    if (b === AIR) continue;
    if (TRUNK[b]) return b;
    leaves = b;
  }
  return leaves;
}

// Plants on the ground: grass tufts, flowers, ferns, mushrooms and berry bushes, by biome. Each row is the chance of
// each kind on a grassy spot (a flower's colour is picked separately).
const FLOWER = -1;
const GROUND = [];
GROUND[MEADOW] = [[FLOWER, 0.2], [TALL_GRASS, 0.26], [BERRY_BUSH, 0.008]];
GROUND[PLAINS] = [[TALL_GRASS, 0.3], [FLOWER, 0.03], [BERRY_BUSH, 0.006]];
GROUND[FOREST] = [[TALL_GRASS, 0.14], [FERN, 0.07], [FLOWER, 0.015], [RED_MUSHROOM, 0.01], [BROWN_MUSHROOM, 0.012], [BERRY_BUSH, 0.01]];
GROUND[DARK_FOREST] = [[FERN, 0.1], [TALL_GRASS, 0.05], [RED_MUSHROOM, 0.025], [BROWN_MUSHROOM, 0.035]];
GROUND[TAIGA] = [[FERN, 0.14], [TALL_GRASS, 0.08], [BERRY_BUSH, 0.025], [BROWN_MUSHROOM, 0.01]];
const GROUND_ALL = GROUND.map((row) => row && row.reduce((t, [, p]) => t + p, 0));

/// What grows on the ground at (x, z) (on top of column `col`, at col.h + 1), if anything.
function groundPlant(x, z, col) {
  const { h, biome } = col;
  if (h <= SEA + 1 || col.d < TOWN_FLAT + 4) return AIR;
  const p = rand(x, 0, z, 71);
  if (biome === DESERT) return p < 0.012 && terrainBlock(x, h, z, col) === SAND ? DRY_SHRUB : AIR;
  const row = GROUND[biome];
  if (!row || p >= GROUND_ALL[biome] || terrainBlock(x, h, z, col) !== GRASS) return AIR;
  let sum = 0;
  for (const [kind, chance] of row) {
    sum += chance;
    if (p >= sum) continue;
    if (kind !== FLOWER) return kind;
    // Flowers grow in patches of one colour, with a few strays.
    const q = rand(x, 1, z, 72);
    if (q < 0.15) return q < 0.05 ? FLOWER_RED : q < 0.1 ? FLOWER_BLUE : FLOWER_YELLOW;
    const n = noise2(x, z, FLOWER_CELLS, 73);
    return n < -0.12 ? FLOWER_RED : n > 0.14 ? FLOWER_BLUE : FLOWER_YELLOW;
  }
  return AIR;
}

// ---------------------------------------------------------------- the town
// The town (its buildings, roads and how far the land is flattened round it) lives in town.js.
export { TOWN_R, OFFICE, townBlock } from "./town.js";

// ---------------------------------------------------------------- the world

/// What was at (x, y, z) when the world was made. The room uses this for single blocks.
export function naturalBlock(x, y, z) {
  if (y < 0 || y >= HEIGHT) return AIR;
  x = wrap(x);
  z = wrap(z);
  const t = townBlock(x, y, z);
  if (t >= 0) return t;
  const col = columnAt(x, z);
  const b = terrainBlock(x, y, z, col);
  if (b !== AIR || y <= col.h) return b;
  const tree = treeAt(treesNear(x, z, x, z), x, y, z);
  if (tree !== AIR) return tree;
  return y === col.h + 1 ? groundPlant(x, z, col) : AIR;
}

export const index = (lx, y, lz) => (y << 8) | (lz << 4) | lx;

/// A whole chunk (16 x 128 x 16), the same blocks naturalBlock gives one by one. (cx, cz) wrap: chunk -1 is chunk
/// CHUNKS - 1.
export function generateChunk(cx, cz) {
  cx = mod(cx, CHUNKS);
  cz = mod(cz, CHUNKS);
  const out = new Uint8Array(CHUNK * CHUNK * HEIGHT);
  const x0 = cx * CHUNK, z0 = cz * CHUNK;
  const cols = [];
  for (let lz = 0; lz < CHUNK; lz++) {
    for (let lx = 0; lx < CHUNK; lx++) {
      const x = x0 + lx, z = z0 + lz;
      const tdx = wrapDelta(x - TOWN.x), tdz = wrapDelta(z - TOWN.z);
      if (tdx * tdx + tdz * tdz <= TOWN_R * TOWN_R) {
        for (let y = 0; y < HEIGHT; y++) out[index(lx, y, lz)] = townBlock(x, y, z);
        continue;
      }
      const col = column(x, z);
      cols[lz * CHUNK + lx] = col;
      const top = Math.max(col.h, SEA);
      for (let y = 0; y <= top; y++) out[index(lx, y, lz)] = terrainBlock(x, y, z, col);
    }
  }
  // Trees, in treesNear's order: a trunk stays where it's put, leaves give way to later leaves (as treeAt decides).
  for (const t of treesNear(x0, z0, x0 + CHUNK - 1, z0 + CHUNK - 1)) {
    const ax = Math.max(x0, t.x - reachLo(t)), bx = Math.min(x0 + CHUNK - 1, t.x + reachHi(t));
    const az = Math.max(z0, t.z - reachLo(t)), bz = Math.min(z0 + CHUNK - 1, t.z + reachHi(t));
    for (let x = ax; x <= bx; x++) {
      for (let z = az; z <= bz; z++) {
        const lx = x - x0, lz = z - z0;
        const col = cols[lz * CHUNK + lx];
        if (!col) continue; // the town
        const y1 = Math.min(t.top, HEIGHT - 1);
        for (let y = Math.max(Math.max(col.h, SEA) + 1, treeBottom(t, x, z)); y <= y1; y++) {
          const i = index(lx, y, lz);
          if (TRUNK[out[i]]) continue;
          const b = treeBlock(t, x, y, z);
          if (b !== AIR) out[i] = b;
        }
      }
    }
  }
  // Then the plants on the ground, wherever a tree left room.
  for (let lz = 0; lz < CHUNK; lz++) {
    for (let lx = 0; lx < CHUNK; lx++) {
      const col = cols[lz * CHUNK + lx];
      if (!col || col.h + 1 >= HEIGHT) continue;
      const i = index(lx, col.h + 1, lz);
      if (out[i] === AIR) out[i] = groundPlant(x0 + lx, z0 + lz, col);
    }
  }
  return out;
}

export const CHUNKS = WORLD / CHUNK;
export { rand };
