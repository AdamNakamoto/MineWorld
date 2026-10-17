// What the player carries: 36 slots, the first 9 are the hotbar, and the armor they wear (head, chest, legs, feet).
// Kept in this browser (per wallet, or as a guest); items are for playing with and are never on-chain. $MINE is
// earned on the room's ledger, not from items.
//
// A slot is { id, n } or, for tools, weapons and armor, { id, n: 1, d } where d is the wear taken so far: at
// maxDurability(id) it breaks. Two worn copies of the same item can be combined into one (repair), as in the classic
// block games: the uses left of both, plus 5% of a new one's.
//
// The autopilot bots that idle mining replaced (bots.js) held pickaxes from the bag, saved beside it
// (mwc:inv:<wallet>:bots = { bots: { tokenId: { id, d, next (one it was being handed) } }, returned }, or, in that
// feature's first builds, { slots, armor, bots, returned } in the one value). Loading such a save brings every one of
// those pickaxes back into the bag, and any it has no room for waits in `returned` (Take back, in the Idle mining box):
// none is lost. The bag stays where every build reads it (mwc:inv:<wallet>: the slots; mwc:inv:<wallet>:armor: the
// armor), and only the pickaxes still waiting are written beside it, as { returned } (which the previous build reads
// too); with none waiting, that key goes.

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
/// A pickaxe read back from storage ({ id, d }), or null if it isn't one (or is worn out).
const cleanPick = (p) => (p && TOOLS[p.id]?.kind === "pick" && Number.isInteger(p.d) && p.d >= 0 && p.d < maxDurability(p.id) ? { id: p.id, d: p.d } : null);

export function createInventory() {
  let slots = Array(SLOTS).fill(null);
  let armor = { head: null, chest: null, legs: null, feet: null }; // { id, d } or null
  let returned = []; // [{ id, d }]: pickaxes back from the old autopilot bots that the bag had no room for
  let key = "mwc:inv:guest";
  let onChange = () => {};

  /// Writes everything (no redraw): the slots and the armor where every build reads them, and beside them the
  /// pickaxes still waiting (none: that key goes).
  function write() {
    try {
      localStorage.setItem(key, JSON.stringify(slots));
      localStorage.setItem(`${key}:armor`, JSON.stringify(armor));
      if (returned.length) localStorage.setItem(`${key}:bots`, JSON.stringify({ returned }));
      else localStorage.removeItem(`${key}:bots`);
    } catch {}
  }
  const save = () => {
    write();
    onChange();
  };
  /// The saved value under `k`, or null (none, or not readable).
  function read(k) {
    try { return JSON.parse(localStorage.getItem(k)); } catch { return null; }
  }
  /// Loads the bag of `who` (a wallet, or null: the guest's). Returns how many pickaxes the old autopilot bots held
  /// came back with it (into the bag, or waiting in `returned`).
  function load(who) {
    key = `mwc:inv:${who ?? "guest"}`;
    const saved = read(key), kept = read(`${key}:bots`);
    let worn = read(`${key}:armor`);
    // The slots (the armor and the old bots' pickaxes in keys of their own), or as the autopilot's first builds saved
    // it: { slots, armor, bots, returned } in the one value.
    const whole = saved && !Array.isArray(saved) && typeof saved === "object" ? saved : null;
    const list = whole ? whole.slots : saved;
    if (whole) worn = whole.armor;
    const held = kept && typeof kept === "object" && !Array.isArray(kept) ? kept : whole;
    slots = Array.isArray(list) && list.length === SLOTS ? list.map(clean) : Array(SLOTS).fill(null);
    armor = Object.fromEntries(ARMOR_SLOTS.map((slot) => {
      const w = worn?.[slot];
      const piece = typeof w === "number" ? item(w) : w && clean({ ...w, n: 1 }); // (older saves kept just the id)
      return [slot, piece && ARMOR[piece.id]?.slot === slot ? { id: piece.id, d: piece.d } : null];
    }));
    // Every pickaxe an old bot held (and one it was being handed), then the ones already waiting: into the bag while
    // there's room, the rest waiting.
    const bots = held?.bots && typeof held.bots === "object" ? Object.values(held.bots) : [];
    const lent = bots.flatMap((e) => [cleanPick(e), cleanPick(e?.next)]).filter(Boolean);
    const waiting = (Array.isArray(held?.returned) ? held.returned : []).map(cleanPick).filter(Boolean);
    returned = [];
    for (const p of [...lent, ...waiting]) stow(p);
    if (held) write(); // (put back as this build saves it: the old bots' pickaxes are never written again)
    onChange();
    return lent.length;
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

  // ---------------------------------------------------------------- the old bots' pickaxes
  /// Puts pickaxe p ({ id, d }) in the first free slot, or with no room in `returned` (never lost).
  function stow(p) {
    const free = slots.findIndex((s) => !s);
    if (free >= 0) slots[free] = item(p.id, p.d);
    else returned.push(p);
  }
  /// Pickaxe `i` of `returned` back into the bag, if there's room.
  function takeBack(i) {
    const p = returned[i], free = slots.findIndex((s) => !s);
    if (!p || free < 0) return false;
    slots[free] = item(p.id, p.d);
    returned.splice(i, 1);
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
  /// Throws away up to n of slot i (all of it when n is left out), for good; how many went.
  function discard(i, n = Infinity) {
    const s = slots[i];
    if (!s) return 0;
    const k = Math.min(n, s.n);
    s.n -= k;
    if (s.n <= 0) slots[i] = null;
    save();
    return k;
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
    load, count, fits, add, take, useSlot, discard, canCraft, craft, swap, toolIn, equip, unequip, armorPoints, armorTiers,
    wearOut, wearArmor, repairs, repair, stacks, clearAll, give, takeBack,
    worn: (slot) => armor[slot]?.id ?? null,
    wornItem: (slot) => armor[slot],
    slot: (i) => slots[i],
    /// The pickaxes waiting for room in the bag ({ id, d }), in order.
    returned: () => returned.slice(),
    recipes: RECIPES,
    set onChange(f) { onChange = f; },
  };
}
