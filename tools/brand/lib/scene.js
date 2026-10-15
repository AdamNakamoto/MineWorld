// The banner scene: a night sky with the rocket's other worlds, a dusk glow along the curve of the tiny blocky home
// planet (the game's own block tiles, with grass, flowers and glowing $MINE and gold ore), DEGENs (their real NFT
// cards, background removed) standing on it, $MINE crystal clusters, and the flat pixel wordmark. Shared by
// banner-x.html and banner-opensea.html; each passes its own layout.

(function () {
  const S = {};
  const px3 = (g, x, y, w, h, c) => { g.fillStyle = c; g.fillRect(x, y, w, h); };
  const shade = (c, k) => "#" + [1, 3, 5].map((i) => Math.max(0, Math.min(255, Math.round(parseInt(c.slice(i, i + 2), 16) * k))).toString(16).padStart(2, "0")).join("");
  S.shade = shade;
  const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16);

  /// Sets up a canvas for crisp drawing at the device's pixel ratio; returns its context in CSS pixels.
  S.ctx = (canvas, W, H) => {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = W * dpr; canvas.height = H * dpr;
    const g = canvas.getContext("2d"); g.scale(dpr, dpr); g.imageSmoothingEnabled = false;
    return g;
  };

  /// Night sky: stepped bands toward the horizon, and pixel stars (some of them sparkles), none inside the `keepOut`
  /// boxes ([x0, y0, x1, y1], e.g. round the type, so no star reads as a full stop).
  S.sky = (g, W, H, o = {}) => {
    const bands = o.bands || ["#0b1026", "#0e1230", "#121539", "#171843", "#1d1b4e", "#241e5a", "#2c2167"];
    const top = o.glowTop ?? H * 0.35, bottom = o.glowBottom ?? H * 0.86, step = 8;
    px3(g, 0, 0, W, H, bands[0]);
    for (let i = 1; i < bands.length; i++) {
      const y = Math.round((top + ((bottom - top) * (i - 1)) / (bands.length - 1)) / step) * step;
      px3(g, 0, y, W, H - y, bands[i]);
    }
    const r = B.prng(o.seed || 7), boxes = o.keepOut || [];
    const keep = (x, y) => boxes.some(([x0, y0, x1, y1]) => x > x0 - 8 && x < x1 + 8 && y > y0 - 8 && y < y1 + 8);
    for (let i = 0; i < (o.stars ?? 140); i++) {
      const x = Math.floor((r() * W) / 3) * 3, y = Math.floor((r() * H * 0.8) / 3) * 3, k = r(), a = 0.35 + r() * 0.65;
      if (keep(x, y)) continue;
      const c = k < 0.12 ? "#f5c832" : k < 0.22 ? "#c9a6ff" : "#e8ecf4";
      g.globalAlpha = a;
      if (k > 0.94) { px3(g, x - 3, y, 9, 3, c); px3(g, x, y - 3, 3, 9, c); } else px3(g, x, y, 3, 3, c);
    }
    g.globalAlpha = 1;
  };

  /// A dusk glow hugging the planet's rim (centre cx, cy, radius R): dithered pixel steps from warm orange at the
  /// horizon out through rose and violet into the night, `depth` pixels deep, on a `cell` pixel grid.
  S.dusk = (g, W, H, { cx, cy, R }, o = {}) => {
    const pal = o.palette || ["#2a1f63", "#3a2373", "#52297e", "#723185", "#9a3d84", "#c4507a", "#e2696b", "#f2895f", "#f9a85e"];
    const depth = o.depth ?? 110, cell = o.cell ?? 4, peak = o.peak ?? pal.length;
    for (let y = 0; y < H; y += cell) for (let x = 0; x < W; x += cell) {
      const d = Math.hypot(x + cell / 2 - cx, y + cell / 2 - cy) - R;
      if (d < -cell || d > depth) continue;
      // brightest straight above the middle, a little weaker toward the sides
      const side = Math.min(1, Math.abs(x - (o.mid ?? cx)) / (o.spread ?? W));
      let t = Math.pow(1 - Math.max(0, d) / depth, o.curve ?? 1.6) * (1 - 0.35 * side);
      const v = t * peak + BAYER[((y / cell) % 4) * 4 + ((x / cell) % 4)] - 0.5;
      const i = Math.floor(v);
      if (i < 0) continue;
      px3(g, x, y, cell, cell, pal[Math.min(pal.length - 1, i)]);
    }
  };

  /// A pixel planet: a stepped disc of radius r (grid p) at (cx, cy), lit from the upper left, painted by
  /// `paint(i, j)` -> colour (i, j: grid cell from the centre).
  S.planet = (g, cx, cy, r, p, paint) => {
    const n = Math.ceil(r / p);
    for (let j = -n; j < n; j++) for (let i = -n; i < n; i++) {
      const dx = (i + 0.5) * p, dy = (j + 0.5) * p, d = Math.hypot(dx, dy);
      if (d > r) continue;
      let c = paint(i, j, d / r);
      const l = (dx * 0.7 + dy * 0.7) / r;
      if (l > 0.35) c = shade(c, l > 0.7 ? 0.55 : 0.75); else if (l < -0.55) c = shade(c, 1.18);
      px3(g, cx + i * p, cy + j * p, p, p, c);
    }
  };
  /// The rocket's three worlds, as small pixel planets.
  S.worlds = {
    // Deepvein: rocky grey-blue, rich in ore
    deep: (g, x, y, r, p = 4) => {
      const rr = B.prng(31), ore = new Set();
      for (let k = 0; k < 18; k++) ore.add(`${Math.floor(rr() * 30 - 15)},${Math.floor(rr() * 30 - 15)}`);
      S.planet(g, x, y, r, p, (i, j) => (ore.has(`${i},${j}`) ? (rr() < 0.5 ? "#d25bff" : "#5fe8e0") : ((i * 7 + j * 13) & 7) < 2 ? "#6f7a8f" : "#8792a8"));
    },
    // Cinderfall: ash and lava
    boss: (g, x, y, r, p = 4) => S.planet(g, x, y, r, p, (i, j) => { const v = Math.sin(i * 0.9 + j * 0.4) + Math.sin(j * 1.3 - i * 0.5); return v > 1.2 ? "#ff8a2a" : v > 0.9 ? "#e0402a" : ((i + j) & 3) === 0 ? "#3a2a2e" : "#4a3438"; }),
    // Red Mesa: terracotta bands
    pvp: (g, x, y, r, p = 4) => S.planet(g, x, y, r, p, (i, j) => ["#d97a4a", "#c4603a", "#e8a070", "#b8502e", "#e08a58"][(j + 40 + ((i * 3) >> 3)) % 5]),
  };

  // ------------------------------------------------------------- the rocket (after the game's rocket model)
  const ROCKET = [
    "....R....", "...RRR...", "..RRRRR..", "..WWWWW..", "..RRRRR..", "..WWWWW..", "..WCCWW..", "..WCcWW..",
    "..WWWWW..", "..WWWWW..", "..RRRRR..", ".RWWWWWR.", "RRWWWWWRR", "RR.DDD.RR",
  ];
  const FLAME = ["...fyf...", "...fyf...", "....f...."];
  const RPAL = { R: "#d23a30", W: "#eef0f2", C: "#8fd8ff", c: "#2a6a8a", D: "#3a3e46", f: "#ff7a1a", y: "#fff0a0" };
  const art = (rows, p, pal = RPAL) => {
    const c = document.createElement("canvas"); c.width = rows[0].length * p; c.height = rows.length * p;
    const k = c.getContext("2d");
    rows.forEach((row, j) => [...row].forEach((ch, i) => {
      if (ch === ".") return;
      // the right-hand column of each colour run a shade darker: a little roundness
      const right = i + 1 >= row.length || row[i + 1] !== ch, col = pal[ch];
      k.fillStyle = right && "RW".includes(ch) && i > 3 ? shade(col, 0.82) : col;
      k.fillRect(i * p, j * p, p, p);
    }));
    return c;
  };
  /// The rocket in flight at (x, y) (its middle), turned by `angle` (0 = nose up).
  S.rocket = (g, x, y, p, angle = 0.5) => {
    const c = art([...ROCKET, ...FLAME], p);
    g.save(); g.translate(x, y); g.rotate(angle); g.drawImage(c, -c.width / 2, -c.height / 2); g.restore();
  };
  /// The rocket lifting off its pad: the pad's top middle at (x, y), the rocket `lift` px up on a long flame, with
  /// pixel smoke billowing out along the pad.
  S.launch = (g, x, y, p, lift, seed = 3) => {
    const c = art(ROCKET, p), q = (v) => Math.round(v / p) * p;
    // pad: a steel plate on two legs
    px3(g, x - 9 * p, y - p, 18 * p, p, "#8a909c"); px3(g, x - 9 * p, y, 18 * p, p, "#3a3e46");
    px3(g, x - 7 * p, y + p, p, p, "#2a2d34"); px3(g, x + 6 * p, y + p, p, p, "#2a2d34");
    // smoke: pixel puffs rolling out along the pad on both sides, lit on top
    const r = B.prng(seed), puffs = [];
    for (let i = 0; i < 26; i++) {
      const side = i % 2 ? 1 : -1, d = 2 * p + r() * 9 * p + (i >> 1) * p * 0.4, s = (2 + r() * 3 * Math.max(0, 1 - d / (18 * p))) * p;
      puffs.push([x + side * d, y + p * 0.5 - r() * 2 * p * Math.max(0, 1 - d / (18 * p)), Math.max(p, s)]);
    }
    puffs.sort((a, b) => b[2] - a[2]);
    for (const [px, py, z] of puffs) {
      const Z = q(z), X = q(px - Z / 2), Y = q(py - Z);
      px3(g, X, Y, Z, Z, "#c7bde0"); px3(g, X, Y, Z, Math.max(p, q(Z * 0.45)), "#eef0f6"); px3(g, X, Y + Z - p, Z, p, "#9d8fc4");
    }
    // flame: orange round a yellow core, white-hot in the middle, tapering to a point
    const fy = y - p - lift, L = Math.max(3, Math.round(lift / p) + 2);
    for (let j = 0; j < L; j++) {
      const w = j < L - 2 ? 3 : 1, Y = fy + j * p;
      px3(g, x - (w * p) / 2, Y, w * p, p, j > L - 3 ? "#ff7a1a" : "#ff8c2a");
      if (j < L - 2) px3(g, x - p / 2, Y, p, p, j < 2 ? "#ffffff" : "#ffe27a");
    }
    g.drawImage(c, Math.round(x - c.width / 2), Math.round(fy - c.height));
  };

  // ------------------------------------------------------------- the tiny round home planet
  /// Rings of blocks around (cx, cy), the surface (outer edge of the grass) at radius R: grass, then dirt, then stone
  /// with ores ($MINE crystal ore most of all, glowing), each block a game tile turned to face out from the middle.
  /// Tall grass and flowers grow on top. Returns { at(deg, lift) -> [x, y] on the surface }.
  S.roundPlanet = (g, W, H, o) => {
    const { cx, cy, R, bs } = o, T = B.TILES, rnd = B.prng(o.seed || 3);
    const tiles = {
      grass: [0, 1, 2].map((k) => B.tileCanvas(T.grass_side(13 + k * 101))),
      dirt: [0, 1, 2].map((k) => B.tileCanvas(T.dirt(11 + k * 97))),
      stone: [0, 1, 2].map((k) => B.tileCanvas(T.stone(14 + k * 89))),
      mine: [0, 1, 2].map((k) => B.tileCanvas(T.mine_ore(28 + k * 53))),
      gold: [0, 1].map((k) => B.tileCanvas(T.gold_ore(26 + k * 41))),
      diamond: [B.tileCanvas(T.diamond_ore(27))],
      coal: [B.tileCanvas(T.coal_ore(24))],
      plants: [B.tileCanvas(T.tall_grass()), B.tileCanvas(T.tall_grass()), B.tileCanvas(T.flower_yellow()), B.tileCanvas(T.flower_red())],
    };
    // the planet's body (shows between the blocks as mortar)
    g.fillStyle = o.mortar || "#1d1a24"; g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.fill();
    g.imageSmoothingEnabled = false;
    const rings = o.rings ?? Math.ceil(Math.max(H - (cy - R), 0) / bs) + 2;
    const glows = [];
    const block = (tile, rc, th, shadeA, hi, glow) => {
      const x = cx + rc * Math.sin(th), y = cy - rc * Math.cos(th);
      if (x < -bs || x > W + bs || y < -bs || y > H + bs) return;
      g.save(); g.translate(x, y); g.rotate(th);
      g.drawImage(tile, -bs / 2, -bs / 2, bs, bs);
      if (shadeA > 0) { g.fillStyle = `rgba(11,16,38,${shadeA})`; g.fillRect(-bs / 2, -bs / 2, bs, bs); }
      if (hi) { g.fillStyle = hi; g.fillRect(-bs / 2, -bs / 2, bs, Math.max(2, bs / 16)); }
      g.restore();
      if (glow) glows.push([x, y, glow]);
    };
    for (let k = rings - 1; k >= 0; k--) {
      const rc = R - (k + 0.5) * bs, n = Math.round((2 * Math.PI * rc) / bs);
      for (let i = 0; i < n; i++) {
        const th = (i / n) * Math.PI * 2 + (k % 2 ? Math.PI / n : 0);
        let t, glow = null;
        if (k === 0) t = tiles.grass[i % 3];
        else if (k < (o.dirt ?? 2)) t = tiles.dirt[(i + k) % 3];
        else {
          const v = rnd();
          if (v < (o.mine ?? 0.16)) { t = tiles.mine[(i + k) % 3]; glow = "210,91,255"; }
          else if (v < (o.mine ?? 0.16) + 0.07) { t = tiles.gold[i % 2]; glow = "245,200,50"; }
          else if (v < (o.mine ?? 0.16) + 0.09) t = tiles.diamond[0];
          else if (v < (o.mine ?? 0.16) + 0.14) t = tiles.coal[0];
          else t = tiles.stone[(i * 7 + k) % 3];
        }
        block(t, rc, th, k === 0 ? 0 : Math.min(0.55, (o.stoneShade ?? 0.26) + (k - 1) * 0.12), k === 0 ? "rgba(190,240,130,0.6)" : null, glow);
      }
    }
    // ore glow: a soft light round each $MINE and gold ore block
    g.save(); g.globalCompositeOperation = "lighter";
    for (const [x, y, c] of glows) {
      const gr = g.createRadialGradient(x, y, 0, x, y, bs * 0.95);
      gr.addColorStop(0, `rgba(${c},${o.oreGlow ?? 0.3})`); gr.addColorStop(1, `rgba(${c},0)`);
      g.fillStyle = gr; g.fillRect(x - bs * 1.2, y - bs * 1.2, bs * 2.4, bs * 2.4);
    }
    g.restore();
    // tall grass and flowers along the top, turned to stand on the curve
    const pr = B.prng((o.seed || 3) + 99), avoid = o.avoid || (() => false);
    const span = o.plantSpan ?? 40;
    for (let i = 0; i < (o.plants ?? 60); i++) {
      const deg = -span + pr() * 2 * span, th = (deg * Math.PI) / 180, kind = pr(), sc = 0.5 + pr() * 0.4;
      const tile = kind < 0.62 ? tiles.plants[i % 2] : kind < 0.82 ? tiles.plants[2] : tiles.plants[3];
      const x = cx + R * Math.sin(th), y = cy - R * Math.cos(th);
      if (x < -bs || x > W + bs || avoid(x, deg)) continue;
      const s = bs * sc;
      g.save(); g.translate(x, y); g.rotate(th); g.drawImage(tile, -s / 2, -s + 1, s, s); g.restore();
    }
    return { at: (deg, lift = 0) => { const th = (deg * Math.PI) / 180, r = R + lift; return [cx + r * Math.sin(th), cy - r * Math.cos(th)]; }, R, cx, cy };
  };

  // ------------------------------------------------------------- DEGENs and things standing on the planet
  /// A DEGEN card (no background), `size` px for the 176-unit card square, its feet at (x, footY). The card's figure
  /// spans x 52-124, y 12-160 of the square; its feet stand at about (88, 153).
  S.degenAt = (t, x, footY, size) => {
    const k = size / 176, X = x - 88 * k, Y = footY - 153 * k;
    return `<svg x="${X}" y="${Y}" width="${size}" height="${size}" viewBox="0 0 176 176">${B.cardBare(t).replace(/^<svg[^>]*>/, "").replace(/<\/svg>$/, "")}</svg>`;
  };
  /// A DEGEN standing on the round planet at `deg` (0 = top), turned to stand upright on it (by at most `maxTilt`
  /// degrees). `held(x, footY, k)`: extra art in the DEGEN's frame (k = size / 176), drawn over it.
  S.degenOn = (planet, t, deg, size, o = {}) => {
    const [x, y] = planet.at(deg, o.lift || 0), tilt = Math.max(-(o.maxTilt ?? 12), Math.min(o.maxTilt ?? 12, deg));
    const foot = y + 2;
    return `<g transform="rotate(${tilt} ${x} ${y})">${o.behind ? o.behind(x, foot, size / 176) : ""}${S.degenAt(t, x, foot, size)}${o.held ? o.held(x, foot, size / 176) : ""}</g>`;
  };
  /// The game's crystal pickaxe (PICK_ART) in a DEGEN's left hand (screen right), head up and out, turned `rot`
  /// degrees about the hand, `ps` px per sprite pixel, with a light outline so it reads on the night sky.
  S.heldPick = (ps, rot = 0, mat = "crystal", outline = "#f3e6ff") => (x, foot, k) => {
    const hx = x + (116 - 88) * k, hy = foot + (101 - 153) * k;
    return `<g transform="rotate(${rot} ${hx} ${hy}) translate(${hx - 1.5 * ps} ${hy - 14.5 * ps}) scale(${ps})" shape-rendering="crispEdges">${B.sprite(B.PICK_ART, mat, outline, 1)}</g>`;
  };
  /// A cluster of $MINE crystal (the game's own crystal sprite) growing out of the planet at `deg`, `k` px per sprite
  /// pixel, with a soft glow. `mat`: crystal, gold or diamond.
  let glowN = 0;
  S.crystalOn = (planet, deg, k, mat = "crystal") => {
    const [x, y] = planet.at(deg, 0), id = "cg" + glowN++;
    const glow = { crystal: "#d25bff", gold: "#f5c832", diamond: "#5fe8e0" }[mat];
    return `<defs><radialGradient id="${id}"><stop offset="0" stop-color="${glow}" stop-opacity=".6"/><stop offset=".55" stop-color="${glow}" stop-opacity=".18"/><stop offset="1" stop-color="${glow}" stop-opacity="0"/></radialGradient></defs>`
      + `<g transform="rotate(${deg} ${x} ${y})"><ellipse cx="${x}" cy="${y - 6 * k}" rx="${15 * k}" ry="${12 * k}" fill="url(#${id})"/>`
      + `<g transform="translate(${x - 8 * k} ${y - 13.6 * k}) scale(${k})" shape-rendering="crispEdges">${B.sprite(B.CLUSTER_ART, mat, "#05081a", 1)}</g></g>`;
  };

  // ------------------------------------------------------------- type
  S.INK = "#eef1f8"; S.GOLD = "#f5c832"; S.GREEN = "#8ee07a"; S.LILAC = "#b9b4ea"; S.OUT = "#05081a";
  S.SH = { ink: "#2b3260", gold: "#8a5a08", green: "#1f4a2a", lilac: "#2b3260" };
  /// The wordmark: MINE and CRAFT in ink, WORLD in gold, the brand's display letters at `p` px per pixel, centred on
  /// x with its top at y. Flat colour, one hard shadow, a dark outline.
  S.wordmark = (x, y, p) => B.pixelLine([["MINE", S.INK, S.SH.ink], ["WORLD", S.GOLD, S.SH.gold], ["CRAFT", S.INK, S.SH.ink]], B.DISPLAY, p, x, y, { gap: 2, shadow: [1, 1], ol: S.OUT });
  /// A line of the text letters, centred on x, its top at y: `segs` [[text, colourKey]] with colourKey ink, gold,
  /// green or lilac.
  S.text = (segs, p, x, y, o = {}) => {
    const C = { ink: S.INK, gold: S.GOLD, green: S.GREEN, lilac: S.LILAC };
    return B.pixelLine(segs.map(([t, k]) => [t, C[k], o.flat ? null : S.SH[k]]), B.TEXT, p, x, y, { gap: o.gap ?? 1, shadow: [1, 1], ol: S.OUT, ...o });
  };

  /// The box a placed line covers, with its shadow and outline: [x0, y0, x1, y1].
  S.box = (t, y, p, pad = 0) => [t.x - p - pad, y - p - pad, t.x + t.w + 2 * p + pad, y + t.h + 2 * p + pad];

  window.S = S;
})();
