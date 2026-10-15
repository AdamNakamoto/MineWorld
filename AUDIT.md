# Audit brief

What MineWorldCraft's contracts do, what they must guarantee, and where reviewers should look hardest. Everything
referenced is in https://github.com/AdamNakamoto/MineWorld at the commit that adds section 11. IMD Swarm audited the
contracts at `ba2a8ed` (job 0792975e; section 8 lists its eight findings and their fixes), re-checked the fixes at
`49830f2` (job 8c7ba957; section 9), again at `4de227d` (job 52b534f9; section 10) and a third time at `25121ea` (job
10d532d5; section 11 lists its five findings and how each is resolved, with one addition since: a "revive" payment
kind). The sections before them describe the contracts as they are now. Nothing is deployed yet: every contract in `contracts/src` is audited before
anything goes to Robinhood Chain. The deploy settings are in `contracts/launch.env`.

**The NFT collection was renamed "I'M DEGEN"** (symbol DEGEN; one character is a DEGEN). Only what people see changed: the
token's name and symbol, the metadata's names and descriptions, the game's and the scripts' wording. The code keeps the
first name, MineWorld Crafters, in its identifiers (`MineWorldCrafters`, `CrafterArt`, `CrafterLevels`, `traitsOf`,
"Crafter" in NatSpec and in this brief), so the audit diff stays small: a Crafter here is one DEGEN.

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
  only in the open: propose, wait two days, accept; and only with a contract whose `owner()` is the vault's owner,
  whose `vault()` is the vault and whose `predecessor()` is the distributor it replaces. Every proxy of the family
  (`MiningSites`, `MinePayments`, `CrafterLevels`) can only be set up in its own constructor, never later, by anyone
  (`OwnedUUPS`), so nobody can make a proxy someone else deployed theirs; the vault's reads are answered by the
  candidate's own code, so they catch mistakes, not a contract built to lie, and the owner proposes only a proxy it
  deploys itself. A replacement carries each player's site (its level as bought), `settled` and `claimed` over from its
  predecessor, and the replaced one retires. Any distributor can be replaced, one without code too (a predicted
  address nothing was deployed at), whose books are empty.
- **Earning and converting** (`MiningSites`, UUPS proxy): the game's server (a Cloudflare Worker, out of scope) keeps
  a ledger of what each signed-in wallet earns and signs an EIP-712 voucher `Earnings(player, total, deadline)` for
  the wallet's **lifetime** earnings. To convert, a wallet opens a mining site once, for ETH (0.005 at launch, sent
  straight to the treasury). `claim` converts what the wallet hasn't converted yet (`total − settled`) at its site
  level's rate (50%, 60%, 70%, 85% and 100% for levels 1 to 5), within a daily cap per wallet (1,500 $MINE at launch,
  at most 3,500), a daily cap across everyone (35,000 at launch, at most the vault's daily limit) and what the vault
  can still mint today. The vault mints to the player. The share a rate doesn't convert is never minted.
- **Spending $MINE:** site upgrades (`MiningSites.upgradeSite`), Crafter levels (`CrafterLevels.upgrade`) and the
  game's shop (`MinePayments.pay`, kind 0) burn 75% of the payment and send 25% to the treasury; rocket tickets
  (kind 1) and revives (kind 2: the game's 420 $MINE revive on the spot after dying on the home planet) burn nothing
  and send it all to the treasury. Every payment is taken straight from the player's wallet
  with an exact approval: no contract holds anyone's $MINE, and payments never touch the vault. Upgrades also name the
  most they'll pay (`maxCost`), and a site upgrade the least rate it buys (`minRateBps`), so a cost raised or a rate
  cut meanwhile reverts them whatever the allowance.
- **The upgradeable contracts** (`MiningSites`, `MinePayments`, `CrafterLevels`): UUPS proxies (ERC-1967) on a shared
  base (`lib/OwnedUUPS.sol`, `MinePayer`, `UpgradeCosts`), with all state in ERC-7201 namespaced storage. They are
  owned by `0x6e85Dc9f094b7DD35a2A981AbBd0AC9C496670eD`: ownership moves in two steps and can't be renounced; only the
  owner changes their settings (within the bounds below) and upgrades their code. The owner may hand them to a
  multisig or a timelock later. The same wallet owns the vault and I'M DEGEN, and is the treasury and the fee
  recipient.
- **I'M DEGEN** (`MineWorldCrafters`, pictures by `CrafterArt`): 3,333 pixel-art NFTs drawn and stored entirely on
  chain. Blind mint for wallets only (`msg.sender == tx.origin`; free at launch, 5 per transaction, 3 per wallet), then
  commit-reveal: `seedCommit` is fixed at
  deploy; after the mint the owner publishes the secret (`reveal(secret)`, sale closed for good), and the seed waits
  for the hash of the chain's next block (an L2 block, from Arbitrum's ArbSys at `0x64`); once that block is over,
  anyone sets the seed with `seal()`, within the 256 L2 blocks ArbSys gives a hash for (about 26 seconds; the owner's
  panel seals straight after the reveal). After a window nobody sealed in, `seal` reverts and only the owner can move
  the entropy block on (`moveEntropyOn`), in public, at most 3 times; then the reveal is stuck for good. Nobody can
  mint knowing a look, nobody, the owner included, can see one before everyone can, and the owner's only lever is
  those three public re-rolls of a window nobody sealed in. As the owner alone knows when it reveals, in practice it
  decides whether a window is sealed unless holders run the sealer (`tools/sealer.sh`) at the reveal time it
  announces: at most a best of four public seeds. A keyed shuffle gives every token a different hair/outfit/eyes/gaze combination; background, skin, hat and
  blush are weighted picks. ERC-2981 royalty fixed at 5% to the treasury, enforced with ERC721-C (OpenSea's registry
  `0xA000027A9B2802E1ddf7000061001e5c005A0000` at launch; the owner picks the validator, and so can relax
  enforcement). `CrafterLevels` keeps each Crafter's level, which the collection shows as a "Level" trait through its
  attributes extension (called with a fixed gas stipend, so it can't break the metadata).

The launch (`contracts/script/deploy-mainnet.sh`) has two stages, from one wallet:

1. `crafters` (`DeployCrafters.s.sol`): `CrafterArt`, then `MineWorldCrafters` (I'M DEGEN) with the sale closed, owned
   by `OWNER` (best deployed from `OWNER` itself: the script warns loudly otherwise). The mint runs; the owner then
   publishes the secret and seals at once (anyone can seal).
2. `launch` (`Deploy.s.sol`, `run()`): `MineHook` at a mined CREATE2 address (its constructor deploys both routers);
   `MineToken` (10.5M to the hook); `MiningSites`' implementation; `MineVault`, naming as its distributor the address
   `MiningSites`' proxy is about to get (the deploying wallet's next contract: a hard precondition the script checks,
   so the wallet sends nothing else meanwhile, and the stage broadcasts with `--slow`); the proxy, initialized in its
   constructor; the token's `setMinter(vault)`, then its `renounceOwnership()`; `MinePayments` (implementation and
   proxy); `openPool`, then the hook's `renounceOwnership()`. With `CRAFTERS` set, `CrafterLevels` too (or later, as
   the `levels` stage), and `setAttributesExtension(levels)` on I'M DEGEN if the deploying wallet owns it
   (otherwise the script prints the call for `OWNER`).

After the launch, `MineToken` and `MineHook` have no owner. `MineVault`, the three proxies and `MineWorldCrafters` are
owned by `0x6e85…70eD`.

**How the game uses each contract** (`web/` and `multiplayer/`, out of scope):

| Contract | Used for |
| --- | --- |
| `MineToken` | Balances; an exact approval before each payment; trading in the Mining Site panel |
| `MineHook`, `MineRouter`, `MineEthRouter` | The panel's trade box: buy and sell with IMD or ETH; price and market cap |
| `MiningSites` | Open a site, upgrade it (`upgradeSite(cost shown, rate shown)`), convert earnings with the server's voucher; the panel reads rates, caps, `claimable` |
| `MineVault` | Only through `MiningSites`; the panel shows `vaultBalance()` |
| `MinePayments` | The Smithy's shop (kind 0: the browser checks its own `Paid` event and adds the items to an inventory kept in the browser), rocket tickets (kind 1: the server checks the `Paid` event) and revives (kind 2, 420 $MINE: the game's side, out of scope, as tickets are) |
| `MineWorldCrafters` | Mint (free, wallets only, at most 3 per wallet: the panel offers no more and explains a refused fourth or a contract's `OnlyWallets`); the owner's "Reveal and lock in" sends `reveal(secret)` then `seal()`, retrying until the seed is set; anyone's "Lock in the reveal" sends `seal()` while `revealStatus()` is Sealable, and after a window nobody sealed in the owner's "Pick a new block" sends `moveEntropyOn` then `seal()`; the DEGEN a player wears is how their miner looks; the server reads `ownerOf` and `seed()` (rarity worked out off chain by `web/crafters.js`) |
| `CrafterLevels` | "Level up" in the panel (`upgrade(id, cost shown)`); the server reads `levelOf` |
| `CrafterArt` | Only through the collection's `tokenURI` (marketplaces) |

A Crafter's rarity and level boost what its holder earns on the server (faster breaking, more per block, a higher
daily earn cap). On chain they change nothing: every payout still goes through `MiningSites`' caps and the vault's
limits.

## 2. Scope

Repository https://github.com/AdamNakamoto/MineWorld, at the commit that adds section 11 (IMD Swarm's 0792975e ran on
`ba2a8ed`, its re-check 8c7ba957 on `49830f2`, its second re-check 52b534f9 on `4de227d` and its third re-check
10d532d5 on `25121ea`; sections 8 to 11 list what changed since). Solidity 0.8.26, via-IR, optimizer 200
runs, EVM `cancun` (transient storage: `MineHook`'s fee slot and OpenZeppelin's `ReentrancyGuardTransient`). Libraries
are the same commits Courier World uses: OpenZeppelin Contracts 5.4.0, Uniswap v4-core `46c6834`, forge-std 1.17.0.

Lines: all lines / code lines (neither blank nor comment). 3,629 / 2,470 in all (3,589 / 2,461 at `25121ea`, 3,533 /
2,443 at `4de227d`, 3,383 /
2,356 at `49830f2`, 3,184 / 2,262 at `ba2a8ed`).

