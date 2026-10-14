// MineWorldCraft's shared world. One Durable Object holds it: who's playing and where, every block anyone has broken
// or placed (the terrain itself comes from web/worldgen.js, so only edits are stored), the monsters it sends each
// player, chat, the MineWorld Crafter each player wears, and the $MINE ledger.
//
// Earning is checked here, never trusted to the game: a broken block must really be there (the room runs the same
// world generator), have an open side, be within reach of where the player really is (and the player not inside
// rock), outside the town, and broken no faster than the best pickaxe allows; blocks players placed pay nothing;
// monsters are spawned by the room and their hits come no faster and no harder than the best sword's. A player who
// moves faster than anyone can, or has just (re)connected, earns nothing for a few seconds. Each wallet earns at most
// DAILY_EARN_CAP a UTC day, from one connection at a time. A player signs in once with their wallet (a free
// signature), and the room signs vouchers for their lifetime total, which MiningSites pays out on-chain to wallets
// with an open mining site.
//
// Runs on Cloudflare's free plan: WebSockets hibernate, pings are answered without waking the room, and writes are
// batched (edits per chunk, the ledger in 16 shards) every FLUSH_MS.
//
// The world is a small planet that wraps round in x and z (rules.js): positions are kept in 0..WORLD, and every
// distance (reach, who's near, voice, monsters, the speed check) is measured the short way round.

import { DurableObject } from "cloudflare:workers";
import { verifyMessage, isAddress, getAddress, createPublicClient, http, parseAbi, keccak256, encodeAbiParameters } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { BLOCKS, AIR, WATER, BEDROCK, fastestBreak, BEST_DAMAGE } from "../../web/blocks.js";
import { naturalBlock, index as blockIndex } from "../../web/worldgen.js";
import {
  WORLD, CHUNK, HEIGHT, SPAWN, TOWN, PROTECT_R, ROOM_REACH, ROOM_ATTACK_MS, protectedAt, isNight,
  MOBS, MOBS_PER_PLAYER, MOB_EVERY_MS, MOB_LIFE_MS, UNDERGROUND_Y, wrap, wrapDelta, wrapDist,
} from "../../web/rules.js";
import { BLOCK_REWARDS, MOB_REWARDS, DAILY_EARN_CAP, toCents, centsToWei } from "../../web/rewards.js";
import { cleanChat, CHAT_EVERY_MS } from "../../web/chat-rules.js";
import { traitsOf, packTraits, SUPPLY } from "../../web/crafters.js";
import { cleanName, nameShown, NAME_EVERY_MS } from "../../web/name-rules.js";

const MAX_SOCKETS = 300;
const MAX_PER_IP = 8;
const MAX_MSG = 12_000; // (voice chat's connection offers are a few kilobytes)
const NEAR = 96; // blocks: positions go to players this close
const NEAR_EDITS = 304; // and block changes this close (games keep chunks loaded out to (view 15 + 3) chunks: on a
// planet WORLD wide, no one is further than WORLD / 2 along either axis, so that's everyone)
const FLUSH_MS = 30_000;
const BREAK_CREDIT = 2.5; // seconds of breaking a player can bank (network bursts); a new connection starts with none
const PLACE_PER_S = 8;
const HIT_EVERY_MS = 450; // the hit bucket refills one hit this often, up to two
const SETTLE_MS = 10_000; // no earnings for this long after (re)connecting, signing in, or a teleport
const CHUNK_KEYS_PER_MIN = 600; // edit requests a connection may make (a full view is about 300)
const EDIT_CHUNKS_PER_MIN = 12; // distinct chunks one connection may change a minute
const AUTH_EVERY_MS = 5000;
const CHUNKS = WORLD / CHUNK;
const DAY_MS = 86_400_000;
const CAP = toCents(DAILY_EARN_CAP);
const CACHE_CHUNKS = 800;
// Chunk edits are stored as `${EDITS}${cx},${cz}`. The 1024-wide world's edits ("c:") belong to a world that's gone,
// so the planet's have their own prefix and those are never read.
const EDITS = "c2:";
const VOICE_RANGE = 64; // blocks: voice connections are only set up between players this close
const RTC_PER_MIN = 240; // voice set-up messages a connection may send a minute

