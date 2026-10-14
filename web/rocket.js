// The rocket on every landing pad (zones.js): a blocky rocket you can click (or stand on the pad and press F) to
// open the destination card, and the take-off that main.js plays before a flight: engines, smoke, and up it goes.
// Drawn standing on the curved planet (planet.js) like everything else; it isn't solid (you walk through its fins).

import * as THREE from "https://esm.sh/three@0.160.0";
import { place } from "./planet.js";
import { ZONES, ZONE_KEYS, TICKETS_FREE, ROCKET_REACH, zoneOf } from "./zones.js";
import { wrapDelta } from "./rules.js";

const mat = (color, emissive = 0) => new THREE.MeshLambertMaterial({ color, emissive });
function box(g, w, h, d, color, x, y, z, emissive) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat(color, emissive));
  m.position.set(x, y, z);
  g.add(m);
  return m;
}

/// The rocket: about 10 blocks tall, white with red bands, fins and nose, a lit window, four legs, and an engine
/// whose flame shows only at take-off. Its base is at y 0.
function rocketModel() {
  const g = new THREE.Group();
  const WHITE = 0xeef0f2, RED = 0xd23a30, DARK = 0x3a3e46;
  box(g, 1.5, 0.7, 1.5, DARK, 0, 0.55, 0); // the engine bell
  box(g, 2.2, 6, 2.2, WHITE, 0, 3.9, 0); // the body
  for (const y of [1.6, 6.0]) box(g, 2.3, 0.45, 2.3, RED, 0, y, 0);
  box(g, 0.95, 0.95, 0.12, 0x2a3a48, 0, 4.7, 1.12); // the window's frame
  box(g, 0.7, 0.7, 0.14, 0x8fd8ff, 0, 4.7, 1.13, 0x2a6a8a);
  box(g, 1.8, 0.9, 1.8, RED, 0, 7.35, 0); // the nose, stepped
  box(g, 1.3, 0.8, 1.3, RED, 0, 8.2, 0);
  box(g, 0.75, 0.7, 0.75, RED, 0, 8.95, 0);
  box(g, 0.25, 0.6, 0.25, 0xd8dce4, 0, 9.6, 0);
  for (const [x, z] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const fin = box(g, x ? 0.9 : 0.2, 2.4, z ? 0.9 : 0.2, RED, x * 1.5, 1.8, z * 1.5);
    fin.userData.fin = true;
  }
  for (const x of [-1, 1]) for (const z of [-1, 1]) box(g, 0.18, 1.1, 0.18, DARK, x * 0.95, 0.55, z * 0.95); // legs
  // The flame: two cones pointing down, outer orange and inner yellow, hidden until take-off.
  const flame = new THREE.Group();
  const outer = new THREE.Mesh(new THREE.ConeGeometry(0.75, 3, 10), new THREE.MeshBasicMaterial({ color: 0xff7a1a, transparent: true, opacity: 0.85 }));
  const inner = new THREE.Mesh(new THREE.ConeGeometry(0.4, 2, 10), new THREE.MeshBasicMaterial({ color: 0xfff0a0 }));
  outer.rotation.x = inner.rotation.x = Math.PI;
  outer.position.y = -1.3;
  inner.position.y = -0.9;
  flame.add(outer, inner);
  flame.visible = false;
  g.add(flame);
  return { g, flame };
}

