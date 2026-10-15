// Every block face and item icon is drawn here, pixel by pixel, from fixed seeds: no image files, nothing borrowed.
// Block faces go into one 256 x 256 atlas (16 x 16 tiles of 16 x 16 pixels).

import { BLOCKS, TORCH, STICK, COAL, IRON, GOLD, DIAMOND, CRYSTAL, WOOD_PICK, STONE_PICK, IRON_PICK, DIAMOND_PICK,
  WOOD_SWORD, STONE_SWORD, IRON_SWORD, DIAMOND_SWORD, APPLE, BERRIES, MUSHROOM_STEW, ARMOR, CRYSTAL_PICK, CRYSTAL_SWORD, WAR_HAMMER } from "./blocks.js";

const T = 16;
export const ATLAS_TILES = 16;

function prng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}
const hex = (c) => [(c >> 16) & 255, (c >> 8) & 255, c & 255];
const clamp = (v) => Math.max(0, Math.min(255, v | 0));

/// A 16 x 16 tile as an ImageData-like RGBA array, painted by `fn(px, py, set)`.
function tile(seed, fn) {
  const d = new Uint8ClampedArray(T * T * 4);
  const r = prng(seed);
  const set = (x, y, c, a = 255, j = 0) => {
    if (x < 0 || y < 0 || x >= T || y >= T) return;
    const [R, G, B] = hex(c);
    const k = (y * T + x) * 4, n = j ? (r() - 0.5) * j : 0;
    d[k] = clamp(R + n); d[k + 1] = clamp(G + n); d[k + 2] = clamp(B + n); d[k + 3] = a;
  };
  fn(set, r);
  return d;
}
const noisy = (base, jitter, seed) => tile(seed, (set) => { for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) set(x, y, base, 255, jitter); });
function blend(a, b, t) {
  const A = hex(a), B = hex(b);
  return (clamp(A[0] + (B[0] - A[0]) * t) << 16) | (clamp(A[1] + (B[1] - A[1]) * t) << 8) | clamp(A[2] + (B[2] - A[2]) * t);
}

function stoneTile(seed, base = 0x7f7f7f) {
  return tile(seed, (set, r) => {
    for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) set(x, y, base, 255, 26);
    for (let i = 0; i < 9; i++) {
      const x = (r() * T) | 0, y = (r() * T) | 0, len = 1 + ((r() * 3) | 0);
      for (let k = 0; k < len; k++) set(x + k, y, blend(base, 0x000000, 0.25), 255, 8);
    }
  });
}
function oreTile(seed, color, glow = false) {
  const d = stoneTile(seed);
  const r = prng(seed + 7);
  for (let i = 0; i < 5; i++) {
    const cx = 2 + ((r() * 12) | 0), cy = 2 + ((r() * 12) | 0);
    for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1], [-1, 0], [0, -1]]) {
      if (r() < 0.25 && !(dx === 0 && dy === 0)) continue;
      const x = cx + dx, y = cy + dy, k = (y * T + x) * 4;
      const [R, G, B] = hex(dx === 0 && dy === 0 && !glow ? blend(color, 0xffffff, 0.35) : color);
      const n = (r() - 0.5) * 30;
      d[k] = clamp(R + n); d[k + 1] = clamp(G + n); d[k + 2] = clamp(B + n);
    }
  }
  return d;
}

/// A one-pixel line from (x0, y0) to (x1, y1).
function line(set, x0, y0, x1, y1, c, j = 0) {
  const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
  for (let k = 0; k <= n; k++) set(Math.round(x0 + ((x1 - x0) * k) / n), Math.round(y0 + ((y1 - y0) * k) / n), c, 255, j);
}
/// A plant's stem with a leaf or two on it, from the bottom of the tile up to `top`.
function stem(set, x, top, leafY = 11) {
  for (let y = top; y < T; y++) set(x, y, y > 12 ? 0x3c7a26 : 0x4f9a30, 255, 8);
  for (const [dx, dy] of [[-1, 0], [-2, -1], [-3, -1]]) set(x + dx, leafY + dy, 0x5aa83a, 255, 10);
  for (const [dx, dy] of [[1, 2], [2, 1], [3, 1]]) set(x + dx, leafY + dy, 0x4a9030, 255, 10);
}

