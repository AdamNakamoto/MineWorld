// The world on screen: chunks generated around the player (worldgen.js), the room's edits laid over them, meshed
// a few at a time each frame so the game never stalls, and dropped again once they're far behind.

import * as THREE from "https://esm.sh/three@0.160.0";
import { BLOCKS, AIR, WATER } from "./blocks.js";
import { CHUNK, HEIGHT, inWorld } from "./rules.js";
import { generateChunk, index, CHUNKS } from "./worldgen.js";
import { meshChunk, LIGHT } from "./mesher.js";

export const keyOf = (cx, cz) => `${cx},${cz}`;
const LIGHT_BLOCKS = new Uint8Array(256);
const BLOCKS_LIGHT = new Uint8Array(256);
for (const b of BLOCKS) if (b) { LIGHT_BLOCKS[b.id] = b.light > 0 ? 1 : 0; BLOCKS_LIGHT[b.id] = b.opaque || b.cutout ? 1 : 0; }

const VERT = `
attribute vec3 lit;
varying vec2 vUv;
varying vec3 vLit;
varying float vDepth;
void main() {
  vUv = uv;
  vLit = lit;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vDepth = -mv.z;
  gl_Position = projectionMatrix * mv;
}`;
const FRAG = `
uniform sampler2D map;
uniform float daylight;
uniform vec3 fogColor;
uniform float fogNear;
uniform float fogFar;
uniform float alphaTest;
uniform float opacity;
varying vec2 vUv;
varying vec3 vLit;
varying float vDepth;
void main() {
  vec4 t = texture2D(map, vUv);
  if (t.a < alphaTest) discard;
  vec3 light = max(vec3(vLit.y * daylight), vLit.z * vec3(1.0, 0.84, 0.62));
  light = max(light, vec3(0.045));
  vec3 col = t.rgb * vLit.x * light;
  float f = smoothstep(fogNear, fogFar, vDepth);
  gl_FragColor = vec4(mix(col, fogColor, f), opacity < 1.0 ? opacity : t.a);
}`;

