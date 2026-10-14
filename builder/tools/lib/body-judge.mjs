// The model judge's measuring tier (creator, 2026-10-07: "We need to work on a model judge for 3 models. We need to look
// at face, body, arms, legs, hands, and feet. We also need to make sure any animation does not distort these. We just
// made a game where the models look good, but the hand is crooked"; research/foundations/evidence/
// studio-v2-crooked-hand-model-judge-request-2026-10-07.json). No browser: three.js in Node, as rig-check.
//
//   const r = await judgeBody('<body.glb>', { clips, rig, role, extraClips, clipNames });
//   // which clips: clipNames exactly; else clipsFor(role): the player's (all but NOT_PLAYED) or an enemy's (ENEMY_CLIPS),
//   // plus extraClips (what the game's rules play)
//   // { ok, parts: {face, body, arm_l, …, foot_r: {ok, na, verts, errors, warnings, worst, measures}}, errors, warnings, stats }
//
// The body is posed by the retarget a game runs (`rig`: the dev kit's kit/character/rig.js by default, or a game's
// vendored gf/three/character/rig.js), through the clips a role plays (all but NOT_PLAYED, or the clips named) at 6 times each, beside the clip's own
// skeleton (the standard, which the clips were made on), and judged per part. Errors fail the body; warnings are notes.
//
//   the model, at rest   every part has vertices; the hands match left and right; no finger rests bent sideways;
//                        each hand rests pointing where the clips expect a hand (else every clip shows a bent wrist);
//                        the toes point forward
//   face                 the front of the head moves with the head: a face that stretches when the head turns fails
//   hands                the palm stays flat: its vertices move with the hand, and a bone inside the palm barely bends;
//                        every finger joint bends as the clip's finger bends (flex and sideways, from rest), so no
//                        finger bends sideways or backward unless the clip's does
//   arms, legs           the upper arm, forearm, thigh and shin point where the clip's do
//   every part (warn)    triangles folded inside out (a crease folding through itself, an arm sinking into the torso)
//                        and edges stretched or crushed, past limits; a finger bent past what a finger can do
//
// Fingers are read from the bone chains under each hand by where their joints sit along the hand, not by their names:
// a joint less than 45% of the way from the wrist to the fingertips is inside the palm. That is how the creator's
// crooked hand shows: Quaternius rigs start every finger with a bone inside the palm, and gf-humanoid-1 mapped the clip's
// knuckle onto it, so the clip's knuckle curl and finger spread bent the palm (palm 21–24% of the hand's length off the
// hand, a bone inside it bent 102–115°, on all 12 Quaternius bodies; the clips' own body: 2%, no such bone).
import './char-node.mjs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { loadGLB, THREE, SkeletonUtils } from './char-three.mjs';
import { refFile } from '../../art/views.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export const DEV_RIG = resolve(here, '../../../runtimes/three/kit/character/rig.js');
export const DEFAULT_CLIPS = refFile('humanoid-clips/gf-humanoid-1');

/**
 * The clips no role plays unless its game asks for them: the judge leaves them out by default. The creator's roguelike
 * (2026-10-08) lost two generated golems and two bosses (4 Meshy runs, 41 credits each) because the face stretched in
 * `swim`, a clip no enemy of that game ever played. The kit itself never plays these (rules may: check 19 adds the clip
 * names a game's rules.js names, tools/lib/bodies-check.mjs). `clipNames` (model-judge --clips a,b,c) judges exactly
 * the clips named instead.
 */
export const NOT_PLAYED = Object.freeze(['swim', 'swim_idle', 'sit', 'crouch', 'crouch_walk', 'emote_wave', 'emote_cheer', 'emote_dance', 'emote_talk']);
/** The clips judged by default from a clip file's names: every clip a role may play (all but NOT_PLAYED). */
export const roleClips = names => names.filter(n => !NOT_PLAYED.includes(n));
/** What a role other than the player plays (the waves, boss and melee mechanics' enemies): locomotion, jump, hits,
 *  knockdown and get-up, punch and the melee clips (an enemy dodges with `dash`). Never aim, carry, interact, throw,
 *  pickup, push or roll. */
export const ENEMY_CLIPS = Object.freeze(['idle', 'walk', 'run', 'sprint', 'jump', 'fall', 'land', 'hit', 'hit_head', 'knockdown', 'getup', 'getup_front', 'punch',
  'slash_1', 'slash_2', 'slash_3', 'heavy', 'dash', 'block', 'cast', 'death', 'attack_enemy']);
/** The clips to judge a body on: `role` 'player' (or none) → roleClips; any other role → ENEMY_CLIPS; plus `extra` (the
 *  clip names a game's rules play), when the clip file has them. */
