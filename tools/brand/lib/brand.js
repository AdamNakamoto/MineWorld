// Brand-art helpers for the MineWorldCraft / I'M DEGEN renders. Everything here draws from the game's own art: the
// DEGEN skins (lib/degen.js, rebuilt by render.sh from web/degen-skin-art.js and web/degen-skin.js), the block and plant
// tiles (the same generators as web/textures.js) and the item sprites (web/textures.js PICK_ART / CLUSTER_ART and its
// MATERIALS); plus the brand's own pixel letters.

(function () {
  const B = {};
  const N = (list, name) => { const i = list.findIndex((x) => x.name === name); if (i < 0) throw new Error("no trait " + name); return i; };
  /// A DEGEN's traits from trait names.
  B.degen = (o) => ({
    background: N(D.BACKGROUNDS, o.bg || "Sky"), skin: N(D.SKINS, o.skin || "Leaf"), eyes: N(D.EYES, o.eyes || "Calm"),
    mouth: N(D.MOUTHS, o.mouth || "Smile"), cheeks: N(D.CHEEKS, o.cheeks || "None"), top: N(D.TOPS, o.top || "Hoodie Grey"),
    bottoms: N(D.BOTTOMS, o.bottoms || "Jeans Blue"), shoes: N(D.SHOES, o.shoes || "Sneakers White"),
    headwear: N(D.HEADWEAR, o.hw || "None"), accessory: N(D.ACCESSORIES, o.acc || "None"),
  });
  /// The NFT card with its background square removed (the character and its ground shadow only).
  B.cardBare = (t, shadow = true) => {
    let s = D.cardSvg(t).replace(/<rect width="176" height="176" fill="#[0-9a-f]{6}"\/>/, "");
    if (!shadow) s = s.replace(/<ellipse[^>]*\/>/, "");
    return s;
  };

  // ------------------------------------------------------------- a 3D render of skin parts (head and bust)
  const hex6 = (c) => "#" + (c >>> 0).toString(16).padStart(6, "0").slice(-6);
  const ch = (c) => [(c >> 16) & 255, (c >> 8) & 255, c & 255];
  const pack = ([r, g, b]) => (r << 16) | (g << 8) | b;
  const LIGHT = { T: (v) => v + (((255 - v) * 48) >> 8), F: (v) => v, R: (v) => (v * 196) >> 8, L: (v) => (v * 196) >> 8, K: (v) => (v * 150) >> 8, U: (v) => (v * 120) >> 8 };
  const lit = (c, f) => pack(ch(c).map(LIGHT[f]));
  const PARTS = D.PARTS;
  /// Where the parts stand (x towards DEGEN's left, y up, z towards the front): their low corner (as the card).
  const AT = { head: [-4, 24, -4], body: [-4, 12, -2], armR: [-8, 12, -2], armL: [4, 12, -2], legR: [-4, 0, -2], legL: [0, 0, -2] };
  /// A face's pixel (i, j) corner in 3D, and its two edge vectors, for a box at [x0,y0,z0] of size [w,h,d].
  function faceGeom(face, [x0, y0, z0], [w, h, d]) {
    switch (face) {
      case "F": return { o: [x0, y0 + h, z0 + d], a: [1, 0, 0], b: [0, -1, 0], fw: w, fh: h };
      case "R": return { o: [x0, y0 + h, z0], a: [0, 0, 1], b: [0, -1, 0], fw: d, fh: h };
      case "T": return { o: [x0, y0 + h, z0], a: [1, 0, 0], b: [0, 0, 1], fw: w, fh: d };
      case "L": return { o: [x0 + w, y0 + h, z0 + d], a: [0, 0, -1], b: [0, -1, 0], fw: d, fh: h };
      case "K": return { o: [x0 + w, y0 + h, z0], a: [-1, 0, 0], b: [0, -1, 0], fw: w, fh: h };
      case "U": return { o: [x0, y0, z0 + d], a: [1, 0, 0], b: [0, 0, -1], fw: w, fh: d };
    }
  }
  /// Renders `parts` ([[part, faces, layer: 0 base | 1 over]]) of skin colours `px` with projection `P`
  /// ({ex, ey, ez, ox, oy} screen vectors per skin pixel). Returns SVG path markup.
  B.render3d = (px, list, P, opt = {}) => {
    const proj = ([x, y, z]) => [P.ox + x * P.ex[0] + y * P.ey[0] + z * P.ez[0], P.oy + x * P.ex[1] + y * P.ey[1] + z * P.ez[1]];
    const r = (v) => Math.round(v * 100) / 100;
    let out = "";
    for (const [part, faces, layer, inflate] of list) {
      const Pt = PARTS[part], size = Pt.size, at = AT[part], uv = layer ? Pt.over : Pt.uv;
      const g = layer ? (inflate ?? (part === "head" ? 0.5 : 0.25)) : 0;
      const at2 = at.map((v) => v - g), size2 = size.map((v) => v + 2 * g);
      for (const face of faces) {
        const G = faceGeom(face, at2, size2);
        const [bu, bv, fw, fh] = D.faceBox(size, face);
        const sa = size2[G.a.findIndex((v) => v !== 0)] / fw, sb = size2[G.b.findIndex((v) => v !== 0)] / fh;
        const runs = new Map();
        for (let j = 0; j < fh; j++) {
          for (let i = 0; i < fw;) {
            const at = (ii) => px[(uv[1] + bv + j) * 64 + uv[0] + bu + ii];
            const c = at(i);
            let n = 1;
            while (i + n < fw && at(i + n) === c) n++;
            if (c >= 0) {
              const col = hex6(lit(c, face));
              const p0 = G.o.map((v, k) => v + G.a[k] * i * sa + G.b[k] * j * sb);
              const pa = G.a.map((v) => v * n * sa), pb = G.b.map((v) => v * sb);
              const A = proj(p0), Bp = proj(p0.map((v, k) => v + pa[k])), C = proj(p0.map((v, k) => v + pa[k] + pb[k])), Dd = proj(p0.map((v, k) => v + pb[k]));
              runs.set(col, (runs.get(col) || "") + `M${r(A[0])} ${r(A[1])}L${r(Bp[0])} ${r(Bp[1])}L${r(C[0])} ${r(C[1])}L${r(Dd[0])} ${r(Dd[1])}z`);
            }
            i += n;
          }
        }
        const sw = opt.seam ?? 0.6;
        for (const [col, d] of runs) out += `<path fill="${col}" stroke="${col}" stroke-width="${sw}" stroke-linejoin="round" d="${d}"/>`;
      }
    }
    return out;
  };

  // ------------------------------------------------------------- the game's 16 x 16 item sprites
  B.MATERIALS = {
    wood: ["#4a3418", "#7d5a2b", "#a77f45", "#c9a062", "#e6c58a"],
    stone: ["#29292b", "#505054", "#76767a", "#98989c", "#bcbcc0"],
    iron: ["#3b3b40", "#85858d", "#b6b6be", "#d8d8dd", "#ffffff"],
    diamond: ["#0c3431", "#136b64", "#1fa498", "#45d6c8", "#a9f5ec"],
    crystal: ["#250843", "#4f1a85", "#7f34c2", "#a95ee8", "#ef86ff"],
    gold: ["#5a3d05", "#a9740e", "#dca21c", "#f4cd45", "#fff0a0"],
  };
  const HANDLE = ["#2b1c0b", "#4f3418", "#7a552a"];
  B.PICK_ART = [
    "......ooooo.....", "...ooolhhlloo...", ".oollhmmlmlhlo..", "omlooooooomlhlo.", "ooo.......omllo.", "..........womlmo",
    ".........WO.olmo", "........wO..olmo", ".......WO...olmo", "......wO....oldo", ".....WO.....omo.", "....wO......odo.",
    "...WO.......omo.", "..wO.......odo..", ".WO........odo..", "OO.........oo...",
  ];
  B.CLUSTER_ART = [
    "................", ".......oo.......", "......ohlo......", ".....ohlmdo.....", ".....ohlmdo.oo..",
    ".....ohlmdoolmo.", "..oo.ohlmdolmdo.", ".ohloohlmdolmdo.", ".ohlmohlmdolmdo.", ".ohlmohlmdolmdo.",
    ".ohlmohlmdolmdo.", ".ohlmohlmdolmdo.", ".ohlmohlmdolmdo.", ".oooooooooooooo.", "................", "................",
  ];
  B.GEM_ART = [
    "................", "................", "....oooooooo....", "...ohhllllmmo...", "..ohlhlllllmmo..",
    ".ohllllllllmmdo.", ".oddmmmmmmmmddo.", "..ollmmmmmmddo..", "...olmmmmmddo...", "....olmmmddo....",
    ".....olmddo.....", "......oldo......", ".......oo.......", "................", "................", "................",
  ];
  const shades = (m) => { const [o, d, mm, l, h] = B.MATERIALS[m]; return { o, d, m: mm, l, h, O: HANDLE[0], W: HANDLE[1], w: HANDLE[2] }; };
  /// A sprite as an SVG group of 1 x 1 rects (one path per colour), in a 16 x 16 box. `outline`: an extra colour
  /// ring around the sprite (a sticker edge), `ow` pixels thick.
  B.sprite = (rows, mat, outline, ow = 1) => {
    const pal = typeof mat === "string" ? shades(mat) : mat;
    const by = new Map();
    const add = (c, d) => by.set(c, (by.get(c) || "") + d);
    if (outline) {
      const solid = (x, y) => (rows[y]?.[x] ?? ".") !== ".";
      for (let y = -ow; y < rows.length + ow; y++) for (let x = -ow; x < 16 + ow; x++) {
        if (solid(x, y)) continue;
        let near = false;
        for (let dy = -ow; dy <= ow && !near; dy++) for (let dx = -ow; dx <= ow && !near; dx++) if (solid(x + dx, y + dy)) near = true;
        if (near) add(outline, `M${x} ${y}h1v1h-1z`);
      }
    }
    rows.forEach((row, y) => [...row].forEach((c, x) => { if (c !== ".") add(pal[c], `M${x} ${y}h1v1h-1z`); }));
    let s = "";
    for (const [c, d] of by) s += `<path fill="${c}" d="${d}"/>`;
    return s;
  };

  // ------------------------------------------------------------- block tiles (as web/textures.js draws them)
  function prng(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
  const clamp = (v) => Math.max(0, Math.min(255, v | 0));
  const hx = (c) => [(c >> 16) & 255, (c >> 8) & 255, c & 255];
  function tile(seed, fn) {
    const d = new Uint8ClampedArray(256 * 4), r = prng(seed);
    const set = (x, y, c, a = 255, j = 0) => {
      if (x < 0 || y < 0 || x >= 16 || y >= 16) return;
      const [R, G, Bb] = hx(c), k = (y * 16 + x) * 4, n = j ? (r() - 0.5) * j : 0;
      d[k] = clamp(R + n); d[k + 1] = clamp(G + n); d[k + 2] = clamp(Bb + n); d[k + 3] = a;
    };
    fn(set, r);
    return d;
  }
  function blend(a, b, t) { const A = hx(a), Bb = hx(b); return (clamp(A[0] + (Bb[0] - A[0]) * t) << 16) | (clamp(A[1] + (Bb[1] - A[1]) * t) << 8) | clamp(A[2] + (Bb[2] - A[2]) * t); }
  function stoneTile(seed, base = 0x7f7f7f) {
    return tile(seed, (set, r) => {
      for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) set(x, y, base, 255, 26);
      for (let i = 0; i < 9; i++) { const x = (r() * 16) | 0, y = (r() * 16) | 0, len = 1 + ((r() * 3) | 0); for (let k = 0; k < len; k++) set(x + k, y, blend(base, 0, 0.25), 255, 8); }
    });
  }
  function oreTile(seed, color, glow = false, base) {
    const d = stoneTile(seed, base), r = prng(seed + 7);
    for (let i = 0; i < 5; i++) {
      const cx = 2 + ((r() * 12) | 0), cy = 2 + ((r() * 12) | 0);
      for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1], [-1, 0], [0, -1]]) {
        if (r() < 0.25 && !(dx === 0 && dy === 0)) continue;
        const x = cx + dx, y = cy + dy, k = (y * 16 + x) * 4;
        const [R, G, Bb] = hx(dx === 0 && dy === 0 && !glow ? blend(color, 0xffffff, 0.35) : color);
        const n = (r() - 0.5) * 30;
        d[k] = clamp(R + n); d[k + 1] = clamp(G + n); d[k + 2] = clamp(Bb + n);
      }
    }
    return d;
  }
  B.TILES = {
    dirt: (s = 11) => tile(s, (set, r) => { for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) set(x, y, r() < 0.12 ? 0x6b4a30 : r() < 0.1 ? 0x9a7352 : 0x86603f, 255, 18); }),
    grass_top: (s = 12) => tile(s, (set, r) => { for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) set(x, y, r() < 0.15 ? 0x4f8a2a : r() < 0.1 ? 0x77b545 : 0x62a136, 255, 20); }),
    grass_side: (s = 13) => tile(s, (set, r) => {
      for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) set(x, y, r() < 0.12 ? 0x6b4a30 : 0x86603f, 255, 18);
      for (let x = 0; x < 16; x++) { const drip = 3 + (r() < 0.4 ? 1 : 0) + (r() < 0.15 ? 1 : 0); for (let y = 0; y < drip; y++) set(x, y, 0x62a136, 255, 22); }
    }),
    stone: (s = 14) => stoneTile(s),
    deep: (s = 15) => stoneTile(s, 0x4a4a52),
    coal_ore: (s = 24) => oreTile(s, 0x222222),
    gold_ore: (s = 26) => oreTile(s, 0xf5d33a),
    diamond_ore: (s = 27) => oreTile(s, 0x5fe8e0),
    mine_ore: (s = 28) => oreTile(s, 0xd25bff, true),
    mine_ore_deep: (s = 28) => oreTile(s, 0xd25bff, true, 0x4a4a52),
    // Plants (web/textures.js): drawn on a clear background.
    tall_grass: () => tile(60, (set, r) => {
      for (let b = 0; b < 12; b++) {
        let x = 0.5 + b * 1.25 + r() * 1.2;
        const h = 7 + ((r() * 9) | 0), lean = (x - 7.5) * 0.04 + (r() - 0.5) * 0.3;
        for (let k = 0; k < h; k++) { set(Math.round(x), 15 - k, k > h - 3 ? 0x8cc456 : k < 3 ? 0x3e7a24 : r() < 0.5 ? 0x5a9c34 : 0x68aa3c, 255, 14); x += lean; }
      }
    }),
    flower_yellow: () => tile(62, (set) => {
      stem(set, 7, 7);
      for (let y = 1; y <= 7; y++) for (let x = 4; x <= 11; x++) {
        const dx = x - 7.5, dy = y - 4, d = dx * dx + dy * dy;
        if (d > 11.5) continue;
        set(x, y, d < 1.8 ? 0xd9821c : (x + y) % 3 === 0 ? 0xfff27e : 0xf2cf2e, 255, 10);
      }
    }),
    flower_red: () => tile(63, (set) => {
      stem(set, 7, 6, 12);
      const rows = ["......R.........", ".....RR.........", ".....RhR........", "..R..RhR..R.....", "..RR.RRR.RR.....", "...RRRRRRR......", "...dRRRRRd......", "....ddRdd......."];
      rows.forEach((row, y) => [...row].forEach((ch, x) => {
        if (ch === "R") set(x + 1, y, 0xd8322a, 255, 12); else if (ch === "h") set(x + 1, y, 0xff7a52, 255, 6); else if (ch === "d") set(x + 1, y, 0x921a16, 255, 6);
      }));
    }),
  };
  function stem(set, x, top, leafY = 11) {
    for (let y = top; y < 16; y++) set(x, y, y > 12 ? 0x3c7a26 : 0x4f9a30, 255, 8);
    for (const [dx, dy] of [[-1, 0], [-2, -1], [-3, -1]]) set(x + dx, leafY + dy, 0x5aa83a, 255, 10);
    for (const [dx, dy] of [[1, 2], [2, 1], [3, 1]]) set(x + dx, leafY + dy, 0x4a9030, 255, 10);
  }
  /// A tile's RGBA as a canvas (16 x 16).
  B.tileCanvas = (rgba, shade = 1) => {
    const c = document.createElement("canvas"); c.width = c.height = 16;
    const g = c.getContext("2d"), im = g.createImageData(16, 16);
    for (let i = 0; i < rgba.length; i += 4) { im.data[i] = rgba[i] * shade; im.data[i + 1] = rgba[i + 1] * shade; im.data[i + 2] = rgba[i + 2] * shade; im.data[i + 3] = rgba[i + 3]; }
    g.putImageData(im, 0, 0);
    return c;
  };
  B.svgImage = (svg) => new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg); });
  B.prng = prng;
  window.B = B;
})();


