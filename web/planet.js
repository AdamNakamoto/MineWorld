// The world drawn as a small planet. The rules, physics and aiming stay flat (a square world that wraps round,
// rules.js); only what's drawn is bent: a point at flat distance d from the camera (the short way round) and height y
// is shown about d / PLANET_R radians round a sphere whose circumference is the world's width, at radius PLANET_R
// plus its height above PLANET_Y, and tilted to match. So the ground curves away below the horizon, and what's across
// the seam meets up on the far side. Near the camera (within BEND_NEAR blocks, past anything you can reach) nothing
// moves; the bend eases in from there to BEND_FAR.
//
// The chunk shader (world.js) bends every vertex with BEND_GLSL; everything else drawn in the world (monsters,
// players, the block outline, debris, signs) is bent as a whole with bend() / place() each frame, after follow().
//
// The planet has one size: height PLANET_Y is at radius PLANET_R, and every height h at PLANET_R + h - PLANET_Y, each
// column standing straight up from the centre. But blocks at your own height shouldn't look stretched (on a mountain
// top, where the planet is wider than PLANET_R) or squeezed (in a cave) just past the ease-in, so the angle round the
// planet grows with distance at the rate that keeps your own level true near you (1 / your radius), changing over to
// 1 / PLANET_R by BEND_SPREAD blocks out: past that the planet is the planet, seen from wherever you are.

import * as THREE from "https://esm.sh/three@0.160.0";
import { WORLD, wrapDelta } from "./rules.js";

export const PLANET_R = WORLD / (2 * Math.PI); // about 81.5 blocks
export const PLANET_Y = 60; // the height at radius PLANET_R (the town's ground is 58)
export const BEND_NEAR = 6; // blocks: nothing closer than this moves (reach is 5)
export const BEND_FAR = 24; // and the full curve from here on
const BEND_SPREAD = 64; // the angle's rate changes over from your level's to the planet's between BEND_NEAR and this
const Y_FOLLOW_S = 1.5; // the camera's height is followed this slowly (so a jump doesn't make the world breathe)

/// The bend's centre (the camera, x and z) and the camera's height, followed slowly (cy). Updated by follow().
export const view = { x: 0, z: 0, cy: PLANET_Y, set: false };

/// Call once a frame with the camera's position (before bending anything). `dt` in seconds.
export function follow(cam, dt = 1) {
  const jumped = !view.set || Math.abs(wrapDelta(cam.x - view.x)) > 48 || Math.abs(wrapDelta(cam.z - view.z)) > 48;
  view.cy = jumped ? cam.y : view.cy + (cam.y - view.cy) * (1 - Math.exp(-dt / Y_FOLLOW_S));
  view.x = cam.x;
  view.z = cam.z;
  view.set = true;
  return view;
}

const smooth = (a, b, x) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
/// The angle round the planet of a point d blocks (flat) from the camera, whose own radius is rc: the integral of a
/// rate going smoothly from 1 / rc (to BEND_NEAR) to 1 / PLANET_R (from BEND_SPREAD).
function angle(d, rc) {
  const A = BEND_NEAR, B = BEND_SPREAD;
  const t = Math.max(0, Math.min(1, (d - A) / (B - A)));
  const I = d > B ? (B - A) / 2 + (d - B) : (B - A) * (t * t * t - (t * t * t * t) / 2);
  return d / rc + (1 / PLANET_R - 1 / rc) * I;
}
const camRadius = () => Math.max(8, PLANET_R + view.cy - PLANET_Y);

/// Where point `p` (flat world coordinates, any image of it) is drawn: written to `out` (a Vector3) and returned.
/// With `tilt` (a Quaternion), also the turn that stands an object at p upright on the curved ground there.
/// The shown point is in the image of the world nearest the camera (view.x, view.z).
export function bend(p, out = new THREE.Vector3(), tilt = null) {
  const dx = wrapDelta(p.x - view.x), dz = wrapDelta(p.z - view.z);
  const d = Math.sqrt(dx * dx + dz * dz);
  const w = smooth(BEND_NEAR, BEND_FAR, d);
  out.set(view.x + dx, p.y, view.z + dz);
  if (w <= 0) {
    tilt?.identity();
    return out;
  }
  const th = angle(d, camRadius()), r = PLANET_R + p.y - PLANET_Y, ux = dx / d, uz = dz / d;
  const h = r * Math.sin(th);
  out.x += (view.x + ux * h - out.x) * w;
  out.y += (PLANET_Y - PLANET_R + r * Math.cos(th) - out.y) * w;
  out.z += (view.z + uz * h - out.z) * w;
  if (tilt) {
    const a = th * w;
    tilt.setFromAxisAngle(_axis.set(uz, 0, -ux), a);
  }
  return out;
}
const _axis = new THREE.Vector3();

