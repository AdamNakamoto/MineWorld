// MineWorldCraft: the game loop. Walking, mining, placing, fighting, the HUD, and wiring the world, the room
// (net.js), the chain (chain.js) and the Mining Site panel together.

import * as THREE from "https://esm.sh/three@0.160.0";
import { BLOCKS, AIR, WATER, TOOLS, HAND_DAMAGE, breakTime, itemName } from "./blocks.js";
import { wrapDelta, SPAWN, REACH, ATTACK_MS, DAY_MS, TOWN, protectedAt, isNight, MOB_KINDS, MOBS_PER_PLAYER, UNDERGROUND_Y, PROTECT_R, CHUNK, wrap, wrapDist } from "./rules.js";
import { OFFICE } from "./worldgen.js";
import { makeAtlas, iconFor, faceTiles, tileOf, ATLAS_TILES } from "./textures.js";
import { createWorld, keyOf, MAX_RADIUS } from "./world.js";
import { follow as followPlanet, place as placeOnPlanet } from "./planet.js";
import { createGlobe } from "./globe.js";
import { moveBox, boxHitsBlock } from "./physics.js";
import { createInventory, SLOTS, HOTBAR } from "./inventory.js";
import { createMobs } from "./mobs.js";
import { createVillagers } from "./villagers.js";
import { createSky } from "./sky.js";
import { createNet, short } from "./net.js";
import { createAvatar } from "./avatar.js";
import * as BLK from "./blocks.js";
import { ICONS, drawRow, createHunger, EXHAUSTION, SPRINT_MIN_FOOD, HEAL_FOOD, EAT_SECONDS, FOOD_MAX } from "./vitals.js";
import { runCommand } from "./commands.js";
import { createVoice } from "./voice.js";
import { cleanName } from "./name-rules.js";
import { packTraits, unpackTraits } from "./crafters.js";
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
world.onDrop = (k) => synced.delete(k);

let settings = { view: touch ? 5 : 10, mouse: 1 };
try { settings = { ...settings, ...JSON.parse(localStorage.getItem("mwc:settings")) }; } catch {}
settings.view = Math.max(3, Math.min(MAX_RADIUS, Number(settings.view) || 10));
world.setRadius(settings.view);

// ---------------------------------------------------------------- the player
const player = {
  pos: new THREE.Vector3(SPAWN.x, SPAWN.y, SPAWN.z), vel: new THREE.Vector3(), yaw: 0, pitch: 0,
  onGround: false, water: false, health: 20, hurtAt: 0, alive: true, fallFrom: null, sel: 0,
};
const HALF = 0.3, TALL = 1.8, EYE = 1.62;

// Your own miner, seen from outside: V (or the 👁 button) switches between first person, behind you, and facing
// you. Mining, placing and fighting always aim from your eyes, whichever view is on.
const VIEWS = ["First person", "Behind you", "Facing you"];
let view = 0, myLook = null, me = null;
try { myLook = unpackTraits(JSON.parse(localStorage.getItem("mwc:wornTraits"))); } catch {}
const meHolder = new THREE.Group(); // stands your miner on the curved planet (planet.place); me.root turns within it
scene.add(meHolder);
/// Dress your own miner as a Crafter (its traits), or as the Rookie (null).
function dressMe(traits) {
  if (me) { meHolder.remove(me.root); me.dispose(); }
  myLook = traits ?? null;
  me = createAvatar(myLook);
  me.root.visible = view > 0;
  meHolder.add(me.root);
}
dressMe(myLook);
function nextView() {
  view = (view + 1) % VIEWS.length;
  me.root.visible = view > 0;
  heldGroup.visible = view === 0;
  $("cross").hidden = view === 2; // (facing yourself there's nothing to aim at)
  showTarget(VIEWS[view], 1000);
}

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
  drawRow($("hearts"), player.health, [ICONS.heart, ICONS.heartHalf, ICONS.heartEmpty]);
}
function drawFood() {
  drawRow($("food"), hunger.food, [ICONS.food, ICONS.foodHalf, ICONS.foodEmpty]);
  $("food").classList.toggle("low", hunger.food <= 6);
}
const hunger = createHunger(() => drawFood());
const FOODS = BLK.FOODS ?? {};

