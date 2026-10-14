// Names and addresses that change in one place. The game's name and ticker are also baked into the contracts at
// deploy time (MineToken: "MineWorldCraft" / "MINE"), so change both together, before deploying.

export const NAME = "MineWorldCraft";
export const TICKER = "$MINE";

/// The live world server. Empty: the site is served by the world server's own Worker (multiplayer/wrangler.toml
/// [assets]), so the room is at /ws on the same address (mineworldcraft.fun, or its workers.dev address). Set it if
/// the site is ever hosted elsewhere. On localhost the local room is used instead (`npx wrangler dev` in
/// multiplayer/), and `?mp=wss://…` overrides both.
export const LIVE_ROOM = "";
export const LOCAL_ROOM = "ws://localhost:8790/ws";

export function roomUrl() {
  const q = new URLSearchParams(location.search).get("mp");
  if (q !== null) return q || null; // ?mp= with nothing plays offline
  if (/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) return LOCAL_ROOM;
  return LIVE_ROOM || (location.protocol === "https:" ? `wss://${location.host}/ws` : null);
}
