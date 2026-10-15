// I'M DEGEN: the art, as small layers painted onto a Minecraft skin (64 x 64, the standard layout with classic 4-pixel
// arms). DEGEN is the owner's own frog: big round eyes bulging up at the top corners of the head, a wide thin mouth,
// round cheeks, eardrums on the sides and dark spots on the crown and back of the head. Every outfit, hat and
// accessory here was drawn for this collection; none is a copy of anything (no brands, logos or other characters).
//
// This file is the source of truth for the skin, the NFT card (degen-skin.js cardSvg) and the contract that draws them
// on chain: everything is integers (rectangles and tiny masks) and named colours, so the chain paints the same pixels
// from the same data. degen-skin.js reads it; tools/gen-degen-art.mjs writes contracts/src/CrafterArt.sol from both.
//
// A layer is a list of operations, one per line (or separated by ";"), each painting onto one part of the model:
//
//   <target> <faces> <x> <y> <w> <h> <colour>      a rectangle on each named face
//   <target> <faces> <x> <y> :<mask>               a small mask, rows split by "/", "." leaves a pixel alone
//
// Targets: head, body, arms, legs (the base layer) and hat, jacket, sleeves, pants (the second, outer layer); arms,
// sleeves, legs and pants paint both limbs, drawn for the RIGHT one and mirrored onto the left. armR, armL, legR, legL,
// sleeveR, sleeveL, pantsR, pantsL paint one limb. A "~" after head, hat, body or jacket also paints the mirror image.
// Faces: F front, K back, R right (the player's right: on a limb, its outer side), L left (inner), T top, U under,
// and S, the band of four sides (right, front, left, back) as one strip, so a cuff or a belt is one rectangle.
// x and y are counted on the face from its top left as you look at it (a negative one counts from the far edge); a
// width or height of "*" runs to the edge.
//
// Colours: the digits 1-9 are the option's own palette; S s l d B the skin's (main, shade, light belly, dark spots,
// blush); K W R Y w fixed (ink, white, mouth pink, star gold, eye shade).

/// Fixed colours, the same for every DEGEN.
export const FIXED = { K: "#1f2029", W: "#f6f7f0", R: "#ea6f8a", Y: "#ffd23f", w: "#c9d0dc" };

/// The NFT card's background (weights out of their total).
export const BACKGROUNDS = [
  { name: "Sky", color: "#bfe3ff", w: 16 }, { name: "Mint", color: "#c6efd6", w: 14 }, { name: "Peach", color: "#ffd9c2", w: 13 },
  { name: "Lavender", color: "#ddd2ff", w: 12 }, { name: "Butter", color: "#fff1b3", w: 12 }, { name: "Stone", color: "#d6d8dc", w: 10 },
  { name: "Pond", color: "#9fd6cc", w: 9 }, { name: "Rose", color: "#ffc9d6", w: 8 }, { name: "Dusk", color: "#4a4170", w: 4 },
  { name: "Night", color: "#1b2440", w: 2 },
];

/// DEGEN's skin: main, shade, light (belly and chin), dark (spots, eardrums), blush. `tier`: 1 Rare, 2 Legendary.
export const SKINS = [
  { name: "Leaf", S: "#6cc04a", s: "#4e9a35", l: "#bfe486", d: "#3a7a28", B: "#f2879a", w: 26 },
  { name: "Lime", S: "#9bd13d", s: "#78a92b", l: "#e0f294", d: "#5b8a1f", B: "#f5879d", w: 19 },
  { name: "Moss", S: "#7f9c3e", s: "#627c2d", l: "#c9d991", d: "#47601f", B: "#e88a8c", w: 15 },
  { name: "Mint", S: "#4fc29f", s: "#37997c", l: "#aeeed8", d: "#26735b", B: "#f28eaa", w: 14 },
  { name: "Forest", S: "#3f8f4f", s: "#2f6e3c", l: "#9fd39c", d: "#1f5230", B: "#e8869c", w: 9 },
  { name: "Ice", S: "#96d6f2", s: "#6ab3d8", l: "#e3f7ff", d: "#4a8fba", B: "#f0a0ca", w: 5, tier: 1 },
  { name: "Purple", S: "#9b6dd9", s: "#7a4eb9", l: "#dcc6fa", d: "#583291", B: "#fb8fc9", w: 5, tier: 1 },
  { name: "Stone", S: "#9a9ba3", s: "#7a7b85", l: "#cbcbd3", d: "#5b5c66", B: "#e99aaa", w: 5, tier: 1 },
  { name: "Gold", S: "#f2c232", s: "#d29c1a", l: "#fff0a3", d: "#a8740e", B: "#ff9b7c", w: 2, tier: 2 },
];

