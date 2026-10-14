// Renders the MineWorldCraft Miners pictures (the NFT images) from the game's own pixel art: one per design
// (web/miners/<key>.png), the sealed one (mystery.png), the collection's picture (collection.png) and its banner
// (banner.png). Run from a page served by ./dev.sh: `(await import("./tools/render-miners.js")).render()` returns
// { file: dataURL }. Not part of the game (web/.vercelignore leaves this folder out of the site).
import { MINERS } from "../miners.js";
import { drawMiner, minerPicture } from "../portrait.js";

function canvas(w, h) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d");
  g.imageSmoothingEnabled = false;
  return [c, g];
}

function mystery() {
  const [c, g] = canvas(512, 512);
  const grad = g.createLinearGradient(0, 0, 0, 512);
  grad.addColorStop(0, "#2a2433");
  grad.addColorStop(1, "#141018");
  g.fillStyle = grad;
  g.fillRect(0, 0, 512, 512);
  // A stone block with crystal specks and a question mark: the sealed miner.
  const px = 16, ox = 128, oy = 128;
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    const v = ((x * 7 + y * 13) % 5) * 6;
    g.fillStyle = `rgb(${110 + v},${110 + v},${118 + v})`;
    g.fillRect(ox + x * px, oy + y * px, px, px);
  }
  g.fillStyle = "#d25bff";
  for (const [x, y] of [[2, 3], [3, 3], [12, 11], [13, 12], [3, 12], [12, 2]]) g.fillRect(ox + x * px, oy + y * px, px, px);
  g.fillStyle = "#f5c832";
  const q = ["01110", "10001", "00001", "00110", "00100", "00000", "00100"];
  q.forEach((row, y) => [...row].forEach((b, x) => b === "1" && g.fillRect(ox + (5.5 + x) * px, oy + (4 + y) * px, px, px)));
  g.fillStyle = "#f4f1e8";
  g.font = "700 30px Silkscreen, monospace";
  g.textAlign = "center";
  g.fillText("SEALED MINER", 256, 452);
  return c.toDataURL("image/png");
}

function collection() {
  const [c, g] = canvas(512, 512);
  g.fillStyle = "#1a1620";
  g.fillRect(0, 0, 512, 512);
  // Four miners, one of each rarity.
  [0, 5, 11, 15].forEach((d, i) => {
    const x = (i % 2) * 256, y = Math.floor(i / 2) * 256;
    const img = new Image();
    img.src = minerPicture(d, 256);
    g.drawImage(img, x, y);
  });
  return c.toDataURL("image/png");
}

function banner() {
  const [c, g] = canvas(1400, 350);
  const grad = g.createLinearGradient(0, 0, 0, 350);
  grad.addColorStop(0, "#5aa0e8");
  grad.addColorStop(0.62, "#9fd0ff");
  grad.addColorStop(0.62, "#62a136");
  grad.addColorStop(0.7, "#4f8a2a");
  grad.addColorStop(0.7, "#86603f");
  grad.addColorStop(1, "#5a4029");
  g.fillStyle = grad;
  g.fillRect(0, 0, 1400, 350);
  MINERS.forEach((_, d) => drawMiner(g, d, 5, 20 + d * 85, 40));
  g.fillStyle = "rgba(0,0,0,0.45)";
  g.fillRect(0, 262, 1400, 64);
  g.fillStyle = "#f5c832";
  g.font = "700 40px Silkscreen, monospace";
  g.textAlign = "center";
  g.fillText("MINEWORLDCRAFT MINERS", 700, 308);
  return c.toDataURL("image/png");
}

export async function render() {
  await document.fonts?.ready;
  await document.fonts?.load("700 40px Silkscreen");
  const out = {};
  MINERS.forEach((m, d) => { out[`${m.key}.png`] = minerPicture(d, 512); });
  out["mystery.png"] = mystery();
  const col = collection();
  // (the collection grid draws data-URL images, which decode asynchronously: draw once more after they load)
  await new Promise((r) => setTimeout(r, 300));
  out["collection.png"] = collection() || col;
  out["banner.png"] = banner();
  return out;
}
