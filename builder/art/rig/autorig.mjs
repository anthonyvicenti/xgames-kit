// Auto-rig: a plain (unrigged) mesh and its archetype in, a skinned body on that archetype's standard out
// (runtimes/three/kit/character/archetypes.js, CREATURES.md). Our own code, no outside rigging service: Meshy's rigging
// puts a biped skeleton on anything, which fits only a humanoid (the looks pilot's moss-mole came back with a hand
// weighted to nothing and a face that tore in two clips).
//
//   const r = await autorig(bytes, { archetype: 'blob', id: 'moss-mole', height?, turn?, joints? });
//     → { bytes, did: [lines for the manifest's `from`], joints: {bone: [x, y, z]}, report }
//
// What it does:
//   1. every mesh into the body's frame (its node's world matrix, dequantised), the feet put on the ground at the origin
//      (the lowest point at y = 0, the middle over x = z = 0), turned by `turn` degrees about Y when the mesh does not
//      face +Z, scaled to `height` metres when one is given;
//   2. the archetype's skeleton fitted from where the vertices are (fitSkeleton: slices, clusters, extremes; `joints`
//      overrides any joint by name, in the body frame after step 1);
//   3. skin weights from each vertex's place on that skeleton (along a chain, in a limb's region; weighWorm, weighBlob,
//      ...), then spread over the mesh's own surface (a few rounds of averaging with the welded neighbours, so a weight
//      follows the skin and never jumps a gap: a cheap stand-in for bone heat), at most four bones a vertex;
//   4. one skin, joints resting unrotated in the character's axes, everything under one `gf_body` node whose extras name
//      the standard (gfRig, gfArchetype), the material, UVs and texture kept, then the body optimiser (meshopt).
import '../../tools/lib/char-node.mjs';
import { gltfCore, gltfFn, io } from '../deps.mjs';

// the kit's standards (they import 'three', which char-node resolves in Node)
const { STANDARDS, RIG_OF, canonicalParent } = await import('../../../runtimes/three/kit/character/archetypes.js');

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const smooth = x => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

// ------------------------------------------------------------------ the cloud: every vertex in the body frame
/** Read every primitive's vertices into the body frame. → { prims: [{prim, start, count, idx}], P, N, n, box } */
async function readCloud(doc, { turn = 0, height = null } = {}) {
  await doc.transform(gltfFn.dequantize());
  const prims = [], pos = [], nor = [];
  let start = 0;
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh(); if (!mesh) continue;
    const M = node.getWorldMatrix();
    const at = (v, w) => [0, 1, 2].map(r => M[r] * v[0] + M[4 + r] * v[1] + M[8 + r] * v[2] + (w ? M[12 + r] : 0));
    for (const prim of mesh.listPrimitives()) {
      const P = prim.getAttribute('POSITION'), N = prim.getAttribute('NORMAL'), I = prim.getIndices();
      const count = P.getCount();
      for (let i = 0; i < count; i++) {
        pos.push(at(P.getElement(i, []), true));
        let n = N ? at(N.getElement(i, []), false) : [0, 1, 0]; const l = Math.hypot(...n) || 1; nor.push(n.map(x => x / l));
      }
      const idx = I ? Array.from(I.getArray()) : Array.from({ length: count }, (_, i) => i);
      prims.push({ prim, start, count, idx });
      start += count;
    }
  }
  if (!pos.length) throw new Error('no mesh to rig');
  // turn about Y, then ground and centre, then scale
  const a = turn * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
  const rot = v => [v[0] * c + v[2] * s, v[1], -v[0] * s + v[2] * c];
  const pts = pos.map(rot), nrm = nor.map(rot);
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const p of pts) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], p[k]); max[k] = Math.max(max[k], p[k]); }
  const k = height ? height / (max[1] - min[1]) : 1;
  const off = [-(min[0] + max[0]) / 2, -min[1], -(min[2] + max[2]) / 2];
  const P = new Float32Array(pts.length * 3), N = new Float32Array(pts.length * 3);
  pts.forEach((p, i) => { for (let j = 0; j < 3; j++) { P[i * 3 + j] = (p[j] + off[j]) * k; N[i * 3 + j] = nrm[i][j]; } });
  const size = [0, 1, 2].map(j => (max[j] - min[j]) * k);
  return { prims, P, N, n: pts.length, size, box: { min: [-size[0] / 2, 0, -size[2] / 2], max: [size[0] / 2, size[1], size[2] / 2] }, scale: k };
}

