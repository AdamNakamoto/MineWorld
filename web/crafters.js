// MineWorld Crafters: which traits a token has, and its picture. The same rules as the contracts
// (MineWorldCrafters.sol, CrafterArt.sol), so the game, the world server and the chain agree on every Crafter.
//
// Traits come from the seed revealed after the mint. The hair, outfit, eye colour and gaze come from a keyed shuffle of
// the token ids: each token takes a different one of the 6,912 combinations, so no two Crafters look alike. Background,
// skin, hat and blush are weighted picks from the token's own hash. Pass viem's keccak256 and encodeAbiParameters
// (`hash`), so this file runs in the browser and in the Worker alike.

import { MASKS, FACE, INK, EYE_WHITE, BACKGROUNDS, SKINS, EYES, BLUSHES, HAIRS, HATS, OUTFITS, SEALED } from "./crafters-art.js";

export const SUPPLY = 3333;
export const COMBOS = HAIRS.length * OUTFITS.length * EYES.length * 2; // 36 hairs x 16 outfits x 6 eyes x 2 gazes = 6,912
const N = 24;

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
/// inside the supply, keyed by the seed.
export function shuffle(seed, x, { keccak256, encodeAbiParameters }) {
  const round = (i, r) => Number(BigInt(keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }], [seed, BigInt(i), BigInt(r)]))) & 63n);
  do {
    let l = x >> 6, r = x & 63;
    for (let i = 0; i < 4; i++) [l, r] = [r, l ^ round(i, r)];
    x = (l << 6) | r;
  } while (x >= SUPPLY);
  return x;
}

/// Token `id`'s traits (indexes into the tables in crafters-art.js), once the seed is known.
export function traitsOf(seed, id, hash) {
  seed = BigInt(seed);
  id = Number(id);
  if (!Number.isInteger(id) || id < 1 || id > SUPPLY) throw new Error(`No Crafter #${id}`);
  const v = shuffle(seed, id - 1, hash);
  const c = Math.floor((v * COMBOS) / SUPPLY);
  const h = BigInt(hash.keccak256(hash.encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [seed, BigInt(id)])));
  const slice = (k) => Number((h >> BigInt(k)) & 0xffffn);
  const H = HAIRS.length, O = OUTFITS.length, E = EYES.length;
  return {
    hair: c % H,
    outfit: Math.floor(c / H) % O,
    eyes: Math.floor(c / (H * O)) % E,
    gaze: Math.floor(c / (H * O * E)),
    background: pick(BACKGROUNDS, slice(0)),
    skin: pick(SKINS, slice(16)),
    hat: pick(HATS, slice(32)),
    blush: pick(BLUSHES, slice(48)),
  };
}

/// The traits as marketplaces list them.
export function attributes(t) {
  return [
    ["Background", BACKGROUNDS[t.background].name], ["Skin", SKINS[t.skin].name], ["Eyes", EYES[t.eyes].name],
    ["Gaze", t.gaze ? "Right" : "Left"], ["Blush", BLUSHES[t.blush].name], ["Hair", HAIRS[t.hair].name],
    ["Hat", HATS[t.hat].name], ["Outfit", OUTFITS[t.outfit].name],
  ];
}

/// The picture as 24 x 24 colours (row by row), painted layer by layer: background, outfit, face, eyes, blush, hair,
/// hat. A hat hides the hair above row 8.
export function pixels(t) {
  const px = Array(N * N).fill(BACKGROUNDS[t.background].color);
  const skin = SKINS[t.skin];
  const paint = (rows, colors, fromRow = 0) => {
    const entries = Array.isArray(rows) ? rows.map((r, y) => [y, r]) : Object.entries(rows).map(([y, r]) => [Number(y), r]);
    for (const [y, r] of entries) {
      if (y < fromRow) continue;
      for (let x = 0; x < N; x++) {
        const ch = r[x];
        if (ch === ".") continue;
        const col = colors[ch] ?? (ch === "S" || ch === "s" || ch === "b" ? skin[ch] : ch === "K" ? INK : ch === "W" ? EYE_WHITE : null);
        if (col) px[y * N + x] = col;
      }
    }
  };
  const outfit = OUTFITS[t.outfit], hair = HAIRS[t.hair], hat = HATS[t.hat];
  paint(MASKS[outfit.mask], outfit.colors);
  paint(FACE.base, {});
  paint(FACE.ink, {});
  const e = EYES[t.eyes].c;
  paint(t.gaze ? FACE.eyesRight : FACE.eyesLeft, { 1: e[0], 2: e[1], 3: e[2], 4: e[3] });
  paint(t.blush ? FACE.blushSoft : FACE.blushRosy, {});
  paint(MASKS[hair.mask], hair.colors, hat.mask ? 8 : 0);
  if (hat.mask) paint(MASKS[hat.mask], hat.colors);
  return px;
}

/// The SVG, exactly as the contract writes it: the background, then each row's runs of one colour.
export function svgOf(px, background) {
  let out = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" shape-rendering="crispEdges"><rect width="24" height="24" fill="${background}"/>`;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N;) {
      const c = px[y * N + x];
      let w = 1;
      while (x + w < N && px[y * N + x + w] === c) w++;
      if (c !== background) out += `<rect x="${x}" y="${y}" width="${w}" height="1" fill="${c}"/>`;
      x += w;
    }
  }
  return `${out}</svg>`;
}

export const svg = (t) => svgOf(pixels(t), BACKGROUNDS[t.background].color);

/// The sealed picture shown before the reveal.
export function sealedSvg() {
  const px = Array(N * N).fill(SEALED.background);
  SEALED.mask.forEach((r, y) => {
    for (let x = 0; x < N; x++) if (r[x] !== ".") px[y * N + x] = SEALED.colors[r[x]];
  });
  return svgOf(px, SEALED.background);
}

export { BACKGROUNDS, SKINS, EYES, BLUSHES, HAIRS, HATS, OUTFITS };

/// Traits on the wire (the world server sends them with each player's look): eight small numbers.
const KEYS = ["hair", "outfit", "eyes", "gaze", "background", "skin", "hat", "blush"];
const LIMITS = [HAIRS.length, OUTFITS.length, EYES.length, 2, BACKGROUNDS.length, SKINS.length, HATS.length, BLUSHES.length];
export const packTraits = (t) => KEYS.map((k) => t[k]);
export function unpackTraits(a) {
  if (!Array.isArray(a) || a.length !== KEYS.length || !a.every((v, i) => Number.isInteger(v) && v >= 0 && v < LIMITS[i])) return null;
  return Object.fromEntries(KEYS.map((k, i) => [k, a[i]]));
}
