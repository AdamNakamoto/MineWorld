// Checks that web/worldgen.js gives the same world one block at a time (naturalBlock, what the world server uses to
// check and pay for breaks) as a chunk at a time (generateChunk, what the game draws), over chunks in the town, along
// the seam where the planet wraps round (chunk 0 and chunk CHUNKS - 1 in x or z) and in every biome; that the world
// repeats every WORLD blocks (naturalBlock(x + WORLD, y, z) is naturalBlock(x, y, z), and generateChunk(-1, ...) is
// generateChunk(CHUNKS - 1, ...)) with no step at the seam; how much of the planet each biome covers; and times it all.
//
//   node tools/check-worldgen.mjs [chunks per biome, default 6]

import { generateChunk, naturalBlock, column, index, CHUNKS, BIOME_NAMES } from "../web/worldgen.js";
import { BLOCKS } from "../web/blocks.js";
import { CHUNK, HEIGHT, TOWN, WORLD, SEA } from "../web/rules.js";

const perBiome = Number(process.argv[2] ?? 6);
const picked = new Map(); // "cx,cz" -> why
const add = (cx, cz, why) => { if (cx >= 0 && cz >= 0 && cx < CHUNKS && cz < CHUNKS && !picked.has(`${cx},${cz}`)) picked.set(`${cx},${cz}`, why); };

// The town and its edge.
const tcx = Math.floor(TOWN.x / CHUNK), tcz = Math.floor(TOWN.z / CHUNK);
for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) if (Math.abs(dx) + Math.abs(dz) <= 2) add(tcx + dx, tcz + dz, "town");
// The seam: every chunk with x or z chunk 0 or CHUNKS - 1 (trees, caves and ores reach across it).
const L = CHUNKS - 1;
for (let k = 0; k < CHUNKS; k++) for (const [cx, cz] of [[0, k], [L, k], [k, 0], [k, L]]) add(cx, cz, "seam");
// Every biome: chunks whose middle is in it, spread over the world.
const byBiome = BIOME_NAMES.map(() => []);
for (let cz = 1; cz < CHUNKS - 1; cz += 1) for (let cx = 1; cx < CHUNKS - 1; cx += 1) {
  byBiome[column(cx * CHUNK + 8, cz * CHUNK + 8).biome].push([cx, cz]);
}
byBiome.forEach((list, b) => {
  for (let k = 0; k < perBiome && list.length; k++) {
    const [cx, cz] = list[Math.floor(((k + 0.5) / perBiome) * list.length)];
    add(cx, cz, BIOME_NAMES[b]);
  }
});

let bad = 0, blocks = 0;
const kinds = new Map();
const chunkCache = new Map();
const genTimes = [];
for (const [k, why] of picked) {
  const [cx, cz] = k.split(",").map(Number);
  const t = performance.now();
  const chunk = generateChunk(cx, cz);
  genTimes.push(performance.now() - t);
  chunkCache.set(k, chunk);
  for (let lz = 0; lz < CHUNK; lz++) for (let lx = 0; lx < CHUNK; lx++) for (let y = 0; y < HEIGHT; y++) {
    const want = chunk[index(lx, y, lz)];
    const got = naturalBlock(cx * CHUNK + lx, y, cz * CHUNK + lz);
    blocks++;
    kinds.set(want, (kinds.get(want) ?? 0) + 1);
    if (want !== got && bad++ < 20) console.log(`MISMATCH chunk ${k} (${why}) at ${cx * CHUNK + lx},${y},${cz * CHUNK + lz}: chunk ${BLOCKS[want]?.name}, single ${BLOCKS[got]?.name}`);
  }
}
const whys = {};
for (const why of picked.values()) whys[why] = (whys[why] ?? 0) + 1;
console.log(`${picked.size} chunks (${Object.entries(whys).map(([w, n]) => `${w} ${n}`).join(", ")}), ${blocks.toLocaleString()} blocks compared`);
console.log("blocks seen:", [...kinds].filter(([id]) => id).sort((a, b) => b[1] - a[1]).map(([id, n]) => `${BLOCKS[id].name} ${n}`).join(", "));
const missing = BIOME_NAMES.filter((_, b) => !byBiome[b].length);
if (missing.length) { console.log("FAILED: biomes not found:", missing.join(", ")); bad++; }

