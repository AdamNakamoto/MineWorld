// Health and food: the two rows of little pixel icons over the hotbar (drawn here, no image files), and the hunger
// rules. Food drains as you move, mine and fight; eating fills it; a full belly heals you, an empty one hurts.

/// A pixel icon as a data URL: `rows` of characters, each a colour from `pal` ("." empty).
function icon(rows, pal) {
  const w = rows[0].length, h = rows.length;
  let rects = "";
  rows.forEach((r, y) => [...r].forEach((c, x) => { if (c !== ".") rects += `<rect x="${x}" y="${y}" width="1" height="1" fill="${pal[c]}"/>`; }));
  return `url('data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" shape-rendering="crispEdges">${rects}</svg>`)}')`;
}
const HEART = [
  ".kk...kk.",
  "kRRk.kRRk",
  "kRwRkRRRk",
  "kRRRRRRRk",
  "kRRRRRRrk",
  ".kRRRRrk.",
  "..kRRrk..",
  "...krk...",
  "....k....",
];
const half = (rows) => rows.map((r) => [...r].map((c, x) => (x > 4 && c !== "k" && c !== "." ? "e" : c)).join(""));
const empty = (rows) => rows.map((r) => r.replace(/[^k.]/g, "e"));
// An original loaf of bread for food.
const BREAD = [
  "...kkkk..",
  "..kLLLLk.",
  ".kLlLlLLk",
  "kLLLLLLLk",
  "kBlBBlBBk",
  "kBBBBBBBk",
  ".kBBBBBk.",
  "..kkkkk..",
  ".........",
];
const HP = { k: "#1a0a0a", R: "#e3352b", r: "#a8221c", w: "#ffb8b0", e: "#3a1a1a" };
const FD = { k: "#24160a", L: "#e8b060", l: "#f8d898", B: "#b8742a", e: "#3a2a1a" };
export const ICONS = {
  heart: icon(HEART, HP), heartHalf: icon(half(HEART), HP), heartEmpty: icon(empty(HEART), HP),
  food: icon(BREAD, FD), foodHalf: icon(half(BREAD), FD), foodEmpty: icon(empty(BREAD), FD),
};

/// Ten icons for a value out of 20 (full, half or empty each).
export function drawRow(el, value, [full, halfI, emptyI]) {
  let html = "";
  for (let i = 0; i < 10; i++) {
    const v = value - i * 2;
    html += `<div class="icon18" style="background-image:${v >= 2 ? full : v === 1 ? halfI : emptyI}"></div>`;
  }
  el.innerHTML = html;
}

/// Hunger, much as in the classic block games: exhaustion builds with effort; every 4 of it costs one food point.
export const FOOD_MAX = 20;
export const EXHAUSTION = { walk: 0.01, sprint: 0.1, jump: 0.05, sprintJump: 0.2, break: 0.025, attack: 0.1, heal: 3 };
export const SPRINT_MIN_FOOD = 7; // too hungry to sprint below this
export const HEAL_FOOD = 18; // heal while food is at least this
export const EAT_SECONDS = 1.6;

export function createHunger(onChange) {
  const s = { food: FOOD_MAX, exhaustion: 0 };
  return {
    get food() { return s.food; },
    set food(v) { s.food = Math.max(0, Math.min(FOOD_MAX, v)); onChange(); },
    tire(amount) {
      s.exhaustion += amount;
      while (s.exhaustion >= 4) {
        s.exhaustion -= 4;
        if (s.food > 0) { s.food--; onChange(); }
      }
    },
    reset() { s.food = FOOD_MAX; s.exhaustion = 0; onChange(); },
  };
}
