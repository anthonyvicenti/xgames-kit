// Kenney's Blocky Characters onto gf-humanoid-1 (runtimes/three/kit/character/RIG.md), as ingest's `--retarget
// kenney-blocky` step. Each Kenney character is six rigid boxes on a node tree (two legs, a torso, two arms hanging at
// the sides, a cube head), 2.7 units tall, with clips of its own. This makes it a skinned body on the standard:
//   - every box is taken into character space (its node's world matrix);
//   - the arms are turned up into the T-pose about the top of the arm (the clips' rest), so the swing at load is nil;
//   - the limbs are cut across at the elbow, the wrist, the knee and the ankle (and the torso along the spine), each
//     cut a narrow band whose two edges ride the two bones: a toy's joints, the box bending only inside the band;
//   - the skeleton is the standard's bones at the boxes' joints, identity frames, one skin, the whole scaled to metres
//     (SCALE: 2.7 units → 1.62 m), the clips of its own dropped (the kit's shared clips play on it), unlit made lit.
// The texture, its UVs and the look stay Kenney's own. No tint: the texture is the character's identity (RIG.md §8).
import { gltfCore, io } from '../deps.mjs';

export const SCALE = 0.6;          // Kenney units → metres
const BAND = 0.03;                 // half the width of a joint's bend band, in Kenney units

/** The joints, in Kenney units, the character facing +z with its own left on +x (left side; the right mirrors x). */
export const JOINTS = {
  Hips: [0, 1.0, 0], Spine02: [0, 1.2, 0], Spine01: [0, 1.4, 0], Spine: [0, 1.6, 0], neck: [0, 1.88, 0], Head: [0, 1.9, 0], head_end: [0, 2.7, 0],
  LeftShoulder: [0.2, 1.7, -0.1], LeftArm: [0.6, 1.7, -0.1], LeftForeArm: [0.95, 1.7, -0.1], LeftHand: [1.27, 1.7, -0.1],
  LeftUpLeg: [0.2, 0.95, 0], LeftLeg: [0.2, 0.5, 0], LeftFoot: [0.2, 0.16, 0], LeftToeBase: [0.2, 0.05, 0.16],
};
for (const [k, v] of Object.entries(JOINTS)) if (k.startsWith('Left')) JOINTS[`Right${k.slice(4)}`] = [-v[0], v[1], v[2]];
const PARENT = {
  Hips: null, Spine02: 'Hips', Spine01: 'Spine02', Spine: 'Spine01', neck: 'Spine', Head: 'neck', head_end: 'Head',
  ...Object.fromEntries(['Left', 'Right'].flatMap(s => [[`${s}Shoulder`, 'Spine'], [`${s}Arm`, `${s}Shoulder`], [`${s}ForeArm`, `${s}Arm`], [`${s}Hand`, `${s}ForeArm`],
    [`${s}UpLeg`, 'Hips'], [`${s}Leg`, `${s}UpLeg`], [`${s}Foot`, `${s}Leg`], [`${s}ToeBase`, `${s}Foot`]])),
};
export const BONES = Object.keys(PARENT);

// ---- triangles: { p: [x,y,z]×3, n: [x,y,z]×3, uv: [u,v]×3 } ------------------------------------------------------
const lerp = (a, b, t) => a.map((x, i) => x + (b[i] - x) * t);
/** Cut triangles by the plane coord[axis] = at: every triangle that crosses it becomes pieces on either side. */
export function cut(tris, axis, at) {
  const out = [];
  for (const t of tris) {
    const d = t.p.map(p => p[axis] - at);
    if (d.every(x => x >= -1e-9) || d.every(x => x <= 1e-9)) { out.push(t); continue; }
    // walk the polygon, splitting edges that cross; then fan each side's polygon into triangles
    const sides = [[], []];
    for (let i = 0; i < 3; i++) {
      const j = (i + 1) % 3, vi = { p: t.p[i], n: t.n[i], uv: t.uv[i] };
      if (d[i] >= 0) sides[0].push(vi); if (d[i] <= 0) sides[1].push(vi);
      if ((d[i] > 0 && d[j] < 0) || (d[i] < 0 && d[j] > 0)) {
        const s = d[i] / (d[i] - d[j]);
        const v = { p: lerp(t.p[i], t.p[j], s), n: lerp(t.n[i], t.n[j], s), uv: lerp(t.uv[i], t.uv[j], s) };
        sides[0].push(v); sides[1].push(v);
      }
    }
    for (const poly of sides) for (let k = 1; k + 1 < poly.length; k++) {
      const q = [poly[0], poly[k], poly[k + 1]];
      out.push({ p: q.map(v => v.p), n: q.map(v => v.n), uv: q.map(v => v.uv) });
    }
  }
  return out;
}
const cuts = (tris, axis, list) => list.reduce((acc, at) => cut(acc, axis, at), tris);

