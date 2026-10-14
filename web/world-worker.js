// The world's workshop, off the main thread: it generates chunks (worldgen.js) and meshes them (mesher.js), so the
// game never stalls while new land comes into view. It keeps its own copy of every chunk the game has loaded (a mesh
// needs the neighbours' blocks too), kept in step with the game's: world.js sends every change here in the order it
// makes them, and messages are handled in that order. Jobs (generate, mesh) wait in a queue; urgent meshes (after an
// edit) jump it, and changes are applied the moment they arrive, so a mesh always reflects every change sent before it.
//
// world.js runs this module as a Web Worker; if a browser can't, it runs the same jobs on the main thread instead.

import { generateChunk, naturalBlock, index, CHUNKS } from "./worldgen.js";
import { meshArea, chunkTops, chunkLights, columnTop, patchEdits, LIGHT } from "./mesher.js";
import { CHUNK, wrap } from "./rules.js";

// The world wraps round: chunk -1 is chunk CHUNKS - 1 (a mesh at the seam takes its neighbours from the other side).
const idOf = (cx, cz) => (((cx % CHUNKS) + CHUNKS) % CHUNKS) * CHUNKS + (((cz % CHUNKS) + CHUNKS) % CHUNKS);

/// Starts the job queue. `send(msg, transfer)` delivers a reply; returns `receive(msg)` for the messages from world.js.
export function startWorldJobs(send) {
  const chunks = new Map(); // id -> { cx, cz, blocks, tops, lights }
  const edits = new Map(); // id -> Map(index -> block): the same as world.js keeps
  const urgent = [], normal = [];
  let lastSeq = 0; // the last message received (every change up to it is applied)
  let version = 0; // counts changes to which chunks this copy holds

  function set({ x, y, z, b }) {
    x = wrap(x);
    z = wrap(z);
    const cx = Math.floor(x / CHUNK), cz = Math.floor(z / CHUNK), id = idOf(cx, cz);
    const lx = x - cx * CHUNK, lz = z - cz * CHUNK, i = index(lx, y, lz);
    if (!edits.has(id)) edits.set(id, new Map());
    edits.get(id).set(i, b);
    const c = chunks.get(id);
    if (!c || c.blocks[i] === b) return;
    const old = c.blocks[i];
    c.blocks[i] = b;
    c.tops[lz * CHUNK + lx] = columnTop(c.blocks, lx, lz);
    if (LIGHT[old] > 0 || LIGHT[b] > 0) c.lights = chunkLights(c.blocks);
  }

  function setEdits({ id, list }) {
    const m = new Map(list), prev = edits.get(id);
    edits.set(id, m);
    const c = chunks.get(id);
    if (!c) return;
    const r = patchEdits(c.blocks, c.cx * CHUNK, c.cz * CHUNK, prev, m, naturalBlock);
    for (const i of r.changed) c.tops[i & 255] = columnTop(c.blocks, i & 15, (i >> 4) & 15);
    if (r.lit) c.lights = chunkLights(c.blocks);
  }

  function gen({ id, cx, cz }) {
    const blocks = generateChunk(cx, cz);
    const e = edits.get(id);
    if (e) for (const [i, b] of e) blocks[i] = b;
    const c = { cx, cz, blocks, tops: chunkTops(blocks), lights: chunkLights(blocks) };
    chunks.set(id, c);
    version++;
    const copy = blocks.slice(), tops = c.tops.slice();
    send({ t: "gen", id, blocks: copy, tops, lights: c.lights, seq: lastSeq, version }, [copy.buffer, tops.buffer]);
  }

  function mesh({ id, cx, cz }) {
    const blocks = [], tops = [], lights = [];
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      const n = chunks.get(idOf(cx + dx, cz + dz));
      if (!n) return send({ t: "mesh", id, fail: true });
      blocks.push(n.blocks);
      tops.push(n.tops);
      for (const [lx, y, lz, s] of n.lights) lights.push([lx + dx * CHUNK, y, lz + dz * CHUNK, s]);
    }
    const d = meshArea(blocks, tops, lights, cx * CHUNK, cz * CHUNK);
    const transfer = [];
    for (const part of [d.solid, d.water]) transfer.push(part.pos.buffer, part.uv.buffer, part.lit.buffer, part.idx.buffer);
    send({ t: "mesh", id, seq: lastSeq, version, d }, transfer);
  }

  /// The planet seen from above (planet-map.js), for the title screen's globe.
  async function map({ w, h }) {
    try {
      const { planetMap } = await import("./planet-map.js");
      const data = planetMap(w, h);
      send({ t: "map", w, h, data }, [data.buffer]);
    } catch (err) {
      send({ t: "error", message: String(err?.stack ?? err) });
      send({ t: "map", w, h, data: null });
    }
  }

  // One job per task, so messages that arrive meanwhile (an edit, an urgent mesh) get in between.
  const tick = new MessageChannel();
  let scheduled = false;
  tick.port1.onmessage = () => {
    scheduled = false;
    const job = urgent.shift() ?? normal.shift();
    if (!job) return;
    try {
      if (job.t === "gen") gen(job);
      else if (job.t === "map") return void map(job).then(schedule);
      else mesh(job);
    } catch (err) {
      send({ t: "error", message: String(err?.stack ?? err) });
      send({ t: job.t, id: job.id, fail: true });
    }
    schedule();
  };
  function schedule() {
    if (scheduled || (!urgent.length && !normal.length)) return;
    scheduled = true;
    tick.port2.postMessage(0);
  }

  return function receive(m) {
    lastSeq = m.seq;
    switch (m.t) {
      case "set": set(m); break;
      case "edits": setEdits(m); break;
      case "drop": if (chunks.delete(m.id)) version++; break;
      case "gen": normal.push(m); break;
      case "mesh": (m.urgent ? urgent : normal).push(m); break;
      case "map": urgent.push(m); break;
    }
    schedule();
  };
}

if (typeof WorkerGlobalScope !== "undefined" && self instanceof WorkerGlobalScope) {
  const receive = startWorldJobs((m, transfer) => self.postMessage(m, transfer ?? []));
  self.onmessage = (e) => receive(e.data);
  self.postMessage({ t: "ready" });
}
