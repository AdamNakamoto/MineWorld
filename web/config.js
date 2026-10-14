// Names and addresses that change in one place. The game's name and ticker are also baked into the contracts at
// deploy time (MineToken: "MineWorldCraft" / "MINE"), so change both together, before deploying.

export const NAME = "MineWorldCraft";
export const TICKER = "$MINE";

/// The live world server (multiplayer/, `npx wrangler deploy` prints its address). Empty until it's deployed: the
/// game then plays offline (single player, nothing earned). On localhost the local room is used instead
/// (`npx wrangler dev` in multiplayer/), and `?mp=wss://…` overrides both.
export const LIVE_ROOM = "";
export const LOCAL_ROOM = "ws://localhost:8790/ws";

export function roomUrl() {
  const q = new URLSearchParams(location.search).get("mp");
  if (q !== null) return q || null; // ?mp= with nothing plays offline
  if (/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) return LOCAL_ROOM;
  return LIVE_ROOM || null;
}
