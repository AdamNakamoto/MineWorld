// MineWorldCraft: the game loop. Walking, mining, placing, fighting, the HUD, and wiring the world, the room
// (net.js), the chain (chain.js) and the Mining Site panel together.

import * as THREE from "https://esm.sh/three@0.160.0";
import { BLOCKS, AIR, WATER, TOOLS, HAND_DAMAGE, breakTime, itemName } from "./blocks.js";
import { SPAWN, REACH, ATTACK_MS, DAY_MS, TOWN, protectedAt, isNight, MOB_KINDS, MOBS_PER_PLAYER, UNDERGROUND_Y, PROTECT_R, CHUNK } from "./rules.js";
import { OFFICE } from "./worldgen.js";
import { makeAtlas, iconFor, faceTiles, tileOf, ATLAS_TILES } from "./textures.js";
import { createWorld, keyOf } from "./world.js";
import { moveBox, boxHitsBlock } from "./physics.js";
import { createInventory, SLOTS, HOTBAR } from "./inventory.js";
import { createMobs } from "./mobs.js";
import { createSky } from "./sky.js";
import { createNet, short } from "./net.js";
import { connectChain } from "./chain.js";
import { createPanel } from "./panel.js";
import { cleanChat } from "./chat-rules.js";
import { fmtMine, toCents, DAILY_EARN_CAP } from "./rewards.js";
import { sfx } from "./sfx.js";
import { roomUrl } from "./config.js";

THREE.ColorManagement.enabled = false; // colours are used as written (the block shader works the same way)
const $ = (id) => document.getElementById(id);
const touch = matchMedia("(pointer: coarse)").matches;
// On localhost only: ?t=0.25 fixes the sky's time of day (0 sunrise, 0.25 noon, 0.75 midnight), and window.mwc
// exposes the game for testing.
const local = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
const dev = { time: local && new URLSearchParams(location.search).has("t") ? Number(new URLSearchParams(location.search).get("t")) : null };

// ---------------------------------------------------------------- scene
const canvas = $("c");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: "high-performance" });
renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
renderer.setPixelRatio(Math.min(devicePixelRatio, touch ? 1.5 : 2));
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(75, 1, 0.05, 500);
camera.rotation.order = "YXZ";
scene.add(camera);
const ambient = new THREE.AmbientLight(0xffffff, 0.6);
const sunLight = new THREE.DirectionalLight(0xffffff, 0.7);
sunLight.position.set(0.4, 1, 0.3);
scene.add(ambient, sunLight);
function resize() {
  renderer.setSize(innerWidth, innerHeight, false);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
}
addEventListener("resize", resize);
resize();

const atlas = makeAtlas();
const world = createWorld(scene, atlas);
const sky = createSky(scene);
const inv = createInventory();

let settings = { view: touch ? 5 : 7, mouse: 1 };
try { settings = { ...settings, ...JSON.parse(localStorage.getItem("mwc:settings")) }; } catch {}
world.setRadius(settings.view);

// ---------------------------------------------------------------- the player
const player = {
  pos: new THREE.Vector3(SPAWN.x, SPAWN.y, SPAWN.z), vel: new THREE.Vector3(), yaw: 0, pitch: 0,
  onGround: false, water: false, health: 20, hurtAt: 0, alive: true, fallFrom: null, sel: 0,
};
const HALF = 0.3, TALL = 1.8, EYE = 1.62;

// ---------------------------------------------------------------- HUD helpers
function toast(text, kind = "") {
  const t = document.createElement("div");
  t.className = `toast ${kind}`;
  t.textContent = text;
  $("toasts").append(t);
  while ($("toasts").children.length > 4) $("toasts").firstChild.remove();
  setTimeout(() => t.remove(), 4600);
}

function drawHearts() {
  const h = $("hearts");
  h.innerHTML = "";
  for (let i = 0; i < 10; i++) {
    const d = document.createElement("div");
    const v = player.health - i * 2;
    d.className = `heart ${v >= 2 ? "full" : v === 1 ? "half" : ""}`;
    h.append(d);
  }
}

