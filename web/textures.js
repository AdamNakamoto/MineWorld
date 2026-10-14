// Every block face and item icon is drawn here, pixel by pixel, from fixed seeds: no image files, nothing borrowed.
// Block faces go into one 256 x 256 atlas (16 x 16 tiles of 16 x 16 pixels).

import { BLOCKS, TORCH, STICK, COAL, IRON, GOLD, DIAMOND, CRYSTAL, TOOLS, WOOD_PICK, STONE_PICK, IRON_PICK, DIAMOND_PICK,
  WOOD_SWORD, STONE_SWORD, IRON_SWORD, DIAMOND_SWORD } from "./blocks.js";

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
    for (let y = 6; y < T; y++) { set(7, y, 0x6b4f2e); set(8, y, 0x7d5d36); }
    for (let y = 3; y < 6; y++) { set(7, y, 0xffd84a); set(8, y, 0xffb12e); }
    set(7, 2, 0xfff3b0); set(8, 2, 0xffe27a);
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

const iconCache = new Map();
/// A small picture of an item for the hotbar and inventory (a data URL).
export function iconFor(id, atlas) {
  if (iconCache.has(id)) return iconCache.get(id);
  const c = document.createElement("canvas");
  c.width = c.height = 32;
  const g = c.getContext("2d");
  g.imageSmoothingEnabled = false;
  if (id < 64) drawBlockIcon(g, id, atlas);
  else drawItemIcon(g, id);
  const url = c.toDataURL();
  iconCache.set(id, url);
  return url;
}

function drawBlockIcon(g, id, atlas) {
  const [top, side] = faceTiles(id);
  const src = (i) => [(i % ATLAS_TILES) * T, Math.floor(i / ATLAS_TILES) * T];
  if (id === TORCH) {
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

function drawItemIcon(g, id) {
  const px = (x, y, c) => { g.fillStyle = c; g.fillRect(x * 2, y * 2, 2, 2); };
  const gem = (c1, c2) => {
    const pts = [[7, 4], [8, 4], [6, 5], [7, 5], [8, 5], [9, 5], [5, 6], [6, 6], [7, 6], [8, 6], [9, 6], [10, 6], [6, 7], [7, 7], [8, 7], [9, 7], [7, 8], [8, 8], [7, 9], [8, 9]];
    for (const [x, y] of pts) px(x, y + 2, (x + y) % 3 ? c1 : c2);
  };
  const tool = TOOLS[id];
  const head = { 0: "#b88d55", 1: "#8a8a8a", 2: "#e4e4e4", 3: "#5fe8e0" };
  if (id === STICK) { for (let i = 0; i < 12; i++) px(3 + i, 13 - i, i % 2 ? "#6b4f2e" : "#7d5d36"); return; }
  if (id === COAL) return gem("#2a2a2a", "#4a4a4a");
  if (id === IRON) return gem("#d8d0c8", "#a89c90");
  if (id === GOLD) return gem("#f5d33a", "#d1a520");
  if (id === DIAMOND) return gem("#5fe8e0", "#2fb0b0");
  if (id === CRYSTAL) return gem("#d25bff", "#8f2fd0");
  if (tool?.kind === "pick") {
    const c = head[[WOOD_PICK, STONE_PICK, IRON_PICK, DIAMOND_PICK].indexOf(id)];
    for (let i = 0; i < 10; i++) px(4 + i, 13 - i + 0, i % 2 ? "#6b4f2e" : "#7d5d36");
    for (const [x, y] of [[6, 2], [7, 2], [8, 2], [9, 2], [10, 2], [11, 3], [12, 3], [13, 4], [13, 5], [14, 6], [14, 7], [5, 3], [4, 3]]) px(x, y + 1, c);
    return;
  }
  if (tool?.kind === "sword") {
    const c = head[[WOOD_SWORD, STONE_SWORD, IRON_SWORD, DIAMOND_SWORD].indexOf(id)];
    for (let i = 0; i < 9; i++) { px(6 + i, 9 - i, c); px(7 + i, 9 - i, c); }
    for (const [x, y] of [[3, 10], [4, 9], [5, 10], [6, 11], [4, 11]]) px(x, y, "#5a4a3a");
    px(3, 12, "#6b4f2e"); px(2, 13, "#7d5d36");
    return;
  }
  g.fillStyle = "#f0f";
  g.fillRect(8, 8, 16, 16);
}
