// The shared world, live: other miners, everyone's block changes, the monsters the room sends you, chat, and the
// $MINE ledger. The room (multiplayer/) checks every break and every hit; this side just reports them and draws
// what comes back. Position updates go out only when you move (the room runs on Cloudflare's free plan, which
// counts incoming messages).
//
// The others you see are the ones on your planet (zones.js): flying somewhere (zone()) tells the room, drops everyone
// you saw, and ignores what the room says about the old planet until it answers "zoned" with the new one's players.
//
// The others move smoothly: each one is drawn a little in the past (about INTERP_S), moving in a straight line from
// one update of theirs to the next, so they walk at an even pace between updates rather than gliding to each one and
// waiting. The moment shown runs a little faster or slower to keep that far behind as updates come early or late.
// Your own updates also say whether you're sneaking (the flags at their end), and one goes out as soon as you stop,
// so the others don't see you glide the last stretch. Your miner's animation (avatar.js) is worked out on each game
// from how the others move, so it costs no messages.
//
// $MINE amounts from the room (earn, signedin, boost, bossreward) are in ledger units, ten-thousandths of a $MINE
// (rewards.js UNIT). Your NFT boost (boosts.js) comes as ["boost", ...] whenever it changes. Your rocket tickets
// (zones.js) come as ["tickets", { zone: count }] after signing in and whenever they change.
//
// Knocked out (zones.js CHEST_MS), the game reports it once with what you carried (dead()); the room leaves it in a
// loot chest where you fell and, in a zone, sends you home ("zoned"). At home, revive() asks to get up there again.

import * as THREE from "https://esm.sh/three@0.160.0";
import { createAvatar } from "./avatar.js";
import { heldModel } from "./held.js";
import { unpackTraits } from "./crafters.js";
import { unpackBoost } from "./boosts.js";
import { wrap, wrapDelta } from "./rules.js";
/// An angle brought round into [-pi, pi).
const turnBy = (a) => a - 2 * Math.PI * Math.floor(a / (2 * Math.PI) + 0.5);
import { place } from "./planet.js";

/// The item in hand from a player's gear as the room relays it ([four armor tiers, item]), 0 for nothing.
const heldOf = (g) => (Number.isInteger(g?.[4]) && g[4] > 0 && g[4] < 256 ? g[4] : 0);