function slotHtml(i, extraClass = "") {
  const s = inv.slot(i);
  return `<div class="slot ${extraClass}" data-slot="${i}">${s ? `<img src="${iconFor(s.id, atlas)}" alt="${itemName(s.id)}" title="${itemName(s.id)}">${s.n > 1 ? `<span class="n">${s.n}</span>` : ""}` : ""}</div>`;
}
function drawHotbar() {
  let html = "";
  for (let i = 0; i < HOTBAR; i++) html += slotHtml(i, i === player.sel ? "on" : "");
  $("hotbar").innerHTML = html;
  updateHeld();
}
$("hotbar").addEventListener("click", (e) => {
  const s = e.target.closest("[data-slot]");
  if (s) select(Number(s.dataset.slot));
});
function select(i) {
  player.sel = (i + HOTBAR) % HOTBAR;
  drawHotbar();
  const s = inv.slot(player.sel);
  if (s) showTarget(itemName(s.id), 1200);
}
let targetTimer = 0;
function showTarget(text, ms) {
  const t = $("target");
  t.textContent = text;
  t.hidden = false;
  clearTimeout(targetTimer);
  targetTimer = setTimeout(() => (t.hidden = true), ms);
}

// The inventory sheet: swap slots, craft.
let picked = null;
function drawInventory() {
  if ($("inv").hidden) return;
  let html = "";
  for (let i = 0; i < SLOTS; i++) html += slotHtml(i, picked === i ? "picked" : "");
  $("invGrid").innerHTML = html;
  $("recipes").innerHTML = inv.recipes.map((r, i) => {
    const need = Object.entries(r.need).map(([id, n]) => `${n} ${itemName(Number(id))}`).join(" + ");
    return `<button class="recipe" data-recipe="${i}" ${inv.canCraft(r) ? "" : "disabled"}><img src="${iconFor(r.out, atlas)}" alt="">
      <span>${r.n > 1 ? `${r.n} ` : ""}${itemName(r.out)}<span class="need">${need}</span></span></button>`;
  }).join("");
}
inv.onChange = () => { drawHotbar(); drawInventory(); };
$("inv").addEventListener("click", (e) => {
  if (e.target === $("inv") || e.target.closest("[data-close]")) return closeInventory();
  const s = e.target.closest("[data-slot]");
  if (s) {
    const i = Number(s.dataset.slot);
    if (picked === null) picked = inv.slot(i) ? i : null;
    else { inv.swap(picked, i); picked = null; }
    return drawInventory();
  }
  const r = e.target.closest("[data-recipe]");
  if (r && !r.disabled) {
    const rec = inv.recipes[Number(r.dataset.recipe)];
    inv.craft(rec);
    sfx.place();
    toast(`Crafted ${rec.n > 1 ? `${rec.n} ` : ""}${itemName(rec.out)}`, "good");
  }
});
function openInventory() { picked = null; $("inv").hidden = false; document.exitPointerLock?.(); drawInventory(); }
function closeInventory() { $("inv").hidden = true; }

// ---------------------------------------------------------------- held item, target box, cracks, debris
const atlasTex = world.uniforms.map.value;
const heldGroup = new THREE.Group();
camera.add(heldGroup);
heldGroup.position.set(0.48, -0.42, -0.78);
let heldMesh = null, swingT = 0;
function tileUVs(geo, tilesForFaces) {
  // BoxGeometry face order: +x, -x, +y, -y, +z, -z; 4 vertices each.
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
function updateHeld() {
  if (heldMesh) { heldGroup.remove(heldMesh); heldMesh.geometry.dispose(); heldMesh.material.map !== atlasTex && heldMesh.material.map?.dispose(); heldMesh.material.dispose(); heldMesh = null; }
  const s = inv.slot(player.sel);
  if (!s) return;
  if (s.id < 64) {
    const g = new THREE.BoxGeometry(0.2, 0.2, 0.2);
    const [top, side, bottom] = faceTiles(s.id);
    tileUVs(g, [side, side, top, bottom, side, side]);
    heldMesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ map: atlasTex, alphaTest: 0.5, transparent: s.id === WATER }));
    heldMesh.rotation.set(0.2, 0.7, 0);
  } else {
    const t = new THREE.TextureLoader().load(iconFor(s.id, atlas));
    t.magFilter = THREE.NearestFilter;
    heldMesh = new THREE.Mesh(new THREE.PlaneGeometry(0.34, 0.34), new THREE.MeshBasicMaterial({ map: t, transparent: true, alphaTest: 0.3, side: THREE.DoubleSide }));
    heldMesh.rotation.set(0, -0.3, 0.2);
  }
  heldGroup.add(heldMesh);
}

const outline = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1.004, 1.004, 1.004)), new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.6 }));
outline.visible = false;
scene.add(outline);
const crackGeo = new THREE.BoxGeometry(1.01, 1.01, 1.01);
const crackBase = crackGeo.attributes.uv.array.slice();
const crack = new THREE.Mesh(crackGeo, new THREE.MeshBasicMaterial({ map: atlasTex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1 }));
crack.visible = false;
scene.add(crack);
let crackStage = -1;
function setCrack(stage) {
  if (stage === crackStage) return;
  crackStage = stage;
  crackGeo.attributes.uv.array.set(crackBase);
  const t = tileOf(`crack${stage}`);
  tileUVs(crackGeo, [t, t, t, t, t, t]);
}

