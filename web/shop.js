// The Smithy's shop: tools for mining, weapons and armor, priced in $MINE. While the game is being tested, nothing is
// charged: buying just hands the item over (FREE_WHILE_TESTING). Paying with the $MINE token on-chain comes later;
// the prices here are the ones it will use. Open it from the shopkeeper at the Smithy's door, or with H.

import {
  STONE_PICK, IRON_PICK, DIAMOND_PICK, CRYSTAL_PICK, STONE_SWORD, IRON_SWORD, DIAMOND_SWORD, CRYSTAL_SWORD, WAR_HAMMER,
  TORCH, APPLE, MUSHROOM_STEW, TOOLS, ARMOR, ARMOR_TIERS, itemName, armorShare,
} from "./blocks.js";
import { iconFor } from "./textures.js";

export const FREE_WHILE_TESTING = true;

/// What's for sale: [item, how many, price in $MINE].
const armorSet = (tier, prices) => [0, 1, 2, 3].map((s) => [100 + tier * 4 + s, 1, prices[s]]);
export const CATALOG = {
  Tools: [[STONE_PICK, 1, 25], [IRON_PICK, 1, 80], [DIAMOND_PICK, 1, 300], [CRYSTAL_PICK, 1, 1200], [TORCH, 16, 10]],
  Weapons: [[STONE_SWORD, 1, 20], [IRON_SWORD, 1, 70], [DIAMOND_SWORD, 1, 250], [CRYSTAL_SWORD, 1, 1000], [WAR_HAMMER, 1, 1500]],
  Armor: [
    ...armorSet(0, [15, 30, 25, 15]), ...armorSet(1, [60, 120, 100, 60]),
    ...armorSet(2, [200, 400, 320, 200]), ...armorSet(3, [800, 1500, 1200, 800]),
  ],
  Supplies: [[APPLE, 5, 10], [MUSHROOM_STEW, 1, 15]],
};

function stats(id) {
  const t = TOOLS[id], a = ARMOR[id];
  if (t?.kind === "pick") return `Mining speed ${t.speed} · ${["", "stone, coal", "iron", "gold, diamonds, crystals", "everything", "everything"][t.tier]}`;
  if (t?.kind === "sword") return `Damage ${t.damage}${t.swingMs ? " · slow swing" : ""}`;
  if (a) return `+${a.points} armor · ${ARMOR_TIERS[a.tier - 1]}`;
  if (id === TORCH) return "Light for caves";
  return "Food";
}

/// `game`: { inv, atlas, toast(text, kind), release(), resume() }.
export function createShop(game) {
  const el = document.getElementById("shop");
  const grid = document.getElementById("shopGrid");
  let tab = "Tools";

  function render() {
    for (const b of el.querySelectorAll("[data-tab]")) b.classList.toggle("on", b.dataset.tab === tab);
    grid.innerHTML = CATALOG[tab].map(([id, n, price], i) => {
      const owned = game.inv.count(id) + (ARMOR[id] && game.inv.worn(ARMOR[id].slot) === id ? 1 : 0);
      return `<div class="ware">
        <img src="${iconFor(id, game.atlas)}" alt="">
        <div class="ware-text"><b>${n > 1 ? `${n} × ` : ""}${itemName(id)}</b><span class="muted small">${stats(id)}</span>
        ${owned ? `<span class="small owned">You have ${owned}</span>` : ""}</div>
        <div class="ware-buy"><span class="price">${price.toLocaleString()} $MINE</span>
        <button class="btn${FREE_WHILE_TESTING ? "" : " gold"}" data-buy="${i}">${FREE_WHILE_TESTING ? "Get (free)" : "Buy"}</button></div>
      </div>`;
    }).join("");
    const pts = game.inv.armorPoints();
    document.getElementById("shopArmor").textContent = pts ? `Your armor: ${pts} points, taking ${Math.round(armorShare(pts) * 100)}% of monsters' hits.` : "You're wearing no armor.";
  }

  function buy(i) {
    const [id, n] = CATALOG[tab][i];
    if (game.inv.add(id, n)) return game.toast("Your inventory is full: make room first.", "bad");
    // Armor goes straight on if that slot is empty.
    const a = ARMOR[id];
    if (a && !game.inv.worn(a.slot)) {
      const at = [...Array(36).keys()].find((k) => game.inv.slot(k)?.id === id);
      if (at !== undefined) game.inv.equip(at);
    }
    game.toast(`${n > 1 ? `${n} × ` : ""}${itemName(id)}${a && game.inv.worn(a.slot) === id ? ", worn" : ""}.`, "good");
    render();
  }

  el.addEventListener("click", (e) => {
    if (e.target === el || e.target.closest("[data-close]")) return close();
    const t = e.target.closest("[data-tab]");
    if (t) { tab = t.dataset.tab; return render(); }
    const b = e.target.closest("[data-buy]");
    if (b) buy(Number(b.dataset.buy));
  });

  function open() {
    game.release();
    el.hidden = false;
    render();
  }
  function close() {
    el.hidden = true;
    game.resume();
  }
  return { open, close, get isOpen() { return !el.hidden; }, render };
}
