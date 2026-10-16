# Autopilot bots

A signed-in player deploys up to 4 of their other I'M DEGENs as bots that mine near them: you plus 4 bots, 5 NFTs
mining. The rules are the player's rules. Constants live in `web/bots-rules.js` (shared by the game and the world
server; import them, never copy the numbers). This file is the design and the protocol both sides follow exactly.

## Rules (decided by the owner, 2026-10-16, tightened by the design review)

- **Own cap.** Each bot earns like a player: block rates from `web/rewards.js`, times the zone's `ZONE_PAY`, plus its
  own DEGEN's earn boost, up to `dailyCap(botBoost.cap, zone)` a UTC day (330 for a Common level 1, 750 for a
  Legendary level 5). The day's count is kept **per token id**, so a DEGEN passed to another wallet keeps the same
  day. Bot earnings go into the wallet's ledger total (they convert like any earnings) but **not** into the player's
  own `today`. Everyone's `WORLD_DAILY_CAP` (35,000) holds for everything. Mining sites convert at most
  `walletDailyCap` (1,500 today) a day per wallet; the rest waits for later days (the panel says so).
- **You + 4, per day.** At most `BOT_MAX` (4) bots at once, and at most `BOT_MAX` distinct DEGENs earn as one
  wallet's bots in a UTC day (swapping in fresh DEGENs doesn't add caps: a 5th distinct DEGEN that day is refused).
  A bot is a DEGEN the wallet owns now (read on-chain at deploy and every 10 minutes), never the one the player wears,
  never one another connection holds, and never one the player wore while earning today (and a DEGEN that mined as a
  bot today can't be worn until tomorrow).
- **Follow you.** Bots go where the player goes. A trip out names the bots that come (`["zone", key, [tokenIds]]`) and
  costs one ticket for the player and one for each of them: all or nothing. Bots left out are recalled ("stayed home")
  and the game redeploys them, with their pickaxes, when the player is home again. The way home is free. New bots are
  deployed on the home planet only; in a zone the player can redeploy, free, a bot whose ticket was paid for that trip
  (after a reload or a dropped connection).
- **Active play.** Bots work while the player's last **accepted** action is less than `BOT_IDLE_MS` (5 min) old. The
  actions: the player's own accepted break of a natural block, an accepted place, an accepted hit on a monster, the
  boss or a player, an accepted chat line, and walking at least `BOT_MARK_MOVE` (2) blocks from the last mark. Not
  `act`, turning, connecting, signing in or anything a bot does. A new connection starts paused until the first
  action. (A script that really walks or mines can't be told from a player; the rule stops message-only keepalives.)
  A knocked-out player's bots pause until the player is up.
- **Gear.** Each bot holds a pickaxe from the player's bag: the server is told which one and its wear at deploy, adds
  1 wear for every accepted bot break of a block with hardness > 0, and recalls the bot when it breaks ("Its pickaxe
  broke"). A bot mines what its pickaxe harvests at that pickaxe's speed with its DEGEN's speed boost (the server's
  rate check uses the best pickaxe, as for players). Ores a bot digs go into the player's bag when there's room; other
  drops are left. A recalled pickaxe goes back to the bag, or waits in the Autopilot box until there's room (never lost).
- **Natural blocks only, never under players.** Bots break only natural blocks (never a placed one), never in a
  protected place (`protectedIn`), never while standing in one or on a pad, and never a block within 2 blocks
  (horizontally) under a player's feet. Bots stand and walk anywhere.
- **No fighting.** Bots don't fight monsters or the boss, and monsters ignore them. In Red Mesa (off the pad) other
  players can hit a bot (not its owner): `BOT_HP` health, no armor, healing 1 every `BOT_HEAL_MS` after the last hit.
  Beaten, its pickaxe drops in a loot chest at its feet (built by the server from the pickaxe it knows; 5 minutes;
  anyone there may take it), the planet hears "<attacker> beat <owner>'s bot #id", and the bot is recalled.
- **Stays near.** A bot roams at most `BOT_LEASH` blocks horizontally and `BOT_DY` vertically from its player (the
  server refuses breaks beyond `BOT_LEASH_ROOM` / `BOT_DY_ROOM`). A stuck bot (foot or head cell solid, no progress for
  5 s, or past the leash) jumps to a free spot beside its player, flagging `BOT_JUMP`.
- **No x-ray.** The bot brain targets only blocks with a face open to air the bot can reach (the surface, cave walls,
  its own tunnel), and tunnels only in straight runs (at most 6 blocks) in a direction chosen without looking inside
  the rock.
- **Free plan.** The room counts incoming messages per UTC day; after `BOT_BUSY_AT` it refuses bot work for the rest of
  the day ("The world is busy today").

## Client to room

### Control messages

Rate limits, on the owner's attachment: bucket `botq` (4 at once, then 1 every 5 s) for `on` (new deploys only),
`pick` and `recheck`; bucket `botsl` (4 at once, then 1 every 5 s) for `sleep` / `wake` (only one that changes
something costs); `off` has none.

- `["bot", "on", tokenId, pickId, wear]`: deploy (or redeploy after a reconnect); `pickId` must be a pickaxe
  (`TOOLS[pickId].kind === "pick"`), `wear` an int in `0..maxDurability(pickId)-1`. Repeating it for a token already
  deployed on this connection just re-sends `botok` (no chain read, no bucket); for one this connection is still
  deploying it's ignored (that deploy answers). Refused by `botq`: `botoff` with retry 1.
- `["bot", "off", tokenId]`: recall. Answered with `botoff` (`why` null, retry 0): with the bot's pickaxe and wear;
  for a token this connection is still deploying, the deploy is called off (no `botok` follows, its hold on the token
  goes at once) and the pickaxe that deploy carried comes back (`["botoff", tokenId, null, 0, pickId, wear]`); for a
  token the room doesn't have here, `["botoff", tokenId, null, 0, null, null]` ("not here": the game gives back the
  pickaxe it keeps).
- `["bot", "pick", tokenId, pickId, wear]`: give a deployed bot another pickaxe: the room answers `["botpick",
  tokenId, oldPickId, oldWear]` (the old one comes back) and the planet hears `botgear`. Refused by `botq`:
  `["err", ...]`, then `["botpick", tokenId, pickId, wear]` with the pickaxe that was sent (it comes back), then
  `botok` with what the bot still holds. For a bot that isn't deployed: `["botoff", tokenId, why, 1, pickId, wear]`
  with the pickaxe that was sent.
- `["bot", "recheck", tokenId]`: read the bot's DEGEN again now (after leveling it up); refused by `botq`, ignored.
- `["bot", "sleep"]` / `["bot", "wake"]`: the tab was hidden / is visible again; the room hides / shows the bots
  (they stay deployed and reserved). Only where they are and how they walk starts afresh (they settle in with their
  next batch, and a bot that isn't worked has its reason told again); their health and breaking budget stay. One
  refused by `botsl` is ignored, with no answer: a refused `sleep` leaves the bots shown where they were, and after a
  refused `wake` the next batch shows them anyway (a batch from a player whose bots are hidden is a wake).

### Bot work: inside the player's `p`

`["p", x, y, z, yaw, pitch, flags, B]`, where the optional 8th element is `B = [zone, entry, entry, ...]` and

`entry = [tokenId, x, y, z, yaw, botFlags, breaks]`, `breaks = [[bx, by, bz, fx, fy, fz], ...]`

- `x, y, z, yaw`: the bot's position now; `fx, fy, fz`: the integer foot cell the bot stood in when it broke that
  block (each within `BOT_FOOT_ROOM` of `x, y, z`). At most `BOT_MAX` entries, one per token, at most `BOT_BREAKS_MAX`
  breaks each.
- `zone` first: the room ignores a whole B whose zone isn't the player's (a batch straddling a flight), without undo.
- The game attaches B whenever its own `p` goes out. Otherwise it sends a **carrier**: a `p` repeating the player's
  last sent position, yaw, pitch and flags exactly, plus B, only when breaks are pending and nothing went out for
  `BOT_BATCH_MS`. A bot that only moved waits for the player's next `p` or the 3 s heartbeat. Never a carrier when the
  player has moved (> 0.05) or turned (> 0.35) since the last `p`: then it's a real `p`. Before `["zone"...]` the game
  sends one last carrier with pending breaks, and stops its bots for the trip.
- The game sends early if a bot is about to move more than 5 blocks from its first unsent foot cell or is about to
  jump to the player.

## Room to client

- To the owner:
  - `["botok", tokenId, tier, level, today, cap, pickId, wear]`: deployed, or its state changed (recheck).
  - `["botoff", tokenId, why, retry, pickId, wear]`: recalled, or a deploy refused. `why` is shown (null when the
    player asked); `retry` 1 means the game may try again later (chain unreadable, busy, knocked out, moved, too many
    changes, being put on), 0 means don't. The pickaxe:
    - `pickId`, `wear`: it comes back to the bag (the bot's, or, for a refused or called-off deploy and a `pick` for a
      bot that isn't deployed, the one that was sent);
    - `pickId` null, `wear` -1: **lost** (its pickaxe broke, or it was beaten and the pickaxe is in a loot chest):
      nothing comes back;
    - `pickId` null, `wear` null: **not here** (an `off` for a token the room doesn't have on this connection, or a
      deploy refused before its pickaxe was valid): the game gives back the pickaxe it keeps for that bot, if any.
  - `["botpick", tokenId, pickId, wear]`: after `["bot","pick",...]`, the pickaxe that comes back to the bag: the old
    one, or, refused, the one sent (then `botok` says what the bot holds).
  - `["botearn", [[tokenId, units, today, cap, why], ...], walletTotal]`: one per batch that lists any bot (why:
    `BOT_PAID`, `BOT_AT_CAP`, `BOT_WORLD_CAP`, `BOT_SETTLING`, `BOT_TOO_FAR`, `BOT_IDLE`, `BOT_REFUSED`). On
    `BOT_AT_CAP` that bot stops until 00:00 UTC (server time); on `BOT_WORLD_CAP` all bots do. A bot that isn't worked
    is listed (0 units, its reason) only in the batch it stops in, and again when its reason changes or after a sleep
    or a wake, a flight, a respawn or a revive; a working bot is listed in every batch that brings breaks.
  - `["botidle", 0|1]`: 1: the player's bots are paused for idleness (or because the player is knocked out); sent
    with the first batch (or the deploy) after they pause, and again for every batch that still brings breaks from a
    bot paused so (the game may have resumed it too early). 0: they may work again; sent on the player's next accepted
    action after a 1, and on a respawn or revive if their last accepted action is less than `BOT_IDLE_MS` old. The
    game keeps its bots paused from a 1 until a 0 (its own activity doesn't end that pause: the room may not have
    accepted it).
  - `["bothit", tokenId, hp, attackerName]` and `["botko", tokenId, attackerName]` (Red Mesa); after `botko` the
    pickaxe is in the chest, and a `botoff` follows with the pickaxe lost (`null`, -1).
  - `["sets", [[x, y, z, b], ...]]`: one per batch, undos (what the room has there) of: refused bot breaks; every
    break of an entry whose position is impossible (outside the world, not numbers); every break of a bot that isn't
    worked (idle, knocked out, at its cap or the world's, busy, its DEGEN over the day's `BOT_MAX`); and every break
    of a bot this connection lost in the last 10 s and doesn't have again (recalled by the room on its own: beaten,
    pickaxe broke, busy, not theirs any more; let go: signed out, signed in elsewhere; or recalled when asked), whose
    game may have sent the batch before it heard.
- To the planet (outgoing):
  - welcome flags and `zoned` (as m[4]) carry `bots: [[pid, ownerId, name, look, x, y, z, yaw, held], ...]`.
  - `["botjoin", pid, ownerId, name, look, x, y, z, yaw, held]`: a bot appears (deploy, arrival, wake, or its
    owner's name changed: not for the same name again); drawn like a player, no "joined" chat line. `["botgear", pid,
    held]` when its pickaxe changes.
  - `["botps", ownerId, [[tokenId, x, y, z, yaw, botFlags], ...]]`: one per batch through `near()`, listing only bots
    that moved, turned or changed flags (stopped bots too: they're still where their game says).
  - `["sets", [[x, y, z, b], ...]]`: one per batch for the bots' accepted breaks (through `near()` with `NEAR_EDITS`).
  - `["botleave", pid]`: it goes (recall, the owner leaving, signing out or sleeping, flying away, or sent home knocked
    out).
  - In Red Mesa `["pvp", pid, dmg]` with a bot's (negative) id is a hit on that bot.

## Room: state and checks

- On the owner's attachment (Cloudflare keeps 2,048 bytes of it): `a.bots = [[tokenId, tier, level, pickId, wear],
  ...]`, `a.activeAt`, `a.markX`, `a.markZ`, `a.botsAt` (when the bots are next read on-chain), `a.botsAsleep`,
  `a.botIdle` (the game was told `botidle 1`), the buckets `botq` and `botsl`, and the edit allowance the player
  shares with their bots, kept small: `a.editMin = {at, p, k, o}` (the minute's start, the planet's edit prefix, its
  chunks as `cz * 32 + cx`, and how many were changed on another planet this minute: they still count). When the JSON
  passes 1,900 bytes, `save()` drops what's only for a moment: full buckets, monsters long gone, a stale last hit,
  stamps whose wait is over, an edit allowance whose minute is over; then, if still too big, the buckets' fractions are
  cut down and the oldest monsters go. Never an edit allowance within its minute, nor a bucket that isn't full (either
  would start afresh). The attachment is saved by every handler that changes it; a carrier (which `position()` doesn't
  save) saves it when the game was told `botidle`, and at most every 5 s while its bots' breaks are taken (their
  pickaxes' wear, the edit allowance; a broken pickaxe saves through the recall), so the room sleeping loses little.
- In memory (gone if the room sleeps, which only happens after the whole room has been quiet):
  - live state per bot (`this.botLive`: Map ws → Map tokenId → `{x, y, z, yaw, flags, walk, walkAt, suspect, credit,
    creditAt, sent, stop}`; `stop`: why it isn't worked, told once), rebuilt from the next batch (credit full at
    `BOT_CREDIT`, settling) when it's new (a deploy) or the room slept; a flight's landing puts it round the pad
    (credit full, settling); a sleep or a wake (`["bot","wake"]`, or a batch or a deploy while hidden) clears only
    where it is and how it walks (`x..flags`, `walk`, `walkAt`, `sent`, `stop`); a respawn or a revive clears `stop`;
  - deploys in progress (`this.botPending`: Map ws → Map tokenId → `{pickId, wear, off, claim}`): they count towards
    `BOT_MAX`, block `fly()`, and `["bot","off"]` calls one off;
  - the bots each connection lost in the last 10 s (`this.botGone`: Map ws → Map tokenId → when), for their batches
    still on the way;
  - Red Mesa health by token (`this.botHp`: Map tokenId → `{hp, hitAt}`), kept through hiding the tab, a recall and a
    redeploy, forgotten once healed (and after the room slept: whole again);
  - when each connection's carriers last saved its attachment (`this.botSavedAt`).
- The Crafters' revealed seed (for the bots' looks) is kept in storage (`crafterseed`) once read and read back when
  the room wakes, so a bot's look is never null.
- Claims: `this.botClaims` (Map tokenId → `{ws, wear}`) is set synchronously by a deploy (and by `wear` while its
  chain read runs) before any `await`. After `readItem` the deploy checks again: not called off, the socket is still
  this player's and ready, same wallet, on the home planet (or the paid-for zone), up, not the worn token, not worn
  while earning today, still claimed by this socket, fewer than `BOT_MAX`, and the wallet's day list has room for this
  token. Otherwise it releases its own claim and answers `botoff`; nothing when it was called off (answered already)
  or the socket left or changed wallet (its deploys were called off then). `leave`, `signout` and signing in
  elsewhere (or as another wallet) release every claim of that socket and call its deploys off (no answer).
- Conflicts: when a deploy or `wear` meets a token another socket holds, the room reads `ownerOf` for the requester;
  if it's theirs, the holder's bot is recalled ("That DEGEN is in another wallet now") and the request goes on.
- The wallet's day list: in the wallet's ledger entry, `l.bots = [tokenId, ...]` (tokens that earned as bots today),
  cleared with `today` when the day changes.
- Token days: one storage key `${ledgerKey}bots` = `{day, t: {tokenId: unitsToday}, w: {tokenId: 1}}` (`w`: worn while
  earning today), reset when the UTC day changes, flushed with the ledger (one row a flush).
- Processing a B (before the player's own new position is applied; the leash uses whichever of the owner's old and new
  positions is closer): ignore it whole if its zone isn't the player's. Entries for a token this connection lost in the
  last 10 s (and not deployed again): their breaks are put back. Then, past `BOT_BUSY_AT`, every bot's breaks in the
  batch are put back and every bot is recalled (`botoff`, `BOT_BUSY`, retry 1). Otherwise hidden bots are shown again (a
  batch is a wake), and for each entry (token in `a.bots`, first occurrence only): one whose position is impossible has
  its breaks put back and nothing else taken; a DEGEN that would be the wallet's (`BOT_MAX` + 1)th today has its breaks
  put back and is recalled. If the owner is idle or knocked out, or the bot is at its cap or the world at its cap, the
  bot isn't worked: its breaks are put back (every such batch), its position is taken and shown (`botps`), settling
  (`suspect = now + SETTLE_MS`, no pay), its reason goes in `botearn` once (`stop`), and if it's paused for idleness (or
  the knock-out) and brought breaks, `botidle 1` is sent again. Otherwise movement: `bucket(bot, "walk", 2 *
  BOT_SPEED_ROOM, BOT_SPEED_ROOM, distance)`; failing it, `BOT_JUMP`, or a first batch (just deployed, or after a sleep
  or a wake), settles. For each break, cheap checks first: credit bucket, leash (foot cell vs owner), foot within
  `BOT_FOOT_ROOM` of the entry, not `protectedIn`/on the pad (foot and block), `inReach` from the foot cell (eye at foot
  y + 1.62), the shared edit allowance (`BOT_EDIT_CHUNKS`), not under a player; then `blockAt` (memoized per batch): not
  air/water/bedrock, not `placed`; `exposed`; `standing(foot)`. Accepted: `setBlock` (collected into one `sets` per
  batch), wear + 1 (for a block with hardness > 0; at the pickaxe's durability the bot is recalled, "Its pickaxe broke",
  pickaxe lost), pay unless settling. Refused: undo to the owner (collected). Credit:
  `units = withEarn(toUnits(reward) * ZONE_PAY[zone], botBoost.earn)`, `c = min(units, botCap - today, WORLD_CAP -
  world.total)`; owner `l.total += c`, token `today += c`, `world.total += c`, `castWorld()`; one `botearn` per batch.
- Lifecycle: `leave`, `signout`, signed in elsewhere: bots let go without a `botoff`, claims released (pickaxes come
  back in the game's own store). `fly`: the bots a trip out doesn't name are recalled ("Stayed home.", retry 0, their
  pickaxes back); `move` places the others round the pad (`botsLand`: credit full, settling) and casts `botjoin`; a
  `move` that isn't a flight (the sign-in zone restore) recalls the bots. Knocked out in a zone: home with the owner,
  free. Respawn and revive end the knock-out's stop (`stop` cleared, and `botidle 0` if the player's last action is
  recent). Ownership: when `now >= a.botsAt` on any owner message, all bots are read in one multicall
  (`ownerOf`, `levelOf`); a definite "not theirs" recalls that bot; a failed read keeps them and retries after
  `BOOST_RETRY_MS`.
- Tickets: a payment buys `n = min(BOT_TICKETS_MAX, floor(amount / price))` tickets, once per transaction, answered
  `["ticketok", zone, count, txHash, bought]` (`count`: the wallet's tickets there now; `bought`, m[4]: `n`). When
  `fly()` takes bot tickets it writes `botz:<wallet> = {zone, toks}` in the same put as `tix:<wallet>`;
  `keepZone(home)` deletes it.

## Game

- `web/bots.js`: up to 4 bots, each an avatar wearing its DEGEN's skin with its pickaxe in hand and a name tag, a body
  stepped with `stepPlayer` (in loaded, synced chunks only), and a brain: the best open-faced natural block its
  pickaxe harvests nearby (reward per second, within the leash), walk there (jump on walls; strip-mine straight runs
  of at most 6 when needed), mine it (its own crack, quiet sounds), collect ores into the bag, wear its pickaxe; jump
  to the player when stuck or too far. A search budget of about 1,500 block reads a frame for all bots together.
- Bots stop when: the game's idle clock passes `BOT_IDLE_MS - 30 s` (it resets only when the game sends one of the
  room's activity actions), the room says `botidle 1` (until it says `botidle 0`), the player is knocked out or
  flying, the socket is closed (until `botok` again), the bot's or the world's cap is reached (until 00:00 UTC), or its
  pickaxe broke.
- Bot pickaxes are saved beside the bag: `mwc:inv:<wallet>` keeps the slots and `mwc:inv:<wallet>:armor` the armor,
  exactly as before (so an older build still reads the bag), and `mwc:inv:<wallet>:bots` holds `{bots, returned}`
  (the bots' pickaxes and the ones waiting for room). A save from the first builds, `{slots, armor, bots, returned}`
  in the one value, still loads and is rewritten in this form. Wear is kept in memory and saved at most every 5 s and
  on page hide.
- Other players' bots: drawn like players (at most 8 within 48 blocks, name tags within 16), interpolated over 2.5 s.
- The Mining Site panel's **Autopilot** box; a HUD line; the rocket card's ticket count, "Take bots" checklist and
  multi-ticket purchase.