// The average colour of each block's side, for debris.
const blockColour = [];
{
  const g = atlas.getContext("2d");
  for (const b of BLOCKS) {
    if (!b?.tex) continue;
    const t = faceTiles(b.id)[1];
    const d = g.getImageData((t % ATLAS_TILES) * 16, Math.floor(t / ATLAS_TILES) * 16, 16, 16).data;
    let r = 0, gg = 0, bb = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 100) { r += d[i]; gg += d[i + 1]; bb += d[i + 2]; n++; }
    blockColour[b.id] = n ? new THREE.Color(r / n / 255, gg / n / 255, bb / n / 255) : new THREE.Color(0.5, 0.5, 0.5);
  }
}
const debris = [];
const debrisGeo = new THREE.BoxGeometry(0.11, 0.11, 0.11);
function burst(x, y, z, b) {
  for (let i = 0; i < 10; i++) {
    const m = new THREE.Mesh(debrisGeo, new THREE.MeshBasicMaterial({ color: blockColour[b] ?? 0x888888 }));
    m.position.set(x + 0.2 + Math.random() * 0.6, y + 0.2 + Math.random() * 0.6, z + 0.2 + Math.random() * 0.6);
    m.userData.v = new THREE.Vector3((Math.random() - 0.5) * 4, Math.random() * 4 + 1, (Math.random() - 0.5) * 4);
    m.userData.life = 0.5 + Math.random() * 0.3;
    scene.add(m);
    debris.push(m);
  }
}
function updateDebris(dt) {
  for (let i = debris.length - 1; i >= 0; i--) {
    const m = debris[i];
    m.userData.life -= dt;
    m.userData.v.y -= 20 * dt;
    m.position.addScaledVector(m.userData.v, dt);
    if (m.userData.life <= 0) { scene.remove(m); m.material.dispose(); debris.splice(i, 1); }
  }
}

// The Mining Office's sign.
{
  const c = document.createElement("canvas");
  c.width = 512; c.height = 96;
  const g = c.getContext("2d");
  g.fillStyle = "#3a2a18"; g.fillRect(0, 0, 512, 96);
  g.strokeStyle = "#f5c832"; g.lineWidth = 8; g.strokeRect(4, 4, 504, 88);
  g.fillStyle = "#f5c832"; g.font = "700 46px Silkscreen, monospace"; g.textAlign = "center"; g.textBaseline = "middle";
  g.fillText("MINING OFFICE", 256, 50);
  const t = new THREE.CanvasTexture(c);
  const sign = new THREE.Mesh(new THREE.PlaneGeometry(6, 1.1), new THREE.MeshBasicMaterial({ map: t }));
  sign.position.set(TOWN.x + 0.5, TOWN.y + 4.45, TOWN.z + OFFICE.z1 + 1.02);
  scene.add(sign);
  document.fonts?.ready.then(() => { g.fillStyle = "#3a2a18"; g.fillRect(8, 8, 496, 80); g.fillStyle = "#f5c832"; g.fillText("MINING OFFICE", 256, 50); t.needsUpdate = true; });
}

// ---------------------------------------------------------------- monsters
const mobs = createMobs(scene, world, {
  bite(dmg, dx, dz) {
    hurt(dmg);
    player.vel.x += dx * 6; player.vel.z += dz * 6; player.vel.y = Math.max(player.vel.y, 4);
  },
});
let offlineMobAt = 0, offlineMobSeq = 0;
function offlineMobs(now) {
  // With no world server there's no ledger, but the nights still have monsters.
  if (net?.online || now < offlineMobAt || mobs.count() >= MOBS_PER_PLAYER) return;
  if (!isNight(Date.now()) && player.pos.y >= UNDERGROUND_Y) return;
  if (Math.hypot(player.pos.x - TOWN.x, player.pos.z - TOWN.z) < PROTECT_R + 16) return;
  offlineMobAt = now + 20_000;
  const a = Math.random() * Math.PI * 2;
  mobs.spawn(-(++offlineMobSeq), MOB_KINDS[Math.floor(Math.random() * 3)], player.pos.x + Math.cos(a) * 12, player.pos.y, player.pos.z + Math.sin(a) * 12);
}

