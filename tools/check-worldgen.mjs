// Checks that web/worldgen.js gives the same world one block at a time (naturalBlock, what the world server uses to
// check and pay for breaks) as a chunk at a time (generateChunk, what the game draws), on every planet the rocket
// flies to (zones.js): the home planet over chunks in the town, along the seam where the planet wraps round (chunk 0
// and chunk CHUNKS - 1 in x or z) and in every biome; each zone round its landing pad (and Cinderfall's arena), along
// its seam and spread over it. Also that each planet repeats every WORLD blocks (naturalBlock(x + WORLD, y, z) is
// naturalBlock(x, y, z), and generateChunk(-1, ...) is generateChunk(CHUNKS - 1, ...)) with no step at the seam; that
// the town's launch pad overlaps nothing (buildings, roads, lamps, gates, gardens, villagers' doors and stops); how much
// of the home planet each biome covers; and times it all.
//
//   node tools/check-worldgen.mjs [chunks per biome, default 6] [one zone only: home, deep, boss or pvp]

import { generateChunk, naturalBlock, column, index, CHUNKS, BIOME_NAMES } from "../web/worldgen.js";
import { BLOCKS } from "../web/blocks.js";
import { CHUNK, HEIGHT, TOWN, WORLD, SEA, PROTECT_R } from "../web/rules.js";
import { ZONES, ZONE_KEYS, ARENA, PAD_R } from "../web/zones.js";
import { BUILDINGS, DOORS, SPOTS, LAUNCH, townBlock } from "../web/town.js";

const perBiome = Number(process.argv[2] ?? 6);
const only = process.argv[3];
let bad = 0;
let seed = 12345;
const rnd = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296;

