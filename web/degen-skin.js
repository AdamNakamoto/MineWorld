// I'M DEGEN as Minecraft skins: which traits a token has, its 64 x 64 skin (the standard layout, classic 4-pixel arms,
// with the second layer: hat, jacket, sleeves and trousers), and its pictures: the NFT card (an isometric render of the
// character standing, the way skin sites show a skin) and a front view for small icons. The game puts the very same
// skin on your miner (avatar.js), so the NFT and the character you play look alike pixel for pixel.
//
// Traits come from the seed revealed after the mint (MineWorldCrafters' commit-reveal): the token's place in a keyed
// shuffle picks its face (eyes, mouth, cheeks) and top, a different one of the combinations for every token, so no two
// DEGENs look alike; the background, skin, bottoms, shoes, headwear and accessory are weighted picks from the token's
// own hash. Pass viem's keccak256 and encodeAbiParameters (`hash`), so this file runs in the browser and in the Worker
// alike.
//
// Everything is integers and small tables (degen-skin-art.js), with no randomness but the trait picks, so the contract
// paints the same pixels and writes the same SVG: contracts/src/CrafterArt.sol is generated from these two files by
// tools/gen-degen-art.mjs, and forge test checks the two agree on every trait, skin and card.

import {
  FIXED, BACKGROUNDS, SKINS, FROG, EYES, MOUTHS, CHEEKS, TOP_STYLES, TOPS, ROOKIE_TOP, BOTTOM_STYLES, BOTTOMS,
  SHOE_STYLES, SHOES, HEAD_STYLES, HEADWEAR, ACCESSORY_STYLES, ACCESSORIES, SEALED,
} from "./degen-skin-art.js";

export const SUPPLY = 3333;
/// The face-and-top combinations the shuffle spreads the tokens over (one each, at most).
export const COMBOS = EYES.length * MOUTHS.length * CHEEKS.length * TOPS.length;
if (COMBOS < SUPPLY) throw new Error(`I'M DEGEN: only ${COMBOS} face-and-top combinations for ${SUPPLY} tokens`);
/// The hood (a headwear never picked by weight) and how often a hoodie with nothing else on the head has it up: one
/// time in HOOD_ONE_IN.
export const HOOD = HEADWEAR.findIndex((h) => h.style === "hood"), HOOD_ONE_IN = 3;
const NONE = 0; // (HEADWEAR[0] and ACCESSORIES[0] are "None")

const total = (list) => list.reduce((t, o) => t + o.w, 0);
function pick(list, x) {
  let r = x % total(list);
  for (let i = 0; i < list.length; i++) {
    if (r < list[i].w) return i;
    r -= list[i].w;
  }
  return list.length - 1;
}

/// The token's place in the shuffled run (0 .. SUPPLY-1): a 4-round Feistel network on 12 bits, repeated until it lands
/// inside the supply, keyed by the seed (the same as the contract's).
export function shuffle(seed, x, { keccak256, encodeAbiParameters }) {
  const round = (i, r) => Number(BigInt(keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }], [seed, BigInt(i), BigInt(r)]))) & 63n);
  do {
    let l = x >> 6, r = x & 63;
    for (let i = 0; i < 4; i++) [l, r] = [r, l ^ round(i, r)];
    x = (l << 6) | r;
  } while (x >= SUPPLY);
  return x;
}