// ---------------------------------------------------------------- health
function hurt(n) {
  if (!player.alive || n <= 0) return;
  player.health = Math.max(0, player.health - n);
  player.hurtAt = performance.now();
  sfx.hurt();
  drawHearts();
  $("hearts").classList.remove("hurt");
  void $("hearts").offsetWidth;
  $("hearts").classList.add("hurt");
  if (player.health <= 0) {
    player.alive = false;
    setMining(false);
    document.exitPointerLock?.();
    $("dead").hidden = false;
  }
}
$("respawn").addEventListener("click", () => {
  player.pos.set(SPAWN.x, SPAWN.y, SPAWN.z);
  player.vel.set(0, 0, 0);
  player.yaw = 0;
  player.pitch = 0;
  player.health = 20;
  player.alive = true;
  player.fallFrom = null;
  $("dead").hidden = true;
  mobs.clear();
  net?.respawn();
  drawHearts();
});

// ---------------------------------------------------------------- the room
let net = null, serverOffset = 0;
const synced = new Set();
const ledger = { signedIn: false, wallet: null, today: 0, total: 0, cap: toCents(DAILY_EARN_CAP) };
function drawLedger() {
  $("earnToday").textContent = fmtMine(ledger.today);
  $("earnWho").textContent = ledger.signedIn ? `${short(ledger.wallet)} · ${fmtMine(ledger.total)} earned in all` : "Guest: sign in to earn (M)";
  panel?.render();
}
const url = roomUrl();
if (url) {
  net = createNet(url, scene, {
    status(on) {
      // Every chunk in range is asked for again once connected (edits made meanwhile come back with it).
      synced.clear();
      world.forgetRequests();
      if (!on) mobs.clear();
      $("onlineN").hidden = !on;
    },
    welcome(serverTime, count) {
      serverOffset = serverTime - Date.now();
      $("onlineN").textContent = `👥 ${count} online`;
      if (ledger.wallet) tryResume(ledger.wallet);
    },
    edits(k, list) { world.setEdits(k, list); synced.add(k); },
    set(x, y, z, b) { world.set(x, y, z, b); },
    earn({ cents, today, total, what }) {
      Object.assign(ledger, { today, total });
      if (what === "cap" || !cents) { if (what === "cap") showTarget("Daily $MINE limit reached: come back tomorrow (UTC)", 2500); }
      else {
        sfx.coin();
        const c = document.querySelector(".coin");
        c.classList.remove("pop"); void c.offsetWidth; c.classList.add("pop");
        if (cents >= 300) toast(`+${fmtMine(cents)} $MINE · ${typeof what === "number" ? itemName(what) : what}`, "gold");
      }
      drawLedger();
    },
    ledger({ today, total }) { Object.assign(ledger, { today, total }); drawLedger(); },
    mob(id, kind, x, y, z) { mobs.spawn(id, kind, x, y, z); },
    mobdead(id) { mobs.kill(id); sfx.win(); },
    chat(l) { chatLine(l.name, l.text, l.mine); },
    count(n) { $("onlineN").textContent = `👥 ${n} online`; },
    error(text) { toast(text, "bad"); },
    signedin(wallet, token, l) {
      Object.assign(ledger, { signedIn: true, wallet, today: l.today, total: l.total, cap: l.cap });
      try { localStorage.setItem(`mwc:tok:${wallet.toLowerCase()}`, token); } catch {}
      drawLedger();
      if (panel?.worn !== null && panel?.worn !== undefined) net.design(panel.worn);
    },
    signedout(reason) {
      ledger.signedIn = false;
      try { localStorage.removeItem(`mwc:tok:${ledger.wallet?.toLowerCase()}`); } catch {}
      drawLedger();
      toast(reason);
    },
  });
}
function tryResume(wallet) {
  let token = null;
  try { token = localStorage.getItem(`mwc:tok:${wallet.toLowerCase()}`); } catch {}
  if (token && net) net.resumeWith(wallet, token);
}

// ---------------------------------------------------------------- chain + panel
let chain = null, panel = null;
async function signIn() {
  if (!net?.online) throw new Error("The world server is offline right now, so earnings can't be counted. Try again soon.");
  if (!chain?.account) await chain?.login();
  if (!chain?.account) throw new Error("Log in with your wallet first.");
  await net.signIn(chain.account, (m) => chain.signMessage(m));
}
connectChain().catch((e) => { console.warn("chain unavailable", e); return null; }).then((c) => {
  chain = c;
  panel = createPanel({
    chain, net,
    ledger: () => ledger,
    signIn,
    toast,
    wear(design, tokenId) { net?.design(tokenId); },
  });
  if (!chain) return;
  chain.onAccount = (a) => {
    ledger.signedIn = false;
    ledger.wallet = a;
    ledger.today = ledger.total = 0;
    inv.load(a);
    if (a) tryResume(a);
    else net?.signOut();
    drawLedger();
  };
  chain.reconnect().catch(() => {});
});
inv.load(null);

