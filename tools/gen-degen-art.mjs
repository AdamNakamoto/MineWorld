// I'M DEGEN: writes the on-chain art (contracts/src/CrafterArt.sol) and its test vectors
// (contracts/test/CrafterVectors.sol) from the JavaScript that defines every DEGEN:
//
//   web/degen-skin-art.js   the layers (rectangles and small masks), the palettes and the trait options
//   web/degen-skin.js       traitsOf (the shuffle and the weighted picks), rarityOf, attributes, layersOf (what is
//                           painted, in which order), the skin's layout, and cardOf (the NFT's picture)
//
// The JS is the specification: the contract must paint every DEGEN's 64 x 64 skin pixel for pixel like skinColours()
// and write its card byte for byte like cardSvg(). Before writing anything, this checks its own model of the contract
// (the data as the contract holds it, painted and written the way the contract does) against the JS for every token
// under the vector seeds and for every option of every trait. Run after any change to either file (or to this one):
//
//   ~/.local/node/bin/node tools/gen-degen-art.mjs           # write both files
//   ~/.local/node/bin/node tools/gen-degen-art.mjs --check   # exit 1 if either is stale (writes nothing)
//
// No npm: keccak-256 is built in below. `forge test` then checks the contract against the vectors, and fails if the
// JS (or this file) changed since the vectors were made.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as ART from "../web/degen-skin-art.js";
import * as D from "../web/degen-skin.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCES = { ART_JS: "web/degen-skin-art.js", RULES_JS: "web/degen-skin.js", GENERATOR: "tools/gen-degen-art.mjs" };
const OUT_ART = "contracts/src/CrafterArt.sol";
const OUT_VECTORS = "contracts/test/CrafterVectors.sol";

function fail(msg) {
  console.error(`gen-degen-art: ${msg}`);
  process.exit(1);
}
const assert = (ok, msg) => ok || fail(msg);

// ---------------------------------------------------------------- keccak-256 (Ethereum's, not NIST SHA3)

const RC = [
  [0x00000001, 0x00000000], [0x00008082, 0x00000000], [0x0000808a, 0x80000000], [0x80008000, 0x80000000],
  [0x0000808b, 0x00000000], [0x80000001, 0x00000000], [0x80008081, 0x80000000], [0x00008009, 0x80000000],
  [0x0000008a, 0x00000000], [0x00000088, 0x00000000], [0x80008009, 0x00000000], [0x8000000a, 0x00000000],
  [0x8000808b, 0x00000000], [0x0000008b, 0x80000000], [0x00008089, 0x80000000], [0x00008003, 0x80000000],
  [0x00008002, 0x80000000], [0x00000080, 0x80000000], [0x0000800a, 0x00000000], [0x8000000a, 0x80000000],
  [0x80008081, 0x80000000], [0x00008080, 0x80000000], [0x80000001, 0x00000000], [0x80008008, 0x80000000],
];
const ROT = [0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14]; // x + 5y

function keccakF(s) { // 25 lanes of (lo, hi) 32-bit halves
  const C = new Uint32Array(10), B = new Uint32Array(50);
  for (let round = 0; round < 24; round++) {
    for (let x = 0; x < 5; x++) {
      C[2 * x] = s[2 * x] ^ s[2 * x + 10] ^ s[2 * x + 20] ^ s[2 * x + 30] ^ s[2 * x + 40];
      C[2 * x + 1] = s[2 * x + 1] ^ s[2 * x + 11] ^ s[2 * x + 21] ^ s[2 * x + 31] ^ s[2 * x + 41];
    }
    for (let x = 0; x < 5; x++) {
      const a = (x + 4) % 5, b = (x + 1) % 5;
      const lo = C[2 * a] ^ ((C[2 * b] << 1) | (C[2 * b + 1] >>> 31));
      const hi = C[2 * a + 1] ^ ((C[2 * b + 1] << 1) | (C[2 * b] >>> 31));
      for (let y = 0; y < 25; y += 5) {
        s[2 * (x + y)] ^= lo;
        s[2 * (x + y) + 1] ^= hi;
      }
    }
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        const i = x + 5 * y, r = ROT[i], lo = s[2 * i], hi = s[2 * i + 1];
        let nlo = lo, nhi = hi;
        if (r > 0 && r < 32) {
          nlo = (lo << r) | (hi >>> (32 - r));
          nhi = (hi << r) | (lo >>> (32 - r));
        } else if (r === 32) {
          nlo = hi;
          nhi = lo;
        } else if (r > 32) {
          const q = r - 32;
          nlo = (hi << q) | (lo >>> (32 - q));
          nhi = (lo << q) | (hi >>> (32 - q));
        }
        const j = y + 5 * ((2 * x + 3 * y) % 5);
        B[2 * j] = nlo;
        B[2 * j + 1] = nhi;
      }
    }
    for (let y = 0; y < 25; y += 5) {
      for (let x = 0; x < 5; x++) {
        const i = x + y, i1 = ((x + 1) % 5) + y, i2 = ((x + 2) % 5) + y;
        s[2 * i] = B[2 * i] ^ (~B[2 * i1] & B[2 * i2]);
        s[2 * i + 1] = B[2 * i + 1] ^ (~B[2 * i1 + 1] & B[2 * i2 + 1]);
      }
    }
    s[0] ^= RC[round][0];
    s[1] ^= RC[round][1];
  }
}

function keccakBytes(data) {
  const rate = 136, s = new Uint32Array(50);
  const padded = new Uint8Array(Math.floor(data.length / rate) * rate + rate);
  padded.set(data);
  padded[data.length] ^= 0x01;
  padded[padded.length - 1] ^= 0x80;
  for (let off = 0; off < padded.length; off += rate) {
    for (let k = 0; k < rate; k++) s[k >> 2] ^= padded[off + k] << (8 * (k & 3));
    keccakF(s);
  }
  const out = new Uint8Array(32);
  for (let k = 0; k < 32; k++) out[k] = (s[k >> 2] >>> (8 * (k & 3))) & 255;
  return out;
}

const toHex = (bytes) => "0x" + Buffer.from(bytes).toString("hex");
const fromHex = (h) => Uint8Array.from(Buffer.from(h.slice(2), "hex"));
/// viem's keccak256, for what degen-skin.js passes it: hex strings (or bytes).
const keccak256 = (v) => toHex(keccakBytes(typeof v === "string" ? fromHex(v) : v));
/// keccak256 of a text's UTF-8 bytes (what Solidity's keccak256(bytes(text)) gives).
const keccakText = (text) => toHex(keccakBytes(Buffer.from(text, "utf8")));
/// viem's encodeAbiParameters, for the uint256s degen-skin.js encodes.
function encodeAbiParameters(types, values) {
  assert(types.every((t) => t.type === "uint256") && types.length === values.length, "encodeAbiParameters: uint256 only");
  return "0x" + values.map((v) => {
    const b = BigInt(v);
    assert(b >= 0n && b < 1n << 256n, "uint256 out of range");
    return b.toString(16).padStart(64, "0");
  }).join("");
}
const hash = { keccak256, encodeAbiParameters };

assert(keccakText("") === "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470", "keccak self-test");
assert(keccakText("abc") === "0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45", "keccak self-test");
assert(keccak256("0x616263") === keccakText("abc"), "keccak self-test");

// ---------------------------------------------------------------- the spec, read and checked

const { FIXED, BACKGROUNDS, SKINS, FROG, EYES, MOUTHS, CHEEKS, TOP_STYLES, TOPS, BOTTOM_STYLES, BOTTOMS, SHOE_STYLES, SHOES,
  HEAD_STYLES, HEADWEAR, ACCESSORY_STYLES, ACCESSORIES, SEALED } = ART;
const { SUPPLY, COMBOS, RARITIES, HOOD, HOOD_ONE_IN } = D;
const COLOUR = /^#[0-9a-f]{6}$/;
const rgb = (c, where) => {
  assert(typeof c === "string" && COLOUR.test(c), `${where}: colour ${JSON.stringify(c)} isn't a lowercase #rrggbb`);
  return parseInt(c.slice(1), 16);
};

