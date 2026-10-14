// What the player carries: 36 slots, the first 9 are the hotbar, and the armor they wear (head, chest, legs, feet).
// Kept in this browser (per wallet, or as a guest); items are for playing with and are never on-chain. $MINE is
// earned on the room's ledger, not from items.
//
// A slot is { id, n } or, for tools, weapons and armor, { id, n: 1, d } where d is the wear taken so far: at
// maxDurability(id) it breaks. Two worn copies of the same item can be combined into one (repair), as in the classic
// block games: the uses left of both, plus 5% of a new one's.

import { RECIPES, stackSize, TOOLS, ARMOR, ARMOR_SLOTS, maxDurability, damageable } from "./blocks.js";

export const SLOTS = 36;
export const HOTBAR = 9;

/// A slot read back from storage, or null if it doesn't make sense.
function clean(s) {
  if (!s || !Number.isInteger(s.id) || !(s.n > 0)) return null;
  const out = { id: s.id, n: Math.min(s.n, stackSize(s.id)) };
  if (damageable(s.id)) out.d = Number.isInteger(s.d) && s.d >= 0 && s.d < maxDurability(s.id) ? s.d : 0;
  return out;
}
const item = (id, d = 0) => (damageable(id) ? { id, n: 1, d } : { id, n: 1 });