// ---------------------------------------------------------------- chat
function chatLine(name, text, mine) {
  const row = document.createElement("div");
  row.className = `line${mine ? " me" : ""}`;
  const b = document.createElement("b");
  b.textContent = mine ? "You" : name;
  row.append(b, document.createTextNode(text));
  $("chatLog").append(row);
  while ($("chatLog").children.length > 30) $("chatLog").firstChild.remove();
}
function openChat() {
  if (!net) return toast("Chat needs the world server (offline right now).");
  document.exitPointerLock?.();
  $("chat").classList.add("open");
  $("chatForm").hidden = false;
  $("chatInput").focus();
}
function closeChat() {
  $("chat").classList.remove("open");
  $("chatForm").hidden = true;
  $("chatInput").blur();
}
$("chatForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const r = cleanChat($("chatInput").value);
  if (r.error) return toast(r.error, "bad");
  net.chat(r.text);
  $("chatInput").value = "";
  closeChat();
  if (!touch) canvas.requestPointerLock?.();
});
$("chatInput").addEventListener("keydown", (e) => { if (e.key === "Escape") closeChat(); e.stopPropagation(); });

// ---------------------------------------------------------------- input
const keys = new Set();
let mining = false, placing = false, placeAt = 0, attackAt = 0, playing = false;
const anyOverlay = () => !$("inv").hidden || (panel?.isOpen ?? false) || !$("dead").hidden || !$("wallets").hidden || !$("chatForm").hidden;
function setMining(on) {
  if (mining === on) return;
  mining = on;
  net?.act(on);
}

addEventListener("keydown", (e) => {
  if (!playing || e.target.tagName === "INPUT") return;
  keys.add(e.code);
  if (e.code === "KeyE") { $("inv").hidden ? openInventory() : closeInventory(); }
  else if (e.code === "KeyM") { panel?.isOpen ? panel.close() : panel?.open(); }
  else if (e.code === "Enter" || e.code === "KeyT") { e.preventDefault(); openChat(); }
  else if (e.code === "Escape") { closeInventory(); panel?.close(); }
  else if (/^Digit[1-9]$/.test(e.code)) select(Number(e.code.slice(5)) - 1);
  if (e.code === "Space") e.preventDefault();
});
addEventListener("keyup", (e) => keys.delete(e.code));
addEventListener("blur", () => { keys.clear(); setMining(false); placing = false; });

canvas.addEventListener("click", () => {
  if (playing && !touch && !anyOverlay() && document.pointerLockElement !== canvas) canvas.requestPointerLock?.();
});
canvas.addEventListener("contextmenu", (e) => e.preventDefault());
canvas.addEventListener("mousedown", (e) => {
  if (document.pointerLockElement !== canvas) return;
  sfx.unlock();
  if (e.button === 0) setMining(true);
  if (e.button === 2) { placing = true; placeAt = 0; }
});
addEventListener("mouseup", (e) => {
  if (e.button === 0) setMining(false);
  if (e.button === 2) placing = false;
});
addEventListener("mousemove", (e) => {
  if (document.pointerLockElement !== canvas) return;
  const k = 0.0022 * settings.mouse;
  player.yaw -= e.movementX * k;
  player.pitch = Math.max(-1.55, Math.min(1.55, player.pitch - e.movementY * k));
});
addEventListener("wheel", (e) => {
  if (document.pointerLockElement === canvas) select(player.sel + Math.sign(e.deltaY));
}, { passive: true });
document.addEventListener("pointerlockchange", () => { if (document.pointerLockElement !== canvas) { setMining(false); placing = false; } });

