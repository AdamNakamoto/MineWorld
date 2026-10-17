# Idle mining (replaces the digging autopilot bots, 2026-10-17)

A signed-in player deploys up to 4 of their other I'M DEGENs to mine for them, like Courier World's couriers at a post
office: you play with the DEGEN you wear (manual mining), and up to 4 more earn by time while you're online. Constants:
`web/bots-rules.js` (import them; never copy the numbers). The earlier digging bots (physical avatars that broke
blocks, with pickaxes, batches inside `p`, per-bot tickets and Red Mesa fights) are removed entirely.

## Rules (decided by the owner, 2026-10-17)

- **Caps x5.** `DAILY_EARN_CAP` goes from 300 to 1,500 (`web/rewards.js`). A player's own cap is
  `dailyCap(boost.cap, zone)` = 1,500 plus the worn DEGEN's cap boost (1,650 for a Common level 1 up to 3,750 for a
  Legendary level 5, more with other slots, up to the boosts' MAX). What everyone earns together isn't capped (since
  2026-10-18): the mining vault still releases at most `VAULT_DAILY_LIMIT` (35,000) a day for everyone's conversions
  together, forever, first come, first served. Mining sites convert at most `walletDailyCap` a day per wallet: 3,500
  from an owner transaction on 2026-10-17, and 35,000 since 2026-10-18 (an upgrade raised `MAX_WALLET_DAILY_CAP` to
  the vault's 35,000, then `setCaps(35,000, 35,000)`). So there's no per-wallet limit of its own: one wallet can convert
  the whole day's 35,000, and the first conversions after 00:00 UTC can take all of it. The rest waits for later days.
- **Idle mining.** Up to `BOT_MAX` (4) deployed DEGENs at once, and at most `BOT_MAX` distinct DEGENs may earn as one
  wallet's idle miners in a UTC day (swapping in fresh ones adds nothing). Each is a DEGEN the wallet owns now (read
  on-chain at deploy and every 10 minutes after), never the one the player wears, never one another connection holds,
  never one the player wore while earning today (and one that idle-mined today can't be worn until tomorrow).
- **By time, while online.** Each deployed DEGEN earns its own cap, `dailyCap(itsBoost.cap, "home")` (1,650 to 3,750),
  spread over `IDLE_DAY_MS` (24 h): `idleRate(cap)` units a millisecond (1,650 a day is 68.75 an hour). Its earn boost
  doesn't change the rate (its cap boost already does). Online means the player's game is connected and signed in and
  was heard from in the last `IDLE_ONLINE_MS` (a message, or its 45 s ping: `ctx.getWebSocketAutoResponseTimestamp`).
  Idle players and hidden tabs still count; offline (logged off, the tab closed, the phone asleep) earns nothing. The
  planet doesn't matter: deployed DEGENs earn wherever the player is (they don't travel, need no tickets).