/// Let go of the mouse on purpose (opening a panel), as opposed to the player pressing Esc (which opens the menu).
let letGo = false;
function releaseMouse() {
  if (document.pointerLockElement === canvas) { letGo = true; document.exitPointerLock?.(); }
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
function openInventory() { picked = null; $("inv").hidden = false; releaseMouse(); drawInventory(); }
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
  if (s.id < 64 && !BLOCKS[s.id]?.plant && s.id !== BLK.TORCH) {
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

// The block outline, the cracks and the debris have flat positions (userData.at, userData.p) and are drawn bent round
// the planet each frame (drawOnPlanet).
const outline = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1.004, 1.004, 1.004)), new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.6 }));
outline.visible = false;
outline.userData.at = new THREE.Vector3();
scene.add(outline);
const crackGeo = new THREE.BoxGeometry(1.01, 1.01, 1.01);
const crackBase = crackGeo.attributes.uv.array.slice();
const crack = new THREE.Mesh(crackGeo, new THREE.MeshBasicMaterial({ map: atlasTex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1 }));
crack.visible = false;
crack.userData.at = new THREE.Vector3();
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
    m.userData.p = new THREE.Vector3(x + 0.2 + Math.random() * 0.6, y + 0.2 + Math.random() * 0.6, z + 0.2 + Math.random() * 0.6);
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
    m.userData.p.addScaledVector(m.userData.v, dt);
    if (m.userData.life <= 0) { scene.remove(m); m.material.dispose(); debris.splice(i, 1); }
  }
}

// The Mining Office's sign.
let officeSign = null;
{
  const c = document.createElement("canvas");
  c.width = 512; c.height = 96;
  const g = c.getContext("2d");
  g.fillStyle = "#3a2a18"; g.fillRect(0, 0, 512, 96);
  g.strokeStyle = "#f5c832"; g.lineWidth = 8; g.strokeRect(4, 4, 504, 88);
  g.fillStyle = "#f5c832"; g.font = "700 46px Silkscreen, monospace"; g.textAlign = "center"; g.textBaseline = "middle";
  g.fillText("MINING OFFICE", 256, 50);
  const t = new THREE.CanvasTexture(c);
  officeSign = new THREE.Mesh(new THREE.PlaneGeometry(6, 1.1), new THREE.MeshBasicMaterial({ map: t }));
  officeSign.userData.at = new THREE.Vector3(TOWN.x + 0.5, TOWN.y + 4.45, TOWN.z + OFFICE.z1 + 1.02);
  scene.add(officeSign);
  document.fonts?.ready.then(() => { g.fillStyle = "#3a2a18"; g.fillRect(8, 8, 496, 80); g.fillStyle = "#f5c832"; g.fillText("MINING OFFICE", 256, 50); t.needsUpdate = true; });
}

// ---------------------------------------------------------------- monsters
// A monster beaten here that the room hasn't confirmed (a hit it didn't count) is given up after a moment, so the
// room frees its place for the next one.
const confirmed = new Set();
const villagers = createVillagers(scene);
const mobs = createMobs(scene, world, {
  gone(id) { if (id > 0) net?.gone(id); },
  killed(id) {
    if (id > 0) setTimeout(() => { if (!confirmed.delete(id)) net?.gone(id); }, 2500);
  },
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
  if (wrapDist(player.pos.x, player.pos.z, TOWN.x, TOWN.z) < PROTECT_R + 16) return;
  offlineMobAt = now + 20_000;
  const a = Math.random() * Math.PI * 2;
  mobs.spawn(-(++offlineMobSeq), MOB_KINDS[Math.floor(Math.random() * 3)], wrap(player.pos.x + Math.cos(a) * 12), player.pos.y, wrap(player.pos.z + Math.sin(a) * 12));
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
    releaseMouse();
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
  hunger.reset();
  drawHearts();
});