function checkZone(zone) {
  const Z = ZONES[zone];
  const picked = new Map(); // "cx,cz" -> why
  const add = (cx, cz, why) => { if (cx >= 0 && cz >= 0 && cx < CHUNKS && cz < CHUNKS && !picked.has(`${cx},${cz}`)) picked.set(`${cx},${cz}`, why); };
  const around = (x, z, why) => {
    const ccx = Math.floor(x / CHUNK), ccz = Math.floor(z / CHUNK);
    for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) if (Math.abs(dx) + Math.abs(dz) <= 2) add(ccx + dx, ccz + dz, why);
  };
  // The town and its edge, or the zone's pad (and Cinderfall's arena) and the level ground round them.
  if (zone === "home") around(TOWN.x, TOWN.z, "town");
  else around(Z.pad.x, Z.pad.z, "pad");
  if (zone === "boss") { around(ARENA.x, ARENA.z, "arena"); around(ARENA.x, (ARENA.z + Z.pad.z) / 2, "path"); }
  // The seam: every chunk with x or z chunk 0 or CHUNKS - 1 (trees, caves and ores reach across it).
  const L = CHUNKS - 1;
  for (let k = 0; k < CHUNKS; k++) for (const [cx, cz] of [[0, k], [L, k], [k, 0], [k, L]]) add(cx, cz, "seam");
  let byBiome = null;
  if (zone === "home") {
    // Every biome: chunks whose middle is in it, spread over the world.
    byBiome = BIOME_NAMES.map(() => []);
    for (let cz = 1; cz < CHUNKS - 1; cz += 1) for (let cx = 1; cx < CHUNKS - 1; cx += 1) {
      byBiome[column(cx * CHUNK + 8, cz * CHUNK + 8).biome].push([cx, cz]);
    }
    byBiome.forEach((list, b) => {
      for (let k = 0; k < perBiome && list.length; k++) {
        const [cx, cz] = list[Math.floor(((k + 0.5) / perBiome) * list.length)];
        add(cx, cz, BIOME_NAMES[b]);
      }
    });
  } else {
    // Spread over the planet, and the highest ground (crags, volcanoes, mesas: the most going on).
    for (let cz = 2; cz < CHUNKS; cz += 5) for (let cx = 3; cx < CHUNKS; cx += 5) add(cx, cz, "spread");
    const high = [];
    for (let cz = 1; cz < CHUNKS - 1; cz++) for (let cx = 1; cx < CHUNKS - 1; cx++) high.push([column(cx * CHUNK + 8, cz * CHUNK + 8, zone).h, cx, cz]);
    high.sort((a, b) => b[0] - a[0]);
    for (const [, cx, cz] of high.slice(0, perBiome * 2)) add(cx, cz, "high");
  }

  let blocks = 0, zbad = 0;
  const kinds = new Map();
  for (const [k, why] of picked) {
    const [cx, cz] = k.split(",").map(Number);
    const chunk = generateChunk(cx, cz, zone);
    for (let lz = 0; lz < CHUNK; lz++) for (let lx = 0; lx < CHUNK; lx++) for (let y = 0; y < HEIGHT; y++) {
      const want = chunk[index(lx, y, lz)];
      const got = naturalBlock(cx * CHUNK + lx, y, cz * CHUNK + lz, zone);
      blocks++;
      kinds.set(want, (kinds.get(want) ?? 0) + 1);
      if (want !== got && zbad++ < 20) console.log(`MISMATCH ${zone} chunk ${k} (${why}) at ${cx * CHUNK + lx},${y},${cz * CHUNK + lz}: chunk ${BLOCKS[want]?.name}, single ${BLOCKS[got]?.name}`);
    }
  }
  bad += zbad;
  const whys = {};
  for (const why of picked.values()) whys[why] = (whys[why] ?? 0) + 1;
  console.log(`\n${Z.name} (${zone}): ${picked.size} chunks (${Object.entries(whys).map(([w, n]) => `${w} ${n}`).join(", ")}), ${blocks.toLocaleString()} blocks compared`);
  console.log("blocks seen:", [...kinds].filter(([id]) => id).sort((a, b) => b[1] - a[1]).map(([id, n]) => `${BLOCKS[id].name} ${n}`).join(", "));
  if (byBiome) {
    const missing = BIOME_NAMES.filter((_, b) => !byBiome[b].length);
    if (missing.length) { console.log("FAILED: biomes not found:", missing.join(", ")); bad++; }
  }

  // The planet repeats: a block anywhere is the block WORLD (or 2 WORLD) away in x, z or both, whichever way the
  // caller writes it, and a chunk past the seam is the one from the other side.
  let wrapped = 0;
  const tries = zone === "home" ? 40000 : 12000;
  for (let k = 0; k < tries; k++) {
    // Mostly near the seam and near the ground, where trees and caves cross it.
    const near = k % 2 === 0;
    const x = near ? (WORLD - 12 + ((rnd() * 24) | 0)) % WORLD : (rnd() * WORLD) | 0;
    const z = k % 4 < 2 ? (WORLD - 12 + ((rnd() * 24) | 0)) % WORLD : (rnd() * WORLD) | 0;
    const y = k % 3 === 0 ? (rnd() * HEIGHT) | 0 : Math.max(0, Math.min(HEIGHT - 1, column(x, z, zone).h - 6 + ((rnd() * 24) | 0)));
    const want = naturalBlock(x, y, z, zone);
    for (const [ox, oz] of [[WORLD, 0], [-WORLD, 0], [0, WORLD], [0, -WORLD], [WORLD, -WORLD], [2 * WORLD, 2 * WORLD]]) {
      const got = naturalBlock(x + ox, y, z + oz, zone);
      wrapped++;
      if (got !== want && bad++ < 20) console.log(`NOT PERIODIC ${zone} at ${x},${y},${z} (+${ox},+${oz}): ${BLOCKS[want]?.name} vs ${BLOCKS[got]?.name}`);
    }
  }
  for (const [cx, cz] of [[-1, 0], [0, -1], [-1, -1], [CHUNKS, 5], [7, CHUNKS], [-1, CHUNKS]]) {
    const a = generateChunk(cx, cz, zone), b = generateChunk(((cx % CHUNKS) + CHUNKS) % CHUNKS, ((cz % CHUNKS) + CHUNKS) % CHUNKS, zone);
    wrapped++;
    if (!a.every((v, i) => v === b[i]) && bad++ < 20) console.log(`NOT PERIODIC: ${zone} generateChunk(${cx}, ${cz})`);
  }
  // No step at the seam: the ground across x = WORLD-1 | 0 (and z) is no rougher than across a line in the middle.
  let seamStep = 0, midStep = 0;
  const h = (x, z) => column(x, z, zone).h;
  for (let t = 0; t < WORLD; t++) {
    seamStep = Math.max(seamStep, Math.abs(h(WORLD - 1, t) - h(0, t)), Math.abs(h(t, WORLD - 1) - h(t, 0)));
    midStep = Math.max(midStep, Math.abs(h(WORLD / 2 - 1, t) - h(WORLD / 2, t)), Math.abs(h(t, WORLD / 2 - 1) - h(t, WORLD / 2)));
  }
  console.log(`periodic: ${wrapped.toLocaleString()} wrapped lookups; biggest ground step across the seam ${seamStep}, across the middle ${midStep}`);
  // (Red Mesa's terraces are cliffs by design, 5 blocks a step: allow a cliff or two at the seam as in the middle.)
  if (seamStep > Math.max(4, midStep * 2)) { console.log(`FAILED: ${zone}'s ground steps at the seam`); bad++; }

  // The pad: level ground, plates where the rocket stands, open sky over it.
  const P = Z.pad;
  const plate = naturalBlock(P.x, P.y, P.z, zone), above = naturalBlock(P.x, P.y + 1, P.z, zone);
  if (BLOCKS[plate]?.name !== "Landing plate" || above !== 0) { console.log(`FAILED: ${zone}'s pad isn't a landing plate under open air (${BLOCKS[plate]?.name}, ${BLOCKS[above]?.name})`); bad++; }
  for (let y = P.y + 1; y < HEIGHT; y++) {
    if (naturalBlock(P.x, y, P.z, zone) !== 0) { console.log(`FAILED: something over ${zone}'s pad at y ${y}`); bad++; break; }
  }
  if (zone !== "home") {
    // The whole safe area is walkable: nothing more than a step up or down from the pad's floor near it.
    let worst = 0;
    for (let dx = -PAD_R + 2; dx <= PAD_R - 2; dx += 2) for (let dz = -PAD_R + 2; dz <= PAD_R - 2; dz += 2) {
      if (dx * dx + dz * dz > (PAD_R - 2) ** 2 || dx * dx + dz * dz < 64) continue;
      worst = Math.max(worst, Math.abs(column(P.x + dx, P.z + dz, zone).h - P.y));
    }
    console.log(`pad at ${P.x}, ${P.y}, ${P.z}: ground within the safe area at most ${worst} from the pad's floor`);
    if (worst > 3) { console.log(`FAILED: ${zone}'s safe area isn't level`); bad++; }
  }
}

