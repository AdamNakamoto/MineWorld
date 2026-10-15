# MineWorldCraft: version one

A blocky mining world in the browser (original code, textures and creatures; no Minecraft assets), with an
on-chain economy on Robinhood Chain. Built on what worked in Courier World (github.com/AdamNakamoto/courierworld):
plain HTML/JS + three.js, a Cloudflare Worker + Durable Object for the shared world, Foundry contracts, the audited
$STAMP hook for the 4% fee, the audited enforced-royalty NFT pattern, and server-signed EIP-712 vouchers.

## Money flows

| | |
|---|---|
| $MINE | `MineToken`: ERC-20 + permit + burnable, name "MineWorldCraft", symbol "MINE", 21,000,000 in all, counting every mint (burns are for good). No transfer tax. Renounced at deploy: no owner, proxy, pause or blocklist |
| 50% liquidity | 10,500,000 $MINE locked single-sided in one MINE/IMD Uniswap v4 pool by `MineHook` (a copy of the audited `StampHook`), locked forever |
| 50% to mine | 10,500,000 $MINE minted by the mining vault (`MineVault`, the token's one minter) only as players convert what they earn in the game: at most 35,000 a UTC day and 10,500,000 in all, fixed in the vault whatever the rules contract asks (at least 300 days). Nobody (not the owner) can take it any other way |
| 4% trading fee | Every swap pays 4% of its IMD side to `0x6e85Dc9f094b7DD35a2A981AbBd0AC9C496670eD` (the fee recipient). Plain transfers are never taxed |
| Mining site | Opened once per wallet with ETH (0.005 ETH at launch, owner-settable, never zero), paid straight to the treasury. Needed to convert earnings to $MINE. Not transferable. Levels 1 to 5 convert 50%, 60%, 70%, 85% and 100% of the earnings claimed; upgrades cost 4,620, 18,942, 77,662 and 318,415 $MINE |
| DEGEN levels | `CrafterLevels`: a DEGEN's holder raises it from level 1 to 5 for 2,310, 9,471, 38,831 and 159,207 $MINE. The level belongs to the token (it stays when sold) and adds to its boost |
| Shop and tickets | `MinePayments`: the Smithy's shop (kind 0), rocket tickets (kind 1, 2,100 $MINE to Deepvein or Cinderfall, 210 to Red Mesa) and revives (kind 2, 420 $MINE to revive on the spot after dying on the home planet), at the game's prices (`web/shop.js`, `web/zones.js`) |
| Burns | Site upgrades, DEGEN levels and the shop burn 75% of what they cost (owner-settable, 0-100%) and send the rest to the treasury; tickets and revives burn nothing. Taken straight from the player's wallet with an exact approval: the contracts never hold anyone's $MINE |
| NFT | "I'M DEGEN" (symbol DEGEN; contract `MineWorldCrafters`, first named MineWorld Crafters: the code keeps that name): 3,333 characters from the user's own pixel-art designs, drawn and stored fully on-chain (the contract builds each SVG from the trait layers in `web/crafters-art.js`). Free mint (gas only; price owner-settable) for wallets only (`msg.sender == tx.origin`, so no contract mints and one transaction can't sweep it through throwaway contracts; an EIP-7702 account mints as itself), at most 3 per wallet (owner-settable, 1 to 50), commit-reveal (the owner publishes the secret, the seed waits for the next block's hash, anyone seals it within the 256 blocks the chain keeps a hash for, about 26 seconds; the panel sends both at once. `revealStatus` says Sealable only with 30 blocks, about 3 seconds, to spare. If nobody seals in time, only the owner can move it on to a new block, in public and at most 3 times; after that the reveal stays stuck rather than fall back to anything that could be steered. `tools/sealer.sh` lets anyone seal the moment it can be, so the owner announces the reveal time). No two alike: hair x outfit x eyes x gaze is a different one of 6,912 combinations for every token; background, skin, hat and blush are weighted. The DEGEN a player wears is how their miner looks in the game, and boosts their mining by its rarity and level (`web/boosts.js`). 5% royalty, enforced (ERC721-C, OpenSea's registry), rate fixed. Owner can update the collection's website and social links shown on OpenSea at any time; its ownership can never be renounced, so OpenSea Studio, which lets only `owner()` edit, stays usable |
| Treasury | Site sales, the unburned share of upgrades and shop payments, tickets, any NFT mint price and the NFT royalty. Defaults to the fee recipient `0x6e85…70eD`; separate setting |
| Owner | `0x6e85Dc9f094b7DD35a2A981AbBd0AC9C496670eD` owns the vault, the three proxies and I'M DEGEN. Two-step transfer, never renounced (`OwnedUUPS`); can be a multisig or a timelock |

