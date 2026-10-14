// The Smithy's shop: tools for mining, weapons and armor, priced in $MINE and paid on-chain. "Buy" approves exactly
// the price for MinePayments, then pays it (kind 0, "shop": 75% burned, 25% to the project treasury) under a fresh
// reference; once the receipt shows exactly that payment, the items go into the inventory. Inventories live in the
// browser, so the game's own check is enough here: every payment that delivered is remembered (its transaction hash),
// so one payment can never add items twice, and an order cut short after paying (a reload, a lost connection) is
// delivered the next time the shop opens. Paid items that no longer fit wait at the shop until there's room.
// FREE_WHILE_TESTING = true makes it all free again: buying just hands the item over, nothing is paid.
// Open it from the shopkeeper at the Smithy's door, or with H.

import {
  STONE_PICK, IRON_PICK, DIAMOND_PICK, CRYSTAL_PICK, STONE_SWORD, IRON_SWORD, DIAMOND_SWORD, CRYSTAL_SWORD, WAR_HAMMER,
  TORCH, APPLE, MUSHROOM_STEW, TOOLS, ARMOR, ARMOR_TIERS, itemName, armorShare,
} from "./blocks.js";
import { iconFor } from "./textures.js";
import { explain } from "./chain.js";

export const FREE_WHILE_TESTING = false;

/// What's for sale: [item, how many, price in $MINE]. Starter gear (stone, padded, torches, food) costs less than an
/// hour's mining for a new player; each tier up costs more, so the best full kit (Crystal pick and sword, the War
/// Hammer and Crystal armor: 21,025 $MINE) is about $50 at a $50K market cap. Gear wears out, so it's bought again.
const armorSet = (tier, prices) => [0, 1, 2, 3].map((s) => [100 + tier * 4 + s, 1, prices[s]]);
export const CATALOG = {
  Tools: [[STONE_PICK, 1, 12], [IRON_PICK, 1, 70], [DIAMOND_PICK, 1, 450], [CRYSTAL_PICK, 1, 3150], [TORCH, 16, 5]],
  Weapons: [[STONE_SWORD, 1, 10], [IRON_SWORD, 1, 60], [DIAMOND_SWORD, 1, 375], [CRYSTAL_SWORD, 1, 2625], [WAR_HAMMER, 1, 3950]],
  Armor: [
    ...armorSet(0, [8, 15, 12, 8]), ...armorSet(1, [53, 105, 88, 53]),
    ...armorSet(2, [300, 600, 480, 300]), ...armorSet(3, [2100, 3950, 3150, 2100]),
  ],
  Supplies: [[APPLE, 5, 5], [MUSHROOM_STEW, 1, 8]],
};

const SHOP_KIND = 0; // MinePayments' kind for the shop
const WEI = 10n ** 18n;
// localStorage: the hashes of payments already delivered (never delivered again); orders paid (or being paid) and not
// delivered yet; and, per wallet, paid items that didn't fit.
const PAID = "mwc:shop:paid", ORDERS = "mwc:shop:orders", OWED = "mwc:shop:owed:";
const ORDER_DAYS = 3; // an order whose payment never shows up is forgotten after this

const mineText = (wei) => (Number(wei / 10n ** 14n) / 1e4).toLocaleString("en-US", { maximumFractionDigits: 4 });
const named = (id, n) => `${n > 1 ? `${n} × ` : ""}${itemName(id)}`;
const same = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
function stored(key, empty) {
  try { const v = JSON.parse(localStorage.getItem(key)); return Array.isArray(v) ? v : empty; } catch { return empty; }
}
function store(key, v) {
  try { localStorage.setItem(key, JSON.stringify(v)); } catch {}
}

function stats(id) {
  const t = TOOLS[id], a = ARMOR[id];
  if (t?.kind === "pick") return `Mining speed ${t.speed} · ${["", "stone, coal", "iron", "gold, diamonds, crystals", "everything", "everything"][t.tier]}`;
  if (t?.kind === "sword") return `Damage ${t.damage}${t.swingMs ? " · slow swing" : ""}`;
  if (a) return `+${a.points} armor · ${ARMOR_TIERS[a.tier - 1]}`;
  if (id === TORCH) return "Light for caves";
  return "Food";
}

