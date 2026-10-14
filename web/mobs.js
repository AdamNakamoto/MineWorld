// Monsters: original blocky creatures. The room decides when and where one comes for you (rules.js MOBS); this
// game moves it, lets it bite, and tells the room about every hit, which the room checks before paying for a win.
// They move in the flat, wrapping world (their position is kept in 0..WORLD) and are drawn standing on the curved
// planet (planet.js) by draw(), each frame before the render.

import * as THREE from "https://esm.sh/three@0.160.0";
import { MOBS, MOB_LIFE_MS, wrap, wrapDelta } from "./rules.js";
import { BLOCKS } from "./blocks.js";
import { moveBox } from "./physics.js";
import { place, nearest } from "./planet.js";

const mat = (color, emissive = 0) => new THREE.MeshLambertMaterial({ color, emissive });
function part(group, w, h, d, color, x, y, z, emissive) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat(color, emissive));
  m.position.set(x, y, z);
  m.userData.emissive = m.material.emissive.clone();
  group.add(m);
  return m;
}

const MODELS = {
  mudling(g) {
    const body = part(g, 0.8, 0.7, 0.8, 0x6a7a3a, 0, 0.5, 0);
    part(g, 0.5, 0.25, 0.5, 0x58682e, 0.08, 0.95, -0.05);
    part(g, 0.18, 0.18, 0.04, 0xffffff, -0.18, 0.62, 0.41);
    part(g, 0.18, 0.18, 0.04, 0xffffff, 0.18, 0.62, 0.41);
    part(g, 0.08, 0.08, 0.05, 0x111111, -0.18, 0.6, 0.43);
    part(g, 0.08, 0.08, 0.05, 0x111111, 0.18, 0.6, 0.43);
    part(g, 0.3, 0.06, 0.04, 0x2a2a14, 0, 0.36, 0.41);
    const feet = [part(g, 0.25, 0.18, 0.3, 0x4a5424, -0.2, 0.09, 0), part(g, 0.25, 0.18, 0.3, 0x4a5424, 0.2, 0.09, 0)];
    return (t, moving) => {
      body.position.y = 0.5 + Math.abs(Math.sin(t * 6)) * (moving ? 0.08 : 0.02);
      feet[0].position.z = Math.sin(t * 8) * (moving ? 0.12 : 0);
      feet[1].position.z = -feet[0].position.z;
    };
  },
  crawler(g) {
    part(g, 1.0, 0.35, 1.1, 0x4a2f6a, 0, 0.45, -0.05);
    part(g, 0.55, 0.35, 0.4, 0x5a3a7a, 0, 0.5, 0.65);
    for (const x of [-0.14, 0.14]) part(g, 0.1, 0.1, 0.04, 0xff2a2a, x, 0.56, 0.86, 0xaa0000);
    const legs = [];
    for (const side of [-1, 1]) for (const z of [-0.35, 0, 0.35]) {
      const leg = part(g, 0.8, 0.08, 0.08, 0x2a1a3a, side * 0.75, 0.35, z);
      leg.rotation.z = side * -0.5;
      legs.push(leg);
    }
    return (t, moving) => legs.forEach((l, i) => { l.position.y = 0.35 + Math.sin(t * 14 + i * 2) * (moving ? 0.07 : 0); });
  },
  rattler(g) {
    const bone = 0xd8d4c4;
    const legs = [part(g, 0.14, 0.85, 0.14, bone, -0.13, 0.43, 0), part(g, 0.14, 0.85, 0.14, bone, 0.13, 0.43, 0)];
    part(g, 0.5, 0.6, 0.22, 0xc8c4b4, 0, 1.15, 0);
    for (let i = 0; i < 3; i++) part(g, 0.54, 0.05, 0.25, 0x8a8678, 0, 0.98 + i * 0.16, 0);
    const arms = [part(g, 0.12, 0.7, 0.12, bone, -0.33, 1.1, 0), part(g, 0.12, 0.7, 0.12, bone, 0.33, 1.1, 0)];
    part(g, 0.45, 0.45, 0.45, 0xe8e4d4, 0, 1.68, 0);
    for (const x of [-0.11, 0.11]) part(g, 0.1, 0.12, 0.04, 0x1a1a1a, x, 1.7, 0.23);
    return (t, moving) => {
      const a = Math.sin(t * 7) * (moving ? 0.6 : 0.05);
      legs[0].rotation.x = a; legs[1].rotation.x = -a;
      arms[0].rotation.x = -1.2 + Math.sin(t * 3) * 0.1; arms[1].rotation.x = -1.2 - Math.sin(t * 3) * 0.1;
    };
  },
  golem(g) {
    const stone = 0x7a7a7a;
    const legs = [part(g, 0.45, 0.8, 0.45, 0x666666, -0.32, 0.4, 0), part(g, 0.45, 0.8, 0.45, 0x666666, 0.32, 0.4, 0)];
    part(g, 1.3, 1.0, 0.9, stone, 0, 1.3, 0);
    part(g, 1.0, 0.2, 0.7, 0x4f7a3a, 0.1, 1.85, -0.05);
    part(g, 0.6, 0.5, 0.55, 0x8a8a8a, 0, 2.0, 0.15);
    for (const x of [-0.14, 0.14]) part(g, 0.12, 0.08, 0.04, 0xffa030, x, 2.05, 0.44, 0xff7a00);
    const arms = [part(g, 0.4, 1.2, 0.4, 0x6e6e6e, -0.88, 1.1, 0), part(g, 0.4, 1.2, 0.4, 0x6e6e6e, 0.88, 1.1, 0)];
    return (t, moving) => {
      const a = Math.sin(t * 4) * (moving ? 0.45 : 0.03);
      legs[0].rotation.x = a; legs[1].rotation.x = -a;
      arms[0].rotation.x = -a; arms[1].rotation.x = a;
    };
  },
};

