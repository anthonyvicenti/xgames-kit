// Body archetypes beside gf-humanoid-1 (CREATURES.md): worm/serpent, blob, quadruped and flyer. Each is a rig standard
// (bones, names, rest pose) that the runtime (creature.js, motion.js) and the Node tools (rig-check, the creature judge,
// autorig) share, so this file imports only 'three'.
//
// Every standard keeps the humanoid's space: metres, +Y up, the body faces +Z with its own left on +X, the origin on the
// ground under the body. A body's joints rest unrotated in the character's axes (autorig writes them so), and the
// skinned meshes sit under one root node `gf_body` whose extras name the standard: { gfRig: 'gf-blob-1', gfArchetype }.
// A creature plays no clip file: it is posed each frame by procedural motion from the same words a humanoid's clips
// answer (ACTION_OF), so the controller, the net's poses and every mechanic drive it unchanged.
import * as THREE from 'three';

/** The archetypes a body may be. 'humanoid' is gf-humanoid-1 (rig.js, RIG.md); the rest are this file's. */
export const ARCHETYPES = ['humanoid', 'worm', 'blob', 'quadruped', 'flyer'];
/** Archetype → rig standard id. */
export const RIG_OF = { humanoid: 'gf-humanoid-1', worm: 'gf-worm-1', blob: 'gf-blob-1', quadruped: 'gf-quadruped-1', flyer: 'gf-flyer-1' };
/** Rig standard id → archetype. */
export const ARCHETYPE_OF = Object.fromEntries(Object.entries(RIG_OF).map(([a, r]) => [r, a]));
export const isCreature = a => !!a && a !== 'humanoid' && ARCHETYPES.includes(a);

/** The actions procedural motion answers: the families the humanoid clips cover (CREATURES.md §3). */
export const ACTIONS = ['idle', 'move', 'air', 'act', 'hit', 'down', 'celebrate', 'hold'];
/** A word the kit or a game plays (a humanoid clip name, the controller's state words) → the creature's action. */
export const ACTION_OF = {
  idle: 'idle', walk: 'move', run: 'move', sprint: 'move', crouch_walk: 'move', push: 'act', swim: 'move', swim_idle: 'idle',
  jump: 'air', fall: 'air', land: 'air', roll: 'act', dash: 'act',
  punch: 'act', throw: 'act', slash_1: 'act', slash_2: 'act', slash_3: 'act', heavy: 'act', attack_enemy: 'act', cast: 'act',
  interact: 'act', pickup: 'act', aim: 'hold', aim_up: 'hold', aim_down: 'hold', carry: 'hold', block: 'hold',
  hit: 'hit', hit_head: 'hit', knockdown: 'down', death: 'down', down: 'down', getup: 'idle', getup_front: 'idle',
  emote_wave: 'celebrate', emote_cheer: 'celebrate', emote_dance: 'celebrate', emote_talk: 'idle', cheer: 'celebrate', wave: 'celebrate',
  celebrate: 'celebrate', act: 'act', attack: 'act', move: 'move', air: 'air', hold: 'hold', sit: 'idle', crouch: 'idle',
};
/** How long a one-shot action lasts (s) when nothing else says. */
export const ACTION_SECONDS = { act: 0.55, hit: 0.42, celebrate: 1.6 };
/** Every word a creature answers: what its `clips` list says, so a game asking `c.clips.includes(word)` gets a truthful yes. */
export const CREATURE_WORDS = Object.keys(ACTION_OF);

const sides = (list) => ['Left', 'Right'].flatMap(s => list.map(([n, p, req]) => [s + n, p ? p.replace('$', s) : p, req]));
const frontBack = (list) => ['Front', 'Back'].flatMap(fb => ['Left', 'Right'].flatMap(s => list.map(([n, p, req]) => [fb + s + n, p.replace('$', fb + s).replace('@', fb === 'Front' ? 'Chest' : 'Hips'), req])));

/**
 * The standards: { rig, archetype, describe, bones: [[name, parent, required]], sockets: {name: bone}, minHeight, maxHeight }.
 * Parents are canonical: a missing optional bone's children hang under its nearest present ancestor (as in RIG.md §2).
 */
