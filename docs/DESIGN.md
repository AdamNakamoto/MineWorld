# MineWorldCraft: version one

A blocky mining world in the browser (original code, textures and creatures; no Minecraft assets), with an
on-chain economy on Robinhood Chain. Built on what worked in Courier World (github.com/AdamNakamoto/courierworld):
plain HTML/JS + three.js, a Cloudflare Worker + Durable Object for the shared world, Foundry contracts, the audited
$STAMP hook for the 4% fee, the audited enforced-royalty NFT pattern, and server-signed EIP-712 vouchers.

## Money flows

| | |
|---|---|
| $MINE | ERC-20 + permit + burnable, name "MineWorldCraft", symbol "MINE", fixed supply 1,000,000,000 minted once at deploy. No owner, no transfer tax |
| 50% liquidity | 500,000,000 $MINE locked single-sided in one MINE/IMD Uniswap v4 pool by `MineHook` (a copy of the audited `StampHook`), locked forever |
| 50% to mine | 500,000,000 $MINE held by `MiningSites`, paid out only to players for what they earn in the game. Nobody (not the owner) can withdraw it any other way |
| 4% trading fee | Every swap pays 4% of its IMD side to `0x6e85Dc9f094b7DD35a2A981AbBd0AC9C496670eD` (the fee recipient). Plain transfers are never taxed |
| Mining site | Opened once per wallet with ETH (0.005 ETH at launch, owner-settable, never zero), paid straight to the treasury. Needed to convert earnings to $MINE. Not transferable |
| NFT | "MineWorld Crafters": 3,333 characters from the user's own pixel-art designs, drawn and stored fully on-chain (the contract builds each SVG from the trait layers in `web/crafters-art.js`). Free mint (gas only; price owner-settable), per-wallet limit, commit-reveal. No two alike: hair x outfit x eyes x gaze is a different one of 6,912 combinations for every token; background, skin, hat and blush are weighted. The Crafter a player wears is how their miner looks in the game (cosmetic only). 5% royalty, enforced (ERC721-C, OpenSea's registry), rate fixed. Owner can update the collection's website and social links shown on OpenSea at any time |
| Treasury | Site sales, any NFT mint price and the NFT royalty. Defaults to the fee recipient `0x6e85…70eD`; separate setting |

No auto yield farming: nothing pays for holding or waiting. $MINE is only paid for things players do in the game.

## Earning and converting

1. A player signs in with their wallet (one free signature, no transaction). Guests can play but earn nothing.
2. Real activity earns $MINE on the server's ledger: breaking natural blocks (more for rarer ores) and defeating
   monsters. The table is `web/rewards.js`, shared by the game and the server, so new activities and new rates are
   one edit there. Placed blocks pay nothing when broken again, so building and re-mining earns nothing.
3. The server checks each action: the block is really there (it runs the same world generator as the game), within
   reach of where the player really is, not faster than the best pickaxe allows, outside the protected town; a
   monster was really spawned for that player, hits come no faster than a sword swings and no harder than the best
   sword. Each wallet earns at most a daily cap (server-side).
4. To convert, the player needs an open mining site (on-chain). The server signs a voucher for the wallet's
   lifetime total earned; `MiningSites.claim` pays the difference from what it already paid, within a per-wallet
   daily cap and a global daily cap (both owner-settable below hard maxima, they bound what a leaked server key could
   take a day), and the owner can pause claims.

## MiningSites contract (the spec the game and the server rely on)

- `openSite()` payable: exactly `sitePrice`, once per wallet, ETH forwarded to `treasury`. `siteOf(address) → uint64
  openedAt` (0 = none), `hasSite(address) → bool`. Event `SiteOpened(address indexed owner, uint256 price)`.
- `claim(uint256 total, uint64 deadline, bytes signature)`: msg.sender must have a site, not paused, `deadline` not
  passed, EIP-712 signature by `signer` over `Earnings(address player,uint256 total,uint64 deadline)` with domain
  name "MineWorldCraft Mining", version "1". Pays `min(total - claimed[player], wallet's daily room, global daily room,
  vault balance)`, reverts `NothingToClaim` if that is 0. `claimed(address) → uint256`. Day = `block.timestamp / 1 days`.
  Event `Claimed(address indexed player, uint256 amount, uint256 totalClaimed)`.
- `claimable(address player, uint256 total) view → uint256` (what a claim would pay now, 0 without a site or paused).
- Views for the panel: `sitePrice`, `treasury`, `signer`, `paused`, `walletDailyCap`, `dailyCap`, `paidToday()`,
  `walletPaidToday(address)`, `token`, `vaultBalance()`.
- Owner (Ownable2Step, renounce reverts): `setSitePrice`, `setTreasury`, `setSigner`, `setPaused`, `setCaps(wallet,
  global)` within `MAX_WALLET_DAILY_CAP` (100,000 $MINE) and `MAX_DAILY_CAP` (5,000,000 $MINE), `sweep(token, to)` for
  tokens other than $MINE sent by mistake. Defaults: 5,000 $MINE a wallet a day, 1,000,000 across everyone.

## Shared world (multiplayer/)

One Durable Object holds the world: a small planet, 512 x 512 blocks (chunks of 16 x 16 x 128) that wrap round in x
and z (no border: walk past 511 and you're back at 0; every distance is measured the short way round), with a
protected town at the centre. The game draws it curved, as a sphere 512 blocks round (`web/planet.js`); the rules
and physics stay flat. The terrain comes from a seed (`web/worldgen.js`, identical in the browser and the Worker); the room
stores only edits, per chunk, flushed in batches (free-plan write budget). Positions are sent ~2 a second while
moving and relayed to nearby players. Monsters are spawned by the room for each player (at night, or underground)
and simulated by that player's game; hits are checked by the room. Free plan only: keep messages down.

## Local ports (so Courier's dev setup can run at the same time)

Anvil 8610, site 5810, local room 8790.
