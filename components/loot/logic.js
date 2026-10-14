// loot: the pure logic (no three.js, no DOM): what a kill or a chest drops, upgrade offers, pickup reach. Node tests:
// research/gf-three/tests/k2-loot.test.mjs.

/** Drop kinds on the wire. */
export const KIND = { coin: 0, potion: 1, weapon: 2, chest: 3, open: 4 };
export const KIND_NAME = ['coin', 'potion', 'weapon', 'chest', 'open'];

/** Coins for a kill worth `score` points: 1 for a basic enemy, more for tougher ones (score / 10), at most `max`. */
export const coinsFor = (score = 10, { per = 10, max = 6 } = {}) => Math.max(1, Math.min(max, Math.round((score || 10) / per)));

/**
 * What a kill drops. rng() → 0..1. o: {score, potionChance, weaponChance, weapons (count), boss}. → [{kind, weapon?, rarity?}]
 * Weapons: an index into the melee mechanic's weapons and a rarity (rare and better are rarer; a boss's is epic or
 * better).
 */
export function rollDrops(rng, { score = 10, potionChance = 0.12, weaponChance = 0.06, weapons = 0, boss = false, coins = null } = {}) {
  const out = [];
  const n = coins ?? (boss ? 12 : coinsFor(score));
  for (let i = 0; i < n; i++) out.push({ kind: KIND.coin });
  if (boss || rng() < potionChance) out.push({ kind: KIND.potion });
  if (weapons > 0 && (boss || rng() < weaponChance)) out.push({ kind: KIND.weapon, weapon: Math.floor(rng() * weapons) % weapons, rarity: rollRarity(rng, boss ? 2 : 0) });
  return out;
}
/** A rarity 0..3 at or above `min`: each step up half as likely. */
export function rollRarity(rng, min = 0) { let r = min; while (r < 3 && rng() < 0.4) r++; return r; }

/** What a chest spills. */
export function chestDrops(rng, { weaponChance = 0.5, weapons = 0 } = {}) {
  const out = [];
  const n = 3 + Math.floor(rng() * 3);
  for (let i = 0; i < n; i++) out.push({ kind: KIND.coin });
  if (rng() < 0.45) out.push({ kind: KIND.potion });
  if (weapons > 0 && rng() < weaponChance) out.push({ kind: KIND.weapon, weapon: Math.floor(rng() * weapons) % weapons, rarity: rollRarity(rng, 1) });
  return out;
}

/** `n` different upgrade ids from `list` (rng() → 0..1). */
export function pickUpgrades(rng, list, n = 3) {
  const pool = [...new Set(list)], out = [];
  while (pool.length && out.length < n) out.push(pool.splice(Math.floor(rng() * pool.length) % pool.length, 1)[0]);
  return out;
}

/** Points around (x, z) to scatter `n` drops on (a ring that grows). rng for jitter. */
export function scatter(x, z, n, rng, r0 = 0.5) {
  return Array.from({ length: n }, (_, i) => { const a = (i / Math.max(1, n)) * Math.PI * 2 + rng() * 0.6, r = r0 + 0.35 * Math.floor(i / 6) + rng() * 0.3; return { x: x + Math.cos(a) * r, z: z + Math.sin(a) * r }; });
}

/** Is a drop close enough to take? touch drops (coins, potions) by walking over them; others by a press within reach. */
export function canTake(kind, d, { touch = 0.9, reach = 1.8, slack = 0 } = {}) {
  if (kind === KIND.coin || kind === KIND.potion) return d <= touch + slack;
  if (kind === KIND.weapon || kind === KIND.chest) return d <= reach + slack;
  return false;
}
