// What the player carries: 36 slots, the first 9 are the hotbar. Kept in this browser (per wallet, or as a guest);
// items are for playing with and are never on-chain. $MINE is earned on the room's ledger, not from items.

import { RECIPES, stackSize, TOOLS } from "./blocks.js";

export const SLOTS = 36;
export const HOTBAR = 9;

export function createInventory() {
  let slots = Array(SLOTS).fill(null);
  let key = "mwc:inv:guest";
  let onChange = () => {};

  const save = () => { try { localStorage.setItem(key, JSON.stringify(slots)); } catch {} onChange(); };
  function load(who) {
    key = `mwc:inv:${who ?? "guest"}`;
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(key)); } catch {}
    slots = Array.isArray(saved) && saved.length === SLOTS
      ? saved.map((s) => (s && Number.isInteger(s.id) && s.n > 0 ? { id: s.id, n: Math.min(s.n, stackSize(s.id)) } : null))
      : Array(SLOTS).fill(null);
    onChange();
  }

  function count(id) {
    return slots.reduce((t, s) => t + (s?.id === id ? s.n : 0), 0);
  }
  /// Adds as many as fit; returns how many didn't.
  function add(id, n = 1) {
    const max = stackSize(id);
    for (const s of slots) {
      if (n && s?.id === id && s.n < max) { const k = Math.min(n, max - s.n); s.n += k; n -= k; }
    }
    for (let i = 0; i < SLOTS && n; i++) {
      if (!slots[i]) { const k = Math.min(n, max); slots[i] = { id, n: k }; n -= k; }
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
  /// Uses one of the item in slot i (a placed block).
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
    load, count, add, take, useSlot, canCraft, craft, swap, toolIn,
    slot: (i) => slots[i],
    recipes: RECIPES,
    set onChange(f) { onChange = f; },
  };
}
