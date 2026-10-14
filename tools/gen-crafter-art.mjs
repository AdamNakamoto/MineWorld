// MineWorld Crafters: writes the on-chain art (contracts/src/CrafterArt.sol) and its test vectors
// (contracts/test/CrafterVectors.sol) from the JavaScript that defines every Crafter:
//
//   web/crafters-art.js   the masks, palettes and trait options
//   web/crafters.js       traitsOf (the shuffle and the weighted picks), rarityOf, pixels (the layer order) and svgOf
//                         (the SVG)
//
// The JS is the specification: the contract must draw every Crafter byte for byte like svg() does. Run after any
// change to either file (or to this one):
//
//   ~/.local/node/bin/node tools/gen-crafter-art.mjs           # write both files
//   ~/.local/node/bin/node tools/gen-crafter-art.mjs --check   # exit 1 if either is stale (writes nothing)
//
// No npm: keccak-256 is built in below. `forge test` then checks the contract against the vectors, and fails if the
// JS (or this file) changed since the vectors were made.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as ART from "../web/crafters-art.js";
import * as RULES from "../web/crafters.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCES = { ART_JS: "web/crafters-art.js", RULES_JS: "web/crafters.js", GENERATOR: "tools/gen-crafter-art.mjs" };
const OUT_ART = "contracts/src/CrafterArt.sol";
const OUT_VECTORS = "contracts/test/CrafterVectors.sol";
const N = 24;

