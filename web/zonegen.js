// The rocket's zones as worlds (zones.js): Deepvein, Cinderfall and Red Mesa. Like the home planet (worldgen.js),
// each is made from fixed seeds with integer hashing and plain arithmetic only, so the game and the world server agree
// on every block, and each wraps round every WORLD blocks. worldgen.js hands a zone's chunks and single blocks here.
//
// To keep "one block" (what the server checks) and "a whole chunk" (what the game draws) the same by construction,
// everything in a zone is decided by its own column: the ground (column + terrain, caves and ores included), what
// stands on it (`above`: plants, cacti, spires, one column each), and the built places (`structure`: the landing
// pad, Cinderfall's arena), which own their columns from bedrock to sky. tools/check-worldgen.mjs checks every zone.

import {
  AIR, GRASS, DIRT, STONE, GRAVEL, BEDROCK, WATER, COAL_ORE, IRON_ORE, GOLD_ORE, DIAMOND_ORE, MINE_ORE, SANDSTONE,
  BRICKS, CACTUS, LAMP, TALL_GRASS, FERN, DRY_SHRUB, BASALT, EMBER, ASH, RED_SAND, RED_CLAY, PALE_CLAY, DEEP_ROCK,
  GLOWCAP, PAD_PLATE,
} from "./blocks.js";
import { WORLD, CHUNK, HEIGHT, SEA, wrap, wrapDelta } from "./rules.js";
import { hash, rand, fade, mod, noise2, fbm2, noise3 } from "./noise.js";
import { ZONES, PAD_S, PAD_FLAT, BLEND, ARENA, PATH } from "./zones.js";

const CHUNKS = WORLD / CHUNK;
const index = (lx, y, lz) => (y << 8) | (lz << 4) | lx;
const dist = (x, z, cx, cz) => {
  const dx = wrapDelta(x - cx), dz = wrapDelta(z - cz);
  return Math.sqrt(dx * dx + dz * dz);
};
const clampH = (h) => Math.max(6, Math.min(HEIGHT - 12, Math.floor(h)));

/// Ores at home's rates, in `fill` rock; seeds `s` keep each zone's veins its own. `rich` (Deepvein): rare ores
/// `rich` times as common and found higher up, iron and coal less so (so the rock isn't all coal).
function ore(x, y, z, fill, s, rich = 1) {
  const cx = x >> 1, cy = y >> 1, cz = z >> 1, up = rich > 1 ? 1.5 : 1, mid = 1 + (rich - 1) / 2, low = 1 + (rich - 1) / 4;
  if (y < 16 * up && rand(cx, cy, cz, s + 21) < 0.004 * rich && rand(x, y, z, s + 31) < 0.55) return DIAMOND_ORE;
  if (y < 24 * up && rand(cx, cy, cz, s + 22) < 0.002 * rich && rand(x, y, z, s + 32) < 0.55) return MINE_ORE;
  if (y < 32 * up && rand(cx, cy, cz, s + 23) < 0.01 * rich && rand(x, y, z, s + 33) < 0.55) return GOLD_ORE;
  if (y < 64 * up && rand(cx, cy, cz, s + 24) < 0.03 * mid && rand(x, y, z, s + 34) < 0.6) return IRON_ORE;
  if (y < 110 && rand(cx, cy, cz, s + 25) < 0.05 * low && rand(x, y, z, s + 35) < 0.65) return COAL_ORE;
  return fill;
}
function bedrock(x, y, z, s) {
  return y === 0 || (y <= 2 && rand(x, y, z, s + 7) < (y === 1 ? 0.6 : 0.3));
}

// ---------------------------------------------------------------- the landing pad (every zone)

/// The pad's block at (dx, dz) from its middle (within PAD_S), height y: landing plates with a brick rim, a lamp set
/// in the rim at each side, and a lamp post at each corner, on the zone's own rock.
function padBlock(Z, dx, dz, y) {
  const py = Z.pad.y, ry = y - py, r2 = dx * dx + dz * dz;
  if (y === 0) return BEDROCK;
  if (ry < -3) return Z.rock;
  if (ry < 0) return Z.soil;
  if (ry === 0) {
    if (r2 <= 20) return PAD_PLATE;
    if (r2 <= 30) return (dx === 0 || dz === 0) && r2 === 25 ? LAMP : BRICKS;
    return Z.top;
  }
  if (Math.abs(dx) === 5 && Math.abs(dz) === 5) return ry <= 2 ? BRICKS : ry === 3 ? LAMP : AIR;
  return AIR;
}
const PAD_R2 = Math.floor(PAD_S * PAD_S);

