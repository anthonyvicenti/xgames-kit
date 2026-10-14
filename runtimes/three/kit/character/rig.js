// gf-humanoid-1: the games.fun character standard (RIG.md). Shared by the runtime (character.js) and the Node tools
// (rig-check, retarget, bean, meshy-character), so it imports only 'three'.
//
// How one clip set drives every body:
//   The shared clip file (library/clips/gf-humanoid-1.glb) animates a *standard skeleton*: canonical bone names, every
//   joint's rest rotation is identity (frames aligned with the character: +X left, +Y up, +Z forward), rest pose is
//   the UAL T-pose. A clip value is therefore "how far this bone has turned from the T-pose, in character axes".
//   A body keeps its own mesh, rest pose and bone frames. At load we measure, per canonical bone b:
//     B(b)  the bone's bind rotation in character space,
//     R(b)  a swing that lines the body's limb up with the standard's limb (an A-pose arm becomes a T-pose arm);
//           own swing for upper arm, forearm, thigh and shin; hands, fingers, feet and toes inherit their parent's.
//   Each frame, with D(b) = the standard bone's world rotation from the clip:
//     world(b) = D(b) * R(b) * B(b),   local(b) = world(parent)^-1 * world(b)
//   and the hips' position is the standard's, scaled by the body's leg length. Two constant quaternions per bone.
import * as THREE from 'three';

export const RIG = 'gf-humanoid-1';

/** The clip names every gf-humanoid-1 clip file carries (CONTRACT §4.4). */
export const CLIPS = ['idle', 'walk', 'run', 'jump', 'fall', 'land', 'hit', 'knockdown', 'getup', 'aim', 'carry', 'interact', 'emote_wave', 'emote_cheer'];
/** The melee clips the standard clip file carries since 2026-10-08 (KayKit, RIG.md §4). Not required at load: a game
 *  whose clip file predates them still loads, and the melee mechanic falls back when a name is missing. */
export const MELEE_CLIPS = ['slash_1', 'slash_2', 'slash_3', 'heavy', 'dash', 'block', 'cast', 'death', 'attack_enemy'];

const side = (s, list) => list.map(([n, p, req]) => [s + n, p && p.replace('$', s), req]);
const FINGERS = ['Thumb', 'Index', 'Middle', 'Ring', 'Pinky'];
const fingerBones = s => FINGERS.flatMap(f => [1, 2, 3].map(i => [`${s}Hand${f}${i}`, i === 1 ? `${s}Hand` : `${s}Hand${f}${i - 1}`, false]));

/** [name, canonical parent, required]. Names are what Meshy's auto-rig emits (Mixamo-style), plus Mixamo finger names. */
export const BONES = [
  ['Hips', null, true],
  ['Spine02', 'Hips', false],
  ['Spine01', 'Spine02', false],
  ['Spine', 'Spine01', true],
  ['neck', 'Spine', false],
  ['Head', 'neck', true],
  ['head_end', 'Head', false],
  ['headfront', 'Head', false],
  ...['Left', 'Right'].flatMap(s => [
    ...side(s, [['Shoulder', 'Spine', false], ['Arm', '$Shoulder', true], ['ForeArm', '$Arm', true], ['Hand', '$ForeArm', true]])
      .map(([n, p, r]) => [n, p === `${s}Spine` ? 'Spine' : p, r]),
    ...fingerBones(s),
    ...side(s, [['UpLeg', 'Hips', true], ['Leg', '$UpLeg', true], ['Foot', '$Leg', true], ['ToeBase', '$Foot', false]])
      .map(([n, p, r]) => [n, p === `${s}Hips` ? 'Hips' : p, r]),
  ]),
];
export const BONE_NAMES = BONES.map(b => b[0]);
export const REQUIRED = BONES.filter(b => b[2]).map(b => b[0]);
export const PARENT = Object.fromEntries(BONES.map(([n, p]) => [n, p]));
const CANON = new Set(BONE_NAMES);
export const isCanonical = n => CANON.has(n);