/// `game`: { inv, atlas, toast(text, kind), release(), resume(), chain() → chain.js's chain (or null) }.
export function createShop(game) {
  const el = document.getElementById("shop");
  const grid = document.getElementById("shopGrid");
  const noteEl = document.getElementById("shopNote");
  const statusEl = document.getElementById("shopStatus");
  let tab = "Tools", balance = null, burnBps = null, busy = false, status = null, settling = false;
  const chain = () => game.chain?.() ?? null;
  const account = () => chain()?.account ?? null;
  const selling = () => !FREE_WHILE_TESTING && !!chain()?.hasPayments;

  function say(text, kind = "") {
    status = text ? { text, kind } : null;
    statusEl.hidden = !status;
    statusEl.className = `card-status ${status?.kind ?? ""}`;
    statusEl.textContent = status?.text ?? "";
  }

  function render() {
    for (const b of el.querySelectorAll("[data-tab]")) b.classList.toggle("on", b.dataset.tab === tab);
    const acct = account(), sell = selling();
    const burn = (burnBps ?? 7500) / 100;
    const owed = acct ? stored(OWED + acct.toLowerCase(), []) : [];
    noteEl.innerHTML = FREE_WHILE_TESTING
      ? "Tools for mining, weapons and armor. Prices are in $MINE; <b>free while the game is being tested</b>."
      : !sell
        ? "Tools for mining, weapons and armor, priced in $MINE. The shop takes $MINE once it's live on-chain."
        : `Tools for mining, weapons and armor, paid in $MINE from your wallet (approve exactly the price, then pay): <b>${burn}% of
          each purchase is burned</b> for good, ${100 - burn}% goes to the project treasury.
          ${acct ? `Your $MINE: <b class="gold">${balance === null ? "…" : mineText(balance)}</b>` : "<b>Log in</b> (Mining Site panel, M) to buy."}
          ${owed.length ? `<br>Paid for and waiting for room: ${owed.map(([id, n]) => named(id, n)).join(", ")}.
            <button class="link-btn" data-collect>Collect</button>` : ""}`;
    grid.innerHTML = CATALOG[tab].map(([id, n, price], i) => {
      const owned = game.inv.count(id) + (ARMOR[id] && game.inv.worn(ARMOR[id].slot) === id ? 1 : 0);
      const why = !sell ? "" : !acct ? "Log in to buy" : balance !== null && balance < BigInt(price) * WEI ? "Not enough $MINE" : "";
      const button = FREE_WHILE_TESTING
        ? `<button class="btn" data-buy="${i}">Get (free)</button>`
        : `<button class="btn gold" data-buy="${i}" ${!sell || busy || why ? "disabled" : ""} title="${why}">Buy</button>`;
      return `<div class="ware">
        <img src="${iconFor(id, game.atlas)}" alt="">
        <div class="ware-text"><b>${named(id, n)}</b><span class="muted small">${stats(id)}</span>
        ${owned ? `<span class="small owned">You have ${owned}</span>` : ""}
        ${why && acct ? `<span class="small warn">${why}</span>` : ""}</div>
        <div class="ware-buy"><span class="price">${price.toLocaleString()} $MINE</span>${button}</div>
      </div>`;
    }).join("");
    const pts = game.inv.armorPoints();
    document.getElementById("shopArmor").textContent = pts ? `Your armor: ${pts} points, taking ${Math.round(armorShare(pts) * 100)}% of monsters' hits.` : "You're wearing no armor.";
  }

  /// Puts `n` of `id` in the inventory (armor straight on if that slot is empty); returns how many didn't fit.
  function give(id, n) {
    const left = game.inv.add(id, n);
    const a = ARMOR[id];
    if (a && left < n && !game.inv.worn(a.slot)) {
      const at = [...Array(36).keys()].find((k) => game.inv.slot(k)?.id === id);
      if (at !== undefined) game.inv.equip(at);
    }
    return left;
  }

  function getFree(i) {
    const [id, n] = CATALOG[tab][i];
    if (!game.inv.fits(id, n)) return game.toast("Your inventory is full: make room first.", "bad");
    give(id, n);
    const a = ARMOR[id];
    game.toast(`${named(id, n)}${a && game.inv.worn(a.slot) === id ? ", worn" : ""}.`, "good");
    render();
  }

  // ---------------------------------------------------------------- paying
  const keepOrder = (o) => store(ORDERS, [...stored(ORDERS, []).filter((x) => x.ref !== o.ref), o]);
  const dropOrder = (o) => store(ORDERS, stored(ORDERS, []).filter((x) => x.ref !== o.ref));

  /// The payment `hash` for `order` checked out: the items go into the inventory, once. The hash is remembered before
  /// anything is added, so the same payment can never deliver again. "done", "again" (it had delivered already), or
  /// "later" (another wallet's inventory is loaded: it's delivered when the paying wallet opens the shop).
  function deliver(order, hash) {
    if (!same(order.account, account())) return "later";
    dropOrder(order);
    const h = hash.toLowerCase(), done = stored(PAID, []);
    if (done.includes(h)) return "again";
    store(PAID, [...done, h].slice(-2000));
    const left = give(order.id, order.n);
    if (left) {
      const key = OWED + order.account.toLowerCase();
      store(key, [...stored(key, []), [order.id, left]]);
    }
    const a = ARMOR[order.id];
    const text = `Bought ${named(order.id, order.n)} for ${order.price.toLocaleString()} $MINE${a && game.inv.worn(a.slot) === order.id ? ", worn" : ""}.`
      + (left ? ` ${left} didn't fit: make room, then Collect them here.` : "");
    say(text, "good");
    game.toast(text, "gold");
    return "done";
  }

  async function buy(i) {
    if (FREE_WHILE_TESTING) return getFree(i);
    const [id, n, price] = CATALOG[tab][i];
    const c = chain(), acct = account();
    if (busy) return;
    if (!c?.hasPayments) return say("The shop takes $MINE once it's live on-chain.", "bad");
    if (!acct) return say("Log in with your wallet first (Mining Site panel, M).", "bad");
    if (!game.inv.fits(id, n)) return say("Your inventory is full: make room first.", "bad");
    const order = { account: acct, ref: c.newRef(), hash: null, id, n, price, at: Date.now() };
    busy = true;
    say(`Buying ${named(id, n)} for ${price.toLocaleString()} $MINE…`);
    render();
    try {
      keepOrder(order);
      const r = await c.pay(SHOP_KIND, BigInt(price) * WEI, {
        ref: order.ref,
        step: (text) => say(text),
        onHash: (hash) => { order.hash = hash; keepOrder(order); },
      });
      const got = deliver(order, r.hash);
      if (got === "again") say("That payment's items are already in your inventory.");
      if (got === "later") say("Paid: the items go to the wallet that paid, next time it opens the shop.", "good");
    } catch (e) {
      console.warn("shop", e);
      say(explain(e), "bad");
      if (!order.hash) dropOrder(order); // (nothing was sent)
    } finally {
      busy = false;
      await settle(); // (an order sent but not seen through: delivered now if it went through, dropped if it failed)
      await loadWallet();
    }
  }

  /// Orders paid from this wallet that weren't delivered (the page closed, or the wait gave up): delivered if their
  /// payment checks out, forgotten if it failed or never showed up.
  async function settle() {
    const c = chain(), acct = account();
    if (!c?.hasPayments || !acct || settling) return;
    settling = true;
    try {
      for (const o of stored(ORDERS, [])) {
        if (!same(o.account, acct) || (busy && !o.hash)) continue;
        const old = Date.now() - o.at > ORDER_DAYS * 86_400_000;
        if (!o.hash) { if (Date.now() - o.at > 600_000) dropOrder(o); continue; }
        const ok = await c.paidIn(o.hash, SHOP_KIND, BigInt(o.price) * WEI, o.ref);
        if (ok === true) deliver(o, o.hash);
        else if (ok === false || old) dropOrder(o);
      }
    } finally {
      settling = false;
    }
  }

  function collect() {
    const acct = account();
    if (!acct) return;
    const key = OWED + acct.toLowerCase();
    const left = [];
    for (const [id, n] of stored(key, [])) {
      const k = give(id, n);
      if (k) left.push([id, k]);
    }
    store(key, left);
    say(left.length ? "Some still don't fit: make more room." : "Collected.", left.length ? "bad" : "good");
    render();
  }

  async function loadWallet() {
    const c = chain();
    if (!selling()) return render();
    try {
      balance = c.account ? await c.mineBalance() : null;
      burnBps ??= await c.kindBurn(SHOP_KIND);
    } catch (e) {
      console.warn("shop: wallet", e);
    }
    if (!el.hidden) render();
  }

  el.addEventListener("click", (e) => {
    if (e.target === el || e.target.closest("[data-close]")) return close();
    const t = e.target.closest("[data-tab]");
    if (t) { tab = t.dataset.tab; return render(); }
    if (e.target.closest("[data-collect]")) return collect();
    const b = e.target.closest("[data-buy]");
    if (b && !b.disabled) buy(Number(b.dataset.buy));
  });

  function open() {
    game.release();
    el.hidden = false;
    if (!busy) say(null);
    balance = null;
    render();
    loadWallet().then(settle).then(() => !el.hidden && render());
  }
  function close() {
    el.hidden = true;
    game.resume();
  }
  return { open, close, get isOpen() { return !el.hidden; }, render };
}
