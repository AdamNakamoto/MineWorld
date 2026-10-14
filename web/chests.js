// Loot chests in a PvP zone (zones.js PVP): a player beaten there leaves everything they carried in a chest where they
// fell. The world server keeps it for a few minutes and hands it, once, to the first player who opens it (click it).
// This draws them, stood on the curved planet, and lets them go when their time is up.

import * as THREE from "https://esm.sh/three@0.160.0";
import { place } from "./planet.js";
import { wrapDelta } from "./rules.js";

function chestModel(who) {
  const g = new THREE.Group();
  const add = (w, h, d, color, x, y, z, emissive = 0) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshLambertMaterial({ color, emissive }));
    m.position.set(x, y, z);
    g.add(m);
    return m;
  };
  add(0.9, 0.5, 0.66, 0x8a5a2a, 0, 0.25, 0);
  add(0.94, 0.26, 0.7, 0x6e4420, 0, 0.62, 0);
  add(0.96, 0.08, 0.72, 0xe8b830, 0, 0.5, 0, 0x3a2a00); // a gold band
  add(0.16, 0.2, 0.06, 0xf5d33a, 0, 0.45, 0.36, 0x5a4000); // the lock
  // A glow over it, so it can be found.
  const glow = add(0.12, 1.4, 0.12, 0xffe27a, 0, 1.6, 0, 0xffc030);
  glow.material.transparent = true;
  glow.material.opacity = 0.5;
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 48;
  const x = c.getContext("2d");
  x.fillStyle = "rgba(20, 16, 8, 0.65)";
  x.fillRect(4, 6, 248, 36);
  x.fillStyle = "#f5c832";
  x.font = "600 22px 'Pixelify Sans', ui-monospace, monospace";
  x.textAlign = "center";
  x.textBaseline = "middle";
  x.fillText(`${who}'s loot`, 128, 25, 236);
  const tag = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false }));
  tag.scale.set(1.7, 0.32, 1);
  tag.position.y = 1.25;
  g.add(tag);
  return { g, glow };
}

export function createChests(scene) {
  const live = new Map(); // id -> { id, pos, until, who, holder, glow }

  function add(id, x, y, z, until, who) {
    if (live.has(id)) return;
    const { g, glow } = chestModel(who);
    const holder = new THREE.Group();
    holder.add(g);
    scene.add(holder);
    live.set(id, { id, pos: new THREE.Vector3(x, y, z), until, who, holder, glow, g });
  }
  function remove(id) {
    const c = live.get(id);
    if (!c) return;
    scene.remove(c.holder);
    c.holder.traverse((o) => {
      if (o.isMesh) o.geometry.dispose(); // (sprites share one geometry: leave it)
      if (o.isMesh || o.isSprite) { o.material.map?.dispose(); o.material.dispose(); }
    });
    live.delete(id);
  }
  function clear() { for (const id of [...live.keys()]) remove(id); }

  return {
    add, remove, clear,
    /// The server's list on arrival: [[id, x, y, z, until, who], ...].
    set(list) { clear(); for (const c of list) add(...c); },
    get count() { return live.size; },
    /// `now`: the server's clock. Chests past their time go; the rest glow and turn a little.
    update(now, t) {
      for (const c of [...live.values()]) {
        if (now > c.until) { remove(c.id); continue; }
        c.g.rotation.y = Math.sin(t * 0.8 + c.id) * 0.3;
        c.glow.material.opacity = 0.3 + 0.25 * Math.sin(t * 4 + c.id);
      }
    },
    draw() { for (const c of live.values()) place(c.holder, c.pos, 0); },
    /// The chest a ray (origin o, unit direction d) hits first within `max`: { chest, t }.
    raycast(o, d, max) {
      let best = null;
      for (const c of live.values()) {
        const px = o.x + wrapDelta(c.pos.x - o.x), pz = o.z + wrapDelta(c.pos.z - o.z);
        const min = [px - 0.5, c.pos.y, pz - 0.4], mx = [px + 0.5, c.pos.y + 0.8, pz + 0.4];
        let t0 = 0, t1 = max, ok = true;
        const O = [o.x, o.y, o.z], D = [d.x, d.y, d.z];
        for (let k = 0; k < 3 && ok; k++) {
          if (Math.abs(D[k]) < 1e-9) { if (O[k] < min[k] || O[k] > mx[k]) ok = false; continue; }
          let ta = (min[k] - O[k]) / D[k], tb = (mx[k] - O[k]) / D[k];
          if (ta > tb) [ta, tb] = [tb, ta];
          t0 = Math.max(t0, ta);
          t1 = Math.min(t1, tb);
          if (t0 > t1) ok = false;
        }
        if (ok && (!best || t0 < best.t)) best = { chest: c, t: t0 };
      }
      return best;
    },
  };
}