/// Token `id`'s traits (indexes into the tables in degen-skin-art.js), once the seed is known.
export function traitsOf(seed, id, hash) {
  seed = BigInt(seed);
  id = Number(id);
  if (!Number.isInteger(id) || id < 1 || id > SUPPLY) throw new Error(`No I'M DEGEN #${id}`);
  const v = shuffle(seed, id - 1, hash);
  const c = Math.floor((v * COMBOS) / SUPPLY);
  const h = BigInt(hash.keccak256(hash.encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [seed, BigInt(id)])));
  const slice = (k) => Number((h >> BigInt(k)) & 0xffffn);
  const E = EYES.length, M = MOUTHS.length, C = CHEEKS.length;
  const t = {
    background: pick(BACKGROUNDS, slice(0)),
    skin: pick(SKINS, slice(16)),
    eyes: c % E,
    mouth: Math.floor(c / E) % M,
    cheeks: Math.floor(c / (E * M)) % C,
    top: Math.floor(c / (E * M * C)),
    bottoms: pick(BOTTOMS, slice(32)),
    shoes: pick(SHOES, slice(48)),
    headwear: pick(HEADWEAR, slice(64)),
    accessory: pick(ACCESSORIES, slice(80)),
  };
  // A hoodie with nothing else on the head has its hood up a third of the time.
  if (TOPS[t.top].style === "hoodie" && t.headwear === NONE && slice(96) % HOOD_ONE_IN === 0) t.headwear = HOOD;
  return t;
}

/// Rarity (rarityOf gives an index into this list).
export const RARITIES = ["Common", "Rare", "Legendary"];

/// A DEGEN's rarity, from what you can see: Legendary with a gold skin, a crown or gold armour; Rare with an ice,
/// purple or stone skin, a royal robe, a space suit, iron armour, a wizard hat or a viking helmet; Common otherwise.
/// (The highest tier among the skin, the top, the headwear and the accessory: their `tier` in degen-skin-art.js.)
export function rarityOf(t) {
  return Math.max(SKINS[t.skin].tier ?? 0, TOPS[t.top].tier ?? 0, HEADWEAR[t.headwear].tier ?? 0, ACCESSORIES[t.accessory].tier ?? 0);
}

/// The traits as marketplaces list them, then the rarity. Bottoms and shoes are left out when the top hides them
/// (matching trousers, a space suit's boots).
export function attributes(t) {
  const top = TOPS[t.top], style = TOP_STYLES[top.style];
  const a = [
    ["Background", BACKGROUNDS[t.background].name], ["Skin", SKINS[t.skin].name], ["Eyes", EYES[t.eyes].name],
    ["Mouth", MOUTHS[t.mouth].name], ["Cheeks", CHEEKS[t.cheeks].name], ["Top", top.name],
  ];
  if (!style.legs) a.push(["Bottoms", BOTTOMS[t.bottoms].name]);
  if (!style.feet) a.push(["Shoes", SHOES[t.shoes].name]);
  a.push(["Headwear", HEADWEAR[t.headwear].name], ["Accessory", ACCESSORIES[t.accessory].name], ["Rarity", RARITIES[rarityOf(t)]]);
  return a;
}

// ---------------------------------------------------------------- the skin layout

/// The model's parts: their size (width, height, depth, in pixels) and where their two layers sit on the skin.
export const PARTS = {
  head: { size: [8, 8, 8], uv: [0, 0], over: [32, 0] },
  body: { size: [8, 12, 4], uv: [16, 16], over: [16, 32] },
  armR: { size: [4, 12, 4], uv: [40, 16], over: [40, 32] },
  armL: { size: [4, 12, 4], uv: [32, 48], over: [48, 48] },
  legR: { size: [4, 12, 4], uv: [0, 16], over: [0, 32] },
  legL: { size: [4, 12, 4], uv: [16, 48], over: [0, 48] },
};
/// Where each face of a part is, from its corner on the skin, and its size: Minecraft's box layout (the top and the
/// underside above, then the right, front, left and back sides in a row).
export function faceBox([w, h, d], face) {
  switch (face) {
    case "T": return [d, 0, w, d];
    case "U": return [d + w, 0, w, d];
    case "R": return [0, d, d, h];
    case "F": return [d, d, w, h];
    case "L": return [d + w, d, d, h];
    case "K": return [2 * d + w, d, w, h];
  }
  throw new Error(`No face ${face}`);
}

