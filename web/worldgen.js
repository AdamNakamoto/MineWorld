// The world as it was made: terrain, caves, ores, trees and the town, all from fixed seeds. The game draws chunks
// from it, and the multiplayer room asks it what a single block was (`naturalBlock`), so it can tell whether a
// broken block was really there and what it was worth. Both must agree exactly, so this file uses only integer
// hashing and plain arithmetic (no Math.random, sin or pow), which give the same answer in every JavaScript engine.

import {
  AIR, GRASS, DIRT, STONE, SAND, GRAVEL, LOG, LEAVES, PLANKS, BEDROCK, WATER, COAL_ORE, IRON_ORE, GOLD_ORE,
  DIAMOND_ORE, MINE_ORE, SNOW, SANDSTONE, GLASS, BRICKS, CACTUS, LAMP, ROOF,
} from "./blocks.js";
import { WORLD, CHUNK, HEIGHT, SEA, TOWN, inWorld } from "./rules.js";

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

const G2 = [[1, 1], [-1, 1], [1, -1], [-1, -1], [1, 0], [-1, 0], [0, 1], [0, -1]];
function noise2(x, z, s) {
  const x0 = Math.floor(x), z0 = Math.floor(z);
  const fx = x - x0, fz = z - z0;
  const g = (ix, iz, dx, dz) => {
    const v = G2[hash(ix, iz, 0, s) & 7];
    return v[0] * dx + v[1] * dz;
  };
  const u = fade(fx), v = fade(fz);
  return lerp(
    lerp(g(x0, z0, fx, fz), g(x0 + 1, z0, fx - 1, fz), u),
    lerp(g(x0, z0 + 1, fx, fz - 1), g(x0 + 1, z0 + 1, fx - 1, fz - 1), u),
    v,
  );
}
function fbm2(x, z, s, octaves) {
  let sum = 0, amp = 1, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += noise2(x, z, s + i * 101) * amp;
    norm += amp;
    amp *= 0.5;
    x *= 2;
    z *= 2;
  }
  return sum / norm;
}

const G3 = [[1, 1, 0], [-1, 1, 0], [1, -1, 0], [-1, -1, 0], [1, 0, 1], [-1, 0, 1], [1, 0, -1], [-1, 0, -1],
  [0, 1, 1], [0, -1, 1], [0, 1, -1], [0, -1, -1], [1, 1, 0], [-1, 1, 0], [0, -1, 1], [0, -1, -1]];
function noise3(x, y, z, s) {
  const x0 = Math.floor(x), y0 = Math.floor(y), z0 = Math.floor(z);
  const fx = x - x0, fy = y - y0, fz = z - z0;
  const g = (ix, iy, iz, dx, dy, dz) => {
    const v = G3[hash(ix, iy, iz, s) & 15];
    return v[0] * dx + v[1] * dy + v[2] * dz;
  };
  const u = fade(fx), v = fade(fy), w = fade(fz);
  return lerp(
    lerp(
      lerp(g(x0, y0, z0, fx, fy, fz), g(x0 + 1, y0, z0, fx - 1, fy, fz), u),
      lerp(g(x0, y0 + 1, z0, fx, fy - 1, fz), g(x0 + 1, y0 + 1, z0, fx - 1, fy - 1, fz), u),
      v,
    ),
    lerp(
      lerp(g(x0, y0, z0 + 1, fx, fy, fz - 1), g(x0 + 1, y0, z0 + 1, fx - 1, fy, fz - 1), u),
      lerp(g(x0, y0 + 1, z0 + 1, fx, fy - 1, fz - 1), g(x0 + 1, y0 + 1, z0 + 1, fx - 1, fy - 1, fz - 1), u),
      v,
    ),
    w,
  );
}

// ---------------------------------------------------------------- columns

export const PLAINS = 0, FOREST = 1, DESERT = 2, SNOWY = 3, PEAKS = 4;
const TOWN_FLAT = 22; // the town's ground is level out to here
const TOWN_BLEND = 46; // and blends into the land by here

