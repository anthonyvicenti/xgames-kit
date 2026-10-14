// The places vocabulary's values (open builder wave 10, track H): a recipe number may be per size ({small, medium,
// large}) or a small expression over the named quantities of the place ({"$": "half", "mul": 0.62, "clamp": [4, 11]}).
// Pure: no three.js, no DOM.
export const SIZES = ['small', 'medium', 'large'];
export const r2 = v => Math.round(v * 100) / 100;
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const norm = a => ((Math.round(a) % 360) + 360) % 360;
export const clone = v => JSON.parse(JSON.stringify(v));

/** A recipe value: per size, an expression over named quantities, or as it is. */
export function val(P, v) {
  if (Array.isArray(v)) return v.map(x => val(P, x));
  if (v && typeof v === 'object') {
    if (SIZES.some(k => k in v) && !('$' in v)) return val(P, v[P.size] ?? v.small);
    if ('$' in v) {
      let x = P.vars[v.$];
      if (typeof x !== 'number') throw new Error(`places: "${v.$}" is not a quantity here (${Object.keys(P.vars).join(', ') || 'none'})`);
      if ('mul' in v) x *= val(P, v.mul);
      if ('add' in v) x += val(P, v.add);
      if ('max' in v) x = Math.min(x, val(P, v.max));   // an upper bound first, then a lower one: max(lo, min(hi, x))
      if ('min' in v) x = Math.max(x, val(P, v.min));
      if ('clamp' in v) x = clamp(x, val(P, v.clamp[0]), val(P, v.clamp[1]));
      if ('floorTo' in v) x = Math.floor(x / v.floorTo + 1e-9) * v.floorTo;   // whole pieces: a rise of stacked blocks
      if (v.round) x = r2(x);
      return x;
    }
  }
  return v;
}