/** Vertex neighbours over the welded surface (UV seams and split normals joined by position). */
function neighbours(cloud) {
  const { P, n, prims } = cloud;
  const key = i => `${Math.round(P[i * 3] * 1e4)},${Math.round(P[i * 3 + 1] * 1e4)},${Math.round(P[i * 3 + 2] * 1e4)}`;
  const weld = new Int32Array(n), first = new Map();
  for (let i = 0; i < n; i++) { const k = key(i); if (!first.has(k)) first.set(k, i); weld[i] = first.get(k); }
  const adj = new Map();
  const link = (a, b) => { a = weld[a]; b = weld[b]; if (a === b) return; (adj.get(a) ?? adj.set(a, new Set()).get(a)).add(b); (adj.get(b) ?? adj.set(b, new Set()).get(b)).add(a); };
  for (const p of prims) for (let t = 0; t + 2 < p.idx.length; t += 3) {
    const a = p.start + p.idx[t], b = p.start + p.idx[t + 1], c = p.start + p.idx[t + 2];
    link(a, b); link(b, c); link(c, a);
  }
  return { weld, adj };
}

const V = (P, i) => [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]];
const centroid = (P, list) => { const c = [0, 0, 0]; for (const i of list) for (let k = 0; k < 3; k++) c[k] += P[i * 3 + k]; return list.length ? c.map(x => x / list.length) : null; };
const within = (P, n, f) => { const out = []; for (let i = 0; i < n; i++) if (f(P[i * 3], P[i * 3 + 1], P[i * 3 + 2], i)) out.push(i); return out; };
const pct = (arr, q) => { if (!arr.length) return 0; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const lerp3 = (a, b, t) => a.map((x, i) => x + (b[i] - x) * t);

/** The centre of a slab across `axis` at `at` (± half), else the nearest non-empty one. */
function slabCentre(cloud, axis, at, half) {
  for (let grow = 1; grow < 8; grow *= 2) {
    const list = within(cloud.P, cloud.n, (x, y, z) => Math.abs([x, y, z][axis] - at) <= half * grow);
    if (list.length >= 3) return centroid(cloud.P, list);
  }
  const c = [0, 0, 0]; c[axis] = at; return c;
}

/** Weights along a chain: s is a vertex's place in joint units (0 at the first joint, 1 at the second, ...): each bone
 *  owns its segment, sharing half with its neighbour at each joint. → [[jointIndex, w], ...] */
function chainBlend(s, count) {
  const b = clamp(Math.floor(s), 0, count - 1), f = clamp(s - b, 0, 1.5);
  const out = [[b, 1]];
  if (b + 1 < count && f > 0.5) { const w = 0.5 * smooth((f - 0.5) / 0.5); out[0][1] -= w; out.push([b + 1, w]); }
  if (b > 0 && f < 0.5) { const w = 0.5 * smooth((0.5 - f) / 0.5); out[0][1] -= w; out.push([b - 1, w]); }
  return out;
}
/** A coordinate → its place along joints at rising coordinates `at` (piecewise linear; before the first is negative). */
function placeAlong(x, at) {
  if (x <= at[0]) return (x - at[0]) / Math.max(1e-6, (at[1] ?? at[0] + 1) - at[0]);
  for (let i = 0; i < at.length - 1; i++) if (x <= at[i + 1]) return i + (x - at[i]) / Math.max(1e-6, at[i + 1] - at[i]);
  const last = at.length - 1; return last + (x - at[last]) / Math.max(1e-6, at[last] - (at[last - 1] ?? at[last] - 1));
}

// ------------------------------------------------------------------ fitting, per archetype
export function fitBlob(cloud) {
  const { P, n, size } = cloud, h = size[1], w = size[0];
  const J = {};
  const mid = centroid(P, within(P, n, (x, y) => y > 0.15 * h && y < 0.45 * h)) ?? [0, 0, 0];
  J.Root = [0, 0, 0];
  J.Body = [mid[0], 0, mid[2]];
  const up = centroid(P, within(P, n, (x, y) => y > 0.5 * h && y < 0.7 * h)) ?? [0, 0.55 * h, 0];
  J.Top = [up[0], 0.55 * h, up[2]];
  const regions = {};
  // feet: two clusters touching the ground, apart in x (a body that sits on its own bottom has none); the lowest band
  // in which they show apart decides (a foot is a few centimetres tall)
  for (const band of [0.03, 0.05, 0.07]) {
    const low = within(P, n, (x, y) => y < band * h);
    const middle = low.filter(i => Math.abs(P[i * 3]) < 0.07 * w).length;
    const L = low.filter(i => P[i * 3] > 0.03 * w), R = low.filter(i => P[i * 3] < -0.03 * w);
    if (!(low.length > 8 && L.length > 3 && R.length > 3 && middle < 0.12 * low.length)) continue;
    for (const [side, list] of [['Left', L], ['Right', R]]) {
      const c = centroid(P, list);
      const r = pct(list.map(i => Math.hypot(P[i * 3] - c[0], P[i * 3 + 2] - c[2])), 0.9);
      J[`${side}Foot`] = [c[0], Math.max(0.02 * h, c[1]), c[2]];
      regions[`${side}Foot`] = { at: J[`${side}Foot`], r: Math.max(0.05 * w, r * 1.5), top: Math.max(0.12 * h, band * h * 3) };
    }
    break;
  }
  // hand nubs: a bump on the side, wider than the slices above and below it
  for (const [side, sg] of [['Left', 1], ['Right', -1]]) {
    const prof = [];
    for (let y = 0.12 * h; y <= 0.66 * h; y += 0.03 * h) {
      const sl = within(P, n, (x, yy) => Math.abs(yy - y) < 0.025 * h && x * sg > 0);
      prof.push({ y, x: sl.length ? Math.max(...sl.map(i => P[i * 3] * sg)) : null, at: sl });
    }
    // a nub is a sharp local bump: wider than the line between the slices either side of it (a round side is not)
    let best = null;
    for (let i = 3; i < prof.length - 3; i++) {
      if (prof.slice(i - 3, i + 4).some(q => q.x === null)) continue;     // a sparse mesh's empty slice is not a dip
      const bump = prof[i].x - (prof[i - 3].x + prof[i + 3].x) / 2;
      const peak = prof[i].x >= prof[i - 1].x && prof[i].x >= prof[i + 1].x;
      if (peak && bump > 0.03 * w && (!best || bump > best.bump)) best = { ...prof[i], bump };
    }
    if (best) {
      const tip = best.at.reduce((a, i) => (P[i * 3] * sg > P[a * 3] * sg ? i : a), best.at[0]);
      const t = V(P, tip);
      const r = Math.max(0.06 * w, best.bump * 1.6);
      // a hand is a small part of the body: a "bump" holding a big share of it is the body's own shape
      if (within(P, n, (x, y, z) => Math.hypot(x - t[0], y - t[1], z - t[2]) < r).length > 0.06 * n) continue;
      J[`${side}Hand`] = [t[0] - sg * r * 0.45, t[1], t[2]];
      regions[`${side}Hand`] = { at: t, r, side: sg, inner: Math.abs(t[0]) - r };
    }
  }
  // a nub found on one side only: the mesh is near enough mirror-shaped when a vertex sits near the mirrored tip
  for (const [a, b, sg] of [['LeftHand', 'RightHand', -1], ['RightHand', 'LeftHand', 1]]) {
    if (!regions[a] || regions[b]) continue;
    const R = regions[a], m = [-R.at[0], R.at[1], R.at[2]];
    if (within(P, n, (x, y, z) => Math.hypot(x - m[0], y - m[1], z - m[2]) < 0.35 * R.r).length) {
      J[b] = [-J[a][0], J[a][1], J[a][2]];
      regions[b] = { at: m, r: R.r, side: sg, inner: R.inner };
    }
  }
  return { joints: J, regions };
}

export function weighBlob(cloud, fit) {
  const { P, n, size } = cloud, h = size[1];
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const p = V(P, i), list = [];
    let rest = 1;
    for (const f of ['LeftFoot', 'RightFoot']) {
      const R = fit.regions[f]; if (!R) continue;
      const d = Math.hypot(p[0] - R.at[0], p[2] - R.at[2]);
      const w = (1 - smooth((p[1] - 0.55 * R.top) / (0.45 * R.top))) * (1 - smooth((d - 0.75 * R.r) / (0.5 * R.r)));
      if (w > 0.01) { list.push([f, w * rest]); rest *= 1 - w; }
    }
    for (const hnd of ['LeftHand', 'RightHand']) {
      const R = fit.regions[hnd]; if (!R) continue;
      if (p[0] * R.side < R.inner) continue;
      const w = 1 - smooth((dist(p, R.at) - 0.55 * R.r) / (0.6 * R.r));
      if (w > 0.01) { list.push([hnd, w * rest]); rest *= 1 - w; }
    }
    const top = smooth((p[1] - 0.22 * h) / (0.5 * h));
    list.push(['Body', rest * (1 - top)], ['Top', rest * top]);
    out[i] = list;
  }
  return out;
}

