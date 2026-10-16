// The town's villagers: blocky folk who live in the houses (town.js), work in the shops and stroll to the plaza, the
// garden and the pond along the roads, then go home at night. Where each one is follows the clock alone, so every
// player sees the same villager in the same place with nothing sent over the network. Click one to talk: they know
// the game.

import * as THREE from "https://esm.sh/three@0.160.0";
import { createAvatar } from "./avatar.js";
import { villagerSkin } from "./villager-skins.js";
import { TOWN, dayTime } from "./rules.js";
import { DOORS, SPOTS } from "./town.js";
import { place } from "./planet.js";

const SPEED = 1.3; // blocks a second
const PAUSE = 9; // seconds at each stop

/// Who lives here: a name, a trade, a home, where they work, a look (their skin: villager-skins.js) and what they say.
export const VILLAGERS = [
  { name: "Olwen", job: "Clerk", home: "Rose Cottage", work: "Mining Sites",
    look: { tone: "fair", hair: ["long", "brown"], eyes: "blue", top: "Suit Navy", shoes: "Boots Black" },
    lines: [
    "Welcome to Mining Sites! Press M to open your mining site and turn what you dig into $MINE.",
    "Sign in with your wallet first: then every natural block you break and every monster you beat is counted.",
    "A mining site costs a little ETH, once. You can earn without one, but you need it to convert to $MINE.",
  ] },
  { name: "Bram", job: "Baker", home: "Miller House", work: "Bakery",
    look: { tone: "tan", hair: ["short", "ginger"], top: "Tee White", bottoms: "Slacks Grey", shoes: "Sneakers White" },
    lines: [
    "Hungry? Apples fall from leaves, berries grow on bushes, and two mushrooms with a plank make a fine stew.",
    "Hold right click with food in hand to eat. A full belly heals you; an empty one hurts.",
  ] },
  { name: "Hilda", job: "Smith", home: "Cobble House", work: "Smithy",
    look: { tone: "brown", hair: ["bun", "black"], top: "Overalls Brown", shoes: "Work Boots", accessory: "Wristbands" },
    lines: [
    "Wood, then stone: a stone pickaxe mines iron, an iron one mines gold, diamonds and the purple $MINE crystals.",
    "A sword hits much harder than a fist. Iron or better, if you're heading underground.",
  ] },
  { name: "Corwin", job: "Trader", home: "East House", work: "Trading Post",
    look: { tone: "light", hair: ["curly", "black"], eyes: "green", top: "Jacket Corduroy", bottoms: "Cargo Khaki", headwear: "Straw Hat" },
    lines: [
    "I trade $MINE for ETH and IMD: press M and find the trade box.",
    "Every trade pays a 4% fee to the MineWorldCraft wallet. Sending $MINE to a friend costs nothing.",
  ] },
  { name: "Mabel", job: "Librarian", home: "Garden House", work: "Library",
    look: { tone: "fair", hair: ["long", "purple"], eyes: "grey", top: "Sweater Cream", bottoms: "Slacks Navy", shoes: "Boots Black", accessory: "Glasses" },
    lines: [
    "This planet is small: walk in a straight line and you'll come back to where you started.",
    "Rarer ores sit deeper. $MINE crystals and diamonds hide below level 24.",
  ] },
  { name: "Ezra", job: "Innkeeper", home: "Sunny House", work: "Tavern",
    look: { tone: "deep", hair: ["short", "black"], beard: true, top: "Flannel Red", bottoms: "Jeans Blue" },
    lines: [
    "Pull up a chair! Type /sethome somewhere you like, and /home brings you back.",
    "Want a chat? Press B for voice with the folk near you, or T to type.",
  ] },
  { name: "Tamsin", job: "Guard", home: "Fern House", work: "gates",
    look: { tone: "tan", hair: ["short", "brown"], eyes: "green", top: "Knight Armour Iron" },
    lines: [
    "The town is protected: nobody mines or builds within 64 blocks of the fountain. Type /wild to head out.",
    "Mudlings, crawlers and rattlers come out at night, and rock golems deep underground. Bring a sword.",
  ] },
  { name: "Juniper", job: "Gardener", home: "Brook House", work: "garden",
    look: { tone: "light", hair: ["long", "green"], top: "Overalls Green", headwear: "Straw Hat", shoes: "Bare Feet" },
    lines: [
    "The flower meadows are a picture. Berry bushes give one to three berries each.",
    "Flowers and grass tufts don't pay $MINE, but stone and ore do.",
  ] },
  { name: "Rook", job: "Miner", home: "Hill House", work: "gates",
    look: { tone: "brown", hair: ["short", "black"], top: "Miner's Vest Orange", bottoms: "Cargo Olive", shoes: "Work Boots", headwear: "Hard Hat Yellow" },
    lines: [
    "Stone pays a little, coal a bit more, iron and gold better, and a $MINE crystal best of all.",
    "Placed blocks pay nothing when you break them again. Only the planet's own stone counts.",
  ] },
  { name: "Wren", job: "DEGEN fan", home: "West House", work: "plaza",
    look: { degen: { background: 0, skin: 3, eyes: 0, mouth: 1, cheeks: 1, top: 6, bottoms: 8, shoes: 2, headwear: 2, accessory: 0 } },
    lines: [
    "See my look? It's an I'M DEGEN. All 3,333 are minted: get one from another player on OpenSea, then wear it from the Mining Site panel.",
    "Press V to see yourself from outside. Your DEGEN is your miner, from its eyes to its shoes!",
    "Wearing a DEGEN makes you a better miner too: faster blocks, more $MINE, a higher daily cap. Rarer and higher-level ones more.",
  ] },
  { name: "Odo", job: "Elder", home: "Town Hall", work: "Town Hall",
    look: { tone: "light", hair: ["bald", "white"], beard: true, eyes: "blue", top: "Sweater Navy", bottoms: "Slacks Grey", shoes: "Boots Black" },
    lines: [
    "We built this town at the top of the world. Everything past the gates is wild.",
    "Once you've signed in, pick a name in the menu (Esc) so folk know who you are.",
    "Deepvein pays double but its monsters never sleep. And in Red Mesa, other miners can take everything you carry.",
    "Get knocked out and everything you carry drops in a chest where you fell. Hurry back to it before someone else does!",
  ] },
  { name: "Hazel", job: "Fisher", home: "Lake House", work: "pond",
    look: { tone: "tan", hair: ["bun", "ginger"], top: "Jacket Bomber", bottoms: "Jeans Light", headwear: "Beanie Blue" },
    lines: [
    "The pond's calm today. Mind the deep water out in the wild: you sink slowly, but you do sink.",
    "Did you know the day here lasts twenty minutes? Nights are when the monsters come.",
  ] },
  { name: "Pip", job: "Kid", home: "Rose Cottage", work: "plaza",
    look: { tone: "fair", hair: ["curly", "blonde"], eyes: "blue", top: "Tee Yellow", bottoms: "Shorts Khaki", shoes: "Sneakers Blue", headwear: "Cap Red" },
    lines: [
    "Have you seen the giant trees? They're in the dark forest, far from town!",
    "I'm not allowed past the gates at night. Monsters!",
  ] },
  // The shopkeeper stays at the Smithy's door, day and night: clicking him opens the shop (shop.js).
  { name: "Garrick", job: "Armorer", stay: [14, -21, Math.PI], shop: true,
    look: { tone: "deep", hair: ["short", "grey"], beard: true, top: "Overalls Grey", shoes: "Work Boots", accessory: "Tool Belt" },
    lines: [
    "Tools, weapons and armor: have a look! Prices are in $MINE, and three quarters of what you pay is burned.",
  ] },
  { name: "Quill", job: "Mapmaker", home: "Barn", work: "orchard",
    look: { tone: "brown", hair: ["long", "white"], top: "Flannel Blue", bottoms: "Cargo Khaki", headwear: "Goggles", accessory: "Backpack Brown" },
    lines: [
    "The planet is 512 blocks around. Your position is in the top-left corner.",
    "From the clock tower you can see the horizon curve away. It really is a little planet.",
    "Seen the rocket on the launch pad, north-east of the plaza? It flies to Deepvein, Cinderfall and Red Mesa.",
  ] },
];

