// Autopilot bots: up to BOT_MAX of your other I'M DEGENs mining near you (docs/AUTOPILOT.md has the rules and the
// protocol; the numbers both sides share are in bots-rules.js). Your game simulates them; the world server checks every
// break of theirs like one of yours and pays it into your wallet's total, within each bot's own daily cap.
//
// Each bot is:
// - an avatar in its DEGEN's skin, its pickaxe in hand and a name tag ("<you>'s bot #id"), drawn bent round the planet
//   like everything else;
// - a body stepped exactly as yours is (physics.js stepPlayer), and only on ground that's loaded and synced with the
//   world server (anywhere else it waits);
// - a brain. It looks for the best block its pickaxe can harvest nearby, by $MINE a second (the block's rate, the zone's
//   pay, the time its pickaxe takes with its own DEGEN's speed boost, the walk there), within BOT_LEASH (and BOT_DY up
//   or down) of you, walks there (jumping up steps) and mines it, with its own cracks and, now and then, a sound. It
//   only ever aims at natural blocks with a face open to air it can see (the surface, cave walls, its own tunnel): no
//   x-ray. With nothing worth it in sight, it digs a straight tunnel of at most RUN_MAX blocks, its way chosen without
//   looking inside the rock (a staircase down while near your level, then straight on). Stuck (inside a block, getting
//   no closer for STUCK_MS) or too far from you, it jumps to a free spot beside you (BOT_JUMP). All the bots together
//   read at most SEARCH_BUDGET blocks a frame while they look.
// - Ores it digs go into your bag when there's room (anything else it breaks gives nothing); its pickaxe wears 1 a
//   block, kept with the bag (inventory.js), and once worn out the bot is recalled.
//
// What they did goes to the world server inside your own position updates (net.js tick): each bot's place now and the
// blocks it broke since the last batch, each with the cell it stood in. A bot that would walk more than FLUSH_AT blocks
// from the first of those cells, step off a drop that deep, or jump to you, waits for its batch to go first (and one
// that falls that far anyway stops where it is until it has).
//
// They stop while: you've been idle (no action the world server counts: a natural block broken, a block placed, a hit,
// a chat line, walking BOT_MARK_MOVE) for BOT_IDLE_MS less half a minute, or the server says so (botidle); you're
// knocked out or flying; the connection is down (until the server confirms each again: botok); a bot or everyone has
// reached the day's cap (until 00:00 UTC, by the server's clock); its pickaxe wore out, or is being changed (its breaks
// with the old one go first, then the change, and it waits for the server's botpick).

import * as THREE from "https://esm.sh/three@0.160.0";
import { BLOCKS, AIR, WATER, STONE, TOOLS, breakTime, maxDurability, dropsFor, COAL, IRON, GOLD, DIAMOND, CRYSTAL } from "./blocks.js";
import { CHUNK, wrap, wrapDelta, wrapDist } from "./rules.js";
import { protectedIn, onPad } from "./zones.js";
import { BLOCK_REWARDS, ZONE_PAY, WORLD_DAILY_CAP } from "./rewards.js";
import { itemBoost, withSpeed } from "./boosts.js";
import { stepPlayer, TICK } from "./physics.js";
import { createAvatar } from "./avatar.js";
import { heldModel, tileUVs } from "./held.js";
import { tileOf } from "./textures.js";
import { place } from "./planet.js";
import { keyOf } from "./world.js";
import { index } from "./worldgen.js";
import { unpackTraits, rarityOf } from "./degen-skin.js";
import { nameTag } from "./net.js";
import {
  BOT_MAX, BOT_IDLE_MS, BOT_LEASH, BOT_DY, BOT_BREAKS_MAX, BOT_REACH, BOT_EDIT_CHUNKS, BOT_MINING, BOT_JUMP,
  BOT_AT_CAP, BOT_WORLD_CAP, BOT_SETTLING, BOT_TOO_FAR, BOT_IDLE, BOT_REFUSED, BOT_HP, botName,
} from "./bots-rules.js";

const SEARCH_BUDGET = 1500; // block reads a frame for all the bots' looking together
const SCAN_R = BOT_REACH + 2, SCAN_DOWN = 3, SCAN_UP = 4; // blocks: where a bot looks round its feet
const CANDIDATES = 8; // the best blocks a look keeps (mined in turn, each checked again first)
const LOOK_MS = 4000; // a look this old is done again
const EXPLORE_N = 24; // surface columns a bot tries when nothing worth it is in sight
const RUN_MAX = 6; // blocks: a straight tunnel, at the most
const STUCK_MS = 5000; // getting no closer to where it's going this long: it jumps to you
const GOAL_MS = 4000; // a block it walks towards and can't get at in this long is given up (for AVOID_MS)
const AVOID_MS = 30_000;
const FLUSH_AT = 5; // blocks from its first unsent foot cell: a bot waits for its batch (the server allows BOT_FOOT_ROOM)
const FOLLOW_AT = BOT_LEASH - 6; // blocks: further from you than this, a bot stops what it's doing and comes after you
const WALK = 4.317; // blocks a second (physics.js MOVE): for guessing how long a walk takes
const RETRY_MS = [5000, 15_000, 30_000, 60_000, 120_000, 300_000]; // after a botoff that says try again later
const ASK_MS = 20_000; // a deploy with no answer this long is tried again
const CALLBACK_MS = 60_000; // a deploy called back with no last word from the server this long is given up on
const IDLE_EARLY_MS = 30_000; // bots pause this much before the server would
const DIG_EVERY = 0.8, SOUND_NEAR = 12, SOUND_GAP_MS = 400, BURST_GAP_MS = 300, BURST_NEAR = 20; // quiet: sounds and debris now and then
const ORE_DROPS = new Set([COAL, IRON, GOLD, DIAMOND, CRYSTAL]); // what goes into your bag (everything else is left)
const DAY_MS = 86_400_000;
/// Where bots stand when they come to you, round your feet (each bot starts at its own).
const SPOTS = [[1.6, 0.9], [-1.6, 0.9], [1.6, -1.3], [-1.6, -1.3], [0, 2.2], [0, -2.2], [2.6, 0], [-2.6, 0]];
const FACES = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
const CARDINALS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
/// The cells round a bot's feet it looks at, nearest first.
const OFFSETS = [];
for (let dy = -SCAN_DOWN; dy <= SCAN_UP; dy++) for (let dx = -SCAN_R; dx <= SCAN_R; dx++) for (let dz = -SCAN_R; dz <= SCAN_R; dz++) OFFSETS.push([dx, dy, dz]);
OFFSETS.sort((a, b) => (a[0] ** 2 + a[1] ** 2 + a[2] ** 2) - (b[0] ** 2 + b[1] ** 2 + b[2] ** 2));
/// An angle brought round into [-pi, pi).
const turnBy = (a) => a - 2 * Math.PI * Math.floor(a / (2 * Math.PI) + 0.5);
const r2 = (v) => Math.round(v * 100) / 100;

