// A blocky miner in 3D, built from a 64 x 64 Minecraft skin with Minecraft's player model: a head 8 x 8 x 8, a body
// 8 x 12 x 4, arms and legs 4 x 12 x 4, each with its outer layer (hat, jacket, sleeves, trousers) as a slightly
// bigger box whose empty pixels are see-through, the texture drawn pixel-sharp. The skin is the I'M DEGEN you wear
// (degen-skin.js), the very same pixels as its NFT, so the card and the character match; players without one are the
// Rookie, DEGEN's plain frog in a grey hoodie. The town's villagers bring their own skins (villager-skins.js).
//
// It moves the way Minecraft Java's players do (HumanoidModel.setupAnim), worked out 20 times a second from where
// the miner really goes and drawn smoothly in between: legs and arms swing with the speed along the ground, the
// arms sway a little at rest, the body turns towards where you walk and lags the head, a swing twists the body, and
// sneaking crouches. In the air (a jump or a fall) the legs hold a stride and the arms lift out a little, in the
// spirit of the Not Enough Animations mod. What's in the hand sets the arm's pose (POSES); the walk and the swing are
// layered on top of it.

import * as THREE from "https://esm.sh/three@0.160.0";
import { skinPixels, ROOKIE, PARTS, faceBox } from "./degen-skin.js";
import { ARMOR_COLOURS } from "./textures.js";
import { wrapDelta } from "./rules.js";
import { withGlint } from "./held.js";

const PX = 1.8 / 32; // one "pixel" of the 32-pixel-tall figure, in metres
const ITEM_BLOCK = 16 * PX; // a held item's model is measured in blocks (held.js): one is 16 of the figure's pixels
const ARMOR_GLINT = { scale: 1.5, strength: 0.55 }; // worn Crystal armor's glint: its streaks' repeats a metre, and how bright
const TICK = 1 / 20; // seconds: the animation's step, Minecraft's tick
const DEG = Math.PI / 180;
/// Minecraft's numbers for the biped's animation (angles in radians, lengths in pixels).
const ANIM = {
  stride: 0.6662, legSwing: 1.4, // a leg swings cos(limbSwing x stride) x legSwing x amount; an arm half as far
  walkSpeed: 4, walkEase: 0.4, // the swing's amount follows min(blocks a tick x walkSpeed, 1), eased this much a tick
  turnEase: 0.3, // the body turns this much of the way towards where you walk each tick
  headFree: 50 * DEG, headMax: 75 * DEG, // the head looks this far off the body freely; the body follows past it
  backwards: 95 * DEG, // walking more than this far off where you look, the body faces your look (walking backwards)
  moving: 0.05, // blocks a tick: slower than this the body doesn't turn to the walk
  swingTicks: 6, // a swing (attack, mining, placing) takes this many ticks; mining starts the next one halfway
  twist: 0.2, // how far the body twists in a swing
  // Sneaking eases in this much a tick: the upper body drops crouchDrop pixels and leans forward from the neck, the
  // head drops crouchHead, the arms hang back along the torso, the legs step back. (Minecraft also lowers the whole
  // model 2 pixels, feet and all: left out here, to keep the feet on the ground.)
  crouchEase: 0.5, lean: 0.5, crouchArms: 0.4, crouchDrop: 3.2, crouchHead: 4.2, crouchLegsBack: 4,
  airEase: 0.35, airRise: 0.15, // in the air: the pose eases in this much a tick; others count as airborne past this
  // rise or fall a tick (blocks), since only your own game knows when you're on the ground
};
/// An angle brought round into [-pi, pi).
const turn = (a) => a - 2 * Math.PI * Math.floor(a / (2 * Math.PI) + 0.5);

const armTurn = (angle) => new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), angle);
/// How each kind of held thing (held.js heldKind) is held: the right arm's angle at rest (negative raises it forward),
/// how much of the walk's arm swing it keeps (Minecraft halves it for anything held), and the thing's turn in the
/// hand, given in the arm's frame (so it's the body-frame turn undone by the arm's).
const POSES = {
  // A tool with the arm down: its head up, forward and out, its face half to the front.
  tool: { arm: 0, walk: 0.5, q: armTurn(0.3).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -0.75 * Math.PI)) },
  // A block a little forward, as if about to place it.
  block: { arm: -0.35, walk: 0.5, q: new THREE.Quaternion() },
  none: { arm: 0, walk: 1, q: new THREE.Quaternion() },
};
// A weapon is held the way a tool is, blade up, forward and out, as in the classic games (the owner preferred it to
// a sword held out to the side); so is anything else held in the hand.
POSES.weapon = POSES.tool;
POSES.item = POSES.tool;

