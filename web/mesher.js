// Turns a chunk's blocks into two meshes' worth of triangles: solid and cut-out faces (leaves, glass) in one, water
// in the other. Only faces next to see-through blocks are drawn. Each corner carries ambient occlusion, a face shade,
// sky light (from how deep it is under the highest solid block of its column) and block light (torches, lamps,
// crystal ore within 8 blocks, without occlusion: cheap, and good enough for version one).

import { BLOCKS, AIR, WATER, TORCH, LEAVES, GLASS } from "./blocks.js";
import { CHUNK, HEIGHT } from "./rules.js";
import { faceTiles, ATLAS_TILES } from "./textures.js";

const P = CHUNK + 2; // padded width
const pidx = (x, y, z) => (y * P + z) * P + x; // x, z in 0..17 (chunk-local + 1)

const OPAQUE = new Uint8Array(256), SOLIDISH = new Uint8Array(256), LIGHT = new Float32Array(256);
const TILES = [];
for (const b of BLOCKS) {
  if (!b) continue;
  OPAQUE[b.id] = b.opaque ? 1 : 0;
  SOLIDISH[b.id] = b.opaque || b.id === LEAVES ? 1 : 0; // what casts ambient occlusion
  LIGHT[b.id] = b.light;
  if (b.tex) TILES[b.id] = faceTiles(b.id);
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
// UVs for the corners above: side faces put the tile upright.
const UV = [[0, 0], [1, 0], [1, 1], [0, 1]];
const AO = [1, 0.78, 0.62, 0.48];

class Buf {
  constructor(n) { this.pos = new Float32Array(n * 3); this.uv = new Float32Array(n * 2); this.lit = new Float32Array(n * 3); this.idx = []; this.n = 0; }
  grow() {
    const g = (a, k) => { const b = new Float32Array(a.length * 2); b.set(a); return b; };
    this.pos = g(this.pos); this.uv = g(this.uv); this.lit = g(this.lit);
  }
  vert(x, y, z, u, v, shade, sky, block) {
    if ((this.n + 1) * 3 > this.pos.length) this.grow();
    const i = this.n++;
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    this.uv[i * 2] = u; this.uv[i * 2 + 1] = v;
    this.lit[i * 3] = shade; this.lit[i * 3 + 1] = sky; this.lit[i * 3 + 2] = block;
    return i;
  }
  out() {
    return { pos: this.pos.slice(0, this.n * 3), uv: this.uv.slice(0, this.n * 2), lit: this.lit.slice(0, this.n * 3), idx: Uint32Array.from(this.idx) };
  }
}

const EPS = 0.0008;
function tileUV(tileI, u, v) {
  const tx = tileI % ATLAS_TILES, ty = Math.floor(tileI / ATLAS_TILES);
  const s = 1 / ATLAS_TILES;
  return [(tx + EPS + u * (1 - 2 * EPS)) * s, 1 - (ty + EPS + (1 - v) * (1 - 2 * EPS)) * s];
}

/// `get(lx, y, lz)` reads blocks for lx, lz in -1..16 (this chunk and a one-block rim of its neighbours);
/// `tops(lx, lz)` the highest light-blocking y of a column in the same range; `lights` the glowing blocks nearby,
/// as [lx, y, lz, strength] in chunk coordinates.
export function meshChunk(get, tops, lights) {
  const pad = new Uint8Array(P * P * HEIGHT);
  const top = new Int16Array(P * P);
  let ymax = 0;
  for (let z = 0; z < P; z++) for (let x = 0; x < P; x++) {
    top[z * P + x] = tops(x - 1, z - 1);
    for (let y = 0; y < HEIGHT; y++) {
      const b = get(x - 1, y, z - 1);
      pad[pidx(x, y, z)] = b;
      if (b !== AIR && y > ymax) ymax = y;
    }
  }
  const at = (x, y, z) => (y < 0 ? 1 : y >= HEIGHT ? AIR : pad[pidx(x, y, z)]);
  // Open sky above a column lights it fully; under cover it fades block by block, and light from an open column
  // next door spills in a little (so walls under an overhang, and cave mouths, aren't black).
  const colSky = (x, y, z) => {
    if (x < 0 || z < 0 || x >= P || z >= P) return 0;
    const t = top[z * P + x];
    return y > t ? 1 : Math.max(0, 1 - (t - y + 1) * 0.16);
  };
  const skyAt = (x, y, z) => {
    if (y >= HEIGHT) return 1;
    const own = colSky(x, y, z);
    if (own >= 1) return 1;
    const side = Math.max(colSky(x + 1, y, z), colSky(x - 1, y, z), colSky(x, y, z + 1), colSky(x, y, z - 1)) * 0.8;
    return Math.max(own, side);
  };
  const near = lights.filter(([lx, , lz]) => lx > -10 && lz > -10 && lx < CHUNK + 9 && lz < CHUNK + 9);
  const blockAt = (x, y, z) => {
    let best = 0;
    for (const [lx, ly, lz, s] of near) {
      const dx = lx - x, dy = ly - y, dz = lz - z;
      const d = Math.abs(dx) + Math.abs(dy) + Math.abs(dz);
      const v = s * (1 - d / 9);
      if (v > best) best = v;
    }
    return best;
  };

  const solid = new Buf(4096), water = new Buf(1024);
  for (let y = 0; y <= ymax; y++) {
    for (let z = 1; z <= CHUNK; z++) {
      for (let x = 1; x <= CHUNK; x++) {
        const b = pad[pidx(x, y, z)];
        if (b === AIR) continue;
        if (b === TORCH) { torch(solid, x - 1, y, z - 1, skyAt(x, y, z), blockAt(x - 1, y, z - 1)); continue; }
        const isWater = b === WATER;
        const buf = isWater ? water : solid;
        const tiles = TILES[b];
        for (let f = 0; f < 6; f++) {
          const F = FACES[f];
          const nx = x + F.n[0], ny = y + F.n[1], nz = z + F.n[2];
          const nb = at(nx, ny, nz);
          if (OPAQUE[nb]) continue;
          if (nb === b && (isWater || b === GLASS || b === LEAVES)) continue;
          if (isWater && nb !== AIR && f !== 0) continue; // water only shows against air (and its top)
          const sky = skyAt(nx, Math.min(ny, HEIGHT - 1), nz);
          const bl = blockAt(nx - 1, ny, nz - 1);
          const lowTop = isWater && f === 0 && at(x, y + 1, z) !== WATER;
          const ao = [0, 0, 0, 0];
          const vi = [];
          for (let k = 0; k < 4; k++) {
            const c = F.c[k];
            let occ = 0;
            if (!isWater) {
              // The two side neighbours and the corner neighbour of this vertex, in the cell in front of the face.
              const s = [0, 0, 0], t = [0, 0, 0];
              let ax = 0;
              for (let a = 0; a < 3; a++) {
                if (F.n[a] !== 0) continue;
                const d = c[a] ? 1 : -1;
                if (ax++ === 0) s[a] = d; else t[a] = d;
              }
              const s1 = SOLIDISH[at(nx + s[0], ny + s[1], nz + s[2])];
              const s2 = SOLIDISH[at(nx + t[0], ny + t[1], nz + t[2])];
              const cc = SOLIDISH[at(nx + s[0] + t[0], ny + s[1] + t[1], nz + s[2] + t[2])];
              occ = s1 && s2 ? 3 : s1 + s2 + cc;
            }
            ao[k] = occ;
            const [u, v] = tileUV(tiles[F.t], UV[k][0], UV[k][1]);
            const vy = y + (lowTop && c[1] ? 0.88 : c[1]);
            vi.push(buf.vert(x - 1 + c[0], vy, z - 1 + c[2], u, v, F.shade * AO[occ], sky, bl));
          }
          // Split the quad along the diagonal that keeps the occlusion smooth.
          if (ao[0] + ao[2] > ao[1] + ao[3]) buf.idx.push(vi[1], vi[2], vi[3], vi[1], vi[3], vi[0]);
          else buf.idx.push(vi[0], vi[1], vi[2], vi[0], vi[2], vi[3]);
        }
      }
    }
  }
  return { solid: solid.out(), water: water.out() };
}

/// A torch: a thin stick, drawn as two crossed planes so it reads from every side.
function torch(buf, x, y, z, sky, block) {
  const tileI = TILES[TORCH][0];
  const quads = [
    [[0.5, 0, 0.0], [0.5, 0, 1.0], [0.5, 1, 1.0], [0.5, 1, 0.0]],
    [[0.0, 0, 0.5], [1.0, 0, 0.5], [1.0, 1, 0.5], [0.0, 1, 0.5]],
  ];
  for (const q of quads) {
    for (const flip of [false, true]) {
      const vi = q.map((c, k) => {
        const [u, v] = tileUV(tileI, UV[k][0], UV[k][1]);
        return buf.vert(x + c[0], y + c[1], z + c[2], u, v, 1, sky, Math.max(block, 1));
      });
      if (flip) buf.idx.push(vi[0], vi[2], vi[1], vi[0], vi[3], vi[2]);
      else buf.idx.push(vi[0], vi[1], vi[2], vi[0], vi[2], vi[3]);
    }
  }
}

export { LIGHT, OPAQUE };