// The planet repeats: a block anywhere is the block WORLD (or 2 WORLD) away in x, z or both, whichever way the
// caller writes it, and a chunk past the seam is the one from the other side.
let seed = 12345;
const rnd = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296;
let wrapped = 0;
for (let k = 0; k < 40000; k++) {
  // Mostly near the seam and near the ground, where trees and caves cross it.
  const near = k % 2 === 0;
  const x = near ? (WORLD - 12 + ((rnd() * 24) | 0)) % WORLD : (rnd() * WORLD) | 0;
  const z = k % 4 < 2 ? (WORLD - 12 + ((rnd() * 24) | 0)) % WORLD : (rnd() * WORLD) | 0;
  const y = k % 3 === 0 ? (rnd() * HEIGHT) | 0 : Math.max(0, Math.min(HEIGHT - 1, column(x, z).h - 6 + ((rnd() * 24) | 0)));
  const want = naturalBlock(x, y, z);
  for (const [ox, oz] of [[WORLD, 0], [-WORLD, 0], [0, WORLD], [0, -WORLD], [WORLD, -WORLD], [2 * WORLD, 2 * WORLD]]) {
    const got = naturalBlock(x + ox, y, z + oz);
    wrapped++;
    if (got !== want && bad++ < 20) console.log(`NOT PERIODIC at ${x},${y},${z} (+${ox},+${oz}): ${BLOCKS[want]?.name} vs ${BLOCKS[got]?.name}`);
  }
}
for (const [cx, cz] of [[-1, 0], [0, -1], [-1, -1], [CHUNKS, 5], [7, CHUNKS], [-1, CHUNKS]]) {
  const a = generateChunk(cx, cz), b = generateChunk(((cx % CHUNKS) + CHUNKS) % CHUNKS, ((cz % CHUNKS) + CHUNKS) % CHUNKS);
  wrapped++;
  if (!a.every((v, i) => v === b[i]) && bad++ < 20) console.log(`NOT PERIODIC: generateChunk(${cx}, ${cz})`);
}
// No step at the seam: the ground across x = WORLD-1 | 0 (and z) is no rougher than across a line in the middle.
let seamStep = 0, midStep = 0;
for (let t = 0; t < WORLD; t++) {
  seamStep = Math.max(seamStep, Math.abs(column(WORLD - 1, t).h - column(0, t).h), Math.abs(column(t, WORLD - 1).h - column(t, 0).h));
  midStep = Math.max(midStep, Math.abs(column(WORLD / 2 - 1, t).h - column(WORLD / 2, t).h), Math.abs(column(t, WORLD / 2 - 1).h - column(t, WORLD / 2).h));
}
console.log(`periodic: ${wrapped.toLocaleString()} wrapped lookups; biggest ground step across the seam ${seamStep}, across the middle ${midStep}`);
if (seamStep > Math.max(4, midStep * 2)) { console.log("FAILED: the ground steps at the seam"); bad++; }
// Over the whole planet (every other column): how much each biome covers, in how many patches, and the biggest.
{
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
const fresh = [];
for (let i = 0; i < 120; i++) fresh.push([(i * 7 + 3) % CHUNKS, (i * 13 + 29) % CHUNKS + (i % 2) * CHUNKS]); // (half written past the seam)
let t = performance.now();
for (const [cx, cz] of fresh) generateChunk(cx, cz);
const genMs = (performance.now() - t) / fresh.length;
const spots = [], breaks = [];
for (let k = 0; k < 100000; k++) {
  const x = (rnd() * WORLD) | 0, z = (rnd() * WORLD) | 0;
  spots.push([x, column(x, z).h - 1 + ((rnd() * 8) | 0), z]);
}
for (let k = 0; k < 20000; k++) {
  const x = (rnd() * WORLD) | 0, z = (rnd() * WORLD) | 0; // (the six neighbours of x = 0 or WORLD - 1 cross the seam)
  breaks.push([x, column(x, z).h + ((rnd() * 3) | 0) - 1, z]);
}
let s = 0, n = 0;
t = performance.now();
for (const [x, y, z] of spots) { s += naturalBlock(x, y, z); n++; }
const scattered = ((performance.now() - t) * 1000) / n;
n = 0;
t = performance.now();
for (const [x, y, z] of breaks) {
  for (const [dx, dy, dz] of [[0, 0, 0], [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1], [2, 1, 2], [2, 2, 2]]) {
    s += naturalBlock(x + dx, y + dy, z + dz);
    n++;
  }
}
const room = ((performance.now() - t) * 1000) / n;
console.log(`generateChunk ${genMs.toFixed(2)} ms/chunk; naturalBlock ${scattered.toFixed(2)} µs/call scattered near the ground, ${room.toFixed(2)} µs/call around a break (${s})`);

if (bad) {
  console.log(`FAILED: ${bad} problems`);
  process.exit(1);
}
console.log("OK: naturalBlock and generateChunk agree everywhere checked, and the planet wraps seamlessly");