// ---------------------------------------------------------------- the room
let net = null, serverOffset = 0;
const synced = new Set();
const ledger = { signedIn: false, wallet: null, name: null, today: 0, total: 0, cap: toCents(DAILY_EARN_CAP) };
function drawLedger() {
  $("earnToday").textContent = fmtMine(ledger.today);
  $("earnWho").textContent = ledger.signedIn ? `${ledger.name ?? short(ledger.wallet)} · ${fmtMine(ledger.total)} earned in all` : "Guest: sign in to earn (M)";
  panel?.render();
}
let voice = null;
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
      $("onlineN").textContent = `● ${count} online`;
      if (ledger.wallet) tryResume(ledger.wallet);
      voice?.reconnected();
    },
    joined(id, name) { sysLine(`${name} joined the game`); },
    left(id, name) { sysLine(`${name} left the game`); voice?.left(id); },
    voices(ids) { voice?.setVoices(ids); },
    voice(id, on) { voice?.setVoice(id, on); },
    rtc(from, data) { voice?.signal(from, data); },
    named(name) { ledger.name = name; drawLedger(); drawNameBox(); toast(`You're ${name} now.`, "good"); },
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
    mobdead(id) { confirmed.add(id); mobs.kill(id); sfx.win(); },
    chat(l) { if (!voice?.isMuted(l.name)) chatLine(l.name, l.text, l.mine); },
    count(n) { $("onlineN").textContent = `● ${n} online`; },
    error(text) { toast(text, "bad"); },
    signedin(wallet, token, l) {
      Object.assign(ledger, { signedIn: true, wallet, name: l.name, today: l.today, total: l.total, cap: l.cap });
      drawNameBox();
      try { localStorage.setItem(`mwc:tok:${wallet.toLowerCase()}`, token); } catch {}
      drawLedger();
      if (panel?.worn !== null && panel?.worn !== undefined) net.wear(panel.worn);
    },
    signedout(reason) {
      ledger.signedIn = false;
      ledger.name = null;
      try { localStorage.removeItem(`mwc:tok:${ledger.wallet?.toLowerCase()}`); } catch {}
      drawLedger();
      toast(reason);
    },
  });
}
if (net) {
  voice = createVoice(net, {
    status(text) { $("voiceNote").textContent = text; },
    changed(on) {
      $("voiceBtn").classList.toggle("on", on);
      $("voiceBtn").innerHTML = `<kbd>B</kbd> ${on ? "Voice on" : "Voice chat"}`;
      $("voiceToggle").textContent = on ? "Turn off voice chat" : "Turn on voice chat";
      if (on) toast("Voice chat on: players near you can hear you.", "good");
    },
  });
}
$("voiceBtn").addEventListener("click", () => (voice ? voice.toggle() : toast("Voice chat needs the world server (offline right now).")));
$("voiceToggle").addEventListener("click", () => (voice ? voice.toggle() : toast("Voice chat needs the world server (offline right now).")));