/// The frog under the clothes: skin everywhere, a light belly and chin, spots on the crown and the back of the head,
/// an eardrum on each side, two nostrils.
export const FROG = `
  head FKRLTU 0 0 * * S; head U 0 0 * * l; head F 0 7 * 1 l; head~ R 0 7 * 1 l
  head~ R 2 2 2 2 d
  head T 2 1 1 1 d; head T 5 2 1 1 d; head T 3 4 1 1 d; head T 6 0 1 1 d
  head K 2 1 1 1 d; head K 5 2 1 1 d; head K 3 4 1 1 d; head K 1 6 1 1 d; head K 6 5 1 1 d
  body FKRLTU 0 0 * * S; body F 2 1 4 11 l
  arms FKRLTU 0 0 * * S; arms U 0 0 * * l
  legs FKRLTU 0 0 * * S; legs U 0 0 * * l
`;

/// The eyes, sitting on the head's top front corners: each mask is the right eye (on the left as you face DEGEN), its
/// columns outer to inner, its rows the head's top (two rows at the front edge) and then the face's top four rows. The
/// left eye is its mirror image; the outer column also wraps round onto the side of the head. The whole eye is copied
/// onto the hat layer too, so in the game it bulges out of the head. Headwear covers the top and the face's top row
/// at most, so the expression (the face's rows 1 to 3) always shows.
export const EYES = [
  { name: "Happy", mask: ".../.../.../.K./K.K/..." },
  { name: "Calm", mask: ".../WWW/WWW/WKW/WKW/WWW" },
  { name: "Surprised", mask: ".W./WWW/WWW/WKW/WWW/.W." },
  { name: "Sleepy", mask: ".../.../.../.../KKK/..." },
  { name: "Determined", mask: ".../.../KK./WWK/WKK/WWW" },
  { name: "Starry", mask: ".../WWW/WWW/WYW/YYY/WYW" },
];

/// The mouth, on the face's rows 4 to 7.
export const MOUTHS = [
  { name: "Smile", mask: "......../.K....K./..KKKK../........" },
  { name: "Grin", mask: "......../.KKKKKK./..KRRK../........" },
  { name: "Small O", mask: "......../...KK.../...KK.../........" },
  { name: "Flat", mask: "......../......../..KKKK../........" },
  { name: "Tongue", mask: "......../.K....K./..KKKK../....RR.." },
];

/// Cheeks, on the face's row 4, at its two outer pixels: nothing worn may cover those (the glasses' lower frame and
/// the hood's face edge stop short of them), so a blush always shows and no two DEGENs can look alike.
export const CHEEKS = [
  { name: "None", mask: "" },
  { name: "Blush", mask: "B......B" },
];