// Touch: a stick on the left, drag anywhere else to look, buttons to jump, mine and place.
const stickState = { id: null, x: 0, y: 0, dx: 0, dy: 0 };
let lookTouch = null;
let touchJump = false;
if (touch) {
  const stick = $("stick"), knob = stick.querySelector(".knob");
  stick.addEventListener("touchstart", (e) => {
    const t = e.changedTouches[0];
    const r = stick.getBoundingClientRect();
    Object.assign(stickState, { id: t.identifier, x: r.left + r.width / 2, y: r.top + r.height / 2 });
    e.preventDefault();
  }, { passive: false });
  addEventListener("touchmove", (e) => {
    for (const t of e.changedTouches) {
      if (t.identifier === stickState.id) {
        let dx = t.clientX - stickState.x, dy = t.clientY - stickState.y;
        const len = Math.hypot(dx, dy), max = 45;
        if (len > max) { dx *= max / len; dy *= max / len; }
        stickState.dx = dx / max; stickState.dy = dy / max;
        knob.style.transform = `translate(${dx}px, ${dy}px)`;
      } else if (lookTouch && t.identifier === lookTouch.id) {
        player.yaw -= (t.clientX - lookTouch.x) * 0.006 * settings.mouse;
        player.pitch = Math.max(-1.55, Math.min(1.55, player.pitch - (t.clientY - lookTouch.y) * 0.006 * settings.mouse));
        lookTouch.x = t.clientX; lookTouch.y = t.clientY;
      }
    }
  }, { passive: true });
  addEventListener("touchend", (e) => {
    for (const t of e.changedTouches) {
      if (t.identifier === stickState.id) { stickState.id = null; stickState.dx = stickState.dy = 0; knob.style.transform = ""; }
      if (lookTouch && t.identifier === lookTouch.id) lookTouch = null;
    }
  });
  canvas.addEventListener("touchstart", (e) => {
    if (lookTouch) return;
    const t = e.changedTouches[0];
    lookTouch = { id: t.identifier, x: t.clientX, y: t.clientY };
  }, { passive: true });
  const hold = (el, on, off) => {
    el.addEventListener("touchstart", (e) => { e.preventDefault(); el.classList.add("on"); sfx.unlock(); on(); }, { passive: false });
    el.addEventListener("touchend", (e) => { e.preventDefault(); el.classList.remove("on"); off(); }, { passive: false });
  };
  hold($("tJump"), () => (touchJump = true), () => (touchJump = false));
  hold($("tMine"), () => setMining(true), () => setMining(false));
  hold($("tPlace"), () => { placing = true; placeAt = 0; }, () => (placing = false));
}

// Buttons.
$("siteBtn").addEventListener("click", () => panel?.open());
$("titleSite").addEventListener("click", () => panel?.open());
$("invBtn").addEventListener("click", () => ($("inv").hidden ? openInventory() : closeInventory()));
$("soundBtn").addEventListener("click", () => { $("soundBtn").textContent = sfx.toggle() ? "🔇" : "🔊"; });
$("soundBtn").textContent = sfx.muted ? "🔇" : "🔊";
$("setBtn").addEventListener("click", () => { $("settings").hidden = !$("settings").hidden; document.exitPointerLock?.(); });
$("settings").addEventListener("click", (e) => { if (e.target.closest("[data-close]")) $("settings").hidden = true; });
$("viewDist").value = settings.view;
$("viewDistN").textContent = settings.view;
$("mouseSpeed").value = settings.mouse;
const saveSettings = () => { try { localStorage.setItem("mwc:settings", JSON.stringify(settings)); } catch {} };
$("viewDist").addEventListener("input", (e) => { settings.view = Number(e.target.value); $("viewDistN").textContent = settings.view; world.setRadius(settings.view); saveSettings(); });
$("mouseSpeed").addEventListener("input", (e) => { settings.mouse = Number(e.target.value); saveSettings(); });

$("play").addEventListener("click", () => {
  sfx.unlock();
  $("title").hidden = true;
  $("hud").hidden = false;
  $("touch").hidden = !touch;
  playing = true;
  if (!touch) canvas.requestPointerLock?.();
  net?.start({});
  if (!net) toast("Playing offline: the world server isn't set up yet, so nothing is earned.");
  drawHotbar();
  drawHearts();
  drawLedger();
});
if (url) fetch(url.replace(/^ws/, "http").replace(/\/ws$/, "/count")).then((r) => r.json()).then((j) => {
  if (j?.online >= 0) { $("onlineTitle").hidden = false; $("onlineTitle").textContent = `● ${j.online} mining right now`; }
}).catch(() => {});