export function createRocket(scene) {
  const holder = new THREE.Group(); // stood on the curved planet; the model rises within it
  const { g, flame } = rocketModel();
  holder.add(g);
  scene.add(holder);
  const at = new THREE.Vector3(); // the pad's middle, on its floor (flat)
  const puffs = [];
  const puffGeo = new THREE.BoxGeometry(1, 1, 1);
  let lift = -1; // seconds since take-off started (-1: standing)

  function setZone(k) {
    const p = zoneOf(k).pad;
    at.set(p.x + 0.5, p.y + 1, p.z + 0.5);
    lift = -1;
    g.position.set(0, 0, 0);
    g.rotation.set(0, 0, 0);
    flame.visible = false;
    for (const s of puffs.splice(0)) { holder.remove(s); s.material.dispose(); }
  }

  /// How high the rocket is `t` seconds into a take-off: the engines run a moment, then it climbs ever faster.
  const height = (t) => (t < 0.7 ? 0 : 3.2 * (t - 0.7) ** 2);

  function update(dt) {
    if (lift < 0) return;
    lift += dt;
    const y = height(lift);
    g.position.y = y;
    // A rumble on the pad before it goes.
    g.position.x = lift < 0.9 ? (Math.random() - 0.5) * 0.08 : 0;
    flame.visible = true;
    flame.scale.set(1 + Math.random() * 0.2, 1 + Math.random() * 0.5 + Math.min(1, lift), 1 + Math.random() * 0.2);
    // Smoke on the pad, billowing out and fading.
    if (y < 14 && Math.random() < dt * 40) {
      const s = new THREE.Mesh(puffGeo, new THREE.MeshLambertMaterial({ color: 0xd8d8d8, transparent: true, opacity: 0.8 }));
      const a = Math.random() * Math.PI * 2;
      s.position.set(Math.cos(a) * 0.5, 0.3, Math.sin(a) * 0.5);
      s.userData = { v: new THREE.Vector3(Math.cos(a) * (2 + Math.random() * 3), 0.6 + Math.random(), Math.sin(a) * (2 + Math.random() * 3)), life: 1.6 };
      s.scale.setScalar(0.8);
      holder.add(s);
      puffs.push(s);
    }
    for (let i = puffs.length - 1; i >= 0; i--) {
      const s = puffs[i];
      s.userData.life -= dt;
      s.position.addScaledVector(s.userData.v, dt);
      s.userData.v.multiplyScalar(1 - dt * 1.2);
      s.scale.setScalar(s.scale.x + dt * 1.8);
      s.material.opacity = Math.max(0, s.userData.life / 1.6) * 0.8;
      if (s.userData.life <= 0) { holder.remove(s); s.material.dispose(); puffs.splice(i, 1); }
    }
  }

  return {
    setZone,
    update,
    /// Start the take-off (main.js moves the camera and switches planets).
    launch() { lift = 0; },
    get lifting() { return lift >= 0; },
    /// Where the rocket's middle is now (flat), to point the camera at.
    middle(out = new THREE.Vector3()) { return out.set(at.x, at.y + 4.5 + (lift >= 0 ? height(lift) : 0), at.z); },
    /// The pad's middle on its floor (flat).
    get pad() { return at; },
    draw() { place(holder, at, 0); },
    /// The rocket, if a ray (origin o, unit direction d) hits it within `max`: { t }.
    raycast(o, d, max) {
      const px = o.x + wrapDelta(at.x - o.x), pz = o.z + wrapDelta(at.z - o.z);
      const min = [px - 1.2, at.y, pz - 1.2], mx = [px + 1.2, at.y + 9.8, pz + 1.2];
      let t0 = 0, t1 = Math.min(max, ROCKET_REACH + 2);
      const O = [o.x, o.y, o.z], D = [d.x, d.y, d.z];
      for (let k = 0; k < 3; k++) {
        if (Math.abs(D[k]) < 1e-9) { if (O[k] < min[k] || O[k] > mx[k]) return null; continue; }
        let ta = (min[k] - O[k]) / D[k], tb = (mx[k] - O[k]) / D[k];
        if (ta > tb) [ta, tb] = [tb, ta];
        t0 = Math.max(t0, ta);
        t1 = Math.min(t1, tb);
        if (t0 > t1) return null;
      }
      return { t: t0 };
    },
    /// Whether (x, y, z) (flat, a player's feet) is on the pad, close enough to fly.
    onPad(x, y, z) {
      return Math.hypot(wrapDelta(x - at.x), wrapDelta(z - at.z)) < 5.5 && Math.abs(y - at.y) < 2.5;
    },
  };
}