/// The tops. Each style is drawn once; its colours are the option's palette. `legs`: the style dresses the legs too
/// (matching trousers, a suit's), so the Bottoms trait doesn't show; `feet`: it has its own boots, so Shoes doesn't.
export const TOP_STYLES = {
  hoodie: { ops: `
    body S 0 0 * * 1; body T 0 0 * * 1; body U 0 0 * * 2
    body S 0 -2 * 2 2
    body F 1 7 6 3 2; body F 2 8 4 1 1
    body F 0 0 8 1 2; body F 0 1 8 1 3
    arms S 0 0 * 10 1; arms T 0 0 * * 1; arms S 0 9 * 1 2
    jacket K 1 0 6 3 2; jacket K 2 3 4 1 2; jacket F 0 0 1 1 2; jacket F 7 0 1 1 2
  ` },
  tee: { ops: `
    body S 0 0 * * 1; body T 0 0 * * 1; body U 0 0 * * 2
    body S 0 -1 * 1 2; body F 3 0 2 1 l
    body F 3 3 2 2 3; body F 2 4 1 1 3; body F 5 4 1 1 3
    arms S 0 0 * 4 1; arms T 0 0 * * 1; arms S 0 3 * 1 2
  ` },
  jacket: { ops: `
    body S 0 0 * * 3; body T 0 0 * * 3; body U 0 0 * * 3; body S 0 -1 * 1 4
    arms S 0 0 * 4 3; arms T 0 0 * * 3
    jacket S 0 0 * * 1; jacket F 2 0 4 * .; jacket T 0 0 * * 1; jacket U 0 0 * * 2
    jacket~ F 0 0 2 1 2; jacket~ F 1 1 1 11 2; jacket S 0 -1 * 1 2
    sleeves S 0 0 * 10 1; sleeves T 0 0 * * 1; sleeves S 0 9 * 1 2
  ` },
  tracksuit: { ops: `
    body S 0 0 * * 1; body T 0 0 * * 1; body U 0 0 * * 2
    body F 0 0 8 1 2; body F 4 1 1 11 4; body S 0 -1 * 1 2
    arms S 0 0 * 10 1; arms T 0 0 * * 1; arms O 1 0 1 10 3; arms S 0 9 * 1 2
    legs S 0 0 * * 1; legs T 0 0 * * 1; legs O 1 0 1 10 3; legs S 0 9 * 1 2
  `, legs: true },
  suit: { ops: `
    body S 0 0 * * 1; body T 0 0 * * 1; body U 0 0 * * 2
    body F 2 0 4 2 3; body F 3 2 2 3 3; body F 3 0 2 1 4; body F 3 1 2 4 4; body F 3 5 1 1 5
    body~ F 1 0 1 6 2; body F 4 7 1 1 K; body F 4 9 1 1 K
    arms S 0 0 * 10 1; arms T 0 0 * * 1; arms S 0 9 * 1 3
    legs S 0 0 * * 1; legs T 0 0 * * 1; legs F 1 0 1 9 2
  `, legs: true },
  overalls: { ops: `
    body S 0 0 * * 4; body T 0 0 * * 4; body U 0 0 * * 1
    arms S 0 0 * 4 4; arms T 0 0 * * 4; arms S 0 3 * 1 5
    body S 0 6 * 6 1; body F 1 3 6 3 1; body~ F 1 0 1 3 1; body~ K 1 0 1 6 1
    body~ F 1 3 1 1 3; body F 3 4 2 2 2; body S 0 6 * 1 2
    legs S 0 0 * * 1; legs T 0 0 * * 1; legs O 2 2 1 4 2; legs S 0 8 * 1 2
  `, legs: true },
  vest: { ops: `
    body S 0 0 * * 4; body T 0 0 * * 4; body U 0 0 * * 4
    arms S 0 0 * 10 4; arms T 0 0 * * 4; arms S 0 9 * 1 5
    jacket S 0 0 * * 1; jacket F 3 0 2 * .; jacket T 0 0 * * 1
    jacket S 0 5 * 1 3; jacket S 0 8 * 1 3; jacket~ F 1 0 1 5 3; jacket~ K 1 0 1 5 3; jacket S 0 -1 * 1 2
  ` },
  sweater: { ops: `
    body S 0 0 * * 1; body T 0 0 * * 1; body U 0 0 * * 2
    body F 2 0 4 1 2; body S 0 -2 * 2 2
    body S 0 4 24 1 :3.3.3.3.3.3.3.3.3.3.3.3.; body S 0 5 24 1 :.3.3.3.3.3.3.3.3.3.3.3.3
    arms S 0 0 * 10 1; arms T 0 0 * * 1; arms S 0 8 * 2 2
    arms S 0 4 16 1 :3.3.3.3.3.3.3.3.; arms S 0 5 16 1 :.3.3.3.3.3.3.3.3
  ` },
  flannel: { ops: `
    body S 0 0 * * 1; body T 0 0 * * 1; body U 0 0 * * 2
    body S 1 0 1 * 2; body S 5 0 1 * 2; body S 9 0 1 * 2; body S 13 0 1 * 2; body S 17 0 1 * 2; body S 21 0 1 * 2
    body S 0 2 * 1 2; body S 0 6 * 1 2; body S 0 10 * 1 2
    body S 0 2 24 1 :.3...3...3...3...3...3..; body S 0 6 24 1 :.3...3...3...3...3...3..
    body S 0 10 24 1 :.3...3...3...3...3...3..
    body F 3 0 2 1 l; body F 4 1 1 11 3; body F 4 3 1 1 W; body F 4 7 1 1 W
    arms S 0 0 * 10 1; arms T 0 0 * * 1
    arms S 1 0 1 10 2; arms S 5 0 1 10 2; arms S 9 0 1 10 2; arms S 13 0 1 10 2
    arms S 0 2 * 1 2; arms S 0 6 * 1 2; arms S 0 9 * 1 2
  ` },
  robe: { ops: `
    body S 0 0 * * 4; body T 0 0 * * 4; body U 0 0 * * 4; body F 3 0 2 * 3; body F 3 4 1 1 5; body F 4 7 1 1 5
    arms S 0 0 * 10 4; arms T 0 0 * * 4
    jacket S 0 0 * * 1; jacket F 3 0 2 * .; jacket T 0 0 * * 1; jacket U 0 0 * * 2
    jacket~ F 2 3 1 9 5; jacket S 0 0 * 3 3; jacket S 0 1 24 2 :.K...K...K...K...K...K../...K...K...K...K...K...K
    sleeves S 0 0 * 11 1; sleeves T 0 0 * * 1; sleeves S 0 9 * 2 3; sleeves S 0 9 16 1 :.K...K...K...K..
    pants S 0 0 * 5 1; pants S 0 5 * 1 5
  ` },
  space: { ops: `
    body S 0 0 * * 1; body T 0 0 * * 1; body U 0 0 * * 1
    body S 0 0 * 1 5; body F 2 3 4 3 3; body F 2 4 1 1 4; body F 4 4 1 1 Y; body F 5 4 1 1 R; body S 0 -2 * 1 2
    jacket K 1 1 6 8 2; jacket K 2 2 4 1 3; jacket K 2 6 4 1 3
    arms S 0 0 * * 1; arms T 0 0 * * 1; arms S 0 5 * 1 2; arms S 0 9 * 3 3; arms O 1 2 1 2 3
    legs S 0 0 * * 1; legs T 0 0 * * 1; legs S 0 5 * 1 2; legs S 0 9 * 3 3; legs U 0 0 * * 5
  `, legs: true, feet: true },
  armour: { ops: `
    body S 0 0 * * 1; body T 0 0 * * 3; body U 0 0 * * 2
    body S 0 4 * 1 2; body F 3 1 2 3 3; body~ F 1 1 1 2 3; body S 0 8 * 1 5; body F 4 8 1 1 3
    body F 2 9 4 3 4; body F 2 9 4 1 2; body K 1 9 6 3 4
    arms S 0 0 * * 1; arms T 0 0 * * 3; arms S 0 5 * 1 2; arms S 0 9 * 3 2; arms F 1 10 2 1 3
    sleeves S 0 0 * 3 3; sleeves T 0 0 * * 3; sleeves S 0 3 * 1 2
    legs S 0 0 * * 1; legs T 0 0 * * 1; legs F 1 4 2 2 3; legs S 0 3 * 1 2; legs S 0 9 * 3 2; legs F 0 11 * 1 5; legs U 0 0 * * 5
  `, legs: true, feet: true },
};