/** Bones whose rest direction is matched to the standard (own swing), and the child that defines the direction. */
export const SWING = { LeftArm: 'LeftForeArm', LeftForeArm: 'LeftHand', RightArm: 'RightForeArm', RightForeArm: 'RightHand',
  LeftUpLeg: 'LeftLeg', LeftLeg: 'LeftFoot', RightUpLeg: 'RightLeg', RightLeg: 'RightFoot' };
/** Bones that take their parent's swing (so wrists and ankles don't bend when an arm or leg is lined up). */
export const INHERIT = new Set(['LeftHand', 'RightHand', 'LeftFoot', 'RightFoot', 'LeftToeBase', 'RightToeBase',
  ...['Left', 'Right'].flatMap(s => FINGERS.flatMap(f => [1, 2, 3].map(i => `${s}Hand${f}${i}`)))]);

/** A finger whose bone 1 sits nearer the wrist than this share of bone 2's distance starts inside the palm (createRetarget). */
export const PALM_FIRST = 0.45;
const FINGER_SEG = /^((?:Left|Right)Hand(?:Index|Middle|Ring|Pinky))([123])$/;

/** Upper-body mask for overlay clips (aim, carry, hit, interact, throw): spine above the hips, arms, head. */
export const UPPER = new Set(BONE_NAMES.filter(n => !/^(Hips|Spine02|(Left|Right)(UpLeg|Leg|Foot|ToeBase))$/.test(n)));

/** Sockets: name → bone and where on it (RIG.md §5). */
export const SOCKETS = { head: 'Head', hand_r: 'RightHand', hand_l: 'LeftHand', back: 'Spine' };

/** Ragdoll parts: [part, bone that the body drives, bone at the far end of the segment, joint to parent part]. */
export const RAGDOLL = [
  ['pelvis', 'Hips', ['Spine02', 'Spine01', 'Spine'], null],
  ['torso', 'Spine', ['neck', 'Head'], 'pelvis'],
  ['head', 'Head', ['head_end'], 'torso'],
  ['upperarm_l', 'LeftArm', ['LeftForeArm'], 'torso'],
  ['forearm_l', 'LeftForeArm', ['LeftHand'], 'upperarm_l'],
  ['upperarm_r', 'RightArm', ['RightForeArm'], 'torso'],
  ['forearm_r', 'RightForeArm', ['RightHand'], 'upperarm_r'],
  ['thigh_l', 'LeftUpLeg', ['LeftLeg'], 'pelvis'],
  ['shin_l', 'LeftLeg', ['LeftFoot'], 'thigh_l'],
  ['thigh_r', 'RightUpLeg', ['RightLeg'], 'pelvis'],
  ['shin_r', 'RightLeg', ['RightFoot'], 'thigh_r'],
];