| File | Lines | Origin | Role |
| --- | --- | --- | --- |
| `contracts/src/MineToken.sol` | 61 / 42 | Courier's `StampToken`, renamed | $MINE: 21M cap, one-shot minter, renounced at launch |
| `contracts/src/MineVault.sol` | 218 / 112 | New | The one minter: 35,000 a day, 10.5M in all, distributor change after 2 days, only to a contract its owner owns that follows the current one |
| `contracts/src/MiningSites.sol` | 637 / 404 | New (voucher check in the style of Courier's `TokenDrops`) | UUPS: sites, levels, rates, vouchers, caps, claims; a replacement's books carried over, levels as bought, from any predecessor (one without code: empty books) |
| `contracts/src/MinePayments.sol` | 119 / 74 | New | UUPS: shop, ticket and revive payments, burn share per kind |
| `contracts/src/CrafterLevels.sol` | 125 / 72 | New | UUPS: each Crafter's level, bought in $MINE; the "Level" trait |
| `contracts/src/MinePayer.sol` | 93 / 56 | New | Shared base: take a payment (burn share burned, rest to the treasury), treasury |
| `contracts/src/UpgradeCosts.sol` | 140 / 84 | New | Shared base: level costs, burn share, adding levels, `maxCost` |
| `contracts/src/lib/OwnedUUPS.sol` | 88 / 52 | New (OpenZeppelin's `Ownable2Step` logic in ERC-7201 storage) | Shared base: two-step ownership, no renounce, owner-only upgrades, each proxy set up only in its own constructor |
| `contracts/src/ICrafterAttributes.sol` | 17 / 7 | New | Interfaces between the Crafters and their attributes extension |
| `contracts/src/MineWorldCrafters.sol` | 693 / 425 | New, built on Courier's `CourierSkins` (see below) | The NFT, I'M DEGEN: mint (wallets only, 3 per wallet at launch), commit-reveal (secret published first, L2 block entropy, sealed by anyone within the window; after it, at most 3 public move-ons by the owner), traits, on-chain metadata, enforced royalty |
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
  wallets only, per-wallet limit, 3 at launch, 5 per transaction), the reveal (`reveal` and `setSaleOpen` no longer match
  `CourierSkins`': the owner publishes the secret, and the seed waits for the next L2 block's hash from ArbSys, set by
  anyone with `seal` within the window, after which only the owner can move it on, at most 3 times with
  `moveEntropyOn`; audit 0792975e #1, re-check 8c7ba957 #2, second re-check 52b534f9 #2 and #4), the user-visible names (the collection is I'M DEGEN), the traits
  (`_shuffle` on 12 bits for 3,333, combination index, weighted picks), the on-chain pictures and metadata, the
  attributes extension (a bounded raw `staticcall`, audit 0792975e #3) and `refreshMetadata`, the collection links and
  pictures, the treasury checks (never this contract; must take ETH, audit 0792975e #4), and that ownership can't be
  renounced.

### Out of scope

The tests, the scripts, `script/DevTransferValidator.sol` (local chains only), `web/`, `multiplayer/` and `tools/`
(among them `tools/sealer.sh`, the sealer anyone can run: it only sends `seal()`).

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
   which is `MiningSites`' proxy, initialised in its constructor (the only place `initialize` can ever run). **A hard
   launch precondition:** the script requires the proxy landed there (and `deploy-mainnet.sh` tells the deploying
   wallet to send nothing else meanwhile, and broadcasts with `--slow`, so a failed step stops everything after it,
   the token's renounce included), and `MiningSites.initialize` independently requires
   that the vault names it (its distributor, or for a later replacement its pending distributor) and
   `vault.token() == token`, so a wrong prediction reverts instead of wiring another contract (the vault would then
   name an address without code and need a new distributor, two days later, which a replacement can be: third re-check
   10d532d5 #1). A replacement works the same way round: propose the owner's own wallet's
   next CREATE address, then deploy the proxy there from that wallet, initialised (3.2); the scripts don't deploy one.
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
   to the deploying wallet only until they are renounced in the same run. I'M DEGEN goes to `OWNER` directly, or in
   two steps (`acceptOwnership`) if the deploying wallet sets it up first (a wallet limit other than 3, links,
   pictures or an open sale). When the broadcasting wallet isn't `OWNER`, `DeployCrafters` prints a loud warning
   (`OWNER` must make the printed `acceptOwnership` right away; deploying from `OWNER` itself is recommended, and
   `deploy-mainnet.sh crafters` says so before it signs), and it always ends by printing `owner()` and
   `pendingOwner()`. Costs other than the defaults
   (`SITE_UPGRADE_COSTS`, `CRAFTER_UPGRADE_COSTS`) are set right after initialization only when the deploying wallet
   is `OWNER`.
7. **The reveal secret** never reaches the scripts: `deploy-mainnet.sh` passes only
   `SEED_COMMIT = keccak256(abi.encode(uint256 secret))`.
8. **OpenSea's registry needs nothing registered on chain.** A collection that never configured anything there gets
   the registry's default list (list 0), whose one authorizer is OpenSea's SignedZone (`getAuthorizerAccountsByCollection`
   on Robinhood Chain, and `test_Fork_EnforcedWithoutRegistering`). `DeployCrafters` prints the owner's launch steps:
   announce the reveal time so holders can run `tools/sealer.sh`; turn on creator earnings in OpenSea Studio, which
   lets only `owner()` edit the collection (its ownership can never
   be renounced; never hand it to a contract wallet that can't sign in there); and how the reveal goes (close, then
   publish the secret and seal at once, from the panel or with a one-line `cast send` sequence; the owner-only
   `moveEntropyOn` after a window nobody sealed in). It logs the collection as `MineWorldCrafters <address>` (I'M DEGEN).

### Tests

`forge test` on this commit: **254 passed, 10 skipped, 264 in 26 suites** (the 10 are fork tests, which skip without a
Robinhood Chain fork; all 10 pass on one). At `25121ea` it was 243 passed, 10 skipped; at `4de227d`, 235 and 10; at
`49830f2`, 225 and 9; at `ba2a8ed`, 205 and 8.

| Suite | Tests | Covers |
| --- | --- | --- |
| `MineTokenTest` | 8 | Cap, one-shot minter, renounce, no other powers, untaxed transfers (fuzz), permit domain |
| `GameDeployTest` | 4 | `_deployGame`: wiring, renounce, defaults, costs from the environment, CrafterLevels |
| `MineVaultTest` | 11 | Daily and total limits, 300 days, distributor delay, cancel and replace, only a contract the owner owns takes over, sweep, no renounce |
| `MineVaultInvariantTest` | 2 invariants + 1 | Never above 35,000 a day across distributor changes; the books add up |
| `MiningSitesTest` | 53 | Sites, upgrades (`maxCost`, `minRateBps`), rates, vouchers, caps, rounding, pause, initializers (only in the proxy's own constructor, never later), a treasury that must take ETH, a UUPS upgrade keeping everything |
| `DistributorRaceTest` | 4 | Audit 0792975e #2: the auditor's two proofs, a proxy left uninitialised can never be set up, the safe replacement path end to end |
| `HijackNamesOwnerTest` | 1 | Re-check 8c7ba957 #1: the auditor's proof (a stranger's proxy naming the vault's owner) |
| `ReplacementResetsSettledTest` | 1 | Re-check 8c7ba957 #3: the auditor's proof (a replacement doesn't pay converted earnings again) |
| `ReplacementTest` | 7 | Re-check 8c7ba957 #3, #4 and second re-check 52b534f9 #3: books carried over through a chain of replacements, a level above the new top kept (and earning the top rate), kept through a hop and restored by `addLevel`, kept through three hops, per-day counters, a retired distributor sells nothing, a predecessor must keep books |
| `FakeVaultHijackTest` | 1 | Second re-check 52b534f9 #1: the auditor's proof (a stranger initialises the owner's proposed, uninitialised proxy with a vault of its own, upgrades it to code that answers the vault's checks, and is accepted) |
| `StrangerInitializesWithOwnVaultTest` | 1 | 52b534f9 #1, the variant: the same with a real `MineVault` of the stranger's own |
| `CodelessDistributorProofTest` | 1 | Third re-check 10d532d5 #1: the auditor's proof (a vault whose distributor has no code is still given a working one) |
| `CodelessPredecessorTest` | 2 | 10d532d5 #1: the codeless predecessor's books read as empty, then sites and claims work; one with code must still answer `bookOf` |
| `LateInitProofTest` | 2 | 10d532d5 #2: the auditor's proof (nobody sets up a `CrafterLevels` or `MinePayments` proxy deployed without its setup) and the shared guard's error |
| `MiningSitesInvariantTest` | 5 invariants + 1 | Never pays more than signed or worth; daily caps; forged vouchers never pay; upgrades burn and pay the treasury; vault books |
| `MinePaymentsTest` | 10 | Split (fuzz), kinds (shop, ticket and revive at launch; a revive all to the treasury), treasury (one without ETH is fine: $MINE only), owner-only, upgrade keeps kinds, initializers |
| `CrafterLevelsTest` | 18 | Holder-only upgrades, `maxCost` against an unlimited approval, levels stay with the token, costs and burn, extension, refresh, upgrade keeps levels |
| `MineWorldCraftersTest` | 49 | Mint rules (3 per wallet at launch, the fourth refused), `revealStatus`'s 30-block margin while `seal` takes the whole window (fuzz), the reveal (secret first, the next block's hash, `seal` by anyone within the window, a seal within it always fixing the seed (fuzz), after it only the owner moving on, at most 3 times, nobody knowing first), renounce leaving the owner in place, the ArbSys path with a mock (the next L2 block, a parent-chain skip, expiry, a failing call), enforcement and relaxing it, royalty, the treasury check, metadata (I'M DEGEN) and every misbehaving extension, links, interfaces, `tokensOfOwner` gas |
| `SybilMintTest` | 4 | 10d532d5 #3: the auditor's sweep through 100 throwaway contracts reverts (the attacker holds 0), a contract can't mint, a wallet still mints 3, an EIP-7702 account mints as itself within the limit |
| `RevealSeedTest` | 2 | Audit 0792975e #1: the auditor's proof, adapted to the current flow, and the grind over 52 reveal blocks |
| `CrafterArtTest` | 19 | Pictures, traits and `tokenURI` equal to the JS's, shuffle bijection (fuzz), uniqueness, Base64 (fuzz), gas |
| `MineHookImdFirstTest`, `MineHookImdSecondTest` | 26 + 26 | The hook and routers against a real v4 `PoolManager`, with IMD as currency0 and as currency1 |
| `MineHookForkTest`, `LaunchForkTest` | 2 + 1 (fork) | ETH routing through the real pools; a blocked fee recipient moves its fees; the whole launch script |
| `MineWorldCraftersForkTest` | 7 (fork) | OpenSea's live registry: holder transfers, authorized sales, strangers, unauthorized marketplaces, enforced with nothing registered; ArbSys at 0x64 (L2 numbers, not the parent chain's); `tokenURI` |

```bash
cd contracts && git submodule update --init --recursive && forge test
forge test --fork-url https://robinhood.drpc.org     # adds the 10 fork tests
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
  (`NotAContract`), its `owner()` is the vault's owner (`NotOwnersDistributor`), its `vault()` is this vault
  (`WrongVault`) and its `predecessor()` is the current distributor (`NotASuccessor`); each read through the minimal
  `IDistributor` by `_read`, a static call whose answer counts only if it is one word holding an address, else 0,
  which never matches),
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
6. Ownership can't be renounced, so a distributor can always be replaced, whatever it is: one without code too (a
   predicted address nothing was deployed at; third re-check 10d532d5 #1), which the replacement records as its
   predecessor without calling it, with empty books.
7. Hence 10,500,000 can't be minted over fewer than 300 UTC days.
8. **Only a contract owned by the vault's owner, paying from this vault and following the current distributor can
   become the distributor** (audit 0792975e #2, re-check 8c7ba957 #1): an empty address, an uninitialised proxy
   (`owner()` is 0), a contract for another vault or one following another distributor is refused at
   `acceptDistributor`; a pending distributor can't mint. `MiningSites.initialize` runs only in the proxy's own
   constructor, never later, by anyone (second re-check 52b534f9 #1; since third re-check 10d532d5 #2 the guard is
   `OwnedUUPS.__Owned_init`'s, shared by every proxy of the family), so a proxy is set up by whoever deploys it, with
   the arguments they choose, and nobody can make a proxy someone else deployed theirs. The three reads are answered
   by the candidate's own code: they catch mistakes (a wrong vault, owner or predecessor), not a contract built to lie.
   So the owner proposes only its own wallet's next CREATE address, where nobody else can deploy, and deploys the
   proxy there itself; then no stranger's vault, signer or treasury can reach this vault.

**Admin powers.** Choose the distributor (two-day delay), sweep strays, hand over ownership. The owner can't mint,
raise a limit or upgrade the vault.

**Known and accepted.**
- The distributor decides who is paid, within the limits: a bad distributor could mint up to 35,000 a day to
  whomever it likes. That is no more than the owner can already reach through `MiningSites` (its signer, or an
  upgrade), so the delay gives notice rather than extra protection.
- A proposal doesn't expire: once its two days are over it can be accepted at any later time (`pendingDistributor`
  shows it until then).
- **Replacing the distributor** (a new MiningSites proxy rather than an upgrade in place), as the vault's NatSpec
  sets out: deploy the implementation; `proposeDistributor(P)` with P the address the owner's own wallet's next
  CREATE will get (nothing there yet, and nobody else can deploy there); deploy the `ERC1967Proxy` at P from that
  wallet with `initialize` in its constructor, naming this vault and its owner (`MiningSites.initialize` accepts the
  vault's pending distributor as well as its distributor, and records the current one as its predecessor); two days
  later `acceptDistributor()`. A proxy deployed without `initialize` in its constructor can never be set up: propose
  another. The owner must not propose a contract someone else deployed: its answers to the vault's reads are its own
  code's (the implementation-slot pin was considered: no contract can read another's storage, and a getter on the
  candidate is answered by its possibly swapped code, so it would prove nothing). If the vault changes hands, a
  replacement must name the new owner; if another distributor is accepted in between, the replacement follows the
  wrong one and is refused. The current distributor can be anything: one without code (the launch's predicted address,
  had the proxy missed it) is recorded without a call, and its books read as empty; one with code must answer `bookOf`
  (`BadPredecessor`), so a contract that isn't a MiningSites would need an implementation that tolerates it.
- 300 UTC days, not 300 × 24 hours: the first and last days can be partial (35,000 just before midnight and 35,000
  just after).

**Tests.** `MineVaultTest` (11, including `test_OnlyAContractTheOwnerOwnsTakesOver`), `MineVaultInvariantTest`
(`invariant_NeverMoreThanTheDailyLimit`, `invariant_Books`, over random releases by three distributors, proposals,
cancels, accepts and time), `DistributorRaceTest` (4: the auditor's `test_replacementDistributorCannotBeHijacked` and
`test_hijackerMintsFromTheVault`, `test_aProxyLeftUninitialisedCanNeverBeSetUp`, `test_safeReplacementPath`),
`HijackNamesOwnerTest`, `FakeVaultHijackTest`, `StrangerInitializesWithOwnVaultTest`, `CodelessDistributorProofTest`,
`CodelessPredecessorTest`, `ReplacementTest`,
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
  `_authorizeUpgrade`, only to an implementation whose `proxiableUUID` is the ERC-1967 slot); internal
  `__Owned_init(owner)`, the first step of every `initialize` in the family, which reverts
  `InitializeOutsideConstructor` unless `address(this).code.length == 0`, i.e. inside the proxy's own constructor (a
  future upgrade's reinitializer wouldn't call it). Errors and events are `Ownable2Step`'s, plus `CannotRenounce` and
  `InitializeOutsideConstructor`.
- `MinePayer`: `token()`, `treasury()`, `setTreasury(t)` (owner; never 0 nor the contract itself; then the virtual
  hook `_checkTreasury(t)`, empty here, which `MiningSites` overrides to require that `t` take ETH). Internal
  `_collect(payer, amount, burnBps)`: `burnFrom(payer, amount × burnBps / BPS)` (rounded down) on $MINE, then
  `safeTransferFrom(payer, treasury, rest)`; either step is skipped when it is 0.
- `UpgradeCosts`: `maxLevel()` (= costs + 1), `upgradeCost(level)` (2 to `maxLevel()`), `upgradeCosts()`,
  `upgradeBurnBps()`; owner: `setUpgradeCosts(costs)` (same count, each 1 wei to the contract's `MAX_UPGRADE_COST`),
  `setUpgradeBurnBps(bps)` (≤ 10,000). Internal `_addLevel(cost)` (up to `MAX_LEVELS` = 20 levels in all),
  `_nextLevel(level, maxCost)` (the next level and its cost; reverts `MaxLevel` at or past the top and
  `CostAboveMax(cost, maxCost)` if the cost is above the caller's `maxCost`), `_payUpgrade`, `_burnShare`.

**Guarantees to check.**
1. **Only the owner can upgrade, and an upgrade keeps all state:** no field lives outside its namespace, no two
   namespaces overlap, and a later version can add fields at the end of a struct without moving anything.
2. **Implementations can't be initialized** (every implementation's constructor calls `_disableInitializers()`) or
   upgraded directly (`onlyProxy`); each proxy's `initialize` runs once, inside the proxy's constructor
   (`OwnedUUPS.__Owned_init`, the first step of `MiningSites`', `MinePayments`' and `CrafterLevels`' `initialize`,
   enforces it: outside the proxy's own constructor nobody can set a proxy up; third re-check 10d532d5 #2).
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
openedAt`, `uint8 level`, the level as bought, which a replacement can carry above its own `maxLevel()`; both 0 = no
site), `claimed[player]` ($MINE paid in all), `settled[player]` (earnings
converted in all, 18 decimals like a voucher's total), `paidDay` and `walletDay[player]` (`uint64 day`,
`uint192 paid`), then (appended for re-check 8c7ba957 #3) `predecessor` (the distributor a replacement follows; 0 for
the first) and `imported[player]` (books carried over). Constants: `MAX_WALLET_DAILY_CAP = 3_500e18`, `MAX_UPGRADE_COST = 1_000_000e18`,
`MIN_RATE_BPS = 1_000`, `EARNINGS_TYPEHASH = keccak256("Earnings(address player,uint256 total,uint64 deadline)")`.

**Functions.**
- `initialize(token, vault, owner, treasury, signer, sitePrice, walletDailyCap, dailyCap)` (once): reverts
  `InitializeOutsideConstructor` unless it runs in the proxy's own constructor (`__Owned_init`, its first step:
  `address(this).code.length == 0`), whoever calls it; its arguments, `vault` included, are trusted because whoever deploys the proxy chooses them; costs 4,620, 18,942, 77,662 and 318,415 $MINE to reach levels 2-5, burn 7,500 BPS,
  rates 5,000, 6,000, 7,000, 8,500 and 10,000; reverts `BadVault` unless the vault mints `token` and names this proxy
  its distributor or its pending distributor; a pending one records the vault's current distributor as its
  `predecessor` (`PredecessorSet`), which must answer `bookOf` (`BadPredecessor`) unless it has no code at all: then
  it is recorded without a call and its books read as empty (third re-check 10d532d5 #1); `TreasuryRefusesEth` unless the
  treasury takes a call with no ETH; `sitePrice > 0`; caps checked as in `setCaps`.
- `openSite()`, `upgradeSite`, `claim` all first require this to be the vault's distributor (`NotActive`: retired, or
  a replacement not yet accepted), then import the caller's books from the predecessor if they weren't yet (`_import`:
  site opened-at and level as bought (bounded only by `MAX_LEVELS`, 20, as a bound on what's stored), `settled` and
  `claimed`, each the higher of the two; `Imported`).
- `openSite()` (anyone without a site, payable, `nonReentrant`): exactly `sitePrice`; level 1; then sends the
  contract's whole ETH balance to the treasury. No `receive`: plain ETH is refused. A site carried over is open
  (`AlreadyOpen`).
- `upgradeSite(maxCost, minRateBps)` (a site's holder, `nonReentrant`): one level up, to at most `maxLevel()` (a level
  carried over at or above the top reverts `MaxLevel`), for
  `upgradeCost(level + 1)` from the caller's wallet through `_collect` (burn share burned, the rest to the treasury);
  reverts `CostAboveMax` if that cost is above `maxCost`, `RateBelowMin` if the new level's rate is below
  `minRateBps`. Works while paused.
- `claim(total, deadline, signature)` (a site's holder, `nonReentrant`): reverts `NoSite`, `IsPaused`, `Expired`
  (after `deadline`), `BadSignature` (any signature that doesn't recover to `signer` over
  `(msg.sender, total, deadline)`, malformed ones included, via `ECDSA.tryRecover`), `NothingToClaim`. Then `_quote`:
  `earnings = total − settled` (0 if `total ≤ settled`), `full = earnings × rate / BPS` (rounded down; `rate` is
  `_siteRate(level)`, the level's rate, or the top level's for a level above the top), `amount` =
  the least of `full`, the wallet's room today, everyone's room today and `vault.roomToday()`. Paid in full, all of
  `earnings` is settled; held back, only `ceil(amount × BPS / rate)` is. Updates `claimed`, `settled` and both day
  totals, emits `Claimed`, then `vault.release(msg.sender, amount)`.
- Views: `bookOf(player)` (opened-at, level, `settled`, `claimed` as this contract counts them: its predecessor's,
  read through any chain of replacements, until imported; a predecessor without code adds nothing), `predecessor()`, `claimable(player, total)` (what `claim`
  would pay now; 0 without a site, while paused, or while not the vault's distributor), `rateBps` (`_siteRate`:
  `levelRateBps(min(level, rates.length))`), `levelRateBps` (0 for no such level), `rates`, `siteOf`, `hasSite`,
  `siteLevel` (the level as bought), `claimed`, `settled` (these five through `bookOf`), `paidToday`,
  `walletPaidToday`,
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
   the caller's wallet, never more than its `maxCost`, never for a rate below its `minRateBps`.
7. `rates().length == maxLevel()` at all times, rates are non-decreasing by level and within 10%-100%, so every site
   has a rate; a level above the top (carried over from a predecessor with more levels) earns the top rate.
8. Pausing stops claims only; nothing earned or settled is lost.
9. **A UUPS upgrade keeps every site, level, `claimed`, `settled`, day total, cap, rate and cost, and only the owner
   can upgrade; implementations can't be initialized, and a proxy only in its own constructor.**
10. **A replacement never pays converted earnings again** (re-check 8c7ba957 #3): its `settled` for a player is never
    below the predecessor's (through any chain), from the first moment it can pay; a replaced contract sells and pays
    nothing (`NotActive`, re-check #4), so the predecessor's books are final when they're imported. A predecessor
    without code never paid anyone, so its empty books are exact.
11. **A level paid for is never lost to a replacement** (second re-check 52b534f9 #3): `bookOf` and `_import` carry
    it as bought through any number of hops; above the new top it earns the top rate, and once `addLevel` reaches it,
    its own.

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
- A rate lowered just before a player's claim applies to it. A cost raised, or a rate cut, just before an upgrade
  doesn't: the upgrade reverts if the cost is above the `maxCost` or the new level's rate below the `minRateBps` the
  player sent (the game sends what it showed).
- At a replacement the per-day counters (`paidToday`, `walletPaidToday`) restart: on the day of the switch a wallet
  can be paid its daily cap on each contract. The vault's 35,000 a day still holds across it. Levels above the new
  contract's top are kept as bought and earn its top rate; they can't be upgraded until the top passes them, and
  `addLevel` restores their own rate.
- The treasury check is a plain call with no ETH: a contract whose fallback takes calls but not ETH would pass it and
  still block `openSite`. The owner is trusted not to choose one (the launch treasury is a wallet).
- The shared daily cap is first come, first served. `NothingToClaim` also covers "today's caps are used up".
- The site price is in ETH and the costs in $MINE, set by hand; they can lag the market.
- Sites can't be moved to another wallet.

**Tests.** `MiningSitesTest` (53, including `testFuzz_ClaimableMatchesWhatClaimPays`,
`test_CappedClaimsSettleOnlyWhatTheyCover`, `test_CappedClaimsRoundInTheVaultsFavour`,
`test_VouchersAreBoundToThisContract`, `test_SignaturesMustBeTheSignersForThisWalletAndTotal`,
`test_InitializersAreLocked`, `test_UpgradeKeepsEverything`, `test_TreasuryCantReenter`, `test_TreasuryMustTakeEth`,
`test_RaisedCostRevertsForAnExactApproval`, `test_RaisedCostRevertsEvenWithAnUnlimitedApproval`,
`test_RateCutMinedFirstRevertsTheUpgrade`, `test_InitializeOnlyInTheConstructor`),
`DistributorRaceTest` (4), `HijackNamesOwnerTest`, `FakeVaultHijackTest`, `StrangerInitializesWithOwnVaultTest`,
`CodelessDistributorProofTest`, `CodelessPredecessorTest`, `ReplacementResetsSettledTest`, `ReplacementTest` (7, including `test_ALevelAboveTheNewTopIsKept`,
`test_LevelPaidForIsKeptThroughAHopAndAfterAnImport`, `test_ALevelSurvivesThreeHops`), and `MiningSitesInvariantTest` (random opens, upgrades, earnings, claims, forged vouchers,
cap and rate changes, pauses, stray transfers and time, across six wallets).

### 3.5 MinePayments (`contracts/src/MinePayments.sol`)

Files: `MinePayments.sol`, `lib/OwnedUUPS.sol`, `MinePayer.sol`, `MineToken.sol`.

**Purpose.** What players pay the game in $MINE: the shop, rocket tickets and revives. Prices live in the game's config, not
here; the contract takes the payment, burns the kind's share and records it in a `Paid` event that the game checks.

**State** (namespace `mineworldcraft.storage.MinePayments`, slot
`0xba35f12e5ac9557c7ad18bdb329ca09fcdbd411d9cbd7d9c10a0623b3b0df300`): `Kind[] kinds` (`string name`,
`uint16 burnBps`). Constants `MAX_KINDS = 32`, `KIND_SHOP = 0`, `KIND_TICKET = 1`, `KIND_REVIVE = 2`.

**Functions.**
- `initialize(token, owner, treasury)` (once, only in the proxy's own constructor: `OwnedUUPS`): the kinds at
  launch, 0 "shop" (7,500 BPS burned), 1 "ticket" (0) and 2 "revive" (0: the game's 420 $MINE revive on the spot after
  dying on the home planet, all to the treasury, as the owner chose).
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
4. A UUPS upgrade keeps every kind; only the owner upgrades; the implementation can't be initialized, nor a proxy
   after its constructor.

**Admin powers.** Burn shares, new kinds, the treasury, ownership, upgrades.

**Known and accepted.**
- The contract doesn't know prices or what was bought. Tickets are checked off chain from the `Paid` event (section
  2); `ref` isn't checked for uniqueness on chain (the server keys tickets by transaction hash).
- Shop items are delivered by the browser, which checks its own `Paid` event and keeps the inventory in local
  storage; a player can edit their own browser. The server's checks assume the best tool and weapon anyway.

- Revives, like tickets, are the game's to check (out of scope): the contract only takes the payment and records the
  `Paid` event.

**Tests.** `MinePaymentsTest` (10, including `testFuzz_SplitAddsUp`, `test_RevivesGoToTheTreasury`,
`test_UpgradeKeepsKindsAndOnlyTheOwnerUpgrades`), `LateInitProofTest`.

### 3.6 CrafterLevels (`contracts/src/CrafterLevels.sol`, `contracts/src/ICrafterAttributes.sol`)

Files: those two, the shared base (3.3), `MineToken.sol`, `MineWorldCrafters.sol` (which it reads and refreshes).

**Purpose.** Each Crafter's level (1 to `maxLevel()`), bought with $MINE by its holder. The level belongs to the
token. The collection shows it as the "Level" trait through `attributesOf`, once its owner points the collection here
(`setAttributesExtension`).

**State** (namespace `mineworldcraft.storage.CrafterLevels`, slot
`0xe0a943f71e53fafb9d333d84c4ad333a9962fba804a4b3a6ad3558ab82f56700`): `crafters` (the collection),
`levels[tokenId]` (uint8; 0 reads as 1). Constant `MAX_UPGRADE_COST = 2_000_000e18`.

**Functions.**
- `initialize(token, crafters, owner, treasury)` (once, only in the proxy's own constructor: `OwnedUUPS`): costs 2,310, 9,471, 38,831 and 159,207 $MINE to reach
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
5. A UUPS upgrade keeps every level; only the owner upgrades; the implementation can't be initialized, nor a proxy
   after its constructor (third re-check 10d532d5 #2).

**Admin powers.** Costs, burn share, more levels, treasury, ownership, upgrades.

**Known and accepted.** The owner could change levels in a new version. Levels raise a player's boost on the server
only (bounded by the server's caps and, for $MINE, by `MiningSites` and the vault). Levels can be bought before the
collection points here; `setAttributesExtension` then refreshes every Crafter. Its treasury needn't take ETH (it is
paid only in $MINE), so it has no ETH check, nor has `MinePayments`.

**Tests.** `LateInitProofTest`, `CrafterLevelsTest` (18, including `test_OnlyTheHolderUpgrades`, `test_LevelStaysWithTheCrafter`,
`test_UpgradeKeepsEveryLevel`, `test_UpgradesBeforeTheCollectionIsWired`, `test_UnreadableExtensionAddsNothing`,
`test_RaisedCostRevertsEvenWithAnUnlimitedApproval`).

### 3.7 MineWorldCrafters (`contracts/src/MineWorldCrafters.sol`)

Files: `MineWorldCrafters.sol`, `ICrafterAttributes.sol`, `CrafterArt.sol`, `lib/FastBase64.sol`.

**Purpose.** The NFT, I'M DEGEN (`name()` "I'M DEGEN", `symbol()` "DEGEN"; tokens "I'M DEGEN #id"): 3,333 Crafters (DEGENs),
blind mint, commit-reveal, traits, fully on-chain metadata and pictures, enforced 5% royalty.

**State.** Not a proxy. OpenZeppelin `ERC721`, `ERC2981`, `Ownable2Step`, then `price`, `walletLimit` (3),
`saleOpen`, `revealedSecret` (public from `reveal` on), `entropyBlock` (the chain block whose hash completes the
seed; 0 until `reveal`), `entropyMoves` (how often the owner moved it on), `totalMinted`, `mintedBy`, `treasury`, `seed` (0 until sealed),
`transferValidator`, `website`, `social`, `collectionImage`, `bannerImage`, `customContractURI`,
`attributesExtension`. Immutables `art`, `seedCommit`. Constants `MAX_SUPPLY = 3333`, `MAX_PER_TX = 5`,
`MAX_WALLET_LIMIT = 50`, `ROYALTY_BPS = 500`, `MAX_LINK = 256`, `EXTENSION_GAS = 300_000`,
`MAX_EXTRA_ATTRIBUTES = 4_096`, `ARB_SYS = address(100)`, `ENTROPY_WINDOW = 256`, `MAX_ENTROPY_MOVES = 3`,
`SEAL_MARGIN = 30`. Enum
`RevealStatus` (None, Waiting, Sealable, Expired, Revealed, Stuck).

**Functions.**
- `mint(quantity)` (a wallet while the sale is open): reverts `OnlyWallets` unless `msg.sender == tx.origin` (no
  contract mints; an EIP-7702 account sending its own transaction mints as itself); 1-5, within `MAX_SUPPLY` and the
  minter's `walletLimit`
  (counted per minting address, `WalletLimit`; 3 at launch, so a wallet's fourth mint reverts), exactly `price × quantity` (0 while free); ids `totalMinted + 1` onward via `_mint`
  (no receiver callback); then the whole ETH balance goes to the treasury.
- The chain block: `_chainBlock()` is `ArbSys(0x64).arbBlockNumber()` (the L2 block number on Robinhood Chain), and
  `_chainBlockHash(b)` is `ArbSys.arbBlockHash(b)`, reverting `EntropyUnavailable` on 0; where 0x64 has no code (a
  local chain) they are `block.number` and `blockhash`. A failing ArbSys call reverts the transaction: there is no
  fallback except a missing ArbSys. `chainBlock()` is the public view.
- `setSaleOpen(open)` (owner): a pause until the reveal; reverts `AlreadyRevealed` once the secret is public.
- `reveal(secret)` (owner, once): requires the sale closed (`SaleStillOpen`) and
  `keccak256(abi.encode(secret)) == seedCommit` (`BadSecret`); stores `revealedSecret = secret` and
  `entropyBlock = _chainBlock() + 1` (the next block), emits `SecretRevealed(secret, entropyBlock)`. Sets no seed.
- `seal()` (anyone): reverts `AlreadyRevealed` once the seed is set, `NoSecret` before `reveal`, `RevealTooSoon`
  while `_chainBlock() ≤ entropyBlock`, `EntropyExpired` once `_chainBlock() − entropyBlock > ENTROPY_WINDOW` (the
  hash can't be read any more). Otherwise sets `seed = keccak256(abi.encode(revealedSecret,
  _chainBlockHash(entropyBlock)))`, never 0, emits `Revealed` and `BatchMetadataUpdate(1, totalMinted)` and returns
  the seed. Expiry is decided from the block numbers alone, never from a failed call.
- `moveEntropyOn()` (owner only): after a window nobody sealed in (`_chainBlock() − entropyBlock > ENTROPY_WINDOW`,
  else `NotExpired`; `AlreadyRevealed` and `NoSecret` as for `seal`), at most `MAX_ENTROPY_MOVES` times in all
  (`NoMovesLeft`): `entropyMoves += 1`, `entropyBlock = _chainBlock() + 1`, emits `EntropyBlockMoved(entropyBlock,
  moves)`. After the third move's window passes unsealed, the reveal is stuck for good.
- `revealStatus()`: None (no secret yet), Waiting, Sealable (only while `_chainBlock() − entropyBlock <
  ENTROPY_WINDOW − SEAL_MARGIN`, i.e. with 30 blocks, about 3 seconds, to spare, longer than a transaction takes to be
  sequenced, so a seal sent on seeing it lands in the window; `seal` itself takes the whole window), Expired (the
  window is over or in its last 30 blocks), Revealed, Stuck (expired with no
  move left), for bots and the game's panel (a client can't compare block numbers itself: the entropy block is an L2
  block).
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
- Owner: `setSaleOpen`, `reveal`, `moveEntropyOn` (above), `setPrice` (any, 0 = free), `setWalletLimit` (1-50), `setTreasury` (≠ 0, ≠ this,
  must take a call with no ETH, as the constructor checks too: `TreasuryRefusesEth`; moves the 5% royalty with it),
  `setTransferValidator` (a contract; no interface check, see section 8 #6), `setLinks`, `setCollectionImages`
  (each ≤ 256 bytes, no `"`, `\` or control characters),
  `setContractURI` (anything; "" restores the built-in JSON), `setAttributesExtension` (a contract or 0; emits
  `BatchMetadataUpdate`), `transferOwnership` / `acceptOwnership`. `renounceOwnership` always reverts
  (`CannotRenounce`), and `transferOwnership(0)` only cancels a pending transfer.

**Guarantees to check.**
1. **Supply and payment:** at most 3,333 tokens, ids 1-3,333, only through `mint` by a wallet sending its own
   transaction (never a contract: third re-check 10d532d5 #3) while the sale is open, with exactly
   `price × quantity`; the payment reaches the treasury in the same call; nothing is ever left in the contract.
2. **Fair reveal** (audit 0792975e #1, re-check 8c7ba957 #2 and #6): nobody, minter or owner, can mint knowing any
   token's look (the secret isn't public and the entropy block doesn't exist while anyone can mint); **when the owner
   publishes the secret, the entropy block doesn't exist yet**, so choosing when to reveal picks nothing it can see;
   on Robinhood Chain the entropy is an L2 block's own hash (ArbSys), never `blockhash` of a parent-chain number,
   which Nitro can return stale when that number skips; **once the entropy block is over, everyone has the same two
   public inputs and anyone can seal**, so no party knows the looks before everyone can, and the owner can't hold them
   back; the seed doesn't depend on when, or by whom, `seal` is sent within the window; **a stranger can't re-roll**
   (second re-check 52b534f9 #2): past the window `seal` reverts, only the owner can move the entropy block on, at
   most 3 times, each in public, and any seal within a window fixes the seed for good; after `reveal` the sale never
   reopens, and after the seal the looks never change.
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
6. **ERC-4906:** every change to what `tokenURI` returns is announced: the seal, `setAttributesExtension`, and
   (through `refreshMetadata`) `CrafterLevels.upgrade` and `addLevel`.
7. The owner can't move anyone's Crafters, hold or redirect a holder's ETH, change the art, the traits, the rarity,
   the reveal's entropy once it exists (bar re-rolling a window nobody sealed in, 3 times at most, in public), or the
   5% rate. Ownership can never be renounced, so OpenSea Studio, which lets only `owner()` edit the collection, stays
   usable. The treasury always takes a plain call (checked when set), so
   it can't block paid mints (audit 0792975e #4).

**Admin powers.** As listed; none ends (ownership can't be renounced, so the links, price and validator stay
manageable, and so does OpenSea Studio), except the sale, `reveal` and `moveEntropyOn`, which end with the reveal.
Anyone can `seal` within the window.

**Known and accepted.**
- **The reveal's entropy, and the trust left in it.** The seed is the published secret mixed with the hash of the L2
  block after the reveal's, set by anyone. What remains: (a) Robinhood Chain's sequencer produces the L2 blocks, so it
  could in principle steer the entropy block's hash (or, seeing the secret in the reveal transaction, order the next
  block to its liking); (b) ArbSys gives a block's hash for 256 L2 blocks, measured at 26 seconds on Robinhood Chain
  (~0.1 s blocks, steady over 864,000 blocks): if nobody seals in that time, `seal` reverts `EntropyExpired` and
  only the owner can move the entropy block on (`moveEntropyOn`), at most 3 times in all, each on chain
  (`EntropyBlockMoved`), where everyone can compute the seed the expired block would have given. So the owner holds
  one lever: let a window pass and re-roll, up to three times, in public; anyone who seals in time stops it. As the
  owner alone knows when it will reveal, and Robinhood Chain has no public mempool, in practice the owner decides
  whether a window is sealed unless others watch for it: the owner announces the reveal time and anyone can run
  `tools/sealer.sh`, which watches for `SecretRevealed` and `EntropyBlockMoved` and sends `seal()` in the next L2
  block, retrying until the seed is set (third re-check 10d532d5 #4). The owner gets a best of four at most, and every
  move is public. The honest path seals at once: the panel's "Reveal and lock in" sends `reveal` and then `seal()` itself, retrying until
  the seed is set, `dev.sh` does the same, and the deploy notes give a one-line `cast send` sequence. After the third
  move's window passes unsealed the reveal is stuck for good: the Crafters stay sealed but keep trading. A fallback
  was weighed and rejected: anything that sets a seed without a fresh block hash is either known in advance from the
  published secret (anyone could work out the looks before the seal) or depends on when the owner sends it (a choice
  it could steer), whereas a stuck reveal takes nothing that refusing to reveal didn't already; (c) on a chain without
  ArbSys, `block.number` and `blockhash` stand in (local chains only). A lost secret means the Crafters stay sealed.
- If the mint doesn't sell out, the collection ends smaller: there is no mint after the reveal.
- The wallet limit (3 at launch; 1-50 with `setWalletLimit`, bounds kept: 50 caps what the owner can open up, and 1
  keeps the mint possible) counts per minting address; several wallets get several allowances. The mint is free at
  launch, and for wallets only (`OnlyWallets`, the owner's choice after third re-check 10d532d5 #3): one transaction
  can't sweep it through throwaway contracts, each a fresh address under the limit. A determined bot then needs a
  funded wallet and a transaction for every 3 DEGENs (accepted). An account delegated with EIP-7702 still mints as
  itself, within the same limit per address. Smart-contract wallets (a Safe, ERC-4337 accounts) can't mint; they can
  buy.
- **Ownership can never be renounced**, so OpenSea Studio, which lets only the contract's `owner()` edit the
  collection's own fields (links, description, banner, creator earnings), always works; the on-chain `contractURI`
  (`setLinks`, `setCollectionImages`, or the owner's override) is the fallback. Handing ownership to a contract wallet
  that can't sign in to OpenSea Studio would lose that editing (the README and the deploy script warn; check a
  multisig there first).
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

**Tests.** `SybilMintTest` (4: the auditor's sweep adapted, `test_AContractCantMint`, `test_AWalletStillMintsThree`,
`test_ADelegatedAccountMintsAsItselfWithinTheLimit`), `MineWorldCraftersTest` (49, including
`testFuzz_SealableLeavesAMarginButSealTakesTheWholeWindow`, `test_ThreePerWalletAtLaunch`, `test_RevealNeedsTheSecretAndEndsTheSale`,
`test_TheSaleIsAPauseUntilTheSecretIsOut`, `test_OwnerCantMintKnowingTheLooks`,
`test_SeedComesFromTheSecretAndTheNextBlock`, `test_NoPartyKnowsTheLooksBeforeEveryoneCan`,
`test_AStrangerCantMoveTheEntropyBlockOn`, `test_TheOwnerMovesOnAtMostThreeTimes`,
`testFuzz_ASealWithinTheWindowAlwaysFixesIt`, `test_AnExpiredEntropyBlockMovesOn`, `test_RenounceReverts`,
`test_Arbitrum_TheEntropyIsTheNextL2Block`,
`test_Arbitrum_AParentChainSkipChangesNothing`, `test_Arbitrum_ExpiryMovesTheEntropyBlockOn`,
`test_Arbitrum_AFailingCallNeverMovesTheEntropyBlockOn`, `test_TokenURIBeforeAndAfterReveal` (the I'M DEGEN names),
`test_GasHungryExtensionCantBreakTokenURI`, `test_RevertingOrSilentExtensionAddsNothing`,
`test_MalformedOrOversizedExtensionAddsNothing`, `test_TreasuryMustTakeEth`, `test_OwnerCanRelaxEnforcementInTheOpen`,
`test_EnforcementCanMoveButNeverBeSwitchedOff`, `test_SafeTransfersWithDataAreCheckedToo`, `test_MintsSkipTheValidator`,
`test_LinksThatWouldBreakTheJsonAreRefused`, `test_RevealRefreshesMarketplaces`, `testFuzz_DifferentSeedsGiveValidTraits`),
`RevealSeedTest` (2: the auditor's `test_SeedDoesNotDependOnTheRevealBlock`, adapted to the current flow, and
`test_OwnerCantGrindItsOwnCrafterToLegendary`), `MineWorldCraftersForkTest` (7, OpenSea's live registry, including
`test_Fork_EnforcedWithoutRegistering`, and `test_Fork_ArbSysIsThere`), and
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
   treasury (owner-only, when it's set), the vault's reads of a proposed distributor's `owner()`, `vault()` and
   `predecessor()`, a replacement's reads of its predecessor's `bookOf` (a view of the owner's own proxy), the
   Crafters' extension (a bounded static call) and validator, and their reads of ArbSys.
7. **Nothing on chain trusts the boosts:** rarity and level change what the server counts, never what the contracts
   pay.
8. **No upgrade charges more than its caller agreed to** (`maxCost`, and for a site the rate, `minRateBps`), whatever
   the allowance.
9. **A replacement of `MiningSites` never pays converted earnings again, and a replaced one never sells or pays:**
   books carry over, levels as bought (3.4, guarantees 10 and 11); only a contract whose `owner()` is the vault's
   owner, `vault()` the vault and `predecessor()` the current distributor can take over, and a `MiningSites` proxy is
   set up only in its own constructor, so the owner proposes only one it deploys itself (3.2, guarantee 8). Any
   distributor can be replaced, one without code too (3.2, guarantee 6).
10. **I'M DEGEN's looks are fixed by the first seal within a window, from public inputs only;** nobody but the owner can
    re-roll a window nobody sealed in, and the owner at most three times, in public. In practice the owner decides
    whether a window is sealed unless holders run the sealer at the reveal time it announces: a best of four at most,
    every move public.
11. **Every proxy of the family is set up only in its own constructor** (`OwnedUUPS.__Owned_init`): a `MiningSites`,
    `MinePayments` or `CrafterLevels` proxy deployed without its setup is nobody's, ever.
12. **I'M DEGEN mints only to wallets sending their own transaction**, at most `walletLimit` per address: no contract,
    so no one-transaction sweep of the free mint.

## 5. Admin powers, and when they end

| Contract | Who | Power | Bounds | Ends? |
| --- | --- | --- | --- | --- |
| `MineToken` | Deploying wallet | `setMinter` | Once, never 0 | Yes: renounced in the launch |
| `MineHook` | Deploying wallet | `openPool`, `setFeeRecipient`, ownership | `openPool` once; fee and liquidity fixed | Yes: renounced right after `openPool` |
| `MineHook` | Fee recipient (`0x6e85…`) | `setFeeRecipient` for its own fees (after the renounce only the current fee recipient can move the fees; nobody else can) | Never 0 | Stays |
| `MineVault` | Owner `0x6e85…` | Propose, cancel, accept a distributor; `sweep`; ownership | Accept ≥ 2 days after proposing, only a contract whose `owner()` is the vault's owner, `vault()` this vault and `predecessor()` the current distributor; can't mint, raise limits or renounce | Stays |
| `MiningSites` | Owner `0x6e85…` | `setSitePrice`, `setSigner`, `setPaused`, `setCaps`, `setRates`, `addLevel`, `setUpgradeCosts`, `setUpgradeBurnBps`, `setTreasury`, `sweep`, ownership | Price > 0; wallet cap ≤ 3,500, global ≤ 35,000; rates 10-100%, non-decreasing, never below a buyer's `minRateBps`; ≤ 20 levels, never fewer; cost 1 wei-1,000,000, never above a buyer's `maxCost`; burn 0-100%; treasury takes ETH; can't renounce | Stays (sales and claims end when it is replaced) |
| `MiningSites` | Owner `0x6e85…` | `upgradeToAndCall` | Any code; minting still bounded by the vault | Stays |
| `MiningSites` | Signer (the server's key) | Sign vouchers | The daily caps and the vault; replaced by `setSigner` | Until replaced |
| `MinePayments` | Owner `0x6e85…` | `addKind`, `setKindBurn`, `setTreasury`, ownership, upgrades | 3 kinds at launch (shop 75%, ticket 0%, revive 0%); ≤ 32 kinds, never removed; burn 0-100%; can't renounce | Stays |
| `CrafterLevels` | Owner `0x6e85…` | `setUpgradeCosts`, `setUpgradeBurnBps`, `addLevel`, `setTreasury`, ownership, upgrades | Cost 1 wei-2,000,000; burn 0-100%; ≤ 20 levels, never fewer; can't renounce | Stays |
| `MineWorldCrafters` | Owner `0x6e85…` | `setSaleOpen`, `reveal`, `moveEntropyOn`, `setPrice`, `setWalletLimit`, `setTreasury`, `setTransferValidator`, `setLinks`, `setCollectionImages`, `setContractURI`, `setAttributesExtension`, `refreshMetadata`, ownership | The sale is a pause until `reveal`, which publishes the committed secret (checked) and nothing else, once; `moveEntropyOn` only after a window nobody sealed in, at most 3 times, each in public; wallet limit 1-50 (3 at launch); royalty 5% fixed; treasury takes ETH; validator a contract (so the owner sets how strict enforcement is); links ≤ 256 bytes, JSON-safe; can't renounce, so OpenSea Studio (which lets only `owner()` edit) stays usable: never hand it to a contract wallet that can't sign in there | Stays (the sale, `reveal` and `moveEntropyOn` end with the reveal) |
| `MineWorldCrafters` | A wallet sending its own transaction | `mint` | While the sale is open: 1-5 at a time, at most `walletLimit` (3) per address, exactly `price`; a contract is refused (`OnlyWallets`) | Until the reveal |
| `MineWorldCrafters` | Anyone | `seal` | Only once the entropy block is over and within 256 blocks of it: sets the seed from public data (later it reverts `EntropyExpired`); `tools/sealer.sh` sends it the moment it can | Until the seed is set |
| `CrafterArt`, `MineRouter`, `MineEthRouter` | Nobody | None | | |

Deploy settings (`contracts/launch.env`): owner, treasury and fee recipient `0x6e85Dc9f094b7DD35a2A981AbBd0AC9C496670eD`
(one key, as Courier's are); start price a $5,000 fully diluted market cap for 21M $MINE; site price 0.005 ETH; caps
1,500 per wallet and 35,000 across everyone; payment kinds shop (75% burned), ticket and revive (0%); I'M DEGEN free,
wallets only, 3 per wallet, OpenSea's registry as validator; the
voucher signer's address passed at launch (`MINING_SIGNER`), the key itself only in the Worker's secrets.

## 6. Known and accepted

- **UUPS upgrades are instant.** `MiningSites`' bounds (caps, rates, costs, signer, pause) are only as fixed as its
  code: the owner, or whoever holds its key, can upgrade it at once and could then mint up to the vault's 35,000 a day
  to anyone. The vault's limits are the hard ones. An upgrade of any proxy could also take $MINE from a wallet with a
  standing allowance to it; the game approves exactly each cost right before paying it. Ownership may move to a
  multisig or a timelock later.
- **Replacing `MiningSites` with a new contract** (as opposed to upgrading the proxy): the replacement carries each
  player's site, `settled` and `claimed` over from its predecessor (read through, imported on the player's first act),
  so lifetime vouchers for the new address pay only what's new; the per-day counters restart (the vault's daily limit
  holds), and levels above its top are kept as bought and earn its top rate. The plan is still to upgrade in place; a
  replacement follows the procedure in 3.2 (propose the owner's own wallet's next CREATE address, deploy the proxy
  there initialised, accept two days later); the vault's checks catch mistakes, not a contract built to lie. It can
  follow any distributor, one without code too (empty books).
- **A leaked voucher key** can take at most the daily caps (per wallet with a site, and in all; two days' worth back
  to back around midnight UTC) until the owner pauses or replaces it. The server is trusted for what each wallet
  earned.
- **Tickets are checked off chain** from the `Paid` event, by the server (section 2). **Shop items are browser-side**:
  the browser delivers them on seeing its own `Paid` event and keeps the inventory in local storage.
- **The rate applies when you claim**, the backlog included, at the rate of the moment; owner changes to rates and
  costs apply from the next transaction.
- **Rounding goes in the vault's favour** (section 3.4).
- The owner can't renounce any contract it owns, by design: the distributor, the rules, the links and the validator
  must stay manageable, and OpenSea Studio, which lets only I'M DEGEN's `owner()` edit the collection, usable.
- The final supply ends below 21M (unconverted shares and unclaimed earnings are never minted; burns are permanent).
- The site price (ETH) and costs ($MINE) are set by hand and can lag the market.
- The treasury must accept ETH where it's sent ETH: `openSite` and paid mints send it directly. `MiningSites` and
  I'M DEGEN refuse a treasury that fails a plain call with no ETH; a contract whose fallback takes calls but not ETH
  would still pass, and the owner is trusted not to pick one. `MinePayments` and `CrafterLevels` don't check
  (they pay the treasury only $MINE).
- Days use `block.timestamp`, which the sequencer sets within the chain's bounds.
- I'M DEGEN's reveal (the sequencer's L2 block hashes; sealing within 256 L2 blocks, about 26 seconds; the owner's
  bounded re-roll, up to 3 public `moveEntropyOn`s after windows nobody sealed in, then stuck: in practice a best of
  four unless holders run the sealer at the announced time), the validator and the owner's power to relax
  enforcement, wallet limits (3 per address at launch, wallets only) and unsold supply (section 3.7); the hook's single-sided launch,
  hookless pools, IMD's issuer, the fee recipient moving its own fees and the -300,000 start-tick floor (section 3.9).

## 7. What to look at hardest

1. **Storage collisions and initializer/upgrade safety** in `OwnedUUPS` and the ERC-7201 layouts: the six namespace
   slots, no sequential storage anywhere in the proxies' inheritance, OpenZeppelin `Initializable`'s own namespace,
   `_disableInitializers()` in every implementation, `initialize` callable once, `upgradeToAndCall` only through the
   proxy and only by the owner, `__Owned_init`'s constructor-only guard in all three proxies, and that a next version
   can extend each struct safely. `OwnedUUPS` re-implements `Ownable2Step` (OpenZeppelin's upgradeable package isn't
   used): check it matches.
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
   owner, `vault()` the vault and `predecessor()` the current distributor (answered by the candidate's own code, so
   they catch mistakes, not lies); `MiningSites.initialize` accepts the vault's pending distributor but runs only in
   the proxy's own constructor (`OwnedUUPS.__Owned_init`: `address(this).code.length == 0`), never later, whoever
   calls, and follows a codeless distributor without calling it; a pending proxy sells
   and pays nothing; proposals don't expire; today's total carries across
   a change; a former distributor can't mint, sell sites or levels.
8. **The books across a replacement** (`bookOf`, `_import`, `_requireActive`): the read-through views match what an
   import writes, levels pass through as bought and are clamped only where used (`_siteRate`, `_nextLevel`), a chain of replacements reads through every hop, nothing can be imported before the replacement is
   accepted (so the predecessor's books are final), a failing predecessor call reverts rather than import zeros, and
   only a predecessor without code (checked on each read) reads as empty books.
9. **The predicted addresses:** the CREATE-predicted `MiningSites` proxy named in the vault's constructor, and the
   hook's mined CREATE2 address and flags (section 2, deploy invariants).
10. **ERC-4906 events:** every change to `tokenURI`'s output emits `MetadataUpdate` or `BatchMetadataUpdate` (the
    seal, `setAttributesExtension`, `CrafterLevels.upgrade` and `addLevel` through `refreshMetadata`, which is
    best-effort and clamps its range). A code upgrade of `CrafterLevels` that changes `attributesOf` emits nothing by
    itself; the owner would call `refreshMetadata`.
11. **The assembly** in `CrafterArt`, `FastBase64` and `MineWorldCrafters._shuffle`/`_traitsFor`: memory safety and
    the bijection.
12. **`MineHook`'s one change:** the start-tick range is now [-300,000, 400,000]; confirm every start tick and
    allocation the constructor accepts still opens.
13. **The reveal** (audit 0792975e #1, re-check 8c7ba957 #2 and #6, second re-check 52b534f9 #2 and #4, third
    re-check 10d532d5 #4 and #5): the secret published before the entropy exists;
    the entropy block's hash from ArbSys (`arbBlockNumber`, `arbBlockHash`) on Robinhood Chain, `block.number` and
    `blockhash` only where 0x64 has no code; the 256-block window decided from block numbers, never from a failing
    call (a caller could starve a call of gas); `seal` reverting after the window; the owner-only, capped move-on
    (`moveEntropyOn`, `NotExpired` until the window is over, `NoMovesLeft` after 3) and the stuck state after it;
    `revealStatus` saying Sealable only with `SEAL_MARGIN` (30) blocks to spare while `seal` takes the whole window;
    and whether the trust left (the sequencer, the owner's three public re-rolls, a best of four unless a sealer runs)
    is stated correctly.
14. **The treasury check, `maxCost` and `minRateBps`:** `_checkTreasury` in `MiningSites` (through `MinePayer`'s
    hook, at `initialize` and `setTreasury`) and in `MineWorldCrafters` (constructor and `setTreasury`); `_nextLevel`'s
    `CostAboveMax` in `UpgradeCosts`; `RateBelowMin` in `upgradeSite`.
15. **The mint gate** (third re-check 10d532d5 #3): `msg.sender == tx.origin` in `mint`. Check what it stops (any
    contract minting, so a sweep through throwaway contracts) and what it leaves (several funded wallets, each a
    transaction; an EIP-7702 account minting as itself, within its own limit).

## 8. Resolved: IMD Swarm audit 0792975e (on commit ba2a8ed)

(The fixes as they stood at `49830f2`, with its line numbers. IMD's re-check found findings #1 and #2's fixes
incomplete and #5's narrower than it should be; section 9 has what replaced them.)

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

## 9. Resolved: IMD Swarm re-check 8c7ba957 (on commit 49830f2)

(The fixes as they stood at `4de227d`, with its line numbers. IMD's second re-check found #1's late path, where the
vault's owner could initialise a proxy left uninitialised, still open to a stranger passing a vault of its own, and
#2's move-on after expiry a free re-roll for anyone; section 10 has what replaced them. #3's levels are now kept as
bought rather than held at the new top.)

The report: https://explorer.imd.fun/jobs/8c7ba957-1fee-4fa5-a621-9b653cc52361 (archived in github.com/Identity-md/research,
`jobs/8c7ba957-1fee-4fa5-a621-9b653cc52361/`). Two medium and four low findings; every one is fixed below. Line numbers
are in the fixed files. The auditor's two proofs (`HijackNamesOwnerTest`, `ReplacementResetsSettledTest`) and the
scenarios behind #2, #4, #5 and #6, written against `49830f2`'s functions, all fail on `49830f2`; the tests below pass.

**Measured on Robinhood Chain** (through the official RPC, 2026-10-15), for #2: ArbSys is at `0x64` (code `0xfe`;
`EXTCODESIZE` reads 1 inside the EVM, so the collection takes the ArbSys path). `arbBlockNumber()` is the L2 block
(88,751,916 in one sample) while `block.number` in the EVM is the parent chain's (26,193,962 at the same moment). `arbBlockHash(n)` equals the L2
block header's hash, answers for `current − 256 ≤ n < current` and reverts `InvalidBlockNumber` otherwise. L2 blocks
come every 0.101 s, steadily: 256 of them took 26 s in four samples across a million blocks, and 864,000 took 87,249 s.
So the window to seal is about 26 seconds. (Forge and Anvil forks don't run ArbOS: they answer `arbBlockNumber` but not
`arbBlockHash`, so the fork test mocks the two calls and `dev.sh --fork` sets the seed as `seal` would; the unit tests
cover the ArbSys path with a mock at `0x64`.)

| # | Finding | Resolution |
| --- | --- | --- |
| 1 | Medium: fix #2 incomplete: `acceptDistributor` only compared `owner()`, so a stranger who initialised the pending, uninitialised proxy naming the vault's owner (but itself as signer and treasury) was accepted and minted | `MiningSites.initialize` runs only in the proxy's own constructor (`address(this).code.length == 0`) or when the vault's owner calls it, for the distributor and the pending distributor alike (`MiningSites.sol:190`, `InitializeOutsideConstructor`). `MineVault.acceptDistributor` (`MineVault.sol:174`) now also requires the pending contract's `vault()` to be this vault (`WrongVault`, `:180`) and its `predecessor()` the current distributor (`NotASuccessor`, `:181`, see #3), besides `owner()` (`:179`), each read through `IDistributor` (`:13`) by `_read` (`:190`), where any failed or malformed answer reads as 0 and never matches. NatSpec (MineVault's steps, `initialize`) and section 3.2 corrected. Tests: the auditor's `test_HijackedProxyNamingTheOwnerIsAccepted` (`HijackNamesOwnerTest`), `test_onlyTheOwnerSetsUpALateProxy`, `test_InitializeOnlyInTheConstructorOrByTheVaultsOwner`, `test_OnlyAContractTheOwnerOwnsTakesOver` (`WrongVault`, `NotASuccessor`), `test_safeReplacementPath`, and 0792975e's two proofs. |
| 2 | Medium: fix #1 didn't hold on Robinhood Chain: `block.number` is the parent chain's and Nitro's `BLOCKHASH` reads a 256-slot ring; when the parent number skips, `blockhash(B)` is the stale `B − 256` value the owner knew in advance (about one transition in four) | Redesigned together with #6: the secret is published before the entropy exists, and the entropy is an L2 block's own hash. `reveal(secret)` (`MineWorldCrafters.sol:246`; owner, sale closed, checked against `seedCommit`) stores `revealedSecret` (`:250`) and `entropyBlock = ArbSys.arbBlockNumber() + 1` (`:252`), the next L2 block; the sale never reopens after it (`setSaleOpen`, `:524`). `seal()` (`:267`), by anyone once that L2 block is over, sets `seed = keccak256(abi.encode(revealedSecret, ArbSys.arbBlockHash(entropyBlock)))`. Past the 256-block window it moves `entropyBlock` on to the next L2 block (`:273`, `EntropyBlockSet`) and returns 0. The window is checked from block numbers, not from a failed call (a `try/catch` on `arbBlockHash` would let anyone force a move-on by starving the call of gas, so any ArbSys failure reverts the seal instead). `_chainBlock`/`_chainBlockHash` (`:304`, `:309`) use ArbSys, or `block.number`/`blockhash` where `0x64` has no code (local chains). The NatSpec states the trust left: the sequencer. Tests: `test_Arbitrum_TheEntropyIsTheNextL2Block`, `test_Arbitrum_AParentChainSkipChangesNothing` (block.number skips by two, `blockhash(B)` set to the stale value: the seed is the L2 block's), `test_Arbitrum_ExpiryMovesTheEntropyBlockOn`, `test_Arbitrum_AFailingCallNeverMovesTheEntropyBlockOn`, `test_SeedComesFromTheSecretAndTheNextBlock`, `test_AnExpiredEntropyBlockMovesOn`, `test_OwnerCantMintKnowingTheLooks`, the auditor's earlier proof `test_SeedDoesNotDependOnTheRevealBlock` (adapted: at whichever block the owner reveals, the entropy doesn't exist yet; once revealed, the seed is the same whenever it's sealed) and `test_OwnerCantGrindItsOwnCrafterToLegendary`, and on a fork `test_Fork_ArbSysIsThere`. |
| 3 | Low: the documented replacement started the new MiningSites with `settled = 0`, so earnings already converted were paid again | A replacement records the vault's distributor of the moment as its `predecessor` at `initialize` (`MiningSites.sol:202`-`:207`; it must answer `bookOf`, else `BadPredecessor`), and the vault only accepts a successor of the current distributor (#1). Each player's site (opened-at, level held at the new top), `settled` and `claimed` carry over: `bookOf` (`:274`) reads through the predecessor (and its own, for chains of replacements) until the player first acts here, and `_import` (`:253`) on the first `openSite`, `upgradeSite` or `claim` writes the higher of each for good (`Imported`). `siteOf`, `hasSite`, `siteLevel`, `rateBps`, `settled`, `claimed` and `claimable` read through `bookOf`. Imports happen only while the contract is the vault's distributor (#4), when the predecessor's books are final. NatSpec notes the per-day counters restart at a replacement (the vault's 35,000 a day holds). Tests: the auditor's `test_ReplacementPaysLifetimeEarningsAgain` (two changes: alice's carried-over site makes her `openSite` a low-level call, and a claim that pays nothing reverts `NothingToClaim`, counted as 0), `test_TheBooksCarryOver` (three contracts, read-through and import), `test_ALevelAboveTheNewTopIsHeldAtTheTop`, `test_PerDayCountersRestartButTheVaultsLimitHolds`, `test_APredecessorMustKeepBooks`. |
| 4 | Low: after a replacement the old MiningSites kept selling sites and upgrades that could never pay | `openSite` (`MiningSites.sol:305`), `upgradeSite` (`:323`) and `claim` (`:376`) first require `vault.distributor() == address(this)` (`_requireActive`, `:247`, `NotActive`), so a retired contract sells and pays nothing (paused or not), and neither does a replacement before it's accepted; `claimable` reads 0 then. Tests: `test_aRetiredDistributorSellsNothing`, `test_safeReplacementPath`. |
| 5 | Low: `maxCost` bounded an upgrade's price but not what it bought: a `setRates` cut mined first still charged full price | `upgradeSite(uint256 maxCost, uint256 minRateBps)` (`MiningSites.sol:323`) reverts `RateBelowMin(rate, minRateBps)` if the new level's rate is below `minRateBps` (`:331`). The web client passes the rate it showed (`web/panel.js` `upsite`, `web/chain.js` `upgradeSite`). Test: `test_RateCutMinedFirstRevertsTheUpgrade`. |
| 6 | Low: after a seal only the owner knew the rarities, with no deadline (reveal was owner-only) | Solved by #2's redesign: the owner's one step, `reveal`, publishes the secret before the entropy block exists; from the end of that block everyone has the same two public inputs and anyone can `seal`; the owner has no step left. Test: `test_NoPartyKnowsTheLooksBeforeEveryoneCan` (the entropy doesn't exist at the reveal nor in its block; a stranger works the seed out from public data and seals; a year of owner silence holds nothing up). |

Also changed since `49830f2`: the collection is renamed I'M DEGEN (symbol DEGEN) where people see it: `name()`/`symbol()`,
the token and collection metadata (`MineWorldCrafters.sol:195`, `tokenURI`, `contractURI`), the panel, the README and
the scripts' wording; identifiers keep their names. The web client's panel shows the reveal's status and a **Lock in the
reveal** button that calls `seal()` right after the owner's `reveal` (and again if the window passed), and passes
`minRateBps`. `dev.sh` publishes the secret, then seals from a player's account (on `--fork`, where Anvil can't give
L2 block hashes, it sets the seed as `seal` would). `DeployCrafters` and `deploy-mainnet.sh` print the new reveal
steps. 235 tests, plus 10 against a Robinhood Chain fork (`--match-contract ForkTest`).

## 10. Resolved: IMD Swarm second re-check 52b534f9 (on commit 4de227d)

(The fixes as they stood at `25121ea`, with its line numbers. IMD's third re-check confirmed all four and found what
section 11 resolves: #1's constructor-only guard now lives in `OwnedUUPS` for every proxy of the family, and #4's
one-block margin is now `SEAL_MARGIN`, 30 blocks.)

The report: https://explorer.imd.fun/jobs/52b534f9-f11d-4ef7-880f-053694cef8be (archived in github.com/Identity-md/research,
`jobs/52b534f9-f11d-4ef7-880f-053694cef8be/`). One medium, two low and one info finding; every one is fixed below.
Line numbers are in the fixed files. The auditor's proof (`FakeVaultHijackTest`, as submitted), its variant
(`StrangerInitializesWithOwnVaultTest`) and the scenarios behind #2, #3 and #4, written against `4de227d`'s functions,
all fail on `4de227d` (five failures, one per scenario); the tests below pass.

| # | Finding | Resolution |
| --- | --- | --- |
| 1 | Medium: re-check fix #1's late path let anyone initialise a proxy left uninitialised: the guard compared the caller with the owner of the `vault_` the caller passed, so a stranger passed a vault of its own (a fake, or a real `MineVault` naming the proxy), became the proxy's owner, upgraded it to code answering the vault's three reads correctly, was accepted and minted | `MiningSites.initialize` runs only in the proxy's own constructor, unconditionally (`MiningSites.sol:191`: `address(this).code.length != 0` reverts `InitializeOutsideConstructor`, `:150`); the late path, its NatSpec and its test are gone, so a proxy deployed without `initialize` in its constructor can never be set up, by anyone (the owner deploys another). NatSpec corrected: `initialize` (`MiningSites.sol:170`-`:179`: its arguments, `vault_` included, are trusted only because whoever deploys the proxy chooses them), MineVault's steps (`MineVault.sol:28`-`:46`: P is the owner's own wallet's next CREATE address, where nobody else can deploy; the three reads catch mistakes, not a contract built to lie) and `acceptDistributor` (`MineVault.sol:173`-`:178`). The ERC-1967 implementation-slot pin in `acceptDistributor` was considered and skipped: no contract can read another's storage, and an `implementation()`-style getter is answered by the candidate's own, possibly swapped code, so it couldn't be read safely; proposing only a proxy the owner deploys itself, from its own wallet, is what closes the gap. Sections 1, 2, 3.2, 3.3, 3.4, 4, 5 and 7 updated (the "initialize a proxy left uninitialised" power is gone from section 5). Tests: the auditor's `test_StrangerInitialisesTheLateProxyWithItsOwnVault` (`FakeVaultHijackTest`, as submitted), `test_StrangerInitializesTheProposedProxyWithItsOwnVault` (`StrangerInitializesWithOwnVaultTest`), `test_InitializeOnlyInTheConstructor` (neither a stranger nor the owner can initialise a deployed proxy; recovery is a new proxy following the dead one), `test_aProxyLeftUninitialisedCanNeverBeSetUp` (replaces `test_onlyTheOwnerSetsUpALateProxy`), `test_safeReplacementPath`, `HijackNamesOwnerTest` and 0792975e's two proofs. |
| 2 | Low: after the window passed unsealed, anyone's `seal()` moved the entropy block on, so the owner (or anyone) could re-roll for free, as often as it liked, by letting windows pass | Past the window, `seal()` now reverts `EntropyExpired` (`MineWorldCrafters.sol:290`, error `:184`). Only the owner can move the entropy block on, with `moveEntropyOn()` (`:310`): only after a window nobody sealed in (`NotExpired`, `:315`), at most `MAX_ENTROPY_MOVES = 3` times in all (`:90`, `entropyMoves` `:126`, `NoMovesLeft` `:317`), each emitting `EntropyBlockMoved(entropyBlock, moves)` (`:154`, `:321`; replaces `EntropyBlockSet`). After the third move's window passes unsealed, `revealStatus()` reads `Stuck` (`:334`) and the reveal can never happen: chosen over a fallback because anything that sets a seed without a fresh block hash is either known in advance from the published secret or depends on when the owner sends it, so it could be steered; being stuck gives the owner nothing that refusing to reveal didn't already. Anyone can still seal within the window, and a seal within it always fixes the seed. The honest path seals at once: the panel's **Reveal and lock in** (owner) sends `reveal`, waits for the next L2 block and sends `seal()`, retrying until the seed is set (`web/chain.js:420` `revealAndSeal`; `web/panel.js:121`, `:125`, `:313`), and after an expired window the owner's **Pick a new block and lock it in** sends `moveEntropyOn` then `seal()`; `dev.sh` (`:148`-`:166`) reveals and seals in a retry loop, failing loudly if the seed isn't set; `DeployCrafters` and `deploy-mainnet.sh` print a one-line `cast send` reveal-then-seal sequence. The NatSpec trust claims now say so (contract `@dev` `:63`, `seal` `:274`, `moveEntropyOn` `:298`), and 3.7's known and accepted. Tests: `test_AStrangerCantMoveTheEntropyBlockOn`, `test_TheOwnerMovesOnAtMostThreeTimes` (then `NoMovesLeft` and `Stuck`), `testFuzz_ASealWithinTheWindowAlwaysFixesIt` (any block in the window, any caller, then nothing moves it), `test_AnExpiredEntropyBlockMovesOn`, `test_Arbitrum_ExpiryMovesTheEntropyBlockOn` (now the owner's move), `test_NoPartyKnowsTheLooksBeforeEveryoneCan`. |
| 3 | Low: `bookOf` and `_import` held a carried-over level at the replacement's `maxLevel()`, so a level paid for was lost for good if the replacement had fewer levels, even after `addLevel` | Levels pass through as bought: `_import` (`MiningSites.sol:263`) and `bookOf` (`:288`) bound them only by `MAX_LEVELS` (20, what's stored), and `siteLevel` (`:350`) shows the raw level. They are clamped only where used: the rate through `_siteRate` (`:360`, `levelRateBps(min(level, rates.length))`) in `rateBps` (`:356`), `claim` (`:393`) and `claimable` (`:424`), so a level above the top earns the top rate; `_nextLevel` (`UpgradeCosts.sol:126`) reverts `MaxLevel` at or past the top, so it can't be upgraded until the top passes it. `levelRateBps` still reads 0 for no such level. Tests: `test_ALevelAboveTheNewTopIsKept` (the auditor's scenario: level 6 bought, replaced by a 5-level contract, still 6 and paid at the top rate), `test_LevelPaidForIsKeptThroughAHopAndAfterAnImport` (kept through a hop and an import, its own rate back after `addLevel`), `test_ALevelSurvivesThreeHops`. |
| 4 | Info: `revealStatus()` said `Sealable` on the window's last block, where a seal sent on seeing it lands one block too late | `Sealable` only while `current − entropyBlock < ENTROPY_WINDOW` (`MineWorldCrafters.sol:333`); on the last block it reads `Expired` (a seal still works there, the owner's move doesn't yet). The panel acts on it (`web/panel.js:313`, `web/chain.js:420`). Test: `test_AnExpiredEntropyBlockMovesOn` (Sealable at +255, Expired at +256 where a seal still lands, the owner's move refused at +256 and accepted at +257). |

Also changed since `4de227d`:
- **The I'M DEGEN mint is free, at most 3 per wallet:** `walletLimit = 3` (`MineWorldCrafters.sol:117`) and
  `CRAFTERS_WALLET_LIMIT=3` in `launch.env`, `DeployCrafters` and `deploy-mainnet.sh`; `dev.sh`'s two starter DEGENs per
  account fit under it. `setWalletLimit`'s bounds stay 1-50: 50 caps what the owner can open up and 1 keeps the mint
  possible, and nothing argues for tightening them. The panel shows "Free (gas only), at most 3 per wallet" and how many
  the wallet has minted, offers no more than it may still mint, and explains a refused fourth (`WalletLimit`). Test:
  `test_ThreePerWalletAtLaunch` (three mints, the fourth reverts at the launch default).
- **Ownership and OpenSea Studio:** `renounceOwnership` reverts and `transferOwnership(0)` leaves `owner()` in place,
  before and after the reveal (`test_RenounceReverts`). `DeployCrafters` warns loudly when the broadcasting wallet
  isn't `OWNER` (`OWNER` must make the printed `acceptOwnership` at once; deploying from `OWNER` itself is
  recommended), prints that OpenSea Studio lets only `owner()` edit the collection and must never be handed to a
  contract wallet that can't sign in there, and ends with `owner()` and `pendingOwner()`; `deploy-mainnet.sh crafters`
  asks for the `OWNER` wallet before signing. The README's launch steps and section 5 say the same; `setLinks`,
  `setCollectionImages` and `contractURI` stay as the on-chain fallback for OpenSea Studio's own fields.
- 243 tests, plus 10 against a Robinhood Chain fork (`--match-contract ForkTest`).

## 11. Resolved: IMD Swarm third re-check 10d532d5 (on commit 25121ea)

The report: https://explorer.imd.fun/jobs/10d532d5-da29-4f5e-87b1-77abdca8467f (archived in github.com/Identity-md/research,
`jobs/10d532d5-da29-4f5e-87b1-77abdca8467f/`). Three low and two info findings, no medium; every one is resolved
below. Line numbers are in the fixed files. The auditor's three proofs (`CodelessDistributorProofTest` and
`LateInitProofTest` as submitted, `SybilMintTest` adapted to the fix) and a scenario for #5, written against
`25121ea`'s functions, all fail on `25121ea` (four failures, one per finding); the tests below pass.

| # | Finding | Resolution |
| --- | --- | --- |
| 1 | Low: a vault whose distributor has no code (a launch whose proxy missed its predicted address) could never be given a working distributor: `initialize` called `bookOf` on the codeless predecessor, and the high-level call reverted before its `try/catch` | `MiningSites.initialize` calls the predecessor's `bookOf` only if it has code (`MiningSites.sol:206`) and records it as `predecessor` either way; `_import` (`:264`) and `bookOf` (`:291`) read a predecessor without code as empty books, with no call. One with code must still answer `bookOf` (`BadPredecessor`, `:153`, `:209`). MineVault's steps say so (`MineVault.sol:47`). The predicted-address check stays a hard launch precondition, and is now said to be one: `Deploy.s.sol:127`-`:133` (the comment, and the `require` kept as it was); `deploy-mainnet.sh` tells the deploying wallet to send nothing else during the launch (`:160`) and broadcasts every stage with `--slow` (`:175`), so a failed proxy transaction stops everything after it, the token's renounce included; README step 5; section 2's deploy invariant 1. 3.2's guarantee 6 now reads "a distributor can always be replaced, whatever it is". Tests: the auditor's `test_AVaultWithACodelessDistributorCanStillBeReplaced` (`CodelessDistributorProofTest`, as submitted), `test_ACodelessPredecessorHasEmptyBooks` (then a site and a claim work), `test_APredecessorWithCodeMustStillKeepBooks`. |
| 2 | Low: `CrafterLevels.initialize` and `MinePayments.initialize` kept the late path `MiningSites` lost: a proxy of either deployed without its setup was anyone's | The constructor-only guard moved into `OwnedUUPS.__Owned_init` (`lib/OwnedUUPS.sol:52`-`:53`, error `InitializeOutsideConstructor` `:36`), the first step of every `initialize` in the family: `MiningSites.sol:192`, `CrafterLevels.sol:57`, `MinePayments.sol:62`. `MiningSites`' own copy and its error declaration are gone (the error keeps its name and selector; the tests name it `OwnedUUPS.InitializeOutsideConstructor`). NatSpec: `OwnedUUPS`, and each `initialize`. Tests: the auditor's `test_StrangerCannotInitialiseLateLevelsOrPaymentsProxies` (`LateInitProofTest`, as submitted), `test_TheGuardIsSharedByEveryProxyOfTheFamily`, and for `MiningSites` `test_InitializeOnlyInTheConstructor`, `test_aProxyLeftUninitialisedCanNeverBeSetUp`, `FakeVaultHijackTest`, `StrangerInitializesWithOwnVaultTest`. |
| 3 | Low: the free mint's 3-per-wallet limit was per `msg.sender` only, so one transaction could sweep it through throwaway contracts (300 DEGENs in one, 12 for all 3,333) | The owner chose "real wallets only": `mint` reverts `OnlyWallets` unless `msg.sender == tx.origin` (`MineWorldCrafters.sol:241`, error `:180`); the 3-per-wallet limit stays. The NatSpec (`:234`-`:239`), 3.7, the README and DESIGN state what it does and doesn't do: it stops one-transaction contract sweeps; a determined bot then needs a funded wallet and a transaction for every 3 DEGENs (accepted); an account delegated with EIP-7702 still mints as itself, within the same limit per address; smart-contract wallets can't mint (they can buy). The panel's mint button explains the error (`web/chain.js:29`, shown through `explain`). Tests (`SybilMintTest`): the auditor's `test_OneActorHoldsAtMostThreeAfterOneTx`, adapted (the attacker sends the sweep itself, `tx.origin` included; the sweep reverts, the attacker holds 0, nothing is minted), `test_AContractCantMint`, `test_AWalletStillMintsThree`, `test_ADelegatedAccountMintsAsItselfWithinTheLimit` (on Prague, a delegated account's code mints 3 as the account, not 6). Every existing mint test now sends as a wallet (`vm.prank(x, x)`). |
| 4 | Info: in practice the owner alone decides whether each 26-second window is sealed (it alone knows when it reveals, and the only sealer shipped was its own panel), so it holds a choice among up to four seeds | No contract change. New `tools/sealer.sh`, which anyone can run with `RPC_URL` and a Foundry keystore (`--account`; `ETH_PASSWORD` may name a password file) or a browser wallet (`--browser`), and which refuses keys and passwords on the command line. It simulates `seal()` every 0.2 s, reports `SecretRevealed` and `EntropyBlockMoved` as the entropy block changes, sends `seal()` as soon as a simulation passes (the next L2 block after the entropy block), retries until the seed is set, waits through an expired window for the owner's move, and stops at `Stuck`. The README's launch step 9 (the owner announces the reveal time; the command), `DeployCrafters`' printed steps and `deploy-mainnet.sh`'s notes say so. The trust assumption is stated in the contract's `@dev` (`MineWorldCrafters.sol:63`-`:67`), 3.7, sections 1, 4 (guarantee 10) and 6: the owner gets a best of four at most, and every move is public. |
| 5 | Info: `revealStatus`'s one-block Sealable margin was about 100 ms, shorter than sequencing, and the panel rethrew a seal that reverted on chain instead of moving on | `SEAL_MARGIN = 30` blocks, about 3 s (`MineWorldCrafters.sol:96`): `revealStatus` says Sealable only while `current − entropyBlock < ENTROPY_WINDOW − SEAL_MARGIN` (`:349`); `seal` still takes the whole window. `web/chain.js`: `send` tags a receipt that reverted (`:175`), and `revealAndSeal` (`:426`) treats a seal that reverted on chain as a reason to read the status again (`:456`): the owner then moves on, or, in the window's last 30 blocks where the move is refused with `NotExpired`, tries a seal (`:444`); anyone else is told only the owner can. The panel's notes for a closing window (`web/panel.js:326`, `:331`). Tests: `testFuzz_SealableLeavesAMarginButSealTakesTheWholeWindow`, `test_AnExpiredEntropyBlockMovesOn` (Sealable at +225; at +226 and +256 Expired, where a seal still works and the move is refused; the move at +257), `test_Arbitrum_ExpiryMovesTheEntropyBlockOn`. |

Also changed since `25121ea`:
- **A revive kind:** players can pay 420 $MINE to revive on the spot after dying on the home planet, through
  `MinePayments` as kind 2 "revive", 0% burned (all to the treasury, as the owner chose, like tickets).
  `MinePayments.initialize` adds it with the other two (`MinePayments.sol:66`, `KIND_REVIVE` `:26`); `launch.env`, the
  README, DESIGN and 3.5 say so. The game side is out of scope. Tests: `test_DeployedAsSpecified` (three kinds),
  `test_RevivesGoToTheTreasury` (`pay(2, 420e18)` sends it all to the treasury, nothing burned).
- 254 tests, plus 10 against a Robinhood Chain fork (`--match-contract ForkTest`).
