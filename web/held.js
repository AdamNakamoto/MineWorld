// What a miner holds, as a model for their hand (your own, in first person and seen with V, and everyone else's),
// made the way Minecraft Java makes its item models: a block is a cube in its own textures; a tool, weapon, food,
// torch or plant is its 16 x 16 icon given one pixel of thickness (Minecraft's ItemModelGenerator). Either is a block
// across and centred on the origin (Minecraft's model spans 0..1 and is drawn offset by -0.5), x right, y up, the
// icon's own face towards +z. Then the model's display settings (the item models' "display") place it: in first
// person as Minecraft's (tools and weapons a touch further in, DISPLAY), in third person at Minecraft's size in the pose
// avatar.js gives it.
//
// Crystal things carry Minecraft's enchantment glint: a purple sheen that slides over the item's own pixels (never the
// clear ones round it), two layers at different angles and speeds, added on top of the lit colour, so it shows at night
// too. One model is made per item and shared by every hand holding it (its meshes are marked userData.shared, so an
// avatar's dispose() leaves them alone).

import * as THREE from "https://esm.sh/three@0.160.0";
import { BLOCKS, TORCH, WATER, TOOLS, ARMOR, STICK, CRYSTAL_PICK, CRYSTAL_SWORD } from "./blocks.js";
import { ATLAS_TILES, faceTiles, iconCanvas } from "./textures.js";

let atlas = null, atlasTex = null;
/// Call once with the block atlas: its canvas (for the icons) and the texture the world is drawn with.
export function setHeldAtlas(canvas, texture) {
  atlas = canvas;
  atlasTex = texture;
}

/// Points a box's UVs at atlas tiles, one per face (BoxGeometry's order: +x, -x, +y, -y, +z, -z; 4 vertices each).
export function tileUVs(geo, tilesForFaces) {
  const uv = geo.attributes.uv;
  const s = 1 / ATLAS_TILES;
  for (let f = 0; f < 6; f++) {
    const t = tilesForFaces[f], tx = t % ATLAS_TILES, ty = Math.floor(t / ATLAS_TILES);
    for (let k = 0; k < 4; k++) {
      const i = f * 4 + k;
      uv.setXY(i, (tx + uv.getX(i)) * s, 1 - (ty + 1 - uv.getY(i)) * s);
    }
  }
  uv.needsUpdate = true;
}

const isBlock = (id) => id < 64 && !BLOCKS[id]?.plant && id !== TORCH;
/// Which of Minecraft's three item models `id` uses: "handheld" (tools, weapons, the stick: held by the handle),
/// "block" (a cube), or "generated" (any other icon).
const modelOf = (id) => (isBlock(id) ? "block" : TOOLS[id] || id === STICK ? "handheld" : "generated");

/// Minecraft's display settings for each model (models/item/handheld.json, generated.json, block/block.json):
/// - first: firstperson_righthand, applied as Minecraft applies it (ItemTransform.apply): moved by translation
///   (sixteenths of a block), turned by rotation (degrees, Minecraft's rotationXYZ: x, then y, then z, each about the
///   turned axes), then scaled, about the model's middle. main.js puts it at the end of Minecraft's arm.
/// - third: thirdperson_righthand's scale, the model then held at `grip` (an icon pixel, x right and y down from its
///   top left) or, a block, its middle `at` this far from the hand (blocks; x left, y up the arm, z forward): avatar.js
///   turns it to suit the pose (POSES), the owner's poses rather than Minecraft's.
/// Tools and weapons in first person are Minecraft's turn, moved a little left and up and a little larger (its own
/// translation is [1.13, 3.2, 1.13] and scale 0.68): there a sword's tip runs off the right edge of a 16:9 screen; here
/// it stops just inside, the blade coming up from the bottom about three quarters across, as in the classic game's
/// pictures (main.js keeps that framing on squarer windows too).
export const DISPLAY = {
  handheld: {
    first: { rotation: [0, -90, 25], translation: [0.4, 3.9, 1.13], scale: 0.72 },
    third: { scale: 0.85, grip: [4, 12] },
  },
  generated: {
    first: { rotation: [0, -90, 25], translation: [1.13, 3.2, 1.13], scale: 0.68 },
    third: { scale: 0.55, grip: [8, 11] },
  },
  block: {
    first: { rotation: [0, 45, 0], translation: [0, 0, 0], scale: 0.4 },
    third: { scale: 0.375, at: [0, 0.03, 0.24] }, // (in front of the fist, overlapping it a little, as Minecraft's)
  },
};
const N = 16; // an icon's pixels across
const DEG = Math.PI / 180;