export function fitWorm(cloud, { segments = null } = {}) {
  const { size } = cloud, [w, h, d] = size;
  const upright = h > 1.2 * Math.max(w, d);
  const axis = upright ? 1 : 2, len = upright ? h : d, lo = upright ? 0 : -d / 2;
  const thick = upright ? Math.max(w, d) : Math.max(w, h);
  const N = segments ?? clamp(Math.round(len / Math.max(1e-3, thick) * 1.4), 4, 10);
  const headAt = lo + len * 0.8, first = lo + len * 0.03;
  const J = { Root: [0, 0, 0] }, at = [];
  for (let i = 0; i < N; i++) {
    const c = first + (headAt - first) * (i / N);
    const sc = slabCentre(cloud, axis, c, len / N / 2);
    J[`Seg${i}`] = upright ? [sc[0], c, sc[2]] : [sc[0], sc[1], c];
    at.push(c);
  }
  const hc = slabCentre(cloud, axis, headAt, len * 0.05);
  J.Head = upright ? [hc[0], headAt, hc[2]] : [hc[0], hc[1], headAt];
  at.push(headAt);
  return { joints: J, regions: { axis, at, chain: [...Array(N).keys()].map(i => `Seg${i}`).concat('Head') }, upright };
}

export function weighWorm(cloud, fit) {
  const { P, n } = cloud, { axis, at, chain } = fit.regions;
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const s = placeAlong(P[i * 3 + axis], at);
    out[i] = s >= chain.length - 1 ? [[chain.at(-1), 1]].concat(s < chain.length - 0.5 ? [] : []) : chainBlend(Math.max(0, s), chain.length).map(([j, w]) => [chain[j], w]);
  }
  return out;
}

