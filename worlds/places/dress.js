// The places vocabulary's dressing words (open builder wave 10, track H): things put at spots, things picked at random
// spots that pass keep-clear tests, and the party loader's own scatter. Pure: no three.js, no DOM.
//
//   put      things (or a group of things) at spots: each spot that passes the step's tests gets one
//   pick     `count` things at random spots drawn by a drawer (an island's `disc`) that pass the tests
//   scatter  the party loader's seeded scatter (kit/world/layout.js expandLayout expands it at load)
// Spots (where): at, list, mirror, ring here; an island adds corners, round, along, flip, beside (island.js). Tests (keep
// clear of what): taken, chance, or here; an island adds sdf, plaza, path, water, spawn, box, runes. A step's random
// draws are taken in the order it names (`order`), so a recipe can follow the code it replaced draw for draw.
import { val, r2, norm } from './values.js';

// ------------------------------------------------------------------------------------------------------------ tests
/** A pad may be a number or {foot: k, add: c} (k times the thing's own footprint, plus c). */
export const padOf = (P, p) => (p && typeof p === 'object' && 'foot' in p ? P.vars.foot * p.foot + (p.add ?? 0) : val(P, p ?? 0));
export const CORE_TESTS = {
  taken(P, [, a], x, z) { const m = padOf(P, a); return !P.taken.some(t => Math.hypot(t[0] - x, t[1] - z) < m + t[2]); },
  chance(P, [, a]) { return P.R() < a; },
  or(P, t, x, z) { return t.slice(1).some(u => test(P, u, x, z)); },
};
export function test(P, t, x, z) {
  const f = P.words.tests[t[0]];
  if (!f) throw new Error(`places: no test "${t[0]}" (${Object.keys(P.words.tests).join(', ')})`);
  return f(P, t, x, z);
}
export const passes = (P, tests, x, z) => (tests ?? []).every(t => test(P, t, x, z));

// ------------------------------------------------------------------------------------------------------------ spots
// A spot source → [{x, z, y?, rot?, a?, side?}] (a: the angle the spot came from).
const mirrorRot = (ax, r) => norm(ax === 'x' ? -r : ax === 'z' ? 180 - r : 180 + r);
export const CORE_SPOTS = {
  at(P, s) { return [{ x: val(P, s.at[0]), y: val(P, s.at[1]), z: val(P, s.at[2]) }]; },
  list(P, s) { return s.list.map(a => ({ x: a[0], y: a[1], z: a[2], rot: a[3] })); },
  mirror(P, s) {
    const base = spots(P, s.of), out = [...base];
    for (const ax of s.mirror === 'xz' ? ['x', 'z', 'xz'] : [s.mirror]) for (const p of base) out.push({ ...p, x: ax.includes('x') ? -p.x : p.x, z: ax.includes('z') ? -p.z : p.z, rot: p.rot === undefined ? undefined : mirrorRot(ax, p.rot) });
    return out;
  },
  ring(P, s) {
    const { n, phase = 0 } = s.ring, at = s.ring.at ?? P.level?.at ?? [0, 0, 0], r = val(P, s.ring.r);
    return Array.from({ length: n }, (_, k) => { const a = (k / n) * Math.PI * 2 + phase; return { x: at[0] + Math.cos(a) * r, z: at[2] + Math.sin(a) * r, a }; });
  },
};
export function spots(P, s) {
  for (const [k, f] of Object.entries(P.words.spots)) if (s[k] !== undefined) return f(P, s);
  throw new Error(`places: no spot source in ${JSON.stringify(s)} (${Object.keys(P.words.spots).join(', ')})`);
}

