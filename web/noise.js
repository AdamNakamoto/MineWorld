// The noise every world is made from (worldgen.js for the home planet, zonegen.js for the rocket's zones). Only
// integer hashing and plain arithmetic (no Math.random, sin or pow), so the game and the world server, in any
// JavaScript engine, get exactly the same numbers.
//
// Every planet wraps round every WORLD blocks in x and z (rules.js), so the lattices here have a whole number of cells
// across the world and their corners are hashed modulo that number.

import { WORLD } from "./rules.js";

export function hash(x, y, z, s) {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(z | 0, 0x1b873593) ^ Math.imul(s, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return (h ^ (h >>> 15)) >>> 0;
}
export const rand = (x, y, z, s) => hash(x, y, z, s) / 4294967296;
export const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
export const lerp = (a, b, t) => a + (b - a) * t;
export const mod = (v, p) => ((v % p) + p) % p;

// Gradient noise that repeats every WORLD blocks in x and z: `p` lattice cells across the world (a whole number), at
// block (x, z). (x * p is a whole number and WORLD a power of two, so the lattice position is exact wherever x is
// written: x and x + WORLD land on the same cell at the same place in it.)
const G2 = [[1, 1], [-1, 1], [1, -1], [-1, -1], [1, 0], [-1, 0], [0, 1], [0, -1]];
export function noise2(x, z, p, s) {
  const X = (x * p) / WORLD, Z = (z * p) / WORLD;
  const x0 = Math.floor(X), z0 = Math.floor(Z);
  const fx = X - x0, fz = Z - z0;
  const i0 = mod(x0, p), j0 = mod(z0, p);
  const i1 = i0 + 1 === p ? 0 : i0 + 1, j1 = j0 + 1 === p ? 0 : j0 + 1;
  const g = (ix, iz, dx, dz) => {
    const v = G2[hash(ix, iz, 0, s) & 7];
    return v[0] * dx + v[1] * dz;
  };
  const u = fade(fx), v = fade(fz);
  return lerp(
    lerp(g(i0, j0, fx, fz), g(i1, j0, fx - 1, fz), u),
    lerp(g(i0, j1, fx, fz - 1), g(i1, j1, fx - 1, fz - 1), u),
    v,
  );
}
/// Octaves of noise2, each with twice the cells of the last (so each still wraps).
export function fbm2(x, z, p, s, octaves) {
  let sum = 0, amp = 1, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += noise2(x, z, p << i, s + i * 101) * amp;
    norm += amp;
    amp *= 0.5;
  }
  return sum / norm;
}

const G3 = [[1, 1, 0], [-1, 1, 0], [1, -1, 0], [-1, -1, 0], [1, 0, 1], [-1, 0, 1], [1, 0, -1], [-1, 0, -1],
  [0, 1, 1], [0, -1, 1], [0, 1, -1], [0, -1, -1], [1, 1, 0], [-1, 1, 0], [0, -1, 1], [0, -1, -1]];
/// 3D noise for caves: `p` cells across the world in x and z (wrapping as noise2), and one cell every `sy` blocks up.
export function noise3(x, y, z, p, sy, s) {
  const X = (x * p) / WORLD, Y = y / sy, Z = (z * p) / WORLD;
  const x0 = Math.floor(X), y0 = Math.floor(Y), z0 = Math.floor(Z);
  const fx = X - x0, fy = Y - y0, fz = Z - z0;
  const i0 = mod(x0, p), k0 = mod(z0, p);
  const i1 = i0 + 1 === p ? 0 : i0 + 1, k1 = k0 + 1 === p ? 0 : k0 + 1;
  const g = (ix, iy, iz, dx, dy, dz) => {
    const v = G3[hash(ix, iy, iz, s) & 15];
    return v[0] * dx + v[1] * dy + v[2] * dz;
  };
  const u = fade(fx), v = fade(fy), w = fade(fz);
  return lerp(
    lerp(
      lerp(g(i0, y0, k0, fx, fy, fz), g(i1, y0, k0, fx - 1, fy, fz), u),
      lerp(g(i0, y0 + 1, k0, fx, fy - 1, fz), g(i1, y0 + 1, k0, fx - 1, fy - 1, fz), u),
      v,
    ),
    lerp(
      lerp(g(i0, y0, k1, fx, fy, fz - 1), g(i1, y0, k1, fx - 1, fy, fz - 1), u),
      lerp(g(i0, y0 + 1, k1, fx, fy - 1, fz - 1), g(i1, y0 + 1, k1, fx - 1, fy - 1, fz - 1), u),
      v,
    ),
    w,
  );
}