export function fitQuadruped(cloud) {
  const { P, n, size } = cloud, [w, h, d] = size;
  // the belly: the lowest point of a narrow strip down the middle of the body (legs stand to the sides)
  const core = within(P, n, (x, y, z) => Math.abs(x) < 0.08 * w && Math.abs(z) < 0.15 * d);
  const yb = core.length ? Math.min(...core.map(i => P[i * 3 + 1])) : 0.45 * h;
  if (yb < 0.08 * h) throw new Error('no belly above the ground under the middle of the body (a quadruped stands on four legs apart)');
  const legs = within(P, n, (x, y) => y < yb * 0.95);
  if (legs.length < 12) throw new Error('no legs under the body (a quadruped stands on four)');
  const zs = legs.map(i => P[i * 3 + 2]).sort((a, b) => a - b);
  // front and back: split at the widest gap in the middle half of the legs' z
  let split = (zs[0] + zs.at(-1)) / 2, gap = -1;
  for (let k = Math.floor(zs.length * 0.25); k < Math.floor(zs.length * 0.75); k++) if (zs[k + 1] - zs[k] > gap) { gap = zs[k + 1] - zs[k]; split = (zs[k] + zs[k + 1]) / 2; }
  const J = { Root: [0, 0, 0] }, regions = { legs: {} };
  const top = Math.max(...within(P, n, (x, y, z) => Math.abs(x) < 0.2 * w).map(i => P[i * 3 + 1]), yb + 0.1 * h);
  const hipY = yb + 0.3 * (top - yb);
  for (const fb of ['Front', 'Back']) for (const [s, sg] of [['Left', 1], ['Right', -1]]) {
    const q = legs.filter(i => (fb === 'Front' ? P[i * 3 + 2] > split : P[i * 3 + 2] <= split) && P[i * 3] * sg > 0);
    const c = centroid(P, q.length ? q : legs) ?? [sg * 0.25 * w, 0, 0];
    const k = fb + s;
    // the leg's top joint at the belly line (a toy's leg turns where it meets the body), the knee half way down
    J[k + 'UpLeg'] = [c[0], yb + 0.03 * h, c[2]];
    J[k + 'Leg'] = [c[0], yb * 0.5, c[2]];
    J[k + 'Foot'] = [c[0], Math.min(0.25 * yb, 0.06 * h), c[2]];
    regions.legs[k] = { x: c[0], z: c[2], r: Math.max(0.06 * w, pct(q.map(i => Math.hypot(P[i * 3] - c[0], P[i * 3 + 2] - c[2])), 0.95) * 1.25) };
  }
  const zBack = (J.BackLeftUpLeg[2] + J.BackRightUpLeg[2]) / 2, zFront = (J.FrontLeftUpLeg[2] + J.FrontRightUpLeg[2]) / 2;
  J.Hips = [0, hipY, zBack]; J.Chest = [0, hipY, zFront]; J.Spine = [0, hipY, (zBack + zFront) / 2];
  // the head: the front-most mass above the belly
  const zmax = d / 2;
  const headPts = within(P, n, (x, y, z) => y > yb && z > zmax - 0.3 * Math.max(0.05, zmax - zFront));
  const hc = centroid(P, headPts) ?? [0, hipY, zmax * 0.8];
  J.Head = [0, hc[1], Math.max(zFront + 0.02 * d, zmax - 0.55 * Math.max(0.05, zmax - zFront) * 0.6)];
  J.Neck = [0, (hipY + J.Head[1]) / 2, (zFront + J.Head[2]) / 2];
  // a tail: behind the hips, where the body's cross-section narrows to under 40% of its width (the rump is body)
  const widthAt = zz => { const sl = within(P, n, (x, y, z) => y > yb * 0.7 && Math.abs(z - zz) < 0.02 * d); return sl.length ? Math.max(...sl.map(i => Math.abs(P[i * 3]))) : 0; };
  const wB = widthAt(zBack), zmin = -d / 2;
  let tailStart = null;
  for (let zz = zBack; zz > zmin + 0.02 * d; zz -= 0.02 * d) { const wz = widthAt(zz); if (wz > 0 && wz < 0.4 * wB) { tailStart = zz; break; } }
  const tail = tailStart === null ? [] : within(P, n, (x, y, z) => y > yb * 0.7 && z < tailStart);
  if (tail.length > 20) {
    const tz = tail.map(i => P[i * 3 + 2]), tmin = Math.min(...tz), tmax = Math.min(tailStart + 0.03 * d, zBack);
    for (let k = 0; k < 3; k++) { const zz = tmax - (tmax - tmin) * (k / 3); const c = slabCentre({ P, n }, 2, zz, (tmax - tmin) / 6); J[`Tail${k}`] = [c[0], c[1], zz]; }
  }
  return { joints: J, regions: { ...regions, yb, split, zBack, zFront, tailStart } };
}

