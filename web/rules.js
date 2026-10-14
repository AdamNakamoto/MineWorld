// The world's rules, shared by the game and the multiplayer room: its size, the protected town, reach, the day,
// and the monsters. The room checks every break and every hit against these, so a modified game can't earn more
// than an honest one.
//
// The world is a small planet: x and z wrap round (walk past 511 and you're back at 0), so every distance and every
// block lookup goes through wrap / wrapDelta. The game draws it curved (planet.js); the rules are flat.

export const WORLD = 512; // blocks along each side (x and z run 0..511, then round again)
export const CHUNK = 16;
export const HEIGHT = 128;
export const SEA = 48;
export const TOWN = { x: 256, z: 256, y: 58 };
/// Nobody breaks or places blocks this close to the town's centre (the spawn, the Mining Office).
export const PROTECT_R = 64;
export const SPAWN = { x: TOWN.x + 0.5, y: TOWN.y + 1, z: TOWN.z + 7.5 };

export const REACH = 5; // blocks, in the game
export const ROOM_REACH = 7.5; // what the room allows: reach plus room for the latency between position updates
export const ATTACK_MS = 500; // a sword swing
export const ROOM_ATTACK_MS = 380;

/// Whether (x, z) is written the one way it's stored: 0 <= x, z < WORLD (wrap first to get there).
export const inWorld = (x, z) => x >= 0 && z >= 0 && x < WORLD && z < WORLD;
/// A coordinate brought round into [0, WORLD) (whole numbers stay whole).
export const wrap = (v) => ((v % WORLD) + WORLD) % WORLD;
/// The shortest way from one coordinate to another round the planet: a difference brought into [-WORLD/2, WORLD/2).
export const wrapDelta = (d) => d - WORLD * Math.floor(d / WORLD + 0.5);
/// The flat distance from (ax, az) to (bx, bz) the short way round.
export const wrapDist = (ax, az, bx, bz) => Math.hypot(wrapDelta(ax - bx), wrapDelta(az - bz));
export function protectedAt(x, z) {
  const dx = wrapDelta(x + 0.5 - TOWN.x), dz = wrapDelta(z + 0.5 - TOWN.z);
  return dx * dx + dz * dz < PROTECT_R * PROTECT_R;
}

/// One day lasts 20 minutes, the same moment for everyone (it follows the clock, not the server).
export const DAY_MS = 20 * 60 * 1000;
/// 0 at sunrise, 0.25 noon, 0.5 sunset, 0.75 midnight.
export const dayTime = (ms) => (ms % DAY_MS) / DAY_MS;
export const isNight = (ms) => {
  const t = dayTime(ms);
  return t > 0.53 && t < 0.97;
};

/// Monsters: original creatures. The room spawns them for each player (at night, or underground), the player's game
/// moves them, and the room checks the hits. hp and damage use the same scale as the player's 20 health.
export const MOBS = {
  mudling: { name: "Mudling", hp: 18, damage: 2, speed: 2.2, size: [0.8, 1.1, 0.8] },
  crawler: { name: "Cave crawler", hp: 14, damage: 2, speed: 3.6, size: [1.2, 0.7, 1.2] },
  rattler: { name: "Bone rattler", hp: 20, damage: 3, speed: 2.6, size: [0.6, 1.9, 0.6] },
  golem: { name: "Rock golem", hp: 50, damage: 6, speed: 1.6, size: [1.3, 2.3, 1.3], deep: true },
};
export const MOB_KINDS = Object.keys(MOBS);
export const MOBS_PER_PLAYER = 3;
export const MOB_EVERY_MS = 20_000; // the soonest a player gets another monster
export const MOB_LIFE_MS = 4 * 60_000; // monsters that aren't defeated wander off
export const UNDERGROUND_Y = 44; // below this, monsters come by day too
