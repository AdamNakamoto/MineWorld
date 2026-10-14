// The town at the centre of the planet: the spawn, the Mining Office, roads, shops, houses, gardens and the villagers'
// homes (villagers.js walks them about). The ground under it is solid (no caves, no ores) and the land is flattened
// round it; nobody mines or builds within PROTECT_R (rules.js). Deterministic like worldgen.js, which asks townBlock
// first for every column within TOWN_R. Everything is placed relative to the town's centre: +x east, +z south.

import {
  AIR, GRASS, DIRT, STONE, COBBLE, SAND, GRAVEL, PLANKS, LOG, LEAVES, BEDROCK, WATER, GLASS, BRICKS, LAMP, ROOF,
  FLOWER_YELLOW, FLOWER_RED, FLOWER_BLUE, BERRY_BUSH, TALL_GRASS,
} from "./blocks.js";
import { TOWN } from "./rules.js";

export const TOWN_FLAT = 60; // the town's ground is level out to here
export const TOWN_BLEND = 84; // and blends into the land by here
export const TOWN_R = 56; // townBlock draws everything within this radius (inside the protected PROTECT_R)

/// The Mining Office: walls from OFFICE.x0..x1, z0..z1, door on the south side.
export const OFFICE = { x0: -6, x1: 6, z0: -14, z1: -6, door: 0 };

// ---------------------------------------------------------------- buildings
// Each building: its footprint (inclusive), which side its door is on (n, s, e or w) and where along that side,
// how wide the door is, its height to the eaves, its materials, and anything special about it.
const HOUSE = { wall: PLANKS, corner: LOG, floor: PLANKS, roof: ROOF, h: 4 };
const STONEHOUSE = { wall: BRICKS, corner: COBBLE, floor: PLANKS, roof: ROOF, h: 4 };
const B = (name, x0, z0, x1, z1, door, at, o = {}) => ({ name, x0, z0, x1, z1, door, at, ...HOUSE, doorW: 1, ...o });

export const BUILDINGS = [
  B("Bakery", 9, -12, 17, -5, "s", 13, { doorW: 3, kind: "shop" }),
  B("Smithy", 8, -20, 16, -15, "n", 12, { wall: COBBLE, corner: COBBLE, floor: COBBLE, chimney: [9, -19], kind: "shop" }),
  B("Library", -17, -12, -9, -5, "s", -13, { ...STONEHOUSE, corner: LOG, doorW: 3, kind: "shop" }),
  B("Trading Post", 9, 5, 18, 12, "n", 13, { doorW: 3, kind: "shop" }),
  B("Tavern", 26, 4, 36, 12, "n", 30, { h: 7, doorW: 3, kind: "shop" }),
  B("Barn", 26, -14, 38, -4, "s", 32, { doorW: 3, h: 5 }),
  B("Town Hall", -18, 5, -9, 12, "n", -13, { ...STONEHOUSE, h: 6, doorW: 3 }),
  B("Clock Tower", 24, -29, 29, -24, "s", 26, { wall: BRICKS, corner: COBBLE, floor: COBBLE, roof: ROOF, h: 15, tower: true }),
  B("Watchtower", -34, -34, -31, -31, "s", -33, { wall: AIR, corner: LOG, floor: PLANKS, roof: PLANKS, h: 9, lookout: true }),
  B("Rose Cottage", -17, -20, -11, -15, "n", -14),
  B("Miller House", -36, -12, -29, -5, "s", -32, STONEHOUSE),
  B("Fern House", -46, -12, -39, -5, "s", -42),
  B("Hill House", -44, -32, -38, -26, "s", -41),
  B("Lake House", 34, 26, 41, 32, "n", 37),
  B("Sunny House", 26, 15, 32, 20, "s", 29),
  B("Cobble House", -36, 5, -30, 11, "n", -33, STONEHOUSE),
  B("West House", -46, 5, -40, 11, "n", -43),
  B("Garden House", -17, 26, -11, 32, "n", -14),
  B("Brook House", -34, 26, -28, 32, "n", -31, STONEHOUSE),
  B("East House", 34, -32, 41, -26, "s", 37),
];

/// Where each building's door opens onto, in world coordinates: the villagers' homes and workplaces.
export const DOORS = Object.fromEntries([["Mining Office", { x: TOWN.x + OFFICE.door, z: TOWN.z + OFFICE.z1 + 1 }],
  ...BUILDINGS.map((b) => {
    const out = { n: [b.at, b.z0 - 1], s: [b.at, b.z1 + 1], e: [b.x1 + 1, b.at], w: [b.x0 - 1, b.at] }[b.door];
    return [b.name, { x: TOWN.x + out[0], z: TOWN.z + out[1] }];
  })]);