// The traits, in traitsOf's order (the Solidity struct uses the same names and order).
const FIELDS = ["background", "skin", "eyes", "mouth", "cheeks", "top", "bottoms", "shoes", "headwear", "accessory"];
const LIST = { background: BACKGROUNDS, skin: SKINS, eyes: EYES, mouth: MOUTHS, cheeks: CHEEKS, top: TOPS, bottoms: BOTTOMS, shoes: SHOES, headwear: HEADWEAR, accessory: ACCESSORIES };
const COUNT = Object.fromEntries(FIELDS.map((f) => [f, LIST[f].length]));
assert(JSON.stringify(Object.keys(D.traitsOf(1n, 1, hash))) === JSON.stringify(FIELDS), `traitsOf must return ${FIELDS.join(", ")}`);
assert(SUPPLY > 0 && SUPPLY <= 4096 && COMBOS >= SUPPLY, "the shuffle is a 12-bit Feistel network: SUPPLY must be 1..4096, and COMBOS >= SUPPLY");
assert(COMBOS === COUNT.eyes * COUNT.mouth * COUNT.cheeks * COUNT.top, "COMBOS must be eyes x mouths x cheeks x tops");
for (const f of FIELDS) assert(COUNT[f] > 0 && COUNT[f] <= 64, `${f}: 1..64 options (tiers and flags are 64-bit fields)`);
const WEIGHTED = ["background", "skin", "bottoms", "shoes", "headwear", "accessory"];
for (const f of WEIGHTED) {
  const l = LIST[f];
  assert(l.length <= 32 && l.every((o) => Number.isInteger(o.w) && o.w >= 0 && o.w < 256) && l.reduce((t, o) => t + o.w, 0) > 0, `${f}: weights must be whole numbers below 256 (at most 32 options)`);
}
assert(HEADWEAR[0].style === null && ACCESSORIES[0].style === null, "headwear 0 and accessory 0 are None");
assert(HEADWEAR.every((h, i) => (h.style === null) === (i === 0)) && ACCESSORIES.every((a, i) => (a.style === null) === (i === 0)), "only option 0 of headwear and accessories is None");
assert(HEADWEAR.every((h, i) => (h.colors === null) === (i === HOOD)) && HEADWEAR[HOOD].w === 0, "the hood alone takes the top's colours, and is never picked by weight");
assert(Number.isInteger(HOOD_ONE_IN) && HOOD_ONE_IN > 0, "HOOD_ONE_IN");
for (const f of ["skin", "top", "headwear", "accessory"]) {
  assert(LIST[f].every((o) => [undefined, 1, 2].includes(o.tier)), `${f}: tiers are 1 (Rare) or 2 (Legendary)`);
}
for (const f of ["background", "eyes", "mouth", "cheeks", "bottoms", "shoes"]) assert(LIST[f].every((o) => o.tier === undefined), `${f}: no tiers (rarityOf reads the skin, top, headwear and accessory)`);
assert(RARITIES.length === 3, "three rarities");
const INKS = [...new Set(ACCESSORIES.filter((a) => a.eyes).map((a) => a.eyes))];
assert(INKS.length <= 1, "every accessory that keeps the eyes' ink uses the same palette colour for it");
const INK = INKS[0] ?? "1";

// ---------------------------------------------------------------- the data blob

// Colour codes: the option's palette (1-9), the skin's (S s l d B), the fixed ones (K W R Y w), and "." (clear).
const SKIN_KEYS = ["S", "s", "l", "d", "B"], FIXED_KEYS = ["K", "W", "R", "Y", "w"];
const CODES = ["1", "2", "3", "4", "5", "6", "7", "8", "9", ...SKIN_KEYS, ...FIXED_KEYS, "."];
assert(JSON.stringify(Object.keys(FIXED).sort()) === JSON.stringify([...FIXED_KEYS].sort()), `FIXED must be ${FIXED_KEYS.join(" ")}`);

const layers = []; // { label, rects }
function layer(label, src) {
  const rects = D.compile(src);
  for (const [x, y, w, h, c] of rects) {
    assert(x >= 0 && x < 64 && y >= 0 && y < 64 && w >= 1 && w <= 64 && h >= 1 && h <= 16 && x + w <= 64 && y + h <= 64, `${label}: a rectangle that doesn't pack (${[x, y, w, h]})`);
    assert(CODES.includes(c), `${label}: no colour code "${c}"`);
  }
  return layers.push({ label, rects }) - 1;
}
/// The biggest palette colour a layer uses (0: none).
const digitsOf = (l) => Math.max(0, ...layers[l].rects.map(([, , , , c]) => CODES.indexOf(c) + 1).filter((d) => d <= 9));
const L = {};
L.frog = layer("FROG", FROG);
L.sealed = layer("SEALED", SEALED.ops);
L.eyes = layers.length;
EYES.forEach((e) => layer(`eyes ${e.name}`, D.eyeOps(e.mask)));
L.ink = layers.length;
EYES.forEach((e) => layer(`eyes ${e.name}, ink`, D.eyeOps(e.mask, INK)));
L.mouths = layers.length;
MOUTHS.forEach((m) => layer(`mouth ${m.name}`, D.faceOps(m.mask)));
L.cheeks = layers.length;
CHEEKS.forEach((c) => layer(`cheeks ${c.name}`, D.faceOps(c.mask)));
const styleLayers = (styles, label, ops = (s) => s) => Object.fromEntries(Object.entries(styles).filter(([k]) => k !== "rookie").map(([k, s]) => [k, layer(`${label} ${k}`, ops(s))]));
L.top = styleLayers(TOP_STYLES, "top", (s) => s.ops);
L.bottoms = styleLayers(BOTTOM_STYLES, "bottoms");
L.shoes = styleLayers(SHOE_STYLES, "shoes");
L.head = styleLayers(HEAD_STYLES, "headwear");
L.acc = styleLayers(ACCESSORY_STYLES, "accessory");
for (const l of [L.frog, L.sealed, ...[L.eyes, L.mouths, L.cheeks].flatMap((s) => [s, s + 1])]) assert(digitsOf(l) === 0, `${layers[l].label}: no palette colours (it has no palette)`);
// The base layer is opaque wherever the card looks: nothing clears it.
const OVERLAY = (x, y) => (y < 16 && x >= 32) || (y >= 32 && y < 48) || (y >= 48 && (x < 16 || x >= 48));
for (const { label, rects } of layers) for (const [x, y, w, h, c] of rects) if (c === ".") assert(OVERLAY(x, y) && OVERLAY(x + w - 1, y + h - 1), `${label}: clears the base layer`);
assert(layers.length < 255, "at most 254 layers (255 means none)");

const palettes = []; // byte arrays, deduplicated
const paletteKey = new Map();
/// An option's colours (1..n, no gaps) as the contract holds them: { index into palettes, n }.
function palette(colors, where) {
  if (!colors) return { index: null, n: 0 };
  const keys = Object.keys(colors);
  keys.forEach((k, i) => assert(colors[String(i + 1)] !== undefined, `${where}: colours must be 1..${keys.length} with no gaps`));
  const bytes = [];
  for (let i = 1; i <= keys.length; i++) {
    const c = rgb(colors[String(i)], `${where} ${i}`);
    bytes.push(c >> 16, (c >> 8) & 255, c & 255);
  }
  const key = bytes.join(",");
  if (!paletteKey.has(key)) {
    paletteKey.set(key, palettes.length);
    palettes.push(bytes);
  }
  return { index: paletteKey.get(key), n: keys.length };
}
const option = (o, layerOf, where) => {
  const r = { layer: o.style === null ? 255 : layerOf[o.style], ...palette(o.colors, where) };
  assert(r.layer !== undefined, `${where}: no style "${o.style}"`);
  if (r.layer !== 255 && o.colors) assert(digitsOf(r.layer) <= r.n, `${where}: its style uses colour ${digitsOf(r.layer)}, its palette has ${r.n}`);
  return r;
};
const OPT = {
  top: TOPS.map((o) => option(o, L.top, o.name)),
  bottoms: BOTTOMS.map((o) => option(o, L.bottoms, o.name)),
  shoes: SHOES.map((o) => option(o, L.shoes, o.name)),
  headwear: HEADWEAR.map((o) => option(o, L.head, o.name)),
  accessory: ACCESSORIES.map((o) => option(o, L.acc, o.name)),
};
// The hood takes any top's colours (on the chain any traits can be drawn); the ink takes its accessory's.
assert(OPT.top.every((o) => o.n >= digitsOf(OPT.headwear[HOOD].layer)), "every top has the colours the hood uses");
ACCESSORIES.forEach((a, i) => a.eyes && assert(OPT.accessory[i].n >= Number(INK), `${a.name}: no colour ${INK} for the eyes' ink`));

// Flags and tiers, a bit (or two) per option.
const bits = (list, test) => list.reduce((m, o, i) => (test(o, i) ? m | (1n << BigInt(i)) : m), 0n);
const HOODIES = bits(TOPS, (o) => o.style === "hoodie");
const LEGS = bits(TOPS, (o) => !!TOP_STYLES[o.style].legs);
const FEET = bits(TOPS, (o) => !!TOP_STYLES[o.style].feet);
const INKY = bits(ACCESSORIES, (a) => !!a.eyes);
const tiers = (list) => list.reduce((m, o, i) => m | (BigInt(o.tier ?? 0) << BigInt(2 * i)), 0n);
const TIERS = { skin: tiers(SKINS), top: tiers(TOPS), headwear: tiers(HEADWEAR), accessory: tiers(ACCESSORIES) };

const T = {};
T.fixed = 0;
T.skins = T.fixed + 15;
T.backgrounds = T.skins + (SKINS.length + 1) * 15; // (the sealed DEGEN's skin last)
T.layers = T.backgrounds + BACKGROUNDS.length * 3;
T.top = T.layers + layers.length * 4;
T.bottoms = T.top + TOPS.length * 4;
T.shoes = T.bottoms + BOTTOMS.length * 4;
T.headwear = T.shoes + SHOES.length * 4;
T.accessory = T.headwear + HEADWEAR.length * 4;
T.palettes = T.accessory + ACCESSORIES.length * 4;
const paletteOffset = [];
let off = T.palettes;
for (const p of palettes) {
  paletteOffset.push(off);
  off += p.length;
}
T.rects = off;
const layerOffset = [];
for (const l of layers) {
  layerOffset.push(off);
  off += l.rects.length * 4;
}
T.end = off;
assert(T.end < 65536, "the art data must stay under 64 KB (uint16 offsets)");

