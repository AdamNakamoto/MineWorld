// What a miner holds, as a model for their hand (your own, in first person and seen with V, and everyone else's): a
// block is a small cube in its own textures; a tool, weapon, food, torch or plant is its 16 x 16 icon given one pixel
// of thickness, the way the classic block games draw a held item. Crystal things glow: a pale outline round the icon,
// unlit, so it shows at night too. One model is made per item and shared by every hand holding it (its meshes are
// marked userData.shared, so an avatar's dispose() leaves them alone). How it's held (the pose) is avatar.js's.

import * as THREE from "https://esm.sh/three@0.160.0";
import { BLOCKS, TORCH, WATER, TOOLS, ARMOR, CRYSTAL_PICK, CRYSTAL_SWORD } from "./blocks.js";
import { ATLAS_TILES, faceTiles, iconCanvas } from "./textures.js";

let atlas = null, atlasTex = null;
/// Call once with the block atlas: its canvas (for the icons) and the texture the world is drawn with.
export function setHeldAtlas(canvas, texture) {
  atlas = canvas;
  atlasTex = texture;
}

/// Points a box's UVs at atlas tiles, one per face (BoxGeometry's order: +x, -x, +y, -y, +z, -z; 4 vertices each).
export function tileUVs(geo, tilesForFaces) {
  const uv = geo.attributes.uv;
  const s = 1 / ATLAS_TILES;
  for (let f = 0; f < 6; f++) {
    const t = tilesForFaces[f], tx = t % ATLAS_TILES, ty = Math.floor(t / ATLAS_TILES);
    for (let k = 0; k < 4; k++) {
      const i = f * 4 + k;
      uv.setXY(i, (tx + uv.getX(i)) * s, 1 - (ty + 1 - uv.getY(i)) * s);
    }
  }
  uv.needsUpdate = true;
}

const isBlock = (id) => id < 64 && !BLOCKS[id]?.plant && id !== TORCH;
const N = 16; // an icon's pixels across
const cache = new Map();

/// A cube of block `id`, a quarter of a metre across, a little in front of the hand.
function blockMeshes(id) {
  const g = new THREE.BoxGeometry(0.24, 0.24, 0.24);
  const [top, side, bottom] = faceTiles(id);
  tileUVs(g, [side, side, top, bottom, side, side]);
  const m = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ map: atlasTex, alphaTest: 0.5, transparent: id === WATER }));
  m.position.set(0, -0.06, 0.1);
  return [m];
}