export function createInventory() {
  let slots = Array(SLOTS).fill(null);
  let armor = { head: null, chest: null, legs: null, feet: null }; // { id, d } or null
  let key = "mwc:inv:guest";
  let onChange = () => {};

  const save = () => {
    try {
      localStorage.setItem(key, JSON.stringify(slots));
      localStorage.setItem(`${key}:armor`, JSON.stringify(armor));
    } catch {}
    onChange();
  };
  function load(who) {
    key = `mwc:inv:${who ?? "guest"}`;
    let saved = null, worn = null;
    try { saved = JSON.parse(localStorage.getItem(key)); worn = JSON.parse(localStorage.getItem(`${key}:armor`)); } catch {}
    slots = Array.isArray(saved) && saved.length === SLOTS ? saved.map(clean) : Array(SLOTS).fill(null);
    armor = Object.fromEntries(ARMOR_SLOTS.map((slot) => {
      const w = worn?.[slot];
      const piece = typeof w === "number" ? item(w) : w && clean({ ...w, n: 1 }); // (older saves kept just the id)
      return [slot, piece && ARMOR[piece.id]?.slot === slot ? { id: piece.id, d: piece.d } : null];
    }));
    onChange();
  }

  // ---------------------------------------------------------------- armor
  /// Put on the armor in slot i (what was worn there goes back into that slot).
  function equip(i) {
    const s = slots[i], a = s && ARMOR[s.id];
    if (!a) return false;
    const old = armor[a.slot];
    armor[a.slot] = { id: s.id, d: s.d ?? 0 };
    slots[i] = old ? item(old.id, old.d) : null;
    save();
    return true;
  }
  /// Take off the armor worn in `slot` (if there's room for it).
  function unequip(slot) {
    const w = armor[slot];
    if (!w) return false;
    const free = slots.findIndex((s) => !s);
    if (free < 0) return false;
    slots[free] = item(w.id, w.d);
    armor[slot] = null;
    save();
    return true;
  }
  const armorPoints = () => ARMOR_SLOTS.reduce((t, slot) => t + (ARMOR[armor[slot]?.id]?.points ?? 0), 0);
  /// The tier worn in each slot (0 none, 1 Padded .. 4 Crystal), as the world server relays it to others.
  const armorTiers = () => ARMOR_SLOTS.map((slot) => ARMOR[armor[slot]?.id]?.tier ?? 0);
  /// Every worn piece takes `amount` wear (a monster's hit); returns the ids of any that broke.
  function wearArmor(amount) {
    const broke = [];
    for (const slot of ARMOR_SLOTS) {
      const w = armor[slot];
      if (!w) continue;
      w.d += amount;
      if (w.d >= maxDurability(w.id)) { broke.push(w.id); armor[slot] = null; }
    }
    save();
    return broke;
  }

  // ---------------------------------------------------------------- wear
  /// The item in slot i takes `amount` wear; returns its id if it broke (it's gone), else null.
  function wearOut(i, amount) {
    const s = slots[i];
    if (!s || !damageable(s.id) || amount <= 0) return null;
    s.d = (s.d ?? 0) + amount;
    const broke = s.d >= maxDurability(s.id) ? s.id : null;
    if (broke) slots[i] = null;
    save();
    return broke;
  }
  /// Items with two or more copies in the bag, at least one of them worn: they can be combined.
  function repairs() {
    const seen = new Map();
    for (const s of slots) if (s && damageable(s.id)) seen.set(s.id, [...(seen.get(s.id) ?? []), s]);
    return [...seen].filter(([, list]) => list.length >= 2 && list.some((s) => s.d > 0)).map(([id]) => id);
  }
  /// Combines the two most worn copies of `id` into one: their uses left plus 5% of a new one's, at most new.
  function repair(id) {
    const max = maxDurability(id);
    const idx = slots.map((s, i) => (s?.id === id ? i : -1)).filter((i) => i >= 0).sort((a, b) => slots[b].d - slots[a].d);
    if (idx.length < 2) return false;
    const [a, b] = idx;
    const left = Math.min(max, (max - slots[a].d) + (max - slots[b].d) + Math.floor(max * 0.05));
    slots[a].d = max - left;
    slots[b] = null;
    save();
    return true;
  }

  // ---------------------------------------------------------------- the bag
  function count(id) {
    return slots.reduce((t, s) => t + (s?.id === id ? s.n : 0), 0);
  }
  /// Whether `n` new `id` would all fit (what the shop checks before taking a payment).
  function fits(id, n = 1) {
    const max = stackSize(id);
    for (const s of slots) {
      if (n <= 0) break;
      if (!s) n -= max;
      else if (s.id === id && s.n < max) n -= max - s.n;
    }
    return n <= 0;
  }
  /// Adds as many as fit (new, unworn); returns how many didn't.
  function add(id, n = 1) {
    const max = stackSize(id);
    for (const s of slots) {
      if (n && s?.id === id && s.n < max) { const k = Math.min(n, max - s.n); s.n += k; n -= k; }
    }
    for (let i = 0; i < SLOTS && n; i++) {
      if (!slots[i]) { const k = Math.min(n, max); slots[i] = { ...item(id), n: k }; n -= k; }
    }
    save();
    return n;
  }
  function take(id, n = 1) {
    if (count(id) < n) return false;
    for (let i = SLOTS - 1; i >= 0 && n; i--) {
      const s = slots[i];
      if (s?.id !== id) continue;
      const k = Math.min(n, s.n);
      s.n -= k; n -= k;
      if (!s.n) slots[i] = null;
    }
    save();
    return true;
  }
  /// Everything carried, worn armor too, as [item, count, wear] stacks (what a PvP knock-out drops).
  function stacks() {
    const out = slots.filter(Boolean).map((s) => (damageable(s.id) ? [s.id, 1, s.d ?? 0] : [s.id, s.n]));
    for (const slot of ARMOR_SLOTS) if (armor[slot]) out.push([armor[slot].id, 1, armor[slot].d ?? 0]);
    return out;
  }
  /// Empties the bag and takes off all armor (it was dropped).
  function clearAll() {
    slots = Array(SLOTS).fill(null);
    armor = { head: null, chest: null, legs: null, feet: null };
    save();
  }
  /// Adds a stack from a loot chest or a reward: a worn tool or piece of armor keeps its wear. Returns how many
  /// didn't fit.
  function give(id, n, d = 0) {
    if (!damageable(id)) return add(id, n);
    const free = slots.findIndex((s) => !s);
    if (free < 0) return n;
    slots[free] = item(id, Number.isInteger(d) && d >= 0 && d < maxDurability(id) ? d : 0);
    save();
    return 0;
  }
  /// Uses one of the item in slot i (a placed block, an eaten apple).
  function useSlot(i) {
    const s = slots[i];
    if (!s) return;
    if (--s.n <= 0) slots[i] = null;
    save();
  }
  function canCraft(r) {
    return Object.entries(r.need).every(([id, n]) => count(Number(id)) >= n);
  }
  function craft(r) {
    if (!canCraft(r)) return false;
    for (const [id, n] of Object.entries(r.need)) take(Number(id), n);
    add(r.out, r.n); // (with a full inventory the rest is lost: make room first)
    return true;
  }
  function swap(a, b) {
    [slots[a], slots[b]] = [slots[b], slots[a]];
    save();
  }
  /// Only the tool in hand counts.
  const toolIn = (i) => (slots[i] && TOOLS[slots[i].id] ? slots[i].id : null);

  return {
    load, count, fits, add, take, useSlot, canCraft, craft, swap, toolIn, equip, unequip, armorPoints, armorTiers,
    wearOut, wearArmor, repairs, repair, stacks, clearAll, give,
    worn: (slot) => armor[slot]?.id ?? null,
    wornItem: (slot) => armor[slot],
    slot: (i) => slots[i],
    recipes: RECIPES,
    set onChange(f) { onChange = f; },
  };
}