const TILES = {
  dirt: () => tile(11, (set, r) => {
    for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) set(x, y, r() < 0.12 ? 0x6b4a30 : r() < 0.1 ? 0x9a7352 : 0x86603f, 255, 18);
  }),
  grass_top: () => tile(12, (set, r) => {
    for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) set(x, y, r() < 0.15 ? 0x4f8a2a : r() < 0.1 ? 0x77b545 : 0x62a136, 255, 20);
  }),
  grass_side: () => tile(13, (set, r) => {
    for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) set(x, y, r() < 0.12 ? 0x6b4a30 : 0x86603f, 255, 18);
    for (let x = 0; x < T; x++) {
      const drip = 3 + (r() < 0.4 ? 1 : 0) + (r() < 0.15 ? 1 : 0);
      for (let y = 0; y < drip; y++) set(x, y, 0x62a136, 255, 22);
    }
  }),
  stone: () => stoneTile(14),
  cobble: () => tile(15, (set, r) => {
    for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) set(x, y, 0x707070, 255, 24);
    const pts = Array.from({ length: 9 }, () => [r() * T, r() * T, 0x8a8a8a + (((r() * 3) | 0) - 1) * 0x0a0a0a]);
    for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) {
      let best = 1e9, second = 1e9, c = 0;
      for (const [px, py, col] of pts) {
        const dx = Math.min(Math.abs(x - px), T - Math.abs(x - px)), dy = Math.min(Math.abs(y - py), T - Math.abs(y - py));
        const dd = dx * dx + dy * dy;
        if (dd < best) { second = best; best = dd; c = col; } else if (dd < second) second = dd;
      }
      set(x, y, Math.sqrt(second) - Math.sqrt(best) < 1.1 ? 0x4a4a4a : c, 255, 16);
    }
  }),
  sand: () => tile(16, (set, r) => { for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) set(x, y, r() < 0.1 ? 0xc9bf88 : 0xdcd3a2, 255, 14); }),
  gravel: () => tile(17, (set, r) => {
    for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) {
      const v = r();
      set(x, y, v < 0.2 ? 0x5e5a58 : v < 0.4 ? 0x8f8a86 : v < 0.5 ? 0x7a6a5a : 0x77726f, 255, 20);
    }
  }),
  log_side: () => tile(18, (set, r) => {
    for (let x = 0; x < T; x++) {
      const c = x % 4 === 0 ? 0x4e3a22 : x % 4 === 2 ? 0x765a38 : 0x664c2e;
      for (let y = 0; y < T; y++) set(x, y, r() < 0.08 ? 0x3f2f1b : c, 255, 12);
    }
  }),
  log_top: () => tile(19, (set) => {
    for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) {
      const d = Math.max(Math.abs(x - 7.5), Math.abs(y - 7.5));
      set(x, y, d > 6.6 ? 0x5a4329 : Math.floor(d) % 2 ? 0xa98552 : 0xb8955f, 255, 10);
    }
  }),
  leaves: () => tile(20, (set, r) => {
    for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) {
      if (r() < 0.18) set(x, y, 0x000000, 0);
      else set(x, y, r() < 0.2 ? 0x2f6b1f : 0x3f8a2a, 255, 26);
    }
  }),
  planks: () => tile(21, (set, r) => {
    for (let y = 0; y < T; y++) {
      const row = Math.floor(y / 4), off = row % 2 ? 7 : 2;
      for (let x = 0; x < T; x++) {
        const seam = y % 4 === 3 || (x + 16 - off) % 16 === 0;
        set(x, y, seam ? 0x7a5a32 : row % 2 ? 0xb88d55 : 0xae8450, 255, seam ? 6 : 12);
      }
    }
    void r;
  }),
  bedrock: () => tile(22, (set, r) => { for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) set(x, y, r() < 0.3 ? 0x1e1e1e : r() < 0.5 ? 0x555555 : 0x3a3a3a, 255, 20); }),
  water: () => tile(23, (set, r) => {
    for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) set(x, y, (x + y * 2) % 7 === 0 ? 0x5f8fe8 : 0x3b6fd6, 190, 10);
    void r;
  }),
  coal_ore: () => oreTile(24, 0x222222),
  iron_ore: () => oreTile(25, 0xd8af93),
  gold_ore: () => oreTile(26, 0xf5d33a),
  diamond_ore: () => oreTile(27, 0x5fe8e0),
  mine_ore: () => oreTile(28, 0xd25bff, true),
  snow_top: () => tile(29, (set, r) => { for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) set(x, y, r() < 0.1 ? 0xdfe8f0 : 0xf6fafc, 255, 8); }),
  snow_side: () => tile(30, (set, r) => {
    for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) set(x, y, r() < 0.12 ? 0x6b4a30 : 0x86603f, 255, 18);
    for (let x = 0; x < T; x++) { const drip = 3 + (r() < 0.5 ? 1 : 0); for (let y = 0; y < drip; y++) set(x, y, 0xf4f8fb, 255, 8); }
  }),
  sandstone: () => tile(31, (set, r) => {
    for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) set(x, y, y % 5 === 4 ? 0xb9ad78 : 0xd6cb95, 255, 10);
    void r;
  }),
  glass: () => tile(32, (set) => {
    for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) {
      const edge = x === 0 || y === 0 || x === T - 1 || y === T - 1;
      const streak = (x - y === 3 || x - y === 4) && x > 3 && x < 10;
      set(x, y, edge ? 0xd8eef5 : 0xffffff, edge ? 255 : streak ? 140 : 0);
    }
  }),
  bricks: () => tile(33, (set) => {
    for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) {
      const row = Math.floor(y / 8), off = row % 2 ? 8 : 0;
      const seam = y % 8 === 7 || (x + off) % 16 === 15;
      set(x, y, seam ? 0x555555 : 0x8c8c8c, 255, seam ? 6 : 14);
    }
  }),
  torch: () => tile(34, (set) => {
    for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) set(x, y, 0, 0);
    // A stick, lit on its left and darker at its foot, charred under a flame that's white hot at the top.
    for (let y = 7; y < T; y++) { set(7, y, y > 13 ? 0x6b4a24 : 0x8a6436); set(8, y, y > 13 ? 0x3e2914 : 0x5a3d1c); }
    set(7, 6, 0x3a2a18); set(8, 6, 0x2b1c0b);
    const flame = [[0xfff8d8, 0xfff0a8], [0xffe46a, 0xffcf40], [0xffc23a, 0xff9e24], [0xff9e24, 0xe8701a]];
    flame.forEach(([a, b], i) => { set(7, 2 + i, a); set(8, 2 + i, b); });
  }),
  cactus_side: () => tile(35, (set, r) => {
    for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) {
      if (x === 0 || x === 15) { set(x, y, 0, 0); continue; }
      set(x, y, x % 4 === 1 ? 0x2c6e2c : 0x3f8f3a, 255, 14);
      if (r() < 0.05) set(x, y, 0xe8e2b0);
    }
  }),
  cactus_top: () => tile(36, (set) => {
    for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) {
      const edge = x === 0 || x === 15 || y === 0 || y === 15;
      set(x, y, edge ? 0 : Math.max(Math.abs(x - 7.5), Math.abs(y - 7.5)) > 5 ? 0x2c6e2c : 0x5aa64e, edge ? 0 : 255, 10);
    }
  }),
  lamp: () => tile(37, (set) => {
    for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) {
      const edge = x === 0 || y === 0 || x === T - 1 || y === T - 1;
      const d = Math.abs(x - 7.5) + Math.abs(y - 7.5);
      set(x, y, edge ? 0x4a3a5a : d < 4 ? 0xffffff : d < 7 ? 0xf0c8ff : 0xc890f0, 255, edge ? 6 : 8);
    }
  }),
  roof: () => tile(38, (set) => {
    for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) {
      const row = Math.floor(y / 4), off = row % 2 ? 4 : 0;
      const seam = y % 4 === 3 || (x + off) % 8 === 7;
      set(x, y, seam ? 0x7a2e22 : 0xb2483a, 255, 14);
    }
  }),
  // Plants: drawn on a clear background, shown as two crossed pictures.
  tall_grass: () => tile(60, (set, r) => {
    for (let b = 0; b < 12; b++) {
      let x = 0.5 + b * 1.25 + r() * 1.2;
      const h = 7 + ((r() * 9) | 0), lean = (x - 7.5) * 0.04 + (r() - 0.5) * 0.3;
      for (let k = 0; k < h; k++) {
        set(Math.round(x), T - 1 - k, k > h - 3 ? 0x8cc456 : k < 3 ? 0x3e7a24 : r() < 0.5 ? 0x5a9c34 : 0x68aa3c, 255, 14);
        x += lean;
      }
    }
  }),
  fern: () => tile(61, (set) => {
    // Five fronds fanning out from the root, each a rib with leaflets that shrink towards its tip.
    for (const [ex, ey] of [[0, 6], [3, 1], [8, 0], [13, 1], [15, 7]]) {
      const n = 12;
      for (let k = 1; k <= n; k++) {
        const t = k / n;
        // A gentle arch: the rib rises first, then leans out.
        const x = 7.5 + (ex - 7.5) * t * t, y = 15 - (15 - ey) * (2 * t - t * t);
        set(Math.round(x), Math.round(y), 0x2e6a22, 255, 6);
        if (k % 2 || k < 3) continue;
        const len = Math.max(1, Math.round((1 - t) * 3));
        // Leaflets at right angles to the rib.
        const dx = (ex - 7.5) * 2 * t, dy = -(15 - ey) * (2 - 2 * t);
        const l = Math.hypot(dx, dy) || 1, px = -dy / l, py = dx / l;
        for (let i = 1; i <= len; i++) {
          set(Math.round(x + px * i), Math.round(y + py * i), 0x4a8f34, 255, 12);
          set(Math.round(x - px * i), Math.round(y - py * i), 0x58a23c, 255, 12);
        }
      }
    }
  }),
  flower_yellow: () => tile(62, (set) => {
    stem(set, 7, 7);
    // A round, five-petalled bloom with an orange eye.
    for (let y = 1; y <= 7; y++) for (let x = 4; x <= 11; x++) {
      const dx = x - 7.5, dy = y - 4;
      const d = dx * dx + dy * dy;
      if (d > 11.5) continue;
      set(x, y, d < 1.8 ? 0xd9821c : (x + y) % 3 === 0 ? 0xfff27e : 0xf2cf2e, 255, 10);
    }
  }),
  flower_red: () => tile(63, (set) => {
    stem(set, 7, 6, 12);
    // A flame-shaped bloom: one tall middle petal between two short curled ones.
    const rows = [
      "......R.........", ".....RR.........", ".....RhR........", "..R..RhR..R.....", "..RR.RRR.RR.....",
      "...RRRRRRR......", "...dRRRRRd......", "....ddRdd.......",
    ];
    rows.forEach((row, y) => [...row].forEach((ch, x) => {
      if (ch === "R") set(x + 1, y, 0xd8322a, 255, 12);
      else if (ch === "h") set(x + 1, y, 0xff7a52, 255, 6);
      else if (ch === "d") set(x + 1, y, 0x921a16, 255, 6);
    }));
  }),
  flower_blue: () => tile(64, (set) => {
    // An arching stem with three little bells hanging from it.
    line(set, 8, 15, 8, 5, 0x3c7a26);
    line(set, 8, 5, 11, 2, 0x4f9a30); line(set, 11, 2, 13, 3, 0x4f9a30);
    for (const [dx, dy] of [[-1, 0], [-2, -1]]) set(8 + dx, 12 + dy, 0x5aa83a, 255, 10);
    for (const [bx, by] of [[5, 6], [9, 5], [13, 5]]) {
      const pts = [[0, 0, 0x7a96ff], [-1, 1, 0x4a6ae0], [0, 1, 0x5a7af0], [1, 1, 0x4a6ae0], [-1, 2, 0x2e46a8], [0, 2, 0x4a6ae0], [1, 2, 0x2e46a8]];
      for (const [x, y, c] of pts) set(bx + x, by + y, c, 255, 8);
      if (bx === 5) line(set, 5, 5, 8, 7, 0x4f9a30);
    }
  }),
  berry_bush: () => tile(65, (set, r) => {
    for (let y = 3; y < T; y++) for (let x = 0; x < T; x++) {
      const dx = (x - 7.5) / 7.5, dy = (y - 10) / 6.5;
      const d = dx * dx + dy * dy;
      if (d > 1 || (d > 0.7 && r() < 0.45) || r() < 0.08) continue;
      set(x, y, r() < 0.3 ? 0x24561c : 0x33702a, 255, 18);
    }
    for (let i = 0; i < 7; i++) {
      const x = 2 + ((r() * 11) | 0), y = 5 + ((r() * 8) | 0);
      set(x, y, 0xc8203a); set(x + 1, y, 0xa01830); set(x, y + 1, 0xa01830); set(x + 1, y + 1, 0x7e1226); set(x, y, 0xff7088);
    }
  }),
  red_mushroom: () => tile(66, (set, r) => {
    for (let y = 10; y < T; y++) for (let x = 6; x <= 9; x++) set(x, y, x === 9 ? 0xc8bca0 : 0xece2c8, 255, 8);
    for (let y = 3; y <= 9; y++) for (let x = 2; x <= 13; x++) {
      const dx = (x - 7.5) / 6, dy = (y - 9.5) / 6.5;
      if (dx * dx + dy * dy > 1) continue;
      set(x, y, y === 9 ? 0x8e1a1c : 0xc8262a, 255, 10);
    }
    for (const [x, y] of [[5, 5], [6, 5], [9, 4], [10, 6], [11, 6], [4, 7], [7, 7], [8, 7]]) set(x, y, 0xf6f0e4, 255, 6);
    void r;
  }),
  brown_mushroom: () => tile(67, (set) => {
    for (let y = 11; y < T; y++) for (let x = 7; x <= 8; x++) set(x, y, x === 8 ? 0xc8bca0 : 0xe2d8bc, 255, 8);
    for (let y = 8; y <= 11; y++) for (let x = 1; x <= 14; x++) {
      const w = y === 8 ? 4 : y === 9 ? 6 : 7;
      if (Math.abs(x - 7.5) > w) continue;
      set(x, y, y === 11 ? 0x6a4a2e : y === 8 ? 0xc29462 : 0xa2724a, 255, 10);
    }
  }),
  dry_shrub: () => tile(68, (set) => {
    line(set, 8, 15, 8, 9, 0x6e5230); line(set, 8, 11, 4, 6, 0x8a6a3a); line(set, 8, 10, 12, 5, 0x8a6a3a);
    line(set, 8, 9, 7, 3, 0x7a5c34); line(set, 5, 8, 2, 7, 0x8a6a3a); line(set, 11, 7, 14, 7, 0x7a5c34);
    line(set, 6, 9, 5, 12, 0x6e5230); line(set, 10, 9, 12, 11, 0x6e5230);
  }),
  // The dark forest's giant trees, and pines.
  dark_log_side: () => tile(69, (set, r) => {
    for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) set(x, y, r() < 0.15 ? 0x2a2018 : 0x3d2e22, 255, 10);
    // Deep grooves that wander a little, and a knot.
    for (const gx of [1, 5, 9, 13]) {
      let x = gx + (r() < 0.5 ? 0 : 1);
      for (let y = 0; y < T; y++) {
        set(x, y, 0x1e1712, 255, 6);
        set(x + 1, y, 0x4e3c2c, 255, 8);
        if (r() < 0.18) x += r() < 0.5 ? -1 : 1;
        x = Math.max(gx - 1, Math.min(gx + 2, x));
      }
    }
    set(10, 7, 0x1a1410); set(11, 7, 0x1a1410); set(10, 8, 0x2a2018); set(11, 8, 0x1a1410);
  }),
  dark_log_top: () => tile(70, (set) => {
    for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) {
      const d = Math.sqrt((x - 7.5) * (x - 7.5) + (y - 7.5) * (y - 7.5));
      set(x, y, d > 6.8 ? 0x2a2018 : Math.floor(d * 1.3) % 2 ? 0x6a4c36 : 0x5a3e2c, 255, 8);
    }
  }),
  dark_leaves: () => tile(71, (set, r) => {
    for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) {
      if (r() < 0.14) { set(x, y, 0, 0); continue; }
      const v = r();
      set(x, y, v < 0.25 ? 0x173a12 : v < 0.8 ? 0x224c1a : 0x2f5e22, 255, 14);
    }
  }),
  pine_leaves: () => tile(72, (set, r) => {
    for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) {
      if (r() < 0.12) { set(x, y, 0, 0); continue; }
      // Needles in little diagonal rows.
      const needle = (x + y * 2) % 5 === 0 || (x * 2 - y + 32) % 7 === 0;
      set(x, y, needle ? 0x46785a : r() < 0.3 ? 0x1f4430 : 0x2b5a3e, 255, 10);
    }
  }),
  // The rocket's zones (zones.js): Cinderfall, Red Mesa, Deepvein, and the landing pads.
  basalt_side: () => tile(80, (set, r) => {
    // Tall columns, a little paler at their joints.
    for (let x = 0; x < T; x++) {
      const c = x % 5 === 0 ? 0x2a2a30 : x % 5 === 1 ? 0x4a4a54 : 0x3a3a42;
      for (let y = 0; y < T; y++) set(x, y, r() < 0.06 ? 0x26262c : c, 255, 10);
    }
  }),
  basalt_top: () => tile(81, (set, r) => {
    for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) {
      const d = Math.max(Math.abs(x - 7.5), Math.abs(y - 7.5));
      set(x, y, d > 6.6 ? 0x2a2a30 : r() < 0.1 ? 0x2e2e36 : 0x40404a, 255, 10);
    }
  }),
  ember: () => tile(82, (set, r) => {
    // Dark crust over glowing cracks.
    for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) set(x, y, 0x3a1c14, 255, 12);
    for (let i = 0; i < 5; i++) {
      let x = (r() * T) | 0, y = (r() * T) | 0;
      for (let k = 0; k < 9; k++) {
        set(x, y, k % 3 ? 0xff8a1e : 0xffd04a, 255, 20);
        x = (x + ((r() * 3) | 0) - 1 + T) % T;
        y = (y + ((r() * 3) | 0) - 1 + T) % T;
      }
    }
  }),
  ash: () => tile(83, (set, r) => { for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) set(x, y, r() < 0.12 ? 0x55555a : r() < 0.1 ? 0x8a8a8c : 0x6e6e72, 255, 14); }),
  red_sand: () => tile(84, (set, r) => { for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) set(x, y, r() < 0.12 ? 0xa8502a : 0xc66a36, 255, 16); }),
  red_clay: () => tile(85, (set, r) => {
    for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) set(x, y, y % 8 === 3 ? 0x8e3e26 : 0xa34a2e, 255, 10);
    void r;
  }),
  pale_clay: () => tile(86, (set, r) => {
    for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) set(x, y, y % 8 === 5 ? 0xc8a88a : 0xdcbfa0, 255, 10);
    void r;
  }),
  deep_rock: () => tile(87, (set, r) => {
    for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) set(x, y, 0x3e4048, 255, 18);
    for (let i = 0; i < 7; i++) {
      const x = (r() * T) | 0, y = (r() * T) | 0;
      for (let k = 0; k < 3; k++) set(x + k, y + (k >> 1), 0x2a2c32, 255, 6);
    }
    for (let i = 0; i < 4; i++) set((r() * T) | 0, (r() * T) | 0, 0x5a5e6a, 255, 10);
  }),
  glowcap: () => tile(88, (set) => {
    for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) set(x, y, 0, 0);
    // Three little glowing mushrooms.
    for (const [cx, top, w] of [[4, 7, 2], [10, 4, 3], [13, 9, 1]]) {
      for (let y = top + 2; y < T; y++) set(cx, y, 0xb8e8d0, 255, 8);
      for (let dx = -w; dx <= w; dx++) { set(cx + dx, top + 1, 0x3fd6c0, 255, 10); if (Math.abs(dx) < w) set(cx + dx, top, 0x9ffff0, 255, 10); }
    }
  }),
  pad_plate: () => tile(89, (set) => {
    for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) {
      const edge = x === 0 || y === 0, rivet = (x === 2 || x === 13) && (y === 2 || y === 13);
      const stripe = (x + y) % 8 < 2 && (y < 3 || y > 12);
      set(x, y, rivet ? 0xd8dce4 : edge ? 0x5a606a : stripe ? 0xe8b830 : 0x8a909a, 255, edge ? 4 : 8);
    }
  }),
  crack0: () => crack(1), crack1: () => crack(2), crack2: () => crack(3), crack3: () => crack(4), crack4: () => crack(5),
};
function crack(stage) {
  return tile(50, (set, r) => {
    for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) set(x, y, 0, 0);
    for (let i = 0; i < stage * 3; i++) {
      let x = 8 + ((r() - 0.5) * 6) | 0, y = 8 + ((r() - 0.5) * 6) | 0;
      for (let k = 0; k < 3 + stage; k++) {
        set(x, y, 0x101010, 200);
        x += ((r() * 3) | 0) - 1;
        y += ((r() * 3) | 0) - 1;
      }
    }
  });
}

