#!/usr/bin/env node
// blocky.mjs: the blocky body set (kind `blocky`). Block avatars in the family of the most-played block games: a cube
// head with a printed face, a box torso, square arms and legs that swing from the top like a toy's, on the
// gf-humanoid-1 standard (runtimes/three/kit/character/RIG.md), so every shared clip plays on them and they pass
// rig-check and the model judge. Generated, no third-party art, CC0.
//
//   node runtimes/three/tools/blocky.mjs [--variant <id>|all] [--out <dir>, default .cache/blocky] [--manifest <file>]
//
// Every part is a box, and almost every box rides one bone rigidly (a toy's joints, never a stretched skin): the head,
// each arm segment, each leg segment, the shoes. Only the torso bends a little, along the spine, so a lean or a run
// never opens a gap at the waist. Faces are thin boxes printed on the head's front; the hurt face (RIG.md §3, gfFaces)
// swaps the eyes for > < and opens the mouth. The shirt is `tint_body`, so the kit paints it in the player's colour;
// skin, trousers, shoes and hair keep their own colours.
import { writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { REPO, KIT } from '../../../builder/tools/lib/paths.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const tool = p => pathToFileURL(join(REPO, 'builder/tools/lib', p)).href;
await import(tool('char-node.mjs'));                          // 'three' resolves under Node (the runtime's pinned copy)
const { io, gltfCore, THREE } = await import(tool('char-deps.mjs'));
const { optimizeDoc } = await import(tool('char-optimize.mjs'));
const rig = await import(pathToFileURL(join(KIT, 'character/rig.js')).href);
const { Vector3 } = THREE;

/**
 * Proportions in metres, x the character's own left, the character facing +z. Heights are measured from the ground.
 *   hip    the hip joints' height (the top of the legs)       torso  {w, d, h}: the box above the hips
 *   leg    {w, d} of a leg; foot {h, front, back}             arm    {w, len}: square arm, shoulder to fingertips
 *   head   the cube's side; hair: 'short' | 'cap' | 'long' | 'flat'; face sizes scale with the head
 */
export const VARIANTS = {
  'blocky-classic': {
    label: 'Block kid', describe: 'a classic block avatar: cube head, short hair, tinted shirt, jeans',
    hip: 0.7, torso: { w: 0.5, d: 0.26, h: 0.64 }, leg: { w: 0.25, d: 0.25 }, foot: { h: 0.09, front: 0.06, back: 0.01 },
    arm: { w: 0.22, len: 0.64 }, head: 0.46, hair: 'short',
    colors: { shirt: '#3d8bff', skin: '#ffcf6b', pants: '#2d5fb8', shoe: '#2a2a36', hair: '#5b3a1e' },
  },
  'blocky-cap': {
    label: 'Cap kid', describe: 'a short block avatar with a big head and a cap with a brim',
    hip: 0.46, torso: { w: 0.46, d: 0.26, h: 0.48 }, leg: { w: 0.23, d: 0.23 }, foot: { h: 0.08, front: 0.05, back: 0.01 },
    arm: { w: 0.2, len: 0.5 }, head: 0.5, hair: 'cap',
    colors: { shirt: '#ff5a4f', skin: '#c98a5a', pants: '#3a3550', shoe: '#f2f2f2', hair: '#e8402f' },
  },
  'blocky-tall': {
    label: 'Tall block', describe: 'a tall, slim block avatar with long hair',
    hip: 0.86, torso: { w: 0.46, d: 0.24, h: 0.7 }, leg: { w: 0.23, d: 0.23 }, foot: { h: 0.09, front: 0.06, back: 0.01 },
    arm: { w: 0.2, len: 0.72 }, head: 0.44, hair: 'long',
    colors: { shirt: '#9b5cff', skin: '#f2c7a5', pants: '#262833', shoe: '#7a4a2a', hair: '#1f1a17' },
  },
  'blocky-chunky': {
    label: 'Chunky block', describe: 'a wide block avatar with a flat-top haircut',
    hip: 0.62, torso: { w: 0.62, d: 0.32, h: 0.62 }, leg: { w: 0.29, d: 0.29 }, foot: { h: 0.1, front: 0.06, back: 0.01 },
    arm: { w: 0.24, len: 0.6 }, head: 0.48, hair: 'flat',
    colors: { shirt: '#2fd36b', skin: '#8d5a3b', pants: '#4a4036', shoe: '#1e1e24', hair: '#141210' },
  },
};

// ------------------------------------------------------------------ the skeleton (T-pose, identity frames)
export function skeleton(v) {
  const T = v.torso, A = v.arm, L = v.leg, F = v.foot;
  const top = v.hip + T.h;                                   // the shoulders' top
  const armY = top - A.w / 2;                                // the arms' axis (T-pose)
  const knee = F.h + (v.hip - F.h) * 0.5;
  const P = {
    Hips: [0, v.hip, 0], Spine02: [0, v.hip + T.h * 0.2, 0], Spine01: [0, v.hip + T.h * 0.42, 0], Spine: [0, armY - A.w * 0.3, 0],
    neck: [0, top, 0], Head: [0, top + 0.02, 0], head_end: [0, top + v.head, 0],
  };
  for (const [s, x] of [['Left', 1], ['Right', -1]]) {
    const root = T.w / 2 + A.w / 2;                          // the arm pivots inside its top cube, as a toy's does
    P[`${s}Shoulder`] = [x * T.w * 0.18, armY, 0];
    P[`${s}Arm`] = [x * root, armY, 0];
    P[`${s}ForeArm`] = [x * (T.w / 2 + A.len * 0.5), armY, 0];
    P[`${s}Hand`] = [x * (T.w / 2 + A.len * 0.8), armY, 0];
    P[`${s}UpLeg`] = [x * L.w / 2, v.hip, 0];
    P[`${s}Leg`] = [x * L.w / 2, knee, 0];
    P[`${s}Foot`] = [x * L.w / 2, F.h, 0];
    P[`${s}ToeBase`] = [x * L.w / 2, F.h * 0.4, L.d / 2 + F.front - 0.04];
  }
  return Object.fromEntries(Object.entries(P).map(([k, p]) => [k, new Vector3(...p)]));
}

// ------------------------------------------------------------------ parts: boxes + weights
const part = mat => ({ pos: [], nor: [], idx: [], jw: [], mat });
function addGeometry(pt, geo, matrix, weigh) {
  geo.applyMatrix4(matrix);
  const p = geo.attributes.position, n = geo.attributes.normal, base = pt.pos.length / 3, v = new Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    pt.pos.push(v.x, v.y, v.z); pt.nor.push(n.getX(i), n.getY(i), n.getZ(i)); pt.jw.push(weigh(v));
  }
  for (const i of geo.index.array) pt.idx.push(base + i);
}
const lerpW = (a, b, t) => (t <= 0 ? [[a, 1]] : t >= 1 ? [[b, 1]] : [[a, 1 - t], [b, t]]);
function chainY(chain, y) {
  if (y <= chain[0][1]) return [[chain[0][0], 1]];
  for (let i = 0; i < chain.length - 1; i++) { const [a, ya] = chain[i], [b, yb] = chain[i + 1]; if (y <= yb) return lerpW(a, b, (y - ya) / (yb - ya)); }
  return [[chain.at(-1)[0], 1]];
}
/** A box from min to max corner (metres), rotated by `rot` about its centre. → [geometry, matrix] */
function box(min, max, { segY = 1, rot = null } = {}) {
  const s = max.map((m, i) => m - min[i]), c = max.map((m, i) => (m + min[i]) / 2);
  const g = new THREE.BoxGeometry(s[0], s[1], s[2], 1, segY, 1);
  const m = new THREE.Matrix4().compose(new Vector3(...c), rot ?? new THREE.Quaternion(), new Vector3(1, 1, 1));
  return [g, m];
}
const rigid = bone => () => [[bone, 1]];