// ---------------------------------------------------------------- the destination card

const mineText = (wei) => (Number(wei / 10n ** 14n) / 1e4).toLocaleString("en-US", { maximumFractionDigits: 4 });
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
/// The card while it's open: { current, pick, close, sales, status: { text, kind } | null, busy, balance }.
let card = null;

/// Opens the card at the rocket: one entry per planet with its line (the current one marked "You're here"), its
/// ticket, the PvP zone's warning, and whether the zone allows PvP. `pick(key)` is called with the chosen one.
/// Whether trips are free: zones.js TICKETS_FREE, or before launch (the room says so: there's no $MINE to pay with).
let ticketsFree = TICKETS_FREE, prelaunch = false;
export function setTicketsFree(free, beforeLaunch = false) {
  ticketsFree = TICKETS_FREE || !!free;
  prelaunch = !!beforeLaunch;
}
export const ticketsAreFree = () => ticketsFree;
const freeNote = () => (TICKETS_FREE ? "free while testing" : prelaunch ? "free until $MINE launches" : "free");

/// Unless tickets are free (ticketsAreFree), a trip out needs a ticket, and `sales` sells them:
/// { tickets() → { zone: count } (the room's), signedIn() → whether the room counts a wallet (guests can't buy),
///   balance() → Promise of the wallet's $MINE in wei (or null), buy(zone, step) → Promise of the tickets there
///   after buying one (step(text) hears each stage; throws with the reason in words), signIn() → Promise,
///   moreMine() → where to get more $MINE, in words }.
export function openCard(current, pick, close, sales = null) {
  const el = document.getElementById("rocketCard");
  card = { current, pick, close, sales, status: null, busy: false, balance: null };
  el.hidden = false;
  drawCard();
  updateBalance();
  el.onclick = (e) => {
    if (!card) return;
    if (e.target === el || e.target.closest("[data-close]")) return shut(true);
    const b = e.target.closest("[data-buy]");
    if (b) return b.disabled ? null : buy(b.dataset.buy);
    if (e.target.closest("[data-signin]")) return signIn();
    const d = e.target.closest("[data-zone]");
    if (d && !d.classList.contains("off")) go(d.dataset.zone);
  };
  el.onkeydown = (e) => {
    const d = e.target.closest?.("[data-zone]");
    if (card && d && (e.key === "Enter" || e.key === " ") && !d.classList.contains("off")) { e.preventDefault(); go(d.dataset.zone); }
  };
}
function shut(closed) {
  const c = card;
  document.getElementById("rocketCard").hidden = true;
  card = null;
  if (closed) c?.close();
}
/// Whether a trip to `k` from here still needs a ticket the player doesn't have.
const lacks = (k) => !ticketsFree && !!card?.sales && k !== "home" && k !== card.current && zoneOf(k).ticket > 0
  && !(card.sales.tickets()[k] > 0);
function go(k) {
  if (lacks(k)) return say(`A trip to ${ZONES[k].name} needs a ticket: buy one below its name.`, "bad");
  const pick = card.pick;
  shut(false);
  pick(k);
}
function say(text, kind = "") {
  if (!card) return;
  card.status = text ? { text, kind } : null;
  drawCard();
}
function updateBalance() {
  const c = card;
  if (!c?.sales || ticketsFree || !c.sales.signedIn()) return;
  c.sales.balance().then((b) => { if (card === c) { c.balance = b; drawCard(); } }).catch(() => {});
}
async function buy(k) {
  const c = card;
  if (!c || c.busy) return;
  c.busy = true;
  say(`Buying a ticket to ${ZONES[k].name}…`);
  try {
    const n = await c.sales.buy(k, (text) => card === c && say(text));
    if (card === c) say(`Ticket bought: you have ${plural(n, "ticket")} to ${ZONES[k].name}. Click it to fly.`, "good");
  } catch (e) {
    if (card === c) say(e?.message ?? String(e), "bad");
  } finally {
    c.busy = false;
    if (card === c) { drawCard(); updateBalance(); }
  }
}
async function signIn() {
  const c = card;
  say("Signing in: one free signature, no transaction…");
  try {
    await c.sales.signIn();
    if (card === c) say("Signed in: you can buy tickets now.", "good");
    updateBalance();
  } catch (e) {
    if (card === c) say(e?.message ?? String(e), "bad");
  }
}