const TEE = { 1: "#dfe3ea", 2: "#b3b9c5" };
/// Tops: a style and its colours. These are spread evenly over the collection (with the face, they're what makes
/// every DEGEN different from every other), so a rarer style simply has fewer colours.
export const TOPS = [
  ...[
    ["Grey", "#8a8f99", "#6b707a", "#d9dde4"], ["Red", "#cf3a35", "#a3282a", "#f2e6e6"], ["Blue", "#3d6fd1", "#2a51a3", "#e6eef9"],
    ["Green", "#3f9a54", "#2d7740", "#e6f2e6"], ["Yellow", "#f0c23a", "#c99a1f", "#fff8e0"], ["Purple", "#8a52c9", "#6a3aa3", "#f0e6fa"],
    ["Pink", "#f08ab4", "#c96a90", "#fff0f6"], ["Black", "#2c2f38", "#1b1d24", "#d9dde4"], ["Orange", "#f07f2a", "#c9611a", "#fff0e0"],
    ["White", "#eceef2", "#c3c8d2", "#8a8f99"],
  ].map(([c, a, b, d]) => ({ name: `Hoodie ${c}`, style: "hoodie", colors: { 1: a, 2: b, 3: d } })),
  ...[
    ["White", "#eceef2", "#c3c8d2", "#3d6fd1"], ["Black", "#2c2f38", "#1b1d24", "#f0c23a"], ["Red", "#cf3a35", "#a3282a", "#f6f7f0"],
    ["Blue", "#3d6fd1", "#2a51a3", "#f6f7f0"], ["Yellow", "#f0c23a", "#c99a1f", "#cf3a35"], ["Teal", "#2fa8a0", "#21827b", "#f6f7f0"],
    ["Lilac", "#b9a2e8", "#957cc9", "#5b3a91"], ["Orange", "#f07f2a", "#c9611a", "#2c2f38"],
  ].map(([c, a, b, d]) => ({ name: `Tee ${c}`, style: "tee", colors: { 1: a, 2: b, 3: d } })),
  ...[
    ["Denim", "#4a6fa8", "#36548a", "#eceef2", "#c3c8d2"], ["Leather", "#2f2a2a", "#1d1919", "#cf3a35", "#a3282a"],
    ["Bomber", "#59683a", "#434f2a", "#f07f2a", "#c9611a"], ["Varsity", "#a3282a", "#7a1d20", "#eceef2", "#c3c8d2"],
    ["Corduroy", "#a2733f", "#7e562c", "#f6e7c8", "#d9c49c"], ["Puffer", "#3d6fd1", "#2a51a3", "#2c2f38", "#1b1d24"],
  ].map(([c, a, b, d, e]) => ({ name: `Jacket ${c}`, style: "jacket", colors: { 1: a, 2: b, 3: d, 4: e } })),
  ...[
    ["Red", "#cf3a35", "#a3282a"], ["Blue", "#2f5fc4", "#21468f"], ["Green", "#2f8a4a", "#226a37"], ["Black", "#2c2f38", "#1b1d24"],
    ["Purple", "#7a46b8", "#5b3391"], ["Teal", "#2fa8a0", "#21827b"],
  ].map(([c, a, b]) => ({ name: `Tracksuit ${c}`, style: "tracksuit", colors: { 1: a, 2: b, 3: "#f6f7f0", 4: "#d9dde4" } })),
  ...[
    ["Black", "#25272e", "#17181d", "#cf3a35", "#a3282a"], ["Navy", "#26345e", "#1a2444", "#3d8fd1", "#2a6aa3"],
    ["Grey", "#6b707a", "#52565e", "#2f8a4a", "#226a37"], ["White", "#e6e8ec", "#bfc4cc", "#25272e", "#17181d"],
    ["Plum", "#5e2a6e", "#441e50", "#f0c23a", "#c99a1f"], ["Brown", "#6e4a2e", "#523620", "#2fa8a0", "#21827b"],
  ].map(([c, a, b, d, e]) => ({ name: `Suit ${c}`, style: "suit", colors: { 1: a, 2: b, 3: "#f6f7f0", 4: d, 5: e } })),
  ...[
    ["Denim", "#3f5f99", "#2d4878", "#e0a526"], ["Brown", "#7a5230", "#5c3d22", "#e0a526"], ["Orange", "#e0762a", "#b45a1c", "#d9dde4"],
    ["Green", "#4a7a3a", "#37602a", "#e0a526"], ["Grey", "#6b707a", "#52565e", "#f0c23a"],
  ].map(([c, a, b, d]) => ({ name: `Overalls ${c}`, style: "overalls", colors: { 1: a, 2: b, 3: d, 4: TEE[1], 5: TEE[2] } })),
  ...[
    ["Orange", "#ff7a1a", "#d45e0e"], ["Yellow", "#e8e22a", "#bfb81a"], ["Lime", "#9be22a", "#7ab81a"],
  ].map(([c, a, b]) => ({ name: `Miner's Vest ${c}`, style: "vest", colors: { 1: a, 2: b, 3: "#e6eaf0", 4: "#4a5568", 5: "#363f4f" } })),
  ...[
    ["Cream", "#efe3c8", "#d2c3a1", "#cf3a35"], ["Green", "#3f8a4f", "#2d6a3b", "#f6f7f0"], ["Red", "#c43a3a", "#9a2a2a", "#f6f7f0"],
    ["Navy", "#2a3a6a", "#1d2a4f", "#f0c23a"],
  ].map(([c, a, b, d]) => ({ name: `Sweater ${c}`, style: "sweater", colors: { 1: a, 2: b, 3: d } })),
  ...[
    ["Red", "#c43a35", "#7a1d1d", "#e88a7a"], ["Blue", "#3a5fb0", "#1d2f6a", "#8aa8e8"], ["Green", "#3a8a4a", "#1d4f26", "#8ad29a"],
    ["Yellow", "#e0b030", "#8a6a1a", "#f8e090"],
  ].map(([c, a, b, d]) => ({ name: `Flannel ${c}`, style: "flannel", colors: { 1: a, 2: b, 3: d } })),
  { name: "Royal Robe Red", style: "robe", colors: { 1: "#b8202a", 2: "#8a161f", 3: "#f6f7f0", 4: "#f0d27a", 5: "#e0a526" }, tier: 1 },
  { name: "Royal Robe Purple", style: "robe", colors: { 1: "#6a2a9a", 2: "#4f1f75", 3: "#f6f7f0", 4: "#f0d27a", 5: "#e0a526" }, tier: 1 },
  { name: "Space Suit White", style: "space", colors: { 1: "#e8ebf0", 2: "#b9c0cc", 3: "#3d6fd1", 4: "#2fd17a", 5: "#6b707a" }, tier: 1 },
  { name: "Space Suit Orange", style: "space", colors: { 1: "#f07f2a", 2: "#c9611a", 3: "#e8ebf0", 4: "#3d6fd1", 5: "#52565e" }, tier: 1 },
  { name: "Knight Armour Iron", style: "armour", colors: { 1: "#a9b0bb", 2: "#7e8592", 3: "#dfe4ea", 4: "#2f5fc4", 5: "#4e5560" }, tier: 1 },
  { name: "Knight Armour Gold", style: "armour", colors: { 1: "#f0c23a", 2: "#c99a1f", 3: "#fff1a8", 4: "#b8202a", 5: "#8a6a12" }, tier: 2 },
];