/// What each target in the art paints: [parts, layer]. A second part is the first's mirror image.
const TARGETS = {
  head: [["head"], 0], hat: [["head"], 1], body: [["body"], 0], jacket: [["body"], 1],
  arms: [["armR", "armL"], 0], sleeves: [["armR", "armL"], 1], legs: [["legR", "legL"], 0], pants: [["legR", "legL"], 1],
  armR: [["armR"], 0], armL: [["armL"], 0], sleeveR: [["armR"], 1], sleeveL: [["armL"], 1],
  legR: [["legR"], 0], legL: [["legL"], 0], pantsR: [["legR"], 1], pantsL: [["legL"], 1],
};

/// A layer's operations (degen-skin-art.js) as rectangles on the skin: [x, y, w, h, colour code] (colour "." clears).
/// Compiled once each.
const compiled = new Map();
export function compile(src) {
  if (compiled.has(src)) return compiled.get(src);
  const out = [];
  for (const line of src.split(/[\n;]/)) {
    const tok = line.trim().split(/\s+/);
    if (!tok[0]) continue;
    let [target, faces, ...rest] = tok;
    const mirror = target.endsWith("~");
    if (mirror) target = target.slice(0, -1);
    const T = TARGETS[target];
    if (!T) throw new Error(`degen-skin-art: no target "${target}" in "${line.trim()}"`);
    const mask = rest[rest.length - 1].startsWith(":") ? rest.pop().slice(1).split("/") : null;
    // The pieces in the face's own space: [x, y, w, h, colour].
    let pieces;
    if (mask) {
      pieces = [];
      const x0 = Number(rest[0]), y0 = Number(rest[1]);
      mask.forEach((row, r) => {
        for (let i = 0; i < row.length;) {
          let n = 1;
          while (i + n < row.length && row[i + n] === row[i]) n++;
          if (row[i] !== ".") pieces.push([x0 + i, y0 + r, n, 1, row[i]]);
          i += n;
        }
      });
    } else {
      if (rest.length !== 5) throw new Error(`degen-skin-art: "${line.trim()}" needs x y w h colour`);
      pieces = [[rest[0], rest[1], rest[2], rest[3], rest[4]]];
    }
    const parts = T[0].map((p, i) => [p, i > 0]);
    if (mirror) parts.push([T[0][0], true]);
    for (const [part, mirrored] of parts) {
      const P = PARTS[part], [w, h, d] = P.size;
      for (let f of faces) {
        f = f === "O" ? "R" : f === "I" ? "L" : f;
        // The face's (or the band of four sides') size, to resolve "*" and negative positions.
        const [fw, fh] = f === "S" ? [2 * d + 2 * w, h] : faceBox(P.size, f).slice(2);
        for (const [px, py, pw, ph, c] of pieces) {
          const x = num(px, fw), y = num(py, fh);
          const rw = pw === "*" ? fw - x : Number(pw), rh = ph === "*" ? fh - y : Number(ph);
          // Split a band into its four faces.
          const onFaces = f !== "S" ? [[f, x, rw]] : [["R", 0, d], ["F", d, w], ["L", d + w, d], ["K", 2 * d + w, w]]
            .map(([g, at, gw]) => [g, Math.max(x, at) - at, Math.min(x + rw, at + gw) - Math.max(x, at)]).filter((p) => p[2] > 0);
          for (let [g, gx, gw] of onFaces) {
            const box = faceBox(P.size, g);
            if (mirrored) {
              gx = box[2] - gx - gw;
              if (g === "R" || g === "L") {
                g = g === "R" ? "L" : "R";
                box.splice(0, 4, ...faceBox(P.size, g));
              }
            }
            const [bu, bv, bw, bh] = box;
            const cx = Math.max(0, gx), cy = Math.max(0, y), cw = Math.min(bw, gx + gw) - cx, ch = Math.min(bh, y + rh) - cy;
            if (cw <= 0 || ch <= 0) continue;
            const [u, v] = T[1] ? P.over : P.uv, r = [u + bu + cx, v + bv + cy, cw, ch, c], last = out[out.length - 1];
            // (Side by side with the one before, in the same colour and rows: one rectangle. A band's faces lie side
            // by side on the skin, so a band is mostly one.)
            if (last && last[1] === r[1] && last[3] === r[3] && last[4] === r[4] && last[0] + last[2] === r[0]) last[2] += r[2];
            else out.push(r);
          }
        }
      }
    }
  }
  compiled.set(src, out);
  return out;
}
const num = (s, size) => {
  const n = Number(s);
  if (!Number.isInteger(n)) throw new Error(`degen-skin-art: "${s}" isn't a whole number`);
  return n < 0 ? size + n : n;
};

