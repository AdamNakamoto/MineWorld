// MineWorldCraft: the game loop. Walking, mining, placing, fighting, the HUD, and wiring the world, the room
// (net.js), the chain (chain.js) and the Mining Site panel together. The rocket (rocket.js) flies between the home
// planet and the zones (zones.js): Deepvein (2x $MINE), Cinderfall (the boss, boss.js) and Red Mesa (PvP). Knocked
// out anywhere, you drop everything in a loot chest (chests.js); at home you can revive where you fell.

import * as THREE from "https://esm.sh/three@0.160.0";
import { BLOCKS, AIR, WATER, TOOLS, HAND_DAMAGE, breakTime, itemName } from "./blocks.js";
import { wrapDelta, SPAWN, REACH, ATTACK_MS, DAY_MS, TOWN, isNight, MOB_KINDS, UNDERGROUND_Y, CHUNK, wrap } from "./rules.js";
import {
  ZONES, zoneOf, landing, spawnOf, protectedIn, calmAt, pvpAt, BOSS, PVP, ROCKET_REACH, PAD_R, CHEST_MS, CHEST_REACH,
  REVIVE_PRICE, REVIVE_KIND,
} from "./zones.js";
import { createRocket, openCard, cardOpen, closeCard, drawCard, setTicketsFree, ticketsAreFree } from "./rocket.js";
import { createBoss } from "./boss.js";
import { createChests, lootLabel } from "./chests.js";
import { OFFICE } from "./worldgen.js";
import { makeAtlas, iconFor, faceTiles, tileOf, ATLAS_TILES } from "./textures.js";
import { createWorld, keyOf, MAX_RADIUS } from "./world.js";
import { follow as followPlanet, place as placeOnPlanet, bend as bendPoint } from "./planet.js";
import { createGlobe } from "./globe.js";
import { boxHitsBlock, stepPlayer, TICK, MOVE } from "./physics.js";
import { createInventory, SLOTS, HOTBAR } from "./inventory.js";
import { createMobs } from "./mobs.js";
import { createVillagers } from "./villagers.js";
import { createShop } from "./shop.js";
import { createSky } from "./sky.js";
import { createNet, short, SNEAKING } from "./net.js";
import { createAvatar } from "./avatar.js";
import { heldModel, setHeldAtlas, tileUVs, bareArm, tickGlint } from "./held.js";
import * as BLK from "./blocks.js";
import { ICONS, drawRow, createHunger, EXHAUSTION, SPRINT_MIN_FOOD, HEAL_FOOD, EAT_SECONDS, FOOD_MAX } from "./vitals.js";
import { runCommand } from "./commands.js";
import { createVoice } from "./voice.js";
import { cleanName } from "./name-rules.js";
import { packTraits, unpackTraits } from "./degen-skin.js";
import { connectChain, explain } from "./chain.js";
import { createPanel } from "./panel.js";
import { cleanChat } from "./chat-rules.js";
import { fmtMine, toUnits, WORLD_DAILY_CAP } from "./rewards.js";
import { NO_BOOST, dailyCap, withSpeed, withMove, describe } from "./boosts.js";
import { sfx } from "./sfx.js";
import { roomUrl } from "./config.js";

THREE.ColorManagement.enabled = false; // colours are used as written (the block shader works the same way)
const $ = (id) => document.getElementById(id);
const touch = matchMedia("(pointer: coarse)").matches;
// On localhost only: ?t=0.25 fixes the sky's time of day (0 sunrise, 0.25 noon, 0.75 midnight), and window.mwc
// exposes the game for testing (mwc.dev.swing, 0..1, holds the first-person hand at that point of a swing).
const local = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
const dev = { time: local && new URLSearchParams(location.search).has("t") ? Number(new URLSearchParams(location.search).get("t")) : null, swing: null };

// ---------------------------------------------------------------- scene
const canvas = $("c");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: "high-performance" });
renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
renderer.setPixelRatio(Math.min(devicePixelRatio, touch ? 1.5 : 2));
const scene = new THREE.Scene();
// How moving and looking feel, after Minecraft Java (the movement itself is physics.js MOVE, the miner's animation
// avatar.js ANIM).
const FEEL = {
  fov: 70, sprintFov: 1.15, fovEase: 0.5, // the view's height in degrees; x this sprinting, eased in this much a tick
  look: 0.15 * Math.PI / 180, // radians turned per mouse count at mouse speed 1 (Minecraft's default sensitivity)
  sneakEye: 1.27, eyeEase: 0.5, // eye height while sneaking (standing: EYE), eased this much of the way a tick
  doubleTap: 7, // ticks: W pressed again within this sprints
  sprintStart: 0.8, // the forward push it takes to start sprinting (sneaking's 0.3 isn't enough)
  wallAngle: 8 * Math.PI / 180, // running into a wall more head-on than this from your push stops a sprint
  bobStep: 0.6, bobMax: 0.1, bobEase: 0.4, // view bobbing: its phase per block walked, its most, eased this much a tick
  fall: 3, // blocks: a longer fall hurts a point (half a heart) for every block past it, part blocks rounded up
  maxCatchUp: 5, // ticks run in one frame at most (after a stall the game slows rather than leaping)
};
const camera = new THREE.PerspectiveCamera(FEEL.fov, 1, 0.05, 500);
camera.rotation.order = "YXZ";
scene.add(camera);
const ambient = new THREE.AmbientLight(0xffffff, 0.6);
const sunLight = new THREE.DirectionalLight(0xffffff, 0.7);
sunLight.position.set(0.4, 1, 0.3);
scene.add(ambient, sunLight);
// What's in your hand in first person is drawn as Minecraft draws it: in its own pass after the world, with the depth
// cleared first (so it never sinks into a wall), through its own camera at the eye looking along -z with a fixed
// field of view (sprinting's widening doesn't stretch it), lit as the world is where you stand (renderHand). The hand
// itself hangs in handScene: see "held item" below.
const HAND_FOV = 70;
const handScene = new THREE.Scene();
const handCamera = new THREE.PerspectiveCamera(HAND_FOV, 1, 0.05, 10);
// Its light: the world's where you stand (renderHand), as an even part and a part from the upper left, in front, that
// turns with the view, so the item's face (which looks to the left) is lit and its edges fall into shade the way a
// solid thing's do, the top ones less than the ones facing you and down. (Minecraft's light tops out at 1, held.js.)
const HAND_LIGHT = { even: 0.45, key: 0.65, from: [-0.75, 0.55, 0.35] };
const handAmbient = new THREE.AmbientLight();
const handKey = new THREE.DirectionalLight();
handKey.position.fromArray(HAND_LIGHT.from);
handScene.add(handAmbient, handKey);
// Minecraft's hand is placed for a 16:9 screen, 70 degrees of view high. On a squarer window the same view would push
// it off the right edge, so there the hand camera shows 16:9's view cut down from the left: the item sits just as it
// does on 16:9, at the same size for the window's height, the same way from the bottom right corner. Narrower than
// HAND_MIN_ASPECT (a phone held upright) it's that one's view, widened to fit.
const HAND_ASPECT = 16 / 9, HAND_MIN_ASPECT = 4 / 3;
function resize() {
  renderer.setSize(innerWidth, innerHeight, false);
  const aspect = innerWidth / innerHeight;
  camera.aspect = handCamera.aspect = aspect;
  camera.updateProjectionMatrix();
  const t = Math.tan((HAND_FOV / 2) * (Math.PI / 180)), n = handCamera.near;
  const high = t * Math.max(1, HAND_MIN_ASPECT / aspect), right = t * Math.max(aspect, HAND_ASPECT);
  handCamera.projectionMatrix.makePerspective((right - 2 * high * aspect) * n, right * n, high * n, -high * n, n, handCamera.far);
  handCamera.projectionMatrixInverse.copy(handCamera.projectionMatrix).invert();
}
addEventListener("resize", resize);
resize();

const atlas = makeAtlas();
const world = createWorld(scene, atlas);
let zone = "home"; // the planet you're on (zones.js)
const sky = createSky(scene);
const inv = createInventory();
world.onDrop = (k) => synced.delete(k);

let settings = { view: touch ? 5 : 10, mouse: 1, bob: true };
try { settings = { ...settings, ...JSON.parse(localStorage.getItem("mwc:settings")) }; } catch {}
settings.view = Math.max(3, Math.min(MAX_RADIUS, Number(settings.view) || 10));
world.setRadius(settings.view);

// ---------------------------------------------------------------- the player
const player = {
  pos: new THREE.Vector3(SPAWN.x, SPAWN.y, SPAWN.z), vel: new THREE.Vector3(), yaw: 0, pitch: 0,
  onGround: false, water: false, health: 20, hurtAt: 0, alive: true, fallFrom: null, sel: 0, jumpDelay: 0,
};
const HALF = 0.3, TALL = 1.8, EYE = 1.62;
/// The player's movement between ticks (playerTick): the position a tick ago (drawn between it and player.pos), and
/// what eases from tick to tick (each with its value a tick ago, to draw in between): the eye's height, the view's
/// widening while sprinting, and the view bobbing's phase (walk) and strength (bob).
const move = {
  acc: 0, prev: new THREE.Vector3().copy(player.pos), sprinting: false, sneaking: false, eating: false,
  tap: 0, hadForward: false, tapped: false, jumpPressed: false, autoJump: false, wall: false,
  eye: EYE, eyeOld: EYE, fov: 1, fovOld: 1, walk: 0, walkOld: 0, bob: 0, bobOld: 0,
};