// ---------------------------------------------------------------- the glint
/// Minecraft's enchantment glint (as Java drew it with two layers, RenderItem.renderEffect, 1.8 to 1.14): its glint
/// texture drawn twice over the item, one layer turned -50 degrees and sliding along once every 3 s, the other turned 10 degrees
/// and sliding back once every 4.873 s, both tinted #8040CC and added to what's there, blended by their own colour (so
/// what's added is the colour squared: deep, saturated purple, faint except where a streak passes). The texture is
/// Mojang's; this draws thin soft streaks of its kind instead. `size`: a layer's streaks across an item (a block);
/// `width`: a streak's width (a share of the gap between streaks); `squared` and `plain`: how much of the tint squared
/// (Minecraft's blend) and as it is (a touch, so a streak still shows, a paler violet, over an item that is purple
/// already) a streak adds at its brightest. The item's own colours stay readable underneath.
const GLINT = {
  tint: [0x80 / 255, 0x40 / 255, 0xcc / 255], layers: [{ angle: -50, period: 3 }, { angle: 10, period: 4.873 }],
  size: 1.7, width: 0.11, squared: 0.75, plain: 0.1,
};
const glintScroll = { value: new THREE.Vector2() };
/// Once a frame, with the time in seconds: every glinting thing (in your hand, on other miners, on worn Crystal armor)
/// shares the one value, so they all shimmer together.
export function tickGlint(seconds) {
  const [a, b] = GLINT.layers;
  glintScroll.value.set((seconds / a.period) % 1, (seconds / b.period) % 1);
}
const f = (n) => n.toFixed(5);
const GLINT_GLSL = `
uniform vec2 glintScroll;
varying vec2 vGlint;
// One layer: streaks running across the item at angle a, slid along by s (0..1, wrapping round): a bright one each
// repeat and a fainter, thinner one between, a little wavy, like the glint texture's.
float glintLayer(vec2 p, float a, float s) {
  vec2 q = mat2(cos(a), sin(a), -sin(a), cos(a)) * p * ${f(GLINT.size)};
  float u = q.x + s + 0.04 * sin(9.4248 * q.y);
  float bright = (fract(u) - 0.5) / ${f(GLINT.width)};
  float faint = (fract(u * 2.0 + 0.35) - 0.5) / ${f(GLINT.width * 0.8)};
  return exp(-bright * bright) + 0.35 * exp(-faint * faint);
}
vec3 glintColour(vec2 p, float strength) {
  vec3 tint = vec3(${GLINT.tint.map(f).join(", ")});
  float a = glintLayer(p, ${f(GLINT.layers[0].angle * DEG)}, glintScroll.x);
  float b = glintLayer(p, ${f(GLINT.layers[1].angle * DEG)}, -glintScroll.y);
  return (tint * tint * ${f(GLINT.squared)} + tint * ${f(GLINT.plain)}) * (a * a + b * b) * strength;
}`;
/// Patches a MeshLambertMaterial's shader: `glint` ({ scale, strength }) adds the glint, laid out by the mesh's own
/// position: (x + z, y) x scale, so a held item's (a block across) at scale 1, worn armor's (in metres) larger, and
/// dimmed by strength (worn armor's is gentler, as Minecraft's armor glint is), after the light, as Minecraft draws it
/// unlit. `solid`: the light never lifts a colour past itself (Minecraft's light tops out at 1), so a held item in full sun
/// keeps its own colours and shading instead of washing out to white.
function patch(material, { glint = null, solid = false }) {
  material.onBeforeCompile = (shader) => {
    if (solid) {
      shader.fragmentShader = shader.fragmentShader.replace(
        "vec3 outgoingLight = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse + totalEmissiveRadiance;",
        "vec3 outgoingLight = min(reflectedLight.directDiffuse + reflectedLight.indirectDiffuse, diffuseColor.rgb) + totalEmissiveRadiance;");
    }
    if (glint) {
      shader.uniforms.glintScroll = glintScroll;
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", "#include <common>\nvarying vec2 vGlint;")
        .replace("#include <begin_vertex>", `#include <begin_vertex>\nvGlint = vec2(position.x + position.z, position.y) * ${f(glint.scale)};`);
      shader.fragmentShader = shader.fragmentShader
        .replace("#include <common>", `#include <common>\n${GLINT_GLSL}`)
        .replace("#include <opaque_fragment>", `#include <opaque_fragment>\ngl_FragColor.rgb += glintColour(vGlint, ${f(glint.strength)});`);
    }
  };
  material.customProgramCacheKey = () => `${glint ? `glint${glint.scale}:${glint.strength}` : ""}${solid ? ":solid" : ""}`;
  return material;
}
/// Gives `material` (a MeshLambertMaterial) the glint (patch), `scale` and `strength` as there.
export const withGlint = (material, scale = 1, strength = 1) => patch(material, { glint: { scale, strength } });
/// Whether item `id` glints: Crystal tools, weapons and armor (not the war hammer).
const glints = (id) => id === CRYSTAL_PICK || id === CRYSTAL_SWORD || ARMOR[id]?.tier === 4;