/// The Rookie's top (players without a DEGEN): a plain grey hoodie, not one of the collection's.
export const ROOKIE_TOP = { name: "Rookie Hoodie", style: "rookie", colors: { 1: "#8d929b", 2: "#70757e", 3: "#a7acb4" } };
TOP_STYLES.rookie = { ops: `
  body S 0 0 * * 1; body T 0 0 * * 1; body U 0 0 * * 2; body S 0 -1 * 1 2; body F 0 0 8 1 2
  arms S 0 0 * 10 1; arms T 0 0 * * 1; arms S 0 9 * 1 2
  legs S 0 0 * * 3; legs T 0 0 * * 3; legs S 0 9 * 1 2
`, legs: true };

/// Trousers (under a top that doesn't bring its own).
export const BOTTOM_STYLES = {
  jeans: `legs S 0 0 * * 1; legs T 0 0 * * 1; legs L 0 0 1 * 2; legs F 0 0 * 1 2; legs O 1 1 2 1 3`,
  joggers: `legs S 0 0 * * 1; legs T 0 0 * * 1; legs S 0 8 * 1 2; legs O 1 0 1 8 2`,
  cargo: `legs S 0 0 * * 1; legs T 0 0 * * 1; legs O 1 3 3 3 2; legs O 1 3 3 1 3; legs F 0 0 * 1 2`,
  shorts: `legs S 0 0 * 5 1; legs T 0 0 * * 1; legs S 0 4 * 1 2; legs O 1 1 2 2 2`,
  slacks: `legs S 0 0 * * 1; legs T 0 0 * * 1; legs F 1 0 1 9 2; legs F 0 0 * 1 2`,
};
export const BOTTOMS = [
  { name: "Jeans Blue", style: "jeans", colors: { 1: "#3f62a3", 2: "#2d4a80", 3: "#7a9ad0" }, w: 14 },
  { name: "Jeans Black", style: "jeans", colors: { 1: "#2f323b", 2: "#1d1f26", 3: "#5b606b" }, w: 10 },
  { name: "Jeans Light", style: "jeans", colors: { 1: "#7fa2d6", 2: "#5d80b4", 3: "#b5cbec" }, w: 8 },
  { name: "Joggers Grey", style: "joggers", colors: { 1: "#8a8f99", 2: "#6b707a" }, w: 10 },
  { name: "Joggers Black", style: "joggers", colors: { 1: "#2c2f38", 2: "#1b1d24" }, w: 8 },
  { name: "Cargo Khaki", style: "cargo", colors: { 1: "#b59a6a", 2: "#8f7750", 3: "#cdb78a" }, w: 10 },
  { name: "Cargo Olive", style: "cargo", colors: { 1: "#5e6a3a", 2: "#46502a", 3: "#7a8850" }, w: 8 },
  { name: "Shorts Khaki", style: "shorts", colors: { 1: "#c4a875", 2: "#9c8355" }, w: 7 },
  { name: "Shorts Denim", style: "shorts", colors: { 1: "#4f72b0", 2: "#3a5690" }, w: 5 },
  { name: "Slacks Black", style: "slacks", colors: { 1: "#2a2c33", 2: "#1a1b20" }, w: 8 },
  { name: "Slacks Navy", style: "slacks", colors: { 1: "#26345e", 2: "#1a2444" }, w: 6 },
  { name: "Slacks Grey", style: "slacks", colors: { 1: "#6b707a", 2: "#52565e" }, w: 6 },
];