/** Weights along a chain of [bone, coordinate] (coordinates rising): rigid between bands, linear inside each band. */
export function chainWeights(chain, x) {
  for (let i = 0; i < chain.length - 1; i++) {
    const [a, xa] = chain[i], [b, xb] = chain[i + 1], mid = (xa + xb) / 2;
    void mid;
    if (x <= xb - BAND) return [[a, 1]];
    if (x < xb + BAND) { const t = (x - (xb - BAND)) / (2 * BAND); return t <= 0 ? [[a, 1]] : t >= 1 ? [[b, 1]] : [[a, 1 - t], [b, t]]; }
  }
  return [[chain.at(-1)[0], 1]];
}

/** A limb's segments along its axis (in the part's own "along" coordinate: x out from the body for an arm, −y down a
 *  leg): [bone, from, to], the first starting at the limb's root end, the last running to its tip. */
function segmentsOf(part) {
  const s = /left/.test(part) ? 'Left' : 'Right';
  if (part.startsWith('arm')) return [[`${s}Arm`, -Infinity, JOINTS.LeftForeArm[0]], [`${s}ForeArm`, JOINTS.LeftForeArm[0], JOINTS.LeftHand[0]], [`${s}Hand`, JOINTS.LeftHand[0], Infinity]];
  if (part.startsWith('leg')) return [[`${s}UpLeg`, -Infinity, -JOINTS.LeftLeg[1]], [`${s}Leg`, -JOINTS.LeftLeg[1], -JOINTS.LeftFoot[1]], [`${s}Foot`, -JOINTS.LeftFoot[1], Infinity]];
  return null;
}
export const OVERLAP = 0.08;       // how far a limb segment runs on past its joint, inside its neighbour (Kenney units)
export const SLIM = 0.96;          // a segment after the first is this much thinner, so the one before covers the overlap

/**
 * A limb as rigid toy segments: each segment is the limb's own boxes between its joints, run on OVERLAP past each
 * joint (the next segment SLIM-mer, so the overlap hides inside the one before when straight and no face fights
 * another), with a cap where it was cut, so a bent elbow or knee shows a closed block, never the inside of a box.
 * Rigid on one bone each: nothing stretches or folds. → [{ ..triangle, bone }]
 */
function limbSegments(part, tris) {
  const segs = segmentsOf(part);
  const sx = part.includes('left') ? 1 : -1;
  const arm = part.startsWith('arm');
  const along = p => (arm ? p[0] * sx : -p[1]);
  const axis = arm ? 0 : 1, sign = arm ? sx : -1;                         // along = coord[axis] * sign
  const across = arm ? [1, 2] : [0, 2];
  const lo = [0, 1].map(k => Math.min(...tris.flatMap(t => t.p.map(p => p[across[k]])))), hi = [0, 1].map(k => Math.max(...tris.flatMap(t => t.p.map(p => p[across[k]]))));
  const mid = [0, 1].map(k => (lo[k] + hi[k]) / 2);
  const out = [];
  segs.forEach(([bone, a, b], i) => {
    const from = a === -Infinity ? -Infinity : a - (i > 0 ? OVERLAP : 0), to = b === Infinity ? Infinity : b + OVERLAP;
    let list = tris;
    for (const at of [from, to]) if (Number.isFinite(at)) list = cut(list, axis, at * sign);
    list = list.filter(t => { const c = t.p.reduce((s, p) => s + along(p), 0) / 3; return c >= from - 1e-9 && c <= to + 1e-9; });
    const k = i > 0 ? SLIM : 1;
    const slim = p => { const q = [...p]; across.forEach((ax, j) => { q[ax] = mid[j] + (p[ax] - mid[j]) * k; }); return q; };
    for (const t of list) out.push({ ...t, p: t.p.map(slim), bone });
    // caps where the segment was cut (the limb's own ends keep Kenney's faces)
    for (const at of [from, to]) {
      if (!Number.isFinite(at)) continue;
      const edge = list.flatMap(t => t.p.map((p, j) => [p, t.uv[j]])).filter(([p]) => Math.abs(along(p) - at) < 1e-6);
      if (!edge.length) continue;
      const uv = [0, 1].map(j => edge.reduce((s, [, u]) => s + u[j], 0) / edge.length);
      const l = [0, 1].map(j => mid[j] + (lo[j] - mid[j]) * k), h = [0, 1].map(j => mid[j] + (hi[j] - mid[j]) * k);
      const corner = (u, v) => { const p = [0, 0, 0]; p[axis] = at * sign; p[across[0]] = u; p[across[1]] = v; return p; };
      const q = [corner(l[0], l[1]), corner(h[0], l[1]), corner(h[0], h[1]), corner(l[0], h[1])];
      const outward = at === to ? 1 : -1, n = [0, 0, 0]; n[axis] = outward * sign;
      // wind the quad so its face points along n
      const e1 = q[1].map((x, j) => x - q[0][j]), e2 = q[2].map((x, j) => x - q[0][j]);
      const cr = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
      const quad = cr[axis] * n[axis] > 0 ? q : [q[0], q[3], q[2], q[1]];
      for (const tri of [[quad[0], quad[1], quad[2]], [quad[0], quad[2], quad[3]]]) out.push({ part, p: tri, n: [n, n, n], uv: [uv, uv, uv], bone });
    }
  });
  return out;
}

