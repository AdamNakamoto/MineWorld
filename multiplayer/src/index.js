// MineWorldCraft's shared world. One Durable Object holds it: who's playing and where, every block anyone has broken
// or placed (the terrain itself comes from web/worldgen.js, so only edits are stored), the monsters it sends each
// player, chat, the MineWorld Crafter each player wears, and the $MINE ledger.
//
// Earning is checked here, never trusted to the game: a broken block must really be there (the room runs the same
// world generator), have an open side, be within reach of where the player really is (and the player not inside
// rock), outside the town, and broken no faster than the best pickaxe allows; blocks players placed pay nothing;
// monsters are spawned by the room and their hits come no faster and no harder than the best sword's. A player who
// moves faster than anyone can, or has just (re)connected, earns nothing for a few seconds. Each wallet earns at most
// DAILY_EARN_CAP a UTC day, from one connection at a time, and everyone together at most WORLD_DAILY_CAP. A player
// signs in once with their wallet (a free signature), and the room signs vouchers for their lifetime total, which
// MiningSites pays out on-chain to wallets with an open mining site. The ledger counts ten-thousandths of a $MINE
// (rewards.js UNIT); vouchers are in wei.
//
// NFT boosts (web/boosts.js): the NFTs a signed-in player uses (their Crafter, and later a skin, a companion, an aura
// and a vehicle) make their blocks break faster (allowed for in the break-rate check), make everything they earn pay
// more and raise their daily cap. The room works each player's boost out from the chain (ownerOf, the Crafter's rarity
// and CrafterLevels' level) when they sign in, wear or equip, checks it again every few minutes while they earn, and
// tells the game. Guests get none.
//
// Runs on Cloudflare's free plan: WebSockets hibernate, pings are answered without waking the room, and writes are
// batched (edits per chunk, the ledger in 16 shards) every FLUSH_MS.
//
// The world is a small planet that wraps round in x and z (rules.js): positions are kept in 0..WORLD, and every
// distance (reach, who's near, voice, monsters, the speed check) is measured the short way round.
//
// The rocket flies between planets (web/zones.js): the home planet and three zones, each its own world. Every player
// is on one of them (the attachment's `zone`): positions, block changes, monsters, block checks (naturalBlock for
// that zone), voice set-up and who joined or left go only to players on the same one; chat goes everywhere. Edits are
// stored per zone (Deepvein's per week, so it grows back every Monday), earnings are multiplied by the zone's rate
// (rewards.js ZONE_PAY). Cinderfall's boss lives here: its health, its moves (picked here, animated by every game from
// the same start time, so nothing is sent while it moves), the checked hits on it and the pool it pays. In Red Mesa,
// players can hit each other: each hit is checked here and passed to the one hit.
//
// Knock-outs (web/zones.js CHEST_MS): whatever knocks a player out, their game reports it with what they carried, and
// the room leaves it in a loot chest where they fell, on that planet, for CHEST_MS: the first player there to open it
// takes it all (the one who fell too). One chest per knock-out, one open chest per player (a new one replaces the
// old), and only from a player who is up (they're down until they respawn or revive). Knocked out in a zone, the room
// sends them home at once (their chest stays in the zone). Knocked out at home, they respawn in town, or revive where
// they fell: free before launch (and while REVIVE_FREE), otherwise paid in $MINE (REVIVE_PRICE, MinePayments kind 2),
// checked here as a ticket is (revive).
//
// Rocket tickets (unless zones.js TICKETS_FREE): a signed-in player pays a zone's `ticket` in $MINE on-chain
// (MinePayments.pay, kind 1, from their own wallet) and sends the transaction's hash; the room reads its receipt and,
// if the payment checks out (see buyTicket), keeps one ticket to that zone for the wallet, used up by its next trip
// out there. Each payment buys one ticket, once.

import { DurableObject } from "cloudflare:workers";
import {
  verifyMessage, isAddress, getAddress, createPublicClient, http, parseAbi, parseEventLogs, keccak256,
  encodeAbiParameters, BaseError, ContractFunctionRevertedError,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { BLOCKS, AIR, WATER, BEDROCK, fastestBreak, BEST_DAMAGE, itemName, stackSize, maxDurability, damageable } from "../../web/blocks.js";
import { naturalBlock, index as blockIndex } from "../../web/worldgen.js";
import {
  WORLD, CHUNK, HEIGHT, ROOM_REACH, isNight, MOBS, MOB_LIFE_MS, UNDERGROUND_Y, wrap, wrapDelta, wrapDist,
} from "../../web/rules.js";
import {
  BLOCK_REWARDS, MOB_REWARDS, WORLD_DAILY_CAP, ZONE_PAY, BOSS_POOL, UNIT, toUnits, unitsToWei, fmtMine,
} from "../../web/rewards.js";
import { SLOTS, isSlot, boostOf, NO_BOOST, dailyCap, withEarn, withSpeed, packBoost } from "../../web/boosts.js";
import {
  isZone, zoneOf, landing, spawnOf, onPad, protectedIn, calmAt, weekOf, ARENA, BOSS, bossAt, PVP, TICKETS_FREE,
  CHEST_MS, CHEST_REACH, CHEST_STACKS, REVIVE_PRICE, REVIVE_KIND, REVIVE_FREE,
} from "../../web/zones.js";
import { cleanChat, CHAT_EVERY_MS } from "../../web/chat-rules.js";
import { traitsOf, packTraits, rarityOf, SUPPLY } from "../../web/degen-skin.js";
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
const WORLD_CAP = toUnits(WORLD_DAILY_CAP);
// The ledger's shards are stored as `${LEDGER}${shard}` and today's world total as WORLD_DAY, in units (rewards.js
// UNIT). Before boosts they counted hundredths of a $MINE under "led:" and "worldday": those are read once, converted
// (x100, so every total stays the same in wei and vouchers stay as they were), written under the new keys and deleted.
const LEDGER = "led2:", WORLD_DAY = "worldday2";
// Before launch (no MINING_ADDRESS: $MINE isn't on-chain yet) the room keeps a practice ledger under its own keys:
// players see what they'd earn, but it's never paid. Setting MINING_ADDRESS at launch switches to the real ledger,
// which starts empty, so practice earnings are reset (they're never converted, and can be deleted later).
const PRACTICE_LEDGER = "prac:", PRACTICE_WORLD_DAY = "pracday";
const OLD_LEDGER = "led:", OLD_WORLD_DAY = "worldday", FROM_CENTS = UNIT / 100;
const BOOST_RECHECK_MS = 10 * 60_000; // what a player uses is checked again on-chain this often while they earn
const BOOST_RETRY_MS = 60_000; // and this soon after a read failed
const CACHE_CHUNKS = 800;
// Chunk edits are stored as `${EDITS}${cx},${cz}`. The 1024-wide world's edits ("c:") belong to a world that's gone,
// so the planet's have their own prefix and those are never read.
const EDITS = "c2:";
const VOICE_RANGE = 64; // blocks: voice connections are only set up between players this close
const RTC_PER_MIN = 240; // voice set-up messages a connection may send a minute
const FLIGHTS = 3, FLIGHT_EVERY_S = 5; // rocket flights a connection may make at once, and one more every few seconds
const PAY_AGE_S = 3 * 3600; // seconds: the oldest a ticket's or a revive's payment can be when it's sent here
const TICKET_KIND = 1n; // MinePayments' kind for rocket tickets ("ticket": all to the treasury)
const REVIVE_KIND_N = BigInt(REVIVE_KIND); // and for revives ("revive": all to the treasury too)
const DEATHS = 3, DEATH_EVERY_S = 20; // knock-outs that make a chest a connection may have at once, and one more this often
const MAX_CHESTS = 200; // loot chests kept at most, on all planets together (the oldest go first)
const DEATH_KEEP_MS = 30 * 60_000; // a wallet's last knock-out is remembered this long for a revive from a new connection
const RECHECKS = 2, RECHECK_EVERY_S = 15; // re-reads of a player's NFTs they may ask for at once, and one more this often

// The game's homes: its own domain (to be decided: add it here), Vercel previews and local development.
const ORIGINS = [/^https:\/\/(www\.)?mineworldcraft\.fun$/, /^https:\/\/mineworldcraft-mp\.[a-z0-9-]+\.workers\.dev$/, /^https:\/\/[a-z0-9-]+\.vercel\.app$/, /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/];

const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const authMessage = (address, nonce) =>
  `MineWorldCraft sign-in\n\nSign to count your $MINE earnings for this wallet. It's free and sends no transaction.\n\nWallet: ${address}\nSession: ${nonce}`;
const randomHex = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, "0")).join("");
async function sha256(s) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v < hi;
const xyz = (p) => ({ x: p.x, y: p.y, z: p.z });
const clampHit = (damage) => Math.max(1, Math.min(BEST_DAMAGE, Math.floor(Number(damage)) || 1));
const num = (v) => typeof v === "number" && Number.isFinite(v);
const CRAFTERS_ABI = parseAbi(["function ownerOf(uint256) view returns (address)", "function seed() view returns (uint256)"]);
const PAYMENTS_ABI = parseAbi(["event Paid(address indexed player, uint256 indexed kind, uint256 amount, uint256 burned, bytes32 indexed ref)"]);
const uintView = new Map(); // view name -> the ABI of `name(uint256) view returns (uint256)` (tierOf, levelOf...)
const viewAbi = (fn) => uintView.get(fn) ?? uintView.set(fn, parseAbi([`function ${fn}(uint256) view returns (uint256)`])).get(fn);
/// Whether a contract call failed because the contract said no (a token that doesn't exist), not the RPC.
const reverted = (e) => e instanceof BaseError && !!e.walk((x) => x instanceof ContractFunctionRevertedError);
/// The boost from what a player uses (`eq`: slot -> [tokenId, tier, level], as kept on the attachment).
const boostOfEq = (eq) => boostOf(Object.fromEntries(Object.entries(eq ?? {}).map(([slot, [, tier, level]]) => [slot, { tier, level }])));
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