// ---------------------------------------------------------------- the ground plan
// What each column of the town is, worked out once: a building (its index), a road, the plaza, a garden...
const R = TOWN_R, SIZE = 2 * R + 1;
const PLAN = new Int16Array(SIZE * SIZE).fill(-100); // >= 0: building index; negative: one of the kinds below
const GROUND = -100, ROAD = -1, LANE = -2, PLAZA = -3, GARDEN = -4, POND = -5, SHORE = -6, HEDGE = -7, ORCHARD = -8;
const at = (dx, dz) => (dz + R) * SIZE + (dx + R);
for (let dz = -R; dz <= R; dz++) {
  for (let dx = -R; dx <= R; dx++) {
    const r2 = dx * dx + dz * dz;
    if (r2 > R * R) continue;
    let k = GROUND;
    if (r2 <= 11.5 * 11.5) k = PLAZA;
    else if ((Math.abs(dx) <= 1 || Math.abs(dz) <= 1) && r2 <= 54 * 54) k = ROAD;
    else if ((Math.abs(Math.abs(dz) - 22) <= 1 && Math.abs(dx) <= 46) || (Math.abs(Math.abs(dx) - 22) <= 1 && Math.abs(dz) <= 46)) k = LANE;
    // A flower garden with a hedge, a pond, and an orchard.
    if (dx >= 8 && dx <= 18 && dz >= 14 && dz <= 20) k = dx === 8 || dx === 18 || dz === 14 || dz === 20 ? HEDGE : GARDEN;
    const pond = (dx - 14) ** 2 + (dz - 34) ** 2;
    if (pond <= 22) k = POND;
    else if (pond <= 34 && k === GROUND) k = SHORE;
    if (dx >= -46 && dx <= -38 && dz >= 30 && dz <= 42 && k === GROUND) k = ORCHARD;
    PLAN[at(dx, dz)] = k;
  }
}
BUILDINGS.forEach((b, i) => {
  for (let dz = b.z0; dz <= b.z1; dz++) for (let dx = b.x0; dx <= b.x1; dx++) PLAN[at(dx, dz)] = i;
});

// Fixed spots: lamp posts beside the roads, the town gates, and the orchard's little trees.
const LAMPS = new Set();
for (const d of [16, 40, 48]) for (const s of [-1, 1]) { LAMPS.add(`${s * d},3`); LAMPS.add(`${s * d},-3`); LAMPS.add(`3,${s * d}`); LAMPS.add(`-3,${s * d}`); }
for (const [x, z] of [[7, 7], [-7, 7]]) LAMPS.add(`${x},${z}`);
const GATES = new Set();
for (const s of [-1, 1]) { GATES.add(`2,${s * 52}`); GATES.add(`-2,${s * 52}`); GATES.add(`${s * 52},2`); GATES.add(`${s * 52},-2`); }
const ORCHARD_TREES = [[-44, 33], [-40, 37], [-44, 40], [-40, 31]];