const hex = (c) => parseInt(c.slice(1), 16);
/// Paints a layer onto `px` (64 x 64 colours, -1 where empty): its rectangles, in the colours of `palette`, then the
/// skin's, then the fixed ones.
function paint(px, src, palette, skin) {
  for (const [x, y, w, h, c] of compile(src)) {
    let col = -1;
    if (c !== ".") {
      const v = palette?.[c] ?? skin[c] ?? FIXED[c];
      if (!v) throw new Error(`degen-skin-art: no colour "${c}"`);
      col = hex(v);
    }
    for (let j = y; j < y + h; j++) px.fill(col, j * 64 + x, j * 64 + x + w);
  }
}

/// The eyes as a layer of operations, from their mask (degen-skin-art.js EYES): each eye on the base layer, and the
/// whole eye (its lid in the skin's colour) again on the hat layer, where it bulges out a little. With `ink` (a colour
/// code: shades), only the eye's dark pixels instead, on the hat layer, over the lenses.
export function eyeOps(mask, ink) {
  const ops = [];
  mask.split("/").forEach((row, r) => {
    for (let c = 0; c < 3; c++) {
      const ch = row[c];
      for (const right of [true, false]) {
        const x = right ? c : 7 - c;
        // Where this pixel goes: the top's front rows, or the face (and, for the outer column, the side of the head).
        const spots = r < 2 ? [["T", x, 6 + r]] : [["F", x, r - 2], ...(c === 0 ? [[right ? "R" : "L", right ? 7 : 0, r - 2]] : [])];
        for (const [face, fx, fy] of spots) {
          if (ink) {
            if (r >= 3 && ch !== "." && ch !== "W" && ch !== "w") ops.push(`hat ${face} ${fx} ${fy} 1 1 ${ink}`);
            continue;
          }
          if (ch !== ".") ops.push(`head ${face} ${fx} ${fy} 1 1 ${ch}`);
          ops.push(`hat ${face} ${fx} ${fy} 1 1 ${ch === "." ? "S" : ch}`);
        }
      }
    }
  });
  return ops.join("; ");
}
/// A mask on the face's rows 4 to 7 (a mouth, cheeks) as a layer.
export const faceOps = (mask) => `head F 0 4 :${mask}`;

/// The palette a look's skin codes (S s l d B) come from.
export const skinOf = (t) => (t.sealed ? SEALED.skin : SKINS[t.skin]);

/// What a look is painted from, in order: [layer (operations), palette (the option's own colours, or null)], each
/// painted over the ones before. The frog, its eyes, mouth and cheeks, then the clothes (clothesLayers). The contract
/// paints the same layers in the same order (contracts/src/CrafterArt.sol, generated from this file).
export function layersOf(t) {
  if (t.sealed) return [[FROG, null], [SEALED.ops, null]];
  const layers = [[FROG, null], [eyeOps(EYES[t.eyes].mask), null], [faceOps(MOUTHS[t.mouth].mask), null]];
  if (CHEEKS[t.cheeks].mask) layers.push([faceOps(CHEEKS[t.cheeks].mask), null]);
  return [...layers, ...clothesLayers(t)];
}

