// gf-three core: seeded random numbers. Gameplay never calls Math.random (CONTRACT §3): ctx.rng() is this.
// Pure (no DOM, no three.js), so node tests and tools import it too.

/** Mulberry32: a fast 32-bit PRNG. Returns a function giving [0, 1). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A 32-bit hash of a string (FNV-1a), for deriving seeds from labels. */
export function hashString(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

/** Any seed (number or string) → a uint32. */
export function seedOf(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return (Math.abs(Math.floor(v)) % 4294967296) >>> 0;
  const n = Number(v);
  if (v !== null && v !== '' && Number.isFinite(n)) return (Math.abs(Math.floor(n)) % 4294967296) >>> 0;
  return hashString(String(v ?? ''));
}

/**
 * rng() → [0, 1), with helpers:
 *   rng.int(n)            0..n-1
 *   rng.range(a, b)       [a, b)
 *   rng.pick(list)        one item
 *   rng.fork(label)       an independent stream derived from this seed and a label (so one system's draws never
 *                         shift another's: bots, layout and the game's own rules each take their own fork)
 */
export function createRng(seed) {
  const s = seedOf(seed), next = mulberry32(s);
  const rng = () => next();
  rng.seed = s;
  rng.int = n => Math.floor(next() * n);
  rng.range = (a, b) => a + (b - a) * next();
  rng.pick = list => list[Math.floor(next() * list.length)];
  rng.fork = label => createRng((s ^ hashString(String(label))) >>> 0);
  return rng;
}