/// Shoes (unless the top brings boots).
export const SHOE_STYLES = {
  sneakers: `legs S 0 10 * 2 1; legs S 0 11 * 1 2; legs U 0 0 * * 2; legs F 1 10 2 1 3`,
  boots: `legs S 0 9 * 3 1; legs S 0 9 * 1 2; legs S 0 11 * 1 3; legs U 0 0 * * 3`,
  work: `legs S 0 9 * 3 1; legs S 0 9 * 1 2; legs S 0 11 * 1 3; legs U 0 0 * * 3; legs F 0 10 * 1 4`,
  bare: `legs S 0 10 * 2 S; legs F 0 11 4 1 :lSlS; legs U 0 0 * * l`,
};
export const SHOES = [
  { name: "Sneakers White", style: "sneakers", colors: { 1: "#eceef2", 2: "#c3c8d2", 3: "#8a8f99" }, w: 16 },
  { name: "Sneakers Black", style: "sneakers", colors: { 1: "#2c2f38", 2: "#eceef2", 3: "#eceef2" }, w: 12 },
  { name: "Sneakers Red", style: "sneakers", colors: { 1: "#cf3a35", 2: "#eceef2", 3: "#f6f7f0" }, w: 9 },
  { name: "Sneakers Blue", style: "sneakers", colors: { 1: "#3d6fd1", 2: "#eceef2", 3: "#f6f7f0" }, w: 8 },
  { name: "Boots Brown", style: "boots", colors: { 1: "#7a5230", 2: "#5c3d22", 3: "#3a2616" }, w: 14 },
  { name: "Boots Black", style: "boots", colors: { 1: "#2c2f38", 2: "#1b1d24", 3: "#111216" }, w: 9 },
  { name: "Work Boots", style: "work", colors: { 1: "#b0803e", 2: "#8a6230", 3: "#3a2616", 4: "#8a8f99" }, w: 10 },
  { name: "Bare Feet", style: "bare", colors: {}, w: 8 },
];