/// The clothes' layers, by their indexes in `t` (the Rookie's own top with `t.rookie`): the trousers (unless the top
/// brings its own), the top, the shoes (unless the top brings boots), the accessory (with shades, the eyes' ink over
/// the lenses), then the headwear (a hood in the hoodie's colours), so a hat sits over the glasses' frame and arms.
export function clothesLayers(t) {
  const top = t.rookie ? ROOKIE_TOP : TOPS[t.top], style = TOP_STYLES[top.style];
  const layers = [];
  if (!style.legs) layers.push([BOTTOM_STYLES[BOTTOMS[t.bottoms].style], BOTTOMS[t.bottoms].colors]);
  layers.push([style.ops, top.colors]);
  if (!style.feet) layers.push([SHOE_STYLES[SHOES[t.shoes].style], SHOES[t.shoes].colors]);
  const acc = ACCESSORIES[t.accessory];
  if (acc.style) {
    layers.push([ACCESSORY_STYLES[acc.style], acc.colors]);
    if (acc.eyes && t.eyes !== undefined) layers.push([eyeOps(EYES[t.eyes].mask, acc.eyes), acc.colors]);
  }
  const hw = HEADWEAR[t.headwear];
  if (hw.style) layers.push([HEAD_STYLES[hw.style], hw.colors ?? top.colors]);
  return layers;
}

/// DEGEN's skin as 64 x 64 colours (row by row; -1 where there's nothing, as on the second layer around the clothes),
/// painted layer by layer (layersOf).
export function skinColours(t) {
  const px = new Int32Array(64 * 64).fill(-1), skin = skinOf(t);
  for (const [src, palette] of layersOf(t)) paint(px, src, palette, skin);
  return px;
}

/// The clothes (clothesLayers) over whoever wears them: `px` as skinColours gives it, `skin` their palette. The
/// town's villagers wear them too (villager-skins.js).
export function dress(px, t, skin) {
  for (const [src, palette] of clothesLayers(t)) paint(px, src, palette, skin);
  return px;
}

/// Paints a layer of operations (the language of degen-skin-art.js) onto `px`, in the colours of `palette`, then
/// `skin`'s, then the fixed ones: for skins that aren't DEGENs (villager-skins.js).
export const paintOps = (px, src, palette, skin) => paint(px, src, palette, skin);

/// The skin as RGBA bytes (64 x 64 x 4, row by row), as a PNG of it would hold: what the game's texture is made of.
export const skinPixels = (t) => rgbaOf(skinColours(t));
/// Colours (-1 for nothing) as RGBA bytes.
export function rgbaOf(px) {
  const out = new Uint8ClampedArray(64 * 64 * 4);
  for (let i = 0; i < px.length; i++) {
    if (px[i] < 0) continue;
    out[4 * i] = px[i] >> 16;
    out[4 * i + 1] = (px[i] >> 8) & 255;
    out[4 * i + 2] = px[i] & 255;
    out[4 * i + 3] = 255;
  }
  return out;
}

/// The look of a player without a DEGEN, the Rookie: the plain frog in a plain grey hoodie.
export const ROOKIE = { rookie: true, background: 0, skin: 0, eyes: 1, mouth: 0, cheeks: 0, top: 0, bottoms: 0, shoes: 0, headwear: 0, accessory: 0 };

// ---------------------------------------------------------------- the pictures

const hex6 = (c) => `#${c.toString(16).padStart(6, "0")}`;
/// Light on the card: the tops a little brighter, the right sides darker (integer steps of 1/256, per channel).
export const LIGHT_TOP = 48, LIGHT_SIDE = 196;
const LIGHT = {
  T: (v) => v + (((255 - v) * LIGHT_TOP) >> 8),
  F: (v) => v,
  R: (v) => (v * LIGHT_SIDE) >> 8,
};
const lit = (c, face) => (LIGHT[face](c >> 16) << 16) | (LIGHT[face]((c >> 8) & 255) << 8) | LIGHT[face](c & 255);