/// The ground height and biome at (x, z).
export function column(x, z) {
  const n = fbm2(x / 220, z / 220, 1, 4);
  const hills = fbm2(x / 64, z / 64, 2, 3);
  const mask = noise2(x / 300, z / 300, 3);
  const ridge = 1 - Math.abs(fbm2(x / 90, z / 90, 4, 3));
  let h = 56 + n * 16 + hills * 6;
  if (mask > 0.12) h += (mask - 0.12) * ridge * ridge * 110;
  const temp = noise2(x / 380, z / 380, 5);
  const dx = x + 0.5 - TOWN.x, dz = z + 0.5 - TOWN.z;
  const d = Math.sqrt(dx * dx + dz * dz);
  if (d < TOWN_BLEND) {
    const k = d < TOWN_FLAT ? 0 : fade((d - TOWN_FLAT) / (TOWN_BLEND - TOWN_FLAT));
    h = TOWN.y + (h - TOWN.y) * k;
  }
  h = Math.floor(h);
  if (h < 6) h = 6;
  if (h > HEIGHT - 12) h = HEIGHT - 12;
  let biome;
  if (h > 96) biome = PEAKS;
  else if (d >= TOWN_BLEND && temp > 0.3) biome = DESERT;
  else if (temp < -0.32) biome = SNOWY;
  else biome = noise2(x / 120, z / 120, 6) > 0.05 ? FOREST : PLAINS;
  return { h, biome, d };
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
  const a = noise3(x / 26, y / 16, z / 26, 11), b = noise3(x / 26, y / 16, z / 26, 12);
  if (a * a + b * b < 0.011) return true;
  return y < 40 && noise3(x / 40, y / 22, z / 40, 13) > 0.52;
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
    if (h <= SEA + 1 || biome === DESERT) return SAND;
    if (biome === SNOWY || biome === PEAKS) return SNOW;
    return GRASS;
  }
  if (y > h - 4) {
    if (biome === DESERT) return y > h - 3 ? SAND : SANDSTONE;
    if (h <= SEA + 1) return SAND;
    if (biome === PEAKS) return STONE;
    return DIRT;
  }
  return ore(x, y, z);
}

// ---------------------------------------------------------------- trees and cacti

const CELL = 5;
/// The tree (or cactus) whose cell is (i, j), if it has one: { x, z, base, height, cactus }.
function plantIn(i, j) {
  const r = hash(i, j, 0, 41);
  const x = i * CELL + (r & 3), z = j * CELL + ((r >> 2) & 3);
  if (!inWorld(x, z)) return null;
  const col = column(x, z);
  if (col.d < TOWN_FLAT + 4 || col.h <= SEA + 1) return null;
  const p = rand(i, j, 0, 42);
  if (col.biome === DESERT) {
    if (p > 0.06 || terrainBlock(x, col.h, z, col) !== SAND) return null;
    return { x, z, base: col.h, height: 1 + ((r >> 4) % 3), cactus: true };
  }
  const chance = col.biome === FOREST ? 0.55 : col.biome === PLAINS ? 0.06 : col.biome === SNOWY ? 0.12 : 0;
  if (p > chance) return null;
  const top = terrainBlock(x, col.h, z, col);
  if (top !== GRASS && top !== SNOW) return null;
  return { x, z, base: col.h, height: 4 + ((r >> 4) % 3), cactus: false };
}

/// What tree `t` puts at (x, y, z): LOG, LEAVES, CACTUS or AIR.
function plantBlock(t, x, y, z) {
  const dy = y - t.base;
  if (x === t.x && z === t.z && dy >= 1 && dy <= t.height) return t.cactus ? CACTUS : LOG;
  if (t.cactus) return AIR;
  const top = t.height; // leaves from top-2 to top+1
  const ly = dy - top;
  if (ly < -2 || ly > 1) return AIR;
  const ax = Math.abs(x - t.x), az = Math.abs(z - t.z);
  const r = ly <= -1 ? 2 : 1;
  if (ax > r || az > r) return AIR;
  // Knock off some corners so the crowns aren't perfect cubes.
  if (ax === r && az === r && (ly === 1 || rand(x, y, z, 43) < 0.5)) return AIR;
  return LEAVES;
}

/// Trees whose crowns could reach the box [x0, x1] x [z0, z1].
function plantsNear(x0, z0, x1, z1) {
  const out = [];
  for (let i = Math.floor((x0 - 5) / CELL); i <= Math.floor((x1 + 2) / CELL); i++) {
    for (let j = Math.floor((z0 - 5) / CELL); j <= Math.floor((z1 + 2) / CELL); j++) {
      const t = plantIn(i, j);
      if (t && t.x >= x0 - 2 && t.x <= x1 + 2 && t.z >= z0 - 2 && t.z <= z1 + 2) out.push(t);
    }
  }
  return out;
}

/// Trunks win over leaves wherever two trees overlap; plants only grow into open air above the ground.
function plantAt(plants, x, y, z) {
  let leaves = false;
  for (const t of plants) {
    const b = plantBlock(t, x, y, z);
    if (b === LOG || b === CACTUS) return b;
    if (b === LEAVES) leaves = true;
  }
  return leaves ? LEAVES : AIR;
}

// ---------------------------------------------------------------- the town

export const TOWN_R = 20;
/// The Mining Office: walls from OFFICE.x0..x1, z0..z1 (relative to the town centre), door on the south side.
export const OFFICE = { x0: -6, x1: 6, z0: -14, z1: -6, door: 0 };

