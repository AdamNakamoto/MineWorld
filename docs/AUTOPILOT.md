# Idle mining (replaces the digging autopilot bots, 2026-10-17)

A signed-in player deploys up to 4 of their other I'M DEGENs to mine for them, like Courier World's couriers at a post
office: you play with the DEGEN you wear (manual mining), and up to 4 more earn by time while you're online. Constants:
`web/bots-rules.js` (import them; never copy the numbers). The earlier digging bots (physical avatars that broke
blocks, with pickaxes, batches inside `p`, per-bot tickets and Red Mesa fights) are removed entirely.

## Rules (decided by the owner, 2026-10-17)

- **Caps x5.** `DAILY_EARN_CAP` goes from 300 to 1,500 (`web/rewards.js`). A player's own cap is
  `dailyCap(boost.cap, zone)` = 1,500 plus the worn DEGEN's cap boost (1,650 for a Common level 1 up to 3,750 for a
  Legendary level 5, more with other slots, up to the boosts' MAX). Everyone's `WORLD_DAILY_CAP` stays 35,000 (the
  mining vault releases at most that a day, forever). Mining sites convert at most `walletDailyCap` (3,500 since an owner
  transaction on 2026-10-17, the most the contract allows) a day per wallet; the rest waits for later days.
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
- **Fair share.** The world server pays every `IDLE_TICK_MS` (5 min). Each tick it works out what the world can pay
  this tick, `budget = (WORLD_CAP - world.total) * tickLength / msLeftToday`, and what all online deployed DEGENs want,
  `want = Σ min(idleRate(cap) * elapsed, cap - today)`. If `want > budget`, each one gets `want_i * budget / want`
  (everyone slows evenly, so the 35,000 lasts until 00:00 UTC); otherwise each gets all it wants. Manual mining pays as
  before, from the same world total (what it takes leaves less for the rest of the day).
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
- `["idle", [[tokenId, units, today, cap], ...], walletTotal, share]`: a payment (every tick, and on recall); `share` is
  the fair-share factor this tick (1 = full rate; 0.6 = everyone's idle rate is at 60% because the day is busy).

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
  `min(now - paidTo, IDLE_GAP_MAX_MS)`, its want `min(idleRate(cap) * elapsed, cap - today)`; the fair share as above;
  pay `floor(want * share)` (never past the world's remaining total), then `paidTo = now`. A socket that isn't online
  has its DEGENs' `paidTo` moved to now without pay (offline time never pays). Credit: owner `l.total += c` (never
  `l.today`), the token's day `t[tokenId] += c` in `${ledgerKey}bots` = `{day, t, w}`, `l.bots` gains the token,
  `world.total += c`, then `castWorld()`; one `["idle", ...]` to the owner.
- Recall, sign out, signing in elsewhere, the socket closing: pay up to now (if online), then drop the DEGEN and its
  claim. The day rolling over resets the token days (and each cap's `today`).
- Ownership: when `now >= a.botsAt` (checked in the tick), all the owner's DEGENs are read in one multicall (`ownerOf`,
  `levelOf`); a definite "not theirs" recalls it; a level change updates its cap (`botok`).

## Game

- `web/bots.js` keeps only the roster: deploy / recall / recheck, the saved list per wallet (redeployed after sign-in),
  the room's answers, today's earnings per DEGEN, the share, and the HUD/panel summary.
- The Mining Site panel's **Idle mining** box: your DEGENs except the worn one, each with Deploy / Recall, its cap a
  day and rate an hour, what it earned today vs its cap, and the notes (online only; 4 a day; the world's fair share;
  the 3,500 converting limit); returned pickaxes with Take back.
- The HUD line: deployed DEGENs and what they earned today (and the share when it's below 100%).
- The rocket card: one ticket per trip again (several can still be bought in one payment).