const MIN_GAP = 0.5; // seconds between position updates, at the most
const HEARTBEAT = 3; // seconds: while moving the same way
const INTERP_S = 0.45; // seconds: others are drawn about this far in the past (half their updates' gap, plus room for
// updates coming late)
const CATCH_UP = 0.5, LAG_S = 1; // the moment shown runs up to 25% faster or slower, by CATCH_UP x how far it's off
// INTERP_S (averaged over LAG_S)
const PAUSE = 2 * MIN_GAP; // seconds: a longer wait between updates was a pause, not a slow walk
const JUMP_TO = 10; // blocks: an update this far from the last is a teleport or a respawn (drawn there at once)
export const SNEAKING = 1; // a position update's flags: sneaking
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
  // id -> { av, tag, holder, name, look, gear, held, pos (drawn), yaw, pitch, sneak, target, tyaw (their latest
  // update), act, snaps (their updates: { t (seconds, when it came), x, y, z, yaw, pitch, flags }), clock (the moment
  // shown, on the same clock), lag (how far that is behind their latest update, averaged) }
  const others = new Map();
  const queue = [];
  /// What was last sent (x NaN: send the next whatever it is).
  const unsent = () => ({ x: NaN, y: 0, z: 0, yaw: 0, pitch: 0, at: 0, flags: 0, moving: false });
  let lastSent = unsent();
  let lastTick = null; // (performance.now() / 1000 at the last tick)
  let pingTimer = null;
  const waiting = new Map(); // reply kind -> resolve
  const ticketWaits = new Map(); // payment hash (lower case) -> resolve: the room's answer about that ticket
  const reviveWaits = new Map(); // payment hash (lower case, or "free") -> resolve: the room's answer about a revive

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
      lastSent = unsent(); // (the room starts us on the pad: say where we really are)
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
    const was = others.get(pid); // (a new name, look or armor: they carry on moving as they were)
    drop(pid);
    const av = createAvatar(unpackTraits(look), gear);
    av.hold(heldModel(held));
    const tag = nameTag(name);
    av.root.add(tag);
    const holder = new THREE.Group();
    holder.add(av.root);
    scene.add(holder);
    const o = { av, tag, holder, name, look, gear, held, pos: new THREE.Vector3(x, y, z), yaw, pitch: 0, sneak: false,
      target: new THREE.Vector3(x, y, z), tyaw: yaw, act: false, clock: performance.now() / 1000, lag: 0 };
    o.snaps = [{ t: o.clock, x, y, z, yaw, pitch: 0, flags: 0 }];
    if (was) for (const k of ["pos", "yaw", "pitch", "sneak", "act", "snaps", "clock", "lag"]) o[k] = was[k];
    others.set(pid, o);
  }
  /// An update from another player: kept to draw them moving to it (tick). Positions are kept the short way round
  /// from the update before, so they interpolate across the seam.
  function heard(o, x, y, z, yaw, pitch, flags) {
    const t = performance.now() / 1000;
    const last = o.snaps[o.snaps.length - 1];
    x = last.x + wrapDelta(x - last.x);
    z = last.z + wrapDelta(z - last.z);
    const s = { t, x, y, z, yaw: last.yaw + turnBy(yaw - last.yaw), pitch, flags };
    if (Math.hypot(x - last.x, y - last.y, z - last.z) > JUMP_TO) { o.snaps = [s]; o.clock = t; o.lag = 0; }
    else {
      // After a pause (standing still, or turning only), the step to here is taken to have begun one update's gap
      // ago: they set off then, rather than creeping all the way since (and the moment shown skips the wait).
      if (t - last.t > PAUSE) {
        o.snaps.push({ ...last, t: t - MIN_GAP });
        if (o.clock < t - MIN_GAP) { o.clock = t - MIN_GAP; o.lag = INTERP_S; }
      }
      o.snaps.push(s);
      if (o.snaps.length > 12) o.snaps.splice(0, o.snaps.length - 12);
    }
    o.target.set(wrap(x), y, wrap(z));
    o.tyaw = yaw;
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
        // A join for someone already here is a new name or look, not a new arrival (m[9]: "landed" by rocket, or "ko":
        // knocked out on planet m[10] and sent home).
        const known = others.has(m[1]);
        add(m[1], m[2], m[3], m[4], m[5], m[6], m[7], m[8]);
        if (!known) h.joined?.(m[1], m[2], m[9] ?? null, m[10] ?? null);
        break;
      }
      case "leave": {
        // (m[2]: the planet they flew to, if they didn't just leave the game; m[3] "ko": knocked out, sent home.)
        const o = others.get(m[1]);
        drop(m[1]);
        if (o) h.left?.(m[1], o.name, m[2] ?? null, m[3] === "ko");
        break;
      }
      case "voices": h.voices?.(m[1]); break;
      case "voice": h.voice?.(m[1], !!m[2]); break;
      case "rtc": h.rtc?.(m[1], m[2]); break;
      case "named": h.named?.(m[1]); break;
      case "p": {
        // ["p", id, x, y, z, yaw, pitch, flags] (flags: SNEAKING; a room from before sends none)
        const o = others.get(m[1]);
        if (o) heard(o, m[2], m[3], m[4], m[5], Number.isFinite(m[6]) ? m[6] : 0, Number.isInteger(m[7]) ? m[7] : 0);
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
      case "revived": case "reviveno": {
        // ["revived", x, y, z, hash] / ["reviveno", why, hash, retry]
        const key = String((k === "revived" ? m[4] : m[2]) ?? "free").toLowerCase();
        const w = reviveWaits.get(key);
        reviveWaits.delete(key);
        if (k === "revived") lastSent = unsent(); // (stood where you fell: say so at once)
        if (w) w(m);
        else h.revive?.(m); // (an answer that came after giving up waiting)
        break;
      }
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

  /// Called every frame with you (`me`: { x, y, z, yaw, pitch, flags (SNEAKING), moving (walking, not just
  /// standing) }): sends an update when it changed enough, and moves the others.
  function tick(me) {
    const now = performance.now() / 1000;
    // (The others' clocks keep real time, even when frames are slow and the game's own dt is held short.)
    const step = Math.min(0.25, now - (lastTick ?? now));
    lastTick = now;
    if (open && id !== null) {
      const L = lastSent;
      const moved = Math.hypot(wrapDelta(me.x - L.x), me.y - L.y, wrapDelta(me.z - L.z));
      const turned = Math.abs(me.yaw - L.yaw);
      const gap = now - L.at;
      const flags = me.flags | 0;
      // Moving, or sneaking or standing up, or just stopped, at once (but no more often than MIN_GAP). Turning alone
      // waits for the heartbeat (the others only see which way you face).
      const stopped = L.moving && !me.moving && moved > 0.05;
      if (gap > MIN_GAP && (!(moved <= 0.6) || flags !== L.flags || stopped || ((moved > 0.05 || turned > 0.35) && gap > HEARTBEAT))) {
        const r = (v) => Math.round(v * 100) / 100;
        ws.send(JSON.stringify(["p", wrap(r(me.x)), r(me.y), wrap(r(me.z)), r(me.yaw), r(me.pitch), flags]));
        lastSent = { x: me.x, y: me.y, z: me.z, yaw: me.yaw, pitch: me.pitch, at: now, flags, moving: !!me.moving };
      }
    }
    for (const o of others.values()) {
      // The moment shown moves on (never past their latest update); they're drawn between the updates either side.
      // Far behind (a hidden tab, a stall), it skips ahead.
      const S = o.snaps, latest = S[S.length - 1].t;
      if (latest - o.clock > 2 * INTERP_S + MIN_GAP) { o.clock = latest - INTERP_S; o.lag = INTERP_S; }
      o.lag += (latest - o.clock - o.lag) * (1 - Math.exp(-step / LAG_S));
      o.clock = Math.min(latest, o.clock + step * Math.max(0.75, Math.min(1.25, 1 + (o.lag - INTERP_S) * CATCH_UP)));
      const shown = o.clock;
      while (S.length > 1 && S[1].t <= shown) S.shift();
      const A = S[0], B = S[1] ?? A;
      const k = B.t > A.t ? Math.max(0, Math.min(1, (shown - A.t) / (B.t - A.t))) : 1;
      o.pos.set(A.x + (B.x - A.x) * k, A.y + (B.y - A.y) * k, A.z + (B.z - A.z) * k);
      o.yaw = A.yaw + (B.yaw - A.yaw) * k;
      o.pitch = A.pitch + (B.pitch - A.pitch) * k;
      o.sneak = !!((k < 0.5 ? A : B).flags & SNEAKING);
      o.av.root.rotation.y = o.yaw + Math.PI;
      o.av.animate(step, { x: o.pos.x, y: o.pos.y, z: o.pos.z, yaw: o.yaw, pitch: o.pitch, sneak: o.sneak, swinging: o.act });
      // Kept at the copy nearest you (voice.js and the rest measure straight to it).
      o.pos.x = me.x + wrapDelta(o.pos.x - me.x);
      o.pos.z = me.z + wrapDelta(o.pos.z - me.z);
      const far = Math.hypot(o.pos.x - me.x, o.pos.z - me.z) > SEEN;
      o.holder.visible = !far;
    }
  }

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
      lastSent = unsent();
    },
    bossHit: (dmg) => send(["bosshit", dmg]),
    pvpHit: (target, dmg) => send(["pvp", target, dmg]),
    /// Knocked out at (x, y, z), carrying `items` ([item, count, wear] stacks, armor too), maybe by player `by` (a PvP
    /// zone): the room answers ["dropped", chestId] (or ["dropno", why]) and, in a zone, sends you home.
    dead: (items, x, y, z, by = null) => send(["dead", items, Math.round(x * 100) / 100, Math.round(y * 100) / 100, Math.round(z * 100) / 100, by]),
    /// Get up where you fell (home only): paid by transaction `hash` (MinePayments kind 2), or null while revives are
    /// free. Resolves with the room's ["revived", x, y, z, hash] or ["reviveno", why, hash, retry] (retry 1: worth
    /// sending again; 2: the payment wasn't used and can pay for a later revive).
    revive(hash = null, ms = 45_000) {
      const key = (hash ?? "free").toLowerCase();
      return new Promise((ok) => {
        reviveWaits.set(key, ok);
        send(["revive", hash]);
        setTimeout(() => {
          if (reviveWaits.get(key) !== ok) return;
          reviveWaits.delete(key);
          ok(["reviveno", "The world server didn't answer. Try again.", hash, 1]);
        }, ms);
      });
    },
    loot: (chestId) => send(["loot", chestId]),
    chunks: (keys) => { for (let i = 0; i < keys.length; i += 48) send(["chunks", keys.slice(i, i + 48)]); },
    breakBlock: (x, y, z) => send(["break", x, y, z]),
    place: (x, y, z, b) => send(["place", x, y, z, b]),
    hit: (mobId, dmg) => send(["hit", mobId, dmg]),
    /// A monster the room sent that this game couldn't place, or that wandered off or was lost.
    gone: (mobId) => send(["gone", mobId]),
    /// After a respawn (the room moved you to the town): your next position goes out whatever it is.
    respawn() { send(["respawn"]); lastSent = unsent(); },
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
