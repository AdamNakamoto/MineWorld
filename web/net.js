// The shared world, live: other miners, everyone's block changes, the monsters the room sends you, chat, and the
// $MINE ledger. The room (multiplayer/) checks every break and every hit; this side just reports them and draws
// what comes back. Position updates go out only when you move (the room runs on Cloudflare's free plan, which
// counts incoming messages).
//
// The others you see are the ones on your planet (zones.js): flying somewhere (zone()) tells the room, drops everyone
// you saw, and ignores what the room says about the old planet until it answers "zoned" with the new one's players.
//
// $MINE amounts from the room (earn, signedin, boost, bossreward) are in ledger units, ten-thousandths of a $MINE
// (rewards.js UNIT). Your NFT boost (boosts.js) comes as ["boost", ...] whenever it changes. Your rocket tickets
// (zones.js) come as ["tickets", { zone: count }] after signing in and whenever they change.

import * as THREE from "https://esm.sh/three@0.160.0";
import { createAvatar } from "./avatar.js";
import { heldModel } from "./held.js";
import { unpackTraits } from "./crafters.js";
import { unpackBoost } from "./boosts.js";
import { wrap, wrapDelta } from "./rules.js";
import { place } from "./planet.js";

/// The item in hand from a player's gear as the room relays it ([four armor tiers, item]), 0 for nothing.
const heldOf = (g) => (Number.isInteger(g?.[4]) && g[4] > 0 && g[4] < 256 ? g[4] : 0);

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

// What the room says about the planet you're on (ignored between leaving one and the room's "zoned" for the next).
const PLANET_NEWS = new Set(["p", "act", "join", "leave", "look", "gear", "set", "edits", "mob", "boss", "bosshp",
  "chest", "chests", "chestgone", "pvphit", "regrow"]);