export function clipsFor(names, { role = null, extra = [] } = {}) {
  const base = role && role !== 'player' ? names.filter(n => ENEMY_CLIPS.includes(n)) : roleClips(names);
  return [...new Set([...base, ...extra.filter(n => names.includes(n))])].sort((a, b) => names.indexOf(a) - names.indexOf(b));
}

export const PARTS = ['face', 'body', 'arm_l', 'arm_r', 'hand_l', 'hand_r', 'leg_l', 'leg_r', 'foot_l', 'foot_r'];
export const PART_LABEL = { face: 'face', body: 'body', arm_l: 'left arm', arm_r: 'right arm', hand_l: 'left hand', hand_r: 'right hand',
  leg_l: 'left leg', leg_r: 'right leg', foot_l: 'left foot', foot_r: 'right foot' };

/** The limits (degrees unless named). Calibrated 2026-10-07 on the library's 18 bodies and the creator's Meshy caller. */
export const LIMITS = {
  frames: 6,                    // samples per clip
  palmAt: 0.45,                 // a joint nearer the wrist than this share of the hand's length is inside the palm
  palmBend: 20,                 // how far a bone inside the palm may bend from rest (flex or sideways)
  palmRigid: 0.06,              // RMS distance of the palm's vertices from the hand's own motion, over the hand's length
  fingerFlex: 30, fingerSide: 25,   // a finger joint's bend from rest, against the clip's finger's bend from rest
  thumbFlex: 40, thumbSide: 40,
  anatomy: { knuckle: [-35, 105], joint: [-25, 125], thumb: [-55, 110] },   // absolute flex, warn only (the clips' own fists reach 100°)
  restSide: 35,                 // at rest, a finger joint bent sideways this far is a crooked model
  handRest: [35, 50],           // at rest (lined up with the clips' arm), the hand's axis from the clips' hand: [warn, error]
  toesRest: [30, 50],           // at rest, the foot's heel-to-toe axis from forward, seen from above: [warn, error]
  limbDir: 15,                  // upper arm, forearm, thigh, shin: angle from the clip's
  faceRigid: 0.06,              // RMS distance of the face's vertices from the head's own motion, over the head's size
  folded: [0.08, 0.04],         // share of a part's triangles folded inside out: [warn for any part, warn for a hand]
  strain: 1.4,                  // |ln(edge length posed / rest)| at the part's 99th percentile, warn (1.4 ≈ ×4 or ×¼)
  symmetry: 1.4,                // left/right size (each of the two longest sorted extents) ratio: hands error, else warn
};

const deg = r => (r * 180) / Math.PI;
const V = () => new THREE.Vector3();
const angle = (a, b) => deg(a.angleTo(b));

/** Part of a canonical bone. */
export function partOf(name) {
  if (/^(Head|head_end|headfront)$/.test(name)) return 'face';
  if (/^(Hips|Spine02|Spine01|Spine|neck|LeftShoulder|RightShoulder)$/.test(name)) return 'body';
  const s = name.startsWith('Left') ? '_l' : name.startsWith('Right') ? '_r' : '';
  if (!s) return 'body';
  if (/Hand/.test(name)) return 'hand' + s;
  if (/(UpLeg|Leg)$/.test(name)) return 'leg' + s;
  if (/(Foot|ToeBase)$/.test(name)) return 'foot' + s;
  if (/(Arm|ForeArm)$/.test(name)) return 'arm' + s;
  return 'body';
}

const clipCache = new Map(), rigCache = new Map();
async function loadRig(path) { const k = resolve(path); if (!rigCache.has(k)) rigCache.set(k, import(pathToFileURL(k).href)); return rigCache.get(k); }
async function loadClips(path) { const k = resolve(path); if (!clipCache.has(k)) clipCache.set(k, loadGLB(k)); return clipCache.get(k); }

/**
 * Bends along one finger chain. pts: joint positions [wrist, j0, j1, …]; frame {f, a, n}: the palm's axes (along the
 * hand, across it toward the index, out of the palm); L: the hand's length. → [{i, u, flex, side}] for each joint that
 * has a segment after it (i: index in pts; u: how far along the hand it sits; flex: toward the palm +; side: across).
 * The segment into the first joint is wrist→j0 when j0 is at least a quarter of the hand from the wrist, else the hand's
 * axis. The frame travels down the finger: the side axis stays across the hand, the palm axis turns with each flex.
 */