export const STANDARDS = {
  blob: {
    rig: 'gf-blob-1', archetype: 'blob',
    describe: 'a round body that is mostly one mass (a slime, a jelly, an egg-shaped critter, a puffball): squash and stretch, jiggle, hops; small feet and hand nubs optional',
    bones: [
      ['Root', null, true],
      ['Body', 'Root', true],            // the base of the mass, on the ground: squash and stretch pivot here
      ['Top', 'Body', true],             // the upper mass (about 55% up): it lags and jiggles
      ['Head', 'Top', false],            // a head that is its own lump (optional): it looks about
      ['LeftHand', 'Body', false], ['RightHand', 'Body', false],
      ['LeftFoot', 'Body', false], ['RightFoot', 'Body', false],   // under the Body: they hop and tip with it
    ],
    sockets: { head: 'Top', hand_l: 'LeftHand', hand_r: 'RightHand', back: 'Top' },
    minHeight: 0.2, maxHeight: 4,
  },
  worm: {
    rig: 'gf-worm-1', archetype: 'worm',
    describe: 'a long body that is a chain (a worm standing up, a snake or serpent lying down, an eel, a caterpillar): a travelling wave crawls it, squash and stretch along it',
    bones: [
      ['Root', null, true],
      ...Array.from({ length: 12 }, (_, i) => [`Seg${i}`, i === 0 ? 'Root' : `Seg${i - 1}`, i < 3]),   // Seg0 is the tail end
      ['Head', 'Seg11', true],           // hangs under the last segment there is
      ['Jaw', 'Head', false],
    ],
    sockets: { head: 'Head', hand_l: 'Head', hand_r: 'Head', back: 'Seg1' },
    minHeight: 0.1, maxHeight: 6,
  },
  quadruped: {
    rig: 'gf-quadruped-1', archetype: 'quadruped',
    describe: 'a body on four legs (a dog, a cat, a horse, a lizard, a beetle on four): a gait (walk, trot, gallop) with planted feet, a head and a tail',
    bones: [
      ['Root', null, true],
      ['Hips', 'Root', true],
      ['Spine', 'Hips', false],
      ['Chest', 'Spine', true],
      ['Neck', 'Chest', false],
      ['Head', 'Neck', true],
      ['Jaw', 'Head', false],
      ['LeftEar', 'Head', false], ['RightEar', 'Head', false],
      ['Tail0', 'Hips', false], ['Tail1', 'Tail0', false], ['Tail2', 'Tail1', false],
      ...frontBack([['UpLeg', '@', true], ['Leg', '$UpLeg', true], ['Foot', '$Leg', true]]),
    ],
    sockets: { head: 'Head', hand_l: 'Head', hand_r: 'Head', back: 'Spine' },
    minHeight: 0.15, maxHeight: 5,
  },
  flyer: {
    rig: 'gf-flyer-1', archetype: 'flyer',
    describe: 'a body with wings (a bird, a bat, a bee, a dragonling): flaps to fly, glides when falling, folds its wings to stand',
    bones: [
      ['Root', null, true],
      ['Body', 'Root', true],
      ['Neck', 'Body', false],
      ['Head', 'Neck', true],
      ...sides([['Wing1', 'Body', true], ['Wing2', '$Wing1', true], ['Wing3', '$Wing2', false]]),
      ['Tail', 'Body', false],
      ...sides([['Leg', 'Body', false], ['Foot', '$Leg', false]]),
    ],
    sockets: { head: 'Head', hand_l: 'LeftLeg', hand_r: 'RightLeg', back: 'Body' },
    minHeight: 0.1, maxHeight: 5,
  },
};
for (const s of Object.values(STANDARDS)) {
  s.names = s.bones.map(b => b[0]);
  s.required = s.bones.filter(b => b[2]).map(b => b[0]);
  s.parent = Object.fromEntries(s.bones.map(([n, p]) => [n, p]));
  s.isCanonical = n => s.parent[n] !== undefined;
}
// a worm's head hangs under its last segment, whichever that is
STANDARDS.worm.parentOf = (n, has) => (n === 'Head' ? [...Array(12).keys()].reverse().map(i => `Seg${i}`).find(has) ?? 'Root' : null);

