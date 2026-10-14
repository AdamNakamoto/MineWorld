// The on-chain side: log in with a browser wallet, open a mining site (ETH) and upgrade it ($MINE), convert earnings to
// $MINE with the room's voucher, mint MineWorld Crafters (and read their traits) and level them up ($MINE), pay the game
// in $MINE (the shop, rocket tickets: MinePayments), and trade $MINE. Every $MINE payment approves exactly what it
// pays, then pays (payMine). Uses web/chain.json from ./dev.sh when
// present, otherwise the mainnet deployment (web/deployments/robinhood.json). Without either, the game plays and the
// panel says the economy isn't live yet.

import {
  createPublicClient, createWalletClient, createTestClient, http, custom, defineChain, keccak256, encodeAbiParameters,
  parseSignature, decodeErrorResult, parseAbi, parseEventLogs, zeroAddress, bytesToHex, formatEther, BaseError,
  ContractFunctionRevertedError,
} from "https://esm.sh/viem@2";
import { pickWallet, wallets, lastWallet, rememberWallet } from "./wallet.js";
import { traitsOf } from "./crafters.js";

const ERROR_TEXT = {
  NoSite: "Open a mining site first: only wallets with one can convert.",
  AlreadyOpen: "This wallet already has a mining site.",
  WrongPayment: "The site price just changed. Check it and try again.",
  NothingToClaim: "Nothing to convert right now: you've converted everything earned so far, or today's limits are reached. Limits reset at 00:00 UTC.",
  IsPaused: "Converting is paused for now. Your earnings stay safe on the ledger.",
  Paused: "Converting is paused for now. Your earnings stay safe on the ledger.",
  Expired: "That voucher expired. Try again.",
  BadSignature: "The voucher didn't check out. Try again.",
  SaleClosed: "The Crafters mint is closed.",
  SoldOut: "Sold out: all 3,333 Crafters have been minted.",
  BadQuantity: "Mint between 1 and 5 at a time.",
  WalletLimit: "That's as many Crafters as one wallet can mint.",
  NotRevealed: "Still sealed: the Crafters are revealed after the mint.",
  Slippage: "The price moved past your slippage limit. Try again, or allow more slippage.",
  PartialFill: "The pool can't fill that much right now. Try a smaller amount.",
  DustSwap: "That amount is too small to trade.",
  BadAmount: "Enter an amount to trade.",
  ERC20InsufficientBalance: "Not enough tokens for that.",
  ERC2612ExpiredSignature: "The signature expired. Try again.",
  PriceLimitAlreadyExceeded: "The pool doesn't hold any IMD to pay for sells right now.",
  MaxLevel: "That's already the top level.",
  BadLevel: "There's no such level.",
  NotHolder: "Only the Crafter's holder can level it up.",
  NoSuchKind: "The game doesn't take that kind of payment.",
  ZeroAmount: "Nothing to pay.",
  ERC20InsufficientAllowance: "The price just changed, so the approval didn't cover it. Check the new price and try again.",
};

const V4_ABI = parseAbi([
  "error WrappedError(address target, bytes4 selector, bytes reason, bytes details)",
  "error PriceLimitAlreadyExceeded(uint160 sqrtPriceCurrentX96, uint160 sqrtPriceLimitX96)",
  "function extsload(bytes32 slot) view returns (bytes32)",
]);
const ERC20_ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address, address) view returns (uint256)",
  "function approve(address, uint256) returns (bool)",
]);
const FEED_ABI = parseAbi(["function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)"]);
const QUOTER_ABI = parseAbi([
  "struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }",
  "struct PathKey { address intermediateCurrency; uint24 fee; int24 tickSpacing; address hooks; bytes hookData; }",
  "function quoteExactInputSingle((PoolKey poolKey, bool zeroForOne, uint128 exactAmount, bytes hookData) params) returns (uint256 amountOut, uint256 gasEstimate)",
  "function quoteExactInput((address exactCurrency, PathKey[] path, uint128 exactAmount) params) returns (uint256 amountOut, uint256 gasEstimate)",
]);
let knownErrors = [];