// ---------------------------------------------------------------- roads
// The road network as a graph: nodes on the roads (town-relative), edges along them. Villagers only walk on it.
const nodes = new Map(); // "x,z" -> [x, z]
const edges = new Map(); // "x,z" -> Set of "x,z"
const key = (x, z) => `${x},${z}`;
function link(a, b) {
  for (const [p, q] of [[a, b], [b, a]]) {
    nodes.set(key(...p), p);
    if (!edges.has(key(...p))) edges.set(key(...p), new Set());
    edges.get(key(...p)).add(key(...q));
  }
}
/// A straight road through `points`, each joined to the next.
function road(points) {
  const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  for (let i = 1; i < sorted.length; i++) link(sorted[i - 1], sorted[i]);
}
const feet = []; // door -> the point on its road
function footOf(door) {
  const dx = door.x - TOWN.x, dz = door.z - TOWN.z;
  // The road the door looks onto: the nearest road or lane line along the axis it faces.
  const lines = [0, 22, -22];
  const toZ = lines.reduce((b, l) => (Math.abs(dz - l) < Math.abs(dz - b) ? l : b), 99);
  const toX = lines.reduce((b, l) => (Math.abs(dx - l) < Math.abs(dx - b) ? l : b), 99);
  return Math.abs(dz - toZ) <= Math.abs(dx - toX) ? [dx, toZ] : [toX, dz];
}
const doorFeet = {};
for (const [name, d] of Object.entries(DOORS)) {
  if (name === "Mining Sites") continue;
  doorFeet[name] = footOf(d);
  feet.push(doorFeet[name]);
}
const spots = Object.fromEntries(Object.entries(SPOTS).map(([k, list]) => [k, list.map(([x, z]) => [x - TOWN.x, z - TOWN.z])]));
const RING = [[7, 0], [0, 7], [-7, 0], [0, -5]];
/// Where a stop joins the roads: on the plaza, the nearest point of the walk round the fountain.
function spotFoot(p) {
  if (Math.hypot(p[0], p[1]) < 12) return RING.reduce((b, r) => (Math.hypot(r[0] - p[0], r[1] - p[1]) < Math.hypot(b[0] - p[0], b[1] - p[1]) ? r : b));
  return footOf({ x: p[0] + TOWN.x, z: p[1] + TOWN.z });
}
for (const list of Object.values(spots)) for (const p of list) if (Math.hypot(p[0], p[1]) >= 12) feet.push(spotFoot(p));
const on = (pts, f) => pts.concat(feet.filter(f));
road(on([[-50, 0], [-40, 0], [-22, 0], [-7, 0]], ([x, z]) => z === 0 && x <= -7));
road(on([[7, 0], [22, 0], [40, 0], [50, 0]], ([x, z]) => z === 0 && x >= 7));
road(on([[0, 7], [0, 22], [0, 40], [0, 50]], ([x, z]) => x === 0 && z >= 7));
road(on([[0, -50], [0, -40], [0, -22], [0, -16]], ([x, z]) => x === 0 && z <= -16));
for (const l of [22, -22]) {
  road(on([[-46, l], [-22, l], [0, l], [22, l], [46, l]], ([x, z]) => z === l && Math.abs(x) <= 46));
  road(on([[l, -46], [l, -22], [l, 0], [l, 22], [l, 46]], ([x, z]) => x === l && Math.abs(z) <= 46));
}
// Round the fountain, and the alley past Mining Sites to the north road.
const ring = [...RING, RING[0]];
for (let i = 1; i < ring.length; i++) link(ring[i - 1], ring[i]);
link([7, 0], [7, -16]);
link([7, -16], [0, -16]);

