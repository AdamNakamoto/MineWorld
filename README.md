# MineWorldCraft

A tiny round planet of blocks in the browser: mine, fight monsters, build, meet the villagers, and earn **$MINE** on
Robinhood Chain.

Everything is original: the code, the block textures (drawn pixel by pixel in `web/textures.js`), the creatures, the
I'M DEGEN characters and the town. No Minecraft code, textures, sounds or names are used, and the game says it isn't
affiliated with Mojang or Microsoft. Built on what worked in Courier World
([github.com/AdamNakamoto/courierworld](https://github.com/AdamNakamoto/courierworld)): plain HTML/JS with three.js,
a Cloudflare Worker for the shared world, Foundry contracts reusing Courier's audited hook, NFT and voucher code.

![The planet](docs/planet-globe.jpg)
![The town](docs/town-road.jpg)
![The planet curving away from a mountain](docs/planet-mountain.jpg)
![Twelve I'M DEGEN cards, drawn on chain from their skins](docs/degen-cards.jpg)

## Layout

- `web/`: the site (no build step; three.js and viem load from esm.sh). Set the hosting root to `web`. `web/docs.html` is
  the players' game guide (https://mineworldcraft.fun/docs), linked from the title screen and the menu with OpenSea and
  the audit report: keep its numbers in step with the code when rules or prices change.
- `multiplayer/`: the world server, a Cloudflare Worker with one Durable Object.
- `contracts/`: Foundry project (`git submodule update --init --recursive`).
- `dev.sh`: a local chain, the contracts and the site.
- `docs/DESIGN.md`: the design the three parts share.
- `docs/AUTOPILOT.md`: idle mining's rules and protocol (its numbers are in `web/bots-rules.js`).

## Run it locally

```bash
./dev.sh
```

Starts Anvil on port 8610, deploys $MINE, its vault, MiningSites, MinePayments, I'M DEGEN and CrafterLevels, gives the
dev players (Anvil accounts 2-9) 1,000,000 play $MINE (from a stand-in for the pool's half: there's no pool, so no
trade box, on a plain local chain) and two revealed DEGENs each, writes `web/chain.json` and `multiplayer/.dev.vars`,
and serves the site at
http://localhost:5810. Then, once it prints "Game", start the local world server (it reads `.dev.vars` when it starts,
so start it after `dev.sh`, and restart it whenever `dev.sh` restarts):

```bash
cd multiplayer && npm install && npx wrangler dev --port 8790
```

On localhost the game joins the local server automatically (`web/config.js`); `?mp=` with nothing plays offline, and
`?t=0.25` fixes the time of day at noon (localhost only: the sky and the villagers' hours). `./dev.sh --fork` runs the full launch on a fork of Robinhood Chain
(the real PoolManager, IMD and IMD/ETH pool), so the panel's trade box works with play money. `--wallet` logs in with
your own browser wallet on a practice chain (chain ID 466400); `--sale` leaves the I'M DEGEN mint open and sealed. A fork
reads Robinhood Chain's official RPC; where a network's DNS blocks that name (Anvil then reports a certificate error),
run `python3 tools/rpc-relay.py` and fork through it: `FORK_URL=http://127.0.0.1:8611 ./dev.sh --fork`.

## How to play

WASD to move, Space to jump, Ctrl (or W twice quickly) to sprint, Shift to sneak (you won't walk off an edge), the
mouse to look. Moving feels like Minecraft Java: the same 20 ticks a second and the same speeds and jump
(`web/physics.js`), view bobbing (it can be turned off in the menu) and its animations for every miner
(`web/avatar.js`). Hold the left button to mine (or attack, or click a villager to talk), right click to place the
block in your hand or hold it to eat, 1-9 or the wheel to pick, **E** the inventory and crafting, **M** the Mining
Site panel, **V** to see your miner from outside, **B** voice chat, **T** or Enter to chat, **F** the rocket (on its
pad), **Esc** the menu (your name, voice, settings). Phones get a stick (push it all the way to sprint),
look-by-drag, and mine / place / jump buttons. Chat commands: `/wild` (a safe random spot far from spawn), `/spawn`,
`/sethome` and `/home`, `/help`; on a zone they work within it (`/spawn` is its landing pad, `/home` only where it was set).

Punch a tree for logs, craft planks and sticks, then a wooden pickaxe; stone needs a pickaxe, iron ore a stone one,
gold, diamonds and $MINE crystals an iron one. Monsters (Mudlings, Cave crawlers, Bone rattlers, Rock golems) come out
at night and underground. Food keeps you going: the hunger bar drains as you move, mine and fight; apples drop from
leaves, berries from bushes, and a red and a brown mushroom with a plank make stew. A full belly heals you, an empty one
hurts, and you need food to sprint (`web/vitals.js`).

**Knocked out** (a fall, monsters, the boss, another player, the void), you drop everything you carry, the armor you
wear too (with its wear), in a loot chest where you fell. It stays 5 minutes (`CHEST_MS` in `web/zones.js`), and the
first player on that planet to open it takes it all, you included, as in Minecraft. You have one open chest at a time:
the next knock-out's replaces it. On the home planet the screen offers **Respawn at spawn** (free: the town square) or
**Revive here** for 420 $MINE (`REVIVE_PRICE`, $1 at a $50K market cap): you get up on the very spot you fell, with full
health and food as a respawn gives, in time to grab your own chest if nobody has. Reviving is paid like a rocket ticket
(MinePayments, the "revive" kind: all to the treasury, nothing burned) and checked by the world server; it's free before
$MINE launches ("Revive here (free until $MINE launches)"), while `REVIVE_FREE` is set, and offline. Guests can't pay,
so once revives cost $MINE they respawn in town. Knocked out in a zone, you're sent back to the home planet, with no
revive there: your things stay in the zone, in a chest anyone there can take for 5 minutes, and the trip back needs a
new ticket (yours was used on the way out). Offline, the game keeps your chest itself.

The Smithy's shop (**H**, or Garrick the armorer at the Smithy's door; `web/shop.js`) sells tools for mining (up to the
Crystal pickaxe, the fastest), weapons (up to the Crystal sword and the slow, heavy war hammer) and armor: helmet,
chestplate, leggings and boots in Padded, Iron, Diamond and Crystal. Armor takes a share of monsters' hits (a full
Diamond set, 20 points, takes two thirds), shows as a row over the hearts and on your miner for everyone to see; click
a piece in the inventory to wear it. Prices are in $MINE (from 2.5 for torches or apples and 4 for padded boots to 1,975
for the war hammer; the best full kit is 10,512.5; halved on 2026-10-16), paid on-chain: **Buy** approves exactly the price for MinePayments and
pays it (the "shop" kind: 75% burned, 25% to the project treasury), and once the receipt shows that payment the items go
into the inventory. Inventories live in the browser, so the game checks the receipt itself and remembers every payment
that delivered, so one payment never adds items twice; an order cut short after paying (a reload) is delivered the next
time the shop opens. Buying needs a logged-in wallet with enough $MINE (the shop shows the balance). `FREE_WHILE_TESTING`
in `web/shop.js` makes it all free again.

Tools, weapons and armor wear out, with the classic block games' numbers (`maxDurability` in `web/blocks.js`): wood 59
uses, stone 131, iron 250, diamond 1,561, crystal 2,031, the war hammer 1,200; armor by piece and tier (an iron
chestplate 240, a diamond one 528). A pickaxe wears 1 for each block it breaks (none for blocks that break instantly)
and 2 for each hit; a sword 1 for each hit and 2 for each block; each worn piece of armor a quarter of every monster's
hit (at least 1). A bar under the icon shows what's left (hover for the count), and at zero the item breaks. Two worn
copies of the same item combine into one at the top of the crafting list: their uses left, plus 5% of a new one's.

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
fountain (the first try explains, and offers `/wild`). Stone main roads and gravel lanes, the plaza and Mining Sites
(the office), a bakery, smithy, library, trading post, two-storey tavern, barn, town hall, clock tower and watchtower,
eleven houses, a flower garden, a pond, an orchard and gates. Fourteen villagers (`web/villagers.js`) live in the
houses, work in the shops and walk the roads to the plaza, the garden and the pond, then go home at dusk; where each
one is follows the clock alone, so every player sees them in the same place with nothing sent over the network. Click
one to talk: they know the game.

## The rocket and its zones

A rocket stands on the launch pad in the town's north-east (`web/town.js` `LAUNCH`, on open grass between the north
road, the lane and the clock tower). Click it, or stand on the pad and press **F**, for the destination card; it lifts
off, the screen fades to the destination turning in space, and you land on its pad (`web/rocket.js`). **Tickets:** one
ticket per trip out (home to a zone, or a zone to another), with no time limit; the way home is always free, and from
home the next trip out needs a new one. DEGENs deployed for idle mining don't travel and need none. The world server
remembers each wallet's zone, so a reload or a dropped connection lands you back there. A ticket costs the zone's
`ticket` in $MINE, paid in full to the treasury: Deepvein and Cinderfall 2,100 each, Red Mesa 210. Sign in, then buy on
the rocket's card (one ticket, or several with its − and +): the game approves exactly their price for MinePayments and
pays it in one payment (the "ticket" kind), and hands the world server the transaction; the server reads its receipt
and, if the payment succeeded, came from that signed-in wallet, was a ticket payment of at least that zone's price, is
at most 3 hours old and never bought tickets before, keeps for the wallet as many tickets as it covers, up to 5
(`TICKETS_MAX`). A payment buys tickets once. The card then says how many you have there; the next trip out there uses
one. Guests can't fly out. `TICKETS_FREE` in `web/zones.js` makes every trip free again. Every zone is its own 512-block
planet, bent like home, from its own seed (`web/zonegen.js`); its landing pad (the middle of the planet) is protected
for 20 blocks: no mining, building or fighting there. Everything tunable is in `web/zones.js`; what the zones pay is in
`web/rewards.js` (`ZONE_PAY`, `BOSS_POOL`).

| Zone | | |
|---|---|---|
| Home planet | No PvP | The town and its villagers |
| **Deepvein**, the 2x Mine Zone | No PvP | Rocky crags riddled with caves, stone over harder deep rock (1.5x stone's breaking time), glowcaps on cave floors, rare ores three times as common (iron 2x, coal 1.5x). Everything a player earns pays **2x** (blocks and monsters; idle mining earns the same on every planet), within the usual cap (1,500 a day for a player's own play, more with a cap boost). Monsters come day and night, up to 5 at once, about every 10 s, with 1.5x health and damage. Its edits are kept a week at a time: every Monday 00:00 UTC it grows back |
| **Cinderfall**, the Boss Zone | No PvP | Ash plains, basalt, volcanoes with glowing craters, cracks of fire and ember-tipped spires. A stone-brick path runs north from the pad to the arena, where **Ashgrim, the Cinder Colossus** (an original giant of cooled lava with a molten heart, 1,500 HP) fights everyone at once |
| **Red Mesa**, the PvP Zone | PvP off the pad | Terraced mesas in banded clays over red sand, dry riverbeds and cacti. Players can hit each other; a player beaten here drops everything they carry and is sent home |

**The boss.** The world server keeps its health and picks its moves; every game animates each move from its start time,
so all see the same thing and nothing is sent while it moves. It walks towards someone, **slams** both fists (a red ring
on the ground shows the reach: step out before they land), **throws a molten rock** at where someone stands (an orange
ring marks it: move off it), and once it's under 60% it **calls up monsters** beside it. The server checks every hit on it
(no faster than a sword, at most the war hammer's 9, from within reach of where it is). Beaten, it pays 150 $MINE (`BOSS_POOL`) shared
by the signed-in players who hit it, by the damage each did (each share with its player's earn boost, through the ledger
and its caps), plus diamonds, gold, iron
and $MINE crystals for everyone who did 5% or more (more, and maybe a Crystal sword, for the top hitter); it's back 10
minutes later. Left alone it heals.

**PvP.** Only in Red Mesa, never on its pad, and nowhere else (the zone's `pvp` flag; elsewhere other players can't even
be aimed at). The server checks each hit (both in the zone, off the pad, within reach, no faster than a swing, at most 9
damage, not just after landing) and passes it to the one hit, whose game takes off its armor's share and wear. A player
beaten there drops everything, as every knock-out does, and is sent home; the killer is named (to everyone in Red Mesa)
only right after a checked hit from them.

**Knock-outs in the zones.** Wherever it happens (Deepvein's monsters, Ashgrim's slam, another player in Red Mesa, a
fall), a player knocked out in a zone is sent back to the home planet's town square the moment their game reports it:
the others in the zone see them go ("knocked out and sent home"), the home planet sees them come back, and the server
remembers their wallet's zone as home. Their loot chest stays in the zone for 5 minutes, for whoever is there. There's
no revive in a zone, and going back needs a new ticket (free while tickets are). DEGENs deployed for idle mining keep
earning through it all.

**Loot chests and revives on the server.** Inventories live in the browser, so a chest holds what the knocked-out
player's game reports, cleaned up by the server (real items, counts within a stack, wear within durability, at most 40
stacks). A chest needs a knock-out report from a player who is up (from then on they're down until they respawn or
revive, so it's one chest per knock-out), and is placed where the game says they fell only if that's no further from
where the server last heard them than they could have gone (else where the server had them; lifted onto the ground after
a fall out of the world). A player has at most one open chest (a new one replaces it), three knock-outs in a row make
chests and then one every 20 seconds (the rest keep what they carried), and the server keeps at most 200 chests. A paid
revive is checked exactly like a ticket: the transaction succeeded and holds a Paid event from MinePayments by the
signed-in wallet, of kind 2, for at least 420 $MINE, at most 3 hours old, and the hash never paid for a revive before.
The server remembers where each player fell and accepts their next stand-up only at spawn or, after a valid revive (or
a free one), right there, so a revive isn't taken for a teleport. A payment checked after the player was already up again
isn't used: the game keeps it and it pays for the next revive within 3 hours.

## Players

Other players walk the planet with you, with name tags and the DEGEN they wear. After signing in (Mining Site panel),
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
| $MINE | 21,000,000 in all, the same as Courier World's $STAMP. ERC-20 with permit, no transfer tax |
| Liquidity | 50% (10,500,000) locked forever, single-sided, in one $MINE/IMD Uniswap v4 pool at launch |
| Mining vault | 50% (10,500,000), minted by `MineVault` only as players convert what they earn in the game: at most 35,000 a day, whatever the rules contract asks, so it lasts at least 300 days |
| Trading fee | Every swap pays 4% of its IMD side to `0x6e85Dc9f094b7DD35a2A981AbBd0AC9C496670eD` (taken by the pool's hook; the hook is renounced at launch: after the renounce only the current fee recipient can move the fees; nobody else can). The fees wait in the pool until someone calls `MineHook.collectProtocolFees(IMD)` (anyone may; it always pays the fee recipient): logged in with the project's wallet, the Mining Site panel shows an **Admin** box with the fees waiting and a **Claim fees** button, plus the treasury's balances and $MINE's numbers (`web/panel.js` `adminBox`, `web/chain.js` `adminStats`) |
| Mining site | Opened once per wallet with ETH (0.005 at launch), paid to the treasury. Needed to convert earnings to $MINE. A new site is level 1 and converts 50% of what it earns; upgrades raise it to 60%, 70%, 85% and 100% at levels 2 to 5, for 4,620, 18,942, 77,662 and 318,415 $MINE (about $1,000 for all four at a $50,000 market cap) |
| DEGEN levels | Every DEGEN starts at level 1; its holder raises it to level 5 for 2,310, 9,471, 38,831 and 159,207 $MINE (half a site's). The level stays with the DEGEN when it's sold, shows as its "Level" trait, and adds to its boost (below) |
| Shop and tickets | Paid in $MINE through `MinePayments` at the game's prices (`web/shop.js` `CATALOG`, `web/zones.js` `ticket`): the shop's 75% burned and 25% to the treasury; rocket tickets (2,100 for Deepvein or Cinderfall, 210 for Red Mesa; one per trip out; a payment buys as many tickets as it covers, up to 5) and revives (420, to revive on the spot after dying on the home planet: kind 2 "revive") all to the treasury |
| Idle mining | A signed-in player can deploy up to 4 of their other DEGENs to mine for them while they're online (connected and signed in): each Common or Rare earns its own daily cap (1,650 to 3,375 $MINE by its rarity and level, counted per token) spread over 24 hours, and each Legendary 1000 times that rate with no daily cap (93,750 to 156,250 an hour, since 2026-10-18), into the wallet's ledger total (not the player's own cap), always at its full rate. Offline, nothing. At most 4 different DEGENs a wallet a UTC day. Rules below, under Idle mining |
| Burns | Site upgrades and DEGEN levels burn 75% of what they cost and send 25% to the treasury, as the shop does. The token counts every mint against its 21M cap, so a burn is for good: the supply only ever shrinks from what was minted |
| NFT: I'M DEGEN | "I'M DEGEN" (symbol DEGEN; the contract is `MineWorldCrafters`): 3,333 frogs, each a full Minecraft-style skin (64 x 64, with the second layer), drawn and stored entirely on chain, no two alike (every token has a different face and top). The NFT's picture is the skin as a "skin card"; the one a player wears is their miner in the game, the same skin pixel for pixel, and boosts their mining by its rarity and level (below). Traits: background, skin (5 greens; Ice, Purple and Stone are Rare, Gold Legendary), eyes, mouth, cheeks, top (58: hoodies, tees, jackets, tracksuits, suits, miner's overalls and vests, sweaters, flannels; royal robes, space suits and iron armour Rare, gold armour Legendary), bottoms, shoes, headwear (caps, beanies, hard hats with a lamp, headphones, goggles, a straw hat, the hood on hoodies; wizard hat and viking helmet Rare, the crowns Legendary) and an accessory; about 69% Common, 25% Rare, 6% Legendary. Free blind mint for wallets only (no contracts, so one transaction can't sweep it through throwaway contracts), at most 3 a wallet (the owner can change that, 1 to 50, or set a price, paid straight to the treasury), then revealed: the owner publishes the secret committed at deploy, and the seed waits for the next block's hash, which anyone then locks in (`seal`) within about 26 seconds (the panel sends both at once), so nobody can pick looks or see them before everyone else. If nobody locks it in, only the owner can move it on to a new block, in public, at most 3 times; anyone can run `tools/sealer.sh` to lock it in the moment it can be. 5% royalty, enforced through the transfer validator the owner picks (it can relax that, in public) |
| Owner and treasury | `0x6e85Dc9f094b7DD35a2A981AbBd0AC9C496670eD` owns the vault, the three upgradeable contracts and I'M DEGEN, and is the treasury (site sales, the unburned share of upgrades and payments, tickets, any mint price, the royalty) and the fee recipient. Ownership moves in two steps and can't be renounced; it can be handed to a multisig or a timelock (I'M DEGEN's only to a wallet that can sign in to OpenSea Studio: launch step 10). A treasury must take ETH where ETH is sent to it (MiningSites and I'M DEGEN refuse one that doesn't) |
| Nothing offline | Nothing pays while a player is offline. $MINE comes only from the game: from playing, and from idle mining while the player is connected and signed in. An NFT merely held earns nothing, and NFT boosts only add to what a player does |

**What can change and what can't.** Fixed forever: the token (21M cap, no owner, no proxy, no pause, no blocklist, no
transfer tax), the mining vault (35,000 a day and 10,500,000 in all, not upgradeable; its distributor can only be
replaced in the open, two days after it's proposed, and only by a contract the vault's owner owns that carries the
players' books over), the pool's locked
liquidity and its 4% fee (the hook is renounced: after the renounce only the current fee recipient can move the fees;
nobody else can), and I'M DEGEN's art, rarities and 5% royalty rate. The royalty's enforcement is only as strict as
the transfer validator: the owner can relax it, plainly (point the collection at a validator that allows everything,
or loosen the collection's policy on OpenSea's registry), and either change shows on chain.
Upgradeable by the owner (UUPS proxies, every site,
level and total kept across upgrades): `MiningSites` (site price, upgrade costs, rates, burn share, more levels up to
20, the daily caps, the voucher key, pause), `CrafterLevels` (costs, burn share, more levels) and `MinePayments` (each
kind's burn share, new kinds). Whatever runs in them, nobody can mint more than the vault allows: the most an owner or
a leaked server key could take is the vault's 35,000 a day.

**Earning.** Signing in with a wallet (one free signature) makes the world server count that wallet's earnings: breaking
natural blocks and defeating monsters, at the rates in `web/rewards.js` (grass, dirt and sand 0.01; stone and logs 0.05;
coal 0.3, iron 0.8, gold 2, diamond 6, a $MINE crystal 15; monsters 0.6 to 2.5; Deepvein pays 2x). Blocks players placed
pay nothing. A player earns up to 1,500 $MINE a UTC day by their own play before boosts (`DAILY_EARN_CAP`, times a
zone's `capMul` in `web/zones.js`, 1 everywhere for now), and each of their deployed Common or Rare DEGENs up to its own
cap by idle mining (a deployed Legendary with no cap: below). What everyone earns together isn't capped (since 2026-10-18); converting is: at most 35,000 a day for
everyone (below, under Converting). The ledger counts ten-thousandths
of a $MINE, so a percentage boost on a 0.01 block is kept exactly. To add an activity or change a rate, edit
`web/rewards.js` and deploy the server and the site.

**NFT boosts.** Every NFT a player uses can boost their mining while they play (`web/boosts.js`, shared by the game and
the server; an NFT merely held earns nothing). One item per slot, and the slots add up: **speed** (blocks break that
much faster; the server allows for it in its break-rate check), **earn** (more $MINE for every block, monster and boss
share), **cap** (a higher daily cap) and **move** (faster walking, for the vehicles to come). Totals are capped at +150%
speed, +150% earn, +300% cap and +100% move. Today the **DEGEN** slot (I'M DEGEN) is live: its rarity gives Common +5%
speed, +5% earn, +10% cap; Rare +10/+10/+25; Legendary +20/+20/+50; its level (bought on-chain from CrafterLevels) adds
L2 +5/+5/+10, L3 +15/+15/+30, L4 +30/+30/+60, L5 +50/+50/+100, so a worn DEGEN makes a player's cap 1,650 (Common, level
1) to 3,750 (Legendary, level 5). Skins, companions, auras and vehicles have their slots and placeholder tables waiting
(contract `null`, "Coming soon" in the panel); the top of `web/boosts.js` says how to plug a collection in. The server
reads what a player owns when they sign in, wear or equip (`ownerOf`, the DEGEN's rarity from its seed, `levelOf`; a
level it can't read counts as 1 and is read again a minute later), checks again every 10 minutes while they earn, and
tells the game; the Mining Site panel (M) and a line under the HUD's earnings show it. A DEGEN deployed for idle mining
gets only its own DEGEN's cap (`itemBoost`), never the player's boost.

**Checks.** The server runs the same world generator as the game (`web/worldgen.js`), so it knows what every block
was. It pays for a break only if the block is really there, within reach of where the player really is, outside the
town, and not faster than the best pickaxe allows; monsters are spawned by the server, and hits come no faster and no
harder than the best sword's. A player who moves faster than anyone can earns nothing for a while.

**Converting.** With a mining site open, **Convert to $MINE** asks the server for a voucher for the wallet's lifetime
total (in wei) and `MiningSites.claim` converts the earnings it hasn't converted before at the site's rate (50% at level
1, up to 100% at level 5) at the moment it claims, so an upgrade before claiming converts everything still unclaimed at
the better rate. It pays within a per-wallet daily cap (35,000 $MINE since 2026-10-18: an upgrade raised its most,
`MAX_WALLET_DAILY_CAP`, from 3,500 to the vault's 35,000, and `setCaps` set it there; it was raised from 1,500 to 3,500
on 2026-10-17) and one across everyone (35,000, the vault's daily limit); the owner can change the caps and pause
claims. So there's no per-wallet limit of its own: one wallet can convert the whole day's 35,000. What everyone earns
isn't capped, and a deployed Legendary earns millions a day, so the 35,000 is first come, first served: the first
conversions after 00:00 UTC can take all of it, then nobody converts until the next 00:00 UTC, and what isn't converted
waits on the ledger for later days. Players together
can now earn more than the vault can ever mint (10,500,000 in all), so an earned balance isn't a promise that all of it
converts. The panel
shows both what you earned and what you'll receive. A leaked server key can take at most the daily caps until it's
paused and replaced.

**Upgrading.** The Mining Site panel (M) shows your site's level and rate, the next level's rate and cost, and an
**Upgrade to level N** button: it approves exactly that cost for MiningSites, then calls `upgradeSite(cost, rate)` with
the cost and the new level's rate it showed (75% burned, 25% to the treasury), and the claim box shows the new rate at
once. Under I'M DEGEN, **Levels** lists each DEGEN you hold with its rarity, level, boost, and the next level's cost and
boost; **Level up** approves exactly the cost for CrafterLevels, then calls `upgrade(tokenId, cost)`. If it's the DEGEN
you wear, the game asks the world
server to read it again at once (`["recheck"]`), so the new boost counts within seconds. Every $MINE payment in the game
approves exactly what it costs, never more, and every upgrade names the cost it was shown as the most it will pay
(`maxCost`; a site upgrade also the rate it was shown as the least it buys, `minRateBps`), so a price raised or a rate
cut meanwhile makes it fail (`CostAboveMax`, `RateBelowMin`) instead of charging for less, even from a wallet that
approved more. Short of $MINE? Buy some in the panel's trade box.

## Idle mining

A signed-in player can deploy up to 4 (`BOT_MAX`) of their other I'M DEGENs to mine for them while they're online, as
Courier World's couriers work at a post office: the player mines by hand with the DEGEN they wear, and the deployed
ones earn by time. Nothing walks, digs or wears out: there are no avatars and no pickaxes, and the world server pays
them on a timer. It replaced the digging autopilot bots on 2026-10-17. The whole design and the protocol, which the
game and the server follow exactly, are in [`docs/AUTOPILOT.md`](docs/AUTOPILOT.md); the shared numbers are in
`web/bots-rules.js` (import them, never copy them).

**Own cap, by time.** Each deployed DEGEN earns its own daily cap, `dailyCap` with that DEGEN's cap boost on the home
planet's terms (1,650 for a Common level 1, 3,750 for a Legendary level 5), spread over 24 hours online
(`IDLE_DAY_MS`): `idleRate(cap)` a millisecond, so 1,650 a day is 68.75 an hour (a Legendary earns 1000 times that,
with no cap: below). Its earn boost doesn't change the
rate (its cap boost already does), the player's boost never applies, and the planet doesn't matter: deployed DEGENs
don't travel and need no tickets. Counted per token id, so a DEGEN passed to another wallet keeps the same day. Idle
earnings go into the wallet's ledger total, so they convert like any earnings, but not into the player's own `today`.
MiningSites converts at most `walletDailyCap` (35,000 since 2026-10-18, the same as everyone's daily limit) a day per
wallet; the rest waits for later days, and the panel says so.

**Legendary: 1000x, no cap.** Since 2026-10-18 a deployed Legendary (rarity tier 2) idle-mines `LEGENDARY_IDLE_X`
(1000) times its normal rate, with no daily cap (`idleRateOf`, `idleUncapped`): 93,750 $MINE an hour at level 1 (its
2,250 cap over 24 hours, times 1000) up to 156,250 at level 5, so 2,250,000 to 3,750,000 a day online. Everything
else holds: online only, at most 4 deployed, 4 distinct DEGENs a wallet a UTC day, never the worn one. Common and Rare
deployed DEGENs are unchanged, and so is wearing a Legendary (its normal boosts, the player's normal daily cap).

**Online only.** A deployed DEGEN earns while its player's game is connected and signed in and was heard from in the
last 150 s (`IDLE_ONLINE_MS`: any message, or the game's 45 s ping, which the room answers without waking). Idle
players and hidden tabs count; offline (signed out, the tab closed, the phone asleep) earns nothing, and offline time is
never paid later. The world server pays every 5 minutes (`IDLE_TICK_MS`: a Durable Object alarm, set only while some
connected player has DEGENs deployed, so an empty room sleeps), one payment covering at most 10 minutes
(`IDLE_GAP_MAX_MS`), and on recall, sign-out or disconnect.

**Full rate.** What everyone earns together isn't capped (since 2026-10-18), so each tick every online deployed DEGEN
gets all it earned, however busy the day: no idle rate ever slows. The vault's 35,000 a day limits converting only
(above, under Converting). Manual mining pays as before.

**You + 4, per day.** At most 4 deployed at once, and at most 4 distinct DEGENs earn as one wallet's idle miners in a
UTC day: swapping in fresh DEGENs adds no caps, and a 5th distinct DEGEN that day is refused. A deployed DEGEN is one
the wallet owns now (read on-chain at deploy, then every 10 minutes for all of them in one multicall), never the one the
player wears, never one another connection holds (unless the chain says it's the requester's now: then that
connection's is recalled), and never one the player wore while earning today; a DEGEN that idle-mined today can't be
worn until tomorrow.

**Free plan.** Deploys are rate-limited (4 at once, then 1 every 5 s), and after 85,000 incoming messages in a UTC day
(`BOT_BUSY_AT`) the room takes no new deploys for the rest of the day; DEGENs already deployed keep earning. Paying
them costs one alarm every 5 minutes, and one message to each such player.

In the game (`web/bots.js`), the Mining Site panel's **Idle mining** box deploys and recalls DEGENs (each with its cap
a day and its rate an hour, a Legendary with its 1000x rate an hour and no cap, and what it earned today), remembers them per wallet and deploys them again after a sign-in,
and gives back the pickaxes the old bots held (**Take back**); a HUD line shows them and what they earned today. The
players' guide (`web/docs.html#bots`) explains it all for players.

## Contracts

| | |
|---|---|
| `MineToken.sol` | $MINE: Courier World's $STAMP (StampToken) line for line. ERC-20 with permit and burn, 21M cap counting every mint (so burns are for good), 10.5M to the hook (pool) at launch, the rest minted only by its one minter, the vault (set once). Renounced at deploy: no owner, no proxy, no pause, no tax |
| `MineVault.sol` | The mining vault, $MINE's minter: mints straight to players when its distributor (MiningSites) asks, never more than 35,000 in a UTC day nor 10,500,000 in all. Not upgradeable. The owner can replace the distributor only in the open (`proposeDistributor`, then `acceptDistributor` two days later), and only with a contract whose `owner()` is the vault's owner, `vault()` the vault and `predecessor()` the current distributor: propose the new proxy's predicted address, deploy it with `initialize` in its constructor, then accept (the steps are in its NatSpec) |
| `MineHook.sol`, `MineRouter.sol`, `MineEthRouter.sol` | Courier's audited `StampHook` and routers for $MINE: one pool, locked launch liquidity, 4% fee on the IMD side, buy/sell with IMD or ETH. The one difference from StampHook: the lowest start tick is -300,000 (was -400,000, as CourierPad); everything else, the 21M launch limit and the market-cap maths included, is StampHook's |
| `MiningSites.sol` | UUPS proxy, the rules for converting: mining sites (ETH, once per wallet) with levels 1 to 5 converting 50/60/70/85/100% (`upgradeSite(maxCost, minRateBps)`, paid in $MINE: `upgradeCost(level)`, 75% burned, never more than `maxCost`, never for a rate below `minRateBps`), and the claims the vault pays: EIP-712 vouchers from the world server, a daily cap per wallet (35,000, the most it allows since the upgrade of 2026-10-18, so one wallet can take the whole day's) and across everyone (35,000), pause. The owner tunes prices, rates, costs and caps, adds levels (up to 20) and can upgrade it. `initialize` runs only in the proxy's own constructor, never later. A replacement can take over from any distributor, one without code too (a predicted address nothing was deployed at: no books), and carries each player's site (its level as bought, even above the replacement's top, which then earns the top rate), `settled` and `claimed` over from its predecessor (read through, then imported on the player's first act), and the replaced one retires (`NotActive`) |
| `CrafterLevels.sol` | UUPS proxy: each DEGEN's level (`levelOf`, 1 to `maxLevel`), raised by its holder with `upgrade(tokenId, maxCost)` for `upgradeCost(level)` $MINE (75% burned, never more than `maxCost`). I'M DEGEN shows it as the "Level" trait once pointed at it (`setAttributesExtension`) |
| `MinePayments.sol` | UUPS proxy: `pay(kind, amount, ref)` takes $MINE from the player (with their exact approval), burns the kind's share, sends the rest to the treasury and emits `Paid(player, kind, amount, burned, ref)`, which the game checks. Kinds at launch: 0 "shop" (75% burned), 1 "ticket" and 2 "revive" (the 420 $MINE revive on the spot after dying on the home planet), both burning nothing (all to the treasury); the owner can change burn shares and add kinds. Prices live in the game, not here |
| `MinePayer.sol`, `UpgradeCosts.sol`, `lib/OwnedUUPS.sol` | What the three proxies share: taking a payment (burned share burned from the payer's wallet, the rest to the treasury; nothing ever held), level costs, and two-step ownership that can't be renounced, with the owner alone upgrading; each proxy is set up only in its own constructor (`__Owned_init` refuses anywhere else), so a proxy deployed without its setup is nobody's. State in ERC-7201 namespaced storage |
| `MineWorldCrafters.sol` | I'M DEGEN (symbol DEGEN; first named MineWorld Crafters, and the code keeps that name; Courier Skins adapted): 3,333 characters, minted by wallets only (`msg.sender == tx.origin`, else `OnlyWallets`; an EIP-7702 account mints as itself, a smart-contract wallet can't mint), commit-reveal (the owner publishes the secret with `reveal`; the seed waits for the next block's hash, from Arbitrum's ArbSys on Robinhood Chain, and anyone sets it with `seal` within 256 L2 blocks; after a window nobody sealed in, only the owner can move it on, at most 3 times, with `moveEntropyOn`; `revealStatus` says Sealable only with 30 blocks, about 3 seconds, to spare), traits from a keyed shuffle (each token a different face and top) and weighted picks, fully on-chain metadata and pictures (the attributes extension gets a fixed 300,000 gas and only a well-formed string of at most 4 KB is used, so it can't break them), enforced 5% royalty (ERC721-C, OpenSea's registry; the owner picks the validator and so can relax enforcement). The owner can update the website and social links (`setLinks`) and the collection's picture and banner (`setCollectionImages`) shown on OpenSea at any time. Ownership can never be renounced, so OpenSea Studio stays usable |
| `CrafterArt.sol` | I'M DEGEN's art: each DEGEN's 64 x 64 skin painted from packed rectangles and palettes, and its card written as an SVG, the trait names and the rarity (19.5 KB, the art data in its own code). Generated from `web/degen-skin-art.js` and `web/degen-skin.js` by `tools/gen-degen-art.mjs`; never edit it by hand |

```bash
cd contracts
forge test                                  # unit + invariant tests
forge test --fork-url robinhood             # plus the fork tests against Robinhood Chain
./script/deploy-mainnet.sh launch           # dry run of the launch on a fork
./script/deploy-mainnet.sh crafters         # dry run of I'M DEGEN
```

The JS in `web/degen-skin-art.js` (the art: layers, palettes, trait options) and `web/degen-skin.js` (traits, rarity,
the paint order, the card) defines every DEGEN; the game dresses the player with it. After changing either, regenerate
the contract and its test vectors (no npm needed), then run the tests, which check the contract paints the same skins
and writes the same cards as the JS, byte for byte, and fail while the generated files are stale.
`web/degen-preview.html` (on the dev server: `/degen-preview.html?view=grid`, `traits`, `skins`, `stats`) shows
random cards, every trait option, the skin textures and the numbers; `tools/degen-skin-check.mjs` prints the rarity
split, uniqueness and sizes.

```bash
~/.local/node/bin/node tools/gen-degen-art.mjs           # writes contracts/src/CrafterArt.sol, contracts/test/CrafterVectors.sol
~/.local/node/bin/node tools/gen-degen-art.mjs --check   # or only check they're up to date
```

Settings are in `contracts/launch.env` (public values only). The real launch, step by step:

0. **Audit first.** Every contract in `contracts/src` goes to IMD Swarm with [`AUDIT.md`](AUDIT.md) (the brief) and
   the commit it describes. Fix every finding, have IMD re-check the fixes, and deploy only the commit IMD has seen.
1. **Accounts.** The owner wallet (`OWNER`, 0x6e85…70eD) holds a little ETH on Robinhood Chain for gas. The world
   server goes on its own free Cloudflare account (Durable Object limits are per account, so Courier World's room is
   unaffected): `npx wrangler login` in `multiplayer/`.
2. **The voucher key.** Generate it straight into the Worker (never printed) and note its address:
   `npx wrangler secret put MINING_KEY` in `multiplayer/`.
3. **Dry runs** against a fork, nothing sent: `./script/deploy-mainnet.sh crafters`, then
   `MINING_SIGNER=<that address> ./script/deploy-mainnet.sh launch`.
4. **I'M DEGEN:** `./script/deploy-mainnet.sh crafters --broadcast --browser --browser-disable-open`. Open
   http://127.0.0.1:9545 in your browser, wallet on Robinhood Chain, and approve each transaction. **Sign with the
   `OWNER` wallet itself**, so it is the collection's creator and its owner (OpenSea Studio lets only `owner()` edit
   the collection). From any other wallet the script prints a loud warning and, if it set anything up first, an
   `acceptOwnership` call `OWNER` must make right away. It ends with `owner()` and `pendingOwner()`: check `owner()`
   is `OWNER` and `pendingOwner()` is 0. Free mint, at most 3 a wallet (`CRAFTERS_WALLET_LIMIT` in `launch.env`;
   `setWalletLimit`, 1 to 50, changes it later). The reveal secret goes to
   `~/mineworldcraft-crafters-reveal-secret.txt` (never printed): keep a copy in a password manager.
5. **$MINE and the game contracts:** `MINING_SIGNER=<address> CRAFTERS=<I'M DEGEN address> ./script/deploy-mainnet.sh
   launch --broadcast --browser --browser-disable-open`: the hook, $MINE (its owner renounced), MineVault, MiningSites,
   MinePayments and CrafterLevels; the pool opened with 10.5M $MINE locked; the hook renounced. If the signing wallet
   isn't `OWNER`, `OWNER` then makes the calls the script prints (`acceptOwnership`, `setAttributesExtension`). **Send
   nothing else from the deploying wallet until it's done:** the vault is given the address of that wallet's next
   contract (MiningSites' proxy), a hard precondition the script checks; it broadcasts with `--slow`, so a failed step
   stops the run before the token is renounced. (Should the proxy ever miss that address, the vault names an empty
   one, which a replacement can still take over: see `MineVault`'s steps.)
6. **Verify the sources:** `./script/deploy-mainnet.sh verify` (Sourcify, as Courier World). A token scanner should
   read $MINE like $STAMP: owner renounced, no proxy, pause, blacklist or transfer tax.
7. **The world server:** set `CHAIN_ID`, `CHAIN_RPC`, `MINING_ADDRESS` (the MiningSites proxy), `CRAFTERS_ADDRESS`,
   `LEVELS_ADDRESS` and `PAYMENTS_ADDRESS` in `multiplayer/wrangler.toml` and the site's address in the Worker's
   `ORIGINS`, then `npx wrangler deploy`.
8. **The website:** `./script/export-web.sh` writes `web/deployments/robinhood.json`; put the Worker's address in
   `web/config.js` (`LIVE_ROOM`) and publish `web/` as it is (no build), e.g. on Vercel or IMD's site hosting.
9. **The mint and the reveal:** `setSaleOpen(true)`; `setSaleOpen(false)` pauses or ends it (it can reopen until the
   reveal). Wallets only: a contract or smart-contract wallet can't mint (`OnlyWallets`), 3 per wallet. When it's over,
   close it and **announce the reveal time in advance**, so holders can run the sealer, which watches the collection
   and locks the reveal in the moment it can be, whoever reveals:
   `RPC_URL=https://robinhood.drpc.org ./tools/sealer.sh --account <keystore name>` (or `--browser`; never a key on
   the command line). Then, at that time, reveal with the secret from step 4, sealing at once. The easy way: log in to
   the game as `OWNER`, open I'M DEGEN in the panel, paste the secret and press **Reveal and lock in**; it sends
   `reveal(secret)`, waits for the next L2 block and sends `seal()`, retrying until the seed is set. From a terminal
   with a Foundry keystore, one line does the same:
   `cast send <I'M DEGEN> "reveal(uint256)" "$(cat ~/mineworldcraft-crafters-reveal-secret.txt)" --account <owner> --rpc-url robinhood && until cast send <I'M DEGEN> "seal()" --account <owner> --rpc-url robinhood; do sleep 1; done`.
   `reveal` makes the secret public (the sale can never reopen) and the seed wait for the next L2 block's hash;
   `seal()` sets it, and every DEGEN's look then shows, for everyone at once. Anyone can send `seal()`, for 256 L2
   blocks only (the chain keeps a block's hash that long, about 26 seconds on Robinhood Chain); later it reverts
   `EntropyExpired`. Then only `OWNER` can move the reveal on to a new block (`moveEntropyOn`, in public, at most 3
   times in all; the panel offers it), and `seal()` must be sent again; after the third, the reveal stays stuck for
   good (the DEGENs keep working, unrevealed) rather than fall back to anything someone could steer. Nobody, the owner
   included, can see a look before everyone can; what's left to trust is Robinhood Chain's sequencer, which produces
   the L2 blocks, and the owner's three public re-rolls if nobody seals in time: at most a best of four seeds, each
   move on chain, and none while a sealer is running and seals in time.
10. **OpenSea:** nothing to register on chain: a collection that never configured anything on OpenSea's registry gets
    its default list (OpenSea's SignedZone as the one authorizer), checked on Robinhood Chain. In OpenSea Studio,
    signed in as `OWNER` (it lets only the contract's `owner()` edit), set the collection's own fields there (links,
    description, banner, creator earnings: turn them on at 5%); the contract's on-chain `contractURI` (its name,
    description, links from `setLinks`, picture and banner from `setCollectionImages`) is what OpenSea shows until
    then, and the fallback. I'M DEGEN's ownership can never be renounced (the contract refuses), so this editing stays
    possible. **Never transfer its ownership to a contract wallet that can't sign in to OpenSea Studio**: check first
    that OpenSea Studio accepts a multisig before handing it to one.

## The world server

```bash
cd multiplayer
npx wrangler deploy
```

One Durable Object holds the world: who's playing and on which planet, every edit (per chunk, per planet: home's under
`c2:`, a zone's under `z<zone>:`, Deepvein's under `zdeep<week>:` with older weeks cleared), the monsters, the boss, the
loot chests (`chests`: every open one, on every planet), chat, names, voice set-up messages, the revive payments it took
(`revTx:<hash>`, kept for good), rocket tickets (`tix:<wallet>`: how many to each zone; every payment that bought some
under `tixTx:<hash>`, kept for good) and the $MINE ledger (16 shards under `led2:`, in ten-thousandths of a $MINE; the
old `led:` shards in hundredths are converted the first time they're read; today's idle mining per DEGEN, and the
DEGENs worn while earning today, in one more key, `led2:bots`). The terrain itself is never stored: both sides
generate it from the same seed. Built for Cloudflare's free plan: hibernating WebSockets, pings answered without
waking the room, an alarm only while someone has DEGENs deployed, positions sent only while moving, writes
batched every 30 seconds (the free plan allows 100,000 requests and 100,000 written rows a day per account, shared by
every Worker on it, so a separate Cloudflare account keeps Courier World's room unaffected).

Knock-outs, loot chests and revives on the wire (the rest of the protocol is in `docs/DESIGN.md`, idle mining's in
`docs/AUTOPILOT.md`):

| Direction | Message | |
|---|---|---|
| game → room | `["dead", stacks, x, y, z, killer]` | Knocked out at (x, y, z) carrying `stacks` (`[item, count, wear]`, armor too); `killer` a player id in Red Mesa, else null. Once per knock-out |
| room → game | `["dropped", chestId]` / `["dropno", why]` | The chest was made (0: nothing to drop) / none was (knocked out again too soon: the game keeps what it carried) |
| room → planet | `["chest", id, x, y, z, until, who]`, `["chestgone", id, by]` | A chest appears; one is opened (`by`: who) or replaced (`by` null) |
| room → game | `["chests", [[id, x, y, z, until, who], ...]]` | The planet's open chests, on joining and on every arrival |
| game → room | `["loot", chestId]` | Open a chest: `["looted", id, stacks, who]` or `["lootno", id, why]` |
| room → game | `["zoned", "home", players, at]` | Knocked out in a zone: sent home (the zone hears `["leave", id, "home", "ko"]`, home `["join", ..., "ko", zone]`) |
| game → room | `["respawn"]` | Up in town (asked while up, it counts as a jump) |
| game → room | `["revive", txHash]` | Up where you fell (home only); `txHash` null while revives are free |
| room → game | `["revived", x, y, z, txHash]` / `["reviveno", why, txHash, retry]` | Done, the room has you there / refused: retry 1 the chain couldn't be read, 2 the payment wasn't used (it can pay for a later revive), 0 never |
| room → game | `["welcome", ..., { practice, ticketsFree, reviveFree }]` | Whether revives are free right now |

`GET /count` answers `{ online, sites, mined, day }` for the title screen: the players connected, the mining sites
open, and everyone's earnings so far today (`mined`, in $MINE, on UTC day `day`; there's no cap on it). The ticker
across the top of the screen shows everyone's earnings today, the most that converts a day (35,000), when the daily
limits reset (00:00 UTC), the $MINE mining sites have paid out in total, the $MINE left in the mining vault and the
sites open; in the world it's kept up to date by the welcome's `world: [units, day]` and `["world", units, day]`, which the
room sends everyone at most every 15 seconds while people earn. Old
logs can't be read from Cloudflare (the official RPC answers its log queries with 429, publicnode serves none), so the
room keeps the wallets it has seen with a site (`site:<wallet>`, and how many under `sitecount`): it checks
`MiningSites.hasSite` when a wallet signs in to earn and when its game says it opened one; the first count checks
`SITES_SEED` (wrangler.toml: the owners when the count began) and every wallet in the ledger, in one multicall. A site
whose wallet never signs in to the game isn't counted. `sites` is null until the first count has worked.

For tests on your own machine, `npx wrangler dev --var DEV_HOOKS:1` turns on two dev hooks, `["dev", "today", mine]`
and `["dev", "world", mine]` (set a signed-in wallet's earnings today, or everyone's for the ticker), so the daily cap
and the ticker can be tried without mining for hours. They only answer connections made to that local server; never put `DEV_HOOKS` in
`wrangler.toml`.
