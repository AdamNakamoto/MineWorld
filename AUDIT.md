# Audit brief

What MineWorldCraft's contracts do, what they must guarantee, and where reviewers should look hardest. Everything
referenced is in https://github.com/AdamNakamoto/MineWorld at the commit that adds section 8. IMD Swarm audited the
contracts at `ba2a8ed` (job 0792975e); section 8 lists its eight findings, how each is fixed and the tests that cover
it, and the sections before it describe the contracts as fixed. Nothing is deployed yet: every contract in
`contracts/src` is audited before anything goes to Robinhood Chain. The deploy settings are in `contracts/launch.env`.

Several contracts reuse Courier World's code (github.com/AdamNakamoto/courierworld), which IMD Swarm audited in
ea514609, ca28d248, 19b34b9b and 25e6a0b3 and which is live on Robinhood Chain. Section 2 says exactly what is reused
and what differs.

## 1. The system

MineWorldCraft is a block-mining game in the browser on **Robinhood Chain** (chain ID 4663, an Arbitrum Orbit L2).
Players earn **$MINE** for what they do in the game. $MINE trades in one **Uniswap v4** pool against **IMD**
(`0x5F7Bb59365ce557C26dbcAa4EE9d39A4b95B7127`).

- **$MINE** (`MineToken`, name "MineWorldCraft", symbol MINE): ERC-20 + EIP-2612 + burn, hard cap 21,000,000
  counting every mint (burns are permanent). 10,500,000 is minted to `MineHook` in the constructor and locked in the
  pool at launch. The rest, at most 10,500,000, is minted only by `MineVault`, the token's one minter (`setMinter` is
  one-shot). The launch renounces the token's ownership right after setting the minter. No transfer tax, blocklist,
  pause, proxy or upgrade. It is Courier's `StampToken` under another name.
- **The pool** (`MineHook`, `MineRouter`, `MineEthRouter`): Courier's `StampHook` and routers. The hook opens one
  $MINE/IMD pool, once, adds the 10.5M as single-sided liquidity that it owns and has no way to remove, and takes 4%
  of the IMD side of every swap for the fee recipient. The launch renounces the hook right after opening the pool;
  after the renounce only the current fee recipient can move the fees; nobody else can.
- **The mining vault** (`MineVault`, not upgradeable): mints $MINE straight to players when its distributor
  (`MiningSites`) asks, never more than 35,000 in a UTC day and 10,500,000 in all, whoever the distributor is.
  35,000 × 300 = 10,500,000, so the vault can't be emptied in under 300 days. The owner can replace the distributor
  only in the open: propose, wait two days, accept; and only with a contract whose `owner()` is the vault's owner, so
  an uninitialised or hijacked proxy can never take over.
- **Earning and converting** (`MiningSites`, UUPS proxy): the game's server (a Cloudflare Worker, out of scope) keeps
  a ledger of what each signed-in wallet earns and signs an EIP-712 voucher `Earnings(player, total, deadline)` for
  the wallet's **lifetime** earnings. To convert, a wallet opens a mining site once, for ETH (0.005 at launch, sent
  straight to the treasury). `claim` converts what the wallet hasn't converted yet (`total − settled`) at its site
  level's rate (50%, 60%, 70%, 85% and 100% for levels 1 to 5), within a daily cap per wallet (1,500 $MINE at launch,
  at most 3,500), a daily cap across everyone (35,000 at launch, at most the vault's daily limit) and what the vault
  can still mint today. The vault mints to the player. The share a rate doesn't convert is never minted.
- **Spending $MINE:** site upgrades (`MiningSites.upgradeSite`), Crafter levels (`CrafterLevels.upgrade`) and the
  game's shop (`MinePayments.pay`, kind 0) burn 75% of the payment and send 25% to the treasury; rocket tickets
  (kind 1) burn nothing and send it all to the treasury. Every payment is taken straight from the player's wallet
  with an exact approval: no contract holds anyone's $MINE, and payments never touch the vault. Upgrades also name the
  most they'll pay (`maxCost`), so a cost raised meanwhile reverts them whatever the allowance.
- **The upgradeable contracts** (`MiningSites`, `MinePayments`, `CrafterLevels`): UUPS proxies (ERC-1967) on a shared
  base (`lib/OwnedUUPS.sol`, `MinePayer`, `UpgradeCosts`), with all state in ERC-7201 namespaced storage. They are
  owned by `0x6e85Dc9f094b7DD35a2A981AbBd0AC9C496670eD`: ownership moves in two steps and can't be renounced; only the
  owner changes their settings (within the bounds below) and upgrades their code. The owner may hand them to a
  multisig or a timelock later. The same wallet owns the vault and the Crafters, and is the treasury and the fee
  recipient.
- **Crafters** (`MineWorldCrafters`, pictures by `CrafterArt`): 3,333 pixel-art NFTs drawn and stored entirely on
  chain. Blind mint (free at launch, 5 per transaction, 10 per wallet), then commit-reveal: `seedCommit` is fixed at
  deploy; closing the sale fixes the reveal block (the block it closes in); once that block is over anyone can
  `seal()` its hash, and `reveal(secret)` mixes the secret with that sealed hash, so when the owner reveals changes
  nothing. A keyed shuffle gives every token a different hair/outfit/eyes/gaze combination; background, skin, hat and
  blush are weighted picks. ERC-2981 royalty fixed at 5% to the treasury, enforced with ERC721-C (OpenSea's registry
  `0xA000027A9B2802E1ddf7000061001e5c005A0000` at launch; the owner picks the validator, and so can relax
  enforcement). `CrafterLevels` keeps each Crafter's level, which the collection shows as a "Level" trait through its
  attributes extension (called with a fixed gas stipend, so it can't break the metadata).

The launch (`contracts/script/deploy-mainnet.sh`) has two stages, from one wallet:

1. `crafters` (`DeployCrafters.s.sol`): `CrafterArt`, then `MineWorldCrafters` with the sale closed, owned by
   `OWNER`. The mint runs; the owner reveals afterwards.
2. `launch` (`Deploy.s.sol`, `run()`): `MineHook` at a mined CREATE2 address (its constructor deploys both routers);
   `MineToken` (10.5M to the hook); `MiningSites`' implementation; `MineVault`, naming as its distributor the address
   `MiningSites`' proxy is about to get (the deploying wallet's next contract); the proxy, initialized in its
   constructor; the token's `setMinter(vault)`, then its `renounceOwnership()`; `MinePayments` (implementation and
   proxy); `openPool`, then the hook's `renounceOwnership()`. With `CRAFTERS` set, `CrafterLevels` too (or later, as
   the `levels` stage), and `setAttributesExtension(levels)` on the Crafters if the deploying wallet owns them
   (otherwise the script prints the call for `OWNER`).

After the launch, `MineToken` and `MineHook` have no owner. `MineVault`, the three proxies and `MineWorldCrafters` are
owned by `0x6e85…70eD`.

**How the game uses each contract** (`web/` and `multiplayer/`, out of scope):

| Contract | Used for |
| --- | --- |
| `MineToken` | Balances; an exact approval before each payment; trading in the Mining Site panel |
| `MineHook`, `MineRouter`, `MineEthRouter` | The panel's trade box: buy and sell with IMD or ETH; price and market cap |
| `MiningSites` | Open a site, upgrade it (`upgradeSite(cost shown)`), convert earnings with the server's voucher; the panel reads rates, caps, `claimable` |
| `MineVault` | Only through `MiningSites`; the panel shows `vaultBalance()` |
| `MinePayments` | The Smithy's shop (kind 0: the browser checks its own `Paid` event and adds the items to an inventory kept in the browser) and rocket tickets (kind 1: the server checks the `Paid` event) |
| `MineWorldCrafters` | Mint; the panel's "Lock in the reveal" button calls `seal()` when `revealStatus()` says it can; the Crafter a player wears is how their miner looks; the server reads `ownerOf` and `seed()` (rarity worked out off chain by `web/crafters.js`) |
| `CrafterLevels` | "Level up" in the panel (`upgrade(id, cost shown)`); the server reads `levelOf` |
| `CrafterArt` | Only through the collection's `tokenURI` (marketplaces) |

A Crafter's rarity and level boost what its holder earns on the server (faster breaking, more per block, a higher
daily earn cap). On chain they change nothing: every payout still goes through `MiningSites`' caps and the vault's
limits.

## 2. Scope

Repository https://github.com/AdamNakamoto/MineWorld, at the commit that adds section 8 (IMD Swarm's 0792975e ran on
`ba2a8ed`; section 8 lists what changed since). Solidity 0.8.26, via-IR, optimizer 200
runs, EVM `cancun` (transient storage: `MineHook`'s fee slot and OpenZeppelin's `ReentrancyGuardTransient`). Libraries
are the same commits Courier World uses: OpenZeppelin Contracts 5.4.0, Uniswap v4-core `46c6834`, forge-std 1.17.0.

Lines: all lines / code lines (neither blank nor comment). 3,383 / 2,356 in all (3,184 / 2,262 at `ba2a8ed`).