// ---------------------------------------------------------------- mining, placing, fighting
let breaking = null; // { x, y, z, b, t, need }
const ray = new THREE.Vector3();
function interact(dt, now) {
  const eye = camera.position;
  camera.getWorldDirection(ray);
  const hit = world.raycast(eye, ray, REACH);
  const mobHit = mobs.raycast(eye, ray, 3.6);
  const mobFirst = mobHit && (!hit || mobHit.t < hit.t);
  // Online, a chunk can be changed only once the room has sent its edits (so nothing is undone when they arrive).
  const allowed = hit && (!net || (net.online && synced.has(keyOf(Math.floor(hit.x / CHUNK), Math.floor(hit.z / CHUNK)))));
  if (hit && !allowed && (mining || placing)) showTarget(net?.online ? "Loading…" : "Reconnecting to the world…", 600);
  if (hit && !mobFirst) {
    outline.visible = true;
    outline.position.set(hit.x + 0.5, hit.y + 0.5, hit.z + 0.5);
  } else outline.visible = false;

  const hand = inv.slot(player.sel)?.id ?? null;
  if (mining && player.alive) {
    swingT += dt * 10;
    if (mobFirst) {
      breaking = null;
      if (now - attackAt > ATTACK_MS) {
        attackAt = now;
        const tool = TOOLS[hand];
        const dmg = tool?.kind === "sword" ? tool.damage : HAND_DAMAGE + (tool?.kind === "pick" ? 1 : 0);
        mobs.hit(mobHit.mob, dmg, ray.x, ray.z);
        if (mobHit.mob.id > 0) net?.hit(mobHit.mob.id, dmg);
        sfx.hit();
      }
    } else if (hit && allowed) {
      if (protectedAt(hit.x, hit.z)) { showTarget("The town is protected: mine outside it", 1500); breaking = null; }
      else if (BLOCKS[hit.b].hardness === Infinity) breaking = null;
      else {
        if (!breaking || breaking.x !== hit.x || breaking.y !== hit.y || breaking.z !== hit.z || breaking.b !== hit.b) {
          const bt = breakTime(hit.b, hand);
          breaking = { x: hit.x, y: hit.y, z: hit.z, b: hit.b, t: 0, need: Math.max(0.05, bt.seconds), drops: bt.drops, tick: 0 };
        }
        breaking.t += dt;
        breaking.tick -= dt;
        if (breaking.tick <= 0) { breaking.tick = 0.25; sfx.dig(BLOCKS[hit.b].tier > 0); }
        if (breaking.t >= breaking.need) finishBreak(breaking);
      }
    } else breaking = null;
  } else {
    breaking = null;
    swingT = 0;
  }
  if (breaking) {
    crack.visible = true;
    crack.position.set(breaking.x + 0.5, breaking.y + 0.5, breaking.z + 0.5);
    setCrack(Math.min(4, Math.floor((breaking.t / breaking.need) * 5)));
  } else crack.visible = false;

  if (placing && player.alive && now > placeAt && hit && allowed && !mobFirst) {
    placeAt = now + 250;
    const s = inv.slot(player.sel);
    const px = hit.x + hit.nx, py = hit.y + hit.ny, pz = hit.z + hit.nz;
    if (s && s.id < 64 && BLOCKS[s.id]?.placeable) {
      const there = world.get(px, py, pz);
      if (protectedAt(px, pz)) showTarget("The town is protected: build outside it", 1500);
      else if ((there === AIR || there === WATER) && !boxHitsBlock(player.pos, HALF, TALL, px, py, pz) && py > 0 && py < 128) {
        world.set(px, py, pz, s.id);
        inv.useSlot(player.sel);
        net?.place(px, py, pz, s.id);
        sfx.place();
        swingT = 1;
      }
    }
  }
  // The name of what you're looking at.
  if (mobFirst) showTarget(mobHit.mob.def.name, 300);
}

function finishBreak(b) {
  world.set(b.x, b.y, b.z, AIR);
  burst(b.x, b.y, b.z, b.b);
  sfx.broke(BLOCKS[b.b].tier > 0);
  net?.breakBlock(b.x, b.y, b.z);
  const drop = BLOCKS[b.b].drop;
  if (b.drops && drop !== null) {
    if (inv.add(drop, 1)) showTarget("Inventory full", 1200);
  } else if (b.b === 8 /* leaves */ && Math.random() < 0.12) inv.add(64, 1); // sometimes a stick
  breaking = null;
}

