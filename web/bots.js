// Idle mining: up to BOT_MAX of your other I'M DEGENs deployed to mine for you while you're online, as Courier World's
// couriers work at a post office (docs/AUTOPILOT.md has the rules and the protocol; the numbers both sides share are in
// bots-rules.js). The world server does the work: it checks each DEGEN is yours, pays each one its own daily cap spread
// over 24 hours while your game is connected and signed in, and forgets them all when your connection goes. Nothing walks, digs or wears out in the game.
//
// This keeps the roster: the DEGENs you deployed, remembered per wallet in this browser (mwc:deployed:<wallet>) and
// deployed again once you're signed in (after a reload, a reconnect, signing in again); what the server said about each
// (botok, botoff); what each earned today of its cap (idle, botok), and the summary the HUD and the Mining Site panel's Idle mining box show. A deploy the server can't take now (it couldn't read the chain,
// or it's busy: retry 1), or one it doesn't answer within ASK_MS, is tried again, waiting longer each time (RETRY_MS);
// one it refused (retry 0) is forgotten, and you're told why.

import { BOT_MAX } from "./bots-rules.js";

const RETRY_MS = [5000, 15_000, 30_000, 60_000, 120_000, 300_000]; // after a botoff that says try again later
const ASK_MS = 20_000; // a deploy with no answer this long is tried again
const CALLBACK_MS = 30_000; // a DEGEN recalled can't be deployed again until the server's last word on it, or this long
const DAY_MS = 86_400_000;