// ---------------------------------------------------------------- name normalisation (other rigs → canonical)
const SIDE = { L: 'Left', R: 'Right', l: 'Left', r: 'Right', Left: 'Left', Right: 'Right' };
/** Maps another rig's bone names to canonical ones. Returns Map(original → canonical). Unmapped names are absent. */
export function canonicalNames(names) {
  const out = new Map();
  const has = n => names.includes(n);
  const strip = n => n.replace(/^mixamorig\d*[:_]?/, '').replace(/^Armature[:_|]/, '');
  const set = (from, to) => { if (from != null && !out.has(from) && ![...out.values()].includes(to)) out.set(from, to); };
  // 1. Meshy / gf-humanoid-1 already
  for (const n of names) if (CANON.has(n)) set(n, n);
  // 2. Mixamo (Spine, Spine1, Spine2: lowest first) and Neck/HeadTop_End
  const mixamo = names.some(n => /^(mixamorig\d*[:_]?)?Spine[12]$/.test(n));
  for (const n of names) {
    const s = strip(n);
    if (mixamo && s === 'Spine') set(n, 'Spine02');
    else if (mixamo && s === 'Spine1') set(n, 'Spine01');
    else if (mixamo && s === 'Spine2') set(n, 'Spine');
    else if (s === 'Neck') set(n, 'neck');
    else if (s === 'HeadTop_End') set(n, 'head_end');
    else if (s !== n && CANON.has(s)) set(n, s);
  }
  // 3. Rigify DEF- (Quaternius UAL)
  const rigify = { 'DEF-hips': 'Hips', 'DEF-spine.001': 'Spine02', 'DEF-spine.002': 'Spine01', 'DEF-spine.003': 'Spine', 'DEF-neck': 'neck', 'DEF-head': 'Head' };
  for (const [a, b] of Object.entries(rigify)) if (has(a)) set(a, b);
  for (const n of names) {
    let m = n.match(/^DEF-(shoulder|upper_arm|forearm|hand|thigh|shin|foot|toe)\.([LR])$/);
    if (m) set(n, SIDE[m[2]] + { shoulder: 'Shoulder', upper_arm: 'Arm', forearm: 'ForeArm', hand: 'Hand', thigh: 'UpLeg', shin: 'Leg', foot: 'Foot', toe: 'ToeBase' }[m[1]]);
    m = n.match(/^DEF-(thumb|f_index|f_middle|f_ring|f_pinky)\.0([123])\.([LR])$/);
    if (m) set(n, `${SIDE[m[3]]}Hand${{ thumb: 'Thumb', f_index: 'Index', f_middle: 'Middle', f_ring: 'Ring', f_pinky: 'Pinky' }[m[1]]}${m[2]}`);
  }
  // 4. Quaternius (Hips, Abdomen, Torso, Chest, Neck, Head, Shoulder.L, UpperArm.L, LowerArm.L, Wrist.L, UpperLeg.L, ...)
  const q = n => n.replace(/[.](L|R)$/, '_$1');
  for (const n of names) {
    const m = q(n).match(/^(Shoulder|UpperArm|LowerArm|Wrist|UpperLeg|LowerLeg|Foot|Toe|Toes)_(L|R)$/);
    if (m) set(n, SIDE[m[2]] + { Shoulder: 'Shoulder', UpperArm: 'Arm', LowerArm: 'ForeArm', Wrist: 'Hand', UpperLeg: 'UpLeg', LowerLeg: 'Leg', Foot: 'Foot', Toe: 'ToeBase', Toes: 'ToeBase' }[m[1]]);
    const f = q(n).match(/^(Thumb|Index|Middle|Ring|Pinky)([123])_(L|R)$/);
    if (f) set(n, `${SIDE[f[3]]}Hand${f[1]}${f[2]}`);
  }
  if (has('Abdomen') || has('Torso') || has('Chest')) {
    // the chest is whatever parents the neck; the bones between it and the hips fill Spine01/Spine02 from the top
    const chain = ['Chest', 'Torso', 'Abdomen'].filter(has);
    const [chest, ...below] = chain;
    set(chest, 'Spine');
    below.forEach((n, i) => set(n, ['Spine01', 'Spine02'][i]));
  }
  // A rig with no wrist bone (some Quaternius ones hang the fingers off LowerArm) has no LeftHand: rig-check refuses it.
  return out;
}

// ---------------------------------------------------------------- analysis of a loaded body (three objects)
const _m = new THREE.Matrix4(), _m2 = new THREE.Matrix4(), _v = new THREE.Vector3(), _q = new THREE.Quaternion(), _s = new THREE.Vector3();

/** Finds the skinned meshes and canonical bones under `root` (a GLTFLoader scene or a SkeletonUtils clone).
 *  Skeleton joints win over other nodes with the same name. */
export function findRig(root) {
  const skinned = [];
  root.traverse(o => { if (o.isSkinnedMesh) skinned.push(o); });
  const bones = new Map();
  for (const m of skinned) for (const b of m.skeleton.bones) if (b && CANON.has(b.name) && !bones.has(b.name)) bones.set(b.name, b);
  root.traverse(o => { if (CANON.has(o.name) && !bones.has(o.name) && !o.isMesh) bones.set(o.name, o); });
  return { skinned, bones };
}

