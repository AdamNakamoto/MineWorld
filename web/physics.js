// Box-against-blocks movement for the player and the monsters: gravity, swimming, and sliding along walls one axis
// at a time. `pos` is the bottom centre of the box; `half` its half width, `h` its height. The world wraps round with
// no border (world.get wraps), so a box can stand across the seam; whoever moves it wraps its position afterwards.
//
// The player moves the way Minecraft Java's does (stepPlayer): in fixed ticks, 20 a second, with its per-tick rules
// (LivingEntity.travel). Most of its feel is in these few numbers: a push that builds up against friction, so you
// get going and stop over a few ticks rather than at once, and a jump that's high and quick. The monsters keep their
// own simpler physics (moveBox).

import { WATER } from "./blocks.js";
import { wrapDelta } from "./rules.js";

const EPS = 1e-3;
export const GRAVITY = 28; // the monsters' (moveBox), in metres per second per second

/// The player's tick, in seconds: the game steps the player 20 times a second and draws in between (main.js).
export const TICK = 1 / 20;
/// Minecraft Java's player movement, per tick, in blocks per tick (multiply by 20 for metres per second). On flat
/// ground this gives walking 4.317 m/s, sprinting 5.612, sneaking about 1.3, a 1.25-block jump and sprint-jumping at
/// about 7.1.
export const MOVE = {
  input: 0.98, // each key's push is scaled by this first
  walk: 0.1, // the push on the ground (the player's movement speed)
  sprint: 1.3, // sprinting multiplies it by this
  sneak: 0.3, // sneaking multiplies the keys' push by this
  using: 0.2, // and eating by this
  air: 0.02, airSprint: 0.026, // the push in the air (sprinting)
  slip: 0.6, // a block's slipperiness: on the ground the speed left after a tick is slip x drag (0.546)
  drag: 0.91, // in the air, the horizontal speed left after a tick
  gravity: 0.08, fallDrag: 0.98, // vertical: v = (v - gravity) x fallDrag, so falling tops out at 3.92 a tick
  jump: 0.42, // a jump's upward speed
  sprintJump: 0.2, // and the push a sprint-jump adds the way you face
  jumpDelay: 10, // ticks: holding jump jumps again no sooner than this
  rest: 0.003, // a speed below this stops
  // In water: a weaker push, more drag, a slow sink, rising while jump is held, and a hop up out of the water at a
  // bank (a wall whose top is within `bank` above).
  water: { push: 0.02, drag: 0.8, sink: 0.005, rise: 0.04, hop: 0.3, bank: 0.6 },
  edge: 0.6, edgeStep: 0.05, // sneaking: you stay over a block within this far down, backing off in these steps
};

function hits(world, pos, half, h) {
  const out = [];
  const x0 = Math.floor(pos.x - half), x1 = Math.floor(pos.x + half - 1e-9);
  const y0 = Math.floor(pos.y), y1 = Math.floor(pos.y + h - 1e-9);
  const z0 = Math.floor(pos.z - half), z1 = Math.floor(pos.z + half - 1e-9);
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) {
    if (world.solid(x, y, z)) out.push([x, y, z]);
  }
  return out;
}

function moveAxis(world, pos, a, d, half, h) {
  if (!d) return false;
  pos[a] += d;
  const hit = hits(world, pos, half, h);
  if (!hit.length) return false;
  const i = a === "x" ? 0 : a === "y" ? 1 : 2;
  if (a === "y") {
    pos.y = d < 0 ? Math.max(...hit.map((b) => b[1] + 1)) : Math.min(...hit.map((b) => b[1])) - h - EPS;
  } else if (d > 0) {
    pos[a] = Math.min(...hit.map((b) => b[i])) - half - EPS;
  } else {
    pos[a] = Math.max(...hit.map((b) => b[i] + 1)) + half + EPS;
  }
  return true;
}

export function inWater(world, pos, h) {
  return world.get(Math.floor(pos.x), Math.floor(pos.y + h * 0.4), Math.floor(pos.z)) === WATER;
}