const names = Object.keys(TILES);
const tileIndex = Object.fromEntries(names.map((n, i) => [n, i]));
export const tileOf = (name) => tileIndex[name];

/// The atlas canvas (browser only).
export function makeAtlas() {
  const c = document.createElement("canvas");
  c.width = c.height = T * ATLAS_TILES;
  const g = c.getContext("2d");
  names.forEach((n, i) => {
    const img = new ImageData(TILES[n](), T, T);
    g.putImageData(img, (i % ATLAS_TILES) * T, Math.floor(i / ATLAS_TILES) * T);
  });
  return c;
}

/// Atlas tiles for a block's faces: [top, side, bottom].
export function faceTiles(id) {
  const t = BLOCKS[id].tex ?? ["stone"];
  const top = tileOf(t[0]), side = tileOf(t[1] ?? t[0]), bottom = tileOf(t[2] ?? t[0]);
  return [top, side, bottom];
}

// ---------------------------------------------------------------- item icons

const iconCache = new Map(), canvasCache = new Map();
/// A small picture of an item for the hotbar and inventory (a data URL).
export function iconFor(id, atlas) {
  if (iconCache.has(id)) return iconCache.get(id);
  const url = iconCanvas(id, atlas).toDataURL();
  iconCache.set(id, url);
  return url;
}
/// The same picture as a 32 x 32 canvas (items are 16 x 16 pixel art drawn at twice the size): held.js reads its
/// pixels to give a held item thickness. Shared: don't draw on it.
export function iconCanvas(id, atlas) {
  if (canvasCache.has(id)) return canvasCache.get(id);
  const c = document.createElement("canvas");
  c.width = c.height = 32;
  const g = c.getContext("2d");
  g.imageSmoothingEnabled = false;
  if (id < 64) drawBlockIcon(g, id, atlas);
  else drawItemIcon(g, id);
  canvasCache.set(id, c);
  return c;
}

