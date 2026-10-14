# MineWorldCraft

A tiny round planet of blocks in the browser: mine, fight monsters, build, meet the villagers, and earn **$MINE** on
Robinhood Chain.

Everything is original: the code, the block textures (drawn pixel by pixel in `web/textures.js`), the creatures, the
Crafters and the town. No Minecraft code, textures, sounds or names are used, and the game says it isn't
affiliated with Mojang or Microsoft. Built on what worked in Courier World
([github.com/AdamNakamoto/courierworld](https://github.com/AdamNakamoto/courierworld)): plain HTML/JS with three.js,
a Cloudflare Worker for the shared world, Foundry contracts reusing Courier's audited hook, NFT and voucher code.

![The planet](docs/planet-globe.jpg)
![The town](docs/town-road.jpg)
![The planet curving away from a mountain](docs/planet-mountain.jpg)

## Layout

- `web/`: the site (no build step; three.js and viem load from esm.sh). Set the hosting root to `web`.
- `multiplayer/`: the world server, a Cloudflare Worker with one Durable Object.
- `contracts/`: Foundry project (`git submodule update --init --recursive`).
- `dev.sh`: a local chain, the contracts and the site.
- `docs/DESIGN.md`: the design the three parts share.

## Run it locally

```bash
./dev.sh
```

Starts Anvil on port 8610, deploys $MINE, MiningSites and the Crafters, gives the dev players (Anvil accounts 2-9) some
$MINE and two revealed Crafters each, writes `web/chain.json` and `multiplayer/.dev.vars`, and serves the site at
http://localhost:5810. Then, once it prints "Game", start the local world server (it reads `.dev.vars` when it starts,
so start it after `dev.sh`, and restart it whenever `dev.sh` restarts):

```bash
cd multiplayer && npm install && npx wrangler dev --port 8790
```

On localhost the game joins the local server automatically (`web/config.js`); `?mp=` with nothing plays offline, and
`?t=0.25` fixes the time of day at noon (localhost only: the sky and the villagers' hours). `./dev.sh --fork` runs the full launch on a fork of Robinhood Chain
(the real PoolManager, IMD and IMD/ETH pool), so the panel's trade box works with play money. `--wallet` logs in with
your own browser wallet on a practice chain (chain ID 466400); `--sale` leaves the Crafters mint open and sealed. A fork
reads Robinhood Chain's official RPC; where a network's DNS blocks that name (Anvil then reports a certificate error),
run `python3 tools/rpc-relay.py` and fork through it: `FORK_URL=http://127.0.0.1:8611 ./dev.sh --fork`.

## How to play

WASD to move, Space to jump, Shift to sprint, the mouse to look. Hold the left button to mine (or attack, or click a
villager to talk), right click to place the block in your hand or hold it to eat, 1-9 or the wheel to pick, **E** the
inventory and crafting, **M** the Mining Site panel, **V** to see your miner from outside, **B** voice chat, **T** or
Enter to chat, **Esc** the menu (your name, voice, settings). Phones get a stick, look-by-drag, and mine / place / jump
buttons. Chat commands: `/wild` (a safe random spot far from spawn), `/spawn`, `/sethome` and `/home`, `/help`.

Punch a tree for logs, craft planks and sticks, then a wooden pickaxe; stone needs a pickaxe, iron ore a stone one,
gold, diamonds and $MINE crystals an iron one. Monsters (Mudlings, Cave crawlers, Bone rattlers, Rock golems) come out
at night and underground. Food keeps you going: the hunger bar drains as you move, mine and fight; apples drop from
leaves, berries from bushes, and a red and a brown mushroom with a plank make stew. A full belly heals you, an empty one
hurts, and you need food to sprint (`web/vitals.js`).

The Smithy's shop (**H**, or Garrick the armorer at the Smithy's door; `web/shop.js`) sells tools for mining (up to the
Crystal pickaxe, the fastest), weapons (up to the Crystal sword and the slow, heavy war hammer) and armor: helmet,
chestplate, leggings and boots in Padded, Iron, Diamond and Crystal. Armor takes a share of monsters' hits (a full
Diamond set, 20 points, takes two thirds), shows as a row over the hearts and on your miner for everyone to see; click
a piece in the inventory to wear it. Prices are in $MINE but **nothing is charged while the game is being tested**
(`FREE_WHILE_TESTING`); paying with the $MINE token on-chain comes later, at the same prices.

## The planet