// ------------------------------------------------------------------------------------------------------------- emit
// One placement: its prop (fixed, a cycle by index, a chance chain, a numbered pattern), its turn and its scale. Where
// it goes: props, crystals or a vegetation list (`into`).
function choose(P, e) {
  if (typeof e.prop === 'string') return e.prop;
  if (e.prop?.cycle) return e.prop.cycle[P.k % e.prop.cycle.length];
  if (e.prop?.chain) { for (const [id, p] of e.prop.chain) if (p === undefined || P.R() < p) return id; }
  if (e.prop?.pattern) return e.prop.pattern.replace('{n}', String(e.prop.from + Math.floor(P.R() * e.prop.count)));
  return e.prop;
}
function rotOf(P, e, spot) {
  const r = e.rot ?? 0;
  if (typeof r === 'number') return r;
  if (r === 'spot') return spot.rot;
  if (r === 'any') return Math.round(P.R() * 360);
  if (r === 'quarter') return Math.round(P.R() * 4) * 90;
  if (r === 'quarter-jitter') return Math.round(P.R() * 4) * 90 + (P.R() - 0.5) * 20;
  if (r === 'face-out') return Math.round((-spot.a * 180) / Math.PI + 90);
  throw new Error(`places: no turn "${r}"`);
}
function scaleOf(P, e, item) {
  const s = e.scale ?? 1;
  if (typeof s === 'number') return s;
  if (s.byProp) { const base = s.byProp[item.prop] ?? s.byProp.else; return r2(base + P.R() * s.rand); }
  return r2(s.base + P.R() * s.rand);
}
function emit(P, e, item, x, z) {
  const L = P.level, y = item.y ?? e.y ?? 0, lv = L ? { level: L.id } : {};
  if (e.into === 'trees') P.out.vegetation.trees.push({ kind: item.prop, at: [r2(x), 0, r2(z)], rot: item.rot, scale: item.scale, ...lv });
  else if (e.into === 'bushes') P.out.vegetation.bushes.push([r2(x), 0.35, r2(z), item.scale]);
  else if (e.into === 'flowers') P.out.vegetation.flowers.push([r2(x), 0, r2(z), item.scale]);
  else if (e.into === 'crystals') P.out.crystals.push({ at: [r2(x), 0, r2(z)], rot: item.rot, scale: item.scale, glow: item.glow, ...lv });
  else P.out.props.push({ prop: item.prop, at: [r2(x), y, r2(z)], rot: item.rot, scale: item.scale, ...lv });
  if (e.keep) P.taken.push([x, z, e.keep === 'foot' ? P.vars.foot : e.keep]);
}
function glowOf(e, k, spot) { const g = e.glow; if (!g) return undefined; if (typeof g === 'string') return g; if (g.every) return k % g.every === g.at ? g.then : g.else; if (g.side) return spot.side < 0 ? g.side[0] : g.side[1]; return undefined; }

// ------------------------------------------------------------------------------------------------------------ steps
export const DRESS_STEPS = {
  /** Things at spots: each spot that passes the tests (`when`) gets one placement, or one group (members at offsets). */
  put(P, s) {
    const list = spots(P, s.spots);
    for (const [i, sp] of list.entries()) {
      P.k = i;
      if (!passes(P, s.when, sp.x, sp.z)) continue;
      if (s.group) {
        for (const m of s.group) { const item = { prop: m.prop, rot: rotOf(P, m, sp), scale: m.scale ?? 1 }; emit(P, { ...s, keep: 0 }, item, sp.x + (m.at?.[0] ?? 0), sp.z + (m.at?.[2] ?? 0)); }
        if (s.keep) P.taken.push([sp.x, sp.z, s.keep]);
        continue;
      }
      const item = {};
      for (const op of s.order ?? ['prop', 'rot', 'scale']) {
        if (op === 'prop') item.prop = choose(P, s);
        if (op === 'rot') item.rot = rotOf(P, s, sp);
        if (op === 'scale') item.scale = scaleOf(P, s, item);
      }
      item.y = sp.y;
      item.glow = glowOf(s, i, sp);
      emit(P, s, item, sp.x, sp.z);
    }
  },
  /** `count` things at random spots (drawn by `from`, default the island's disc) that pass the tests (`where`); a
   *  failed draw still uses its index. */
  pick(P, s) {
    const n = Math.round(val(P, s.count)), draw = P.words.draws[s.from ?? 'disc'];
    if (!draw) throw new Error(`places: no spot drawer "${s.from ?? 'disc'}" (${Object.keys(P.words.draws).join(', ') || 'none'})`);
    for (let k = 0; k < n; k++) {
      P.k = k;
      const item = {};
      let at = null;
      for (const op of s.order ?? ['spot', 'prop', 'rot', 'scale']) {
        if (op === 'spot') { at = draw(P, s.where, s.tries ?? 60); if (!at) break; }
        else if (op === 'prop') item.prop = choose(P, s);
        else if (op === 'rot') item.rot = rotOf(P, s, {});
        else if (op === 'scale') item.scale = scaleOf(P, s, item);
        else if (op === 'foot') P.vars.foot = s.foot[item.prop] * item.scale;
      }
      if (!at) continue;
      item.glow = glowOf(s, k, {});
      emit(P, s, item, at[0], at[1]);
    }
  },
  /** The party loader's own scatter (it expands it, seeded, at load). */
  scatter(P, s) { P.out.scatter.push(...JSON.parse(JSON.stringify(s.list))); },
};