function drawBlockIcon(g, id, atlas) {
  const [top, side] = faceTiles(id);
  const src = (i) => [(i % ATLAS_TILES) * T, Math.floor(i / ATLAS_TILES) * T];
  if (id === TORCH || BLOCKS[id]?.plant) {
    const [sx, sy] = src(top);
    g.drawImage(atlas, sx, sy, T, T, 0, 0, 32, 32);
    return;
  }
  // A little isometric cube: top, left and right faces with shading.
  const face = (tileI, shade, m) => {
    const [sx, sy] = src(tileI);
    g.save();
    g.setTransform(...m);
    g.drawImage(atlas, sx, sy, T, T, 0, 0, T, T);
    g.fillStyle = `rgba(0,0,0,${shade})`;
    g.globalCompositeOperation = "source-atop";
    g.fillRect(0, 0, T, T);
    g.restore();
  };
  face(top, 0, [1, 0.5, -1, 0.5, 16, 0]);
  face(side, 0.18, [1, 0.5, 0, 1, 0, 8]);
  face(side, 0.35, [1, -0.5, 0, 1, 16, 16]);
}

// Food, as 16 x 16 pixel pictures ("." is empty).
const FOOD_ART = {
  [APPLE]: [[
    "................", ".......s........", "......s.LL......", "......sLLL......", "...RRRsRRRR.....",
    "..RRhhRRRRRR....", ".RRhhRRRRRRRR...", ".RRhRRRRRRRRR...", ".RRRRRRRRRRRd...", ".RRRRRRRRRRRd...",
    ".RRRRRRRRRRdd...", "..RRRRRRRRdd....", "..dRRRRRRRdd....", "...ddRRdddd.....", ".....d..d.......", "................",
  ], { R: "#d8302c", h: "#ff9a86", d: "#94201c", s: "#6b4a2a", L: "#5aa83a" }],
  [BERRIES]: [[
    "................", "........LL......", ".......LLs......", "......s.s.......", ".....s...s......",
    "...BBB..BBB.....", "..BhBBB.BhBB....", "..BBBBdBBBBd....", "..BBBBdBBBBd....", "...dddBBBddd....",
    ".......BhBB.....", "......BBBBBd....", "......BBBBBd....", ".......dddd.....", "................", "................",
  ], { B: "#c42446", h: "#ff8aa0", d: "#7a1430", s: "#4f7a2a", L: "#5aa83a" }],
  [MUSHROOM_STEW]: [[
    "................", "................", "................", "................", "................",
    "..oooooooooooo..", ".oSSrSSSScSSSSo.", ".WSSSScSSSrSSSW.", ".WwSSSSSSSSSSwW.", "..WwwwwwwwwwwW..",
    "..WWwwwwwwwwWW..", "...WWWwwwwWWW...", "....WWWWWWWW....", ".....kkkkkk.....", "................", "................",
  ], { o: "#5a3a1e", S: "#b0703a", r: "#d8302c", c: "#f0e2c0", W: "#8a5c32", w: "#a87442", k: "#5a3a1e" }],
};
/// Draws 16 x 16 art ("." is empty) in palette `pal`. `rim` (0..1) darkens the pixels round its outside by that much,
/// an outline in each pixel's own colour, darker.
function pixelArt(px, [rows, pal], rim = 0) {
  const solid = (x, y) => (rows[y]?.[x] ?? ".") !== ".";
  const darken = (c) => "#" + [1, 3, 5].map((i) => Math.round(parseInt(c.slice(i, i + 2), 16) * (1 - rim)).toString(16).padStart(2, "0")).join("");
  rows.forEach((row, y) => [...row].forEach((ch, x) => {
    if (ch === ".") return;
    const edge = rim > 0 && !(solid(x - 1, y) && solid(x + 1, y) && solid(x, y - 1) && solid(x, y + 1));
    px(x, y, edge ? darken(pal[ch]) : pal[ch]);
  }));
}