/// The look of a player without a DEGEN: the Rookie (degen-skin.js).
export { ROOKIE };

/// A skin (64 x 64 RGBA bytes) as a texture, drawn pixel-sharp.
function skinTexture(rgba) {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  c.getContext("2d").putImageData(new ImageData(rgba, 64, 64), 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  return t;
}

/// A part of the model as a box `grow` pixels bigger than the part (0 for the base layer; the outer layer is a half
/// pixel bigger on the head and a quarter on the rest, as in Minecraft), its faces cut from the skin by Minecraft's
/// layout (degen-skin.js faceBox). Box faces: +x (the miner's left), -x (right), +y, -y, +z (front), -z (back).
const EDGE = 0.002; // (a sliver kept off each face's edge, so pixel-sharp sampling never catches the next face's pixels)
function skinBox(part, outer, material, grow = 0) {
  const P = PARTS[part], [w, h, d] = P.size, [u0, v0] = outer ? P.over : P.uv;
  const geo = new THREE.BoxGeometry((w + grow) * PX, (h + grow) * PX, (d + grow) * PX);
  const uv = geo.attributes.uv;
  ["L", "R", "T", "U", "F", "K"].forEach((face, i) => {
    const [bu, bv, bw, bh] = faceBox(P.size, face);
    const x0 = (u0 + bu + EDGE) / 64, x1 = (u0 + bu + bw - EDGE) / 64;
    const top = 1 - (v0 + bv + EDGE) / 64, bottom = 1 - (v0 + bv + bh - EDGE) / 64;
    for (let k = 4 * i; k < 4 * i + 4; k++) uv.setXY(k, uv.getX(k) ? x1 : x0, uv.getY(k) ? top : bottom);
  });
  return new THREE.Mesh(geo, material);
}

function box(w, h, d, color, emissive) {
  const m = new THREE.MeshLambertMaterial({ color, emissive: emissive ?? 0x000000 });
  return new THREE.Mesh(new THREE.BoxGeometry(w * PX, h * PX, d * PX), m);
}

/// `traits`: a DEGEN's traits (from the chain, via the world server), or null for the Rookie. `gear`: the armor tier
/// worn on head, chest, legs and feet (0 none, 1 Padded, 2 Iron, 3 Diamond, 4 Crystal); a helmet takes the place of
/// the hat layer (headwear, and the eyes' bulge). `skin`: a ready skin (64 x 64 RGBA) to wear instead (villagers).
export function createAvatar(traits, gear = [0, 0, 0, 0], skin = null) {
  const rgba = skin ?? skinPixels(traits ?? ROOKIE);
  const tex = skinTexture(rgba);
  const base = new THREE.MeshLambertMaterial({ map: tex });
  const outer = new THREE.MeshLambertMaterial({ map: tex, alphaTest: 0.5 });
  /// A part with its outer layer, centred `y` pixels from its pivot; gives the outer layer.
  const part = (name, parent, y, grow) => {
    const layers = [skinBox(name, false, base), skinBox(name, true, outer, grow)];
    for (const m of layers) {
      m.position.y = y * PX;
      parent.add(m);
    }
    return layers[1];
  };
  // The colour you see at pixel (x, y) of the right arm's front (for the bare arm in first person, held.js).
  const seenAt = (x, y) => {
    const P = PARTS.armR, [bu, bv] = faceBox(P.size, "F");
    const o = 4 * ((P.over[1] + bv + y) * 64 + P.over[0] + bu + x), b = 4 * ((P.uv[1] + bv + y) * 64 + P.uv[0] + bu + x);
    const i = rgba[o + 3] ? o : b;
    return (rgba[i] << 16) | (rgba[i + 1] << 8) | rgba[i + 2];
  };

  // root faces where the miner looks (whoever draws it turns it); `body` turns within it, lagging the head; `upper`
  // (the torso and arms) twists in a swing; the torso leans from the neck (`chest`) when sneaking. The head turns
  // with root, so it always faces the look.
  const root = new THREE.Group();
  const body = new THREE.Group();
  const upper = new THREE.Group();
  const chest = new THREE.Group();
  chest.position.y = 24 * PX;
  root.add(body);
  body.add(upper);
  upper.add(chest);
  // The right leg and arm first (the miner faces +z, so its right is -x).
  const legs = [["legR", -2], ["legL", 2]].map(([name, x]) => {
    const pivot = new THREE.Group();
    pivot.position.set(x * PX, 12 * PX, 0);
    part(name, pivot, -6, 0.5);
    body.add(pivot);
    return pivot;
  });
  part("body", chest, -6, 0.5);
  const arms = [["armR", -6], ["armL", 6]].map(([name, x]) => {
    const pivot = new THREE.Group();
    pivot.position.set(x * PX, 23 * PX, 0);
    part(name, pivot, -5, 0.5);
    pivot.rotation.order = "ZYX"; // (Minecraft's order for a part's turns)
    upper.add(pivot);
    return pivot;
  });

  const head = new THREE.Group();
  head.position.y = 24 * PX;
  const hat = part("head", head, 4, 1);
  hat.visible = !gear[0]; // (a helmet takes its place)
  root.add(head);

  // Armor over the outfit, in its tier's colours (Crystal glows a little, and has the enchantment glint, held.js).
  const plate = (tier, w, h, d, x, y, z, parent) => {
    const [main] = ARMOR_COLOURS[tier - 1];
    const m = box(w, h, d, main, tier === 4 ? 0x3a1050 : 0);
    if (tier === 4) withGlint(m.material, ARMOR_GLINT.scale, ARMOR_GLINT.strength);
    m.position.set(x * PX, y * PX, z * PX);
    parent.add(m);
  };
  // The helmet leaves the face open (DEGEN's eyes sit at the top of the head): a cap, the sides and back, a brow.
  if (gear[0]) {
    plate(gear[0], 9, 1.2, 9, 0, 8.4, 0, head);
    for (const x of [-4.3, 4.3]) plate(gear[0], 0.9, 4.6, 9, x, 6.5, 0, head);
    plate(gear[0], 9, 4.6, 0.9, 0, 6.5, -4.3, head);
    plate(gear[0], 9, 1, 0.9, 0, 7.6, 4.3, head);
  }
  if (gear[1]) {
    plate(gear[1], 8.8, 9, 4.8, 0, 19.4 - 24, 0, chest);
    for (const a of arms) plate(gear[1], 4.8, 3.4, 4.8, 0, -0.6, 0, a);
  }
  if (gear[2]) for (const l of legs) plate(gear[2], 4.6, 6, 4.6, 0, -3, 0, l);
  if (gear[3]) for (const l of legs) plate(gear[3], 4.8, 3.2, 5, 0, -10.6, 0.3, l);

  // What's in the hand (held.js): the right hand (the miner faces +z, so its right is -x), the one that swings. The
  // model inside is in blocks, at Minecraft's third-person size.
  const grip = new THREE.Group();
  grip.position.set(0, -11 * PX, 0.5 * PX);
  grip.scale.setScalar(ITEM_BLOCK);
  arms[0].add(grip);

  // The animation, stepped once a tick from where the miner is (each value's last two kept, to draw in between).
  // Angles follow Minecraft's model but with y and z turns flipped, since this model faces +z and Minecraft's -z.
  let pose = POSES.none; // how the right arm holds what's in it
  const st = {
    seen: false, acc: 0, age: 0, x: 0, y: 0, z: 0,
    limb: 0, amount: 0, amountOld: 0, // how far the legs have swung (limbSwing), and how widely (limbSwingAmount)
    body: 0, bodyOld: 0, // the body's yaw
    swinging: false, swingTime: 0, attack: 0, attackOld: 0, // a swing: its tick, and how far through it is (0..1)
    crouch: 0, crouchOld: 0, air: 0, airOld: 0, rise: 0, riseOld: 0, // (rise: blocks up a tick, smoothed)
  };
  /// Starts a swing (Minecraft's LivingEntity.swing): a new one only once the last is halfway through.
  function startSwing() {
    if (!st.swinging || st.swingTime >= ANIM.swingTicks / 2 || st.swingTime < 0) { st.swingTime = -1; st.swinging = true; }
  }
  /// One tick: what the miner did since the last (`s`: see animate).
  function step(s) {
    const dx = wrapDelta(s.x - st.x), dz = wrapDelta(s.z - st.z);
    let dy = s.y - st.y, d2 = dx * dx + dz * dz;
    if (d2 > 4 || Math.abs(dy) > 4) d2 = dy = 0; // a teleport or a respawn, not a step
    st.x = s.x; st.y = s.y; st.z = s.z;
    st.age++;
    // The walk's swing follows the speed along the ground.
    st.amountOld = st.amount;
    st.amount += (Math.min(Math.sqrt(d2) * ANIM.walkSpeed, 1) - st.amount) * ANIM.walkEase;
    st.limb += st.amount;
    // The body turns towards where you walk (or to your look, walking backwards or swinging), and never lets the
    // head get more than headMax off it (past headFree it starts to follow).
    st.bodyOld = st.body;
    let target = st.body;
    if (d2 > ANIM.moving * ANIM.moving) {
      const walkYaw = Math.atan2(-dx, -dz);
      target = Math.abs(turn(s.yaw - walkYaw)) > ANIM.backwards ? walkYaw + Math.PI : walkYaw;
    }
    if (st.attack > 0 || s.swinging) target = s.yaw;
    st.body += turn(target - st.body) * ANIM.turnEase;
    const off = Math.max(-ANIM.headMax, Math.min(ANIM.headMax, turn(s.yaw - st.body)));
    st.body = s.yaw - off;
    if (Math.abs(off) > ANIM.headFree) st.body += off * 0.2;
    // The swing (mining or fighting keeps starting the next).
    if (s.swinging) startSwing();
    st.attackOld = st.attack;
    if (st.swinging && ++st.swingTime >= ANIM.swingTicks) { st.swingTime = 0; st.swinging = false; }
    if (!st.swinging) st.swingTime = 0;
    st.attack = st.swingTime / ANIM.swingTicks;
    // Sneaking, and the air (your own game says when you're on the ground; for others it's a quick rise or fall).
    st.crouchOld = st.crouch;
    st.crouch += ((s.sneak ? 1 : 0) - st.crouch) * ANIM.crouchEase;
    st.airOld = st.air;
    st.riseOld = st.rise;
    const airborne = s.ground === undefined ? Math.abs(dy) > ANIM.airRise : !s.ground;
    st.air += ((airborne ? 1 : 0) - st.air) * ANIM.airEase;
    st.rise += (dy - st.rise) * 0.5;
  }
  /// Sets every part for the moment `a` (0..1) of the way from the last tick to the next.
  function draw(s, a) {
    const amount = Math.min(1, st.amountOld + (st.amount - st.amountOld) * a);
    const limb = st.limb - st.amount * (1 - a);
    const age = st.age + a;
    const crouch = st.crouchOld + (st.crouch - st.crouchOld) * a;
    const air = st.airOld + (st.air - st.airOld) * a;
    const rise = st.riseOld + (st.rise - st.riseOld) * a;
    let att = st.attack - st.attackOld;
    if (att < 0) att += 1; // (the swing wrapped round to the next one)
    att = st.attackOld + att * a;
    body.rotation.y = turn(st.bodyOld + turn(st.body - st.bodyOld) * a - s.yaw);
    head.rotation.x = -s.pitch;
    head.position.y = (24 - crouch * ANIM.crouchHead) * PX;
    // The walk: legs swing cos(limbSwing x stride) x legSwing x amount, the arms opposite and half as far (less in the
    // air, where the legs hold a stride instead).
    const walk = amount * (1 - 0.5 * air), c = Math.cos(limb * ANIM.stride) * walk;
    legs[0].rotation.x = c * ANIM.legSwing;
    legs[1].rotation.x = -c * ANIM.legSwing;
    arms[0].rotation.set(pose.arm - c * pose.walk, 0, 0);
    arms[1].rotation.set(c, 0, 0);
    // The arms' idle sway.
    const sway = Math.cos(age * 0.09) * 0.05 + 0.05, nod = Math.sin(age * 0.067) * 0.05;
    arms[0].rotation.z -= sway; arms[0].rotation.x += nod;
    arms[1].rotation.z += sway; arms[1].rotation.x -= nod;
    // In the air: a stride held, the arms lifting out, more the faster you fall.
    if (air > 0.001) {
      const fall = Math.max(0, Math.min(1, -rise / 0.6));
      legs[0].rotation.x -= 0.5 * air * (1 - fall);
      legs[1].rotation.x += 0.3 * air;
      arms[0].rotation.z -= (0.15 + 0.45 * fall) * air;
      arms[1].rotation.z += (0.15 + 0.45 * fall) * air;
      arms[1].rotation.x -= 0.5 * fall * air;
    }
    // A swing: the body twists, the arm comes up fast and down across.
    upper.rotation.y = 0;
    if (att > 0) {
      const tw = Math.sin(Math.sqrt(att) * Math.PI * 2) * ANIM.twist;
      upper.rotation.y = -tw;
      arms[1].rotation.x += tw;
      let f = 1 - att;
      f = 1 - f * f * f * f;
      arms[0].rotation.x -= Math.sin(f * Math.PI) * 1.2 + Math.sin(att * Math.PI) * -(head.rotation.x - 0.7) * 0.75;
      arms[0].rotation.y -= tw * 2;
      arms[0].rotation.z += Math.sin(att * Math.PI) * 0.4;
    }
    // Sneaking: the upper body drops and leans forward from the neck, the arms hang along it, the legs step back.
    upper.position.y = -crouch * ANIM.crouchDrop * PX;
    chest.rotation.x = crouch * ANIM.lean;
    arms[0].rotation.x += crouch * ANIM.crouchArms;
    arms[1].rotation.x += crouch * ANIM.crouchArms;
    for (const l of legs) l.position.z = -crouch * ANIM.crouchLegsBack * PX;
  }

  return {
    root, head,
    /// The right arm for the bare arm in first person (held.js bareArm): its sleeve's and hand's colours, and
    /// `arm(unit)`, the arm itself in the skin (base and outer layer, `unit` a pixel, the hand towards +y).
    colours: {
      skin: seenAt(1, 11), sleeve: seenAt(1, 2),
      arm(unit) {
        const g = new THREE.Group();
        // (its own materials, as the bare arm's owner disposes them; the texture stays your miner's)
        for (const m of [skinBox("armR", false, base.clone()), skinBox("armR", true, outer.clone(), 0.5)]) {
          m.scale.setScalar(unit / PX);
          g.add(m);
        }
        g.rotation.x = Math.PI; // (the hand up, towards +y, as the bare arm is drawn)
        return g;
      },
    },
    /// Puts `model` (held.js heldModel, or null for nothing) in the hand, in place of what was there, and holds it
    /// the way its kind is held (POSES).
    hold(model) {
      grip.clear();
      pose = POSES[model?.userData.kind] ?? POSES.none;
      grip.quaternion.copy(pose.q);
      if (model) grip.add(model);
      arms[0].rotation.x = pose.arm;
    },
    /// Called every frame (`dt` seconds since the last) with where the miner is and what they do: `s` is { x, y, z
    /// (flat, any image of it), yaw, pitch (where they look; root is turned to the yaw by whoever draws it), sneak,
    /// swinging (mining or fighting, held down), ground (whether they stand on something, if known) }.
    animate(dt, s) {
      if (!st.seen) {
        Object.assign(st, { seen: true, x: s.x, y: s.y, z: s.z, body: s.yaw, bodyOld: s.yaw });
      }
      st.acc = Math.min(st.acc + dt, TICK * 5);
      while (st.acc >= TICK) { step(s); st.acc -= TICK; }
      draw(s, st.acc / TICK);
    },
    /// One swing (placing a block, or a single hit).
    swing: startSwing,
    dispose() {
      root.traverse((n) => {
        if (!n.isMesh || n.userData.shared) return; // (a held item's model is shared: held.js)
        n.geometry.dispose();
        for (const m of [].concat(n.material)) m.dispose();
      });
      tex.dispose();
    },
  };
}