/// The town's launch pad must sit on open ground: no building, road, lane, plaza, lamp, gate, garden, pond or orchard
/// under it, no villager's door or stop on it, and within the protected town.
function checkLaunchPad() {
  const cells = [];
  for (let dz = -8; dz <= 8; dz++) for (let dx = -8; dx <= 8; dx++) {
    if (dx * dx + dz * dz <= LAUNCH.r2) cells.push([LAUNCH.x + dx, LAUNCH.z + dz]);
  }
  for (let dz = LAUNCH.path[0]; dz <= LAUNCH.path[1]; dz++) for (let dx = -1; dx <= 1; dx++) cells.push([LAUNCH.x + dx, dz]);
  const problems = [];
  for (const [x, z] of cells) {
    for (const b of BUILDINGS) if (x >= b.x0 - 1 && x <= b.x1 + 1 && z >= b.z0 - 1 && z <= b.z1 + 1) problems.push(`${b.name} at ${x},${z}`);
    if (Math.abs(x) <= 1 || Math.abs(z) <= 1) problems.push(`a main road at ${x},${z}`);
    if ((Math.abs(Math.abs(z) - 22) <= 1 && Math.abs(x) <= 46) || (Math.abs(Math.abs(x) - 22) <= 1 && Math.abs(z) <= 46)) problems.push(`a lane at ${x},${z}`);
    if (x * x + z * z <= 12 * 12) problems.push(`the plaza at ${x},${z}`);
    for (const d of Object.values(DOORS)) if (d.x - TOWN.x === x && d.z - TOWN.z === z) problems.push(`a door at ${x},${z}`);
    for (const list of Object.values(SPOTS)) for (const [sx, sz] of list) if (Math.abs(sx - TOWN.x - x) <= 1 && Math.abs(sz - TOWN.z - z) <= 1) problems.push(`a villagers' stop at ${x},${z}`);
    if (x * x + z * z >= (PROTECT_R - 4) ** 2) problems.push(`outside the protected town at ${x},${z}`);
  }
  // Nothing taller than the floor on the pad itself (a lamp post or a tree would stand in the rocket).
  for (const [x, z] of cells.slice(0, cells.length - 15)) {
    for (let ry = 1; ry < 12; ry++) if (townBlock(TOWN.x + x, TOWN.y + ry, TOWN.z + z) !== 0) { problems.push(`a block over the pad at ${x},${ry},${z}`); break; }
  }
  console.log(`\nlaunch pad at town ${LAUNCH.x}, ${LAUNCH.z}: ${cells.length} cells checked, ${problems.length ? `FAILED: ${[...new Set(problems)].slice(0, 8).join("; ")}` : "on open ground, clear of everything"}`);
  bad += problems.length ? 1 : 0;
}

