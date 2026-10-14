// A picture of the whole planet from above, for the globe on the title screen (globe.js): each column's top colour
// (grass by biome, sand, snow, water by depth, the town's roofs and roads), shaded by the slope so hills and
// mountains show. No DOM: it runs in the world worker (world-worker.js), off the main thread.
//
// It's drawn ready to wrap round a sphere by longitude and latitude: x goes round the equator (WORLD blocks to 360
// degrees), and z runs north to south by the Mercator projection, which keeps shapes true everywhere (the town is
// round, not squashed) and fits a square world exactly between 85 degrees north and south. What's left, round the
// poles, comes back transparent for the globe to cover with ice.

import { column, townBlock, TOWN_R, PLAINS, FOREST, DESERT, SNOWY, PEAKS, MEADOW, DARK_FOREST, TAIGA, BEACH, rand } from "./worldgen.js";
import { AIR, GRASS, DIRT, STONE, COBBLE, SAND, GRAVEL, LOG, LEAVES, PLANKS, WATER, GLASS, BRICKS, LAMP, ROOF, SNOW } from "./blocks.js";
import { WORLD, SEA, TOWN, wrapDelta } from "./rules.js";

const hex = (c) => [(c >> 16) & 255, (c >> 8) & 255, c & 255];
const BIOME = [];
BIOME[PLAINS] = hex(0x7dbb4f); BIOME[FOREST] = hex(0x3f8a36); BIOME[DESERT] = hex(0xe3cf8c); BIOME[SNOWY] = hex(0xecf3f6);
BIOME[PEAKS] = hex(0xf7fbff); BIOME[MEADOW] = hex(0x97cc5a); BIOME[DARK_FOREST] = hex(0x285a27); BIOME[TAIGA] = hex(0x3c6e4c);
BIOME[BEACH] = hex(0xe9daa2);
const TREES = []; // how much of each biome is under trees (darker specks)
TREES[FOREST] = 0.35; TREES[DARK_FOREST] = 0.5; TREES[TAIGA] = 0.3; TREES[PLAINS] = 0.04; TREES[MEADOW] = 0.02; TREES[SNOWY] = 0.1;
const TOWN_COLOUR = { [ROOF]: hex(0xb4463a), [PLANKS]: hex(0xb08a55), [LOG]: hex(0x6e5032), [BRICKS]: hex(0x9a9a96),
  [COBBLE]: hex(0x86868a), [STONE]: hex(0x8a8a8a), [GRASS]: hex(0x7dbb4f), [DIRT]: hex(0x8a6a44), [SAND]: hex(0xe9daa2),
  [GRAVEL]: hex(0x8f8a84), [WATER]: hex(0x3f8fd0), [GLASS]: hex(0xcfe8f0), [LAMP]: hex(0xffe9a0), [LEAVES]: hex(0x3f8a36),
  [SNOW]: hex(0xf2f6f8) };
const SHALLOW = hex(0x3d93d4), DEEP = hex(0x163f7c);

/// The planet as w x h RGBA pixels, w across the 360 degrees of longitude (x) and h down the 180 degrees of latitude,
/// north first: z by Mercator, rows past the world's edge (near the poles) transparent.
export function planetMap(w, h) {
  const out = new Uint8Array(w * h * 4);
  const H = new Float32Array(w * h);
  const sx = WORLD / w;
  const zOf = new Float64Array(h);
  for (let j = 0; j < h; j++) {
    const lat = ((90 - ((j + 0.5) / h) * 180) * Math.PI) / 180;
    zOf[j] = WORLD / 2 - (Math.log(Math.tan(Math.PI / 4 + lat / 2)) / (2 * Math.PI)) * WORLD;
  }
  const inside = (j) => zOf[j] >= 0 && zOf[j] < WORLD;
  const cols = new Array(w * h);
  for (let j = 0; j < h; j++) {
    if (!inside(j)) continue;
    for (let i = 0; i < w; i++) {
      const x = Math.floor((i + 0.5) * sx), z = Math.floor(zOf[j]);
      const c = column(x, z);
      cols[j * w + i] = c;
      H[j * w + i] = Math.max(c.h, SEA);
    }
  }
  for (let j = 0; j < h; j++) {
    if (!inside(j)) continue; // (alpha 0: the globe's ice)
    const up = inside(j - 1) ? j - 1 : j, down = inside(j + 1) ? j + 1 : j;
    const sz = Math.max(1, zOf[down] - zOf[up]);
    for (let i = 0; i < w; i++) {
      const k = j * w + i, c = cols[k];
      const x = Math.floor((i + 0.5) * sx), z = Math.floor(zOf[j]);
      let rgb, shade = 1;
      const tdx = wrapDelta(x - TOWN.x), tdz = wrapDelta(z - TOWN.z);
      if (tdx * tdx + tdz * tdz <= TOWN_R * TOWN_R) {
        // The town: its highest block in this column.
        let b = AIR;
        for (let y = TOWN.y + 18; y >= TOWN.y - 2 && b === AIR; y--) b = townBlock(x, y, z);
        rgb = TOWN_COLOUR[b] ?? BIOME[PLAINS];
      } else if (c.h < SEA) {
        const t = Math.min(1, (SEA - c.h) / 22);
        rgb = [0, 1, 2].map((n) => SHALLOW[n] + (DEEP[n] - SHALLOW[n]) * t);
      } else {
        rgb = c.h <= SEA + 1 && c.biome !== SNOWY ? BIOME[BEACH] : BIOME[c.biome] ?? BIOME[PLAINS];
        // Slopes facing the light (from the north-west) are brighter, and high ground a little paler.
        const l = H[j * w + ((i + w - 1) % w)], r = H[j * w + ((i + 1) % w)];
        const u = H[up * w + i], d = H[down * w + i];
        shade = 1 + ((l - r) / (2 * sx) + (u - d) / sz) * 0.12;
        shade = Math.max(0.7, Math.min(1.25, shade)) + Math.max(0, c.h - 70) * 0.004;
        if (rand(x, 3, z, 91) < (TREES[c.biome] ?? 0)) shade *= 0.72;
      }
      out[k * 4] = Math.min(255, rgb[0] * shade);
      out[k * 4 + 1] = Math.min(255, rgb[1] * shade);
      out[k * 4 + 2] = Math.min(255, rgb[2] * shade);
      out[k * 4 + 3] = 255;
    }
  }
  return out;
}
