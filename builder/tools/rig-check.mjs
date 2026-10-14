#!/usr/bin/env node
// rig-check.mjs: does a GLB work as a gf-humanoid-1 body, or as a body on one of the archetype standards beside it
// (worm, blob, quadruped, flyer: kit/character/CREATURES.md, judged by tools/lib/creature-judge.mjs)? Passes or fails it,
// with reasons.
//
//   node builder/tools/rig-check.mjs <body.glb> [--clips <clip file>] [--archetype worm|blob|quadruped|flyer] [--json]
//   import { rigCheck } from './rig-check.mjs'; const r = await rigCheck(path);   // { ok, errors, warnings, stats, metrics }
//
// It loads the body with three.js's own GLTFLoader (as the game will), then checks:
//   bones     the required gf-humanoid-1 bones by name, and their parents (kit/character/RIG.md §2)
//   scale     metres: standing height 0.5–3 m; Y up; facing +Z (left side on +X); feet on the ground
//   skin      every vertex weighted, weights sum to 1, at most 4 influences, limbs carry weight
//   clips     the shared clip file binds, and posing the body with it through the runtime retarget gives a sane
//             skinned mesh (feet on the ground in idle and walk, hands below the shoulders, nothing flies off)
//   budget    file size, triangles, textures, joints (RIG.md §7)
//   judge     the model judge's measuring tier (tools/lib/body-judge.mjs; creator 2026-10-07: "the models look good, but the
//             hand is crooked"): face, body, arms, hands, legs and feet hold their shape at rest and in every clip. Its
//             errors are rig-check errors ("model judge, left hand: …"), so a generated or uploaded body that a clip
//             distorts is refused like a body without bones; { judge: false } skips it. It judges the clips a role plays
//             (body-judge.mjs clipsFor): { role: 'enemy' } (meshy-character --enemy) what enemies play, else the player's
import { isMain } from './lib/main.mjs';
import './lib/char-node.mjs';
import { readFileSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { io } from './lib/char-deps.mjs';
import { loadGLB, THREE, SkeletonUtils } from './lib/char-three.mjs';
import { bodyStats } from './lib/char-gltf.mjs';
import { refFile } from '../art/views.mjs';

const rig = await import('../../runtimes/three/kit/character/rig.js');
const here = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_CLIPS = refFile('humanoid-clips/gf-humanoid-1');

/** RIG.md §7. Errors refuse the body; warnings are reported. */
export const BUDGET = {
  bytes: { warn: 2.5e6, error: 6e6 },
  triangles: { warn: 30000, error: 60000 },
  texturePx: { warn: 1024, error: 2048 },
  joints: { warn: 90, error: 160 },
  materials: { warn: 8, error: 24 },
};

const clipCache = new Map();
async function loadClips(path) {
  if (!clipCache.has(path)) clipCache.set(path, loadGLB(path));
  return clipCache.get(path);
}

/** The archetype a body file names (its gf_body node's extras gfArchetype or gfRig), else null (a gf-humanoid-1 body). */
export function archetypeOfDoc(doc) {
  const x = doc.getRoot().listNodes().find(n => n.getName() === 'gf_body')?.getExtras() ?? {};
  const a = x.gfArchetype ?? (typeof x.gfRig === 'string' ? { 'gf-worm-1': 'worm', 'gf-blob-1': 'blob', 'gf-quadruped-1': 'quadruped', 'gf-flyer-1': 'flyer' }[x.gfRig] : null);
  return a && a !== 'humanoid' ? a : null;
}

/**
 * A body on one of the archetype standards beside gf-humanoid-1 (worm, blob, quadruped, flyer: CREATURES.md) is judged
 * by the creature judge (tools/lib/creature-judge.mjs): its standard's bones, scale, skin, and every action posed by the
 * runtime's own procedural motion. `archetype` names it; else the file's gf_body extras do.
 */
export async function rigCheck(file, { clips = DEFAULT_CLIPS, judge = true, role = null, archetype = null } = {}) {
  const errors = [], warnings = [], metrics = {};
  const err = m => errors.push(m), warn = m => warnings.push(m);
  const bytes = statSync(file).size;
  let doc;
  try { doc = await (await io()).read(file); } catch (e) { return { ok: false, file, errors: [`not a readable glTF/GLB: ${e.message}`], warnings, stats: { bytes }, metrics }; }
  const arch = archetype && archetype !== 'humanoid' ? archetype : archetype === 'humanoid' ? null : archetypeOfDoc(doc);
  if (arch) {
    const { judgeCreature } = await import('./lib/creature-judge.mjs');
    const r = await judgeCreature(file, { archetype: arch });
    return { ok: r.ok, file, archetype: r.archetype, rig: r.rig, errors: r.errors, warnings: r.warnings, stats: r.stats ?? { bytes }, metrics: r.metrics ?? {},
      judge: r.parts && Object.keys(r.parts).length ? { ok: r.ok, parts: Object.fromEntries(Object.entries(r.parts).map(([p, v]) => [p, v.na ? 'n/a' : v.ok ? 'pass' : 'fail'])) } : null, poses: r.poses };
  }
  const stats = bodyStats(doc, bytes);

  // ---- budget
  const over = (v, b, what, unit = '') => { if (v > b.error) err(`${what} ${v}${unit} is over the limit ${b.error}${unit}`); else if (v > b.warn) warn(`${what} ${v}${unit} is over the target ${b.warn}${unit}`); };
  over(bytes, BUDGET.bytes, 'file size', ' B');
  over(Math.round(stats.triangles), BUDGET.triangles, 'triangles');
  over(stats.joints, BUDGET.joints, 'joints');
  over(stats.materials, BUDGET.materials, 'materials');
  for (const t of stats.textures) if (t.size) over(Math.max(...t.size), BUDGET.texturePx, `texture (${t.mime})`, ' px');
  for (const m of doc.getRoot().listMaterials()) {
    if (m.getEmissiveTexture() && m.getEmissiveTexture() === m.getBaseColorTexture()) warn(`material ${m.getName()}: emissive map is the albedo (Meshy's glow): run optimize.mjs`);
  }
  if (stats.animations.length) warn(`the body carries ${stats.animations.length} animation(s) of its own; the kit ignores them (clips come from the shared clip file)`);
  if (stats.skins > 1) {
    const js = doc.getRoot().listSkins().map(s => s.listJoints().map(j => j.getName()).join());
    if (new Set(js).size > 1) err('several skins with different joints: the body must be one skeleton');
  }
  // raw weights (three's GLTFLoader re-binds an unweighted vertex to joint 0, so this is read from the file itself)
  let rawZero = 0, rawBad = 0;
  for (const m of doc.getRoot().listMeshes()) for (const p of m.listPrimitives()) {
    if (p.getAttribute('JOINTS_1')) err(`mesh ${m.getName()}: more than 4 influences per vertex (JOINTS_1); three.js reads 4`);
    const W = p.getAttribute('WEIGHTS_0');
    if (!W) continue;
    const w = [];
    for (let i = 0; i < W.getCount(); i++) {
      W.getElement(i, w);
      const s = w[0] + w[1] + w[2] + w[3];
      if (!(s > 1e-4)) rawZero++; else if (Math.abs(s - 1) > 0.02 || w.some(x => !Number.isFinite(x) || x < 0)) rawBad++;
    }
  }
  if (rawZero) err(`${rawZero} vertices have no skin weight (three.js would pin them to the first joint)`);
  if (rawBad) err(`${rawBad} vertices have weights that are negative, NaN or don't sum to 1`);

  // ---- load as the game will
  let g;
  try { g = await loadGLB(file); } catch (e) { err(`three.js could not load it: ${e.message}`); return { ok: false, file, errors, warnings, stats, metrics }; }
  const root = g.scene;
  const found = rig.findRig(root);
  if (!found.skinned.length) { err('not rigged: no skinned mesh'); return { ok: false, file, errors, warnings, stats, metrics }; }
  const has = n => found.bones.has(n);
  const missing = rig.REQUIRED.filter(n => !has(n));
  if (missing.length) {
    const raw = []; root.traverse(o => { if (o.isBone) raw.push(o.name); });
    const alias = rig.canonicalNames(raw);
    const fixable = missing.every(n => [...alias.values()].includes(n));
    err(`missing required bones: ${missing.join(', ')}${fixable ? ' (another rig\'s names: run `optimize.mjs --normalize` to rename them)' : ''}`);
    return { ok: false, file, errors, warnings, stats, metrics };
  }
  // parents: each canonical bone's nearest canonical ancestor must be the standard one
  for (const [n, bone] of found.bones) {
    if (n === 'Hips') continue;
    let a = bone.parent; while (a && !(rig.isCanonical(a.name) && found.bones.get(a.name) === a)) a = a.parent;
    const want = rig.canonicalParent(n, has);
    if ((a?.name ?? null) !== want) err(`bone ${n} hangs under ${a?.name ?? 'nothing'}; gf-humanoid-1 wants ${want}`);
  }
  const notJoint = rig.REQUIRED.filter(n => !found.skinned.some(m => m.skeleton.bones.includes(found.bones.get(n))));
  if (notJoint.length) err(`bones not in the skin: ${notJoint.join(', ')}`);
  if (errors.length) return { ok: false, file, errors, warnings, stats, metrics };

  // ---- bind pose: units, up, facing, ground
  const bp = rig.bindPose(root, found);
  const P = n => bp.pos.get(n);
  const box = rig.bindBox(root, found, undefined, bp.frames);
  if (bp.spread > 1e-3) warn(`the file's bones are not at the bind pose (largest difference ${bp.spread.toFixed(3)}); the kit resets them to bind`);
  const height = box.max.y - box.min.y;
  metrics.height = +height.toFixed(3);
  metrics.ground = +box.min.y.toFixed(3);
  if (!(height >= 0.5 && height <= 3)) err(`standing height ${height.toFixed(3)} m: bodies are in metres, 0.5–3 m tall (centimetres? run optimize.mjs --normalize)`);
  else if (height < 0.9 || height > 2.2) warn(`standing height ${height.toFixed(2)} m is unusual (players are about 1–2 m)`);
  if (!(P('Head').y > P('Hips').y && P('Hips').y > P('LeftFoot').y && P('Hips').y > P('RightFoot').y)) err('not Y-up: the head must be above the hips and the hips above the feet');
  const leftX = (P('LeftArm').x - P('RightArm').x) + (P('LeftUpLeg').x - P('RightUpLeg').x);
  if (leftX <= 0) err('faces -Z (its left side is on -X): gf-humanoid-1 faces +Z with its left on +X (optimize.mjs --normalize turns it)');
  if (has('LeftToeBase') && has('RightToeBase')) {
    const toes = (P('LeftToeBase').z - P('LeftFoot').z) + (P('RightToeBase').z - P('RightFoot').z);
    if (toes <= 0) err('the toes point to -Z: facing is wrong');
  }
  if (Math.abs(box.min.y) > 0.05 * height) warn(`feet are ${box.min.y.toFixed(3)} m off the ground (y=0); the kit compensates`);
  const mid = P('LeftFoot').clone().add(P('RightFoot')).multiplyScalar(0.5);
  if (Math.hypot(mid.x, mid.z) > 0.25) warn(`the feet stand ${Math.hypot(mid.x, mid.z).toFixed(2)} m from the origin`);
  for (const [n, b] of found.bones) {
    const s = new THREE.Vector3(); bp.bind.get(b)?.decompose(new THREE.Vector3(), new THREE.Quaternion(), s);
    if (bp.bind.get(b) && (Math.abs(s.x - s.y) > 1e-3 || Math.abs(s.y - s.z) > 1e-3)) err(`bone ${n} has a non-uniform scale at bind`);
  }

  // ---- skin weights
  const limb = ['LeftArm', 'LeftForeArm', 'RightArm', 'RightForeArm', 'LeftUpLeg', 'LeftLeg', 'RightUpLeg', 'RightLeg', 'Hips', 'Head'];
  const weightOf = new Map();
  let bad = 0, zero = 0, verts = 0;
  for (const m of found.skinned) {
    const si = m.geometry.attributes.skinIndex, sw = m.geometry.attributes.skinWeight;
    if (!si || !sw) { err(`mesh ${m.name}: no skin weights`); continue; }
    const nb = m.skeleton.bones.length;
    for (let i = 0; i < si.count; i++) {
      verts++;
      let sum = 0;
      for (let k = 0; k < 4; k++) {
        const w = sw.getComponent(i, k), j = si.getComponent(i, k);
        if (!Number.isFinite(w) || w < 0) { bad++; continue; }
        if (w > 0 && j >= nb) { bad++; continue; }
        sum += w;
        if (w > 0) { const b = m.skeleton.bones[j]; weightOf.set(b, (weightOf.get(b) ?? 0) + w); }
      }
      if (sum < 1e-4) zero++; else if (Math.abs(sum - 1) > 0.02) bad++;
    }
  }
  metrics.vertices = verts;
  if (zero) err(`${zero} vertices have no skin weight (they would stay behind when the body moves)`);
  if (bad) err(`${bad} vertices have broken weights (NaN, negative, out-of-range joint, or not summing to 1)`);
  const unweighted = limb.filter(n => !(weightOf.get(found.bones.get(n)) > 0));
  if (unweighted.length) warn(`no vertex follows ${unweighted.join(', ')} (that part will not move)`);

  // ---- clips: bind and pose
  let cg;
  try { cg = await loadClips(clips); } catch (e) { err(`clip file ${clips}: ${e.message}`); return { ok: false, file, errors, warnings, stats, metrics }; }
  const meta = cg.scene.getObjectByName('gf_humanoid_1')?.userData?.gfClips ?? {};
  const names = cg.animations.map(a => a.name);
  const lacking = rig.CLIPS.filter(n => !names.includes(n));
  if (lacking.length) err(`clip file lacks ${lacking.join(', ')}`);
  const std = rig.standardFrom(cg.scene);
  let rt;
  try { rt = rig.createRetarget(root, std, { rig: found }); } catch (e) { err(`retarget: ${e.message}`); return { ok: false, file, errors, warnings, stats, metrics }; }
  metrics.legScale = +rt.k.toFixed(3);
  metrics.swingDeg = Object.fromEntries([...rt.swing].filter(([n, d]) => rig.SWING[n] && d > 0.5).map(([n, d]) => [n, +d.toFixed(1)]));
  for (const [n, d] of Object.entries(metrics.swingDeg)) if (d > 70) warn(`${n} rests ${d}° away from the standard's T-pose; it is lined up at runtime, which stretches the skin there`);
  const unbound = [];
  for (const a of cg.animations) for (const t of a.tracks) { const bn = THREE.PropertyBinding.parseTrackName(t.name).nodeName; if (!std.bones.has(bn)) unbound.push(t.name); }
  if (unbound.length) err(`${unbound.length} clip tracks target bones outside the standard skeleton (e.g. ${unbound[0]})`);
  metrics.boundBones = rt.order.length;

  const proxyRoot = SkeletonUtils.clone(cg.scene);
  const proxy = new Map(); proxyRoot.traverse(o => { if (std.bones.has(o.name) && !proxy.has(o.name)) proxy.set(o.name, o); });
  const mixer = new THREE.AnimationMixer(proxyRoot);
  const v = new THREE.Vector3();
  const poseAt = (clipName, frac) => {
    const clip = cg.animations.find(a => a.name === clipName);
    mixer.stopAllAction();
    const act = mixer.clipAction(clip); act.reset().play(); act.paused = false;
    mixer.setTime(Math.min(clip.duration * frac, clip.duration - 1e-3));
    rt.apply(proxy);
    root.updateMatrixWorld(true);
    const b = new THREE.Box3();
    const pts = (n) => { const o = found.bones.get(n); return o ? o.getWorldPosition(new THREE.Vector3()) : null; };
    for (const m of found.skinned) for (let i = 0; i < m.geometry.attributes.position.count; i += 3) { m.getVertexPosition(i, v); v.applyMatrix4(m.matrixWorld); b.expandByPoint(v); }
    return { box: b, pts };
  };
  const checks = [];
  for (const [clipName, frac] of [['idle', 0], ['walk', 0.25], ['walk', 0.75], ['run', 0.3], ['aim', 0.5], ['carry', 0.5]]) {
    if (!names.includes(clipName)) continue;
    const { box: b, pts } = poseAt(clipName, frac);
    const h = b.max.y - b.min.y;
    const feetOff = b.min.y - box.min.y;
    const r = { clip: clipName, at: frac, height: +h.toFixed(3), feetOffGround: +feetOff.toFixed(3) };
    if (['idle', 'walk'].includes(clipName) && Math.abs(feetOff) > 0.08 * height) err(`${clipName}: the feet end up ${feetOff.toFixed(2)} m from the ground (the body's proportions don't fit the clips)`);
    if (clipName === 'idle') {
      if (h < 0.8 * height || h > 1.15 * height) err(`idle: posed height ${h.toFixed(2)} m vs rest ${height.toFixed(2)} m`);
      for (const s of ['Left', 'Right']) if (pts(s + 'Hand').y > pts(s + 'Arm').y) err(`idle: ${s.toLowerCase()} hand is above the shoulder (arm swing wrong)`);
      if (pts('Head').y < pts('Hips').y) err('idle: head below the hips');
    }
    const far = Math.max(b.max.x - b.min.x, b.max.z - b.min.z);
    if (far > 2.5 * height) err(`${clipName}: the posed mesh spans ${far.toFixed(2)} m (something flew off)`);
    checks.push(r);
  }
  metrics.poses = checks;
  metrics.clips = names.length;

  // ---- the model judge: every part, every clip
  let verdict = null;
  if (judge && !errors.length) {
    const { judgeBody, PARTS, PART_LABEL } = await import('./lib/body-judge.mjs');
    const j = await judgeBody(file, { clips, role });
    verdict = { ok: j.ok, parts: Object.fromEntries(PARTS.map(p => [p, j.parts[p].na ? 'n/a' : j.parts[p].ok ? 'pass' : 'fail'])), stats: j.stats };
    for (const e of j.errors) err(`model judge: ${e}`);
    for (const p of PARTS) {
      for (const e of j.parts[p].errors) err(`model judge, ${PART_LABEL[p]}: ${e}`);
      if (j.parts[p].warnings.length) warn(`model judge, ${PART_LABEL[p]}: ${j.parts[p].warnings[0]}${j.parts[p].warnings.length > 1 ? ` (+${j.parts[p].warnings.length - 1} more)` : ''}`);
    }
  }
  return { ok: errors.length === 0, file, errors, warnings, stats, metrics, judge: verdict, clipMeta: Object.keys(meta).length };
}

if (isMain(import.meta)) {
  const args = process.argv.slice(2);
  const files = args.filter(a => !a.startsWith('--') && !['--clips', '--archetype'].includes(args[args.indexOf(a) - 1]));
  const ci = args.indexOf('--clips'), ai = args.indexOf('--archetype');
  if (!files.length) { console.error('usage: rig-check.mjs <body.glb> [...] [--clips file] [--json]'); process.exit(2); }
  let fail = 0;
  const out = [];
  for (const f of files) {
    const r = await rigCheck(resolve(f), { ...(ci > 0 ? { clips: resolve(args[ci + 1]) } : {}), ...(ai >= 0 ? { archetype: args[ai + 1] } : {}) });
    out.push(r);
    if (!r.ok) fail++;
    if (!args.includes('--json')) {
      console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${f}  ${r.rig ? `${r.rig}, ` : ''}${(r.stats.bytes / 1e6).toFixed(2)} MB, ${Math.round(r.stats.triangles ?? 0)} tris, ${r.stats.joints ?? 0} joints${r.metrics.height ? `, ${r.metrics.height} m` : ''}`);
      for (const e of r.errors) console.log(`  error: ${e}`);
      for (const w of r.warnings) console.log(`  warn:  ${w}`);
    }
  }
  if (args.includes('--json')) console.log(JSON.stringify(out.length === 1 ? out[0] : out, null, 1));
  process.exit(fail ? 1 : 0);
}
