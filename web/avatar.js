// A blocky miner for other players (and the NFT pictures, via portrait.js): head, body, arms and legs, dressed in
// one of the outfits in miners.js, with a walk cycle and a swing.

import * as THREE from "https://esm.sh/three@0.160.0";
import { designOf } from "./miners.js";

const PX = 1.8 / 32; // one "pixel" of the 32-pixel-tall figure, in metres

function faceTexture(d) {
  const c = document.createElement("canvas");
  c.width = c.height = 8;
  const g = c.getContext("2d");
  const css = (n) => `#${n.toString(16).padStart(6, "0")}`;
  g.fillStyle = css(d.skin);
  g.fillRect(0, 0, 8, 8);
  g.fillStyle = css(d.hair);
  g.fillRect(0, 0, 8, 2);
  g.fillRect(0, 2, 1, 1);
  g.fillRect(7, 2, 1, 1);
  if (d.hat?.type === "hood") {
    g.fillStyle = css(d.hat.color);
    g.fillRect(0, 0, 8, 3);
    g.fillRect(0, 5, 8, 3);
    g.fillRect(0, 0, 1, 8);
    g.fillRect(7, 0, 1, 8);
  }
  g.fillStyle = "#ffffff";
  g.fillRect(1, 3, 2, 1);
  g.fillRect(5, 3, 2, 1);
  g.fillStyle = d.eyes ? css(d.eyes) : "#2a2a44";
  g.fillRect(2, 3, 1, 1);
  g.fillRect(5, 3, 1, 1);
  if (d.beard) {
    g.fillStyle = css(d.beard);
    g.fillRect(1, 5, 6, 3);
    g.fillStyle = css(d.skin);
    g.fillRect(3, 5, 2, 1);
  } else if (d.hat?.type !== "hood") {
    g.fillStyle = "#8a4a3a";
    g.fillRect(3, 6, 2, 1);
  }
  const t = new THREE.CanvasTexture(c);
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestFilter;
  return t;
}

function box(w, h, d, color, emissive) {
  const m = new THREE.MeshLambertMaterial({ color, emissive: emissive ?? 0x000000 });
  return new THREE.Mesh(new THREE.BoxGeometry(w * PX, h * PX, d * PX), m);
}

function hat(d) {
  const g = new THREE.Group();
  const t = d.hat;
  if (!t) return g;
  const c = t.color;
  const add = (w, h, dd, y, z = 0, color = c, x = 0) => { const m = box(w, h, dd, color); m.position.set(x * PX, y * PX, z * PX); g.add(m); return m; };
  switch (t.type) {
    case "hardhat": add(9, 2, 9, 4.6); add(10, 0.6, 11, 3.8, 0.6); add(2, 1.4, 1, 3.4, 4.6, d.accent ?? 0xffffaa).material.emissive = new THREE.Color(0x666633); break;
    case "beanie": add(8.6, 3, 8.6, 3.4); add(2, 1.4, 2, 5.4, 0, d.accent ?? c); break;
    case "straw": add(8.4, 2, 8.4, 4.4); add(13, 0.6, 13, 3.6); break;
    case "safari": add(8.4, 2.4, 8.4, 4.4); add(11, 0.6, 11, 3.4); break;
    case "helmet": add(8.8, 8.8, 8.8, 0.2).material.transparent = false; add(1, 3, 1, 5.6, 0, d.accent); break;
    case "hood": add(8.6, 8.4, 8.6, 0.4, -0.3); break;
    case "dome": { const m = add(10, 10, 10, 0.4); m.material.transparent = true; m.material.opacity = 0.35; break; }
    case "brass": add(9.6, 9.6, 9.6, 0.2); add(5, 4, 1, 0.5, 4.9, 0x3ad8e8); break;
    case "horns": add(1.4, 3, 1.4, 4.6, 0, c, 3); add(1.4, 3, 1.4, 4.6, 0, c, -3); break;
    case "visor": add(8.8, 1.6, 1, 0.6, 4.4, c).material.emissive = new THREE.Color(c); break;
    case "crown": for (const x of [-3, -1, 1, 3]) add(1.4, 2.4, 8.4, 5, 0, c, x).material.emissive = new THREE.Color(0x401060); add(8.4, 1, 8.4, 4.2); break;
  }
  return g;
}

/// A miner wearing outfit `design` (an index into MINERS, or null for the rookie look).
export function createAvatar(design) {
  const d = designOf(design);
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  const glow = d.glow ?? null;
  // Legs (pivot at the hip), body, arms (pivot at the shoulder), head (pivot at the neck).
  const legs = [-2, 2].map((x) => {
    const pivot = new THREE.Group();
    pivot.position.set(x * PX, 12 * PX, 0);
    const leg = box(4, 12, 4, d.pants);
    leg.position.y = -6 * PX;
    const shoe = box(4.2, 2.4, 4.4, d.shoes, glow && d.shoes === 0xff5a1a ? 0x802000 : 0);
    shoe.position.set(0, -10.9 * PX, 0.2 * PX);
    pivot.add(leg, shoe);
    body.add(pivot);
    return pivot;
  });
  const torso = box(8, 12, 4, d.shirt);
  torso.position.y = 18 * PX;
  const belt = box(8.2, 1.4, 4.2, d.accent ?? d.pants, glow ? new THREE.Color(glow).multiplyScalar(0.5) : 0);
  belt.position.y = 12.8 * PX;
  body.add(torso, belt);
  const arms = [-6, 6].map((x) => {
    const pivot = new THREE.Group();
    pivot.position.set(x * PX, 23 * PX, 0);
    const arm = box(4, 12, 4, d.shirt);
    arm.position.y = -5 * PX;
    const hand = box(4.1, 2.5, 4.1, d.skin);
    hand.position.y = -10 * PX;
    pivot.add(arm, hand);
    body.add(pivot);
    return pivot;
  });
  const head = new THREE.Group();
  head.position.y = 24 * PX;
  // Box faces: +x, -x, +y, -y, +z (front), -z. The face goes on +z.
  const skull = new THREE.Mesh(new THREE.BoxGeometry(8 * PX, 8 * PX, 8 * PX), [
    new THREE.MeshLambertMaterial({ color: d.hair }), new THREE.MeshLambertMaterial({ color: d.hair }),
    new THREE.MeshLambertMaterial({ color: d.hair }), new THREE.MeshLambertMaterial({ color: d.skin }),
    new THREE.MeshLambertMaterial({ map: faceTexture(d) }), new THREE.MeshLambertMaterial({ color: d.hair }),
  ]);
  skull.position.y = 4 * PX;
  head.add(skull, hat(d));
  head.children[1].position.y = 4 * PX;
  body.add(head);
  if (glow) {
    const light = new THREE.PointLight(glow, 0.6, 4);
    light.position.y = 1.2;
    root.add(light);
  }

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
  };
}
