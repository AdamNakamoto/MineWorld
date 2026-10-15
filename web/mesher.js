// Turns a chunk's blocks into two meshes' worth of triangles: solid and cut-out faces (leaves, glass, plants) in one,
// water in the other. Only faces next to see-through blocks are drawn; plants and torches are two crossed pictures.
// Each corner carries ambient occlusion, a face shade, sky light (from how deep it is under the highest light-blocking
// block of its column) and block light (torches, lamps, crystal ore within 8 blocks, without occlusion: cheap, and
// good enough for version one); leaves let some light through, so under trees it's shady, not black. Runs in the
// world worker (world-worker.js) and, for edits, on the main thread.
//
// The output is compact, to keep a wide view distance light on memory: positions in 1/16 blocks (Uint16, the mesh is
// scaled by 1/16), texture coordinates as normalised Uint16, light as normalised Uint8, and Uint16 indices when they fit.

import { BLOCKS, AIR, WATER, TORCH, GLASS } from "./blocks.js";
import { CHUNK, HEIGHT } from "./rules.js";
import { faceTiles, ATLAS_TILES } from "./textures.js";

const P = CHUNK + 2; // padded width
const pidx = (x, y, z) => (y * P + z) * P + x; // x, z in 0..17 (chunk-local + 1)
const S = 16; // position units per block

const OPAQUE = new Uint8Array(256), SOLIDISH = new Uint8Array(256), LEAFY = new Uint8Array(256), CROSS = new Uint8Array(256);
/// Blocks that keep the sky off the column below them (not leaves, which only shade it, nor plants, torches or water).
export const SKY_BLOCK = new Uint8Array(256);
/// Blocks that give off light, and how much (0..1).
export const LIGHT = new Float32Array(256);
const TILES = [];
for (const b of BLOCKS) {
  if (!b) continue;
  OPAQUE[b.id] = b.opaque ? 1 : 0;
  LEAFY[b.id] = b.leaves ? 1 : 0;
  SOLIDISH[b.id] = b.opaque || b.leaves ? 1 : 0; // what casts ambient occlusion
  CROSS[b.id] = b.plant || b.id === TORCH ? 1 : 0;
  SKY_BLOCK[b.id] = (b.opaque || (b.cutout && b.solid)) && !b.leaves ? 1 : 0;
  LIGHT[b.id] = b.light;
  if (b.tex) TILES[b.id] = faceTiles(b.id);
}

/// Column (lx, lz) of a chunk's blocks: the highest y that keeps the sky off it (0 if none), plus 256 times the highest
/// leaves above that (0 if none). `& 255` is the top; `>> 8` the leaves.
export function columnTop(blocks, lx, lz) {
  let leaves = 0;
  for (let i = ((HEIGHT - 1) << 8) | (lz << 4) | lx; i > 255; i -= 256) {
    const b = blocks[i];
    if (SKY_BLOCK[b]) return (i >> 8) | (leaves << 8);
    if (!leaves && LEAFY[b]) leaves = i >> 8;
  }
  return leaves << 8;
}
/// All 256 column tops of a chunk (as columnTop).
export function chunkTops(blocks, out = new Uint16Array(CHUNK * CHUNK)) {
  for (let lz = 0; lz < CHUNK; lz++) for (let lx = 0; lx < CHUNK; lx++) out[lz * CHUNK + lx] = columnTop(blocks, lx, lz);
  return out;
}
/// Lays a chunk's new list of edits (Map index -> block) over its blocks, where `prev` was laid before: what `prev`
/// changed and `next` doesn't goes back to what the world was made with (`natural(x, y, z)`). Returns the indices
/// that changed, and whether a light came or went.
export function patchEdits(blocks, x0, z0, prev, next, natural) {
  const changed = [];
  let lit = false;
  const put = (i, b) => {
    if (!(i >= 0 && i < blocks.length) || blocks[i] === b) return;
    if (LIGHT[blocks[i]] > 0 || LIGHT[b] > 0) lit = true;
    blocks[i] = b;
    changed.push(i);
  };
  if (prev) for (const i of prev.keys()) if (!next.has(i)) put(i, natural(x0 + (i & 15), i >> 8, z0 + ((i >> 4) & 15)));
  for (const [i, b] of next) put(i, b);
  return { changed, lit };
}
/// How much open sky reaches height y of a column whose top is `t` (columnTop): all of it above everything, fading
/// block by block under cover, and shady under leaves (the deeper, the shadier) down to a dim forest floor.
export function columnSky(t, y) {
  const rock = t & 255;
  if (y <= rock) return Math.max(0, 1 - (rock - y + 1) * 0.16);
  const leaves = t >> 8;
  return y > leaves ? 1 : Math.max(0.4, 0.86 - (leaves - y) * 0.035);
}
/// What's left of a glowing block's light (strength s) d blocks away (counted along the axes).
export const lightReach = (s, d) => s * (1 - d / 9);
/// The glowing blocks of a chunk, as [lx, y, lz, strength].
export function chunkLights(blocks) {
  const out = [];
  for (let i = 0; i < blocks.length; i++) if (LIGHT[blocks[i]] > 0) out.push([i & 15, i >> 8, (i >> 4) & 15, LIGHT[blocks[i]]]);
  return out;
}

