// I'M DEGEN skins: checks the art and the rules in web/degen-skin.js and web/degen-skin-art.js, and prints the numbers
// that matter for putting them on-chain (phase 2):
//
//   - every option paints (each layer compiles, each colour it names exists), with every top, headwear and accessory;
//   - every one of the 3,333 DEGENs looks different from every other (their skins and backgrounds compared pixel for
//     pixel), under several seeds;
//   - the rarity split, expected from the weights and counted under those seeds;
//   - roughly how big the art data is as bytes (tools/gen-degen-art.mjs gives the contract's exact layout), and how
//     big the card SVG is;
//   - the trait tables with their weights.
//
//   ~/.local/node/bin/node tools/degen-skin-check.mjs [seed,seed,...]
//
// keccak-256 comes from viem in multiplayer/node_modules (the world server's own copy); run `npm install` there first.

import { keccak256, encodeAbiParameters } from "../multiplayer/node_modules/viem/_esm/index.js";
import * as D from "../web/degen-skin.js";
import * as ART from "../web/degen-skin-art.js";

const hash = { keccak256, encodeAbiParameters };
const seeds = (process.argv[2] ?? "20261015,1,2,3,4").split(",").map(BigInt);
let failed = false;
const fail = (msg) => { console.error(`FAIL ${msg}`); failed = true; };

// ---------------------------------------------------------------- every option paints
const base = { background: 0, skin: 0, eyes: 1, mouth: 0, cheeks: 0, top: 0, bottoms: 0, shoes: 0, headwear: 0, accessory: 0 };
const lists = { background: ART.BACKGROUNDS, skin: ART.SKINS, eyes: ART.EYES, mouth: ART.MOUTHS, cheeks: ART.CHEEKS, top: ART.TOPS,
  bottoms: ART.BOTTOMS, shoes: ART.SHOES, headwear: ART.HEADWEAR, accessory: ART.ACCESSORIES };
for (const [k, list] of Object.entries(lists)) {
  list.forEach((o, i) => {
    try { D.cardSvg({ ...base, [k]: i }); } catch (e) { fail(`${k} ${o.name}: ${e.message}`); }
  });
}
// Every top with every headwear and accessory (the hood takes the top's colours; shades redraw the eyes).
for (let top = 0; top < ART.TOPS.length; top++) {
  for (let headwear = 0; headwear < ART.HEADWEAR.length; headwear++) {
    for (let accessory = 0; accessory < ART.ACCESSORIES.length; accessory++) {
      try { D.skinColours({ ...base, top, headwear, accessory }); } catch (e) { fail(`top ${top} headwear ${headwear} accessory ${accessory}: ${e.message}`); }
    }
  }
}
for (const t of [D.ROOKIE, { sealed: true }]) D.cardSvg(t);

// ---------------------------------------------------------------- uniqueness and rarity
const tot = (l) => l.reduce((t, o) => t + o.w, 0);
const atLeast = (l, k) => l.filter((o) => (o.tier ?? 0) >= k).reduce((t, o) => t + o.w, 0) / tot(l);
const topsAtLeast = (k) => ART.TOPS.filter((o) => (o.tier ?? 0) >= k).length / ART.TOPS.length;
const noneAtLeast = (k) => (1 - atLeast(ART.SKINS, k)) * (1 - atLeast(ART.HEADWEAR, k)) * (1 - atLeast(ART.ACCESSORIES, k)) * (1 - topsAtLeast(k));
const L = 1 - noneAtLeast(2), RL = 1 - noneAtLeast(1);
const pct = (x) => `${(100 * x).toFixed(1)}%`;
console.log(`Rarity expected from the weights: Common ${pct(1 - RL)}, Rare ${pct(RL - L)}, Legendary ${pct(L)}`);
let cards = [], fronts = [];
for (const seed of seeds) {
  const n = [0, 0, 0], looks = new Set();
  for (let id = 1; id <= D.SUPPLY; id++) {
    const t = D.traitsOf(seed, id, hash);
    n[D.rarityOf(t)]++;
    const px = D.skinColours(t);
    looks.add(`${t.background}:${Buffer.from(px.buffer).toString("base64")}`);
    if (seed === seeds[0]) { cards.push(D.cardSvg(t)); fronts.push(D.frontSvg(t)); }
  }
  if (looks.size !== D.SUPPLY) fail(`seed ${seed}: only ${looks.size} different looks`);
  console.log(`seed ${seed}: ${n.map((c, r) => `${D.RARITIES[r]} ${c} (${pct(c / D.SUPPLY)})`).join(", ")}; ${looks.size} different looks`);
}

