// MineWorldCraft's shared world. One Durable Object holds it: who's playing and where, every block anyone has broken
// or placed (the terrain itself comes from web/worldgen.js, so only edits are stored), the monsters it sends each
// player, chat, and the $MINE ledger.
//
// Earning is checked here, never trusted to the game: a broken block must really be there (the room runs the same
// world generator), within reach of where the player really is, outside the town, and no faster than the best
// pickaxe allows; blocks players placed pay nothing; monsters are spawned by the room and their hits come no faster
// and no harder than the best sword's. Each wallet earns at most DAILY_EARN_CAP a UTC day. A player signs in once
// with their wallet (a free signature), and the room signs vouchers for their lifetime total, which MiningSites pays
// out on-chain to wallets with an open mining site.
//
// Runs on Cloudflare's free plan: WebSockets hibernate, pings are answered without waking the room, and writes are
// batched (edits per chunk, the ledger in 16 shards) every FLUSH_MS.

import { DurableObject } from "cloudflare:workers";
import { verifyMessage, isAddress, getAddress, createPublicClient, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { BLOCKS, AIR, WATER, BEDROCK, fastestBreak, BEST_DAMAGE } from "../../web/blocks.js";
import { naturalBlock, index as blockIndex } from "../../web/worldgen.js";
import {
  WORLD, CHUNK, HEIGHT, SPAWN, TOWN, PROTECT_R, ROOM_REACH, ROOM_ATTACK_MS, protectedAt, isNight,
  MOBS, MOBS_PER_PLAYER, MOB_EVERY_MS, MOB_LIFE_MS, UNDERGROUND_Y,
} from "../../web/rules.js";
import { BLOCK_REWARDS, MOB_REWARDS, DAILY_EARN_CAP, toCents, centsToWei } from "../../web/rewards.js";
import { cleanChat, CHAT_EVERY_MS } from "../../web/chat-rules.js";

const MAX_PLAYERS = 150;
const MAX_MSG = 4096;
const NEAR = 96; // blocks: positions and block changes go to players this close
const FLUSH_MS = 30_000;
const BREAK_CREDIT = 2.5; // seconds of breaking a player can bank (network bursts)
const PLACE_PER_S = 8;
const CHUNKS = WORLD / CHUNK;
const DAY_MS = 86_400_000;
const CAP = toCents(DAILY_EARN_CAP);
const CACHE_CHUNKS = 800;

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
const MINERS_ABI = parseAbi(["function ownerOf(uint256) view returns (address)", "function designOf(uint256) view returns (uint256)"]);

export class World extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
    this.atts = new Map(); // ws -> attachment, as last saved
    this.edits = new Map(); // chunk key -> Map(index -> block)
    this.dirtyChunks = new Set();
    this.shards = new Map(); // "0".."f" -> { wallet: { total, day, today } }
    this.dirtyShards = new Set();
    this.flushTimer = null;
    this.nextId = null;
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
  /// To every player within NEAR blocks of (x, z), except `skip`.
  near(x, z, msg, skip) {
    const s = JSON.stringify(msg);
    for (const [ws, a] of this.players()) {
      if (ws === skip) continue;
      if (Math.abs(a.x - x) > NEAR || Math.abs(a.z - z) > NEAR) continue;
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
    if (this.ctx.getWebSockets().length >= MAX_PLAYERS) return new Response("The world is full", { status: 503 });
    if (this.nextId === null) this.nextId = Math.max(0, ...this.ctx.getWebSockets().map((w) => this.att(w).id ?? 0)) + 1;
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    const a = { id: this.nextId++, name: "", wallet: null, design: null, x: SPAWN.x, y: SPAWN.y, z: SPAWN.z, yaw: 0, ready: false, mobs: [], mobSeq: 0 };
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
        case "p": return this.position(ws, a, m);
        case "chunks": return await this.chunks(ws, m[1]);
        case "break": return await this.breakBlock(ws, a, m[1], m[2], m[3]);
        case "place": return await this.place(ws, a, m[1], m[2], m[3], m[4]);
        case "hit": return await this.hit(ws, a, m[1], m[2]);
        case "act": if (a.ready) this.near(a.x, a.z, ["act", a.id, m[1] ? 1 : 0], ws); return;
        case "respawn": a.x = SPAWN.x; a.y = SPAWN.y; a.z = SPAWN.z; a.pAt = Date.now(); a.mobs = []; this.save(ws, a); return;
        case "chat": return this.chat(ws, a, m[1]);
        case "auth": return this.auth(ws, a, m[1]);
        case "signin": return await this.signIn(ws, a, m[1]);
        case "resume": return await this.resume(ws, a, m[1], m[2]);
        case "signout": a.wallet = null; this.rename(ws, a); return;
        case "voucher": return await this.voucher(ws, a);
        case "design": return await this.design(ws, a, m[1]);
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
    const list = this.players().filter(([w]) => w !== ws).map(([, o]) => [o.id, o.name, o.design, o.x, o.y, o.z, o.yaw]);
    this.send(ws, ["welcome", a.id, Date.now(), list, list.length + 1]);
    this.everyone(["join", a.id, a.name, a.design, a.x, a.y, a.z, a.yaw], ws);
  }
  rename(ws, a) {
    a.name = a.wallet ? short(a.wallet) : `Guest-${a.id}`;
    this.save(ws, a);
    if (a.ready) this.everyone(["join", a.id, a.name, a.design, a.x, a.y, a.z, a.yaw], ws);
  }

  position(ws, a, m) {
    if (!a.ready) return;
    const [, x, y, z, yaw, pitch] = m;
    if (![x, y, z, yaw].every(num) || x < -2 || z < -2 || x > WORLD + 2 || z > WORLD + 2 || y < -10 || y > HEIGHT + 20) return;
    const now = Date.now();
    // A player moving faster than anyone can (teleporting) earns nothing for a while.
    const dt = Math.max(0.05, (now - (a.pAt ?? now)) / 1000);
    if (Math.hypot(x - a.x, z - a.z) / dt > 40 && a.pAt) a.suspect = now + 15_000;
    a.x = x; a.y = y; a.z = z; a.yaw = yaw; a.pAt = now;
    this.near(x, z, ["p", a.id, x, y, z, yaw, num(pitch) ? pitch : 0], ws);
    this.maybeMob(ws, a, now);
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
    const raw = await this.ctx.storage.get(`c:${key}`);
    e = this.edits.get(key); // (filled by another message meanwhile)
    if (e) return e;
    e = new Map();
    if (raw) for (let i = 0; i + 2 < raw.length; i += 3) e.set(raw[i] | (raw[i + 1] << 8), raw[i + 2]);
    this.edits.set(key, e);
    if (this.edits.size > CACHE_CHUNKS) {
      for (const k of this.edits.keys()) {
        if (this.edits.size <= CACHE_CHUNKS * 0.8) break;
        if (!this.dirtyChunks.has(k) && k !== key) this.edits.delete(k);
      }
    }
    return e;
  }

  async chunks(ws, keys) {
    if (!Array.isArray(keys)) return;
    for (const k of keys.slice(0, 48)) {
      if (typeof k !== "string" || !/^\d{1,2},\d{1,2}$/.test(k)) continue;
      const [cx, cz] = k.split(",").map(Number);
      if (cx >= CHUNKS || cz >= CHUNKS) continue;
      const e = await this.chunkEdits(k);
      this.send(ws, ["edits", k, [...e]]);
    }
  }

  /// The block at (x, y, z) now, and whether a player put it there.
  async blockAt(x, y, z) {
    const key = `${Math.floor(x / CHUNK)},${Math.floor(z / CHUNK)}`;
    const e = await this.chunkEdits(key);
    const i = blockIndex(x % CHUNK, y, z % CHUNK);
    const placed = e.has(i);
    return { key, e, i, placed, block: placed ? e.get(i) : naturalBlock(x, y, z) };
  }
  setBlock(at, b, x, y, z, ws) {
    at.e.set(at.i, b);
    this.dirtyChunks.add(at.key);
    this.scheduleFlush();
    this.near(x, z, ["set", x, y, z, b], ws);
  }
  inReach(a, x, y, z) {
    return Math.hypot(x + 0.5 - a.x, y + 0.5 - (a.y + 1.62), z + 0.5 - a.z) <= ROOM_REACH;
  }

  async breakBlock(ws, a, x, y, z) {
    if (!a.ready || !isInt(x, 0, WORLD) || !isInt(z, 0, WORLD) || !isInt(y, 1, HEIGHT)) return;
    const at = await this.blockAt(x, y, z);
    const cur = at.block;
    const undo = () => this.send(ws, ["set", x, y, z, cur]);
    if (cur === AIR || cur === WATER || cur === BEDROCK || protectedAt(x, z) || !this.inReach(a, x, y, z)) return undo();
    // Breaking takes time: a player banks up to BREAK_CREDIT seconds and each block costs what the best pickaxe needs.
    const now = Date.now();
    a.credit = Math.min(BREAK_CREDIT, (a.credit ?? BREAK_CREDIT) + (now - (a.creditAt ?? now)) / 1000);
    a.creditAt = now;
    const cost = fastestBreak(cur) * 0.85;
    if (a.credit < cost) { this.save(ws, a); return undo(); }
    a.credit -= cost;
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
    if (!BLOCKS[b]?.placeable || (cur !== AIR && cur !== WATER) || protectedAt(x, z) || !this.inReach(a, x, y, z)) return undo();
    const now = Date.now();
    a.pcredit = Math.min(PLACE_PER_S, (a.pcredit ?? PLACE_PER_S) + ((now - (a.pcreditAt ?? now)) / 1000) * PLACE_PER_S);
    a.pcreditAt = now;
    if (a.pcredit < 1) { this.save(ws, a); return undo(); }
    a.pcredit -= 1;
    this.setBlock(at, b, x, y, z, ws);
    this.save(ws, a);
  }

  // ---------------------------------------------------------------- monsters

  maybeMob(ws, a, now) {
    a.mobs = (a.mobs ?? []).filter((m) => now - m.at < MOB_LIFE_MS);
    if (a.mobs.length >= MOBS_PER_PLAYER || now < (a.nextMob ?? 0)) return;
    const under = a.y < UNDERGROUND_Y;
    if (!under && !isNight(now)) return;
    if (Math.hypot(a.x - TOWN.x, a.z - TOWN.z) < PROTECT_R + 16) return;
    const r = Math.random();
    const kind = under && a.y < 30 && r < 0.2 ? "golem" : r < 0.45 ? "mudling" : r < 0.75 ? "rattler" : "crawler";
    const ang = Math.random() * Math.PI * 2, d = 10 + Math.random() * 6;
    const mob = { i: ++a.mobSeq, k: kind, x: Math.round(a.x + Math.cos(ang) * d), y: Math.round(a.y), z: Math.round(a.z + Math.sin(ang) * d), hp: MOBS[kind].hp, at: now };
    a.mobs.push(mob);
    a.nextMob = now + MOB_EVERY_MS * (0.8 + Math.random() * 0.4);
    this.send(ws, ["mob", mob.i, kind, mob.x, mob.y, mob.z]);
  }

  async hit(ws, a, mobId, damage) {
    const now = Date.now();
    const m = (a.mobs ?? []).find((o) => o.i === mobId);
    if (!m || now - (a.lastHit ?? 0) < ROOM_ATTACK_MS || now - m.at < 600) return;
    // The monster can't have gone further than its speed allows since it came, nor the player be out of reach of it.
    const reach = 16 + MOBS[m.k].speed * ((now - m.at) / 1000) + ROOM_REACH;
    if (Math.hypot(a.x - m.x, a.z - m.z) > reach) return;
    a.lastHit = now;
    m.hp -= Math.max(1, Math.min(BEST_DAMAGE, Math.floor(Number(damage)) || 1));
    if (m.hp <= 0) {
      a.mobs = a.mobs.filter((o) => o !== m);
      this.send(ws, ["mobdead", m.i]);
      if (a.wallet && !(a.suspect > now)) await this.credit(ws, a, toCents(MOB_REWARDS[m.k] ?? 0), m.k);
    }
    this.save(ws, a);
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
    // Every tab of the same wallet sees the new totals.
    for (const [w, o] of this.players()) if (o.wallet === a.wallet) this.send(w, w === ws ? ["earn", c, l.today, l.total, what] : ["ledger", l.today, l.total, CAP]);
  }

  scheduleFlush() {
    // A pending timer also keeps the room from hibernating before its changes are written.
    this.flushTimer ??= setTimeout(() => this.flush().catch((e) => console.log("flush failed", e?.message ?? e)), FLUSH_MS);
  }
  async flush() {
    this.flushTimer = null;
    const out = {};
    for (const k of this.dirtyChunks) {
      const e = this.edits.get(k);
      if (!e) continue;
      const raw = new Uint8Array(e.size * 3);
      let j = 0;
      for (const [i, b] of e) { raw[j++] = i & 255; raw[j++] = i >> 8; raw[j++] = b; }
      out[`c:${k}`] = raw;
    }
    for (const s of this.dirtyShards) out[`led:${s}`] = this.shards.get(s);
    this.dirtyChunks.clear();
    this.dirtyShards.clear();
    const keys = Object.keys(out);
    for (let i = 0; i < keys.length; i += 128) {
      await this.ctx.storage.put(Object.fromEntries(keys.slice(i, i + 128).map((k) => [k, out[k]])));
    }
  }

  // ---------------------------------------------------------------- wallets

  auth(ws, a, address) {
    if (typeof address !== "string" || !isAddress(address)) return this.send(ws, ["signinfail", "That isn't a wallet address."]);
    a.pending = getAddress(address);
    a.nonce = randomHex(16);
    this.save(ws, a);
    this.send(ws, ["challenge", authMessage(a.pending, a.nonce)]);
  }
  async signIn(ws, a, signature) {
    if (!a.pending || !a.nonce || typeof signature !== "string") return this.send(ws, ["signinfail", "Start the sign-in again."]);
    const ok = await verifyMessage({ address: a.pending, message: authMessage(a.pending, a.nonce), signature }).catch(() => false);
    const wallet = a.pending;
    a.pending = a.nonce = null;
    if (!ok) { this.save(ws, a); return this.send(ws, ["signinfail", "That signature didn't match the wallet."]); }
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
    a.wallet = wallet;
    this.rename(ws, a);
    const [, l] = await this.ledger(wallet);
    this.send(ws, ["signedin", wallet, token, l.today, l.total, CAP]);
  }

  /// A voucher for the wallet's lifetime earnings, which MiningSites.claim pays (less what it has already paid).
  async voucher(ws, a) {
    const env = this.env;
    if (!a.wallet) return this.send(ws, ["voucher", null, 0, null, "Sign in with your wallet first."]);
    if (!env.MINING_KEY || !env.MINING_ADDRESS || !env.CHAIN_ID) return this.send(ws, ["voucher", null, 0, null, "Converting to $MINE isn't open yet."]);
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

  /// Wear a Miner: only once the chain says the signed-in wallet owns that token.
  async design(ws, a, tokenId) {
    const env = this.env;
    const now = Date.now();
    if (tokenId === null) { a.design = null; this.save(ws, a); return this.everyone(["look", a.id, null]); }
    if (!a.wallet || !env.MINERS_ADDRESS || !env.CHAIN_RPC || !isInt(tokenId, 1, 1000) || now - (a.designAt ?? 0) < 5000) return;
    a.designAt = now;
    const pub = createPublicClient({ transport: http(env.CHAIN_RPC) });
    const c = { address: env.MINERS_ADDRESS, abi: MINERS_ABI };
    const [owner, design] = await Promise.all([
      pub.readContract({ ...c, functionName: "ownerOf", args: [BigInt(tokenId)] }),
      pub.readContract({ ...c, functionName: "designOf", args: [BigInt(tokenId)] }),
    ]);
    if (getAddress(owner) !== a.wallet) return this.send(ws, ["err", "That Miner isn't in your wallet."]);
    a.design = Number(design);
    this.save(ws, a);
    this.everyone(["look", a.id, a.design]);
  }
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { headers: { "access-control-allow-origin": "*" } });
    if (url.pathname !== "/ws" && url.pathname !== "/count") return new Response("MineWorldCraft world server", { status: 404 });
    return env.WORLD.get(env.WORLD.idFromName("world")).fetch(req);
  },
};
