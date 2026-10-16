// What the player carries: 36 slots, the first 9 are the hotbar, and the armor they wear (head, chest, legs, feet).
// Kept in this browser (per wallet, or as a guest); items are for playing with and are never on-chain. $MINE is
// earned on the room's ledger, not from items.
//
// A slot is { id, n } or, for tools, weapons and armor, { id, n: 1, d } where d is the wear taken so far: at
// maxDurability(id) it breaks. Two worn copies of the same item can be combined into one (repair), as in the classic
// block games: the uses left of both, plus 5% of a new one's.
//
// The pickaxes your autopilot bots hold (bots.js, docs/AUTOPILOT.md) are kept here too, out of the bag: `bots` maps a
// DEGEN's token id to { id, d, look (its packed traits, to dress it again after a reload), stay (left home by a
// flight: it comes back when you're home), next (a pickaxe it's being handed instead, until the world server says
// so) }, and `returned` holds pickaxes that came back while the bag was full (they wait in the Autopilot box, never
// lost). The bag stays where every build reads it (mwc:inv:<wallet>: the slots; mwc:inv:<wallet>:armor: the armor, so
// an older build, or a tab still running one, never finds an empty bag), and the bots' pickaxes are beside it
// (mwc:inv:<wallet>:bots = { bots, returned }); all three are written together, so a pickaxe moving between the bag
// and a bot is one write (a save made as { slots, armor, bots, returned } in the one value still loads). A bot's wear
// changes with every block it breaks: it's kept in memory and written at most every WEAR_SAVE_MS (and at once by
// flush(), on page hide), without redrawing anything. A pickaxe change the world server hadn't answered when the page
// went (entry.next) is undone on loading: the server forgets a page's bots with its connection.

import { RECIPES, stackSize, TOOLS, ARMOR, ARMOR_SLOTS, maxDurability, damageable } from "./blocks.js";
import { SUPPLY } from "./degen-skin.js";

export const SLOTS = 36;
export const HOTBAR = 9;
const WEAR_SAVE_MS = 5000; // a bot's pickaxe wear is written at most this often
const RETURNED_MAX = 40; // pickaxes waiting in the Autopilot box, at most (more can't happen: 4 bots, each one at a time)

/// A slot read back from storage, or null if it doesn't make sense.
function clean(s) {
  if (!s || !Number.isInteger(s.id) || !(s.n > 0)) return null;
  const out = { id: s.id, n: Math.min(s.n, stackSize(s.id)) };
  if (damageable(s.id)) out.d = Number.isInteger(s.d) && s.d >= 0 && s.d < maxDurability(s.id) ? s.d : 0;
  return out;
}
const item = (id, d = 0) => (damageable(id) ? { id, n: 1, d } : { id, n: 1 });
const isPick = (id) => TOOLS[id]?.kind === "pick";
/// A pickaxe read back from storage ({ id, d }), or null if it isn't one (or is worn out).
const cleanPick = (p) => (p && isPick(p.id) && Number.isInteger(p.d) && p.d >= 0 && p.d < maxDurability(p.id) ? { id: p.id, d: p.d } : null);
/// A bot's entry read back from storage, or null.
function cleanBot(e) {
  const pick = cleanPick(e);
  if (!pick) return null;
  const out = { ...pick, look: Array.isArray(e.look) && e.look.length <= 16 && e.look.every(Number.isInteger) ? e.look : null };
  if (e.stay) out.stay = true;
  const next = cleanPick(e.next);
  if (next) out.next = next;
  return out;
}