/// The name box in the menu: pick one once signed in.
function drawNameBox() {
  const signed = ledger.signedIn;
  $("nameNote").textContent = signed
    ? ledger.name ? `You're ${ledger.name}. You can change it once a day.` : "Pick a name to show instead of your wallet address."
    : "Sign in to earn (in the Mining Site panel) to pick a name: it shows instead of your wallet address.";
  for (const el of $("nameForm").elements) el.disabled = !signed;
  if (signed && ledger.name && !$("nameInput").value) $("nameInput").value = ledger.name;
}
$("nameForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const r = cleanName($("nameInput").value);
  if (r.error) return toast(r.error, "bad");
  net?.setName(r.name);
});
$("nameInput").addEventListener("keydown", (e) => e.stopPropagation());

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
    wear(traits, tokenId) {
      net?.wear(tokenId);
      if (traits && !ledger.signedIn) toast("You see it now; others will once you sign in to earn (they check it's yours).");
      dressMe(traits);
      try { localStorage.setItem("mwc:wornTraits", JSON.stringify(traits ? packTraits(traits) : null)); } catch {}
    },
  });
  if (!chain) return;
  chain.onAccount = (a) => {
    // The room stops counting for the old wallet before this one resumes (or stays a guest).
    if (ledger.signedIn) net?.signOut();
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
  if (!mine) {
    b.title = "Mute or unmute (voice and chat)";
    b.addEventListener("click", () => toast(voice?.mute(name) ? `${name} muted.` : `${name} unmuted.`));
  }
  row.append(b, document.createTextNode(text));
  $("chatLog").append(row);
  while ($("chatLog").children.length > 30) $("chatLog").firstChild.remove();
}
/// A line from the game itself (who joined, command replies), in yellow.
function sysLine(text) {
  const row = document.createElement("div");
  row.className = "line sys";
  row.textContent = text;
  $("chatLog").append(row);
  while ($("chatLog").children.length > 30) $("chatLog").firstChild.remove();
}
function openChat() {
  releaseMouse();
  $("chat").classList.add("open");
  $("chatForm").hidden = false;
  $("chatInput").focus();
}
function closeChat() {
  $("chat").classList.remove("open");
  $("chatForm").hidden = true;
  $("chatInput").blur();
}
/// Move the player somewhere (a command): the world loads around them before they fall.
function teleport(x, y, z) {
  player.pos.set(wrap(x), y, wrap(z));
  player.vel.set(0, 0, 0);
  player.fallFrom = null;
  mobs.clear();
}
const commandGame = {
  teleport,
  here: () => ({ x: player.pos.x, y: player.pos.y, z: player.pos.z }),
  homeKey: () => `mwc:home:${(ledger.wallet ?? "guest").toLowerCase()}`,
  say: (text, kind) => { sysLine(text); if (kind === "bad") sfx.hurt?.(); },
};
$("chatForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const raw = $("chatInput").value.trim();
  if (raw.startsWith("/")) {
    runCommand(raw, commandGame);
    $("chatInput").value = "";
    closeChat();
    if (!touch) lockMouse();
    return;
  }
  if (!net) return toast("Chat needs the world server (offline right now).");
  const r = cleanChat(raw);
  if (r.error) return toast(r.error, "bad");
  net.chat(r.text);
  $("chatInput").value = "";
  closeChat();
  if (!touch) lockMouse();
});
$("chatInput").addEventListener("keydown", (e) => { if (e.key === "Escape") closeChat(); e.stopPropagation(); });

// ---------------------------------------------------------------- input
/// Grab the mouse for looking around (browsers can refuse, e.g. right after Esc; the next click tries again).
function lockMouse() {
  try { canvas.requestPointerLock?.()?.catch?.(() => {}); } catch {}
}
const keys = new Set();
let mining = false, placing = false, placeAt = 0, attackAt = 0, playing = false;
const anyOverlay = () => !$("inv").hidden || (panel?.isOpen ?? false) || !$("dead").hidden || !$("wallets").hidden || !$("chatForm").hidden
  || !$("menu").hidden || !$("notice").hidden;
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
  else if (e.code === "KeyV") nextView();
  else if (e.code === "Enter" || e.code === "KeyT") { e.preventDefault(); openChat(); }
  else if (e.code === "Escape") { closeInventory(); panel?.close(); $("menu").hidden = true; $("notice").hidden = true; }
  else if (e.code === "KeyB") voice?.toggle();
  else if (/^Digit[1-9]$/.test(e.code)) select(Number(e.code.slice(5)) - 1);
  if (e.code === "Space") e.preventDefault();
});
addEventListener("keyup", (e) => keys.delete(e.code));
addEventListener("blur", () => { keys.clear(); setMining(false); placing = false; });