for (const zone of ZONE_KEYS) if (!only || only === zone) checkZone(zone);
if (!only || only === "home") {
  checkLaunchPad();
  // Over the whole planet (every other column): how much each biome covers, in how many patches, and the biggest.
  const S = 2, N = WORLD / S, kind = new Uint8Array(N * N), names = [...BIOME_NAMES, "Sea"];
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) { const c = column(i * S, j * S); kind[j * N + i] = c.h < SEA ? names.length - 1 : c.biome; }
  const seen = new Uint8Array(N * N), patches = names.map(() => []);
  for (let k = 0; k < N * N; k++) {
    if (seen[k]) continue;
    const v = kind[k], stack = [k];
    let n = 0;
    seen[k] = 1;
    while (stack.length) {
      const q = stack.pop(), x = q % N, z = (q / N) | 0;
      n++;
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nk = ((z + dz + N) % N) * N + ((x + dx + N) % N);
        if (!seen[nk] && kind[nk] === v) { seen[nk] = 1; stack.push(nk); }
      }
    }
    patches[v].push(n * S * S);
  }
  console.log("planet:", names.map((name, b) => {
    const p = patches[b].sort((a, c) => c - a), area = p.reduce((a, c) => a + c, 0);
    return `${name} ${((area / (WORLD * WORLD)) * 100).toFixed(1)}% (${p.length} patches, biggest ~${Math.round(Math.sqrt(p[0] ?? 0))}²)`;
  }).join(", "));
}

// Timing: generateChunk on chunks not seen yet, and naturalBlock at scattered spots near the ground (each one new to
// its caches) and in the room's pattern around a broken block (the block, its six neighbours, where the player stands).
for (const zone of ZONE_KEYS) {
  if (only && only !== zone) continue;
  const fresh = [];
  for (let i = 0; i < 120; i++) fresh.push([(i * 7 + 3) % CHUNKS, (i * 13 + 29) % CHUNKS + (i % 2) * CHUNKS]); // (half written past the seam)
  let t = performance.now();
  for (const [cx, cz] of fresh) generateChunk(cx, cz, zone);
  const genMs = (performance.now() - t) / fresh.length;
  const spots = [], breaks = [];
  for (let k = 0; k < 50000; k++) {
    const x = (rnd() * WORLD) | 0, z = (rnd() * WORLD) | 0;
    spots.push([x, column(x, z, zone).h - 1 + ((rnd() * 8) | 0), z]);
  }
  for (let k = 0; k < 10000; k++) {
    const x = (rnd() * WORLD) | 0, z = (rnd() * WORLD) | 0; // (the six neighbours of x = 0 or WORLD - 1 cross the seam)
    breaks.push([x, column(x, z, zone).h + ((rnd() * 3) | 0) - 1, z]);
  }
  let s = 0, n = 0;
  t = performance.now();
  for (const [x, y, z] of spots) { s += naturalBlock(x, y, z, zone); n++; }
  const scattered = ((performance.now() - t) * 1000) / n;
  n = 0;
  t = performance.now();
  for (const [x, y, z] of breaks) {
    for (const [dx, dy, dz] of [[0, 0, 0], [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1], [2, 1, 2], [2, 2, 2]]) {
      s += naturalBlock(x + dx, y + dy, z + dz, zone);
      n++;
    }
  }
  const room = ((performance.now() - t) * 1000) / n;
  console.log(`${ZONES[zone].name}: generateChunk ${genMs.toFixed(2)} ms/chunk; naturalBlock ${scattered.toFixed(2)} µs/call scattered near the ground, ${room.toFixed(2)} µs/call around a break (${s})`);
}

if (bad) {
  console.log(`FAILED: ${bad} problems`);
  process.exit(1);
}
console.log("OK: naturalBlock and generateChunk agree everywhere checked on every planet, each wraps seamlessly, and the launch pad sits clear");