export function weighQuadruped(cloud, fit) {
  const { P, n } = cloud, J = fit.joints, R = fit.regions;
  // a chain's segment belongs to the joint nearer the root: the spine forward from the hips, the tail back from them,
  // a leg down from the hip
  const spine = ['Hips', 'Spine', 'Chest', 'Neck', 'Head'].filter(b => J[b]);
  const spineAt = spine.map(b => J[b][2]);
  const tail = ['Tail0', 'Tail1', 'Tail2'].filter(b => J[b]);
  const tailAt = tail.map(b => -J[b][2]);
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const p = V(P, i);
    // below the belly every point is a leg's (the nearest); near the belly only within a leg's own reach
    let leg = null, best = Infinity;
    for (const [k, L] of Object.entries(R.legs)) { const dd = Math.hypot(p[0] - L.x, p[2] - L.z); if ((dd < L.r || p[1] < R.yb * 0.9) && dd < best) { best = dd; leg = k; } }
    let body = chainBlend(Math.max(0, placeAlong(p[2], spineAt)), spine.length).map(([j, w]) => [spine[j], w]);
    if (tail.length && p[2] < J.Tail0[2] + 0.5 * (J.Hips[2] - J.Tail0[2])) {
      // the tail chain from its root back, blending into the hips at its root
      const st = placeAlong(-p[2], [-J.Hips[2], ...tailAt]);
      body = chainBlend(Math.max(0, st), tail.length + 1).map(([j, w]) => [j === 0 ? 'Hips' : tail[j - 1], w]);
    }
    if (leg && p[1] < R.yb * 1.15) {
      const L = [leg + 'UpLeg', leg + 'Leg', leg + 'Foot'];
      const s = placeAlong(-p[1], L.map(b => -J[b][1]));
      const legW = 1 - smooth((p[1] - R.yb * 0.95) / (R.yb * 0.2));
      const lw = chainBlend(clamp(s, 0, 2.4), 3).map(([j, w]) => [L[j], w * legW]);
      out[i] = lw.concat(body.map(([b, w]) => [b, w * (1 - legW)]));
    } else out[i] = body;
  }
  return out;
}