/** Matrix of `o` relative to `root` (root's own transform excluded), from the current local transforms. */
export function relMatrix(o, root, target = new THREE.Matrix4()) {
  target.identity();
  const chain = [];
  for (let n = o; n && n !== root; n = n.parent) chain.push(n);
  for (let i = chain.length - 1; i >= 0; i--) { chain[i].updateMatrix(); target.multiply(chain[i].matrix); }
  return target;
}

/**
 * The bind pose of a body in character space (the space of `root` when the GLB was loaded).
 * Returns { bind: Map(bone → Matrix4), pos: Map(name → Vector3), rot: Map(name → Quaternion), frame, spread }.
 * three.js skins a vertex as boneWorld · boneInverse · bindMatrix · v. The bind frame those inverses live in is not
 * always character space: gltf-transform's quantize folds the dequantisation into the IBMs. So the frame is recovered
 * from the hips: frame = hipsNodeWorld · boneInverse(hips) (identity for an unquantised file whose nodes rest at the
 * bind pose), and every bind matrix is frame · inverse(boneInverse). `spread` is how far the other bones' frames
 * disagree (a file saved in a pose that isn't its bind pose).
 */
export function bindPose(root, rig = findRig(root)) {
  const inv = new Map();
  for (const mesh of rig.skinned) {
    const sk = mesh.skeleton;
    sk.bones.forEach((b, i) => { if (b && !inv.has(b)) inv.set(b, sk.boneInverses[i]); });
  }
  const hips = rig.bones.get('Hips');
  const hipsRest = hips ? relMatrix(hips, root) : null;
  const frameOf = (bi) => (hipsRest && bi ? hipsRest.clone().multiply(bi) : new THREE.Matrix4());
  const frame = frameOf(inv.get(hips));
  // per skinned mesh: gltf-transform quantises each mesh into its own volume and gives it its own skin
  const frames = new Map(rig.skinned.map(m => [m, frameOf(m.skeleton.boneInverses[m.skeleton.bones.indexOf(hips)])]));
  let spread = 0;
  const e = frame.elements;
  for (const [b, bi] of inv) {
    const f = relMatrix(b, root).multiply(bi).elements;
    for (let i = 0; i < 16; i++) spread = Math.max(spread, Math.abs(f[i] - e[i]));
  }
  const bind = new Map();
  for (const [b, bi] of inv) bind.set(b, frame.clone().multiply(bi.clone().invert()));
  const pos = new Map(), rot = new Map();
  for (const [name, bone] of rig.bones) {
    const m = bind.get(bone) ?? relMatrix(bone, root);
    m.decompose(_v, _q, _s);
    pos.set(name, _v.clone()); rot.set(name, _q.clone());
  }
  return { bind, pos, rot, frame, frames, spread, mesh: rig.skinned[0] ?? null };
}

/** Puts every bone of the body at its bind pose (local transforms from the bind matrices). Non-bone parents keep theirs. */
export function poseToBind(root, rig = findRig(root), bp = bindPose(root, rig)) {
  const bones = [...bp.bind.keys()];
  const depth = o => { let d = 0; for (let n = o; n && n !== root; n = n.parent) d++; return d; };
  bones.sort((a, b) => depth(a) - depth(b));
  const world = new Map();
  for (const bone of bones) {
    const w = bp.bind.get(bone);
    const pw = bone.parent && bp.bind.has(bone.parent) ? bp.bind.get(bone.parent) : relMatrix(bone.parent, root);
    _m.copy(pw).invert().multiply(w);
    _m.decompose(bone.position, bone.quaternion, bone.scale);
    world.set(bone, w);
  }
  root.updateMatrixWorld(true);
}

/** Bind-pose vertex positions of every skinned mesh in character space → Box3 (and optional per-vertex callback).
 *  `frames`: a bindPose().frames map, or one Matrix4 for every mesh. */