const _q = new THREE.Quaternion(), _p = new THREE.Vector3();
/// Stands object `obj` at flat point `p` on the curved world: its position bent, its quaternion the tilt there times
/// a turn of `yaw` about its own up (or times `local`, a Quaternion, if given). Returns obj.
export function place(obj, p, yaw = 0, local = null) {
  bend(p, obj.position, _q);
  if (local) obj.quaternion.copy(_q).multiply(local);
  else obj.quaternion.copy(_q).multiply(_yawQ.setFromAxisAngle(_up, yaw));
  return obj;
}
const _yawQ = new THREE.Quaternion(), _up = new THREE.Vector3(0, 1, 0);

/// The image of coordinate `v` nearest `ref` (both x or both z).
export const nearest = (v, ref) => ref + wrapDelta(v - ref);

/// The bounding sphere (centre written to `out.center`, radius to `out.radius`) of the box [x0, x1] x [y0, y1] x
/// [z0, z1] as it's drawn bent: from its eight corners, plus a margin for the curve between them.
export function bentBounds(x0, y0, z0, x1, y1, z1, out) {
  let n = 0;
  const c = out.center;
  c.set(0, 0, 0);
  for (let i = 0; i < 8; i++) {
    _p.set(i & 1 ? x1 : x0, i & 2 ? y1 : y0, i & 4 ? z1 : z0);
    bend(_p, _corners[i]);
    c.add(_corners[i]);
    n++;
  }
  c.multiplyScalar(1 / n);
  let r2 = 0;
  for (let i = 0; i < 8; i++) r2 = Math.max(r2, c.distanceToSquared(_corners[i]));
  out.radius = Math.sqrt(r2) + 2;
  return out;
}
const _corners = Array.from({ length: 8 }, () => new THREE.Vector3());

const F = (v) => v.toFixed(6);
/// The same bend for shaders: `vec3 bend(vec3 p)` of a world position (in the image nearest the camera), and
/// `float bendDist(vec3 p)`, the flat distance from the camera (for fog). Needs `uniform vec4 bendAt` = (view.x,
/// camera radius, view.z, 0): see uniforms().
export const BEND_GLSL = `
uniform vec4 bendAt;
float bendDist(vec3 p) { return length(p.xz - bendAt.xz); }
vec3 bend(vec3 p) {
  vec2 d = p.xz - bendAt.xz;
  float dist = length(d);
  float w = smoothstep(${F(BEND_NEAR)}, ${F(BEND_FAR)}, dist);
  if (w <= 0.0) return p;
  float rc = bendAt.y;
  float t = clamp((dist - ${F(BEND_NEAR)}) / ${F(BEND_SPREAD - BEND_NEAR)}, 0.0, 1.0);
  float I = dist > ${F(BEND_SPREAD)} ? ${F((BEND_SPREAD - BEND_NEAR) / 2)} + (dist - ${F(BEND_SPREAD)}) : ${F(BEND_SPREAD - BEND_NEAR)} * (t * t * t - 0.5 * t * t * t * t);
  float th = dist / rc + (${F(1 / PLANET_R)} - 1.0 / rc) * I;
  float r = ${F(PLANET_R)} + p.y - ${F(PLANET_Y)};
  vec2 u = d / dist;
  float h = r * sin(th);
  vec3 s = vec3(bendAt.x + u.x * h, ${F(PLANET_Y - PLANET_R)} + r * cos(th), bendAt.z + u.y * h);
  return mix(p, s, w);
}`;

/// The uniforms BEND_GLSL needs; update() copies the current view into them (call after follow()).
export function uniforms() {
  const u = { bendAt: { value: new THREE.Vector4() } };
  return { u, update: () => u.bendAt.value.set(view.x, camRadius(), view.z, 0) };
}