/// Moves the box by its velocity over `dt`, in small steps so nothing tunnels through a block.
/// Returns { onGround, wall, water }.
export function moveBox(world, pos, vel, half, h, dt) {
  const water = inWater(world, pos, h);
  vel.y -= GRAVITY * (water ? 0.25 : 1) * dt;
  if (water) vel.y = Math.max(vel.y, -3);
  else vel.y = Math.max(vel.y, -50);
  const steps = Math.max(1, Math.ceil((Math.abs(vel.x) + Math.abs(vel.y) + Math.abs(vel.z)) * dt / 0.4));
  const s = dt / steps;
  let onGround = false, wall = false;
  for (let k = 0; k < steps; k++) {
    if (moveAxis(world, pos, "y", vel.y * s, half, h)) {
      if (vel.y < 0) onGround = true;
      vel.y = 0;
    }
    if (moveAxis(world, pos, "x", vel.x * s, half, h)) { vel.x = 0; wall = true; }
    if (moveAxis(world, pos, "z", vel.z * s, half, h)) { vel.z = 0; wall = true; }
  }
  return { onGround, wall, water };
}

/// Whether any solid block overlaps the box of half width `half` from (x, y, z) up to y + h.
function anySolid(world, x, y, z, half, h) {
  const x0 = Math.floor(x - half), x1 = Math.floor(x + half - 1e-9);
  const y0 = Math.floor(y), y1 = Math.floor(y + h - 1e-9);
  const z0 = Math.floor(z - half), z1 = Math.floor(z + half - 1e-9);
  for (let bx = x0; bx <= x1; bx++) for (let by = y0; by <= y1; by++) for (let bz = z0; bz <= z1; bz++) {
    if (world.solid(bx, by, bz)) return true;
  }
  return false;
}

/// Sneaking on the ground: shortens a step (dx, dz) until the box still has a block under it (within MOVE.edge
/// down), the way Minecraft backs you off an edge. Returns [dx, dz].
function backOffEdge(world, pos, dx, dz, half) {
  const { edge, edgeStep: s } = MOVE;
  const under = (x, z) => anySolid(world, x, pos.y - edge, z, half, edge);
  const less = (d) => (Math.abs(d) < s ? 0 : d - Math.sign(d) * s);
  while (dx !== 0 && !under(pos.x + dx, pos.z)) dx = less(dx);
  while (dz !== 0 && !under(pos.x, pos.z + dz)) dz = less(dz);
  while (dx !== 0 && dz !== 0 && !under(pos.x + dx, pos.z + dz)) { dx = less(dx); dz = less(dz); }
  return [dx, dz];
}

/// Moves the box by (dx, dy, dz) blocks, up and down first, then across, sliding along what it meets, in steps short
/// enough that nothing tunnels through a block. Says which ways it was stopped.
function slide(world, pos, dx, dy, dz, half, h) {
  const steps = Math.max(1, Math.ceil((Math.abs(dx) + Math.abs(dy) + Math.abs(dz)) / 0.4));
  let hitX = false, hitY = false, hitZ = false;
  for (let k = 0; k < steps; k++) {
    if (!hitY && moveAxis(world, pos, "y", dy / steps, half, h)) hitY = true;
    if (!hitX && moveAxis(world, pos, "x", dx / steps, half, h)) hitX = true;
    if (!hitZ && moveAxis(world, pos, "z", dz / steps, half, h)) hitZ = true;
  }
  return { hitX, hitY, hitZ };
}