export function createWorld(scene, atlas) {
  const tex = new THREE.CanvasTexture(atlas);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  const uniforms = {
    map: { value: tex }, daylight: { value: 1 }, fogColor: { value: new THREE.Color(0x9fd0ff) },
    fogNear: { value: 60 }, fogFar: { value: 100 }, alphaTest: { value: 0.5 }, opacity: { value: 1 },
  };
  const solidMat = new THREE.ShaderMaterial({ uniforms, vertexShader: VERT, fragmentShader: FRAG });
  const waterMat = new THREE.ShaderMaterial({
    uniforms: { ...uniforms, alphaTest: { value: 0 }, opacity: { value: 0.78 } },
    vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false, side: THREE.DoubleSide,
  });
  // The water material shares the light and fog values.
  for (const k of ["daylight", "fogColor", "fogNear", "fogFar", "map"]) waterMat.uniforms[k] = uniforms[k];

  const chunks = new Map(); // key -> { cx, cz, blocks, tops, lights, meshes, dirty }
  const edits = new Map(); // key -> Map(index -> block): every change since the world was made
  let radius = 7;

  function chunkAt(x, z) {
    return chunks.get(keyOf(Math.floor(x / CHUNK), Math.floor(z / CHUNK)));
  }
  function get(x, y, z) {
    if (y < 0) return 10; // bedrock below the world
    if (y >= HEIGHT || !inWorld(x, z)) return AIR;
    const c = chunkAt(x, z);
    if (!c) return AIR;
    return c.blocks[index(x - c.cx * CHUNK, y, z - c.cz * CHUNK)];
  }
  const loaded = (x, z) => !inWorld(x, z) || !!chunkAt(x, z);

  function columnTop(c, lx, lz) {
    for (let y = HEIGHT - 1; y > 0; y--) if (BLOCKS_LIGHT[c.blocks[index(lx, y, lz)]]) return y;
    return 0;
  }
  function scanLights(c) {
    c.lights = [];
    const b = c.blocks;
    for (let i = 0; i < b.length; i++) {
      if (LIGHT_BLOCKS[b[i]]) c.lights.push([i & 15, i >> 8, (i >> 4) & 15, LIGHT[b[i]]]);
    }
  }

  function build(cx, cz) {
    const c = { cx, cz, blocks: generateChunk(cx, cz), tops: new Int16Array(CHUNK * CHUNK), lights: [], meshes: null, dirty: true };
    const e = edits.get(keyOf(cx, cz));
    if (e) for (const [i, b] of e) c.blocks[i] = b;
    for (let lz = 0; lz < CHUNK; lz++) for (let lx = 0; lx < CHUNK; lx++) c.tops[lz * CHUNK + lx] = columnTop(c, lx, lz);
    scanLights(c);
    chunks.set(keyOf(cx, cz), c);
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
      const n = chunks.get(keyOf(cx + dx, cz + dz));
      if (n) n.dirty = true;
    }
    return c;
  }

  function neighboursReady(cx, cz) {
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      const nx = cx + dx, nz = cz + dz;
      if (nx < 0 || nz < 0 || nx >= CHUNKS || nz >= CHUNKS) continue;
      if (!chunks.has(keyOf(nx, nz))) return false;
    }
    return true;
  }

  function remesh(c) {
    const x0 = c.cx * CHUNK, z0 = c.cz * CHUNK;
    const lights = [];
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      const n = chunks.get(keyOf(c.cx + dx, c.cz + dz));
      if (n) for (const [lx, y, lz, s] of n.lights) lights.push([lx + dx * CHUNK, y, lz + dz * CHUNK, s]);
    }
    const data = meshChunk(
      (lx, y, lz) => get(x0 + lx, y, z0 + lz),
      (lx, lz) => {
        const n = chunkAt(x0 + lx, z0 + lz);
        if (!n) return 0;
        return n.tops[(z0 + lz - n.cz * CHUNK) * CHUNK + (x0 + lx - n.cx * CHUNK)];
      },
      lights,
    );
    dispose(c);
    c.meshes = [];
    for (const [part, mat] of [[data.solid, solidMat], [data.water, waterMat]]) {
      if (!part.idx.length) continue;
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(part.pos, 3));
      g.setAttribute("uv", new THREE.BufferAttribute(part.uv, 2));
      g.setAttribute("lit", new THREE.BufferAttribute(part.lit, 3));
      g.setIndex(new THREE.BufferAttribute(part.idx, 1));
      g.computeBoundingSphere();
      const m = new THREE.Mesh(g, mat);
      m.position.set(x0, 0, z0);
      m.matrixAutoUpdate = false;
      m.updateMatrix();
      if (mat === waterMat) m.renderOrder = 1;
      scene.add(m);
      c.meshes.push(m);
    }
    c.dirty = false;
  }
  function dispose(c) {
    if (!c.meshes) return;
    for (const m of c.meshes) {
      scene.remove(m);
      m.geometry.dispose();
    }
    c.meshes = null;
  }

  /// Change a block (an edit of yours, or one the room sent). Re-meshes this chunk and any neighbour it touches.
  function set(x, y, z, b) {
    if (y < 0 || y >= HEIGHT || !inWorld(x, z)) return;
    const cx = Math.floor(x / CHUNK), cz = Math.floor(z / CHUNK);
    const lx = x - cx * CHUNK, lz = z - cz * CHUNK;
    const i = index(lx, y, lz);
    const k = keyOf(cx, cz);
    if (!edits.has(k)) edits.set(k, new Map());
    edits.get(k).set(i, b);
    const c = chunks.get(k);
    if (!c) return;
    const old = c.blocks[i];
    if (old === b) return;
    c.blocks[i] = b;
    c.tops[lz * CHUNK + lx] = columnTop(c, lx, lz);
    const lit = LIGHT_BLOCKS[old] || LIGHT_BLOCKS[b];
    if (lit) scanLights(c);
    c.dirty = true;
    // Neighbours share the rim (faces, occlusion) and, for a light, everything within 8 blocks.
    const reach = lit ? 9 : 1;
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      if (!dx && !dz) continue;
      const near = (dx < 0 ? lx < reach : dx > 0 ? lx >= CHUNK - reach : true) && (dz < 0 ? lz < reach : dz > 0 ? lz >= CHUNK - reach : true);
      const n = near && chunks.get(keyOf(cx + dx, cz + dz));
      if (n) n.dirty = true;
    }
  }

  /// The room's edits for a chunk, as [index, block] pairs: they replace whatever this game had for it.
  function setEdits(k, list) {
    const m = new Map(list);
    const prev = edits.get(k);
    edits.set(k, m);
    const c = chunks.get(k);
    if (!c) return;
    const [cx, cz] = k.split(",").map(Number);
    // Rebuild from the generator with the room's edits on top (also undoes any of ours it never accepted).
    if (prev?.size || m.size) {
      chunks.delete(k);
      dispose(c);
      build(cx, cz);
    }
  }

  let need = new Set();
  /// Generate and mesh around (px, pz) for up to `budgetMs` this frame. Returns the chunk keys that are now in range
  /// and haven't been asked of the room yet (the caller asks for their edits).
  function update(px, pz, budgetMs = 7) {
    const pcx = Math.floor(px / CHUNK), pcz = Math.floor(pz / CHUNK);
    const start = performance.now();
    const want = [];
    for (let dx = -radius - 1; dx <= radius + 1; dx++) for (let dz = -radius - 1; dz <= radius + 1; dz++) {
      const cx = pcx + dx, cz = pcz + dz;
      if (cx < 0 || cz < 0 || cx >= CHUNKS || cz >= CHUNKS) continue;
      const d = dx * dx + dz * dz;
      if (d > (radius + 1.5) * (radius + 1.5)) continue;
      want.push([d, cx, cz]);
    }
    want.sort((a, b) => a[0] - b[0]);
    const fresh = [];
    for (const [d, cx, cz] of want) {
      const k = keyOf(cx, cz);
      if (!need.has(k)) { need.add(k); fresh.push(k); }
      if (!chunks.has(k)) {
        if (performance.now() - start > budgetMs) break;
        build(cx, cz);
      }
      void d;
    }
    for (const [d, cx, cz] of want) {
      if (d > (radius + 0.5) * (radius + 0.5)) continue;
      const c = chunks.get(keyOf(cx, cz));
      if (!c || !c.dirty || !neighboursReady(cx, cz)) continue;
      if (performance.now() - start > budgetMs * 2) break;
      remesh(c);
    }
    // Forget what's far behind (the edits stay, so it comes back the same).
    const far = (radius + 3) * (radius + 3);
    for (const [k, c] of chunks) {
      const dx = c.cx - pcx, dz = c.cz - pcz;
      if (dx * dx + dz * dz > far) {
        dispose(c);
        chunks.delete(k);
        need.delete(k);
      }
    }
    return fresh;
  }

  /// The first block a ray from (o) along unit vector (d) hits within `max` blocks (water doesn't stop it).
  function raycast(o, d, max) {
    let x = Math.floor(o.x), y = Math.floor(o.y), z = Math.floor(o.z);
    const sx = Math.sign(d.x), sy = Math.sign(d.y), sz = Math.sign(d.z);
    const tdx = d.x ? Math.abs(1 / d.x) : Infinity, tdy = d.y ? Math.abs(1 / d.y) : Infinity, tdz = d.z ? Math.abs(1 / d.z) : Infinity;
    let tx = d.x > 0 ? (x + 1 - o.x) * tdx : d.x < 0 ? (o.x - x) * tdx : Infinity;
    let ty = d.y > 0 ? (y + 1 - o.y) * tdy : d.y < 0 ? (o.y - y) * tdy : Infinity;
    let tz = d.z > 0 ? (z + 1 - o.z) * tdz : d.z < 0 ? (o.z - z) * tdz : Infinity;
    let t = 0, nx = 0, ny = 0, nz = 0;
    for (let i = 0; i < 64 && t <= max; i++) {
      const b = get(x, y, z);
      if (b !== AIR && b !== WATER) return { x, y, z, b, nx, ny, nz, t };
      if (tx < ty && tx < tz) { x += sx; t = tx; tx += tdx; nx = -sx; ny = 0; nz = 0; }
      else if (ty < tz) { y += sy; t = ty; ty += tdy; nx = 0; ny = -sy; nz = 0; }
      else { z += sz; t = tz; tz += tdz; nx = 0; ny = 0; nz = -sz; }
    }
    return null;
  }

  return {
    get, set, setEdits, update, raycast, loaded, uniforms,
    solid: (x, y, z) => !!BLOCKS[get(x, y, z)]?.solid,
    /// The highest light-blocking block of the column at (x, z), or -1 where nothing is loaded.
    topAt(x, z) {
      const c = chunkAt(x, z);
      return c ? c.tops[(z - c.cz * CHUNK) * CHUNK + (x - c.cx * CHUNK)] : -1;
    },
    setRadius(r) { radius = r; },
    get radius() { return radius; },
    forgetRequests() { need = new Set(); },
    chunkCount: () => chunks.size,
  };
}