// ---------------------------------------------------------------- the loop
const clock = new THREE.Clock();
let regenAt = 0;
const forward = new THREE.Vector3(), right = new THREE.Vector3();
function frame() {
  requestAnimationFrame(frame);
  const dt = Math.min(clock.getDelta(), 0.05);
  const now = performance.now();

  // Chunks around you (and ask the room for their edits).
  const fresh = world.update(player.pos.x, player.pos.z, playing ? 6 : 10);
  if (fresh.length && net?.online) net.chunks(fresh);

  if (playing) {
    const ready = world.loaded(Math.floor(player.pos.x), Math.floor(player.pos.z));
    // Movement.
    let fx = 0, fz = 0;
    const typing = anyOverlay();
    if (!typing) {
      if (keys.has("KeyW") || keys.has("ArrowUp")) fz += 1;
      if (keys.has("KeyS") || keys.has("ArrowDown")) fz -= 1;
      if (keys.has("KeyA") || keys.has("ArrowLeft")) fx -= 1;
      if (keys.has("KeyD") || keys.has("ArrowRight")) fx += 1;
    }
    if (stickState.id !== null) { fx += stickState.dx; fz -= stickState.dy; }
    const len = Math.hypot(fx, fz);
    if (len > 1) { fx /= len; fz /= len; }
    forward.set(-Math.sin(player.yaw), 0, -Math.cos(player.yaw));
    right.set(Math.cos(player.yaw), 0, -Math.sin(player.yaw));
    const sprint = keys.has("ShiftLeft") || keys.has("ShiftRight") || (touch && Math.hypot(stickState.dx, stickState.dy) > 0.95);
    const speed = (player.water ? 2.6 : sprint ? 5.8 : 4.3) * (player.alive ? 1 : 0);
    const tx = (forward.x * fz + right.x * fx) * speed, tz = (forward.z * fz + right.z * fx) * speed;
    const k = 1 - Math.exp(-dt * (player.onGround ? 14 : player.water ? 5 : 3));
    player.vel.x += (tx - player.vel.x) * k;
    player.vel.z += (tz - player.vel.z) * k;
    const jump = !typing && (keys.has("Space") || touchJump);
    if (jump && player.onGround && !player.water) player.vel.y = 8.6;
    if (jump && player.water) player.vel.y = Math.min(player.vel.y + 30 * dt, 3.5);
    if (ready) {
      const r = moveBox(world, player.pos, player.vel, HALF, TALL, dt);
      // Auto-jump on touch screens, where pressing jump while walking is awkward.
      if (touch && r.wall && r.onGround && len > 0.3) player.vel.y = 8.6;
      if (!r.onGround && !r.water) player.fallFrom = Math.max(player.fallFrom ?? player.pos.y, player.pos.y);
      else {
        if (player.fallFrom !== null && r.onGround && !r.water) {
          const drop = player.fallFrom - player.pos.y;
          if (drop > 3.5) hurt(Math.floor(drop - 3));
        }
        player.fallFrom = null;
      }
      player.onGround = r.onGround;
      player.water = r.water;
    }
    if (player.pos.y < -30) { hurt(99); }
    // Health comes back slowly when nothing has hurt you for a while.
    if (player.alive && player.health < 20 && now - player.hurtAt > 6000 && now > regenAt) {
      regenAt = now + 3000;
      player.health += 1;
      drawHearts();
    }

    camera.position.set(player.pos.x, player.pos.y + EYE, player.pos.z);
    camera.rotation.set(player.pitch, player.yaw, 0);
    if (!typing) interact(dt, now);
    else { outline.visible = false; crack.visible = false; breaking = null; }
    heldGroup.position.set(0.48, -0.42 - Math.abs(Math.sin(swingT)) * 0.1, -0.78 + Math.sin(swingT) * 0.08);
    heldGroup.rotation.x = -Math.abs(Math.sin(swingT)) * 0.6;

    mobs.update(dt, player);
    offlineMobs(now);
    net?.tick(dt, { x: player.pos.x, y: player.pos.y, z: player.pos.z, yaw: player.yaw, pitch: player.pitch });
    updateDebris(dt);
    $("where").textContent = `${Math.floor(player.pos.x)}, ${Math.floor(player.pos.y)}, ${Math.floor(player.pos.z)}${isNight(Date.now() + serverOffset) ? " · night" : ""}`;
  } else {
    // The title screen: a slow turn over the town.
    const t = now / 1000;
    camera.position.set(TOWN.x + Math.cos(t * 0.05) * 34, TOWN.y + 16, TOWN.z + Math.sin(t * 0.05) * 34);
    camera.lookAt(TOWN.x, TOWN.y + 2, TOWN.z);
  }

  // Sky, light and fog.
  const top = world.topAt(Math.floor(camera.position.x), Math.floor(camera.position.z));
  const under = top >= 0 ? Math.max(0, Math.min(1, (top - camera.position.y - 2) / 10)) : 0;
  const s = sky.update(dev.time !== null ? dev.time * DAY_MS : Date.now() + serverOffset, camera, under);
  world.uniforms.daylight.value = s.daylight;
  world.uniforms.fogColor.value.copy(s.color);
  const far = world.radius * CHUNK;
  world.uniforms.fogNear.value = far * 0.55;
  world.uniforms.fogFar.value = far * 0.95;
  ambient.intensity = 0.25 + s.daylight * 0.55;
  sunLight.intensity = s.daylight * 0.6;
  renderer.render(scene, camera);
}
drawHotbar();
frame();
if (local) window.mwc = { player, world, inv, mobs, camera, get net() { return net; }, get chain() { return chain; }, ledger, dev, select, setMining, signIn };