/// `opts`: { scene, world, inv (inventory.js), atlasTex (the block atlas, for the cracks), player ({ pos, alive }),
/// half, tall, eye (your box: the bots' is the same), zone() (the planet you're on), synced(chunkKey) (the world
/// server's edits for it are in), net() (net.js, or null), signedIn(), owner() (your name, for the tags), now() (the
/// server's clock, ms), flying() (a rocket trip is under way), burst(x, y, z, block) (debris), sfx, toast(text, kind),
/// say(text) (a line in chat), changed() (the roster changed: the HUD and the panel draw it again) }.
export function createBots(opts) {
  const { scene, world, inv, player, half, tall, eye } = opts;
  const bots = new Map(); // token id -> the bot (below), while it's out or being sent out
  const placed = new Map(); // chunk key -> Set(index): blocks players placed (the room's edits that aren't air)
  const avoid = new Map(); // "x,y,z" -> until (ms): blocks a bot gave up on, or whose break the room refused
  const editMin = new Map(); // chunk key -> when it was last changed by you or a bot (the room's BOT_EDIT_CHUNKS)
  // token id -> { id, d, at }: a deploy recalled before the server answered it (its pickaxe is back in your bag): that
  // DEGEN can't go out again until the server's last word on that ask (a botoff; a botok first is answered "off").
  const calledBack = new Map();
  let flight = null; // { to, departed }: the last flight that took off (bots left home wait on it: flying, landed)
  const crackMat = new THREE.MeshBasicMaterial({ map: opts.atlasTex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1 });
  let activeAt = 0; // when you last did something the world server counts as activity (performance.now())
  let serverIdle = false; // the server says your bots are paused for idleness (botidle 1)
  let worldDay = -1; // the UTC day everyone's cap was reached (server time)
  let reads = 0; // block reads left this frame
  let turn = 0; // which bot looks first this frame (they take turns)
  let soundAt = 0, burstAt = 0, hitSaid = 0;
  let shownKey = ""; // what the HUD and the panel last drew (changed() only when it moves on)
  const net = () => opts.net?.() ?? null;
  const day = () => Math.floor(opts.now() / DAY_MS);

  // ---------------------------------------------------------------- what the world is (natural, allowed)
  const chunkOf = (x, z) => keyOf(Math.floor(wrap(x) / CHUNK), Math.floor(wrap(z) / CHUNK));
  const cellKey = (x, y, z) => `${wrap(x)},${y},${wrap(z)}`;
  /// Whether a player placed the block at (x, y, z) (the room's edit there isn't air): bots never break it.
  function isPlaced(x, y, z) {
    x = wrap(x); z = wrap(z);
    const s = placed.get(chunkOf(x, z));
    return !!s && s.has(index(x % CHUNK, y, z % CHUNK));
  }
  const avoided = (x, y, z) => (avoid.get(cellKey(x, y, z)) ?? 0) > performance.now();
  function giveUp(x, y, z, ms = AVOID_MS) {
    if (avoid.size > 500) for (const [k, t] of avoid) if (t < performance.now()) avoid.delete(k);
    avoid.set(cellKey(x, y, z), performance.now() + ms);
  }
  /// Whether a bot may change a block in the chunk holding (x, z) this minute: the room allows you and your bots
  /// BOT_EDIT_CHUNKS distinct chunks a minute together (two are kept for you).
  function editRoom(x, z, now) {
    for (const [k, t] of editMin) if (now - t > 60_000) editMin.delete(k);
    return editMin.has(chunkOf(x, z)) || editMin.size < BOT_EDIT_CHUNKS - 2;
  }
  // The players near you (you too): no bot breaks a block under one (within 2 blocks across, up to their head).
  let people = [];
  function lookAround() {
    const P = player.pos;
    people = [[P.x, P.y, P.z]];
    for (const [pid, o] of net()?.others ?? []) if (pid > 0 && o.holder.visible) people.push([o.pos.x, o.pos.y, o.pos.z]);
  }
  const underSomeone = (x, y, z) => people.some(([px, py, pz]) => Math.abs(wrapDelta(x + 0.5 - px)) < 2.5 && Math.abs(wrapDelta(z + 0.5 - pz)) < 2.5 && y <= py + 2);

  /// Bot b's pickaxe ({ id, d } from the bag's store), or null.
  const pickOf = (b) => inv.bot(b.tok);
  /// How long bot b takes to break `block` (seconds; its pickaxe, its DEGEN's speed boost).
  function need(b, block) {
    const p = pickOf(b);
    return Math.max(0.05, withSpeed(breakTime(block, p?.id ?? null).seconds, b.boost.speed));
  }
  /// What a straight tunnel earns bot b a second, about (stone, and a little walking).
  const runValue = (b) => ((BLOCK_REWARDS[STONE] ?? 0.05) * (ZONE_PAY[opts.zone()] ?? 1)) / (need(b, STONE) + 0.3);

  /// Whether bot b may break `block` at (x, y, z): solid, its pickaxe harvests it, paying (unless it's digging a
  /// tunnel: `run`), natural, not protected, synced, within its leash, under nobody, not under its own feet, and
  /// within the minute's chunks.
  function canBreak(b, x, y, z, block, run = false) {
    const B = BLOCKS[block];
    if (!B?.solid || B.liquid || !(B.hardness > 0) || B.hardness === Infinity) return false;
    const p = pickOf(b);
    if (!p || B.tier > (TOOLS[p.id]?.tier ?? 0)) return false;
    if (!run && !BLOCK_REWARDS[block]) return false;
    const zone = opts.zone(), P = player.pos, pos = b.body.pos;
    if (y < 1 || isPlaced(x, y, z) || avoided(x, y, z)) return false;
    if (protectedIn(zone, wrap(x), wrap(z)) || onPad(zone, x + 0.5, z + 0.5)) return false;
    if (!opts.synced(chunkOf(x, z))) return false;
    if (wrapDist(x + 0.5, z + 0.5, P.x, P.z) > BOT_LEASH - 2 || Math.abs(y - P.y) > BOT_DY - 2) return false;
    if (y < Math.floor(pos.y) && Math.abs(wrapDelta(x + 0.5 - pos.x)) < 0.85 && Math.abs(wrapDelta(z + 0.5 - pos.z)) < 0.85) return false;
    if (underSomeone(x, y, z)) return false;
    return editRoom(x, z, performance.now());
  }
  /// Whether block (x, y, z) has a face open (not solid) on the side towards (ex, ey, ez).
  function openToward(x, y, z, ex, ey, ez) {
    const vx = wrapDelta(ex - (x + 0.5)), vy = ey - (y + 0.5), vz = wrapDelta(ez - (z + 0.5));
    for (const [nx, ny, nz] of FACES) {
      if (nx * vx + ny * vy + nz * vz <= 0) continue;
      reads--;
      if (!world.solid(x + nx, y + ny, z + nz)) return true;
    }
    return false;
  }
  /// Whether bot b's eyes see block (x, y, z): the first solid block on the line to its middle is that one.
  function sees(b, x, y, z) {
    const o = b.body.pos, ox = o.x, oy = o.y + eye, oz = o.z;
    const dx = wrapDelta(x + 0.5 - ox), dy = y + 0.5 - oy, dz = wrapDelta(z + 0.5 - oz);
    const len = Math.hypot(dx, dy, dz) || 1;
    const tx = Math.floor(ox + dx), ty = y, tz = Math.floor(oz + dz); // (the block's image nearest the eyes)
    let cx = Math.floor(ox), cy = Math.floor(oy), cz = Math.floor(oz);
    const ux = dx / len, uy = dy / len, uz = dz / len;
    const sx = Math.sign(ux), sy = Math.sign(uy), sz = Math.sign(uz);
    const ddx = ux ? Math.abs(1 / ux) : Infinity, ddy = uy ? Math.abs(1 / uy) : Infinity, ddz = uz ? Math.abs(1 / uz) : Infinity;
    let mx = ux > 0 ? (cx + 1 - ox) * ddx : ux < 0 ? (ox - cx) * ddx : Infinity;
    let my = uy > 0 ? (cy + 1 - oy) * ddy : uy < 0 ? (oy - cy) * ddy : Infinity;
    let mz = uz > 0 ? (cz + 1 - oz) * ddz : uz < 0 ? (oz - cz) * ddz : Infinity;
    for (let i = 0; i < 32; i++) {
      if (cx === tx && cy === ty && cz === tz) return true;
      reads--;
      if (i > 0 && world.solid(cx, cy, cz)) return false;
      if (mx < my && mx < mz) { cx += sx; mx += ddx; } else if (my < mz) { cy += sy; my += ddy; } else { cz += sz; mz += ddz; }
    }
    return false;
  }
  const eyeDist = (b, x, y, z) => { const p = b.body.pos; return Math.hypot(wrapDelta(x + 0.5 - p.x), y + 0.5 - (p.y + eye), wrapDelta(z + 0.5 - p.z)); };
  /// A free spot beside you for bot slot i (feet on something, room for its height, not in water), or null.
  function spotBeside(i) {
    const P = player.pos;
    for (let k = 0; k < SPOTS.length; k++) {
      const [ox, oz] = SPOTS[(i * 2 + k) % SPOTS.length];
      const bx = Math.floor(P.x + ox), bz = Math.floor(P.z + oz);
      if (!world.loaded(bx, bz) || !opts.synced(chunkOf(bx, bz))) continue;
      for (const dy of [0, 1, -1, 2, -2, 3, -3]) {
        const by = Math.floor(P.y) + dy;
        if (by < 1 || !world.solid(bx, by - 1, bz) || world.solid(bx, by, bz) || world.solid(bx, by + 1, bz)) continue;
        if (world.get(bx, by, bz) === WATER || world.get(bx, by + 1, bz) === WATER) continue;
        return [wrap(bx + 0.5), by, wrap(bz + 0.5)];
      }
    }
    return null;
  }

  // ---------------------------------------------------------------- a bot
  /// A bot record: its DEGEN (token id, traits, tier, level, boost), whether the world server has it out on this
  /// connection (live), its avatar once it's in the world, its body, and what its brain is doing. (`leaving`: a flight
  /// that took off without it is leaving it home, `departed` once that flight went; `pickSent`: its pickaxe change
  /// went to the server.)
  function make(tok, e) {
    const traits = unpackTraits(e.look);
    const used = new Set([...bots.values()].map((b) => b.slot));
    let slot = 0;
    while (used.has(slot)) slot++;
    const tier = traits ? rarityOf(traits) : 0;
    const b = {
      tok, traits, tier, level: 1, boost: itemBoost("crafter", tier, 1), slot,
      live: false, asked: 0, tries: 0, retryAt: 0, why: null, said: null, inZone: false, recall: false, broken: false, offSent: false,
      leaving: false, departed: false, pickSent: false,
      today: 0, cap: null, todayDay: day(), capDay: -1, hp: BOT_HP,
      holder: null, av: null, tag: null, crack: null, crackGeo: null, crackBase: null, crackStage: -1, replace: false,
      body: { pos: new THREE.Vector3(), vel: new THREE.Vector3(), onGround: false, water: false, jumpDelay: 0 },
      prev: new THREE.Vector3(), drawn: new THREE.Vector3(), acc: 0, yaw: 0, pitch: 0, wall: false,
      inp: { strafe: 0, forward: 0, yaw: 0, jump: false, sprint: false, sneak: false, speed: 1 },
      target: null, goal: null, run: null, scan: null, cands: null, candsAt: 0, follow: false, status: "",
      moving: false, best: Infinity, moveKey: "", progressAt: performance.now(), digAt: 0, mining: false,
      breaks: [], foot0: null, sent: null, dirty: true, jumped: false, urgent: false,
    };
    bots.set(tok, b);
    return b;
  }
  /// Puts bot b in the world beside you, dressed and holding its pickaxe.
  function appear(b) {
    b.av = createAvatar(b.traits, [0, 0, 0, 0]);
    b.av.hold(heldModel(pickOf(b)?.id ?? 0));
    b.tag = nameTag(botName(opts.owner(), b.tok));
    b.av.root.add(b.tag);
    b.holder = new THREE.Group();
    b.holder.add(b.av.root);
    scene.add(b.holder);
    b.crackGeo = new THREE.BoxGeometry(1.01, 1.01, 1.01);
    b.crackBase = b.crackGeo.attributes.uv.array.slice();
    b.crack = new THREE.Mesh(b.crackGeo, crackMat);
    b.crack.visible = false;
    b.crack.userData.at = new THREE.Vector3();
    scene.add(b.crack);
    b.replace = true; // (stood beside you once the ground there is ready: update)
  }
  /// Takes bot b out of the world and forgets it (it isn't out on the server any more: a pickaxe change the server
  /// hadn't answered is undone, the new one back in your bag).
  function remove(b) {
    if (!b) return;
    unswap(b.tok);
    if (b.holder) {
      scene.remove(b.holder);
      b.av.dispose();
      b.tag.material.map?.dispose();
      b.tag.material.dispose();
      scene.remove(b.crack);
      b.crackGeo.dispose();
    }
    bots.delete(b.tok);
  }
  /// Bot `tok`'s pickaxe change that the server won't answer now (it forgot the bot, or never had it): the bot keeps
  /// the one it had, and the one it was being handed goes back to your bag.
  function unswap(tok) {
    const e = inv.bot(tok);
    if (e?.next) inv.pickSwapped(tok, e.next.id, e.next.d);
    const b = bots.get(tok);
    if (b) b.pickSent = false;
  }
  /// Whether the pickaxe a botok or botoff names (`pickId`, `wear`) is the one bot b (its store entry e) holds or is
  /// being handed, as this game keeps them: worn no more than this game counted (the server counts the same breaks, or
  /// fewer: refused ones, ones still on the way), and, for a bot that isn't out yet, worn exactly that (nothing wore it
  /// since it was sent). Anything else is about an earlier deploy (or a change undone), not this one.
  function holds(e, b, pickId, wear) {
    const fits = (p) => !!p && pickId === p.id && (!Number.isInteger(wear) || (b?.live ? wear <= p.d : wear === p.d));
    return fits(e) || fits(e.next);
  }
  /// Whether DEGEN `tok` was recalled while the server was still deploying it, and the server hasn't had its last word.
  function callingBack(tok) {
    const c = calledBack.get(tok);
    if (c && performance.now() - c.at > CALLBACK_MS) calledBack.delete(tok);
    return calledBack.has(tok);
  }
  function setCrack(b, stage) {
    if (stage === b.crackStage) return;
    b.crackStage = stage;
    b.crackGeo.attributes.uv.array.set(b.crackBase);
    const t = tileOf(`crack${stage}`);
    tileUVs(b.crackGeo, [t, t, t, t, t, t]);
  }
  /// Stands bot b on a free spot beside you, now (flagged BOT_JUMP for the server: it settles it, no fault).
  function jumpToYou(b, now) {
    const s = spotBeside(b.slot) ?? [player.pos.x, player.pos.y, player.pos.z];
    b.body.pos.set(s[0], s[1], s[2]);
    b.body.vel.set(0, 0, 0);
    b.body.onGround = false;
    b.prev.copy(b.body.pos);
    b.drawn.copy(b.body.pos);
    b.acc = 0;
    b.jumped = b.dirty = true;
    b.target = b.goal = b.run = b.scan = b.cands = null;
    b.follow = b.urgent = false;
    b.progressAt = now;
    b.moveKey = "";
  }
  /// Asks the world server to send bot b out (or again: after a reconnect, a reload, a retry).
  function ask(b, now) {
    const e = inv.bot(b.tok), n = net();
    if (!e || !n?.online || !opts.signedIn()) return;
    if (n.sendBot("on", b.tok, e.id, e.d)) {
      b.asked = now;
      b.retryAt = 0;
      b.inZone = opts.zone() !== "home";
    }
  }

  // ---------------------------------------------------------------- why bots wait
  /// Why every bot waits right now, in words, or null if they may work.
  function pausedWhy(now = performance.now()) {
    if (!opts.signedIn()) return "sign in to earn (M)";
    if (!net()?.online) return "reconnecting to the world…";
    if (opts.flying()) return "flying";
    if (!player.alive) return "you're knocked out";
    if (worldDay === day()) return `today's ${WORLD_DAILY_CAP.toLocaleString("en-US")} $MINE for everyone is mined: back at 00:00 UTC`;
    if (serverIdle || now - activeAt > BOT_IDLE_MS - IDLE_EARLY_MS) return "move or mine to wake them";
    return null;
  }
  /// Why bot b waits (on top of pausedWhy), or null.
  function waitsWhy(b) {
    if (b.broken) return "its pickaxe is worn out";
    if (b.recall) return "coming back";
    if (b.leaving) return "staying home";
    if (!b.live) return b.retryAt ? `trying again soon${b.why ? ` (${b.why})` : ""}` : b.asked ? "getting ready…" : "reconnecting…";
    if (inv.bot(b.tok)?.next) return "changing its pickaxe"; // (it mines nothing until the server has handed it over)
    if (b.capDay === day()) return "at its cap for today: back at 00:00 UTC";
    return null;
  }

  // ---------------------------------------------------------------- the brain
  function hold(b) {
    b.inp.forward = 0;
    b.inp.sprint = false;
    b.inp.jump = b.body.water;
    b.moving = false;
    b.mining = false;
  }
  /// How far (x, y, z) is from the furthest foot cell of bot b's breaks still to go, along any one axis (the server
  /// wants each within BOT_FOOT_ROOM of the bot's place when they go), or 0 with none.
  function footSpan(b, x, y, z) {
    let m = 0;
    for (const k of b.breaks) m = Math.max(m, Math.abs(wrapDelta(k[3] + 0.5 - x)), Math.abs(k[4] - y), Math.abs(wrapDelta(k[5] + 0.5 - z)));
    return m;
  }
  /// Walks bot b towards (tx, tz) (sprinting if asked), jumping up steps and swimming; true once within `stop`.
  function walkTo(b, tx, tz, now, sprint = false, stop = 0.4) {
    const p = b.body.pos;
    const dx = wrapDelta(tx - p.x), dz = wrapDelta(tz - p.z), d = Math.hypot(dx, dz);
    if (d < stop) { hold(b); return true; }
    // Its breaks' foot cells (the first, and any since) must stay near where it is when they go: it waits for its batch
    // to leave first.
    const f = b.foot0;
    if (f && (Math.hypot(wrapDelta(f[0] + 0.5 - p.x), f[1] - p.y, wrapDelta(f[2] + 0.5 - p.z)) > FLUSH_AT - 0.8 || footSpan(b, p.x, p.y, p.z) > FLUSH_AT - 0.8)) {
      b.urgent = true;
      hold(b);
      return false;
    }
    // Nor does it step off a drop that would take it that far from them (a fall can't be stopped halfway): it looks
    // down the column a step ahead, and waits for its batch first.
    if (b.breaks.length && b.body.onGround && !b.body.water) {
      const ax = Math.floor(p.x + (dx / d) * 0.8), az = Math.floor(p.z + (dz / d) * 0.8);
      let y = Math.floor(p.y);
      if ((ax !== Math.floor(p.x) || az !== Math.floor(p.z)) && !world.solid(ax, y, az)) {
        for (let k = 0; k <= FLUSH_AT && y > 1 && !world.solid(ax, y - 1, az); k++) y--;
        if (footSpan(b, ax + 0.5, y, az + 0.5) > FLUSH_AT - 0.8) {
          b.urgent = true;
          hold(b);
          return false;
        }
      }
    }
    const key = `${Math.round(tx)},${Math.round(tz)}`;
    if (key !== b.moveKey) { b.moveKey = key; b.best = d; b.progressAt = now; }
    else if (d < b.best - 0.5) { b.best = d; b.progressAt = now; }
    b.yaw = Math.atan2(-dx, -dz);
    b.pitch = 0;
    b.inp.forward = d > 0.9 ? 1 : 0.5;
    b.inp.sprint = sprint && d > 3;
    b.inp.jump = (b.wall && b.body.onGround) || b.body.water;
    b.moving = true;
    b.mining = false;
    return false;
  }
  /// A block for bot b to mine now.
  function aim(b, x, y, z, block, run = false) {
    const p = pickOf(b);
    b.target = { x: wrap(x), y, z: wrap(z), b: block, t: 0, need: need(b, block), drops: breakTime(block, p?.id ?? null).drops, run };
    b.goal = null;
  }

  /// One frame of bot b's brain: sets what its body does (b.inp) and mines.
  function think(b, dt, now, paused) {
    const P = player.pos, p = b.body.pos;
    const fx = Math.floor(p.x), fy = Math.floor(p.y), fz = Math.floor(p.z);
    const flat = wrapDist(p.x, p.z, P.x, P.z), dy = p.y - P.y;
    b.mining = false;
    // Stuck in a block, lost below the world, too far, or getting nowhere: to you at once (its batch first).
    const buried = world.solid(fx, fy, fz) || world.solid(fx, fy + 1, fz);
    if (buried || p.y < 1 || flat > BOT_LEASH + 2 || Math.abs(dy) > BOT_DY + 2 || (b.moving && now - b.progressAt > STUCK_MS)) {
      b.status = "coming to you";
      if (b.breaks.length) { b.urgent = true; return hold(b); }
      return jumpToYou(b, now);
    }
    if (!b.moving) b.progressAt = now;
    if (paused || waitsWhy(b)) {
      b.target = b.goal = b.run = null;
      b.status = "";
      return hold(b);
    }
    // Far from you: it comes after you (sprinting if far), dropping what it was doing.
    if (flat > FOLLOW_AT || Math.abs(dy) > BOT_DY - 6) b.follow = true;
    if (b.follow) {
      b.target = b.goal = b.run = b.cands = b.scan = null;
      b.status = "following you";
      if (walkTo(b, P.x, P.z, now, flat > 8, 4)) b.follow = false;
      return;
    }
    // Standing somewhere protected (the town, a pad), it can break nothing: it walks out your way, or waits by you.
    const zone = opts.zone();
    if (protectedIn(zone, wrap(fx), wrap(fz)) || onPad(zone, p.x, p.z)) {
      b.target = b.run = null;
      b.status = "in a protected area";
      const free = !protectedIn(zone, Math.floor(P.x), Math.floor(P.z)) && !onPad(zone, P.x, P.z);
      if (free && flat > 2) walkTo(b, P.x, P.z, now, false, 2);
      else hold(b);
      return;
    }
    if (b.target) return mine(b, dt, now);
    if (b.goal) return go(b, now);
    // Looking: a fresh look round (over a few frames), then the best of what it saw.
    if (!b.cands || now - b.candsAt > LOOK_MS || (b.scan && !b.scan.done)) {
      hold(b);
      b.status = "looking for blocks";
      const list = look(b);
      if (!list) return;
      b.cands = list;
      b.candsAt = now;
      b.scan = null;
    }
    // (What's left of the frame's reads must cover a choice: else it chooses next frame.)
    const best = reads > 2 * EXPLORE_N + 8 ? pick(b) : undefined;
    if (best === undefined) return hold(b);
    const rv = runValue(b);
    if (b.run) {
      // In a tunnel: anything worth more than the tunnel that came into sight first (its walls), then on.
      if (best && best.value >= rv * 1.3) return take(b, best, now);
      return dig(b, now);
    }
    if (best && best.value >= rv * 0.6) return take(b, best, now);
    const far = explore(b);
    if (far && far.value >= rv * 0.6) return take(b, far, now);
    if (startRun(b)) return dig(b, now);
    if (best) return take(b, best, now);
    if (far) return take(b, far, now);
    // Nothing at all: stroll near you and look again.
    b.cands = null;
    b.status = "looking for blocks";
    const a = Math.random() * Math.PI * 2;
    b.goal = { walk: true, x: wrap(P.x + Math.cos(a) * 5), z: wrap(P.z + Math.sin(a) * 5), until: now + GOAL_MS };
  }
  /// Bot b goes for candidate c: mines it if it's in reach and seen, else walks to it.
  function take(b, c, now) {
    if (eyeDist(b, c.x, c.y, c.z) <= BOT_REACH && sees(b, c.x, c.y, c.z)) aim(b, c.x, c.y, c.z, c.b);
    else b.goal = { x: c.x, y: c.y, z: c.z, b: c.b, until: now + GOAL_MS, seenAt: 0 };
    hold(b);
  }
  /// The best of bot b's candidates still there, still allowed and in its sight (each it can't have is dropped), or
  /// null; undefined if the frame's reads ran out before it could tell.
  function pick(b) {
    while (b.cands?.length) {
      if (reads <= 0) return undefined;
      const c = b.cands[0];
      if (world.get(c.x, c.y, c.z) === c.b && canBreak(b, c.x, c.y, c.z, c.b) && sees(b, c.x, c.y, c.z)) return c;
      b.cands.shift();
    }
    return null;
  }
  /// One frame of bot b's look round its feet (SCAN_R across, SCAN_DOWN down, SCAN_UP up), within what's left of the
  /// frame's reads: when it's done, its best CANDIDATES by $MINE a second (blocks it can break with a face open its
  /// way), else null.
  function look(b) {
    const p = b.body.pos;
    let s = b.scan;
    if (!s || s.done) s = b.scan = { i: 0, x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z), ex: p.x, ey: p.y + eye, ez: p.z, best: [], done: false };
    const pay = ZONE_PAY[opts.zone()] ?? 1;
    while (s.i < OFFSETS.length && reads > 0) {
      const [dx, dy, dz] = OFFSETS[s.i++];
      const x = s.x + dx, y = s.y + dy, z = s.z + dz;
      reads--;
      const block = world.get(x, y, z), R = BLOCK_REWARDS[block];
      if (!R || !canBreak(b, x, y, z, block) || !openToward(x, y, z, s.ex, s.ey, s.ez)) continue;
      const d = Math.hypot(wrapDelta(x + 0.5 - s.ex), y + 0.5 - s.ey, wrapDelta(z + 0.5 - s.ez));
      const value = (R * pay) / (need(b, block) + Math.max(0, d - BOT_REACH) / WALK + 0.25);
      const c = { x: wrap(x), y, z: wrap(z), b: block, value };
      const at = s.best.findIndex((o) => o.value < value);
      if (at < 0) { if (s.best.length < CANDIDATES) s.best.push(c); }
      else { s.best.splice(at, 0, c); if (s.best.length > CANDIDATES) s.best.pop(); }
    }
    if (s.i < OFFSETS.length) return null;
    s.done = true;
    return s.best;
  }
  /// Bot b tries a few surface blocks further out (within its leash, at about its own level: the sky's above them, so
  /// they're in plain view): the best by $MINE a second, or null.
  function explore(b) {
    const p = b.body.pos, P = player.pos, pay = ZONE_PAY[opts.zone()] ?? 1;
    let best = null;
    for (let k = 0; k < EXPLORE_N && reads > 0; k++) {
      const a = Math.random() * Math.PI * 2, r = SCAN_R + Math.random() * 10;
      const x = wrap(Math.floor(p.x + Math.cos(a) * r)), z = wrap(Math.floor(p.z + Math.sin(a) * r));
      if (wrapDist(x + 0.5, z + 0.5, P.x, P.z) > BOT_LEASH - 4) continue;
      reads -= 2;
      const y = world.topAt(x, z);
      if (y < 1 || Math.abs(y - p.y) > 3) continue;
      const block = world.get(x, y, z), R = BLOCK_REWARDS[block];
      if (!R || !canBreak(b, x, y, z, block)) continue;
      const d = wrapDist(x + 0.5, z + 0.5, p.x, p.z);
      const value = (R * pay) / (need(b, block) + d / WALK + 0.5);
      if (!best || value > best.value) best = { x, y, z, b: block, value };
    }
    return best;
  }
  /// Bot b walks towards the block it's going for; once it's in reach and in sight, it mines it. Given up after
  /// GOAL_MS. (A stroll, `walk`, just walks.)
  function go(b, now) {
    const g = b.goal;
    if (now > g.until) {
      if (!g.walk) giveUp(g.x, g.y, g.z);
      b.goal = null;
      return hold(b);
    }
    b.status = g.walk ? "looking for blocks" : "walking";
    if (!g.walk) {
      if (world.get(g.x, g.y, g.z) !== g.b) { b.goal = null; return hold(b); }
      if (eyeDist(b, g.x, g.y, g.z) <= BOT_REACH && now - g.seenAt > 250) {
        g.seenAt = now;
        if (sees(b, g.x, g.y, g.z)) { aim(b, g.x, g.y, g.z, g.b); return hold(b); }
      }
    }
    if (walkTo(b, g.x + 0.5, g.z + 0.5, now, false, g.walk ? 0.6 : 1.2)) {
      if (!g.walk) giveUp(g.x, g.y, g.z); // (there, and still can't see it)
      b.goal = null;
    }
  }
  /// One frame of bot b mining its target: facing it, the cracks growing, a dig sound now and then; broken once its
  /// time is up (if there's room in its batch).
  function mine(b, dt, now) {
    const t = b.target;
    hold(b);
    if (world.get(t.x, t.y, t.z) !== t.b || eyeDist(b, t.x, t.y, t.z) > BOT_REACH + 0.5) { b.target = null; return; }
    const p = b.body.pos;
    const dx = wrapDelta(t.x + 0.5 - p.x), dy = t.y + 0.5 - (p.y + eye), dz = wrapDelta(t.z + 0.5 - p.z);
    b.yaw = Math.atan2(-dx, -dz);
    b.pitch = Math.atan2(dy, Math.hypot(dx, dz));
    b.mining = true;
    b.status = t.run ? "digging a tunnel" : "mining";
    if (t.t < t.need) {
      t.t += dt;
      if (now - b.digAt > DIG_EVERY * 1000 && Math.hypot(dx, dz) < SOUND_NEAR + 4 && wrapDist(p.x, p.z, player.pos.x, player.pos.z) < SOUND_NEAR) {
        b.digAt = now;
        opts.sfx?.dig(BLOCKS[t.b].tier > 0);
      }
    }
    if (t.t < t.need) return;
    if (b.breaks.length >= BOT_BREAKS_MAX - 1) { b.status = "waiting for its batch to go"; return; } // (room for a plant on top)
    if (!canBreak(b, t.x, t.y, t.z, t.b, t.run)) { giveUp(t.x, t.y, t.z); b.target = null; return; }
    finish(b, t, now);
  }
  /// Bot b breaks its target: the block (and a plant on it) goes, into its batch with the cell it stands in; its
  /// pickaxe wears; ores go into your bag.
  function finish(b, t, now) {
    const p = b.body.pos;
    const foot = [wrap(Math.floor(p.x)), Math.floor(p.y), wrap(Math.floor(p.z))];
    world.set(t.x, t.y, t.z, AIR);
    b.breaks.push([t.x, t.y, t.z, ...foot]);
    b.foot0 ??= foot;
    const above = world.get(t.x, t.y + 1, t.z);
    if (BLOCKS[above]?.plant && !isPlaced(t.x, t.y + 1, t.z)) {
      world.set(t.x, t.y + 1, t.z, AIR);
      b.breaks.push([t.x, t.y + 1, t.z, ...foot]);
    }
    editMin.set(chunkOf(t.x, t.z), now);
    const near = wrapDist(t.x + 0.5, t.z + 0.5, player.pos.x, player.pos.z);
    if (near < BURST_NEAR && now - burstAt > BURST_GAP_MS) { burstAt = now; opts.burst?.(t.x, t.y, t.z, t.b); }
    if (near < SOUND_NEAR && now - soundAt > SOUND_GAP_MS) { soundAt = now; opts.sfx?.broke(BLOCKS[t.b].tier > 0); }
    // The pickaxe wears 1 a block (blocks that break at a touch cost nothing); worn out, the bot comes back.
    const e = pickOf(b);
    if (e && BLOCKS[t.b].hardness > 0) {
      const d = e.d + 1;
      inv.botWear(b.tok, d);
      if (d >= maxDurability(e.id)) {
        b.broken = true;
        b.urgent = true; // (its last breaks go first: then it's recalled, update)
        opts.toast?.(`Bot #${b.tok} wore out its pickaxe: it's coming back.`, "bad");
      }
    }
    for (const [id, n] of dropsFor(t.b, Math.random, t.drops)) if (ORE_DROPS.has(id)) inv.add(id, n);
    b.target = null;
    b.progressAt = now;
  }
  /// Starts a straight tunnel for bot b, if it can: the way it faces first, then the others, keeping the far end
  /// within its leash; a staircase down while it's near your level, straight on deeper down. Only the faces it can
  /// see (the cells just ahead) are read.
  function startRun(b) {
    const p = b.body.pos, P = player.pos;
    if (!b.body.onGround || b.body.water) return false;
    const fx = Math.floor(p.x), fy = Math.floor(p.y), fz = Math.floor(p.z);
    const down = fy >= Math.floor(P.y) - 6 && fy - RUN_MAX > P.y - BOT_DY + 3;
    const faced = [-Math.sin(b.yaw), -Math.cos(b.yaw)];
    const ways = CARDINALS.slice().sort((u, v) => (v[0] * faced[0] + v[1] * faced[1]) - (u[0] * faced[0] + u[1] * faced[1]));
    for (const [dx, dz] of ways) {
      if (wrapDist(fx + dx * RUN_MAX + 0.5, fz + dz * RUN_MAX + 0.5, P.x, P.z) > BOT_LEASH - 3) continue;
      const ax = fx + dx, az = fz + dz;
      const cells = down ? [[ax, fy + 1, az], [ax, fy, az], [ax, fy - 1, az]] : [[ax, fy + 1, az], [ax, fy, az]];
      reads -= cells.length;
      const blocks = cells.map(([x, y, z]) => world.get(x, y, z));
      if (blocks.some((k) => k === WATER)) continue;
      if (!blocks.some((k) => BLOCKS[k]?.solid)) continue; // (nothing to dig that way)
      if (!cells.every(([x, y, z], i) => !BLOCKS[blocks[i]]?.solid || canBreak(b, x, y, z, blocks[i], true))) continue;
      b.run = { dx, dz, down, left: RUN_MAX, at: null };
      return true;
    }
    return false;
  }
  /// One frame of bot b's tunnel: the cells of the next step dug out (head, feet, and below for a staircase), then a
  /// step into it; RUN_MAX steps, or until something in the way can't be dug.
  function dig(b, now) {
    const r = b.run, p = b.body.pos;
    b.status = "digging a tunnel";
    if (!r.at) {
      // Each step starts from the middle of its cell (so the cells ahead aren't under its own feet).
      if (!walkTo(b, Math.floor(p.x) + 0.5, Math.floor(p.z) + 0.5, now, false, 0.15) || !b.body.onGround) return;
      r.at = [Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)];
    }
    const ax = r.at[0] + r.dx, ay = r.at[1], az = r.at[2] + r.dz;
    const cells = r.down ? [[ax, ay + 1, az], [ax, ay, az], [ax, ay - 1, az]] : [[ax, ay + 1, az], [ax, ay, az]];
    for (const [x, y, z] of cells) {
      const k = world.get(x, y, z);
      if (k === WATER) { b.run = null; return hold(b); }
      if (!BLOCKS[k]?.solid) continue;
      if (!canBreak(b, x, y, z, k, true) || eyeDist(b, x, y, z) > BOT_REACH) { b.run = null; return hold(b); }
      aim(b, x, y, z, k, true);
      return hold(b);
    }
    // Dug out: a step in. Then a look at the new walls (an ore may show) before the next.
    if (Math.floor(p.x) === wrap(ax) && Math.floor(p.z) === wrap(az) && b.body.onGround) {
      r.at = null;
      b.cands = null;
      if (--r.left <= 0) b.run = null;
      return hold(b);
    }
    walkTo(b, ax + 0.5, az + 0.5, now, false, 0.2);
  }

  // ---------------------------------------------------------------- the frame
  /// Every frame (dt seconds): sends out the bots waiting to go, runs each bot in the world (its brain, then its body in
  /// whole ticks, drawn between the last two), and tells the HUD when something it shows changed.
  function update(dt) {
    const now = performance.now();
    const paused = pausedWhy(now);
    const today = day();
    reads = SEARCH_BUDGET;
    lookAround();
    const list = [...bots.values()];
    turn = (turn + 1) % Math.max(1, list.length);
    for (let i = 0; i < list.length; i++) {
      const b = list[(i + turn) % list.length];
      if (b.todayDay !== today) { b.todayDay = today; b.today = 0; }
      // Asking again for the ones not out yet: an ask with no answer, or a botoff that said to, after RETRY_MS. (The
      // first ask on a connection is redeploy's, once you're signed in on it.)
      // (Not one a flight is leaving home: it waits for the flight.)
      if (!b.live && !b.recall && !b.leaving && b.asked && !b.retryAt && now - b.asked > ASK_MS) {
        b.asked = 0;
        b.retryAt = now + RETRY_MS[Math.min(b.tries++, RETRY_MS.length - 1)];
      }
      if (!b.live && !b.recall && !b.leaving && b.retryAt && now >= b.retryAt && opts.signedIn() && net()?.online) ask(b, now);
      // Recalled or worn out: once its last breaks have gone, the server is asked to take it back.
      if ((b.recall || b.broken) && !b.offSent && !b.breaks.length) {
        if (!b.live) { recalled(b, null, null, null); continue; }
        if (net()?.sendBot("off", b.tok)) b.offSent = true;
      }
      // Handed another pickaxe (changePick): once its last breaks with the old one have gone (the server wears the
      // pickaxe a bot holds when its breaks come), the server is asked to swap them.
      const e = b.live && !b.pickSent && !b.recall && !b.broken && !b.leaving && !b.breaks.length ? inv.bot(b.tok) : null;
      if (e?.next && net()?.sendBot("pick", b.tok, e.next.id, e.next.d)) b.pickSent = true;
      if (b.holder && !b.leaving) tickBot(b, dt, now, paused);
    }
    const key = summaryKey(paused);
    if (key !== shownKey) { shownKey = key; opts.changed?.(); }
  }
  function tickBot(b, dt, now, paused) {
    const p = b.body.pos;
    const ready = (x, z) => world.loaded(Math.floor(x), Math.floor(z)) && opts.synced(chunkOf(x, z));
    if (b.replace) {
      // New in the world, or after a flight, a regrow: beside you, once the ground there is ready (and its last breaks
      // have gone).
      b.av.root.visible = false;
      if (b.breaks.length && b.live) { b.urgent = true; return; }
      if (!ready(player.pos.x, player.pos.z)) return;
      const first = !b.sent;
      b.replace = false;
      b.av.root.visible = true;
      jumpToYou(b, now);
      if (first) b.jumped = false; // (nothing to report for its first: the server has it out with you)
    }
    // Left on ground that isn't loaded any more (you went far: /wild, a respawn, a long walk), where its brain can't run:
    // to you at once, once its last breaks have gone.
    if (!ready(p.x, p.z) && ready(player.pos.x, player.pos.z)) {
      if (b.breaks.length && b.live) b.urgent = true;
      else jumpToYou(b, now);
    }
    const here = ready(p.x, p.z);
    if (here) think(b, dt, now, paused);
    else hold(b);
    if (here) {
      b.inp.yaw = b.yaw;
      b.acc = Math.min(b.acc + dt, 5 * TICK);
      // A fall it didn't see coming (or a push) that took it FLUSH_AT from its breaks' foot cells: it stops right there
      // until they've gone (at once), so the server still finds each within BOT_FOOT_ROOM of where it says it is.
      const far = () => b.live && b.breaks.length > 0 && footSpan(b, p.x, p.y, p.z) > FLUSH_AT - 0.8;
      while (b.acc >= TICK && !far()) {
        b.prev.copy(p);
        const r = stepPlayer(world, b.body, b.inp, half, tall);
        p.x = wrap(p.x);
        p.z = wrap(p.z);
        b.wall = r.wall;
        b.acc -= TICK;
      }
      if (far()) {
        b.urgent = true;
        b.acc = 0;
        b.prev.copy(p);
      }
    } else {
      b.acc = 0;
      b.prev.copy(p);
    }
    // Drawn between its last two ticks (a jump to you: straight there).
    const dx = wrapDelta(p.x - b.prev.x), dy = p.y - b.prev.y, dz = wrapDelta(p.z - b.prev.z);
    const k = dx * dx + dy * dy + dz * dz > 64 ? 0 : 1 - b.acc / TICK;
    b.drawn.set(wrap(p.x - dx * k), p.y - dy * k, wrap(p.z - dz * k));
    b.av.root.rotation.y = b.yaw + Math.PI;
    b.av.animate(Math.min(dt, 0.25), { x: b.drawn.x, y: b.drawn.y, z: b.drawn.z, yaw: b.yaw, pitch: b.pitch, sneak: false,
      swinging: b.mining, ground: b.body.onGround || b.body.water });
    const t = b.target;
    b.crack.visible = !!t && t.t > 0;
    if (t) {
      b.crack.userData.at.set(t.x + 0.5, t.y + 0.5, t.z + 0.5);
      setCrack(b, Math.min(4, Math.floor((t.t / t.need) * 5)));
    }
  }
  /// Stands the bots on the curved planet as seen from the camera (after planet.follow, before the render).
  function draw() {
    for (const b of bots.values()) {
      if (!b.holder) continue;
      b.holder.visible = !b.replace && !b.leaving && !opts.flying();
      if (b.holder.visible) place(b.holder, b.drawn, 0);
      if (b.crack.visible && b.holder.visible) place(b.crack, b.crack.userData.at, 0);
      else b.crack.visible = false;
    }
  }

  // ---------------------------------------------------------------- the batch (net.js tick)
  /// Whether bot b has something new for the world server (moved, turned, its flags, or a jump), or nothing.
  function news(b) {
    const S = b.sent, p = b.body.pos;
    const flags = (b.mining ? BOT_MINING : 0) | (b.jumped ? BOT_JUMP : 0);
    return !S || b.dirty || flags !== S.flags || Math.hypot(wrapDelta(p.x - S.x), p.y - S.y, wrapDelta(p.z - S.z)) > 0.05
      || Math.abs(turnBy(b.yaw - S.yaw)) > 0.35;
  }
  const wire = {
    /// 0: nothing to send; 1: bots only moved (they wait for your next update or the heartbeat); 2: breaks wait
    /// (BOT_BATCH_MS); 3: a bot can't go on until its batch has gone.
    due() {
      let d = 0;
      for (const b of bots.values()) {
        if (!b.live || !b.holder || (b.leaving && !b.breaks.length)) continue;
        if (b.urgent && b.breaks.length) return 3;
        if (b.breaks.length) d = 2;
        else if (!d && news(b)) d = 1;
        if (b.urgent && !b.breaks.length) b.urgent = false;
      }
      return d;
    },
    /// The batch for planet `zone`, B = [zone, [tokenId, x, y, z, yaw, botFlags, breaks], ...] (only the bots with
    /// something new; of the ones a flight leaves home, only their last breaks), or null. What it takes counts as sent.
    take(zone) {
      const B = [zone];
      for (const b of bots.values()) {
        if (!b.live || !b.holder || (!b.breaks.length && (b.replace || b.leaving || !news(b)))) continue;
        const p = b.body.pos, flags = (b.mining ? BOT_MINING : 0) | (b.jumped ? BOT_JUMP : 0);
        B.push([b.tok, wrap(r2(p.x)), r2(p.y), wrap(r2(p.z)), r2(turnBy(b.yaw)), flags, b.breaks.splice(0)]);
        b.sent = { x: p.x, y: p.y, z: p.z, yaw: b.yaw, flags };
        b.jumped = b.dirty = b.urgent = false;
        b.foot0 = null;
      }
      return B.length > 1 ? B : null;
    },
    /// Bots the world server has out on this connection.
    get count() { let n = 0; for (const b of bots.values()) if (b.live) n++; return n; },
    sleep() {},
    /// Back from a hidden tab: every bot's place goes again (the server may have rebuilt them).
    wake() { for (const b of bots.values()) { b.dirty = true; b.prev.copy(b.body.pos); } },
    /// A flight's ["zone", ...] goes now (net.js fly), right after the last carrier took every bot's last breaks:
    /// recalled and worn-out bots say "off" first (so the server takes them back here, with their pickaxes); of the
    /// ones it leaves home, those the server doesn't have out stay home now, the others once the server says so (off).
    depart() {
      if (flight) flight.departed = true;
      for (const b of [...bots.values()]) {
        // (Breaks the last carrier couldn't take stay here, unpaid: on the next planet the server would check them
        // against its ground.)
        b.breaks.length = 0;
        b.foot0 = null;
        if ((b.recall || b.broken) && b.live && !b.offSent && net()?.sendBot("off", b.tok)) b.offSent = true;
        if (!b.leaving) continue;
        if (b.live) b.departed = true;
        else { inv.setStay(b.tok, true); remove(b); }
      }
      opts.changed?.();
    },
  };

  // ---------------------------------------------------------------- what the world server says
  /// ["botok", tokenId, tier, level, today, cap, pickId, wear]: it's out (or its state changed: a recheck).
  function ok(tok, tier, level, today, cap, pickId, wear) {
    const e = inv.bot(tok);
    // A bot this game doesn't keep (or a deploy recalled while the server read the chain: calledBack): let it go (its
    // botoff is the server's last word, off).
    if (!e) { net()?.sendBot("off", tok); return; }
    // Holding a pickaxe this bot doesn't hold, nor is being handed (holds): an earlier deploy's, not this one. The
    // server lets it go (that botoff is ignored, off), and this one is asked for again in a moment.
    if (Number.isInteger(pickId) && !holds(e, bots.get(tok), pickId, wear)) {
      net()?.sendBot("off", tok);
      const s = bots.get(tok);
      if (s) {
        s.live = false;
        s.asked = 0;
        s.retryAt = performance.now() + RETRY_MS[Math.min(s.tries++, RETRY_MS.length - 1)];
        s.breaks.length = 0;
        s.foot0 = null;
        s.target = null;
      }
      return opts.changed?.();
    }
    const b = bots.get(tok) ?? make(tok, e);
    b.live = true;
    b.asked = b.tries = b.retryAt = 0;
    b.why = null;
    b.inZone = false;
    if (Number.isInteger(tier) && tier >= 0 && tier <= 2) b.tier = tier;
    if (Number.isInteger(level) && level >= 1) b.level = level;
    b.boost = itemBoost("crafter", b.tier, b.level);
    if (Number.isFinite(today)) { b.today = today; b.todayDay = day(); }
    if (Number.isFinite(cap)) b.cap = cap;
    b.capDay = b.cap !== null && b.today >= b.cap ? day() : -1; // (a cap raised above today, by a level up: on again)
    if (e.stay) inv.setStay(tok, false);
    if (e.next && pickId === e.next.id && pickId !== e.id) { inv.pickSwapped(tok, null, null); b.av?.hold(heldModel(pickId)); }
    if (!b.holder) appear(b);
    b.dirty = true;
    opts.changed?.();
  }
  /// ["botoff", tokenId, why, retry, pickId, wear]: it's back. Its pickaxe comes back to your bag (or waits in the
  /// Autopilot box), unless it stayed home for a trip (it goes out again once you're home), or it may try again later
  /// (retry), or it was being sent out again in a zone (it waits for home, then tries again there). No pickaxe:
  /// `wear` -1 means it's lost (broken, or in a loot chest), null that the server didn't have it out (the game's own
  /// copy comes back).
  function off(tok, why, retry, pickId, wear) {
    const b = bots.get(tok), e = inv.bot(tok);
    if (!e) {
      // (The server's last word on a deploy recalled while it read the chain: its pickaxe is in your bag already.)
      const c = calledBack.get(tok);
      if (c && (pickId === null || pickId === c.id)) calledBack.delete(tok);
      remove(b);
      return opts.changed?.();
    }
    // "Not here" (no pickaxe, no reason) answers an "off" of this game's: back for one it asked back (recalled, worn
    // out), with the pickaxe this game keeps (below); about any other (an earlier ask called off, or let go by ok) it
    // says nothing about this one.
    if (pickId === null && wear === null && why === null && !b?.recall && !b?.broken) return;
    // A pickaxe this bot doesn't hold, nor is being handed (holds): about an earlier deploy (or a change undone), not
    // this one. (If this one waits for its answer, it's asked again now: the server may have dropped it while it held
    // the token.)
    if (pickId !== null && !holds(e, b, pickId, wear)) {
      if (b && !b.live && b.asked) { b.asked = 0; b.retryAt = performance.now(); }
      return;
    }
    // (The one it was being handed: it holds that one now (the change went through and its botpick went astray, or the
    // server had no bot to hand it to and sent it back: it goes out again with it). The old one comes back.)
    if (pickId !== null && pickId === e.next?.id && pickId !== e.id) inv.pickSwapped(tok, null, null);
    if (pickId === null && wear === -1) return recalled(b ?? { tok }, why, null, null, true);
    // Left home by a flight that went (or that the server would only take later): it goes out again once you're home.
    if (b?.leaving && (retry || b.departed)) {
      inv.setStay(tok, true);
      remove(b);
      return opts.changed?.();
    }
    // Stayed home for a trip: away from home it waits. Back home it was being sent out again, and the server's no is
    // taken like any other's (it tries again later, or comes back with its pickaxe).
    if (e.stay && opts.zone() !== "home") { remove(b); return opts.changed?.(); }
    if (e.stay) inv.setStay(tok, false);
    if (retry && !b?.recall && !b?.broken) {
      const w = b ?? make(tok, e);
      w.live = false;
      w.asked = 0;
      w.why = why;
      w.retryAt = performance.now() + RETRY_MS[Math.min(w.tries++, RETRY_MS.length - 1)];
      w.breaks.length = 0;
      w.foot0 = null;
      w.target = null;
      unswap(tok); // (the server has no bot to hand a pickaxe to now: it goes out again with the one it had)
      return opts.changed?.();
    }
    if (b?.inZone && opts.zone() !== "home" && !b.recall && !b.broken) {
      inv.setStay(tok, true);
      remove(b);
      opts.toast?.(`Bot #${tok} goes out again once you're home${why ? ` (${why})` : ""}.`);
      return opts.changed?.();
    }
    recalled(b ?? { tok }, why, pickId, wear);
  }
  /// Bot b is back for good: its pickaxe returns (unless it's `lost`), and you're told.
  function recalled(b, why, pickId, wear, lost = false) {
    const quiet = !!b.broken;
    remove(bots.get(b.tok));
    const where = lost ? inv.dropBot(b.tok) : inv.giveBack(b.tok, pickId, wear);
    if (!quiet || why) {
      const back = where === "returned" ? " Your bag is full: its pickaxe waits in the Autopilot box (M)." : where === "bag" ? " Its pickaxe is back in your bag." : "";
      opts.toast?.(`Bot #${b.tok} ${why ? `is back: ${String(why).replace(/\.$/, "")}` : "is back"}.${back}`, why ? "bad" : "");
    }
    opts.changed?.();
  }
  /// ["botpick", tokenId, oldPickId, oldWear]: it holds its new pickaxe; the old one comes back.
  function picked(tok, oldId, oldWear) {
    inv.pickSwapped(tok, oldId, oldWear);
    const b = bots.get(tok);
    if (b) b.pickSent = false;
    b?.av?.hold(heldModel(inv.bot(tok)?.id ?? 0));
    opts.changed?.();
  }
  /// ["botearn", [[tokenId, units, today, cap, why], ...], walletTotal]: what the batch paid. Returns { units (all the
  /// bots' together), big ([tokenId, units] for the bigger ones, to show) }.
  function earn(list) {
    let units = 0;
    const big = [], today = day();
    for (const [tok, u, t, cap, why] of list) {
      const b = bots.get(tok);
      if (why === BOT_WORLD_CAP) worldDay = today;
      if (!b) continue;
      if (Number.isFinite(t)) { b.today = t; b.todayDay = today; }
      if (Number.isFinite(cap)) b.cap = cap;
      b.said = why;
      if (why === BOT_AT_CAP) b.capDay = today;
      else if (Number.isFinite(t) && Number.isFinite(cap) && t < cap) b.capDay = -1; // (its cap went up meanwhile)
      if (u > 0) { units += u; if (u >= 20_000) big.push([tok, u]); }
    }
    opts.changed?.();
    return { units, big };
  }
  /// ["bothit", tokenId, hp, attackerName] (Red Mesa): someone's hitting a bot of yours.
  function hit(tok, hp, by) {
    const b = bots.get(tok);
    if (!b) return;
    b.hp = Number.isFinite(hp) ? hp : b.hp;
    if (performance.now() - hitSaid > 3000) {
      hitSaid = performance.now();
      opts.toast?.(`${by ?? "Someone"} is hitting your bot #${tok} (${Math.max(0, b.hp)}/${BOT_HP})`, "bad");
    }
  }
  /// ["botko", tokenId, attackerName]: it was beaten; its pickaxe is in a loot chest where it fell (anyone there may
  /// take it), and it's gone (a botoff with no pickaxe follows).
  function ko(tok, by) {
    inv.dropBot(tok);
    remove(bots.get(tok));
    const text = `${by ?? "Someone"} beat your bot #${tok}: its pickaxe is in a loot chest where it fell, for 5 minutes.`;
    opts.toast?.(text, "bad");
    opts.say?.(text);
    opts.changed?.();
  }

  // ---------------------------------------------------------------- your side
  /// Sends out every bot the bag's store keeps that isn't out (after signing in, a reconnect, landing): all of them at
  /// home; in a zone, the ones that flew there (the server knows which tickets they had).
  function redeploy() {
    if (!opts.signedIn() || !net()?.online) return;
    const home = opts.zone() === "home", now = performance.now();
    for (const [tok, e] of inv.bots()) {
      if (e.stay && !home) continue;
      const b = bots.get(tok) ?? make(tok, e);
      if (b.live || b.recall || b.leaving || (b.asked && now - b.asked < ASK_MS) || b.retryAt > now) continue;
      ask(b, now);
    }
    opts.changed?.();
  }
  /// A block the room set (someone placed or broke one, or an undo): anything but air is no longer natural for bots.
  function setBlock(x, y, z, block) {
    if (block === AIR || !Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(z)) return;
    x = wrap(x); z = wrap(z);
    const k = chunkOf(x, z);
    if (!placed.has(k)) placed.set(k, new Set());
    placed.get(k).add(index(x % CHUNK, y, z % CHUNK));
  }
  /// You changed a block in the chunk holding (x, z) (it counts towards the minute's chunks).
  function edited(x, z) { editMin.set(chunkOf(x, z), performance.now()); }
  /// What the HUD and the panel show, as a string (to tell when it changed).
  function summaryKey(paused) {
    let s = `${paused}|${inv.bots().length}`;
    for (const b of bots.values()) s += `|${b.tok}:${b.live}:${b.capDay}:${b.broken}:${b.recall}:${b.retryAt > 0}`;
    return s;
  }
  /// Whether a new bot can go out now, and if not why (in words).
  function cannot(tok = null) {
    if (!opts.signedIn()) return "Sign in to earn first.";
    if (!net()?.online) return "The world server is offline right now.";
    if (opts.zone() !== "home") return "New bots go out on the home planet only.";
    if (tok !== null && inv.bot(tok)) return `Bot #${tok} is out already.`;
    if (tok !== null && callingBack(tok)) return `Bot #${tok} is still coming back: try again in a moment.`;
    if (inv.bots().length >= BOT_MAX) return `${BOT_MAX} bots at once at the most.`;
    return null;
  }
  return {
    update, draw, wire, cannot,
    /// The bots in play, by token id (for testing).
    list: bots,
    /// Sends DEGEN `tok` (its `traits`, packed for the store as `look`) out with the pickaxe in bag slot `slot`.
    /// Returns why not, or null.
    deploy(tok, slot, look) {
      const why = cannot(tok);
      if (why) return why;
      const e = inv.lend(slot, tok, look);
      if (!e) return "Pick a pickaxe from your bag.";
      ask(make(tok, e), performance.now());
      opts.changed?.();
      return null;
    },
    /// Brings bot `tok` back (its last breaks go first). One that isn't out comes back at once; one the server is still
    /// deploying is called back (calledBack: that DEGEN waits for the server's last word on it before it can go out).
    recall(tok) {
      const b = bots.get(tok);
      if (b?.live) { b.recall = true; b.urgent = true; b.leaving = b.departed = false; }
      else {
        const e = inv.bot(tok);
        if (b?.asked && e && net()?.sendBot("off", tok)) calledBack.set(tok, { id: e.id, d: e.d, at: performance.now() });
        recalled(b ?? { tok }, null, null, null);
      }
      opts.changed?.();
    },
    /// Hands bot `tok` the pickaxe in bag slot `slot` instead (the old one comes back once the server says so). Its
    /// breaks made with the old one go first, and it mines nothing until then (update sends the change).
    changePick(tok, slot) {
      const b = bots.get(tok);
      if (!b?.live || b.recall || b.broken || b.leaving) return "It isn't out right now.";
      if (!net()?.online) return "The world server is offline right now.";
      const p = inv.swapPick(tok, slot);
      if (!p) return "Pick a pickaxe from your bag.";
      b.pickSent = false;
      b.urgent = true;
      b.target = b.goal = b.run = null;
      opts.changed?.();
      return null;
    },
    /// Asks the world server to read bot `tok`'s DEGEN again (it was just leveled up).
    recheck(tok) { if (bots.get(tok)?.live) net()?.sendBot("recheck", tok); },
    redeploy,
    /// The bots that fly with you (the ones out), as token ids.
    flyList: () => [...bots.values()].filter((b) => b.live && !b.recall && !b.broken && !b.leaving).map((b) => b.tok),
    /// Whether a bot is still being sent out, or called back while it was (a flight waits for it: so does the server).
    get pending() {
      const now = performance.now();
      return [...calledBack.keys()].some(callingBack) || [...bots.values()].some((b) => !b.live && !b.recall && b.asked && now - b.asked < ASK_MS && !b.retryAt);
    },
    /// A flight to `to` takes off with bots `toks`. The others stay home (their pickaxes wait for you there): they stop
    /// now and their last breaks go at once, but they're only left home once the flight goes (wire.depart) and the
    /// server says so (off), since it may refuse the flight (landed). Bots being recalled or worn out aren't left
    /// home: they come back as they were going to.
    flying(to, toks) {
      const going = new Set(toks);
      flight = { to, departed: false };
      for (const b of bots.values()) {
        b.target = b.goal = b.run = b.cands = b.scan = null;
        if (going.has(b.tok) || b.recall || b.broken) continue;
        b.leaving = true;
        b.departed = false;
        hold(b);
        if (b.breaks.length) b.urgent = true;
      }
      opts.changed?.();
    },
    /// You're on another planet now (a flight, a restore, sent home), or it grew back: the bots come to you there, and
    /// back home the ones that stayed go out again. Put back where you were after a flight went (the server refused
    /// it), the bots it was leaving home carry on: the server still has them out.
    landed() {
      const refused = !!flight?.departed && opts.zone() !== flight.to;
      if (refused) flight = null;
      for (const b of bots.values()) {
        if (refused && b.leaving) b.leaving = b.departed = false;
        b.breaks.length = 0; // (any still here were made on the ground it was on: see depart)
        b.foot0 = null;
        b.target = b.goal = b.run = b.cands = b.scan = null;
        b.follow = false;
        if (b.holder) b.replace = true;
        b.dirty = true;
      }
      placed.clear();
      avoid.clear();
      editMin.clear();
      redeploy();
    },
    ok, off, picked, earn, hit, ko,
    /// ["botidle", 0|1]: the server paused your bots for idleness, or let them work again.
    idle(on) { serverIdle = !!on; opts.changed?.(); },
    /// The connection dropped: every bot waits until the server has it out again (botok). The server forgot them all
    /// with it: a flight's left-home bots stay home now, a deploy called back is over, and a pickaxe change it hadn't
    /// answered is undone (the new one back in your bag).
    closed() {
      for (const b of [...bots.values()]) {
        if (b.leaving) { inv.setStay(b.tok, true); remove(b); continue; }
        b.live = false;
        b.asked = b.retryAt = 0;
        b.breaks.length = 0;
        b.foot0 = null;
        b.target = null;
        b.urgent = false;
        b.offSent = false;
        b.pickSent = false;
      }
      calledBack.clear();
      inv.cancelSwaps();
      serverIdle = false;
      opts.changed?.();
    },
    /// Connected again: a new connection starts with no activity (the server's bots wait for your first action).
    connected() { activeAt = 0; serverIdle = false; },
    /// Signed out (or in somewhere else, or another wallet): the bots leave this game; the bag's store keeps them
    /// (they go out again the next time this wallet signs in here). Only what the server forgot with them is written:
    /// a pickaxe change it hadn't answered is undone, and a bot a flight was leaving home stays home. (The server's
    /// idle pause stays: it's the connection's, and only its ["botidle", 0] ends it.)
    signedOut() {
      for (const b of [...bots.values()]) {
        if (b.leaving) inv.setStay(b.tok, true); // (left home by a flight: it waits for home)
        remove(b);
      }
      calledBack.clear();
      inv.cancelSwaps();
      flight = null;
      opts.changed?.();
    },
    /// You just did something the world server counts as activity (the game sent it). (Only the server's ["botidle",
    /// 0] ends its pause: it may not have accepted this one.)
    active() {
      const was = pausedWhy();
      activeAt = performance.now();
      if (was !== pausedWhy()) opts.changed?.();
    },
    /// You're up again (respawned or revived): bots the server refused meanwhile (you were knocked out) try again now.
    up() {
      const now = performance.now();
      for (const b of bots.values()) if (!b.live && !b.recall && !b.leaving && b.retryAt > now) b.retryAt = now;
    },
    /// The room's edits for chunk `k` ([index, block] pairs): the placed blocks there.
    edits(k, list) {
      const s = new Set();
      for (const [i, block] of list) if (block !== AIR) s.add(i);
      if (s.size) placed.set(k, s);
      else placed.delete(k);
    },
    set: setBlock,
    /// You placed a block at (x, y, z).
    placedAt(x, y, z) { setBlock(x, y, z, 1); edited(x, z); },
    /// Whether the block at (x, y, z) is natural, as far as this game knows (no player placed it).
    natural: (x, y, z) => !isPlaced(x, y, z),
    edited,
    /// Chunk `k` was dropped from memory (its edits come again with it).
    forget(k) { placed.delete(k); },
    /// Your name changed: the bots' tags follow.
    rename() {
      for (const b of bots.values()) {
        if (!b.holder) continue;
        b.av.root.remove(b.tag);
        b.tag.material.map?.dispose();
        b.tag.material.dispose();
        b.tag = nameTag(botName(opts.owner(), b.tok));
        b.av.root.add(b.tag);
      }
    },
    /// The Autopilot box's rows: every bot the bag's store keeps, with its state.
    roster() {
      const now = performance.now(), paused = pausedWhy(now), today = day();
      return inv.bots().map(([tok, e]) => {
        const b = bots.get(tok), traits = b?.traits ?? unpackTraits(e.look);
        const tier = b?.tier ?? (traits ? rarityOf(traits) : 0), level = b?.level ?? null;
        let state;
        if (e.stay && opts.zone() !== "home") state = "Stayed home: it goes out again once you're home";
        else if (!b) state = "Not out: it goes out once you're signed in here";
        else state = (waitsWhy(b) ?? (paused ? `Paused: ${paused}` : null) ?? (b.status || "out")).replace(/^./, (c) => c.toUpperCase());
        const note = b?.live && b.said === BOT_SETTLING ? "Settling: no pay for a moment"
          : b?.live && b.said === BOT_TOO_FAR ? "Too far from you to be paid"
          : b?.live && b.said === BOT_IDLE ? "Not paid: you've been idle"
          : b?.live && b.said === BOT_REFUSED ? "A break wasn't accepted" : null;
        return {
          tok, traits, tier, level, boost: itemBoost("crafter", tier, level ?? 1), pick: { id: e.id, d: e.d }, next: e.next ?? null,
          stay: !!e.stay, live: !!b?.live, today: b && b.todayDay === today ? b.today : 0, cap: b?.cap ?? null, state, note,
          hp: b?.hp ?? BOT_HP,
        };
      });
    },
    /// For the HUD: { n (bots kept), out (out now), today (units, together), paused (why they all wait, or null), each
    /// ([tokenId, today, cap]) }.
    summary() {
      const today = day();
      let out = 0, sum = 0;
      const each = [];
      for (const b of bots.values()) {
        if (b.live) out++;
        const t = b.todayDay === today ? b.today : 0;
        sum += t;
        each.push([b.tok, t, b.cap]);
      }
      return { n: inv.bots().length, out, today: sum, paused: pausedWhy(), each };
    },
  };
}
