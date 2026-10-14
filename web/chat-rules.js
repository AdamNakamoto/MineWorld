// What a chat message may be (from Courier World). Shared by the game (instant feedback) and the multiplayer room (the
// rule that counts), with no imports, so both can load it. Any language and emoji are fine; links and
// wallet addresses are not.

export const CHAT_MAX = 140; // characters
export const CHAT_EVERY_MS = 2000; // one message per player this often

// Endings that are only ever web addresses: "name.com" is a link wherever it appears.
const STRONG =
  "com|net|org|io|xyz|gg|ly|app|fun|site|link|online|top|vip|info|biz|ru|cn|tk|ml|ga|cf|gq|cc|tv|dev|finance|" +
  "exchange|club|store|shop|tech|website|click|lol|bet|eth|crypto|nft|dao|network|ws|su|live|pro|wtf|claim|airdrop|money";
// Endings that are also everyday words ("thanks.me", "lol.it"): a link only with a path, as in "t.me/name".
const WEAK =
  "me|to|in|it|us|my|id|co|ai|de|es|fr|jp|kr|tw|hk|sg|th|vn|ph|br|uk|be|so|at|is|win|world|today|news|social|chat|" +
  "group|page|zone|space";
const LINK = new RegExp(
  String.raw`(?:[a-z][a-z0-9+.-]*:\/\/)|(?:\bwww\.)|(?:\b\d{1,3}(?:\.\d{1,3}){3}\b)|` +
    String.raw`(?:[a-z0-9-]+\.(?:${STRONG})(?![a-z0-9]))|(?:[a-z0-9-]+\.(?:${WEAK})\/)`,
  "i"
);
const ADDRESS = /0x[0-9a-f]{20,}/i;

/// The message as it will be shown, or why it can't be sent: { text } or { error }.
export function cleanChat(raw) {
  if (typeof raw !== "string") return { error: "Type a message first." };
  // NFKC folds look-alikes (full-width letters, ligatures, circled letters) into plain ones.
  let t = raw.normalize("NFKC");
  // Drop invisible and control characters (zero-width spaces, direction overrides) and private-use ones.
  t = t.replace(/[\p{Cc}\p{Cf}\p{Co}\p{Cs}]/gu, "");
  // At most three accents on a letter (enough for every script), so nobody stacks marks into a smear.
  t = t.replace(/(\p{M}{3})\p{M}+/gu, "$1");
  t = t.replace(/\s+/g, " ").trim();
  if (!t) return { error: "Type a message first." };
  if ([...t].length > CHAT_MAX) return { error: `Keep it under ${CHAT_MAX} characters.` };
  if (LINK.test(unmask(t))) return { error: "Links aren't allowed in chat." };
  if (ADDRESS.test(t.replace(/\s/g, ""))) return { error: "Wallet addresses aren't allowed in chat." };
  return { text: t };
}

/// The message with the usual ways of hiding a link undone: "dot" spelled out, a dot in brackets, a dot
/// with spaces on both sides, and the ideographic full stop.
function unmask(t) {
  return t
    .toLowerCase()
    .replace(/[。｡︒]/g, ".")
    .replace(/\s*[([{<]\s*(?:dot|\.)\s*[)\]}>]\s*/g, ".")
    .replace(/\s+dot\s+/g, ".")
    .replace(/\s+\.\s+/g, ".");
}
