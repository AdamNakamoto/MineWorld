// The title screen: the whole planet as a slowly turning globe in space. Its surface is a picture of the world from
// above (planet-map.js, made in the world worker at load): x round the equator, z from north to south by Mercator
// (true shapes, the town round), and ice caps over the poles, where the square world runs out (past 85 degrees) and
// a ragged edge a little further in. Lit from one side, with a soft atmosphere and stars. Cheap to build and to draw
// (it runs on phones too).

import * as THREE from "https://esm.sh/three@0.160.0";

const SUN = new THREE.Vector3(-0.62, 0.42, 0.66).normalize(); // in view space: from the upper left, a little in front
const ICE = [236, 244, 250];

const PLANET_VERT = `
varying vec2 vUv;
varying vec3 vN;
varying vec3 vV;
void main() {
  vUv = uv;
  vN = normalize(normalMatrix * normal);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vV = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}`;
const PLANET_FRAG = `
uniform sampler2D map;
uniform vec3 sun;
uniform float ready;
varying vec2 vUv;
varying vec3 vN;
varying vec3 vV;
void main() {
  vec3 n = normalize(vN);
  vec3 c = mix(vec3(0.16, 0.42, 0.72), texture2D(map, vUv).rgb, ready);
  float l = dot(n, sun);
  float day = smoothstep(-0.28, 0.4, l);
  vec3 col = c * (0.16 + 0.98 * day);
  float rim = pow(1.0 - max(dot(n, normalize(vV)), 0.0), 2.6);
  col = mix(col, vec3(0.55, 0.78, 1.0), rim * (0.18 + 0.5 * day));
  gl_FragColor = vec4(col, 1.0);
}`;
const AIR_FRAG = `
uniform vec3 sun;
varying vec3 vN;
varying vec3 vV;
void main() {
  vec3 n = normalize(vN);
  float d = -dot(n, normalize(vV)); // 0 at the outer edge, about 0.42 where it meets the planet
  float glow = pow(clamp(d / 0.42, 0.0, 1.0), 1.8);
  float lit = 0.3 + 0.7 * smoothstep(-0.5, 0.6, dot(n, sun));
  gl_FragColor = vec4(vec3(0.42, 0.7, 1.0) * glow * lit, 1.0);
}`;

export function createGlobe() {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x03050d);
  const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 200);

  const tex = new THREE.DataTexture(new Uint8Array([40, 107, 184, 255]), 1, 1);
  tex.needsUpdate = true;
  const uniforms = { map: { value: tex }, sun: { value: SUN }, ready: { value: 0 } };
  const planet = new THREE.Mesh(new THREE.SphereGeometry(1, 96, 64),
    new THREE.ShaderMaterial({ uniforms, vertexShader: PLANET_VERT, fragmentShader: PLANET_FRAG }));
  // Turn the town (x = WORLD / 2, the middle of the picture) towards the camera to start with.
  planet.rotation.y = -Math.PI / 2;
  const tilt = new THREE.Group();
  tilt.rotation.z = 0.32; // an axial tilt
  tilt.rotation.x = 0.18;
  tilt.add(planet);
  scene.add(tilt);
  const air = new THREE.Mesh(new THREE.SphereGeometry(1.1, 64, 48), new THREE.ShaderMaterial({
    uniforms: { sun: uniforms.sun }, vertexShader: PLANET_VERT, fragmentShader: AIR_FRAG,
    side: THREE.BackSide, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
  }));
  scene.add(air);

  const n = 1400, pos = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const u = Math.random() * 2 - 1, a = Math.random() * Math.PI * 2, r = Math.sqrt(1 - u * u);
    pos.set([Math.cos(a) * r * 80, u * 80, Math.sin(a) * r * 80], i * 3);
  }
  const sg = new THREE.BufferGeometry();
  sg.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  scene.add(new THREE.Points(sg, new THREE.PointsMaterial({ color: 0xcfd8ff, size: 1.3, sizeAttenuation: false })));

  let shown = 0;
  return {
    scene, camera, planet, tilt,
    /// The planet from above (planet-map.js): w x h RGBA rows by latitude, north first. Fades in.
    setMap(data, w, h) {
      const px = new Uint8Array(w * h * 4);
      for (let j = 0; j < h; j++) {
        // Row j goes at the top for the north (the texture's first row is its bottom), and the poles get ice caps
        // with a ragged edge.
        const lat = 90 - ((j + 0.5) / h) * 180;
        const dst = (h - 1 - j) * w * 4;
        for (let i = 0; i < w; i++) {
          const lon = (i / w) * Math.PI * 2;
          const edge = 79.5 + 2 * Math.sin(lon * 5 + (lat > 0 ? 0 : 2)) + 1.2 * Math.sin(lon * 13 + 1);
          const s0 = (j * w + i) * 4;
          const ice = data[s0 + 3] ? Math.max(0, Math.min(1, (Math.abs(lat) - edge) / 1.5 + 0.5)) : 1;
          const s = s0, k = dst + i * 4;
          const speck = ((i * 7919 + j * 104729) % 23) / 23 * 14;
          for (let c = 0; c < 3; c++) px[k + c] = data[s + c] + (ICE[c] - speck - data[s + c]) * ice;
          px[k + 3] = 255;
        }
      }
      const t = new THREE.DataTexture(px, w, h);
      t.magFilter = THREE.LinearFilter;
      t.minFilter = THREE.LinearFilter;
      t.wrapS = THREE.RepeatWrapping;
      t.needsUpdate = true;
      uniforms.map.value = t;
      tex.dispose();
      shown = performance.now();
    },
    /// Each frame on the title screen: turn a little, fit the screen, and draw.
    render(renderer, dt) {
      planet.rotation.y += dt * 0.06;
      if (shown) uniforms.ready.value = Math.min(1, (performance.now() - shown) / 900);
      const w = renderer.domElement.clientWidth || innerWidth, h = renderer.domElement.clientHeight || innerHeight;
      camera.aspect = w / h;
      // The globe and its air (radius 1.1) fill about three quarters of the narrower side.
      const fit = 1.1 / 0.74 / (Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * Math.min(1, camera.aspect));
      camera.position.set(0, 0, fit + 0);
      camera.updateProjectionMatrix();
      renderer.render(scene, camera);
    },
  };
}
