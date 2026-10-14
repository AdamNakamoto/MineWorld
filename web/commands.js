// Chat commands, typed in the chat box: /wild (a safe random spot far from spawn), /spawn, /sethome, /home, /help.
// They run in this game only; the world server just sees you move (a teleport earns nothing for a few seconds).

import { column, naturalBlock } from "./worldgen.js";
import { WATER, BLOCKS } from "./blocks.js";
import { SPAWN, TOWN, WORLD, SEA, PROTECT_R, wrap } from "./rules.js";

const WILD_EVERY_MS = 30_000;
let wildAt = 0;

/// Somewhere to stand far enough from spawn to mine and build: dry land, open sky, not too high up. Anywhere on the
/// planet from just past the protected town to nearly half way round (it wraps, so there's no edge to keep off).
export function wildSpot(rand = Math.random) {
  for (let tries = 0; tries < 200; tries++) {
    const a = rand() * Math.PI * 2, d = PROTECT_R + 24 + rand() * (WORLD / 2 - PROTECT_R - 40);
    const x = wrap(Math.floor(TOWN.x + Math.cos(a) * d)), z = wrap(Math.floor(TOWN.z + Math.sin(a) * d));
    const { h } = column(x, z);
    if (h <= SEA + 1 || h > 100) continue;
    let y = h + 1;
    const solid = (yy) => !!BLOCKS[naturalBlock(x, yy, z)]?.solid; // (grass tufts and flowers aren't)
    while (y < 127 && solid(y)) y++; // above a tree, if one stands here
    const ground = naturalBlock(x, y - 1, z);
    if (!BLOCKS[ground]?.solid || ground === WATER || solid(y + 1)) continue;
    return { x: x + 0.5, y, z: z + 0.5 };
  }
  return { x: SPAWN.x, y: SPAWN.y, z: SPAWN.z };
}

/// Runs `text` if it's a command; returns false if it isn't one (so it goes to chat as usual).
/// `game`: { teleport(x, y, z), here() → {x, y, z}, homeKey(), say(text, kind) }.
export function runCommand(text, game) {
  if (!text.startsWith("/")) return false;
  const [cmd] = text.slice(1).trim().toLowerCase().split(/\s+/);
  const now = Date.now();
  switch (cmd) {
    case "wild": {
      if (now < wildAt) return game.say(`You can use /wild again in ${Math.ceil((wildAt - now) / 1000)} s.`, "bad"), true;
      wildAt = now + WILD_EVERY_MS;
      const p = wildSpot();
      game.teleport(p.x, p.y, p.z);
      game.say(`Off you go: ${Math.round(p.x)}, ${p.y}, ${Math.round(p.z)}. Mine and build away.`, "good");
      return true;
    }
    case "spawn":
      game.teleport(SPAWN.x, SPAWN.y, SPAWN.z);
      game.say("Back at spawn.");
      return true;
    case "sethome": {
      const p = game.here();
      try { localStorage.setItem(game.homeKey(), JSON.stringify(p)); } catch {}
      game.say(`Home set at ${Math.round(p.x)}, ${Math.round(p.y)}, ${Math.round(p.z)}. /home brings you back.`, "good");
      return true;
    }
    case "home": {
      let p = null;
      try { p = JSON.parse(localStorage.getItem(game.homeKey())); } catch {}
      if (!p || ![p.x, p.y, p.z].every(Number.isFinite)) return game.say("No home yet: stand somewhere and type /sethome.", "bad"), true;
      game.teleport(wrap(p.x), p.y, wrap(p.z));
      game.say("Home.");
      return true;
    }
    case "help":
      game.say("/wild: a safe random spot far from spawn · /spawn: back to town · /sethome, then /home · chat: just type");
      return true;
    default:
      game.say(`Unknown command /${cmd}. Try /help.`, "bad");
      return true;
  }
}