No auto yield farming: nothing pays for holding or waiting. $MINE is only paid for things players do in the game.

**Fixed forever:** the token, the vault (its daily and total limits; a new distributor only two days after it's
proposed, in the open), the hook (renounced: the 4% fee is final, and only the current fee recipient can move its fees)
and the locked liquidity, and I'M DEGEN's art, rarities and 5% royalty. **Upgradeable** (UUPS, owner only, state in ERC-7201 namespaced storage so
every site, level and total carries over): `MiningSites`, `CrafterLevels`, `MinePayments`. Whatever code runs in them,
the vault caps what can be minted at 35,000 a day.

## Earning and converting

1. A player signs in with their wallet (one free signature, no transaction). Guests can play but earn nothing.
2. Real activity earns $MINE on the server's ledger: breaking natural blocks (more for rarer ores) and defeating
   monsters. The table is `web/rewards.js`, shared by the game and the server, so new activities and new rates are
   one edit there. Placed blocks pay nothing when broken again, so building and re-mining earns nothing.
3. The server checks each action: the block is really there (it runs the same world generator as the game), within
   reach of where the player really is, not faster than the best pickaxe allows, outside the protected town; a
   monster was really spawned for that player, hits come no faster than a sword swings and no harder than the best
   sword. Each wallet earns at most a daily cap (server-side: `DAILY_EARN_CAP` 300 times its NFT cap boost and the
   zone's `capMul`), and everyone together at most `WORLD_DAILY_CAP` (35,000) a day. The ledger counts ten-thousandths
   of a $MINE (`UNIT`); vouchers are in wei.
5. NFT boosts (`web/boosts.js`): the NFTs a signed-in player uses (one per slot: DEGEN, skin, companion, aura,
   vehicle; only the DEGEN is out) add a % to their block-breaking speed (allowed for in the server's break-rate
   check), to every block, monster and boss share they earn, to their daily cap, and (client only) to walking. Totals
   are clamped (+150% speed, +150% earn, +300% cap, +100% move). The server checks ownership and reads the tier and
   level on-chain when the player signs in, wears or equips, and again every 10 minutes while they earn. Nothing pays
   for holding.
4. To convert, the player needs an open mining site (on-chain). The server signs a voucher for the wallet's
   lifetime total earned; `MiningSites.claim` converts what hasn't been converted yet (`total - settled`) at the
   site's rate now, within a per-wallet daily cap and a global daily cap (both owner-settable below hard maxima, they
   bound what a leaked server key could take a day), and the owner can pause claims. Earnings a cap holds back stay
   claimable; the share a rate doesn't convert stays in the vault for good.

## The contracts (the spec the game and the server rely on)