export function build(v) {
  const P = skeleton(v);
  const parts = Object.fromEntries(['tint_body', 'skin', 'pants', 'shoe', 'hair', 'eye_white', 'eye_dark', 'face_hurt'].map(n => [n, part(n)]));
  const add = (mat, [g, m], weigh) => addGeometry(parts[mat], g, m, weigh);
  const T = v.torso, A = v.arm, L = v.leg, F = v.foot, H = v.head;
  const top = v.hip + T.h, armY = top - A.w / 2, knee = P.LeftLeg.y;

  // torso: a belt of trousers on the hips, then the shirt, bending gently along the spine (the only blended part)
  const belt = v.hip + Math.min(0.12, T.h * 0.2);
  add('pants', box([-T.w / 2, v.hip - 0.03, -T.d / 2], [T.w / 2, belt, T.d / 2]), rigid('Hips'));
  const spine = [['Hips', belt], ['Spine02', P.Spine02.y], ['Spine01', P.Spine01.y], ['Spine', P.Spine.y]];
  add('tint_body', box([-T.w / 2, belt, -T.d / 2], [T.w / 2, top, T.d / 2], { segY: 2 }), p => chainY(spine, p.y));

  for (const [s, x] of [['Left', 1], ['Right', -1]]) {
    // arm: a sleeve from the shoulder to the elbow, bare forearm, a block hand
    const x0 = T.w / 2, elbow = Math.abs(P[`${s}ForeArm`].x), wrist = Math.abs(P[`${s}Hand`].x), tip = T.w / 2 + A.len;
    const span = (a, b) => (x > 0 ? [a, b] : [-b, -a]);
    const [s0, s1] = span(x0, elbow + 0.02), [f0, f1] = span(elbow - 0.005, wrist + 0.01), [h0, h1] = span(wrist, tip);
    const w = A.w / 2, hw = A.w * 0.46;
    add('tint_body', box([s0, armY - w, -w], [s1, armY + w, w]), rigid(`${s}Arm`));
    add('skin', box([f0, armY - w * 0.94, -w * 0.94], [f1, armY + w * 0.94, w * 0.94]), rigid(`${s}ForeArm`));
    add('skin', box([h0, armY - hw, -hw], [h1, armY + hw, hw]), rigid(`${s}Hand`));
    // leg: thigh up into the belt (no wedge shows when it swings), shin over the knee, a shoe a little longer in front
    const lx = x * L.w / 2, lw = L.w / 2 - 0.004, ld = L.d / 2;
    add('pants', box([lx - lw, knee - 0.01, -ld], [lx + lw, v.hip + 0.06, ld]), rigid(`${s}UpLeg`));
    add('pants', box([lx - lw * 0.97, F.h - 0.005, -ld * 0.97], [lx + lw * 0.97, knee + 0.03, ld * 0.97]), rigid(`${s}Leg`));
    const toeZ = P[`${s}ToeBase`].z - 0.03;
    add('shoe', box([lx - lw * 1.02, 0, -ld - F.back], [lx + lw * 1.02, F.h, toeZ]), rigid(`${s}Foot`));
    add('shoe', box([lx - lw * 1.02, 0, toeZ], [lx + lw * 1.02, F.h * 0.8, ld + F.front]), rigid(`${s}ToeBase`));
  }

  // head: the cube, then hair or a cap, then the printed face on +z
  const hy0 = top, hy1 = top + H, hz = H / 2, head = rigid('Head');
  add('skin', box([-H / 2, hy0, -H / 2], [H / 2, hy1, H / 2]), head);
  const o = 0.012;                                                        // hair stands this far off the head
  if (v.hair === 'short' || v.hair === 'long' || v.hair === 'flat') {
    const lift = v.hair === 'flat' ? H * 0.22 : H * 0.1;
    add('hair', box([-H / 2 - o, hy1 - H * 0.16, -H / 2 - o], [H / 2 + o, hy1 + lift, H / 2 + o]), head);            // the top
    add('hair', box([-H / 2 - o, hy1 - H * (v.hair === 'long' ? 1.25 : 0.62), -H / 2 - o], [H / 2 + o, hy1, -H / 2 + H * 0.2]), head);   // the back
    for (const sx of [1, -1]) add('hair', box([sx > 0 ? H / 2 - 0.004 : -H / 2 - o, hy1 - H * (v.hair === 'long' ? 0.75 : 0.34), -H / 2 - o], [sx > 0 ? H / 2 + o : -H / 2 + 0.004, hy1, H * 0.12]), head);   // sides
    if (v.hair === 'short') add('hair', box([-H / 2 - o, hy1 - H * 0.24, hz - 0.01], [H * 0.12, hy1, hz + o]), head);  // a fringe across one side
  } else if (v.hair === 'cap') {
    add('hair', box([-H / 2 - o, hy1 - H * 0.2, -H / 2 - o], [H / 2 + o, hy1 + H * 0.14, H / 2 + o]), head);           // the crown
    add('hair', box([-H / 2 + 0.02, hy1 - H * 0.2, hz], [H / 2 - 0.02, hy1 - H * 0.2 + 0.035, hz + H * 0.42]), head);   // the brim
  }
  // the face: eyes (white with a dark pupil toward the nose), a smile of three blocks; the hurt face's > < and open mouth
  const ey = top + H * (v.hair === 'cap' ? 0.5 : 0.54), ex = H * 0.19, es = H * 0.17, my = top + H * 0.27, f = hz;
  for (const sx of [1, -1]) {
    add('eye_white', box([sx * ex - es / 2, ey - es / 2, f - 0.004], [sx * ex + es / 2, ey + es / 2, f + 0.008]), head);
    const px = sx * ex - sx * es * 0.18;
    add('eye_dark', box([px - es * 0.3, ey - es * 0.42, f + 0.004], [px + es * 0.3, ey + es * 0.36, f + 0.012]), head);
    for (const tilt of [1, -1]) {                                   // > on the left eye, < on the right: chevrons pointing in
      const q = new THREE.Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), sx * tilt * -0.62);
      const cx = sx * ex + sx * es * 0.12, cy = ey + tilt * es * 0.2;
      add('face_hurt', box([cx - es * 0.42, cy - es * 0.08, f - 0.004], [cx + es * 0.42, cy + es * 0.08, f + 0.012], { rot: q }), head);
    }
  }
  const mw = H * 0.24, mt = H * 0.06;
  add('eye_dark', box([-mw / 2, my - mt / 2, f - 0.004], [mw / 2, my + mt / 2, f + 0.01]), head);
  for (const sx of [1, -1]) add('eye_dark', box([sx * mw / 2 - (sx > 0 ? 0 : mt), my, f - 0.004], [sx * mw / 2 + (sx > 0 ? mt : 0), my + mt * 1.6, f + 0.01]), head);
  add('face_hurt', box([-mw * 0.4, my - mt * 1.1, f - 0.004], [mw * 0.4, my + mt * 1.3, f + 0.012]), head);
  return { P, parts };
}