export function createMobs(scene, world, hooks) {
  const live = new Map(); // id -> mob
  let clock = 0;

  /// The room sent a monster for this player, near (x, y, z): stand it on the nearest floor there. `mul`: the zone's
  /// { hp, damage } against home's (zones.js mobs: Deepvein's are tougher).
  function spawn(id, kind, x, y, z, mul = { hp: 1, damage: 1 }) {
    const def = MOBS[kind];
    if (!def || live.has(id)) return;
    const tall = Math.ceil(def.size[1]);
    let spot = null;
    for (const [ox, oz] of [[0, 0], [2, 0], [-2, 0], [0, 2], [0, -2], [3, 3], [-3, -3]]) {
      const bx = Math.floor(x) + ox, bz = Math.floor(z) + oz;
      if (!world.loaded(bx, bz)) continue;
      // The floor nearest the height the room asked for (so not on a treetop above, nor a cave far below).
      for (let d = 0; d <= 12 && !spot; d++) {
        for (const by of d ? [Math.floor(y) + d, Math.floor(y) - d] : [Math.floor(y)]) {
          if (by < 2) continue;
          let clear = world.solid(bx, by - 1, bz) && !BLOCKS[world.get(bx, by - 1, bz)]?.leaves;
          for (let k = 0; k < tall && clear; k++) clear = !world.solid(bx, by + k, bz) && world.get(bx, by + k, bz) !== 11;
          if (clear) { spot = [bx + 0.5, by, bz + 0.5]; break; }
        }
      }
      if (spot) break;
    }
    if (!spot) return hooks.gone?.(id);
    // holder: stood on the curved ground (planet.place); group: the model, turned and animated within it.
    const holder = new THREE.Group(), group = new THREE.Group();
    const anim = MODELS[kind](group);
    holder.add(group);
    scene.add(holder);
    const mob = {
      id, kind, def, holder, group, anim, hp: Math.round(def.hp * mul.hp), damage: def.damage * mul.damage, born: performance.now(),
      pos: new THREE.Vector3(wrap(spot[0]), spot[1], wrap(spot[2])), vel: new THREE.Vector3(), yaw: 0, attackT: 1, hurtT: 0,
      dead: 0, wanderT: 0, wander: 0,
    };
    live.set(id, mob);
  }

  function remove(m) {
    scene.remove(m.holder);
    m.group.traverse((o) => { if (o.isMesh) { o.geometry.dispose(); o.material.dispose(); } });
    live.delete(m.id);
  }

  const HURT = new THREE.Color(0x990000);
  function flash(m, on) {
    m.group.traverse((o) => { if (o.isMesh) o.material.emissive.copy(on ? HURT : o.userData.emissive); });
  }

  /// player: { pos, vel, alive }.
  function update(dt, player) {
    clock += dt;
    const now = performance.now();
    for (const m of [...live.values()]) {
      if (m.dead) {
        m.dead -= dt;
        m.group.scale.setScalar(Math.max(0.01, m.dead / 0.4));
        m.group.rotation.z += dt * 6;
        if (m.dead <= 0) remove(m);
        continue;
      }
      const half = m.def.size[0] / 2, h = m.def.size[1];
      const dx = wrapDelta(player.pos.x - m.pos.x), dz = wrapDelta(player.pos.z - m.pos.z), dy = player.pos.y - m.pos.y;
      const dist = Math.hypot(dx, dz);
      if (now - m.born > MOB_LIFE_MS || dist > 64) { remove(m); hooks.gone?.(m.id); continue; }
      let tx = 0, tz = 0;
      if (player.alive && dist < 24) {
        tx = dx / (dist || 1) * m.def.speed;
        tz = dz / (dist || 1) * m.def.speed;
        if (dist < half + 0.7) { tx = 0; tz = 0; }
      } else {
        m.wanderT -= dt;
        if (m.wanderT <= 0) { m.wanderT = 2 + Math.random() * 3; m.wander = Math.random() < 0.4 ? null : Math.random() * Math.PI * 2; }
        if (m.wander !== null) { tx = Math.sin(m.wander) * m.def.speed * 0.3; tz = Math.cos(m.wander) * m.def.speed * 0.3; }
      }
      const k = 1 - Math.exp(-dt * 8);
      if (m.hurtT <= 0) {
        m.vel.x += (tx - m.vel.x) * k;
        m.vel.z += (tz - m.vel.z) * k;
      }
      const r = moveBox(world, m.pos, m.vel, half, h, dt);
      m.pos.x = wrap(m.pos.x);
      m.pos.z = wrap(m.pos.z);
      if (r.wall && r.onGround) m.vel.y = 8; // hop up a step
      if (r.water) m.vel.y = Math.max(m.vel.y, 1.5);
      if (Math.abs(m.vel.x) + Math.abs(m.vel.z) > 0.2) m.yaw = Math.atan2(m.vel.x, m.vel.z);
      m.group.rotation.y = m.yaw;
      m.anim(clock, Math.abs(m.vel.x) + Math.abs(m.vel.z) > 0.3);
      if (m.hurtT > 0) { m.hurtT -= dt; if (m.hurtT <= 0) flash(m, false); }
      m.attackT -= dt;
      if (player.alive && dist < half + 1.1 && Math.abs(dy) < h && m.attackT <= 0) {
        m.attackT = 1.1;
        hooks.bite(m.damage, dx / (dist || 1), dz / (dist || 1));
      }
    }
  }

  /// Stands every monster on the curved ground as seen from the camera (after planet.follow, before the render).
  function draw() {
    for (const m of live.values()) place(m.holder, m.pos, 0);
  }

  /// The monster a ray (origin o, unit direction d) hits first within `max`, as { mob, t }.
  function raycast(o, d, max) {
    let best = null;
    for (const m of live.values()) {
      if (m.dead) continue;
      const half = m.def.size[0] / 2 + 0.1, h = m.def.size[1];
      const px = nearest(m.pos.x, o.x), pz = nearest(m.pos.z, o.z); // (the copy on the ray's side of the seam)
      const min = [px - half, m.pos.y, pz - half], mx = [px + half, m.pos.y + h, pz + half];
      let t0 = 0, t1 = max;
      const O = [o.x, o.y, o.z], D = [d.x, d.y, d.z];
      let ok = true;
      for (let a = 0; a < 3 && ok; a++) {
        if (Math.abs(D[a]) < 1e-9) { if (O[a] < min[a] || O[a] > mx[a]) ok = false; continue; }
        let ta = (min[a] - O[a]) / D[a], tb = (mx[a] - O[a]) / D[a];
        if (ta > tb) [ta, tb] = [tb, ta];
        t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
        if (t0 > t1) ok = false;
      }
      if (ok && (!best || t0 < best.t)) best = { mob: m, t: t0 };
    }
    return best;
  }

  /// A hit from the player: knock it back and show it. The room has the final say on whether it's beaten.
  function hit(m, damage, dirX, dirZ) {
    m.hp -= damage;
    m.vel.x = dirX * 7; m.vel.z = dirZ * 7; m.vel.y = 5;
    m.hurtT = 0.25;
    flash(m, true);
    if (m.hp <= 0) { m.dead = 0.4; hooks.killed?.(m.id); }
  }
  /// The room says it's beaten (or gone).
  function kill(id) {
    const m = live.get(id);
    if (m && !m.dead) m.dead = 0.4;
  }
  function clear() { for (const m of [...live.values()]) remove(m); }

  return { spawn, update, draw, raycast, hit, kill, clear, count: () => live.size };
}
