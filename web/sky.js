// The sky: its colour through the day, a square sun and moon, stars at night, and the daylight the block shader
// uses. The day follows the clock (rules.js), so everyone shares the same sunset.

import * as THREE from "https://esm.sh/three@0.160.0";
import { dayTime } from "./rules.js";

const DAY = new THREE.Color(0x8ec9ff), DUSK = new THREE.Color(0xf29a5c), NIGHT = new THREE.Color(0x0b1026), CAVE = new THREE.Color(0x05060a);

function disc(color, size, glow) {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d");
  if (glow) {
    const r = g.createRadialGradient(32, 32, 8, 32, 32, 32);
    r.addColorStop(0, "rgba(255,240,200,0.6)");
    r.addColorStop(1, "rgba(255,240,200,0)");
    g.fillStyle = r;
    g.fillRect(0, 0, 64, 64);
  }
  g.fillStyle = color;
  g.fillRect(20, 20, 24, 24);
  const t = new THREE.CanvasTexture(c);
  t.magFilter = THREE.NearestFilter;
  const m = new THREE.Mesh(new THREE.PlaneGeometry(size, size), new THREE.MeshBasicMaterial({ map: t, transparent: true, depthWrite: false, fog: false }));
  m.renderOrder = -1;
  return m;
}

export function createSky(scene) {
  const sun = disc("#fff3c4", 60, true), moon = disc("#e8ecf4", 40, false);
  scene.add(sun, moon);
  const n = 700, pos = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const u = Math.random() * 2 - 1, a = Math.random() * Math.PI * 2, r = Math.sqrt(1 - u * u);
    pos.set([Math.cos(a) * r * 300, Math.abs(u) * 300, Math.sin(a) * r * 300], i * 3);
  }
  const sg = new THREE.BufferGeometry();
  sg.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  const stars = new THREE.Points(sg, new THREE.PointsMaterial({ color: 0xffffff, size: 1.6, sizeAttenuation: false, transparent: true, fog: false, depthWrite: false }));
  scene.add(stars);
  const bg = new THREE.Color();
  scene.background = bg;

  return {
    /// `ms`: the clock; `cam`: the camera; `under`: how deep in a cave the eye is (0 open air .. 1 deep).
    update(ms, cam, under = 0) {
      const t = dayTime(ms);
      const ang = t * Math.PI * 2; // 0 sunrise, pi/2 noon
      const elev = Math.sin(ang);
      const daylight = Math.max(0.24, Math.min(1, 0.3 + elev * 1.4));
      const dusk = Math.max(0, 1 - Math.abs(elev) * 4);
      bg.copy(NIGHT).lerp(DAY, Math.max(0, Math.min(1, (elev + 0.15) * 2.2)));
      bg.lerp(DUSK, dusk * 0.45);
      bg.lerp(CAVE, under * 0.85);
      const place = (m, a, d) => {
        m.position.set(cam.position.x + Math.cos(a) * d, cam.position.y + Math.sin(a) * d, cam.position.z + 40);
        m.lookAt(cam.position);
      };
      place(sun, ang, 320);
      place(moon, ang + Math.PI, 320);
      stars.position.copy(cam.position);
      stars.material.opacity = Math.max(0, -elev * 2.5) * (1 - under);
      stars.visible = stars.material.opacity > 0.01;
      return { daylight, color: bg };
    },
  };
}