/// Item `id`'s icon, `size` metres across, one icon pixel thick: the picture on both faces, and the edge of every
/// pixel that borders a clear one filled in with that pixel's colour. Placed so the point (gx, gy) (icon pixels, y
/// down) is at the origin, where the hand holds it.
function itemMeshes(id, size, gx, gy, glow = null) {
  const canvas = iconCanvas(id, atlas);
  const data = canvas.getContext("2d").getImageData(0, 0, 32, 32).data;
  const S = size / N;
  const solid = (x, y) => x >= 0 && y >= 0 && x < N && y < N && data[(y * 2 * 32 + x * 2) * 4 + 3] > 128;
  const ox = -(gx + 0.5) * S, oy = (gy + 0.5) * S; // the icon's top left corner, from the grip

  // The faces: the icon itself, front and back.
  const tex = new THREE.CanvasTexture(canvas);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.colorSpace = THREE.SRGBColorSpace;
  // Each face shows only from its own side (the back is the same picture seen from behind, so mirrored, as a solid
  // thing would be): a two-sided face would show its mirror image through the clear parts of the other.
  const plane = new THREE.PlaneGeometry(size, size);
  const front = new THREE.Mesh(plane, new THREE.MeshLambertMaterial({ map: tex, alphaTest: 0.5, side: THREE.FrontSide }));
  const back = new THREE.Mesh(plane, new THREE.MeshLambertMaterial({ map: tex, alphaTest: 0.5, side: THREE.BackSide }));
  front.position.set(ox + size / 2, oy - size / 2, S / 2);
  back.position.set(ox + size / 2, oy - size / 2, -S / 2);

  // The edges: one quad (S square) per pixel side that faces a clear pixel.
  const pos = [], nor = [], col = [], idx = [];
  const c = new THREE.Color();
  const quad = (corners, n) => {
    const k = pos.length / 3;
    for (const p of corners) { pos.push(...p); nor.push(...n); col.push(c.r, c.g, c.b); }
    idx.push(k, k + 1, k + 2, k, k + 2, k + 3);
  };
  const z0 = -S / 2, z1 = S / 2;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    if (!solid(x, y)) continue;
    const i = (y * 2 * 32 + x * 2) * 4;
    c.setRGB(data[i] / 255, data[i + 1] / 255, data[i + 2] / 255, THREE.SRGBColorSpace);
    const x0 = ox + x * S, x1 = x0 + S, yt = oy - y * S, yb = yt - S;
    if (!solid(x - 1, y)) quad([[x0, yb, z0], [x0, yb, z1], [x0, yt, z1], [x0, yt, z0]], [-1, 0, 0]);
    if (!solid(x + 1, y)) quad([[x1, yb, z1], [x1, yb, z0], [x1, yt, z0], [x1, yt, z1]], [1, 0, 0]);
    if (!solid(x, y - 1)) quad([[x0, yt, z1], [x1, yt, z1], [x1, yt, z0], [x0, yt, z0]], [0, 1, 0]);
    if (!solid(x, y + 1)) quad([[x0, yb, z0], [x1, yb, z0], [x1, yb, z1], [x0, yb, z1]], [0, -1, 0]);
  }
  const edges = new THREE.BufferGeometry();
  edges.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  edges.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
  edges.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  edges.setIndex(idx);
  const rim = new THREE.Mesh(edges, new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }));
  if (!glow) return [front, back, rim];

  // The glow: every clear pixel touching the icon (corners too), on a plane through the middle of the item, so it
  // rings the outline from both sides.
  const halo = document.createElement("canvas");
  halo.width = halo.height = N + 2;
  const h = halo.getContext("2d");
  h.fillStyle = glow;
  for (let y = -1; y <= N; y++) for (let x = -1; x <= N; x++) {
    if (solid(x, y)) continue;
    let near = false;
    for (let dy = -1; dy <= 1 && !near; dy++) for (let dx = -1; dx <= 1; dx++) if (solid(x + dx, y + dy)) { near = true; break; }
    if (near) h.fillRect(x + 1, y + 1, 1, 1);
  }
  const haloTex = new THREE.CanvasTexture(halo);
  haloTex.magFilter = THREE.NearestFilter;
  haloTex.minFilter = THREE.NearestFilter;
  haloTex.colorSpace = THREE.SRGBColorSpace;
  const ring = new THREE.Mesh(
    new THREE.PlaneGeometry(size + 2 * S, size + 2 * S),
    new THREE.MeshBasicMaterial({ map: haloTex, transparent: true, opacity: 0.9, depthWrite: false, side: THREE.DoubleSide }),
  );
  ring.position.set(ox + size / 2, oy - size / 2, 0);
  return [front, back, rim, ring];
}

/// The glow round an item, if it has one: Crystal tools, weapons and armor.
const GLOW = "#f3d2ff";
const glowOf = (id) => (id === CRYSTAL_PICK || id === CRYSTAL_SWORD || ARMOR[id]?.tier === 4 ? GLOW : null);
/// How an item is held (avatar.js poses the arm for it): "weapon" (swords and the war hammer, held out, ready),
/// "tool" (pickaxes), "block" or "item" (food, torches, armor and the rest).
export function heldKind(id) {
  if (isBlock(id)) return "block";
  const t = TOOLS[id];
  return t?.kind === "sword" ? "weapon" : t ? "tool" : "item";
}

/// A model of item `id` for a hand, or null for an empty hand: the icon (or cube) in its own plane, the point where
/// it's gripped at the origin, and its kind (heldKind) in userData.kind. avatar.js turns it to suit the pose.
export function heldModel(id) {
  if (!id || !atlas) return null;
  const kind = heldKind(id);
  if (!cache.has(id)) {
    // Tools and weapons are drawn corner to corner, handle at the bottom left: held near its end (a weapon is a
    // little bigger). Anything else is held by its middle, smaller.
    const meshes = kind === "block" ? blockMeshes(id)
      : kind === "weapon" ? itemMeshes(id, 0.9, 4, 12, glowOf(id))
      : kind === "tool" ? itemMeshes(id, 0.7, 4, 12, glowOf(id))
      : itemMeshes(id, 0.42, 8, 11, glowOf(id));
    for (const m of meshes) m.userData.shared = true;
    cache.set(id, meshes);
  }
  const model = new THREE.Group();
  for (const m of cache.get(id)) model.add(m.clone());
  model.userData.kind = kind;
  return model;
}