export function fitFlyer(cloud) {
  const { P, n, size } = cloud, [w, h, d] = size;
  // the body's edge in x: where the mesh, seen across, turns thin (a wing is a sheet; the body is deep)
  const bins = 40, half = w / 2, lo = new Array(bins).fill(Infinity), hi = new Array(bins).fill(-Infinity);
  for (let i = 0; i < n; i++) { const b = Math.min(bins - 1, Math.floor(Math.abs(P[i * 3]) / Math.max(1e-6, half) * bins)); lo[b] = Math.min(lo[b], P[i * 3 + 1]); hi[b] = Math.max(hi[b], P[i * 3 + 1]); }
  const deep = b => (hi[b] > lo[b] ? hi[b] - lo[b] : 0);
  const centre = Math.max(deep(0), deep(1));
  let edge = bins * 0.3;
  for (let b = 2; b < bins; b++) if (deep(b) > 0 && deep(b) < 0.4 * centre) { edge = b; break; }
  const xb = Math.max(0.08 * w, edge / bins * half);
  const body = within(P, n, x => Math.abs(x) < xb);
  const bc = centroid(P, body) ?? [0, 0.5 * h, 0];
  const J = { Root: [0, 0, 0], Body: [0, bc[1], bc[2]] };
  const bz = body.map(i => P[i * 3 + 2]), zmin = Math.min(...bz), zmax = Math.max(...bz);
  const headPts = body.filter(i => P[i * 3 + 2] > zmax - 0.3 * (zmax - zmin) && P[i * 3 + 1] > bc[1] - 0.1 * h);
  const hc = centroid(P, headPts) ?? [0, bc[1], zmax * 0.7];
  J.Head = [0, hc[1], zmax - 0.6 * 0.3 * (zmax - zmin)];
  J.Neck = lerp3(J.Body, J.Head, 0.55);
  const wingPts = within(P, n, x => Math.abs(x) >= xb);
  const span = wingPts.length ? Math.max(...wingPts.map(i => Math.abs(P[i * 3]))) : half;
  for (const [s, sg] of [['Left', 1], ['Right', -1]]) {
    const side = wingPts.filter(i => P[i * 3] * sg > 0);
    for (const [k, t] of [[1, 0], [2, 0.45], [3, 0.8]]) {
      const x = xb + (span - xb) * t;
      const sl = side.filter(i => Math.abs(Math.abs(P[i * 3]) - x) < (span - xb) * 0.12);
      const c = centroid(P, sl.length ? sl : side) ?? [sg * x, bc[1], bc[2]];
      J[`${s}Wing${k}`] = [sg * x, c[1], c[2]];
    }
  }
  // the wing's chord and thickness at its root: a wing weight goes only to points near the wing's own sheet (a head or
  // a beak as wide as the body's edge is not a wing)
  const rootPts = wingPts.filter(i => Math.abs(P[i * 3]) < xb + 0.25 * (span - xb));
  const wz = J.LeftWing1[2], wy = J.LeftWing1[1];
  const chord = Math.max(0.05 * d, pct(rootPts.map(i => Math.abs(P[i * 3 + 2] - wz)), 0.95) * 1.2);
  const thick = Math.max(0.05 * h, pct(rootPts.map(i => Math.abs(P[i * 3 + 1] - wy)), 0.95) * 1.5);
  const tailPts = body.filter(i => P[i * 3 + 2] < zmin + 0.18 * (zmax - zmin));
  if (tailPts.length > 20) { const c = centroid(P, tailPts); J.Tail = [0, c[1], zmin + 0.2 * (zmax - zmin)]; }
  // legs: two clusters under the body, near the ground
  const low = body.filter(i => P[i * 3 + 1] < 0.25 * h);
  const L = low.filter(i => P[i * 3] > 0.01 * w), R = low.filter(i => P[i * 3] < -0.01 * w);
  if (bc[1] > 0.3 * h && L.length > 4 && R.length > 4) {
    for (const [s, list] of [['Left', L], ['Right', R]]) {
      const c = centroid(P, list);
      J[`${s}Leg`] = [c[0], 0.3 * h, c[2]]; J[`${s}Foot`] = [c[0], 0.04 * h, c[2]];
    }
  }
  return { joints: J, regions: { xb, span, zmin, zmax, wz, wy, chord, thick } };
}

export function weighFlyer(cloud, fit) {
  const { P, n, size } = cloud, J = fit.joints, R = fit.regions, h = size[1];
  const chain = ['Tail', 'Body', 'Neck', 'Head'].filter(b => J[b]);
  const at = chain.map(b => J[b][2]);
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const p = V(P, i), ax = Math.abs(p[0]), s = p[0] >= 0 ? 'Left' : 'Right';
    const body = chainBlend(Math.max(0, placeAlong(p[2], at)), chain.length).map(([j, w]) => [chain[j], w]);
    const near = (1 - smooth((Math.abs(p[2] - R.wz) - R.chord) / (0.3 * R.chord))) * (1 - smooth((Math.abs(p[1] - R.wy) - R.thick) / (0.5 * R.thick)));
    const wingW = smooth((ax - R.xb * 0.7) / (R.xb * 0.6)) * (ax > R.xb + 0.35 * (R.span - R.xb) ? 1 : near);
    let list = body.map(([b, w]) => [b, w * (1 - wingW)]);
    if (wingW > 0) {
      const W = [`${s}Wing1`, `${s}Wing2`, `${s}Wing3`].filter(b => J[b]);
      const sw = placeAlong(ax, W.map(b => Math.abs(J[b][0])));
      list = list.concat(chainBlend(Math.max(0, sw), W.length).map(([j, w]) => [W[j], w * wingW]));
    }
    if (J[`${s}Leg`] && p[1] < 0.3 * h && ax < R.xb) {
      const lw = 1 - smooth((p[1] - 0.22 * h) / (0.1 * h));
      const leg = p[1] < 0.12 * h ? `${s}Foot` : `${s}Leg`;
      list = list.map(([b, w]) => [b, w * (1 - lw)]).concat([[leg, lw]]);
    }
    out[i] = list;
  }
  return out;
}