// ---------------------------------------------------------------- Cinderfall's arena

/// The arena's block at (dx, dz) from its middle (within its wall), height y: a stone-brick floor with an ember ring
/// and an ember mark in the middle, a basalt wall with battlements and four gates (the south one faces the pad), and
/// a lamp-topped pillar either side of each gate.
const ARENA_R2 = ARENA.wall * ARENA.wall + 20;
function arenaBlock(dx, dz, y) {
  const ry = y - ARENA.y, r2 = dx * dx + dz * dz;
  if (y === 0) return BEDROCK;
  if (ry < 0) return BASALT;
  const wall = r2 > (ARENA.r + 0.5) ** 2;
  if (ry === 0) {
    if (wall) return BASALT;
    if (r2 <= 2) return EMBER;
    if (r2 >= 64 && r2 < 81 && ((dx + dz) & 1) === 0) return EMBER;
    return BRICKS;
  }
  if (!wall) return AIR;
  const ax = Math.abs(dx), az = Math.abs(dz);
  if ((ax === 3 && az >= ARENA.r) || (az === 3 && ax >= ARENA.r)) return ry <= 6 ? BASALT : ry === 7 ? LAMP : AIR;
  if (ax <= 2 || az <= 2) return AIR; // the gates
  if (ry <= 3) return BASALT;
  if (ry === 4) return ((dx + dz) & 1) === 0 ? BASALT : AIR;
  return AIR;
}

// ---------------------------------------------------------------- level ground round the built places

/// How far (x, z) is outside zone Z's level ground (0 or less: on it): round its pad, and in Cinderfall round the
/// arena and along the path between them.
function flatDist(Z, x, z) {
  let d = dist(x, z, Z.pad.x, Z.pad.z) - PAD_FLAT;
  if (Z.key === "boss") {
    d = Math.min(d, dist(x, z, ARENA.x, ARENA.z) - (ARENA.wall + 3));
    if (z >= ARENA.z && z <= Z.pad.z) d = Math.min(d, Math.abs(wrapDelta(x - ARENA.x)) - 4);
  }
  return d;
}
/// Height h brought down (or up) to the level ground's height y, the closer the more.
function flatten(h, d, y) {
  if (d >= BLEND) return h;
  const k = d <= 0 ? 0 : fade(d / BLEND);
  return y + (h - y) * k;
}

// ---------------------------------------------------------------- Deepvein: rock, caves and ore

const DS = ZONES.deep.seed;
function deepColumn(x, z) {
  const Z = ZONES.deep;
  const n = fbm2(x, z, 3, DS + 1, 4), hills = fbm2(x, z, 8, DS + 2, 3);
  const mask = noise2(x, z, 4, DS + 3), ridge = 1 - Math.abs(fbm2(x, z, 6, DS + 4, 3));
  let h = 64 + n * 14 + hills * 7;
  // Crags: ridged rock over half the planet, far steeper than home's mountains.
  if (mask > -0.05) h += (mask + 0.05) * ridge * ridge * 80;
  const d = flatDist(Z, x, z);
  h = clampH(flatten(h, d, Z.pad.y));
  const moss = noise2(x, z, 6, DS + 6) > 0.15 && h < 84; // grassy hollows
  const gravel = !moss && noise2(x, z, 16, DS + 7) > 0.22;
  return { h, d, moss, gravel, dark: !moss && !gravel && noise2(x, z, 20, DS + 9) > 0.18, deep: 40 + Math.floor(noise2(x, z, 12, DS + 8) * 8) };
}
/// Wide worm caves everywhere, and big caverns below 56.
function deepCave(x, y, z, h) {
  if (y < 5 || y > h || h <= SEA + 1) return false;
  const a = noise3(x, y, z, 24, 14, DS + 11), b = noise3(x, y, z, 24, 14, DS + 12);
  if (a * a + b * b < 0.02) return true;
  return y < 56 && noise3(x, y, z, 14, 18, DS + 13) > 0.44;
}
function deepTerrain(x, y, z, col) {
  if (bedrock(x, y, z, DS)) return BEDROCK;
  const h = col.h;
  if (y > h) return y <= SEA ? WATER : AIR;
  if (col.d > 2 && deepCave(x, y, z, h)) {
    // Glowcaps grow on cave floors and light the way.
    return !deepCave(x, y - 1, z, h) && rand(x, y, z, DS + 61) < 0.03 ? GLOWCAP : AIR;
  }
  // The top: grassy hollows, gravel and dark deep rock in patches, and bare stone where ore shows through.
  if (y === h) return h < SEA ? GRAVEL : col.moss ? GRASS : col.gravel ? GRAVEL : col.dark ? DEEP_ROCK : ore(x, y, z, STONE, DS, 3);
  if (y > h - 3 && col.moss) return DIRT;
  // Stone near the top, harder deep rock further down; ores in both, about three times as many as at home.
  return ore(x, y, z, y < col.deep ? DEEP_ROCK : STONE, DS, 3);
}
function deepAbove(x, z, col) {
  if (col.d <= 0 || col.h <= SEA + 1 || deepTerrain(x, col.h, z, col) !== GRASS) return null;
  const p = rand(x, 0, z, DS + 71);
  return p < 0.12 ? [TALL_GRASS] : p < 0.16 ? [FERN] : null;
}