| File | Lines | Origin | Role |
| --- | --- | --- | --- |
| `contracts/src/MineToken.sol` | 61 / 42 | Courier's `StampToken`, renamed | $MINE: 21M cap, one-shot minter, renounced at launch |
| `contracts/src/MineVault.sol` | 192 / 103 | New | The one minter: 35,000 a day, 10.5M in all, distributor change after 2 days, only to a contract its owner owns |
| `contracts/src/MiningSites.sol` | 517 / 330 | New (voucher check in the style of Courier's `TokenDrops`) | UUPS: sites, levels, rates, vouchers, caps, claims |
| `contracts/src/MinePayments.sol` | 114 / 72 | New | UUPS: shop and ticket payments, burn share per kind |
| `contracts/src/CrafterLevels.sol` | 124 / 72 | New | UUPS: each Crafter's level, bought in $MINE; the "Level" trait |
| `contracts/src/MinePayer.sol` | 93 / 56 | New | Shared base: take a payment (burn share burned, rest to the treasury), treasury |
| `contracts/src/UpgradeCosts.sol` | 140 / 84 | New | Shared base: level costs, burn share, adding levels, `maxCost` |
| `contracts/src/lib/OwnedUUPS.sol` | 79 / 50 | New (OpenZeppelin's `Ownable2Step` logic in ERC-7201 storage) | Shared base: two-step ownership, no renounce, owner-only upgrades |
| `contracts/src/ICrafterAttributes.sol` | 17 / 7 | New | Interfaces between the Crafters and their attributes extension |
| `contracts/src/MineWorldCrafters.sol` | 608 / 398 | New, built on Courier's `CourierSkins` (see below) | The NFT: mint, commit-reveal sealed by anyone, traits, on-chain metadata, enforced royalty |
| `contracts/src/CrafterArt.sol` | 534 / 436 | New, generated (about 170 of its lines are the art and names as constants) | On-chain SVG pictures, trait names, rarity; no state |
| `contracts/src/lib/FastBase64.sol` | 50 / 40 | New (Solady's technique) | Base64 for `tokenURI` |
| `contracts/src/MineHook.sol` | 490 / 376 | Courier's `StampHook`, one bound changed | Pool owner and v4 hook: 4% fee, one-time `openPool`, locked liquidity |
| `contracts/src/MineRouter.sol` | 148 / 119 | Courier's `StampRouter`, renamed | Buy and sell with IMD, permit sells |
| `contracts/src/MineEthRouter.sol` | 183 / 145 | Courier's `StampEthRouter`, renamed | Buy and sell with ETH through the IMD/ETH pool |
| `contracts/src/lib/SafeTransfer.sol` | 33 / 26 | Courier's, byte for byte | Transfer helpers for the hook and routers |

`CrafterArt.sol` is written by `tools/gen-crafter-art.mjs` from `web/crafters-art.js` and `web/crafters.js` (the game
draws Crafters with the same JS); it isn't edited by hand, and `test_ArtIsUpToDateWithTheJs` fails when it is stale.

### What is reused from Courier World, and what differs

Compared with Courier's `contracts/src` (the hook last changed in Courier's `96b8216`, after the three audits above;
it is the code live for $STAMP at `0xb07382187852485D485a171dd87b100BF4f1a8Cc`):

- **`MineToken` vs `StampToken`:** the contract name, `ERC20("MineWorldCraft", "MINE")`,
  `ERC20Permit("MineWorldCraft")` (so the permit domain's name) and NatSpec. Nothing else: the cap, the
  constructor's allocation, the one-shot `setMinter`, `mint` and `totalBurned` are unchanged.
- **`MineHook` vs `StampHook`:**
  1. The lowest start tick: a new constant `MIN_START_TICK = -300_000`, and the constructor rejects
     `startTick_ < MIN_START_TICK` where `StampHook` rejected `startTick_ < -MAX_START_TICK` (-400,000). The range is
     now CourierPad's (audited in 59db1445). Nothing else changed: top tick 400,000, tick spacing 200, `FEE_BPS` 400,
     LP fee 0, launch supply 1 to 21,000,000 tokens, the hook flags, `beforeSwap`/`afterSwap`, the full-fill check,
     `openPool` and its liquidity maths, fee collection, `setFeeRecipient`, two-step ownership and
     `renounceOwnership` (only after `openPool`).
  2. Renames: `IStampSupply` → `IMineSupply`; the constructor deploys `MineRouter`/`MineEthRouter` instead of
     `StampRouter`/`StampEthRouter`, with the same arguments.
  3. Comments (among them `renounceOwnership`'s, corrected after audit 0792975e #7: after the renounce only the
     current fee recipient can move the fees). The transient `FEE_SLOT` keeps `StampHook`'s value
     (`keccak256("Stamp.beforeSwapFee")`): transient storage is per contract, so the name doesn't matter.
- **`MineRouter` vs `StampRouter`:** `IStampPool` → `IMinePool`, the contract name and comments. `PermitHelper` is
  unchanged.
- **`MineEthRouter` vs `StampEthRouter`:** the imported names, the contract name and comments.
- **`lib/SafeTransfer.sol`:** identical.
- **`MineWorldCrafters` vs `CourierSkins`** (audited in 25e6a0b3): `_setValidator`, `_update` and `supportsInterface`
  are `CourierSkins`' line for line, and the ERC721-C interfaces are the same. New: the mint (price may be 0,
  per-wallet limit, 5 per transaction), the reveal (`reveal` and `setSaleOpen` no longer match `CourierSkins`': the
  entropy is the hash of the block the sale closed in, sealed by anyone with `seal`; audit 0792975e #1), the traits
  (`_shuffle` on 12 bits for 3,333, combination index, weighted picks), the on-chain pictures and metadata, the
  attributes extension (a bounded raw `staticcall`, audit 0792975e #3) and `refreshMetadata`, the collection links and
  pictures, the treasury checks (never this contract; must take ETH, audit 0792975e #4), and that ownership can't be
  renounced.

### Out of scope

The tests, the scripts, `script/DevTransferValidator.sol` (local chains only), `web/`, `multiplayer/` and `tools/`.

Two pieces of the server are trust assumptions the contracts rely on (read them; findings there are welcome, but the
contracts are what's audited):

- **Voucher signing** (`multiplayer/src/index.js`, `voucher`, line 1140): signs
  `Earnings(player, total, deadline)` with the key `MINING_KEY` for the domain ("MineWorldCraft Mining", "1",
  `CHAIN_ID`, `MINING_ADDRESS` = the `MiningSites` proxy). `player` is the signed-in wallet, `total` its lifetime
  ledger total in wei, `deadline` an hour ahead. The ledger is written before signing. What counts as earned (the
  server re-runs the world generator, checks reach and break rate, spawns monsters, caps each wallet at 300 a day
  times its boost and everyone at 35,000 a day) is the server's anti-cheat, out of scope.
- **The ticket check** (`multiplayer/src/index.js`, `buyTicket`, line 601): a rocket ticket counts only if the
  transaction succeeded, holds a `Paid` log from `PAYMENTS_ADDRESS` (the `MinePayments` proxy) whose player is the
  signed-in wallet, kind 1 and amount at least the zone's price, its block is at most 3 hours old, and the hash never
  bought a ticket before (`tixTx:<hash>`, kept for good).

**Deploy-script invariants worth a look** (`script/Deploy.s.sol`, `DeployCrafters.s.sol`, `DeployLib.sol`,
`deploy-mainnet.sh`):

1. **The predicted proxy address.** `MineVault` is constructed with
   `vm.computeCreateAddress(deployer, vm.getNonce(deployer) + 1)`, the address of the deploying wallet's next contract,
   which is `MiningSites`' proxy. The script requires the proxy landed there, and `MiningSites.initialize`
   independently requires that the vault names it (its distributor, or for a later replacement its pending
   distributor) and `vault.token() == token`, so a wrong prediction reverts instead of wiring another contract (the
   vault would then need a new distributor, two days later). A replacement works the same way round: propose its
   predicted address, then deploy it initialised (3.2); the scripts don't deploy one.
2. **The renounce order.** The token's `setMinter(vault)` comes before its `renounceOwnership()` (the other way round,
   $MINE could never be minted); the hook's `openPool` comes before its `renounceOwnership()` (the hook refuses
   earlier).
3. **The hook's CREATE2 address.** `DeployLib.mineSalt` finds a salt whose address has exactly `0x28CC` in its low 14
   bits (beforeInitialize, beforeAddLiquidity, beforeSwap, afterSwap, beforeSwapReturnDelta, afterSwapReturnDelta);
   the constructor checks the flags again (`Hooks.validateHookPermissions`). It deploys through forge-std's CREATE2
   deployer (`0x4e59b44847b379578588920cA78FbF26c0B4956C`). The owner (the deploying wallet) is part of the init code,
   so replaying the deployment can only create the same contract with the same owner.
4. **The start price.** `START_MCAP_USD` (5,000) for all 21M $MINE, converted to IMD from the IMD/ETH pool and
   Chainlink ETH/USD (a feed older than a day is refused), rounded down to the tick spacing and required within
   [-300,000, 400,000].
5. **End-state checks** in `_deployGame`/`_launch`: the token's owner is 0 and its minter the vault; 10.5M minted, all
   held by the hook before `openPool`; the vault and `MiningSites` point at each other; both proxies' ERC-1967
   implementation slots hold the implementations just deployed.
6. **Owners.** The vault and the proxies get `OWNER` in their constructor/initializer. The token and the hook belong
   to the deploying wallet only until they are renounced in the same run. The Crafters go to `OWNER` directly, or in
   two steps (`acceptOwnership`) if the deploying wallet sets them up first. Costs other than the defaults
   (`SITE_UPGRADE_COSTS`, `CRAFTER_UPGRADE_COSTS`) are set right after initialization only when the deploying wallet
   is `OWNER`.
7. **The reveal secret** never reaches the scripts: `deploy-mainnet.sh` passes only
   `SEED_COMMIT = keccak256(abi.encode(uint256 secret))`.
8. **OpenSea's registry needs nothing registered on chain.** A collection that never configured anything there gets
   the registry's default list (list 0), whose one authorizer is OpenSea's SignedZone (`getAuthorizerAccountsByCollection`
   on Robinhood Chain, and `test_Fork_EnforcedWithoutRegistering`). `DeployCrafters` prints the owner's launch steps:
   turn on creator earnings in OpenSea Studio, and how the reveal goes (close, anyone seals, reveal).

### Tests

`forge test` on this commit: **225 passed, 9 skipped, 234 in 17 suites** (the 9 are fork tests, which skip without a
Robinhood Chain fork; all 9 pass on one). At `ba2a8ed` it was 205 passed, 8 skipped.

| Suite | Tests | Covers |
| --- | --- | --- |
| `MineTokenTest` | 8 | Cap, one-shot minter, renounce, no other powers, untaxed transfers (fuzz), permit domain |
| `GameDeployTest` | 4 | `_deployGame`: wiring, renounce, defaults, costs from the environment, CrafterLevels |
| `MineVaultTest` | 11 | Daily and total limits, 300 days, distributor delay, cancel and replace, only a contract the owner owns takes over, sweep, no renounce |
| `MineVaultInvariantTest` | 2 invariants + 1 | Never above 35,000 a day across distributor changes; the books add up |
| `MiningSitesTest` | 51 | Sites, upgrades (`maxCost`), rates, vouchers, caps, rounding, pause, initializers, a treasury that must take ETH, a UUPS upgrade keeping everything |
| `DistributorRaceTest` | 4 | Audit 0792975e #2: the auditor's two proofs, a stranger's pending proxy never accepted, the safe replacement path end to end |
| `MiningSitesInvariantTest` | 5 invariants + 1 | Never pays more than signed or worth; daily caps; forged vouchers never pay; upgrades burn and pay the treasury; vault books |
| `MinePaymentsTest` | 9 | Split (fuzz), kinds, treasury (one without ETH is fine: $MINE only), owner-only, upgrade keeps kinds, initializers |
| `CrafterLevelsTest` | 18 | Holder-only upgrades, `maxCost` against an unlimited approval, levels stay with the token, costs and burn, extension, refresh, upgrade keeps levels |
| `MineWorldCraftersTest` | 43 | Mint rules, the reveal block, `seal` by anyone, expiry and re-arming, no reopening after a seal, enforcement and relaxing it, royalty, the treasury check, metadata and every misbehaving extension, links, interfaces, `tokensOfOwner` gas |
| `RevealSeedTest` | 2 | Audit 0792975e #1: the auditor's proof (`test_SeedDoesNotDependOnTheRevealBlock`) and the grind over 52 reveal blocks |
| `CrafterArtTest` | 19 | Pictures, traits and `tokenURI` equal to the JS's, shuffle bijection (fuzz), uniqueness, Base64 (fuzz), gas |
| `MineHookImdFirstTest`, `MineHookImdSecondTest` | 26 + 26 | The hook and routers against a real v4 `PoolManager`, with IMD as currency0 and as currency1 |
| `MineHookForkTest`, `LaunchForkTest` | 2 + 1 (fork) | ETH routing through the real pools; a blocked fee recipient moves its fees; the whole launch script |
| `MineWorldCraftersForkTest` | 6 (fork) | OpenSea's live registry: holder transfers, authorized sales, strangers, unauthorized marketplaces, enforced with nothing registered, `tokenURI` |

```bash
cd contracts && git submodule update --init --recursive && forge test
forge test --fork-url https://robinhood.drpc.org     # adds the 9 fork tests
./script/deploy-mainnet.sh crafters                  # dry runs of both stages against a fork, with launch.env
MINING_SIGNER=0x... ./script/deploy-mainnet.sh launch
```

## 3. The contracts

Each part below can be read on its own, for a job that covers only that contract; "Files" lists what such a job
needs. Throughout, a day is `block.timestamp / 1 days` (UTC), BPS is 10,000, and the owner is `0x6e85…70eD`.

### 3.1 MineToken (`contracts/src/MineToken.sol`)

Files: `MineToken.sol` (OpenZeppelin `ERC20`, `ERC20Burnable`, `ERC20Permit`, `Ownable`).

**Purpose.** $MINE. Courier's `StampToken` line for line except the name and symbol (section 2).

**State.** Not a proxy. OpenZeppelin's ERC-20, EIP-712 and nonces state, `Ownable._owner`, then `minter` and
`totalMinted`. Constant `MAX_SUPPLY = 21_000_000e18`.

**Functions.**
- Constructor `(owner, liquidity, liquidityAmount)`: mints `liquidityAmount` (≤ the cap) to `liquidity` and counts
  it in `totalMinted`. The launch passes the hook and 10,500,000e18.
- `setMinter(minter)` (owner, once, never 0); `renounceOwnership`, `transferOwnership` (OpenZeppelin `Ownable`, one
  step).
- `mint(to, amount)` (the minter only): reverts `CapExceeded` if `totalMinted + amount > MAX_SUPPLY`.
- `burn`, `burnFrom`, `permit`, transfers and approvals as in OpenZeppelin. `totalBurned()` = `totalMinted −
  totalSupply()`.

**Guarantees to check.**
1. `totalMinted` never exceeds 21,000,000e18 and never decreases, so a burn is never re-minted.
2. Only `minter` mints; `setMinter` succeeds at most once; once the owner is renounced (in the launch, right after
   `setMinter(vault)`), nothing can set an owner or a minter again.
3. No transfer, `transferFrom` or `burnFrom` charges a fee, consults a list, or can be paused; the amount sent
   arrives in full.
4. The permit domain is ("MineWorldCraft", "1", chain ID, the token).

**Admin powers.** `setMinter`, once, until the launch renounces. None after.

**Known and accepted.** As for $STAMP: emissions not converted (a rate below 100%, earnings never claimed) are never
minted, so the final supply ends below 21M.

**Tests.** `MineTokenTest` (8), `GameDeployTest` (4), `test_GamePayoutsAndTransfersAreNotTaxed` in the hook suites.

### 3.2 MineVault (`contracts/src/MineVault.sol`)

Files: `MineVault.sol`, `MineToken.sol`.

**Purpose.** $MINE's only minter, kept apart from the rules (which can be upgraded) so that the limits on minting
can't be. It mints straight to players when its distributor asks, and holds nothing.

**State.** Not a proxy, not upgradeable. `Ownable2Step` (`_owner`, `_pendingOwner`), `ReentrancyGuard`
(`_status`), `distributor`, `pendingDistributor`, `pendingReadyAt`, `released`, and one slot packing `_day` (uint64)
and `_today` (uint192): what was minted on `_day`. Immutable `token`. Constants `DAILY_LIMIT = 35_000e18`,
`TOTAL_LIMIT = 10_500_000e18`, `DISTRIBUTOR_DELAY = 2 days`.

**Functions.**
- Constructor `(token, owner, distributor)`: reverts `BadToken` unless `token.totalMinted() + TOTAL_LIMIT ≤
  token.MAX_SUPPLY()`. The first distributor is `MiningSites`' proxy, at its predicted address (no code yet).
- `release(to, amount)` (the distributor only, `nonReentrant`): adds `amount` to today's total (a record from an
  earlier day counts as 0) and to `released`, reverts `OverDailyLimit` / `OverTotalLimit` past either limit, then
  calls `token.mint(to, amount)`.
- Views: `releasedToday()`, `remaining()`, `roomToday()` (the smaller of today's room and what's left in all).
- Owner: `proposeDistributor(d)` (any non-zero address, code or not, so a proxy's predicted address can be proposed
  before it exists; replaces any earlier proposal and restarts the wait), `cancelDistributor()`,
  `acceptDistributor()` (once `block.timestamp ≥ pendingReadyAt`, and only if the pending address has code
  (`NotAContract`) and its `owner()` (a static call, read through the minimal `IOwned`) returns exactly the vault's
  owner (`NotOwnersDistributor` otherwise, including a call that reverts or returns anything but one word)),
  `sweep(token, to)` (tokens sent by mistake), `transferOwnership` / `acceptOwnership`. `renounceOwnership` always
  reverts `CannotRenounce`.

**Guarantees to check.**
1. **MineVault never mints more than 35,000e18 in a UTC day, whoever the distributor is, including across a
   distributor change** (today's total belongs to the vault, not to the distributor).
2. `released` never exceeds 10,500,000e18, and the constructor's check means the token's cap is never what stops a
   release.
3. Only the current distributor can make it mint: not the owner, not a pending or former distributor.
4. The distributor changes only by `proposeDistributor`, then `acceptDistributor` at least 2 days later, both by the
   owner; `cancelDistributor` or a new proposal voids the old one.
5. The vault never holds $MINE: `release` mints straight to `to`; `sweep` only moves what was sent by mistake.
6. Ownership can't be renounced, so a distributor can always be replaced.
7. Hence 10,500,000 can't be minted over fewer than 300 UTC days.
8. **Only a contract the vault's owner owns can become the distributor** (audit 0792975e #2): an empty address, an
   uninitialised proxy (`owner()` is 0) or a proxy someone else initialised is refused at `acceptDistributor`, and a
   pending distributor can't mint.

**Admin powers.** Choose the distributor (two-day delay), sweep strays, hand over ownership. The owner can't mint,
raise a limit or upgrade the vault.

**Known and accepted.**
- The distributor decides who is paid, within the limits: a bad distributor could mint up to 35,000 a day to
  whomever it likes. That is no more than the owner can already reach through `MiningSites` (its signer, or an
  upgrade), so the delay gives notice rather than extra protection.
- A proposal doesn't expire: once its two days are over it can be accepted at any later time (`pendingDistributor`
  shows it until then).
- **Replacing the distributor** (a new MiningSites proxy rather than an upgrade in place), as the vault's NatSpec
  sets out: deploy the implementation; `proposeDistributor(P)` with P the new proxy's predicted address (nothing there
  yet); deploy the `ERC1967Proxy` at P with `initialize` in its constructor, naming this vault and its owner
  (`MiningSites.initialize` accepts the vault's pending distributor as well as its distributor), so it is never
  uninitialised; two days later `acceptDistributor()`. If the owner instead proposes a proxy that already exists
  uninitialised, anyone can initialise it during the wait (it is then the pending distributor); the vault refuses it
  at accept, so that costs two days, never $MINE. If the vault changes hands, a replacement must name the new owner.
- 300 UTC days, not 300 × 24 hours: the first and last days can be partial (35,000 just before midnight and 35,000
  just after).

**Tests.** `MineVaultTest` (11, including `test_OnlyAContractTheOwnerOwnsTakesOver`), `MineVaultInvariantTest`
(`invariant_NeverMoreThanTheDailyLimit`, `invariant_Books`, over random releases by three distributors, proposals,
cancels, accepts and time), `DistributorRaceTest` (4: the auditor's `test_replacementDistributorCannotBeHijacked` and
`test_hijackerMintsFromTheVault`, `test_aStrangersPendingProxyIsNeverAccepted`, `test_safeReplacementPath`),
`test_VaultCantEmptyInUnder300Days` and `test_MaxDailyCapIsTheVaultOver300Days` in `MiningSitesTest`.

### 3.3 The proxies' shared base (`lib/OwnedUUPS.sol`, `MinePayer.sol`, `UpgradeCosts.sol`)

Files: those three; they are part of every job on `MiningSites`, `MinePayments` or `CrafterLevels`.

**Purpose.** What the three upgradeable contracts share: ownership and upgrades (`OwnedUUPS`), taking a $MINE payment
(`MinePayer`), and levels bought with $MINE (`UpgradeCosts`, used by `MiningSites` and `CrafterLevels`).

**State.** All in ERC-7201 namespaces (each slot is
`keccak256(abi.encode(uint256(keccak256(id)) - 1)) & ~bytes32(uint256(0xff))`; all six below were recomputed and
match):

| Namespace id | Slot | Fields |
| --- | --- | --- |
| `mineworldcraft.storage.Owned` | `0xf76a6bf6b01b1456d605310624268399969c1df982b72809888831a00ceb4b00` | `owner`, `pendingOwner` |
| `mineworldcraft.storage.MinePayer` | `0x74f15e19b025ca7fea1f6b3ca559dc8a3a24b77e2e16e24020a165c023c82d00` | `token`, `treasury` |
| `mineworldcraft.storage.UpgradeCosts` | `0x7f4940bc0a1f6d9e3488faac330c723b9928c3808d99c502b6421ef23cc88f00` | `uint256[] costs` (cost of reaching level i + 2), `uint16 burnBps` |
| `mineworldcraft.storage.MiningSites` | `0x65ef401c05211035aa84a6ea9a3dd124127d2cf4d8c7545646e73aef77627100` | see 3.4 |
| `mineworldcraft.storage.MinePayments` | `0xba35f12e5ac9557c7ad18bdb329ca09fcdbd411d9cbd7d9c10a0623b3b0df300` | see 3.5 |
| `mineworldcraft.storage.CrafterLevels` | `0xe0a943f71e53fafb9d333d84c4ad333a9962fba804a4b3a6ad3558ab82f56700` | see 3.6 |

Besides these, only OpenZeppelin's `Initializable` namespace, the ERC-1967 implementation slot, UUPS's immutable
`__self` and `ReentrancyGuardTransient`'s transient slot. `forge inspect <contract> storageLayout` lists no sequential
storage for `MiningSites`, `MinePayments` or `CrafterLevels`.

**Functions.**
- `OwnedUUPS`: `owner()`, `pendingOwner()`, `transferOwnership(newOwner)` (owner; 0 cancels a pending transfer),
  `acceptOwnership()` (the pending owner), `renounceOwnership()` (always reverts `CannotRenounce`),
  `upgradeToAndCall(impl, data)` (OpenZeppelin `UUPSUpgradeable`: only through the proxy, only by the owner via
  `_authorizeUpgrade`, only to an implementation whose `proxiableUUID` is the ERC-1967 slot). Errors and events are
  `Ownable2Step`'s.
- `MinePayer`: `token()`, `treasury()`, `setTreasury(t)` (owner; never 0 nor the contract itself; then the virtual
  hook `_checkTreasury(t)`, empty here, which `MiningSites` overrides to require that `t` take ETH). Internal
  `_collect(payer, amount, burnBps)`: `burnFrom(payer, amount × burnBps / BPS)` (rounded down) on $MINE, then
  `safeTransferFrom(payer, treasury, rest)`; either step is skipped when it is 0.
- `UpgradeCosts`: `maxLevel()` (= costs + 1), `upgradeCost(level)` (2 to `maxLevel()`), `upgradeCosts()`,
  `upgradeBurnBps()`; owner: `setUpgradeCosts(costs)` (same count, each 1 wei to the contract's `MAX_UPGRADE_COST`),
  `setUpgradeBurnBps(bps)` (≤ 10,000). Internal `_addLevel(cost)` (up to `MAX_LEVELS` = 20 levels in all),
  `_nextLevel(level, maxCost)` (the next level and its cost; reverts `MaxLevel` at the top and
  `CostAboveMax(cost, maxCost)` if the cost is above the caller's `maxCost`), `_payUpgrade`, `_burnShare`.

**Guarantees to check.**
1. **Only the owner can upgrade, and an upgrade keeps all state:** no field lives outside its namespace, no two
   namespaces overlap, and a later version can add fields at the end of a struct without moving anything.
2. **Implementations can't be initialized** (every implementation's constructor calls `_disableInitializers()`) or
   upgraded directly (`onlyProxy`); each proxy's `initialize` runs once, inside the proxy's constructor.
3. Ownership moves only by `transferOwnership` then `acceptOwnership` by that address; it can't be renounced.
4. `_collect` takes exactly `amount` from `payer` and nothing from anyone else (every caller passes `msg.sender`),
   needs an allowance of exactly `amount`, burns the stated share and sends the rest to the treasury; the contract's
   own $MINE balance never changes, and the vault is never involved.
5. Costs stay within 1 wei and `MAX_UPGRADE_COST`, the burn share within 0-100%, levels within 2-20 and never fewer;
   `setUpgradeCosts` can't change the number of levels.
6. **An upgrade never charges more than the `maxCost` its caller passed**, whatever the caller approved (audit
   0792975e #5).

**Admin powers.** Settings within the bounds above, the treasury, ownership, and upgrades to any code.

**Known and accepted.** Upgrades take effect at once (no timelock at launch): an upgrade can change any rule, and
could take $MINE from any wallet that has a standing allowance to that proxy (the game approves exactly each cost,
just before paying it). Ownership may move to a multisig or a timelock later.

### 3.4 MiningSites (`contracts/src/MiningSites.sol`)

Files: `MiningSites.sol`, the shared base (3.3), `MineVault.sol`, `MineToken.sol`.

**Purpose.** The rules for converting earnings into $MINE: mining sites and their levels, the server's vouchers, the
daily caps. It is the vault's distributor.

**State** (namespace `mineworldcraft.storage.MiningSites`, slot
`0x65ef401c05211035aa84a6ea9a3dd124127d2cf4d8c7545646e73aef77627100`): `vault`, `sitePrice`, `signer` and `paused`
(packed), `walletDailyCap`, `dailyCap`, `uint16[] rates` (level i + 1's rate in BPS), `sites[wallet]` (`uint64
openedAt`, `uint8 level`; both 0 = no site), `claimed[player]` ($MINE paid in all), `settled[player]` (earnings
converted in all, 18 decimals like a voucher's total), `paidDay` and `walletDay[player]` (`uint64 day`,
`uint192 paid`). Constants: `MAX_WALLET_DAILY_CAP = 3_500e18`, `MAX_UPGRADE_COST = 1_000_000e18`,
`MIN_RATE_BPS = 1_000`, `EARNINGS_TYPEHASH = keccak256("Earnings(address player,uint256 total,uint64 deadline)")`.

**Functions.**
- `initialize(token, vault, owner, treasury, signer, sitePrice, walletDailyCap, dailyCap)` (once, by the proxy's
  constructor): costs 4,620, 18,942, 77,662 and 318,415 $MINE to reach levels 2-5, burn 7,500 BPS, rates 5,000,
  6,000, 7,000, 8,500 and 10,000; reverts `BadVault` unless the vault mints `token` and names this proxy its
  distributor or its pending distributor; `TreasuryRefusesEth` unless the treasury takes a call with no ETH;
  `sitePrice > 0`; caps checked as in `setCaps`. It must run in the proxy's constructor (as the deploy script and the
  replacement procedure in 3.2 do).
- `openSite()` (anyone without a site, payable, `nonReentrant`): exactly `sitePrice`; level 1; then sends the
  contract's whole ETH balance to the treasury. No `receive`: plain ETH is refused.
- `upgradeSite(maxCost)` (a site's holder, `nonReentrant`): one level up, to at most `maxLevel()`, for
  `upgradeCost(level + 1)` from the caller's wallet through `_collect` (burn share burned, the rest to the treasury);
  reverts `CostAboveMax` if that cost is above `maxCost`. Works while paused.
- `claim(total, deadline, signature)` (a site's holder, `nonReentrant`): reverts `NoSite`, `IsPaused`, `Expired`
  (after `deadline`), `BadSignature` (any signature that doesn't recover to `signer` over
  `(msg.sender, total, deadline)`, malformed ones included, via `ECDSA.tryRecover`), `NothingToClaim`. Then `_quote`:
  `earnings = total − settled` (0 if `total ≤ settled`), `full = earnings × rate / BPS` (rounded down), `amount` =
  the least of `full`, the wallet's room today, everyone's room today and `vault.roomToday()`. Paid in full, all of
  `earnings` is settled; held back, only `ceil(amount × BPS / rate)` is. Updates `claimed`, `settled` and both day
  totals, emits `Claimed`, then `vault.release(msg.sender, amount)`.
- Views: `claimable(player, total)` (what `claim` would pay now; 0 without a site or while paused), `rateBps`,
  `levelRateBps`, `rates`, `siteOf`, `hasSite`, `siteLevel`, `paidToday`, `walletPaidToday`, `claimed`, `settled`,
  `vault`, `vaultBalance`, `MAX_DAILY_CAP()` (the vault's `DAILY_LIMIT`), `sitePrice`, `signer`, `paused`,
  `walletDailyCap`, `dailyCap`, `today`, `domainSeparator()`, `eip712Domain()` (ERC-5267).
- Owner: `setSitePrice` (> 0), `setSigner` (≠ 0), `setPaused`, `setCaps(wallet, global)` (1 wei ≤ wallet ≤
  3,500e18, wallet ≤ global ≤ the vault's daily limit), `setRates(rates)` (one per level, each 10%-100%, never lower
  than the level below's), `addLevel(cost, rate)` (rate ≥ the top level's, ≤ 100%), `sweep(token, to)`, and the
  shared base's powers (costs, burn share, treasury, ownership, upgrades). A new treasury must take a call with no
  ETH (`_checkTreasury`: a zero-value call with all the gas, as `Address.sendValue` would make; `TreasuryRefusesEth`).

**EIP-712.** Domain name "MineWorldCraft Mining", version "1", `block.chainid`, `address(this)`: computed on each
call, and in the proxy's context, so it is the same before and after an upgrade.

**Guarantees to check.**
1. **A claim never pays more than (total − settled) × rate** (rounded down), at the claimer's rate at that moment,
   and never more than any of the three daily rooms or the vault's room.
2. `settled[p]` never exceeds the highest `total` signed for `p`; a held-back claim settles strictly less than
   `total − settled`, and never pays more than the earnings it settles are worth at its rate.
3. Only a voucher signed by `signer`, for the caller, in this proxy's domain on this chain, pays; the same voucher, or
   one with a lower total, never pays twice (the total is cumulative); a voucher for another contract or chain never
   pays.
4. Per UTC day, one wallet is paid at most `walletDailyCap` and everyone together at most `dailyCap`, and neither cap
   can exceed its maximum; a cap lowered below what was paid today stops the day's claims without breaking the books.
5. A wallet without a site can't claim; a site opens once, for exactly `sitePrice`, and that ETH reaches the treasury
   in the same call; the contract's ETH balance is 0 after every call; the treasury took a plain call when it was set,
   so it doesn't block `openSite` (audit 0792975e #4).
6. **Upgrade payments never touch the vault:** `upgradeSite` raises only the caller's site, one level, paid only from
   the caller's wallet, never more than its `maxCost`.
7. `rates().length == maxLevel()` at all times, rates are non-decreasing by level and within 10%-100%, so every site
   has a rate.
8. Pausing stops claims only; nothing earned or settled is lost.
9. **A UUPS upgrade keeps every site, level, `claimed`, `settled`, day total, cap, rate and cost, and only the owner
   can upgrade; implementations can't be initialized.**

**Admin powers.** The settings above within their bounds, the signer, the pause, the treasury, ownership, upgrades.

**Known and accepted.**
- The signer key decides what each wallet has earned. If it leaks, whoever holds it can sign any total for wallets it
  controls; each needs a site (paid to the treasury), and it takes at most `walletDailyCap` per wallet and `dailyCap`
  in all per UTC day (two days' worth back to back around midnight) until the owner pauses or calls `setSigner`. It
  can't touch the treasury, anyone's ETH or $MINE already paid, and it uses up the honest players' share of the day.
- The rate applies when you claim: upgrading before claiming converts the whole backlog at the new rate (intended),
  and a rate the owner changes applies to earnings not yet claimed.
- Rounding goes in the vault's favour: a full conversion rounds the payment down and settles everything (the dust is
  lost); a held-back one settles `ceil(amount × BPS / rate)`.
- A rate lowered just before a player's claim applies to it. A cost raised just before an upgrade doesn't: the
  upgrade reverts if the cost is above the `maxCost` the player sent (the game sends the cost it showed).
- The treasury check is a plain call with no ETH: a contract whose fallback takes calls but not ETH would pass it and
  still block `openSite`. The owner is trusted not to choose one (the launch treasury is a wallet).
- The shared daily cap is first come, first served. `NothingToClaim` also covers "today's caps are used up".
- The site price is in ETH and the costs in $MINE, set by hand; they can lag the market.
- Sites can't be moved to another wallet.

**Tests.** `MiningSitesTest` (49, including `testFuzz_ClaimableMatchesWhatClaimPays`,
`test_CappedClaimsSettleOnlyWhatTheyCover`, `test_CappedClaimsRoundInTheVaultsFavour`,
`test_VouchersAreBoundToThisContract`, `test_SignaturesMustBeTheSignersForThisWalletAndTotal`,
`test_InitializersAreLocked`, `test_UpgradeKeepsEverything`, `test_TreasuryCantReenter`, `test_TreasuryMustTakeEth`,
`test_RaisedCostRevertsForAnExactApproval`, `test_RaisedCostRevertsEvenWithAnUnlimitedApproval`),
`DistributorRaceTest` (4), and `MiningSitesInvariantTest` (random opens, upgrades, earnings, claims, forged vouchers,
cap and rate changes, pauses, stray transfers and time, across six wallets).

### 3.5 MinePayments (`contracts/src/MinePayments.sol`)

Files: `MinePayments.sol`, `lib/OwnedUUPS.sol`, `MinePayer.sol`, `MineToken.sol`.

**Purpose.** What players pay the game in $MINE: the shop and rocket tickets. Prices live in the game's config, not
here; the contract takes the payment, burns the kind's share and records it in a `Paid` event that the game checks.

**State** (namespace `mineworldcraft.storage.MinePayments`, slot
`0xba35f12e5ac9557c7ad18bdb329ca09fcdbd411d9cbd7d9c10a0623b3b0df300`): `Kind[] kinds` (`string name`,
`uint16 burnBps`). Constants `MAX_KINDS = 32`, `KIND_SHOP = 0`, `KIND_TICKET = 1`.

**Functions.**
- `initialize(token, owner, treasury)` (once): kinds 0 "shop" (7,500 BPS burned) and 1 "ticket" (0).
- `pay(kind, amount, ref)` (anyone, `nonReentrant`): reverts `NoSuchKind`, `ZeroAmount`; takes `amount` from the
  caller through `_collect`; emits `Paid(player, kind, amount, burned, ref)`.
- Views `kindCount()`, `kind(i)`.
- Owner: `addKind(name, burnBps)` (name 1-32 bytes, ≤ 32 kinds, kinds never removed), `setKindBurn(i, burnBps)`
  (0-100%), and the base's treasury, ownership and upgrades.

**Guarantees to check.**
1. `pay` takes exactly `amount` from the caller and from nobody else; `burned` = `amount × burnBps / BPS` (rounded
   down) is burned and the rest reaches the treasury; the event carries exactly those numbers.
2. The contract never holds $MINE and never touches the vault.
3. Kinds are only added, never removed; burn shares stay within 0-100%.
4. A UUPS upgrade keeps every kind; only the owner upgrades; the implementation can't be initialized.

**Admin powers.** Burn shares, new kinds, the treasury, ownership, upgrades.

**Known and accepted.**
- The contract doesn't know prices or what was bought. Tickets are checked off chain from the `Paid` event (section
  2); `ref` isn't checked for uniqueness on chain (the server keys tickets by transaction hash).
- Shop items are delivered by the browser, which checks its own `Paid` event and keeps the inventory in local
  storage; a player can edit their own browser. The server's checks assume the best tool and weapon anyway.

**Tests.** `MinePaymentsTest` (9, including `testFuzz_SplitAddsUp`, `test_UpgradeKeepsKindsAndOnlyTheOwnerUpgrades`).

### 3.6 CrafterLevels (`contracts/src/CrafterLevels.sol`, `contracts/src/ICrafterAttributes.sol`)

Files: those two, the shared base (3.3), `MineToken.sol`, `MineWorldCrafters.sol` (which it reads and refreshes).

**Purpose.** Each Crafter's level (1 to `maxLevel()`), bought with $MINE by its holder. The level belongs to the
token. The collection shows it as the "Level" trait through `attributesOf`, once its owner points the collection here
(`setAttributesExtension`).

**State** (namespace `mineworldcraft.storage.CrafterLevels`, slot
`0xe0a943f71e53fafb9d333d84c4ad333a9962fba804a4b3a6ad3558ab82f56700`): `crafters` (the collection),
`levels[tokenId]` (uint8; 0 reads as 1). Constant `MAX_UPGRADE_COST = 2_000_000e18`.

**Functions.**
- `initialize(token, crafters, owner, treasury)` (once): costs 2,310, 9,471, 38,831 and 159,207 $MINE to reach
  levels 2-5, burn 7,500 BPS; both addresses must be contracts.
- `upgrade(tokenId, maxCost)` (the token's current owner, `nonReentrant`): reverts `NotHolder` unless
  `crafters.ownerOf(tokenId) == msg.sender`; one level up for `upgradeCost(level + 1)` from the caller through
  `_collect`, reverting `CostAboveMax` if that's above `maxCost`; then asks the collection for
  `MetadataUpdate(tokenId)` (try/catch: a refresh never fails the upgrade).
- `addLevel(cost)` (owner): a new top level, then a refresh of every Crafter (the trait's `max_value` changes).
- Views `levelOf`, `attributesOf` (`{"trait_type":"Level","value":L,"max_value":M}`), `crafters`, and the base's.
- Owner: the base's costs, burn share, treasury, ownership, upgrades.

**Guarantees to check.**
1. **Only the Crafter's owner can level it** (not an approved operator, not a former holder), and only one level per
   call, never past `maxLevel()`, never for more than the caller's `maxCost`.
2. The payment comes only from the caller, as in 3.3; never through the vault.
3. A level stays with the token when it changes hands, and never goes down.
4. `attributesOf` always returns one well-formed JSON object.
5. A UUPS upgrade keeps every level; only the owner upgrades; the implementation can't be initialized.

**Admin powers.** Costs, burn share, more levels, treasury, ownership, upgrades.

**Known and accepted.** The owner could change levels in a new version. Levels raise a player's boost on the server
only (bounded by the server's caps and, for $MINE, by `MiningSites` and the vault). Levels can be bought before the
collection points here; `setAttributesExtension` then refreshes every Crafter. Its treasury needn't take ETH (it is
paid only in $MINE), so it has no ETH check, nor has `MinePayments`.

**Tests.** `CrafterLevelsTest` (18, including `test_OnlyTheHolderUpgrades`, `test_LevelStaysWithTheCrafter`,
`test_UpgradeKeepsEveryLevel`, `test_UpgradesBeforeTheCollectionIsWired`, `test_UnreadableExtensionAddsNothing`,
`test_RaisedCostRevertsEvenWithAnUnlimitedApproval`).

### 3.7 MineWorldCrafters (`contracts/src/MineWorldCrafters.sol`)

Files: `MineWorldCrafters.sol`, `ICrafterAttributes.sol`, `CrafterArt.sol`, `lib/FastBase64.sol`.

**Purpose.** The NFT: 3,333 Crafters, blind mint, commit-reveal, traits, fully on-chain metadata and pictures,
enforced 5% royalty.

**State.** Not a proxy. OpenZeppelin `ERC721`, `ERC2981`, `Ownable2Step`, then `price`, `walletLimit` (10),
`saleOpen`, `revealBlock` (the block the sale last closed in; 0 while open or never closed), `sealedHash`
(`blockhash(revealBlock)` once sealed), `totalMinted`, `mintedBy`, `treasury`, `seed` (0 until revealed),
`transferValidator`, `website`, `social`, `collectionImage`, `bannerImage`, `customContractURI`,
`attributesExtension`. Immutables `art`, `seedCommit`. Constants `MAX_SUPPLY = 3333`, `MAX_PER_TX = 5`,
`MAX_WALLET_LIMIT = 50`, `ROYALTY_BPS = 500`, `MAX_LINK = 256`, `EXTENSION_GAS = 300_000`,
`MAX_EXTRA_ATTRIBUTES = 4_096`. Enum `RevealStatus` (None, Waiting, Sealable, Expired, Sealed, Revealed).

**Functions.**
- `mint(quantity)` (anyone while the sale is open): 1-5, within `MAX_SUPPLY` and the minter's `walletLimit`
  (counted per minting address), exactly `price × quantity` (0 while free); ids `totalMinted + 1` onward via `_mint`
  (no receiver callback); then the whole ETH balance goes to the treasury.
- `setSaleOpen(open)` (owner): reverts `AlreadyRevealed` after the reveal, `AlreadySealed` after the seal, and
  `SealPending` while the reveal block's hash is readable and unsealed; closing sets `revealBlock = block.number`
  (`RevealBlockSet`), opening sets it to 0. Closing therefore ends the sale once anyone seals (from the next block).
- `seal()` (anyone): reverts `AlreadySealed`, `SaleStillOpen`, `NoRevealBlock` (never closed), `RevealTooSoon`
  (`block.number ≤ revealBlock`) or `RevealBlockExpired` (`blockhash(revealBlock)` is 0: more than 256 blocks late);
  otherwise records `sealedHash = blockhash(revealBlock)` and emits `Sealed(revealBlock, hash)`.
- `reveal(secret)` (owner, once): seals first if nobody has (same checks), requires
  `keccak256(abi.encode(secret)) == seedCommit`; `seed = keccak256(abi.encode(secret, sealedHash))`, never 0; emits
  `Revealed` and `BatchMetadataUpdate(1, totalMinted)`. The seed doesn't depend on the block the reveal lands in.
- `revealStatus()`: where the reveal stands, for bots and the game's panel (a client can't compare its own block
  number: on Arbitrum the RPC's is the L2 block, the EVM's `block.number` the parent chain's).
- Traits: `_shuffle(seed, id − 1)` is a 4-round Feistel network on 12 bits (round function
  `keccak256(abi.encode(s, i, r)) & 63`), cycle-walked below 3,333; `c = shuffle × 6,912 / 3,333` picks one of the
  6,912 hair × outfit × eyes × gaze combinations; background, skin, hat and blush are weighted picks from
  `keccak256(abi.encode(seed, id))`. Rarity is a table of background and hat.
- Views: `traitsOf`, `rarityOf` (revealed, existing tokens), `extraAttributes(id)` (the extension's JSON: a raw
  `staticcall` with `EXTENSION_GAS` gas and no return data copied by the call; the answer is used only if the call
  succeeded and returned at least 64 bytes, an offset of exactly 0x20 and a length of at most 4,096 that the returned
  data holds, and only those bytes are copied, with the free memory pointer moved past them; "" otherwise, or with no
  extension), `tokenURI` (base64 JSON with a base64 SVG; before the reveal a sealed picture and
  "Status: Sealed"; the extension's traits are appended), `contractURI` (ERC-7572; built in, or the owner's override),
  `tokensOfOwner` (loops over every id), `royaltyInfo`, `getTransferValidator`, `getTransferValidationFunction`
  (`validateTransfer`, `0xcaee23ea`, a view), `supportsInterface` (ICreatorToken `0xad0d7f6c`, ERC-4906, ERC-721,
  ERC-2981).
- Transfers: `_update` calls `validateTransfer(msg.sender, from, to, id)` on the validator for every move between
  two non-zero addresses. Mints skip it; there is no burn.
- `refreshMetadata(from, to)` (the attributes extension or the owner): emits `MetadataUpdate` or
  `BatchMetadataUpdate`, clamped to minted ids.
- Owner: `setSaleOpen` (above), `setPrice` (any, 0 = free), `setWalletLimit` (1-50), `setTreasury` (≠ 0, ≠ this,
  must take a call with no ETH, as the constructor checks too: `TreasuryRefusesEth`; moves the 5% royalty with it),
  `setTransferValidator` (a contract; no interface check, see section 8 #6), `setLinks`, `setCollectionImages`
  (each ≤ 256 bytes, no `"`, `\` or control characters),
  `setContractURI` (anything; "" restores the built-in JSON), `setAttributesExtension` (a contract or 0; emits
  `BatchMetadataUpdate`), `transferOwnership` / `acceptOwnership`. `renounceOwnership` always reverts.

**Guarantees to check.**
1. **Supply and payment:** at most 3,333 tokens, ids 1-3,333, only through `mint` while the sale is open, with exactly
   `price × quantity`; the payment reaches the treasury in the same call; nothing is ever left in the contract.
2. **Fair reveal:** nobody, minter or owner, can mint knowing any token's look (the reveal block's hash can't exist
   while the sale is open); **the seed depends only on the committed secret and the hash of the block the sale closed
   in, never on when `seal` or `reveal` is sent** (audit 0792975e #1); once that hash is readable the sale can't
   reopen or close again until it is sealed (never after) or expires; once sealed it never changes and nothing more is
   minted; after the reveal looks never change.
3. **No two alike:** `_shuffle` is a bijection on 0..3,332 for every seed, and 6,912 ≥ 3,333 makes the combination
   index injective, so no two tokens share hair, outfit, eyes and gaze.
4. **Royalty enforcement is always routed through the validator:** no path moves a Crafter between two non-zero
   addresses without calling it (`transferFrom`, both `safeTransferFrom`s, anything reaching `_update`); it can't be
   set to zero or a non-contract; `royaltyInfo` is always 5% to the treasury; holders can always move their own
   Crafters with the launch registry. How strict enforcement is depends on the validator the owner sets (an owner
   power, stated plainly: section 8 #6).
5. **Metadata:** `tokenURI` returns valid base64 JSON for every existing token, before and after the reveal, with or
   without an extension, **whatever the extension does** (reverts, runs out of its 300,000 gas, returns nothing,
   returns malformed or oversized data, or a return bomb: then no extra traits; audit 0792975e #3), and reverts for
   ids never minted; links and pictures can't break the built-in `contractURI` JSON; `traitsOf`, `rarityOf` and
   `tokenURI` agree.
6. **ERC-4906:** every change to what `tokenURI` returns is announced: the reveal, `setAttributesExtension`, and
   (through `refreshMetadata`) `CrafterLevels.upgrade` and `addLevel`.
7. The owner can't move anyone's Crafters, hold or redirect a holder's ETH, change the art, the traits, the rarity,
   the reveal's entropy once it exists, or the 5% rate. The treasury always takes a plain call (checked when set), so
   it can't block paid mints (audit 0792975e #4).

**Admin powers.** As listed; none ends (ownership can't be renounced, so the links, price and validator stay
manageable). Anyone can `seal`.

**Known and accepted.**
- **The reveal's entropy, and the trust left in it.** The seed is the committed secret mixed with the hash of the
  block the sale closed in, sealed by anyone; the owner can't pick it by timing the reveal (audit 0792975e #1). What
  remains: (a) Robinhood Chain is an Arbitrum Orbit chain: `block.number` follows the parent chain, and `blockhash` is
  a pseudo-random value the chain derives from its own blocks, which its sequencer produces, so the sequencer (not the
  owner) could in principle steer it; (b) the chain keeps a block hash for 256 blocks (about 50 minutes, in
  parent-chain blocks): if nobody seals in time, closing the sale again fixes a new reveal block. Letting the hash
  expire is the only way to get a different one, and it is public (`RevealBlockSet`, and `revealStatus()` reads
  Sealable for those 256 blocks), and anyone (a bot, a player, the game's panel) who seals in time stops it, so it
  should be done promptly; (c) closing the sale is not a pause: from the next block anyone can seal, after which it never reopens. A lost
  secret means the Crafters stay sealed.
- If the mint doesn't sell out, the collection ends smaller: there is no mint after the reveal.
- The wallet limit counts per minting address; several wallets get several allowances. The mint is free at launch.
- **The validator is trusted, and the owner can relax enforcement** (audit 0792975e #6). The owner (or OpenSea, which
  controls the registry) could block marketplace sales or every transfer; the owner can point the collection at a
  validator that allows everything (`test_OwnerCanRelaxEnforcementInTheOpen`), and on OpenSea's registry the
  collection's owner can also change the collection's own list of authorizers and security level (a stranger can't:
  checked against the live registry). Every change is on chain. No ERC-165 check on a new validator: OpenSea's
  registry answers `supportsInterface` only for ERC-165 itself and `0x751a6149`, which Limit Break's validators on the
  same chain don't, so requiring an id would only tie the collection to one registry family. Private transfers between
  holders pay no royalty.
- The attributes extension's JSON and the `contractURI` override are owner-chosen and inserted as they are (the
  extension's at most 4,096 bytes, read with 300,000 gas).
- The treasury check is a plain call with no ETH: a contract whose fallback takes calls but not ETH would pass it and
  still refuse mint money. The owner is trusted not to choose one (the launch treasury is a wallet).
- `tokensOfOwner` loops over every id; it is meant for off-chain reads.

**Tests.** `MineWorldCraftersTest` (43, including `test_OwnerCantMintKnowingTheLooks`,
`test_RevealNeedsTheSaleClosedInAnEarlierBlock`, `test_SeedComesFromTheSecretAndTheBlock`,
`test_AStrangerSealsTheRevealBlock`, `test_NoRevealBlockUntilTheSaleCloses`, `test_NoReopeningAfterASeal`,
`test_TheHashCantBeSwappedOnceItExists`, `test_AnExpiredRevealBlockIsReArmedByClosingAgain`,
`test_GasHungryExtensionCantBreakTokenURI`, `test_RevertingOrSilentExtensionAddsNothing`,
`test_MalformedOrOversizedExtensionAddsNothing`, `test_TreasuryMustTakeEth`, `test_OwnerCanRelaxEnforcementInTheOpen`,
`test_EnforcementCanMoveButNeverBeSwitchedOff`, `test_SafeTransfersWithDataAreCheckedToo`, `test_MintsSkipTheValidator`,
`test_LinksThatWouldBreakTheJsonAreRefused`, `test_RevealRefreshesMarketplaces`, `testFuzz_DifferentSeedsGiveValidTraits`),
`RevealSeedTest` (2: the auditor's `test_SeedDoesNotDependOnTheRevealBlock`, and `test_OwnerCantGrindItsOwnCrafterToLegendary`),
`MineWorldCraftersForkTest` (6, OpenSea's live registry, including `test_Fork_EnforcedWithoutRegistering`), and
`CrafterArtTest`'s `testFuzz_ShuffleIsABijection`, `test_EveryCrafterIsUnique`, `test_TokenURIMatchesTheJs`.

### 3.8 CrafterArt and FastBase64 (`contracts/src/CrafterArt.sol`, `contracts/src/lib/FastBase64.sol`)

Files: those two, with `web/crafters-art.js`, `web/crafters.js` and `tools/gen-crafter-art.mjs` as the reference.

**Purpose.** `CrafterArt` draws every Crafter as a 24 × 24 SVG from packed masks and palettes (`ART`), the same bytes
`svg(traits)` in `web/crafters.js` writes; it also gives the trait names, the attributes array, the rarity and the
sealed picture. It has no state and no owner; all functions are `pure`. `CrafterRules` (a library in the same file)
holds the counts and the weighted picks. `FastBase64` is RFC 4648 base64 with padding, using Solady's technique (the
alphabet in scratch memory at `0x1f`-`0x5e`, restored free-memory pointer).

**Functions.** `render(traits)`, `sealedSvg()`, `attributes(traits)`, `rarityOf(traits)`, `traitName(kind, index)`;
`FastBase64.encode(bytes)` (internal).

**Guarantees to check.**
1. `render`, `attributes` and `rarityOf` revert `BadTraits` for any index past its table and never revert otherwise.
2. The output is valid SVG and valid JSON, equal to the JS's for the test vectors and every Crafter of a seed.
3. The assembly is memory-safe: `_canvas` (20,576 bytes), `_layer` (palette slots written before read), `_svg` (one
   buffer written in place, the free-memory pointer set after), `_name`, `FastBase64` (the word after the input
   zeroed and restored; the alphabet over `0x40` restored), and in `MineWorldCrafters` `_shuffle`'s scratch writes
   past the free-memory pointer and `extraAttributes` (the call data and the returned header at the free-memory
   pointer, then the string written there and the pointer moved past it).
4. `tokenURI` stays well under RPC `eth_call` gas caps (`test_TokenURIGas` requires < 15M).
5. `FastBase64.encode` equals standard base64 for every input (fuzzed against forge's encoder, with edge cases).

**Known and accepted.** View-only: a bug here can garble or break a picture, never move tokens or funds.

**Tests.** `CrafterArtTest` (19).

### 3.9 MineHook, MineRouter, MineEthRouter (`contracts/src/MineHook.sol`, `MineRouter.sol`, `MineEthRouter.sol`)

Files: those three, `lib/SafeTransfer.sol`, `MineToken.sol`. Courier's `StampHook`, `StampRouter` and
`StampEthRouter` with the differences listed in section 2 (only the lowest start tick changes behaviour).

**Purpose.** The hook owns the one $MINE/IMD pool: `openPool` (owner, once) initializes it at the start tick fixed in
the constructor and adds the 10.5M launch allocation (less a 1e9-wei rounding buffer, burned with any donation) as
single-sided liquidity owned by the hook, which has no function to remove it. `beforeInitialize` and
`beforeAddLiquidity` revert for any caller but the hook, so nobody can open another pool on it or add liquidity. LP
fee 0. The fee is 4% of the IMD side of every swap, rounded up, through any router, both directions, exact-in and
exact-out, taken through the swap's return deltas, held as ERC-6909 IMD claims (`pendingProtocolFees`) and sent to
`feeRecipient` by `collectProtocolFees` (anyone). A swap whose specified side is IMD must fill completely
(`PartialFill`). The routers (deployed by the hook's constructor) pull tokens only from `msg.sender`, pass the user in
`hookData` for the `Trade` event, and stop sells at the launch price (`sellPriceLimit`). `MineEthRouter` goes through
the hookless IMD/ETH v4 pool (fee 1%, tick spacing 100).

**State.** Not a proxy. `owner`, `pendingOwner`, `feeRecipient`, `token`, `launches`, `tokenOfPool`,
`pendingProtocolFees`; immutables `poolManager`, `IMD`, `router`, `ethRouter`, `startTick`, `launchSupply`; the
transient `FEE_SLOT`. The routers hold only immutables.

**Functions.** Hook: `openPool(token)` (owner, once); `beforeSwap`, `afterSwap`, `unlockCallback` (the PoolManager);
`collectProtocolFees(quote)` (anyone); `setFeeRecipient` (the owner, or the fee recipient itself); two-step
ownership; `renounceOwnership` (owner, only after `openPool`); views `poolKey`, `launchSqrtPrice`, `sellPriceLimit`,
`price`, `marketCap`; every other hook entry point reverts. `MineRouter`: `buy`, `sell`, `sellWithPermit`.
`MineEthRouter`: `buyWithEth`, `sellForEth`, `sellForEthWithPermit`. Both: `unlockCallback` (the PoolManager).

**Guarantees to check** (Courier's guarantees 1-3 and 7, which IMD Swarm checked on `StampHook`):
1. **The fee is always paid, never undercharged:** 4% of the IMD side, rounded up, whatever the router, direction or
   mode; no path skips it; no trader pays more than 1 wei above 4%.
2. **Fee solvency:** the hook's ERC-6909 IMD claims are never less than `pendingProtocolFees[IMD]`;
   `collectProtocolFees` sends exactly that to `feeRecipient`, whether or not the PoolManager is already unlocked.
3. **Locked liquidity:** nobody can remove the launch liquidity, add other liquidity, open another pool on this hook
   or call `openPool` twice; a donation before the launch can't block `openPool`; every start tick in
   [-300,000, 400,000] (multiples of 200) with every allocation of 1 to 21,000,000 tokens opens.
4. **Routers** only move the caller's tokens; deadlines and minimum outputs hold; the ETH router returns unused ETH and
   IMD; a front-run permit can't make a sell fail; sells stop at the launch price.
5. After `renounceOwnership`, only the current fee recipient can move the fees; nobody else can.

**Admin powers.** `openPool` once, `setFeeRecipient`, ownership: all end with the renounce in the launch. The fee
recipient can always move its own fees.

**Known and accepted** (as in Courier's brief, section 5): sells can't fill until buys bring IMD into the pool;
anyone can open a separate hookless $MINE pool that pays no fee; donations stay where they land; a sell through
another router can push the pool price past the launch price, and `price()` reports the launch price there; IMD's
issuer can block addresses or switch transfers off (a blocked fee recipient moves its fees with `setFeeRecipient`);
`Trade` logs `tx.origin` for other routers; a 1-wei exact-in buy through another router pays its 1 wei as the fee.
After the renounce the current fee recipient can still move its own fees (as `StampHook`), so a compromised
fee-recipient key could redirect future fees; nobody else can (audit 0792975e #7). The lowest start tick is -300,000
where `StampHook`'s is -400,000: reviewed in audit 0792975e (#8) and accepted, no code change.

**Tests.** `MineHookImdFirstTest` and `MineHookImdSecondTest` (26 each, the same suite with IMD as currency0 and as
currency1, including `test_StartPriceIsBoundedSoOpenPoolAlwaysWorks` at -300,000 and 400,000 with 1, 10.5M and 21M),
`MineHookForkTest` (2) and `LaunchForkTest.test_Fork_FullLaunch` on a Robinhood Chain fork.

## 4. Cross-contract guarantees

1. **The 300-day promise holds whatever `MiningSites`' code is.** $MINE's only minter is the vault (set once, token
   renounced); the vault mints only for its distributor and never more than 35,000 in a UTC day or 10,500,000 in all;
   the other 10,500,000 is locked in the pool. No upgrade of `MiningSites`, `MinePayments` or `CrafterLevels`, no
   signer and no owner can mint more, sooner. Total supply ≤ 10,500,000 + `released` ≤ 21,000,000 at all times.
2. **The token is ownerless, mint-only-by-vault, with no proxy, pause, blocklist or tax:** after the launch
   `owner() == 0`, `minter == vault`, nothing can change either, and a token scanner should read $MINE as it reads
   $STAMP.
3. **The hook's 4% is fixed:** `FEE_BPS` is a constant and the hook isn't upgradeable; after the renounce only the
   current fee recipient can move the fees; nobody else can.
4. **The 5% royalty rate is a constant and every transfer between wallets goes through the validator,** which can
   only be replaced by another contract, and the collection can't be renounced into an unmanageable state. How strict
   enforcement is, is the owner's choice of validator (and of the collection's policy on OpenSea's registry): the owner
   can relax it, in public.
5. **No contract holds a player's $MINE or ETH between calls**, and payments never touch the vault: site and Crafter
   upgrades and shop or ticket payments go from the player's wallet to the burn and the treasury; claims are minted
   straight to the player; site and mint payments go straight to the treasury.
6. **$MINE has no transfer hooks** (plain OpenZeppelin ERC-20), so no mint, burn or transfer can call back into the
   game; the only external calls that can are the ETH sends to the treasury, the plain call that checks a new
   treasury (owner-only, when it's set), the vault's read of a proposed distributor's `owner()`, and the Crafters'
   extension (a bounded static call) and validator.
7. **Nothing on chain trusts the boosts:** rarity and level change what the server counts, never what the contracts
   pay.
8. **No upgrade charges more than its caller agreed to** (`maxCost`), whatever the allowance.

## 5. Admin powers, and when they end

| Contract | Who | Power | Bounds | Ends? |
| --- | --- | --- | --- | --- |
| `MineToken` | Deploying wallet | `setMinter` | Once, never 0 | Yes: renounced in the launch |
| `MineHook` | Deploying wallet | `openPool`, `setFeeRecipient`, ownership | `openPool` once; fee and liquidity fixed | Yes: renounced right after `openPool` |
| `MineHook` | Fee recipient (`0x6e85…`) | `setFeeRecipient` for its own fees (after the renounce only the current fee recipient can move the fees; nobody else can) | Never 0 | Stays |
| `MineVault` | Owner `0x6e85…` | Propose, cancel, accept a distributor; `sweep`; ownership | Accept ≥ 2 days after proposing, only a contract whose `owner()` is the vault's owner; can't mint, raise limits or renounce | Stays |
| `MiningSites` | Owner `0x6e85…` | `setSitePrice`, `setSigner`, `setPaused`, `setCaps`, `setRates`, `addLevel`, `setUpgradeCosts`, `setUpgradeBurnBps`, `setTreasury`, `sweep`, ownership | Price > 0; wallet cap ≤ 3,500, global ≤ 35,000; rates 10-100%, non-decreasing; ≤ 20 levels, never fewer; cost 1 wei-1,000,000, never above a buyer's `maxCost`; burn 0-100%; treasury takes ETH; can't renounce | Stays |
| `MiningSites` | Owner `0x6e85…` | `upgradeToAndCall` | Any code; minting still bounded by the vault | Stays |
| `MiningSites` | Signer (the server's key) | Sign vouchers | The daily caps and the vault; replaced by `setSigner` | Until replaced |
| `MinePayments` | Owner `0x6e85…` | `addKind`, `setKindBurn`, `setTreasury`, ownership, upgrades | ≤ 32 kinds, never removed; burn 0-100%; can't renounce | Stays |
| `CrafterLevels` | Owner `0x6e85…` | `setUpgradeCosts`, `setUpgradeBurnBps`, `addLevel`, `setTreasury`, ownership, upgrades | Cost 1 wei-2,000,000; burn 0-100%; ≤ 20 levels, never fewer; can't renounce | Stays |
| `MineWorldCrafters` | Owner `0x6e85…` | `setSaleOpen`, `reveal`, `setPrice`, `setWalletLimit`, `setTreasury`, `setTransferValidator`, `setLinks`, `setCollectionImages`, `setContractURI`, `setAttributesExtension`, `refreshMetadata`, ownership | Closing fixes the reveal block; no reopening or re-closing while its hash is readable and unsealed, never after the seal; the reveal uses the sealed hash; wallet limit 1-50; royalty 5% fixed; treasury takes ETH; validator a contract (so the owner sets how strict enforcement is); links ≤ 256 bytes, JSON-safe; can't renounce | Stays (the sale ends at the seal) |
| `MineWorldCrafters` | Anyone | `seal` | Only once the reveal block is over and within 256 blocks; records its hash, nothing else | Once |
| `CrafterArt`, `MineRouter`, `MineEthRouter` | Nobody | None | | |

Deploy settings (`contracts/launch.env`): owner, treasury and fee recipient `0x6e85Dc9f094b7DD35a2A981AbBd0AC9C496670eD`
(one key, as Courier's are); start price a $5,000 fully diluted market cap for 21M $MINE; site price 0.005 ETH; caps
1,500 per wallet and 35,000 across everyone; Crafters free, 10 per wallet, OpenSea's registry as validator; the
voucher signer's address passed at launch (`MINING_SIGNER`), the key itself only in the Worker's secrets.

## 6. Known and accepted

- **UUPS upgrades are instant.** `MiningSites`' bounds (caps, rates, costs, signer, pause) are only as fixed as its
  code: the owner, or whoever holds its key, can upgrade it at once and could then mint up to the vault's 35,000 a day
  to anyone. The vault's limits are the hard ones. An upgrade of any proxy could also take $MINE from a wallet with a
  standing allowance to it; the game approves exactly each cost right before paying it. Ownership may move to a
  multisig or a timelock later.
- **Replacing `MiningSites` with a new contract** (as opposed to upgrading the proxy) starts from empty `settled`:
  lifetime vouchers for the new address would convert everything again (within the vault's limits) unless the new
  contract carries the old `settled` over. The plan is to upgrade in place; the distributor change exists for a
  rules contract that does carry it over, and follows the procedure in 3.2 (propose the predicted address, deploy it
  initialised, accept two days later; the vault only accepts a contract its owner owns).
- **A leaked voucher key** can take at most the daily caps (per wallet with a site, and in all; two days' worth back
  to back around midnight UTC) until the owner pauses or replaces it. The server is trusted for what each wallet
  earned.
- **Tickets are checked off chain** from the `Paid` event, by the server (section 2). **Shop items are browser-side**:
  the browser delivers them on seeing its own `Paid` event and keeps the inventory in local storage.
- **The rate applies when you claim**, the backlog included, at the rate of the moment; owner changes to rates and
  costs apply from the next transaction.
- **Rounding goes in the vault's favour** (section 3.4).
- The owner can't renounce any contract it owns, by design: the distributor, the rules, the links and the validator
  must stay manageable.
- The final supply ends below 21M (unconverted shares and unclaimed earnings are never minted; burns are permanent).
- The site price (ETH) and costs ($MINE) are set by hand and can lag the market.
- The treasury must accept ETH where it's sent ETH: `openSite` and paid mints send it directly. `MiningSites` and the
  Crafters refuse a treasury that fails a plain call with no ETH; a contract whose fallback takes calls but not ETH
  would still pass, and the owner is trusted not to pick one. `MinePayments` and `CrafterLevels` don't check
  (they pay the treasury only $MINE).
- Days use `block.timestamp`, which the sequencer sets within the chain's bounds.
- The Crafters' reveal (the sequencer's `blockhash`, sealing promptly, closing is final), the validator and the
  owner's power to relax enforcement, wallet limits and unsold supply (section 3.7); the hook's single-sided launch,
  hookless pools, IMD's issuer, the fee recipient moving its own fees and the -300,000 start-tick floor (section 3.9).

## 7. What to look at hardest

1. **Storage collisions and initializer/upgrade safety** in `OwnedUUPS` and the ERC-7201 layouts: the six namespace
   slots, no sequential storage anywhere in the proxies' inheritance, OpenZeppelin `Initializable`'s own namespace,
   `_disableInitializers()` in every implementation, `initialize` callable once, `upgradeToAndCall` only through the
   proxy and only by the owner, and that a next version can extend each struct safely. `OwnedUUPS` re-implements
   `Ownable2Step` (OpenZeppelin's upgradeable package isn't used): check it matches.
2. **The EIP-712 domain across proxy upgrades:** the domain is built on each call from constants, `block.chainid` and
   `address(this)` (the proxy). Vouchers signed before an upgrade stay valid after it; check they can't pay twice,
   can't be used on another chain, another proxy or the implementation, and that `eip712Domain()` and the server's
   domain match.
3. **The `settled`/`claimed` accounting under caps** (`_quote` and `claim`): the wallet cap, the global cap and the
   vault's room in every order; caps lowered mid-day; rates changed between claims; `ceil` on held-back claims; no
   sequence that pays more than (total − settled) × rate or settles past the signed total.
4. **The `burnFrom`/allowance paths in `MinePayer`:** the payer is always `msg.sender`; the burn and the transfer
   together spend exactly `amount` of allowance; burn shares of 0% and 100%; a treasury equal to the payer; MineToken's
   `burnFrom` (OpenZeppelin `ERC20Burnable`).
5. **The attributes-extension call in `tokenURI`** (rewritten for audit 0792975e #3): a raw `staticcall` with
   300,000 gas whose answer is used only if it is one ABI string (offset 0x20, length ≤ 4,096, within the returned
   data), copied by hand in assembly. Check the bounds (an overflowing length, a short answer, a return bomb), the
   memory handling, and that nothing an extension does can make `tokenURI` revert. Its JSON is still inserted
   unescaped (owner-set).
6. **Reentrancy on every $MINE movement:** claims (vault → token mint), upgrades and payments (`burnFrom`,
   `transferFrom`), sweeps, router swaps; and the ETH sends to the treasury (`openSite`, `mint`) and the ETH router's
   refunds. Guards: `ReentrancyGuardTransient` on `MiningSites`, `MinePayments`, `CrafterLevels`; `ReentrancyGuard` on
   the vault.
7. **The vault's distributor delay, cancel and owner check:** a new proposal restarts the wait; `cancelDistributor`
   voids it; `acceptDistributor` only after `pendingReadyAt` and only for a contract whose `owner()` is the vault's
   owner; `MiningSites.initialize` now also accepts the vault's pending distributor (so a replacement is deployed
   initialised), and that pending proxy can't mint; proposals don't expire; today's total carries across a change; a
   former distributor can't mint.
8. **The predicted addresses:** the CREATE-predicted `MiningSites` proxy named in the vault's constructor, and the
   hook's mined CREATE2 address and flags (section 2, deploy invariants).
9. **ERC-4906 events:** every change to `tokenURI`'s output emits `MetadataUpdate` or `BatchMetadataUpdate` (the
   reveal, `setAttributesExtension`, `CrafterLevels.upgrade` and `addLevel` through `refreshMetadata`, which is
   best-effort and clamps its range). A code upgrade of `CrafterLevels` that changes `attributesOf` emits nothing by
   itself; the owner would call `refreshMetadata`.
10. **The assembly** in `CrafterArt`, `FastBase64` and `MineWorldCrafters._shuffle`/`_traitsFor`: memory safety and
    the bijection.
11. **`MineHook`'s one change:** the start-tick range is now [-300,000, 400,000]; confirm every start tick and
    allocation the constructor accepts still opens.
12. **The reveal's seal** (audit 0792975e #1): `revealBlock` set when the sale closes, `seal` by anyone, `SealPending`
    stopping a reopen or re-close while the hash is readable and unsealed, re-arming only after expiry, nothing after a
    seal; and whether the trust left (the sequencer's `blockhash`, a withheld seal until expiry) is stated correctly.
13. **The treasury check and `maxCost`:** `_checkTreasury` in `MiningSites` (through `MinePayer`'s hook, at
    `initialize` and `setTreasury`) and in `MineWorldCrafters` (constructor and `setTreasury`); `_nextLevel`'s
    `CostAboveMax` in `UpgradeCosts`.

## 8. Resolved: IMD Swarm audit 0792975e (on commit ba2a8ed)

The report: https://explorer.imd.fun/jobs/0792975e-220d-4fe2-a11c-d611efec47bd (archived in github.com/Identity-md/research,
`jobs/0792975e-220d-4fe2-a11c-d611efec47bd/`). Two medium, three low and three info findings; every one is resolved or
answered below. Line numbers are in the fixed files.

| # | Finding | Resolution |
| --- | --- | --- |
| 1 | Medium: the owner could pick the Crafters' reveal seed by picking the reveal block (`reveal` mixed in `blockhash(block.number - 1)` of whatever block it landed in), and so pick traits and rarity | The entropy is bound to a block fixed when the sale closes. `setSaleOpen(false)` sets `revealBlock = block.number` and emits `RevealBlockSet` (`MineWorldCrafters.sol:488`). New `seal()` (`:250`, `_seal` `:255`), callable by anyone once `block.number > revealBlock`, records `sealedHash = blockhash(revealBlock)` for good, reverting `RevealBlockExpired` if that is 0 (more than 256 blocks late). `reveal(secret)` (`:236`) seals first if nobody has, then sets `seed = keccak256(abi.encode(secret, sealedHash))`. While the hash is readable and unsealed the sale can't reopen or close again (`SealPending`, `:491`), and never after a seal (`AlreadySealed`), so the hash can't be swapped; an expired one is re-armed by closing again, in public. `revealStatus()` (`:267`) tells bots and the panel when to seal. The reveal block is the closing block itself rather than one after it: its hash doesn't exist until that block is over, so nobody could mint knowing it, and with `+1` the auditor's proof (which reveals one block after the close) would be refused. The residual trust is stated in the NatSpec and in 3.7: on Robinhood Chain (Arbitrum Orbit) `block.number` follows the parent chain and `blockhash` is derived from the chain's own, sequencer-produced blocks; a seal withheld until expiry is the only way to re-roll, and it is public. Tests: the auditor's `test_SeedDoesNotDependOnTheRevealBlock` and `test_OwnerCantGrindItsOwnCrafterToLegendary` (`RevealSeedTest`), `test_AStrangerSealsTheRevealBlock`, `test_AnExpiredRevealBlockIsReArmedByClosingAgain`, `test_NoReopeningAfterASeal`, `test_TheHashCantBeSwappedOnceItExists`, `test_NoRevealBlockUntilTheSaleCloses`, `test_SeedComesFromTheSecretAndTheBlock`, `test_RevealNeedsTheSaleClosedInAnEarlierBlock`. |
| 2 | Medium: a replacement MiningSites proxy had to sit uninitialised through the 2-day wait (the vault only took a proposal with code; `initialize` only ran once the vault named it distributor), so whoever initialised it first after `acceptDistributor` owned it and could have the vault mint to them | All three parts: `MineVault.proposeDistributor` takes an address without code, i.e. a proxy's predicted address (`MineVault.sol:145`); `MiningSites.initialize` accepts being the vault's distributor or its pending distributor (`MiningSites.sol:170`), so the proxy is deployed with `initialize` in its constructor; `MineVault.acceptDistributor` requires the pending address to have code and its `owner()` (minimal `IOwned`, `MineVault.sol:11`) to equal the vault's owner (`:163`), so an uninitialised or hijacked proxy can never be accepted. The procedure is in `MineVault`'s and `MiningSites.initialize`'s NatSpec and in 3.2. Tests: the auditor's `test_replacementDistributorCannotBeHijacked` (unchanged) and `test_hijackerMintsFromTheVault` (one change: the owner's `acceptDistributor()` is now a low-level call, since the vault refusing that uninitialised proxy is where the attack now stops), `test_aStrangersPendingProxyIsNeverAccepted`, `test_safeReplacementPath` (propose the predicted address, deploy initialised, can't mint while pending, accept after two days, it pays, the old one can't), `test_OnlyAContractTheOwnerOwnsTakesOver`; the vault invariant suite (`MineVaultInvariantTest`) stays green with distributors owned by the vault's owner. |
| 3 | Low: `tokenURI` wasn't isolated from the attributes extension: a gas-hungry one starved the picture (10M and 30M `eth_call`), and return data that didn't decode as a string reverted it | `extraAttributes` (`MineWorldCrafters.sol:297`) calls the extension with a raw `staticcall` and a fixed `EXTENSION_GAS = 300_000` (`:68`, `:309`), copies nothing at the call, and uses the answer only if the call succeeded and returned at least 64 bytes with offset exactly 0x20 and a length of at most `MAX_EXTRA_ATTRIBUTES = 4_096` (`:70`) that the returned data holds; only those bytes are copied. Otherwise "" (no extra traits). Calling it after the art was considered: with the stipend the extension can use at most 300,000 gas wherever it's called, so the order is kept. Tests: `test_GasHungryExtensionCantBreakTokenURI` (a `while (true)` extension, sealed and revealed, at 10M and 30M gas), `test_RevertingOrSilentExtensionAddsNothing` (reverting; no return data), `test_MalformedOrOversizedExtensionAddsNothing` (short answer, another offset, a length past the data, a huge and a wrapping length, 4,097 bytes, a 1 MB return bomb; 4,096 bytes shows), and the existing extension tests. |
| 4 | Low: a treasury that refuses ETH blocked every `openSite` (and a paid Crafters mint) | Where ETH is forwarded the new treasury must take a plain call with no ETH, else `TreasuryRefusesEth`: `MiningSites._checkTreasury` (`MiningSites.sol:198`), through a virtual hook in `MinePayer._setTreasury` (`MinePayer.sol:72`, `:79`) that runs at `initialize` and `setTreasury`; `MinePayments` and `CrafterLevels` ($MINE only) keep the empty hook. `MineWorldCrafters._checkTreasury` (`MineWorldCrafters.sol:529`) in the constructor (`:187`) and `setTreasury` (`:518`). A contract whose fallback takes calls but not ETH would still pass; documented. Tests: `test_TreasuryMustTakeEth` in both suites (a contract without receive refused at setTreasury and at deploy/initialize; a wallet and a payable contract accepted and paid); `MinePaymentsTest.test_TreasuryMoves` and `CrafterLevelsTest.test_TreasuryMoves` accept a treasury without ETH. |
| 5 | Low: `upgradeSite()` and `CrafterLevels.upgrade()` took no `maxCost`, so a cost raise mined first charged whatever the wallet had approved | `upgradeSite(uint256 maxCost)` (`MiningSites.sol:226`) and `upgrade(uint256 tokenId, uint256 maxCost)` (`CrafterLevels.sol:90`) revert `CostAboveMax(cost, maxCost)` through `UpgradeCosts._nextLevel(level, maxCost)` (`UpgradeCosts.sol:124`, `:128`). The web client passes the cost it showed (`web/chain.js` `upgradeSite`, `levelUp`) and still approves exactly that. Tests: `test_RaisedCostRevertsEvenWithAnUnlimitedApproval` in `MiningSitesTest` and `CrafterLevelsTest` (unlimited allowance, raise to the maximum mined first: reverts, nothing taken), `test_RaisedCostRevertsForAnExactApproval`. |
| 6 | Info: royalty enforcement is only as strong as the validator the owner sets; the launch registry needs the collection's policy registered after deploy | Stated plainly as an owner power in `setTransferValidator`'s NatSpec (`MineWorldCrafters.sol:463`), the contract's trust notes, 3.7, sections 4 and 5, and the README: the owner can relax enforcement (a validator that allows everything, or a looser policy for the collection on OpenSea's registry, which only the collection's owner can set). Registration: none needed. Read on Robinhood Chain, OpenSea's registry gives a collection that never configured anything its default list, whose one authorizer is OpenSea's SignedZone (`getAuthorizerAccountsByCollection`), and the fork tests show unauthorized marketplaces refused and SignedZone sales allowed on a fresh collection; Courier World's live Courier Skins, whose deploy registered nothing either, reads the same default list. `DeployCrafters` prints the off-chain step (creator earnings on in OpenSea Studio). ERC-165 check: not added. The live registry answers `supportsInterface` only for `0x01ffc9a7` and `0x751a6149`; Limit Break's validators, also on Robinhood Chain, don't support `0x751a6149`, so no id is shared to require. Tests: `test_OwnerCanRelaxEnforcementInTheOpen`, `test_Fork_EnforcedWithoutRegistering`. |
| 7 | Info: after the hook's renounce the fee recipient can still move its own fees, contrary to the renounce NatSpec and the brief | The audited `StampHook` logic is kept. `renounceOwnership`'s NatSpec (`MineHook.sol:380`), the README and this brief (sections 1, 3.9, 4, 5, 6) now say: after the renounce only the current fee recipient can move the fees; nobody else can. Test: `test_FeeRecipientCanMoveItsOwnFees`, `test_Fork_BlockedFeeRecipientMovesItsFees`. |
| 8 | Info: the hook's start-tick floor is -300,000 where `StampHook`'s is -400,000 (`MineHook.sol:86`, `:151`) | Reviewed and accepted, no code change: it is CourierPad's range, the launch tick is far inside it, and every corner opens (`test_StartPriceIsBoundedSoOpenPoolAlwaysWorks`). |

Also changed since that commit: the web client passes `maxCost` (the cost it shows) to both upgrades and offers a
**Lock in the reveal** button (`seal()`) in the Mining Site panel when `revealStatus()` is Sealable (`web/chain.js`,
`web/panel.js`); `dev.sh` seals from a player's account before the owner reveals; `DeployCrafters` and
`deploy-mainnet.sh` print the reveal steps and the OpenSea step. 225 tests, plus 9 against a Robinhood Chain fork
(`--match-contract ForkTest`).
