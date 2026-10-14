// The shared world, live: other miners, everyone's block changes, the monsters the room sends you, chat, and the
// $MINE ledger. The room (multiplayer/) checks every break and every hit; this side just reports them and draws
// what comes back. Position updates go out only when you move (the room runs on Cloudflare's free plan, which
// counts incoming messages).

import * as THREE from "https://esm.sh/three@0.160.0";
import { createAvatar } from "./avatar.js";
import { unpackTraits } from "./crafters.js";
import { wrap, wrapDelta } from "./rules.js";
import { place } from "./planet.js";

const MIN_GAP = 0.5; // seconds between position updates, at the most
const HEARTBEAT = 3; // seconds: while moving the same way
const PING_EVERY = 45_000; // Cloudflare drops sockets quiet for 100 s
const SEEN = 96; // blocks: how far other miners are drawn
export const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;

function nameTag(text) {
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 64;
  const g = c.getContext("2d");
  g.fillStyle = "rgba(10, 12, 16, 0.55)";
  g.beginPath();
  g.roundRect(8, 10, 240, 44, 8);
  g.fill();
  g.fillStyle = "#ffffff";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.font = "600 26px 'Silkscreen', ui-monospace, monospace";
  g.fillText(text, 128, 33, 228);
  const t = new THREE.CanvasTexture(c);
  t.minFilter = THREE.LinearFilter;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, transparent: true, depthWrite: false }));
  s.scale.set(1.6, 0.4, 1);
  s.position.y = 2.25;
  return s;
}