export function chainBends(pts, frame, L) {
  const out = [];
  const w = pts[0];
  let x = pts[1].clone().sub(w);
  if (x.length() < 0.25 * L) x = frame.f.clone(); else x.normalize();
  let lat = frame.a.clone().sub(x.clone().multiplyScalar(frame.a.dot(x))).normalize();
  let n = x.clone().cross(lat);
  if (n.dot(frame.n) < 0) n.negate();
  const sign = Math.sign(x.clone().cross(lat).dot(n)) || 1;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = pts[i + 1].clone().sub(pts[i]);
    if (d.length() < 1e-5) continue;
    d.normalize();
    out.push({ i, u: pts[i].clone().sub(w).dot(frame.f) / L, flex: deg(Math.atan2(d.dot(n), d.dot(x))), side: deg(Math.asin(Math.max(-1, Math.min(1, d.dot(lat))))) });
    x = d;
    lat = lat.sub(x.clone().multiplyScalar(lat.dot(x))).normalize();
    n = x.clone().cross(lat).multiplyScalar(sign);
  }
  return out;
}

/** The palm's frame from a wrist and finger tips (or last joints): {f, a, n}, or null with fewer than two fingers. */
function palmFrame(w, tips, side) {
  const fingers = ['Index', 'Middle', 'Ring', 'Pinky'].filter(n => tips[n]);
  if (fingers.length < 2) return null;
  const f = fingers.reduce((acc, n) => acc.add(tips[n]), V()).multiplyScalar(1 / fingers.length).sub(w).normalize();
  const a = tips[fingers[0]].clone().sub(tips[fingers.at(-1)]); a.sub(f.clone().multiplyScalar(a.dot(f))).normalize();
  return { f, a, n: side === 'l' ? f.clone().cross(a) : a.clone().cross(f) };
}
const turn = (fr, q) => ({ f: fr.f.clone().applyQuaternion(q), a: fr.a.clone().applyQuaternion(q), n: fr.n.clone().applyQuaternion(q) });

/** Principal axis (largest spread) of points. */
function mainAxis(pts) {
  const c = pts.reduce((a, p) => a.add(p), V()).multiplyScalar(1 / pts.length);
  const m = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (const p of pts) { const d = p.clone().sub(c).toArray(); for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) m[i * 3 + j] += d[i] * d[j]; }
  let v = new THREE.Vector3(0.3, 0.2, 1).normalize();
  for (let k = 0; k < 40; k++) { const [x, y, z] = v.toArray(); v.set(m[0] * x + m[1] * y + m[2] * z, m[3] * x + m[4] * y + m[5] * z, m[6] * x + m[7] * y + m[8] * z); if (v.lengthSq() < 1e-20) break; v.normalize(); }
  return { axis: v, centre: c };
}