/** The standard for an archetype or a rig id ('blob' or 'gf-blob-1'), or null. */
export function standardOf(x) {
  const a = STANDARDS[x] ? x : ARCHETYPE_OF[x];
  return a && STANDARDS[a] ? STANDARDS[a] : null;
}

/** The nearest present canonical ancestor a bone should hang under (missing optional bones are skipped). */
export function canonicalParent(std, name, has) {
  const own = std.parentOf?.(name, has);
  if (own) return own;
  let p = std.parent[name];
  while (p && !has(p)) p = std.parent[p];
  return p ?? null;
}

/** The archetype a loaded model says it is (gf_body extras gfArchetype or gfRig), or null. */
export function archetypeOfModel(root) {
  const x = root?.getObjectByName?.('gf_body')?.userData ?? {};
  if (x.gfArchetype && ARCHETYPES.includes(x.gfArchetype)) return x.gfArchetype;
  if (x.gfRig && ARCHETYPE_OF[x.gfRig]) return ARCHETYPE_OF[x.gfRig];
  return null;
}

/** Skinned meshes and the standard's bones under `root` (skeleton joints win over other nodes of the same name). */
export function findCreatureRig(root, std) {
  const skinned = [];
  root.traverse(o => { if (o.isSkinnedMesh) skinned.push(o); });
  const bones = new Map();
  for (const m of skinned) for (const b of m.skeleton.bones) if (std.isCanonical(b.name) && !bones.has(b.name)) bones.set(b.name, b);
  root.traverse(o => { if (std.isCanonical(o.name) && !bones.has(o.name) && (o.isBone || o.type === 'Bone')) bones.set(o.name, o); });
  return { skinned, bones };
}

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _v = new THREE.Vector3(), _s = new THREE.Vector3();

/**
 * The bind pose in the body's own frame (the `gf_body` node, else the root), read from the model as loaded: a body's
 * file rests at its bind pose (autorig writes it so; the creature judge checks it). Each bone's position and rotation,
 * and the skin's box from three's own skinning (so quantised positions, whose dequantisation gltf-transform folds into
 * the inverse bind matrices, measure in metres). Cached per geometry.
 * → { pos: Map(name → Vector3), rot: Map(name → Quaternion), frame: Matrix4 (body frame ← world), box: Box3, spread }
 */
const BINDS = new Map();
export function creatureBind(root, rig) {
  root.updateMatrixWorld(true);
  const body = root.getObjectByName('gf_body') ?? root;
  const frameInv = body.matrixWorld.clone().invert();
  const pos = new Map(), rot = new Map();
  for (const [name, b] of rig.bones) {
    _m.copy(b.matrixWorld).premultiply(frameInv); _m.decompose(_v, _q, _s);
    pos.set(name, _v.clone()); rot.set(name, _q.clone());
  }
  // at the bind pose every joint's world · inverse bind is the same matrix (the mesh's dequantisation): how far apart
  // they are says how far the file's pose is from its bind pose
  let spread = 0;
  for (const m of rig.skinned) {
    const ref = new THREE.Matrix4().multiplyMatrices(m.skeleton.bones[0].matrixWorld, m.skeleton.boneInverses[0]);
    for (let i = 1; i < m.skeleton.bones.length; i++) {
      const e = new THREE.Matrix4().multiplyMatrices(m.skeleton.bones[i].matrixWorld, m.skeleton.boneInverses[i]).elements;
      for (let k = 0; k < 16; k++) spread = Math.max(spread, Math.abs(e[k] - ref.elements[k]));
    }
  }
  // the skin's box, and how far each bone's own vertices (the ones it leads) reach from it: a small limb is moved by
  // its own size, not the body's
  const key = rig.skinned.map(m => m.geometry.uuid).join();
  if (!BINDS.has(key)) {
    const box = new THREE.Box3(), extent = new Map(), pts = [];
    const v = new THREE.Vector3();
    const total = rig.skinned.reduce((a, m) => a + m.geometry.attributes.position.count, 0), every = Math.max(1, Math.floor(total / 300));
    for (const m of rig.skinned) {
      const P = m.geometry.attributes.position, si = m.geometry.attributes.skinIndex, sw = m.geometry.attributes.skinWeight;
      for (let i = 0; i < P.count; i++) {
        m.getVertexPosition(i, v); v.applyMatrix4(m.matrixWorld).applyMatrix4(frameInv); box.expandByPoint(v);
        if (i % every === 0) pts.push(v.x, v.y, v.z);
        if (!si || !sw) continue;
        let best = 0, bw = -1; for (let k = 0; k < 4; k++) { const w = sw.getComponent(i, k); if (w > bw) { bw = w; best = si.getComponent(i, k); } }
        const name = m.skeleton.bones[best]?.name, at = pos.get(name);
        if (at) extent.set(name, Math.max(extent.get(name) ?? 0, v.distanceTo(at)));
      }
    }
    BINDS.set(key, { box, extent, sample: new Float32Array(pts) });
  }
  const { box, extent, sample } = BINDS.get(key);
  // sample: about 300 of the skin's points at rest (body frame), for motion to keep a tipped body out of the ground
  return { pos, rot, frame: frameInv, box: box.clone(), extent, sample, spread };
}

