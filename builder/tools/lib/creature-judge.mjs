// The creature judge: does a GLB work as a body on one of the archetype standards (worm, blob, quadruped, flyer;
// runtimes/three/kit/character/CREATURES.md)? rig-check's half for creatures, and the model judge's checks that make
// sense for a body with no hands or face of a person's: no clip file, so it poses the body through every action with
// the runtime's own procedural motion (kit/character/motion.js, in Node) and measures the skinned mesh.
//
//   const r = await judgeCreature('<body.glb>', { archetype });   // archetype: else the body's gf_body extras say
//   → { ok, archetype, rig, errors, warnings, parts: {body, head, limbs}, poses: [...], stats, metrics }
//
// What fails a body (errors):
//   standard   not skinned; a required bone missing or under the wrong parent; a joint not in the skin; a joint not resting
//              unrotated in the character's axes (autorig writes them so); a non-uniform scale at bind; a joint off the
//              body (outside its box by more than a fifth of its size)
//   scale      metres (the standard's height range), Y up, facing +Z (each archetype's own tell), feet on the ground
//   skin       a vertex with no weight, weights that do not sum to 1, more than four influences, a required bone no
//              vertex follows (it would move nothing)
//   motion     in any action: triangles stretched past 2.2x or squeezed under 0.35x of their rest edges (more than 2% of
//              a part), triangles folding inside out (more than 6%), a part flying off (the posed body over 2.5x its
//              size), the body sinking through the ground or never touching it while it walks, nothing moving when it
//              moves (a skin weighted to a bone the motion does not drive)
// Budget: rig-check's (RIG.md §7).
import './char-node.mjs';
import { readFileSync, statSync } from 'node:fs';
import { io } from './char-deps.mjs';
import { loadGLB, THREE } from './char-three.mjs';
import { bodyStats } from './char-gltf.mjs';

const kit = '../../../runtimes/three/kit/character/';
const A = await import(kit + 'archetypes.js');
const { createMotion } = await import(kit + 'motion.js');
const { prepareCreature } = await import(kit + 'creature.js');

export const PARTS = ['body', 'head', 'limbs'];
export const PART_LABEL = { body: 'body', head: 'head', limbs: 'limbs (feet, hands, legs, wings, tail)' };
const BUDGET = { bytes: { warn: 2.5e6, error: 6e6 }, triangles: { warn: 30000, error: 60000 }, texturePx: { warn: 1024, error: 2048 }, joints: { warn: 90, error: 160 }, materials: { warn: 8, error: 24 } };
export const LIMITS = { stretch: 2.2, squeeze: 0.35, badShare: 0.02, foldShare: 0.06, span: 2.5, ground: 0.08, restDeg: 3 };

const HEADS = { blob: ['Top', 'Head'], worm: ['Head', 'Jaw'], quadruped: ['Head', 'Jaw', 'LeftEar', 'RightEar', 'Neck'], flyer: ['Head', 'Neck'] };
const LIMB = /Foot|Hand|Leg|Wing|Tail|Ear/;
const partOfBone = (arch, b) => (HEADS[arch].includes(b) ? 'head' : LIMB.test(b) ? 'limbs' : 'body');