The world is a tiny planet, as in Courier World: 512 blocks round in every direction, with no edge (walk any way and
you come back where you started). The blocks stay square and physics stays flat, but everything is drawn bent round a
sphere of radius 512 / 2π, about 81.5 blocks, as seen from the camera (`web/planet.js`; the chunks bend in their
shader, everything else is placed each frame), so the horizon curves close by and mountains fall away behind it. The
title screen shows the whole planet as a turning globe (`web/globe.js`, from a map the world worker draws). The terrain
(`web/worldgen.js`) tiles seamlessly: plains, forests, flower meadows, dark forests of giant trees, pine taiga, deserts,
snow, peaks, seas and beaches, caves and ores; `tools/check-worldgen.mjs` checks that the game and the server agree on
every block, across the seams too. Chunks are generated and meshed in a Web Worker (`web/world-worker.js`); the view
reaches up to 15 chunks.

## The town and its villagers

The town at the top of the planet (`web/town.js`) is protected: nobody mines or builds within 64 blocks of the
fountain (the first try explains, and offers `/wild`). Stone main roads and gravel lanes, the plaza and the Mining
Office, a bakery, smithy, library, trading post, two-storey tavern, barn, town hall, clock tower and watchtower,
eleven houses, a flower garden, a pond, an orchard and gates. Fourteen villagers (`web/villagers.js`) live in the
houses, work in the shops and walk the roads to the plaza, the garden and the pond, then go home at dusk; where each
one is follows the clock alone, so every player sees them in the same place with nothing sent over the network. Click
one to talk: they know the game.

## Players

Other players walk the planet with you, with name tags and the Crafter they wear. After signing in (Mining Site panel),
pick a name in the menu: 3 to 15 letters, numbers or `_`, first come first served, changed at most once a day; reserved
and offensive names are refused (`web/name-rules.js`, from Courier World; add one to `BANNED` to take it down). Chat
lines (no links or wallet addresses) and who joined or left show in the chat box; clicking a name mutes that player.

Voice chat (`web/voice.js`) is off until a player turns it on (B, or the menu). Players with voice on who stand within
about 32 blocks talk directly, browser to browser (WebRTC); the world server only passes on the messages that set a
connection up, and only between nearby players who both have voice on. Voices fade with distance. It uses public STUN
servers only, so players behind strict networks may not connect until a TURN relay is added.

## The economy