export function bindBox(root, rig = findRig(root), each, frames = bindPose(root, rig).frames) {
  const box = new THREE.Box3();
  for (const mesh of rig.skinned) {
    const g = mesh.geometry, p = g.attributes.position;
    _m2.copy(frames instanceof Map ? frames.get(mesh) : frames).multiply(mesh.bindMatrix);
    for (let i = 0; i < p.count; i++) {
      _v.fromBufferAttribute(p, i).applyMatrix4(_m2);
      box.expandByPoint(_v);
      if (each) each(_v, mesh, i);
    }
  }
  return box;
}

/** Nearest canonical ancestor that the body actually has. */
export function canonicalParent(name, has) {
  for (let p = PARENT[name]; p; p = PARENT[p]) if (has(p)) return p;
  return null;
}

// ---------------------------------------------------------------- the standard skeleton (proxy) from the clip file
/**
 * Reads the standard skeleton out of a loaded clip file scene: Map(name → Object3D) and rest positions (character
 * space). The standard's rest rotations are identity, so rest positions are sums of local translations.
 */
export function standardFrom(clipRoot) {
  const bones = new Map();
  clipRoot.traverse(o => { if (CANON.has(o.name) && !bones.has(o.name)) bones.set(o.name, o); });
  if (!bones.has('Hips')) throw new Error('gf-humanoid-1 clip file has no Hips');
  const rest = new Map();
  const walk = (o, acc) => { const p = acc.clone().add(o.position); if (CANON.has(o.name)) rest.set(o.name, p); for (const c of o.children) walk(c, p); };
  walk(bones.get('Hips'), new THREE.Vector3());
  const ground = clipRoot.userData?.gfGround ?? 0;
  return { bones, rest, ground, hipsHeight: rest.get('Hips').y - ground };
}

// ---------------------------------------------------------------- the retarget (standard pose → body pose)
/**
 * Builds the per-body constants and returns apply(proxyBones) that writes the body's bone transforms from the
 * standard skeleton's current pose. `proxy` is a Map(name → Object3D) of a standard skeleton (a clone per character).
 *   body: { root, rig: findRig(root) }   std: standardFrom(clipScene)
 * Options: { pinXZ: false }. Returns { apply, k, ground, height, swing: Map(name → degrees), missing: [], order: [] }.
 */