**MiningSites** (UUPS proxy; `UpgradeCosts`, `MinePayer`, `OwnedUUPS`):
- `openSite()` payable: exactly `sitePrice`, once per wallet, ETH forwarded to `treasury`; the site opens at level 1.
  `siteOf(address) → uint64 openedAt` (0 = none), `hasSite(address) → bool`, `siteLevel(address) → level` (0 = none; the level as bought, kept as it is through a replacement even above that one's `maxLevel`).
  Event `SiteOpened(address indexed owner, uint256 price)`.
- `upgradeSite(uint256 maxCost, uint256 minRateBps)`: raises the caller's site one level for `upgradeCost(level + 1)`
  $MINE, taken from the wallet with its approval: `upgradeBurnBps` (75%) burned, the rest to the treasury. The game
  passes the cost and the next level's rate it shows, and approves exactly the cost. Reverts `NoSite`, `MaxLevel`,
  `CostAboveMax(cost, maxCost)`, `RateBelowMin(rate, minRateBps)`. Event `SiteUpgraded(address indexed owner, uint256 level, uint256 cost, uint256 burned)`.
  `maxLevel()` (5 at launch), `upgradeCost(level)` (2 to maxLevel), `upgradeCosts()`, `upgradeBurnBps()`.
- Rates: `rateBps(address)` (the wallet's, 0 without a site; a level above the top earns the top rate), `levelRateBps(level)`, `rates()`: 5,000, 6,000, 7,000,
  8,500 and 10,000 at launch.
- `claim(uint256 total, uint64 deadline, bytes signature)`: msg.sender must have a site, not paused, `deadline` not
  passed, EIP-712 signature by `signer` over `Earnings(address player,uint256 total,uint64 deadline)` with domain
  name "MineWorldCraft Mining", version "1". Converts `total - settled[player]` at the site's rate now and pays it
  within the wallet's daily room, everyone's daily room and the vault's `roomToday()`; held back, only the earnings
  the payment covers count as settled. Reverts `NothingToClaim` if it would pay 0. The vault mints straight to the
  player. Day = `block.timestamp / 1 days`. Event `Claimed(address indexed player, uint256 amount, uint256 earnings,
  uint256 rateBps, uint256 totalClaimed, uint256 totalSettled)`.
- `claimable(address player, uint256 total) view → uint256` (what a claim would pay now, 0 without a site or paused).
- Views for the panel: `sitePrice`, `treasury`, `signer`, `paused`, `walletDailyCap`, `dailyCap`, `paidToday()`,
  `walletPaidToday(address)`, `claimed(address)`, `settled(address)`, `token`, `vault`, `vaultBalance()`.
- Owner: `setSitePrice` (never 0), `setTreasury` (must take ETH: `TreasuryRefusesEth`), `setSigner`, `setPaused`, `setCaps(wallet, global)` within
  `MAX_WALLET_DAILY_CAP` (3,500 $MINE) and `MAX_DAILY_CAP()` (the vault's 35,000), `setUpgradeCosts` (each 1 wei to
  1,000,000 $MINE), `setRates` (each 10% to 100%, never lower for a higher level), `setUpgradeBurnBps` (0-100%),
  `addLevel(cost, rate)` (up to 20 levels, never fewer), `sweep(token, to)` for tokens sent by mistake, and upgrades.
  Defaults: 1,500 $MINE a wallet a day, 35,000 across everyone.

**MineVault** (not upgradeable): `release(to, amount)` only from `distributor` (MiningSites), at most `DAILY_LIMIT`
(35,000) a UTC day and `TOTAL_LIMIT` (10,500,000) in all; `released`, `releasedToday()`, `remaining()`, `roomToday()`.
Owner: `proposeDistributor` (an address, code or not: a proxy's predicted address), `cancelDistributor`,
`acceptDistributor` (after `DISTRIBUTOR_DELAY`, 2 days, and only a contract whose `owner()` is the vault's owner,
`vault()` the vault and `predecessor()` the current distributor), `sweep`. A replacement MiningSites proxy is deployed
with `initialize` in its constructor (the only place it can run, for every proxy of the family: `OwnedUUPS.__Owned_init`
refuses anywhere else, so a proxy deployed without it can never be set up; it accepts the vault's pending distributor
and records the current one as its predecessor, which must answer `bookOf` unless it has no code at all, a predicted
address nothing was deployed at, whose books are empty). The vault's checks catch mistakes, not a contract built to
lie, so the owner proposes only a proxy it deploys itself, from its own wallet. It carries each player's site,
`settled` and `claimed` over (`bookOf` reads through; a player's first `openSite`, `upgradeSite` or `claim` imports
them; levels as they are), and the replaced one retires: its `openSite`, `upgradeSite` and `claim` revert `NotActive`.
Per-day counters restart at a replacement. The launch's vault is given the MiningSites proxy's predicted address: a
hard precondition the deploy script checks (the deploying wallet sends nothing else meanwhile).

**CrafterLevels** (UUPS proxy): `levelOf(tokenId)` (1 until upgraded), `upgrade(tokenId, maxCost)` by the token's
holder for `upgradeCost(level + 1)`, never more than `maxCost` (75% burned; costs 2,310, 9,471, 38,831, 159,207 at launch, each at most 2,000,000), `maxLevel`,
`upgradeCosts`, `upgradeBurnBps`; event `CrafterUpgraded(uint256 indexed tokenId, address indexed holder, uint256 level,
uint256 cost, uint256 burned)`. `attributesOf(tokenId)` is the DEGEN's "Level" trait. Owner: costs, burn share,
`addLevel(cost)`, treasury, upgrades.

**MinePayments** (UUPS proxy): `pay(kind, amount, ref)` takes `amount` from the caller (exact approval), burns the
kind's `burnBps` and sends the rest to the treasury; event `Paid(address indexed player, uint256 indexed kind, uint256
amount, uint256 burned, bytes32 indexed ref)`. Kinds: 0 "shop" (7,500), 1 "ticket" (0), 2 "revive" (0: 420 $MINE to revive on the spot after dying on the home planet); `kind(i) → (name, burnBps)`,
`kindCount()`. Owner: `setKindBurn`, `addKind` (up to 32), treasury, upgrades. Prices are the game's, not the
contract's. The game makes `ref` 32 random bytes per payment.

How the game pays: approve exactly the price for the contract that takes it (unless the allowance is exactly that
already), then call it (`chain.js` `payMine`). Site upgrades and DEGEN levels are on-chain state the game reads back.
The shop checks its own receipts (the Paid event with this wallet, kind 0, the price and its `ref`): inventories live
in the browser, and every delivered payment's hash is remembered there, so none delivers twice. Tickets are checked by
the world server (below).

## Shared world (multiplayer/)

One Durable Object holds the world: a small planet, 512 x 512 blocks (chunks of 16 x 16 x 128) that wrap round in x
and z (no border: walk past 511 and you're back at 0; every distance is measured the short way round), with a
protected town at the centre. The game draws it curved, as a sphere 512 blocks round (`web/planet.js`); the rules
and physics stay flat. The terrain comes from a seed (`web/worldgen.js`, identical in the browser and the Worker); the room
stores only edits, per chunk, flushed in batches (free-plan write budget). Positions are sent ~2 a second while
moving and relayed to nearby players. Monsters are spawned by the room for each player (at night, or underground)
and simulated by that player's game; hits are checked by the room. Free plan only: keep messages down.

## The rocket's zones

The rocket flies between planets (`web/zones.js`): home, Deepvein (2x $MINE, grows back weekly), Cinderfall (the boss)
and Red Mesa (PvP). Each is its own 512-block planet from its own seed (`web/zonegen.js`; `tools/check-worldgen.mjs` checks
that naturalBlock and generateChunk agree on every one). The room keeps each player on one planet: positions, edits,
monsters, block checks, voice and join/leave only within it; chat everywhere. A trip out (home to a zone, or zone to
zone) uses a ticket (`useTicket` in the room: always yes while `TICKETS_FREE`), the way home never does, and the room
remembers each wallet's zone (`zone:<wallet>`) and puts it back there when it signs in again.

Tickets (unless `TICKETS_FREE`, which makes every trip free and the room sell none): a signed-in player pays the
zone's `ticket` with `MinePayments.pay(1, price, ref)` and sends `["ticket", txHash, zone]`. The room reads the
receipt from `CHAIN_RPC` and keeps one ticket to that zone for the wallet (`tix:<wallet>`, zone -> count, no expiry)
only if the transaction succeeded; it holds a `Paid` log from `PAYMENTS_ADDRESS` whose player is the signed-in wallet,
kind 1 and amount at least that zone's price; its block is at most 3 hours old; and the hash never bought a ticket
before (`tixTx:<hash>`, kept for good; the same hash sent twice at once is checked once). `useTicket` takes one on the
way out; the way home is free; guests can't fly out. The game keeps a paid hash the room hasn't confirmed and sends it
again after the next sign-in.

Knock-outs (`web/zones.js` `CHEST_MS`, `REVIVE_*`): any knock-out, anywhere (falls, monsters, the boss, PvP, the void),
drops the whole inventory, armor included with its wear, as a loot chest where the player fell. The game reports it once
(`["dead", stacks, x, y, z, killer]`) and empties its bag; the room makes the chest only for a player who is up (then
`a.dead` until a respawn or revive: one chest per knock-out), cleans the stacks (`cleanItems`, at most `CHEST_STACKS` 40),
takes the reported spot only if it's within reach of the last heard position (else its own; a fall out of the world is
lifted onto the ground), keeps at most one open chest per player (wallet, or guest connection; a new one replaces the
old), allows three in a row and then one every 20 s (the rest make none and the game keeps what it carried: `dropno`) and
200 in all, and stores them under `chests`. A chest lasts `CHEST_MS` (5 minutes) and goes, once, to the first player on
that planet within `CHEST_REACH` who opens it, its owner included. Knocked out in a zone, the room sends the player home
at once (`move(..., ko)`: to the town square, still down, the wallet's zone forgotten); the chest stays in the zone; no
revive there; the ticket out was used, so going back needs a new one. At home the game offers "Respawn at spawn" (free)
and "Revive here": `REVIVE_PRICE` 420 $MINE ($1 at a $50K market cap) paid with `MinePayments.pay(2, price, ref)` (kind
2 "revive", nothing burned), then `["revive", txHash]`; the room checks the receipt as `buyTicket` does (shared
`paidBy`: success, a Paid log from `PAYMENTS_ADDRESS` by the signed-in wallet, kind 2, amount at least the price, at most
3 hours old) and that the hash never revived anyone (`revTx:<hash>`, written only when it does), then stands the player
at the stored death spot (`a.died`, and per wallet in memory for 30 minutes, for a game that reconnected while down), so
the next position is no jump. Free (no hash) before launch (no `PAYMENTS_ADDRESS`), while `REVIVE_FREE`, and offline
(the game keeps its own chest); guests can't pay. A valid payment the room didn't use (the player was up first) answers
retry 2, and the game keeps it for the next revive.

Protocol additions (client → room):
`["hello", {zone}]`, `["zone", key]` (fly), `["ticket", txHash, zone]`, `["bosshit", damage]`, `["pvp", target, damage]`,
`["dead", stacks, x, y, z, killer]` (any knock-out; a game from before may still send `["pvpdead", killer, stacks]`),
`["respawn"]`, `["revive", txHash | null]`, `["loot", chestId]`; (room → client): `["zoned", key, players, at]`, `["tickets", { zone:
count }]` (after signing in, buying and using one), `["ticketok", zone, count, txHash]`, `["ticketno", zone, why, txHash,
retry]` (retry 1: the chain couldn't be read, the same hash may do later), `["count", n]`, `["sys", text]`,
`["regrow", key]`, `["boss", hp, max, act, t0, ms, fromX, fromZ, toX, toZ, target, aim, downUntil]`, `["bosshp", hp, by,
counted]`, `["bossreward", units, share%, items, signedIn]`, `["pvphit", from, damage, dirX, dirZ]`, `["pvpno", target,
why]`, `["dropped", chestId]` (0: nothing dropped), `["dropno", why]`, `["chest", id, x, y, z, until, who]`, `["chests",
list]` (every planet's, on joining and arriving), `["chestgone", id, by]` (`by` null: replaced), `["looted", id, stacks,
who]`, `["lootno", id, why]`, `["revived", x, y, z, txHash]`, `["reviveno", why, txHash, retry]` (retry 1: the chain
couldn't be read; 2: the payment wasn't used and can pay for a later revive; 0: never); `welcome`'s flags carry
`reviveFree`; `edits` carries the zone, `join` a "landed" flag (or "ko" and the zone left, after a knock-out there) and
`leave` the planet flown to (and "ko"). The boss's moves are one message each (no per-frame traffic); its timers run only
while someone is in the fight.

## Ledger units and boosts on the wire

Every $MINE amount the room sends is in units of 1/10,000 $MINE (`rewards.js` UNIT): `["earn", units, today, total,
what]` (`what` a block id, a monster, "boss", or "cap" / "worldcap" with 0), `["signedin", wallet, token, today, total,
dailyCap, name]`, `["bossreward", units, ...]`. Vouchers stay 18-decimal wei of the lifetime total (units x 1e14). NFT
boosts (`web/boosts.js`): client → room `["wear", crafterId | null]` (the DEGEN slot, as before) and `["equip", slot,
tokenId | null]` (any other slot: checked with `ownerOf` and the slot's `tierOf` on its contract; "coming soon" while it
has none) and `["recheck"]` (read what the player uses again now, sent after leveling up the DEGEN they wear; two at
once, then one every 15 s; answered with a boost); room → client `["boost", speed, earn, cap, move, sources, dailyCap]`,
sources `[slot, label, speed, earn, cap, move]` per item, dailyCap in units for the zone the player is on (sent after a
wear or equip, a flight, a recheck, and when a re-check changes it). Local testing only (`wrangler dev --var DEV_HOOKS:1`, connections to that local server):
`["dev", "today" | "world", mine]`.

## Local ports (so Courier's dev setup can run at the same time)

Anvil 8610, site 5810, local room 8790.
