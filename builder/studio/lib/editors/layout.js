// The layout editor's logic, with no DOM: the props of a 3D world (config/world.json → props, the json slot
// world.<template>.layout) seen from above. A prop is { prop, at: [x, y, z], rot (degrees), scale }. Pure.
//
// The world's own size is config/world.json → size [width, depth] (metres, centred on 0). A prop's footprint comes from
// the library's measured size (library/props.json → size [w, h, d]) when the prop is a library one, else 1 m.

export const SNAP = 0.5;          // metres a drag snaps to (hold Alt for free placement)
export const TURN = 15;           // degrees a rotate step turns

export const snap = (v, step = SNAP) => (step > 0 ? Math.round(v / step) * step : v);
const r2 = v => Math.round(v * 100) / 100;

/** The props as the editor draws them: index, name, centre, rotation, footprint (w by d, metres, already scaled). */
export function propsView(props = [], sizes = {}) {
  return props.map((p, i) => {
    const s = sizes[p.prop] ?? [1, 1, 1], k = Number(p.scale ?? 1) || 1;
    return { i, name: p.prop, x: p.at?.[0] ?? 0, z: p.at?.[2] ?? 0, rot: Number(p.rot ?? 0) || 0, w: Math.max(0.3, s[0] * k), d: Math.max(0.3, s[2] * k), h: s[1] * k };
  });
}

/** The prop under a point (the smallest one wins, so a bench in front of a house can be picked). → index or -1 */
export function hitProp(view, x, z) {
  let best = -1, area = Infinity;
  for (const v of view) {
    const a = (-v.rot * Math.PI) / 180, dx = x - v.x, dz = z - v.z;
    const lx = dx * Math.cos(a) - dz * Math.sin(a), lz = dx * Math.sin(a) + dz * Math.cos(a);
    if (Math.abs(lx) <= v.w / 2 && Math.abs(lz) <= v.d / 2 && v.w * v.d < area) { best = v.i; area = v.w * v.d; }
  }
  return best;
}

/** Keep a point inside the world's ground ([width, depth] centred on 0). */
export function clampTo(size, x, z) {
  const [w, d] = Array.isArray(size) ? size : [size * 2, size * 2];
  return [Math.max(-w / 2, Math.min(w / 2, x)), Math.max(-d / 2, Math.min(d / 2, z))];
}

/** A prop moved to (x, z), snapped and kept inside. → a new list */
export function moveProp(props, i, x, z, { size, step = SNAP } = {}) {
  const [cx, cz] = size ? clampTo(size, snap(x, step), snap(z, step)) : [snap(x, step), snap(z, step)];
  return props.map((p, j) => (j === i ? { ...p, at: [r2(cx), p.at?.[1] ?? 0, r2(cz)] } : p));
}
/** A prop turned by `by` degrees (kept in 0..359, whole steps). → a new list */
export function rotateProp(props, i, by = TURN) {
  return props.map((p, j) => (j === i ? { ...p, rot: ((Math.round((Number(p.rot ?? 0) + by) / 1) % 360) + 360) % 360 } : p));
}
/** A prop's size changed (0.25 to 4 times the model). → a new list */
export function scaleProp(props, i, scale) {
  const k = Math.max(0.25, Math.min(4, Number(scale) || 1));
  return props.map((p, j) => (j === i ? { ...p, scale: r2(k) } : p));
}
/** A copy of a prop beside it (Fortnite's "place another"). → { props, index } */
export function duplicateProp(props, i, { size, offset = 1.5 } = {}) {
  const p = props[i]; if (!p) return { props, index: -1 };
  const [x, z] = size ? clampTo(size, (p.at?.[0] ?? 0) + offset, p.at?.[2] ?? 0) : [(p.at?.[0] ?? 0) + offset, p.at?.[2] ?? 0];
  return { props: [...props, { ...p, at: [r2(x), p.at?.[1] ?? 0, r2(z)] }], index: props.length };
}
export const removeProp = (props, i) => props.filter((_, j) => j !== i);
/** A new prop of a kind the world already uses, at a point. */
export const addProp = (props, name, x, z) => [...props, { prop: name, at: [r2(snap(x)), 0, r2(snap(z))], rot: 0, scale: 1 }];

/** The view's transform: world metres ↔ canvas pixels, the whole ground fitted with a margin. +X right, +Z down (the
 *  top view looks down with the far side, -Z, at the top, as the game's own camera starts). */
export function fitView(size, width, height, margin = 16) {
  const [w, d] = Array.isArray(size) ? size : [size * 2, size * 2];
  const k = Math.min((width - margin * 2) / w, (height - margin * 2) / d);
  const ox = width / 2, oz = height / 2;
  return { k, toPx: (x, z) => [ox + x * k, oz + z * k], toWorld: (px, py) => [(px - ox) / k, (py - oz) / k] };
}