canvas.addEventListener("click", () => {
  if (playing && !touch && !anyOverlay() && document.pointerLockElement !== canvas) lockMouse();
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
// Esc lets go of the mouse: that opens the menu, as a pause screen (unless a panel was opened on purpose).
document.addEventListener("pointerlockchange", () => {
  if (document.pointerLockElement === canvas) return;
  setMining(false);
  placing = false;
  if (!letGo && playing && !anyOverlay()) openMenu();
  letGo = false;
});

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
$("viewBtn").addEventListener("click", nextView);
$("titleSite").addEventListener("click", () => panel?.open());
$("invBtn").addEventListener("click", () => ($("inv").hidden ? openInventory() : closeInventory()));
$("chatBtn").addEventListener("click", openChat);
$("menuBtn").addEventListener("click", openMenu);
function openMenu() {
  releaseMouse();
  $("menu").hidden = false;
  drawNameBox();
}
function closeMenu() {
  $("menu").hidden = true;
  if (!touch && playing) lockMouse();
}
$("menu").addEventListener("click", (e) => { if (e.target === $("menu") || e.target.closest("[data-close]")) closeMenu(); });
$("soundToggle").checked = !sfx.muted;
$("soundToggle").addEventListener("change", (e) => { if (e.target.checked === sfx.muted) sfx.toggle(); });
// The spawn is protected: the first try to mine or build there explains, and offers /wild.
let noticeAt = 0;
function spawnNotice() {
  const now = Date.now();
  if (now - noticeAt < 60_000) return showTarget("Spawn is protected: go exploring (/wild)", 1500);
  noticeAt = now;
  setMining(false);
  placing = false;
  releaseMouse();
  $("notice").hidden = false;
}
$("noticeGo").addEventListener("click", () => { $("notice").hidden = true; runCommand("/wild", commandGame); if (!touch) lockMouse(); });
$("noticeStay").addEventListener("click", () => { $("notice").hidden = true; if (!touch) lockMouse(); });
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
  if (!touch) lockMouse();
  net?.start({});
  if (!net) toast("Playing offline: the world server isn't set up yet, so nothing is earned.");
  drawHotbar();
  drawHearts();
  drawFood();
  drawLedger();
  setTimeout(() => ($("help").hidden = true), 25_000); // (the controls are in the menu too)
});
if (url) fetch(url.replace(/^ws/, "http").replace(/\/ws$/, "/count")).then((r) => r.json()).then((j) => {
  if (j?.online >= 0) { $("onlineTitle").hidden = false; $("onlineTitle").textContent = `● ${j.online} mining right now`; }
}).catch(() => {});