// Tools, weapons and materials: 16 x 16 pixel art in the classic block games' manner, drawn here (not copied from
// anyone's textures): a dark outline round the outside, three or four shades inside lit from the top left, and the
// tools laid corner to corner, the handle from the bottom left. One shape per kind, its letters shades:
// o d m l h a material's outline, dark, mid, light and highlight; O W w the wooden handle's outline, dark and light.
/// A material's shades: [outline, dark, mid, light, highlight].
const MATERIALS = {
  wood: ["#4a3418", "#7d5a2b", "#a77f45", "#c9a062", "#e6c58a"],
  stone: ["#29292b", "#505054", "#76767a", "#98989c", "#bcbcc0"],
  iron: ["#3b3b40", "#85858d", "#b6b6be", "#d8d8dd", "#ffffff"],
  diamond: ["#0c3431", "#136b64", "#1fa498", "#45d6c8", "#a9f5ec"],
  crystal: ["#250843", "#4f1a85", "#7f34c2", "#a95ee8", "#ef86ff"],
  steel: ["#202228", "#454953", "#6c717d", "#959ba8", "#cdd2dc"], // the war hammer's dark steel
  coal: ["#0b0b0d", "#232327", "#36363c", "#505058", "#767680"],
  gold: ["#5a3d05", "#a9740e", "#dca21c", "#f4cd45", "#fff0a0"],
  leather: ["#3d2412", "#6b4325", "#8f5d35", "#b07a4a", "#cf9d6c"], // Padded armor
};
const HANDLE = ["#2b1c0b", "#4f3418", "#7a552a"]; // outline, dark, light
const shades = (m) => {
  const [o, d, mid, l, h] = MATERIALS[m];
  return { o, d, m: mid, l, h, O: HANDLE[0], W: HANDLE[1], w: HANDLE[2] };
};
// A pickaxe: the crescent head mirrors itself across the handle's diagonal, a point either side.
const PICK_ART = [
  "......ooooo.....",
  "...ooolhhlloo...",
  ".oollhmmlmlhlo..",
  "omlooooooomlhlo.",
  "ooo.......omllo.",
  "..........womlmo",
  ".........WO.olmo",
  "........wO..olmo",
  ".......WO...olmo",
  "......wO....oldo",
  ".....WO.....omo.",
  "....wO......odo.",
  "...WO.......omo.",
  "..wO.......odo..",
  ".WO........odo..",
  "OO.........oo...",
];
// A sword: the blade outlined, a light ridge with highlights, the crossguard, the grip and the pommel. (Its tip stops a
// pixel short of the corner, so it stays in view in first person.)
const SWORD_ART = [
  "............oo..",
  "...........oho..",
  "..........ohlo..",
  ".........olmo...",
  "........ohmo....",
  ".......olmo.....",
  "......olmo......",
  "..o..oldo.......",
  "..omoldo........",
  "...dldo.........",
  "...wdm..........",
  "..WO.do.........",
  ".wO...o.........",
  "lm..............",
  "mo..............",
  "................",
];
// The war hammer: a heavy block of a head across a long handle.
const HAMMER_ART = [
  "........o.......",
  ".......oho......",
  "......ohhho.....",
  "......olllho....",
  ".......omllho...",
  "........omlmlo..",
  ".........odmmlo.",
  "........wOodmdmo",
  ".......WO..oddo.",
  "......wO....oo..",
  ".....WO.........",
  "....wO..........",
  "...WO...........",
  "..wO............",
  ".WO.............",
  "OO..............",
];
// Materials: a coal lump, ingots, a cut diamond and a cluster of $MINE crystal.
const LUMP_ART = [
  "................", "................", "................", "......oooo......", "....oodmmdoo....",
  "...odmlhmmddo...", "..odmlhlmmmddo..", "..odmmlmmmmddo..", "..oddmmmmmdddo..", "...odddmmddddo..",
  "...ooddddddoo...", ".....oooooo.....", "................", "................", "................", "................",
];
const INGOT_ART = [
  "................", "................", "................", "................", "................",
  "....oooooooo....", "...ohhhhhhhlo...", "..ohllllllllmo..", ".ommmmmmmmmmmdo.", ".ollmmmmmmmmddo.",
  ".odddddddddddoo.", ".oooooooooooooo.", "................", "................", "................", "................",
];
const GEM_ART = [
  "................", "................", "....oooooooo....", "...ohhllllmmo...", "..ohlhlllllmmo..",
  ".ohllllllllmmdo.", ".oddmmmmmmmmddo.", "..ollmmmmmmddo..", "...olmmmmmddo...", "....olmmmddo....",
  ".....olmddo.....", "......oldo......", ".......oo.......", "................", "................", "................",
];
const CLUSTER_ART = [
  "................", ".......oo.......", "......ohlo......", ".....ohlmdo.....", ".....ohlmdo.oo..",
  ".....ohlmdoolmo.", "..oo.ohlmdolmdo.", ".ohloohlmdolmdo.", ".ohlmohlmdolmdo.", ".ohlmohlmdolmdo.",
  ".ohlmohlmdolmdo.", ".ohlmohlmdolmdo.", ".ohlmohlmdolmdo.", ".oooooooooooooo.", "................", "................",
];
/// Item id -> [its art, its material].
const ITEM_ART = {
  [WOOD_PICK]: [PICK_ART, "wood"], [STONE_PICK]: [PICK_ART, "stone"], [IRON_PICK]: [PICK_ART, "iron"],
  [DIAMOND_PICK]: [PICK_ART, "diamond"], [CRYSTAL_PICK]: [PICK_ART, "crystal"],
  [WOOD_SWORD]: [SWORD_ART, "wood"], [STONE_SWORD]: [SWORD_ART, "stone"], [IRON_SWORD]: [SWORD_ART, "iron"],
  [DIAMOND_SWORD]: [SWORD_ART, "diamond"], [CRYSTAL_SWORD]: [SWORD_ART, "crystal"],
  [WAR_HAMMER]: [HAMMER_ART, "steel"],
  [COAL]: [LUMP_ART, "coal"], [IRON]: [INGOT_ART, "iron"], [GOLD]: [INGOT_ART, "gold"],
  [DIAMOND]: [GEM_ART, "diamond"], [CRYSTAL]: [CLUSTER_ART, "crystal"],
};