// ---------------------------------------------------------------- Cinderfall: basalt, ash and fire

const BS = ZONES.boss.seed, CONE_CELL = 128, CONE_CELLS = WORLD / CONE_CELL;
/// Volcanoes: at most one in each 128 x 128 cell, none near the pad, the arena or the path.
const CONES = [];
for (let i = 0; i < CONE_CELLS; i++) for (let j = 0; j < CONE_CELLS; j++) {
  const r1 = hash(i, j, 0, BS + 51);
  let c = null;
  if (rand(i, j, 0, BS + 52) < 0.8) {
    c = { x: i * CONE_CELL + 24 + (r1 % 80), z: j * CONE_CELL + 24 + ((r1 >>> 8) % 80), r: 28 + ((r1 >>> 16) % 18), h: 24 + ((r1 >>> 22) % 28) };
    const P = ZONES.boss.pad;
    if (dist(c.x, c.z, P.x, P.z) < c.r + 40 || dist(c.x, c.z, ARENA.x, ARENA.z) < c.r + 40) c = null;
  }
  CONES[i * CONE_CELLS + j] = c;
}
function bossColumn(x, z) {
  const Z = ZONES.boss;
  const n = fbm2(x, z, 3, BS + 1, 4), hills = fbm2(x, z, 8, BS + 2, 3);
  let h = 61 + n * 9 + hills * 5, crater = false;
  // (A cone reaches less than a cell past its own, so the cells round this one are all that can reach it.)
  const ci = Math.floor(x / CONE_CELL), cj = Math.floor(z / CONE_CELL);
  for (let i = ci - 1; i <= ci + 1; i++) for (let j = cj - 1; j <= cj + 1; j++) {
    const c = CONES[mod(i, CONE_CELLS) * CONE_CELLS + mod(j, CONE_CELLS)];
    if (!c) continue;
    const d = dist(x, z, c.x, c.z);
    if (d >= c.r) continue;
    const t = 1 - d / c.r;
    h += c.h * t * Math.sqrt(t);
    const cr = c.r * 0.22;
    if (d < cr) { h -= (1 - d / cr) * 9; crater = true; }
  }
  const d = flatDist(Z, x, z);
  h = Math.max(SEA + 2, clampH(flatten(h, d, Z.pad.y)));
  const path = Math.abs(wrapDelta(x - ARENA.x)) <= PATH.half && z >= PATH.z0 && z <= PATH.z1;
  return {
    h, d, crater, path,
    fissure: Math.abs(noise2(x, z, 12, BS + 9)) < 0.02 && noise2(x, z, 3, BS + 10) > 0.1,
    ashy: hills + n * 0.5 > -0.12,
    deep: 30 + Math.floor(noise2(x, z, 12, BS + 8) * 6),
  };
}
function bossCave(x, y, z, h) {
  if (y < 5 || y > h) return false;
  const a = noise3(x, y, z, 20, 16, BS + 11), b = noise3(x, y, z, 20, 16, BS + 12);
  return a * a + b * b < 0.009;
}
function bossTerrain(x, y, z, col) {
  if (bedrock(x, y, z, BS)) return BEDROCK;
  const h = col.h;
  if (y > h) return y <= SEA ? WATER : AIR;
  if (col.d > 2 && !col.path && bossCave(x, y, z, h)) return AIR;
  if (y === h) {
    if (col.path) return BRICKS;
    if (col.crater) return rand(x, y, z, BS + 81) < 0.25 ? EMBER : BASALT; // a crater floor still glowing
    if (col.fissure) return EMBER; // cracks of fire across the plains
    return h > 92 || !col.ashy ? BASALT : ASH;
  }
  if (y > h - 3) return col.ashy && !col.crater ? ASH : BASALT;
  if (y > col.deep) return BASALT;
  return ore(x, y, z, STONE, BS);
}
function bossAbove(x, z, col) {
  if (col.d <= 0 || col.path) return null;
  const top = bossTerrain(x, col.h, z, col);
  const p = rand(x, 0, z, BS + 71);
  if (top === ASH && p < 0.012) return [DRY_SHRUB];
  if ((top === ASH || top === BASALT) && p > 0.996) {
    // A basalt spire with a glowing tip.
    const out = [];
    for (let k = 2 + (hash(x, 1, z, BS + 72) % 5); k > 0; k--) out.push(BASALT);
    out.push(EMBER);
    return out;
  }
  return null;
}