// ---------------------------------------------------------------- mining, placing, fighting
let breaking = null; // { x, y, z, b, t, need }
const ray = new THREE.Vector3();
function interact(dt, now) {
  const eye = eyePos;
  lookDir(ray);
  const hit = world.raycast(eye, ray, REACH);
  const mobHit = mobs.raycast(eye, ray, 3.6);
  const mobFirst = mobHit && (!hit || mobHit.t < hit.t);
  // A villager in front of everything else: a click talks to them.
  const folk = villagers.raycast(eye, ray, 4.5);
  if (folk && (!hit || folk.t < hit.t) && (!mobHit || folk.t < mobHit.t)) {
    outline.visible = false;
    crack.visible = false;
    breaking = null;
    showTarget(`${folk.v.name} · ${folk.v.job} · click to talk`, 300);
    if (mining && !talkLatch) { talkLatch = true; sayHello(folk.v); }
    return;
  }
  // Online, a chunk can be changed only once the room has sent its edits (so nothing is undone when they arrive).
  const allowed = hit && (!net || (net.online && synced.has(keyOf(Math.floor(hit.x / CHUNK), Math.floor(hit.z / CHUNK)))));
  if (hit && !allowed && (mining || placing)) showTarget(net?.online ? "Loading…" : "Reconnecting to the world…", 600);
  if (hit && !mobFirst) {
    outline.visible = true;
    outline.userData.at.set(hit.x + 0.5, hit.y + 0.5, hit.z + 0.5);
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
        hunger.tire(EXHAUSTION.attack);
        if (mobHit.mob.id > 0) net?.hit(mobHit.mob.id, dmg);
        sfx.hit();
      }
    } else if (hit && allowed) {
      if (protectedAt(hit.x, hit.z)) { spawnNotice(); breaking = null; }
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
    crack.userData.at.set(breaking.x + 0.5, breaking.y + 0.5, breaking.z + 0.5);
    setCrack(Math.min(4, Math.floor((breaking.t / breaking.need) * 5)));
  } else crack.visible = false;

  if (placing && player.alive && now > placeAt && hit && allowed && !mobFirst && !FOODS[hand]) {
    placeAt = now + 250;
    const s = inv.slot(player.sel);
    const px = wrap(hit.x + hit.nx), py = hit.y + hit.ny, pz = wrap(hit.z + hit.nz); // (round the seam)
    if (s && s.id < 64 && BLOCKS[s.id]?.placeable) {
      const there = world.get(px, py, pz);
      if (protectedAt(px, pz)) spawnNotice();
      else if ((there === AIR || there === WATER || BLOCKS[there]?.plant) && !boxHitsBlock(player.pos, HALF, TALL, px, py, pz) && py > 0 && py < 128) {
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
  // A plant standing on the broken block goes with it.
  const above = world.get(b.x, b.y + 1, b.z);
  if (BLOCKS[above]?.plant && !protectedAt(b.x, b.z)) {
    world.set(b.x, b.y + 1, b.z, AIR);
    net?.breakBlock(b.x, b.y + 1, b.z);
  }
  burst(b.x, b.y, b.z, b.b);
  sfx.broke(BLOCKS[b.b].tier > 0);
  net?.breakBlock(b.x, b.y, b.z);
  hunger.tire(EXHAUSTION.break);
  // What a block gives (blocks.js dropsFor: ore items, apples from leaves, berries from bushes...).
  const drops = BLK.dropsFor ? BLK.dropsFor(b.b, Math.random, b.drops) : (b.drops && BLOCKS[b.b].drop !== null ? [[BLOCKS[b.b].drop, 1]] : []);
  for (const [id, n] of drops) if (inv.add(id, n)) showTarget("Inventory full", 1200);
  breaking = null;
}

// ---------------------------------------------------------------- talking to villagers
let talkLatch = false, talking = null;
addEventListener("mouseup", (e) => { if (e.button === 0) talkLatch = false; });
addEventListener("touchend", () => (talkLatch = false));
function sayHello(v) {
  $("talkWho").textContent = `${v.name} the ${v.job.toLowerCase()}`;
  $("talkLine").textContent = villagers.talk(v);
  $("talk").hidden = false;
  talking = { v, until: performance.now() + 9000 };
  sfx.place();
}
function endTalk() {
  $("talk").hidden = true;
  talking = null;
}

// ---------------------------------------------------------------- the camera
const eyePos = new THREE.Vector3();
const back = new THREE.Vector3();
/// The direction you're looking, from yaw and pitch.
function lookDir(out) {
  const c = Math.cos(player.pitch);
  return out.set(-Math.sin(player.yaw) * c, Math.sin(player.pitch), -Math.cos(player.yaw) * c);
}
/// First person at your eyes; or pulled back (behind you, or out in front looking back), stopping short of walls.
function placeCamera() {
  if (view === 0) {
    camera.position.copy(eyePos);
    camera.rotation.set(player.pitch, player.yaw, 0);
    return;
  }
  lookDir(back);
  if (view === 1) back.negate();
  const hit = world.raycast(eyePos, back, 4.5);
  const d = hit ? Math.max(0.4, hit.t - 0.3) : 4.5;
  camera.position.copy(eyePos).addScaledVector(back, d);
  if (view === 1) {
    // A little above your head, so it doesn't sit on the crosshair (unless a ceiling is in the way).
    if (!world.solid(Math.floor(camera.position.x), Math.floor(camera.position.y + 0.5), Math.floor(camera.position.z))) camera.position.y += 0.4;
    camera.rotation.set(player.pitch, player.yaw, 0);
  }
  else camera.lookAt(eyePos);
}

// ---------------------------------------------------------------- eating
// Hold right click (or the place button) with food in hand: a moment later it's eaten.
let eatT = 0;
function eat(dt) {
  const s = inv.slot(player.sel);
  const food = s && FOODS[s.id];
  if (!placing || !food || !player.alive || hunger.food >= FOOD_MAX) {
    eatT = 0;
    $("eating").hidden = true;
    return;
  }
  eatT += dt;
  swingT += dt * 6;
  $("eating").hidden = false;
  $("eating").firstElementChild.style.width = `${Math.min(100, (eatT / EAT_SECONDS) * 100)}%`;
  if (eatT >= EAT_SECONDS) {
    eatT = 0;
    hunger.food += food;
    inv.useSlot(player.sel);
    sfx.place();
    showTarget(`Ate ${itemName(s.id)}`, 900);
  }
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
    const sprint = hunger.food >= SPRINT_MIN_FOOD && (keys.has("ShiftLeft") || keys.has("ShiftRight") || (touch && Math.hypot(stickState.dx, stickState.dy) > 0.95));
    const speed = (player.water ? 2.6 : sprint ? 5.8 : 4.3) * (player.alive ? 1 : 0);
    const tx = (forward.x * fz + right.x * fx) * speed, tz = (forward.z * fz + right.z * fx) * speed;
    const k = 1 - Math.exp(-dt * (player.onGround ? 14 : player.water ? 5 : 3));
    player.vel.x += (tx - player.vel.x) * k;
    player.vel.z += (tz - player.vel.z) * k;
    const jump = !typing && (keys.has("Space") || touchJump);
    if (jump && player.onGround && !player.water) { player.vel.y = 8.6; hunger.tire(sprint ? EXHAUSTION.sprintJump : EXHAUSTION.jump); }
    if (jump && player.water) player.vel.y = Math.min(player.vel.y + 30 * dt, 3.5);
    if (ready) {
      const before = { x: player.pos.x, z: player.pos.z };
      const r = moveBox(world, player.pos, player.vel, HALF, TALL, dt);
      const walked = Math.hypot(player.pos.x - before.x, player.pos.z - before.z);
      // Round the planet: past 511 is 0 again (everything drawn follows, see drawOnPlanet).
      player.pos.x = wrap(player.pos.x);
      player.pos.z = wrap(player.pos.z);
      if (walked < 1) hunger.tire(walked * (sprint ? EXHAUSTION.sprint : EXHAUSTION.walk));
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
    // A full belly heals; an empty one hurts (down to half a heart).
    if (player.alive && now > regenAt) {
      if (hunger.food >= HEAL_FOOD && player.health < 20) {
        regenAt = now + 4000;
        player.health += 1;
        hunger.tire(EXHAUSTION.heal);
        drawHearts();
      } else if (hunger.food === 0 && player.health > 1) {
        regenAt = now + 4000;
        hurt(1);
      }
    }
    eat(dt);

    eyePos.set(player.pos.x, player.pos.y + EYE, player.pos.z);
    placeCamera();
    me.root.rotation.y = player.yaw + Math.PI;
    me.head.rotation.x = -player.pitch * 0.8;
    me.animate(dt, player.alive ? Math.hypot(player.vel.x, player.vel.z) : 0, mining && player.alive);
    if (!typing) interact(dt, now);
    else { outline.visible = false; crack.visible = false; breaking = null; }
    heldGroup.position.set(0.48, -0.42 - Math.abs(Math.sin(swingT)) * 0.1, -0.78 + Math.sin(swingT) * 0.08);
    heldGroup.rotation.x = -Math.abs(Math.sin(swingT)) * 0.6;

    mobs.update(dt, player);
    if (talking && (now > talking.until || Math.hypot(wrapDelta(talking.v.pos.x - player.pos.x), wrapDelta(talking.v.pos.z - player.pos.z)) > 7)) endTalk();
    offlineMobs(now);
    net?.tick(dt, { x: player.pos.x, y: player.pos.y, z: player.pos.z, yaw: player.yaw, pitch: player.pitch });
    voice?.tick(player.pos);
    updateDebris(dt);
    $("where").textContent = `${Math.floor(player.pos.x)}, ${Math.floor(player.pos.y)}, ${Math.floor(player.pos.z)}${isNight(Date.now() + serverOffset) ? " · night" : ""}`;
  } else {
    // The title screen: the whole planet, turning slowly in space (the world loads round the spawn meanwhile).
    globe.render(renderer, dt);
    return;
  }

  // Sky, light and fog.
  const top = world.topAt(Math.floor(camera.position.x), Math.floor(camera.position.z));
  const under = top >= 0 ? Math.max(0, Math.min(1, (top - camera.position.y - 2) / 10)) : 0;
  const s = sky.update(dev.time !== null ? dev.time * DAY_MS : Date.now() + serverOffset, camera, under);
  villagers.update(dt, Date.now() + serverOffset, dev.time !== null ? dev.time * DAY_MS : Date.now() + serverOffset);
  world.uniforms.daylight.value = s.daylight;
  world.uniforms.fogColor.value.copy(s.color);
  const far = world.radius * CHUNK;
  world.uniforms.fogNear.value = far * 0.55;
  world.uniforms.fogFar.value = far * 0.95;
  // Mostly even light, so faces stay readable whichever way they turn from the sun. (three.js lights are in physical
  // units: an intensity of pi lights a surface at its own colour.)
  ambient.intensity = (0.42 + s.daylight * 0.5) * Math.PI;
  sunLight.intensity = s.daylight * 0.35 * Math.PI;
  drawOnPlanet(dt);
  renderer.render(scene, camera);
}

/// Bends everything drawn in the world round the planet as seen from the camera, just before the render: the chunks
/// (in the shader, at their copies nearest the camera), monsters, other miners, your own miner, the block outline,
/// the cracks, debris and the Mining Office's sign.
const _flat = new THREE.Vector3();
function drawOnPlanet(dt) {
  followPlanet(camera.position, dt);
  world.draw(camera);
  mobs.draw();
  villagers.draw();
  net?.draw();
  if (me.root.visible) placeOnPlanet(meHolder, player.pos, 0);
  // The outline and cracks are boxes round a block's centre: stand them at the bent centre, turned with the ground.
  for (const o of [outline, crack]) if (o.visible) placeOnPlanet(o, o.userData.at, 0);
  for (const m of debris) placeOnPlanet(m, m.userData.p, 0);
  if (officeSign) placeOnPlanet(officeSign, officeSign.userData.at, 0);
}
const globe = createGlobe();
world.map(512, 256).then(({ data, w, h }) => data && globe.setMap(data, w, h));
drawHotbar();
frame();
if (local) window.mwc = { player, world, inv, mobs, villagers, camera, globe, renderer, scene, get net() { return net; }, get chain() { return chain; }, ledger, dev, select, setMining, signIn, dressMe, nextView };