const blob = [];
const u16 = (v) => {
  assert(Number.isInteger(v) && v >= 0 && v < 65536, "uint16 overflow");
  blob.push(v >> 8, v & 255);
};
const u24 = (c) => blob.push(c >> 16, (c >> 8) & 255, c & 255);
FIXED_KEYS.forEach((k) => u24(rgb(FIXED[k], `FIXED.${k}`)));
[...SKINS, SEALED.skin].forEach((s, i) => SKIN_KEYS.forEach((k) => u24(rgb(s[k], `skin ${i} ${k}`))));
BACKGROUNDS.forEach((b) => u24(rgb(b.color, `background ${b.name}`)));
layers.forEach((l, i) => {
  u16(layerOffset[i]);
  u16(l.rects.length);
});
for (const f of ["top", "bottoms", "shoes", "headwear", "accessory"]) {
  for (const o of OPT[f]) {
    blob.push(o.layer);
    u16(o.index === null ? 0 : paletteOffset[o.index]);
    blob.push(o.n);
  }
}
for (const p of palettes) blob.push(...p);
for (const l of layers) {
  for (const [x, y, w, h, c] of l.rects) {
    const e = (x << 26) | (y << 20) | ((w - 1) << 14) | ((h - 1) << 10) | (CODES.indexOf(c) << 5);
    blob.push((e >>> 24) & 255, (e >>> 16) & 255, (e >>> 8) & 255, e & 255);
  }
}
assert(blob.length === T.end, "blob layout");
const SEALED_BG = rgb(SEALED.background, "SEALED.background");

// ---------------------------------------------------------------- the contract, modelled in JS

/// The contract's _skin(): the layers painted from the blob, as the contract paints them. Pixels are 0 (empty) or
/// 0x1rrggbb.
const rd16 = (o) => (blob[o] << 8) | blob[o + 1];
const rd24 = (o) => (blob[o] << 16) | (blob[o + 1] << 8) | blob[o + 2];
function modelPaint(px, l, pal, skin) {
  const at = T.layers + 4 * l, p0 = rd16(at), n = rd16(at + 2);
  for (let k = 0; k < n; k++) {
    const p = p0 + 4 * k, e = ((blob[p] << 24) | (blob[p + 1] << 16) | (blob[p + 2] << 8) | blob[p + 3]) >>> 0;
    const code = (e >>> 5) & 31, x = e >>> 26, y = (e >>> 20) & 63, w = ((e >>> 14) & 63) + 1, h = ((e >>> 10) & 15) + 1;
    let c = 0;
    if (code < 9) c = 0x1000000 | rd24(pal + 3 * code);
    else if (code < 14) c = 0x1000000 | rd24(skin + 3 * (code - 9));
    else if (code < 19) c = 0x1000000 | rd24(T.fixed + 3 * (code - 14));
    for (let j = y; j < y + h; j++) px.fill(c, j * 64 + x, j * 64 + x + w);
  }
}
const has = (mask, i) => ((mask >> BigInt(i)) & 1n) === 1n;
const modelOption = (table, i) => [blob[table + 4 * i], rd16(table + 4 * i + 1)];
function modelSkin(t) {
  const px = new Array(4096).fill(0);
  if (t.sealed) {
    const skin = T.skins + 15 * SKINS.length;
    modelPaint(px, L.frog, 0, skin);
    modelPaint(px, L.sealed, 0, skin);
    return px;
  }
  const skin = T.skins + 15 * t.skin;
  modelPaint(px, L.frog, 0, skin);
  modelPaint(px, L.eyes + t.eyes, 0, skin);
  modelPaint(px, L.mouths + t.mouth, 0, skin);
  modelPaint(px, L.cheeks + t.cheeks, 0, skin);
  const [top, topColours] = modelOption(T.top, t.top);
  if (!has(LEGS, t.top)) modelPaint(px, ...modelOption(T.bottoms, t.bottoms), skin);
  modelPaint(px, top, topColours, skin);
  if (!has(FEET, t.top)) modelPaint(px, ...modelOption(T.shoes, t.shoes), skin);
  if (t.accessory !== 0) {
    const [l, c] = modelOption(T.accessory, t.accessory);
    modelPaint(px, l, c, skin);
    if (has(INKY, t.accessory)) modelPaint(px, L.ink + t.eyes, c, skin);
  }
  if (t.headwear !== 0) {
    const [l, c] = modelOption(T.headwear, t.headwear);
    modelPaint(px, l, t.headwear === HOOD ? topColours : c, skin);
  }
  return px;
}

// The card's faces, as the contract reads them: 14 bytes each.
const FACES = [];
const LIGHTS = { F: 0, R: 1, T: 2 };
for (const f of D.CARD_FACES) {
  for (const v of [f.X, f.Y]) assert(Number.isInteger(v) && v >= 0 && v < 256, "a face's corner must be 0..255");
  for (const v of [...f.a, ...f.b]) assert(Number.isInteger(v) && v >= -128 && v < 128, "a face's edges must be -128..127");
  FACES.push(f.base >> 8, f.base & 255, f.over >> 8, f.over & 255, f.fw, f.fh, f.X, f.Y, ...[...f.a, ...f.b].map((v) => v & 255), LIGHTS[f.face], f.last ? 1 : 0);
}
assert(D.CARD_FACES.at(-1).last, "the last face ends its part");
const MARK = "#@@@@@@";
const head = D.cardHead(MARK);
assert(head.split(MARK).length === 2, "the card's head holds the background once");
const [HEAD_A, HEAD_B] = head.split(MARK).map((s, i) => (i === 0 ? s + "#" : s));
const PATH_OPEN = '<path fill="#', PATH_MID = '" d="', PATH_CLOSE = '"/>';

/// The contract's _card(): the card written from the canvas, step by step as the contract writes it.
function modelCard(px, bg) {
  const hex6 = (c) => c.toString(16).padStart(6, "0");
  const lit = (c, kind) => {
    const ch = (v) => (kind === 1 ? (v * 196) >> 8 : kind === 2 ? v + (((255 - v) * 48) >> 8) : v);
    return (ch(c >> 16) << 16) | (ch((c >> 8) & 255) << 8) | ch(c & 255);
  };
  const num = (v) => String(v);
  const quad = (x, y, ax, ay, bx, by) => `M${num(x)} ${num(y)}l${num(ax)} ${num(ay)}${bx === 0 ? `v${num(by)}` : `l${num(bx)} ${num(by)}`}l${num(-ax)} ${num(-ay)}z`;
  let out = HEAD_A.slice(0, -1) + "#" + hex6(bg) + HEAD_B;
  let ents = [];
  for (let f = 0; f < FACES.length; f += 14) {
    const r = FACES.slice(f, f + 14), sx = (v) => (v > 127 ? v - 256 : v);
    const [b0, o0] = [(r[0] << 8) | r[1], (r[2] << 8) | r[3]], [fw, fh, X, Y] = r.slice(4, 8), [ax, ay, bx, by] = r.slice(8, 12).map(sx);
    const cols = [];
    for (let j = 0; j < fh; j++) for (let i = 0; i < fw; i++) {
      const at = 64 * j + i, c = px[o0 + at] || px[b0 + at];
      cols.push(lit(c & 0xffffff, r[12]));
    }
    const dist = [];
    for (const c of cols) {
      const d = dist.find((e) => e.c === c);
      if (d) d.n++;
      else dist.push({ c, n: 1 });
    }
    let best = dist[0];
    for (const d of dist.slice(1)) if (d.n > best.n) best = d;
    const base = best.c;
    ents.push({ g: 0, c: base, s: quad(X, Y, ax * fw, ay * fw, bx * fh, by * fh) });
    for (let j = 0; j < fh; j++) {
      for (let i = 0; i < fw;) {
        const c = cols[j * fw + i];
        let m = 1;
        while (i + m < fw && cols[j * fw + i + m] === c) m++;
        if (c !== base) ents.push({ g: 1, c, s: quad(X + ax * i + bx * j, Y + ay * i + by * j, ax * m, ay * m, bx, by) });
        i += m;
      }
    }
    if (!r[13]) continue;
    for (const g of [0, 1]) {
      for (let q = 0; q < ents.length; q++) {
        const e = ents[q];
        if (e.g !== g || e.done) continue;
        out += PATH_OPEN + hex6(e.c) + PATH_MID;
        for (let r = q; r < ents.length; r++) {
          const e2 = ents[r];
          if (e2.g === g && !e2.done && e2.c === e.c) {
            out += e2.s;
            e2.done = true;
          }
        }
        out += PATH_CLOSE;
      }
    }
    ents = [];
  }
  return out + D.CARD_TAIL;
}

// ---------------------------------------------------------------- names (from attributes() itself)