// Faces: normal, the 4 corners (counter-clockwise seen from outside), and which tile (0 top, 1 side, 2 bottom).
const FACES = [
  { n: [0, 1, 0], c: [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]], t: 0, shade: 1.0 },
  { n: [0, -1, 0], c: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]], t: 2, shade: 0.5 },
  { n: [1, 0, 0], c: [[1, 0, 1], [1, 0, 0], [1, 1, 0], [1, 1, 1]], t: 1, shade: 0.8 },
  { n: [-1, 0, 0], c: [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]], t: 1, shade: 0.8 },
  { n: [0, 0, 1], c: [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]], t: 1, shade: 0.65 },
  { n: [0, 0, -1], c: [[1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 1, 0]], t: 1, shade: 0.65 },
];
// The side and corner neighbours that occlude each corner of each face (offsets from the cell in front of the face).
const AO_NB = FACES.map((F) => F.c.map((c) => {
  const s = [0, 0, 0], t = [0, 0, 0];
  let ax = 0;
  for (let a = 0; a < 3; a++) {
    if (F.n[a] !== 0) continue;
    const d = c[a] ? 1 : -1;
    if (ax++ === 0) s[a] = d; else t[a] = d;
  }
  return [s, t, [s[0] + t[0], s[1] + t[1], s[2] + t[2]]];
}));
// UVs for the corners above: side faces put the tile upright.
const UV = [[0, 0], [1, 0], [1, 1], [0, 1]];
const AO = [1, 0.78, 0.62, 0.48];

class Buf {
  constructor(n) {
    this.pos = new Uint16Array(n * 3); this.uv = new Uint16Array(n * 2); this.lit = new Uint8Array(n * 3);
    this.idx = new Uint32Array(n * 1.5); this.n = 0; this.ni = 0;
  }
  vert(x, y, z, u, v, shade, sky, block) {
    if (this.n * 3 + 3 > this.pos.length) {
      const g = (a) => { const b = new a.constructor(a.length * 2); b.set(a); return b; };
      this.pos = g(this.pos); this.uv = g(this.uv); this.lit = g(this.lit);
    }
    const i = this.n++;
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    this.uv[i * 2] = u; this.uv[i * 2 + 1] = v;
    this.lit[i * 3] = shade * 255 + 0.5; this.lit[i * 3 + 1] = sky * 255 + 0.5; this.lit[i * 3 + 2] = block * 255 + 0.5;
    return i;
  }
  tri(a, b, c, d, e, f) {
    if (this.ni + 6 > this.idx.length) { const x = new Uint32Array(this.idx.length * 2); x.set(this.idx); this.idx = x; }
    const I = this.idx, k = this.ni;
    I[k] = a; I[k + 1] = b; I[k + 2] = c; I[k + 3] = d; I[k + 4] = e; I[k + 5] = f;
    this.ni += 6;
  }
  out() {
    const idx = this.n <= 65535 ? Uint16Array.from(this.idx.subarray(0, this.ni)) : this.idx.slice(0, this.ni);
    return { pos: this.pos.slice(0, this.n * 3), uv: this.uv.slice(0, this.n * 2), lit: this.lit.slice(0, this.n * 3), idx };
  }
}

const EPS = 0.0008;
const UV_TABLE = []; // [tile][corner] -> [u, v] as Uint16 values
function tileUV(tileI, k) {
  let t = UV_TABLE[tileI];
  if (!t) {
    t = UV_TABLE[tileI] = [];
    const tx = tileI % ATLAS_TILES, ty = Math.floor(tileI / ATLAS_TILES), s = 1 / ATLAS_TILES;
    for (const [u, v] of UV) t.push([Math.round((tx + EPS + u * (1 - 2 * EPS)) * s * 65535), Math.round((1 - (ty + EPS + (1 - v) * (1 - 2 * EPS)) * s) * 65535)]);
  }
  return t[k];
}