/**
 * What procedural motion needs to know of a body (measured once at load): sizes, the chain of a worm, the legs of a
 * quadruped, the wings of a flyer. Pure geometry from the bind pose; nothing archetype-specific is read from names
 * beyond the standard's own.
 */
export function measureCreature(std, rig, bind) {
  const has = n => rig.bones.has(n);
  const P = n => bind.pos.get(n);
  const size = bind.box.getSize(new THREE.Vector3());
  const info = { archetype: std.archetype, height: size.y, width: size.x, depth: size.z, ground: bind.box.min.y, has: [...rig.bones.keys()] };
  if (std.archetype === 'worm') {
    const segs = [...Array(12).keys()].map(i => `Seg${i}`).filter(has);
    const chain = [...segs, 'Head'];
    const pts = chain.map(P);
    let len = 0; for (let i = 1; i < pts.length; i++) len += pts[i].distanceTo(pts[i - 1]);
    const rise = pts.at(-1).y - pts[0].y, run = Math.hypot(pts.at(-1).x - pts[0].x, pts.at(-1).z - pts[0].z);
    Object.assign(info, { segs, length: Math.max(len, 1e-3), upright: rise > run });
  }
  if (std.archetype === 'quadruped') {
    info.legs = {};
    for (const fb of ['Front', 'Back']) for (const s of ['Left', 'Right']) {
      const k = fb + s, a = P(k + 'UpLeg'), b = P(k + 'Leg'), c = P(k + 'Foot');
      if (!a || !b || !c) continue;
      info.legs[k] = { front: fb === 'Front', side: s === 'Left' ? 1 : -1, l1: a.distanceTo(b), l2: b.distanceTo(c), hip: a.clone(), knee: b.clone(), foot: c.clone() };
    }
    const legH = Object.values(info.legs).map(l => l.hip.y - l.foot.y);
    info.legLength = legH.length ? legH.reduce((x, y) => x + y, 0) / legH.length : size.y * 0.5;
    info.bodyLength = Math.max(0.05, (P('Head')?.z ?? 0) - (P('Hips')?.z ?? 0));
  }
  if (std.archetype === 'flyer') {
    const span = ['LeftWing1', 'LeftWing2', 'LeftWing3'].filter(has).map(P);
    info.span = span.length ? Math.max(...span.map(p => Math.abs(p.x))) * 2 : size.x;
    info.legs = has('LeftLeg') || has('RightLeg');
  }
  return info;
}

/** Where a socket sits on a creature (body frame): the head's top, a hand (or a side), the back. */
export function socketPoint(std, name, bind) {
  const b = std.sockets[name];
  const box = bind.box, c = box.getCenter(new THREE.Vector3());
  if (name === 'head') {
    const hb = bind.pos.get(b) ?? c;
    return { bone: b, at: new THREE.Vector3(hb.x, box.max.y, hb.z) };
  }
  if (name === 'back') return { bone: b, at: new THREE.Vector3(c.x, (box.min.y + box.max.y) / 2, box.min.z) };
  const side = name === 'hand_l' ? 1 : -1;
  const p = bind.pos.get(b);
  return { bone: b, at: p ? p.clone() : new THREE.Vector3(side * box.max.x, c.y, c.z) };
}