const FIT = { blob: fitBlob, worm: fitWorm, quadruped: fitQuadruped, flyer: fitFlyer };
const WEIGH = { blob: weighBlob, worm: weighWorm, quadruped: weighQuadruped, flyer: weighFlyer };

/**
 * Spread weights over the surface: `rounds` of mixing each welded vertex with its neighbours, each neighbour counted by
 * how near it is (within about `reach` metres; a long edge of a coarse mesh barely mixes), so a weight travels a set
 * distance over the skin whatever the mesh's density.
 */
function spread(weights, nb, P, { rounds = 4, keep = 0.5, reach = 0.03 } = {}) {
  const { weld, adj } = nb;
  const toMap = l => { const m = new Map(); for (const [b, w] of l) if (w > 0) m.set(b, (m.get(b) ?? 0) + w); return m; };
  const near = (i, j) => { const d = Math.hypot(P[i * 3] - P[j * 3], P[i * 3 + 1] - P[j * 3 + 1], P[i * 3 + 2] - P[j * 3 + 2]); return Math.exp(-((d / reach) ** 2)); };
  let cur = new Map();
  for (let i = 0; i < weights.length; i++) if (weld[i] === i) cur.set(i, toMap(weights[i]));
  for (let r = 0; r < rounds; r++) {
    const next = new Map();
    for (const [i, m] of cur) {
      const ns = adj.get(i); if (!ns || !ns.size) { next.set(i, m); continue; }
      const f = [...ns].map(j => [j, near(i, j)]), sum = f.reduce((a, [, x]) => a + x, 0);
      if (sum < 1e-6) { next.set(i, m); continue; }
      const take = (1 - keep) * sum / ns.size;
      const mix = new Map();
      for (const [b, w] of m) mix.set(b, w * (1 - take));
      for (const [j, x] of f) for (const [b, w] of cur.get(j) ?? []) mix.set(b, (mix.get(b) ?? 0) + w * take * x / sum);
      next.set(i, mix);
    }
    cur = next;
  }
  return weights.map((_, i) => [...(cur.get(weld[i]) ?? toMap(weights[i])).entries()]);
}

/** At most four bones a vertex, small ones dropped, summing to 1. */
function topFour(list) {
  const l = list.filter(([, w]) => w > 0.004).sort((a, b) => b[1] - a[1]).slice(0, 4);
  const s = l.reduce((a, [, w]) => a + w, 0) || 1;
  return l.map(([b, w]) => [b, w / s]);
}

/** Fit an archetype's skeleton to a cloud (exported for tests and the stand-in maker). */
export function fitSkeleton(archetype, cloud, { joints = null, segments = null } = {}) {
  const fit = FIT[archetype](cloud, { segments });
  if (joints) for (const [k, v] of Object.entries(joints)) fit.joints[k] = v;
  return fit;
}

/**
 * A plain mesh (GLB bytes) → a skinned body on the archetype's standard.
 * opts: { archetype, id, height (metres), turn (degrees about Y), joints ({bone: [x, y, z]} overrides), segments (worm),
 *         tint (material names a seat colour tints), tintMix, optimize (true) }
 */