/// Draws the open card again (main.js calls it when the room's word on the tickets changes).
export function drawCard() {
  if (!card) return;
  const { current, sales, status, busy, balance } = card;
  const selling = !ticketsFree && !!sales;
  const have = selling ? sales.tickets() : {};
  const signed = selling && sales.signedIn();
  document.getElementById("rocketTicket").textContent = ticketsFree
    ? `One ticket per trip out: stay as long as you like. The way home is free. Tickets are ${freeNote()}.`
    : `One ticket per trip out, paid in $MINE to the treasury: stay as long as you like. The way home is free.${signed && balance !== null ? ` Your $MINE: ${mineText(balance)}.` : ""}`;
  const st = document.getElementById("rocketStatus");
  st.hidden = !status;
  st.className = `card-status ${status?.kind ?? ""}`;
  st.textContent = status?.text ?? "";
  document.getElementById("rocketList").innerHTML = ZONE_KEYS.map((k) => {
    const Z = ZONES[k], here = k === current, n = have[k] ?? 0, need = lacks(k);
    const wei = BigInt(Z.ticket) * 10n ** 18n, short = balance !== null && balance < wei;
    let ticket = "";
    if (!Z.ticket) ticket = here ? "" : `<span class="dest-ticket">The way home is free</span>`;
    else if (ticketsFree) ticket = `<span class="dest-ticket">Ticket: ${Z.ticket.toLocaleString()} $MINE (${freeNote()})</span>`;
    else if (n > 0) ticket = `<span class="dest-have">🎫 You have ${plural(n, "ticket")} to ${Z.name}</span>`;
    else ticket = `<span class="dest-ticket">Ticket: ${Z.ticket.toLocaleString()} $MINE</span>`;
    const buyRow = !need ? "" : !signed
      ? `<span class="dest-buy"><button class="btn gold" data-signin ${busy ? "disabled" : ""}>Sign in to buy a ticket</button>
         <span class="small muted">The world server keeps tickets for your wallet: guests can't fly out.</span></span>`
      : `<span class="dest-buy"><button class="btn gold" data-buy="${k}" ${busy || short ? "disabled" : ""}>Buy ticket: ${Z.ticket.toLocaleString()} $MINE</button>
         ${short ? `<span class="small warn">Not enough $MINE: ${sales.moreMine?.() ?? "get some in the Mining Site panel (M)"}.</span>` : ""}</span>`;
    return `<div class="dest ${Z.pvp ? "pvp" : ""} ${here ? "off" : ""} ${need ? "locked" : ""}" data-zone="${k}" role="button" tabindex="${here ? -1 : 0}" aria-disabled="${here || need}">
      <span class="dest-head"><b>${Z.name}</b><span class="dest-label ${k}">${Z.label}</span>${here ? `<span class="here">You're here</span>` : ""}</span>
      <span class="dest-line">${Z.line}</span>
      ${ticket}
      ${Z.warn ? `<span class="dest-warn">⚠ ${Z.warn}</span>` : `<span class="dest-rule">${Z.rule}</span>`}
      ${buyRow}
    </div>`;
  }).join("");
}
export const cardOpen = () => !document.getElementById("rocketCard").hidden;
export function closeCard() { if (card) shut(false); else document.getElementById("rocketCard").hidden = true; }
