// The on-chain side: log in with a browser wallet, open a mining site (ETH), convert earnings to $MINE with the
// room's voucher, mint and wear MineWorldCraft Miners, and trade $MINE. Uses web/chain.json from ./dev.sh when
// present, otherwise the mainnet deployment (web/deployments/robinhood.json). Without either, the game plays and the
// panel says the economy isn't live yet.

import {
  createPublicClient, createWalletClient, createTestClient, http, custom, defineChain, keccak256, encodeAbiParameters,
  parseSignature, decodeErrorResult, parseAbi, zeroAddress, BaseError, ContractFunctionRevertedError,
} from "https://esm.sh/viem@2";
import { pickWallet, wallets, lastWallet, rememberWallet } from "./wallet.js";

const ERROR_TEXT = {
  NoSite: "Open a mining site first: only wallets with one can convert.",
  AlreadyOpen: "This wallet already has a mining site.",
  WrongPayment: "The site price just changed. Check it and try again.",
  NothingToClaim: "Nothing to convert right now: you've converted everything earned so far, or today's limits are reached. Limits reset at 00:00 UTC.",
  IsPaused: "Converting is paused for now. Your earnings stay safe on the ledger.",
  Paused: "Converting is paused for now. Your earnings stay safe on the ledger.",
  Expired: "That voucher expired. Try again.",
  BadSignature: "The voucher didn't check out. Try again.",
  SaleClosed: "The Miners mint is closed.",
  SoldOut: "Sold out: every Miner has been minted.",
  BadQuantity: "Mint between 1 and 10 at a time.",
  NotRevealed: "Still sealed: the Miners are revealed after the mint.",
  Slippage: "The price moved past your slippage limit. Try again, or allow more slippage.",
  PartialFill: "The pool can't fill that much right now. Try a smaller amount.",
  DustSwap: "That amount is too small to trade.",
  BadAmount: "Enter an amount to trade.",
  ERC20InsufficientBalance: "Not enough tokens for that.",
  ERC2612ExpiredSignature: "The signature expired. Try again.",
  PriceLimitAlreadyExceeded: "The pool doesn't hold any IMD to pay for sells right now.",
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
  knownErrors = [...abis.mine, ...abis.sites, ...(abis.miners ?? []), ...(abis.hook ?? []), ...(abis.router ?? []), ...(abis.ethRouter ?? []), ...V4_ABI]
    .filter((i) => i.type === "error");
  const withErrors = (abi) => [...abi.filter((i) => i.type !== "error"), ...knownErrors];
  const C = {
    mine: { address: dep.contracts.mine, abi: withErrors(abis.mine) },
    sites: { address: dep.contracts.sites, abi: withErrors(abis.sites) },
    miners: dep.contracts.miners ? { address: dep.contracts.miners, abi: withErrors(abis.miners) } : null,
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

  async function send(c, fn, args = [], value) {
    // Simulated first, so a call that would fail says why (in the player's words) before the wallet is asked.
    const { request } = await pub.simulateContract({ ...c, functionName: fn, args, value, account });
    const hash = await wallet.writeContract({ ...request, chain });
    const receipt = await pub.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`${fn} failed`);
    return receipt;
  }

  const minerDesigns = new Map(); // token id -> design, once revealed
  async function snapshot() {
    const [sitePrice, paused, walletCap, dailyCap, paidToday, vault] = await Promise.all([
      read(C.sites, "sitePrice"), read(C.sites, "paused"), read(C.sites, "walletDailyCap"), read(C.sites, "dailyCap"),
      read(C.sites, "paidToday"), read(C.sites, "vaultBalance"),
    ]);
    const s = { account, accounts, local: !!dep.local, devAccounts: !browserWallet, explorer: dep.explorer, sitePrice, paused, walletCap, dailyCap, paidToday, vault, trading: !!T };
    if (C.miners) {
      const [price, saleOpen, minted, seed, max] = await Promise.all([
        read(C.miners, "price"), read(C.miners, "saleOpen"), read(C.miners, "totalMinted"), read(C.miners, "seed"), read(C.miners, "MAX_SUPPLY"),
      ]);
      s.miners = { price, saleOpen, minted: Number(minted), seed, max: Number(max), mine: [] };
    }
    if (!account) return s;
    const [eth, mine, siteAt, claimed, walletPaid, imd] = await Promise.all([
      pub.getBalance({ address: account }), read(C.mine, "balanceOf", [account]), read(C.sites, "siteOf", [account]),
      read(C.sites, "claimed", [account]), read(C.sites, "walletPaidToday", [account]), T ? read(T.imd, "balanceOf", [account]) : null,
    ]);
    Object.assign(s, { eth, mine, site: Number(siteAt), claimed, walletPaid, imd });
    if (C.miners) {
      const ids = (await read(C.miners, "tokensOfOwner", [account])).map(Number);
      const design = (id) => minerDesigns.get(id) ?? read(C.miners, "designOf", [BigInt(id)]).then((d) => (minerDesigns.set(id, Number(d)), Number(d)));
      const designs = s.miners.seed === 0n ? ids.map(() => null) : await Promise.all(ids.map(design));
      s.miners.mine = ids.map((id, i) => ({ id, design: designs[i] }));
    }
    return s;
  }

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
    addresses: { mine: C.mine.address, sites: C.sites.address, miners: C.miners?.address ?? null },
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
    claim: (v) => send(C.sites, "claim", [v.total, v.deadline, v.signature]),
    claimable: (total) => read(C.sites, "claimable", [account, total]),
    mintMiners: (n, price) => send(C.miners, "mint", [BigInt(n)], price * BigInt(n)),
    trade: T ? { quote, market, execute: trade } : null,
    /// Local chains only: Anvil gives the logged-in wallet some play ETH.
    async devFund() {
      if (!test || !account) return;
      const bal = await pub.getBalance({ address: account });
      await test.setBalance({ address: account, value: bal + 10n ** 19n });
    },
  };
}