export async function judgeBody(file, { clips = DEFAULT_CLIPS, rig: rigPath = DEV_RIG, limits = {}, clipNames = null, role = null, extraClips = [] } = {}) {
  const rig = await loadRig(rigPath);
  const L_ = { ...LIMITS, ...limits };
  const g = await loadGLB(file);
  const root = g.scene;
  const found = rig.findRig(root);
  const parts = Object.fromEntries(PARTS.map(p => [p, { ok: true, na: false, verts: 0, errors: [], warnings: [], worst: null, measures: [] }]));
  const errors = [], warnings = [];
  const stats = { clips: 0, frames: 0 };
  const result = () => {
    for (const p of PARTS) parts[p].ok = parts[p].errors.length === 0;
    return { ok: errors.length === 0 && PARTS.every(p => parts[p].ok), file, parts, errors, warnings, stats };
  };
  if (!found.skinned.length) { errors.push('not rigged: no skinned mesh'); return result(); }
  const missing = rig.REQUIRED.filter(n => !found.bones.has(n));
  if (missing.length) { errors.push(`missing required bones: ${missing.join(', ')} (run rig-check)`); return result(); }

  const cg = await loadClips(clips);
  const std = rig.standardFrom(cg.scene);
  const rt = rig.createRetarget(root, std, { rig: found });   // also puts the body at its bind pose
  root.updateMatrixWorld(true);
  const B = n => found.bones.get(n);
  const wp = o => o.getWorldPosition(V());

  // ---------------------------------------------------------------- the skin at rest: each vertex's part
  const canonOf = new Map();
  const canonical = b => {
    if (canonOf.has(b)) return canonOf.get(b);
    let a = b; while (a && !(rig.isCanonical(a.name) && found.bones.get(a.name) === a)) a = a.parent;
    const n = a?.name ?? 'Hips'; canonOf.set(b, n); return n;
  };
  const meshes = found.skinned.map(m => {
    const si = m.geometry.attributes.skinIndex, sw = m.geometry.attributes.skinWeight, count = m.geometry.attributes.position.count;
    const dom = new Int32Array(count), part = new Array(count), rest = new Float32Array(count * 3), v = V();
    for (let i = 0; i < count; i++) {
      let best = -1, bw = -1;
      for (let k = 0; k < 4; k++) { const w = sw.getComponent(i, k); if (w > bw) { bw = w; best = si.getComponent(i, k); } }
      dom[i] = best;
      const bone = m.skeleton.bones[best];
      part[i] = bone ? partOf(canonical(bone)) : 'body';
      m.getVertexPosition(i, v); v.applyMatrix4(m.matrixWorld);
      rest.set([v.x, v.y, v.z], i * 3);
    }
    const idx = m.geometry.index ? m.geometry.index.array : Uint32Array.from({ length: count }, (_, i) => i);
    const tris = [];
    for (let t = 0; t + 2 < idx.length; t += 3) {
      const [a, b, c] = [idx[t], idx[t + 1], idx[t + 2]];
      tris.push([a, b, c, part[a] === part[b] || part[a] === part[c] ? part[a] : part[b] === part[c] ? part[b] : part[a]]);
    }
    return { m, count, dom, part, rest, tris };
  });
  const P = (mm, i, arr = mm.rest) => new THREE.Vector3(arr[i * 3], arr[i * 3 + 1], arr[i * 3 + 2]);
  const vertsOf = (pred) => { const out = []; meshes.forEach((mm, mi) => { for (let i = 0; i < mm.count; i++) if (pred(mm, i)) out.push([mm, mi, i]); }); return out; };
  for (const mm of meshes) for (let i = 0; i < mm.count; i++) parts[mm.part[i]].verts++;
  const triRest = meshes.map(mm => mm.tris.map(([a, b, c]) => {
    const A = P(mm, a), Bv = P(mm, b), C = P(mm, c);
    const nrm = Bv.clone().sub(A).cross(C.clone().sub(A)), area = nrm.length() / 2;
    return { n: area > 0 ? nrm.normalize() : nrm, area, e: [A.distanceTo(Bv), Bv.distanceTo(C), C.distanceTo(A)] };
  }));
  const meanArea = (() => { let s = 0, k = 0; for (const tr of triRest) for (const t of tr) { s += t.area; k++; } return k ? s / k : 0; })();
  const allBones = [...new Set(found.skinned.flatMap(m => m.skeleton.bones))].filter(Boolean);
  const restInv = new Map(allBones.map(b => [b, b.matrixWorld.clone().invert()]));

  // ---------------------------------------------------------------- the clips' own skeleton (the standard)
  const proxyRoot = SkeletonUtils.clone(cg.scene);
  const proxy = new Map(); proxyRoot.traverse(o => { if (std.bones.has(o.name) && !proxy.has(o.name)) proxy.set(o.name, o); });
  proxyRoot.updateMatrixWorld(true);
  const sp = n => (proxy.get(n) ? proxy.get(n).getWorldPosition(V()) : null);
  const sq = n => proxy.get(n).getWorldQuaternion(new THREE.Quaternion());
  const stdRestQInv = new Map([...proxy.keys()].map(n => [n, sq(n).invert()]));
  const FINGERS = ['Thumb', 'Index', 'Middle', 'Ring', 'Pinky'];

  // ---------------------------------------------------------------- recording
  const worst = new Map();
  const note = (part, what, level, value, ok, clip, t, detail) => {
    const key = `${part}|${what}`, w = worst.get(key), row = { part, what, level, value, ok, clip, t, detail };
    if (!w || (w.ok && !ok) || (w.ok === ok && value > w.value)) worst.set(key, row);
  };
  const restIssue = (part, level, text) => parts[part][level === 'error' ? 'errors' : 'warnings'].push(`at rest: ${text}`);

  // ---------------------------------------------------------------- the model at rest
  for (const p of PARTS) if (!parts[p].verts) {
    if (/^(hand|foot)/.test(p)) { parts[p].na = true; parts[p].warnings.push(`no vertex follows the ${PART_LABEL[p]}`); }
    else restIssue(p, 'error', `no vertex follows the ${PART_LABEL[p]}`);
  }
  const extents = p => { const b = new THREE.Box3(); for (const mm of meshes) for (let i = 0; i < mm.count; i++) if (mm.part[i] === p) b.expandByPoint(P(mm, i)); return b.isEmpty() ? null : b.getSize(V()).toArray().sort((x, y) => y - x); };
  for (const pair of [['arm_l', 'arm_r'], ['hand_l', 'hand_r'], ['leg_l', 'leg_r'], ['foot_l', 'foot_r']]) {
    const [el, er] = pair.map(extents), level = pair[0] === 'hand_l' ? 'error' : 'warn';
    if (!el || !er) { if (el || er) restIssue(el ? pair[1] : pair[0], level, `the ${PART_LABEL[el ? pair[1] : pair[0]]} has no vertices while the other side has ${(el ?? er).length ? 'some' : 'none'}`); continue; }
    const r = Math.max(...[0, 1].map(i => Math.max(el[i], er[i]) / Math.max(1e-4, Math.min(el[i], er[i]))));
    if (r > L_.symmetry) for (const p of pair) restIssue(p, level, `left and right differ in size ×${r.toFixed(2)} (limit ×${L_.symmetry}): ${pair.map((q, i) => `${PART_LABEL[q]} ${[el, er][i].slice(0, 2).map(x => x.toFixed(2)).join(' × ')} m`).join(', ')}${level === 'warn' ? ' (often a tail or cape weighted to one side)' : ''}`);
  }

  const hands = {};
  for (const [s, side] of [['l', 'Left'], ['r', 'Right']]) {
    const hand = B(`${side}Hand`), w0 = wp(hand);
    const chains = hand.children.filter(o => o.isBone).map(c => {
      const chain = [c]; for (let k = c; ;) { const nx = k.children.find(o => o.isBone); if (!nx) break; chain.push(nx); k = nx; }
      const finger = (chain.map(b => (rig.isCanonical(b.name) ? b.name : '')).join(' ').match(/Hand(Thumb|Index|Middle|Ring|Pinky)/) ?? [])[1] ?? null;
      return { chain, finger };
    });
    const H = { side, s, hand, chains, thumb: chains.find(c => c.finger === 'Thumb') };
    const handVerts = vertsOf((mm, i) => mm.part[i] === `hand_${s}`);
    // the hand at rest, lined up with the clips' arm (R), against the clips' hand: a wrist that rests bent stays bent
    if (handVerts.length) {
      const axis = handVerts.reduce((a, [mm, , i]) => a.add(P(mm, i)), V()).multiplyScalar(1 / handVerts.length).sub(w0).normalize();
      const lined = axis.clone().applyQuaternion(rt.R?.get(`${side}Hand`) ?? new THREE.Quaternion());
      const want = sp(`${side}HandMiddle1`) ? sp(`${side}HandMiddle1`).sub(sp(`${side}Hand`)) : sp(`${side}Hand`).sub(sp(`${side}ForeArm`));
      const d = angle(lined, want);
      if (d > L_.handRest[0]) restIssue(`hand_${s}`, d > L_.handRest[1] ? 'error' : 'warn', `the ${side.toLowerCase()} hand rests ${d.toFixed(0)}° off the line of its arm compared with the clips' hand (limit ${L_.handRest[1]}°): every clip shows the wrist bent`);
    }
    const tips = Object.fromEntries(chains.filter(c => c.finger).map(c => [c.finger, wp(c.chain.at(-1))]));
    H.frameRest = palmFrame(w0, tips, s);
    if (H.frameRest) {
      const f = H.frameRest.f;
      H.L = Math.max(...chains.map(c => wp(c.chain.at(-1)).sub(w0).dot(f)), ...handVerts.map(([mm, , i]) => P(mm, i).sub(w0).dot(f)));
      H.restBends = new Map(chains.map(c => [c, chainBends([w0, ...c.chain.map(wp)], H.frameRest, H.L)]));
      H.palmBones = new Set([hand, ...chains.filter(c => c !== H.thumb).flatMap(c => c.chain.filter(b => wp(b).sub(w0).dot(f) / H.L < L_.palmAt))]);
      H.palmVerts = vertsOf((mm, i) => H.palmBones.has(mm.m.skeleton.bones[mm.dom[i]]) && P(mm, i).sub(w0).dot(f) / H.L < 0.4);
      H.inPalm = chains.filter(c => c !== H.thumb).flatMap(c => H.restBends.get(c).filter(b => b.u < L_.palmAt).map(() => c.finger)).length;
      for (const c of chains) for (const b of H.restBends.get(c)) if (c !== H.thumb && b.u >= L_.palmAt && Math.abs(b.side) > L_.restSide)
        restIssue(`hand_${s}`, 'error', `the ${side.toLowerCase()} ${(c.finger ?? 'finger').toLowerCase()} bends ${Math.abs(b.side).toFixed(0)}° sideways at a joint ${(b.u * 100).toFixed(0)}% along the hand (limit ${L_.restSide}°): a crooked finger in the model itself`);
      // the clips' hand: its palm frame and finger chains at rest
      const sw0 = sp(`${side}Hand`);
      const sTips = Object.fromEntries(FINGERS.filter(F => sp(`${side}Hand${F}3`)).map(F => [F, sp(`${side}Hand${F}3`)]));
      H.stdFrame = palmFrame(sw0, sTips, s);
      if (H.stdFrame) {
        H.stdL = Math.max(...Object.values(sTips).map(p => p.clone().sub(sw0).dot(H.stdFrame.f)));
        H.stdChain = F => [1, 2, 3].map(i => `${side}Hand${F}${i}`).filter(n => proxy.has(n));
        H.stdRest = new Map(FINGERS.map(F => [F, chainBends([sw0, ...H.stdChain(F).map(sp)], H.stdFrame, H.stdL)]));
      }
    }
    // the toes point forward (ankle → toe bone; without a toe bone, the long axis of the foot's vertices), lined up with
    // the clips' leg, seen from above. Wide feet (a lizard's splayed toes) are longer across than along without a toe bone.
    const footVerts = vertsOf((mm, i) => mm.part[i] === `foot_${s}`).map(([mm, , i]) => P(mm, i));
    const ankle = wp(B(`${side}Foot`)), toe = B(`${side}ToeBase`);
    let axis = null;
    if (toe) axis = wp(toe).sub(ankle);
    else if (footVerts.length > 8) {
      const m = mainAxis(footVerts);
      axis = m.axis;
      // the axis has no sign: take it toward +Z, or, for a foot turned well out, toward where the foot lies from the ankle
      if (axis.dot(Math.abs(axis.z) >= 0.2 ? new THREE.Vector3(0, 0, 1) : m.centre.clone().sub(ankle).setY(0)) < 0) axis.negate();
    }
    if (axis) {
      axis.applyQuaternion(rt.R?.get(`${side}Foot`) ?? new THREE.Quaternion()).setY(0);
      if (axis.length() > 1e-3) {
        const d = angle(axis, new THREE.Vector3(0, 0, 1));
        if (d > L_.toesRest[0]) restIssue(`foot_${s}`, d > L_.toesRest[1] ? 'error' : 'warn', `the ${side.toLowerCase()} foot points ${d.toFixed(0)}° away from forward (limit ${L_.toesRest[1]}°)`);
      }
    }
    hands[s] = H;
  }
  const head = B('Head'), headY = wp(head).y;
  const faceVerts = vertsOf((mm, i) => mm.part[i] === 'face' && mm.rest[i * 3 + 1] >= headY);
  const headSize = (() => { const b = new THREE.Box3(); for (const [mm, , i] of faceVerts) b.expandByPoint(P(mm, i)); return b.isEmpty() ? 0.25 * rt.height : Math.max(...b.getSize(V()).toArray()); })();

  // ---------------------------------------------------------------- every clip
  const mixer = new THREE.AnimationMixer(proxyRoot);
  const motion = new Map(), rots = new Map(), tq = new THREE.Quaternion(), tv = V(), ts = V();
  const rotOf = b => { let q = rots.get(b); if (!q) { motion.get(b).decompose(tv, tq, ts); q = tq.clone(); rots.set(b, q); } return q; };
  const all = cg.animations.map(a => a.name);
  const names = clipNames ? all.filter(n => clipNames.includes(n)) : clipsFor(all, { role, extra: extraClips });
  stats.judged = names; stats.left = all.filter(n => !names.includes(n));
  if (clipNames) { const unknown = clipNames.filter(n => !all.includes(n)); if (unknown.length) warnings.push(`the clip file has no ${unknown.join(', ')}`); }
  const posed = meshes.map(mm => new Float32Array(mm.count * 3));
  for (const clipName of names) {
    const clip = cg.animations.find(a => a.name === clipName);
    stats.clips++;
    for (let fi = 0; fi < L_.frames; fi++) {
      const t = Math.min(clip.duration * (fi / (L_.frames - 1)), clip.duration - 1e-3), tt = +t.toFixed(2);
      mixer.stopAllAction(); mixer.clipAction(clip).reset().play(); mixer.setTime(t);
      proxyRoot.updateMatrixWorld(true);
      rt.apply(proxy);
      root.updateMatrixWorld(true);
      stats.frames++;
      rots.clear();
      for (const b of allBones) motion.set(b, b.matrixWorld.clone().multiply(restInv.get(b)));
      const v = V();
      meshes.forEach((mm, mi) => { const arr = posed[mi]; for (let i = 0; i < mm.count; i++) { mm.m.getVertexPosition(i, v); v.applyMatrix4(mm.m.matrixWorld); arr.set([v.x, v.y, v.z], i * 3); } });
      const dev = (list, bone) => { const T = motion.get(bone); let s2 = 0; for (const [mm, mi, i] of list) s2 += P(mm, i).applyMatrix4(T).distanceToSquared(P(mm, i, posed[mi])); return list.length ? Math.sqrt(s2 / list.length) : 0; };

      // -- the skin, every part (warnings): folded triangles, strain
      const flips = {}, tot = {}, strains = {};
      meshes.forEach((mm, mi) => {
        const arr = posed[mi];
        mm.tris.forEach(([a, b, c, p], ti) => {
          const r = triRest[mi][ti];
          if (r.area < 0.02 * meanArea) return;
          const A = P(mm, a, arr), Bv = P(mm, b, arr), C = P(mm, c, arr);
          const nrm = Bv.clone().sub(A).cross(C.clone().sub(A));
          const bone = mm.m.skeleton.bones[mm.dom[a]];
          tot[p] = (tot[p] ?? 0) + 1;
          if (nrm.lengthSq() > 0 && bone && nrm.normalize().dot(r.n.clone().applyQuaternion(rotOf(bone))) < 0) flips[p] = (flips[p] ?? 0) + 1;
          const e = [A.distanceTo(Bv), Bv.distanceTo(C), C.distanceTo(A)];
          (strains[p] ??= []).push(...e.map((x, k) => Math.abs(Math.log(Math.max(1e-6, x) / Math.max(1e-6, r.e[k])))));
        });
      });
      for (const p of PARTS) {
        if (!tot[p]) continue;
        const share = (flips[p] ?? 0) / tot[p], lim = /^hand/.test(p) ? L_.folded[1] : L_.folded[0];
        note(p, 'folded', 'warn', share, share <= lim, clipName, tt, `${(share * 100).toFixed(1)}% of its triangles fold inside out (limit ${(lim * 100).toFixed(0)}%)`);
        const st = strains[p].sort((x, y) => x - y), p99 = st[Math.floor(0.99 * (st.length - 1))];
        note(p, 'strain', 'warn', p99, p99 <= L_.strain, clipName, tt, `its edges stretch or crush ×${Math.exp(p99).toFixed(1)} (99th percentile; limit ×${Math.exp(L_.strain).toFixed(1)})`);
      }
      // -- the face moves with the head
      if (faceVerts.length) {
        const r = dev(faceVerts, head) / headSize;
        note('face', 'rigid', 'error', r, r <= L_.faceRigid, clipName, tt, `the face stretches: its vertices move ${(r * 100).toFixed(1)}% of the head's size away from the head (RMS; limit ${(L_.faceRigid * 100).toFixed(0)}%)`);
      }
      for (const [s, side] of [['l', 'Left'], ['r', 'Right']]) {
        // -- limbs point where the clip's limbs point
        for (const [a, b, part, what] of [[`${side}Arm`, `${side}ForeArm`, `arm_${s}`, 'upper arm'], [`${side}ForeArm`, `${side}Hand`, `arm_${s}`, 'forearm'], [`${side}UpLeg`, `${side}Leg`, `leg_${s}`, 'thigh'], [`${side}Leg`, `${side}Foot`, `leg_${s}`, 'shin']]) {
          if (!sp(a) || !sp(b)) continue;
          const d = angle(wp(B(b)).sub(wp(B(a))), sp(b).sub(sp(a)));
          note(part, `${what} aim`, 'error', d, d <= L_.limbDir, clipName, tt, `the ${side.toLowerCase()} ${what} points ${d.toFixed(0)}° away from the clip's (limit ${L_.limbDir}°)`);
        }
        // -- the hand
        const H = hands[s];
        if (!H.frameRest || !parts[`hand_${s}`].verts) continue;
        const part = `hand_${s}`, lc = side.toLowerCase();
        if (H.palmVerts.length) {
          const r = dev(H.palmVerts, H.hand) / H.L;
          note(part, 'palm', 'error', r, r <= L_.palmRigid, clipName, tt, `the ${lc} palm bends: its vertices move ${(r * 100).toFixed(1)}% of the hand's length off the hand (RMS; limit ${(L_.palmRigid * 100).toFixed(0)}%)`);
        }
        const frame = turn(H.frameRest, rotOf(H.hand)), w = wp(H.hand);
        const sFrame = H.stdFrame && turn(H.stdFrame, sq(`${side}Hand`).multiply(stdRestQInv.get(`${side}Hand`)));
        for (const c of H.chains) {
          const now = chainBends([w, ...c.chain.map(wp)], frame, H.L), rest = H.restBends.get(c);
          const thumb = c === H.thumb, name = `${lc} ${(c.finger ?? 'finger').toLowerCase()}`;
          const sNow = sFrame && c.finger ? chainBends([sp(`${side}Hand`), ...H.stdChain(c.finger).map(sp)], sFrame, H.stdL) : null;
          const sRest = sNow && H.stdRest.get(c.finger);
          let k = 0;
          for (const b of now) {
            const r = rest.find(x => x.i === b.i); if (!r) continue;
            const dFlex = b.flex - r.flex, dSide = b.side - r.side;
            if (!thumb && r.u < L_.palmAt) {
              const bend = Math.max(Math.abs(dFlex), Math.abs(dSide));
              note(part, 'palm joint', 'error', bend, bend <= L_.palmBend, clipName, tt, `the ${name}'s bone inside the palm (${(r.u * 100).toFixed(0)}% along the hand) bends ${bend.toFixed(0)}° (limit ${L_.palmBend}°): the palm folds`);
              continue;
            }
            const where = thumb ? `joint ${k + 1}` : k === 0 ? 'knuckle' : `joint ${k + 1}`;
            const [lo, hi] = thumb ? L_.anatomy.thumb : k === 0 ? L_.anatomy.knuckle : L_.anatomy.joint;
            const over = Math.max(0, b.flex - hi, lo - b.flex);
            note(part, 'finger anatomy', 'warn', over, over === 0, clipName, tt, `the ${name} bends ${b.flex.toFixed(0)}° at its ${where} (a finger bends ${lo}° to ${hi}°)`);
            const s1 = sNow?.[k], s0 = sRest?.[k];
            if (s1 && s0) {
              const eFlex = Math.abs(dFlex - (s1.flex - s0.flex)), eSide = Math.abs(dSide - (s1.side - s0.side));
              const [lf, ls] = thumb ? [L_.thumbFlex, L_.thumbSide] : [L_.fingerFlex, L_.fingerSide];
              note(part, 'finger flex', 'error', eFlex, eFlex <= lf, clipName, tt, `the ${name}'s ${where} bends ${dFlex.toFixed(0)}° where the clip's bends ${(s1.flex - s0.flex).toFixed(0)}° (off by ${eFlex.toFixed(0)}°, limit ${lf}°)`);
              note(part, 'finger side', 'error', eSide, eSide <= ls, clipName, tt, `the ${name}'s ${where} bends ${dSide.toFixed(0)}° sideways where the clip's bends ${(s1.side - s0.side).toFixed(0)}° (off by ${eSide.toFixed(0)}°, limit ${ls}°): a crooked finger`);
            }
            k++;
          }
        }
      }
    }
  }
  mixer.stopAllAction();
  rig.poseToBind(root, found);

  // ---------------------------------------------------------------- verdicts per part
  for (const w of worst.values()) {
    const p = parts[w.part];
    const row = { what: w.what, level: w.level, value: +w.value.toFixed(4), ok: w.ok, clip: w.clip, t: w.t, detail: w.detail };
    p.measures.push(row);
    if (!w.ok) p[w.level === 'error' ? 'errors' : 'warnings'].push(`${w.clip} at ${w.t} s: ${w.detail}`);
  }
  for (const p of PARTS) {
    const ms = parts[p].measures;
    parts[p].worst = ms.find(m => !m.ok && m.level === 'error') ?? ms.find(m => !m.ok) ?? null;
  }
  stats.hands = Object.fromEntries(Object.entries(hands).map(([s, H]) => [s, { fingers: H.chains.filter(c => c.finger && c !== H.thumb).length, thumb: !!H.thumb, palmJoints: H.inPalm ?? 0 }]));
  stats.retarget = { legScale: +rt.k.toFixed(3), ...(rt.fingers ? { fingers: rt.fingers } : {}) };
  return result();
}

/** One line per part, "PASS face", "FAIL left hand: …", and a line per warning when `warnings`. */
export function judgeLines(r, { warnings = false } = {}) {
  const out = [];
  for (const p of PARTS) {
    const x = r.parts[p];
    out.push(`${x.na ? 'n/a ' : x.ok ? 'PASS' : 'FAIL'}  ${PART_LABEL[p]}${x.errors.length ? `: ${x.errors[0]}${x.errors.length > 1 ? ` (+${x.errors.length - 1} more)` : ''}` : ''}`);
    if (warnings) for (const w of x.warnings) out.push(`        warn: ${w}`);
  }
  for (const e of r.errors) out.push(`FAIL  ${e}`);
  return out;
}

/** A short summary for a verdict line: "left hand: idle at 0.4 s: … ; right hand: …" (errors only, first per part). */
export function judgeSummary(r) {
  return [...r.errors, ...PARTS.filter(p => !r.parts[p].ok).map(p => `${PART_LABEL[p]}: ${r.parts[p].errors[0]}`)].join('; ');
}
