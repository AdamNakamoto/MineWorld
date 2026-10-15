// The world on screen: chunks generated around the player, the room's edits laid over them, meshed, and dropped again
// once they're far behind. The world wraps round (rules.js): chunk numbers, block lookups and distances all go the
// short way round, each chunk's meshes sit at the copy of the chunk nearest the camera (moved as you go, so the seam
// can't be seen), and the shader bends them round the planet (planet.js), culled by where they're drawn. Generating and meshing happen in a Web Worker (world-worker.js), so a wide view distance
// doesn't cost the frame rate; this side keeps a copy of every loaded chunk's blocks (for physics, aiming and the rest
// of the game) and sends the worker every change in the same order, so both copies stay the same. A block you break
// or place is re-meshed right here at the start of the next frame, without waiting for the worker.
//
// It shows one planet at a time: the home planet or one of the rocket's zones (zones.js). setZone drops every chunk
// and edit and starts over on the new planet (the worker does the same, in step).

import * as THREE from "https://esm.sh/three@0.160.0";
import { BLOCKS, AIR, WATER } from "./blocks.js";
import { CHUNK, HEIGHT, WORLD, wrap } from "./rules.js";
import { index, CHUNKS, naturalBlock } from "./worldgen.js";
import { meshArea, chunkTops, chunkLights, columnTop, patchEdits, LIGHT, columnSky, lightReach } from "./mesher.js";
import { BEND_GLSL, uniforms as bendUniforms, view as bendView, nearest, bentBounds } from "./planet.js";

/// The view radius can't reach half way round (CHUNKS / 2), or a chunk would be wanted on both sides at once.
export const MAX_RADIUS = CHUNKS / 2 - 1;
const wrapC = (c) => ((c % CHUNKS) + CHUNKS) % CHUNKS;
/// A difference in chunks, the short way round.
const deltaC = (d) => d - CHUNKS * Math.floor(d / CHUNKS + 0.5);
export const keyOf = (cx, cz) => `${wrapC(cx)},${wrapC(cz)}`;
const idOf = (cx, cz) => wrapC(cx) * CHUNKS + wrapC(cz);
const keyOfId = (id) => keyOf(Math.floor(id / CHUNKS), id % CHUNKS);
const SOLID = new Uint8Array(256);
for (const b of BLOCKS) if (b) SOLID[b.id] = b.solid ? 1 : 0;

const MAX_GEN = 4, MAX_MESH = 4; // jobs waiting in the worker at once (fewer means it follows you sooner)
// The room answers up to 600 chunk requests a minute: ask for a full view at once, then no faster than it refills.
const ASK_BURST = 480, ASK_PER_S = 9;