/// Headwear, on the hat layer (a helmet in the game takes its place). The front of the hat stays clear of the eyes.
export const HEAD_STYLES = {
  cap: `hat T 0 0 * * 1; hat S 0 0 * 1 1; hat F 0 0 8 1 3; hat T 0 6 * 2 3; hat T 3 2 2 2 2; hat K 3 1 2 1 2`,
  beanie: `hat T 0 0 * * 1; hat S 0 0 * 1 2; hat T 3 3 2 2 3; hat T 0 1 8 1 2; hat T 0 5 8 1 2`,
  hood: `hat T 0 0 * * 1; hat K 0 0 * * 1; hat R 0 0 7 * 1; hat L 1 0 7 * 1; hat~ R 7 0 1 1 1; hat~ R 7 4 1 4 1
    hat F 0 0 8 1 2; hat~ F 0 5 1 3 2; hat K 0 7 * 1 2`,
  hardhat: `hat T 0 0 * * 1; hat T 3 0 2 * 3; hat S 0 0 * 1 2; hat F 3 0 2 1 4; hat T 3 6 2 2 5`,
  crown: `hat S 0 0 * 1 1; hat F 3 0 2 1 4; hat~ R 3 0 2 1 5; hat K 3 0 2 1 4
    hat T 0 0 8 8 :31.11.13/1......1/......../1......1/1......1/......../1......1/31.11.13`,
  jewelled: `hat S 0 0 * 1 1; hat F 1 0 1 1 5; hat F 3 0 2 1 4; hat F 6 0 1 1 7; hat~ R 2 0 1 1 7; hat~ R 5 0 1 1 5; hat K 3 0 2 1 4
    hat T 1 1 6 6 6; hat T 3 3 2 2 1; hat T 3 3 1 1 3
    hat T 0 0 8 8 :31.11.13/1......1/......../1......1/1......1/......../1......1/31.11.13`,
  headphones: `hat T 0 3 8 2 1; hat~ R 3 0 2 2 1; hat~ R 2 2 4 4 2; hat~ R 3 3 2 2 3`,
  goggles: `hat S 0 0 * 1 1; hat T 1 5 2 2 2; hat T 5 5 2 2 2; hat T 1 5 1 1 3; hat T 5 5 1 1 3; hat T 3 6 2 1 1`,
  straw: `hat T 0 0 * * 1; hat T 0 0 8 8 :.3...3../...3...3/.3...3../...3...3/.3...3../...3...3/.3...3../...3...3
    hat S 0 0 * 1 2`,
  wizard: `hat T 0 0 * * 1; hat S 0 0 * 1 2; hat T 2 2 1 1 3; hat T 5 4 1 1 3; hat T 3 6 1 1 3; hat T 4 3 2 1 4
    hat~ R 2 0 1 1 3; hat K 5 0 1 1 3`,
  viking: `hat T 0 0 * * 1; hat T 3 0 2 * 3; hat S 0 0 * 1 3; hat T 1 1 1 1 2; hat T 6 6 1 1 2
    hat~ R 1 0 4 4 :5.../44../.444/..44`,
};
export const HEADWEAR = [
  { name: "None", style: null, w: 56 },
  { name: "Cap Red", style: "cap", colors: { 1: "#cf3a35", 2: "#a3282a", 3: "#a3282a" }, w: 7 },
  { name: "Cap Blue", style: "cap", colors: { 1: "#3d6fd1", 2: "#2a51a3", 3: "#2a51a3" }, w: 7 },
  { name: "Cap Black", style: "cap", colors: { 1: "#2c2f38", 2: "#1b1d24", 3: "#1b1d24" }, w: 6 },
  { name: "Cap Green", style: "cap", colors: { 1: "#3f9a54", 2: "#2d7740", 3: "#2d7740" }, w: 5 },
  { name: "Cap Yellow", style: "cap", colors: { 1: "#f0c23a", 2: "#c99a1f", 3: "#c99a1f" }, w: 5 },
  { name: "Beanie Grey", style: "beanie", colors: { 1: "#8a8f99", 2: "#6b707a", 3: "#eceef2" }, w: 5 },
  { name: "Beanie Red", style: "beanie", colors: { 1: "#cf3a35", 2: "#a3282a", 3: "#eceef2" }, w: 5 },
  { name: "Beanie Blue", style: "beanie", colors: { 1: "#3d6fd1", 2: "#2a51a3", 3: "#f0c23a" }, w: 4 },
  { name: "Beanie Orange", style: "beanie", colors: { 1: "#f07f2a", 2: "#c9611a", 3: "#2c2f38" }, w: 4 },
  { name: "Hard Hat Yellow", style: "hardhat", colors: { 1: "#f5c832", 2: "#c89a10", 3: "#fff2a0", 4: "#fffbe0", 5: "#c89a10" }, w: 12 },
  { name: "Hard Hat Orange", style: "hardhat", colors: { 1: "#ff8a2a", 2: "#c85a10", 3: "#ffc890", 4: "#fffbe0", 5: "#c85a10" }, w: 7 },
  { name: "Hard Hat White", style: "hardhat", colors: { 1: "#eef0f6", 2: "#b8bcc8", 3: "#ffffff", 4: "#fffbe0", 5: "#b8bcc8" }, w: 5 },
  { name: "Headphones Black", style: "headphones", colors: { 1: "#2c2f38", 2: "#3a3e48", 3: "#cf3a35" }, w: 5 },
  { name: "Headphones White", style: "headphones", colors: { 1: "#eceef2", 2: "#d0d4dc", 3: "#3d6fd1" }, w: 4 },
  { name: "Headphones Pink", style: "headphones", colors: { 1: "#f08ab4", 2: "#c96a90", 3: "#fff0f6" }, w: 3 },
  { name: "Goggles", style: "goggles", colors: { 1: "#6e4a2e", 2: "#b8bcc8", 3: "#7fd8f0" }, w: 8 },
  { name: "Straw Hat", style: "straw", colors: { 1: "#e8c77a", 2: "#c9a55a", 3: "#f5dc9c" }, w: 8 },
  { name: "Wizard Hat", style: "wizard", colors: { 1: "#3a3a9a", 2: "#2a2a75", 3: "#ffd23f", 4: "#f6f7f0" }, w: 4, tier: 1 },
  { name: "Viking Helmet", style: "viking", colors: { 1: "#a9b0bb", 2: "#7e8592", 3: "#a2733f", 4: "#f2ead2", 5: "#d6c9a6" }, w: 4, tier: 1 },
  { name: "Crown Gold", style: "crown", colors: { 1: "#f5c832", 2: "#c89a10", 3: "#fff1a8", 4: "#e0303a", 5: "#3d6fd1" }, w: 3, tier: 2 },
  { name: "Crown Jewelled", style: "jewelled", colors: { 1: "#f5c832", 2: "#c89a10", 3: "#fff1a8", 4: "#e0303a", 5: "#2fd17a", 6: "#7a2a9a", 7: "#3d8fd1" }, w: 1, tier: 2 },
  // The hood is never picked by weight: a hoodie with nothing else on the head has its hood up a third of the time,
  // in the hoodie's colours (degen-skin.js traitsOf).
  { name: "Hood", style: "hood", colors: null, w: 0 },
];

