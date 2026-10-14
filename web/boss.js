// Ashgrim, the Cinder Colossus: Cinderfall's boss (zones.js BOSS), an original creature, a giant of cooled lava with
// a molten heart. The world server keeps its health and picks its moves; this draws it from what the server says,
// animating each move from its start time (so every game shows the same thing, and nothing is sent while it moves),
// and works out whether its slam or its thrown rock caught you (this game's own player only). Its moves:
//   - a walk towards someone, staying in the arena;
//   - a slam: both fists raised (a red ring on the ground shows where it will hit), then down: a ring of fire round
//     it. Step out of the ring before the fists land;
//   - a thrown rock: it winds up and throws a molten rock at where someone stands (an orange ring marks the spot).
//     Move off the mark;
//   - a summons, once it's hurt: it roars, and monsters climb out beside it (the server sends them, as ever).

import * as THREE from "https://esm.sh/three@0.160.0";
import { place } from "./planet.js";
import { BOSS, ARENA, bossAt } from "./zones.js";
import { wrapDelta } from "./rules.js";

const BASALT = 0x34343c, DARK = 0x26262e, ROCK = 0x42424c, GLOW = 0xff6a14;

function part(parent, w, h, d, color, x, y, z, emissive = 0) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshLambertMaterial({ color, emissive }));
  m.position.set(x, y, z);
  parent.add(m);
  return m;
}
const pivot = (parent, x, y, z) => { const g = new THREE.Group(); g.position.set(x, y, z); parent.add(g); return g; };

/// The model, about 9.5 blocks tall, facing +z, its feet at y 0.
function colossus() {
  const g = new THREE.Group();
  const legs = [-1, 1].map((s) => {
    const p = pivot(g, s * 1.0, 3.4, 0);
    part(p, 1.5, 3.4, 1.5, BASALT, 0, -1.7, 0);
    part(p, 1.54, 0.16, 1.54, 0x5a1a08, 0, -1.6, 0, GLOW); // a glowing crack at the knee
    part(p, 1.7, 0.5, 1.9, DARK, 0, -3.15, 0.15); // a foot
    return p;
  });
  part(g, 3.4, 1.0, 2.0, DARK, 0, 3.4, 0); // hips
  const torso = pivot(g, 0, 3.9, 0);
  part(torso, 4.4, 3.4, 2.6, ROCK, 0, 1.7, 0);
  const core = part(torso, 1.5, 1.5, 0.3, 0x8a2a08, 0, 1.9, 1.32, GLOW); // the molten heart
  for (const [x, y, w, h] of [[-0.9, 1.0, 0.12, 1.3], [1.0, 2.5, 0.12, 1.1], [0.2, 0.6, 1.6, 0.12], [-1.4, 2.6, 0.9, 0.12]]) {
    part(torso, w, h, 0.05, 0x5a1a08, x, y, 1.31, GLOW); // cracks
  }
  for (const s of [-1, 1]) {
    part(torso, 1.9, 1.6, 1.9, 0x4a4a54, s * 2.6, 3.3, 0); // shoulder boulders
    part(torso, 0.6, 0.35, 0.6, 0x5a1a08, s * 2.5, 4.2, -0.3, GLOW); // vents
  }
  const head = pivot(torso, 0, 3.4, 0.1);
  part(head, 2.0, 1.7, 1.8, DARK, 0, 0.75, 0);
  part(head, 2.15, 0.35, 0.45, 0x1e1e24, 0, 1.15, 0.85); // brow
  const eyes = [-1, 1].map((s) => part(head, 0.45, 0.18, 0.1, 0x7a5a10, s * 0.45, 0.82, 0.93, 0xffd84a));
  part(head, 1.0, 0.14, 0.1, 0x5a1a08, 0, 0.3, 0.93, GLOW); // a glowing mouth
  for (const s of [-1, 1]) {
    const horn = part(head, 0.35, 1.3, 0.35, 0x1a1a20, s * 0.95, 1.8, -0.1);
    horn.rotation.z = -s * 0.5;
  }
  const arms = [-1, 1].map((s) => {
    const sh = pivot(torso, s * 2.6, 3.0, 0);
    part(sh, 1.2, 2.2, 1.2, BASALT, 0, -1.1, 0);
    const el = pivot(sh, 0, -2.2, 0);
    part(el, 1.4, 2.0, 1.4, ROCK, 0, -1.0, 0);
    part(el, 1.9, 1.7, 1.9, 0x40404a, 0, -2.6, 0.1); // a fist
    part(el, 1.95, 0.28, 0.5, 0x5a1a08, 0, -2.2, 0.9, GLOW); // glowing knuckles
    return { sh, el };
  });
  const rock = part(arms[1].el, 1.2, 1.2, 1.2, 0x6a2a0a, 0, -3.8, 0.6, 0xff8a2a); // in its right fist, while throwing
  rock.visible = false;
  const mats = [];
  g.traverse((o) => { if (o.isMesh) mats.push([o.material, o.material.emissive.clone()]); });
  return { g, legs, torso, head, arms, core, eyes, rock, mats };
}