/// `opts`: { net() (net.js, or null), signedIn(), wallet() (the signed-in wallet), worn() (the token id of the DEGEN you
/// wear, or null), now() (the server's clock, ms), toast(text, kind), changed() (the roster changed: the HUD and the
/// panel draw it again) }.
export function createBots(opts) {
  const roster = new Map(); // token id -> a deployed DEGEN (make, below), while it's deployed or being deployed
  // token id -> [UTC day, units earned that day, cap (units, or null)]: each DEGEN's idle mining as the server last said
  // (kept after a recall: the panel still shows it, and a DEGEN that earned today counts towards the day's BOT_MAX).
  const days = new Map();
  // token id -> when (performance.now()): DEGENs recalled whose last word from the server (a botoff) hasn't come yet.
  const calledBack = new Map();
  let timer = 0; // the next retry, waiting
  const net = () => opts.net?.() ?? null;
  const day = () => Math.floor(opts.now() / DAY_MS);
  const changed = () => opts.changed?.();

  // ---------------------------------------------------------------- what this browser remembers
  const savedKey = () => { const w = opts.wallet?.(); return w ? `mwc:deployed:${w.toLowerCase()}` : null; };
  /// The DEGENs this wallet deployed, as this browser remembers them (token ids).
  function saved() {
    const k = savedKey();
    try {
      const v = k ? JSON.parse(localStorage.getItem(k)) : null;
      return Array.isArray(v) ? v.filter((t) => Number.isInteger(t) && t > 0).slice(0, BOT_MAX) : [];
    } catch {
      return [];
    }
  }
  /// Remembers DEGEN `tok` as deployed (`on`), or forgets it.
  function remember(tok, on) {
    const k = savedKey();
    if (!k) return;
    const list = saved().filter((t) => t !== tok);
    if (on) list.push(tok);
    try { list.length ? localStorage.setItem(k, JSON.stringify(list)) : localStorage.removeItem(k); } catch {}
  }

  // ---------------------------------------------------------------- the roster
  /// A deployed DEGEN: its token id, its rarity and level (null until the server has read them), whether the server has
  /// it deployed on this connection (live), when its deploy went (asked, waiting for the answer), the tries and the next
  /// one (retryAt), and why the server last said no (why).
  function make(tok) {
    const b = { tok, tier: null, level: null, live: false, asked: 0, tries: 0, retryAt: 0, why: null };
    roster.set(tok, b);
    return b;
  }
  /// What DEGEN `tok` earned today and its cap, in units: [today, cap] (cap null until the server has said).
  function todayOf(tok) {
    const d = days.get(tok);
    return d ? [d[0] === day() ? d[1] : 0, d[2]] : [0, null];
  }
  /// The server says DEGEN `tok` earned `today` of its `cap` (units; either may be missing).
  function note(tok, today, cap) {
    const d = day(), was = days.get(tok);
    days.set(tok, [d, Number.isFinite(today) ? today : was?.[0] === d ? was[1] : 0, Number.isFinite(cap) ? cap : was?.[2] ?? null]);
  }
  /// The DEGENs that earned idle mining for this wallet today, as far as this game has heard (token ids).
  const usedToday = () => [...days].filter(([, d]) => d[0] === day() && d[1] > 0).map(([tok]) => tok);
  /// Whether DEGEN `tok` was recalled and the server hasn't had its last word on it yet.
  function callingBack(tok) {
    const at = calledBack.get(tok);
    if (at !== undefined && performance.now() - at > CALLBACK_MS) calledBack.delete(tok);
    return calledBack.has(tok);
  }
  /// How long b waits before its next try (longer each time).
  const backoff = (b) => RETRY_MS[Math.min(b.tries++, RETRY_MS.length - 1)];

  /// Asks the world server to deploy b (or again: after a reconnect, a reload, a retry). If it can't go now (not
  /// connected yet), it's tried again in a moment.
  function ask(b, now) {
    if (opts.signedIn() && net()?.sendBot("on", b.tok)) {
      b.asked = now;
      b.retryAt = 0;
    } else b.retryAt = now + RETRY_MS[0];
  }
  /// Sets the timer for the next try that's due: a retry, or an ask with no answer (ASK_MS).
  function schedule() {
    clearTimeout(timer);
    let at = Infinity;
    for (const b of roster.values()) {
      if (b.live) continue;
      if (b.retryAt) at = Math.min(at, b.retryAt);
      else if (b.asked) at = Math.min(at, b.asked + ASK_MS);
    }
    if (at < Infinity) timer = setTimeout(retry, Math.max(0, at - performance.now()) + 50);
  }
  /// Tries again for every DEGEN whose time has come: an ask with no answer waits its turn first.
  function retry() {
    const now = performance.now();
    for (const b of roster.values()) {
      if (b.live) continue;
      if (b.asked && !b.retryAt && now - b.asked >= ASK_MS) { b.asked = 0; b.retryAt = now + backoff(b); }
      if (b.retryAt && now >= b.retryAt) ask(b, now);
    }
    schedule();
    changed();
  }
  /// Deploys again every DEGEN this wallet deployed in this browser that isn't deployed now (once you're signed in:
  /// after a reload, a reconnect, signing in again): those still on the roster (a reconnect keeps them, even when this
  /// browser can't remember them) and those it remembers. The one you wear now can't be: it's forgotten.
  function redeploy() {
    if (!opts.signedIn() || !net()?.online) return;
    const now = performance.now();
    for (const tok of [...new Set([...roster.keys(), ...saved()])].slice(0, BOT_MAX)) {
      if (tok === opts.worn?.()) { remember(tok, false); roster.delete(tok); continue; }
      const b = roster.get(tok) ?? make(tok);
      if (b.live || (b.asked && now - b.asked < ASK_MS) || b.retryAt > now) continue;
      ask(b, now);
    }
    schedule();
    changed();
  }
  /// Why DEGEN `tok` can't be deployed now (or, with none, why no DEGEN can), in words; null if it can.
  function cannot(tok = null) {
    if (!opts.signedIn()) return "Sign in to earn first.";
    if (!net()?.online) return "The world server is offline right now.";
    if (tok !== null && roster.has(tok)) return `DEGEN #${tok} is deployed already.`;
    if (tok !== null && tok === opts.worn?.()) return `You wear DEGEN #${tok}: wear another one to deploy it.`;
    if (tok !== null && callingBack(tok)) return `DEGEN #${tok} is still being recalled: try again in a moment.`;
    if (roster.size >= BOT_MAX) return `${BOT_MAX} DEGENs deployed at once at the most: recall one first.`;
    // (As the server counts the day's DEGENs: those that earned today and those deployed now, together.)
    if (tok !== null && new Set([...usedToday(), ...roster.keys(), tok]).size > BOT_MAX) {
      return `${BOT_MAX} different DEGENs have idle-mined for you today: only those can until 00:00 UTC.`;
    }
    return null;
  }

  // ---------------------------------------------------------------- what the world server says
  /// ["botok", tokenId, tier, level, today, cap]: deployed (or its state changed: a recheck after a level up).
  function ok(tok, tier, level, today, cap) {
    const b = roster.get(tok);
    // One this game doesn't keep (recalled while the server read the chain): let it go (its botoff is the server's
    // last word, off).
    if (!b) {
      if (net()?.sendBot("off", tok)) calledBack.set(tok, performance.now());
      return;
    }
    b.live = true;
    b.asked = b.tries = b.retryAt = 0;
    b.why = null;
    if (Number.isInteger(tier) && tier >= 0 && tier <= 2) b.tier = tier;
    if (Number.isInteger(level) && level >= 1) b.level = level;
    note(tok, today, cap);
    schedule();
    changed();
  }
  /// ["botoff", tokenId, why, retry]: recalled. With no `why` it answers a recall of this game's (the DEGEN left the
  /// roster then); otherwise `why` says why, and retry 1 means it's tried again later (the server couldn't read the
  /// chain, or it's busy), 0 that it's forgotten.
  function off(tok, why, retry) {
    calledBack.delete(tok);
    const b = roster.get(tok);
    // (Not on the roster: the answer to a recall. No reason, yet on the roster: the answer to an earlier recall of it,
    // not about this deploy.)
    if (!b || why === null) return changed();
    if (retry) {
      b.live = false;
      b.asked = 0;
      b.why = why;
      b.retryAt = performance.now() + backoff(b);
      schedule();
      return changed();
    }
    roster.delete(tok);
    remember(tok, false);
    schedule();
    opts.toast?.(`DEGEN #${tok} stopped idle mining: ${String(why).replace(/\.$/, "")}.`, "bad");
    changed();
  }
  /// ["idle", [[tokenId, units, today, cap], ...], walletTotal]: what idle mining just paid (every IDLE_TICK_MS, and on
  /// a recall). Returns the units paid, all together.
  function paid(list) {
    let units = 0;
    for (const [tok, u, today, cap] of list) {
      if (!Number.isInteger(tok)) continue;
      note(tok, today, cap);
      if (Number.isFinite(u) && u > 0) units += u;
    }
    changed();
    return units;
  }

  return {
    cannot, redeploy, ok, off, paid,
    /// The roster, by token id (for testing).
    list: roster,
    /// Deploys DEGEN `tok`: remembered for this wallet, and asked of the server. Returns why not, or null.
    deploy(tok) {
      const why = cannot(tok);
      if (why) return why;
      remember(tok, true);
      ask(make(tok), performance.now());
      schedule();
      changed();
      return null;
    },
    /// Recalls DEGEN `tok` (the server pays what it earned up to now first): it leaves the roster at once, and waits for
    /// the server's last word before it can be deployed again (calledBack).
    recall(tok) {
      const b = roster.get(tok);
      roster.delete(tok);
      remember(tok, false);
      if ((b?.live || b?.asked) && net()?.sendBot("off", tok)) calledBack.set(tok, performance.now());
      schedule();
      changed();
    },
    /// Asks the world server to read DEGEN `tok` again (it was just leveled up: its cap goes up at once).
    recheck(tok) { if (roster.get(tok)?.live) net()?.sendBot("recheck", tok); },
    /// The connection dropped: the server forgot every deployed DEGEN with it (each goes again once you're signed in on
    /// the next: redeploy), and won't answer a recall now.
    closed() {
      for (const b of roster.values()) {
        b.live = false;
        b.asked = b.tries = b.retryAt = 0;
        b.why = null;
      }
      calledBack.clear();
      clearTimeout(timer);
      changed();
    },
    /// Signed out (or in somewhere else, or another wallet): the roster leaves this game, and this browser still
    /// remembers it for the wallet (deployed again the next time it signs in here).
    signedOut() {
      roster.clear();
      calledBack.clear();
      days.clear();
      clearTimeout(timer);
      changed();
    },
    /// Why DEGEN `tok` can't be worn now (it's deployed, or idle-mined today), in words; null if it can.
    wearWhy(tok) {
      if (roster.has(tok)) {
        return `DEGEN #${tok} is deployed for idle mining: recall it first (one that idle-mined today can be worn tomorrow).`;
      }
      if (todayOf(tok)[0] > 0) return `DEGEN #${tok} idle-mined today: it can be worn from 00:00 UTC.`;
      return null;
    },
    /// What DEGEN `tok` earned idle mining today and its cap: [today, cap] in units (cap null until the server said).
    today: todayOf,
    /// The Idle mining box's rows: every DEGEN deployed, { tok, tier, level (null until the server has read them),
    /// live, state (in words), today, cap (units; null until the server has said) }.
    roster() {
      const online = !!net()?.online;
      return [...roster.values()].map((b) => {
        const [today, cap] = todayOf(b.tok);
        const state = b.live ? "Earning while you're online" : !online ? "Reconnecting…"
          : b.retryAt ? `Trying again soon${b.why ? ` (${String(b.why).replace(/\.$/, "")})` : ""}` : "Getting ready…";
        return { tok: b.tok, tier: b.tier, level: b.level, live: b.live, state, today, cap };
      });
    },
    /// For the HUD: { n (deployed), live (deployed on this connection now), today (units, all of them together), each
    /// ([tokenId, today, cap, tier]) }.
    summary() {
      const each = [...roster.keys()].map((tok) => [tok, ...todayOf(tok), roster.get(tok).tier]);
      let live = 0;
      for (const b of roster.values()) if (b.live) live++;
      return { n: roster.size, live, today: each.reduce((t, e) => t + e[1], 0), each };
    },
  };
}