function fail(msg) {
  console.error(`gen-crafter-art: ${msg}`);
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
/// viem's keccak256, for what crafters.js passes it: hex strings (or bytes).
const keccak256 = (v) => toHex(keccakBytes(typeof v === "string" ? fromHex(v) : v));
/// keccak256 of a text's UTF-8 bytes (what Solidity's keccak256(bytes(text)) gives).
const keccakText = (text) => toHex(keccakBytes(Buffer.from(text, "utf8")));
/// viem's encodeAbiParameters, for the uint256s crafters.js encodes.
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

const { MASKS, FACE, INK, EYE_WHITE, BACKGROUNDS, SKINS, EYES, BLUSHES, HAIRS, HATS, OUTFITS, SEALED } = ART;
const { SUPPLY, COMBOS } = RULES;
const COLOUR = /^#[0-9a-f]{6}$/;
const rgb = (c, where) => {
  assert(typeof c === "string" && COLOUR.test(c), `${where}: colour ${JSON.stringify(c)} isn't a lowercase #rrggbb (the contract writes lowercase hex)`);
  return parseInt(c.slice(1), 16);
};

/// A colour as the contract stores it: its six lowercase hex digits (ASCII), as the SVG has them.
const ascii6 = (c) => [...Buffer.from(c.toString(16).padStart(6, "0"), "latin1")];

// The traits, in traitsOf's order (the Solidity struct uses the same names and order).
const sample = RULES.traitsOf(1n, 1, hash);
const FIELDS = Object.keys(sample);
const COUNT = { hair: HAIRS.length, outfit: OUTFITS.length, eyes: EYES.length, gaze: COMBOS / (HAIRS.length * OUTFITS.length * EYES.length), background: BACKGROUNDS.length, skin: SKINS.length, hat: HATS.length, blush: BLUSHES.length };
assert(FIELDS.length === 8 && FIELDS.every((f) => f in COUNT), `traitsOf returns ${FIELDS.join()}: expected hair, outfit, eyes, gaze, background, skin, hat, blush`);
assert(COUNT.gaze === 2, "COMBOS must be hairs x outfits x eyes x 2 gazes");
assert(SUPPLY > 0 && SUPPLY <= 4096 && COMBOS >= SUPPLY, "the shuffle is a 12-bit Feistel network: SUPPLY must be 1..4096, and COMBOS >= SUPPLY");
assert(BLUSHES.length === 2, "pixels() paints blushSoft for any blush but 0: exactly two blushes");
for (const [name, list] of [["BACKGROUNDS", BACKGROUNDS], ["SKINS", SKINS], ["HATS", HATS], ["BLUSHES", BLUSHES]]) {
  assert(list.length <= 16 && list.every((o) => Number.isInteger(o.w) && o.w >= 0 && o.w < 65536) && list.reduce((t, o) => t + o.w, 0) > 0, `${name}: weights must be whole numbers below 65,536 (at most 16 options)`);
}
for (const f of FIELDS) assert(COUNT[f] > 0 && COUNT[f] <= 256, `${f}: 1..256 options`);

// ---------------------------------------------------------------- masks and roles

const rowsOf = (m) => (Array.isArray(m) ? m.map((r, y) => [y, r]) : Object.entries(m).map(([y, r]) => [Number(y), r]));
const MASK_LIST = [
  ...Object.keys(MASKS).map((k) => [k, MASKS[k]]),
  ["faceBase", FACE.base], ["ink", FACE.ink], ["eyesLeft", FACE.eyesLeft], ["eyesRight", FACE.eyesRight],
  ["blushRosy", FACE.blushRosy], ["blushSoft", FACE.blushSoft], ["sealed", SEALED.mask],
];
const MASK_ID = Object.fromEntries(MASK_LIST.map(([k], i) => [k, i]));
const ROLES = []; // every character a mask uses, numbered in order of first appearance
const pixelsOf = {}; // mask -> [[pos, char]] as paint() visits them (it skips "." and anything past x = 23)
for (const [k, m] of MASK_LIST) {
  const px = [];
  for (const [y, r] of rowsOf(m)) {
    assert(Number.isInteger(y) && y >= 0 && y < N, `mask ${k}: row ${y} is outside the 24 x 24 picture`);
    assert(typeof r === "string", `mask ${k}: row ${y} isn't a string`);
    for (let x = 0; x < N; x++) {
      const ch = r[x];
      if (ch === undefined || ch === ".") continue;
      if (!ROLES.includes(ch)) ROLES.push(ch);
      px.push([y * N + x, ch]);
    }
  }
  px.sort((a, b) => a[0] - b[0]);
  pixelsOf[k] = px;
}
assert(ROLES.length <= 64, "at most 64 different mask characters");
const charsOf = (k) => [...new Set(pixelsOf[k].map(([, ch]) => ch))].sort((a, b) => ROLES.indexOf(a) - ROLES.indexOf(b));

// How each palette entry resolves: a fixed colour, the skin's S, s or b, or nothing (the pixel is left alone).
const HOW = { rgb: 0, S: 1, s: 2, b: 3, none: 4 };
/// As paint() in crafters.js: `colors[ch] ?? (S, s, b: the skin; K: ink; W: eye white; else nothing)`, then
/// `if (col)` paints.
function resolvePaint(colors, ch, where) {
  const c = colors[ch];
  if (c !== undefined && c !== null) return c ? [HOW.rgb, rgb(c, where)] : [HOW.none, 0];
  if (ch === "S" || ch === "s" || ch === "b") return [HOW[ch], 0];
  if (ch === "K") return [HOW.rgb, rgb(INK, "INK")];
  if (ch === "W") return [HOW.rgb, rgb(EYE_WHITE, "EYE_WHITE")];
  return [HOW.none, 0];
}
/// As sealedSvg(): `SEALED.colors[ch]`, no fallback.
function resolveSealed(ch) {
  const c = SEALED.colors[ch];
  assert(c !== undefined, `SEALED.mask uses "${ch}", which SEALED.colors doesn't have (sealedSvg would write "undefined")`);
  return [HOW.rgb, rgb(c, `SEALED.colors.${ch}`)];
}

// ---------------------------------------------------------------- the data blob

const palettes = []; // byte arrays, deduplicated
const paletteKey = new Map();
const unusedColours = [];
function palette(maskKey, resolve) {
  const bytes = [];
  for (const ch of charsOf(maskKey)) {
    const [how, c] = resolve(ch);
    bytes.push(ROLES.indexOf(ch), how, ...ascii6(c));
  }
  const key = bytes.join(",");
  if (!paletteKey.has(key)) {
    paletteKey.set(key, palettes.length);
    palettes.push(bytes);
  }
  return { index: paletteKey.get(key), count: bytes.length / 8 };
}
const layers = []; // { mask, palette, count, label }
function layer(label, maskKey, colors, resolve) {
  if (maskKey === null) return layers.push({ label, mask: 255, palette: null, count: 0 }) - 1;
  assert(maskKey in MASK_ID, `${label}: no mask "${maskKey}"`);
  if (colors) for (const ch of Object.keys(colors)) if (!charsOf(maskKey).includes(ch)) unusedColours.push(`${label} "${ch}"`);
  const p = palette(maskKey, resolve ?? ((ch) => resolvePaint(colors ?? {}, ch, `${label} "${ch}"`)));
  return layers.push({ label, mask: MASK_ID[maskKey], palette: p.index, count: p.count }) - 1;
}

const L = {};
L.hair = layers.length;
HAIRS.forEach((h, i) => layer(`HAIRS[${i}] ${h.name}`, h.mask, h.colors));
L.outfit = layers.length;
OUTFITS.forEach((o, i) => layer(`OUTFITS[${i}] ${o.name}`, o.mask, o.colors));
L.hat = layers.length;
HATS.forEach((h, i) => layer(`HATS[${i}] ${h.name}`, h.mask ?? null, h.colors));
L.eyes = layers.length; // two per colour: looking left (gaze 0), right (gaze 1)
EYES.forEach((e, i) => {
  assert(Array.isArray(e.c) && e.c.length === 4, `EYES[${i}]: four colours`);
  const colors = { 1: e.c[0], 2: e.c[1], 3: e.c[2], 4: e.c[3] };
  layer(`EYES[${i}] ${e.name} left`, "eyesLeft", colors);
  layer(`EYES[${i}] ${e.name} right`, "eyesRight", colors);
});
L.blush = layers.length; // blush 0 is FACE.blushRosy, any other FACE.blushSoft
layer("blush 0", "blushRosy", {});
layer("blush 1", "blushSoft", {});
L.face = layer("face", "faceBase", {});
L.ink = layer("ink", "ink", {});
L.sealed = layer("sealed", "sealed", null, resolveSealed);
// (Colours an option defines but its mask never uses are harmless; crafters.js's tables have the curly hairs' 4th.)
const unusedNote = unusedColours.filter((u) => !/^HATS\[0\]/.test(u));

const T = {};
T.masks = 0; // (_layer reads the mask table at offset 0)
T.layers = T.masks + MASK_LIST.length * 4;
T.backgrounds = T.layers + layers.length * 4;
T.skins = T.backgrounds + BACKGROUNDS.length * 6;
T.pixels = T.skins + SKINS.length * 18;
const maskOffset = [];
let off = T.pixels;
for (const [k] of MASK_LIST) {
  maskOffset.push(off);
  off += pixelsOf[k].length * 2;
}
T.palettes = off;
const paletteOffset = [];
for (const p of palettes) {
  paletteOffset.push(off);
  off += p.length;
}
T.end = off;
assert(T.end < 65536, "the art data must stay under 64 KB (uint16 offsets)");

const blob = [];
const u16 = (v) => {
  assert(v >= 0 && v < 65536, "uint16 overflow");
  blob.push(v >> 8, v & 255);
};
const u48 = (v) => blob.push(...ascii6(v));
MASK_LIST.forEach(([k], i) => {
  u16(maskOffset[i]);
  u16(pixelsOf[k].length);
});
for (const l of layers) {
  blob.push(l.mask);
  u16(l.palette === null ? 0 : paletteOffset[l.palette]);
  blob.push(l.count);
}
BACKGROUNDS.forEach((b, i) => u48(rgb(b.color, `BACKGROUNDS[${i}]`)));
SKINS.forEach((s, i) => ["S", "s", "b"].forEach((k) => u48(rgb(s[k], `SKINS[${i}].${k}`))));
for (const [k] of MASK_LIST) for (const [pos, ch] of pixelsOf[k]) u16((pos << 6) | ROLES.indexOf(ch));
for (const p of palettes) blob.push(...p);
assert(blob.length === T.end, "blob layout");

// ---------------------------------------------------------------- names (from attributes() itself)

const zero = Object.fromEntries(FIELDS.map((f) => [f, 0]));
const { RARITIES, rarityOf } = RULES;
assert(Array.isArray(RARITIES) && RARITIES.length >= 1 && RARITIES.length <= 4 && typeof rarityOf === "function", "crafters.js exports RARITIES (1-4 names) and rarityOf(traits)");
/// attributes() lists the eight traits, then ["Rarity", RARITIES[rarityOf(t)]]: the traits' part.
const traitAttributes = (t) => {
  const a = RULES.attributes(t);
  assert(Array.isArray(a) && a.length === 9 && a.every((x) => x.length === 2), "attributes() returns nine [trait_type, value] pairs: the eight traits, then Rarity");
  assert(a[8][0] === "Rarity" && a[8][1] === RARITIES[rarityOf(t)], `attributes() must end with ["Rarity", RARITIES[rarityOf(t)]]`);
  return a.slice(0, 8);
};
const base = traitAttributes(zero);
const KINDS = base.map(([k]) => k);
const fieldOf = KINDS.map((_, k) => {
  const f = FIELDS.filter((f) => traitAttributes({ ...zero, [f]: 1 })[k][1] !== base[k][1]);
  assert(f.length === 1, `attribute ${KINDS[k]} must follow exactly one trait`);
  return f[0];
});
assert(new Set(fieldOf).size === 8, "each trait has its own attribute");
for (const f of FIELDS) {
  const changed = KINDS.filter((_, k) => traitAttributes({ ...zero, [f]: 1 })[k][1] !== base[k][1]);
  assert(changed.length === 1, `trait ${f} must change exactly one attribute`);
}
const SAFE = /^[A-Za-z0-9 ._-]+$/;
const NAMES = KINDS.map((kind, k) => {
  assert(SAFE.test(kind), `trait type ${JSON.stringify(kind)}: letters, digits, spaces and . _ - only (it goes into JSON and Solidity as is)`);
  return Array.from({ length: COUNT[fieldOf[k]] }, (_, i) => {
    const n = traitAttributes({ ...zero, [fieldOf[k]]: i })[k][1];
    assert(typeof n === "string" && SAFE.test(n), `${kind} ${i}: name ${JSON.stringify(n)}: letters, digits, spaces and . _ - only`);
    return n;
  });
});
// The rarity comes last: a ninth kind of name, worked out from the background and the hat.
for (const n of RARITIES) assert(typeof n === "string" && SAFE.test(n), `rarity ${JSON.stringify(n)}: letters, digits, spaces and . _ - only`);
NAMES.push([...RARITIES]);
const ALL_KINDS = [...KINDS, "Rarity"];
const kindCount = (k) => (k < KINDS.length ? COUNT[fieldOf[k]] : RARITIES.length);

// ---------------------------------------------------------------- rarity

/// rarityOf() as a table by background and hat. It must depend on those two alone: checked here against every
/// option of every other trait (and below, against every token of the supply).
const RARITY = BACKGROUNDS.map((_, b) => HATS.map((_, h) => rarityOf({ ...zero, background: b, hat: h })));
for (let b = 0; b < COUNT.background; b++) {
  for (let h = 0; h < COUNT.hat; h++) {
    const r = RARITY[b][h];
    assert(Number.isInteger(r) && r >= 0 && r < RARITIES.length, `rarityOf: ${r} for background ${b}, hat ${h} isn't an index into RARITIES`);
    for (const f of FIELDS) {
      if (f === "background" || f === "hat") continue;
      for (let i = 0; i < COUNT[f]; i++) {
        assert(rarityOf({ ...zero, [f]: i, background: b, hat: h }) === r, `rarityOf must depend on the background and the hat alone (it changed with ${f})`);
      }
    }
  }
}
assert(2 * COUNT.background * COUNT.hat <= 256, "the rarity table (2 bits per background and hat) must fit a word");
let rarityTable = 0n;
RARITY.forEach((row, b) => row.forEach((r, h) => (rarityTable |= BigInt(r) << BigInt(2 * (b * COUNT.hat + h)))));
const rarityOdds = RARITIES.map((_, r) => {
  let w = 0;
  BACKGROUNDS.forEach((bg, b) => HATS.forEach((hat, h) => (w += RARITY[b][h] === r ? bg.w * hat.w : 0)));
  return w / (BACKGROUNDS.reduce((t, o) => t + o.w, 0) * HATS.reduce((t, o) => t + o.w, 0));
});
const pct = (x) => `${+(x * 100).toFixed(2)}%`;
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
const attributesJson = (t) => "[" + RULES.attributes(t).map(([k, v]) => `{"trait_type":"${k}","value":"${v}"}`).join(",") + "]";

// ---------------------------------------------------------------- the SVG, as the contract writes it

const SVG_HEAD = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" shape-rendering="crispEdges"><rect width="24" height="24" fill="#';
const SVG_HEAD_END = '"/>';
const RECT_X = '<rect x="', RECT_Y = '" y="', RECT_W = '" width="', RECT_FILL = '" height="1" fill="#', RECT_END = '"/>';
const SVG_END = "</svg>";
/// The contract's writer, in JS: checked against svgOf() before anything is written.
function contractSvg(px, bg) {
  const hex = (c) => c.toString(16).padStart(6, "0");
  let out = SVG_HEAD + hex(bg) + SVG_HEAD_END;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N;) {
      const c = px[y * N + x];
      let w = 1;
      while (x + w < N && px[y * N + x + w] === c) w++;
      if (c !== bg) out += RECT_X + x + RECT_Y + y + RECT_W + w + RECT_FILL + hex(c) + RECT_END;
      x += w;
    }
  }
  return out + SVG_END;
}
const pxRgb = (px) => px.map((c) => rgb(c, "pixels()"));
const word = (s) => {
  assert(s.length <= 32, "word");
  return "0x" + Buffer.from(s, "latin1").toString("hex").padEnd(64, "0");
};
const words = (s) => {
  const out = [];
  for (let i = 0; i < s.length; i += 32) out.push(word(s.slice(i, i + 32)));
  return out;
};
// The contract keeps each colour as a word: its six hex digits then the `"/>` that ends a rect (and the background's).
assert(RECT_END === SVG_HEAD_END && RECT_END.length + 6 <= 32 && RECT_FILL.endsWith("#") && SVG_HEAD.endsWith("#"), "colour words: rects and the background must end the same way");
const colourWord = (hex6) => word(hex6 + RECT_END);
const HEX_MASK = "0x" + "ff".repeat(6) + "00".repeat(26);
const END_WORD = "0x" + "00".repeat(6) + Buffer.from(RECT_END, "latin1").toString("hex") + "00".repeat(26 - RECT_END.length);
/// Fill the 576 pixel words by doubling: the first word copied over the next, those two over the next two...
const fillCopies = (indent) => {
  const out = [];
  for (let n = 32; n < 576 * 32; n *= 2) out.push(`${indent}mcopy(add(canvas, ${n}), canvas, ${Math.min(n, 576 * 32 - n)})`);
  return out.join("\n");
};

