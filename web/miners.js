// The 16 MineWorldCraft Miners outfits, in the order MineWorldMiners.sol numbers them (designOf). Cosmetic only:
// they change how a player looks, never what they earn. Shared by the game (the avatars), the panel and the NFT
// pictures. Players without one wear ROOKIE.

export const ROOKIE = {
  key: "rookie", name: "Rookie", rarity: "",
  skin: 0xe0ac7e, hair: 0x4a3222, shirt: 0x3f7fd0, pants: 0x3a3f66, shoes: 0x3b2a1e, hat: null,
};

export const MINERS = [
  { key: "classic", name: "Classic Miner", rarity: "Common", skin: 0xe0ac7e, hair: 0x3b2618, shirt: 0xd8822f, pants: 0x2f4a7a, shoes: 0x2e2018, hat: { type: "hardhat", color: 0xf2c230 }, accent: 0xfff6a8 },
  { key: "lumberjack", name: "Lumberjack", rarity: "Common", skin: 0xd99b6c, hair: 0x6b3a1e, shirt: 0xc0342c, pants: 0x3b3b44, shoes: 0x4a3020, hat: { type: "beanie", color: 0x2f5a2f }, accent: 0x1e1e1e, beard: 0x6b3a1e },
  { key: "farmer", name: "Farmer", rarity: "Common", skin: 0xe8b98c, hair: 0xb8862c, shirt: 0xf0e6c8, pants: 0x4a6fa5, shoes: 0x5a3a20, hat: { type: "straw", color: 0xe0c060 }, accent: 0x4a6fa5 },
  { key: "explorer", name: "Explorer", rarity: "Common", skin: 0xc68a5e, hair: 0x2a1a10, shirt: 0xb59a64, pants: 0x6f5a3a, shoes: 0x3a2a18, hat: { type: "safari", color: 0xcdb680 }, accent: 0x7a4a2a },
  { key: "builder", name: "Builder", rarity: "Common", skin: 0x8d5a3b, hair: 0x1a1210, shirt: 0xff8a1f, pants: 0x3a5a8a, shoes: 0x2a2a2a, hat: { type: "hardhat", color: 0xffffff }, accent: 0xd8ff3a },
  { key: "knight", name: "Knight", rarity: "Rare", skin: 0xe0ac7e, hair: 0x5a4030, shirt: 0xb8bcc4, pants: 0x8a8e96, shoes: 0x5a5e66, hat: { type: "helmet", color: 0xc8ccd4 }, accent: 0x2a4aa8 },
  { key: "ninja", name: "Ninja", rarity: "Rare", skin: 0xe0ac7e, hair: 0x101014, shirt: 0x1c1c24, pants: 0x1c1c24, shoes: 0x101014, hat: { type: "hood", color: 0x1c1c24 }, accent: 0xc0242c },
  { key: "astronaut", name: "Astronaut", rarity: "Rare", skin: 0xe0ac7e, hair: 0x4a3222, shirt: 0xf2f2f2, pants: 0xe4e4e4, shoes: 0x9a9a9a, hat: { type: "dome", color: 0x9fd8ff }, accent: 0xff6a2a },
  { key: "diver", name: "Deep Diver", rarity: "Rare", skin: 0xe0ac7e, hair: 0x3b2618, shirt: 0x2a5a6a, pants: 0x2a4a5a, shoes: 0x1a2a30, hat: { type: "brass", color: 0xc8963a }, accent: 0x3ad8e8 },
  { key: "lava", name: "Lava Walker", rarity: "Rare", skin: 0x9a5a3a, hair: 0x2a0a06, shirt: 0x3a1a14, pants: 0x2a1410, shoes: 0xff5a1a, hat: { type: "horns", color: 0xff7a1a }, accent: 0xff4a10, glow: 0xff5a10 },
  { key: "frost", name: "Frost Miner", rarity: "Rare", skin: 0xf0d8c8, hair: 0xe8f4ff, shirt: 0x8ad0f0, pants: 0x4a7aa8, shoes: 0xe8f4ff, hat: { type: "beanie", color: 0xe8f4ff }, accent: 0x5fe8ff, glow: 0x9fe8ff },
  { key: "gold", name: "Gold Miner", rarity: "Legendary", skin: 0xe0ac7e, hair: 0x3b2618, shirt: 0xf5c832, pants: 0xb8902a, shoes: 0x8a6a1a, hat: { type: "hardhat", color: 0xffd84a }, accent: 0xfff2a0, glow: 0xffd84a },
  { key: "diamond", name: "Diamond Miner", rarity: "Legendary", skin: 0xe0ac7e, hair: 0x2a2a3a, shirt: 0x5fe8e0, pants: 0x2fb0b0, shoes: 0x1f7a7a, hat: { type: "hardhat", color: 0x9ff8f0 }, accent: 0xffffff, glow: 0x5fe8e0 },
  { key: "shadow", name: "Shadow Miner", rarity: "Mythic", skin: 0x2a2433, hair: 0x0a0a10, shirt: 0x14121c, pants: 0x0e0c14, shoes: 0x08080c, hat: { type: "hood", color: 0x0e0c14 }, accent: 0xb04aff, glow: 0x8a3aff, eyes: 0xd28aff },
  { key: "neon", name: "Neon Miner", rarity: "Mythic", skin: 0xe0ac7e, hair: 0xff3ad0, shirt: 0x1a1a2a, pants: 0x14142a, shoes: 0x3affe0, hat: { type: "visor", color: 0x3affe0 }, accent: 0xff3ad0, glow: 0x3affe0 },
  { key: "crystal", name: "Crystal Miner", rarity: "Mythic", skin: 0xe8d0f8, hair: 0xd25bff, shirt: 0xb070f0, pants: 0x7a3ad0, shoes: 0xd25bff, hat: { type: "crown", color: 0xd25bff }, accent: 0xffffff, glow: 0xd25bff, eyes: 0xffffff },
];

export const designOf = (i) => (Number.isInteger(i) && MINERS[i]) || ROOKIE;
