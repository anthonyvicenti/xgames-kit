// gf-three voxel world: seeded noise for the terrain. Gradient noise in 2D and 3D (Ken Perlin's improved noise, 2002,
// written from the paper's description: a seeded permutation, quintic fade, 12 edge gradients), fractal sums, ridged
// noise and integer hashes. Pure and deterministic: the same seed gives the same numbers on every machine (only
// integer maths and + - * /, so float results are bit-identical in every JS engine).

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A hash of integers → [0, 1). */
export function hash(seed, x, y = 0, z = 0) {
  let n = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(z | 0, 1440670441) + Math.imul(seed | 0, 982451653);
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  n ^= n >>> 16;
  return (n >>> 0) / 4294967296;
}

const G3 = [[1, 1, 0], [-1, 1, 0], [1, -1, 0], [-1, -1, 0], [1, 0, 1], [-1, 0, 1], [1, 0, -1], [-1, 0, -1], [0, 1, 1], [0, -1, 1], [0, 1, -1], [0, -1, -1]];
const fade = t => t * t * t * (t * (t * 6 - 15) + 10);
const lerp = (a, b, t) => a + (b - a) * t;

/** Seeded gradient noise: { n2(x, y), n3(x, y, z) } in about [-1, 1]. */
export function perlin(seed) {
  const rnd = mulberry32(seed), p = new Uint8Array(512), perm = [...Array(256).keys()];
  for (let i = 255; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [perm[i], perm[j]] = [perm[j], perm[i]]; }
  for (let i = 0; i < 512; i++) p[i] = perm[i & 255];
  const g2 = (h, x, y) => { const g = G3[h % 12]; return g[0] * x + g[1] * y; };
  const g3 = (h, x, y, z) => { const g = G3[h % 12]; return g[0] * x + g[1] * y + g[2] * z; };
  return {
    n2(x, y) {
      const X = Math.floor(x), Y = Math.floor(y), xf = x - X, yf = y - Y, xi = X & 255, yi = Y & 255;
      const u = fade(xf), v = fade(yf);
      const aa = p[p[xi] + yi], ab = p[p[xi] + yi + 1], ba = p[p[xi + 1] + yi], bb = p[p[xi + 1] + yi + 1];
      return lerp(lerp(g2(aa, xf, yf), g2(ba, xf - 1, yf), u), lerp(g2(ab, xf, yf - 1), g2(bb, xf - 1, yf - 1), u), v) * 1.4;
    },
    n3(x, y, z) {
      const X = Math.floor(x), Y = Math.floor(y), Z = Math.floor(z), xf = x - X, yf = y - Y, zf = z - Z;
      const xi = X & 255, yi = Y & 255, zi = Z & 255, u = fade(xf), v = fade(yf), w = fade(zf);
      const A = p[xi] + yi, AA = p[A] + zi, AB = p[A + 1] + zi, B = p[xi + 1] + yi, BA = p[B] + zi, BB = p[B + 1] + zi;
      return lerp(
        lerp(lerp(g3(p[AA], xf, yf, zf), g3(p[BA], xf - 1, yf, zf), u), lerp(g3(p[AB], xf, yf - 1, zf), g3(p[BB], xf - 1, yf - 1, zf), u), v),
        lerp(lerp(g3(p[AA + 1], xf, yf, zf - 1), g3(p[BA + 1], xf - 1, yf, zf - 1), u), lerp(g3(p[AB + 1], xf, yf - 1, zf - 1), g3(p[BB + 1], xf - 1, yf - 1, zf - 1), u), v),
        w);
    },
  };
}

/** Fractal sum of n2 (octaves halving in size), about [-1, 1]. */
export function fbm2(n, x, y, oct = 4, gain = 0.5) {
  let a = 0, amp = 1, f = 1, sum = 0;
  for (let i = 0; i < oct; i++) { a += n.n2(x * f + i * 17.3, y * f - i * 9.1) * amp; sum += amp; amp *= gain; f *= 2; }
  return a / sum;
}
/** Ridged fractal noise in [0, 1]: sharp crests where the noise crosses zero (mountain ridges). */
export function ridged2(n, x, y, oct = 4) {
  let a = 0, amp = 0.5, f = 1, w = 1, sum = 0;
  for (let i = 0; i < oct; i++) { let r = 1 - Math.abs(n.n2(x * f + i * 31.7, y * f + i * 11.3)); r *= r * w; w = Math.min(1, r * 2); a += r * amp; sum += amp; amp *= 0.5; f *= 2; }
  return a / sum;
}