function drawItemIcon(g, id) {
  const px = (x, y, c) => { g.fillStyle = c; g.fillRect(x * 2, y * 2, 2, 2); };
  if (ARMOR[id]) return drawArmor(px, ARMOR[id]);
  if (ITEM_ART[id]) return pixelArt(px, [ITEM_ART[id][0], shades(ITEM_ART[id][1])]);
  if (id === STICK) {
    // The handle on its own, corner to corner, darker at its ends.
    for (let v = 1; v <= 14; v++) {
      px(14 - v, v, v === 1 || v === 14 ? HANDLE[0] : HANDLE[v % 2 ? 2 : 1]);
      px(15 - v, v, HANDLE[0]);
    }
    return;
  }
  if (id === APPLE || id === BERRIES || id === MUSHROOM_STEW) return pixelArt(px, FOOD_ART[id], 0.45);
  g.fillStyle = "#f0f";
  g.fillRect(8, 8, 16, 16);
}

/// Armor by tier (Padded, Iron, Diamond, Crystal): its material (MATERIALS), and the colours worn armor is drawn in
/// (avatar.js): main, shade, highlight.
const ARMOR_MATERIALS = ["leather", "iron", "diamond", "crystal"];
export const ARMOR_COLOURS = ARMOR_MATERIALS.map((m) => [MATERIALS[m][3], MATERIALS[m][2], MATERIALS[m][4]]);
// The four pieces, letters as the tools' (o d m l h).
const ARMOR_ART = {
  head: [
    "................", "................", "................", ".....oooooo.....", "...oohhhllloo...",
    "..ohhlllllllmo..", "..ohllllllllmo..", "..olllmmmmmmdo..", "..olmoooooomdo..", "..olmo....omdo..",
    "..olmo....omdo..", "..oooo....oooo..", "................", "................", "................", "................",
  ],
  chest: [
    "................", "................", "..ooo......ooo..", ".ohlo......olmo.", ".ohlloooooolmdo.",
    ".ohlhhllllllmdo.", ".oolllllllllmoo.", "..ollllllllmdo..", "..ollmmmmmmmdo..", "..olmmmmmmmmdo..",
    "...olmmmmmmdo...", "...oddddddddo...", "...oooooooooo...", "................", "................", "................",
  ],
  legs: [
    "................", "................", "..oooooooooooo..", "..ohhhhhhhhhlo..", "..olllllllllmo..",
    "..ollmmmmmmmdo..", "..ollmo..olmdo..", "..olmdo..olmdo..", "..olmdo..olmdo..", "..olmdo..olmdo..",
    "..olmdo..olmdo..", "..odddo..odddo..", "..ooooo..ooooo..", "................", "................", "................",
  ],
  feet: [
    "................", "................", "................", "................", "................",
    "................", "................", "...oooo...oooo..", "...ohlo...ohlo..", "...olmo...olmo..",
    ".oohlmo.oohlmo..", ".ohllmo.ohllmo..", ".odddmo.odddmo..", ".oooooo.oooooo..", "................", "................",
  ],
};
function drawArmor(px, a) {
  pixelArt(px, [ARMOR_ART[a.slot], shades(ARMOR_MATERIALS[a.tier - 1])]);
}