// ---------------------------------------------------------------- vectors

const SEED = BigInt(keccakText("MineWorld Crafters test vectors"));
const TOKEN_IDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 50, 99, 100, 101, 256, 333, 500, 666, 777, 1000, 1024, 1111, 1234, 1500, 1666, 1667, 2000, 2048, 2222, 2500, 2718, 3000, 3141, 3300, 3331, 3332, 3333].filter((id) => id <= SUPPLY);
// Looks chosen to draw every option of every trait at least once: each hair bare and under a hat, every hat, outfit,
// eye colour, gaze, background, skin and blush; plus the gold background under the yellow hard hat (same colour).
const LOOKS = [];
const H = COUNT.hair, nHats = COUNT.hat;
for (let i = 0; i < 2 * H; i++) {
  LOOKS.push({
    hair: i % H, outfit: (i * 5) % COUNT.outfit, eyes: (i * 5) % COUNT.eyes, gaze: (i >> 1) & 1,
    background: (i * 3) % COUNT.background, skin: (i * 2) % COUNT.skin,
    hat: i < H ? HATS.findIndex((h) => !h.mask) : 1 + ((i - H) % (nHats - 1)), blush: i % 3 === 0 ? 1 : 0,
  });
}
const gold = BACKGROUNDS.findIndex((b) => b.name === "Gold"), yellow = HATS.findIndex((h) => h.name === "Hard Hat Yellow");
if (gold >= 0 && yellow >= 0) LOOKS.push({ hair: 0, outfit: 0, eyes: 0, gaze: 0, background: gold, skin: 0, hat: yellow, blush: 0 });
for (const f of FIELDS) {
  const seen = new Set(LOOKS.map((t) => t[f]));
  assert(seen.size === COUNT[f], `the looks must cover every ${f}`);
}
const ordered = (t) => FIELDS.map((f) => t[f]);