// The game's homes: its own domain (to be decided: add it here), Vercel previews and local development.
const ORIGINS = [/^https:\/\/(www\.)?mineworldcraft\.fun$/, /^https:\/\/[a-z0-9-]+\.vercel\.app$/, /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/];

const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const authMessage = (address, nonce) =>
  `MineWorldCraft sign-in\n\nSign to count your $MINE earnings for this wallet. It's free and sends no transaction.\n\nWallet: ${address}\nSession: ${nonce}`;
const randomHex = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, "0")).join("");
async function sha256(s) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v < hi;
const num = (v) => typeof v === "number" && Number.isFinite(v);
const CRAFTERS_ABI = parseAbi(["function ownerOf(uint256) view returns (address)", "function seed() view returns (uint256)"]);
const HASH = { keccak256, encodeAbiParameters };
/// A token bucket kept on the attachment: refills `per` units a second up to `max`; takes `cost` if it can.
function bucket(a, key, max, per, cost, now) {
  const at = a[`${key}At`] ?? now;
  a[key] = Math.min(max, (a[key] ?? max) + ((now - at) / 1000) * per);
  a[`${key}At`] = now;
  if (a[key] < cost) return false;
  a[key] -= cost;
  return true;
}

export class World extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
    this.atts = new Map(); // ws -> attachment, as last saved
    this.edits = new Map(); // chunk key -> Map(index -> block)
    this.dirtyChunks = new Set();
    this.saving = new Set(); // chunk keys being written right now (kept in the cache until they are)
    this.shards = new Map(); // "0".."f" -> { wallet: { total, day, today } }
    this.dirtyShards = new Set();
    this.flushTimer = null;
    this.flushing = null;
    this.nextId = null;
    this.authByIp = new Map(); // ip -> recent sign-in attempts (ms)
    this.crafterSeed = null; // the Crafters' revealed seed, once read
    // Answered by Cloudflare without waking the room (and without counting as a request).
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('["ping"]', '["pong"]'));
  }

  // ---------------------------------------------------------------- sockets

  att(ws) {
    let a = this.atts.get(ws);
    if (!a) {
      a = ws.deserializeAttachment() ?? {};
      this.atts.set(ws, a);
    }
    return a;
  }
  save(ws, a) {
    ws.serializeAttachment(a);
  }
  players() {
    return this.ctx.getWebSockets().map((ws) => [ws, this.att(ws)]).filter(([, a]) => a.ready);
  }
  send(ws, msg) {
    try { ws.send(JSON.stringify(msg)); } catch {}
  }
  /// To every player within `range` blocks of (x, z), except `skip`.
  near(x, z, msg, skip, range = NEAR) {
    const s = JSON.stringify(msg);
    for (const [ws, a] of this.players()) {
      if (ws === skip) continue;
      if (Math.abs(wrapDelta(a.x - x)) > range || Math.abs(wrapDelta(a.z - z)) > range) continue;
      try { ws.send(s); } catch {}
    }
  }
  everyone(msg, skip) {
    const s = JSON.stringify(msg);
    for (const [ws] of this.players()) if (ws !== skip) try { ws.send(s); } catch {}
  }

  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/count") {
      return Response.json({ online: this.players().length }, { headers: { "access-control-allow-origin": "*" } });
    }
    if (req.headers.get("upgrade") !== "websocket") return new Response("Expected a WebSocket", { status: 426 });
    const origin = req.headers.get("origin");
    if (origin && !ORIGINS.some((r) => r.test(origin))) return new Response("Not allowed", { status: 403 });
    const sockets = this.ctx.getWebSockets();
    if (sockets.length >= MAX_SOCKETS) return new Response("The world is full", { status: 503 });
    const ip = req.headers.get("x-ip") ?? "";
    if (ip && sockets.filter((w) => this.att(w).ip === ip).length >= MAX_PER_IP) return new Response("Too many connections", { status: 429 });
    if (this.nextId === null) this.nextId = Math.max(0, ...sockets.map((w) => this.att(w).id ?? 0)) + 1;
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    const now = Date.now();
    const a = {
      id: this.nextId++, name: "", ip, wallet: null, look: null, x: SPAWN.x, y: SPAWN.y, z: SPAWN.z, yaw: 0, ready: false,
      mobs: [], mobSeq: 0, credit: 0, creditAt: now, suspect: now + SETTLE_MS,
    };
    a.name = `Guest-${a.id}`;
    this.atts.set(server, a);
    this.save(server, a);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, data) {
    if (typeof data !== "string" || data.length > MAX_MSG) return;
    let m;
    try { m = JSON.parse(data); } catch { return; }
    if (!Array.isArray(m)) return;
    const a = this.att(ws);
    try {
      switch (m[0]) {
        case "hello": return this.hello(ws, a);
        case "p": return await this.position(ws, a, m);
        case "chunks": return await this.chunks(ws, a, m[1]);
        case "break": return await this.breakBlock(ws, a, m[1], m[2], m[3]);
        case "place": return await this.place(ws, a, m[1], m[2], m[3], m[4]);
        case "hit": return await this.hit(ws, a, m[1], m[2]);
        case "gone": return this.gone(ws, a, m[1]);
        case "act": if (a.ready) this.near(a.x, a.z, ["act", a.id, m[1] ? 1 : 0], ws); return;
        case "respawn": a.x = SPAWN.x; a.y = SPAWN.y; a.z = SPAWN.z; a.pAt = Date.now(); a.mobs = []; this.save(ws, a); return;
        case "chat": return this.chat(ws, a, m[1]);
        case "auth": return this.auth(ws, a, m[1]);
        case "signin": return await this.signIn(ws, a, m[1]);
        case "resume": return await this.resume(ws, a, m[1], m[2]);
        case "signout": a.wallet = null; a.nick = null; this.rename(ws, a); return;
        case "voucher": return await this.voucher(ws, a);
        case "wear": return await this.wear(ws, a, m[1]);
        case "setname": return await this.setName(ws, a, m[1]);
        case "voice": return this.voice(ws, a, m[1]);
        case "rtc": return this.rtc(ws, a, m[1], m[2]);
      }
    } catch (e) {
      console.log("message failed", m[0], e?.message ?? e);
    }
  }

  webSocketClose(ws) {
    this.leave(ws);
  }
  webSocketError(ws) {
    this.leave(ws);
  }
  leave(ws) {
    const a = this.att(ws);
    this.atts.delete(ws);
    if (a.ready) this.everyone(["leave", a.id], ws);
    try { ws.close(1000, "bye"); } catch {}
  }

  hello(ws, a) {
    if (a.ready) return;
    a.ready = true;
    this.save(ws, a);
    const list = this.players().filter(([w]) => w !== ws).map(([, o]) => [o.id, o.name, o.look, o.x, o.y, o.z, o.yaw]);
    this.send(ws, ["welcome", a.id, Date.now(), list, list.length + 1]);
    const voices = this.players().filter(([w, o]) => w !== ws && o.voice).map(([, o]) => o.id);
    if (voices.length) this.send(ws, ["voices", voices]);
    this.everyone(["join", a.id, a.name, a.look, a.x, a.y, a.z, a.yaw], ws);
  }
  rename(ws, a) {
    a.name = a.wallet ? (a.nick && nameShown(a.nick) ? a.nick : short(a.wallet)) : `Guest-${a.id}`;
    this.save(ws, a);
    if (a.ready) this.everyone(["join", a.id, a.name, a.look, a.x, a.y, a.z, a.yaw], ws);
  }

  async position(ws, a, m) {
    if (!a.ready) return;
    const [, x, y, z, yaw, pitch] = m;
    if (![x, y, z, yaw].every(num) || x < 0 || z < 0 || x >= WORLD || z >= WORLD || y < 0 || y > HEIGHT + 20) return;
    const now = Date.now();
    // A player moving faster than anyone can (a teleport) earns nothing for a while. Idle time can't be banked:
    // whatever the gap, a single update may cover at most a second's worth. Falling is fast; climbing isn't.
    // (Walking over the seam, from 511 to 0, is a step, not a leap.)
    const dt = Math.min(1, Math.max(0.05, (now - (a.pAt ?? now)) / 1000));
    const dy = y - a.y;
    if (wrapDist(x, z, a.x, a.z) / dt > 40 || dy / dt > 20 || -dy / dt > 80) a.suspect = now + SETTLE_MS;
    a.x = x; a.y = y; a.z = z; a.yaw = yaw; a.pAt = now;
    this.near(x, z, ["p", a.id, x, y, z, yaw, num(pitch) ? pitch : 0], ws);
    await this.maybeMob(ws, a, now);
    this.save(ws, a);
  }

  chat(ws, a, raw) {
    if (!a.ready) return;
    const now = Date.now();
    if (now - (a.chatAt ?? 0) < CHAT_EVERY_MS) return this.send(ws, ["err", "One message every two seconds."]);
    const r = cleanChat(raw);
    if (r.error) return this.send(ws, ["err", r.error]);
    a.chatAt = now;
    this.save(ws, a);
    this.everyone(["chat", a.id, a.name, r.text]);
  }

  // ---------------------------------------------------------------- the world's edits

  async chunkEdits(key) {
    let e = this.edits.get(key);
    if (e) return e;
    const raw = await this.ctx.storage.get(`${EDITS}${key}`);
    e = this.edits.get(key); // (filled by another message meanwhile)
    if (e) return e;
    e = new Map();
    if (raw) for (let i = 0; i + 2 < raw.length; i += 3) e.set(raw[i] | (raw[i + 1] << 8), raw[i + 2]);
    this.edits.set(key, e);
    if (this.edits.size > CACHE_CHUNKS) {
      // Forget chunks nobody is changing; never one whose edits aren't written yet.
      for (const k of this.edits.keys()) {
        if (this.edits.size <= CACHE_CHUNKS * 0.8) break;
        if (!this.dirtyChunks.has(k) && !this.saving.has(k) && k !== key) this.edits.delete(k);
      }
    }
    return e;
  }

  async chunks(ws, a, keys) {
    if (!Array.isArray(keys)) return;
    const seen = new Set();
    for (const k of keys.slice(0, 48)) {
      if (typeof k !== "string" || !/^\d{1,2},\d{1,2}$/.test(k)) continue;
      const [cx, cz] = k.split(",").map(Number);
      const key = `${cx},${cz}`; // the one spelling, so "01,5" can't dodge the cache
      if (cx >= CHUNKS || cz >= CHUNKS || seen.has(key)) continue;
      seen.add(key);
      if (!bucket(a, "keys", CHUNK_KEYS_PER_MIN, CHUNK_KEYS_PER_MIN / 60, 1, Date.now())) break;
      const e = await this.chunkEdits(key);
      this.send(ws, ["edits", key, [...e]]);
    }
    this.save(ws, a);
  }

  /// The block at (x, y, z) now, and whether a player put it there. x and z wrap round (a neighbour of x = 0 is 511).
  async blockAt(x, y, z) {
    if (!Number.isInteger(x) || !Number.isInteger(z) || y < 0 || y >= HEIGHT) return { block: y < 0 ? BEDROCK : AIR, placed: false };
    x = wrap(x);
    z = wrap(z);
    const key = `${Math.floor(x / CHUNK)},${Math.floor(z / CHUNK)}`;
    const e = await this.chunkEdits(key);
    const i = blockIndex(x % CHUNK, y, z % CHUNK);
    const placed = e.has(i);
    return { key, e, i, placed, block: placed ? e.get(i) : naturalBlock(x, y, z) };
  }
  async solidAt(x, y, z) {
    return !!BLOCKS[(await this.blockAt(x, y, z)).block]?.solid;
  }
  /// Whether a player could stand where they say: their feet and head are not inside solid blocks.
  async standing(a) {
    const x = Math.floor(a.x), y = Math.floor(a.y), z = Math.floor(a.z);
    return !(await this.solidAt(x, y, z)) && !(await this.solidAt(x, y + 1, z));
  }
  /// Whether a block has a side open to air or water (anything else couldn't have been reached).
  async exposed(x, y, z) {
    for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
      if (!(await this.solidAt(x + dx, y + dy, z + dz))) return true;
    }
    return false;
  }
  /// Changing a block counts against the connection's chunk allowance (a few distinct chunks a minute).
  editAllowed(a, key, now) {
    if (!a.editMin || now - a.editMin.at > 60_000) a.editMin = { at: now, keys: [] };
    if (a.editMin.keys.includes(key)) return true;
    if (a.editMin.keys.length >= EDIT_CHUNKS_PER_MIN) return false;
    a.editMin.keys.push(key);
    return true;
  }
  setBlock(at, b, x, y, z, ws) {
    at.e.set(at.i, b);
    this.dirtyChunks.add(at.key);
    this.scheduleFlush();
    this.near(x, z, ["set", x, y, z, b], ws, NEAR_EDITS);
  }
  inReach(a, x, y, z) {
    return Math.hypot(wrapDelta(x + 0.5 - a.x), y + 0.5 - (a.y + 1.62), wrapDelta(z + 0.5 - a.z)) <= ROOM_REACH;
  }

  async breakBlock(ws, a, x, y, z) {
    if (!a.ready || !isInt(x, 0, WORLD) || !isInt(z, 0, WORLD) || !isInt(y, 1, HEIGHT)) return;
    const at = await this.blockAt(x, y, z);
    const cur = at.block;
    const undo = () => this.send(ws, ["set", x, y, z, cur]);
    const now = Date.now();
    if (cur === AIR || cur === WATER || cur === BEDROCK || protectedAt(x, z) || !this.inReach(a, x, y, z)) return undo();
    if (!(await this.exposed(x, y, z)) || !(await this.standing(a)) || !this.editAllowed(a, at.key, now)) { this.save(ws, a); return undo(); }
    // Breaking takes time: a player banks up to BREAK_CREDIT seconds and each block costs what the best pickaxe needs.
    if (!bucket(a, "credit", BREAK_CREDIT, 1, fastestBreak(cur) * 0.85, now)) { this.save(ws, a); return undo(); }
    this.setBlock(at, AIR, x, y, z, ws);
    const reward = BLOCK_REWARDS[cur];
    if (!at.placed && reward && a.wallet && !(a.suspect > now)) await this.credit(ws, a, toCents(reward), cur);
    this.save(ws, a);
  }

  async place(ws, a, x, y, z, b) {
    if (!a.ready || !isInt(x, 0, WORLD) || !isInt(z, 0, WORLD) || !isInt(y, 1, HEIGHT) || !isInt(b, 1, 64)) return;
    const at = await this.blockAt(x, y, z);
    const cur = at.block;
    const undo = () => this.send(ws, ["set", x, y, z, cur]);
    const now = Date.now();
    if (!BLOCKS[b]?.placeable || (cur !== AIR && cur !== WATER && !BLOCKS[cur]?.plant) || protectedAt(x, z) || !this.inReach(a, x, y, z)) return undo();
    if (!this.editAllowed(a, at.key, now) || !bucket(a, "pcredit", PLACE_PER_S, PLACE_PER_S, 1, now)) { this.save(ws, a); return undo(); }
    this.setBlock(at, b, x, y, z, ws);
    this.save(ws, a);
  }

  // ---------------------------------------------------------------- monsters

  async maybeMob(ws, a, now) {
    a.mobs = (a.mobs ?? []).filter((m) => now - m.at < MOB_LIFE_MS);
    if (a.mobs.length >= MOBS_PER_PLAYER || now < (a.nextMob ?? 0)) return;
    const under = a.y < UNDERGROUND_Y;
    if (!under && !isNight(now)) return;
    if (wrapDist(a.x, a.z, TOWN.x, TOWN.z) < PROTECT_R + 16) return;
    a.nextMob = now + MOB_EVERY_MS * (0.8 + Math.random() * 0.4);
    // Underground means really in a cave: not claiming a spot inside the rock.
    if (under && !(await this.standing(a))) return;
    const r = Math.random();
    const kind = under && a.y < 30 && r < 0.2 ? "golem" : r < 0.45 ? "mudling" : r < 0.75 ? "rattler" : "crawler";
    const ang = Math.random() * Math.PI * 2, d = 10 + Math.random() * 6;
    const mob = { i: ++a.mobSeq, k: kind, x: wrap(Math.round(a.x + Math.cos(ang) * d)), y: Math.round(a.y), z: wrap(Math.round(a.z + Math.sin(ang) * d)), hp: MOBS[kind].hp, at: now };
    a.mobs.push(mob);
    this.send(ws, ["mob", mob.i, kind, mob.x, mob.y, mob.z]);
  }

  async hit(ws, a, mobId, damage) {
    const now = Date.now();
    const m = (a.mobs ?? []).find((o) => o.i === mobId);
    if (!m || now - m.at < 600) return;
    // The monster can't have gone further than its speed allows since it came, nor the player be out of reach of it.
    const reach = 16 + MOBS[m.k].speed * ((now - m.at) / 1000) + ROOM_REACH;
    if (wrapDist(a.x, a.z, m.x, m.z) > reach) return;
    // A sword swings every ATTACK_MS; the bucket lets two hits through close together (network jitter), no more.
    if (!bucket(a, "hits", 2, 1000 / HIT_EVERY_MS, 1, now)) { this.save(ws, a); return; }
    m.hp -= Math.max(1, Math.min(BEST_DAMAGE, Math.floor(Number(damage)) || 1));
    if (m.hp <= 0) {
      a.mobs = a.mobs.filter((o) => o !== m);
      this.send(ws, ["mobdead", m.i]);
      if (a.wallet && !(a.suspect > now)) await this.credit(ws, a, toCents(MOB_REWARDS[m.k] ?? 0), m.k);
    }
    this.save(ws, a);
  }
  /// The game couldn't place a monster, or it wandered off: free its place for the next one.
  gone(ws, a, mobId) {
    const before = (a.mobs ?? []).length;
    a.mobs = (a.mobs ?? []).filter((o) => o.i !== mobId);
    if (a.mobs.length !== before) this.save(ws, a);
  }

  // ---------------------------------------------------------------- the $MINE ledger

  async shard(wallet) {
    const s = wallet[2].toLowerCase();
    let sh = this.shards.get(s);
    if (!sh) {
      const stored = (await this.ctx.storage.get(`led:${s}`)) ?? {};
      sh = this.shards.get(s) ?? stored;
      this.shards.set(s, sh);
    }
    return [s, sh];
  }
  async ledger(wallet) {
    const [s, sh] = await this.shard(wallet);
    const day = Math.floor(Date.now() / DAY_MS);
    const l = (sh[wallet] ??= { total: 0, day, today: 0 });
    if (l.day !== day) { l.day = day; l.today = 0; }
    return [s, l];
  }
  async credit(ws, a, cents, what) {
    if (!cents) return;
    const [s, l] = await this.ledger(a.wallet);
    const c = Math.min(cents, CAP - l.today);
    if (c <= 0) return this.send(ws, ["earn", 0, l.today, l.total, "cap"]);
    l.today += c;
    l.total += c;
    this.dirtyShards.add(s);
    this.scheduleFlush();
    this.send(ws, ["earn", c, l.today, l.total, what]);
  }

  scheduleFlush() {
    // A pending timer also keeps the room from hibernating before its changes are written.
    this.flushTimer ??= setTimeout(() => this.flush().catch((e) => console.log("flush failed", e?.message ?? e)), FLUSH_MS);
  }
  /// Writes every changed chunk and ledger shard. If a write fails, what it held is marked changed again.
  async flush() {
    if (this.flushing) await this.flushing;
    clearTimeout(this.flushTimer);
    this.flushTimer = null;
    const chunks = [...this.dirtyChunks], shards = [...this.dirtyShards];
    if (!chunks.length && !shards.length) return;
    this.dirtyChunks.clear();
    this.dirtyShards.clear();
    for (const k of chunks) this.saving.add(k);
    const out = {};
    for (const k of chunks) {
      const e = this.edits.get(k);
      const raw = new Uint8Array(e.size * 3);
      let j = 0;
      for (const [i, b] of e) { raw[j++] = i & 255; raw[j++] = i >> 8; raw[j++] = b; }
      out[`${EDITS}${k}`] = raw;
    }
    for (const s of shards) out[`led:${s}`] = this.shards.get(s);
    this.flushing = (async () => {
      try {
        const keys = Object.keys(out);
        for (let i = 0; i < keys.length; i += 128) {
          await this.ctx.storage.put(Object.fromEntries(keys.slice(i, i + 128).map((k) => [k, out[k]])));
        }
      } catch (e) {
        for (const k of chunks) this.dirtyChunks.add(k);
        for (const s of shards) this.dirtyShards.add(s);
        this.scheduleFlush();
        throw e;
      } finally {
        for (const k of chunks) this.saving.delete(k);
        this.flushing = null;
      }
    })();
    await this.flushing;
  }

  // ---------------------------------------------------------------- wallets

  auth(ws, a, address) {
    const now = Date.now();
    if (now - (a.authAt ?? 0) < AUTH_EVERY_MS) return this.send(ws, ["signinfail", "One sign-in every few seconds. Try again."]);
    const recent = (this.authByIp.get(a.ip) ?? []).filter((t) => now - t < 60_000);
    if (a.ip && recent.length >= 10) return this.send(ws, ["signinfail", "Too many sign-ins from here. Try again in a minute."]);
    if (typeof address !== "string" || !isAddress(address)) return this.send(ws, ["signinfail", "That isn't a wallet address."]);
    if (a.ip) this.authByIp.set(a.ip, [...recent, now]);
    a.authAt = now;
    a.pending = getAddress(address);
    a.nonce = randomHex(16);
    this.save(ws, a);
    this.send(ws, ["challenge", authMessage(a.pending, a.nonce)]);
  }
  async signIn(ws, a, signature) {
    const wallet = a.pending, nonce = a.nonce;
    if (!wallet || !nonce || typeof signature !== "string") return this.send(ws, ["signinfail", "Start the sign-in again."]);
    a.pending = a.nonce = null;
    this.save(ws, a);
    const ok = await verifyMessage({ address: wallet, message: authMessage(wallet, nonce), signature }).catch(() => false);
    if (!ok) return this.send(ws, ["signinfail", "That signature didn't match the wallet."]);
    const token = randomHex(32);
    await this.ctx.storage.put(`tok:${await sha256(token)}`, wallet);
    await this.signedIn(ws, a, wallet, token);
  }
  async resume(ws, a, address, token) {
    if (typeof address !== "string" || !isAddress(address) || typeof token !== "string" || !/^[0-9a-f]{64}$/.test(token)) return;
    const wallet = await this.ctx.storage.get(`tok:${await sha256(token)}`);
    if (wallet !== getAddress(address)) return this.send(ws, ["signinfail", "Sign in again to keep earning."]);
    await this.signedIn(ws, a, wallet, token);
  }
  async signedIn(ws, a, wallet, token) {
    // One earning connection per wallet: signing in here signs any other one out.
    for (const [w, o] of this.players()) {
      if (w === ws || o.wallet !== wallet) continue;
      o.wallet = null;
      this.rename(w, o);
      this.send(w, ["signinfail", "You signed in somewhere else, so earnings count there now."]);
    }
    a.wallet = wallet;
    a.suspect = Math.max(a.suspect ?? 0, Date.now() + SETTLE_MS);
    a.nick = (await this.ctx.storage.get(`name:${wallet}`))?.name ?? null;
    this.rename(ws, a);
    const [, l] = await this.ledger(wallet);
    this.send(ws, ["signedin", wallet, token, l.today, l.total, CAP, a.nick && nameShown(a.nick) ? a.nick : null]);
  }

  /// A voucher for the wallet's lifetime earnings, which MiningSites.claim pays (less what it has already paid).
  /// The ledger is written first, so a voucher never covers earnings that a restart could lose.
  async voucher(ws, a) {
    const env = this.env;
    if (!a.wallet) return this.send(ws, ["voucher", null, 0, null, "Sign in with your wallet first."]);
    if (!env.MINING_KEY || !env.MINING_ADDRESS || !env.CHAIN_ID) return this.send(ws, ["voucher", null, 0, null, "Converting to $MINE isn't open yet."]);
    await this.flush();
    const [, l] = await this.ledger(a.wallet);
    if (!l.total) return this.send(ws, ["voucher", null, 0, null, "Nothing earned yet: mine blocks and defeat monsters first."]);
    const total = centsToWei(l.total);
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
    const signature = await privateKeyToAccount(env.MINING_KEY).signTypedData({
      domain: { name: "MineWorldCraft Mining", version: "1", chainId: Number(env.CHAIN_ID), verifyingContract: env.MINING_ADDRESS },
      types: { Earnings: [{ name: "player", type: "address" }, { name: "total", type: "uint256" }, { name: "deadline", type: "uint64" }] },
      primaryType: "Earnings",
      message: { player: a.wallet, total, deadline },
    });
    this.send(ws, ["voucher", total.toString(), Number(deadline), signature]);
  }

  // ---------------------------------------------------------------- names

  /// A signed-in wallet picks a name (web/name-rules.js): first come, first served (any case), changed at most once a
  /// day. Storage: name:<wallet> = { name, changedAt }, taken:<lower case name> = wallet.
  async setName(ws, a, raw) {
    if (!a.wallet) return this.send(ws, ["err", "Sign in with your wallet (Mining Site panel) to pick a name."]);
    const r = cleanName(raw);
    if (r.error) return this.send(ws, ["err", r.error]);
    const S = this.ctx.storage, now = Date.now(), low = r.name.toLowerCase();
    const had = await S.get(`name:${a.wallet}`);
    if (had?.name === r.name) return this.send(ws, ["named", r.name]);
    if (had && now - had.changedAt < NAME_EVERY_MS) return this.send(ws, ["err", "You can change your name once a day."]);
    const owner = await S.get(`taken:${low}`);
    if (owner && owner !== a.wallet) return this.send(ws, ["err", "That name is taken. Pick another."]);
    if (had?.name && had.name.toLowerCase() !== low) await S.delete(`taken:${had.name.toLowerCase()}`);
    await S.put({ [`name:${a.wallet}`]: { name: r.name, changedAt: now }, [`taken:${low}`]: a.wallet });
    for (const [w, o] of this.players()) {
      if (o.wallet !== a.wallet) continue;
      o.nick = r.name;
      this.rename(w, o);
    }
    this.send(ws, ["named", r.name]);
  }

  // ---------------------------------------------------------------- voice chat
  // Players talk to each other directly (WebRTC); the room only passes the set-up messages between two players who
  // have both turned voice on and are near each other. No audio ever goes through the room.

  voice(ws, a, on) {
    a.voice = !!on;
    this.save(ws, a);
    this.everyone(["voice", a.id, a.voice ? 1 : 0], ws);
  }
  rtc(ws, a, to, data) {
    if (!a.voice || !Number.isInteger(to) || data === null || typeof data !== "object") return;
    if (!bucket(a, "rtcs", RTC_PER_MIN, RTC_PER_MIN / 60, 1, Date.now())) return;
    const target = this.players().find(([, o]) => o.id === to);
    if (!target || !target[1].voice) return;
    const o = target[1];
    if (Math.abs(wrapDelta(o.x - a.x)) > VOICE_RANGE || Math.abs(wrapDelta(o.z - a.z)) > VOICE_RANGE || Math.abs(o.y - a.y) > VOICE_RANGE) return;
    this.send(target[0], ["rtc", a.id, data]);
  }

  /// Wear a MineWorld Crafter (or null for the Rookie): only once the chain says the signed-in wallet owns it. Its
  /// traits come from the revealed seed (web/crafters.js, the same rules as the contract) and go to everyone.
  async wear(ws, a, tokenId) {
    const env = this.env;
    const now = Date.now();
    if (tokenId === null) {
      a.look = null;
      this.save(ws, a);
      return this.everyone(["look", a.id, null]);
    }
    if (!a.wallet || !env.CRAFTERS_ADDRESS || !env.CHAIN_RPC || !isInt(tokenId, 1, SUPPLY + 1) || now - (a.wearAt ?? 0) < 3000) return;
    a.wearAt = now;
    this.save(ws, a);
    const pub = createPublicClient({ transport: http(env.CHAIN_RPC) });
    const c = { address: env.CRAFTERS_ADDRESS, abi: CRAFTERS_ABI };
    if (!this.crafterSeed) {
      const seed = await pub.readContract({ ...c, functionName: "seed" });
      if (seed === 0n) return this.send(ws, ["err", "The Crafters aren't revealed yet."]);
      this.crafterSeed = seed;
    }
    const owner = await pub.readContract({ ...c, functionName: "ownerOf", args: [BigInt(tokenId)] });
    if (getAddress(owner) !== a.wallet) return this.send(ws, ["err", "That Crafter isn't in your wallet."]);
    a.look = packTraits(traitsOf(this.crafterSeed, tokenId, HASH));
    this.save(ws, a);
    this.everyone(["look", a.id, a.look]);
  }
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { headers: { "access-control-allow-origin": "*" } });
    if (url.pathname !== "/ws" && url.pathname !== "/count") return new Response("MineWorldCraft world server", { status: 404 });
    // The room limits connections per address; it only sees this header, which the Worker sets from Cloudflare's.
    const headers = new Headers(req.headers);
    headers.set("x-ip", req.headers.get("cf-connecting-ip") ?? "");
    return env.WORLD.get(env.WORLD.idFromName("world")).fetch(new Request(req, { headers }));
  },
};