const KINDS = ["Background", "Skin", "Eyes", "Mouth", "Cheeks", "Top", "Bottoms", "Shoes", "Headwear", "Accessory"];
const FIELD_OF = Object.fromEntries(KINDS.map((k, i) => [k, FIELDS[i]]));
const showsBottoms = (top) => !has(LEGS, top), showsShoes = (top) => !has(FEET, top);
const attributesOf = (t) => D.attributes(t);
const zero = Object.fromEntries(FIELDS.map((f) => [f, 0]));
const plainTop = TOPS.findIndex((o, i) => showsBottoms(i) && showsShoes(i));
assert(plainTop >= 0, "some top shows both the bottoms and the shoes");
// Every option of every trait shows under its kind's name, and nothing else moves.
for (const f of FIELDS) {
  for (let i = 0; i < COUNT[f]; i++) {
    const t = { ...zero, top: plainTop, [f]: i };
    const a = attributesOf(t);
    const want = KINDS.filter((k) => (k !== "Bottoms" || showsBottoms(t.top)) && (k !== "Shoes" || showsShoes(t.top)));
    assert(JSON.stringify(a.map(([k]) => k)) === JSON.stringify([...want, "Rarity"]), `attributes(): kinds for ${f} ${i}`);
    for (const [k, v] of a.slice(0, -1)) assert(v === LIST[FIELD_OF[k]][t[FIELD_OF[k]]].name, `attributes(): ${k} must be its option's name`);
    assert(a.at(-1)[1] === RARITIES[D.rarityOf(t)], "attributes() ends with the rarity");
  }
}
// Bottoms and shoes are left out exactly when the top brings its own.
for (let top = 0; top < COUNT.top; top++) {
  const kinds = attributesOf({ ...zero, top }).map(([k]) => k);
  assert(kinds.includes("Bottoms") === showsBottoms(top) && kinds.includes("Shoes") === showsShoes(top), `attributes(): bottoms and shoes for top ${top}`);
}
const SAFE = /^[A-Za-z0-9 ._'-]+$/;
const NAMES = [...KINDS.map((k) => LIST[FIELD_OF[k]].map((o) => o.name)), [...RARITIES]];
const ALL_KINDS = [...KINDS, "Rarity"];
for (const k of ALL_KINDS) assert(SAFE.test(k), `trait type ${k}: letters, digits, spaces and . _ ' - only`);
for (const list of NAMES) for (const n of list) assert(SAFE.test(n), `name ${JSON.stringify(n)}: letters, digits, spaces and . _ ' - only (it goes into JSON and Solidity as is)`);
const nameBase = [];
const flatNames = [];
for (const list of NAMES) {
  nameBase.push(flatNames.length);
  flatNames.push(...list);
}
const nameEnds = [];
let nameText = "";
for (const n of flatNames) {
  nameText += n;
  nameEnds.push(nameText.length);
}
assert(nameText.length < 65536, "names under 64 KB");
const attributesJson = (t) => "[" + attributesOf(t).map(([k, v]) => `{"trait_type":"${k}","value":"${v}"}`).join(",") + "]";

// ---------------------------------------------------------------- rarity, spelled out

/// rarityOf(): the highest tier among the skin, the top, the headwear and the accessory.
const tierOf = (f, i) => Number((TIERS[f] >> BigInt(2 * i)) & 3n);
const modelRarity = (t) => Math.max(tierOf("skin", t.skin), tierOf("top", t.top), tierOf("headwear", t.headwear), tierOf("accessory", t.accessory));
for (const f of FIELDS) for (let i = 0; i < COUNT[f]; i++) for (const base of [zero, { ...zero, skin: 8 }, { ...zero, top: 52 }]) {
  const t = { ...base, [f]: i };
  assert(modelRarity(t) === D.rarityOf(t), `rarityOf: ${f} ${i}`);
}
const total = (list) => list.reduce((t, o) => t + o.w, 0);
const atLeast = (f, k) => (f === "top" ? TOPS.filter((o) => (o.tier ?? 0) >= k).length / TOPS.length
  : LIST[f].filter((o) => (o.tier ?? 0) >= k).reduce((t, o) => t + o.w, 0) / total(LIST[f]));
const noneAtLeast = (k) => ["skin", "top", "headwear", "accessory"].reduce((p, f) => p * (1 - atLeast(f, k)), 1);
const rarityOdds = [noneAtLeast(1), noneAtLeast(2) - noneAtLeast(1), 1 - noneAtLeast(2)];
const pct = (x) => `${+(x * 100).toFixed(1)}%`;

// ---------------------------------------------------------------- vectors

const SEEDS = [BigInt(keccakText("I'M DEGEN test vectors")), 1n, BigInt(keccakText("another seed"))];
const SEED = SEEDS[0];
const TOKEN_IDS = [
  [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 50, 99, 100, 101, 256, 333, 500, 666, 777, 1000, 1024, 1111, 1234, 1500, 1666, 1667, 2000, 2048, 2222, 2500, 2718, 3000, 3141, 3300, 3331, 3332, 3333],
  [1, 2, 17, 64, 128, 400, 999, 1337, 2001, 2600, 3000, 3333],
  [1, 3, 42, 300, 808, 1200, 1717, 2345, 2900, 3333],
];
const skinHash = (t) => toHex(keccakBytes(Buffer.from(D.skinPixels(t))));
const pack = (t) => FIELDS.map((f) => t[f]);
/// Checks the model against the JS for `t`, and gives the vector's numbers.
function check(t, where) {
  const want = D.skinColours(t), px = modelSkin(t);
  for (let i = 0; i < 4096; i++) assert((px[i] ? px[i] & 0xffffff : -1) === want[i], `${where}: the contract's painting differs from skinColours() at pixel ${i % 64}, ${i >> 6}`);
  const card = D.cardSvg(t);
  assert(modelCard(px, t.sealed ? SEALED_BG : rgb(BACKGROUNDS[t.background].color, "background")) === card, `${where}: the contract's card differs from cardSvg()`);
  if (t.sealed) return { card };
  assert(modelRarity(t) === D.rarityOf(t), `${where}: rarity`);
  return { card, rarity: D.rarityOf(t), skin: skinHash(t), attributes: keccakText(attributesJson(t)) };
}
// The whole supply under each seed: every token checked against the model; its traits, rarity and card length kept.
const supply = SEEDS.map((seed, s) => {
  const seq = [], rarities = [], counts = [0, 0, 0], combos = new Set();
  let heavy = [];
  for (let id = 1; id <= SUPPLY; id++) {
    const t = D.traitsOf(seed, id, hash);
    for (const f of FIELDS) assert(Number.isInteger(t[f]) && t[f] >= 0 && t[f] < COUNT[f], `seed ${s} token ${id}: ${f} out of range`);
    assert(t.headwear !== HOOD || has(HOODIES, t.top), `seed ${s} token ${id}: a hood on a top that isn't a hoodie`);
    const { card, rarity } = check(t, `seed ${s} token ${id}`);
    seq.push(...pack(t));
    rarities.push(rarity);
    counts[rarity]++;
    combos.add(`${t.eyes},${t.mouth},${t.cheeks},${t.top}`);
    if (s === 0) heavy.push([card.length, id]);
  }
  assert(combos.size === SUPPLY, `seed ${s}: two DEGENs share a face and a top`);
  heavy = heavy.sort((a, b) => b[0] - a[0]).slice(0, 5).map(([, id]) => id);
  return { traits: toHex(keccakBytes(Uint8Array.from(seq))), rarity: toHex(keccakBytes(Uint8Array.from(rarities))), counts, heavy };
});
const HEAVY = supply[0].heavy;
const tokens = [];
SEEDS.forEach((seed, s) => {
  const ids = s === 0 ? [...new Set([...TOKEN_IDS[0], ...HEAVY])] : TOKEN_IDS[s];
  for (const id of ids) {
    const t = D.traitsOf(seed, id, hash);
    const v = check(t, `seed ${s} token ${id}`);
    tokens.push({ seed: s, id, t, ...v, cardLength: Buffer.byteLength(v.card), card: keccakText(v.card) });
  }
});
// Looks that draw every option of every trait: a sweep (look i takes option i % count of each trait), each bottoms and
// shoes under a top that shows them, every eye under shades (the ink), and the hood on every hoodie.
const LOOKS = [];
for (let i = 0; i < COUNT.top; i++) LOOKS.push(Object.fromEntries(FIELDS.map((f, k) => [f, (i * (k === 5 ? 1 : 7 + k)) % COUNT[f]])));
for (let i = 0; i < COUNT.bottoms; i++) LOOKS.push({ ...zero, top: plainTop, bottoms: i, skin: i % COUNT.skin, background: i % COUNT.background });
for (let i = 0; i < COUNT.shoes; i++) LOOKS.push({ ...zero, top: plainTop, shoes: i, eyes: i % COUNT.eyes });
const shades = ACCESSORIES.findIndex((a) => a.eyes);
if (shades >= 0) for (let e = 0; e < COUNT.eyes; e++) LOOKS.push({ ...zero, eyes: e, accessory: shades, headwear: e % COUNT.headwear, mouth: e % COUNT.mouth });
TOPS.forEach((o, i) => o.style === "hoodie" && LOOKS.push({ ...zero, top: i, headwear: HOOD, accessory: i % COUNT.accessory }));
for (const f of FIELDS) assert(new Set(LOOKS.map((t) => t[f])).size === COUNT[f], `the looks must cover every ${f}`);
const looks = LOOKS.map((t, i) => {
  const v = check(t, `look ${i}`);
  return { t, ...v, cardLength: Buffer.byteLength(v.card), card: keccakText(v.card) };
});
assert(new Set(looks.map((x) => x.rarity)).size === 3, "the looks must cover every rarity");
const sealedCard = check({ sealed: true }, "the sealed card").card;
assert(sealedCard === D.sealedSvg(), "sealedSvg()");

// ---------------------------------------------------------------- Solidity

const hexLines = (bytes, indent) => {
  const lines = [];
  for (let i = 0; i < bytes.length; i += 48) lines.push(`${indent}hex"${Buffer.from(bytes.slice(i, i + 48)).toString("hex")}"`);
  return lines.join("\n");
};
const word = (s) => {
  assert(s.length <= 32, "word");
  return "0x" + Buffer.from(s, "latin1").toString("hex").padEnd(64, "0");
};
/// Yul writing the text `s` at `p` (whole words; the bytes past it are written over later), then moving `p` on.
const writeText = (s, indent) => {
  const out = [];
  for (let i = 0; i < s.length; i += 32) out.push(`${indent}mstore(${i ? `add(p, ${i})` : "p"}, ${word(s.slice(i, i + 32))})`);
  out.push(`${indent}p := add(p, ${s.length})`);
  return out.join("\n");
};
/// 8-bit weights, the first option lowest (64 hex digits: 40 would make an address literal).
const packWeights = (list) => "0x" + list.map((o) => o.w.toString(16).padStart(2, "0")).reverse().join("").padStart(64, "0");
const hex64 = (v) => "0x" + v.toString(16).padStart(64, "0");
const weightDoc = (list) => list.map((o) => `${o.name} ${o.w}`).join(", ");
/// Wraps a comment at 118 columns: `first` starts the first line, `next` the others.
const wrap = (text, first, next, width = 118) => {
  const out = [];
  let line = "";
  for (const w of text.split(" ")) {
    const prefix = out.length ? next : first;
    if (line && (prefix + line + " " + w).length > width) {
      out.push(prefix + line);
      line = w;
    } else line = line ? `${line} ${w}` : w;
  }
  if (line) out.push((out.length ? next : first) + line);
  return out.join("\n");
};
const CONST = { background: "BACKGROUNDS", skin: "SKINS", eyes: "EYES", mouth: "MOUTHS", cheeks: "CHEEKS", top: "TOPS", bottoms: "BOTTOMS", shoes: "SHOES", headwear: "HEADWEAR", accessory: "ACCESSORIES" };
const pick = (f, fn) => `${wrap(`Weighted pick of x % ${total(LIST[f])}: ${weightDoc(LIST[f])}.`, "    /// @notice ", "    ///         ")}
    function ${fn}(uint256 x) internal pure returns (uint8) {
        return _pick(x, ${packWeights(LIST[f])}, ${COUNT[f]}, ${total(LIST[f])});
    }`;
const tierDoc = (f) => LIST[f].map((o, i) => (o.tier ? `${i} ${o.name} (${RARITIES[o.tier]})` : null)).filter(Boolean).join(", ");
const kindFirst = ALL_KINDS.map((_, k) => nameBase[k]);
const kindCount = NAMES.map((l) => l.length);
const packU16 = (vs) => "0x" + vs.map((v) => v.toString(16).padStart(4, "0")).reverse().join("_");
const nameArg = (k, expr) => `_name(names, ends, ${nameBase[k]} + uint256(${expr}))`;
const kv = (k, first) => `${first ? "'[" : "'\"},"}{"trait_type":"${ALL_KINDS[k]}","value":"'`;
const art = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

// GENERATED by tools/gen-degen-art.mjs from web/degen-skin-art.js and web/degen-skin.js: don't edit by hand. Change
// the JS, then run \`~/.local/node/bin/node tools/gen-degen-art.mjs\` and \`forge test\` (which checks this art against
// skins and cards drawn by the JS).

/// @notice A DEGEN's traits: indexes into the tables of web/degen-skin-art.js, named and ordered as traitsOf returns
///         them in web/degen-skin.js.
struct Traits {
${FIELDS.map((f) => `    /// @dev ${{ headwear: `HEADWEAR (0 None, ${HOOD} Hood)`, accessory: "ACCESSORIES (0 None)" }[f] ?? CONST[f]} (${COUNT[f]})\n    uint8 ${f};`).join("\n")}
}

/// @notice The numbers and weighted picks behind a DEGEN's traits, and its rarity, as in web/degen-skin.js.
library CrafterRules {
    uint256 internal constant SUPPLY = ${SUPPLY};
${FIELDS.map((f) => `    uint256 internal constant ${CONST[f]} = ${COUNT[f]};`).join("\n")}
    uint256 internal constant RARITIES = ${RARITIES.length};
    /// @notice Eyes x mouth x cheeks x top: the shuffle gives every token a different one.
    uint256 internal constant COMBOS = ${COMBOS};
    /// @notice The hood: never picked by weight; a hoodie with no other headwear has it up one time in HOOD_ONE_IN.
    uint8 internal constant HOOD = ${HOOD};
    uint256 internal constant HOOD_ONE_IN = ${HOOD_ONE_IN};

${pick("background", "background")}

${pick("skin", "skin")}

${pick("bottoms", "bottoms")}

${pick("shoes", "shoes")}

${pick("headwear", "headwear")}

${pick("accessory", "accessory")}

    /// @notice Whether top \`top\` is a hoodie (its hood can be up).
    function hoodie(uint256 top) internal pure returns (bool) {
        return (${hex64(HOODIES)} >> top) & 1 != 0;
    }

    /// @notice Whether top \`top\` brings its own trousers (so no Bottoms are drawn or listed).
    function legs(uint256 top) internal pure returns (bool) {
        return (${hex64(LEGS)} >> top) & 1 != 0;
    }

    /// @notice Whether top \`top\` brings its own boots (so no Shoes are drawn or listed).
    function feet(uint256 top) internal pure returns (bool) {
        return (${hex64(FEET)} >> top) & 1 != 0;
    }

    /// @notice Whether accessory \`i\` keeps the eyes' ink over its lenses (shades).
    function ink(uint256 i) internal pure returns (bool) {
        return (${hex64(INKY)} >> i) & 1 != 0;
    }

${wrap(`rarityOf() in web/degen-skin.js: the highest tier (0 Common, 1 Rare, 2 Legendary) among the skin, the top, the headwear and the accessory, 2 bits each. Rare and Legendary ones: skins ${tierDoc("skin")}; tops ${tierDoc("top")}; headwear ${tierDoc("headwear")}${tierDoc("accessory") ? `; accessories ${tierDoc("accessory")}` : ""}. By the weights: ${RARITIES.map((n, r) => `${n} ${pct(rarityOdds[r])}`).join(", ")}.`, "    /// @notice ", "    ///         ")}
    function rarity(Traits memory t) internal pure returns (uint8) {
        uint256 r = (${hex64(TIERS.skin)} >> (2 * uint256(t.skin))) & 3;
        uint256 x = (${hex64(TIERS.top)} >> (2 * uint256(t.top))) & 3;
        if (x > r) r = x;
        x = (${hex64(TIERS.headwear)} >> (2 * uint256(t.headwear))) & 3;
        if (x > r) r = x;
        x = (${hex64(TIERS.accessory)} >> (2 * uint256(t.accessory))) & 3;
        if (x > r) r = x;
        return uint8(r);
    }

    /// @dev pick() in web/degen-skin.js: \`x % total\`, walked through the weights (8 bits each, first option lowest).
    function _pick(uint256 x, uint256 weights, uint256 n, uint256 total) private pure returns (uint8) {
        uint256 r = x % total;
        for (uint256 i; i < n; ++i) {
            uint256 w = (weights >> (8 * i)) & 0xff;
            if (r < w) return uint8(i);
            r -= w;
        }
        return uint8(n - 1);
    }
}

/// @title CrafterArt
/// @notice I'M DEGEN's pictures, drawn on chain. Every DEGEN is a Minecraft skin (64 x 64, the standard layout with
///         its second layer), painted layer by layer from the rectangles and palettes of web/degen-skin-art.js as
///         layersOf() in web/degen-skin.js lists them; its NFT card is that skin seen from the front, a little to its
///         right and above, written exactly as cardOf() writes it. The game puts the same skin on the player. Also the
///         sealed card shown before the reveal, the trait names marketplaces list, and each DEGEN's rarity. Holds no
///         state and has no owner.
contract CrafterArt {
    /// @notice A trait index past the end of its table.
    error BadTraits();

    /// @dev The art, from web/degen-skin-art.js (byte offsets):
    ///      [${T.fixed}, ${T.skins}) fixed colours, 3 bytes each: ${FIXED_KEYS.join(" ")}
    ///      [${T.skins}, ${T.backgrounds}) skins, S s l d B each (the sealed DEGEN's last)
    ///      [${T.backgrounds}, ${T.layers}) backgrounds
${wrap(`[${T.layers}, ${T.top}) ${layers.length} layers: rectangles offset uint16, count uint16. The frog ${L.frog}, the sealed DEGEN ${L.sealed}, eyes from ${L.eyes}, the eyes' ink from ${L.ink}, mouths from ${L.mouths}, cheeks from ${L.cheeks}, then the tops', bottoms', shoes', headwear's and accessories' styles`, "    ///      ", "    ///                 ")}
${wrap(`[${T.top}, ${T.palettes}) the options: layer uint8 (255: none), colours offset uint16, colours uint8, for the ${COUNT.top} tops from ${T.top}, ${COUNT.bottoms} bottoms from ${T.bottoms}, ${COUNT.shoes} shoes from ${T.shoes}, ${COUNT.headwear} headwear from ${T.headwear}, ${COUNT.accessory} accessories from ${T.accessory}`, "    ///      ", "    ///                 ")}
    ///      [${T.palettes}, ${T.rects}) the options' colours, 3 bytes each
${wrap(`[${T.rects}, ${T.end}) rectangles, 4 bytes each: x << 26 | y << 20 | (width - 1) << 14 | (height - 1) << 10 | code << 5, on the skin. Codes: 0-8 the option's colours 1-9, 9-13 the skin's S s l d B, 14-18 the fixed colours, 19 clear.`, "    ///      ", "    ///                 ")}
    bytes private constant ART =
${hexLines(blob, "        ")};

${wrap(`The card's faces, back to front, 14 bytes each: the index of their top left pixel on the base layer and on the second (uint16 each), width, height, corner on screen (x, y), the edges along a row and down a column (or towards the front) as signed bytes (ax, ay, bx, by), their light (0 front, 1 side, 2 top), and 1 at their part's last face.`, "    /// @dev ", "    ///      ")}
    bytes private constant FACES = hex"${Buffer.from(FACES).toString("hex")}";

${wrap(`The trait names, back to back (${ALL_KINDS.map((k, i) => `${k} from ${kindFirst[i]}`).join(", ")}), and where each one ends (uint16).`, "    /// @dev ", "    ///      ")}
    bytes private constant NAMES =
${nameText.match(/.{1,96}/g).map((s) => `        "${s}"`).join("\n")};
    bytes private constant NAME_ENDS =
${hexLines(nameEnds.flatMap((e) => [e >> 8, e & 255]), "        ")};

    /// @notice The DEGEN's NFT picture (an SVG), the same bytes as cardSvg(traits) in web/degen-skin.js.
    function render(Traits calldata t) external pure returns (string memory) {
        _check(t);
        return _card(_skin(t), _background(t.background));
    }

    /// @notice The sealed DEGEN shown before the reveal (sealedSvg() in web/degen-skin.js).
    function sealedSvg() external pure returns (string memory) {
        (uint256 data, uint256 canvas) = _start();
        uint256 skin = data + ${T.skins + 15 * SKINS.length};
        _paint(data, canvas, ${L.frog}, 0, skin);
        _paint(data, canvas, ${L.sealed}, 0, skin);
        return _card(canvas, ${"0x" + SEALED_BG.toString(16).padStart(6, "0")});
    }

${wrap(`The traits as marketplaces list them: a JSON array of {"trait_type", "value"} in the order of attributes() in web/degen-skin.js (${KINDS.join(", ")}, Rarity). Bottoms and Shoes are left out when the top brings its own.`, "    /// @notice ", "    ///         ")}
    function attributes(Traits calldata t) external pure returns (string memory) {
        _check(t);
        bytes memory names = NAMES;
        bytes memory ends = NAME_ENDS;
        string memory head = string.concat(
${KINDS.slice(0, 6).map((k, i) => `            ${kv(i, i === 0)},\n            ${nameArg(i, `t.${FIELD_OF[k]}`)}`).join(",\n")}
        );
        string memory bottoms = CrafterRules.legs(t.top) ? "" : string.concat(${kv(6)}, ${nameArg(6, "t.bottoms")});
        string memory shoes = CrafterRules.feet(t.top) ? "" : string.concat(${kv(7)}, ${nameArg(7, "t.shoes")});
        return string.concat(
            head,
            bottoms,
            shoes,
            ${kv(8)},
            ${nameArg(8, "t.headwear")},
            ${kv(9)},
            ${nameArg(9, "t.accessory")},
            ${kv(10)},
            ${nameArg(10, "CrafterRules.rarity(t)")},
            '"}]'
        );
    }

    /// @notice A DEGEN's rarity: ${RARITIES.map((n, r) => `${r} ${n}`).join(", ")} (rarityOf() in web/degen-skin.js).
    function rarityOf(Traits calldata t) external pure returns (uint8) {
        _check(t);
        return CrafterRules.rarity(t);
    }

${wrap(`A trait's name: \`kind\` in the attributes' order (${ALL_KINDS.map((k, i) => `${i} ${k}`).join(", ")}).`, "    /// @notice ", "    ///         ")}
    function traitName(uint256 kind, uint256 index) external pure returns (string memory) {
        if (kind >= ${ALL_KINDS.length}) revert BadTraits();
        uint256 first = (${packU16(kindFirst)} >> (16 * kind)) & 0xffff;
        uint256 count = (${packU16(kindCount)} >> (16 * kind)) & 0xffff;
        if (index >= count) revert BadTraits();
        return _name(NAMES, NAME_ENDS, first + index);
    }

    function _check(Traits calldata t) private pure {
        if (
${FIELDS.map((f) => `            t.${f} >= ${COUNT[f]}`).join(" ||\n")}
        ) revert BadTraits();
    }

${wrap(`layersOf() in web/degen-skin.js, painted onto a fresh canvas (4,096 words, one per pixel of the skin, row by row: 0 empty, else 0x1rrggbb): the frog, its eyes, mouth and cheeks, the trousers (unless the top brings its own), the top, the shoes (unless it brings boots), the accessory (with shades, the eyes' ink over the lenses) and the headwear (a hood in the top's colours).`, "    /// @dev ", "    ///      ")}
    function _skin(Traits memory t) internal pure returns (uint256 canvas) {
        uint256 data;
        (data, canvas) = _start();
        uint256 skin = data + ${T.skins} + 15 * uint256(t.skin);
        _paint(data, canvas, ${L.frog}, 0, skin);
        _paint(data, canvas, ${L.eyes} + uint256(t.eyes), 0, skin);
        _paint(data, canvas, ${L.mouths} + uint256(t.mouth), 0, skin);
        _paint(data, canvas, ${L.cheeks} + uint256(t.cheeks), 0, skin);
        (uint256 top, uint256 topColours) = _option(data, ${T.top}, t.top);
        if (!CrafterRules.legs(t.top)) {
            (uint256 l, uint256 c) = _option(data, ${T.bottoms}, t.bottoms);
            _paint(data, canvas, l, c, skin);
        }
        _paint(data, canvas, top, topColours, skin);
        if (!CrafterRules.feet(t.top)) {
            (uint256 l, uint256 c) = _option(data, ${T.shoes}, t.shoes);
            _paint(data, canvas, l, c, skin);
        }
        if (t.accessory != 0) {
            (uint256 l, uint256 c) = _option(data, ${T.accessory}, t.accessory);
            _paint(data, canvas, l, c, skin);
            if (CrafterRules.ink(t.accessory)) _paint(data, canvas, ${L.ink} + uint256(t.eyes), c, skin);
        }
        if (t.headwear != 0) {
            (uint256 l, uint256 c) = _option(data, ${T.headwear}, t.headwear);
            _paint(data, canvas, l, t.headwear == CrafterRules.HOOD ? topColours : c, skin);
        }
    }

    /// @dev The art in memory (where its bytes start), and a canvas of 4,096 empty pixels.
    function _start() private pure returns (uint256 data, uint256 canvas) {
        bytes memory art = ART;
        assembly ("memory-safe") {
            data := add(art, 32)
            canvas := mload(0x40)
            calldatacopy(canvas, calldatasize(), 131072) // (zeros)
            mstore(0x40, add(canvas, 131072))
        }
    }

    /// @dev Background \`i\`'s colour.
    function _background(uint256 i) private pure returns (uint256 c) {
        bytes memory art = ART;
        assembly ("memory-safe") {
            c := shr(232, mload(add(add(art, 32), add(${T.backgrounds}, mul(3, i)))))
        }
    }

    /// @dev Option \`i\` of the table at \`table\`: its layer, and where its colours are.
    function _option(uint256 data, uint256 table, uint256 i) private pure returns (uint256 layer, uint256 colours) {
        assembly ("memory-safe") {
            let rec := mload(add(data, add(table, shl(2, i))))
            layer := byte(0, rec)
            colours := add(data, and(shr(232, rec), 0xffff))
        }
    }

    /// @dev paint() in web/degen-skin.js: layer \`layer\`'s rectangles, each in its colour (\`colours\`, then \`skin\`, then
    ///      the fixed ones; "clear" empties the pixels).
    function _paint(uint256 data, uint256 canvas, uint256 layer, uint256 colours, uint256 skin) private pure {
        assembly ("memory-safe") {
            let rec := mload(add(data, add(${T.layers}, shl(2, layer))))
            let p := add(data, shr(240, rec))
            let end := add(p, shl(2, and(shr(224, rec), 0xffff)))
            for {} lt(p, end) { p := add(p, 4) } {
                let e := shr(224, mload(p))
                let code := and(shr(5, e), 31)
                let c := 0
                switch lt(code, 9)
                case 1 { c := or(0x1000000, shr(232, mload(add(colours, mul(3, code))))) }
                default {
                    switch lt(code, 14)
                    case 1 { c := or(0x1000000, shr(232, mload(add(skin, mul(3, sub(code, 9)))))) }
                    default {
                        if lt(code, 19) { c := or(0x1000000, shr(232, mload(add(data, add(${T.fixed}, mul(3, sub(code, 14))))))) }
                    }
                }
                let width := shl(5, add(and(shr(14, e), 63), 1))
                let row := add(canvas, shl(5, add(shl(6, and(shr(20, e), 63)), shr(26, e))))
                for { let h := add(and(shr(10, e), 15), 1) } h { h := sub(h, 1) } {
                    for { let q := row let qEnd := add(row, width) } lt(q, qEnd) { q := add(q, 32) } { mstore(q, c) }
                    row := add(row, 2048)
                }
            }
        }
    }

${wrap(`cardOf() in web/degen-skin.js: the card's head (with the background), then for each part, back to front, its faces' colours as you see them (the second layer where it has one, else the base) and lit, each face filled with its commonest colour, then every other run of one colour along a row drawn over it: one path per colour per part, the fills' first, each colour's pieces in the order they came. Written in place into one buffer, after scratch space for a face's colours, their counts, and a part's pieces and their text.`, "    /// @dev ", "    ///      ")}
    function _card(uint256 canvas, uint256 bg) private pure returns (string memory svg) {
        bytes memory faces = FACES;
        assembly ("memory-safe") {
            /// Colour \`c\`'s six lowercase hex digits at \`p\`.
            function hex6(p, c) -> q {
                for { let k := 0 } lt(k, 6) { k := add(k, 1) } {
                    mstore8(add(p, k), byte(and(shr(sub(20, shl(2, k)), c), 15), 0x3031323334353637383961626364656600000000000000000000000000000000))
                }
                q := add(p, 6)
            }
            /// \`v\` (a signed number, -999 to 999) in decimal at \`p\`.
            function num(p, v) -> q {
                if slt(v, 0) {
                    mstore8(p, 45)
                    p := add(p, 1)
                    v := sub(0, v)
                }
                switch lt(v, 10)
                case 1 {
                    mstore8(p, add(48, v))
                    q := add(p, 1)
                }
                default {
                    switch lt(v, 100)
                    case 1 {
                        mstore8(p, add(48, div(v, 10)))
                        mstore8(add(p, 1), add(48, mod(v, 10)))
                        q := add(p, 2)
                    }
                    default {
                        mstore8(p, add(48, div(v, 100)))
                        mstore8(add(p, 1), add(48, mod(div(v, 10), 10)))
                        mstore8(add(p, 2), add(48, mod(v, 10)))
                        q := add(p, 3)
                    }
                }
            }
            /// quad() in web/degen-skin.js: a parallelogram from (x, y) along (ax, ay) and (bx, by).
            function quad(p, x, y, ax, ay, bx, by) -> q {
                mstore8(p, 77) // M
                p := num(add(p, 1), x)
                mstore8(p, 32)
                p := num(add(p, 1), y)
                mstore8(p, 108) // l
                p := num(add(p, 1), ax)
                mstore8(p, 32)
                p := num(add(p, 1), ay)
                switch bx
                case 0 {
                    mstore8(p, 118) // v
                    p := num(add(p, 1), by)
                }
                default {
                    mstore8(p, 108)
                    p := num(add(p, 1), bx)
                    mstore8(p, 32)
                    p := num(add(p, 1), by)
                }
                mstore8(p, 108)
                p := num(add(p, 1), sub(0, ax))
                mstore8(p, 32)
                p := num(add(p, 1), sub(0, ay))
                mstore8(p, 122) // z
                q := add(p, 1)
            }
            /// Colour \`c\` lit: as it is (0, a front), x ${D.LIGHT_SIDE}/256 (1, a side), or + (255 - v) x ${D.LIGHT_TOP}/256 (2, a top), per channel.
            function light(c, kind) -> l {
                switch kind
                case 0 { l := c }
                case 1 {
                    l := or(or(shl(16, shr(8, mul(shr(16, c), ${D.LIGHT_SIDE}))), shl(8, shr(8, mul(and(shr(8, c), 255), ${D.LIGHT_SIDE})))), shr(8, mul(and(c, 255), ${D.LIGHT_SIDE})))
                }
                default {
                    let r := shr(16, c)
                    let g := and(shr(8, c), 255)
                    let b := and(c, 255)
                    r := add(r, shr(8, mul(sub(255, r), ${D.LIGHT_TOP})))
                    g := add(g, shr(8, mul(sub(255, g), ${D.LIGHT_TOP})))
                    b := add(b, shr(8, mul(sub(255, b), ${D.LIGHT_TOP})))
                    l := or(or(shl(16, r), shl(8, g)), b)
                }
            }

            let cols := mload(0x40) // a face's colours (96 words at most)
            let dist := add(cols, 3072) // its different colours: count << 24 | colour
            let ents := add(dist, 3072) // a part's pieces: colour, text offset << 24, length << 56, group << 72, done << 73
            let text := add(ents, 10240) // their text
            svg := add(text, 12288)
            let p := add(svg, 32)
${writeText(HEAD_A, "            ")}
            p := hex6(p, bg)
${writeText(HEAD_B, "            ")}
            let n := 0
            let tp := text
            for { let f := add(faces, 32) let fEnd := add(f, ${FACES.length}) } lt(f, fEnd) { f := add(f, 14) } {
                let rec := mload(f)
                let b0 := shr(240, rec)
                let o0 := and(shr(224, rec), 0xffff)
                let fw := byte(4, rec)
                let fh := byte(5, rec)
                let x0 := byte(6, rec)
                let y0 := byte(7, rec)
                let ax := signextend(0, byte(8, rec))
                let ay := signextend(0, byte(9, rec))
                let bx := signextend(0, byte(10, rec))
                let by := signextend(0, byte(11, rec))
                // The face's colours as you see them, lit.
                let k := 0
                for { let j := 0 } lt(j, fh) { j := add(j, 1) } {
                    for { let i := 0 } lt(i, fw) { i := add(i, 1) } {
                        let at := add(shl(6, j), i)
                        let c := mload(add(canvas, shl(5, add(o0, at))))
                        if iszero(c) { c := mload(add(canvas, shl(5, add(b0, at)))) }
                        mstore(add(cols, shl(5, k)), light(and(c, 0xffffff), byte(12, rec)))
                        k := add(k, 1)
                    }
                }
                // Its commonest (the first to appear, of those as common).
                let nd := 0
                for { let q := 0 } lt(q, k) { q := add(q, 1) } {
                    let c := mload(add(cols, shl(5, q)))
                    let d := 0
                    for {} lt(d, nd) { d := add(d, 1) } {
                        let e := mload(add(dist, shl(5, d)))
                        if eq(and(e, 0xffffff), c) {
                            mstore(add(dist, shl(5, d)), add(e, 0x1000000))
                            break
                        }
                    }
                    if eq(d, nd) {
                        mstore(add(dist, shl(5, nd)), or(0x1000000, c))
                        nd := add(nd, 1)
                    }
                }
                let best := mload(dist)
                for { let d := 1 } lt(d, nd) { d := add(d, 1) } {
                    let e := mload(add(dist, shl(5, d)))
                    if gt(shr(24, e), shr(24, best)) { best := e }
                }
                let base := and(best, 0xffffff)
                // The fill (group 0), then each row's runs of another colour (group 1): a piece each.
                let s := tp
                tp := quad(tp, x0, y0, mul(ax, fw), mul(ay, fw), mul(bx, fh), mul(by, fh))
                mstore(add(ents, shl(5, n)), or(or(base, shl(24, sub(s, text))), shl(56, sub(tp, s))))
                n := add(n, 1)
                for { let j := 0 } lt(j, fh) { j := add(j, 1) } {
                    let row := add(cols, shl(5, mul(j, fw)))
                    for { let i := 0 } lt(i, fw) {} {
                        let c := mload(add(row, shl(5, i)))
                        let m := 1
                        for {} and(lt(add(i, m), fw), eq(mload(add(row, shl(5, add(i, m)))), c)) {} { m := add(m, 1) }
                        if iszero(eq(c, base)) {
                            s := tp
                            tp := quad(tp, add(x0, add(mul(ax, i), mul(bx, j))), add(y0, add(mul(ay, i), mul(by, j))), mul(ax, m), mul(ay, m), bx, by)
                            mstore(add(ents, shl(5, n)), or(or(or(c, shl(24, sub(s, text))), shl(56, sub(tp, s))), shl(72, 1)))
                            n := add(n, 1)
                        }
                        i := add(i, m)
                    }
                }
                // At the part's last face: one path per colour, its pieces in order; the fills' first.
                if byte(13, rec) {
                    for { let g := 0 } lt(g, 2) { g := add(g, 1) } {
                        for { let q := 0 } lt(q, n) { q := add(q, 1) } {
                            let e := mload(add(ents, shl(5, q)))
                            // (shr(72) is the group while the piece isn't written yet: done adds 2)
                            if eq(shr(72, e), g) {
                                let c := and(e, 0xffffff)
${writeText(PATH_OPEN, "                                ")}
                                p := hex6(p, c)
${writeText(PATH_MID, "                                ")}
                                for { let r := q } lt(r, n) { r := add(r, 1) } {
                                    let e2 := mload(add(ents, shl(5, r)))
                                    if and(eq(shr(72, e2), g), eq(and(e2, 0xffffff), c)) {
                                        let len := and(shr(56, e2), 0xffff)
                                        mcopy(p, add(text, and(shr(24, e2), 0xffffffff)), len)
                                        p := add(p, len)
                                        mstore(add(ents, shl(5, r)), or(e2, shl(73, 1)))
                                    }
                                }
${writeText(PATH_CLOSE, "                                ")}
                            }
                        }
                    }
                    n := 0
                    tp := text
                }
            }
${writeText(D.CARD_TAIL, "            ")}
            mstore(svg, sub(p, add(svg, 32)))
            mstore(p, 0)
            mstore(0x40, and(add(p, 63), not(31)))
        }
    }

    /// @dev Name \`i\` of NAMES, as a new string.
    function _name(bytes memory names, bytes memory ends, uint256 i) private pure returns (string memory s) {
        assembly ("memory-safe") {
            let e := add(ends, 32)
            let start := 0
            if i { start := shr(240, mload(add(e, shl(1, sub(i, 1))))) }
            let len := sub(shr(240, mload(add(e, shl(1, i)))), start)
            s := mload(0x40)
            mstore(s, len)
            mcopy(add(s, 32), add(add(names, 32), start), len)
            mstore(add(add(s, 32), len), 0)
            mstore(0x40, and(add(add(s, 63), len), not(31)))
        }
    }
}
`;

const traitsSol = (t) => `Traits(${pack(t).join(", ")})`;
const fileHash = (rel) => keccak256(readFileSync(join(ROOT, rel)));
const vectors = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

// GENERATED by tools/gen-degen-art.mjs: don't edit by hand. Traits, skins, cards and names worked out by the JS
// (web/degen-skin.js, web/degen-skin-art.js); CrafterArt.t.sol checks the contracts give the same.

import {Traits} from "../src/CrafterArt.sol";

library CrafterVectors {
    /// @notice keccak256 of each source file when this was generated: forge test fails once one changes, until
    ///         \`~/.local/node/bin/node tools/gen-degen-art.mjs\` is run again.
${Object.entries(SOURCES).map(([k, rel]) => `    bytes32 internal constant ${k} = ${fileHash(rel)}; // ${rel}`).join("\n")}

    /// @notice The seeds the vectors were worked out with: keccak256("I'M DEGEN test vectors"), 1 and
    ///         keccak256("another seed"). SEED is the first.
    uint256 internal constant SEED = ${hex64(SEED)};

    function seeds() internal pure returns (uint256[${SEEDS.length}] memory) {
        return [${SEEDS.map((s, i) => (i === 0 ? `uint256(${hex64(s)})` : hex64(s))).join(", ")}];
    }

    /// @notice keccak256 of sealedSvg() (${Buffer.byteLength(sealedCard)} bytes).
    bytes32 internal constant SEALED_SVG = ${keccakText(sealedCard)};
    uint256 internal constant SEALED_SVG_LENGTH = ${Buffer.byteLength(sealedCard)};

    /// @notice keccak256 of the names, "|"-joined, of each kind of trait (in the attributes' order).
    function names() internal pure returns (bytes32[${ALL_KINDS.length}] memory) {
        return [
${NAMES.map((l, i) => `            ${i === 0 ? `bytes32(${keccakText(l.join("|"))})` : keccakText(l.join("|"))}${i < NAMES.length - 1 ? "," : ""} // ${ALL_KINDS[i]}, ${l.length}`).join("\n")}
        ];
    }

    /// @notice keccak256 of every DEGEN's traits under each seed, from #1 to #${SUPPLY}, ten bytes each (in the struct's
    ///         order).
    function traitsRuns() internal pure returns (bytes32[${SEEDS.length}] memory) {
        return [${supply.map((x, i) => (i === 0 ? `bytes32(${x.traits})` : x.traits)).join(", ")}];
    }

    /// @notice keccak256 of every DEGEN's rarity under each seed, one byte each, from #1 to #${SUPPLY}.
    function rarityRuns() internal pure returns (bytes32[${SEEDS.length}] memory) {
        return [${supply.map((x, i) => (i === 0 ? `bytes32(${x.rarity})` : x.rarity)).join(", ")}];
    }

    /// @notice How many of the ${SUPPLY} under each seed have each rarity (${RARITIES.join(", ")}).
    function rarityCounts() internal pure returns (uint256[${RARITIES.length}][${SEEDS.length}] memory) {
        return [${supply.map((x) => `[${x.counts.map((c, j) => (j === 0 ? `uint256(${c})` : c)).join(", ")}]`).join(", ")}];
    }

    /// @notice The ${HEAVY.length} DEGENs with the longest cards under SEED (the heaviest tokenURIs), longest first.
    function heaviest() internal pure returns (uint256[${HEAVY.length}] memory) {
        return [${HEAVY.map((id, i) => (i === 0 ? `uint256(${id})` : id)).join(", ")}];
    }

    struct Token {
        uint8 seed; // its index in seeds()
        uint256 id;
        Traits traits;
        uint8 rarity; // rarityOf(traits)
        bytes32 card; // keccak256 of cardSvg(traits)
        uint256 cardLength;
        bytes32 skin; // keccak256 of the skin's 64 x 64 RGBA bytes (skinPixels)
        bytes32 attributes; // keccak256 of the attributes JSON array
    }

    struct Look {
        Traits traits;
        uint8 rarity;
        bytes32 card;
        uint256 cardLength;
        bytes32 skin;
        bytes32 attributes;
    }

    /// @notice ${tokens.length} tokens under the seeds: traitsOf(seed, id), and their skins and cards.
    function tokens() internal pure returns (Token[] memory v) {
        v = new Token[](${tokens.length});
${tokens.map((x, i) => `        v[${i}] = Token(${x.seed}, ${x.id}, ${traitsSol(x.t)}, ${x.rarity}, ${x.card}, ${x.cardLength}, ${x.skin}, ${x.attributes});`).join("\n")}
    }

    /// @notice ${looks.length} looks that between them draw every option of every trait, every eye under shades and the
    ///         hood on every hoodie, and every rarity.
    function looks() internal pure returns (Look[] memory v) {
        v = new Look[](${looks.length});
${looks.map((x, i) => `        v[${i}] = Look(${traitsSol(x.t)}, ${x.rarity}, ${x.card}, ${x.cardLength}, ${x.skin}, ${x.attributes});`).join("\n")}
    }
}
`;

// ---------------------------------------------------------------- write, or check

const outputs = [[OUT_ART, art], [OUT_VECTORS, vectors]];
const lengths = [...tokens, ...looks].map((x) => x.cardLength);
const counts = supply[0].counts;
const summary = `rarity over the ${SUPPLY} under the vector seed: ${RARITIES.map((n, r) => `${n} ${counts[r]}`).join(", ")} (odds ${rarityOdds.map(pct).join(" / ")}); art data ${blob.length} bytes (${layers.length} layers, ${layers.reduce((t, l) => t + l.rects.length, 0)} rectangles, ${palettes.length} palettes), names ${nameText.length} bytes; ${tokens.length} token and ${looks.length} look vectors under ${SEEDS.length} seeds, cards ${Math.min(...lengths)}-${Math.max(...lengths)} bytes, sealed ${sealedCard.length}; heaviest under the vector seed: #${HEAVY.join(", #")}`;
if (process.argv.includes("--check")) {
  const stale = outputs.filter(([rel, text]) => {
    try {
      return readFileSync(join(ROOT, rel), "utf8") !== text;
    } catch {
      return true;
    }
  });
  if (stale.length) fail(`${stale.map(([rel]) => rel).join(" and ")} ${stale.length > 1 ? "are" : "is"} stale: run ~/.local/node/bin/node tools/gen-degen-art.mjs`);
  console.log(`CrafterArt.sol and CrafterVectors.sol are up to date (${summary})`);
} else {
  for (const [rel, text] of outputs) writeFileSync(join(ROOT, rel), text);
  console.log(`wrote ${OUT_ART} and ${OUT_VECTORS}: ${summary}`);
}
