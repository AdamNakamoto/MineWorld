// A blocky miner in 3D, dressed as a MineWorld Crafter: the face on the front of the head is the Crafter's own
// pixel art, the hair, hat and outfit follow its traits (crafters.js), with a walk cycle and a swing. Players without
// a Crafter are the Rookie.

import * as THREE from "https://esm.sh/three@0.160.0";
import { pixels, HAIRS, HATS, OUTFITS, SKINS } from "./crafters.js";
import { ARMOR_COLOURS } from "./textures.js";

const PX = 1.8 / 32; // one "pixel" of the 32-pixel-tall figure, in metres

/// The look of a player without a Crafter: brown bob, charcoal hoodie, no hat.
export const ROOKIE = { hair: 9, outfit: 4, eyes: 0, gaze: 0, background: 0, skin: 1, hat: 0, blush: 0 };

function canvasTexture(w, h, draw) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  draw(c.getContext("2d"));
  const t = new THREE.CanvasTexture(c);
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestFilter;
  return t;
}

function box(w, h, d, color, emissive) {
  const m = new THREE.MeshLambertMaterial({ color, emissive: emissive ?? 0x000000 });
  return new THREE.Mesh(new THREE.BoxGeometry(w * PX, h * PX, d * PX), m);
}

/// `traits`: a Crafter's traits (from the chain, via the world server), or null for the Rookie. `gear`: the armor tier
/// worn on head, chest, legs and feet (0 none, 1 Padded, 2 Iron, 3 Diamond, 4 Crystal).
export function createAvatar(traits, gear = [0, 0, 0, 0]) {
  const t = traits ?? ROOKIE;
  const px = pixels(t);
  const bg = px[0];
  const skin = SKINS[t.skin], hair = HAIRS[t.hair], hatDef = HATS[t.hat], outfit = OUTFITS[t.outfit];
  const hc = hair.colors;
  const hairMid = hc[3] ?? hc.m, hairDark = hc[2] ?? hc.f;
  const at = (x, y) => px[y * 24 + x];

  // The face: the Crafter's own pixels, from the bangs down to the neck (10 x 10), the background filled with hair.
  const face = canvasTexture(10, 10, (g) => {
    for (let y = 0; y < 10; y++) for (let x = 0; x < 10; x++) {
      const c = at(x + 8, y + 8);
      g.fillStyle = c === bg ? hairDark : c;
      g.fillRect(x, y, 1, 1);
    }
  });
  // The front of the body: the outfit's own pixels (rows 19-23), its last row carried on down.
  const shirt = canvasTexture(8, 12, (g) => {
    for (let y = 0; y < 12; y++) for (let x = 0; x < 8; x++) {
      const c = at(x + 8, Math.min(23, y + 19));
      g.fillStyle = c === bg ? outfit.colors[3] : c;
      g.fillRect(x, y, 1, 1);
    }
  });
  const main = outfit.colors[3];
  const sleeve = at(6, 21) === bg ? main : at(6, 21);
  const pants = outfit.mask === "overalls" || outfit.mask === "suit" ? main : "#2a3046";

  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  const legs = [-2, 2].map((x) => {
    const pivot = new THREE.Group();
    pivot.position.set(x * PX, 12 * PX, 0);
    const leg = box(4, 12, 4, pants);
    leg.position.y = -6 * PX;
    const shoe = box(4.2, 2.4, 4.4, "#2a1e16");
    shoe.position.set(0, -10.9 * PX, 0.2 * PX);
    pivot.add(leg, shoe);
    body.add(pivot);
    return pivot;
  });
  const torso = new THREE.Mesh(new THREE.BoxGeometry(8 * PX, 12 * PX, 4 * PX), [
    new THREE.MeshLambertMaterial({ color: main }), new THREE.MeshLambertMaterial({ color: main }),
    new THREE.MeshLambertMaterial({ color: main }), new THREE.MeshLambertMaterial({ color: main }),
    new THREE.MeshLambertMaterial({ map: shirt }), new THREE.MeshLambertMaterial({ color: main }),
  ]);
  torso.position.y = 18 * PX;
  body.add(torso);
  const arms = [-6, 6].map((x) => {
    const pivot = new THREE.Group();
    pivot.position.set(x * PX, 23 * PX, 0);
    const arm = box(4, 12, 4, sleeve);
    arm.position.y = -5 * PX;
    const hand = box(4.1, 2.5, 4.1, skin.S);
    hand.position.y = -10 * PX;
    pivot.add(arm, hand);
    body.add(pivot);
    return pivot;
  });

  const head = new THREE.Group();
  head.position.y = 24 * PX;
  // Box faces: +x, -x, +y, -y, +z (front), -z. The Crafter's face goes on +z.
  const skull = new THREE.Mesh(new THREE.BoxGeometry(8 * PX, 8 * PX, 8 * PX), [
    new THREE.MeshLambertMaterial({ color: hairMid }), new THREE.MeshLambertMaterial({ color: hairMid }),
    new THREE.MeshLambertMaterial({ color: hairMid }), new THREE.MeshLambertMaterial({ color: skin.S }),
    new THREE.MeshLambertMaterial({ map: face }), new THREE.MeshLambertMaterial({ color: hairMid }),
  ]);
  skull.position.y = 4 * PX;
  head.add(skull);
  body.add(head);
  const add = (w, h, d, color, x, y, z, emissive) => {
    const m = box(w, h, d, color, emissive);
    m.position.set(x * PX, y * PX, z * PX);
    head.add(m);
    return m;
  };
  // Hair beyond the head's own box.
  if (hair.mask === "long") add(8.6, 13, 1.6, hairMid, 0, 1, -4.4);
  if (hair.mask === "bob") add(8.8, 6, 8.8, hairMid, 0, 5.4, -0.3);
  if (hair.mask === "curly") add(9.6, 4.6, 9.6, hairMid, 0, 6.8, -0.2);
  if (hair.mask === "bun") { add(8.6, 3, 8.6, hairMid, 0, 7, -0.2); if (!hatDef.mask) add(3.4, 3.4, 3.4, hairMid, -2, 10, -2); }
  // The hat (a helmet takes its place).
  const hcol = gear[0] ? {} : hatDef.colors ?? {};
  if (!gear[0] && hatDef.mask === "bucket") { add(9.2, 3.4, 9.2, hcol[4], 0, 9, 0); add(12.4, 0.8, 12.4, hcol[1], 0, 7.4, 0); }
  if (!gear[0] && hatDef.mask === "cap") { add(9, 3, 9, hcol[3], 0, 9.2, 0); add(8, 0.8, 4.6, hcol[1], 0, 7.8, 6); }
  if (!gear[0] && hatDef.mask === "hard") {
    add(9.4, 3, 9.4, hcol[3], 0, 9.2, 0);
    add(11, 0.8, 11, hcol[2], 0, 7.8, 0);
    add(2.2, 1.8, 1, hcol.Q, 0, 9, 4.9, 0x888866);
  }

  // Armor over the outfit, in its tier's colours (Crystal glows a little).
  const plate = (tier, w, h, d, x, y, z, parent) => {
    const [main] = ARMOR_COLOURS[tier - 1];
    const m = box(w, h, d, main, tier === 4 ? 0x3a1050 : 0);
    m.position.set(x * PX, y * PX, z * PX);
    parent.add(m);
  };
  if (gear[0]) { plate(gear[0], 9, 4.4, 9, 0, 6.6, 0, head); plate(gear[0], 9, 1.2, 1.4, 0, 4.4, 4.2, head); }
  if (gear[1]) {
    plate(gear[1], 8.8, 9, 4.8, 0, 19.4, 0, body);
    for (const a of arms) plate(gear[1], 4.8, 3.4, 4.8, 0, -0.6, 0, a);
  }
  if (gear[2]) for (const l of legs) plate(gear[2], 4.6, 6, 4.6, 0, -3, 0, l);
  if (gear[3]) for (const l of legs) plate(gear[3], 4.8, 3.2, 5, 0, -10.6, 0.3, l);

  let phase = 0, swing = 0;
  return {
    root, head,
    /// speed: metres per second along the ground; swinging: mining or fighting.
    animate(dt, speed, swinging) {
      phase += dt * Math.min(speed, 6) * 2.2;
      const a = Math.sin(phase) * Math.min(speed / 4, 1) * 0.8;
      legs[0].rotation.x = a;
      legs[1].rotation.x = -a;
      arms[0].rotation.x = -a;
      arms[1].rotation.x = a;
      swing = swinging ? (swing + dt * 9) % (Math.PI * 2) : 0;
      if (swinging) arms[1].rotation.x = -1.2 - Math.sin(swing) * 0.9;
    },
    dispose() {
      root.traverse((n) => {
        if (!n.isMesh) return;
        n.geometry.dispose();
        for (const m of [].concat(n.material)) { m.map?.dispose(); m.dispose(); }
      });
    },
  };
}

/// A small picture of a Crafter (a data URL of its SVG), for the panel.
export { svg as crafterSvg } from "./crafters.js";
