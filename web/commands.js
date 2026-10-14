// Chat commands, typed in the chat box: /wild (a safe random spot far from the spawn or the pad), /spawn, /sethome,
// /home, /help. They run in this game only; the world server just sees you move (a teleport earns nothing for a few
// seconds). On the rocket's zones (zones.js) they work within the zone: /spawn takes you to its landing pad, /wild
// somewhere on it, and /home only where your home was set.

import { column, naturalBlock } from "./worldgen.js";
import { WATER, BLOCKS } from "./blocks.js";
import { TOWN, WORLD, SEA, PROTECT_R, wrap } from "./rules.js";
import { ZONES, zoneOf, spawnOf, protectedIn, calmAt, PAD_R } from "./zones.js";

const WILD_EVERY_MS = 30_000;
let wildAt = 0;

/// Somewhere to stand on planet `zone` far enough from its spawn (the town, or the pad) to mine and build: dry land,
/// open sky, not too high up, nowhere protected (Cinderfall's arena and path are), and nowhere the boss fights.
/// Anywhere from just past the protected middle to nearly half way round (it wraps, so there's no edge to keep off).
export function wildSpot(zone = "home", rand = Math.random) {
  const home = zone === "home";
  const c = home ? TOWN : zoneOf(zone).pad, min = (home ? PROTECT_R : PAD_R) + 24;
  for (let tries = 0; tries < 300; tries++) {
    const a = rand() * Math.PI * 2, d = min + rand() * (WORLD / 2 - min - 16);
    const x = wrap(Math.floor(c.x + Math.cos(a) * d)), z = wrap(Math.floor(c.z + Math.sin(a) * d));
    if (protectedIn(zone, x, z) || (!home && calmAt(zone, x, z))) continue;
    const { h } = column(x, z, zone);
    if (h <= SEA + 1 || h > 100) continue;
    let y = h + 1;
    const solid = (yy) => !!BLOCKS[naturalBlock(x, yy, z, zone)]?.solid; // (grass tufts and flowers aren't)
    while (y < 127 && solid(y)) y++; // above a tree, if one stands here
    const ground = naturalBlock(x, y - 1, z, zone);
    if (!BLOCKS[ground]?.solid || ground === WATER || solid(y + 1)) continue;
    return { x: x + 0.5, y, z: z + 0.5 };
  }
  return spawnOf(zone);
}

/// Runs `text` if it's a command; returns false if it isn't one (so it goes to chat as usual).
/// `game`: { teleport(x, y, z), here() → {x, y, z}, zone() → the zone key, homeKey(), say(text, kind) }.
export function runCommand(text, game) {
  if (!text.startsWith("/")) return false;
  const [cmd] = text.slice(1).trim().toLowerCase().split(/\s+/);
  const now = Date.now();
  const zone = game.zone?.() ?? "home", Z = zoneOf(zone);
  switch (cmd) {
    case "wild": {
      if (now < wildAt) return game.say(`You can use /wild again in ${Math.ceil((wildAt - now) / 1000)} s.`, "bad"), true;
      wildAt = now + WILD_EVERY_MS;
      const p = wildSpot(zone);
      game.teleport(p.x, p.y, p.z);
      game.say(`Off you go: ${Math.round(p.x)}, ${p.y}, ${Math.round(p.z)}. Mine and build away.`, "good");
      return true;
    }
    case "spawn": {
      const p = spawnOf(zone);
      game.teleport(p.x, p.y, p.z);
      game.say(zone === "home" ? "Back at spawn." : `Back at ${Z.name}'s landing pad.`);
      return true;
    }
    case "sethome": {
      const p = game.here();
      try { localStorage.setItem(game.homeKey(), JSON.stringify({ ...p, zone })); } catch {}
      game.say(`Home set at ${Math.round(p.x)}, ${Math.round(p.y)}, ${Math.round(p.z)}${zone === "home" ? "" : ` on ${Z.name}`}. /home brings you back.`, "good");
      return true;
    }
    case "home": {
      let p = null;
      try { p = JSON.parse(localStorage.getItem(game.homeKey())); } catch {}
      if (!p || ![p.x, p.y, p.z].every(Number.isFinite)) return game.say("No home yet: stand somewhere and type /sethome.", "bad"), true;
      const at = ZONES[p.zone] ? p.zone : "home";
      if (at !== zone) return game.say(`Your home is on ${ZONES[at].name}: take the rocket there first (or /sethome here).`, "bad"), true;
      game.teleport(wrap(p.x), p.y, wrap(p.z));
      game.say("Home.");
      return true;
    }
    case "help":
      game.say(`/wild: a safe random spot far from ${zone === "home" ? "spawn" : "the pad"} · /spawn: back to ${zone === "home" ? "town" : "the landing pad"} · /sethome, then /home · the rocket (on the launch pad, F) flies to the other zones · chat: just type`);
      return true;
    default:
      game.say(`Unknown command /${cmd}. Try /help.`, "bad");
      return true;
  }
}
