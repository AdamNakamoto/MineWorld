// The Mining Site panel: log in, sign in to earn (free), open a mining site (ETH), convert earnings to $MINE, trade
// $MINE, and mint or wear a MineWorld Crafter. Everything about money happens here, in plain words.

import { formatEther } from "https://esm.sh/viem@2";
import { explain } from "./chain.js";
import { createTrade } from "./trade.js";
import { svg, sealedSvg, HAIRS, OUTFITS } from "./crafters.js";
import { ROOKIE } from "./avatar.js";
import { fmtMine, BLOCK_REWARDS, MOB_REWARDS, DAILY_EARN_CAP } from "./rewards.js";
import { itemName } from "./blocks.js";
import { MOBS } from "./rules.js";
import { short } from "./net.js";

const eth = (wei) => Number(formatEther(wei)).toLocaleString("en-US", { maximumFractionDigits: 5 });
const mine = (wei) => Number(formatEther(wei)).toLocaleString("en-US", { maximumFractionDigits: 2 });
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/// `game`: { chain, net, ledger() → { signedIn, wallet, today, total, cap }, signIn(), toast(text, kind), wear(traits, id) }.
export function createPanel(game) {
  const el = document.getElementById("panel");
  const body = document.getElementById("panelBody");
  const tradeEl = document.getElementById("tradeBox");
  const { chain } = game;
  let snap = null, busy = false, timer = 0, trade = null, worn = null;
  try { worn = JSON.parse(localStorage.getItem("mwc:worn")); } catch {}

  async function run(what, fn) {
    if (busy) return;
    busy = true;
    render();
    game.toast(`${what}…`);
    try {
      await fn();
      game.toast(`${what}: done.`, "good");
    } catch (e) {
      console.warn(what, e);
      game.toast(explain(e), "bad");
    } finally {
      busy = false;
      await refresh();
    }
  }

  async function refresh() {
    if (!chain) return render();
    try {
      snap = await chain.snapshot();
    } catch (e) {
      console.warn("snapshot failed", e);
    }
    render();
    trade?.update(snap ?? {});
  }

  function open() {
    el.hidden = false;
    document.exitPointerLock?.();
    refresh();
    clearInterval(timer);
    timer = setInterval(refresh, 5000);
    if (chain?.trade && !trade) trade = createTrade(chain, tradeEl, { run, isBusy: () => busy, onLogin: login });
  }
  function close() {
    el.hidden = true;
    clearInterval(timer);
  }
  el.addEventListener("click", (e) => {
    if (e.target === el || e.target.closest("[data-close]")) return close();
    const b = e.target.closest("[data-act]");
    if (b && !b.disabled) act(b.dataset.act, b.dataset);
  });

  async function login() {
    try { await chain.login(); } catch (e) { game.toast(explain(e), "bad"); }
    refresh();
  }

  async function act(what, data) {
    const L = game.ledger();
    switch (what) {
      case "login": return login();
      case "logout": chain.logout(); return refresh();
      case "devacct": return chain.login(data.a).then(refresh);
      case "signin": return run("Signing in to earn", () => game.signIn());
      case "open": return run("Opening your mining site", () => chain.openSite(snap.sitePrice));
      case "convert": return run("Converting your earnings to $MINE", async () => {
        if (!L.signedIn) throw new Error("Sign in to earn first.");
        const v = await game.net.voucher();
        const pay = await chain.claimable(v.total);
        if (pay === 0n) throw new Error("Nothing to convert right now: today's limits may be reached. They reset at 00:00 UTC.");
        await chain.claim(v);
      });
      case "mint": return run(`Minting ${data.n} Crafter${data.n > 1 ? "s" : ""}`, () => chain.mintCrafters(Number(data.n), snap.crafters.price));
      case "wear": {
        const id = data.id === "none" ? null : Number(data.id);
        worn = id;
        try { localStorage.setItem("mwc:worn", JSON.stringify(id)); } catch {}
        const m = snap?.crafters?.mine.find((x) => x.id === id);
        game.wear(id === null ? null : m?.traits ?? null, id);
        return render();
      }
      case "fund": return run("Adding play ETH", () => chain.devFund());
    }
  }

  function render() {
    if (el.hidden) return;
    const L = game.ledger();
    if (!chain) {
      body.innerHTML = `
        <p>Earn <b class="gold">$MINE</b> by playing: breaking natural blocks (rarer ores pay more) and defeating monsters.</p>
        <div class="box"><h3>Coming soon</h3><p class="note">The $MINE token, mining sites and the Miners collection aren't on-chain yet. You can already play, and once
        you sign in, everything you earn is counted.</p></div>
        ${economyBox()} ${ratesBox()}`;
      tradeEl.hidden = true;
      return;
    }
    const s = snap;
    const acct = chain.account;
    const site = !!s?.site;
    const earnedWei = BigInt(L.total) * 10n ** 16n;
    const claimed = s?.claimed ?? 0n;
    const ready = earnedWei > claimed ? earnedWei - claimed : 0n;
    const step = (done, text) => `<li class="${done ? "done" : ""}">${done ? "✓ " : ""}${text}</li>`;
    body.innerHTML = `
      <ol class="steps">
        ${step(!!acct, acct ? `Logged in as ${short(acct)}` : "Log in with your wallet")}
        ${step(L.signedIn, L.signedIn ? "Signed in: your activity earns $MINE" : "Sign in to earn (one free signature)")}
        ${step(site, site ? "Your mining site is open" : "Open your mining site (needed to convert)")}
        ${step(false, "Convert what you earn to $MINE, any time")}
      </ol>
      <div class="row-btns">
        ${!acct ? `<button class="btn gold" data-act="login">Log in</button>` : ""}
        ${acct && !L.signedIn ? `<button class="btn gold" data-act="signin" ${busy ? "disabled" : ""}>Sign in to earn</button>` : ""}
        ${acct ? `<button class="btn" data-act="logout">Log out</button>` : ""}
        ${chain.local && acct ? `<button class="btn" data-act="fund" ${busy ? "disabled" : ""}>+10 play ETH</button>` : ""}
      </div>
      ${s?.devAccounts ? `<p class="note">Local chain: play as one of Anvil's accounts.
        ${s.accounts.slice(2, 6).map((a) => `<button class="link-btn" data-act="devacct" data-a="${a}">${short(a)}</button>`).join(" · ")}</p>` : ""}

      <section class="box">
        <h3>Your earnings</h3>
        <div class="kv"><span>Earned today</span><b class="gold">${fmtMine(L.today)} / ${fmtMine(L.cap)} $MINE</b></div>
        <div class="kv"><span>Earned in all</span><b>${fmtMine(L.total)} $MINE</b></div>
        <div class="kv"><span>Converted so far</span><b>${acct ? mine(claimed) : "—"} $MINE</b></div>
        <div class="kv"><span>Ready to convert</span><b class="gold">${L.signedIn ? mine(ready) : "—"} $MINE</b></div>
        ${s ? `<div class="kv"><span>Your conversions today</span><b>${acct ? mine(s.walletPaid) : "0"} / ${mine(s.walletCap)}</b></div>
        <div class="kv"><span>Everyone's conversions today</span><b>${mine(s.paidToday)} / ${mine(s.dailyCap)}</b></div>` : ""}
        ${s?.paused ? `<p class="warn small">Converting is paused right now. Your earnings stay on the ledger.</p>` : ""}
        <button class="btn gold wide" data-act="convert" ${!acct || !L.signedIn || !site || ready === 0n || busy || s?.paused ? "disabled" : ""}>Convert to $MINE</button>
        <p class="note">${!site && acct ? "Open a mining site first: only wallets with one can convert. " : ""}Earnings are counted by the world server and paid from the mining vault (half of all $MINE). Each wallet converts up to the daily limit; the rest waits for the next day.</p>
      </section>

      <section class="box">
        <h3>Mining site <span class="status ${site ? "open" : "closed"}">${site ? "OPEN" : "NOT OPEN"}</span></h3>
        ${site
          ? `<p class="note">Opened ${new Date(s.site * 1000).toLocaleDateString()}. It's yours for good and lets this wallet convert earnings to $MINE.</p>`
          : `<div class="kv"><span>Price (once, paid in ETH)</span><b>${s ? eth(s.sitePrice) : "…"} ETH</b></div>
             ${acct && s ? `<div class="kv"><span>Your ETH</span><b>${eth(s.eth)}</b></div>` : ""}
             <button class="btn gold wide" data-act="open" ${!acct || !s || busy || (s.eth ?? 0n) < s.sitePrice ? "disabled" : ""}>Open my mining site</button>
             <p class="note">One per wallet. You can play and earn without one; you need it to turn your earnings into $MINE.</p>`}
      </section>

      ${acct && s ? `<section class="box"><h3>Wallet</h3>
        <div class="kv"><span>$MINE</span><b class="gold">${mine(s.mine)}</b></div>
        <div class="kv"><span>ETH</span><b>${eth(s.eth)}</b></div>
        ${s.imd !== null && s.imd !== undefined ? `<div class="kv"><span>IMD</span><b>${mine(s.imd)}</b></div>` : ""}</section>` : ""}

      ${craftersBox(s, acct)}
      ${economyBox()}
      ${ratesBox()}`;
    tradeEl.hidden = !chain.trade;
  }

  const pic = (src) => `data:image/svg+xml;utf8,${encodeURIComponent(src)}`;
  function craftersBox(s, acct) {
    const M = s?.crafters;
    if (!M) return "";
    const left = M.max - M.minted;
    const mine = M.mine ?? [];
    const price = M.price === 0n ? "Free (gas only)" : `${eth(M.price)} ETH`;
    return `<section class="box">
      <h3>MineWorld Crafters</h3>
      <p class="note">${M.max.toLocaleString()} characters, drawn and stored fully on-chain: every picture is made by the contract itself, and no two are
      alike (${HAIRS.length} hairs, ${OUTFITS.length} outfits, hats, skins, eyes, backgrounds). The one you wear is how your miner looks in the world.
      Cosmetic only: never what you earn. Minted sealed, revealed after the mint. Resales pay a 5% creator royalty.</p>
      <div class="kv"><span>Minted</span><b>${M.minted.toLocaleString()} / ${M.max.toLocaleString()}</b></div>
      <div class="kv"><span>Price</span><b>${price}</b></div>
      ${M.limit ? `<div class="kv"><span>Per wallet</span><b>${M.limit}</b></div>` : ""}
      ${M.saleOpen && left > 0
        ? `<div class="row-btns">${[1, 3, 5].map((n) => `<button class="btn${n === 1 ? " gold" : ""}" data-act="mint" data-n="${n}" ${!acct || busy || n > left ? "disabled" : ""}>Mint ${n}</button>`).join("")}</div>`
        : `<p class="note">${left <= 0 ? "Sold out." : "The mint isn't open right now."}</p>`}
      ${mine.length ? `<h3>Yours</h3><div class="miners">
        <button class="miner ${worn === null ? "on" : ""}" data-act="wear" data-id="none"><img src="${pic(svg(ROOKIE))}" alt="">Rookie</button>
        ${mine.map((m) => `<button class="miner ${worn === m.id ? "on" : ""}" data-act="wear" data-id="${m.id}" ${m.traits ? "" : "disabled"}>
          <img src="${pic(m.traits ? svg(m.traits) : sealedSvg())}" alt="">#${m.id}${m.traits ? "" : " sealed"}</button>`).join("")}
      </div><p class="note">${mine.some((m) => m.traits) ? "Tap one to wear it. Others see it once the world server has checked it's yours." : "Yours are sealed until the reveal."}</p>` : ""}
    </section>`;
  }

  function economyBox() {
    return `<section class="box"><h3>How $MINE works</h3>
      <div class="kv"><span>Supply</span><b>1,000,000,000 $MINE, fixed</b></div>
      <div class="kv"><span>Liquidity</span><b>50%, locked forever in the $MINE/IMD pool</b></div>
      <div class="kv"><span>Mining vault</span><b>50%, earned only by playing</b></div>
      <div class="kv"><span>Trading fee</span><b>4% per trade</b></div>
      <p class="note">No yield farming: nothing pays for holding or waiting. $MINE comes only from what you do in the world.</p></section>`;
  }

  function ratesBox() {
    const blocks = Object.entries(BLOCK_REWARDS).sort((a, b) => b[1] - a[1]).map(([id, v]) => `<div class="kv"><span>${esc(itemName(Number(id)))}</span><b>${v}</b></div>`).join("");
    const mobs = Object.entries(MOB_REWARDS).map(([k, v]) => `<div class="kv"><span>${esc(MOBS[k].name)}</span><b>${v}</b></div>`).join("");
    return `<section class="box"><h3>What earns $MINE</h3>
      <p class="note">Natural blocks only (blocks players placed pay nothing). Up to ${DAILY_EARN_CAP.toLocaleString()} $MINE per wallet per day.</p>
      ${blocks}<h3>Monsters</h3>${mobs}
      <p class="note">Monsters come out at night, and underground at any time.</p></section>`;
  }

  return { open, close, refresh, get isOpen() { return !el.hidden; }, get worn() { return worn; }, render };
}