// ---------------------------------------------------------------- the models
/// A cube of block `id`, a block across, centred.
function blockMeshes(id) {
  const g = new THREE.BoxGeometry(1, 1, 1);
  const [top, side, bottom] = faceTiles(id);
  tileUVs(g, [side, side, top, bottom, side, side]);
  return [new THREE.Mesh(g, patch(new THREE.MeshLambertMaterial({ map: atlasTex, alphaTest: 0.5, transparent: id === WATER }), { solid: true }))];
}

/// Item `id`'s icon extruded one pixel thick, as Minecraft's ItemModelGenerator makes it: a block across, centred, the
/// icon on its +z face (as drawn) and its -z face (the same picture seen from behind), and the edge of every pixel
/// that borders a clear one filled in with that pixel's colour.
function itemMeshes(id) {
  const canvas = iconCanvas(id, atlas);
  const data = canvas.getContext("2d").getImageData(0, 0, 32, 32).data;
  const S = 1 / N;
  const solid = (x, y) => x >= 0 && y >= 0 && x < N && y < N && data[(y * 2 * 32 + x * 2) * 4 + 3] > 128;
  const material = (opts) => patch(new THREE.MeshLambertMaterial(opts), { glint: glints(id) ? { scale: 1, strength: 1 } : null, solid: true });

  // The faces: the icon itself, front and back. (Its colours used as written, as the world's: no colour space.)
  const tex = new THREE.CanvasTexture(canvas);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  // Each face shows only from its own side (the back is the same picture seen from behind, so mirrored, as a solid
  // thing would be): a two-sided face would show its mirror image through the clear parts of the other.
  const plane = new THREE.PlaneGeometry(1, 1);
  const front = new THREE.Mesh(plane, material({ map: tex, alphaTest: 0.5, side: THREE.FrontSide }));
  const back = new THREE.Mesh(plane, material({ map: tex, alphaTest: 0.5, side: THREE.BackSide }));
  front.position.z = S / 2;
  back.position.z = -S / 2;

  // The edges: one quad (a pixel square) per pixel side that faces a clear pixel.
  const pos = [], nor = [], col = [], idx = [];
  const c = new THREE.Color();
  const quad = (corners, n) => {
    const k = pos.length / 3;
    for (const p of corners) { pos.push(...p); nor.push(...n); col.push(c.r, c.g, c.b); }
    idx.push(k, k + 1, k + 2, k, k + 2, k + 3);
  };
  const z0 = -S / 2, z1 = S / 2;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    if (!solid(x, y)) continue;
    const i = (y * 2 * 32 + x * 2) * 4;
    c.setRGB(data[i] / 255, data[i + 1] / 255, data[i + 2] / 255);
    const x0 = x * S - 0.5, x1 = x0 + S, yt = 0.5 - y * S, yb = yt - S;
    if (!solid(x - 1, y)) quad([[x0, yb, z0], [x0, yb, z1], [x0, yt, z1], [x0, yt, z0]], [-1, 0, 0]);
    if (!solid(x + 1, y)) quad([[x1, yb, z1], [x1, yb, z0], [x1, yt, z0], [x1, yt, z1]], [1, 0, 0]);
    if (!solid(x, y - 1)) quad([[x0, yt, z1], [x1, yt, z1], [x1, yt, z0], [x0, yt, z0]], [0, 1, 0]);
    if (!solid(x, y + 1)) quad([[x0, yb, z0], [x1, yb, z0], [x1, yb, z1], [x0, yb, z1]], [0, -1, 0]);
  }
  const edges = new THREE.BufferGeometry();
  edges.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  edges.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
  edges.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  edges.setIndex(idx);
  const rim = new THREE.Mesh(edges, material({ vertexColors: true, side: THREE.DoubleSide }));
  return [front, back, rim];
}