/** Which bones a vertex of the torso or head rides: the torso bends a little along the spine, the head is rigid. */
function weigh(part, p) {
  if (part === 'torso') return chainWeights([['Hips', -Infinity], ['Spine02', JOINTS.Spine02[1]], ['Spine01', JOINTS.Spine01[1]], ['Spine', JOINTS.Spine[1]]], p[1]);
  return [['Head', 1]];
}

/** The parts' triangles in character space (arms turned up into the T-pose): limbs as rigid segments, the torso cut
 *  along the spine. → { tris: [{p, n, uv, part, bone?}], material } */
function partTriangles(doc) {
  const out = [];
  let material = null;
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    const name = node.getName();
    const M = node.getWorldMatrix();
    const at = (v, w) => [0, 1, 2].map(r => M[r] * v[0] + M[4 + r] * v[1] + M[8 + r] * v[2] + (w ? M[12 + r] : 0));
    for (const prim of mesh.listPrimitives()) {
      material ??= prim.getMaterial();
      const P = prim.getAttribute('POSITION'), N = prim.getAttribute('NORMAL'), T = prim.getAttribute('TEXCOORD_0'), I = prim.getIndices();
      const idx = I ? Array.from(I.getArray()) : Array.from({ length: P.getCount() }, (_, i) => i);
      for (let k = 0; k + 2 < idx.length; k += 3) {
        const tri = { p: [], n: [], uv: [] };
        for (const i of idx.slice(k, k + 3)) {
          let p = at(P.getElement(i, []), true), n = N ? at(N.getElement(i, []), false) : [0, 1, 0];
          const ln = Math.hypot(...n) || 1; n = n.map(x => x / ln);
          if (name.startsWith('arm')) {
            // hanging down → out to the side, about the arm's top cube: (x, y) → (cx − (y − cy)·sx, cy + (x − cx)·sx)
            const sx = name.includes('left') ? 1 : -1, c = [JOINTS.LeftArm[0] * sx, JOINTS.LeftArm[1]];
            p = [c[0] - (p[1] - c[1]) * sx, c[1] + (p[0] - c[0]) * sx, p[2]];
            n = [-n[1] * sx, n[0] * sx, n[2]];
          }
          tri.p.push(p); tri.n.push(n); tri.uv.push(T ? T.getElement(i, []) : [0, 0]);
        }
        out.push({ part: name, ...tri });
      }
    }
  }
  const parts = new Map();
  for (const t of out) { if (!parts.has(t.part)) parts.set(t.part, []); parts.get(t.part).push(t); }
  const done = [];
  for (const [part, tris] of parts) {
    if (segmentsOf(part)) { done.push(...limbSegments(part, tris)); continue; }
    const list = part === 'torso' ? cuts(tris, 1, ['Spine02', 'Spine01', 'Spine'].flatMap(j => [JOINTS[j][1] - BAND, JOINTS[j][1] + BAND])) : tris;
    for (const t of list) done.push({ ...t, part });
  }
  return { tris: done, material };
}