// ------------------------------------------------------------------ write the GLB
const hex = c => { const col = new THREE.Color(c); return [col.r, col.g, col.b, 1]; };
export async function makeBlocky(id, { color } = {}) {
  const v = VARIANTS[id];
  if (!v) throw new Error(`no blocky variant ${id} (have ${Object.keys(VARIANTS).join(', ')})`);
  const { P, parts } = build(v);
  const doc = new gltfCore.Document();
  doc.setLogger(new gltfCore.Logger(gltfCore.Logger.Verbosity.SILENT));
  const buf = doc.createBuffer();
  const names = rig.BONE_NAMES.filter(n => P[n]);
  const nodes = new Map();
  const root = doc.createNode('gf_body').setExtras({
    gfRig: rig.RIG, gfBody: id, gfTint: ['tint_body'], gfSpineBend: 0.4, gfGenerator: 'runtimes/three/tools/blocky.mjs',
    gfFaces: { hurt: { show: ['face_hurt'], hide: ['eye_white', 'eye_dark'] } },
  });
  for (const n of names) {
    const par = rig.canonicalParent(n, x => !!P[x]);
    const node = doc.createNode(n).setTranslation(P[n].clone().sub(par ? P[par] : new Vector3()).toArray());
    nodes.set(n, node);
    (par ? nodes.get(par) : root).addChild(node);
  }
  const ibm = doc.createAccessor('ibm').setType('MAT4').setBuffer(buf)
    .setArray(new Float32Array(names.flatMap(n => new THREE.Matrix4().makeTranslation(-P[n].x, -P[n].y, -P[n].z).toArray())));
  const skin = doc.createSkin('gf_skin').setInverseBindMatrices(ibm).setSkeleton(nodes.get('Hips'));
  names.forEach(n => skin.addJoint(nodes.get(n)));
  const C = v.colors;
  const MAT = {
    tint_body: { color: color ?? C.shirt, rough: 0.8 }, skin: { color: C.skin, rough: 0.7 }, pants: { color: C.pants, rough: 0.85 },
    shoe: { color: C.shoe, rough: 0.7 }, hair: { color: C.hair, rough: 0.8 }, eye_white: { color: '#fbfbff', rough: 0.4 },
    eye_dark: { color: '#1a1622', rough: 0.4 }, face_hurt: { color: '#221a2b', rough: 0.45 },   // never the same as eye_dark: the optimizer would merge them and the hurt face would always show
  };
  const mesh = doc.createMesh(id);
  const jIndex = new Map(names.map((n, i) => [n, i]));
  for (const [name, pt] of Object.entries(parts)) {
    if (!pt.idx.length) continue;
    const n = pt.pos.length / 3, J = new Uint8Array(n * 4), W = new Float32Array(n * 4);
    pt.jw.forEach((list, i) => {
      const ent = list.filter(([, w]) => w > 1e-4).sort((a, b) => b[1] - a[1]).slice(0, 4), s = ent.reduce((a, [, w]) => a + w, 0);
      ent.forEach(([b, w], k) => { J[i * 4 + k] = jIndex.get(b); W[i * 4 + k] = w / s; });
    });
    const mat = doc.createMaterial(name).setBaseColorFactor(hex(MAT[name].color)).setRoughnessFactor(MAT[name].rough).setMetallicFactor(0);
    mesh.addPrimitive(doc.createPrimitive().setMaterial(mat)
      .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setBuffer(buf).setArray(new Float32Array(pt.pos)))
      .setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setBuffer(buf).setArray(new Float32Array(pt.nor)))
      .setAttribute('JOINTS_0', doc.createAccessor().setType('VEC4').setBuffer(buf).setArray(J))
      .setAttribute('WEIGHTS_0', doc.createAccessor().setType('VEC4').setBuffer(buf).setArray(W))
      .setIndices(doc.createAccessor().setType('SCALAR').setBuffer(buf).setArray(new Uint16Array(pt.idx))));
  }
  root.addChild(doc.createNode(id).setMesh(mesh).setSkin(skin));
  doc.createScene(id).addChild(root);
  await optimizeDoc(doc, {});
  const bytes = await (await io()).writeBinary(doc);
  return { bytes, label: v.label, describe: v.describe, color: color ?? C.shirt, height: +(v.hip + v.torso.h + v.head + (v.hair === 'flat' ? v.head * 0.22 : v.hair === 'cap' ? v.head * 0.14 : v.head * 0.1)).toFixed(2) };
}