// ---------------------------------------------------------------- Red Mesa: terraced mesas and dry canyons

const MS = ZONES.pvp.seed;
// The clay bands up a mesa's side, bottom to top (they repeat).
const BANDS = [RED_CLAY, RED_CLAY, PALE_CLAY, RED_CLAY, SANDSTONE, RED_CLAY, PALE_CLAY, PALE_CLAY, RED_CLAY, RED_CLAY, SANDSTONE, PALE_CLAY];
function mesaColumn(x, z) {
  const Z = ZONES.pvp;
  const base = 55 + fbm2(x, z, 3, MS + 1, 4) * 6 + fbm2(x, z, 10, MS + 2, 2) * 2;
  const m = fbm2(x, z, 5, MS + 3, 3);
  let h = base;
  if (m > 0.04) h = Math.max(base, Math.floor((base + 7 + Math.min(34, (m - 0.04) * 150)) / 5) * 5); // terraces
  const rv = Math.abs(noise2(x, z, 6, MS + 5));
  if (m < 0 && rv < 0.04) h -= (0.04 - rv) * 90; // dry riverbeds
  const d = flatDist(Z, x, z);
  h = Math.max(SEA + 2, clampH(flatten(h, d, Z.pad.y)));
  const b = Math.floor(base);
  return { h, d, base: b, mesa: h >= b + 5, band: Math.floor(noise2(x, z, 4, MS + 6) * 4) };
}
function mesaCave(x, y, z, h) {
  if (y < 5 || y > h) return false;
  const a = noise3(x, y, z, 20, 16, MS + 11), b = noise3(x, y, z, 20, 16, MS + 12);
  if (a * a + b * b < 0.011) return true;
  return y < 40 && noise3(x, y, z, 13, 22, MS + 13) > 0.52;
}
function mesaTerrain(x, y, z, col) {
  if (bedrock(x, y, z, MS)) return BEDROCK;
  const h = col.h;
  if (y > h) return y <= SEA ? WATER : AIR;
  if (col.d > 2 && mesaCave(x, y, z, h)) return AIR;
  if (col.mesa && y > col.base - 3) return BANDS[mod(y + col.band, BANDS.length)];
  if (y > h - 2) return RED_SAND;
  if (y > h - 4) return SANDSTONE;
  if (y > h - 9) return RED_CLAY;
  return ore(x, y, z, STONE, MS);
}
function mesaAbove(x, z, col) {
  if (col.d <= 0) return null;
  const top = mesaTerrain(x, col.h, z, col);
  const p = rand(x, 0, z, MS + 71);
  if (top === RED_SAND) {
    if (p < 0.006) return Array(1 + (hash(x, 1, z, MS + 72) % 3)).fill(CACTUS);
    return p < 0.022 ? [DRY_SHRUB] : null;
  }
  return (top === RED_CLAY || top === PALE_CLAY) && p < 0.012 ? [DRY_SHRUB] : null;
}

// ---------------------------------------------------------------- the zones, as one interface