// ---------------------------------------------------------------- sizes
// The art as a contract would hold it: each rectangle 4 bytes (x and y 6 bits each, width-1 5 bits, height-1 4 bits,
// colour code 5 bits), each eye mask 18 cells of 2 bits, each palette colour 3 bytes, each option 4 bytes (style,
// weight, tier) and its name (a length byte and the text).
const layers = [ART.FROG, ART.SEALED.ops, ...Object.values(ART.TOP_STYLES).map((s) => s.ops), ...Object.values(ART.BOTTOM_STYLES),
  ...Object.values(ART.SHOE_STYLES), ...Object.values(ART.HEAD_STYLES), ...Object.values(ART.ACCESSORY_STYLES),
  ...ART.MOUTHS.map((m) => `head F 0 4 :${m.mask}`), ...ART.CHEEKS.filter((c) => c.mask).map((c) => `head F 0 4 :${c.mask}`)];
const rects = layers.reduce((t, l) => t + D.compile(l).length, 0);
for (const l of layers) for (const [x, y, w, h] of D.compile(l)) if (x > 63 || y > 63 || w > 32 || h > 16) fail(`a rectangle too big to pack: ${[x, y, w, h]}`);
const options = Object.values(lists).flat();
const colours = options.reduce((t, o) => t + Object.keys(o.colors ?? {}).length + (o.color ? 1 : 0) + ["S", "s", "l", "d", "B"].filter((k) => o[k]).length, 0)
  + Object.keys(ART.FIXED).length;
const names = options.reduce((t, o) => t + 1 + o.name.length, 0);
const art = { rects: rects * 4, eyes: Math.ceil((ART.EYES.length * 18 * 2) / 8), colours: colours * 3, options: options.length * 4, names };
const artTotal = Object.values(art).reduce((a, b) => a + b, 0);
console.log(`Art data as bytes, estimated: ${artTotal} (${rects} rectangles ${art.rects}, eyes ${art.eyes}, ${colours} colours `
  + `${art.colours}, ${options.length} options ${art.options}, names ${art.names}); tools/gen-degen-art.mjs prints the contract's exact layout`);
const stat = (list) => {
  const b = list.map((s) => Buffer.byteLength(s)), e = list.map((s) => (s.match(/<(path|rect|ellipse)/g) ?? []).length);
  const avg = (x) => Math.round(x.reduce((p, c) => p + c, 0) / x.length);
  return `${avg(b)} bytes on average (${Math.min(...b)} to ${Math.max(...b)}), ${avg(e)} elements (${Math.min(...e)} to ${Math.max(...e)})`;
};
console.log(`Card SVG over the ${cards.length} under seed ${seeds[0]}: ${stat(cards)}`);
console.log(`Front SVG: ${stat(fronts)}`);

// ---------------------------------------------------------------- the tables
console.log("\nTraits (weight, and its share; tops and the face are spread evenly by the shuffle):");
for (const [k, list] of Object.entries(lists)) {
  const t = list[0].w === undefined ? 0 : tot(list);
  const row = list.map((o) => `${o.name}${o.tier ? ` [${D.RARITIES[o.tier]}]` : ""}${t ? ` ${o.w} (${pct(o.w / t)})` : ""}`);
  console.log(`  ${k} (${list.length}): ${row.join("; ")}`);
}
if (failed) process.exit(1);
