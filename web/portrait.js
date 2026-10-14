// A Miner seen from the front, as pixel art: for the panel and for the NFT pictures (tools/render-miners.html).
// The figure is 16 x 32 "pixels", the same proportions as the avatar in the game.

import { designOf } from "./miners.js";

const css = (n) => `#${n.toString(16).padStart(6, "0")}`;
const shade = (n, k) => {
  const r = Math.min(255, Math.max(0, ((n >> 16) & 255) * k)), g = Math.min(255, Math.max(0, ((n >> 8) & 255) * k)), b = Math.min(255, Math.max(0, (n & 255) * k));
  return (r << 16) | (g << 8) | b;
};

/// Draws outfit `design` (index, or null for the rookie) at pixel size `px`, with its top-left at (ox, oy).
export function drawMiner(g, design, px = 8, ox = 0, oy = 0) {
  const d = designOf(design);
  const P = (x, y, w, h, c) => { g.fillStyle = css(c); g.fillRect(ox + x * px, oy + y * px, w * px, h * px); };
  const hatY = 4; // the figure starts lower so hats have room
  const y0 = hatY;
  // legs
  P(4, y0 + 20, 4, 10, d.pants); P(8, y0 + 20, 4, 10, shade(d.pants, 0.85));
  P(4, y0 + 30, 4, 2, d.shoes); P(8, y0 + 30, 4, 2, shade(d.shoes, 0.85));
  // body and arms
  P(4, y0 + 8, 8, 12, d.shirt);
  P(4, y0 + 19, 8, 1, d.accent ?? shade(d.pants, 0.7));
  P(0, y0 + 8, 4, 10, shade(d.shirt, 0.9)); P(12, y0 + 8, 4, 10, shade(d.shirt, 0.9));
  P(0, y0 + 18, 4, 2, d.skin); P(12, y0 + 18, 4, 2, d.skin);
  if (d.key === "knight") { P(5, y0 + 10, 6, 6, d.accent); P(7, y0 + 11, 2, 4, 0xf5c832); }
  if (d.key === "classic" || d.key === "builder") { P(4, y0 + 13, 8, 1, d.accent); }
  if (d.key === "lumberjack") for (let i = 0; i < 4; i++) P(4 + i * 2, y0 + 8 + (i % 2) * 3, 1, 12, 0x1e1e1e);
  if (d.key === "farmer") { P(5, y0 + 11, 6, 9, d.accent); P(5, y0 + 8, 1, 3, d.accent); P(10, y0 + 8, 1, 3, d.accent); }
  if (d.key === "astronaut") { P(6, y0 + 10, 4, 3, d.accent); P(7, y0 + 11, 2, 1, 0x3a8aff); }
  if (d.key === "neon") { P(4, y0 + 12, 8, 1, d.glow); P(4, y0 + 16, 8, 1, d.accent); }
  if (d.key === "crystal" || d.key === "diamond" || d.key === "gold") { P(7, y0 + 10, 2, 2, d.accent); }
  // head
  P(4, y0, 8, 8, d.skin);
  P(4, y0, 8, 2, d.hair); P(4, y0 + 2, 1, 1, d.hair); P(11, y0 + 2, 1, 1, d.hair);
  P(5, y0 + 3, 2, 1, 0xffffff); P(9, y0 + 3, 2, 1, 0xffffff);
  P(6, y0 + 3, 1, 1, d.eyes ?? 0x2a2a44); P(9, y0 + 3, 1, 1, d.eyes ?? 0x2a2a44);
  if (d.beard) { P(5, y0 + 5, 6, 3, d.beard); P(7, y0 + 5, 2, 1, d.skin); }
  else P(7, y0 + 6, 2, 1, 0x8a4a3a);
  const t = d.hat;
  if (t) {
    const c = t.color;
    switch (t.type) {
      case "hardhat": P(3, y0 - 2, 10, 3, c); P(2, y0, 12, 1, shade(c, 0.85)); P(7, y0 - 1, 2, 1, d.accent ?? 0xffffaa); break;
      case "beanie": P(4, y0 - 2, 8, 3, c); P(7, y0 - 3, 2, 1, d.accent ?? c); break;
      case "straw": P(5, y0 - 2, 6, 2, c); P(1, y0, 14, 1, shade(c, 0.9)); break;
      case "safari": P(4, y0 - 2, 8, 2, c); P(2, y0, 12, 1, shade(c, 0.85)); P(4, y0 - 1, 8, 1, d.accent); break;
      case "helmet": P(3, y0 - 1, 10, 9, c); P(5, y0 + 3, 6, 1, 0x1a1a1a); P(7, y0 - 3, 2, 2, d.accent); break;
      case "hood": P(3, y0 - 1, 10, 4, c); P(3, y0 + 5, 10, 3, c); P(3, y0, 1, 8, c); P(12, y0, 1, 8, c); break;
      case "dome": g.globalAlpha = 0.35; P(2, y0 - 2, 12, 12, c); g.globalAlpha = 1; P(2, y0 - 2, 12, 1, 0xffffff); break;
      case "brass": P(3, y0 - 1, 10, 10, c); P(5, y0 + 2, 6, 4, 0x3ad8e8); P(6, y0 + 3, 1, 1, 0xffffff); break;
      case "horns": P(3, y0 - 3, 2, 3, c); P(11, y0 - 3, 2, 3, c); break;
      case "visor": P(4, y0 + 2, 8, 2, c); break;
      case "crown": P(4, y0 - 2, 8, 2, c); P(4, y0 - 4, 1, 2, c); P(7, y0 - 4, 2, 2, c); P(11, y0 - 4, 1, 2, c); P(7, y0 - 2, 2, 1, 0xffffff); break;
    }
  }
}

/// A square picture of the Miner on its rarity's background (a data URL), `size` pixels wide.
export function minerPicture(design, size = 160) {
  const d = designOf(design);
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d");
  const bg = { Common: [0x3a4a5a, 0x2a3440], Rare: [0x3a2a6a, 0x221a40], Legendary: [0x6a4a10, 0x3a2808], Mythic: [0x5a1a6a, 0x200a28] }[d.rarity] ?? [0x2a3a2a, 0x1a241a];
  const grad = g.createLinearGradient(0, 0, 0, size);
  grad.addColorStop(0, css(bg[0]));
  grad.addColorStop(1, css(bg[1]));
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  // A few ore specks behind, for flavour.
  g.fillStyle = "rgba(255,255,255,0.06)";
  for (let i = 0; i < 18; i++) g.fillRect(((i * 37) % 16) * (size / 16), ((i * 53) % 16) * (size / 16), size / 16, size / 16);
  if (d.glow) {
    const r = g.createRadialGradient(size / 2, size / 2, size * 0.05, size / 2, size / 2, size * 0.5);
    r.addColorStop(0, css(d.glow) + "88");
    r.addColorStop(1, css(d.glow) + "00");
    g.fillStyle = r;
    g.fillRect(0, 0, size, size);
  }
  const px = Math.floor(size / 40);
  drawMiner(g, design, px, Math.round((size - 16 * px) / 2), Math.round((size - 36 * px) / 2));
  return c.toDataURL("image/png");
}