export function createRetarget(root, std, { rig = findRig(root) } = {}) {
  const bp = bindPose(root, rig);
  poseToBind(root, rig, bp);
  const has = n => rig.bones.has(n);
  const missing = REQUIRED.filter(n => !has(n));
  if (missing.length) throw new Error(`gf-humanoid-1: body is missing ${missing.join(', ')}`);
  const order = BONE_NAMES.filter(has);   // topological: BONES lists parents first
  const box = bindBox(root, rig, undefined, bp.frames);
  const ground = box.min.y;
  const height = box.max.y - box.min.y;
  // leg scale: how high this body's hips stand once its legs are lined up with the standard's (straight down),
  // over the standard's hip height. A body resting with its legs apart reaches lower than its bind hip height.
  const reach = (P, g) => {
    const side = s => P(`${s}UpLeg`).distanceTo(P(`${s}Leg`)) + P(`${s}Leg`).distanceTo(P(`${s}Foot`)) + (P(`${s}Foot`).y - g) + (P('Hips').y - P(`${s}UpLeg`).y);
    return (side('Left') + side('Right')) / 2;
  };
  const stdReach = std.rest.has('LeftUpLeg') ? reach(n => std.rest.get(n), std.ground) : std.hipsHeight;
  const k = reach(n => bp.pos.get(n), ground) / stdReach;

  // finger chains (RIG.md §2, "Fingers"): which standard bone drives each body bone. The standard's finger 1 is the
  // knuckle. A rig whose finger 1 sits inside the palm (Quaternius: Index1 0.028 m from the wrist, the knuckle Index2,
  // the tip a fourth bone) is shifted one bone outward: finger 1 rides with the hand, 2 takes the clip's 1, 3 its 2 and
  // the bone after 3 its 3. Mapped by name, the clip's knuckle curl and spread bent the palm and the real knuckles took
  // the middle joints' curl (creator, Token Call Centre, 2026-10-07: "the hand is crooked"). gf_body extras
  // gfFingers: "by-name" turns this off for a rig the measure reads wrongly.
  const driver = new Map(order.map(n => [n, n]));
  const driven = [];   // non-standard bones a shifted chain drives (its tips): {key, bone, driver, parent}
  const tipPos = new Map();   // bone 3 of a shifted chain → its tip's bind position (the end of its segment)
  const fingers = {};
  const byName = root.getObjectByName?.('gf_body')?.userData?.gfFingers === 'by-name';
  for (const s of ['Left', 'Right']) for (const f of ['Index', 'Middle', 'Ring', 'Pinky']) {
    const [n1, n2, n3] = [1, 2, 3].map(i => `${s}Hand${f}${i}`);
    if (byName || !has(n1) || !has(n2) || !has(`${s}Hand`)) continue;
    const w = bp.pos.get(`${s}Hand`), d1 = bp.pos.get(n1).distanceTo(w), d2 = bp.pos.get(n2).distanceTo(w);
    if (!(d2 > 0 && d1 / d2 < PALM_FIRST)) continue;
    driver.set(n1, `${s}Hand`); driver.set(n2, n1);
    if (has(n3)) {
      driver.set(n3, n2);
      const tip = rig.bones.get(n3).children.find(o => o.isBone && !CANON.has(o.name) && bp.bind.has(o));
      if (tip) { driven.push({ key: `${n3}>tip`, bone: tip, driver: n3, parent: n3 }); tipPos.set(n3, new THREE.Vector3().setFromMatrixPosition(bp.bind.get(tip))); }
    }
    (fingers[s] ??= []).push(f);
  }
  // R(b): own swing or inherited
  const R = new Map(), swingDeg = new Map();
  for (const n of BONE_NAMES) {
    if (!has(n)) continue;
    let r = new THREE.Quaternion();
    const child = SWING[n];
    if (child && has(child) && std.rest.has(n) && std.rest.has(child)) {
      const db = _v.copy(bp.pos.get(child)).sub(bp.pos.get(n)).normalize().clone();
      const ds = std.rest.get(child).clone().sub(std.rest.get(n)).normalize();
      if (db.lengthSq() > 0 && ds.lengthSq() > 0) r.setFromUnitVectors(db, ds);
    } else if (INHERIT.has(n)) {
      const p = canonicalParent(n, has);
      if (p && R.has(p)) r.copy(R.get(p));
      // a finger (not the thumb) also lines each segment up with the clips' finger, on top of the hand's swing: a hand
      // whose fingers rest fanned apart (Quaternius, ~18° at the knuckles) otherwise closes a fist into a loose claw
      const fm = FINGER_SEG.exec(n), dn = driver.get(n), sm = dn && FINGER_SEG.exec(dn);
      if (fm && sm) {
        const next = has(`${fm[1]}${+fm[2] + 1}`) ? bp.pos.get(`${fm[1]}${+fm[2] + 1}`) : tipPos.get(n);
        const sNext = std.rest.get(`${sm[1]}${+sm[2] + 1}`);
        if (next && sNext && std.rest.has(dn)) {
          const db = next.clone().sub(bp.pos.get(n)).applyQuaternion(r).normalize();
          const ds = sNext.clone().sub(std.rest.get(dn)).normalize();
          if (db.lengthSq() > 0 && ds.lengthSq() > 0) r.premultiply(_q.setFromUnitVectors(db, ds));
        }
      }
    }
    R.set(n, r);
    swingDeg.set(n, THREE.MathUtils.radToDeg(2 * Math.acos(Math.min(1, Math.abs(r.w)))));
  }
  // constants: C(b) = R(b) B(b); for each bone, its parent either a canonical bone (dynamic) or a static node
  const C = new Map(), parentOf = new Map(), staticParentInv = new Map(), staticParentMat = new Map();
  for (const n of order) {
    C.set(n, R.get(n).clone().multiply(bp.rot.get(n)));
    const bone = rig.bones.get(n);
    const p = bone.parent && CANON.has(bone.parent.name) && rig.bones.get(bone.parent.name) === bone.parent ? bone.parent.name : null;
    parentOf.set(n, p);
    if (!p) {
      const pm = bone.parent ? relMatrix(bone.parent, root) : new THREE.Matrix4();
      pm.decompose(_v, _q, _s);
      staticParentInv.set(n, _q.clone().invert());
      staticParentMat.set(n, pm.clone().invert());
    }
  }
  for (const t of driven) { bp.bind.get(t.bone).decompose(_v, _q, _s); C.set(t.key, R.get(t.parent).clone().multiply(_q)); }
  const D = new Map(order.map(n => [n, new THREE.Quaternion()]));
  const W = new Map([...order, ...driven.map(t => t.key)].map(n => [n, new THREE.Quaternion()]));
  const stdWorld = new Map();
  const stdOrder = BONE_NAMES.filter(n => std.bones.has(n));
  const hipsPos = new THREE.Vector3(), tmpQ = new THREE.Quaternion();
  const hipsLift = std.hipsHeight / stdReach;   // the standard's own hips over its straight-leg reach (≈ 1)

  /** Standard world rotations from a proxy (Map name → Object3D), accumulated down the canonical tree. */
  function standardWorld(proxy) {
    for (const n of stdOrder) {
      const o = proxy.get(n);
      const p = PARENT[n] && canonicalParent(n, x => proxy.has(x));
      const w = stdWorld.get(n) ?? new THREE.Quaternion();
      if (p) w.copy(stdWorld.get(p)).multiply(o.quaternion); else w.copy(o.quaternion);
      stdWorld.set(n, w);
    }
    return stdWorld;
  }

  // gfSpineBend (body root extras, 0–1, default 1): how much of the clip's spine bend a body takes. A one-piece body
  // (a bean) folds at the waist under full human spine motion, so beans use about 0.4.
  const spineBend = root.getObjectByName?.('gf_body')?.userData?.gfSpineBend ?? 1;
  const SPINE = ['Spine02', 'Spine01', 'Spine', 'neck', 'Head'];
  const _rel = new THREE.Quaternion(), _hq = new THREE.Quaternion(), _I = new THREE.Quaternion();
  function apply(proxy, { pinXZ = false } = {}) {
    const sw = standardWorld(proxy);
    if (spineBend < 1 && sw.has('Hips')) {
      _hq.copy(sw.get('Hips'));
      for (const n of SPINE) { const d = sw.get(n); if (!d) continue; _rel.copy(_hq).invert().multiply(d).slerp(_I, 1 - spineBend); d.copy(_hq).multiply(_rel); }
    }
    for (const n of order) {
      const dn = driver.get(n);
      const d = sw.get(dn) ?? sw.get(canonicalParent(dn, x => sw.has(x)));
      W.get(n).copy(d).multiply(C.get(n));
      const bone = rig.bones.get(n), p = parentOf.get(n);
      if (p) bone.quaternion.copy(tmpQ.copy(W.get(p)).invert().multiply(W.get(n)));
      else bone.quaternion.copy(staticParentInv.get(n)).multiply(W.get(n));
    }
    for (const t of driven) {
      W.get(t.key).copy(sw.get(t.driver) ?? W.get(t.parent)).multiply(C.get(t.key));
      t.bone.quaternion.copy(tmpQ.copy(W.get(t.parent)).invert().multiply(W.get(t.key)));
    }
    // hips position: the standard's (character space), legs scaled, feet on this body's ground
    const sh = proxy.get('Hips').position;
    hipsPos.set(pinXZ ? 0 : sh.x * k, ground + (sh.y - std.ground) * k * hipsLift, pinXZ ? 0 : sh.z * k);
    const hips = rig.bones.get('Hips');
    if (parentOf.get('Hips')) hips.position.copy(hipsPos); else hips.position.copy(hipsPos.applyMatrix4(staticParentMat.get('Hips')));
  }
  return { apply, k, ground, height, swing: swingDeg, missing, order, bind: bp, R, C, world: W, standardWorld, spineBend, fingers, driver };
}