function path(from, to) {
  // Dijkstra over the little graph.
  const dist = new Map([[key(...from), 0]]), prev = new Map(), todo = new Set([key(...from)]);
  while (todo.size) {
    let cur = null;
    for (const k of todo) if (cur === null || dist.get(k) < dist.get(cur)) cur = k;
    todo.delete(cur);
    if (cur === key(...to)) break;
    const [cx, cz] = nodes.get(cur);
    for (const n of edges.get(cur) ?? []) {
      const [nx, nz] = nodes.get(n);
      const d = dist.get(cur) + Math.hypot(nx - cx, nz - cz);
      if (d < (dist.get(n) ?? Infinity)) { dist.set(n, d); prev.set(n, cur); todo.add(n); }
    }
  }
  const out = [];
  for (let k = key(...to); k; k = prev.get(k)) out.unshift(nodes.get(k));
  return out[0] && key(...out[0]) === key(...from) ? out : [from, to];
}

/// A villager's day as a loop of stops: home, work, a wander, work again, and back home; each leg along the roads.
function dayLoop(v, i) {
  const place = (name, n) => {
    if (DOORS[name]) return { foot: name === "Mining Sites" ? [0, -5] : doorFeet[name], door: [DOORS[name].x - TOWN.x, DOORS[name].z - TOWN.z] };
    const list = spots[name];
    const p = list[(i + n) % list.length];
    return { foot: spotFoot(p), door: p };
  };
  const extra = ["plaza", "garden", "pond", "orchard"][(i * 3) % 4];
  const stops = [place(v.home, 0), place(v.work, 0), place(extra, 1), place(v.work, 1), place("plaza", 2)];
  const legs = []; // [{ pts: [[x, z]...], pause }]
  for (let s = 0; s < stops.length; s++) {
    const a = stops[s], b = stops[(s + 1) % stops.length];
    legs.push({ pts: [a.door, ...path(a.foot, b.foot), b.door], pause: PAUSE + (i % 4) * 2 });
  }
  // As timed segments: walking along each leg, then standing still at its end.
  const segs = [];
  let t = 0;
  for (const leg of legs) {
    for (let k = 1; k < leg.pts.length; k++) {
      const [ax, az] = leg.pts[k - 1], [bx, bz] = leg.pts[k];
      const len = Math.hypot(bx - ax, bz - az);
      if (len < 0.01) continue;
      segs.push({ t0: t, t1: t + len / SPEED, ax, az, bx, bz });
      t += len / SPEED;
    }
    const [ex, ez] = leg.pts[leg.pts.length - 1];
    segs.push({ t0: t, t1: t + leg.pause, ax: ex, az: ez, bx: ex, bz: ez });
    t += leg.pause;
  }
  return { segs, total: t };
}

