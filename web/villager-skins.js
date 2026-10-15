// The town's villagers as Minecraft skins (64 x 64), for avatar.js: plain human folk with a face, hair and a skin
// tone of their own, dressed in the same clothes as the I'M DEGEN frogs (degen-skin-art.js: tops, trousers, shoes,
// hats, accessories, by name). Not NFTs, so none of this goes on-chain. A villager can also simply be a DEGEN
// (`degen`: its traits), like Wren, the DEGEN fan.

import { paintOps, dress, rgbaOf, skinPixels, TOPS, BOTTOMS, SHOES, HEADWEAR, ACCESSORIES } from "./degen-skin.js";

/// Skin tones: main, shade, light, dark (the mouth), blush (as a DEGEN skin's S s l d B).
const TONES = {
  fair: { S: "#ffe0c8", s: "#eab9a0", l: "#fff0e4", d: "#b8705f", B: "#ffb0b0" },
  light: { S: "#f3c7a2", s: "#d6a07f", l: "#ffe2c8", d: "#a35d48", B: "#f5a0a0" },
  tan: { S: "#d99e6e", s: "#b77a50", l: "#efc39a", d: "#84452e", B: "#e89080" },
  brown: { S: "#a8693e", s: "#85502c", l: "#c88a5e", d: "#55291a", B: "#c8705a" },
  deep: { S: "#6e4128", s: "#55301c", l: "#8a5638", d: "#2a160c", B: "#9a5048" },
};
/// Hair: main and shade.
const HAIR = {
  brown: ["#5c3a22", "#42281a"], black: ["#26262e", "#16161c"], blonde: ["#e0b450", "#b88a30"], ginger: ["#c8582a", "#9a3e1a"],
  white: ["#e8e8ec", "#b8bcc8"], grey: ["#9a9ca4", "#74767e"], green: ["#3a8a4a", "#2a6a36"], purple: ["#7a4a9a", "#5a3474"],
};
const EYES = { blue: "#3d6fd1", brown: "#6a3e22", green: "#2f8a4a", grey: "#6b707a" };

/// A face: eyes (white and iris), brows in the hair's shade, a nose and a mouth. Colours: 1 hair, 2 its shade, 3 the
/// eyes.
const HEAD = `
  head FKRLTU 0 0 * * S; head U 0 0 * * s
  head F 1 4 2 1 W; head F 5 4 2 1 W; head F 2 4 1 1 3; head F 5 4 1 1 3
  head F 1 3 2 1 2; head F 5 3 2 1 2; head F 3 5 2 1 s; head F 3 6 2 1 d
  body FKRLTU 0 0 * * S; arms FKRLTU 0 0 * * S; legs FKRLTU 0 0 * * S
`;
const SHORT = `head T 0 0 * * 1; head S 0 0 * 2 1; head F 0 2 8 1 :11....11; head K 0 0 * 5 1; head~ R 0 0 5 4 1
  head K 0 4 * 1 2; head T 2 2 1 1 2; head T 5 4 1 1 2`;
const HAIRSTYLES = {
  short: SHORT,
  long: `${SHORT}; head K 0 0 * * 1; head~ R 0 0 6 * 1; head F 0 2 1 6 1; head F 7 2 1 6 1; head K 0 7 * 1 2; body K 1 0 6 3 1`,
  bun: `${SHORT}; hat T 2 1 4 3 1; hat T 3 1 2 1 2; hat K 2 0 4 1 1`,
  curly: `${SHORT}; hat T 0 0 * * 1; hat S 0 0 * 1 1; hat T 0 0 8 8 :.2...2../...2...2/.2...2../...2...2/.2...2../...2...2/.2...2../...2...2
    hat S 0 0 32 1 :2..2..2..2..2..2..2..2..2..2..2.`,
  bald: `head~ R 0 3 5 2 1; head K 0 3 * 3 1; head T 2 2 4 3 s`,
};
const BEARD = `head F 1 5 6 3 1; head F 3 6 2 1 d; head F 3 5 2 1 s; head~ R 5 5 3 3 1`;

const named = (list, name) => {
  const i = list.findIndex((o) => o.name === name);
  if (i < 0) throw new Error(`villager-skins: no "${name}"`);
  return i;
};

/// A villager's skin (64 x 64 RGBA). `look`: { degen } (a DEGEN's traits), or { tone, hair: [style, colour], eyes,
/// beard, top, bottoms, shoes, headwear, accessory } (the clothes by their names in degen-skin-art.js).
export function villagerSkin(look) {
  if (look.degen) return skinPixels(look.degen);
  const px = new Int32Array(64 * 64).fill(-1);
  const skin = TONES[look.tone], [h1, h2] = HAIR[look.hair[1]];
  const palette = { 1: h1, 2: h2, 3: EYES[look.eyes ?? "brown"] };
  paintOps(px, HEAD, palette, skin);
  paintOps(px, HAIRSTYLES[look.hair[0]], palette, skin);
  if (look.beard) paintOps(px, BEARD, palette, skin);
  dress(px, {
    top: named(TOPS, look.top), bottoms: named(BOTTOMS, look.bottoms ?? "Jeans Blue"), shoes: named(SHOES, look.shoes ?? "Boots Brown"),
    headwear: named(HEADWEAR, look.headwear ?? "None"), accessory: named(ACCESSORIES, look.accessory ?? "None"),
  }, skin);
  return rgbaOf(px);
}