// ------------------------------------------------------------- the brand's own pixel letters (drawn for this brand)
// Two faces: DISPLAY, 9 rows with 2-pixel strokes (the wordmark and I'M DEGEN), and TEXT, 7 rows with 2-pixel uprights
// and 1-pixel bars (taglines). Letters are flat colour with one hard offset shadow and a dark outline, the way the
// game's own title is set: no texture, no bevel, no gradient.
(function () {
  const B = window.B;
  B.DISPLAY = {
    M: ["##....##", "###..###", "########", "##.##.##", "##.##.##", "##....##", "##....##", "##....##", "##....##"],
    W: ["##....##", "##....##", "##....##", "##.##.##", "##.##.##", "##.##.##", "########", "###..###", "##....##"],
    I: ["######", "######", "..##..", "..##..", "..##..", "..##..", "..##..", "######", "######"],
    N: ["##....##", "###...##", "####..##", "##.#..##", "##.##.##", "##..#.##", "##..####", "##...###", "##....##"],
    E: ["#######", "#######", "##.....", "##.....", "######.", "##.....", "##.....", "#######", "#######"],
    O: [".#####.", "#######", "##...##", "##...##", "##...##", "##...##", "##...##", "#######", ".#####."],
    R: ["######.", "#######", "##...##", "##...##", "######.", "#####..", "##.###.", "##..###", "##...##"],
    L: ["##.....", "##.....", "##.....", "##.....", "##.....", "##.....", "##.....", "#######", "#######"],
    D: ["######.", "#######", "##...##", "##...##", "##...##", "##...##", "##...##", "#######", "######."],
    C: [".######", "#######", "##.....", "##.....", "##.....", "##.....", "##.....", "#######", ".######"],
    A: [".#####.", "#######", "##...##", "##...##", "#######", "#######", "##...##", "##...##", "##...##"],
    F: ["#######", "#######", "##.....", "##.....", "######.", "##.....", "##.....", "##.....", "##....."],
    T: ["########", "########", "...##...", "...##...", "...##...", "...##...", "...##...", "...##...", "...##..."],
    G: [".######", "#######", "##.....", "##.....", "##.####", "##.####", "##...##", "#######", ".#####."],
    S: [".######", "#######", "##.....", "######.", ".######", ".....##", ".....##", "#######", "######."],
    $: ["...##...", ".######.", "########", "##.##...", "#######.", ".#######", "...##.##", "########", ".######.", "...##..."],
    "'": ["##", "##", ".#", "..", "..", "..", "..", "..", ".."],
    " ": ["....", "....", "....", "....", "....", "....", "....", "....", "...."],
  };
  B.TEXT = {
    A: [".####.", "##..##", "##..##", "######", "##..##", "##..##", "##..##"],
    B: ["#####.", "##..##", "##..##", "#####.", "##..##", "##..##", "#####."],
    C: [".#####", "##....", "##....", "##....", "##....", "##....", ".#####"],
    D: ["#####.", "##..##", "##..##", "##..##", "##..##", "##..##", "#####."],
    E: ["######", "##....", "##....", "#####.", "##....", "##....", "######"],
    F: ["######", "##....", "##....", "#####.", "##....", "##....", "##...."],
    G: [".#####", "##....", "##....", "##.###", "##..##", "##..##", ".#####"],
    H: ["##..##", "##..##", "##..##", "######", "##..##", "##..##", "##..##"],
    I: ["####", ".##.", ".##.", ".##.", ".##.", ".##.", "####"],
    K: ["##..##", "##.##.", "####..", "###...", "####..", "##.##.", "##..##"],
    L: ["##....", "##....", "##....", "##....", "##....", "##....", "######"],
    M: ["##...##", "###.###", "#######", "##.#.##", "##...##", "##...##", "##...##"],
    N: ["##..##", "###.##", "######", "##.###", "##..##", "##..##", "##..##"],
    O: [".####.", "##..##", "##..##", "##..##", "##..##", "##..##", ".####."],
    P: ["#####.", "##..##", "##..##", "#####.", "##....", "##....", "##...."],
    R: ["#####.", "##..##", "##..##", "#####.", "##.##.", "##..##", "##..##"],
    S: [".#####", "##....", "##....", ".####.", "....##", "....##", "#####."],
    T: ["######", "..##..", "..##..", "..##..", "..##..", "..##..", "..##.."],
    U: ["##..##", "##..##", "##..##", "##..##", "##..##", "##..##", ".####."],
    V: ["##..##", "##..##", "##..##", "##..##", "##..##", ".####.", "..##.."],
    W: ["##...##", "##...##", "##...##", "##.#.##", "#######", "###.###", "##...##"],
    Y: ["##..##", "##..##", "##..##", ".####.", "..##..", "..##..", "..##.."],
    0: [".####.", "##..##", "##.###", "######", "###.##", "##..##", ".####."],
    1: [".##.", "###.", ".##.", ".##.", ".##.", ".##.", "####"],
    3: ["#####.", "....##", "....##", "..###.", "....##", "....##", "#####."],
    "$": ["...#...", ".######", "##.#...", ".#####.", "...#.##", "######.", "...#..."],
    ".": ["..", "..", "..", "..", "..", "##", "##"],
    ",": ["..", "..", "..", "..", "..", "##", "##", "#."],
    "-": ["....", "....", "....", "####", "....", "....", "...."],
    "·": ["..", "..", "..", "##", "##", "..", ".."],
    "'": ["##", "##", "#.", "..", "..", "..", ".."],
    " ": ["...", "...", "...", "...", "...", "...", "..."],
  };
  const DISPLAY_LIFT = { $: -0.5 };

  /// Lays out `segs` ([[text, face, shadow], ...]) in `font` as one line, `p` screen pixels per letter pixel.
  /// o: { gap: pixels between letters, shadow: [dx, dy] in letter pixels (one hard offset copy in each segment's
  /// shadow colour), ol: outline colour, olw: outline width in letter pixels }.
  /// Returns { svg, w, h }: an SVG <g> with its top-left letter pixel at (0, 0), and the line's size (letters only).
  B.pixelText = (segs, font, p, o = {}) => {
    const gap = o.gap ?? 1, [sx, sy] = o.shadow ?? [1, 1], olw = o.olw ?? 1;
    const face = new Map(), shade = new Map(), outline = [];
    const add = (m, c, d) => m.set(c, (m.get(c) || "") + d);
    let x = 0, first = true;
    for (const [text, fc, sc] of segs) {
      for (const ch of text) {
        const gl = font[ch];
        if (!gl) throw new Error("no glyph " + JSON.stringify(ch));
        if (!first) x += gap;
        first = false;
        const dy = font === B.DISPLAY ? DISPLAY_LIFT[ch] || 0 : 0;
        gl.forEach((row, y) => {
          for (let i = 0; i < row.length;) {
            if (row[i] !== "#") { i++; continue; }
            let n = 1;
            while (i + n < row.length && row[i + n] === "#") n++;
            const X = (x + i) * p, Y = (y + dy) * p, w = n * p;
            const r = (ox, oy) => `M${X + ox} ${Y + oy}h${w}v${p}h${-w}z`;
            add(face, fc, r(0, 0));
            if (sc) add(shade, sc, r(sx * p, sy * p));
            outline.push(r(0, 0)); if (sc) outline.push(r(sx * p, sy * p));
            i += n;
          }
        });
        x += gl[0].length;
      }
    }
    let svg = "";
    if (o.ol) svg += `<path fill="${o.ol}" stroke="${o.ol}" stroke-width="${2 * olw * p}" stroke-linejoin="miter" d="${outline.join("")}"/>`;
    for (const [c, d] of shade) svg += `<path fill="${c}" d="${d}"/>`;
    for (const [c, d] of face) svg += `<path fill="${c}" d="${d}"/>`;
    return { svg: `<g shape-rendering="crispEdges">${svg}</g>`, w: x * p, h: (font === B.DISPLAY ? 9 : 7) * p };
  };
  /// The same, placed: centred on x (anchor "middle") or from x ("start"), its top at y.
  B.pixelLine = (segs, font, p, x, y, o = {}) => {
    const t = B.pixelText(segs, font, p, o);
    const X = Math.round(o.anchor === "start" ? x : x - t.w / 2);
    return { svg: `<g transform="translate(${X} ${y})">${t.svg}</g>`, w: t.w, h: t.h, x: X };
  };
})();