function check(t, where) {
  const svg = RULES.svg(t);
  const mine = contractSvg(pxRgb(RULES.pixels(t)), rgb(BACKGROUNDS[t.background].color, "background"));
  assert(mine === svg, `${where}: the contract's SVG writer doesn't match svgOf()`);
  return svg;
}
const tokens = TOKEN_IDS.map((id) => {
  const t = RULES.traitsOf(SEED, id, hash);
  assert(FIELDS.every((f) => Number.isInteger(t[f]) && t[f] >= 0 && t[f] < COUNT[f]), `token ${id}: traits out of range`);
  const svg = check(t, `token ${id}`);
  return { id, t, rarity: rarityOf(t), svg: keccakText(svg), svgLength: svg.length, attributes: keccakText(attributesJson(t)) };
});
const looks = LOOKS.map((t, i) => {
  const svg = check(t, `look ${i}`);
  return { t, rarity: rarityOf(t), svg: keccakText(svg), svgLength: svg.length, attributes: keccakText(attributesJson(t)) };
});
assert(new Set(looks.map((x) => x.rarity)).size === RARITIES.length, "the looks must cover every rarity");
const sealedSvg = RULES.sealedSvg();
{
  const px = Array(N * N).fill(rgb(SEALED.background, "SEALED.background"));
  for (const [pos, ch] of pixelsOf.sealed) px[pos] = resolveSealed(ch)[1];
  assert(contractSvg(px, rgb(SEALED.background, "SEALED.background")) === sealedSvg, "the sealed picture: the contract's SVG writer doesn't match sealedSvg()");
}
// Sanity: the whole supply under the vector seed takes 3,333 different hair x outfit x eyes x gaze combinations. And
// each token's rarity, by the table, matches rarityOf(): their counts and the whole run of them are vectors too.
const rarityCounts = RARITIES.map(() => 0);
const raritySequence = [];
{
  const seen = new Set();
  for (let id = 1; id <= SUPPLY; id++) {
    const t = RULES.traitsOf(SEED, id, hash);
    seen.add(`${t.hair},${t.outfit},${t.eyes},${t.gaze}`);
    const r = rarityOf(t);
    assert(r === RARITY[t.background][t.hat], `token ${id}: rarityOf doesn't match the table`);
    rarityCounts[r]++;
    raritySequence.push(r);
  }
  assert(seen.size === SUPPLY, "traitsOf gave two tokens the same hair, outfit, eyes and gaze");
}

// ---------------------------------------------------------------- Solidity