- **Legendary: 1000x, no cap (decided by the owner, 2026-10-18).** A deployed Legendary (rarity tier 2,
  `idleUncapped`) idle-mines `LEGENDARY_IDLE_X` (1000) times its normal rate, `idleRateOf(tier, cap)`, with no daily
  cap: 93,750 an hour at level 1 (its 2,250 cap over 24 h, times 1000) up to 156,250 at level 5, so 2,250,000 to
  3,750,000 a day online. Everything else holds: online only, at most `BOT_MAX` deployed, `BOT_MAX` distinct DEGENs a
  wallet a UTC day, never the worn one. Common and Rare deployed DEGENs are unchanged, and so is wearing a Legendary
  (its normal boosts, the player's normal daily cap).
- **Full rate.** The world server pays every `IDLE_TICK_MS` (5 min). Each tick every online deployed DEGEN gets all it
  wants, `min(idleRateOf(tier, cap) * elapsed, cap - today)` (a Legendary's without `cap - today`), however busy the
  day: there's no fair share since 2026-10-18 (what everyone earns together isn't capped, so no rate slows). Manual
  mining pays as before.
- **No pickaxes, no digging, no avatars.** Deployed DEGENs are shown only in the Mining Site panel (and a HUD line);
  nothing walks, digs, wears out or flies. The pickaxes lent to the old bots come back to the bag (or wait in the box
  until there's room).

## Client to room

- `["bot", "on", tokenId]`: deploy (or redeploy after a reload or reconnect: the game remembers your deployed DEGENs per
  wallet and sends them again once you're signed in). Bucket `botq` on the owner: 4 at once, then 1 every 5 s. Repeating
  it for a DEGEN already deployed on this connection just re-sends `botok` (no chain read, no bucket).
- `["bot", "off", tokenId]`: recall (pays what it earned up to now first).
- `["bot", "recheck", tokenId]`: read its DEGEN again now (after leveling it up).

## Room to client

- `["botok", tokenId, tier, level, today, cap]`: deployed (or its state changed after a recheck); units for today/cap.
- `["botoff", tokenId, why, retry]`: recalled; `why` is shown (null when the player asked); `retry` 1 means the game may
  try again later (chain unreadable, busy), 0 means don't.
- `["idle", [[tokenId, units, today, cap], ...], walletTotal]`: a payment (every tick, and on recall). For a while a
  4th field, always 1, follows it: games from before 2026-10-18 read it as the fair share (the full rate).

## Room: state

- On the owner's attachment: `a.bots = [[tokenId, tier, level, paidTo], ...]` (`paidTo`: the time it's been paid up
  to) and `a.botsAt` (next ownership read). In memory: `this.botClaims` (tokenId -> ws), `this.botPending` (deploys
  reading the chain).
- Deploy: claim the token before any `await`; after `readItem` check everything again (same socket, ready, same wallet;
  deploys work on any planet and while knocked out), not worn, not worn-while-earning today, still claimed by this
  socket, fewer than `BOT_MAX`, and the wallet's day list (`l.bots`) has room for this token. Conflicts
  with another socket are settled by `ownerOf`. `paidTo = now`.
- The tick: a Durable Object alarm every `IDLE_TICK_MS`, set while any connected socket has deployed DEGENs (and not
  otherwise, so an empty room sleeps). For each such socket that's online: each DEGEN's elapsed time is
  `min(now - paidTo, IDLE_GAP_MAX_MS)`, its want `min(idleRateOf(tier, cap) * elapsed, cap - today)` (a Legendary's
  without `cap - today`); pay `floor(want)`, then `paidTo = now`. A socket that isn't online has its DEGENs' `paidTo`
  moved to now without pay (offline time never pays). Credit: owner `l.total += c` (never `l.today`), the token's day
  `t[tokenId] += c` in `${ledgerKey}bots` = `{day, t, w}`, `l.bots` gains the token, `world.total += c` (for the ticker), then `castWorld()`; one `["idle", ...]`
  to the owner.
- Recall, sign out, signing in elsewhere, the socket closing: pay up to now (if online), then drop the DEGEN and its
  claim. The day rolling over resets the token days (and each cap's `today`).
- Ownership: when `now >= a.botsAt` (checked in the tick), all the owner's DEGENs are read in one multicall (`ownerOf`,
  `levelOf`); a definite "not theirs" recalls it; a level change updates its cap (`botok`).

## Game

- `web/bots.js` keeps only the roster: deploy / recall / recheck, the saved list per wallet (redeployed after sign-in),
  the room's answers, today's earnings per DEGEN, and the HUD/panel summary.
- The Mining Site panel's **Idle mining** box: your DEGENs except the worn one, each with Deploy / Recall, its cap a
  day and rate an hour (a Legendary: its 1000x rate an hour and no cap), what it earned today vs its cap, and the notes
  (online only; 4 a day; the per-wallet converting limit, 35,000 since 2026-10-18); returned pickaxes with Take back.
- The HUD line: deployed DEGENs and what they earned today.
- The rocket card: one ticket per trip again (several can still be bought in one payment).