// Each vertex is bent round the planet; fog goes by the flat distance (so it hides the edge of what's loaded).
const VERT = `
attribute vec3 lit;
varying vec2 vUv;
varying vec3 vLit;
varying float vDepth;
${BEND_GLSL}
void main() {
  vUv = uv;
  vLit = lit;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vDepth = bendDist(wp.xyz);
  gl_Position = projectionMatrix * viewMatrix * vec4(bend(wp.xyz), 1.0);
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
  const bending = bendUniforms();
  const uniforms = {
    map: { value: tex }, daylight: { value: 1 }, fogColor: { value: new THREE.Color(0x9fd0ff) },
    fogNear: { value: 60 }, fogFar: { value: 100 }, alphaTest: { value: 0.5 }, opacity: { value: 1 }, ...bending.u,
  };
  const solidMat = new THREE.ShaderMaterial({ uniforms, vertexShader: VERT, fragmentShader: FRAG });
  const waterMat = new THREE.ShaderMaterial({
    uniforms: { ...uniforms, alphaTest: { value: 0 }, opacity: { value: 0.78 } },
    vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false, side: THREE.DoubleSide,
  });
  // The water material shares the light and fog values.
  for (const k of ["daylight", "fogColor", "fogNear", "fogFar", "map", "bendAt"]) waterMat.uniforms[k] = uniforms[k];

  // id -> { cx, cz, id, blocks, tops, lights, meshes, dirty, urgent, soon, inflight, needSeq, needVersion }
  const chunks = new Map();
  const edits = new Map(); // id -> Map(index -> block): every change since the world was made
  const pending = new Map(); // id -> { touched }: asked of the worker, not back yet
  const urgentSet = new Set(); // chunks to re-mesh here, at the start of the next update
  let radius = 7;
  let genFlight = 0, meshFlight = 0;
  let want = [], wantAt = null; // the chunks in range, nearest first, and where that was worked out
  let px0 = 0, pz0 = 0; // the last position update() saw
  let zone = "home", zoneSeq = 0; // the planet shown, and the message that switched to it (older replies are stale)
  const natural = (x, y, z) => naturalBlock(x, y, z, zone);

  // ---------------------------------------------------------------- the worker
  let seq = 0;
  let early = []; // what was sent before the worker said it was ready (sent again if it fails to start)
  let toWorker = null;
  function fallBack(why) {
    console.warn("World worker unavailable, building the world on the main thread:", why);
    import("./world-worker.js").then(({ startWorldJobs }) => {
      const receive = startWorldJobs((m) => setTimeout(() => onReply(m), 0));
      toWorker = (m) => receive(m);
      for (const m of early ?? []) receive(m);
      early = null;
    });
    toWorker = null;
  }
  try {
    const worker = new Worker(new URL("./world-worker.js", import.meta.url), { type: "module" });
    toWorker = (m) => worker.postMessage(m);
    worker.onmessage = (e) => onReply(e.data);
    worker.onerror = (e) => { if (early) { e.preventDefault?.(); worker.terminate(); fallBack(e.message); } else console.error("World worker:", e.message); };
  } catch (err) {
    fallBack(err);
  }
  /// Sends a message to the worker; returns its number (messages are handled in this order).
  function post(m) {
    m.seq = ++seq;
    if (early) early.push(m);
    toWorker?.(m);
    return seq;
  }

  function onReply(m) {
    if (m.t === "ready") { early = null; return; }
    if ((m.t === "gen" || m.t === "mesh") && !(m.seq >= zoneSeq)) return; // made for the planet before

    if (m.t === "gen") onGen(m);
    else if (m.t === "mesh") onMesh(m);
    else if (m.t === "map") mapWaits.shift()?.(m);
    else if (m.t === "error") console.error("World worker:", m.message);
    pump();
  }

  const mapWaits = []; // (answered in the order asked)
  /// A whole planet from above as w x h RGBA pixels (planet-map.js), made in the worker: resolves { w, h, data }.
  /// `z`: which planet (the home planet if left out).
  function map(w, h, z = "home") {
    return new Promise((ok) => { mapWaits.push(ok); post({ t: "map", w, h, zone: z }); });
  }

  /// Show another planet (a zone key, zones.js): every chunk and edit of this one is dropped, and the new one is
  /// generated round the player from the next update() on. (The caller asks the room for the new planet's edits.)
  function setZone(z) {
    zone = z;
    for (const c of chunks.values()) dispose(c);
    chunks.clear();
    edits.clear();
    pending.clear();
    urgentSet.clear();
    genFlight = meshFlight = 0;
    want = [];
    wantAt = null;
    need = new Set();
    zoneSeq = post({ t: "zone", zone: z });
  }

  // ---------------------------------------------------------------- blocks
  /// The chunk holding block (x, z) (whole numbers, any image), if loaded.
  function chunkAt(x, z) {
    return chunks.get(idOf(Math.floor(x / CHUNK), Math.floor(z / CHUNK)));
  }
  /// The block at (x, y, z) (whole numbers; x and z wrap round).
  function get(x, y, z) {
    if (y < 0) return 10; // bedrock below the world
    if (y >= HEIGHT) return AIR;
    x = ((x % WORLD) + WORLD) % WORLD;
    z = ((z % WORLD) + WORLD) % WORLD;
    const cx = Math.floor(x / CHUNK), cz = Math.floor(z / CHUNK);
    const c = chunks.get(cx * CHUNKS + cz);
    if (!c) return AIR;
    return c.blocks[(y << 8) | ((z - cz * CHUNK) << 4) | (x - cx * CHUNK)];
  }
  const loaded = (x, z) => !!chunkAt(x, z);

  /// A chunk's mesh is out of date from message `s` on (and, for a neighbour's arrival, worker version `v`).
  function stale(c, s, v = 0, urgent = false) {
    c.dirty = true;
    if (s > c.needSeq) c.needSeq = s;
    if (v > c.needVersion) c.needVersion = v;
    if (urgent) { c.urgent = true; urgentSet.add(c); }
  }
  /// After block (lx, lz) of chunk c changed: the neighbours that share its rim (faces, occlusion) or, for a light,
  /// anything within 8 blocks.
  function staleAround(c, lx, lz, lit, s, urgent) {
    const reach = lit ? 9 : 1;
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      if (!dx && !dz) continue;
      const nearX = dx < 0 ? lx < reach : dx > 0 ? lx >= CHUNK - reach : true;
      const nearZ = dz < 0 ? lz < reach : dz > 0 ? lz >= CHUNK - reach : true;
      if (!nearX || !nearZ) continue;
      const n = chunks.get(idOf(c.cx + dx, c.cz + dz));
      // Only the rim needs to be instant; light further in can come from the worker.
      const rim = (dx < 0 ? lx < 1 : dx > 0 ? lx >= CHUNK - 1 : true) && (dz < 0 ? lz < 1 : dz > 0 ? lz >= CHUNK - 1 : true);
      if (n) stale(n, s, 0, urgent && rim);
    }
  }
  /// Before an edit to a chunk still being generated: remember which blocks it touches, to lay them over the result.
  function touchPending(id, indices) {
    const p = pending.get(id);
    if (!p) return;
    if (!p.touched) p.touched = new Set(edits.get(id)?.keys() ?? []);
    for (const i of indices) p.touched.add(i);
  }

  /// Change a block (an edit of yours, or one the room sent). Re-meshes this chunk and any neighbour it touches.
  function set(x, y, z, b) {
    if (y < 0 || y >= HEIGHT) return;
    x = wrap(x);
    z = wrap(z);
    const cx = Math.floor(x / CHUNK), cz = Math.floor(z / CHUNK);
    const lx = x - cx * CHUNK, lz = z - cz * CHUNK;
    const i = index(lx, y, lz), id = idOf(cx, cz);
    touchPending(id, [i]);
    if (!edits.has(id)) edits.set(id, new Map());
    edits.get(id).set(i, b);
    const s = post({ t: "set", x, y, z, b });
    const c = chunks.get(id);
    if (!c) return;
    const old = c.blocks[i];
    if (old === b) return;
    c.blocks[i] = b;
    c.tops[lz * CHUNK + lx] = columnTop(c.blocks, lx, lz);
    const lit = LIGHT[old] > 0 || LIGHT[b] > 0;
    if (lit) c.lights = chunkLights(c.blocks);
    stale(c, s, 0, true);
    staleAround(c, lx, lz, lit, s, true);
  }

  /// The room's edits for a chunk, as [index, block] pairs: they replace whatever this game had for it.
  function setEdits(k, list) {
    const [cx, cz] = String(k).split(",").map(Number);
    if (!(cx >= 0 && cz >= 0 && cx < CHUNKS && cz < CHUNKS)) return;
    const id = idOf(cx, cz);
    const m = new Map(list), prev = edits.get(id);
    touchPending(id, [...m.keys()]);
    edits.set(id, m);
    const s = post({ t: "edits", id, list: [...m] });
    const c = chunks.get(id);
    if (!c) return;
    // Back to the generator's block wherever ours were never accepted, and the room's on top.
    const r = patchEdits(c.blocks, cx * CHUNK, cz * CHUNK, prev, m, natural);
    if (!r.changed.length) return;
    for (const i of r.changed) c.tops[i & 255] = columnTop(c.blocks, i & 15, (i >> 4) & 15);
    if (r.lit) c.lights = chunkLights(c.blocks);
    stale(c, s);
    c.soon = true;
    for (const i of r.changed) staleAround(c, i & 15, (i >> 4) & 15, r.lit, s, false);
  }

  // ---------------------------------------------------------------- what comes back
  function onGen(m) {
    genFlight = Math.max(0, genFlight - 1);
    const p = pending.get(m.id);
    pending.delete(m.id);
    if (m.fail || chunks.has(m.id)) return;
    const cx = Math.floor(m.id / CHUNKS), cz = m.id % CHUNKS;
    const far = (radius + 3) * (radius + 3);
    const dx = deltaC(cx - Math.floor(px0 / CHUNK)), dz = deltaC(cz - Math.floor(pz0 / CHUNK));
    if (dx * dx + dz * dz > far) { post({ t: "drop", id: m.id }); return; } // you've moved on
    const c = {
      cx, cz, id: m.id, blocks: m.blocks, tops: m.tops, lights: m.lights, meshes: null, ox: 0, oz: 0,
      dirty: true, urgent: false, soon: false, inflight: false, needSeq: seq, needVersion: m.version,
    };
    if (p?.touched) {
      // Edits made while it was being generated: lay the latest over it (the worker did the same with its copy).
      const r = patchEdits(c.blocks, cx * CHUNK, cz * CHUNK, p.touched, edits.get(m.id) ?? new Map(), natural);
      if (r.changed.length) { chunkTops(c.blocks, c.tops); c.lights = chunkLights(c.blocks); }
    }
    chunks.set(m.id, c);
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      const n = (dx || dz) && chunks.get(idOf(cx + dx, cz + dz));
      if (n) stale(n, 0, m.version);
    }
  }

  function onMesh(m) {
    meshFlight = Math.max(0, meshFlight - 1);
    const c = chunks.get(m.id);
    if (!c) return;
    c.inflight = false;
    if (m.fail) return;
    // Built from data that has every change this chunk is waiting for? Otherwise it's asked for again.
    if (m.seq < c.needSeq || m.version < c.needVersion) return;
    show(c, m.d);
    c.dirty = false;
    c.soon = false;
  }

  function show(c, data) {
    dispose(c);
    c.meshes = [];
    for (const [part, mat] of [[data.solid, solidMat], [data.water, waterMat]]) {
      if (!part.idx.length) continue;
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(part.pos, 3));
      g.setAttribute("uv", new THREE.BufferAttribute(part.uv, 2, true));
      g.setAttribute("lit", new THREE.BufferAttribute(part.lit, 3, true));
      g.setIndex(new THREE.BufferAttribute(part.idx, 1));
      let lo = 65535, hi = 0;
      for (let i = 1; i < part.pos.length; i += 3) { const y = part.pos[i]; if (y < lo) lo = y; if (y > hi) hi = y; }
      const h = (hi - lo) / 2;
      g.boundingSphere = new THREE.Sphere(new THREE.Vector3(128, lo + h, 128), Math.sqrt(128 * 128 * 2 + h * h) + 1);
      const mesh = new THREE.Mesh(g, mat);
      // Drawn bent, so three.js's own culling (by the flat position) is off: cull() does it by where it's drawn.
      mesh.frustumCulled = false;
      mesh.userData.lo = lo / 16;
      mesh.userData.hi = hi / 16;
      mesh.position.set(c.ox, 0, c.oz);
      mesh.scale.setScalar(1 / 16); // positions are in sixteenths of a block
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      if (mat === waterMat) mesh.renderOrder = 1;
      scene.add(mesh);
      c.meshes.push(mesh);
    }
  }
  /// Moves chunk c's meshes to the copy of it nearest (rx, rz), if they aren't there already.
  function placeAt(c, rx, rz) {
    const ox = nearest(c.cx * CHUNK + CHUNK / 2, rx) - CHUNK / 2, oz = nearest(c.cz * CHUNK + CHUNK / 2, rz) - CHUNK / 2;
    if (ox === c.ox && oz === c.oz) return;
    c.ox = ox;
    c.oz = oz;
    for (const m of c.meshes ?? []) {
      m.position.set(ox, 0, oz);
      m.updateMatrix();
    }
  }
  function dispose(c) {
    if (!c.meshes) return;
    for (const m of c.meshes) {
      scene.remove(m);
      m.geometry.dispose();
    }
    c.meshes = null;
  }

  // ---------------------------------------------------------------- keeping up with the player
  function neighboursReady(cx, cz) {
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      if (!chunks.has(idOf(cx + dx, cz + dz))) return false;
    }
    return true;
  }
  /// Meshes a chunk here and now (after an edit), from this side's copy.
  function meshHere(c) {
    const blocks = [], tops = [], lights = [];
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      const n = chunks.get(idOf(c.cx + dx, c.cz + dz));
      blocks.push(n?.blocks ?? null);
      tops.push(n?.tops ?? null);
      if (n) for (const [lx, y, lz, s] of n.lights) lights.push([lx + dx * CHUNK, y, lz + dz * CHUNK, s]);
    }
    show(c, meshArea(blocks, tops, lights, c.cx * CHUNK, c.cz * CHUNK));
    placeAt(c, bendView.x, bendView.z);
    c.dirty = false;
    c.soon = false;
  }

  /// Hands the worker the next chunks to generate and to mesh, nearest first, a few at a time.
  function pump() {
    const meshR = (radius + 0.5) * (radius + 0.5);
    for (const w of want) {
      if (genFlight >= MAX_GEN) break;
      if (chunks.has(w.id) || pending.has(w.id)) continue;
      pending.set(w.id, { touched: null });
      post({ t: "gen", id: w.id, cx: w.cx, cz: w.cz });
      genFlight++;
    }
    for (const w of want) {
      if (meshFlight >= MAX_MESH || w.d > meshR) break;
      const c = chunks.get(w.id);
      if (!c || !c.dirty || c.inflight || c.urgent || !neighboursReady(c.cx, c.cz)) continue;
      post({ t: "mesh", id: c.id, cx: c.cx, cz: c.cz, urgent: c.soon });
      c.inflight = true;
      meshFlight++;
    }
  }

  let need = new Set();
  let onDrop = () => {};
  let asks = ASK_BURST, askAt = performance.now();
  /// Keeps the world loaded and meshed around (px, pz). Edited chunks are re-meshed here, within about `budgetMs`
  /// (the rest go to the worker, first in its queue). Returns the chunk keys that are now in range and haven't been
  /// asked of the room yet (the caller asks for their edits), nearest first, paced to what the room allows.
  function update(px, pz, budgetMs = 7) {
    const start = performance.now();
    px0 = px; pz0 = pz;
    const pcx = Math.floor(px / CHUNK), pcz = Math.floor(pz / CHUNK);

    // Edits first: a broken block disappears this frame.
    for (const c of urgentSet) {
      urgentSet.delete(c);
      c.urgent = false;
      if (chunks.get(c.id) !== c || !c.dirty) continue;
      if (!neighboursReady(c.cx, c.cz)) continue;
      if (performance.now() - start > budgetMs) { c.soon = true; continue; }
      meshHere(c);
    }

    if (!wantAt || wantAt[0] !== pcx || wantAt[1] !== pcz || wantAt[2] !== radius) {
      wantAt = [pcx, pcz, radius];
      want = [];
      const r = radius + 1.5;
      // Round the seam: each chunk once, at its nearest (whichever side of the seam).
      const seen = new Set();
      const ring = [];
      for (let dx = -radius - 1; dx <= radius + 1; dx++) for (let dz = -radius - 1; dz <= radius + 1; dz++) {
        const d = dx * dx + dz * dz;
        if (d <= r * r) ring.push({ d, cx: wrapC(pcx + dx), cz: wrapC(pcz + dz), id: idOf(pcx + dx, pcz + dz) });
      }
      ring.sort((a, b) => a.d - b.d);
      for (const w of ring) if (!seen.has(w.id)) { seen.add(w.id); want.push(w); }
      // Forget what's far behind (the edits stay, so it comes back the same).
      const far = (radius + 3) * (radius + 3);
      for (const [id, c] of chunks) {
        const dx = deltaC(c.cx - pcx), dz = deltaC(c.cz - pcz);
        if (dx * dx + dz * dz > far) {
          dispose(c);
          chunks.delete(id);
          urgentSet.delete(c);
          post({ t: "drop", id });
          need.delete(id);
          onDrop(keyOfId(id));
        }
      }
      // Asked for but never loaded before you moved on: asked again when it's back in range.
      for (const id of need) {
        const dx = deltaC(Math.floor(id / CHUNKS) - pcx), dz = deltaC((id % CHUNKS) - pcz);
        if (dx * dx + dz * dz > far && !chunks.has(id)) { need.delete(id); onDrop(keyOfId(id)); }
      }
    }
    pump();

    const now = performance.now();
    asks = Math.min(ASK_BURST, asks + ((now - askAt) / 1000) * ASK_PER_S);
    askAt = now;
    const fresh = [];
    for (const w of want) {
      if (asks < 1) break;
      if (need.has(w.id)) continue;
      need.add(w.id);
      fresh.push(keyOf(w.cx, w.cz));
      asks--;
    }
    return fresh;
  }

  /// The first block a ray from (o) along unit vector (d) hits within `max` blocks (water doesn't stop it). Its x and
  /// z come back wrapped into the world (0..WORLD-1), whichever side of the seam the ray started.
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
      if (b !== AIR && b !== WATER) return { x: wrap(x), y, z: wrap(z), b, nx, ny, nz, t };
      if (tx < ty && tx < tz) { x += sx; t = tx; tx += tdx; nx = -sx; ny = 0; nz = 0; }
      else if (ty < tz) { y += sy; t = ty; ty += tdy; nx = 0; ny = -sy; nz = 0; }
      else { z += sz; t = tz; tz += tdz; nx = 0; ny = 0; nz = -sz; }
    }
    return null;
  }

  const frustum = new THREE.Frustum(), projView = new THREE.Matrix4(), sphere = new THREE.Sphere();
  let drawn = 0;
  /// Before each render (after planet.follow): the bend's uniforms, every chunk's meshes at their copy nearest the
  /// camera, and only those whose bent bounds are in view switched on.
  function draw(camera) {
    bending.update();
    camera.updateMatrixWorld();
    projView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    frustum.setFromProjectionMatrix(projView);
    drawn = 0;
    for (const c of chunks.values()) {
      if (!c.meshes?.length) continue;
      placeAt(c, bendView.x, bendView.z);
      // One test for the chunk (its solid and water meshes together): the box they fill, as it's drawn.
      let lo = HEIGHT, hi = 0;
      for (const m of c.meshes) { lo = Math.min(lo, m.userData.lo); hi = Math.max(hi, m.userData.hi); }
      bentBounds(c.ox, lo, c.oz, c.ox + CHUNK, hi + 1, c.oz + CHUNK, sphere);
      const vis = frustum.intersectsSphere(sphere);
      for (const m of c.meshes) m.visible = vis;
      if (vis) drawn += c.meshes.length;
    }
  }

  return {
    get, set, setEdits, update, raycast, loaded, uniforms, draw, map, setZone,
    get zone() { return zone; },
    /// Whether the chunk holding (x, z) is loaded and drawn (meshed), for an arrival to wait on.
    shown(x, z) { const c = chunkAt(wrap(x), wrap(z)); return !!c?.meshes; },
    solid: (x, y, z) => SOLID[get(x, y, z)] === 1,
    /// The highest block of the column at (x, z) that keeps the sky off it (leaves don't), or -1 where nothing is
    /// loaded.
    topAt(x, z) {
      x = wrap(x);
      z = wrap(z);
      const c = chunkAt(x, z);
      return c ? c.tops[(z - c.cz * CHUNK) * CHUNK + (x - c.cx * CHUNK)] & 255 : -1;
    },
    /// The light at (x, y, z) as the mesher lights a face there: the open sky that reaches it (0..1, with a little spilling
    /// in from an open column next door) and the nearest glowing block's (0..1). For what isn't drawn with the chunks,
    /// such as the first-person hand.
    lightAt(x, y, z) {
      x = Math.floor(x); y = Math.floor(y); z = Math.floor(z);
      const col = (cx, cz) => {
        cx = wrap(cx); cz = wrap(cz);
        const c = chunkAt(cx, cz);
        return c ? columnSky(c.tops[(cz - c.cz * CHUNK) * CHUNK + (cx - c.cx * CHUNK)], y) : 1;
      };
      let sky = y >= HEIGHT ? 1 : col(x, z);
      if (sky < 1) sky = Math.max(sky, 0.8 * Math.max(col(x + 1, z), col(x - 1, z), col(x, z + 1), col(x, z - 1)));
      const across = (d) => Math.abs(d - WORLD * Math.round(d / WORLD)); // (the short way round the world)
      let block = 0;
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
        const c = chunkAt(wrap(x + dx * CHUNK), wrap(z + dz * CHUNK));
        for (const [lx, ly, lz, s] of c?.lights ?? []) {
          const d = across(c.cx * CHUNK + lx - x) + Math.abs(ly - y) + across(c.cz * CHUNK + lz - z);
          block = Math.max(block, lightReach(s, d));
        }
      }
      return { sky, block };
    },
    setRadius(r) { radius = Math.max(1, Math.min(MAX_RADIUS, r)); },
    get radius() { return radius; },
    forgetRequests() { need = new Set(); },
    /// Called with each chunk key dropped from memory (its edits are asked for again when it comes back).
    set onDrop(f) { onDrop = f; },
    chunkCount: () => chunks.size,
    /// Chunk meshes drawn in the last frame (after culling).
    drawnCount: () => drawn,
  };
}