// Your own miner, seen from outside: V (or the 👁 button) switches between first person, behind you, and facing
// you. Mining, placing and fighting always aim from your eyes, whichever view is on.
const VIEWS = ["First person", "Behind you", "Facing you"];
let view = 0, myLook = null, me = null;
let handArm = null; // your bare arm in first person (held.js bareArm), in your miner's colours: made when first shown
let heldNow = 0; // the item in your hand (0: nothing), as your miner and everyone else show it
let prelaunch = false; // the room says $MINE isn't live yet: practice earnings, free trips and shop
try { myLook = unpackTraits(JSON.parse(localStorage.getItem("mwc:wornTraits"))); } catch {}
const meHolder = new THREE.Group(); // stands your miner on the curved planet (planet.place); me.root turns within it
scene.add(meHolder);
/// Dress your own miner as a Crafter (its traits), or as the Rookie (null).
function dressMe(traits) {
  if (me) { meHolder.remove(me.root); me.dispose(); }
  myLook = traits ?? null;
  me = createAvatar(myLook, inv.armorTiers());
  me.hold(heldModel(heldNow));
  me.root.visible = view > 0;
  meHolder.add(me.root);
  // The bare arm, in the new colours.
  if (handArm) {
    const shown = heldMesh === handArm;
    if (shown) heldGroup.remove(handArm);
    handArm.traverse((n) => { if (n.isMesh) { n.geometry.dispose(); n.material.dispose(); } });
    handArm = null;
    if (shown) showHeld(0);
  }
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

/// The wear bar under a tool's, weapon's or armor's icon (only once it's been used), green to red as it wears.
function wearBar(id, d) {
  const max = BLK.maxDurability(id);
  if (!max || !d) return "";
  const left = Math.max(0, 1 - d / max);
  return `<span class="dura"><i style="width:${Math.max(4, left * 100)}%;background:hsl(${Math.round(left * 120)},85%,48%)"></i></span>`;
}
const usesLeft = (id, d) => (BLK.maxDurability(id) ? ` (${BLK.maxDurability(id) - (d ?? 0)}/${BLK.maxDurability(id)} uses left)` : "");
function slotHtml(i, extraClass = "") {
  const s = inv.slot(i);
  return `<div class="slot ${extraClass}" data-slot="${i}">${s ? `<img src="${iconFor(s.id, atlas)}" alt="${itemName(s.id)}" title="${itemName(s.id)}${usesLeft(s.id, s.d)}">${s.n > 1 ? `<span class="n">${s.n}</span>` : ""}${wearBar(s.id, s.d)}` : ""}</div>`;
}
/// Something wore out: it's gone.
function broke(id) {
  toast(`Your ${itemName(id).toLowerCase()} broke!`, "bad");
  sfx.broke(true);
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
  if (t.textContent !== text) t.textContent = text; // (it's called every frame while you look at something)
  t.hidden = false;
  clearTimeout(targetTimer);
  targetTimer = setTimeout(() => (t.hidden = true), ms);
}

// The inventory sheet: swap slots, wear armor, craft.
let picked = null;
const SLOT_NAMES = { head: "Helmet", chest: "Chestplate", legs: "Leggings", feet: "Boots" };
function drawInventory() {
  if ($("inv").hidden) return;
  $("armorSlots").innerHTML = BLK.ARMOR_SLOTS.map((slot) => {
    const id = inv.worn(slot);
    const w = inv.wornItem(slot);
    return `<div class="slot ${id ? "" : "empty"}" data-armor="${slot}" title="${id ? `${itemName(id)}${usesLeft(id, w.d)}: click to take off` : `${SLOT_NAMES[slot]}: none`}">${id ? `<img src="${iconFor(id, atlas)}" alt="">${wearBar(id, w.d)}` : SLOT_NAMES[slot][0]}</div>`;
  }).join("");
  let html = "";
  for (let i = 0; i < SLOTS; i++) html += slotHtml(i, picked === i ? "picked" : "");
  $("invGrid").innerHTML = html;
  // Repairs first: two worn copies of the same thing make one (their uses left, plus 5%).
  $("recipes").innerHTML = inv.repairs().map((id) => `<button class="recipe" data-repair="${id}"><img src="${iconFor(id, atlas)}" alt="">
      <span>Repair ${itemName(id).toLowerCase()}<span class="need">Combine 2 into 1 (their uses left, plus 5%)</span></span></button>`).join("")
    + inv.recipes.map((r, i) => {
    const need = Object.entries(r.need).map(([id, n]) => `${n} ${itemName(Number(id))}`).join(" + ");
    return `<button class="recipe" data-recipe="${i}" ${inv.canCraft(r) ? "" : "disabled"}><img src="${iconFor(r.out, atlas)}" alt="">
      <span>${r.n > 1 ? `${r.n} ` : ""}${itemName(r.out)}<span class="need">${need}</span></span></button>`;
  }).join("");
}
// When the armor worn changes: the armor row, your miner, and what the others see.
let wornKey = "";
inv.onChange = () => {
  drawHotbar();
  drawInventory();
  const tiers = inv.armorTiers(), k = tiers.join();
  if (k === wornKey) return;
  wornKey = k;
  drawArmor();
  dressMe(myLook);
  sendGear();
};
$("inv").addEventListener("click", (e) => {
  if (e.target === $("inv") || e.target.closest("[data-close]")) return closeInventory();
  const worn = e.target.closest("[data-armor]");
  if (worn) {
    if (inv.worn(worn.dataset.armor) && !inv.unequip(worn.dataset.armor)) toast("Make room in your inventory first.", "bad");
    return drawInventory();
  }
  const s = e.target.closest("[data-slot]");
  if (s) {
    const i = Number(s.dataset.slot);
    // Clicking armor puts it on (whatever was worn there takes its place).
    if (picked === null && BLK.ARMOR[inv.slot(i)?.id]) { inv.equip(i); return drawInventory(); }
    if (picked === null) picked = inv.slot(i) ? i : null;
    else { inv.swap(picked, i); picked = null; }
    return drawInventory();
  }
  const fix = e.target.closest("[data-repair]");
  if (fix) {
    inv.repair(Number(fix.dataset.repair));
    sfx.place();
    return toast(`Repaired your ${itemName(Number(fix.dataset.repair)).toLowerCase()}.`, "good");
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
setHeldAtlas(atlas, atlasTex);
// In first person what's in hand hangs off the view exactly as Minecraft Java's does (GameRenderer.renderItemInHand
// and ItemInHandRenderer, right-handed), in handScene (above), metres being blocks, x right, y up, -z ahead:
// - bobber: the view bobbing (placeCamera), the same as the world's;
// - swayer: the hand lagging the view as you turn (Minecraft's xBob and yBob);
// - heldGroup: the arm, a matrix built up as Minecraft's pose stack is (drawHand): the swing, the arm's place and the
//   equip's dip, the attack's turn, or the lift to the mouth while eating;
// - in it, the item placed by its model's own first-person display settings (held.js heldModel "first"), or with
//   nothing in hand, Minecraft's bare arm (held.js bareArm, in your miner's colours).
const HAND = {
  side: 1, // the right hand (Minecraft's 1; the left would be -1)
  x: 0.56, y: -0.52, z: -0.72, drop: -0.6, // applyItemArmTransform: where the item is held, and its drop when changing
  ticks: 6, dip: 0.4, // a swing's ticks (as your miner's, avatar.js); the most the equip's height changes in a tick
  sway: 0.1, swayEase: 0.5, // turned by (view - bob) x sway; bob eases this much of the way to the view a tick
  eatTicks: EAT_SECONDS * 20, // food's use time (Minecraft's 32 ticks)
};
const bobber = new THREE.Group();
const swayer = new THREE.Group();
const heldGroup = new THREE.Group();
heldGroup.matrixAutoUpdate = false; // (drawHand sets its matrix)
handScene.add(bobber);
bobber.add(swayer);
swayer.add(heldGroup);
let heldMesh = null; // what's in it now
/// The hand's swing (its tick, and how far through it is, 0..1), height (1 up, 0 out of sight: Minecraft's
/// mainHandHeight) and the view it lags behind (Minecraft's xBob and yBob, in radians as player.pitch and yaw), each
/// with its value a tick ago, and the item whose model it shows.
const hand = { swinging: false, time: 0, attack: 0, attackOld: 0, height: 1, heightOld: 1, shown: 0, pitch: 0, pitchOld: 0, yaw: 0, yawOld: 0 };
/// A swing of the hand (a new one only once the last is halfway: mining keeps starting them).
function swingHand() {
  if (!hand.swinging || hand.time >= HAND.ticks / 2 || hand.time < 0) { hand.time = -1; hand.swinging = true; }
}
let gearTimer = 0;
/// Tells the room what you wear and hold (the four armor tiers, then the item in hand), a moment after the last
/// change, so scrolling through the hotbar sends one message rather than one per slot.
function sendGear(now = false) {
  clearTimeout(gearTimer);
  const go = () => net?.gear([...inv.armorTiers(), heldNow]);
  if (now) go();
  else gearTimer = setTimeout(go, 400);
}
/// After the selected slot or what's in it changed: your miner holds the new item at once (and the others are told);
/// your first-person hand dips and comes back up with it (handTick).
function updateHeld() {
  const id = inv.slot(player.sel)?.id ?? 0;
  if (id !== heldNow) {
    heldNow = id;
    me?.hold(heldModel(id));
    sendGear();
  }
}
/// Puts item `id`'s first-person model in the hand, or with nothing (0) the bare arm.
function showHeld(id) {
  hand.shown = id;
  if (heldMesh) heldGroup.remove(heldMesh); // (an item's model is shared, held.js; the arm is kept)
  heldMesh = id ? heldModel(id, "first") : (handArm ??= bareArm(me.colours));
  if (heldMesh) heldGroup.add(heldMesh);
}
const turnAngle = (r) => r - 2 * Math.PI * Math.floor(r / (2 * Math.PI) + 0.5); // into [-pi, pi)
/// The hand's tick (Minecraft's ItemInHandRenderer.tick and LocalPlayer's xBob/yBob): the swing goes on (mining or
/// fighting, held down, keeps it going); the lag eases towards the view; the height heads for the attack strength
/// cubed (so it dips after a hit and rises as the weapon is ready again, as Minecraft's does), or down to change what's
/// shown, at most `dip` a tick.
function handTick(busy) {
  hand.attackOld = hand.attack;
  hand.heightOld = hand.height;
  hand.pitchOld = hand.pitch;
  hand.yawOld = hand.yaw;
  hand.pitch += (player.pitch - hand.pitch) * HAND.swayEase;
  hand.yaw += turnAngle(player.yaw - hand.yaw) * HAND.swayEase;
  if (busy) swingHand();
  if (hand.swinging && ++hand.time >= HAND.ticks) { hand.time = 0; hand.swinging = false; }
  if (!hand.swinging) hand.time = 0;
  hand.attack = hand.time / HAND.ticks;
  const strength = Math.min(1, (performance.now() - attackAt) / (TOOLS[heldNow]?.swingMs ?? ATTACK_MS));
  const want = heldNow === hand.shown ? strength ** 3 : 0;
  hand.height += Math.max(-HAND.dip, Math.min(HAND.dip, want - hand.height));
  if (hand.height < 0.1 && heldNow !== hand.shown) showHeld(heldNow);
}
const DEG = Math.PI / 180;
/// heldGroup's matrix, built up the way Minecraft's PoseStack is: each step moves or turns (degrees) what follows.
const _step = new THREE.Matrix4();
const pose = {
  m: heldGroup.matrix,
  move(x, y, z) { this.m.multiply(_step.makeTranslation(x, y, z)); return this; },
  turnX(d) { this.m.multiply(_step.makeRotationX(d * DEG)); return this; },
  turnY(d) { this.m.multiply(_step.makeRotationY(d * DEG)); return this; },
  turnZ(d) { this.m.multiply(_step.makeRotationZ(d * DEG)); return this; },
};
/// Poses the first-person hand `a` (0..1) of the way between ticks, as Minecraft's renderHandsWithItems does.
function drawHand(a) {
  const side = HAND.side;
  let p = hand.attack - hand.attackOld;
  if (p < 0) p += 1; // (the swing wrapped round to the next one)
  p = dev.swing ?? hand.attackOld + p * a; // the swing's progress, 0..1
  const sq = Math.sqrt(p), equip = 1 - (hand.heightOld + (hand.height - hand.heightOld) * a);
  // The lag behind the view (Minecraft turns by (view - bob) x 0.1, its pitch down and yaw right being ours negated).
  const bobPitch = hand.pitchOld + (hand.pitch - hand.pitchOld) * a;
  const bobYaw = hand.yawOld + turnAngle(hand.yaw - hand.yawOld) * a;
  swayer.rotation.set(-(player.pitch - bobPitch) * HAND.sway, -turnAngle(player.yaw - bobYaw) * HAND.sway, 0, "XYZ");
  pose.m.identity();
  if (heldMesh && heldMesh === handArm) {
    // The bare arm (renderPlayerArm): out from the lower right, punching forward in a swing.
    pose.move(side * (-0.3 * Math.sin(sq * Math.PI) + 0.64), 0.4 * Math.sin(sq * Math.PI * 2) - 0.6 + equip * -0.6,
      -0.4 * Math.sin(p * Math.PI) - 0.72)
      .turnY(side * 45)
      .turnY(side * Math.sin(sq * Math.PI) * 70)
      .turnZ(side * Math.sin(p * p * Math.PI) * -20)
      .move(side * -1, 3.6, 3.5)
      .turnZ(side * 120).turnX(200).turnY(side * -135)
      .move(side * 5.6, 0, 0);
  } else if (move.eating && eatT > 0) {
    // Eating (applyEatTransform): lifted to the mouth and turned to face you, bobbing as you chew.
    const left = Math.max(0, HAND.eatTicks - eatT * 20) + 1, f = Math.min(1, left / HAND.eatTicks);
    if (f < 0.8) pose.move(0, Math.abs(Math.cos((left / 4) * Math.PI) * 0.1), 0);
    const up = 1 - f ** 27;
    pose.move(up * 0.6 * side, up * -0.5, 0).turnY(side * up * 90).turnX(up * 10).turnZ(side * up * 30)
      .move(side * HAND.x, HAND.y + equip * HAND.drop, HAND.z);
  } else {
    // The swing: across and up, then a chop down and away (the swing's move, applyItemArmTransform, then
    // applyItemArmAttackTransform).
    pose.move(side * -0.4 * Math.sin(sq * Math.PI), 0.2 * Math.sin(sq * Math.PI * 2), -0.2 * Math.sin(p * Math.PI))
      .move(side * HAND.x, HAND.y + equip * HAND.drop, HAND.z)
      .turnY(side * (45 + Math.sin(p * p * Math.PI) * -20))
      .turnZ(side * Math.sin(sq * Math.PI) * -20)
      .turnX(Math.sin(sq * Math.PI) * -80)
      .turnY(side * -45);
  }
  heldGroup.matrixWorldNeedsUpdate = true;
}
/// Draws the hand over the world (frame(), after the world), lit as the block shader lights the world where your eyes
/// are (world.js): the brighter of the daylight that reaches there and a light's warm glow, never quite black. So it
/// darkens at night and in caves, and warms by a torch, with the world round it.
const _handLight = new THREE.Color();
function renderHand() {
  if (view !== 0 || !heldGroup.visible || !heldMesh) return;
  const { sky, block } = world.lightAt(eyePos.x, eyePos.y, eyePos.z);
  const day = sky * world.uniforms.daylight.value;
  _handLight.setRGB(Math.max(day, block, 0.045), Math.max(day, block * 0.84, 0.045), Math.max(day, block * 0.62, 0.045));
  handAmbient.color.copy(_handLight);
  handAmbient.intensity = HAND_LIGHT.even * Math.PI;
  handKey.color.copy(_handLight);
  handKey.intensity = HAND_LIGHT.key * Math.PI;
  renderer.autoClear = false;
  renderer.clearDepth();
  renderer.render(handScene, handCamera);
  renderer.autoClear = true;
}
showHeld(0);

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

// The Mining Sites' sign.
let officeSign = null;
{
  const c = document.createElement("canvas");
  c.width = 512; c.height = 96;
  const g = c.getContext("2d");
  g.fillStyle = "#3a2a18"; g.fillRect(0, 0, 512, 96);
  g.strokeStyle = "#f5c832"; g.lineWidth = 8; g.strokeRect(4, 4, 504, 88);
  g.fillStyle = "#f5c832"; g.font = "700 46px Silkscreen, monospace"; g.textAlign = "center"; g.textBaseline = "middle";
  g.fillText("MINING SITES", 256, 50);
  const t = new THREE.CanvasTexture(c);
  officeSign = new THREE.Mesh(new THREE.PlaneGeometry(6, 1.1), new THREE.MeshBasicMaterial({ map: t }));
  officeSign.userData.at = new THREE.Vector3(TOWN.x + 0.5, TOWN.y + 4.45, TOWN.z + OFFICE.z1 + 1.02);
  scene.add(officeSign);
  document.fonts?.ready.then(() => { g.fillStyle = "#3a2a18"; g.fillRect(8, 8, 496, 80); g.fillStyle = "#f5c832"; g.fillText("MINING SITES", 256, 50); t.needsUpdate = true; });
}

// ---------------------------------------------------------------- monsters
// A monster beaten here that the room hasn't confirmed (a hit it didn't count) is given up after a moment, so the
// room frees its place for the next one.
const confirmed = new Set();
const villagers = createVillagers(scene);
let biteLeft = 0;
function drawArmor() {
  const pts = Math.min(20, inv.armorPoints());
  $("armorRow").hidden = pts === 0;
  if (pts) drawRow($("armorRow"), pts, [ICONS.armor, ICONS.armorHalf, ICONS.armorEmpty]);
}
const mobs = createMobs(scene, world, {
  gone(id) { if (id > 0) net?.gone(id); },
  killed(id) {
    if (id > 0) setTimeout(() => { if (!confirmed.delete(id)) net?.gone(id); }, 2500);
  },
  bite(dmg, dx, dz) { takeHit(dmg, dx, dz); },
});
/// A hit taken (a monster's bite, the boss's slam or rock, another player's blow in a PvP zone), pushing you along
/// (dx, dz). Armor takes its share; what's left over in fractions adds up to whole points. Each worn piece wears a
/// quarter of the hit (at least 1).
function takeHit(dmg, dx, dz, push = 6) {
  if (!player.alive || trip) return;
  for (const id of inv.wearArmor(Math.max(1, Math.floor(dmg / 4)))) broke(id);
  biteLeft += dmg * (1 - BLK.armorShare(inv.armorPoints()));
  const n = Math.floor(biteLeft);
  biteLeft -= n;
  if (n) hurt(n);
  player.vel.x += dx * push; player.vel.z += dz * push; player.vel.y = Math.max(player.vel.y, 4);
}
let offlineMobAt = 0, offlineMobSeq = 0;
function offlineMobs(now) {
  // With no world server there's no ledger, but the nights still have monsters (and Deepvein's days).
  const M = zoneOf(zone).mobs;
  if (net?.online || now < offlineMobAt || mobs.count() >= M.max) return;
  if (!M.always && !isNight(Date.now()) && player.pos.y >= UNDERGROUND_Y) return;
  if (calmAt(zone, player.pos.x, player.pos.z)) return;
  offlineMobAt = now + M.everyMs;
  const a = Math.random() * Math.PI * 2;
  mobs.spawn(-(++offlineMobSeq), MOB_KINDS[Math.floor(Math.random() * 3)], wrap(player.pos.x + Math.cos(a) * 12), player.pos.y, wrap(player.pos.z + Math.sin(a) * 12), M);
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
    knockedOut();
    $("dead").hidden = false;
  }
}
// ---------------------------------------------------------------- knocked out
// Whatever knocks you out (a fall, monsters, the boss, another player, the void), everything you carry, armor too,
// drops in a loot chest where you fell, for anyone on that planet (you too) to open for CHEST_MS: the world server
// makes it from what the game reports, and offline the game keeps it itself. Knocked out at home: respawn in town
// (free) or revive where you fell, in time to open your own chest if nobody has (REVIVE_PRICE $MINE, paid like a
// rocket ticket: MinePayments kind 2, checked by the room; free before launch, while the room says so, and offline;
// guests can't pay). Knocked out in a zone, the room sends you home at once ("zoned"); your things stay there.
let lastPvp = null; // { by, at }: the last hit from another player
/// The knock-out you're down from: { zone, x, y, z, by (the player who did it, in a PvP zone), byName, stacks (what
/// dropped), kept (the room made no chest, so you kept it) }, or null.
let died = null;
let reviveFree = false; // the room says revives are free (before launch, or zones.js REVIVE_FREE)
let reviving = false;
function knockedOut() {
  const by = zoneOf(zone).pvp && lastPvp && performance.now() - lastPvp.at < PVP.killMs - 500 && net?.online ? lastPvp.by : null;
  lastPvp = null;
  const stacks = inv.stacks();
  died = { zone, x: player.pos.x, y: player.pos.y, z: player.pos.z, by, byName: by === null ? null : net.others.get(by)?.name ?? "Another player", stacks, kept: false };
  inv.clearAll();
  if (net) net.dead(stacks, died.x, died.y, died.z, by);
  else if (stacks.length) dropLocal(stacks);
  setReviveStatus(null);
  drawDead();
}
/// The knocked-out screen: what happened to your things, "Respawn at spawn", and at home "Revive here".
function drawDead() {
  if (!died) return;
  const Z = ZONES[died.zone], mins = CHEST_MS / 60_000, home = died.zone === "home";
  const things = !died.stacks.length ? "You carried nothing, so nothing dropped." : died.kept ? "You keep what you carry this time." : null;
  const who = died.byName ? `${died.byName} beat you` : "You were knocked out";
  // (Offline the chest is yours alone.)
  $("deadText").textContent = home
    ? things ?? `Everything you carried, armor too, is in a chest where you fell${net ? `: anyone can open it for ${mins} minutes, so get there first` : `, for ${mins} minutes`}.`
    : `${who} in ${Z.name}: back to the home planet. ${things ?? `Your things stay there for ${mins} minutes, in a chest ${net ? "anyone there can open" : "where you fell"}.`}`;
  // Revive: home only. Offline it's free; online free before launch (or while the room says so), else paid, by a
  // signed-in wallet only.
  const paid = !!net && !reviveFree;
  const can = home && zone === "home" && (!paid || ledger.signedIn);
  const spare = paid && ledger.signedIn && spareRevive(ledger.wallet);
  $("revive").hidden = !can;
  $("revive").disabled = reviving;
  $("revive").textContent = !net ? "Revive here (free offline)"
    : !paid ? (prelaunch ? "Revive here (free until $MINE launches)" : "Revive here (free)")
    : spare ? "Revive here (already paid)" : `Revive here: ${REVIVE_PRICE.toLocaleString("en-US")} $MINE`;
  $("reviveNote").hidden = !(home && zone === "home" && paid && !ledger.signedIn);
  $("reviveNote").textContent = `Signed-in players can revive where they fell for ${REVIVE_PRICE.toLocaleString("en-US")} $MINE.`;
  $("respawn").textContent = "Respawn at spawn";
  $("respawn").title = "Free: the town square on the home planet, with full health and food";
  $("revive").title = "Back on your feet where you fell, with full health and food";
}
function setReviveStatus(text, kind = "") {
  $("reviveStatus").hidden = !text;
  $("reviveStatus").className = `card-status ${kind}`;
  $("reviveStatus").textContent = text ?? "";
}
/// Back on your feet at `at` (facing `yaw`), with full health and food.
function standUp(at, yaw) {
  player.pos.set(at.x, at.y, at.z);
  player.vel.set(0, 0, 0);
  player.yaw = yaw;
  player.pitch = 0;
  player.health = 20;
  player.alive = true;
  player.fallFrom = null;
  died = null;
  reviving = false;
  setReviveStatus(null);
  $("dead").hidden = true;
  mobs.clear();
  hunger.reset();
  drawHearts();
}
/// "Respawn at spawn": the town square on the home planet (from a zone too: the room has already sent you home, or,
/// offline, the game flies you there now).
function respawn() {
  if (player.alive) return;
  const sp = spawnOf("home");
  if (zone !== "home") switchZone("home", sp);
  standUp(sp, 0);
  net?.respawn();
}
$("respawn").addEventListener("click", respawn);
/// "Revive here": up again where you fell (home only). Offline it's free; online the room stands you there, free or
/// once it has checked your payment.
async function revive() {
  if (player.alive || !died || reviving || died.zone !== "home" || zone !== "home") return;
  if (!net) return standUp(died, player.yaw);
  reviving = true;
  drawDead();
  try {
    const r = reviveFree ? await net.revive(null) : await paidRevive((text) => setReviveStatus(text));
    if (r[0] !== "revived") throw new Error(r[1]);
    if (!player.alive) standUp({ x: r[1], y: r[2], z: r[3] }, player.yaw);
    toast("Back on your feet where you fell.", "good");
  } catch (e) {
    setReviveStatus(explain(e), "bad");
  } finally {
    reviving = false;
    drawDead();
  }
}
$("revive").addEventListener("click", () => revive());
// A revive paid for but not used (the connection dropped as it was checked, or you respawned first) is kept here, and
// pays for the next one within 3 hours (the room takes a payment that old, once).
const revKey = (w) => `mwc:revpay:${w.toLowerCase()}`;
function spareRevive(w) {
  try { const v = JSON.parse(localStorage.getItem(revKey(w))); return v?.hash && Date.now() - v.at < 2.9 * 3600_000 ? v.hash : null; } catch { return null; }
}
function setSpare(w, hash) {
  try { hash ? localStorage.setItem(revKey(w), JSON.stringify({ hash, at: Date.now() })) : localStorage.removeItem(revKey(w)); } catch {}
}
/// Pays for a revive (MinePayments kind 2, approving exactly REVIVE_PRICE first; or a spare one) and hands the room
/// the transaction: resolves with its answer. Tried again a couple of times while the room can't read the chain yet.
async function paidRevive(step) {
  if (!chain?.hasPayments) throw new Error("Revives can't be paid for on this chain yet.");
  if (!net?.online) throw new Error("The world server is offline right now, and it checks revives. Try again soon.");
  if (!ledger.signedIn) throw new Error("Sign in to earn first (Mining Site panel, M) to pay for a revive.");
  if (chain.account?.toLowerCase() !== ledger.wallet?.toLowerCase()) throw new Error("Log in with the wallet you signed in with.");
  const wallet = ledger.wallet;
  let hash = spareRevive(wallet);
  if (hash) step("Using the revive you paid for earlier…");
  else {
    try {
      ({ hash } = await chain.pay(REVIVE_KIND, BigInt(REVIVE_PRICE) * 10n ** 18n, { step, what: " to revive", onHash: (h) => setSpare(wallet, h) }));
    } catch (e) {
      setSpare(wallet, null); // (it never paid)
      throw e;
    }
    step("Paid. The world server is checking the payment…");
  }
  for (let tries = 0; ; tries++) {
    const r = await net.revive(hash);
    if (r[0] === "revived") { setSpare(wallet, null); return r; }
    if (!r[3]) setSpare(wallet, null); // (it never will: 2 keeps it for later)
    if (r[3] !== 1 || tries >= 2) return r;
    await new Promise((ok) => setTimeout(ok, 3000));
  }
}
// Offline (no world server), the game keeps your loot chest itself: one at a time, CHEST_MS, on the planet you fell.
const localChests = new Map(); // id (negative) -> { id, zone, x, y, z, until, items }
let localSeq = 0;
function dropLocal(stacks) {
  for (const id of localChests.keys()) chests.remove(id);
  localChests.clear();
  const y = died.y >= 1 ? died.y : world.topAt(Math.floor(died.x), Math.floor(died.z)) + 1; // (out of the world: on top)
  const c = { id: -(++localSeq), zone, x: died.x, y, z: died.z, until: Date.now() + CHEST_MS, items: stacks };
  localChests.set(c.id, c);
  chests.add(c.id, c.x, c.y, c.z, c.until, null);
}
function lootLocal(id) {
  const c = localChests.get(id);
  if (!c || Date.now() > c.until) { localChests.delete(id); chests.remove(id); return toast("That chest is gone.", "bad"); }
  if (Math.hypot(wrapDelta(c.x - player.pos.x), wrapDelta(c.z - player.pos.z)) > CHEST_REACH || Math.abs(c.y - player.pos.y) > 5) return toast("Get closer to the chest.", "bad");
  localChests.delete(id);
  chests.remove(id);
  let left = 0;
  for (const [item, n, d] of c.items) left += inv.give(item, n, d);
  sfx.chest();
  toast(`You got your things back.${left ? " Your bag was full: some of it was left behind." : ""}`, "gold");
}

// ---------------------------------------------------------------- the room
let net = null, serverOffset = 0;
const synced = new Set();
// Amounts are in ledger units (rewards.js UNIT). `cap`: your daily cap here, with your boost; `boost`: your NFT boost
// as the room last said (boosts.js), none until it has checked your NFTs (and none for guests).
const ledger = { signedIn: false, wallet: null, name: null, today: 0, total: 0, cap: dailyCap(0, "home"), boost: NO_BOOST };
function drawLedger() {
  $("earnToday").textContent = fmtMine(ledger.today);
  $("earnWho").textContent = ledger.signedIn ? `${ledger.name ?? short(ledger.wallet)} · ${fmtMine(ledger.total)} earned in all` : "Guest: sign in to earn (M)";
  $("earnPractice").hidden = !prelaunch;
  const b = ledger.boost, said = describe(b);
  $("earnBoost").hidden = !ledger.signedIn || !said;
  $("earnBoost").textContent = `⚡ ${[b.speed && `+${b.speed}% speed`, b.earn && `+${b.earn}% $MINE`, b.cap && `cap ${fmtMine(ledger.cap)}`, b.move && `+${b.move}% move`].filter(Boolean).join(", ")}`;
  $("earnBoost").title = `Your boosts, from ${b.sources.map((x) => x.label).join(", ") || "nothing yet"}. Daily cap here: ${fmtMine(ledger.cap)} $MINE.`;
  panel?.render();
}
/// No boost (signed out, or reconnecting: the room checks your NFTs again first).
function dropBoost() {
  ledger.boost = NO_BOOST;
  ledger.cap = dailyCap(0, zone);
}
let voice = null;
const url = roomUrl();
if (url) {
  net = createNet(url, scene, {
    status(on) {
      // Every chunk in range is asked for again once connected (edits made meanwhile come back with it).
      synced.clear();
      world.forgetRequests();
      if (!on) { mobs.clear(); dropBoost(); drawLedger(); }
      $("onlineN").hidden = !on;
    },
    welcome(serverTime, count, flags) {
      serverOffset = serverTime - Date.now();
      // Before launch the room keeps a practice ledger (reset at launch), and trips and the shop are free.
      prelaunch = !!flags.practice;
      setTicketsFree(flags.ticketsFree, prelaunch);
      reviveFree = !!flags.reviveFree;
      drawDead();
      drawLedger();
      $("onlineN").textContent = `● ${count} online`;
      if (ledger.wallet) tryResume(ledger.wallet);
      voice?.reconnected();
      if (inv.armorPoints() || heldNow) sendGear(true);
    },
    joined(id, name, how, from) {
      sysLine(how === "landed" ? `${name} landed here by rocket`
        : how === "ko" ? `${name} was knocked out in ${ZONES[from]?.name ?? "a zone"} and is back home` : `${name} joined the game`);
    },
    left(id, name, to, ko) {
      sysLine(ko ? `${name} was knocked out and sent home` : to ? `${name} flew to ${ZONES[to]?.name ?? "another planet"}` : `${name} left the game`);
      voice?.left(id);
    },
    gone(id) { voice?.left(id); },
    /// The room has you on planet k: the answer to a flight; or a flight it refused; or, after a reload or a sign-in,
    /// the zone your wallet was on (the room remembers it: a ticket has no time limit); or, knocked out in a zone, home.
    zoned(k, at) {
      if (k === zone) {
        // Not after our own flight: whatever was asked meanwhile may have been answered for another planet.
        if (!trip) { synced.clear(); world.forgetRequests(); }
        return;
      }
      if (trip) trip.to = k; // (a flight the room refused: the rocket lands where the room has you)
      else if (player.alive) toast(`You're on ${ZONES[k].name}${k === "home" ? "" : ", where you left off"}.`, "good");
      switchZone(k, at ? { ...at, yaw: player.yaw } : landing(k));
      drawZoneTag();
      drawDead();
    },
    regrow(k) {
      if (k !== zone) return;
      world.setZone(zone);
      synced.clear();
      toast(`A new week: ${ZONES[zone].name} has grown back.`, "good");
    },
    sys(text) { sysLine(text); },
    boss(m) { boss.set(m); },
    bossHp(hp) { boss.setHp(hp); },
    bossReward({ units, share, items, signedIn }) {
      for (const [id, n] of items) if (inv.give(id, n)) toast("Your bag is full: some loot was left behind.", "bad");
      const loot = items.map(([id, n]) => `${n > 1 ? `${n} ` : ""}${itemName(id)}`).join(", ");
      const text = `${BOSS.name} is beaten! You did ${share}% of the damage${units ? `: +${fmtMine(units)} $MINE` : ""}${loot ? `, and got ${loot}` : ""}.`;
      sysLine(text);
      toast(text, "gold");
      if (!signedIn) sysLine("Sign in to earn (M) to get a share of the boss's $MINE next time.");
      sfx.win();
    },
    pvpHit(from, dmg, dx, dz) {
      if (!zoneOf(zone).pvp || !player.alive) return;
      lastPvp = { by: from, at: performance.now() };
      showTarget(`${net.others.get(from)?.name ?? "Someone"} hit you!`, 900);
      takeHit(dmg, dx, dz, 7);
    },
    pvpNo(target, why) {
      if (why === "safe") showTarget("No fighting on the landing pad", 900);
      else if (why === "nopvp") showTarget(zoneOf(zone).rule, 1200);
    },
    /// The room made your loot chest where you fell (0: you carried nothing).
    dropped() {},
    /// The room made no chest (knocked out again so soon): you keep what you carried.
    dropNo() {
      if (!died || died.kept) return;
      died.kept = true;
      let left = 0;
      for (const [item, n, d] of died.stacks) left += inv.give(item, n, d);
      if (left) toast("Your bag was full: some of your things were lost.", "bad");
      drawDead();
    },
    /// A revive the room answered after the game gave up waiting.
    revive(m) { if (m[0] === "revived" && !player.alive && died?.zone === "home" && zone === "home") standUp({ x: m[1], y: m[2], z: m[3] }, player.yaw); },
    chest(id, x, y, z, until, who) { chests.add(id, x, y, z, until, who); },
    chests(list) { chests.set(list); },
    chestGone(id, by) { chests.remove(id); if (by) sysLine(`${by} opened a loot chest.`); },
    looted(id, items, who) {
      chests.remove(id);
      let left = 0;
      for (const [item, n, d] of items) left += inv.give(item, n, d);
      sfx.chest();
      toast(`You took ${who}'s loot: ${items.length} stack${items.length === 1 ? "" : "s"}.${left ? " Your bag was full: some of it was left behind." : ""}`, "gold");
    },
    lootNo(id, why) { toast(why, "bad"); },
    /// Your rocket tickets, as the room keeps them (after signing in, buying one, and using one).
    tickets(t) { tickets = t; drawCard(); },
    voices(ids) { voice?.setVoices(ids); },
    voice(id, on) { voice?.setVoice(id, on); },
    rtc(from, data) { voice?.signal(from, data); },
    named(name) { ledger.name = name; drawLedger(); drawNameBox(); toast(`You're ${name} now.`, "good"); },
    edits(k, list) { world.setEdits(k, list); synced.add(k); },
    set(x, y, z, b) { world.set(x, y, z, b); },
    earn({ units, today, total, what }) {
      Object.assign(ledger, { today, total });
      if (what === "cap" || what === "worldcap" || !units) {
        if (what === "cap") showTarget(`Your daily $MINE limit (${fmtMine(ledger.cap)}) is reached: come back tomorrow (UTC)`, 2500);
        if (what === "worldcap") showTarget(`Today's ${WORLD_DAILY_CAP.toLocaleString("en-US")} $MINE for everyone is all mined: back at 00:00 UTC`, 2500);
      }
      else {
        sfx.coin();
        const c = document.querySelector(".coin");
        c.classList.remove("pop"); void c.offsetWidth; c.classList.add("pop");
        if (units >= toUnits(0.3)) toast(`+${fmtMine(units)} $MINE · ${typeof what === "number" ? itemName(what) : what}`, "gold"); // (coal and up)
      }
      drawLedger();
    },
    /// Your NFT boost, as the room has checked it (after signing in, wearing a Crafter, equipping, flying).
    boost(b, cap) {
      const was = ledger.boost.sources.map((x) => x.label).join(", ");
      ledger.boost = b;
      if (Number.isFinite(cap)) ledger.cap = cap;
      const now = b.sources.map((x) => x.label).join(", ");
      if (now && now !== was) toast(`⚡ ${now}: ${describe(b)}`, "good");
      drawLedger();
    },
    ledger({ today, total }) { Object.assign(ledger, { today, total }); drawLedger(); },
    mob(id, kind, x, y, z) { mobs.spawn(id, kind, x, y, z, zoneOf(zone).mobs); },
    mobdead(id) { confirmed.add(id); mobs.kill(id); sfx.win(); },
    chat(l) { if (!voice?.isMuted(l.name)) chatLine(l.name, l.text, l.mine); },
    count(n) { $("onlineN").textContent = `● ${n} online`; },
    error(text) { toast(text, "bad"); },
    signedin(wallet, token, l) {
      Object.assign(ledger, { signedIn: true, wallet, name: l.name, today: l.today, total: l.total, cap: l.cap, boost: NO_BOOST });
      drawNameBox();
      try { localStorage.setItem(`mwc:tok:${wallet.toLowerCase()}`, token); } catch {}
      drawLedger();
      if (panel?.worn !== null && panel?.worn !== undefined) net.wear(panel.worn);
      resendTickets(wallet);
      drawDead();
    },
    signedout(reason) {
      ledger.signedIn = false;
      ledger.name = null;
      tickets = {};
      dropBoost();
      try { localStorage.removeItem(`mwc:tok:${ledger.wallet?.toLowerCase()}`); } catch {}
      drawLedger();
      drawDead();
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
let sitesOpen = null; // mining sites open, as the room last said (the title screen's count; the panel's admin box)
let countAt = 0; // when the room was last asked (loadCount)
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
    sitesOpen: () => sitesOpen,
    /// The admin box asks the room again at most once a minute (as often as the room tops its count up).
    refreshCount() { if (Date.now() - countAt > 60_000) loadCount(false); },
    signIn,
    toast,
    wear(traits, tokenId) {
      net?.wear(tokenId);
      if (traits && !ledger.signedIn) toast("You see it now; others will once you sign in to earn (they check it's yours).");
      dressMe(traits);
      try { localStorage.setItem("mwc:wornTraits", JSON.stringify(traits ? packTraits(traits) : null)); } catch {}
    },
    /// Crafter `id` was just leveled up to `level`: if it's the one you wear, the room reads it again at once (rather
    /// than at its next check, minutes away), and once more a few seconds later if the boost it sends back doesn't show
    /// the new level yet (its RPC a block behind).
    leveled(id, level) {
      if (!net?.online || !ledger.signedIn || panel?.worn !== id) return;
      net.recheck();
      setTimeout(() => {
        const src = ledger.boost.sources.find((x) => x.slot === "crafter");
        if (!src || !src.label.endsWith(` L${level}`)) net.recheck();
      }, 5000);
    },
  });
  if (!chain) return;
  chain.onAccount = (a) => {
    // The room stops counting for the old wallet before this one resumes (or stays a guest).
    if (ledger.signedIn) net?.signOut();
    ledger.signedIn = false;
    ledger.wallet = a;
    tickets = {};
    ledger.today = ledger.total = 0;
    dropBoost();
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
  zone: () => zone,
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
/// Grab the mouse for looking around (browsers can refuse, e.g. right after Esc; the next click tries again). Raw
/// mouse movement where the browser offers it (no pointer acceleration, as Minecraft reads the mouse); plain where
/// it doesn't.
function lockMouse() {
  const plain = () => { try { canvas.requestPointerLock?.()?.catch?.(() => {}); } catch {} };
  try {
    const p = canvas.requestPointerLock?.({ unadjustedMovement: true });
    p?.catch?.((e) => { if (e?.name === "NotSupportedError") plain(); });
  } catch { plain(); }
}
const keys = new Set();
let mining = false, placing = false, placeAt = 0, attackAt = 0, playing = false;
const anyOverlay = () => !$("inv").hidden || (panel?.isOpen ?? false) || !$("dead").hidden || !$("wallets").hidden || !$("chatForm").hidden
  || !$("menu").hidden || !$("notice").hidden || !$("shop").hidden || cardOpen();
function setMining(on) {
  if (mining === on) return;
  mining = on;
  net?.act(on);
}

addEventListener("keydown", (e) => {
  if (!playing || e.target.tagName === "INPUT") return;
  keys.add(e.code);
  // (A press too quick for a tick to see still counts: a tap of W towards a double-tap sprint, or of Space.)
  if (!e.repeat && (e.code === "KeyW" || e.code === "ArrowUp")) move.tapped = true;
  if (!e.repeat && e.code === "Space") move.jumpPressed = true;
  // Ctrl sprints: keep the browser's Ctrl shortcuts (Ctrl+D, Ctrl+S...) out of the way while playing.
  if (e.ctrlKey && document.pointerLockElement === canvas) e.preventDefault();
  if (e.code === "KeyE") { $("inv").hidden ? openInventory() : closeInventory(); }
  else if (e.code === "KeyH") { shop.isOpen ? shop.close() : shop.open(); }
  else if (e.code === "KeyM") { panel?.isOpen ? panel.close() : panel?.open(); }
  else if (e.code === "KeyV") nextView();
  else if (e.code === "Enter" || e.code === "KeyT") { e.preventDefault(); openChat(); }
  else if (e.code === "Escape") { closeInventory(); panel?.close(); shop.close(); closeCard(); $("menu").hidden = true; $("notice").hidden = true; }
  else if (e.code === "KeyB") voice?.toggle();
  else if (e.code === "KeyF" && !anyOverlay()) { if (rocket.onPad(player.pos.x, player.pos.y, player.pos.z) || lookingAt === "rocket") openRocket(); }
  else if (/^Digit[1-9]$/.test(e.code)) select(Number(e.code.slice(5)) - 1);
  if (e.code === "Space") e.preventDefault();
});
addEventListener("keyup", (e) => keys.delete(e.code));
// Ctrl+W closes the tab and a page can't stop it: if it comes while sprinting with Ctrl, ask first.
addEventListener("beforeunload", (e) => {
  if (playing && keys.has("ControlLeft") && document.pointerLockElement === canvas) { e.preventDefault(); e.returnValue = ""; }
});
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
// Looking is applied at once, every mouse move, with nothing smoothing it (the movement ticks just read the yaw).
addEventListener("mousemove", (e) => {
  if (document.pointerLockElement !== canvas) return;
  const k = FEEL.look * settings.mouse;
  player.yaw -= e.movementX * k;
  player.pitch = Math.max(-1.55, Math.min(1.55, player.pitch - e.movementY * k));
});
addEventListener("wheel", (e) => {
  if (document.pointerLockElement !== canvas) return;
  if (e.ctrlKey) e.preventDefault(); // (sprinting with Ctrl: the wheel picks, it doesn't zoom the page)
  select(player.sel + Math.sign(e.deltaY));
}, { passive: false });
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
const shop = createShop({ inv, atlas, toast, release: releaseMouse, resume: () => { if (!touch && playing) lockMouse(); }, chain: () => chain, free: () => prelaunch });
$("shopBtn").addEventListener("click", () => shop.open());
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
  if (now - noticeAt < 60_000) return showTarget(`${zone === "home" ? "Spawn" : "The pad"} is protected: go exploring (/wild)`, 1500);
  noticeAt = now;
  setMining(false);
  placing = false;
  releaseMouse();
  $("noticeTitle").textContent = zone === "home" ? "Spawn is protected" : "The landing pad is protected";
  $("noticeText").innerHTML = zone === "home"
    ? "Mining and building are off within 64 blocks of spawn. Walk out, or use <b>/wild</b> to find a safe spot."
    : `Mining and building are off within ${PAD_R} blocks of the pad${zone === "boss" ? ", round the arena and along its path" : ""}. Walk out, or use <b>/wild</b> to find a safe spot.`;
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
$("bobToggle").checked = settings.bob !== false;
$("bobToggle").addEventListener("change", (e) => { settings.bob = e.target.checked; saveSettings(); });

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
  drawArmor();
  drawLedger();
  setTimeout(() => ($("help").hidden = true), 25_000); // (the controls are in the menu too)
});
// The title screen: who's playing, and how many mining sites are open (the room counts them from the chain; sitesOpen
// stays null while it can't tell yet, and is asked again once, a few seconds later). The panel's admin box asks again
// while it's open (refreshCount).
function loadCount(retry = true) {
  if (!url) return;
  countAt = Date.now();
  fetch(url.replace(/^ws/, "http").replace(/\/ws$/, "/count")).then((r) => r.json()).then((j) => {
    if (j?.online >= 0) { $("onlineTitle").hidden = false; $("onlineTitle").textContent = `● ${j.online} mining right now`; }
    if (typeof j?.sites === "number") {
      sitesOpen = j.sites;
      $("sitesTitle").hidden = false;
      $("sitesTitle").textContent = `⛏ ${j.sites.toLocaleString("en-US")} mining site${j.sites === 1 ? "" : "s"} open`;
    } else if (retry) setTimeout(() => loadCount(false), 5000);
  }).catch(() => {});
}
loadCount();

// ---------------------------------------------------------------- mining, placing, fighting
let breaking = null; // { x, y, z, b, t, need }
const ray = new THREE.Vector3();
let lookingAt = null; // what's under the crosshair, if it isn't a block: "folk", "rocket", "chest", "boss" or "foe"
function interact(dt, now) {
  const eye = eyePos;
  lookDir(ray);
  const hit = world.raycast(eye, ray, REACH);
  const mobHit = mobs.raycast(eye, ray, 3.6);
  const mobFirst = mobHit && (!hit || mobHit.t < hit.t);
  // Things that aren't blocks, nearest first: a villager, the rocket, a loot chest, the boss, and another player, but
  // only where players can fight (a PvP zone, off its pad): anywhere else they can't be aimed at, let alone hit.
  const things = [];
  const folk = villagers.raycast(eye, ray, 4.5);
  if (folk) things.push({ kind: "folk", t: folk.t, v: folk.v });
  const rk = rocket.raycast(eye, ray, ROCKET_REACH);
  if (rk) things.push({ kind: "rocket", t: rk.t });
  const ch = chests.raycast(eye, ray, 4.5);
  if (ch) things.push({ kind: "chest", t: ch.t, chest: ch.chest });
  const bs = boss.raycast(eye, ray, 4.5);
  if (bs) things.push({ kind: "boss", t: bs.t });
  const foe = pvpAt(zone, player.pos.x, player.pos.z) ? net?.raycast(eye, ray, 3.6) : null; // (not from the safe pad)
  if (foe) things.push({ kind: "foe", t: foe.t, id: foe.id, o: foe.o });
  things.sort((a, b) => a.t - b.t);
  const th = things[0];
  lookingAt = null;
  if (th && (!hit || th.t < hit.t) && (!mobHit || th.t < mobHit.t)) {
    outline.visible = false;
    crack.visible = false;
    breaking = null;
    lookingAt = th.kind;
    return useThing(th, dt, now);
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
    if (mobFirst) {
      breaking = null;
      if (now - attackAt > (TOOLS[hand]?.swingMs ?? ATTACK_MS)) {
        attackAt = now;
        const dmg = swing(hand);
        mobs.hit(mobHit.mob, dmg, ray.x, ray.z);
        if (mobHit.mob.id > 0) net?.hit(mobHit.mob.id, dmg);
      }
    } else if (hit && allowed) {
      if (protectedIn(zone, hit.x, hit.z)) { spawnNotice(); breaking = null; }
      else if (BLOCKS[hit.b].hardness === Infinity) breaking = null;
      else {
        if (!breaking || breaking.x !== hit.x || breaking.y !== hit.y || breaking.z !== hit.z || breaking.b !== hit.b) {
          // (Your NFT speed boost breaks it sooner; the room allows for the same boost: boosts.js.)
          const bt = breakTime(hit.b, hand);
          breaking = { x: hit.x, y: hit.y, z: hit.z, b: hit.b, t: 0, need: Math.max(0.05, withSpeed(bt.seconds, ledger.boost.speed)), drops: bt.drops, tick: 0 };
        }
        breaking.t += dt;
        breaking.tick -= dt;
        if (breaking.tick <= 0) { breaking.tick = 0.25; sfx.dig(BLOCKS[hit.b].tier > 0); }
        if (breaking.t >= breaking.need) finishBreak(breaking);
      }
    } else breaking = null;
  } else breaking = null;
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
      if (protectedIn(zone, px, pz)) spawnNotice();
      else if ((there === AIR || there === WATER || BLOCKS[there]?.plant) && !boxHitsBlock(player.pos, HALF, TALL, px, py, pz) && py > 0 && py < 128) {
        world.set(px, py, pz, s.id);
        inv.useSlot(player.sel);
        net?.place(px, py, pz, s.id);
        sfx.place();
        swingHand();
        me.swing();
      }
    }
  }
  // The name of what you're looking at.
  if (mobFirst) showTarget(mobHit.mob.def.name, 300);
}

/// A swing with what's in hand at something: its damage (a sword's, or a fist's, a pickaxe a little more); it tires
/// you, and wears the tool (a sword 1 a hit, a pickaxe 2).
function swing(hand) {
  const tool = TOOLS[hand];
  hunger.tire(EXHAUSTION.attack);
  if (tool) {
    const gone = inv.wearOut(player.sel, tool.kind === "sword" ? 1 : 2);
    if (gone) broke(gone);
  }
  sfx.hit();
  return tool?.kind === "sword" ? tool.damage : HAND_DAMAGE + (tool?.kind === "pick" ? 1 : 0);
}

/// Using what's under the crosshair that isn't a block: talk to a villager, open the rocket's card or a loot chest,
/// hit the boss, or (in a PvP zone, off the pad) another player.
function useThing(th, dt, now) {
  const click = mining && !talkLatch && player.alive;
  const hand = inv.slot(player.sel)?.id ?? null;
  const ready = () => now - attackAt > (TOOLS[hand]?.swingMs ?? ATTACK_MS);
  if (th.kind === "folk") {
    showTarget(`${th.v.name} · ${th.v.job} · ${th.v.shop ? "click for the shop" : "click to talk"}`, 300);
    if (click) {
      talkLatch = true;
      sayHello(th.v);
      if (th.v.shop) { setMining(false); shop.open(); }
    }
  } else if (th.kind === "rocket") {
    showTarget(touch ? "The rocket · tap ⛏ to fly" : "The rocket · click (or F) to fly", 300);
    if (click) { talkLatch = true; openRocket(); }
  } else if (th.kind === "chest") {
    const left = Math.max(0, th.chest.until - (Date.now() + serverOffset));
    showTarget(`${lootLabel(th.chest.who)} · click to open · ${Math.floor(left / 60_000)}:${String(Math.floor((left % 60_000) / 1000)).padStart(2, "0")}`, 300);
    if (click) {
      talkLatch = true;
      if (th.chest.id < 0) lootLocal(th.chest.id); // (offline: your own, kept by the game)
      else if (net) net.loot(th.chest.id);
    }
  } else if (th.kind === "boss") {
    showTarget(`${BOSS.name} · ${Math.max(0, boss.state?.hp ?? 0).toLocaleString()} / ${BOSS.hp.toLocaleString()}`, 300);
    if (mining && player.alive && ready()) {
      attackAt = now;
      const dmg = swing(hand);
      boss.flash();
      if (net?.online) net.bossHit(dmg);
      else toast("The boss fight needs the world server (offline right now).");
    }
  } else if (th.kind === "foe") {
    const can = pvpAt(zone, player.pos.x, player.pos.z) && pvpAt(zone, th.o.pos.x, th.o.pos.z);
    showTarget(can ? th.o.name : `${th.o.name} · no fighting on the landing pad`, 300);
    if (mining && player.alive && can && ready()) {
      attackAt = now;
      net.pvpHit(th.id, swing(hand));
    }
  }
}

function finishBreak(b) {
  world.set(b.x, b.y, b.z, AIR);
  // A plant standing on the broken block goes with it.
  const above = world.get(b.x, b.y + 1, b.z);
  if (BLOCKS[above]?.plant && !protectedIn(zone, b.x, b.z)) {
    world.set(b.x, b.y + 1, b.z, AIR);
    net?.breakBlock(b.x, b.y + 1, b.z);
  }
  burst(b.x, b.y, b.z, b.b);
  sfx.broke(BLOCKS[b.b].tier > 0);
  net?.breakBlock(b.x, b.y, b.z);
  hunger.tire(EXHAUSTION.break);
  // The tool in hand wears: a pickaxe 1 a block, anything else 2 (blocks that break instantly cost nothing).
  const tool = TOOLS[inv.slot(player.sel)?.id];
  if (tool && BLOCKS[b.b].hardness > 0) {
    const gone = inv.wearOut(player.sel, tool.kind === "pick" ? 1 : 2);
    if (gone) broke(gone);
  }
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

// ---------------------------------------------------------------- the rocket and the zones
// Click the rocket (or stand on its pad and press F) for the card; pick a planet and the rocket lifts off with the
// camera watching, the screen fades to the destination turning in space (the title's globe, with that planet's
// picture), and you land standing on its pad once the ground there is ready.
const rocket = createRocket(scene);
rocket.setZone("home");
const boss = createBoss(scene, {
  hurt: (dmg, dx, dz) => takeHit(dmg, dx, dz, 9),
  posOf: (id) => (id === net?.id ? player.pos : net?.others.get(id)?.pos ?? null),
  boom: (k) => { shake = Math.max(shake, 0.6 * k); sfx.boom(k); },
});
const chests = createChests(scene);
let trip = null; // a flight: { to, phase: "lift" | "space" | "land", t }
let travelGlobe = null, shake = 0, onPadSaid = false;
const pictures = new Map(); // zone -> the globe's picture of it (promise)
const picture = (k) => { if (!pictures.has(k)) pictures.set(k, world.map(512, 256, k)); return pictures.get(k); };

function openRocket() {
  if (trip || !player.alive) return;
  setMining(false);
  placing = false;
  releaseMouse();
  openCard(zone, fly, () => { if (!touch && playing) lockMouse(); }, net ? ticketSales : null);
}

// Rocket tickets (zones.js): the room keeps each signed-in wallet's (["tickets", { zone: count }]) and uses one on each
// trip out. Buying one: pay the zone's `ticket` in $MINE (MinePayments, kind 1: chain.pay approves exactly that, then
// pays) and hand the room the transaction, which it checks on-chain. A payment the room hasn't confirmed yet (it was
// offline, or the page closed) is kept here and sent again after the next sign-in. Offline (no room) trips are free.
let tickets = {};
const claiming = new Set(); // payments being handed to the room right now
const tixKey = (w) => `mwc:tixpay:${w.toLowerCase()}`;
function unconfirmed(w) {
  try { const v = JSON.parse(localStorage.getItem(tixKey(w))); return Array.isArray(v) ? v : []; } catch { return []; }
}
function setUnconfirmed(w, list) {
  try { list.length ? localStorage.setItem(tixKey(w), JSON.stringify(list)) : localStorage.removeItem(tixKey(w)); } catch {}
}
/// Whether a trip to `to` needs a ticket you don't have.
const needsTicket = (to) => !ticketsAreFree() && !!net && to !== "home" && to !== zone && zoneOf(to).ticket > 0 && !(tickets[to] > 0);
/// Hands the room payment `hash` (from `wallet`) for a ticket to `to`: resolves with your tickets there now, or throws
/// why not. Tried again a couple of times while the room can't read the chain yet.
async function claimTicket(wallet, hash, to) {
  claiming.add(hash);
  try {
    for (let tries = 0; ; tries++) {
      const r = await net.ticket(hash, to);
      const forget = () => setUnconfirmed(wallet, unconfirmed(wallet).filter((p) => p.hash !== hash));
      if (r[0] === "ticketok") { forget(); return r[2]; }
      if (!r[4]) forget();
      if (!r[4] || tries >= 2) throw new Error(r[2]);
      await new Promise((ok) => setTimeout(ok, 3000));
    }
  } finally {
    claiming.delete(hash);
  }
}
async function buyTicket(to, step) {
  const Z = ZONES[to];
  if (!chain?.hasPayments) throw new Error("Tickets can't be bought on this chain yet.");
  if (!net?.online) throw new Error("The world server is offline right now, and it keeps the tickets. Try again soon.");
  if (!ledger.signedIn) throw new Error("Sign in to earn first (Mining Site panel, M): the world server keeps tickets for your wallet.");
  if (chain.account?.toLowerCase() !== ledger.wallet?.toLowerCase()) throw new Error("Log in with the wallet you signed in with.");
  const wallet = ledger.wallet;
  try {
    const { hash } = await chain.pay(1, BigInt(Z.ticket) * 10n ** 18n, {
      step,
      onHash: (h) => setUnconfirmed(wallet, [...unconfirmed(wallet), { hash: h, zone: to, at: Date.now() }]),
    });
    step("Paid. The world server is checking the payment…");
    const n = await claimTicket(wallet, hash, to);
    toast(`Ticket to ${Z.name} bought: you have ${n}.`, "gold");
    return n;
  } catch (e) {
    throw new Error(explain(e));
  }
}
/// After signing in: payments for tickets the room never confirmed go to it again.
function resendTickets(wallet) {
  if (ticketsAreFree()) return;
  const list = unconfirmed(wallet).filter((p) => Date.now() - p.at < 4 * 3600_000);
  setUnconfirmed(wallet, list);
  for (const p of list) {
    if (claiming.has(p.hash) || !ZONES[p.zone]) continue;
    claimTicket(wallet, p.hash, p.zone).then((n) => toast(`Your ticket to ${ZONES[p.zone].name} is ready: you have ${n}.`, "good")).catch(() => {});
  }
}
const ticketSales = {
  tickets: () => tickets,
  signedIn: () => ledger.signedIn && !!net?.online,
  balance: () => (chain?.account ? chain.mineBalance() : Promise.resolve(null)),
  buy: buyTicket,
  signIn: () => signIn().catch((e) => { throw new Error(explain(e)); }),
  moreMine: () => (chain?.trade ? "buy some in the Mining Site panel's trade box (M)" : "convert your earnings in the Mining Site panel (M)"),
};

/// Fly to planet `to`: the take-off starts here; frame() runs the rest (tripStep).
function fly(to) {
  if (trip || !player.alive || !ZONES[to] || to === zone) return;
  if (needsTicket(to)) return toast(`A trip to ${ZONES[to].name} needs a ticket: buy one at the rocket.`, "bad");
  closeCard();
  if (!touch && playing) lockMouse();
  setMining(false);
  placing = false;
  breaking = null;
  trip = { to, phase: "lift", t: 0 };
  travelGlobe ??= createGlobe();
  const Z = ZONES[to];
  picture(to).then(({ data, w, h }) => data && travelGlobe.setMap(data, w, h, Z.globe.cap, Z.globe.air));
  rocket.launch();
  sfx.rocket();
  me.root.visible = false;
  heldGroup.visible = false;
}
function tripStep(dt) {
  trip.t += dt;
  const fade = $("fade");
  if (trip.phase === "lift") {
    if (trip.t > 2.4 && !trip.dark) { trip.dark = true; fade.hidden = false; void fade.offsetWidth; fade.classList.add("on"); }
    if (trip.t > 2.95) {
      // In space: the new planet loads round its pad meanwhile.
      switchZone(trip.to);
      Object.assign(trip, { phase: "space", t: 0 });
      $("travelTo").textContent = `Flying to ${ZONES[trip.to].name}`;
      $("travelLine").textContent = ZONES[trip.to].line;
      $("travel").hidden = false;
      fade.classList.remove("on");
    }
  } else if (trip.phase === "space") {
    const ready = world.shown(player.pos.x, player.pos.z) && world.chunkCount() >= 25 && !(net?.online && net.flying);
    if (trip.t > 2.6 && (ready || trip.t > 15)) { fade.classList.add("on"); Object.assign(trip, { phase: "land", t: 0 }); }
  } else if (trip.phase === "land") {
    if (trip.t > 0.5 && !trip.landed) {
      trip.landed = true;
      $("travel").hidden = true;
      fade.classList.remove("on");
      me.root.visible = view > 0;
      heldGroup.visible = view === 0;
      const Z = ZONES[zone];
      toast(`Welcome to ${Z.name}${Z.label === "Home" ? "" : ` · ${Z.label}`}. ${Z.rule}.`, Z.pvp ? "bad" : "good");
      sysLine(`${Z.name}: ${Z.line} ${Z.warn ?? Z.rule}.`);
    }
    if (trip.t > 1.0) { fade.hidden = true; trip = null; }
  }
}
/// The camera through the take-off: off to one side of the pad, watching the rocket climb.
const _mid = new THREE.Vector3(), _bent = new THREE.Vector3();
function liftCamera() {
  const pad = rocket.pad;
  camera.position.set(pad.x + 13, pad.y + 2.2 + Math.min(6, trip.t * 1.5), pad.z + 2.5); // (east: between the lamp posts)
  followPlanet(camera.position, 0);
  camera.lookAt(bendPoint(rocket.middle(_mid), _bent));
}

/// Puts you on planet `k`, standing at `spot` (its pad, unless the room says otherwise): the world, the monsters, the
/// loot chests, the boss, the rocket, the sky and the HUD all switch over, and the room is told.
function switchZone(k, spot = landing(k)) {
  zone = k;
  world.setZone(k);
  synced.clear();
  mobs.clear();
  confirmed.clear();
  chests.clear(); // (the room sends the new planet's)
  for (const c of localChests.values()) if (c.zone === k && c.until > Date.now()) chests.add(c.id, c.x, c.y, c.z, c.until, null);
  boss.setZone(k);
  rocket.setZone(k);
  sky.setColours(ZONES[k].sky);
  if (officeSign) officeSign.visible = k === "home";
  if (k !== "home") for (const f of villagers.folk) { f.out = false; f.av.root.visible = false; }
  player.pos.set(spot.x, spot.y, spot.z);
  player.vel.set(0, 0, 0);
  if (spot.yaw !== undefined) player.yaw = spot.yaw;
  player.pitch = 0;
  player.fallFrom = null;
  breaking = null;
  lastPvp = null;
  onPadSaid = true; // (you land on it: no need to explain it)
  if (net && net.zone !== k) net.fly(k);
  drawZoneTag();
}
function drawZoneTag() {
  const Z = ZONES[zone];
  $("zoneTag").innerHTML = `<b>${Z.name}</b>${Z.label === "Home" ? "" : `<span>${Z.label}</span>`}<span class="rule ${Z.pvp ? "pvp" : ""}">${Z.pvp ? "PvP on (not on the pad)" : "No PvP"}</span>`;
  $("zoneTag").title = Z.rule;
}
drawZoneTag();
/// The first time you step on a rocket's pad, say what it's for.
function padHint() {
  const on = rocket.onPad(player.pos.x, player.pos.y, player.pos.z);
  if (on && !onPadSaid) toast(touch ? "🚀 The rocket: tap ⛏ on it to fly to the other zones." : "🚀 The rocket: press F (or click it) to fly to the other zones.", "good");
  onPadSaid = on;
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
/// A blow nearby (the boss's slam) shakes the view a moment.
function shakeCamera() {
  if (shake <= 0) return;
  camera.position.x += (Math.random() - 0.5) * shake * 0.5;
  camera.position.y += (Math.random() - 0.5) * shake * 0.5;
  camera.position.z += (Math.random() - 0.5) * shake * 0.5;
}
/// In first person the view bobs as you walk (Minecraft's GameRenderer.bobView, scaled by your smoothed speed along
/// the ground), unless that's turned off in the menu: a sway, a dip and a slight roll and nod each step. The same
/// motion moves the hand (bobber), as Minecraft's does. `a`: how far between ticks.
const _bobOff = new THREE.Vector3();
function placeCamera(a) {
  // Wider while sprinting (Minecraft's dynamic field of view).
  const fov = FEEL.fov * (move.fovOld + (move.fov - move.fovOld) * a);
  if (Math.abs(camera.fov - fov) > 1e-3) { camera.fov = fov; camera.updateProjectionMatrix(); }
  if (view === 0) {
    const bob = settings.bob ? move.bobOld + (move.bob - move.bobOld) * a : 0;
    const ph = -(move.walkOld + (move.walk - move.walkOld) * a) * Math.PI;
    const sx = Math.sin(ph) * bob * 0.5, sy = -Math.abs(Math.cos(ph) * bob);
    const roll = Math.sin(ph) * bob * 3 * DEG, nod = Math.abs(Math.cos(ph - 0.2) * bob) * 5 * DEG;
    // Minecraft moves the world by this in the view; the camera moves the opposite way.
    camera.rotation.set(player.pitch - nod, player.yaw, -roll);
    camera.position.copy(eyePos).add(_bobOff.set(-sx, -sy, 0).applyQuaternion(camera.quaternion));
    bobber.position.set(sx, sy, 0);
    bobber.rotation.set(nod, 0, roll, "ZXY");
    shakeCamera();
    return;
  }
  lookDir(back);
  if (view === 1) back.negate();
  const hit = world.raycast(eyePos, back, 4.5);
  const d = hit ? Math.max(0.4, hit.t - 0.3) : 4.5;
  camera.position.copy(eyePos).addScaledVector(back, d);
  shakeCamera();
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
  move.eating = !!(placing && food && player.alive && hunger.food < FOOD_MAX); // (eating slows you, as in Minecraft)
  if (!move.eating) {
    eatT = 0;
    $("eating").hidden = true;
    return;
  }
  eatT += dt;
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

// ---------------------------------------------------------------- moving
/// One tick of your movement (20 a second, as Minecraft's): the keys or the stick read as Minecraft reads them,
/// sprinting and sneaking by its rules, then the move itself (physics.js stepPlayer), then what follows from it:
/// falls, hunger, the view's bobbing and widening and the eye's height, and the hand.
function playerTick() {
  move.prev.copy(player.pos);
  move.eyeOld = move.eye; move.fovOld = move.fov; move.walkOld = move.walk; move.bobOld = move.bob;
  const live = !anyOverlay() && !trip && player.alive;
  let strafe = 0, forward = 0;
  if (live) {
    if (keys.has("KeyW") || keys.has("ArrowUp")) forward += 1;
    if (keys.has("KeyS") || keys.has("ArrowDown")) forward -= 1;
    if (keys.has("KeyA") || keys.has("ArrowLeft")) strafe -= 1;
    if (keys.has("KeyD") || keys.has("ArrowRight")) strafe += 1;
    if (stickState.id !== null) {
      // The stick's push stretched to a square, so full tilt on a diagonal pushes as hard as two keys do.
      const x = stickState.dx, z = -stickState.dy, m = Math.hypot(x, z), big = Math.max(Math.abs(x), Math.abs(z));
      if (big > 1e-3) { strafe += (x * m) / big; forward += (z * m) / big; }
    }
    strafe = Math.max(-1, Math.min(1, strafe));
    forward = Math.max(-1, Math.min(1, forward));
  }
  const sneak = live && (keys.has("ShiftLeft") || keys.has("ShiftRight"));
  if (sneak) { strafe *= MOVE.sneak; forward *= MOVE.sneak; }
  if (move.eating) { strafe *= MOVE.using; forward *= MOVE.using; }
  // Sprinting (Minecraft's LocalPlayer.aiStep): Ctrl, or the stick pushed all the way, with a push forward, or W
  // pressed twice quickly on the ground; never when too hungry, sneaking, eating or in water. It stops when you stop
  // going forward or run into a wall.
  const sprintKey = live && (keys.has("ControlLeft") || (touch && Math.hypot(stickState.dx, stickState.dy) > 0.95));
  const fed = hunger.food >= SPRINT_MIN_FOOD;
  const ahead = forward >= FEEL.sprintStart;
  const can = fed && !sneak && !move.eating && !player.water;
  if (move.tap > 0) move.tap--;
  if (live && (move.tapped || (ahead && !move.hadForward)) && player.onGround && can && !move.sprinting) {
    if (move.tap <= 0 && !sprintKey) move.tap = FEEL.doubleTap;
    else if (ahead) move.sprinting = true;
  }
  if (!move.sprinting && ahead && can && sprintKey) move.sprinting = true;
  if (move.sprinting && (forward <= 1e-5 || !can || move.wall)) move.sprinting = false;
  move.hadForward = ahead;
  move.tapped = false;
  const jump = live && (keys.has("Space") || move.jumpPressed || touchJump || move.autoJump);
  move.jumpPressed = move.autoJump = false;

  // (An NFT move boost speeds up walking and sprinting: boosts.js. The room's speed check allows far more.)
  const r = stepPlayer(world, player, { strafe, forward, yaw: player.yaw, jump, sprint: move.sprinting, sneak, speed: withMove(1, ledger.boost.move) }, HALF, TALL);
  // Round the planet: past 511 is 0 again (everything drawn follows, see drawOnPlanet).
  player.pos.x = wrap(player.pos.x);
  player.pos.z = wrap(player.pos.z);
  const walked = Math.hypot(r.dx, r.dz);
  if (walked < 1) hunger.tire(walked * (move.sprinting ? EXHAUSTION.sprint : EXHAUSTION.walk));
  if (r.jumped) hunger.tire(move.sprinting ? EXHAUSTION.sprintJump : EXHAUSTION.jump);
  // A wall met more head-on than a glance (the step taken more than wallAngle off your push) ends a sprint.
  move.wall = false;
  if (r.wall) {
    const fx = -Math.sin(player.yaw), fz = -Math.cos(player.yaw);
    const px = fx * forward - fz * strafe, pz = fz * forward + fx * strafe, pl = Math.hypot(px, pz);
    move.wall = pl > 1e-5 && (walked < 1e-5 || Math.acos(Math.max(-1, Math.min(1, (px * r.dx + pz * r.dz) / (pl * walked)))) > FEEL.wallAngle);
  }
  // Auto-jump on touch screens, where pressing jump while walking is awkward.
  if (touch && r.wall && player.onGround && Math.hypot(strafe, forward) > 0.3) move.autoJump = true;
  // Falls: from the highest point since you left the ground (falling into water is safe).
  if (!player.onGround && !player.water) player.fallFrom = Math.max(player.fallFrom ?? move.prev.y, player.pos.y);
  else {
    if (player.fallFrom !== null && player.onGround && !player.water) {
      const drop = player.fallFrom - player.pos.y;
      if (drop > FEEL.fall) hurt(Math.ceil(drop - FEEL.fall - 1e-6));
    }
    player.fallFrom = null;
  }
  // The view: bobbing with the walk (its strength your speed along the ground just now, on the ground only), wider
  // while sprinting; the eye lower while sneaking.
  move.sneaking = sneak;
  move.walk += walked * FEEL.bobStep;
  const along = Math.hypot(player.vel.x, player.vel.z) * TICK;
  move.bob += ((player.onGround && player.alive ? Math.min(FEEL.bobMax, along) : 0) - move.bob) * FEEL.bobEase;
  move.fov += ((move.sprinting ? FEEL.sprintFov : 1) - move.fov) * FEEL.fovEase;
  move.eye += ((sneak ? FEEL.sneakEye : EYE) - move.eye) * FEEL.eyeEase;
  handTick(live && mining);
}

// ---------------------------------------------------------------- the loop
const clock = new THREE.Clock();
let regenAt = 0;
const drawnPos = new THREE.Vector3(); // where you're drawn: between your last two ticks' positions
let whereShown = "";
function frame() {
  requestAnimationFrame(frame);
  const real = clock.getDelta(); // (the movement ticks keep real time; the rest steps at most 50 ms a frame)
  const dt = Math.min(real, 0.05);
  const now = performance.now();

  // Chunks around you (and ask the room for their edits).
  const fresh = world.update(player.pos.x, player.pos.z, playing ? 6 : 10);
  if (fresh.length && net?.online) net.chunks(fresh);

  if (playing) {
    if (trip) {
      tripStep(dt);
      // In space: the destination turning, coming closer, while its ground loads.
      if (trip && trip.phase !== "lift" && !trip.landed) {
        travelGlobe.render(renderer, dt, 0.7 + Math.min(1, trip.t / 4) * 0.5);
        return;
      }
    }
    const still = !!trip; // (no walking, falling or fighting while the rocket flies)
    const ready = !still && world.loaded(Math.floor(player.pos.x), Math.floor(player.pos.z));
    const typing = anyOverlay() || still;
    // Movement, in whole ticks (playerTick); drawn between the last two.
    if (ready) {
      move.acc = Math.min(move.acc + real, FEEL.maxCatchUp * TICK);
      while (move.acc >= TICK) { playerTick(); move.acc -= TICK; }
    } else {
      move.acc = 0;
      move.prev.copy(player.pos);
    }
    const a = move.acc / TICK;
    {
      const dx = wrapDelta(player.pos.x - move.prev.x), dy = player.pos.y - move.prev.y, dz = wrapDelta(player.pos.z - move.prev.z);
      if (dx * dx + dy * dy + dz * dz > 64) move.prev.copy(player.pos); // (a teleport or a respawn: straight there)
      const b = move.prev.equals(player.pos) ? 0 : 1 - a;
      drawnPos.set(wrap(player.pos.x - dx * b), player.pos.y - dy * b, wrap(player.pos.z - dz * b));
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

    eyePos.set(drawnPos.x, drawnPos.y + move.eyeOld + (move.eye - move.eyeOld) * a, drawnPos.z);
    if (trip?.phase === "lift") liftCamera();
    else placeCamera(a);
    shake = Math.max(0, shake - dt * 1.5);
    me.root.rotation.y = player.yaw + Math.PI;
    me.animate(Math.min(real, 0.25), { x: drawnPos.x, y: drawnPos.y, z: drawnPos.z, yaw: player.yaw, pitch: player.pitch,
      sneak: move.sneaking, swinging: mining && player.alive && !typing, ground: player.onGround || player.water });
    if (!typing) interact(dt, now);
    else { outline.visible = false; crack.visible = false; breaking = null; }
    drawHand(a);

    mobs.update(dt, player);
    rocket.update(dt);
    boss.update(dt, Date.now() + serverOffset, player);
    chests.update(Date.now() + serverOffset, now / 1000);
    if (!trip) padHint();
    if (talking && (now > talking.until || Math.hypot(wrapDelta(talking.v.pos.x - player.pos.x), wrapDelta(talking.v.pos.z - player.pos.z)) > 7)) endTalk();
    offlineMobs(now);
    net?.tick({ x: player.pos.x, y: player.pos.y, z: player.pos.z, yaw: player.yaw, pitch: player.pitch,
      flags: move.sneaking ? SNEAKING : 0, moving: Math.hypot(player.vel.x, player.vel.z) > 0.5 });
    voice?.tick(player.pos);
    updateDebris(dt);
    const where = `${Math.floor(player.pos.x)}, ${Math.floor(player.pos.y)}, ${Math.floor(player.pos.z)}${isNight(Date.now() + serverOffset) ? " · night" : ""}`;
    if (where !== whereShown) $("where").textContent = whereShown = where; // (only when it changes: a write costs a layout)
  } else {
    // The title screen: the whole planet, turning slowly in space (the world loads round the spawn meanwhile).
    globe.render(renderer, dt);
    return;
  }

  // Sky, light and fog.
  const top = world.topAt(Math.floor(camera.position.x), Math.floor(camera.position.z));
  const under = top >= 0 ? Math.max(0, Math.min(1, (top - camera.position.y - 2) / 10)) : 0;
  const s = sky.update(dev.time !== null ? dev.time * DAY_MS : Date.now() + serverOffset, camera, under);
  if (zone === "home") villagers.update(dt, Date.now() + serverOffset, dev.time !== null ? dev.time * DAY_MS : Date.now() + serverOffset);
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
  tickGlint(now / 1000);
  renderer.render(scene, camera);
  renderHand();
}

/// Bends everything drawn in the world round the planet as seen from the camera, just before the render: the chunks
/// (in the shader, at their copies nearest the camera), monsters, other miners, your own miner, the block outline,
/// the cracks, debris and the Mining Sites' sign.
const _flat = new THREE.Vector3();
function drawOnPlanet(dt) {
  followPlanet(camera.position, dt);
  world.draw(camera);
  mobs.draw();
  villagers.draw();
  net?.draw();
  rocket.draw();
  boss.draw();
  chests.draw();
  if (me.root.visible) placeOnPlanet(meHolder, drawnPos, 0);
  // The outline and cracks are boxes round a block's centre: stand them at the bent centre, turned with the ground.
  for (const o of [outline, crack]) if (o.visible) placeOnPlanet(o, o.userData.at, 0);
  for (const m of debris) placeOnPlanet(m, m.userData.p, 0);
  if (officeSign?.visible) placeOnPlanet(officeSign, officeSign.userData.at, 0);
}
const globe = createGlobe();
world.map(512, 256).then(({ data, w, h }) => data && globe.setMap(data, w, h));
drawHotbar();
frame();
if (local) {
  window.mwc = {
    player, world, inv, mobs, villagers, camera, globe, renderer, scene, get net() { return net; }, get chain() { return chain; }, ledger, dev, select,
    setMining, signIn, dressMe, nextView,
    // The rocket's zones, for testing: where you are, fly (with the take-off) or switch at once, the boss, the chests.
    get zone() { return zone; }, get trip() { return trip; }, fly, switchZone, openRocket, rocket, boss, chests, takeHit,
    // Knock-outs, for testing: hurt(99) knocks you out; the screen's two buttons; what dropped; offline chests.
    hurt, respawn, revive, get died() { return died; }, get reviveFree() { return reviveFree; }, localChests,
    loot: (id) => (id < 0 ? lootLocal(id) : net?.loot(id)),
    get lookingAt() { return lookingAt; },
    // Moving, for testing: the keys held, a movement tick (run them by hand to measure speeds), its state, your miner.
    keys, stickState, playerTick, move, hand, hunger, FEEL, settings, drawnPos, get me() { return me; }, get view() { return view; },
    // The first-person hand: its scene and camera, and what's in it.
    handScene, handCamera, heldGroup, get heldMesh() { return heldMesh; }, get eatT() { return eatT; }, setPlacing: (on) => { placing = on; placeAt = 0; },
  };
}
