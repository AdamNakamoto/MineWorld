// Player names (from Courier World): anyone signed in with a wallet can pick one, and it shows instead of their
// wallet address (name tag, chat). Shared by the game (instant feedback) and the world server (the rule that counts),
// with no imports, so both can load it.

export const NAME = /^[A-Za-z0-9_]{3,15}$/; // ASCII only, so nobody can pass off a look-alike of someone else's name
export const NAME_EVERY_MS = 24 * 3600_000; // how often a wallet can change its name

// Names players would read as the game speaking: nobody can take these (underscores don't count:
// "ad_min" is "admin"), or start a name with the ones in RESERVED_START.
const RESERVED = new Set([
  "admin", "administrator", "mod", "moderator", "moderators", "official", "support", "help", "helpdesk", "team", "staff",
  "system", "server", "bot", "owner", "dev", "developer", "founder", "ceo", "mineworld", "mineworldcraft", "minecraft",
  "mojang", "crafter", "crafters", "miningsite", "treasury", "mine", "adam", "adamnakamoto", "guest", "you",
  "me", "everyone", "here", "null", "undefined", "anonymous", "unknown", "nobody", "wallet", "airdrop", "giveaway",
  "claim", "verify", "verified",
]);
const RESERVED_START = ["admin", "official", "moderator", "support", "staff", "mineworld", "guest"];
// Words a name can't contain, even spelled with digits (sh1t) or split with underscores.
const BLOCKED = [
  "fuck", "fuk", "shit", "cunt", "nigger", "nigga", "faggot", "fag", "retard", "whore", "slut", "bitch", "porn", "nazi",
  "hitler", "kkk", "penis", "vagina", "rapist", "pedophile", "molest", "jizz", "dildo",
];
// Names taken out of the world by hand (an offensive one the list above misses): add it, lower case, and
// redeploy the game and the world server. Whoever had it shows as their wallet address again.
export const BANNED = new Set([]);

const LEET = { 0: "o", 1: "i", 3: "e", 4: "a", 5: "s", 7: "t", 8: "b", 9: "g" };
const plain = (low) => low.replace(/_/g, "").replace(/[01345789]/g, (d) => LEET[d]);
const blocked = (low) => BANNED.has(low) || BLOCKED.some((w) => plain(low).includes(w));
/// Whether text (any case) contains a blocked word, even spelled with digits or split with underscores.
export const offensive = (text) => BLOCKED.some((w) => plain(String(text).toLowerCase().replace(/[^a-z0-9_]/g, "")).includes(w));

/// The name as it will be shown, or why it can't be used: { name } or { error }.
export function cleanName(raw) {
  const name = typeof raw === "string" ? raw.trim() : "";
  if (!NAME.test(name)) return { error: "Use 3 to 15 letters, numbers or _ (no spaces)." };
  const low = name.toLowerCase(), bare = low.replace(/_/g, "");
  if (low.startsWith("0x")) return { error: "A name can't start with 0x." };
  if (RESERVED.has(bare) || RESERVED_START.some((w) => bare.startsWith(w))) return { error: "That name is reserved. Pick another." };
  if (blocked(low)) return { error: "Pick a different name." };
  return { name };
}
/// Whether a name the room sent may be shown (well-formed and not taken out of the world).
export const nameShown = (name) => typeof name === "string" && NAME.test(name) && !blocked(name.toLowerCase());