/** The library entry for a made body (the shape of runtimes/three/library/bodies.json entries). */
export function entryFor(id, made, file) {
  return {
    id, label: made.label, file, from: 'blocky', kind: 'blocky', tags: ['blocky', 'block', 'voxel', 'toy'], color: made.color, describe: made.describe,
    license: { spdx: 'CC0-1.0', author: 'xgames-kit', note: 'generated by runtimes/three/tools/blocky.mjs (no third-party art)' },
    rig: 'gf-humanoid-1', height: made.height, bytes: made.bytes.length, sha256: createHash('sha256').update(made.bytes).digest('hex'), tint: ['tint_body'],
  };
}

// writes the GLBs and a manifest of them into a scratch folder: the set itself lives in the asset library (pack
// xk-blocky-bodies, library/packs/xk-blocky-bodies; its manifests hold these files' sha256, which tests/blocky.test.mjs
// holds to a fresh make). After a change: make them here, then `gamesfun art ingest <dir> --pack xk-blocky-bodies`.
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const a = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
  const which = a('--variant', 'all');
  const out = resolve(a('--out', resolve(REPO, '.cache/blocky')));
  const manifest = resolve(a('--manifest', join(out, 'bodies-blocky.json')));
  mkdirSync(out, { recursive: true });
  const entries = [];
  for (const id of which === 'all' ? Object.keys(VARIANTS) : [which]) {
    const r = await makeBlocky(id);
    const file = join(out, `${id}.glb`);
    writeFileSync(file, r.bytes);
    entries.push(entryFor(id, r, relative(dirname(manifest), file)));
    console.log(`${id}.glb  ${(r.bytes.length / 1024).toFixed(0)} KB  ${r.height} m  ${r.label}`);
  }
  if (which === 'all') writeFileSync(manifest, JSON.stringify({ about: 'The blocky body set (kind blocky), made by runtimes/three/tools/blocky.mjs: ingest into the library pack xk-blocky-bodies.', rig: 'gf-humanoid-1', bodies: entries }, null, 1) + '\n');
}