export async function autorig(bytes, { archetype, id = 'creature', height = null, turn = 0, joints = null, segments = null, tint = null, tintMix = null, optimize = true } = {}) {
  const std = STANDARDS[archetype];
  if (!std) throw new Error(`autorig: no standard for archetype "${archetype}" (one of ${Object.keys(STANDARDS).join(', ')})`);
  const IO = await io();
  const doc = await IO.readBinary(new Uint8Array(bytes));
  doc.setLogger(new gltfCore.Logger(gltfCore.Logger.Verbosity.SILENT));
  for (const s of doc.getRoot().listSkins()) s.dispose();
  for (const a of doc.getRoot().listAnimations()) a.dispose();
  const cloud = await readCloud(doc, { turn, height });
  const fit = fitSkeleton(archetype, cloud, { joints, segments });
  const J = fit.joints;
  // the bones the fit placed, in the standard's order, each under its nearest placed canonical parent
  const has = b => !!J[b];
  const bones = std.names.filter(has);
  for (const r of std.required) if (!has(r)) throw new Error(`autorig: the ${archetype} fit found no place for ${r}`);
  const parentOf = b => canonicalParent(std, b, has);

  const nb = neighbours(cloud);
  const raw = WEIGH[archetype](cloud, fit);
  const weights = spread(raw, nb, cloud.P, { rounds: archetype === 'worm' ? 3 : 4, reach: 0.025 * Math.max(...cloud.size) }).map(topFour);

  // the new tree: gf_body → skeleton (identity frames, joints at the fitted places) and the meshes, all at identity
  const root = doc.getRoot();
  const buf = root.listBuffers()[0] ?? doc.createBuffer();
  for (const s of root.listScenes()) s.dispose();
  for (const nd of root.listNodes()) nd.dispose();
  const body = doc.createNode('gf_body').setExtras({ gfRig: std.rig, gfArchetype: archetype, gfBody: id, gfGenerator: 'builder/art/rig/autorig.mjs',
    ...(tint?.length ? { gfTint: tint } : {}), ...(tintMix != null ? { gfTintMix: tintMix } : tint?.length ? {} : { gfTintMix: 0 }) });
  const nodes = new Map();
  for (const b of bones) {
    const p = parentOf(b), q = p ? J[p] : [0, 0, 0];
    const node = doc.createNode(b).setTranslation(J[b].map((x, i) => x - q[i]));
    nodes.set(b, node);
    (p ? nodes.get(p) : body).addChild(node);
  }
  const ibm = doc.createAccessor('ibm').setType('MAT4').setBuffer(buf).setArray(new Float32Array(bones.flatMap(b => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -J[b][0], -J[b][1], -J[b][2], 1])));
  const skin = doc.createSkin('gf_skin').setInverseBindMatrices(ibm).setSkeleton(nodes.get('Root'));
  for (const b of bones) skin.addJoint(nodes.get(b));
  const jIndex = new Map(bones.map((b, i) => [b, i]));

  const meshes = new Map();
  for (const pr of cloud.prims) {
    const { prim, start, count } = pr;
    const POS = cloud.P.subarray(start * 3, (start + count) * 3), NOR = cloud.N.subarray(start * 3, (start + count) * 3);
    const JN = new Uint8Array(count * 4), WT = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      const l = weights[start + i].length ? weights[start + i] : [[bones.includes('Body') ? 'Body' : bones[1], 1]];
      l.forEach(([b, w], k) => { JN[i * 4 + k] = jIndex.get(b) ?? 0; WT[i * 4 + k] = w; });
    }
    const acc = (type, arr) => doc.createAccessor().setType(type).setBuffer(buf).setArray(arr);
    prim.setAttribute('POSITION', acc('VEC3', new Float32Array(POS))).setAttribute('NORMAL', acc('VEC3', new Float32Array(NOR)))
      .setAttribute('JOINTS_0', acc('VEC4', JN)).setAttribute('WEIGHTS_0', acc('VEC4', WT));
    for (const sem of prim.listSemantics()) if (/^(TANGENT|JOINTS_1|WEIGHTS_1)$/.test(sem)) prim.setAttribute(sem, null);
    const mesh = prim.listParents().find(p => p.propertyType === 'Mesh');
    meshes.set(mesh, true);
  }
  for (const mesh of meshes.keys()) body.addChild(doc.createNode(mesh.getName() || id).setMesh(mesh).setSkin(skin));
  doc.createScene(id).addChild(body);
  root.setDefaultScene(root.listScenes()[0]);
  await doc.transform(gltfFn.prune({ keepLeaves: true }));
  const did = [`rigged on ${std.rig} by builder/art/rig/autorig.mjs (${bones.length} bones: ${bones.filter(b => !std.required.includes(b)).length ? `the required ones and ${bones.filter(b => !std.required.includes(b)).join(', ')}` : 'the required ones'}; weights from the skeleton, spread over the skin)`];
  if (turn) did.push(`turned ${turn}° to face +Z`);
  if (height) did.push(`scaled to ${height} m`);
  if (optimize) {
    const { optimizeDoc } = await import('../../tools/lib/char-optimize.mjs');
    did.push(...await optimizeDoc(doc));
  }
  const out = Buffer.from(await IO.writeBinary(doc));
  const weighted = {};
  for (const l of weights) for (const [b, w] of l) weighted[b] = (weighted[b] ?? 0) + w;
  return { bytes: out, did, joints: Object.fromEntries(bones.map(b => [b, J[b].map(x => +x.toFixed(4))])), report: { archetype, rig: std.rig, size: cloud.size.map(x => +x.toFixed(3)), vertices: cloud.n, bones, weighted: Object.fromEntries(Object.entries(weighted).map(([k, v]) => [k, Math.round(v)])), upright: fit.upright ?? null } };
}

export { RIG_OF };