/// Where the parts stand, in pixels (x towards DEGEN's left, y up from the feet, z towards the front): their low
/// corner.
const AT = { head: [-4, 24, -4], body: [-4, 12, -2], armR: [-8, 12, -2], armL: [4, 12, -2], legR: [-4, 0, -2], legL: [0, 0, -2] };
/// The card shows DEGEN from the front, a little to its right and above: back to front, each part's faces you can see.
const CARD_ORDER = [["legL", "F"], ["legR", "FR"], ["armL", "FT"], ["body", "F"], ["armR", "FRT"], ["head", "FRT"]];
/// The card: a square of CARD units, a pixel's x step on screen (4, -1), its z step (2, 2), its y step (0, -4).
const CARD = 176, OX = 88, OY = 152;
const sx = (x, y, z) => OX + 4 * x + 2 * z;
const sy = (x, y, z) => OY - x + 2 * z - 4 * y;

/// The faces the card draws, back to front: for each, where its pixels are on the skin (`base`, `over`: the index of
/// its top left pixel on each layer), its size, its corner on screen (X, Y) and its two edges there, along a row (a)
/// and down a column for a side, or towards the front for the top (b), how it's lit, and whether it's its part's last.
export const CARD_FACES = CARD_ORDER.flatMap(([part, faces]) => [...faces].map((face, k) => {
  const P = PARTS[part], [w, h, d] = P.size, [x0, y0, z0] = AT[part], [bu, bv, fw, fh] = faceBox(P.size, face);
  let corner, a, b;
  if (face === "F") { corner = [x0, y0 + h, z0 + d]; a = [4, -1]; b = [0, 4]; }
  if (face === "R") { corner = [x0, y0 + h, z0]; a = [2, 2]; b = [0, 4]; }
  if (face === "T") { corner = [x0, y0 + h, z0]; a = [4, -1]; b = [2, 2]; }
  return {
    part, face, fw, fh, X: sx(...corner), Y: sy(...corner), a, b, last: k === faces.length - 1,
    base: (P.uv[1] + bv) * 64 + P.uv[0] + bu, over: (P.over[1] + bv) * 64 + P.over[0] + bu,
  };
}));
/// The card's beginning (`background` as #rrggbb), up to its first part, and its end.
export const cardHead = (background) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${CARD} ${CARD}"><rect width="${CARD}" height="${CARD}" fill="${background}"/>`
  + `<ellipse cx="${OX}" cy="${OY + 2}" rx="34" ry="11" fill="#000" fill-opacity=".14"/>`;
export const CARD_TAIL = "</svg>";

/// The NFT's picture: DEGEN standing on its background, seen from a little to its right and above, as skin sites show
/// a skin. Each part's visible faces are filled with their most common colour, then every other run of one colour along
/// a row is drawn over it as a parallelogram; one path per colour per part, so it's small. Back to front, so nearer
/// parts cover farther ones. The contract writes it byte for byte the same (CrafterArt.render).
export function cardOf(px, background) {
  let out = cardHead(background);
  let fills = new Map(), runs = new Map();
  const add = (m, c, s) => m.set(c, (m.get(c) ?? "") + s);
  for (const { face, fw, fh, X, Y, a, b, last, base: b0, over: o0 } of CARD_FACES) {
    // The face's colours as you see them (the second layer where it has one, else the base), lit, and the commonest
    // (the first to appear, of those as common).
    const cols = [], count = new Map();
    for (let j = 0; j < fh; j++) for (let i = 0; i < fw; i++) {
      const o = px[o0 + j * 64 + i], c = lit(o >= 0 ? o : px[b0 + j * 64 + i], face);
      cols.push(c);
      count.set(c, (count.get(c) ?? 0) + 1);
    }
    let base = cols[0];
    for (const [c, n] of count) if (n > count.get(base)) base = c;
    add(fills, base, quad(X, Y, a[0] * fw, a[1] * fw, b[0] * fh, b[1] * fh));
    for (let j = 0; j < fh; j++) {
      for (let i = 0; i < fw;) {
        const c = cols[j * fw + i];
        let n = 1;
        while (i + n < fw && cols[j * fw + i + n] === c) n++;
        if (c !== base) add(runs, c, quad(X + a[0] * i + b[0] * j, Y + a[1] * i + b[1] * j, a[0] * n, a[1] * n, b[0], b[1]));
        i += n;
      }
    }
    if (!last) continue;
    for (const m of [fills, runs]) for (const [c, s] of m) out += `<path fill="${hex6(c)}" d="${s}"/>`;
    fills = new Map();
    runs = new Map();
  }
  return out + CARD_TAIL;
}
/// A parallelogram from (x, y) along (ax, ay) and (bx, by).
const quad = (x, y, ax, ay, bx, by) => `M${x} ${y}l${ax} ${ay}${bx ? `l${bx} ${by}` : `v${by}`}l${-ax} ${-ay}z`;

