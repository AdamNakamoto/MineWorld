// Box-against-blocks movement for the player and the monsters: gravity, swimming, and sliding along walls one axis
// at a time. `pos` is the bottom centre of the box; `half` its half width, `h` its height.

import { WATER } from "./blocks.js";
import { WORLD } from "./rules.js";

const EPS = 1e-3;
export const GRAVITY = 28;

function hits(world, pos, half, h) {
  const out = [];
  const x0 = Math.floor(pos.x - half), x1 = Math.floor(pos.x + half - 1e-9);
  const y0 = Math.floor(pos.y), y1 = Math.floor(pos.y + h - 1e-9);
  const z0 = Math.floor(pos.z - half), z1 = Math.floor(pos.z + half - 1e-9);
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) {
    if (world.solid(x, y, z) || (y >= 0 && (x < 0 || z < 0 || x >= WORLD || z >= WORLD))) out.push([x, y, z]);
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

/// Whether a box at `pos` would overlap a solid block (used before placing a block where someone stands).
export function boxHitsBlock(pos, half, h, bx, by, bz) {
  return bx + 1 > pos.x - half && bx < pos.x + half && by + 1 > pos.y && by < pos.y + h && bz + 1 > pos.z - half && bz < pos.z + half;
}