const _v = { x: 0, y: 0, z: 0 };
/// One tick of the player's movement, Minecraft Java's way (MOVE). `p`: { pos, vel (metres per second), onGround,
/// water, jumpDelay }, updated in place. `inp`: { strafe (right +), forward (each -1..1, already scaled for sneaking or
/// eating), yaw, jump, sprint, sneak, speed (the move boost's multiplier) }. Returns { hitX, hitZ, wall, dx, dz (the
/// step taken across, blocks), jumped }.
export function stepPlayer(world, p, inp, half, h) {
  const v = _v, W = MOVE.water;
  v.x = p.vel.x * TICK; v.y = p.vel.y * TICK; v.z = p.vel.z * TICK;
  if (Math.abs(v.x) < MOVE.rest) v.x = 0;
  if (Math.abs(v.y) < MOVE.rest) v.y = 0;
  if (Math.abs(v.z) < MOVE.rest) v.z = 0;
  const fx = -Math.sin(inp.yaw), fz = -Math.cos(inp.yaw); // the way you face
  // Jumping (or rising in water).
  let jumped = false;
  if (p.jumpDelay > 0) p.jumpDelay--;
  if (inp.jump) {
    if (p.water) v.y += W.rise;
    else if (p.onGround && p.jumpDelay === 0) {
      v.y = MOVE.jump;
      if (inp.sprint) { v.x += fx * MOVE.sprintJump; v.z += fz * MOVE.sprintJump; }
      p.jumpDelay = MOVE.jumpDelay;
      jumped = true;
    }
  } else p.jumpDelay = 0;
  // The keys' push, turned the way you face (a diagonal is no faster than straight on).
  let s = inp.strafe * MOVE.input, f = inp.forward * MOVE.input;
  const n = s * s + f * f;
  if (n > 1) { const k = 1 / Math.sqrt(n); s *= k; f *= k; }
  const push = p.water ? W.push
    : (p.onGround ? MOVE.walk * (inp.sprint ? MOVE.sprint : 1) : inp.sprint ? MOVE.airSprint : MOVE.air) * inp.speed;
  v.x += (fx * f - fz * s) * push;
  v.z += (fz * f + fx * s) * push;
  // The move (sneaking keeps you on the block you're on).
  let dx = v.x, dz = v.z;
  if (inp.sneak && p.onGround && v.y <= 0 && !p.water) [dx, dz] = backOffEdge(world, p.pos, dx, dz, half);
  const x0 = p.pos.x, y0 = p.pos.y, z0 = p.pos.z;
  const r = slide(world, p.pos, dx, v.y, dz, half, h);
  if (r.hitX) v.x = 0;
  if (r.hitZ) v.z = 0;
  const onGround = r.hitY && v.y < 0;
  if (r.hitY) v.y = 0;
  // Then drag (and gravity), from where you were at the tick's start: on the ground or in the air, or in water.
  if (p.water) {
    v.x *= W.drag; v.z *= W.drag;
    v.y = v.y * W.drag - W.sink;
    // Swimming into a bank whose top is just above: a hop up onto it.
    if ((r.hitX || r.hitZ) && !anySolid(world, p.pos.x + v.x, y0 + v.y + W.bank, p.pos.z + v.z, half, h)) v.y = W.hop;
  } else {
    const k = p.onGround ? MOVE.slip * MOVE.drag : MOVE.drag;
    v.x *= k; v.z *= k;
    v.y = (v.y - MOVE.gravity) * MOVE.fallDrag;
  }
  p.onGround = onGround;
  p.water = inWater(world, p.pos, h);
  p.vel.set(v.x / TICK, v.y / TICK, v.z / TICK);
  return { hitX: r.hitX, hitZ: r.hitZ, wall: r.hitX || r.hitZ, dx: p.pos.x - x0, dz: p.pos.z - z0, jumped };
}

/// Whether a box at `pos` would overlap a solid block (used before placing a block where someone stands). The block
/// may be written on either side of the seam.
export function boxHitsBlock(pos, half, h, bx, by, bz) {
  bx = pos.x + wrapDelta(bx + 0.5 - pos.x) - 0.5;
  bz = pos.z + wrapDelta(bz + 0.5 - pos.z) - 0.5;
  return bx + 1 > pos.x - half && bx < pos.x + half && by + 1 > pos.y && by < pos.y + h && bz + 1 > pos.z - half && bz < pos.z + half;
}