function revertName(e) {
  if (!(e instanceof BaseError)) return null;
  const revert = e.walk((err) => err instanceof ContractFunctionRevertedError);
  let name = revert?.data?.errorName;
  if (name === "WrappedError") {
    try { name = decodeErrorResult({ abi: knownErrors, data: revert.data.args[2] }).errorName; } catch {}
  }
  return name ?? null;
}
export function explain(e) {
  if (e instanceof BaseError) {
    const name = revertName(e);
    if (name) return ERROR_TEXT[name] ?? name;
    if (/rejected|denied/i.test(e.shortMessage ?? "")) return "Rejected in the wallet.";
    return e.shortMessage ?? e.message;
  }
  return e?.message ?? String(e);
}

async function loadDeployment() {
  for (const url of ["./chain.json", "./deployments/robinhood.json"]) {
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (res.ok) return await res.json();
    } catch {}
  }
  return null;
}

export async function connectChain() {
  const dep = await loadDeployment();
  if (!dep?.contracts?.sites) return null;
  const chain = defineChain({
    id: dep.chainId, name: dep.chainName ?? "Local",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [dep.walletRpcUrl ?? dep.rpcUrl] } },
    blockExplorers: dep.explorer ? { default: { name: "Blockscout", url: dep.explorer } } : undefined,
    contracts: dep.contracts.multicall3 ? { multicall3: { address: dep.contracts.multicall3 } } : undefined,
  });
  const pub = createPublicClient({ chain, transport: http(dep.rpcUrl), pollingInterval: 500, batch: { multicall: !!dep.contracts.multicall3 } });
  const test = dep.local ? createTestClient({ chain, mode: "anvil", transport: http(dep.rpcUrl) }) : null;
  const abis = dep.abis;
  knownErrors = [...abis.mine, ...abis.sites, ...(abis.crafters ?? []), ...(abis.levels ?? []), ...(abis.payments ?? []),
    ...(abis.hook ?? []), ...(abis.router ?? []), ...(abis.ethRouter ?? []), ...V4_ABI]
    .filter((i) => i.type === "error");
  const withErrors = (abi) => [...abi.filter((i) => i.type !== "error"), ...knownErrors];
  const C = {
    mine: { address: dep.contracts.mine, abi: withErrors(abis.mine) },
    sites: { address: dep.contracts.sites, abi: withErrors(abis.sites) },
    crafters: dep.contracts.crafters ? { address: dep.contracts.crafters, abi: withErrors(abis.crafters) } : null,
    // CrafterLevels and MinePayments (proxies): Crafter upgrades, and the game's shop and tickets.
    levels: dep.contracts.levels && abis.levels ? { address: dep.contracts.levels, abi: withErrors(abis.levels) } : null,
    payments: dep.contracts.payments && abis.payments ? { address: dep.contracts.payments, abi: withErrors(abis.payments) } : null,
  };
  const T = dep.contracts.hook ? {
    hook: { address: dep.contracts.hook, abi: withErrors(abis.hook) },
    router: { address: dep.contracts.router, abi: withErrors(abis.router) },
    ethRouter: { address: dep.contracts.ethRouter, abi: withErrors(abis.ethRouter) },
    imd: { address: dep.contracts.imd, abi: withErrors(ERC20_ABI) },
    quoter: { address: dep.contracts.quoter, abi: QUOTER_ABI },
    pm: { address: dep.contracts.poolManager, abi: V4_ABI },
    ethUsd: { address: dep.contracts.ethUsd, abi: FEED_ABI },
  } : null;
  const read = (c, fn, args = []) => pub.readContract({ ...c, functionName: fn, args });
  const same = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

  // A browser wallet on mainnet (and with ./dev.sh --wallet); otherwise Anvil's unlocked accounts.
  const browserWallet = !dep.local || !!dep.wallet;
  let wallet = null, account = null, accounts = [], onAccount = null;
  if (dep.local) accounts = await pub.request({ method: "eth_accounts" });
  if (!browserWallet) {
    wallet = createWalletClient({ chain, transport: http(dep.rpcUrl) });
    let saved = null;
    try { saved = localStorage.getItem("mwc:account"); } catch {}
    account = accounts.includes(saved) ? saved : null;
  }

  async function useProvider(w) {
    const provider = w.provider;
    wallet = createWalletClient({ chain, transport: custom(provider) });
    [account] = await wallet.requestAddresses();
    if ((await wallet.getChainId()) !== chain.id) {
      try { await wallet.switchChain({ id: chain.id }); } catch {
        await wallet.addChain({ chain });
        await wallet.switchChain({ id: chain.id });
      }
    }
    rememberWallet(w.info.rdns);
    provider.on?.("accountsChanged", (a) => { account = a[0] ?? null; onAccount?.(account); });
    provider.on?.("chainChanged", () => location.reload());
  }

  async function send(c, fn, args = [], value, onHash) {
    // Simulated first, so a call that would fail says why (in the player's words) before the wallet is asked.
    const { request } = await pub.simulateContract({ ...c, functionName: fn, args, value, account });
    const hash = await wallet.writeContract({ ...request, chain });
    onHash?.(hash);
    const receipt = await pub.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`${fn} failed`);
    return receipt;
  }

  const hash = { keccak256, encodeAbiParameters };
  const crafterTraits = new Map(); // token id -> traits, once revealed (they never change)
  const has = (c, fn) => c.abi.some((i) => i.type === "function" && i.name === fn);
  async function snapshot() {
    const [sitePrice, paused, walletCap, dailyCap, paidToday, vault] = await Promise.all([
      read(C.sites, "sitePrice"), read(C.sites, "paused"), read(C.sites, "walletDailyCap"), read(C.sites, "dailyCap"),
      read(C.sites, "paidToday"), read(C.sites, "vaultBalance"),
    ]);
    const s = { account, accounts, local: !!dep.local, devAccounts: !browserWallet, explorer: dep.explorer, sitePrice, paused, walletCap, dailyCap, paidToday, vault, trading: !!T };
    if (C.crafters) {
      const K = C.crafters;
      const [price, saleOpen, minted, seed, max, limit] = await Promise.all([
        read(K, "price"), read(K, "saleOpen"), read(K, "totalMinted"), read(K, "seed"), read(K, "MAX_SUPPLY"),
        has(K, "walletLimit") ? read(K, "walletLimit") : null,
      ]);
      s.crafters = { price, saleOpen, minted: Number(minted), seed, max: Number(max), limit: limit === null ? null : Number(limit), mine: [] };
    }
    if (!account) return s;
    const [eth, mine, siteAt, claimed, walletPaid, imd] = await Promise.all([
      pub.getBalance({ address: account }), read(C.mine, "balanceOf", [account]), read(C.sites, "siteOf", [account]),
      read(C.sites, "claimed", [account]), read(C.sites, "walletPaidToday", [account]), T ? read(T.imd, "balanceOf", [account]) : null,
    ]);
    Object.assign(s, { eth, mine, site: Number(siteAt), claimed, walletPaid, imd });
    // A site converts its earnings at its level's rate (MiningSites: 50% at level 1 up to 100% at 5); `settled` is the
    // earnings converted so far (what a voucher's total is counted against). Read only where the contract has them.
    const S = C.sites;
    const [settled, siteLevel, rateBps] = await Promise.all([
      has(S, "settled") ? read(S, "settled", [account]) : null,
      has(S, "siteLevel") ? read(S, "siteLevel", [account]).then(Number) : null,
      has(S, "rateBps") ? read(S, "rateBps", [account]).then(Number) : null,
    ]);
    Object.assign(s, { settled, siteLevel, rateBps });
    // Upgrading the site: the next level, what it converts and costs, and the share of the cost burned (siteUp.next is
    // null at the top level).
    if (siteLevel && has(S, "maxLevel")) {
      const max = Number(await read(S, "maxLevel"));
      const next = siteLevel < max ? siteLevel + 1 : null;
      const [cost, nextRate, burnBps] = await Promise.all([
        next ? read(S, "upgradeCost", [BigInt(next)]) : null,
        next ? read(S, "levelRateBps", [BigInt(next)]).then(Number) : null,
        read(S, "upgradeBurnBps").then(Number),
      ]);
      s.siteUp = { max, next, cost, nextRate, burnBps };
    }
    if (C.crafters) {
      const ids = (await read(C.crafters, "tokensOfOwner", [account])).map(Number);
      const seed = s.crafters.seed;
      // Each Crafter's level (CrafterLevels; null if it can't be read), and the levels' costs: costs[i] reaches level
      // i + 2.
      const L = C.levels;
      const [levels, levelInfo] = await Promise.all([
        Promise.all(ids.map((id) => (L ? read(L, "levelOf", [BigInt(id)]).then(Number).catch(() => null) : null))),
        L ? Promise.all([read(L, "maxLevel").then(Number), read(L, "upgradeCosts"), read(L, "upgradeBurnBps").then(Number)]) : null,
      ]);
      if (levelInfo) s.crafters.levels = { max: levelInfo[0], costs: levelInfo[1], burnBps: levelInfo[2] };
      // Traits come from the revealed seed, worked out here exactly as the contract does (crafters.js).
      s.crafters.mine = ids.map((id, i) => {
        if (seed === 0n) return { id, traits: null, level: levels[i] };
        if (!crafterTraits.has(id)) crafterTraits.set(id, traitsOf(seed, id, hash));
        return { id, traits: crafterTraits.get(id), level: levels[i] };
      });
    }
    return s;
  }

  // ---------------------------------------------------------------- paying in $MINE
  const fmtMine = (wei) => Number(formatEther(wei)).toLocaleString("en-US", { maximumFractionDigits: 4 });
  /// Not enough $MINE for a payment: how much it costs, what the wallet has, and where to get more.
  function notEnough(need, have) {
    const e = new Error(`Not enough $MINE: this costs ${fmtMine(need)} and your wallet has ${fmtMine(have)}. ${T
      ? "Buy $MINE in the trade box (Mining Site panel, M)."
      : "Convert your earnings to $MINE first (Mining Site panel, M): this chain has no $MINE pool to buy from."}`);
    e.code = "NOT_ENOUGH_MINE";
    return e;
  }
  /// Pays `amount` $MINE to contract `c` (MiningSites, CrafterLevels or MinePayments, which take it from the wallet:
  /// part burned, the rest to the treasury) by calling `fn`: first approves exactly that much for it (unless that's
  /// the allowance already), never more. `step(text)` hears each stage; `onHash(hash)` gets the paying transaction as
  /// soon as it's sent. Resolves with its receipt.
  async function payMine(c, amount, fn, args, { step, onHash, what = "" } = {}) {
    if (!account) throw new Error("Log in with your wallet first.");
    const [have, allowance] = await Promise.all([read(C.mine, "balanceOf", [account]), read(C.mine, "allowance", [account, c.address])]);
    if (have < amount) throw notEnough(amount, have);
    const confirm = browserWallet ? ": confirm in your wallet" : "";
    if (allowance !== amount) {
      step?.(`Step 1 of 2: approving exactly ${fmtMine(amount)} $MINE${what}${confirm}…`);
      await send(C.mine, "approve", [c.address, amount]);
    }
    step?.(`Step 2 of 2: paying ${fmtMine(amount)} $MINE${what}${confirm}…`);
    return send(c, fn, args, undefined, onHash);
  }
  /// The Paid event in `receipt` that is exactly this wallet's payment of `amount` $MINE of `kind` under `ref`.
  function paidEvent(receipt, kind, amount, ref) {
    const evs = parseEventLogs({ abi: C.payments.abi, logs: receipt.logs, eventName: "Paid" });
    return evs.find((l) => same(l.address, C.payments.address) && same(l.args.player, account) && l.args.kind === BigInt(kind)
      && l.args.amount === amount && l.args.ref.toLowerCase() === ref.toLowerCase())?.args ?? null;
  }
  const event = (c, receipt, name) => {
    try { return parseEventLogs({ abi: c.abi, logs: receipt.logs, eventName: name })[0]?.args ?? null; } catch { return null; }
  };
  /// A fresh reference for a payment (MinePayments' `ref`): 32 random bytes.
  const newRef = () => bytesToHex(crypto.getRandomValues(new Uint8Array(32)));

  // ---------------------------------------------------------------- trading (as in Courier World)
  let poolKey = null, imdEthKey = null;
  async function keys() {
    poolKey ??= await read(T.hook, "poolKey", [C.mine.address]);
    imdEthKey ??= await read(T.ethRouter, "imdEthKey");
    return { pool: poolKey, imdEth: imdEthKey };
  }
  async function quote(side, asset, amountIn) {
    const k = await keys(), S = C.mine.address, I = T.imd.address;
    if (asset === "IMD") {
      const zeroForOne = same(k.pool.currency0, side === "buy" ? I : S);
      const [out] = await read(T.quoter, "quoteExactInputSingle", [{ poolKey: k.pool, zeroForOne, exactAmount: amountIn, hookData: "0x" }]);
      return out;
    }
    const hop = (to, key) => ({ intermediateCurrency: to, fee: key.fee, tickSpacing: key.tickSpacing, hooks: key.hooks, hookData: "0x" });
    const path = side === "buy" ? [hop(I, k.imdEth), hop(S, k.pool)] : [hop(I, k.pool), hop(zeroAddress, k.imdEth)];
    const [out] = await read(T.quoter, "quoteExactInput", [{ exactCurrency: side === "buy" ? zeroAddress : S, path, exactAmount: amountIn }]);
    return out;
  }
  async function imdUsd() {
    imdEthKey ??= await read(T.ethRouter, "imdEthKey");
    const k = imdEthKey;
    const id = keccak256(encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
      [k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks],
    ));
    const slot = keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [id, 6n]));
    const [slot0, round] = await Promise.all([read(T.pm, "extsload", [slot]), read(T.ethUsd, "latestRoundData")]);
    const sqrtP = Number(BigInt(slot0) & ((1n << 160n) - 1n)) / 2 ** 96;
    return Number(round[1]) / 1e8 / (sqrtP * sqrtP);
  }
  async function market() {
    const [price, usd] = await Promise.all([read(T.hook, "price", [C.mine.address]), imdUsd()]);
    const tokenImd = Number(price) / 1e18;
    return { tokenImd, imdUsd: usd, tokenUsd: tokenImd * usd };
  }
  async function signPermit(spender, value, deadline) {
    const [nonce, domain] = await Promise.all([read(C.mine, "nonces", [account]), read(C.mine, "eip712Domain")]);
    const signature = await wallet.signTypedData({
      account,
      domain: { name: domain[1], version: domain[2], chainId: Number(domain[3]), verifyingContract: domain[4] },
      types: { Permit: [
        { name: "owner", type: "address" }, { name: "spender", type: "address" }, { name: "value", type: "uint256" },
        { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" },
      ] },
      primaryType: "Permit",
      message: { owner: account, spender, value, nonce, deadline },
    });
    const { r, s, v, yParity } = parseSignature(signature);
    return { r, s, v: Number(v ?? BigInt(yParity + 27)) };
  }
  const rejected = (e) => e?.code === 4001 || /reject|denied/i.test(e?.shortMessage ?? e?.message ?? "");
  async function trade({ side, asset, amountIn, minOut }) {
    const S = C.mine.address;
    const deadline = (await pub.getBlock()).timestamp + 600n;
    if (side === "buy" && asset === "ETH") return send(T.ethRouter, "buyWithEth", [S, minOut, deadline], amountIn);
    if (side === "buy") {
      if ((await read(T.imd, "allowance", [account, T.router.address])) < amountIn) await send(T.imd, "approve", [T.router.address, amountIn]);
      return send(T.router, "buy", [S, amountIn, minOut, deadline]);
    }
    const [r, plain, withPermit] = asset === "ETH" ? [T.ethRouter, "sellForEth", "sellForEthWithPermit"] : [T.router, "sell", "sellWithPermit"];
    if ((await read(C.mine, "allowance", [account, r.address])) >= amountIn) return send(r, plain, [S, amountIn, minOut, deadline]);
    let sig = null;
    try { sig = await signPermit(r.address, amountIn, deadline); } catch (e) { if (rejected(e)) throw e; }
    if (sig) return send(r, withPermit, [S, amountIn, minOut, deadline, sig.v, sig.r, sig.s]);
    await send(C.mine, "approve", [r.address, amountIn]);
    return send(r, plain, [S, amountIn, minOut, deadline]);
  }

  return {
    local: !!dep.local,
    browserWallet,
    chainName: dep.chainName,
    explorer: dep.explorer,
    addresses: { mine: C.mine.address, sites: C.sites.address, crafters: C.crafters?.address ?? null, levels: C.levels?.address ?? null, payments: C.payments?.address ?? null },
    /// Whether this chain has CrafterLevels (Crafter upgrades) and MinePayments (the shop and tickets).
    hasLevels: !!C.levels,
    hasPayments: !!C.payments,
    get account() { return account; },
    set onAccount(f) { onAccount = f; },
    snapshot,
    /// Log in: the wallet picker on mainnet, or pick one of Anvil's accounts on a dev chain.
    async login(devAccount) {
      if (!browserWallet) {
        account = devAccount ?? accounts[2];
        try { localStorage.setItem("mwc:account", account); } catch {}
        onAccount?.(account);
        return account;
      }
      const w = await pickWallet();
      if (!w) return null;
      await useProvider(w);
      onAccount?.(account);
      return account;
    },
    /// Log back in quietly with the wallet used last time, if it's still connected.
    async reconnect() {
      if (!browserWallet) { if (account) onAccount?.(account); return account; }
      const last = lastWallet();
      const w = wallets().find((x) => x.info.rdns === last);
      if (!w) return null;
      const got = await w.provider.request({ method: "eth_accounts" }).catch(() => []);
      if (!got?.length) return null;
      await useProvider(w);
      onAccount?.(account);
      return account;
    },
    logout() { account = null; rememberWallet(null); try { localStorage.removeItem("mwc:account"); } catch {} onAccount?.(null); },
    signMessage: (message) => wallet.signMessage({ account, message }),
    openSite: (price) => send(C.sites, "openSite", [], price),
    /// Convert with the room's voucher: what the claim did, from its Claimed event ({ amount, earnings, rateBps,
    /// totalClaimed, totalSettled }; amount is the $MINE paid, earnings what it converted), or null if there's none.
    async claim(v) {
      const receipt = await send(C.sites, "claim", [v.total, v.deadline, v.signature]);
      try {
        const [ev] = parseEventLogs({ abi: C.sites.abi, logs: receipt.logs, eventName: "Claimed" });
        return ev?.args ?? null;
      } catch {
        return null; // (an ABI without the event: the claim still went through)
      }
    },
    claimable: (total) => read(C.sites, "claimable", [account, total]),
    mintCrafters: (n, price) => send(C.crafters, "mint", [BigInt(n)], price * BigInt(n)),
    /// The logged-in wallet's $MINE (wei), or null when logged out.
    mineBalance: () => (account ? read(C.mine, "balanceOf", [account]) : Promise.resolve(null)),
    /// Raise your mining site one level for `cost` $MINE (MiningSites.upgradeCost of the next level, as shown):
    /// approve exactly that, then upgradeSite. Resolves with the new level.
    async upgradeSite(cost, opts = {}) {
      const receipt = await payMine(C.sites, cost, "upgradeSite", [], { ...opts, what: " for the upgrade" });
      return Number(event(C.sites, receipt, "SiteUpgraded")?.level ?? 0) || null;
    },
    /// Raise Crafter `id` one level for `cost` $MINE (CrafterLevels.upgradeCost of its next level, as shown): approve
    /// exactly that, then upgrade(id). Resolves with its new level.
    async levelUp(id, cost, opts = {}) {
      if (!C.levels) throw new Error("Crafter levels aren't on this chain yet.");
      const receipt = await payMine(C.levels, cost, "upgrade", [BigInt(id)], { ...opts, what: ` for Crafter #${id}` });
      return Number(event(C.levels, receipt, "CrafterUpgraded")?.level ?? 0) || null;
    },
    newRef,
    /// Pay the game `amount` $MINE (wei) of `kind` (MinePayments: 0 the shop, 1 a rocket ticket) under reference
    /// `opts.ref` (a fresh one if none): approve exactly that, then pay. Resolves once the receipt shows exactly that
    /// payment: { hash, ref, paid } (paid: the Paid event's args).
    async pay(kind, amount, opts = {}) {
      if (!C.payments) throw new Error("Paying in $MINE isn't open on this chain yet.");
      const ref = opts.ref ?? newRef();
      const receipt = await payMine(C.payments, amount, "pay", [BigInt(kind), amount, ref], opts);
      const paid = paidEvent(receipt, kind, amount, ref);
      if (!paid) throw new Error(`That transaction went through but shows no matching payment (${receipt.transactionHash}).`);
      return { hash: receipt.transactionHash, ref, paid };
    },
    /// Whether transaction `hash` was this wallet's payment of `amount` $MINE of `kind` under `ref`: true; false (it
    /// wasn't, or it failed); null (no receipt yet, or the chain couldn't be read).
    async paidIn(hash, kind, amount, ref) {
      if (!C.payments) return null;
      const receipt = await pub.getTransactionReceipt({ hash }).catch(() => null);
      if (!receipt) return null;
      return receipt.status === "success" && !!paidEvent(receipt, kind, amount, ref);
    },
    /// The share of a payment of `kind` that is burned, in basis points (MinePayments.kind), or null.
    async kindBurn(kind) {
      if (!C.payments) return null;
      const [, bps] = await read(C.payments, "kind", [BigInt(kind)]);
      return Number(bps);
    },
    trade: T ? { quote, market, execute: trade } : null,
    /// Local chains only: Anvil gives the logged-in wallet some play ETH.
    async devFund() {
      if (!test || !account) return;
      const bal = await pub.getBalance({ address: account });
      await test.setBalance({ address: account, value: bal + 10n ** 19n });
    },
  };
}