function hash(x, z) {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(z | 0, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  return ((h ^ (h >>> 13)) >>> 0) / 4294967296;
}

/// A building's block at (dx, dz) inside its footprint, ry blocks above the town floor.
function buildingBlock(b, dx, dz, ry) {
  const lx = dx - b.x0, lz = dz - b.z0, w = b.x1 - b.x0, d = b.z1 - b.z0;
  const edgeX = lx === 0 || lx === w, edgeZ = lz === 0 || lz === d;
  const H = b.h;
  if (ry === 0) return b.floor;
  // The roof: a gable along the longer side, one block of overhang is drawn by roofOver().
  if (ry > H) return roofBlock(b, dx, dz, ry - H);
  if (b.lookout) {
    // A log tower: four posts, a platform at the top with a rail, a ladder of planks inside.
    if (edgeX && edgeZ) return LOG;
    if (ry === H) return PLANKS;
    if (ry === H - 1 && (edgeX || edgeZ)) return AIR;
    return AIR;
  }
  const door = { n: lz === 0, s: lz === d, e: lx === w, w: lx === 0 }[b.door];
  const along = b.door === "n" || b.door === "s" ? dx : dz;
  if (door && Math.abs(along - b.at) <= (b.doorW - 1) / 2 && ry <= 3) return AIR;
  if (!edgeX && !edgeZ) {
    if (b.h >= 7) {
      // Two floors, and stairs up to the upper one along the back wall: a step at a time, a hole above them.
      if (lz === 1 && lx >= 1 && lx <= 3) return ry <= lx ? PLANKS : ry === 4 ? AIR : AIR;
      if (ry === 4) return PLANKS;
    }
    if (ry === H && lx === Math.floor(w / 2) && lz === Math.floor(d / 2)) return LAMP;
    if (b.tower && ry === H - 1 && lx === Math.floor(w / 2) && lz === Math.floor(d / 2)) return AIR;
    return AIR;
  }
  if (edgeX && edgeZ) return b.corner;
  if (ry === H || (b.h >= 7 && ry === 4)) return b.corner === COBBLE ? COBBLE : LOG; // beams
  // Windows: every third block along a wall, two high (and on each floor); the clock tower has glowing faces.
  if (b.tower) {
    if (ry >= H - 3 && ry <= H - 1 && (edgeX ? lz === Math.floor(d / 2) : lx === Math.floor(w / 2))) return LAMP;
    if (ry % 4 === 2 && (edgeX ? lz : lx) % 2 === 1) return GLASS;
    return b.wall;
  }
  const i = edgeX ? lz : lx;
  const win = (ry === 2 || ry === 3 || (b.h >= 7 && (ry === 5 || ry === 6))) && i % 3 === 1 && i !== (edgeX ? d : w);
  if (win) return GLASS;
  if (b.chimney && dx === b.chimney[0] && dz === b.chimney[1]) return COBBLE;
  return b.wall;
}

/// The roof k blocks above the eaves: a gable along the longer side, sloping one block in per layer.
function roofBlock(b, dx, dz, k) {
  const w = b.x1 - b.x0, d = b.z1 - b.z0;
  if (b.chimney && dx === b.chimney[0] && dz === b.chimney[1]) return k <= 3 ? COBBLE : k === 4 ? LAMP : AIR;
  if (b.lookout) return k === 1 && (dx === b.x0 || dx === b.x1) && (dz === b.z0 || dz === b.z1) ? LOG : k === 2 ? PLANKS : AIR;
  if (b.tower) {
    // A pyramid spire.
    const half = Math.min(w, d) / 2 - (k - 1);
    if (half < 0) return AIR;
    const cx = (b.x0 + b.x1) / 2, cz = (b.z0 + b.z1) / 2;
    return Math.abs(dx - cx) <= half && Math.abs(dz - cz) <= half ? (k >= Math.min(w, d) / 2 ? LAMP : ROOF) : AIR;
  }
  const alongX = w >= d;
  const span = alongX ? d : w;
  const c = alongX ? (b.z0 + b.z1) / 2 : (b.x0 + b.x1) / 2;
  const off = Math.abs((alongX ? dz : dx) - c);
  const half = span / 2 + 1 - (k - 1);
  if (half < 0 || off > half) return AIR;
  const end = alongX ? dx === b.x0 || dx === b.x1 : dz === b.z0 || dz === b.z1;
  if (off >= half - 0.5) return b.roof;
  return end ? b.wall === AIR ? PLANKS : b.wall : AIR;
}

/// Roof overhang: the bottom layer of a roof reaches one block past the walls on the eave sides.
function roofOver(dx, dz, ry) {
  for (const b of BUILDINGS) {
    if (b.tower || b.lookout) continue;
    const alongX = b.x1 - b.x0 >= b.z1 - b.z0;
    if (ry !== b.h + 1) continue;
    if (alongX ? dx >= b.x0 && dx <= b.x1 && (dz === b.z0 - 1 || dz === b.z1 + 1) : dz >= b.z0 && dz <= b.z1 && (dx === b.x0 - 1 || dx === b.x1 + 1)) return b.roof;
  }
  return -1;
}

/// The Mining Office (as it was first built).
function officeBlock(dx, dz, ry) {
  const o = OFFICE, cz = (o.z0 + o.z1) / 2;
  const inOffice = dx >= o.x0 && dx <= o.x1 && dz >= o.z0 && dz <= o.z1;
  if (ry === 0) return inOffice ? PLANKS : -1;
  if (ry >= 5) {
    const k = ry - 5;
    const half = (o.z1 - o.z0) / 2 + 1 - k;
    if (half >= 0 && Math.abs(dz - cz) <= half && dx >= o.x0 - 1 && dx <= o.x1 + 1) {
      return Math.abs(dz - cz) >= half - 0.5 || dx === o.x0 - 1 || dx === o.x1 + 1 ? ROOF : PLANKS;
    }
    return inOffice ? AIR : -1;
  }
  if (!inOffice) return -1;
  const wallX = dx === o.x0 || dx === o.x1, wallZ = dz === o.z0 || dz === o.z1;
  if (!wallX && !wallZ) return ry === 4 && dx === 0 && dz === Math.round(cz) ? LAMP : AIR;
  if (wallX && wallZ) return LOG;
  if (dz === o.z1 && Math.abs(dx - o.door) <= 1 && ry <= 3) return AIR;
  if (ry === 4) return LOG;
  if ((ry === 2 || ry === 3) && (wallZ ? Math.abs(dx) % 3 === 1 : Math.abs(dz - cz) <= 1)) return GLASS;
  return PLANKS;
}

/// The town's block at (x, y, z), or -1 outside it.
export function townBlock(x, y, z) {
  const dx = x - TOWN.x, dz = z - TOWN.z;
  if (dx * dx + dz * dz > R * R) return -1;
  const ry = y - TOWN.y;
  if (y === 0) return BEDROCK;
  if (ry < -3) return STONE;
  if (ry < 0) return DIRT;
  const office = officeBlock(dx, dz, ry);
  if (office >= 0) return office;
  const k = PLAN[at(dx, dz)];
  if (k >= 0) return buildingBlock(BUILDINGS[k], dx, dz, ry);
  if (ry >= 5 && ry <= 8) {
    const over = roofOver(dx, dz, ry);
    if (over >= 0) return over;
  }
  if (ry === 0) {
    switch (k) {
      case PLAZA: {
        const r2 = dx * dx + dz * dz;
        return r2 >= 81 ? BRICKS : (dx + dz) % 4 === 0 ? COBBLE : BRICKS;
      }
      case ROAD: return BRICKS;
      case LANE: return GRAVEL;
      case POND: return WATER;
      case SHORE: return SAND;
      default: return GRASS;
    }
  }
  // The fountain in the middle of the plaza.
  if (Math.abs(dx) <= 2 && Math.abs(dz) <= 2) {
    const rim = Math.abs(dx) === 2 || Math.abs(dz) === 2;
    if (ry === 1) return rim ? BRICKS : WATER;
    if (ry === 2 && dx === 0 && dz === 0) return LAMP;
    return AIR;
  }
  const key = `${dx},${dz}`;
  if (LAMPS.has(key)) return ry <= 2 ? LOG : ry === 3 ? LAMP : AIR;
  if (GATES.has(key)) return ry <= 3 ? BRICKS : ry === 4 ? LAMP : AIR;
  if (ry === 1) {
    if (k === HEDGE) return LEAVES;
    if (k === GARDEN) {
      const h = hash(dx, dz);
      return h < 0.3 ? FLOWER_RED : h < 0.55 ? FLOWER_YELLOW : h < 0.75 ? FLOWER_BLUE : h < 0.85 ? BERRY_BUSH : AIR;
    }
    if (k === GROUND && hash(dx * 7, dz * 3) < 0.05) return hash(dx, dz * 5) < 0.6 ? TALL_GRASS : FLOWER_YELLOW;
  }
  // The orchard's little fruit trees.
  if (k === ORCHARD) {
    for (const [tx, tz] of ORCHARD_TREES) {
      if (dx === tx && dz === tz && ry <= 3) return LOG;
      if (Math.abs(dx - tx) <= 1 && Math.abs(dz - tz) <= 1 && (ry === 3 || ry === 4) && !(dx === tx && dz === tz && ry === 3)) return LEAVES;
    }
  }
  return AIR;
}

/// The places villagers walk between (world coordinates): the plaza, the shops' doors, the garden, the pond...
export const SPOTS = {
  plaza: [[TOWN.x + 4, TOWN.z + 6], [TOWN.x - 5, TOWN.z + 5], [TOWN.x + 6, TOWN.z - 3], [TOWN.x - 6, TOWN.z - 2]],
  garden: [[TOWN.x + 13, TOWN.z + 22]],
  pond: [[TOWN.x + 14, TOWN.z + 27], [TOWN.x + 8, TOWN.z + 34]],
  orchard: [[TOWN.x - 37, TOWN.z + 36]],
  gates: [[TOWN.x, TOWN.z + 50], [TOWN.x, TOWN.z - 50], [TOWN.x + 50, TOWN.z], [TOWN.x - 50, TOWN.z]],
};