/// Meshes one chunk from its neighbourhood: `blocks` and `tops` are 9 arrays each (or null outside the world), the
/// chunk and its 8 neighbours at [(dz + 1) * 3 + (dx + 1)]; `lights` the glowing blocks of all 9 as [lx, y, lz, s]
/// in this chunk's coordinates; (x0, z0) the chunk's first block (to vary where plants sit).
export function meshArea(blocks, tops, lights, x0 = 0, z0 = 0) {
  const pad = new Uint8Array(P * P * HEIGHT);
  const top = new Uint16Array(P * P);
  for (let pz = 0; pz < P; pz++) {
    const dz = pz === 0 ? -1 : pz === P - 1 ? 1 : 0, lz = pz - 1 - dz * CHUNK;
    for (let dx = -1; dx <= 1; dx++) {
      const k = (dz + 1) * 3 + dx + 1, b = blocks[k], t = tops[k];
      // The padded columns this neighbour fills: x 0 (dx -1), 1..16 (dx 0), 17 (dx 1).
      const px0 = dx < 0 ? 0 : dx > 0 ? P - 1 : 1, px1 = dx < 0 ? 1 : dx > 0 ? P : P - 1, lx0 = dx < 0 ? CHUNK - 1 : 0;
      if (!b) continue; // outside the world: air, open sky
      for (let px = px0; px < px1; px++) top[pz * P + px] = t[lz * CHUNK + lx0 + px - px0];
      for (let y = 0; y < HEIGHT; y++) {
        const src = (y << 8) | (lz << 4) | lx0, dst = pidx(px0, y, pz);
        if (px1 - px0 === 1) pad[dst] = b[src];
        else pad.set(b.subarray(src, src + CHUNK), dst);
      }
    }
  }
  return meshPadded(pad, top, lights, x0, z0);
}

/// The original interface: `get(lx, y, lz)` reads blocks for lx, lz in -1..16 (this chunk and a one-block rim of its
/// neighbours); `tops(lx, lz)` a column's top in the same range (as columnTop); `lights` as for meshArea.
export function meshChunk(get, tops, lights, x0 = 0, z0 = 0) {
  const pad = new Uint8Array(P * P * HEIGHT);
  const top = new Uint16Array(P * P);
  for (let z = 0; z < P; z++) for (let x = 0; x < P; x++) {
    top[z * P + x] = tops(x - 1, z - 1);
    for (let y = 0; y < HEIGHT; y++) pad[pidx(x, y, z)] = get(x - 1, y, z - 1);
  }
  return meshPadded(pad, top, lights, x0, z0);
}