/** The scenarios the judge (and the sheet) pose a creature through: [name, state over time, seconds to run]. */
export function scenarios(h) {
  const base = { grounded: true, vy: 0, airT: 0, landT: 9, vel: { x: 0, z: 0 }, action: null, hold: 0, aim: 0, down: 0, tumbling: false, getup: null };
  const act = (action, dur, at) => (t, s) => ({ ...s, action: t >= 0.6 ? { action, t: Math.min(dur, (t - 0.6) * 1), dur } : null });
  return [
    ['idle', () => ({ ...base, speed: 0 }), 1.2],
    ['walk', () => ({ ...base, speed: Math.max(0.6, 1.2 * h), vel: { x: 0, z: Math.max(0.6, 1.2 * h) } }), 1.6],
    ['run', () => ({ ...base, speed: Math.max(1.8, 4 * h), vel: { x: 0, z: Math.max(1.8, 4 * h) } }), 1.6],
    ['jump', (t) => ({ ...base, grounded: t < 0.5, vy: t < 0.5 ? 0 : 4, airT: Math.max(0, t - 0.5), speed: 0 }), 0.7],
    ['fall', (t) => ({ ...base, grounded: false, vy: -4, airT: t, speed: 0 }), 0.8],
    ['land', (t) => ({ ...base, landT: Math.max(0, t - 0.5), speed: 0 }), 0.62],
    ['act', (t, s) => act('act', 0.55)(t, { ...base, speed: 0 }), 0.6 + 0.3],
    ['act-strike', (t, s) => act('act', 0.55)(t, { ...base, speed: 0 }), 0.6 + 0.29],
    ['hit', (t, s) => act('hit', 0.42)(t, { ...base, speed: 0 }), 0.6 + 0.08],
    ['celebrate', (t, s) => act('celebrate', 1.6)(t, { ...base, speed: 0 }), 0.6 + 0.6],
    ['hold', () => ({ ...base, hold: 1, speed: 0 }), 0.8],
    ['down', (t) => ({ ...base, down: Math.min(1, t * 2), speed: 0 }), 1.0],
    ['getup', (t) => ({ ...base, down: 1 - Math.min(1, t / 0.6), getup: Math.min(1, t / 0.6), speed: 0 }), 0.3],
  ];
}

const _v = new THREE.Vector3();
function skinnedPositions(skinned, frame) {
  const out = [];
  for (const m of skinned) {
    const P = m.geometry.attributes.position, arr = new Float32Array(P.count * 3);
    for (let i = 0; i < P.count; i++) { m.getVertexPosition(i, _v); _v.applyMatrix4(m.matrixWorld).applyMatrix4(frame); arr[i * 3] = _v.x; arr[i * 3 + 1] = _v.y; arr[i * 3 + 2] = _v.z; }
    out.push(arr);
  }
  return out;
}