| | |
|---|---|
| $MINE | 1,000,000,000, fixed, minted once. ERC-20 with permit; no owner, no mint, no transfer tax |
| Liquidity | 50% (500M) locked forever, single-sided, in one $MINE/IMD Uniswap v4 pool |
| Mining vault | 50% (500M) in `MiningSites`, paid out only for what players earn in the game |
| Trading fee | Every swap pays 4% of its IMD side to `0x6e85Dc9f094b7DD35a2A981AbBd0AC9C496670eD` (taken by the pool's hook; the hook is renounced at launch, so only that wallet can ever move its own fee) |
| Mining site | Opened once per wallet with ETH (0.005 at launch), paid to the treasury. Needed to convert earnings to $MINE |
| Crafters NFT | 3,333 cosmetic pixel-art characters, drawn and stored entirely on chain, no two alike. Free blind mint (5 a transaction, 10 a wallet; the owner can set a price, paid straight to the treasury), revealed after the mint. 5% royalty, enforced |
| No yield farming | Nothing pays for holding or waiting. $MINE comes only from playing |

**Earning.** Signing in with a wallet (one free signature) makes the world server count that wallet's earnings:
breaking natural blocks and defeating monsters, at the rates in `web/rewards.js` (stone 0.5, coal 3, iron 8, gold 20,
diamond 60, a $MINE crystal 150; monsters 6-25). Blocks players placed pay nothing. A wallet earns up to 3,000 $MINE a
UTC day. To add an activity or change a rate, edit `web/rewards.js` and deploy the server and the site.

**Checks.** The server runs the same world generator as the game (`web/worldgen.js`), so it knows what every block
was. It pays for a break only if the block is really there, within reach of where the player really is, outside the
town, and not faster than the best pickaxe allows; monsters are spawned by the server, and hits come no faster and no
harder than the best sword's. A player who moves faster than anyone can earns nothing for a while.

**Converting.** With a mining site open, **Convert to $MINE** asks the server for a voucher for the wallet's lifetime
total and `MiningSites.claim` pays the difference from what it has paid before, within a per-wallet daily cap (5,000)
and a global one (1,000,000); the owner can change both up to hard limits (100,000 and 5,000,000) and pause claims. A
leaked server key can take at most the daily caps until it's paused and replaced.

## Contracts

| | |
|---|---|
| `MineToken.sol` | $MINE: 500M to the hook (pool), 500M to MiningSites (vault) at deploy |
| `MineHook.sol`, `MineRouter.sol`, `MineEthRouter.sol` | Courier's audited `StampHook` and routers for $MINE: one pool, locked launch liquidity, 4% fee on the IMD side, buy/sell with IMD or ETH. Differences from StampHook: launch supply up to 1B, lowest start tick -300,000 (as CourierPad), market cap over the fixed supply |
| `MiningSites.sol` | Mining sites (ETH, once per wallet) and the vault's claims: EIP-712 vouchers from the world server, daily caps, pause. Ownable2Step, can't be renounced |
| `MineWorldCrafters.sol` | MineWorld Crafters (Courier Skins adapted): 3,333 Crafters, commit-reveal, traits from a keyed shuffle (each token a different hair, outfit, eyes and gaze) and weighted picks, fully on-chain metadata and pictures, enforced 5% royalty (ERC721-C, OpenSea's registry). The owner can update the website and social links (`setLinks`) and the collection's picture and banner (`setCollectionImages`) shown on OpenSea at any time |
| `CrafterArt.sol` | The Crafters' pictures as 24 x 24 SVGs, generated from `web/crafters-art.js` and `web/crafters.js` by `tools/gen-crafter-art.mjs`; never edit it by hand |

```bash
cd contracts
forge test                                  # unit + invariant tests
forge test --fork-url robinhood             # plus the fork tests against Robinhood Chain
./script/deploy-mainnet.sh launch           # dry run of the launch on a fork
./script/deploy-mainnet.sh crafters         # dry run of the Crafters
```

The JS in `web/crafters-art.js` and `web/crafters.js` defines every Crafter. After changing either, regenerate the
contract and its test vectors (no npm needed), then run the tests, which check the contract draws exactly what the JS
draws and fail while the generated files are stale:

```bash
~/.local/node/bin/node tools/gen-crafter-art.mjs           # writes contracts/src/CrafterArt.sol, contracts/test/CrafterVectors.sol
~/.local/node/bin/node tools/gen-crafter-art.mjs --check   # or only check they're up to date
```

Settings are in `contracts/launch.env` (public values only). The real launch, after an audit:

1. Generate the server's voucher key straight into the Worker (never print it) and note its address:
   `npx wrangler secret put MINING_KEY` in `multiplayer/`.
2. `MINING_SIGNER=<that address> ./script/deploy-mainnet.sh launch --broadcast --browser --browser-disable-open`
   (sign at http://127.0.0.1:9545 with the wallet on Robinhood Chain; it becomes the owner of MiningSites).
3. `./script/deploy-mainnet.sh crafters --broadcast --browser --browser-disable-open` (the art, then the collection
   with the sale closed; the reveal secret goes to `~/mineworldcraft-crafters-reveal-secret.txt`, never printed; keep
   it safe). Open the mint with `setSaleOpen(true)`; after it, `setSaleOpen(false)`, wait for the next block, then
   `reveal(secret)`.
4. Set `CHAIN_ID`, `CHAIN_RPC`, `MINING_ADDRESS` and `CRAFTERS_ADDRESS` in `multiplayer/wrangler.toml`, deploy the
   Worker, put its address in `web/config.js` (`LIVE_ROOM`) and its domain in the Worker's `ORIGINS`, and publish the
   site with `web/deployments/robinhood.json` (written by `export-web.sh`).
5. On OpenSea: set the collection's links and pictures (or call `setLinks` and `setCollectionImages`) and turn on
   creator earnings.

## The world server

```bash
cd multiplayer
npx wrangler deploy
```

One Durable Object holds the world: who's playing, every edit (per chunk), the monsters, chat, names, voice set-up
messages and the $MINE ledger (16 shards). The terrain itself is never stored: both sides generate it from the same seed. Built for Cloudflare's
free plan: hibernating WebSockets, pings answered without waking the room, positions sent only while moving, writes
batched every 30 seconds (the free plan allows 100,000 requests and 100,000 written rows a day per account, shared by
every Worker on it, so a separate Cloudflare account keeps Courier World's room unaffected).