/// A flat ring on the ground (inner, outer radius) in `color`, drawn on top of the blocks.
function ring(r0, r1, color) {
  const m = new THREE.Mesh(new THREE.RingGeometry(r0, r1, 48), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false }));
  m.rotation.x = -Math.PI / 2;
  const holder = new THREE.Group();
  holder.add(m);
  holder.visible = false;
  holder.userData.at = new THREE.Vector3();
  holder.renderOrder = 2;
  return { holder, m };
}

/// `hooks`: { hurt(damage, dirX, dirZ) (this game's player was caught), posOf(id) (a player's flat position, or
/// null), boom(strength) (shake the screen) }.
export function createBoss(scene, hooks) {
  const M = colossus();
  const holder = new THREE.Group(); // stood on the curved planet; the model turns and moves within it
  holder.add(M.g);
  holder.visible = false;
  scene.add(holder);
  const warn = ring(BOSS.slam.radius - 0.6, BOSS.slam.radius, 0xff2a1a);
  const shock = ring(0.6, 1.2, 0xffa040);
  const mark = ring(BOSS.rock.radius - 0.4, BOSS.rock.radius, 0xff8a1a);
  const call = ring(2.5, 3.4, 0xff6a20);
  for (const r of [warn, shock, mark, call]) scene.add(r.holder);
  const flying = part(scene, 1.2, 1.2, 1.2, 0x6a2a0a, 0, 0, 0, 0xff8a2a); // the thrown rock
  flying.visible = false;
  flying.userData.at = new THREE.Vector3();
  const bits = []; // embers from impacts
  const bitGeo = new THREE.BoxGeometry(0.25, 0.25, 0.25);

  const bar = document.getElementById("bossBar"), fill = document.getElementById("bossHp"), note = document.getElementById("bossNote");
  document.getElementById("bossName").textContent = `${BOSS.name}, ${BOSS.title}`;

  let s = null; // the server's state: { hp, max, act, t0, ms, from, to, target, aim, down }
  let here = false, yaw = 0, flashT = 0, doneSlam = 0, doneRock = 0, clock = 0;
  const pos = new THREE.Vector3(), bodyAt = new THREE.Vector3();

  /// From the server: ["boss", hp, max, act, t0, ms, fx, fz, tx, tz, target, aim, down].
  function set(m) {
    s = { hp: m[1], max: m[2], act: m[3], t0: m[4], ms: m[5], from: [m[6], m[7]], to: [m[8], m[9]], target: m[10], aim: m[11], down: m[12] };
  }
  function setHp(hp) { if (s) s.hp = hp; }
  function setZone(k) {
    here = k === "boss";
    if (!here) { s = null; bar.hidden = true; holder.visible = false; for (const r of [warn, shock, mark, call]) r.holder.visible = false; flying.visible = false; }
  }

  function burst(x, y, z, n, color = 0xff8a2a) {
    for (let i = 0; i < n; i++) {
      const b = new THREE.Mesh(bitGeo, new THREE.MeshBasicMaterial({ color }));
      b.userData.p = new THREE.Vector3(x + (Math.random() - 0.5) * 2, y + Math.random(), z + (Math.random() - 0.5) * 2);
      b.userData.v = new THREE.Vector3((Math.random() - 0.5) * 9, 4 + Math.random() * 7, (Math.random() - 0.5) * 9);
      b.userData.life = 0.6 + Math.random() * 0.6;
      scene.add(b);
      bits.push(b);
    }
  }

  /// Where the boss's fist is when it lets go of a rock (flat): high over its right shoulder, about. (Its own +x is
  /// (cos yaw, -sin yaw) on the ground, its front (sin yaw, cos yaw).)
  const handAt = (out) => out.set(pos.x + Math.cos(yaw) * 2.6 - Math.sin(yaw) * 0.5, ARENA.y + 1 + 10.5, pos.z - Math.sin(yaw) * 2.6 - Math.cos(yaw) * 0.5);
  const _h = new THREE.Vector3();

  /// Each frame: `now` is the server's clock (ms); `player`: { pos, alive }.
  function update(dt, now, player) {
    clock += dt;
    for (let i = bits.length - 1; i >= 0; i--) {
      const b = bits[i];
      b.userData.life -= dt;
      b.userData.v.y -= 22 * dt;
      b.userData.p.addScaledVector(b.userData.v, dt);
      if (b.userData.life <= 0) { scene.remove(b); b.material.dispose(); bits.splice(i, 1); }
    }
    if (!here || !s) { bar.hidden = true; return; }
    const near = Math.hypot(wrapDelta(player.pos.x - ARENA.x), wrapDelta(player.pos.z - ARENA.z)) < 80;
    bar.hidden = !near;
    if (s.act === "down") {
      // Beaten: it crumbles into the floor, and is gone until it's back.
      const k = Math.min(1, (now - s.t0) / 1500);
      holder.visible = k < 1;
      M.g.position.y = -k * 4;
      M.torso.rotation.x = k * 0.7;
      fill.style.width = "0%";
      const left = Math.max(0, s.down - now);
      note.textContent = left ? `Beaten · back in ${Math.floor(left / 60_000)}:${String(Math.floor((left % 60_000) / 1000)).padStart(2, "0")}` : "Beaten · back any moment";
      for (const r of [warn, shock, mark, call]) r.holder.visible = false;
      flying.visible = false;
      return;
    }
    holder.visible = true;
    M.g.position.y = 0;
    fill.style.width = `${Math.max(0, (s.hp / s.max) * 100)}%`;
    note.textContent = `${Math.max(0, s.hp).toLocaleString()} / ${s.max.toLocaleString()}`;
    const p = bossAt(s, now);
    pos.set(p.x, ARENA.y + 1, p.z);
    const t = now - s.t0;
    // Facing: where it walks, else whoever it's after (or the spot it throws at).
    let face = null;
    if (s.act === "walk") face = [s.to[0] - s.from[0], s.to[1] - s.from[1]];
    else if (s.aim) face = [s.aim[0] - p.x, s.aim[2] - p.z];
    else if (s.target !== null) { const q = hooks.posOf(s.target); if (q) face = [wrapDelta(q.x - p.x), wrapDelta(q.z - p.z)]; }
    if (face && Math.hypot(face[0], face[1]) > 0.3) {
      let dy = Math.atan2(face[0], face[1]) - yaw;
      dy = Math.atan2(Math.sin(dy), Math.cos(dy));
      yaw += dy * (1 - Math.exp(-dt * 6));
    }
    M.g.rotation.y = yaw;
    pose(s.act, t, dt);
    effects(now, t, player);
    if (flashT > 0) { flashT -= dt; if (flashT <= 0) for (const [m, e] of M.mats) m.emissive.copy(e); }
  }

  const ease = (k) => k * k * (3 - 2 * k);
  function pose(act, t, dt) {
    const [L, R] = M.arms;
    const breathe = Math.sin(clock * 1.6) * 0.06;
    let legA = 0, lean = 0, armX = [Math.sin(clock * 1.2) * 0.08, -Math.sin(clock * 1.2) * 0.08], armZ = [-0.12, 0.12], elbow = [-0.25, -0.25];
    let bob = breathe, headX = 0, core = 0.7 + 0.3 * Math.sin(clock * 3);
    M.rock.visible = false;
    if (act === "walk") {
      const ph = (t / 1000) * 2.4 * Math.PI;
      legA = Math.sin(ph) * 0.5;
      armX = [-Math.sin(ph) * 0.35, Math.sin(ph) * 0.35];
      bob = Math.abs(Math.sin(ph)) * 0.18;
    } else if (act === "slam") {
      const w = BOSS.slam.windupMs;
      if (t < w) { const k = ease(t / w); armX = [2.7 * k, 2.7 * k]; elbow = [-0.6 * k, -0.6 * k]; lean = -0.28 * k; headX = -0.3 * k; }
      else if (t < w + 160) { const k = (t - w) / 160; armX = [2.7 - 3.6 * k, 2.7 - 3.6 * k]; lean = -0.28 + 0.65 * k; }
      else { const k = Math.min(1, (t - w - 160) / 700); armX = [-0.9 * (1 - k), -0.9 * (1 - k)]; lean = 0.37 * (1 - k); }
    } else if (act === "rock") {
      const w = BOSS.rock.windupMs;
      if (t < w) { const k = ease(t / w); armX[1] = 2.5 * k; elbow[1] = -1.2 * k; lean = -0.15 * k; M.rock.visible = true; }
      else if (t < w + 220) { const k = (t - w) / 220; armX[1] = 2.5 - 3.8 * k; lean = -0.15 + 0.35 * k; }
      else { const k = Math.min(1, (t - w - 220) / 700); armX[1] = -1.3 * (1 - k); lean = 0.2 * (1 - k); }
    } else if (act === "summon") {
      const k = ease(Math.min(1, t / 700)) * (t > BOSS.summon.ms - 500 ? Math.max(0, (BOSS.summon.ms - t) / 500) : 1);
      armZ = [-0.12 - 2.1 * k, 0.12 + 2.1 * k];
      headX = -0.45 * k;
      core = 1 + Math.sin(clock * 14) * 0.5 * k;
    }
    M.legs[0].rotation.x = legA;
    M.legs[1].rotation.x = -legA;
    M.torso.position.y = 3.9 + bob;
    M.torso.rotation.x = lean;
    M.head.rotation.x = headX;
    L.sh.rotation.x = armX[0]; R.sh.rotation.x = armX[1]; // (positive: raised up and back; negative: forward)
    L.sh.rotation.z = armZ[0]; R.sh.rotation.z = armZ[1];
    L.el.rotation.x = elbow[0]; R.el.rotation.x = elbow[1];
    if (flashT <= 0) M.core.material.emissive.setRGB(1, 0.42 * core, 0.08 * core).multiplyScalar(Math.min(1.4, core));
    void dt;
  }

  function effects(now, t, player) {
    const me = player.pos;
    // The slam: the warning ring through the wind-up, then the ring of fire.
    const S = BOSS.slam;
    warn.holder.visible = s.act === "slam" && t < S.windupMs;
    if (warn.holder.visible) {
      warn.holder.userData.at.set(pos.x, ARENA.y + 1.05, pos.z);
      warn.m.material.opacity = 0.25 + 0.55 * (t / S.windupMs) + 0.15 * Math.sin(clock * 20);
    }
    const st = t - S.windupMs;
    shock.holder.visible = s.act === "slam" && st >= 0 && st < 450;
    if (shock.holder.visible) {
      const r = 1 + (S.radius / 1.2 - 1) * (st / 450);
      shock.holder.userData.at.set(pos.x, ARENA.y + 1.1, pos.z);
      shock.m.scale.setScalar(r);
      shock.m.material.opacity = 0.9 * (1 - st / 450);
    }
    if (s.act === "slam" && st >= 0 && doneSlam !== s.t0) {
      doneSlam = s.t0;
      if (st < 600) {
        burst(pos.x, ARENA.y + 1, pos.z, 18);
        hooks.boom(Math.max(0.15, 1 - Math.hypot(wrapDelta(me.x - pos.x), wrapDelta(me.z - pos.z)) / 30));
        const d = Math.hypot(wrapDelta(me.x - pos.x), wrapDelta(me.z - pos.z));
        if (player.alive && d < S.radius + 0.3 && me.y < ARENA.y + 4) hooks.hurt(S.damage, wrapDelta(me.x - pos.x) / (d || 1), wrapDelta(me.z - pos.z) / (d || 1), "slam");
      }
    }
    // The rock: in its fist through the wind-up, then flying to the mark, which shows from the start.
    const K = BOSS.rock;
    mark.holder.visible = s.act === "rock" && !!s.aim && t < K.windupMs + K.flightMs;
    if (mark.holder.visible) {
      mark.holder.userData.at.set(s.aim[0], s.aim[1] + 0.05, s.aim[2]);
      mark.m.material.opacity = 0.45 + 0.35 * Math.sin(clock * 12);
    }
    const ft = t - K.windupMs;
    flying.visible = s.act === "rock" && !!s.aim && ft >= 0 && ft < K.flightMs;
    if (flying.visible) {
      const k = ft / K.flightMs;
      handAt(_h);
      const ax = _h.x + wrapDelta(s.aim[0] - _h.x), az = _h.z + wrapDelta(s.aim[2] - _h.z);
      flying.userData.at.set(_h.x + (ax - _h.x) * k, _h.y + (s.aim[1] + 0.6 - _h.y) * k + 7 * 4 * k * (1 - k), _h.z + (az - _h.z) * k);
      flying.rotation.set(k * 9, k * 6, 0);
    }
    if (s.act === "rock" && s.aim && ft >= K.flightMs && doneRock !== s.t0) {
      doneRock = s.t0;
      if (ft < K.flightMs + 600) {
        burst(s.aim[0], s.aim[1] + 0.3, s.aim[2], 14);
        const d = Math.hypot(wrapDelta(me.x - s.aim[0]), wrapDelta(me.z - s.aim[2]));
        hooks.boom(Math.max(0.1, 0.6 - d / 40));
        if (player.alive && d < K.radius + 0.3 && Math.abs(me.y - s.aim[1]) < 3) hooks.hurt(K.damage, wrapDelta(me.x - s.aim[0]) / (d || 1), wrapDelta(me.z - s.aim[2]) / (d || 1), "rock");
      }
    }
    // The summons: a ring of fire spreading round it.
    call.holder.visible = s.act === "summon" && t < BOSS.summon.ms;
    if (call.holder.visible) {
      const k = (t % 900) / 900;
      call.holder.userData.at.set(pos.x, ARENA.y + 1.05, pos.z);
      call.m.scale.setScalar(1 + k * 1.6);
      call.m.material.opacity = 0.8 * (1 - k);
    }
  }

  return {
    set, setHp, setZone, update,
    get state() { return s; },
    get alive() { return !!s && s.act !== "down" && s.hp > 0; },
    /// A hit from this player: a flash (the server has the final say on the damage).
    flash() {
      flashT = 0.15;
      for (const [m] of M.mats) m.emissive.setRGB(0.6, 0, 0);
    },
    /// Where its middle is (flat), for the name over the crosshair and the distance to it.
    get middle() { return bodyAt.set(pos.x, pos.y + BOSS.height / 2, pos.z); },
    /// Stands it (and its rings, rock and embers) on the curved planet (after planet.follow, before the render).
    draw() {
      if (holder.visible) place(holder, pos, 0);
      for (const r of [warn, shock, mark, call]) if (r.holder.visible) place(r.holder, r.holder.userData.at, 0);
      if (flying.visible) place(flying, flying.userData.at, 0);
      for (const b of bits) place(b, b.userData.p, 0);
    },
    /// The boss, if a ray (origin o, unit direction d) hits it within `max`: { t }.
    raycast(o, d, max) {
      if (!here || !s || !holder.visible || s.act === "down") return null;
      const px = o.x + wrapDelta(pos.x - o.x), pz = o.z + wrapDelta(pos.z - o.z);
      const w = BOSS.body;
      const min = [px - w, pos.y, pz - w], mx = [px + w, pos.y + BOSS.height, pz + w];
      let t0 = 0, t1 = max;
      const O = [o.x, o.y, o.z], D = [d.x, d.y, d.z];
      for (let k = 0; k < 3; k++) {
        if (Math.abs(D[k]) < 1e-9) { if (O[k] < min[k] || O[k] > mx[k]) return null; continue; }
        let ta = (min[k] - O[k]) / D[k], tb = (mx[k] - O[k]) / D[k];
        if (ta > tb) [ta, tb] = [tb, ta];
        t0 = Math.max(t0, ta);
        t1 = Math.min(t1, tb);
        if (t0 > t1) return null;
      }
      return { t: t0 };
    },
  };
}