const hexLines = (bytes, indent) => {
  const lines = [];
  for (let i = 0; i < bytes.length; i += 48) lines.push(`${indent}hex"${Buffer.from(bytes.slice(i, i + 48)).toString("hex")}"`);
  return lines.join("\n");
};
/// Weights packed 16 bits each, the first option lowest (written 0x<last>_..._<first>, padded to 16 options: a 40-digit
/// hex literal would be an address in Solidity).
const packWeights = (list) => "0x" + [...list.map((o) => o.w), ...Array(16 - list.length).fill(0)].map((w) => w.toString(16).padStart(4, "0")).reverse().join("_");
const total = (list) => list.reduce((t, o) => t + o.w, 0);
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
const fieldDoc = { hair: "HAIRS", outfit: "OUTFITS", eyes: "EYES", gaze: "0 left, 1 right", background: "BACKGROUNDS", skin: "SKINS", hat: "HATS (0 None)", blush: "BLUSHES" };
const rarityDoc = RARITIES.map((n, r) => `${r} ${n} ${pct(rarityOdds[r])}`).join(", ");
const kindOfField = Object.fromEntries(fieldOf.map((f, k) => [f, k]));
const pieces = ALL_KINDS.map((kind, k) => (k === 0 ? `[{"trait_type":"${kind}","value":"` : `"},{"trait_type":"${kind}","value":"`));
const noHat = HATS.findIndex((h) => !h.mask);
const HIDE_FROM = 8 * N; // a hat hides the hair above row 8
const head = words(SVG_HEAD);
const mstores = (ws, indent) => ws.map((w, i) => `${indent}mstore(${i ? `add(p, ${i * 32})` : "p"}, ${w})`).join("\n");

const art = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

// GENERATED by tools/gen-crafter-art.mjs from web/crafters-art.js and web/crafters.js: don't edit by hand. Change the
// JS, then run \`~/.local/node/bin/node tools/gen-crafter-art.mjs\` and \`forge test\` (which checks this art against
// pictures drawn by the JS).

/// @notice A Crafter's traits: indexes into the tables of web/crafters-art.js, named and ordered as traitsOf returns
///         them in web/crafters.js.
struct Traits {
${FIELDS.map((f) => `    /// @dev ${fieldDoc[f]} (${COUNT[f]})\n    uint8 ${f};`).join("\n")}
}

/// @notice The numbers and weighted picks behind a Crafter's traits, as in web/crafters.js.
library CrafterRules {
    uint256 internal constant SUPPLY = ${SUPPLY};
${FIELDS.map((f) => `    uint256 internal constant ${{ hair: "HAIRS", outfit: "OUTFITS", eyes: "EYES", gaze: "GAZES", background: "BACKGROUNDS", skin: "SKINS", hat: "HATS", blush: "BLUSHES" }[f]} = ${COUNT[f]};`).join("\n")}
    /// @notice Hair x outfit x eyes x gaze: the shuffle gives every token a different one.
    uint256 internal constant COMBOS = ${COMBOS};

${wrap(`Weighted pick of x % ${total(BACKGROUNDS)}: ${weightDoc(BACKGROUNDS)}.`, "    /// @notice ", "    ///         ")}
    function background(uint256 x) internal pure returns (uint8) {
        return _pick(x, ${packWeights(BACKGROUNDS)}, ${BACKGROUNDS.length}, ${total(BACKGROUNDS)});
    }

${wrap(`Weighted pick of x % ${total(SKINS)}: ${weightDoc(SKINS)}.`, "    /// @notice ", "    ///         ")}
    function skin(uint256 x) internal pure returns (uint8) {
        return _pick(x, ${packWeights(SKINS)}, ${SKINS.length}, ${total(SKINS)});
    }

${wrap(`Weighted pick of x % ${total(HATS)}: ${weightDoc(HATS)}.`, "    /// @notice ", "    ///         ")}
    function hat(uint256 x) internal pure returns (uint8) {
        return _pick(x, ${packWeights(HATS)}, ${HATS.length}, ${total(HATS)});
    }

${wrap(`Weighted pick of x % ${total(BLUSHES)}: ${weightDoc(BLUSHES)}.`, "    /// @notice ", "    ///         ")}
    function blush(uint256 x) internal pure returns (uint8) {
        return _pick(x, ${packWeights(BLUSHES)}, ${BLUSHES.length}, ${total(BLUSHES)});
    }

${wrap(`rarityOf() in web/crafters.js: ${rarityDoc} (by the weights). It depends on the background and the hat alone, so it's kept as a table of the two: 2 bits each, at 2 * (background * ${COUNT.hat} + hat).`, "    /// @notice ", "    ///         ")}
    uint256 internal constant RARITIES = ${RARITIES.length};

${wrap(`The rarity (${RARITIES.map((n, r) => `${r} ${n}`).join(", ")}) of a Crafter with background \`bg\` and hat \`hatIndex\`. Indexes past their tables give nonsense: callers check them first.`, "    /// @notice ", "    ///         ")}
    function rarity(uint256 bg, uint256 hatIndex) internal pure returns (uint8) {
        // (64 hex digits: 40 would make an address literal)
        return uint8((0x${rarityTable.toString(16).padStart(64, "0")} >> (2 * (bg * ${COUNT.hat} + hatIndex))) & 3);
    }

    /// @dev pick() in web/crafters.js: \`x % total\`, walked through the weights (16 bits each, first option lowest).
    function _pick(uint256 x, uint256 weights, uint256 n, uint256 total) private pure returns (uint8) {
        uint256 r = x % total;
        for (uint256 i; i + 1 < n; ++i) {
            uint256 w = (weights >> (16 * i)) & 0xffff;
            if (r < w) return uint8(i);
            r -= w;
        }
        return uint8(n - 1);
    }
}