/// Accessories, mostly on the outer layer. `eyes`: shades cover the eyes but keep their shape (the eye's ink is
/// drawn on the lens in this colour), so every expression still shows.
export const ACCESSORY_STYLES = {
  chain: `jacket F 1 1 6 4 :1....1/.1..1./..11../..22..`,
  glasses: `hat F 0 0 8 1 :111..111; hat F 0 4 8 1 :.11..11.; hat F 3 1 2 1 1; hat~ R 0 1 7 1 1`,
  shades: `hat F 0 1 3 3 2; hat F 5 1 3 3 2; hat F 0 0 8 1 1; hat F 3 1 2 1 1; hat~ R 0 1 8 1 1; hat~ R 7 1 1 3 2; hat F 1 1 1 1 3; hat F 6 1 1 1 3`,
  scarf: `jacket S 0 0 * 3 1; jacket S 0 2 24 1 :2.2.2.2.2.2.2.2.2.2.2.2.; jacket F 1 3 2 5 1; jacket F 1 5 2 1 2; jacket F 1 7 2 1 2`,
  backpack: `jacket K 1 1 6 9 1; jacket K 1 1 6 1 2; jacket K 2 5 4 3 2; jacket K 3 6 2 1 3; jacket~ F 1 0 1 8 3; jacket~ T 1 0 1 * 3`,
  wristbands: `sleeves S 0 8 * 2 1; sleeves S 0 8 * 1 2`,
  toolbelt: `jacket S 0 9 * 2 1; jacket S 0 10 * 1 2; jacket F 3 9 2 2 3; jacket F 4 10 1 1 1
    pantsR R 0 0 4 4 :.44./4334/..1./..1.; pantsR F 0 0 1 3 1`,
};
export const ACCESSORIES = [
  { name: "None", style: null, w: 44 },
  { name: "Gold Chain", style: "chain", colors: { 1: "#f5c832", 2: "#c89a10" }, w: 8 },
  { name: "Glasses", style: "glasses", colors: { 1: "#2c2f38" }, w: 9 },
  { name: "Shades", style: "shades", colors: { 1: "#1b1d24", 2: "#2f3440", 3: "#0e0f13" }, eyes: "3", w: 9 },
  { name: "Scarf Red", style: "scarf", colors: { 1: "#cf3a35", 2: "#f6f7f0" }, w: 4 },
  { name: "Scarf Blue", style: "scarf", colors: { 1: "#3d6fd1", 2: "#f6f7f0" }, w: 4 },
  { name: "Backpack Brown", style: "backpack", colors: { 1: "#8a5a32", 2: "#6a4424", 3: "#3a2616" }, w: 5 },
  { name: "Backpack Red", style: "backpack", colors: { 1: "#cf3a35", 2: "#a3282a", 3: "#2c2f38" }, w: 4 },
  { name: "Wristbands", style: "wristbands", colors: { 1: "#f6f7f0", 2: "#cf3a35" }, w: 7 },
  { name: "Tool Belt", style: "toolbelt", colors: { 1: "#7a5230", 2: "#5c3d22", 3: "#f0c23a", 4: "#a9b0bb" }, w: 6 },
];

/// The sealed DEGEN, before the reveal: a shadow of a frog with a gold question mark.
export const SEALED = {
  background: "#1a1626",
  skin: { S: "#3a3746", s: "#2e2c38", l: "#46435a", d: "#2a2834", B: "#3a3746" },
  ops: `body F 2 2 4 6 :.YY./Y..Y/...Y/..Y./..../..Y.`,
};