export async function judgeCreature(file, { archetype = null } = {}) {
  const errors = [], warnings = [], metrics = {};
  const err = m => errors.push(m), warn = m => warnings.push(m);
  const bytes = statSync(file).size;
  let doc;
  try { doc = await (await io()).read(file); } catch (e) { return { ok: false, file, errors: [`not a readable glTF/GLB: ${e.message}`], warnings, stats: { bytes }, metrics, parts: {} }; }
  const stats = bodyStats(doc, bytes);
  const over = (v, b, what, unit = '') => { if (v > b.error) err(`${what} ${v}${unit} is over the limit ${b.error}${unit}`); else if (v > b.warn) warn(`${what} ${v}${unit} is over the target ${b.warn}${unit}`); };
  over(bytes, BUDGET.bytes, 'file size', ' B'); over(Math.round(stats.triangles), BUDGET.triangles, 'triangles'); over(stats.joints, BUDGET.joints, 'joints'); over(stats.materials, BUDGET.materials, 'materials');
  for (const t of stats.textures) if (t.size) over(Math.max(...t.size), BUDGET.texturePx, `texture (${t.mime})`, ' px');
  for (const m of doc.getRoot().listMeshes()) for (const p of m.listPrimitives()) if (p.getAttribute('JOINTS_1')) err(`mesh ${m.getName()}: more than 4 influences per vertex (JOINTS_1)`);
  const g = await loadGLB(file);
  const root = g.scene;
  const arch = archetype ?? A.archetypeOfModel(root);
  const std = A.standardOf(arch);
  if (!std || arch === 'humanoid') return { ok: false, file, archetype: arch, errors: [`no creature archetype: the body's gf_body extras name none (gfArchetype) and none was given (one of ${Object.keys(A.STANDARDS).join(', ')})`], warnings, stats, metrics, parts: {} };
  const named = A.archetypeOfModel(root);
  if (named && named !== arch) err(`the body says it is a ${named} (gf_body extras) but is judged as a ${arch}`);
  const rig = A.findCreatureRig(root, std);
  if (!rig.skinned.length) return { ok: false, file, archetype: arch, rig: std.rig, errors: [`not rigged: no skinned mesh (gamesfun art autorig <file> --archetype ${arch})`], warnings, stats, metrics, parts: {} };
  const has = n => rig.bones.has(n);
  const missing = std.required.filter(n => !has(n));
  if (missing.length) return { ok: false, file, archetype: arch, rig: std.rig, errors: [`missing required ${std.rig} bones: ${missing.join(', ')}`], warnings, stats, metrics, parts: {} };
  for (const [n, bone] of rig.bones) {
    if (n === 'Root') continue;
    let a = bone.parent; while (a && !(std.isCanonical(a.name) && rig.bones.get(a.name) === a)) a = a.parent;
    const want = A.canonicalParent(std, n, has);
    if ((a?.name ?? null) !== want) err(`bone ${n} hangs under ${a?.name ?? 'nothing'}; ${std.rig} wants ${want}`);
  }
  const notJoint = std.required.filter(n => n !== 'Root' && !rig.skinned.some(m => m.skeleton.bones.includes(rig.bones.get(n))));
  if (notJoint.length) err(`bones not in the skin: ${notJoint.join(', ')}`);
  if (errors.length) return { ok: false, file, archetype: arch, rig: std.rig, errors, warnings, stats, metrics, parts: {} };

  // ---- bind: frames, scale, facing, ground
  const bind = A.creatureBind(root, rig);
  const P = n => bind.pos.get(n);
  if (bind.spread > 1e-3) warn(`the file's bones are not at the bind pose (largest difference ${bind.spread.toFixed(3)}): the body is measured as the file holds it`);
  for (const [n, q] of bind.rot) {
    const deg = 2 * Math.acos(Math.min(1, Math.abs(q.w))) * 180 / Math.PI;
    if (deg > LIMITS.restDeg) err(`bone ${n} rests turned ${deg.toFixed(1)}° from the character's axes: ${std.rig} joints rest unrotated (autorig writes them so)`);
  }
  root.updateMatrixWorld(true);
  for (const [n, b] of rig.bones) { const s = new THREE.Vector3(); b.matrixWorld.decompose(new THREE.Vector3(), new THREE.Quaternion(), s); if (Math.abs(s.x - s.y) > 1e-3 || Math.abs(s.y - s.z) > 1e-3) err(`bone ${n} has a non-uniform scale at bind`); }
  const info = A.measureCreature(std, rig, bind);
  const h = info.height;
  Object.assign(metrics, { height: +h.toFixed(3), width: +info.width.toFixed(3), depth: +info.depth.toFixed(3), ground: +info.ground.toFixed(3) });
  if (!(h >= std.minHeight && h <= std.maxHeight)) err(`height ${h.toFixed(3)} m: a ${arch} is ${std.minHeight}–${std.maxHeight} m tall, in metres`);
  if (Math.abs(info.ground) > 0.05 * h) warn(`the lowest point is ${info.ground.toFixed(3)} m off the ground (y=0); the kit compensates`);
  const facing = {
    blob: () => (P('Top').y > P('Body').y ? null : 'the Top must sit above the Body (Y up)'),
    worm: () => (P('Head').distanceTo(P('Seg0')) > 0.2 * Math.max(h, info.depth) ? (info.upright ? (P('Head').y > P('Seg0').y ? null : 'a standing worm\'s Head must be above its tail (Y up)') : (P('Head').z > P('Seg0').z ? null : 'a lying worm\'s Head must be toward +Z from its tail (it faces +Z)')) : 'the Head is too near the tail: the chain must run the length of the body'),
    quadruped: () => (P('Head').z <= P('Hips').z ? 'the Head must be toward +Z from the Hips (it faces +Z)' : P('FrontLeftUpLeg').x <= P('FrontRightUpLeg').x ? 'its left legs must be on +X' : ['FrontLeft', 'FrontRight', 'BackLeft', 'BackRight'].some(k => P(k + 'Foot').y >= P(k + 'UpLeg').y) ? 'each Foot must be below its UpLeg (Y up)' : null),
    flyer: () => (P('LeftWing1').x <= 0 || P('RightWing1').x >= 0 ? 'the left wing must be on +X and the right on -X' : P('Head').z <= P('Body').z - 0.02 * info.depth ? 'the Head must be toward +Z from the Body (it faces +Z)' : null),
  }[arch]();
  if (facing) err(facing);
  // every joint inside the body (a little outside at most): a joint placed off it swings the skin about a far pivot
  const room = bind.box.clone().expandByScalar(0.2 * Math.max(info.height, info.width, info.depth));
  for (const [n, p] of bind.pos) if (n !== 'Root' && !room.containsPoint(p)) err(`bone ${n} sits off the body (at ${p.toArray().map(x => x.toFixed(2)).join(', ')} m, the body's box is ${bind.box.min.toArray().map(x => x.toFixed(2)).join(', ')} to ${bind.box.max.toArray().map(x => x.toFixed(2)).join(', ')}): fit the skeleton again (autorig)`);

  // ---- skin
  let zero = 0, bad = 0, verts = 0;
  const weightOf = new Map();
  for (const m of rig.skinned) {
    const si = m.geometry.attributes.skinIndex, sw = m.geometry.attributes.skinWeight, nb = m.skeleton.bones.length;
    if (!si || !sw) { err(`mesh ${m.name}: no skin weights`); continue; }
    for (let i = 0; i < si.count; i++) {
      verts++; let sum = 0;
      for (let k = 0; k < 4; k++) { const w = sw.getComponent(i, k), j = si.getComponent(i, k); if (!Number.isFinite(w) || w < 0 || (w > 0 && j >= nb)) { bad++; continue; } sum += w; if (w > 0) { const b = m.skeleton.bones[j]; weightOf.set(b.name, (weightOf.get(b.name) ?? 0) + w); } }
      if (sum < 1e-4) zero++; else if (Math.abs(sum - 1) > 0.02) bad++;
    }
  }
  metrics.vertices = verts;
  metrics.weighted = Object.fromEntries([...weightOf].map(([k, v]) => [k, Math.round(v)]));
  if (zero) err(`${zero} vertices have no skin weight`);
  if (bad) err(`${bad} vertices have broken weights (NaN, negative, out of range, or not summing to 1)`);
  const idle = std.required.filter(n => n !== 'Root' && !(weightOf.get(n) > 0));
  if (idle.length) err(`no vertex follows ${idle.join(', ')}: the motion would move nothing there`);
  const lazy = [...rig.bones.keys()].filter(n => n !== 'Root' && !std.required.includes(n) && !(weightOf.get(n) > 0));
  if (lazy.length) warn(`no vertex follows ${lazy.join(', ')} (optional bones with nothing on them)`);
  if (errors.length) return { ok: false, file, archetype: arch, rig: std.rig, errors, warnings, stats, metrics, parts: {} };

  // ---- motion: every action, measured on the skinned mesh
  const bodyNode = root.getObjectByName('gf_body') ?? root;
  const frame = bodyNode.matrixWorld.clone().invert();
  const tris = [];
  for (const [mi, m] of rig.skinned.entries()) {
    const idx = m.geometry.index ? m.geometry.index.array : Array.from({ length: m.geometry.attributes.position.count }, (_, i) => i);
    const si = m.geometry.attributes.skinIndex, sw = m.geometry.attributes.skinWeight;
    const dom = i => { let best = 0, bw = -1; for (let k = 0; k < 4; k++) { const w = sw.getComponent(i, k); if (w > bw) { bw = w; best = si.getComponent(i, k); } } return m.skeleton.bones[best].name; };
    for (let t = 0; t + 2 < idx.length; t += 3) { const bone = dom(idx[t]); tris.push({ m: mi, a: idx[t], b: idx[t + 1], c: idx[t + 2], bone, part: partOfBone(arch, bone) }); }
  }
  const rest = skinnedPositions(rig.skinned, frame);
  const tv = (pos, t, k) => { const a = pos[t.m], i = t[k] * 3; return [a[i], a[i + 1], a[i + 2]]; };
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const len = a => Math.hypot(a[0], a[1], a[2]);
  const restTri = tris.map(t => { const A_ = tv(rest, t, 'a'), B = tv(rest, t, 'b'), C = tv(rest, t, 'c'); return { e: [len(sub(B, A_)), len(sub(C, B)), len(sub(A_, C))], n: cross(sub(B, A_), sub(C, A_)) }; });
  const size = Math.max(info.height, info.width, info.depth);
  const partStats = Object.fromEntries(PARTS.map(p => [p, { tris: tris.filter(t => t.part === p).length, worst: null, errors: [], warnings: [] }]));
  const poses = [];
  let touched = false, lowest = Infinity;
  const restBones = new Map([...rig.bones].map(([n, b]) => [n, b.getWorldPosition(new THREE.Vector3()).applyMatrix4(frame)]));
  let moved = 0;
  // each bone's turn from its rest (body frame): a face turned with its bone is not folded, only one turned against it
  const restQ = new Map([...rig.bones].map(([n, b]) => [n, b.getWorldQuaternion(new THREE.Quaternion())]));
  const bodyQ0 = bodyNode.getWorldQuaternion(new THREE.Quaternion());
  for (const [name, stateAt, seconds] of scenarios(h)) {
    // a fresh motion each time (its springs and phase start still), stepped at 60 Hz to the moment judged
    for (const [n, b] of rig.bones) { b.position.copy(b.userData.__restP ??= b.position.clone()); b.quaternion.copy(b.userData.__restQ ??= b.quaternion.clone()); b.scale.copy(b.userData.__restS ??= b.scale.clone()); }
    const motion = createMotion(std, rig, bind, info, { bodyNode });
    const dt = 1 / 60;
    let minY = Infinity;
    for (let t = 0; t <= seconds + 1e-6; t += dt) {
      motion.pose({ t, ...stateAt(t, {}) }, dt);
      if (name === 'walk' && t > 0.4) {
        root.updateMatrixWorld(true);
        const pos = skinnedPositions(rig.skinned, frame);
        for (const a of pos) for (let i = 1; i < a.length; i += 9) minY = Math.min(minY, a[i]);
      }
    }
    root.updateMatrixWorld(true);
    const pos = skinnedPositions(rig.skinned, frame);
    const box = new THREE.Box3();
    for (const a of pos) for (let i = 0; i < a.length; i += 3) box.expandByPoint(_v.set(a[i], a[i + 1], a[i + 2]));
    const per = Object.fromEntries(PARTS.map(p => [p, { bad: 0, fold: 0 }]));
    const turn = new Map([...rig.bones].map(([n, b]) => [n, b.getWorldQuaternion(new THREE.Quaternion()).multiply(restQ.get(n).clone().invert()).premultiply(bodyQ0.clone().invert()).multiply(bodyQ0)]));
    const _n = new THREE.Vector3();
    tris.forEach((t, k) => {
      const A_ = tv(pos, t, 'a'), B = tv(pos, t, 'b'), C = tv(pos, t, 'c');
      const e = [len(sub(B, A_)), len(sub(C, B)), len(sub(A_, C))], r = restTri[k];
      let worst = 1;
      // an edge under 1% of the body's size is too small to see (and quantised positions make its length noisy)
      for (let j = 0; j < 3; j++) if (r.e[j] > 0.01 * size) { const q = e[j] / r.e[j]; if (q > LIMITS.stretch || q < LIMITS.squeeze) worst = 0; }
      if (!worst) per[t.part].bad++;
      // a fold: the posed face turned more than 120° from where its bone turned its rest facing (inside out)
      const n = cross(sub(B, A_), sub(C, A_)), rn = _n.set(...r.n).applyQuaternion(turn.get(t.bone)), d = n[0] * rn.x + n[1] * rn.y + n[2] * rn.z;
      if (len(n) > 1e-12 && rn.length() > 1e-12 && d / (len(n) * rn.length()) < -0.5) per[t.part].fold++;
    });
    const span = Math.max(box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z);
    const rec = { pose: name, t: +seconds.toFixed(2), span: +span.toFixed(3), low: +box.min.y.toFixed(3), parts: {} };
    for (const p of PARTS) {
      const S = partStats[p]; if (!S.tris) continue;
      const bs = per[p].bad / S.tris, fs = per[p].fold / S.tris;
      rec.parts[p] = { stretched: +bs.toFixed(4), folded: +fs.toFixed(4) };
      if (!S.worst || bs + fs > S.worst.score) S.worst = { pose: name, score: bs + fs, stretched: +bs.toFixed(4), folded: +fs.toFixed(4) };
      if (bs > LIMITS.badShare) S.errors.push(`${name}: ${(bs * 100).toFixed(1)}% of its triangles stretch past ${LIMITS.stretch}x or squeeze under ${LIMITS.squeeze}x (limit ${LIMITS.badShare * 100}%)`);
      else if (bs > LIMITS.badShare / 4) S.warnings.push(`${name}: ${(bs * 100).toFixed(1)}% of its triangles stretch or squeeze hard`);
      if (fs > LIMITS.foldShare) S.errors.push(`${name}: ${(fs * 100).toFixed(1)}% of its triangles fold inside out (limit ${LIMITS.foldShare * 100}%)`);
    }
    if (span > LIMITS.span * size) err(`${name}: the posed body spans ${span.toFixed(2)} m against ${size.toFixed(2)} m at rest (something flies off)`);
    if (['idle', 'hold', 'act', 'hit'].includes(name) && box.min.y < -LIMITS.ground * h) err(`${name}: the body sinks ${(-box.min.y).toFixed(3)} m into the ground`);
    if (name === 'idle' && box.min.y > LIMITS.ground * h) err(`idle: the body floats ${box.min.y.toFixed(3)} m above the ground`);
    if (name === 'walk') {
      lowest = minY; touched = minY < LIMITS.ground * h && minY > -LIMITS.ground * h * 1.5;
      if (!touched && !(arch === 'flyer' && !info.legs)) err(`walk: the body ${minY < 0 ? `sinks ${(-minY).toFixed(3)} m into` : `never touches (lowest ${minY.toFixed(3)} m)`} the ground while it walks`);
      // does walking move anything? the largest bone travel against rest
      for (const [n, b] of rig.bones) moved = Math.max(moved, b.getWorldPosition(new THREE.Vector3()).applyMatrix4(frame).distanceTo(restBones.get(n)));
    }
    poses.push(rec);
  }
  if (moved < 0.01 * size) err(`walk: nothing moves (the bones travel ${moved.toFixed(4)} m): the skin is on bones the motion does not drive`);
  metrics.walkLowest = +lowest.toFixed(3);
  const parts = {};
  for (const p of PARTS) {
    const S = partStats[p];
    parts[p] = { na: !S.tris, ok: !S.errors.length, errors: [...new Set(S.errors)].slice(0, 4), warnings: [...new Set(S.warnings)].slice(0, 4), worst: S.worst, tris: S.tris };
    for (const e of parts[p].errors) err(`${PART_LABEL[p]}: ${e}`);
    if (parts[p].warnings.length) warn(`${PART_LABEL[p]}: ${parts[p].warnings[0]}${parts[p].warnings.length > 1 ? ` (+${parts[p].warnings.length - 1} more)` : ''}`);
  }
  return { ok: errors.length === 0, file, archetype: arch, rig: std.rig, errors, warnings, parts, poses, stats, metrics };
}

/** One line for a verdict: what failed. */
export function creatureSummary(r) {
  return r.ok ? `a ${r.archetype} on ${r.rig} that holds its shape in every action` : `${r.archetype ?? 'creature'}: ${r.errors.slice(0, 3).join('; ')}${r.errors.length > 3 ? ` (+${r.errors.length - 3} more)` : ''}`;
}
