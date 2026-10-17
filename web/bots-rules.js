// Idle mining: a signed-in player deploys up to BOT_MAX of their other I'M DEGENs to mine for them, as Courier World's
// couriers work at a post office. While the player is online (connected and signed in: idle or not, the tab hidden or
// not), each deployed DEGEN earns its own daily cap (rewards.js DAILY_EARN_CAP plus its DEGEN's cap boost) spread over
// 24 hours, paid by the world server every IDLE_TICK_MS into the wallet's ledger total and counted by token id.
// Offline, nothing. Shared by the game (web/bots.js) and the world server
// (multiplayer/src/index.js). docs/AUTOPILOT.md has the whole design and the protocol.

export const BOT_MAX = 4; // DEGENs deployed at once, and distinct DEGENs that may earn as one wallet's in a UTC day
export const IDLE_DAY_MS = 24 * 3600_000; // a deployed DEGEN earns its whole daily cap over this much time online
export const IDLE_TICK_MS = 5 * 60_000; // the world server pays idle mining this often
export const IDLE_ONLINE_MS = 150_000; // online: the player's game was heard from (a message or a ping) this recently
export const IDLE_GAP_MAX_MS = 2 * IDLE_TICK_MS; // the most time one payment covers (a late tick doesn't pay a long gap)
export const BOT_BUSY_AT = 85_000; // incoming messages in a UTC day after which the room takes no new deploys (free plan)

/// A deployed DEGEN's pay rate in units a millisecond: its daily cap (in units) over IDLE_DAY_MS.
export const idleRate = (capUnits) => capUnits / IDLE_DAY_MS;
