// Trade $MINE in the Mining Site panel (from Courier World's trade box): buy or sell with ETH (routed through the
// IMD/ETH pool) or with IMD directly. Quotes come from Uniswap's v4 quoter and include the 4% fee. This section
// lives in its own element so the panel's redraws never reset the input.
import { formatEther, parseEther } from "https://esm.sh/viem@2";

const GAS_RESERVE = parseEther("0.0005"); // ETH kept back by "Max" for transaction fees
const sig = new Intl.NumberFormat(undefined, { maximumSignificantDigits: 3 });
const usd = new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const amount = (wei) => {
  const n = Number(formatEther(wei));
  return n >= 1000 ? n.toLocaleString(undefined, { maximumFractionDigits: 0 })
    : n >= 1 ? n.toLocaleString(undefined, { maximumFractionDigits: 4 }) : sig.format(n);
};

export function createTrade(chain, el, { run, isBusy, onLogin }) {
  const T = {
    symbol: "$MINE", supply: 21_000_000, balance: (s) => s.mine, // (all there will ever be: the market cap is over this)
    quote: chain.trade.quote, market: chain.trade.market, execute: chain.trade.execute,
    note: "Every trade pays 4% of its IMD side to the MineWorldCraft wallet. The pool started with $MINE only (10.5M, half the supply, locked forever), so sells fill once buyers have brought IMD in.",
  };
  let side = "buy", asset = "ETH", slipBps = 100, text = "";
  let snap = null, market = null, marketAt = 0;
  let q = null; // { key, out, impact } or { key, error }
  let seq = 0, timer = 0;

  el.hidden = false;
  el.innerHTML = `<h3>Trade ${T.symbol} <span class="muted">4% fee per trade</span></h3>
    <div class="seg" role="group" aria-label="Buy or sell">
      <button data-side="buy">Buy</button><button data-side="sell">Sell</button></div>
    <div class="seg small" role="group" aria-label="Currency"><span class="muted" data-r="withLabel"></span>
      <button data-asset="ETH">ETH</button><button data-asset="IMD">IMD</button></div>
    <label class="field"><span class="row"><span data-r="payLabel"></span>
      <button class="link-btn" data-act="max">Balance <span data-r="bal"></span></button></span>
      <span class="amt"><input data-r="input" inputmode="decimal" autocomplete="off" placeholder="0.0" spellcheck="false">
      <span class="unit" data-r="unit"></span></span></label>
    <div class="kv"><span>You get</span><b data-r="out">—</b></div>
    <div class="kv"><span>At least</span><b data-r="min">—</b></div>
    <div class="kv"><span>Price impact</span><b data-r="impact">—</b></div>
    <div class="seg small" role="group" aria-label="Slippage"><span class="muted">Slippage</span>
      <button data-slip="50">0.5%</button><button data-slip="100">1%</button><button data-slip="300">3%</button></div>
    <button class="pbtn primary wide" data-r="go"></button>
    <p class="note" data-r="price"></p>
    <p class="note" data-r="note"></p>`;
  const r = Object.fromEntries([...el.querySelectorAll("[data-r]")].map((n) => [n.dataset.r, n]));
  r.note.textContent = T.note;

  const parse = () => {
    if (!/^\d*\.?\d*$/.test(text) || !/\d/.test(text)) return 0n;
    try { return parseEther(text); } catch { return 0n; }
  };
  const balance = () => {
    if (!snap?.account) return null;
    return side === "sell" ? T.balance(snap) ?? null : asset === "ETH" ? snap.eth : snap.imd;
  };
  const inUnit = () => (side === "buy" ? asset : T.symbol);
  const outUnit = () => (side === "buy" ? T.symbol : asset);
  const key = (amt) => `${side}:${asset}:${amt}`;

  async function requote() {
    const amt = parse(), k = key(amt), mine = ++seq;
    if (amt === 0n) { q = null; return render(); }
    try {
      // A tiny trade gives the current rate, so the gap to this one is its price impact (fees cancel out).
      const tiny = amt / 1000n > 0n ? amt / 1000n : amt;
      const [out, ref] = await Promise.all([T.quote(side, asset, amt), T.quote(side, asset, tiny)]);
      if (mine !== seq) return;
      const rate = Number(out) / Number(amt), refRate = Number(ref) / Number(tiny);
      q = { key: k, out, impact: refRate > 0 ? Math.max(0, 1 - rate / refRate) : 0 };
    } catch (e) {
      if (mine !== seq) return;
      console.warn("quote failed", e);
      q = { key: k, error: side === "sell" ? "The pool doesn't hold enough IMD for this sell." : "No quote for this amount." };
    }
    render();
  }
  function schedule(delay = 250) {
    clearTimeout(timer);
    timer = setTimeout(requote, delay);
  }

  function render() {
    const amt = parse(), bal = balance(), busy = isBusy();
    const fresh = q && q.key === key(amt);
    for (const b of el.querySelectorAll("[data-side]")) b.classList.toggle("on", b.dataset.side === side);
    for (const b of el.querySelectorAll("[data-asset]")) b.classList.toggle("on", b.dataset.asset === asset);
    for (const b of el.querySelectorAll("[data-slip]")) b.classList.toggle("on", Number(b.dataset.slip) === slipBps);
    r.withLabel.textContent = side === "buy" ? "Pay with" : "Receive";
    r.payLabel.textContent = side === "buy" ? "You pay" : "You sell";
    r.unit.textContent = inUnit();
    r.bal.textContent = bal === null ? "—" : `${amount(bal)} ${inUnit()}`;

    const minOut = fresh && !q.error ? (q.out * BigInt(10_000 - slipBps)) / 10_000n : 0n;
    r.out.textContent = !amt ? "—" : !fresh ? "…" : q.error ? q.error : `${amount(q.out)} ${outUnit()}`;
    r.out.classList.toggle("warn", !!(fresh && q.error));
    r.min.textContent = fresh && !q.error ? `${amount(minOut)} ${outUnit()}` : "—";
    r.impact.textContent = fresh && !q.error ? `${(q.impact * 100).toFixed(q.impact < 0.01 ? 2 : 1)}%` : "—";
    r.impact.classList.toggle("warn", !!(fresh && q.impact > 0.05));

    let label = side === "buy" ? `Buy ${T.symbol}` : `Sell ${T.symbol}`, ok = fresh && !q.error && minOut > 0n && !busy;
    if (!snap?.account) { label = "Log in to trade"; ok = !busy; }
    else if (amt > 0n && bal !== null && amt > bal) { label = `Not enough ${inUnit()}`; ok = false; }
    r.go.textContent = label;
    r.go.disabled = !ok;
    r.go.dataset.min = String(minOut);

    if (market) {
      const p = `1 ${T.symbol} = ${sig.format(market.tokenImd)} IMD`;
      r.price.textContent = Number.isFinite(market.tokenUsd)
        ? `${p} ≈ $${sig.format(market.tokenUsd)} · market cap ≈ ${usd.format(market.tokenUsd * T.supply)}`
        : p;
    }
  }

  el.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b || b.disabled) return;
    if (b.dataset.side || b.dataset.asset) {
      side = b.dataset.side ?? side;
      asset = b.dataset.asset ?? asset;
      q = null;
      render();
      return schedule(0);
    }
    if (b.dataset.slip) { slipBps = Number(b.dataset.slip); return render(); }
    if (b.dataset.act === "max") {
      const bal = balance();
      if (bal === null) return;
      const max = side === "buy" && asset === "ETH" ? (bal > GAS_RESERVE ? bal - GAS_RESERVE : 0n) : bal;
      text = max ? formatEther(max) : "";
      r.input.value = text;
      render();
      return schedule(0);
    }
    if (b === r.go) {
      if (!snap?.account) return onLogin();
      const amt = parse(), minOut = BigInt(b.dataset.min), s0 = side, a0 = asset;
      const what = s0 === "buy" ? `Buying ${T.symbol} with ${amount(amt)} ${a0}` : `Selling ${amount(amt)} ${T.symbol} for ${a0}`;
      return run(what, async () => {
        await T.execute({ side: s0, asset: a0, amountIn: amt, minOut });
        text = "";
        r.input.value = "";
        q = null;
      });
    }
  });
  r.input.addEventListener("input", () => {
    text = r.input.value.trim().replace(",", ".");
    render();
    schedule();
  });

  return {
    /// Called with every chain snapshot while the panel is open.
    update(s) {
      snap = s;
      const now = Date.now();
      if (now - marketAt > 10_000) {
        marketAt = now;
        T.market().then((m) => { market = m; render(); }).catch((e) => console.warn("price failed", e));
        if (parse() > 0n && !isBusy()) schedule(0); // prices move: refresh the quote too
      }
      render();
    },
  };
}