export function createNet(url, scene, h) {
  let ws = null, id = null, open = false, closedByUs = false, backoff = 1000;
  let hello = null, resume = null;
  const others = new Map(); // id -> { av, tag, name, design, pos, target, yaw, tyaw, act, speed }
  const queue = [];
  let lastSent = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, at: 0 };
  let pingTimer = null;
  const waiting = new Map(); // reply kind -> resolve

  function send(msg) {
    if (open) ws.send(JSON.stringify(msg));
    else queue.push(msg);
  }

  function connect() {
    closedByUs = false;
    try { ws = new WebSocket(url); } catch { return retry(); }
    ws.onopen = () => {
      open = true;
      backoff = 1000;
      ws.send(JSON.stringify(["hello", hello ?? {}]));
      if (resume) ws.send(JSON.stringify(["resume", resume.address, resume.token]));
      while (queue.length) ws.send(JSON.stringify(queue.shift()));
      clearInterval(pingTimer);
      pingTimer = setInterval(() => open && ws.send('["ping"]'), PING_EVERY);
      h.status?.(true);
    };
    ws.onclose = () => {
      open = false;
      clearInterval(pingTimer);
      for (const id of [...others.keys()]) drop(id);
      h.status?.(false);
      if (!closedByUs) retry();
    };
    ws.onerror = () => {};
    ws.onmessage = (e) => {
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      if (Array.isArray(m)) receive(m);
    };
  }
  function retry() {
    setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 30_000);
  }

  /// `look`: the Crafter they wear, as packed traits (checked on-chain by the world server), or null.
  /// `pos` is where they are (flat, kept at the copy nearest you, so distances to it are the short way round);
  /// `holder` stands their avatar there on the curved planet (draw()).
  /// `gear`: the armor tiers they wear (head, chest, legs, feet), as the room relays them.
  function add(pid, name, look, x, y, z, yaw, gear) {
    gear = Array.isArray(gear) && gear.length === 4 && gear.every((t) => Number.isInteger(t) && t >= 0 && t <= 4) ? gear : [0, 0, 0, 0];
    drop(pid);
    const av = createAvatar(unpackTraits(look), gear);
    const tag = nameTag(name);
    av.root.add(tag);
    const holder = new THREE.Group();
    holder.add(av.root);
    scene.add(holder);
    others.set(pid, { av, tag, holder, name, look, gear, pos: new THREE.Vector3(x, y, z), target: new THREE.Vector3(x, y, z), yaw, tyaw: yaw, act: false, speed: 0 });
  }
  function drop(pid) {
    const o = others.get(pid);
    if (!o) return;
    scene.remove(o.holder);
    o.av.dispose();
    o.tag.material.map?.dispose();
    o.tag.material.dispose();
    others.delete(pid);
  }

  function receive(m) {
    const [k] = m;
    switch (k) {
      case "welcome": {
        id = m[1];
        for (const p of m[3]) add(...p);
        h.welcome?.(m[2], others.size + 1);
        break;
      }
      case "join": {
        // A join for someone already here is a new name or look, not a new arrival.
        const known = others.has(m[1]);
        add(m[1], m[2], m[3], m[4], m[5], m[6], m[7], m[8]);
        if (!known) h.joined?.(m[1], m[2]);
        h.count?.(others.size + 1);
        break;
      }
      case "leave": {
        const o = others.get(m[1]);
        drop(m[1]);
        if (o) h.left?.(m[1], o.name);
        h.count?.(others.size + 1);
        break;
      }
      case "voices": h.voices?.(m[1]); break;
      case "voice": h.voice?.(m[1], !!m[2]); break;
      case "rtc": h.rtc?.(m[1], m[2]); break;
      case "named": h.named?.(m[1]); break;
      case "p": {
        const o = others.get(m[1]);
        if (!o) break;
        o.target.set(m[2], m[3], m[4]);
        o.tyaw = m[5];
        break;
      }
      case "act": { const o = others.get(m[1]); if (o) o.act = !!m[2]; break; }
      case "look": {
        const o = others.get(m[1]);
        if (o) add(m[1], o.name, m[2], o.target.x, o.target.y, o.target.z, o.tyaw, o.gear);
        break;
      }
      case "gear": {
        const o = others.get(m[1]);
        if (o) add(m[1], o.name, o.look, o.target.x, o.target.y, o.target.z, o.tyaw, m[2]);
        break;
      }
      case "edits": h.edits?.(m[1], m[2]); break;
      case "set": h.set?.(m[1], m[2], m[3], m[4]); break;
      case "earn": h.earn?.({ cents: m[1], today: m[2], total: m[3], what: m[4] }); break;
      case "ledger": h.ledger?.({ today: m[1], total: m[2], cap: m[3] }); break;
      case "mob": h.mob?.(m[1], m[2], m[3], m[4], m[5]); break;
      case "mobdead": h.mobdead?.(m[1]); break;
      case "chat": h.chat?.({ id: m[1], name: m[2], text: m[3], mine: m[1] === id }); break;
      case "count": h.count?.(m[1]); break;
      case "err": h.error?.(m[1]); break;
      case "challenge": case "signedin": case "voucher": case "signinfail": {
        const key = k === "signinfail" ? "signedin" : k;
        const w = waiting.get(key);
        waiting.delete(key);
        if (k === "signedin") {
          resume = { address: m[1], token: m[2] };
          h.signedin?.(m[1], m[2], { today: m[3], total: m[4], cap: m[5], name: m[6] ?? null });
        }
        if (k === "signinfail" && !w) { resume = null; h.signedout?.(m[1]); }
        w?.(m);
        break;
      }
    }
  }
  const ask = (msg, reply, ms = 20_000) => new Promise((ok, bad) => {
    waiting.set(reply, ok);
    send(msg);
    setTimeout(() => { if (waiting.get(reply) === ok) { waiting.delete(reply); bad(new Error("The world server didn't answer. Try again.")); } }, ms);
  });

  /// Called every frame with your position: sends an update when it changed enough, and moves the others.
  function tick(dt, me) {
    const now = performance.now() / 1000;
    if (open && id !== null) {
      const L = lastSent;
      const moved = Math.hypot(wrapDelta(me.x - L.x), me.y - L.y, wrapDelta(me.z - L.z));
      const turned = Math.abs(me.yaw - L.yaw);
      const gap = now - L.at;
      // Turning alone waits for the heartbeat (the others only see which way you face).
      if (gap > MIN_GAP && (!(moved <= 0.6) || ((moved > 0.05 || turned > 0.35) && gap > HEARTBEAT))) {
        const r = (v) => Math.round(v * 100) / 100;
        ws.send(JSON.stringify(["p", wrap(r(me.x)), r(me.y), wrap(r(me.z)), r(me.yaw), r(me.pitch)]));
        lastSent = { x: me.x, y: me.y, z: me.z, yaw: me.yaw, pitch: me.pitch, at: now };
      }
    }
    for (const o of others.values()) {
      const before = o.pos.clone();
      const k = 1 - Math.exp(-dt * 8);
      // Towards where they are now, the short way round (across the seam if that's shorter).
      const tx = o.pos.x + wrapDelta(o.target.x - o.pos.x), tz = o.pos.z + wrapDelta(o.target.z - o.pos.z);
      if ((tx - o.pos.x) ** 2 + (o.target.y - o.pos.y) ** 2 + (tz - o.pos.z) ** 2 > 100) o.pos.set(tx, o.target.y, tz); // a respawn or a teleport: jump there
      else o.pos.lerp(_t.set(tx, o.target.y, tz), k);
      let dy = o.tyaw - o.yaw;
      while (dy > Math.PI) dy -= Math.PI * 2;
      while (dy < -Math.PI) dy += Math.PI * 2;
      o.yaw += dy * k;
      o.av.root.rotation.y = o.yaw + Math.PI;
      const sp = Math.hypot(o.pos.x - before.x, o.pos.z - before.z) / Math.max(dt, 1e-3);
      o.speed += (sp - o.speed) * k;
      o.av.animate(dt, o.speed, o.act);
      // Kept at the copy nearest you (voice.js and the rest measure straight to it).
      o.pos.x = me.x + wrapDelta(o.pos.x - me.x);
      o.pos.z = me.z + wrapDelta(o.pos.z - me.z);
      const far = Math.hypot(o.pos.x - me.x, o.pos.z - me.z) > SEEN;
      o.holder.visible = !far;
    }
  }
  const _t = new THREE.Vector3();

  /// Stands the other miners on the curved planet as seen from the camera (after planet.follow, before the render).
  function draw() {
    for (const o of others.values()) if (o.holder.visible) place(o.holder, o.pos, 0);
  }

  return {
    start(helloMsg) { hello = helloMsg; connect(); },
    stop() { closedByUs = true; ws?.close(); },
    send,
    get id() { return id; },
    get online() { return open; },
    others,
    tick,
    draw,
    chunks: (keys) => { for (let i = 0; i < keys.length; i += 48) send(["chunks", keys.slice(i, i + 48)]); },
    breakBlock: (x, y, z) => send(["break", x, y, z]),
    place: (x, y, z, b) => send(["place", x, y, z, b]),
    hit: (mobId, dmg) => send(["hit", mobId, dmg]),
    /// A monster the room sent that this game couldn't place, or that wandered off or was lost.
    gone: (mobId) => send(["gone", mobId]),
    /// After a respawn (the room moved you to the town): your next position goes out whatever it is.
    respawn() { send(["respawn"]); lastSent = { x: NaN, y: 0, z: 0, yaw: 0, pitch: 0, at: 0 }; },
    act: (on) => send(["act", on ? 1 : 0]),
    chat: (text) => send(["chat", text]),
    /// Pick a name (web/name-rules.js); the room answers "named" or an error.
    setName: (name) => send(["setname", name]),
    /// Wear Crafter `tokenId` (null for the Rookie): the room checks on-chain that it's yours.
    wear: (tokenId) => send(["wear", tokenId]),
    /// The armor you have on (tiers for head, chest, legs, feet), for the others to see.
    gear: (tiers) => send(["gear", tiers]),
    /// One free signature proves the wallet is yours; from then on the room counts your earnings for it.
    async signIn(address, sign) {
      const [, message] = await ask(["auth", address], "challenge");
      const signature = await sign(message);
      const r = await ask(["signin", signature], "signedin");
      if (r[0] === "signinfail") throw new Error(r[1]);
      return r;
    },
    resumeWith(address, token) { resume = { address, token }; send(["resume", address, token]); },
    signOut() { resume = null; send(["signout"]); },
    /// The room's voucher for your lifetime earnings: { total (wei, string), deadline, signature }.
    async voucher() {
      const r = await ask(["voucher"], "voucher");
      if (!r[1]) throw new Error(r[4] || "No voucher right now.");
      return { total: BigInt(r[1]), deadline: BigInt(r[2]), signature: r[3] };
    },
  };
}