/// What a knocked-out player's game says they carried, cleaned up: at most CHEST_STACKS stacks of [item, count, wear],
/// real items only, counts within a stack's size and wear within the item's durability. (Inventories live in the
/// browser, so the items are the game's own report; this only keeps them well-formed.)
function cleanItems(items) {
  const out = [];
  for (const s of Array.isArray(items) ? items : []) {
    if (out.length >= CHEST_STACKS || !Array.isArray(s)) break;
    const [id, n, d] = s;
    if (!isInt(id, 1, 256) || itemName(id) === "?" || id === WATER || id === BEDROCK || !isInt(n, 1, stackSize(id) + 1)) continue;
    out.push(damageable(id) ? [id, 1, isInt(d, 0, maxDurability(id)) ? d : 0] : [id, n]);
  }
  return out;
}

export class World extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
    this.practice = !env.MINING_ADDRESS; // before launch: a practice ledger, never paid (PRACTICE_LEDGER)
    this.ledgerKey = this.practice ? PRACTICE_LEDGER : LEDGER;
    this.worldDayKey = this.practice ? PRACTICE_WORLD_DAY : WORLD_DAY;
    this.atts = new Map(); // ws -> attachment, as last saved
    this.edits = new Map(); // chunk key -> Map(index -> block)
    this.dirtyChunks = new Set();
    this.saving = new Set(); // chunk keys being written right now (kept in the cache until they are)
    this.shards = new Map(); // "0".."f" -> { wallet: { total, day, today } } (in units, rewards.js UNIT)
    this.dirtyShards = new Set();
    this.oldKeys = new Set(); // the ledger's old keys (hundredths), deleted once their converted copies are written
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
  /// To every player on `zone` within `range` blocks of (x, z), except `skip`.
  near(zone, x, z, msg, skip, range = NEAR) {
    const s = JSON.stringify(msg);
    for (const [ws, a] of this.players()) {
      if (ws === skip || a.zone !== zone) continue;
      if (Math.abs(wrapDelta(a.x - x)) > range || Math.abs(wrapDelta(a.z - z)) > range) continue;
      try { ws.send(s); } catch {}
    }
  }
  everyone(msg, skip) {
    const s = JSON.stringify(msg);
    for (const [ws] of this.players()) if (ws !== skip) try { ws.send(s); } catch {}
  }
  /// The players on `zone`.
  onZone(zone) {
    return this.players().filter(([, a]) => a.zone === zone);
  }
  /// To every player on `zone`, except `skip`.
  zoneCast(zone, msg, skip) {
    const s = JSON.stringify(msg);
    for (const [ws] of this.onZone(zone)) if (ws !== skip) try { ws.send(s); } catch {}
  }
  /// How a player is shown to others: [id, name, look, x, y, z, yaw, gear] (gear: armor tiers, then the item in hand).
  shown(a) {
    return [a.id, a.name, a.look, a.x, a.y, a.z, a.yaw, a.gear ?? null];
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
    // `eq`: the NFTs this player uses, slot -> [tokenId, tier, level] (boosts.js), as checked on-chain; `local`: the
    // connection came to wrangler dev on this machine (the dev hooks need it).
    const a = {
      id: this.nextId++, name: "", ip, wallet: null, look: null, zone: "home", ...xyz(spawnOf("home")), yaw: 0, ready: false,
      mobs: [], mobSeq: 0, credit: 0, creditAt: now, suspect: now + SETTLE_MS, eq: {},
      local: /^(localhost|127\.0\.0\.1|\[::1\])$/.test(url.hostname),
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
        case "hello": return await this.hello(ws, a, m[1]);
        case "zone": return await this.fly(ws, a, m[1]);
        case "p": return await this.position(ws, a, m);
        case "chunks": return await this.chunks(ws, a, m[1]);
        case "break": return await this.breakBlock(ws, a, m[1], m[2], m[3]);
        case "place": return await this.place(ws, a, m[1], m[2], m[3], m[4]);
        case "hit": return await this.hit(ws, a, m[1], m[2]);
        case "gone": return this.gone(ws, a, m[1]);
        case "act": if (a.ready) this.near(a.zone, a.x, a.z, ["act", a.id, m[1] ? 1 : 0], ws); return;
        case "respawn": return this.respawn(ws, a);
        case "bosshit": return await this.bossHit(ws, a, m[1]);
        case "pvp": return this.pvpHit(ws, a, m[1], m[2]);
        case "dead": return await this.died(ws, a, m[1], m[2], m[3], m[4], m[5]);
        case "pvpdead": return await this.died(ws, a, m[2], null, null, null, m[1]); // (a game from before: ["pvpdead", killer, stacks])
        case "revive": return await this.revive(ws, a, m[1]);
        case "loot": return await this.loot(ws, a, m[1]);
        case "chat": return this.chat(ws, a, m[1]);
        case "auth": return this.auth(ws, a, m[1]);
        case "signin": return await this.signIn(ws, a, m[1]);
        case "resume": return await this.resume(ws, a, m[1], m[2]);
        case "signout": a.wallet = null; a.nick = null; a.eq = {}; this.rename(ws, a); return;
        case "voucher": return await this.voucher(ws, a);
        case "wear": return await this.wear(ws, a, m[1]);
        case "equip": return await this.equip(ws, a, m[1], m[2]);
        case "recheck": return await this.recheckNow(ws, a);
        case "ticket": return await this.buyTicket(ws, a, m[1], m[2]);
        case "dev": return await this.dev(ws, a, m[1], m[2]);
        case "gear": return this.gear(ws, a, m[1]);
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
    if (a.ready) {
      this.zoneCast(a.zone, ["leave", a.id], ws);
      this.everyone(["count", this.players().filter(([w]) => w !== ws).length], ws);
    }
    try { ws.close(1000, "bye"); } catch {}
  }

  /// A game joins (or rejoins after a dropped connection). Where it starts is the room's call: home, or, while trips
  /// are free (zones.js TICKETS_FREE), the planet the game says it's on (`info.zone`). A wallet's own zone is
  /// remembered here and it's put back there when it signs in (signedIn), tickets or not.
  async hello(ws, a, info) {
    if (a.ready) return;
    const zone = isZone(info?.zone) && (info.zone === "home" || this.ticketsFree()) ? info.zone : "home";
    if (zone !== a.zone) this.arrive(a, zone, Date.now());
    a.ready = true;
    this.save(ws, a);
    const here = this.onZone(a.zone).filter(([w]) => w !== ws);
    const total = this.players().length;
    this.send(ws, ["welcome", a.id, Date.now(), here.map(([, o]) => this.shown(o)), total, a.zone,
      { practice: this.practice, ticketsFree: this.ticketsFree(), reviveFree: this.reviveFree() }]);
    const voices = this.players().filter(([w, o]) => w !== ws && o.voice).map(([, o]) => o.id);
    if (voices.length) this.send(ws, ["voices", voices]);
    this.zoneCast(a.zone, ["join", ...this.shown(a)], ws);
    this.everyone(["count", total], ws);
    await this.zoneNews(ws, a);
  }
  /// A new name or look: the others on the same planet redraw them.
  rename(ws, a) {
    a.name = a.wallet ? (a.nick && nameShown(a.nick) ? a.nick : short(a.wallet)) : `Guest-${a.id}`;
    this.save(ws, a);
    if (a.ready) this.zoneCast(a.zone, ["join", ...this.shown(a)], ws);
  }

  /// ["p", x, y, z, yaw, pitch, flags]: where a player is, passed on to those near (flags: web/net.js SNEAKING; a
  /// game from before sends none).
  async position(ws, a, m) {
    if (!a.ready) return;
    const [, x, y, z, yaw, pitch, flags] = m;
    if (![x, y, z, yaw].every(num) || x < 0 || z < 0 || x >= WORLD || z >= WORLD || y < 0 || y > HEIGHT + 20) return;
    const now = Date.now();
    // A player moving faster than anyone can (a teleport) earns nothing for a while. Idle time can't be banked:
    // whatever the gap, a single update may cover at most a second's worth. Falling is fast; climbing isn't.
    // (Walking over the seam, from 511 to 0, is a step, not a leap.)
    const dt = Math.min(1, Math.max(0.05, (now - (a.pAt ?? now)) / 1000));
    const dy = y - a.y;
    if (wrapDist(x, z, a.x, a.z) / dt > 40 || dy / dt > 20 || -dy / dt > 80) a.suspect = now + SETTLE_MS;
    a.x = x; a.y = y; a.z = z; a.yaw = yaw; a.pAt = now;
    this.near(a.zone, x, z, ["p", a.id, x, y, z, yaw, num(pitch) ? pitch : 0, isInt(flags, 0, 256) ? flags : 0], ws);
    // Deepvein grows back on Mondays: anyone there when the week turns gets the new week's world.
    if (zoneOf(a.zone).weekly && a.week !== weekOf(now)) {
      a.week = weekOf(now);
      this.send(ws, ["regrow", a.zone]);
    }
    if (a.zone === "boss") {
      if (wrapDist(x, z, ARENA.x, ARENA.z) < BOSS.engage) await this.bossWake(now);
      else this.bossTidy(now); // (back after its rest, even if nobody's at the arena yet)
    }
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

  /// Where zone `zone`'s chunk edits are stored: home's as they always were, each zone under its own prefix, and a
  /// weekly zone's under that week's (so it starts afresh every Monday; the weeks before are cleared out).
  editPrefix(zone, now = Date.now()) {
    if (zone === "home") return EDITS;
    if (!zoneOf(zone).weekly) return `z${zone}:`;
    const prefix = `z${zone}${weekOf(now)}:`;
    if (this.cleaned?.[zone] !== prefix) this.clearOldWeeks(zone, prefix).catch((e) => console.log("clearing old weeks failed", e?.message ?? e));
    return prefix;
  }
  async clearOldWeeks(zone, prefix) {
    (this.cleaned ??= {})[zone] = prefix;
    const old = [...(await this.ctx.storage.list({ prefix: `z${zone}`, limit: 2048 })).keys()].filter((k) => !k.startsWith(prefix));
    for (let i = 0; i < old.length; i += 128) await this.ctx.storage.delete(old.slice(i, i + 128));
    for (const k of [...this.edits.keys()]) {
      if (k.startsWith(`z${zone}`) && !k.startsWith(prefix) && !this.dirtyChunks.has(k) && !this.saving.has(k)) this.edits.delete(k);
    }
  }

  /// A chunk's edits, by its storage key (editPrefix + "cx,cz").
  async chunkEdits(key) {
    let e = this.edits.get(key);
    if (e) return e;
    const raw = await this.ctx.storage.get(key);
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
    if (!Array.isArray(keys) || !a.ready) return;
    const seen = new Set(), prefix = this.editPrefix(a.zone);
    for (const k of keys.slice(0, 48)) {
      if (typeof k !== "string" || !/^\d{1,2},\d{1,2}$/.test(k)) continue;
      const [cx, cz] = k.split(",").map(Number);
      const key = `${cx},${cz}`; // the one spelling, so "01,5" can't dodge the cache
      if (cx >= CHUNKS || cz >= CHUNKS || seen.has(key)) continue;
      seen.add(key);
      if (!bucket(a, "keys", CHUNK_KEYS_PER_MIN, CHUNK_KEYS_PER_MIN / 60, 1, Date.now())) break;
      const e = await this.chunkEdits(prefix + key);
      this.send(ws, ["edits", key, [...e], a.zone]);
    }
    this.save(ws, a);
  }

  /// The block at (x, y, z) on `zone` now, and whether a player put it there. x and z wrap round (a neighbour of
  /// x = 0 is 511).
  async blockAt(zone, x, y, z) {
    if (!Number.isInteger(x) || !Number.isInteger(z) || y < 0 || y >= HEIGHT) return { block: y < 0 ? BEDROCK : AIR, placed: false };
    x = wrap(x);
    z = wrap(z);
    const key = `${this.editPrefix(zone)}${Math.floor(x / CHUNK)},${Math.floor(z / CHUNK)}`;
    const e = await this.chunkEdits(key);
    const i = blockIndex(x % CHUNK, y, z % CHUNK);
    const placed = e.has(i);
    return { key, e, i, placed, block: placed ? e.get(i) : naturalBlock(x, y, z, zone) };
  }
  async solidAt(zone, x, y, z) {
    return !!BLOCKS[(await this.blockAt(zone, x, y, z)).block]?.solid;
  }
  /// Whether a player could stand where they say: their feet and head are not inside solid blocks.
  async standing(a) {
    const x = Math.floor(a.x), y = Math.floor(a.y), z = Math.floor(a.z);
    return !(await this.solidAt(a.zone, x, y, z)) && !(await this.solidAt(a.zone, x, y + 1, z));
  }
  /// Whether a block has a side open to air or water (anything else couldn't have been reached).
  async exposed(zone, x, y, z) {
    for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
      if (!(await this.solidAt(zone, x + dx, y + dy, z + dz))) return true;
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
  setBlock(zone, at, b, x, y, z, ws) {
    at.e.set(at.i, b);
    this.dirtyChunks.add(at.key);
    this.scheduleFlush();
    this.near(zone, x, z, ["set", x, y, z, b], ws, NEAR_EDITS);
  }
  inReach(a, x, y, z) {
    return Math.hypot(wrapDelta(x + 0.5 - a.x), y + 0.5 - (a.y + 1.62), wrapDelta(z + 0.5 - a.z)) <= ROOM_REACH;
  }

  async breakBlock(ws, a, x, y, z) {
    if (!a.ready || !isInt(x, 0, WORLD) || !isInt(z, 0, WORLD) || !isInt(y, 1, HEIGHT)) return;
    const zone = a.zone;
    const at = await this.blockAt(zone, x, y, z);
    const cur = at.block;
    const undo = () => this.send(ws, ["set", x, y, z, cur]);
    const now = Date.now();
    if (cur === AIR || cur === WATER || cur === BEDROCK || protectedIn(zone, x, z) || !this.inReach(a, x, y, z)) return undo();
    if (!(await this.exposed(zone, x, y, z)) || !(await this.standing(a)) || !this.editAllowed(a, at.key, now)) { this.save(ws, a); return undo(); }
    // Breaking takes time: a player banks up to BREAK_CREDIT seconds and each block costs what the best pickaxe needs,
    // less their NFT speed boost (boosts.js: a +50% miner breaks in two thirds of the time).
    const cost = withSpeed(fastestBreak(cur), this.boost(a).speed) * 0.85;
    if (!bucket(a, "credit", BREAK_CREDIT, 1, cost, now)) { this.save(ws, a); return undo(); }
    this.setBlock(zone, at, AIR, x, y, z, ws);
    const reward = BLOCK_REWARDS[cur];
    if (!at.placed && reward && a.wallet && !(a.suspect > now)) await this.earn(ws, a, reward, cur);
    this.save(ws, a);
  }

  async place(ws, a, x, y, z, b) {
    if (!a.ready || !isInt(x, 0, WORLD) || !isInt(z, 0, WORLD) || !isInt(y, 1, HEIGHT) || !isInt(b, 1, 64)) return;
    const zone = a.zone;
    const at = await this.blockAt(zone, x, y, z);
    const cur = at.block;
    const undo = () => this.send(ws, ["set", x, y, z, cur]);
    const now = Date.now();
    if (!BLOCKS[b]?.placeable || (cur !== AIR && cur !== WATER && !BLOCKS[cur]?.plant) || protectedIn(zone, x, z) || !this.inReach(a, x, y, z)) return undo();
    if (!this.editAllowed(a, at.key, now) || !bucket(a, "pcredit", PLACE_PER_S, PLACE_PER_S, 1, now)) { this.save(ws, a); return undo(); }
    this.setBlock(zone, at, b, x, y, z, ws);
    this.save(ws, a);
  }

  // ---------------------------------------------------------------- monsters

  /// A monster for this player, now and then: at night or underground (in Deepvein, any time), more and tougher
  /// where the zone says (zones.js), never near the town, a pad or Cinderfall's arena.
  async maybeMob(ws, a, now) {
    const M = zoneOf(a.zone).mobs;
    a.mobs = (a.mobs ?? []).filter((m) => now - m.at < MOB_LIFE_MS);
    if (a.mobs.length >= M.max || now < (a.nextMob ?? 0)) return;
    const under = a.y < UNDERGROUND_Y;
    if (!under && !M.always && !isNight(now)) return;
    if (calmAt(a.zone, a.x, a.z)) return;
    a.nextMob = now + M.everyMs * (0.8 + Math.random() * 0.4);
    // Underground means really in a cave: not claiming a spot inside the rock.
    if (under && !(await this.standing(a))) return;
    const r = Math.random();
    const kind = under && a.y < 30 && r < 0.2 ? "golem" : r < 0.45 ? "mudling" : r < 0.75 ? "rattler" : "crawler";
    const ang = Math.random() * Math.PI * 2, d = 10 + Math.random() * 6;
    this.addMob(ws, a, kind, a.x + Math.cos(ang) * d, a.y, a.z + Math.sin(ang) * d, now);
  }
  addMob(ws, a, kind, x, y, z, now) {
    const mob = { i: ++a.mobSeq, k: kind, x: wrap(Math.round(x)), y: Math.round(y), z: wrap(Math.round(z)), hp: Math.round(MOBS[kind].hp * zoneOf(a.zone).mobs.hp), at: now };
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
    m.hp -= clampHit(damage);
    if (m.hp <= 0) {
      a.mobs = a.mobs.filter((o) => o !== m);
      this.send(ws, ["mobdead", m.i]);
      if (a.wallet && !(a.suspect > now)) await this.earn(ws, a, MOB_REWARDS[m.k] ?? 0, m.k);
    }
    this.save(ws, a);
  }
  /// The game couldn't place a monster, or it wandered off: free its place for the next one.
  gone(ws, a, mobId) {
    const before = (a.mobs ?? []).length;
    a.mobs = (a.mobs ?? []).filter((o) => o.i !== mobId);
    if (a.mobs.length !== before) this.save(ws, a);
  }

  // ---------------------------------------------------------------- the rocket's zones (web/zones.js)

  /// Puts player `a` on `zone`, standing at `spot` (its landing pad, unless said otherwise; no message: the callers
  /// tell whoever needs to know).
  arrive(a, zone, now, spot = landing(zone)) {
    a.zone = zone;
    Object.assign(a, xyz(spot));
    a.pAt = now;
    a.suspect = Math.max(a.suspect ?? 0, now + SETTLE_MS); // (a flight is a teleport: nothing is earned for a moment)
    a.mobs = [];
    a.dead = false;
    a.lastHit = null;
    a.week = weekOf(now);
  }
  /// The rocket: the player flies to `zone`. A trip out (from home to a zone, or from a zone to another) uses a
  /// ticket (useTicket); the way home never does. If the flight is refused (no ticket, or too many too fast), they're
  /// told which planet they're still on, and their game goes back there.
  async fly(ws, a, zone) {
    if (!a.ready || !isZone(zone)) return;
    const now = Date.now();
    if (!bucket(a, "flights", FLIGHTS, 1 / FLIGHT_EVERY_S, 1, now)) {
      this.save(ws, a);
      this.send(ws, ["err", "The rocket needs a moment between flights."]);
      return this.zoned(ws, a);
    }
    if (zone !== "home" && zone !== a.zone && !(await this.useTicket(ws, a, zone))) {
      const Z = zoneOf(zone), price = `${Z.ticket.toLocaleString("en-US")} $MINE`;
      this.send(ws, ["err", a.wallet
        ? `A trip to ${Z.name} needs a ticket (${price}): buy one at the rocket. The way home is free.`
        : `A trip to ${Z.name} needs a ticket (${price}): sign in to earn (M) to buy one. The way home is free.`]);
      return this.zoned(ws, a);
    }
    await this.move(ws, a, zone, now);
  }
  /// Trips are free while zones.js TICKETS_FREE says so, and before launch (no MinePayments to buy tickets with).
  ticketsFree() {
    return TICKETS_FREE || !this.env.PAYMENTS_ADDRESS;
  }
  /// A ticket for player `a`'s trip out to `to`, used up on departure: true if they may go. While TICKETS_FREE
  /// (zones.js) every trip is free; otherwise it takes one of the signed-in wallet's tickets to `to` (bought with
  /// buyTicket; guests have none). A ticket has no time limit (a zone can be stayed in as long as you like), and the
  /// way home never needs one.
  async useTicket(ws, a, to) {
    if (this.ticketsFree()) return true;
    if (!a.wallet) return false;
    const t = await this.ticketsOf(a.wallet);
    if (!(t[to] > 0)) return false;
    if (--t[to] === 0) delete t[to];
    await this.ctx.storage.put(`tix:${a.wallet}`, t);
    this.send(ws, ["tickets", t]);
    return true;
  }
  /// A wallet's tickets, as kept (`tix:<wallet>`): zone -> how many.
  async ticketsOf(wallet) {
    return (await this.ctx.storage.get(`tix:${wallet}`)) ?? {};
  }
  /// ["ticket", txHash, zone]: a ticket to `zone`, bought with that transaction. It counts only if the transaction
  /// succeeded, holds a Paid event from MinePayments (PAYMENTS_ADDRESS) by this player's signed-in wallet for kind 1
  /// (tickets) and at least the zone's `ticket` price, is at most PAY_AGE_S old, and hasn't bought a ticket before
  /// (`tixTx:<hash>`, kept for good). The wallet then has one more ticket there. Answers ["ticketok", zone, count,
  /// hash] and ["tickets", all], or ["ticketno", zone, why, hash, retry] (retry 1: the chain couldn't be read, so the
  /// same hash may do later; 0: it never will).
  async buyTicket(ws, a, hash, zone) {
    const env = this.env, now = Date.now();
    const no = (why, retry = false) =>
      this.send(ws, ["ticketno", isZone(zone) ? zone : null, why, typeof hash === "string" ? hash : null, retry ? 1 : 0]);
    if (!a.ready) return;
    if (!isZone(zone) || !zoneOf(zone).ticket) return no("The rocket sells no tickets there.");
    if (this.ticketsFree()) return no("Tickets are free right now: no need to buy one.");
    if (!a.wallet) return no("Sign in to earn (M) first, so the world server knows your wallet.");
    if (typeof hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(hash)) return no("That isn't a transaction.");
    if (!env.PAYMENTS_ADDRESS || !env.CHAIN_RPC) return no("Tickets can't be bought yet.");
    if (!bucket(a, "tix", 4, 1 / 5, 1, now)) {
      this.save(ws, a);
      return no("One ticket at a time: try again in a few seconds.", true);
    }
    this.save(ws, a);
    const key = `tixTx:${hash.toLowerCase()}`;
    this.payChecks ??= new Set(); // (hashes being checked right now: the same one sent twice is checked once)
    if (this.payChecks.has(key) || (await this.ctx.storage.get(key))) return no("That payment has already bought a ticket.");
    this.payChecks.add(key);
    const wallet = a.wallet, Z = zoneOf(zone);
    try {
      const r = await this.paidBy(hash, wallet, TICKET_KIND, BigInt(Z.ticket) * 10n ** 18n, {
        other: "That payment came from another wallet: buy tickets from the wallet you signed in with.",
        kind: "That payment wasn't for a rocket ticket.",
        less: `A ticket to ${Z.name} costs ${Z.ticket.toLocaleString("en-US")} $MINE: that payment was less.`,
        old: "That payment is too old to buy a ticket (over 3 hours).",
      });
      if (!r.ok) return no(r.why, r.retry);
      const t = await this.ticketsOf(wallet);
      t[zone] = (t[zone] ?? 0) + 1;
      await this.ctx.storage.put({ [key]: wallet, [`tix:${wallet}`]: t });
      this.send(ws, ["ticketok", zone, t[zone], hash]);
      if (a.wallet === wallet) this.send(ws, ["tickets", t]);
    } catch (e) {
      console.log("ticket check failed", e?.shortMessage ?? e?.message ?? e);
      no("Couldn't check that payment right now. Try again in a moment.", true);
    } finally {
      this.payChecks.delete(key);
    }
  }
  /// Whether transaction `hash` paid the game: it succeeded and holds a Paid event from MinePayments (PAYMENTS_ADDRESS)
  /// by `wallet`, of `kind`, for at least `price` (wei), in a block at most PAY_AGE_S old. Resolves { ok: true }, or
  /// { why, retry } (retry: the receipt isn't there yet, so the same hash may do later); `say` puts what's wrong in the
  /// payer's terms: { other (another wallet's), kind (the wrong kind), less (too little), old }. Throws if the chain
  /// can't be read. (buyTicket and revive; each keeps its own record of the hashes already used.)
  async paidBy(hash, wallet, kind, price, say) {
    const env = this.env, pub = this.chainClient();
    let receipt = null;
    for (let i = 0; i < 5 && !receipt; i++) {
      receipt = await pub.getTransactionReceipt({ hash }).catch(() => null);
      if (!receipt && i < 4) await new Promise((r) => setTimeout(r, 1500));
    }
    if (!receipt) return { why: "Couldn't find that payment on the chain yet. Try again in a moment.", retry: true };
    if (receipt.status !== "success") return { why: "That transaction failed, so it paid nothing." };
    const paid = parseEventLogs({ abi: PAYMENTS_ABI, logs: receipt.logs, eventName: "Paid" })
      .filter((l) => l.address.toLowerCase() === env.PAYMENTS_ADDRESS.toLowerCase());
    if (!paid.length) return { why: "That transaction isn't a payment to the game." };
    const theirs = paid.filter((l) => getAddress(l.args.player) === wallet);
    if (!theirs.length) return { why: say.other };
    const ofKind = theirs.filter((l) => l.args.kind === kind);
    if (!ofKind.length) return { why: say.kind };
    if (!ofKind.some((l) => l.args.amount >= price)) return { why: say.less };
    const block = await pub.getBlock({ blockNumber: receipt.blockNumber });
    if (Date.now() / 1000 - Number(block.timestamp) > PAY_AGE_S) return { why: say.old };
    return { ok: true };
  }
  /// The chain, read through CHAIN_RPC.
  chainClient() {
    return (this.pub ??= createPublicClient({ transport: http(this.env.CHAIN_RPC) }));
  }
  /// Puts the player on `zone`'s pad: the others on the planet they left see them go, those on the new one see them
  /// land, and the player gets who's there (and the boss, or the loot chests). A signed-in wallet's zone is kept, so a
  /// reload or a dropped connection lands it back there.
  /// `ko`: they were knocked out in a zone and are sent home (died): they come down in town, still knocked out, and the
  /// others see why they left and came (["leave", id, "home", "ko"], ["join", ..., "ko", from]).
  async move(ws, a, zone, now = Date.now(), ko = false) {
    const from = a.zone;
    if (from !== zone) this.zoneCast(from, ["leave", a.id, zone, ...(ko ? ["ko"] : [])], ws);
    this.arrive(a, zone, now, ko ? spawnOf(zone) : landing(zone));
    if (ko) a.dead = true;
    this.save(ws, a);
    this.zoned(ws, a);
    this.zoneCast(zone, ["join", ...this.shown(a), ...(from === zone ? [null] : ko ? ["ko", from] : ["landed"])], ws);
    if (a.wallet) {
      this.send(ws, this.boostMsg(a)); // (the daily cap there is the zone's: zones.js capMul)
      await this.keepZone(a.wallet, zone);
    }
    await this.zoneNews(ws, a);
  }
  /// Remembers the zone a wallet is on (home is forgotten: it's where everyone starts).
  async keepZone(wallet, zone) {
    if (zone === "home") await this.ctx.storage.delete(`zone:${wallet}`);
    else await this.ctx.storage.put(`zone:${wallet}`, zone);
  }
  /// Tells a player which planet they're on and who else is there.
  zoned(ws, a) {
    const here = this.onZone(a.zone).filter(([w]) => w !== ws).map(([, o]) => this.shown(o));
    this.send(ws, ["zoned", a.zone, here, xyz(a)]);
  }
  /// What a player arriving on a planet (or joining) needs besides the players: the boss in Cinderfall, and the loot
  /// chests there (every planet's, even none: the game drops what it showed before).
  async zoneNews(ws, a) {
    if (a.zone === "boss") {
      await this.bossState();
      this.bossTidy(Date.now());
      this.send(ws, this.bossMsg(this.boss)); // (tidying may have brought a fresh one back)
    }
    const now = Date.now();
    const list = [...(await this.chestList()).values()].filter((c) => c.zone === a.zone && c.until > now);
    this.send(ws, ["chests", list.map((c) => [c.id, c.x, c.y, c.z, c.until, c.who])]);
  }
  /// ["respawn"]: back on your feet after being knocked out, in town (knocked out in a zone, the room has already sent
  /// you home: died). Asked while up, it's a jump to spawn like any other (nothing is earned for a moment).
  respawn(ws, a) {
    const now = Date.now();
    if (!a.dead) a.suspect = Math.max(a.suspect ?? 0, now + SETTLE_MS);
    Object.assign(a, xyz(spawnOf(a.zone)));
    a.pAt = now;
    a.mobs = [];
    a.dead = false;
    a.died = null;
    a.lastHit = null;
    if (a.wallet) this.deaths?.delete(a.wallet);
    this.save(ws, a);
  }

  // ---------------------------------------------------------------- the boss (Cinderfall)
  // One boss, in memory: { hp, act, t0, ms, from, to, target, aim, down, dmg, lastFight, summonAt }. Every move goes
  // to everyone in Cinderfall as one message ["boss", ...]; their games animate it from t0, and work out for
  // themselves whether its slam or its thrown rock caught them (so nothing is sent while it moves, and nothing per
  // frame). A loop of timers picks its moves only while someone is in the fight; left alone, it stands still, and
  // after BOSS.healMs it heals (or, if the room has slept meanwhile, it simply starts fresh). Only when it was beaten
  // (and so when it's back) is written down.

  async bossState() {
    if (this.boss) return this.boss;
    const down = (await this.ctx.storage.get("bossdown")) ?? 0;
    this.boss ??= this.freshBoss(down > Date.now() ? down : 0);
    return this.boss;
  }
  freshBoss(down = 0) {
    const at = [ARENA.x + 0.5, ARENA.z + 0.5];
    return { hp: BOSS.hp, act: down ? "down" : "idle", t0: Date.now(), ms: 0, from: at, to: at, target: null, aim: null, down, dmg: new Map(), lastFight: 0, summonAt: 0 };
  }
  /// The message every game draws the boss from.
  bossMsg(B) {
    return ["boss", B.hp, BOSS.hp, B.act, B.t0, B.ms, B.from[0], B.from[1], B.to[0], B.to[1], B.target, B.aim, B.down];
  }
  /// Back after its rest, or healed after being left alone.
  bossTidy(now) {
    const B = this.boss;
    if (!B) return;
    if (B.down && now >= B.down) {
      this.boss = this.freshBoss();
      this.ctx.storage.delete("bossdown").catch(() => {});
      this.zoneCast("boss", this.bossMsg(this.boss));
      this.zoneCast("boss", ["sys", `${BOSS.name} is back in the arena.`]);
    } else if (!B.down && B.hp < BOSS.hp && now - B.lastFight > BOSS.healMs) {
      Object.assign(B, { hp: BOSS.hp, dmg: new Map(), summonAt: 0 });
      this.zoneCast("boss", this.bossMsg(B));
    }
  }
  /// Someone came near the arena (or hit the boss): get its loop going if it isn't.
  async bossWake(now) {
    await this.bossState();
    this.bossTidy(now);
    if (this.bossTimer || this.boss.down) return;
    this.bossTimer = setTimeout(() => this.bossThink(), 300);
  }
  /// The players in the fight: in Cinderfall, near the arena, not knocked out.
  fighters() {
    return this.onZone("boss").filter(([, o]) => !o.dead && wrapDist(o.x, o.z, ARENA.x, ARENA.z) < BOSS.engage);
  }
  /// Picks the boss's next move and tells everyone in Cinderfall; runs again when the move is done.
  bossThink() {
    this.bossTimer = null;
    const B = this.boss, now = Date.now();
    if (!B || B.down) return;
    const pos = bossAt(B, now), here = [pos.x, pos.z];
    const fighters = this.fighters();
    if (!fighters.length) {
      // Nobody to fight: stand where it is, and the loop stops (bossWake starts it again).
      if (B.act !== "idle") {
        Object.assign(B, { act: "idle", t0: now, ms: 0, from: here, to: here, target: null, aim: null });
        this.zoneCast("boss", this.bossMsg(B));
      }
      return;
    }
    B.lastFight = now;
    // Mostly the nearest, sometimes anyone.
    const by = fighters.map(([, o]) => ({ o, d: wrapDist(o.x, o.z, pos.x, pos.z) })).sort((p, q) => p.d - q.d);
    const { o: t, d } = Math.random() < 0.65 ? by[0] : by[Math.floor(Math.random() * by.length)];
    const move = (act, ms, extra = {}) => Object.assign(B, { act, t0: now, ms, from: here, to: here, target: t.id, aim: null, ...extra });
    if (B.hp < BOSS.hp * BOSS.summon.below && now - B.summonAt > BOSS.summon.everyMs) {
      move("summon", BOSS.summon.ms);
      B.summonAt = now;
      this.bossMinions(fighters, pos, now);
    } else if (d > BOSS.slam.radius - 1 && Math.random() < 0.45) {
      // Walk towards them (stopping a stride short of its own body), staying in the arena.
      const k = Math.max(0, d - BOSS.body - 2.5) / (d || 1);
      let tx = pos.x + wrapDelta(t.x - pos.x) * k, tz = pos.z + wrapDelta(t.z - pos.z) * k;
      const r = Math.hypot(tx - ARENA.x - 0.5, tz - ARENA.z - 0.5);
      if (r > BOSS.roam) { tx = ARENA.x + 0.5 + ((tx - ARENA.x - 0.5) * BOSS.roam) / r; tz = ARENA.z + 0.5 + ((tz - ARENA.z - 0.5) * BOSS.roam) / r; }
      const len = Math.hypot(tx - pos.x, tz - pos.z);
      if (len > 1) move("walk", Math.round(Math.min(3500, Math.max(600, (len / BOSS.walkSpeed) * 1000))), { to: [tx, tz] });
      else move("rock", BOSS.rock.ms, { aim: [t.x, t.y, t.z] });
    } else if (d <= BOSS.slam.radius - 0.5 && Math.random() < 0.75) move("slam", BOSS.slam.ms);
    else move("rock", BOSS.rock.ms, { aim: [Math.round(t.x * 10) / 10, Math.round(t.y * 10) / 10, Math.round(t.z * 10) / 10] });
    this.zoneCast("boss", this.bossMsg(B));
    const [lo, hi] = BOSS.restMs;
    this.bossTimer = setTimeout(() => this.bossThink(), B.ms + lo + Math.random() * (hi - lo));
  }
  /// It calls up monsters: one for each of a few fighters, beside the boss (each game runs its own, as always).
  bossMinions(fighters, pos, now) {
    const kinds = ["mudling", "rattler", "crawler"];
    for (let i = 0; i < Math.min(BOSS.summon.count, fighters.length * 2); i++) {
      const [ws, o] = fighters[i % fighters.length];
      const ang = Math.random() * Math.PI * 2, r = 4 + Math.random() * 3;
      this.addMob(ws, o, kinds[i % kinds.length], pos.x + Math.cos(ang) * r, ARENA.y + 1, pos.z + Math.sin(ang) * r, now);
      this.save(ws, o);
    }
  }
  /// A hit on the boss: only from Cinderfall, close enough to it, no faster than a sword and no harder than the best
  /// one, and not just after a teleport. Everyone there sees its health; a refused hit just tells the hitter the
  /// real health again.
  async bossHit(ws, a, damage) {
    const now = Date.now();
    if (!a.ready || a.zone !== "boss") return;
    await this.bossState();
    this.bossTidy(now);
    const B = this.boss;
    const no = () => this.send(ws, ["bosshp", B.hp, a.id, 0]);
    if (B.down || a.dead || a.suspect > now) return no();
    const p = bossAt(B, now);
    if (wrapDist(a.x, a.z, p.x, p.z) > BOSS.hitRange || a.y < ARENA.y - 4 || a.y > ARENA.y + BOSS.height + 4) return no();
    if (!bucket(a, "hits", 2, 1000 / HIT_EVERY_MS, 1, now)) { this.save(ws, a); return no(); }
    this.save(ws, a);
    const d = Math.min(B.hp, clampHit(damage));
    B.hp -= d;
    B.lastFight = now;
    const key = a.wallet ? `w:${a.wallet}` : `g:${a.id}`;
    const rec = B.dmg.get(key) ?? { d: 0, wallet: a.wallet, id: a.id, name: a.name };
    // (What they use as of their last hit: their share gets that boost, even if they've left by the end.)
    Object.assign(rec, { d: rec.d + d, id: a.id, name: a.name, eq: a.wallet ? { ...a.eq } : null });
    B.dmg.set(key, rec);
    this.zoneCast("boss", ["bosshp", B.hp, a.id, 1]);
    if (B.hp <= 0) await this.bossDown(now);
    else await this.bossWake(now);
  }
  /// Beaten: the pool is shared by the signed-in players who hit it, by the damage each did (each share with that
  /// player's earn boost, through the ledger and its daily caps), everyone who did a fair share gets some loot, and
  /// it's back after BOSS.respawnMs.
  async bossDown(now) {
    const B = this.boss;
    clearTimeout(this.bossTimer);
    this.bossTimer = null;
    const here = [bossAt(B, now).x, bossAt(B, now).z];
    Object.assign(B, { hp: 0, act: "down", t0: now, ms: 0, from: here, to: here, target: null, aim: null, down: now + BOSS.respawnMs });
    await this.ctx.storage.put("bossdown", B.down);
    this.zoneCast("boss", this.bossMsg(B));
    const all = [...B.dmg.values()].sort((p, q) => q.d - p.d);
    B.dmg = new Map();
    const total = all.reduce((t, r) => t + r.d, 0) || 1;
    const signed = all.filter((r) => r.wallet).reduce((t, r) => t + r.d, 0);
    const pool = toUnits(BOSS_POOL);
    const conns = this.players();
    for (const [i, r] of all.entries()) {
      // Their connection now: the same one, or the same wallet's.
      const c = conns.find(([, o]) => o.id === r.id) ?? (r.wallet ? conns.find(([, o]) => o.wallet === r.wallet) : null);
      const ws = c?.[0] ?? null;
      let units = 0;
      if (r.wallet && signed) {
        const b = boostOfEq(r.eq);
        units = await this.creditWallet(r.wallet, withEarn(Math.floor((pool * r.d) / signed), b.earn), "boss", ws, dailyCap(b.cap, "boss"));
      }
      const share = r.d / total;
      const loot = new Map();
      const give = (list) => { for (const [id, n] of list) loot.set(id, (loot.get(id) ?? 0) + n); };
      if (share >= 0.05) give(BOSS.loot);
      if (i === 0 && share >= 0.05) {
        give(BOSS.topLoot);
        if (Math.random() < BOSS.rareLoot[1]) give([[BOSS.rareLoot[0], 1]]);
      }
      if (ws) this.send(ws, ["bossreward", units, Math.round(share * 1000) / 10, [...loot], !!r.wallet]);
    }
    const top = all.slice(0, 3).map((r) => `${r.name} ${Math.round((r.d / total) * 100)}%`).join(", ");
    const paid = signed ? `${fmtMine(pool)} $MINE shared by damage` : "Nobody who hit it was signed in, so no $MINE this time";
    this.zoneCast("boss", ["sys", `${BOSS.name} is beaten! ${paid}${top ? ` (${top})` : ""}. Back in ${Math.round(BOSS.respawnMs / 60_000)} minutes.`]);
  }

  // ---------------------------------------------------------------- PvP (Red Mesa)

  /// A hit on another player: only when both are in the same PvP zone (zones.js `pvp`), neither on its pad, close
  /// enough (by where the server last heard they were), no sooner than a swing after the last one, no harder than the
  /// best weapon, and not from someone who has just teleported or is knocked out. Passed to the one hit, whose game
  /// takes their armor off it. A refused hit is answered ["pvpno", target, why].
  pvpHit(ws, a, targetId, damage) {
    if (!a.ready) return;
    const now = Date.now();
    const no = (why) => this.send(ws, ["pvpno", targetId, why]);
    const t = Number.isInteger(targetId) && targetId !== a.id ? this.players().find(([, o]) => o.id === targetId) : null;
    if (!t) return no("gone");
    const [tws, o] = t;
    if (!zoneOf(a.zone).pvp || o.zone !== a.zone) return no("nopvp");
    if (onPad(a.zone, a.x, a.z) || onPad(o.zone, o.x, o.z)) return no("safe");
    if (a.dead || o.dead) return no("down");
    if (a.suspect > now) return no("settling"); // (just landed, joined or moved faster than anyone can)
    if (wrapDist(a.x, a.z, o.x, o.z) > PVP.reach || Math.abs(a.y - o.y) > 4) return no("far");
    if (now - (a.pvpAt ?? 0) < PVP.everyMs) return no("fast");
    a.pvpAt = now;
    this.save(ws, a);
    o.lastHit = { by: a.id, at: now };
    this.save(tws, o);
    const dx = wrapDelta(o.x - a.x), dz = wrapDelta(o.z - a.z), len = Math.hypot(dx, dz) || 1;
    this.send(tws, ["pvphit", a.id, clampHit(damage), Math.round((dx / len) * 100) / 100, Math.round((dz / len) * 100) / 100]);
  }

  // ---------------------------------------------------------------- knock-outs: loot chests and revives

  /// The loot chests left by knocked-out players: id -> { id, zone, x, y, z, until, who, owner, items } (`owner`: the
  /// wallet, or "g:<id>" for a guest), kept in storage too (the room may sleep between a knock-out and the looting).
  async chestList() {
    if (!this.chests) {
      const list = (await this.ctx.storage.get("chests")) ?? [];
      this.chests ??= new Map(list.map((c) => [c.id, c]));
    }
    const now = Date.now();
    for (const [id, c] of this.chests) if (c.until <= now) this.chests.delete(id);
    return this.chests;
  }
  async saveChests() {
    await this.ctx.storage.put("chests", [...this.chests.values()]);
  }
  /// The height a player stands at on top of column (x, z): where a chest goes when they fell out of the world.
  async surface(zone, x, z) {
    const bx = wrap(Math.floor(x)), bz = wrap(Math.floor(z));
    for (let y = HEIGHT - 1; y > 0; y--) if (await this.solidAt(zone, bx, y, bz)) return y + 1;
    return 1;
  }
  /// ["dead", stacks, x, y, z, killer]: the player's game says they were knocked out at (x, y, z) (by a fall, monsters,
  /// the boss, the void, or `killer`, another player's id), carrying `stacks` ([item, count, wear], armor included).
  /// Only from a player who is up: from then on they're down until they respawn or revive, so it's once per knock-out.
  /// Where they fell is the game's word if it's no further from where the room last heard them than they could have
  /// gone since (else the room's own), lifted onto the ground if they fell out of the world; it's kept (a.died, and for
  /// a wallet this.deaths) for a revive. Their things (cleaned up) wait there in a loot chest for CHEST_MS, replacing
  /// any chest of theirs still open; a few knock-outs in a row (DEATHS, then one every DEATH_EVERY_S) make no chest and
  /// the game keeps what it carried. Answers ["dropped", chestId (0: nothing to drop)] or ["dropno", why]. The killer
  /// is named only in a PvP zone, right after a checked hit from them. Knocked out in a zone, they're sent home (move).
  async died(ws, a, items, px, py, pz, killer) {
    if (!a.ready) return;
    if (a.dead) return this.send(ws, ["dropno", "You're already knocked out."]);
    const now = Date.now(), zone = a.zone;
    let x = a.x, y = a.y, z = a.z;
    if ([px, py, pz].every(num) && px >= 0 && pz >= 0 && px < WORLD && pz < WORLD && py > -500 && py < HEIGHT + 20) {
      const dt = Math.min(2, Math.max(0.05, (now - (a.pAt ?? now)) / 1000)), dy = py - a.y;
      if (wrapDist(px, pz, a.x, a.z) <= 8 + 40 * dt && dy <= 4 + 20 * dt && -dy <= 8 + 80 * dt) [x, y, z] = [px, py, pz];
    }
    if (y < 1) y = await this.surface(zone, x, z);
    const r1 = (v) => Math.round(v * 10) / 10;
    [x, y, z] = [wrap(r1(x)), r1(Math.min(y, HEIGHT)), wrap(r1(z))];
    const byPlayer = zoneOf(zone).pvp && a.lastHit?.by === killer && now - a.lastHit.at <= PVP.killMs;
    Object.assign(a, { x, y, z, pAt: now, dead: true, lastHit: null, mobs: [] });
    a.died = { zone, x, y, z, at: now };
    if (a.wallet) (this.deaths ??= new Map()).set(a.wallet, a.died);
    const counted = bucket(a, "deaths", DEATHS, 1 / DEATH_EVERY_S, 1, now);
    this.save(ws, a);
    const stacks = counted ? cleanItems(items) : [];
    let c = null;
    if (stacks.length) {
      const chests = await this.chestList(), owner = a.wallet ?? `g:${a.id}`;
      const gone = (old) => { chests.delete(old.id); this.zoneCast(old.zone, ["chestgone", old.id, null]); };
      for (const old of [...chests.values()]) if (old.owner === owner) gone(old); // (one open chest each)
      c = { id: crypto.getRandomValues(new Uint32Array(1))[0] >>> 1 || 1, zone, x, y, z, until: now + CHEST_MS, who: a.name, owner, items: stacks };
      chests.set(c.id, c);
      while (chests.size > MAX_CHESTS) gone([...chests.values()].reduce((p, q) => (q.until < p.until ? q : p)));
      this.zoneCast(zone, ["chest", c.id, c.x, c.y, c.z, c.until, c.who]);
      await this.saveChests();
    }
    this.send(ws, counted ? ["dropped", c?.id ?? 0] : ["dropno", "Knocked out again so soon: this time you keep what you carry."]);
    const left = c ? `: ${byPlayer ? "their loot chest waits" : "their things wait in a chest"} where they fell` : "";
    if (byPlayer) {
      const k = this.players().find(([, o]) => o.id === killer)?.[1];
      this.zoneCast(zone, ["sys", `${k?.name ?? "Someone"} beat ${a.name}${left}.`]);
    } else if (c) this.near(zone, x, z, ["sys", `${a.name} was knocked out${left}.`], ws);
    if (zone !== "home") await this.move(ws, a, "home", now, true);
  }
  /// Revives are free before launch (no MinePayments to pay with) and while zones.js REVIVE_FREE says so.
  reviveFree() {
    return REVIVE_FREE || !this.env.PAYMENTS_ADDRESS;
  }
  /// The knock-out a revive would undo: this connection's own, or, for a game that came back on a new connection while
  /// knocked out (its connection dropped as it paid, say), its wallet's last one, for DEATH_KEEP_MS.
  deathOf(a) {
    if (a.dead) return a.died ?? null;
    const d = a.wallet ? this.deaths?.get(a.wallet) : null;
    return d && Date.now() - d.at < DEATH_KEEP_MS ? d : null;
  }
  /// ["revive", txHash]: knocked out on the home planet, the player gets up again where they fell (zones.js
  /// REVIVE_PRICE). Free before launch and while REVIVE_FREE (no hash needed); otherwise it takes a payment that
  /// checks out as a ticket's does (paidBy: this signed-in wallet's, kind 2, at least REVIVE_PRICE, at most 3 hours
  /// old) and has never paid for a revive before (`revTx:<hash>`, kept for good; written only once it has revived
  /// someone). Answers ["revived", x, y, z, txHash] (the room has them there, up, so their next position is no jump),
  /// or ["reviveno", why, txHash, retry]: retry 1, the chain couldn't be read (the same hash may do later); 2, the
  /// payment wasn't used (they're up, or not at home): it can still pay for a revive within 3 hours; 0, never.
  async revive(ws, a, hash) {
    if (!a.ready) return;
    const env = this.env, now = Date.now();
    const h = typeof hash === "string" ? hash : null;
    const no = (why, retry = 0) => this.send(ws, ["reviveno", why, h, retry]);
    if (!bucket(a, "revs", 4, 1 / 5, 1, now)) {
      this.save(ws, a);
      return no("One revive at a time: try again in a few seconds.", 1);
    }
    this.save(ws, a);
    const died = this.deathOf(a);
    if (!died) return no("You're not knocked out.", 2);
    if (died.zone !== "home" || a.zone !== "home") return no("No revives in the zones: knocked out there, you respawn at home.", 2);
    if (this.reviveFree()) return this.revived(ws, a, died, null);
    if (!a.wallet) return no("Sign in to earn (M) to pay for a revive.");
    if (!h || !/^0x[0-9a-fA-F]{64}$/.test(h)) return no("That isn't a transaction.");
    if (!env.CHAIN_RPC) return no("Revives can't be paid for yet.");
    const key = `revTx:${h.toLowerCase()}`;
    this.payChecks ??= new Set(); // (hashes being checked right now: the same one sent twice is checked once)
    if (this.payChecks.has(key) || (await this.ctx.storage.get(key))) return no("That payment has already paid for a revive.");
    this.payChecks.add(key);
    const wallet = a.wallet;
    try {
      const r = await this.paidBy(h, wallet, REVIVE_KIND_N, BigInt(REVIVE_PRICE) * 10n ** 18n, {
        other: "That payment came from another wallet: pay from the wallet you signed in with.",
        kind: "That payment wasn't for a revive.",
        less: `A revive costs ${REVIVE_PRICE.toLocaleString("en-US")} $MINE: that payment was less.`,
        old: "That payment is too old to pay for a revive (over 3 hours).",
      });
      if (!r.ok) return no(r.why, r.retry ? 1 : 0);
      // (Still knocked out there, and signed in as that wallet? They may have respawned while the chain was read.)
      const still = this.deathOf(a);
      if (a.wallet !== wallet || still?.at !== died.at || a.zone !== "home") return no("You were up again before the payment was checked: it's kept for your next revive (within 3 hours).", 2);
      await this.ctx.storage.put(key, wallet);
      this.revived(ws, a, died, h);
    } catch (e) {
      console.log("revive check failed", e?.shortMessage ?? e?.message ?? e);
      no("Couldn't check that payment right now. Try again in a moment.", 1);
    } finally {
      this.payChecks.delete(key);
    }
  }
  /// Up again where they fell: the room has them there (so their next position is no jump, and no teleport).
  revived(ws, a, died, hash) {
    Object.assign(a, { x: died.x, y: died.y, z: died.z, pAt: Date.now(), dead: false, died: null, lastHit: null, mobs: [] });
    if (a.wallet) this.deaths?.delete(a.wallet);
    this.save(ws, a);
    this.send(ws, ["revived", died.x, died.y, died.z, hash]);
  }
  /// Opening a loot chest: the first player on its planet close enough (and up) takes everything in it, once; the one
  /// who fell as well as anyone.
  async loot(ws, a, id) {
    if (!a.ready) return;
    const chests = await this.chestList();
    const c = chests.get(id);
    if (!c || c.zone !== a.zone) return this.send(ws, ["lootno", id, "That chest is gone."]);
    if (a.dead) return this.send(ws, ["lootno", id, "You're knocked out."]);
    if (wrapDist(a.x, a.z, c.x, c.z) > CHEST_REACH || Math.abs(a.y - c.y) > 5) return this.send(ws, ["lootno", id, "Get closer to the chest."]);
    chests.delete(id); // (before anything waits: a second try finds nothing)
    this.send(ws, ["looted", id, c.items, c.who]);
    this.zoneCast(c.zone, ["chestgone", id, a.name], ws);
    await this.saveChests();
  }

  // ---------------------------------------------------------------- the $MINE ledger

  /// A ledger shard (wallets by their address's first hex digit), in units. One still under the old key, in
  /// hundredths, is converted here and written under the new one at the next flush (which then deletes the old).
  async shard(wallet) {
    const s = wallet[2].toLowerCase();
    let sh = this.shards.get(s);
    if (!sh) {
      let stored = await this.ctx.storage.get(`${this.ledgerKey}${s}`), old = null;
      if (stored === undefined && !this.practice) {
        old = await this.ctx.storage.get(`${OLD_LEDGER}${s}`);
        if (old) stored = Object.fromEntries(Object.entries(old).map(([w, l]) => [w, { ...l, total: l.total * FROM_CENTS, today: l.today * FROM_CENTS }]));
      }
      sh = this.shards.get(s); // (loaded by another message meanwhile)
      if (!sh) {
        sh = stored ?? {};
        this.shards.set(s, sh);
        if (old) {
          this.oldKeys.add(`${OLD_LEDGER}${s}`);
          this.dirtyShards.add(s);
          this.scheduleFlush();
        }
      }
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
  /// Everyone's earnings today (kept with the ledger, written in the same flush), in units.
  async worldToday() {
    const day = Math.floor(Date.now() / DAY_MS);
    if (!this.world) {
      let w = await this.ctx.storage.get(this.worldDayKey);
      if (w === undefined && !this.practice) {
        const old = await this.ctx.storage.get(OLD_WORLD_DAY);
        if (old && !this.world) {
          w = { day: old.day, total: old.total * FROM_CENTS };
          this.oldKeys.add(OLD_WORLD_DAY);
          this.dirtyWorld = true;
          this.scheduleFlush();
        }
      }
      this.world ??= w ?? { day, total: 0 };
    }
    if (this.world.day !== day) this.world = { day, total: 0 };
    return this.world;
  }
  /// Player `a` did something worth `mine` $MINE at home's rate: it's counted times their zone's rate (rewards.js
  /// ZONE_PAY) and their earn boost, within their daily cap (with their cap boost, in this zone) and everyone's.
  async earn(ws, a, mine, what) {
    const b = this.boost(a);
    this.recheck(ws, a);
    return this.creditWallet(a.wallet, withEarn(toUnits(mine) * (ZONE_PAY[a.zone] ?? 1), b.earn), what, ws, dailyCap(b.cap, a.zone));
  }
  /// Counts `units` for `wallet` (within its daily cap `cap` and everyone's), and tells its game (`ws`, if it's here).
  /// Returns what was counted.
  async creditWallet(wallet, units, what, ws, cap) {
    if (!units || !wallet) return 0;
    const [s, l] = await this.ledger(wallet);
    const w = await this.worldToday();
    const c = Math.min(units, cap - l.today, WORLD_CAP - w.total);
    if (c <= 0) {
      if (ws) this.send(ws, ["earn", 0, l.today, l.total, w.total >= WORLD_CAP ? "worldcap" : "cap"]);
      return 0;
    }
    l.today += c;
    l.total += c;
    w.total += c;
    this.dirtyShards.add(s);
    this.dirtyWorld = true;
    this.scheduleFlush();
    if (ws) this.send(ws, ["earn", c, l.today, l.total, what]);
    return c;
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
    const chunks = [...this.dirtyChunks], shards = [...this.dirtyShards], world = this.dirtyWorld;
    if (!chunks.length && !shards.length && !world) return;
    this.dirtyChunks.clear();
    this.dirtyShards.clear();
    this.dirtyWorld = false;
    for (const k of chunks) this.saving.add(k);
    const out = {};
    for (const k of chunks) {
      const e = this.edits.get(k);
      const raw = new Uint8Array(e.size * 3);
      let j = 0;
      for (const [i, b] of e) { raw[j++] = i & 255; raw[j++] = i >> 8; raw[j++] = b; }
      out[k] = raw;
    }
    for (const s of shards) out[`${this.ledgerKey}${s}`] = this.shards.get(s);
    if (world) out[this.worldDayKey] = this.world;
    const old = [...this.oldKeys]; // (their converted copies are in this write)
    this.flushing = (async () => {
      try {
        const keys = Object.keys(out);
        for (let i = 0; i < keys.length; i += 128) {
          await this.ctx.storage.put(Object.fromEntries(keys.slice(i, i + 128).map((k) => [k, out[k]])));
        }
        if (old.length) {
          await this.ctx.storage.delete(old);
          for (const k of old) this.oldKeys.delete(k);
        }
      } catch (e) {
        for (const k of chunks) this.dirtyChunks.add(k);
        for (const s of shards) this.dirtyShards.add(s);
        if (world) this.dirtyWorld = true;
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
      o.eq = {};
      this.rename(w, o);
      this.send(w, ["signinfail", "You signed in somewhere else, so earnings count there now."]);
    }
    a.wallet = wallet;
    a.suspect = Math.max(a.suspect ?? 0, Date.now() + SETTLE_MS);
    // No boost until this wallet's own NFTs are checked: the game wears its Crafter again once it's signed in.
    a.eq = {};
    a.nick = (await this.ctx.storage.get(`name:${wallet}`))?.name ?? null;
    this.rename(ws, a);
    const [, l] = await this.ledger(wallet);
    this.send(ws, ["signedin", wallet, token, l.today, l.total, dailyCap(0, a.zone), a.nick && nameShown(a.nick) ? a.nick : null]);
    if (!this.ticketsFree()) this.send(ws, ["tickets", await this.ticketsOf(wallet)]);
    // Back on the zone this wallet was on (its ticket has no time limit). A game in a zone already (a guest's free
    // trip, only possible while tickets are free) keeps its place, and that becomes the wallet's zone.
    const kept = (await this.ctx.storage.get(`zone:${wallet}`)) ?? "home";
    if (kept !== a.zone && a.ready) {
      if (a.zone === "home" && isZone(kept)) await this.move(ws, a, kept);
      else await this.keepZone(wallet, a.zone);
    }
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
    const total = unitsToWei(l.total);
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
    const signature = await privateKeyToAccount(env.MINING_KEY).signTypedData({
      domain: { name: "MineWorldCraft Mining", version: "1", chainId: Number(env.CHAIN_ID), verifyingContract: env.MINING_ADDRESS },
      types: { Earnings: [{ name: "player", type: "address" }, { name: "total", type: "uint256" }, { name: "deadline", type: "uint64" }] },
      primaryType: "Earnings",
      message: { player: a.wallet, total, deadline },
    });
    this.send(ws, ["voucher", total.toString(), Number(deadline), signature]);
  }

  /// What a player shows: the armor they wear (four tiers 0..4) and, fifth, the item in their hand (an id, 0 for
  /// nothing). It's only for looks, so it's only checked for shape; at most a few times a second (the game sends it a
  /// moment after the last change).
  gear(ws, a, g) {
    if (!a.ready || !Array.isArray(g) || (g.length !== 4 && g.length !== 5)) return;
    if (!g.slice(0, 4).every((t) => isInt(t, 0, 5)) || (g.length === 5 && !isInt(g[4], 0, 256))) return;
    if (!bucket(a, "gears", 4, 1, 1, Date.now())) return;
    a.gear = g;
    this.save(ws, a);
    this.zoneCast(a.zone, ["gear", a.id, g], ws);
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
    if (!target || !target[1].voice || target[1].zone !== a.zone) return;
    const o = target[1];
    if (Math.abs(wrapDelta(o.x - a.x)) > VOICE_RANGE || Math.abs(wrapDelta(o.z - a.z)) > VOICE_RANGE || Math.abs(o.y - a.y) > VOICE_RANGE) return;
    this.send(target[0], ["rtc", a.id, data]);
  }

  // ---------------------------------------------------------------- NFTs: looks and boosts (web/boosts.js)

  /// Wear a MineWorld Crafter, an I'M DEGEN (or null for the Rookie): only once the chain says the signed-in wallet
  /// owns it. Its traits come from the revealed seed (web/degen-skin.js, the rules the contract's art follows) and go
  /// to everyone; its rarity and level (CrafterLevels) are the player's Crafter boost.
  async wear(ws, a, tokenId) {
    const env = this.env;
    const now = Date.now();
    if (tokenId === null) {
      a.look = null;
      const had = !!a.eq?.crafter;
      if (a.eq) delete a.eq.crafter;
      this.save(ws, a);
      this.zoneCast(a.zone, ["look", a.id, null]);
      if (had) this.send(ws, this.boostMsg(a));
      return;
    }
    if (!a.wallet || !env.CRAFTERS_ADDRESS || !env.CHAIN_RPC || !isInt(tokenId, 1, SUPPLY + 1) || now - (a.wearAt ?? 0) < 3000) return;
    a.wearAt = now;
    this.save(ws, a);
    const wallet = a.wallet;
    const r = await this.readItem("crafter", tokenId, wallet).catch((e) => ({ failed: e }));
    if (r.failed) return this.chainDown(ws, r.failed);
    if (r.sealed) return this.send(ws, ["err", "The I'M DEGEN collection isn't revealed yet."]);
    if (!r.mine) return this.send(ws, ["err", "That DEGEN isn't in your wallet."]);
    if (a.wallet !== wallet) return; // (signed out meanwhile)
    a.look = packTraits(r.traits);
    this.zoneCast(a.zone, ["look", a.id, a.look]);
    this.equipped(ws, a, "crafter", [tokenId, r.tier, r.level], r.levelOk);
  }

  /// Use (or, with null, stop using) token `tokenId` of a boost slot's collection (boosts.js SLOTS): only once the
  /// chain says the signed-in wallet owns it, and its tier is read from the collection. The Crafter slot is `wear`.
  /// A slot whose collection isn't out yet (no address) says so.
  async equip(ws, a, slot, tokenId) {
    if (!isSlot(slot)) return;
    if (slot === "crafter") return this.wear(ws, a, tokenId);
    const S = SLOTS[slot], what = S.name.toLowerCase();
    if (tokenId === null) {
      if (a.eq?.[slot]) {
        delete a.eq[slot];
        this.save(ws, a);
        this.send(ws, this.boostMsg(a));
      }
      return;
    }
    if (!a.wallet) return this.send(ws, ["err", `Sign in to earn (M) to use a ${what}.`]);
    if (!Number.isSafeInteger(tokenId) || tokenId < 0) return;
    if (!bucket(a, "equips", 3, 1 / 3, 1, Date.now())) { this.save(ws, a); return this.send(ws, ["err", "One change every few seconds."]); }
    this.save(ws, a);
    const wallet = a.wallet;
    const r = await this.readItem(slot, tokenId, wallet).catch((e) => ({ failed: e }));
    if (r.failed) return this.chainDown(ws, r.failed);
    if (r.off) return this.send(ws, ["err", `${S.name}s aren't out yet: coming soon.`]);
    if (!r.mine) return this.send(ws, ["err", `That ${what} isn't in your wallet.`]);
    if (!isInt(r.tier, 0, S.tiers.length)) return this.send(ws, ["err", `That ${what}'s tier isn't one the game knows yet.`]);
    if (a.wallet !== wallet) return;
    this.equipped(ws, a, slot, [tokenId, r.tier, r.level], r.levelOk);
  }
  chainDown(ws, e) {
    console.log("chain read failed", e?.shortMessage ?? e?.message ?? e);
    this.send(ws, ["err", "The chain didn't answer. Try again in a moment."]);
  }
  /// Player `a` now uses `item` ([tokenId, tier, level]) in `slot`: their boost changes, and they're told. It's checked
  /// again later (sooner if the level couldn't be read: until it is, it counts as level 1).
  equipped(ws, a, slot, item, levelOk) {
    (a.eq ??= {})[slot] = item;
    a.eqAt = Date.now() + (levelOk ? BOOST_RECHECK_MS : BOOST_RETRY_MS);
    this.save(ws, a);
    this.send(ws, this.boostMsg(a));
  }

  /// What the chain says about token `id` of slot `slot`'s collection for `wallet`: { off } while the collection has
  /// no address; { sealed } while the Crafters aren't revealed; { mine: false } if it isn't the wallet's (or doesn't
  /// exist); else { mine, tier, level, levelOk, traits }. Throws if the chain can't be read.
  async readItem(slot, id, wallet) {
    const S = SLOTS[slot], env = this.env;
    const address = env[S.env] || S.contract;
    if (!address || !env.CHAIN_RPC) return { off: true };
    const pub = createPublicClient({ transport: http(env.CHAIN_RPC) });
    if (S.tierOf === "rarity" && !this.crafterSeed) {
      const seed = await pub.readContract({ address, abi: CRAFTERS_ABI, functionName: "seed" });
      if (seed === 0n) return { sealed: true };
      this.crafterSeed = seed;
    }
    const owner = await pub.readContract({ address, abi: CRAFTERS_ABI, functionName: "ownerOf", args: [BigInt(id)] })
      .catch((e) => { if (reverted(e)) return null; throw e; }); // (a token that doesn't exist reverts)
    if (!owner || getAddress(owner) !== wallet) return { mine: false };
    let traits = null, tier;
    if (S.tierOf === "rarity") {
      traits = traitsOf(this.crafterSeed, id, HASH);
      tier = rarityOf(traits);
    } else tier = Number(await pub.readContract({ address, abi: viewAbi(S.tierOf), functionName: S.tierOf, args: [BigInt(id)] }));
    const lv = S.levels ? await this.readLevel(pub, S.levels, id) : { level: 1, ok: true };
    return { mine: true, tier, level: lv.level, levelOk: lv.ok, traits };
  }
  /// A token's level from its levels contract (CrafterLevels.levelOf). Level 1 while that contract has no address;
  /// level 1 for now if the chain can't be read (ok: false, so it's tried again a minute later).
  async readLevel(pub, L, id) {
    const address = this.env[L.env] || L.contract;
    if (!address) return { level: 1, ok: true };
    try {
      const v = await pub.readContract({ address, abi: viewAbi(L.fn), functionName: L.fn, args: [BigInt(id)] });
      return { level: Math.max(1, Math.min(255, Number(v))), ok: true };
    } catch (e) {
      console.log("level read failed", e?.shortMessage ?? e?.message ?? e);
      return { level: 1, ok: false };
    }
  }

  /// A player's boost (boosts.js): from what they use, checked on-chain; none for a guest.
  boost(a) {
    return a.wallet ? boostOfEq(a.eq) : NO_BOOST;
  }
  /// What the game is told: ["boost", speed, earn, cap, move, sources, the wallet's daily cap here in units].
  boostMsg(a) {
    const b = this.boost(a);
    return ["boost", ...packBoost(b), dailyCap(b.cap, a.zone)];
  }
  /// Every BOOST_RECHECK_MS while a player earns (a minute after a read failed), what they use is checked again,
  /// alongside the credit and never holding it up: a token that's no longer theirs stops boosting (and a Crafter stops
  /// showing), and a level bought meanwhile starts counting. If the chain can't be read, what was known stays.
  recheck(ws, a) {
    const now = Date.now();
    if (!a.wallet || !a.eq || !Object.keys(a.eq).length || now < (a.eqAt ?? 0)) return;
    a.eqAt = now + BOOST_RETRY_MS; // (one check at a time)
    this.save(ws, a);
    this.checkAgain(ws, a, a.wallet).catch((e) => console.log("boost check failed", e?.message ?? e));
  }
  /// ["recheck"]: read what the player uses again now, rather than at the next check (the game asks right after its
  /// player levels up the Crafter they wear). A few at most (RECHECKS, then one every RECHECK_EVERY_S); the player
  /// gets their ["boost", ...] back either way.
  async recheckNow(ws, a) {
    if (!a.wallet || !a.eq || !Object.keys(a.eq).length) return;
    const now = Date.now();
    if (!bucket(a, "rechecks", RECHECKS, 1 / RECHECK_EVERY_S, 1, now)) return this.save(ws, a);
    a.eqAt = now + BOOST_RETRY_MS; // (and no regular check meanwhile)
    this.save(ws, a);
    await this.checkAgain(ws, a, a.wallet, true);
  }
  async checkAgain(ws, a, wallet, answer = false) {
    let ok = true, changed = false;
    for (const [slot, item] of Object.entries(a.eq)) {
      const r = await this.readItem(slot, item[0], wallet).catch(() => null);
      if (a.wallet !== wallet || a.eq[slot]?.[0] !== item[0]) continue; // (they changed it meanwhile)
      if (!r) { ok = false; continue; }
      if (r.off || !r.mine) {
        delete a.eq[slot];
        changed = true;
        if (slot === "crafter") {
          a.look = null;
          this.zoneCast(a.zone, ["look", a.id, null]);
        }
        this.send(ws, ["err", `Your ${slot === "crafter" ? "DEGEN" : SLOTS[slot].name.toLowerCase()} isn't in this wallet any more, so its boost is off.`]);
        continue;
      }
      const level = r.levelOk ? r.level : item[2];
      if (!r.levelOk) ok = false;
      if (r.tier !== item[1] || level !== item[2]) {
        a.eq[slot] = [item[0], r.tier, level];
        changed = true;
      }
    }
    if (a.wallet !== wallet) return;
    a.eqAt = Date.now() + (ok ? BOOST_RECHECK_MS : BOOST_RETRY_MS);
    this.save(ws, a);
    if (changed || answer) this.send(ws, this.boostMsg(a));
  }

  // ---------------------------------------------------------------- local testing only

  /// Dev hooks, for trying the daily caps without mining for hours: ["dev", "today", mine] sets the signed-in wallet's
  /// earnings today, ["dev", "world", mine] everyone's. Only when the room runs under `wrangler dev --var DEV_HOOKS:1`
  /// (never put DEV_HOOKS in wrangler.toml) and the connection came to it on this machine, so never in production.
  async dev(ws, a, what, mine) {
    if (this.env.DEV_HOOKS !== "1" || !a.local || !num(mine) || mine < 0) return;
    if (what === "today" && a.wallet) {
      const [s, l] = await this.ledger(a.wallet);
      l.today = toUnits(mine);
      this.dirtyShards.add(s);
    } else if (what === "world") {
      (await this.worldToday()).total = toUnits(mine);
      this.dirtyWorld = true;
    } else return;
    this.scheduleFlush();
    const l = a.wallet ? (await this.ledger(a.wallet))[1] : null;
    this.send(ws, ["dev", what, l?.today ?? 0, (await this.worldToday()).total]);
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