export function createInventory() {
  let slots = Array(SLOTS).fill(null);
  let armor = { head: null, chest: null, legs: null, feet: null }; // { id, d } or null
  let bots = {}; // token id -> { id, d, look, stay?, next? }: the pickaxes the autopilot bots hold
  let returned = []; // [{ id, d }]: pickaxes back from bots while the bag was full
  let key = "mwc:inv:guest";
  let onChange = () => {};
  let wearTimer = 0; // a write of the bots' wear, waiting

  /// Writes everything (no redraw): the slots and the armor where every build reads them, the bots' pickaxes beside.
  function write() {
    clearTimeout(wearTimer);
    wearTimer = 0;
    try {
      localStorage.setItem(key, JSON.stringify(slots));
      localStorage.setItem(`${key}:armor`, JSON.stringify(armor));
      localStorage.setItem(`${key}:bots`, JSON.stringify({ bots, returned }));
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
  function load(who) {
    if (wearTimer) write(); // (the last wallet's bots' wear first)
    key = `mwc:inv:${who ?? "guest"}`;
    const saved = read(key), kept = read(`${key}:bots`);
    let worn = read(`${key}:armor`);
    // The slots (the armor and the bots' pickaxes in keys of their own), or as this feature's first builds saved it:
    // { slots, armor, bots, returned } in the one value.
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
    bots = {};
    for (const [tok, e] of Object.entries(held?.bots ?? {})) {
      const id = Number(tok), b = cleanBot(e);
      if (Number.isInteger(id) && id >= 1 && id <= SUPPLY && b) bots[id] = b;
    }
    returned = (Array.isArray(held?.returned) ? held.returned : []).map(cleanPick).filter(Boolean).slice(0, RETURNED_MAX);
    if (dropSwaps() || whole) write(); // (the swaps the world server forgot undone; a one-value save put back as every build reads it)
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

  // ---------------------------------------------------------------- the autopilot bots' pickaxes
  /// Hands the pickaxe in slot i to bot `tok` (a DEGEN's token id; `look`: its packed traits): it leaves the bag.
  /// Returns the bot's entry, or null (not a pickaxe, or that bot holds one already).
  function lend(i, tok, look = null) {
    const s = slots[i];
    if (!s || !isPick(s.id) || bots[tok]) return null;
    bots[tok] = { id: s.id, d: s.d ?? 0, look: Array.isArray(look) ? look : null };
    slots[i] = null;
    save();
    return bots[tok];
  }
  /// Puts a pickaxe back in the bag, or with no room in `returned` (never lost). Worn out, it's gone. Returns
  /// "bag", "returned" or null.
  function stow(id, d) {
    const p = cleanPick({ id, d });
    if (!p) return null;
    const free = slots.findIndex((s) => !s);
    if (free >= 0) { slots[free] = item(p.id, p.d); return "bag"; }
    returned.push(p);
    if (returned.length > RETURNED_MAX) returned.shift();
    return "returned";
  }
  /// Bot `tok` is recalled: its pickaxe comes back with the wear the world server counted (`id`, `d`; its own entry's
  /// if those don't say), and one it was being handed too. Returns where it went (stow), or null.
  function giveBack(tok, id = null, d = null) {
    const e = bots[tok];
    if (!e) return null;
    delete bots[tok];
    const where = isPick(id) && Number.isInteger(d) ? stow(id, d) : stow(e.id, e.d);
    if (e.next) stow(e.next.id, e.next.d);
    save();
    return where;
  }
  /// Bot `tok` is gone with its pickaxe (beaten: the pickaxe is in a loot chest; or it wore out). One it was being
  /// handed comes back.
  function dropBot(tok) {
    const e = bots[tok];
    if (!e) return;
    delete bots[tok];
    if (e.next) stow(e.next.id, e.next.d);
    save();
  }
  /// Bot `tok` is to hold the pickaxe in slot i instead: it waits under the bot (entry.next) until the world server
  /// answers (pickSwapped). Returns the pickaxe, or null.
  function swapPick(tok, i) {
    const e = bots[tok], s = slots[i];
    if (!e || e.next || !s || !isPick(s.id)) return null;
    e.next = { id: s.id, d: s.d ?? 0 };
    slots[i] = null;
    save();
    return e.next;
  }
  /// The world server handed bot `tok` its new pickaxe: the old one comes back (with the wear it counted). The one
  /// sent coming back instead means it refused (too many changes): the bot keeps the one it had.
  function pickSwapped(tok, oldId, oldWear) {
    const e = bots[tok];
    if (!e?.next) return;
    if (oldId === e.next.id && oldWear === e.next.d) {
      stow(e.next.id, e.next.d);
      delete e.next;
      save();
      return;
    }
    const said = isPick(oldId) && Number.isInteger(oldWear);
    stow(said ? oldId : e.id, said ? oldWear : e.d);
    bots[tok] = { ...e.next, look: e.look, ...(e.stay ? { stay: true } : {}) };
    save();
  }
  /// Every pickaxe being handed to a bot comes back to the bag (or waits in `returned`); each bot keeps the one it had.
  /// Returns whether there were any (nothing is written).
  function dropSwaps() {
    let any = false;
    for (const e of Object.values(bots)) {
      if (!e.next) continue;
      stow(e.next.id, e.next.d);
      delete e.next;
      any = true;
    }
    return any;
  }
  /// The world server forgot every pickaxe change it hadn't answered (the connection dropped, or you signed out): they
  /// come back to the bag, and each bot keeps the pickaxe it had.
  function cancelSwaps() { if (dropSwaps()) save(); }
  /// Bot `tok`'s pickaxe wore by a block: kept in memory, written within WEAR_SAVE_MS (nothing is redrawn).
  function botWear(tok, d) {
    const e = bots[tok];
    if (!e) return;
    e.d = d;
    if (!wearTimer) wearTimer = setTimeout(write, WEAR_SAVE_MS);
  }
  /// Bot `tok` stays home (a flight it didn't come on) or not.
  function setStay(tok, on) {
    const e = bots[tok];
    if (!e || !!e.stay === !!on) return;
    if (on) e.stay = true;
    else delete e.stay;
    save();
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
  /// Writes now whatever's waiting (the page is being hidden or closed).
  function flush() { if (wearTimer) write(); }

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
    lend, giveBack, dropBot, swapPick, pickSwapped, cancelSwaps, botWear, setStay, takeBack, flush,
    worn: (slot) => armor[slot]?.id ?? null,
    wornItem: (slot) => armor[slot],
    slot: (i) => slots[i],
    /// Bot `tok`'s entry ({ id, d, look, stay, next }), or null.
    bot: (tok) => bots[tok] ?? null,
    /// Every bot's entry, as [tokenId, entry].
    bots: () => Object.entries(bots).map(([tok, e]) => [Number(tok), e]),
    /// The pickaxes in the bag, as { slot, id, d }.
    picks: () => slots.flatMap((s, i) => (s && isPick(s.id) ? [{ slot: i, id: s.id, d: s.d ?? 0 }] : [])),
    returned: () => returned.slice(),
    recipes: RECIPES,
    set onChange(f) { onChange = f; },
  };
}
