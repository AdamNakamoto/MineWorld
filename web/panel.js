// The Mining Site panel: log in, sign in to earn (free), open a mining site (ETH) and upgrade it ($MINE), convert
// earnings to $MINE, trade $MINE, mint or wear an I'M DEGEN character and level it up ($MINE), deploy your other
// DEGENs for idle mining (bots.js), and see your NFT boosts (boosts.js). Everything about money happens here, in plain
// words. Every $MINE payment approves exactly what it costs, then pays (chain.js payMine); part of it is burned and
// the rest goes to the project's treasury.

import { formatEther } from "https://esm.sh/viem@2";
import { explain } from "./chain.js";
import { createTrade } from "./trade.js";
import { cardSvg, sealedSvg, TOPS, HEADWEAR, rarityOf, RARITIES, ROOKIE } from "./degen-skin.js";
import { fmtMine, unitsToWei, BLOCK_REWARDS, MOB_REWARDS, DAILY_EARN_CAP, VAULT_DAILY_LIMIT, ZONE_PAY } from "./rewards.js";
import { SLOTS, SLOT_KEYS, TIERS, CRAFTER_LEVELS, MAX, NO_BOOST, issued, itemBoost, describe, dailyCap } from "./boosts.js";
import { BOT_MAX, idleRate } from "./bots-rules.js";
import { itemName } from "./blocks.js";
import { MOBS } from "./rules.js";
import { short } from "./net.js";

