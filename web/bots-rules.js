// Autopilot bots: a signed-in player deploys up to BOT_MAX of their other I'M DEGENs as bots that mine near them.
// The player's game simulates the bots (it has to be open and in use: bots pause after BOT_IDLE_MS without the
// player doing anything the world server accepts); the server checks every bot break like a player's (a real natural
// block, within reach of the bot, not faster than the best pickaxe allows with the bot's own DEGEN speed boost) and
// pays it into the wallet's ledger total, within the bot's own daily cap (DAILY_EARN_CAP plus its DEGEN's cap boost),
// counted by token id. Shared by the game (web/bots.js) and the world server (multiplayer/src/index.js).
// docs/AUTOPILOT.md has the whole design and the protocol.

export const BOT_MAX = 4; // bots at once, and distinct DEGENs that may earn as one wallet's bots in a UTC day
export const BOT_IDLE_MS = 5 * 60_000; // bots pause this long after the player's last accepted action
export const BOT_MARK_MOVE = 2; // blocks the player must walk from their last mark for walking to count as activity
export const BOT_LEASH = 24; // blocks (horizontal): how far the game lets a bot roam from its player
export const BOT_DY = 24; // blocks (vertical): the game keeps a bot within this of its player
export const BOT_LEASH_ROOM = 34; // the server's horizontal limit (the game's plus slack); further, a bot's breaks are refused
export const BOT_DY_ROOM = 32; // the server's vertical limit
export const BOT_SPEED_ROOM = 12; // blocks/s a bot's walking budget refills at on the server (banked up to twice that)
export const BOT_FOOT_ROOM = 6; // blocks: a break's foot cell must be this close to its entry's reported position
export const BOT_BATCH_MS = 2000; // the game sends bot breaks at most this often when nothing else is going out
export const BOT_BREAKS_MAX = 12; // breaks one bot may list in one batch
export const BOT_REACH = 4; // blocks: how far a bot reaches when it mines (the server allows ROOM_REACH from its foot cell)
export const BOT_CREDIT = 3; // seconds of breaking a bot can bank on the server (covers one batch)
export const BOT_HP = 20; // a bot's health in Red Mesa, where players can hit it
export const BOT_HEAL_MS = 4000; // a hurt bot heals 1 hp this often after its last hit
export const BOT_TICKETS_MAX = 5; // tickets one payment can buy (a ticket for you and one for each bot)
export const BOT_EDIT_CHUNKS = 16; // distinct chunks the player and their bots may change in a minute, together
export const BOT_BUSY_AT = 85_000; // incoming messages in a UTC day after which the room stops taking bot work (free plan)

// botFlags in a bot's batch entry.
export const BOT_MINING = 1; // swinging (others see it)
export const BOT_JUMP = 2; // jumped back to its player: the server settles it (no pay for a moment) without a fault

// Why a bot's credit in ["botearn", ...] was what it was.
export const BOT_PAID = 0, BOT_AT_CAP = 1, BOT_WORLD_CAP = 2, BOT_SETTLING = 3, BOT_TOO_FAR = 4, BOT_IDLE = 5, BOT_REFUSED = 6;

/// The id other games know a bot by: negative, so it never meets a player's id (players count up from 1).
export const botPid = (ownerId, tokenId) => -(ownerId * 4096 + tokenId);
/// The owner's id and the token id back from a bot's id.
export const botOf = (pid) => ({ ownerId: Math.floor(-pid / 4096), tokenId: -pid % 4096 });
/// A bot's name tag: its owner's name and the DEGEN's number.
export const botName = (owner, tokenId) => `${owner}'s bot #${tokenId}`;