export function createNet(url, scene, h) {
  let ws = null, id = null, open = false, closedByUs = false, backoff = 1000;
  let hello = null, resume = null, zone = "home", flying = null;
  const others = new Map(); // id -> { av, tag, name, design, pos, target, yaw, tyaw, act, speed }
  const queue = [];
  let lastSent = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, at: 0 };
  let pingTimer = null;
  const waiting = new Map(); // reply kind -> resolve
  const ticketWaits = new Map(); // payment hash (lower case) -> resolve: the room's answer about that ticket

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
      ws.send(JSON.stringify(["hello", { ...(hello ?? {}), zone }]));
      flying = null;
      lastSent = { x: NaN, y: 0, z: 0, yaw: 0, pitch: 0, at: 0 }; // (the room starts us on the pad: say where we really are)
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
  /// `gear`: the armor tiers they wear (head, chest, legs, feet), then the item in their hand (0: nothing), as the
  /// room relays them.
  function add(pid, name, look, x, y, z, yaw, gear) {
    const ok = Array.isArray(gear) && gear.length >= 4 && gear.slice(0, 4).every((t) => Number.isInteger(t) && t >= 0 && t <= 4);
    const held = ok ? heldOf(gear) : 0;
    gear = ok ? gear.slice(0, 4) : [0, 0, 0, 0];
    drop(pid);
    const av = createAvatar(unpackTraits(look), gear);
    av.hold(heldModel(held));
    const tag = nameTag(name);
    av.root.add(tag);
    const holder = new THREE.Group();
    holder.add(av.root);
    scene.add(holder);
    others.set(pid, { av, tag, holder, name, look, gear, held, pos: new THREE.Vector3(x, y, z), target: new THREE.Vector3(x, y, z), yaw, tyaw: yaw, act: false, speed: 0 });
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
    if (flying && PLANET_NEWS.has(k)) return; // (about the planet just left)
    switch (k) {
      case "welcome": {
        id = m[1];
        for (const p of m[3]) add(...p);
        h.welcome?.(m[2], m[4] ?? others.size + 1, m[6] ?? {});
        break;
      }
      case "zoned": {
        // The room has you on planet m[1] now: these are the players there.
        flying = null;
        zone = m[1];
        for (const pid of [...others.keys()]) { drop(pid); h.gone?.(pid); }
        for (const p of m[2]) add(...p);
        h.zoned?.(m[1], m[3]);
        break;
      }
      case "join": {
        // A join for someone already here is a new name or look, not a new arrival (m[9]: "landed" by rocket).
        const known = others.has(m[1]);
        add(m[1], m[2], m[3], m[4], m[5], m[6], m[7], m[8]);
        if (!known) h.joined?.(m[1], m[2], m[9] === "landed");
        break;
      }
      case "leave": {
        // (m[2]: the planet they flew to, if they didn't just leave the game.)
        const o = others.get(m[1]);
        drop(m[1]);
        if (o) h.left?.(m[1], o.name, m[2] ?? null);
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
        if (o) add(m[1], o.name, m[2], o.target.x, o.target.y, o.target.z, o.tyaw, [...o.gear, o.held]);
        break;
      }
      case "gear": {
        const o = others.get(m[1]), g = m[2];
        if (!o) break;
        // Only the item in hand changed (the usual case: a new hotbar slot): just swap it.
        if (Array.isArray(g) && g.slice(0, 4).join() === o.gear.join()) {
          o.held = heldOf(g);
          o.av.hold(heldModel(o.held));
        } else add(m[1], o.name, o.look, o.target.x, o.target.y, o.target.z, o.tyaw, g);
        break;
      }
      case "edits": if ((m[3] ?? "home") === zone) h.edits?.(m[1], m[2]); break;
      case "set": h.set?.(m[1], m[2], m[3], m[4]); break;
      case "earn": h.earn?.({ units: m[1], today: m[2], total: m[3], what: m[4] }); break;
      case "boost": h.boost?.(unpackBoost(m.slice(1)), m[6]); break;
      case "ledger": h.ledger?.({ today: m[1], total: m[2], cap: m[3] }); break;
      case "mob": h.mob?.(m[1], m[2], m[3], m[4], m[5]); break;
      case "mobdead": h.mobdead?.(m[1]); break;
      case "chat": h.chat?.({ id: m[1], name: m[2], text: m[3], mine: m[1] === id }); break;
      case "count": h.count?.(m[1]); break;
      case "err": h.error?.(m[1]); break;
      case "sys": h.sys?.(m[1]); break;
      case "regrow": h.regrow?.(m[1]); break;
      case "boss": h.boss?.(m); break;
      case "bosshp": h.bossHp?.(m[1], m[2], !!m[3]); break;
      case "bossreward": h.bossReward?.({ units: m[1], share: m[2], items: m[3], signedIn: m[4] }); break;
      case "pvphit": h.pvpHit?.(m[1], m[2], m[3], m[4]); break;
      case "pvpno": h.pvpNo?.(m[1], m[2]); break;
      case "dropped": h.dropped?.(m[1]); break;
      case "dropno": h.dropNo?.(m[1]); break;
      case "chest": h.chest?.(m[1], m[2], m[3], m[4], m[5], m[6]); break;
      case "chests": h.chests?.(m[1]); break;
      case "chestgone": h.chestGone?.(m[1], m[2]); break;
      case "looted": h.looted?.(m[1], m[2], m[3]); break;
      case "lootno": h.lootNo?.(m[1], m[2]); break;
      case "tickets": h.tickets?.(m[1] && typeof m[1] === "object" ? m[1] : {}); break;
      case "ticketok": case "ticketno": {
        // ["ticketok", zone, count, hash] / ["ticketno", zone, why, hash, retry]
        const key = String(m[3] ?? "").toLowerCase();
        const w = ticketWaits.get(key);
        ticketWaits.delete(key);
        if (w) w(m);
        else h.ticket?.(m); // (an answer about a payment sent again after a reconnect)
        break;
      }
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

  /// The other miner a ray (origin o, unit direction d) hits first within `max`: { id, o, t }. (Only asked in a PvP
  /// zone: nowhere else can players hit each other.)
  function raycast(origin, d, max) {
    let best = null;
    for (const [pid, o] of others) {
      if (!o.holder.visible) continue;
      const min = [o.pos.x - 0.4, o.pos.y, o.pos.z - 0.4], mx = [o.pos.x + 0.4, o.pos.y + 1.85, o.pos.z + 0.4];
      const O = [origin.x, origin.y, origin.z], D = [d.x, d.y, d.z];
      let t0 = 0, t1 = max, ok = true;
      for (let a = 0; a < 3 && ok; a++) {
        if (Math.abs(D[a]) < 1e-9) { if (O[a] < min[a] || O[a] > mx[a]) ok = false; continue; }
        let ta = (min[a] - O[a]) / D[a], tb = (mx[a] - O[a]) / D[a];
        if (ta > tb) [ta, tb] = [tb, ta];
        t0 = Math.max(t0, ta);
        t1 = Math.min(t1, tb);
        if (t0 > t1) ok = false;
      }
      if (ok && (!best || t0 < best.t)) best = { id: pid, o, t: t0 };
    }
    return best;
  }

  return {
    start(helloMsg) { hello = helloMsg; connect(); },
    stop() { closedByUs = true; ws?.close(); },
    send,
    get id() { return id; },
    get online() { return open; },
    get zone() { return zone; },
    /// Between asking to fly and the room's answer.
    get flying() { return !!flying; },
    others,
    tick,
    draw,
    raycast,
    /// Fly to planet `key` (zones.js): the room puts you on its pad and answers "zoned" with who's there.
    fly(key) {
      zone = key;
      for (const pid of [...others.keys()]) { drop(pid); h.gone?.(pid); }
      if (!open) return; // (the next hello says where you are)
      flying = key;
      send(["zone", key]);
      lastSent = { x: NaN, y: 0, z: 0, yaw: 0, pitch: 0, at: 0 };
    },
    bossHit: (dmg) => send(["bosshit", dmg]),
    pvpHit: (target, dmg) => send(["pvp", target, dmg]),
    /// Knocked out by player `by` in a PvP zone, carrying `items` ([item, count, wear] stacks).
    pvpDead: (by, items) => send(["pvpdead", by, items]),
    loot: (chestId) => send(["loot", chestId]),
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
    /// Wear Crafter `tokenId` (null for the Rookie): the room checks on-chain that it's yours, and its rarity and
    /// level become your Crafter boost.
    wear: (tokenId) => send(["wear", tokenId]),
    /// Use token `tokenId` of a boost slot's collection (boosts.js SLOTS: "skin", "companion", "aura", "vehicle"), or
    /// null to stop: the room checks it's yours and answers with your new ["boost", ...] (or why not).
    equip: (slot, tokenId) => send(["equip", slot, tokenId]),
    /// Ask the room to read the NFTs you use again now (after leveling up the Crafter you wear): it answers with your
    /// ["boost", ...]. The room allows a couple at once, then one every 15 s.
    recheck: () => send(["recheck"]),
    /// A rocket ticket to `zone`, paid by transaction `hash` (MinePayments, kind 1): the room checks the payment and
    /// answers ["ticketok", zone, count, hash] or ["ticketno", zone, why, hash, retry] (retry 1: worth sending again).
    ticket(hash, zone, ms = 45_000) {
      const key = hash.toLowerCase();
      return new Promise((ok) => {
        ticketWaits.set(key, ok);
        send(["ticket", hash, zone]);
        setTimeout(() => {
          if (ticketWaits.get(key) !== ok) return;
          ticketWaits.delete(key);
          ok(["ticketno", zone, "The world server didn't answer. Try again.", hash, 1]);
        }, ms);
      });
    },
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