/// @title CrafterArt
/// @notice MineWorld Crafters' pictures, drawn on chain: every Crafter as a 24 x 24 pixel-art SVG, painted layer by
///         layer from the masks and palettes of web/crafters-art.js (outfit, face, ink, eyes, blush, hair, hat) and
///         written exactly as svgOf() in web/crafters.js writes it. Also the sealed picture shown before the reveal,
///         the trait names marketplaces list, and each Crafter's rarity. Holds no state and has no owner.
contract CrafterArt {
    /// @notice A trait index past the end of its table.
    error BadTraits();

    /// @dev The art, from web/crafters-art.js (byte offsets):
${wrap(`[${T.masks}, ${T.layers}) masks: pixels offset uint16, count uint16 (${MASK_LIST.map(([k], i) => `${i} ${k}`).join(", ")})`, "    ///      ", "    ///                 ")}
${wrap(`[${T.layers}, ${T.backgrounds}) layers: mask uint8 (255: none), palette offset uint16, palette size uint8. Hairs from ${L.hair}, outfits ${L.outfit}, hats ${L.hat}, eyes ${L.eyes} (left and right for each colour), blushes ${L.blush}, face ${L.face}, ink ${L.ink}, sealed ${L.sealed}`, "    ///      ", "    ///                 ")}
    ///      [${T.backgrounds}, ${T.skins}) backgrounds: six hex digits (ASCII)
    ///      [${T.skins}, ${T.pixels}) skins: S, s, b, six hex digits each
    ///      [${T.pixels}, ${T.palettes}) mask pixels, by position: uint16 (y * 24 + x) << 6 | role
    ///      [${T.palettes}, ${T.end}) palettes, one entry per role the mask uses: role, how (0 the colour, 1-3 the
    ///                 skin's S, s or b, 4 nothing), colour (six hex digits)
${wrap(`Roles: ${ROLES.map((r, i) => `${i} ${r}`).join(", ")}.`, "    ///      ", "    ///      ")}
    bytes private constant ART =
${hexLines(blob, "        ")};

${wrap(`The trait names, back to back (${ALL_KINDS.map((k, i) => `${k} from ${nameBase[i]}`).join(", ")}), and where each one ends (uint16).`, "    /// @dev ", "    ///      ")}
    bytes private constant NAMES =
${flatNames.reduce((lines, n) => {
    const last = lines.length - 1;
    if (last >= 0 && (lines[last] + n).length <= 100) lines[last] += n;
    else lines.push(n);
    return lines;
  }, []).map((l) => `        "${l}"`).join("\n")};
    bytes private constant NAME_ENDS =
${hexLines(nameEnds.flatMap((e) => [e >> 8, e & 255]), "        ")};

    /// @notice The Crafter's picture: an SVG of 24 x 24 pixels, the same bytes as svg(traits) in web/crafters.js.
    function render(Traits calldata t) external pure returns (string memory) {
        _check(t);
        bytes memory art = ART;
        uint256 back = _colour(art, ${T.backgrounds} + 6 * uint256(t.background));
        uint256 canvas = _canvas(back);
        _skin(art, canvas, ${T.skins} + 18 * uint256(t.skin));
        _layer(art, canvas, ${L.outfit} + uint256(t.outfit), 0);
        _layer(art, canvas, ${L.face}, 0);
        _layer(art, canvas, ${L.ink}, 0);
        _layer(art, canvas, ${L.eyes} + 2 * uint256(t.eyes) + uint256(t.gaze), 0);
        _layer(art, canvas, ${L.blush} + uint256(t.blush), 0);
        bool hat = _hasMask(art, ${L.hat} + uint256(t.hat));
        // A hat hides the hair above row 8.
        _layer(art, canvas, ${L.hair} + uint256(t.hair), hat ? ${HIDE_FROM} : 0);
        if (hat) _layer(art, canvas, ${L.hat} + uint256(t.hat), 0);
        return _svg(canvas, back);
    }

    /// @notice The sealed Crafter shown before the reveal (sealedSvg() in web/crafters.js).
    function sealedSvg() external pure returns (string memory) {
        bytes memory art = ART;
        uint256 back = ${colourWord(SEALED.background.slice(1))}; // ${SEALED.background.slice(1)}"/>
        uint256 canvas = _canvas(back);
        _layer(art, canvas, ${L.sealed}, 0);
        return _svg(canvas, back);
    }

    /// @notice The traits as marketplaces list them: a JSON array of {"trait_type", "value"} in the order of
    ///         attributes() in web/crafters.js (${ALL_KINDS.join(", ")}).
    function attributes(Traits calldata t) external pure returns (string memory) {
        _check(t);
        bytes memory names = NAMES;
        bytes memory ends = NAME_ENDS;
        return string.concat(
${KINDS.map((kind, k) => `            '${pieces[k]}',\n            _name(names, ends, ${nameBase[k]} + uint256(t.${fieldOf[k]})),`).join("\n")}
            '${pieces[KINDS.length]}',
            _name(names, ends, ${nameBase[KINDS.length]} + uint256(CrafterRules.rarity(t.background, t.hat))),
            '"}]'
        );
    }

    /// @notice A Crafter's rarity: ${RARITIES.map((n, r) => `${r} ${n}`).join(", ")} (rarityOf() in web/crafters.js).
    function rarityOf(Traits calldata t) external pure returns (uint8) {
        _check(t);
        return CrafterRules.rarity(t.background, t.hat);
    }

    /// @notice A trait's name: \`kind\` in the attributes' order (${ALL_KINDS.map((k, i) => `${i} ${k}`).join(", ")}).
    function traitName(uint256 kind, uint256 index) external pure returns (string memory) {
        if (kind >= ${ALL_KINDS.length}) revert BadTraits();
        uint256 first = (0x${[...nameBase].reverse().map((b) => b.toString(16).padStart(4, "0")).join("_")} >> (16 * kind)) & 0xffff;
        uint256 count = (0x${ALL_KINDS.map((_, k) => kindCount(k)).reverse().map((b) => b.toString(16).padStart(4, "0")).join("_")} >> (16 * kind)) & 0xffff;
        if (index >= count) revert BadTraits();
        return _name(NAMES, NAME_ENDS, first + index);
    }

    function _check(Traits calldata t) private pure {
        if (
${FIELDS.map((f) => `            t.${f} >= ${COUNT[f]}`).join(" ||\n")}
        ) revert BadTraits();
    }

    /// @dev A colour as the picture holds it: its six hex digits and the \`"/>\` that ends its rect, left-aligned in
    ///      a word, so the SVG writer copies it as it is. (One word per colour: equal words are equal colours.)
    function _colour(bytes memory art, uint256 at) private pure returns (uint256 c) {
        assembly ("memory-safe") {
            c := or(and(mload(add(add(art, 32), at)), ${HEX_MASK}), ${END_WORD})
        }
    }

    function _hasMask(bytes memory art, uint256 layer) private pure returns (bool yes) {
        assembly ("memory-safe") {
            yes := iszero(eq(byte(0, mload(add(add(art, 32), add(${T.layers}, shl(2, layer))))), 255))
        }
    }

    /// @dev Memory for the picture: 576 pixels (a colour word each, row by row), then 64 palette slots (one per
    ///      role), then the skin's S, s and b. Every pixel starts as the background.
    function _canvas(uint256 back) private pure returns (uint256 canvas) {
        assembly ("memory-safe") {
            canvas := mload(0x40)
            mstore(0x40, add(canvas, ${(576 + 64 + 3) * 32}))
            mstore(canvas, back)
${fillCopies("            ")}
        }
    }

    function _skin(bytes memory art, uint256 canvas, uint256 at) private pure {
        uint256 S = _colour(art, at);
        uint256 s = _colour(art, at + 6);
        uint256 b = _colour(art, at + 12);
        assembly ("memory-safe") {
            let skin := add(canvas, ${(576 + 64) * 32})
            mstore(skin, S)
            mstore(add(skin, 32), s)
            mstore(add(skin, 64), b)
        }
    }

    /// @dev paint() in web/crafters.js: resolve the layer's palette, then paint its mask's pixels from position
    ///      \`from\` on (a pixel whose role resolves to nothing is left as it is).
    function _layer(bytes memory art, uint256 canvas, uint256 layer, uint256 from) private pure {
        assembly ("memory-safe") {
            let data := add(art, 32)
            let pal := add(canvas, ${576 * 32})
            let skin := add(pal, ${64 * 32})
            let rec := mload(add(data, add(${T.layers}, shl(2, layer))))
            let p := add(data, or(shl(8, byte(1, rec)), byte(2, rec)))
            for { let end := add(p, shl(3, byte(3, rec))) } lt(p, end) { p := add(p, 8) } {
                let e := mload(p)
                let how := byte(1, e)
                let c := 0
                switch how
                case 0 { c := or(and(shl(16, e), ${HEX_MASK}), ${END_WORD}) }
                case 4 {}
                default { c := mload(add(skin, shl(5, sub(how, 1)))) }
                mstore(add(pal, shl(5, byte(0, e))), c)
            }
            let m := mload(add(data, shl(2, byte(0, rec))))
            let q := add(data, shr(240, m))
            for { let end := add(q, shl(1, and(shr(224, m), 0xffff))) } lt(q, end) { q := add(q, 2) } {
                let e := shr(240, mload(q))
                let pos := shr(6, e)
                if iszero(lt(pos, from)) {
                    let c := mload(add(pal, shl(5, and(e, 63))))
                    if c { mstore(add(canvas, shl(5, pos)), c) }
                }
            }
        }
    }

    /// @dev svgOf() in web/crafters.js: the background, then each row's runs of one colour (the background's runs
    ///      left out). Written in place into one buffer, a few words at a time: \`<rect x="X\` and \`W" height="1"
    ///      fill="#\` come from tables made once (their length in the low byte), \`" y="Y" width="\` once a row,
    ///      and the colour words already end with \`"/>\`.
    function _svg(uint256 canvas, uint256 back) private pure returns (string memory svg) {
        assembly ("memory-safe") {
            /// v (0-99) as decimal digits starting at byte \`at\` of a word, and how many.
            function digits(v, at) -> d, n {
                let shift := sub(248, shl(3, at))
                switch lt(v, 10)
                case 1 {
                    d := shl(shift, add(48, v))
                    n := 1
                }
                default {
                    d := or(shl(shift, add(48, div(v, 10))), shl(sub(shift, 8), add(48, mod(v, 10))))
                    n := 2
                }
            }
            let xs := mload(0x40) // by x (0-23): ${RECT_X}X
            let ws := add(xs, 800) // by width (1-24): W${RECT_FILL}
            svg := add(ws, 800)
            for { let i := 0 } lt(i, 25) { i := add(i, 1) } {
                let d, n := digits(i, ${RECT_X.length})
                mstore(add(xs, shl(5, i)), or(or(${word(RECT_X)}, d), add(${RECT_X.length}, n)))
                d, n := digits(i, 0)
                mstore(add(ws, shl(5, i)), or(or(d, shr(shl(3, n), ${word(RECT_FILL)})), add(n, ${RECT_FILL.length})))
            }
            let p := add(svg, 32)
            // ${SVG_HEAD}
${mstores(head, "            ")}
            mstore(add(p, ${SVG_HEAD.length}), back)
            p := add(p, ${SVG_HEAD.length + 6 + SVG_HEAD_END.length})
            for { let y := 0 } lt(y, 24) { y := add(y, 1) } {
                let d, n := digits(y, ${RECT_Y.length})
                // ${RECT_Y}Y${RECT_W}
                let yw := or(or(${word(RECT_Y)}, d), shr(shl(3, add(${RECT_Y.length}, n)), ${word(RECT_W)}))
                let yn := add(${RECT_Y.length + RECT_W.length}, n)
                let row := add(canvas, mul(y, 768))
                let rowEnd := add(row, 768)
                for { let q := row } lt(q, rowEnd) {} {
                    let c := mload(q)
                    let r := add(q, 32)
                    for {} and(lt(r, rowEnd), eq(mload(r), c)) {} { r := add(r, 32) }
                    if iszero(eq(c, back)) {
                        let xw := mload(add(xs, sub(q, row)))
                        mstore(p, xw)
                        p := add(p, and(xw, 0xff))
                        mstore(p, yw)
                        p := add(p, yn)
                        let ww := mload(add(ws, sub(r, q)))
                        mstore(p, ww)
                        p := add(p, and(ww, 0xff))
                        mstore(p, c)
                        p := add(p, ${6 + RECT_END.length})
                    }
                    q := r
                }
            }
            mstore(p, ${word(SVG_END)}) // ${SVG_END}
            p := add(p, ${SVG_END.length})
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

const traitsSol = (t) => `Traits(${ordered(t).join(", ")})`;
const fileHash = (rel) => keccak256(readFileSync(join(ROOT, rel)));
const vectors = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

// GENERATED by tools/gen-crafter-art.mjs: don't edit by hand. Pictures, traits and names worked out by the JS
// (web/crafters.js, web/crafters-art.js); CrafterArt.t.sol checks the contracts give the same.

import {Traits} from "../src/CrafterArt.sol";

library CrafterVectors {
    /// @notice keccak256 of each source file when this was generated: forge test fails once one changes, until
    ///         \`~/.local/node/bin/node tools/gen-crafter-art.mjs\` is run again.
${Object.entries(SOURCES).map(([k, rel]) => `    bytes32 internal constant ${k} = ${fileHash(rel)}; // ${rel}`).join("\n")}

    /// @notice The seed the token vectors were worked out with (keccak256("MineWorld Crafters test vectors")).
    uint256 internal constant SEED = ${"0x" + SEED.toString(16).padStart(64, "0")};

    /// @notice keccak256 of sealedSvg() (${sealedSvg.length} bytes).
    bytes32 internal constant SEALED_SVG = ${keccakText(sealedSvg)};

    /// @notice keccak256 of the names, back to back, of each trait (in the attributes' order).
${ALL_KINDS.map((k, i) => `    bytes32 internal constant ${k.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_NAMES = ${keccakText(NAMES[i].join("|"))}; // "|"-joined, ${NAMES[i].length}`).join("\n")}

    /// @notice How many of the ${SUPPLY} Crafters under SEED have each rarity (${RARITIES.join(", ")}).
    function rarityCounts() internal pure returns (uint256[${RARITIES.length}] memory) {
        return [${rarityCounts.map((c, i) => (i === 0 ? `uint256(${c})` : `${c}`)).join(", ")}];
    }

    /// @notice keccak256 of every Crafter's rarity under SEED, one byte each, from #1 to #${SUPPLY}.
    bytes32 internal constant RARITY_SEQUENCE = ${toHex(keccakBytes(Uint8Array.from(raritySequence)))};

    struct Token {
        uint256 id;
        Traits traits;
        uint8 rarity; // rarityOf(traits)
        bytes32 svg; // keccak256 of svg(traits)
        uint256 svgLength;
        bytes32 attributes; // keccak256 of the attributes JSON array
    }

    struct Look {
        Traits traits;
        uint8 rarity;
        bytes32 svg;
        uint256 svgLength;
        bytes32 attributes;
    }

    /// @notice ${tokens.length} tokens under SEED: traitsOf(SEED, id), and their pictures.
    function tokens() internal pure returns (Token[] memory v) {
        v = new Token[](${tokens.length});
${tokens.map((x, i) => `        v[${i}] = Token(${x.id}, ${traitsSol(x.t)}, ${x.rarity}, ${x.svg}, ${x.svgLength}, ${x.attributes});`).join("\n")}
    }

    /// @notice ${looks.length} looks that between them draw every option of every trait, and every rarity.
    function looks() internal pure returns (Look[] memory v) {
        v = new Look[](${looks.length});
${looks.map((x, i) => `        v[${i}] = Look(${traitsSol(x.t)}, ${x.rarity}, ${x.svg}, ${x.svgLength}, ${x.attributes});`).join("\n")}
    }
}
`;

// ---------------------------------------------------------------- write, or check

const outputs = [[OUT_ART, art], [OUT_VECTORS, vectors]];
const lengths = [...tokens, ...looks].map((x) => x.svgLength);
const rarityNote = RARITIES.map((n, r) => `${n} ${rarityCounts[r]}`).join(", ");
const summary = `rarity over the ${SUPPLY} under the vector seed: ${rarityNote} (odds ${rarityOdds.map(pct).join(" / ")}); art data ${blob.length} bytes (${MASK_LIST.length} masks, ${Object.values(pixelsOf).reduce((t, p) => t + p.length, 0)} pixels, ${palettes.length} palettes, ${layers.length} layers), names ${nameText.length} bytes; ${tokens.length} token and ${looks.length} look vectors, SVGs ${Math.min(...lengths)}-${Math.max(...lengths)} bytes, sealed ${sealedSvg.length}`;
if (process.argv.includes("--check")) {
  const stale = outputs.filter(([rel, text]) => {
    try {
      return readFileSync(join(ROOT, rel), "utf8") !== text;
    } catch {
      return true;
    }
  });
  if (stale.length) fail(`${stale.map(([rel]) => rel).join(" and ")} ${stale.length > 1 ? "are" : "is"} stale: run ~/.local/node/bin/node tools/gen-crafter-art.mjs`);
  console.log(`CrafterArt.sol and CrafterVectors.sol are up to date (${summary})`);
} else {
  for (const [rel, text] of outputs) writeFileSync(join(ROOT, rel), text);
  console.log(`wrote ${OUT_ART} and ${OUT_VECTORS}: ${summary}`);
  if (unusedNote.length) console.log(`(colours no mask pixel uses: ${unusedNote.join(", ")})`);
}