/// How an item is held (avatar.js poses the arm for it): "weapon" (swords and the war hammer, held out, ready),
/// "tool" (pickaxes), "block" or "item" (food, torches, armor and the rest).
export function heldKind(id) {
  if (isBlock(id)) return "block";
  const t = TOOLS[id];
  return t?.kind === "sword" ? "weapon" : t ? "tool" : "item";
}

const cache = new Map();
/// A model of item `id` for a hand, or null for an empty hand, its kind (heldKind) in userData.kind. `view`:
/// - "first": placed by Minecraft's firstperson_righthand, for the end of main.js's first-person arm;
/// - "third": in blocks, held at its grip (DISPLAY), for avatar.js to turn to suit the pose.
export function heldModel(id, view = "third") {
  if (!id || !atlas) return null;
  const kind = modelOf(id);
  if (!cache.has(id)) {
    const meshes = kind === "block" ? blockMeshes(id) : itemMeshes(id);
    for (const m of meshes) m.userData.shared = true;
    cache.set(id, meshes);
  }
  const shape = new THREE.Group();
  for (const m of cache.get(id)) shape.add(m.clone());
  const d = DISPLAY[kind][view];
  shape.scale.setScalar(d.scale);
  if (view === "first") {
    shape.position.fromArray(d.translation).multiplyScalar(1 / 16);
    shape.rotation.set(d.rotation[0] * DEG, d.rotation[1] * DEG, d.rotation[2] * DEG, "XYZ");
  } else if (d.grip) {
    shape.position.set(0.5 - (d.grip[0] + 0.5) / N, (d.grip[1] + 0.5) / N - 0.5, 0).multiplyScalar(d.scale);
  } else shape.position.fromArray(d.at);
  const model = new THREE.Group();
  model.add(shape);
  model.userData.kind = heldKind(id);
  return model;
}

/// Minecraft's bare right arm for first person (PlayerModel's rightArm, as ItemInHandRenderer.renderPlayerArm draws
/// it): a 4 x 12 x 4 box hanging from the shoulder (its pivot 5 pixels right of the body's middle and 2 down; in model
/// units, sixteenths, y down the arm), tilted out 0.1 radians by the idle sway at rest. The sleeve in the outfit's
/// colour, the hand at its end in the skin's (avatar.js colours). Its own meshes: dispose() them when done.
export function bareArm({ skin, sleeve }) {
  const P = 1 / 16;
  const part = new THREE.Group();
  part.position.set(-5 * P, 2 * P, 0);
  part.rotation.set(0, 0, 0.1, "ZYX");
  const box = (h, y, colour, grow = 0) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry((4 + grow) * P, h * P, (4 + grow) * P), new THREE.MeshLambertMaterial({ color: colour }));
    m.position.set(-1 * P, y * P, 0);
    part.add(m);
  };
  box(9.5, -2 + 9.5 / 2, sleeve); // shoulder to wrist
  box(2.5, 10 - 2.5 / 2, skin, 0.1); // the hand
  return part;
}