export const cardSvg = (t) => cardOf(skinColours(t), t.sealed ? SEALED.background : BACKGROUNDS[t.background].color);

/// The colour you see at pixel (x, y) of a part's face: the second layer where it has one, else the base.
function seen(px, part, face, x, y) {
  const P = PARTS[part], [bu, bv] = faceBox(P.size, face);
  const o = px[(P.over[1] + bv + y) * 64 + P.over[0] + bu + x];
  return o >= 0 ? o : px[(P.uv[1] + bv + y) * 64 + P.uv[0] + bu + x];
}

/// The front view for small icons: DEGEN square on, 16 x 32 pixels on a 40 x 40 background.
const FRONT = [["head", 16, 4], ["armR", 12, 12], ["body", 16, 12], ["armL", 24, 12], ["legR", 16, 24], ["legL", 20, 24]];
export function frontOf(px, background) {
  const runs = new Map();
  for (const [part, X, Y] of FRONT) {
    const [fw, fh] = faceBox(PARTS[part].size, "F").slice(2);
    for (let j = 0; j < fh; j++) {
      for (let i = 0; i < fw;) {
        const c = seen(px, part, "F", i, j);
        let n = 1;
        while (i + n < fw && seen(px, part, "F", i + n, j) === c) n++;
        runs.set(c, (runs.get(c) ?? "") + `M${X + i} ${Y + j}h${n}v1h${-n}z`);
        i += n;
      }
    }
  }
  let out = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" shape-rendering="crispEdges"><rect width="40" height="40" fill="${background}"/>`;
  for (const [c, s] of runs) out += `<path fill="${hex6(c)}" d="${s}"/>`;
  return `${out}</svg>`;
}
export const frontSvg = (t) => frontOf(skinColours(t), t.sealed ? SEALED.background : BACKGROUNDS[t.background].color);

/// The sealed DEGEN shown before the reveal.
export const SEALED_LOOK = { sealed: true };
export const sealedSvg = () => cardSvg(SEALED_LOOK);

export { BACKGROUNDS, SKINS, EYES, MOUTHS, CHEEKS, TOPS, BOTTOMS, SHOES, HEADWEAR, ACCESSORIES };

/// Traits on the wire (the world server sends them with each player's look): ten small numbers.
const KEYS = ["background", "skin", "eyes", "mouth", "cheeks", "top", "bottoms", "shoes", "headwear", "accessory"];
const LIMITS = [BACKGROUNDS, SKINS, EYES, MOUTHS, CHEEKS, TOPS, BOTTOMS, SHOES, HEADWEAR, ACCESSORIES].map((l) => l.length);
export const packTraits = (t) => KEYS.map((k) => t[k]);
export function unpackTraits(a) {
  if (!Array.isArray(a) || a.length !== KEYS.length || !a.every((v, i) => Number.isInteger(v) && v >= 0 && v < LIMITS[i])) return null;
  return Object.fromEntries(KEYS.map((k, i) => [k, a[i]]));
}