const eth = (wei) => Number(formatEther(wei)).toLocaleString("en-US", { maximumFractionDigits: 5 });
const mine = (wei) => Number(formatEther(wei)).toLocaleString("en-US", { maximumFractionDigits: 4 });
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/// `game`: { chain, net, ledger() → { signedIn, wallet, today, total, cap, boost }, signIn(), toast(text, kind),
/// wear(traits, id), leveled(tokenId, level) (a DEGEN was just leveled up), sitesOpen() (mining sites open, as the
/// world server counts them, or null), refreshCount() (ask the world server again, at most once a minute),
/// siteOpened() (this wallet just opened its site: the world server counts it), bots: the Idle mining box's { list()
/// (bots.js roster), today(tokenId) ([units earned today, its cap or null]), cannot(tokenId) (why it can't be deployed now, or null), wearWhy(tokenId) (why it can't be worn
/// now, or null), deploy(tokenId) (returns why not, or null), recall(tokenId), returned() (pickaxes the old autopilot
/// bots held, waiting for room in the bag: { i, id, d, max, name, icon }), takeBack(i) } }. The ledger's amounts are in
/// units (rewards.js UNIT).
export function createPanel(game) {
  const el = document.getElementById("panel");
  const body = document.getElementById("panelBody");
  const tradeEl = document.getElementById("tradeBox");
  const { chain } = game;
  let snap = null, busy = false, timer = 0, trade = null, worn = null;
  // The reveal's secret as the owner pastes it (kept across the panel's refreshes, never stored).
  let secretDraft = null;
  // What the last action said, shown where it was started (`at`: "site", "crafter:<id>"...): its progress, how it
  // ended, or why it didn't go through.
  let status = null;
  try { worn = JSON.parse(localStorage.getItem("mwc:worn")); } catch {}

  /// Runs an action: `fn(step)` may report each stage with step(text) and return the words to end with.
  async function run(what, fn, at = null) {
    if (busy) return;
    busy = true;
    status = { at, text: `${what}…`, kind: "" };
    render();
    game.toast(`${what}…`);
    const step = (text) => { status = { at, text, kind: "" }; render(); game.toast(text); };
    try {
      const said = await fn(step);
      status = { at, text: typeof said === "string" ? said : `${what}: done.`, kind: "good" };
      game.toast(status.text, typeof said === "string" ? "gold" : "good");
    } catch (e) {
      console.warn(what, e);
      status = { at, text: explain(e), kind: "bad" };
      game.toast(status.text, "bad");
    } finally {
      busy = false;
      await refresh();
    }
  }
  const statusAt = (at) => (status && status.at === at ? `<p class="card-status ${status.kind}" role="status">${esc(status.text)}</p>` : "");

  async function refresh() {
    if (!chain) return render();
    try {
      snap = await chain.snapshot();
      // What converting now would pay, at the site's rate and within today's caps (MiningSites.claimable).
      const L = game.ledger();
      if (snap?.site && L.signedIn && L.total) snap.payNow = await chain.claimable(unitsToWei(L.total));
      if (snap?.admin) game.refreshCount?.();
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
  el.addEventListener("input", (e) => {
    if (e.target.id === "revealSecret") secretDraft = e.target.value;
  });
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
      case "open": return run("Opening your mining site", async () => {
        await chain.openSite(snap.sitePrice);
        game.siteOpened?.();
      });
      case "convert": return run("Converting your earnings to $MINE", async () => {
        if (!L.signedIn) throw new Error("Sign in to earn first.");
        const v = await game.net.voucher();
        const pay = await chain.claimable(v.total);
        if (pay === 0n) throw new Error("Nothing to convert right now: today's limits may be reached. They reset at 00:00 UTC.");
        const got = await chain.claim(v);
        if (got?.earnings !== undefined) {
          game.toast(`Converted ${mine(got.earnings)} $MINE of earnings at ${Number(got.rateBps) / 100}%: you received ${mine(got.amount)} $MINE.`, "gold");
        }
      });
      case "mint": return run(`Minting ${data.n} DEGEN${data.n > 1 ? "s" : ""}`, () => chain.mintCrafters(Number(data.n), snap.crafters.price));
      // Anyone: lock the reveal in (seal), waiting for its block and retrying until it's set. The owner: publish the
      // secret first (reveal), then the same, at once, so no window passes unsealed.
      case "seal": return run("Locking in the I'M DEGEN reveal", async (step) => {
        await chain.revealAndSeal(null, { step });
        return "Locked in: every DEGEN's look is fixed for good, and shows now.";
      }, "seal");
      case "reveal": {
        const secret = (document.getElementById("revealSecret")?.value ?? "").trim();
        if (!/^\d+$/.test(secret)) return game.toast("Paste the reveal's secret (the number in your secret file).", "bad");
        return run("Revealing I'M DEGEN", async (step) => {
          await chain.revealAndSeal(secret, { step });
          secretDraft = null;
          return "Revealed and locked in: every DEGEN's look is fixed for good, and shows now.";
        }, "seal");
      }
      case "upsite": {
        // The cost shown is the cost approved and the most the upgrade may charge (maxCost), and the rate shown is the
        // least it must buy (minRateBps): if the owner changed either meanwhile, the upgrade fails rather than charge
        // for less.
        const up = snap?.siteUp;
        if (!up?.next) return;
        return run(`Upgrading your mining site to level ${up.next}`, async (step) => {
          const level = (await chain.upgradeSite(up.cost, { step, minRateBps: up.nextRate })) ?? up.next;
          return `Your mining site is level ${level} now: it converts ${up.nextRate / 100}% of what you earn. Your next conversion pays at that rate.`;
        }, "site");
      }
      case "levelup": {
        const id = Number(data.id);
        const m = snap?.crafters?.mine.find((x) => x.id === id), lv = snap?.crafters?.levels;
        const level = m?.level ?? null;
        if (!m || !lv || level === null || level >= lv.max) return;
        const cost = lv.costs[level - 1];
        return run(`Leveling up DEGEN #${id} to level ${level + 1}`, async (step) => {
          const now = (await chain.levelUp(id, cost, { step })) ?? level + 1;
          game.leveled?.(id, now);
          const r = m.traits ? rarityOf(m.traits) : null;
          const b = r === null ? "" : `: ${describe(itemBoost("crafter", r, now))}`;
          return `DEGEN #${id} is level ${now} now${b}.${worn === id ? " Your boost updates in a moment." : ""}`;
        }, `crafter:${id}`);
      }
      case "wear": {
        const id = data.id === "none" ? null : Number(data.id);
        const why = id === null ? null : game.bots?.wearWhy(id);
        if (why) return game.toast(why, "bad");
        worn = id;
        try { localStorage.setItem("mwc:worn", JSON.stringify(id)); } catch {}
        const m = snap?.crafters?.mine.find((x) => x.id === id);
        game.wear(id === null ? null : m?.traits ?? null, id);
        return render();
      }
      case "claimFees": return run("Claiming the trading fees", async (step) => {
        step("Claiming the trading fees: confirm in your wallet…");
        const got = await chain.admin.collectFees();
        return got ? `Claimed ${mine(got.amount)} IMD in trading fees to ${short(got.to)}.` : "Nothing was waiting to claim.";
      }, "admin");
      case "fund": return run("Adding play ETH", () => chain.devFund());
      // The Idle mining box.
      case "boton": {
        const tok = Number(data.id), why = game.bots.deploy(tok);
        status = why ? { at: `bot:${tok}`, text: why, kind: "bad" } : null;
        return render();
      }
      case "botoff": game.bots.recall(Number(data.id)); status = null; return render();
      case "bottake": {
        if (!game.bots.takeBack(Number(data.i))) game.toast("Make room in your bag first.", "bad");
        return render();
      }
    }
  }

  function render() {
    if (el.hidden) return;
    if (document.activeElement?.id === "revealSecret") return; // (don't redraw under the owner's typing)
    const L = game.ledger();
    if (!chain) {
      body.innerHTML = `
        <p>Earn <b class="gold">$MINE</b> by playing: breaking natural blocks (rarer ores pay more) and defeating monsters.</p>
        <div class="box"><h3>Coming soon</h3><p class="note">The $MINE token, mining sites and the I'M DEGEN collection aren't on-chain yet. You can already play, and once
        you sign in, everything you earn is counted.</p></div>
        ${boostsBox(L)} ${economyBox()} ${ratesBox()}`;
      tradeEl.hidden = true;
      return;
    }
    const s = snap;
    const acct = chain.account;
    const site = !!s?.site;
    const earnedWei = unitsToWei(L.total);
    const claimed = s?.claimed ?? 0n; // $MINE received
    const settled = s?.settled ?? claimed; // earnings converted (the same before sites had rates)
    const ready = earnedWei > settled ? earnedWei - settled : 0n;
    const pct = s?.rateBps ? `${s.rateBps / 100}%` : null;
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

      ${adminBox(s)}

      <section class="box">
        <h3>Your earnings</h3>
        <div class="kv"><span>Earned today</span><b class="gold">${fmtMine(L.today)} / ${fmtMine(L.cap)} $MINE</b></div>
        <div class="kv"><span>Earned in all</span><b>${fmtMine(L.total)} $MINE</b></div>
        <div class="kv"><span>Earnings converted so far</span><b>${acct ? mine(settled) : "—"} $MINE</b></div>
        <div class="kv"><span>$MINE received so far</span><b>${acct ? mine(claimed) : "—"} $MINE</b></div>
        <div class="kv"><span>Earned, not converted yet</span><b class="gold">${L.signedIn ? mine(ready) : "—"} $MINE</b></div>
        ${site && pct ? `<div class="kv"><span>You'll receive now (at your site's ${pct}${s.siteLevel ? `, level ${s.siteLevel}` : ""})</span><b class="gold">${L.signedIn && s.payNow !== undefined ? mine(s.payNow) : "—"} $MINE</b></div>` : ""}
        ${s ? `<div class="kv"><span>Your conversions today</span><b>${acct ? mine(s.walletPaid) : "0"} / ${mine(s.walletCap)}</b></div>
        <div class="kv"><span>Everyone's conversions today</span><b>${mine(s.paidToday)} / ${mine(s.dailyCap)}</b></div>` : ""}
        ${s?.paused ? `<p class="warn small">Converting is paused right now. Your earnings stay on the ledger.</p>` : ""}
        <button class="btn gold wide" data-act="convert" ${!acct || !L.signedIn || !site || ready === 0n || busy || s?.paused ? "disabled" : ""}>Convert to $MINE</button>
        <p class="note">${!site && acct ? "Open a mining site first: only wallets with one can convert. " : ""}Earnings are counted by the world server; converting mints $MINE from the mining vault (half of all $MINE) at your site's rate (50% at level 1, up to 100% at level 5), within the daily limits. What a day's limits don't cover waits for the next day.</p>
      </section>

      ${boostsBox(L)}

      <section class="box">
        <h3>Mining site <span class="status ${site ? "open" : "closed"}">${site ? "OPEN" : "NOT OPEN"}</span></h3>
        ${site
          ? `<p class="note">Opened ${new Date(s.site * 1000).toLocaleDateString()}. It's yours for good and lets this wallet convert earnings to $MINE.</p>
             ${siteLevelBox(s)}`
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
      ${idleBox(s, L)}
      ${economyBox()}
      ${ratesBox()}`;
    tradeEl.hidden = !chain.trade;
  }

  /// The project wallet's box (chain.js adminStats): the trading fees waiting in the pool and the button that sends them
  /// to the fee wallet, the treasury's balances, and how $MINE and the game are doing.
  function adminBox(s) {
    const a = s?.admin;
    if (!a) return "";
    const m = a.market, sites = game.sitesOpen?.() ?? null;
    const usd = (n) => `$${n.toLocaleString("en-US", { maximumFractionDigits: n < 1 ? 6 : 2 })}`;
    const inUsd = (wei, per) => (per ? ` (≈ ${usd(Number(formatEther(wei)) * per)})` : "");
    const link = (addr) => (s.explorer ? `<a href="${s.explorer}/address/${addr}" target="_blank" rel="noopener">${short(addr)}</a>` : short(addr));
    const whole = (wei) => Math.round(Number(formatEther(wei))).toLocaleString("en-US");
    return `<section class="box admin">
      <h3>Admin <span class="status open">YOUR WALLET</span></h3>
      <div class="kv"><span>Trading fees waiting</span><b class="gold">${mine(a.pendingFees)} IMD${inUsd(a.pendingFees, m?.imdUsd)}</b></div>
      <button class="btn gold wide" data-act="claimFees" ${a.pendingFees === 0n || busy ? "disabled" : ""}>Claim fees to ${short(a.feeRecipient)}</button>
      ${statusAt("admin")}
      <p class="note">4% of every $MINE trade, paid in IMD, waits in the pool until it's claimed; claiming sends all of it to the fee wallet
      ${link(a.feeRecipient)} (gas only). Everything else reaches the treasury by itself: mining site sales (ETH), 25% of site upgrades,
      DEGEN levels and the shop, every ticket and revive${a.royaltyBps !== null ? `, and the ${a.royaltyBps / 100}% DEGEN royalty` : ""}.</p>
      <h3>Treasury · ${link(a.treasury)}</h3>
      <div class="kv"><span>ETH</span><b>${eth(a.treasuryEth)}</b></div>
      <div class="kv"><span>IMD</span><b>${mine(a.treasuryImd)}${inUsd(a.treasuryImd, m?.imdUsd)}</b></div>
      <div class="kv"><span>$MINE</span><b>${mine(a.treasuryMine)}${inUsd(a.treasuryMine, m?.tokenUsd)}</b></div>
      <h3>$MINE token</h3>
      ${m ? `<div class="kv"><span>Price</span><b>${usd(m.tokenUsd)}</b></div>
      <div class="kv"><span>Market cap (all in circulation)</span><b>${usd(Number(formatEther(a.supply)) * m.tokenUsd)}</b></div>` : ""}
      <div class="kv"><span>Mined by players so far</span><b>${whole(a.mined)}</b></div>
      <div class="kv"><span>Burned</span><b>${whole(a.burned)}</b></div>
      <div class="kv"><span>In circulation</span><b>${whole(a.supply)} / 21,000,000</b></div>
      ${sites !== null ? `<div class="kv"><span>Mining sites open</span><b>${sites.toLocaleString("en-US")}</b></div>` : ""}
    </section>`;
  }

  /// The site's level and what upgrading it costs and does (MiningSites: upgradeSite, paid in $MINE).
  function siteLevelBox(s) {
    if (!s.siteLevel) return "";
    const up = s.siteUp;
    const rows = `<div class="kv"><span>Level</span><b class="gold">${s.siteLevel}${up ? ` of ${up.max}` : ""}</b></div>
      <div class="kv"><span>Converts</span><b>${s.rateBps / 100}% of what you earn</b></div>`;
    if (!up) return rows;
    if (!up.next) {
      return `${rows}<div class="kv"><span>Upgrades</span><b class="gold">Max level</b></div>
        <p class="note">Your site is at the top level: it converts ${s.rateBps / 100}% of everything you earn.</p>${statusAt("site")}`;
    }
    const short = s.mine !== undefined && s.mine < up.cost;
    const burn = up.burnBps / 100;
    return `${rows}
      <div class="kv"><span>Level ${up.next} converts</span><b class="gold">${up.nextRate / 100}%</b></div>
      <div class="kv"><span>Upgrade to level ${up.next}</span><b class="gold">${mine(up.cost)} $MINE</b></div>
      <button class="btn gold wide" data-act="upsite" ${busy ? "disabled" : ""}>Upgrade to level ${up.next}</button>
      ${statusAt("site")}
      <p class="note">Paid in $MINE from your wallet (it asks you to approve exactly ${mine(up.cost)}, then to pay): ${burn}% is burned for good
      and ${100 - burn}% goes to the project treasury. Your next conversion pays at the new rate, earnings not converted yet included.
      ${short ? `<span class="warn">You have ${mine(s.mine)} $MINE: ${chain.trade ? "buy more in the trade box below" : "convert your earnings first"}.</span>` : ""}</p>`;
  }

  const pic = (src) => `data:image/svg+xml;utf8,${encodeURIComponent(src)}`;
  function craftersBox(s, acct) {
    const M = s?.crafters;
    if (!M) return "";
    const left = M.max - M.minted;
    const mine = M.mine ?? [];
    const price = M.price === 0n ? "Free (gas only)" : `${eth(M.price)} ETH`;
    // What this wallet may still mint: the per-wallet limit (3 at launch) less what it has minted, at most 5 at once.
    const room = M.limit === null || M.mintedByMe === null ? left : Math.max(0, M.limit - M.mintedByMe);
    const most = Math.min(5, left, room);
    const sizes = [1, 2, 3, 5].filter((n) => n <= most);
    return `<section class="box">
      <h3>I'M DEGEN</h3>
      <p class="note">${M.max.toLocaleString()} frogs, each a full Minecraft-style skin, drawn and stored fully on-chain: every picture is made by the contract itself, and no two are
      alike (${TOPS.length} tops, ${HEADWEAR.length - 1} headwear, skins, faces, shoes, accessories, backgrounds). The one you wear is your miner in the world, the same skin pixel for pixel.
      The one you wear also boosts your mining by its rarity and level (see Boosts). Minted sealed, revealed after the mint. Resales pay a 5%
      creator royalty.</p>
      <div class="kv"><span>Minted</span><b>${M.minted.toLocaleString()} / ${M.max.toLocaleString()}</b></div>
      <div class="kv"><span>Price</span><b>${price}${M.limit ? `, at most ${M.limit} per wallet` : ""}</b></div>
      ${acct && M.mintedByMe !== null && M.limit ? `<div class="kv"><span>You've minted</span><b>${M.mintedByMe} of ${M.limit}</b></div>` : ""}
      ${!M.saleOpen || left <= 0
        ? `<p class="note">${left <= 0 ? "Sold out." : "The mint isn't open right now."}</p>`
        : acct && room === 0
          ? `<p class="note">You've minted ${M.limit}: that's the most one wallet can mint.</p>`
          : `<div class="row-btns">${sizes.map((n) => `<button class="btn${n === 1 ? " gold" : ""}" data-act="mint" data-n="${n}" ${!acct || busy ? "disabled" : ""}>Mint ${n}</button>`).join("")}</div>`}
      ${revealBox(M, acct)}
      ${mine.length ? `<h3>Yours</h3><div class="miners">
        <button class="miner ${worn === null ? "on" : ""}" data-act="wear" data-id="none"><img src="${pic(cardSvg(ROOKIE))}" alt="">Rookie</button>
        ${mine.map((m) => {
          const r = m.traits ? rarityOf(m.traits) : null;
          return `<button class="miner ${worn === m.id ? "on" : ""}" data-act="wear" data-id="${m.id}" ${m.traits ? "" : "disabled"}>
          <img src="${pic(m.traits ? cardSvg(m.traits) : sealedSvg())}" alt="">#${m.id}${m.traits ? "" : " sealed"}${r === null ? "" : `<span class="tier t${r}">${RARITIES[r]}</span>`}</button>`;
        }).join("")}
      </div><p class="note">${mine.some((m) => m.traits) ? "Tap one to wear it. Others see it once the world server has checked it's yours." : "Yours are sealed until the reveal."}</p>
      ${levelsList(M, s)}` : ""}
    </section>`;
  }

  /// Where the reveal stands (MineWorldCrafters.revealStatus: 0 secret not out, 1 waiting, 2 sealable, 3 expired, 4
  /// revealed, 5 stuck), and the button anyone can press once the owner has published the secret: it locks the reveal
  /// in with the next block's hash, which the chain only gives for 256 blocks (about 26 seconds). After a window nobody
  /// sealed in, only the owner can move it on (moveEntropyOn, at most three times); the owner's reveal seals at once.
  function revealBox(M, acct) {
    const st = M.revealStatus;
    if (st === null || st === undefined || st === 4) return "";
    if (st === 0) {
      if (M.saleOpen || M.minted === 0) return "";
      if (!M.isOwner) return `<p class="note">Reveal: the owner publishes the secret next; then anyone can lock the reveal in, here.</p>`;
      // The owner's reveal: the secret, then seal() straight after (chain.revealAndSeal), so no window passes unsealed.
      return `<p class="note">You own I'M DEGEN. Paste the reveal's secret: the panel publishes it, then locks the reveal in as soon as the next
        block is over (two confirmations in your wallet; it retries until it's locked in).</p>
        <div class="row-form"><input id="revealSecret" type="password" autocomplete="off" placeholder="the reveal's secret" value="${esc(secretDraft ?? chain.devSecret ?? "")}"></div>
        <button class="btn gold wide" data-act="reveal" ${!acct || busy ? "disabled" : ""}>Reveal and lock in</button>${statusAt("seal")}`;
    }
    if (st === 5) return `<p class="note">The reveal can't happen any more: its block was moved on three times and the last window passed with nobody locking it in.</p>`;
    if (st === 3 && !M.isOwner) return `<p class="note">The reveal's window is closing or closed. If nobody locked it in, only the owner can pick a new block (it can, ${M.movesLeft ?? 0} more time${M.movesLeft === 1 ? "" : "s"}); then anyone locks it in, here.</p>`;
    const label = st === 3 ? `Pick a new block and lock it in (${M.movesLeft} left)` : "Lock in the reveal";
    const note = {
      1: "The owner has published the reveal's secret. The reveal locks in a moment from now: anyone can press the button (gas only); every DEGEN's look then shows, for everyone at once.",
      2: "Ready: anyone can lock the reveal in now (gas only). Every DEGEN's look is fixed then and shows for everyone at once; nobody, the owner included, can change it.",
      3: "The reveal's window is closing or closed. As the owner you can pick a new block once it has closed (in public, at most three times in all; until then the panel tries to lock it in), and the panel then locks it in at once.",
    }[st];
    return `<p class="note">${note}</p><button class="btn gold wide" data-act="seal" ${!acct || busy ? "disabled" : ""}>${label}</button>${statusAt("seal")}`;
  }

  /// Each DEGEN you hold: its rarity, level and boost, and what the next level costs and adds (CrafterLevels).
  function levelsList(M, s) {
    const lv = M.levels;
    if (!lv) return "";
    const rows = M.mine.map((m) => {
      const r = m.traits ? rarityOf(m.traits) : null, level = m.level;
      const next = level !== null && level < lv.max ? level + 1 : null;
      const cost = next ? lv.costs[level - 1] : null;
      const now = r === null ? null : itemBoost("crafter", r, level ?? 1);
      const then = r === null || !next ? null : itemBoost("crafter", r, next);
      const short = cost !== null && s.mine !== undefined && s.mine < cost;
      return `<div class="crafter-row ${worn === m.id ? "on" : ""}">
        <img src="${pic(m.traits ? cardSvg(m.traits) : sealedSvg())}" alt="">
        <div class="cr-text">
          <b>#${m.id} · ${r === null ? "Sealed" : `<span class="tier t${r}">${RARITIES[r]}</span>`} · ${level === null ? "level ?" : `Level ${level} of ${lv.max}`}${worn === m.id ? " · worn" : ""}</b>
          <span class="boost">${now ? describe(now) : "Its boost shows once it's revealed"}</span>
          ${next ? `<span class="small muted">Level ${next}: ${mine(cost)} $MINE${then ? ` → ${describe(then)}` : ""}${short ? ` <span class="warn">(you have ${mine(s.mine)})</span>` : ""}</span>` : ""}
          ${statusAt(`crafter:${m.id}`)}
        </div>
        ${next ? `<button class="btn gold" data-act="levelup" data-id="${m.id}" ${busy ? "disabled" : ""}>Level up</button>`
          : level !== null ? `<span class="max-level">Max level</span>` : ""}
      </div>`;
    }).join("");
    const burn = lv.burnBps / 100;
    return `<h3>Levels</h3><div class="crafter-rows">${rows}</div>
      <p class="note">A level adds to the DEGEN's boost while you wear it, and stays with the DEGEN if it's sold. Paid in $MINE (approve
      exactly the cost, then pay): ${burn}% is burned for good and ${100 - burn}% goes to the project treasury.${chain.trade ? " Short of $MINE? The trade box is below." : ""}</p>`;
  }

  /// The Idle mining box (bots.js, docs/AUTOPILOT.md): your DEGENs but the one you wear (the deployed ones first, with
  /// their state), each with its cap a day and its rate an hour (its DEGEN's cap boost raises both), what it earned
  /// today of that cap, and Deploy or Recall; the pickaxes the old autopilot bots held that wait for room in your bag;
  /// and the rules (online only, BOT_MAX a day, the conversion limit per wallet).
  function idleBox(s, L) {
    const M = s?.crafters, B = game.bots;
    if (!M || !B || !chain.account) return "";
    const roster = B.list(), deployed = new Set(roster.map((r) => r.tok));
    const yours = new Map((M.mine ?? []).map((m) => [m.id, m]));
    const free = (M.mine ?? []).filter((m) => m.traits && m.id !== worn && !deployed.has(m.id));
    // One DEGEN (`r`: its roster entry if it's deployed): its cap is the room's once it has said, else worked out from
    // its rarity and level as the room does (boosts.js dailyCap with its own cap boost, on the home planet).
    const row = (tok, r) => {
      const m = yours.get(tok);
      const tier = r?.tier ?? (m?.traits ? rarityOf(m.traits) : null), level = r?.level ?? m?.level ?? null;
      const cap = r?.cap ?? (tier === null ? null : dailyCap(itemBoost("crafter", tier, level ?? 1).cap, "home"));
      const today = B.today(tok)[0], why = r ? null : B.cannot(tok);
      const pct = cap ? Math.min(100, (today / cap) * 100) : 0;
      return `<div class="bot-row ${r?.live ? "out" : ""}">
        <img src="${pic(m?.traits ? cardSvg(m.traits) : sealedSvg())}" alt="">
        <div class="cr-text">
          <b>#${tok}${tier === null ? "" : ` · <span class="tier t${tier}">${RARITIES[tier]}</span>`}${level === null ? "" : ` · Level ${level}`}</b>
          ${cap === null ? "" : `<span class="boost">${fmtMine(cap)} $MINE a day · ${fmtMine(Math.round(idleRate(cap) * 3_600_000))} an hour</span>`}
          ${r ? `<span class="state">${esc(r.state)}</span>` : ""}
          <span class="small">Today ${fmtMine(today)}${cap === null ? "" : ` / ${fmtMine(cap)}`} $MINE</span>
          <div class="bot-cap"><i style="width:${pct}%"></i></div>
        </div>
        ${r ? `<button class="btn" data-act="botoff" data-id="${tok}">Recall</button>`
          : `<button class="btn gold" data-act="boton" data-id="${tok}" ${why ? `disabled title="${esc(why)}"` : ""}>Deploy</button>`}
        ${statusAt(`bot:${tok}`)}
      </div>`;
    };
    const rows = [...roster.map((r) => row(r.tok, r)), ...free.map((m) => row(m.id, null))].join("");
    const returned = B.returned(), live = roster.filter((r) => r.live).length;
    const waiting = returned.length ? `<h3>Pickaxes back from your bots</h3><p class="note">The autopilot bots held these before idle mining, and your bag
      was full when they came back: take them when there's room.</p>
      <div class="pick-list">${returned.map((p) => `<button class="pick-btn" data-act="bottake" data-i="${p.i}"><img src="${p.icon}" alt="">${esc(p.name)} · ${p.max - p.d}/${p.max} · Take back</button>`).join("")}</div>` : "";
    const why = !L.signedIn ? "Sign in to earn first: your DEGENs idle-mine for your signed-in wallet."
      : roster.length >= BOT_MAX ? `${BOT_MAX} DEGENs deployed: recall one to deploy another.` : B.cannot(null);
    return `<section class="box">
      <h3>Idle mining <span class="status ${live ? "open" : "closed"}">${live} / ${BOT_MAX} DEPLOYED</span></h3>
      <p class="note">You mine with the DEGEN you wear; deploy up to ${BOT_MAX} of your others to mine for you by time. While you're online, each earns
      its own daily cap (${DAILY_EARN_CAP.toLocaleString("en-US")} $MINE, more with its cap boost) spread over 24 hours, into your wallet's total. Nothing
      walks, digs or wears out.</p>
      ${rows ? `${why && free.length ? `<p class="note">${esc(why)}</p>` : ""}<div class="bot-rows">${rows}</div>`
        : `<p class="note">${(M.mine ?? []).length ? "Your other revealed DEGENs show here (not the one you wear)." : "Idle miners are your other I'M DEGENs: mint or buy one to deploy it."}</p>`}
      ${waiting}
      <p class="note">Online only: deployed DEGENs earn while your game is open, connected and signed in, on any planet, idle or in another tab.
      Logged off, the tab closed or the phone asleep, they earn nothing, and that time isn't made up later.</p>
      <p class="note">At most ${BOT_MAX} at once, and ${BOT_MAX} different DEGENs a day (UTC): swapping in fresh ones doesn't add caps. The DEGEN you wear
      (or wore while earning today) can't be deployed, and one that idle-mined today can't be worn until tomorrow.</p>
      ${s.walletCap !== undefined ? `<p class="note">Converting is limited to ${mine(s.walletCap)} $MINE a day per wallet: what you and your DEGENs earn
      above it waits for later days.</p>` : ""}
    </section>`;
  }

  /// Your boosts: the totals the world server last sent, what each slot adds, and the DEGENs' table.
  function boostsBox(L) {
    const b = L.boost ?? NO_BOOST;
    const lead = L.signedIn
      ? `Your boosts: <b>+${b.speed}% speed, +${b.earn}% $MINE, daily cap ${fmtMine(L.cap)}</b>${b.move ? ` <b>(+${b.move}% move)</b>` : ""}`
      : "Sign in to earn: then the NFTs you use boost your mining.";
    const rows = SLOT_KEYS.map((k) => {
      const src = b.sources.find((x) => x.slot === k);
      const val = src ? `<b class="on">${esc(src.label)}: ${describe(src)}</b>`
        : !issued(k) ? `<b class="soon">Coming soon</b>`
        : `<b class="soon">${k === "crafter" ? "None worn" : "None"}</b>`;
      return `<div class="kv"><span>${SLOTS[k].name}</span>${val}</div>`;
    }).join("");
    const cell = (x) => `+${x.speed}/${x.earn}/${x.cap}`;
    const levels = Object.keys(CRAFTER_LEVELS).map(Number).sort((p, q) => p - q);
    const table = `<table class="boost-table"><tr><th>Level</th>${TIERS.map((t) => `<th>${t}</th>`).join("")}</tr>
      ${levels.map((l) => `<tr><td>L${l}</td>${TIERS.map((t, r) => `<td>${cell(itemBoost("crafter", r, l))}</td>`).join("")}</tr>`).join("")}</table>`;
    return `<section class="box"><h3>Boosts</h3>
      <p class="boost-lead">${lead}</p>
      ${rows}
      <p class="note">One NFT a slot, and the slots add up. They only add to what you do: blocks break faster, every block, monster and boss share
      pays more, and your daily cap (${DAILY_EARN_CAP.toLocaleString("en-US")} $MINE) is higher. Nothing pays for holding. At most +${MAX.speed}%
      speed, +${MAX.earn}% $MINE and +${MAX.cap}% cap.</p>
      <details><summary class="note">DEGEN boosts (% speed / $MINE / daily cap): rarity and level add up</summary>${table}
      <p class="note">Each of your DEGENs shows its rarity and level below (I'M DEGEN, Levels); levels are bought there with $MINE, and stay
      with the DEGEN.</p></details>
    </section>`;
  }

  function economyBox() {
    return `<section class="box"><h3>How $MINE works</h3>
      <div class="kv"><span>Supply</span><b>21,000,000 $MINE in all (upgrades and the shop burn 75% of what they cost)</b></div>
      <div class="kv"><span>Liquidity</span><b>50% (10,500,000), locked forever in the $MINE/IMD pool</b></div>
      <div class="kv"><span>Mining vault</span><b>50% (10,500,000), minted only as players convert, at most ${VAULT_DAILY_LIMIT.toLocaleString("en-US")} a day</b></div>
      <div class="kv"><span>Trading fee</span><b>4% per trade</b></div>
      <p class="note">No yield farming: holding an NFT pays nothing. $MINE comes only from the world: what you mine yourself, and what your
      deployed DEGENs idle-mine while you're online (offline, nothing).</p></section>`;
  }

  function ratesBox() {
    const blocks = Object.entries(BLOCK_REWARDS).sort((a, b) => b[1] - a[1]).map(([id, v]) => `<div class="kv"><span>${esc(itemName(Number(id)))}</span><b>${v}</b></div>`).join("");
    const mobs = Object.entries(MOB_REWARDS).map(([k, v]) => `<div class="kv"><span>${esc(MOBS[k].name)}</span><b>${v}</b></div>`).join("");
    return `<section class="box"><h3>What earns $MINE</h3>
      <p class="note">Natural blocks only (blocks players placed pay nothing). Up to ${DAILY_EARN_CAP.toLocaleString("en-US")} $MINE a day for you,
      more with a cap boost (each DEGEN you deploy idle-mines up to its own cap). Deepvein pays ${ZONE_PAY.deep}x; NFT boosts add their % on top.</p>
      ${blocks}<h3>Monsters</h3>${mobs}
      <p class="note">Monsters come out at night, and underground at any time.</p></section>`;
  }

  return { open, close, refresh, get isOpen() { return !el.hidden; }, get worn() { return worn; }, render };
}