/** A Kenney Blocky Characters GLB (its texture packed inside) → a gf-humanoid-1 body GLB. */
export async function kenneyBlockyToHumanoid(bytes, { id = 'kenney-blocky' } = {}) {
  const IO = await io();
  const doc = await IO.readBinary(new Uint8Array(bytes));
  doc.setLogger(new gltfCore.Logger(gltfCore.Logger.Verbosity.SILENT));
  const names = doc.getRoot().listNodes().map(n => n.getName());
  for (const want of ['leg-left', 'leg-right', 'torso', 'arm-left', 'arm-right', 'head']) if (!names.includes(want)) throw new Error(`not a Kenney blocky character: no node "${want}"`);
  const { tris, material } = partTriangles(doc);
  // the old tree, meshes and clips go; the material and its texture stay
  for (const a of doc.getRoot().listAnimations()) a.dispose();
  for (const s of doc.getRoot().listScenes()) s.dispose();
  for (const n of doc.getRoot().listNodes()) n.dispose();
  for (const m of doc.getRoot().listMeshes()) m.dispose();
  for (const ext of doc.getRoot().listExtensionsUsed()) if (ext.extensionName === 'KHR_materials_unlit') ext.dispose();
  material.setMetallicFactor(0).setRoughnessFactor(0.85).setName('kenney_blocky');

  const buf = doc.getRoot().listBuffers()[0] ?? doc.createBuffer();
  const root = doc.createNode('gf_body').setExtras({ gfRig: 'gf-humanoid-1', gfBody: id, gfSpineBend: 0.4, gfGenerator: 'builder/art/rig/kenney-blocky.mjs' });
  const nodes = new Map();
  for (const b of BONES) {
    const par = PARENT[b], p = JOINTS[b], q = par ? JOINTS[par] : [0, 0, 0];
    const node = doc.createNode(b).setTranslation(p.map((x, i) => (x - q[i]) * SCALE));
    nodes.set(b, node);
    (par ? nodes.get(par) : root).addChild(node);
  }
  const ibm = doc.createAccessor('ibm').setType('MAT4').setBuffer(buf).setArray(new Float32Array(BONES.flatMap(b => {
    const [x, y, z] = JOINTS[b].map(v => v * SCALE);
    return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -x, -y, -z, 1];
  })));
  const skin = doc.createSkin('gf_skin').setInverseBindMatrices(ibm).setSkeleton(nodes.get('Hips'));
  for (const b of BONES) skin.addJoint(nodes.get(b));

  // one vertex per corner (boxes are flat-shaded), its weights from where it sits
  const jIndex = new Map(BONES.map((b, i) => [b, i]));
  const n = tris.length * 3, POS = new Float32Array(n * 3), NOR = new Float32Array(n * 3), UV = new Float32Array(n * 2), J = new Uint8Array(n * 4), W = new Float32Array(n * 4);
  let v = 0;
  for (const t of tris) for (let k = 0; k < 3; k++, v++) {
    POS.set(t.p[k].map(x => x * SCALE), v * 3); NOR.set(t.n[k], v * 3); UV.set(t.uv[k], v * 2);
    (t.bone ? [[t.bone, 1]] : weigh(t.part, t.p[k])).forEach(([b, w], i) => { J[v * 4 + i] = jIndex.get(b); W[v * 4 + i] = w; });
  }
  const acc = (type, arr) => doc.createAccessor().setType(type).setBuffer(buf).setArray(arr);
  const mesh = doc.createMesh(id).addPrimitive(doc.createPrimitive().setMaterial(material)
    .setAttribute('POSITION', acc('VEC3', POS)).setAttribute('NORMAL', acc('VEC3', NOR)).setAttribute('TEXCOORD_0', acc('VEC2', UV))
    .setAttribute('JOINTS_0', acc('VEC4', J)).setAttribute('WEIGHTS_0', acc('VEC4', W)));
  root.addChild(doc.createNode(id).setMesh(mesh).setSkin(skin));
  doc.createScene(id).addChild(root);
  doc.getRoot().setDefaultScene(doc.getRoot().listScenes()[0]);
  return Buffer.from(await IO.writeBinary(doc));
}