function tag(text) {
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 48;
  const g = c.getContext("2d");
  g.fillStyle = "rgba(20, 28, 32, 0.6)";
  g.fillRect(4, 6, 248, 36);
  g.fillStyle = "#f5e27a";
  g.font = "800 24px Nunito, system-ui, sans-serif";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(text, 128, 25, 236);
  const t = new THREE.CanvasTexture(c);
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, transparent: true, depthWrite: false }));
  s.scale.set(1.7, 0.32, 1);
  s.position.y = 2.2;
  return s;
}

export function createVillagers(scene) {
  const folk = VILLAGERS.map((v, i) => {
    const av = createAvatar(null, undefined, villagerSkin(v.look));
    av.root.add(tag(`${v.name} · ${v.job}`));
    av.root.visible = false;
    scene.add(av.root);
    // `pos` is where they are on the flat map; draw() stands them on the curved planet.
    return { ...v, i, av, loop: v.stay ? null : dayLoop(v, i), pos: new THREE.Vector3(), yaw: 0, said: 0, out: false };
  });

  /// Places everyone: their walk follows the clock `ms`; they're out from sunrise until a little before dusk (`dayMs`,
  /// the time of day, which can differ from the clock when testing).
  function update(dt, ms, dayMs = ms) {
    const day = dayTime(dayMs);
    const out = day < 0.5;
    for (const f of folk) {
      if (f.stay) {
        // Always at his post.
        f.out = true;
        f.av.root.visible = true;
        f.pos.set(TOWN.x + f.stay[0] + 0.5, TOWN.y + 1, TOWN.z + f.stay[1] + 0.5);
        f.yaw = f.stay[2];
        f.av.animate(dt, { x: f.pos.x, y: f.pos.y, z: f.pos.z, yaw: f.yaw + Math.PI, pitch: 0, ground: true });
        continue;
      }
      f.out = out;
      f.av.root.visible = out;
      if (!out) continue;
      // Each villager starts the loop at a different time, so they don't all leave home together.
      const t = ((ms / 1000 + f.i * 37) % f.loop.total + f.loop.total) % f.loop.total;
      const s = f.loop.segs.find((g) => t >= g.t0 && t < g.t1) ?? f.loop.segs[0];
      const k = s.t1 > s.t0 ? (t - s.t0) / (s.t1 - s.t0) : 0;
      const x = s.ax + (s.bx - s.ax) * k, z = s.az + (s.bz - s.az) * k;
      const moving = s.ax !== s.bx || s.az !== s.bz;
      if (moving) f.yaw = Math.atan2(s.bx - s.ax, s.bz - s.az);
      f.pos.set(TOWN.x + x + 0.5, TOWN.y + 1, TOWN.z + z + 0.5);
      // (The avatar takes a player's yaw, which faces -z at 0; a villager's faces +z.)
      f.av.animate(dt, { x: f.pos.x, y: f.pos.y, z: f.pos.z, yaw: f.yaw + Math.PI, pitch: 0, ground: true });
    }
  }
  /// Stands everyone who's out on the curved ground, as seen from the camera (just before the render).
  function draw() {
    for (const f of folk) if (f.out) place(f.av.root, f.pos, f.yaw);
  }

  /// The villager a ray hits first within `max` blocks: { v, t }.
  function raycast(o, d, max) {
    let best = null;
    for (const f of folk) {
      if (!f.out) continue;
      const min = [f.pos.x - 0.4, f.pos.y, f.pos.z - 0.4], mx = [f.pos.x + 0.4, f.pos.y + 1.9, f.pos.z + 0.4];
      const O = [o.x, o.y, o.z], D = [d.x, d.y, d.z];
      let t0 = 0, t1 = max, ok = true;
      for (let a = 0; a < 3 && ok; a++) {
        if (Math.abs(D[a]) < 1e-9) { if (O[a] < min[a] || O[a] > mx[a]) ok = false; continue; }
        let ta = (min[a] - O[a]) / D[a], tb = (mx[a] - O[a]) / D[a];
        if (ta > tb) [ta, tb] = [tb, ta];
        t0 = Math.max(t0, ta);
        t1 = Math.min(t1, tb);
        if (t0 > t1) ok = false;
      }
      if (ok && (!best || t0 < best.t)) best = { v: f, t: t0 };
    }
    return best;
  }

  /// The next thing villager `f` says (they go through their lines in turn).
  function talk(f) {
    const line = f.lines[f.said % f.lines.length];
    f.said++;
    return line;
  }

  return { update, draw, raycast, talk, folk };
}