/// key -> { column, terrain, above, rock, soil, top } (rock, soil and top: what the pad stands on).
const GEN = {
  deep: { column: deepColumn, terrain: deepTerrain, above: deepAbove, rock: DEEP_ROCK, soil: STONE, top: STONE },
  boss: { column: bossColumn, terrain: bossTerrain, above: bossAbove, rock: BASALT, soil: ASH, top: ASH },
  pvp: { column: mesaColumn, terrain: mesaTerrain, above: mesaAbove, rock: RED_CLAY, soil: SANDSTONE, top: RED_SAND },
};
for (const [k, g] of Object.entries(GEN)) Object.assign(g, { key: k, pad: ZONES[k].pad, cache: new Map() });

/// Zone k's column at (x, z): { h (the ground's height), d (how far outside its level ground), ... }. Kept for a while
/// (the server asks about single blocks, several round each one broken); this changes nothing but the speed.
export function zoneColumn(k, x, z) {
  const g = GEN[k];
  x = wrap(x);
  z = wrap(z);
  const key = x * 4096 + z;
  let c = g.cache.get(key);
  if (!c) {
    if (g.cache.size > 16384) g.cache.clear();
    g.cache.set(key, (c = g.column(x, z)));
  }
  return c;
}

/// The built place owning column (x, z) (wrapped), if any: the pad, or Cinderfall's arena.
function structureAt(g, x, z) {
  const px = wrapDelta(x - g.pad.x), pz = wrapDelta(z - g.pad.z);
  if (px * px + pz * pz <= PAD_R2) return (y) => padBlock(g, px, pz, y);
  if (g.key === "boss") {
    const ax = wrapDelta(x - ARENA.x), az = wrapDelta(z - ARENA.z);
    if (ax * ax + az * az <= ARENA_R2) return (y) => arenaBlock(ax, az, y);
  }
  return null;
}

/// What was at (x, y, z) in zone k when it was made.
export function zoneBlock(k, x, y, z) {
  if (y < 0 || y >= HEIGHT) return AIR;
  const g = GEN[k];
  x = wrap(x);
  z = wrap(z);
  const s = structureAt(g, x, z);
  if (s) return s(y);
  const col = zoneColumn(k, x, z);
  if (y <= Math.max(col.h, SEA)) return g.terrain(x, y, z, col);
  const a = g.above(x, z, col);
  return a && y - col.h - 1 < a.length ? a[y - col.h - 1] : AIR;
}

/// A whole chunk of zone k, the same blocks zoneBlock gives one by one.
export function zoneChunk(k, cx, cz) {
  const g = GEN[k];
  cx = mod(cx, CHUNKS);
  cz = mod(cz, CHUNKS);
  const out = new Uint8Array(CHUNK * CHUNK * HEIGHT);
  for (let lz = 0; lz < CHUNK; lz++) {
    for (let lx = 0; lx < CHUNK; lx++) {
      const x = cx * CHUNK + lx, z = cz * CHUNK + lz;
      const s = structureAt(g, x, z);
      if (s) {
        for (let y = 0; y < HEIGHT; y++) out[index(lx, y, lz)] = s(y);
        continue;
      }
      const col = zoneColumn(k, x, z);
      const top = Math.max(col.h, SEA);
      for (let y = 0; y <= top; y++) out[index(lx, y, lz)] = g.terrain(x, y, z, col);
      const a = g.above(x, z, col);
      if (a) for (let i = 0; i < a.length && col.h + 1 + i < HEIGHT; i++) out[index(lx, col.h + 1 + i, lz)] = a[i];
    }
  }
  return out;
}

/// The top block of zone k's column (x, z) and its height, for the globe's picture (planet-map.js).
export function zoneSurface(k, x, z) {
  const g = GEN[k];
  x = wrap(x);
  z = wrap(z);
  const s = structureAt(g, x, z);
  if (s) {
    for (let y = HEIGHT - 1; y > 0; y--) { const b = s(y); if (b !== AIR) return { h: y, b }; }
  }
  const col = zoneColumn(k, x, z);
  if (col.h < SEA) return { h: SEA, b: WATER, depth: SEA - col.h };
  const a = g.above(x, z, col);
  const top = a && a[a.length - 1] === EMBER ? EMBER : g.terrain(x, col.h, z, col);
  if (top === AIR || top === GLOWCAP) {
    // A cave mouth: the rock at its bottom, in shadow.
    for (let y = col.h - 1; y > Math.max(0, col.h - 24); y--) {
      const b = g.terrain(x, y, z, col);
      if (b !== AIR && b !== GLOWCAP) return { h: col.h, b, cave: true };
    }
  }
  return { h: col.h, b: top };
}