function meshPadded(pad, top, lights, x0, z0) {
  let ymax = 0;
  for (let i = pad.length - 1; i >= 0; i--) if (pad[i] !== AIR) { ymax = Math.floor(i / (P * P)); break; }
  const at = (x, y, z) => (y < 0 ? 1 : y >= HEIGHT ? AIR : pad[pidx(x, y, z)]);
  // Open sky above a column lights it fully; under cover it fades block by block, and light from an open column
  // next door spills in a little (so walls under an overhang, and cave mouths, aren't black). Under leaves it's
  // shady, the more so the deeper under them, down to a dim forest floor.
  const colSky = (x, y, z) => (x < 0 || z < 0 || x >= P || z >= P ? 0 : columnSky(top[z * P + x], y));
  const skyAt = (x, y, z) => {
    if (y >= HEIGHT) return 1;
    const own = colSky(x, y, z);
    if (own >= 1) return 1;
    const side = Math.max(colSky(x + 1, y, z), colSky(x - 1, y, z), colSky(x, y, z + 1), colSky(x, y, z - 1)) * 0.8;
    return Math.max(own, side);
  };
  const near = lights.filter(([lx, , lz]) => lx > -10 && lz > -10 && lx < CHUNK + 9 && lz < CHUNK + 9);
  const blockAt = near.length ? (x, y, z) => {
    let best = 0;
    for (const [lx, ly, lz, s] of near) {
      const v = lightReach(s, Math.abs(lx - x) + Math.abs(ly - y) + Math.abs(lz - z));
      if (v > best) best = v;
    }
    return best;
  } : () => 0;

  const solid = new Buf(8192), water = new Buf(512);
  for (let y = 0; y <= ymax; y++) {
    for (let z = 1; z <= CHUNK; z++) {
      for (let x = 1; x <= CHUNK; x++) {
        const b = pad[pidx(x, y, z)];
        if (b === AIR) continue;
        if (CROSS[b]) { cross(solid, b, x - 1, y, z - 1, skyAt(x, y, z), blockAt(x - 1, y, z - 1), x0, z0); continue; }
        const isWater = b === WATER;
        const buf = isWater ? water : solid;
        const tiles = TILES[b];
        for (let f = 0; f < 6; f++) {
          const F = FACES[f];
          const nx = x + F.n[0], ny = y + F.n[1], nz = z + F.n[2];
          const nb = at(nx, ny, nz);
          if (OPAQUE[nb]) continue;
          if (nb === b && (isWater || b === GLASS || LEAFY[b])) continue;
          if (isWater && nb !== AIR && f !== 0) continue; // water only shows against air (and its top)
          const sky = skyAt(nx, Math.min(ny, HEIGHT - 1), nz);
          const bl = blockAt(nx - 1, ny, nz - 1);
          const lowTop = isWater && f === 0 && at(x, y + 1, z) !== WATER;
          const tileI = tiles[F.t];
          let o0 = 0, o1 = 0, o2 = 0, o3 = 0;
          const vi = [0, 0, 0, 0];
          for (let k = 0; k < 4; k++) {
            const c = F.c[k];
            let occ = 0;
            if (!isWater) {
              const [s, t, st] = AO_NB[f][k];
              const s1 = SOLIDISH[at(nx + s[0], ny + s[1], nz + s[2])];
              const s2 = SOLIDISH[at(nx + t[0], ny + t[1], nz + t[2])];
              const cc = SOLIDISH[at(nx + st[0], ny + st[1], nz + st[2])];
              occ = s1 && s2 ? 3 : s1 + s2 + cc;
            }
            if (k === 0) o0 = occ; else if (k === 1) o1 = occ; else if (k === 2) o2 = occ; else o3 = occ;
            const [u, v] = tileUV(tileI, k);
            const vy = (y + c[1]) * S - (lowTop && c[1] ? 2 : 0);
            vi[k] = buf.vert((x - 1 + c[0]) * S, vy, (z - 1 + c[2]) * S, u, v, F.shade * AO[occ], sky, bl);
          }
          // Split the quad along the diagonal that keeps the occlusion smooth.
          if (o0 + o2 > o1 + o3) buf.tri(vi[1], vi[2], vi[3], vi[1], vi[3], vi[0]);
          else buf.tri(vi[0], vi[1], vi[2], vi[0], vi[2], vi[3]);
        }
      }
    }
  }
  return { solid: solid.out(), water: water.out() };
}

/// A torch (a thin stick across the middle) or a plant (corner to corner, nudged a little so a meadow doesn't look
/// planted in rows): two crossed pictures, each drawn from both sides.
function cross(buf, b, x, y, z, sky, block, x0, z0) {
  const tileI = TILES[b][0];
  let quads, shadeLo = 1;
  if (b === TORCH) {
    quads = [[[8, 0], [8, 16]], [[0, 8], [16, 8]]];
    block = Math.max(block, 1);
  } else {
    let h = Math.imul((x0 + x) | 0, 0x2c1b3c6d) ^ Math.imul((z0 + z) | 0, 0x297a2d39);
    h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
    const ox = ((h >>> 8) % 5) - 2, oz = ((h >>> 16) % 5) - 2; // (positions stay within 0..16: they're unsigned)
    quads = [[[2 + ox, 2 + oz], [14 + ox, 14 + oz]], [[14 + ox, 2 + oz], [2 + ox, 14 + oz]]];
    shadeLo = 0.72; // a little darker at the roots
  }
  const X = x * S, Y = y * S, Z = z * S;
  quads.forEach(([[ax, az], [bx, bz]], qi) => {
    const shade = qi ? 0.86 : 1;
    const c = [[ax, 0, az], [bx, 0, bz], [bx, S, bz], [ax, S, az]];
    const vi = c.map(([cx, cy, cz], k) => {
      const [u, v] = tileUV(tileI, k);
      return buf.vert(X + cx, Y + cy, Z + cz, u, v, shade * (cy ? 1 : shadeLo), sky, block);
    });
    buf.tri(vi[0], vi[1], vi[2], vi[0], vi[2], vi[3]);
    buf.tri(vi[0], vi[2], vi[1], vi[0], vi[3], vi[2]);
  });
}

export { OPAQUE };