/// The town's block at (x, y, z), or -1 outside it. The ground under the town is solid: no caves, no ores.
export function townBlock(x, y, z) {
  const dx = x - TOWN.x, dz = z - TOWN.z;
  if (dx * dx + dz * dz > TOWN_R * TOWN_R) return -1;
  const Y = TOWN.y, ry = y - Y;
  if (y === 0) return BEDROCK;
  if (ry < -3) return STONE;
  if (ry < 0) return DIRT;
  const o = OFFICE;
  const inOffice = dx >= o.x0 && dx <= o.x1 && dz >= o.z0 && dz <= o.z1;
  if (ry === 0) {
    if (inOffice) return PLANKS;
    const ring = dx * dx + dz * dz;
    if (Math.abs(dx) <= 1 || Math.abs(dz) <= 1 || (ring >= 81 && ring <= 132)) return BRICKS;
    return GRASS;
  }
  // The fountain in the middle.
  if (Math.abs(dx) <= 2 && Math.abs(dz) <= 2) {
    const rim = Math.abs(dx) === 2 || Math.abs(dz) === 2;
    if (ry === 1) return rim ? BRICKS : WATER;
    if (ry === 2 && dx === 0 && dz === 0) return LAMP;
    return AIR;
  }
  // Lamp posts.
  if (Math.abs(dx) === 7 && Math.abs(dz) === 7 && dz > 0) return ry <= 2 ? LOG : ry === 3 ? LAMP : AIR;
  if (Math.abs(dx) === 12 && dz === 0) return ry <= 2 ? LOG : ry === 3 ? LAMP : AIR;
  // The Mining Office.
  const cz = (o.z0 + o.z1) / 2;
  if (ry >= 5) {
    const k = ry - 5;
    const half = (o.z1 - o.z0) / 2 + 1 - k;
    if (half >= 0 && Math.abs(dz - cz) <= half && dx >= o.x0 - 1 && dx <= o.x1 + 1) {
      return Math.abs(dz - cz) >= half - 0.5 || dx === o.x0 - 1 || dx === o.x1 + 1 ? ROOF : PLANKS;
    }
    return AIR;
  }
  if (!inOffice) return AIR;
  const wallX = dx === o.x0 || dx === o.x1, wallZ = dz === o.z0 || dz === o.z1;
  if (!wallX && !wallZ) return ry === 4 && dx === 0 && dz === Math.round(cz) ? LAMP : AIR;
  if (wallX && wallZ) return LOG;
  if (dz === o.z1 && Math.abs(dx - o.door) <= 1 && ry <= 3) return AIR; // the door
  if (ry === 4) return LOG;
  if ((ry === 2 || ry === 3) && (wallZ ? Math.abs(dx) % 3 === 1 : Math.abs(dz - cz) <= 1)) return GLASS;
  return PLANKS;
}

// ---------------------------------------------------------------- the world

/// What was at (x, y, z) when the world was made. The room uses this for single blocks.
export function naturalBlock(x, y, z) {
  if (!inWorld(x, z) || y < 0 || y >= HEIGHT) return AIR;
  const t = townBlock(x, y, z);
  if (t >= 0) return t;
  const col = column(x, z);
  const b = terrainBlock(x, y, z, col);
  if (b !== AIR || y <= col.h) return b;
  return plantAt(plantsNear(x, z, x, z), x, y, z);
}

export const index = (lx, y, lz) => (y << 8) | (lz << 4) | lx;

/// A whole chunk (16 x 128 x 16), the same blocks naturalBlock gives one by one.
export function generateChunk(cx, cz) {
  const out = new Uint8Array(CHUNK * CHUNK * HEIGHT);
  const x0 = cx * CHUNK, z0 = cz * CHUNK;
  const cols = [];
  for (let lz = 0; lz < CHUNK; lz++) {
    for (let lx = 0; lx < CHUNK; lx++) {
      const x = x0 + lx, z = z0 + lz;
      if (!inWorld(x, z)) continue;
      const tdx = x - TOWN.x, tdz = z - TOWN.z;
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
  const plants = plantsNear(x0, z0, x0 + CHUNK - 1, z0 + CHUNK - 1);
  for (const t of plants) {
    for (let x = t.x - 2; x <= t.x + 2; x++) {
      for (let z = t.z - 2; z <= t.z + 2; z++) {
        const lx = x - x0, lz = z - z0;
        if (lx < 0 || lz < 0 || lx >= CHUNK || lz >= CHUNK) continue;
        const col = cols[lz * CHUNK + lx];
        if (!col) continue; // the town, or outside the world
        for (let y = Math.max(col.h, SEA) + 1; y <= t.base + t.height + 1 && y < HEIGHT; y++) {
          const i = index(lx, y, lz);
          if (out[i] === LOG || out[i] === CACTUS) continue;
          const b = plantBlock(t, x, y, z);
          if (b !== AIR) out[i] = b;
        }
      }
    }
  }
  return out;
}

export const CHUNKS = WORLD / CHUNK;
export { rand };
