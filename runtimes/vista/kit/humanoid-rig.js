// gf-vista: gf-humanoid-1 for the core (research/gf-three/kit/character/RIG.md), the CPU half: no GPU, runs in Node
// (tools/humanoid-fixture.mjs) as in the browser (kit/humanoid.js). Plain data in the shape the core's glTF reader
// returns (core/src/engine/loaders/GLTF.js), math from the core (three.js-compatible API).
//
//   const body = prepareBody(await readGlb(bytes))   one skin, float attributes in character space, the bind pose as rest
//   const std  = standardFrom(await readGlb(clipBytes))
//   const rt   = createRetarget(body, std)           rig.js createRetarget, ported: two constant quaternions per bone,
//                                                    the hips scaled by the body's straight-leg reach
//   const clip = bakeClip(rt, std, std.clips.get('walk'))   the standard clip as the body's own clip (core SkinnedModel)
//
// How it matches rig.js. rig.js poses the standard skeleton with three's AnimationMixer and writes the body's bones
// every frame (local(b) = W(parent)⁻¹ · D(b) · R(b) · B(b)). The core's SkinnedModel samples clips on the body's own
// nodes. So each standard clip is retargeted once, at every key time of any of its channels (the clip file's keys are
// reduced per channel; their union is the source's 30 fps frames), with the standard sampled as three samples it
// (slerp, hold at the ends), and becomes a clip of rotation tracks on the body's canonical bones (and the finger tips a
// shifted finger drives) plus the hips' translation. At those times the pose is rig.js's exactly; between them the
// core nlerps the body's locals where three slerps the standard's (a local is the standard's local multiplied on both
// sides by constants, which commutes with interpolation, so the gap is nlerp against slerp over one 1/30 s frame), and
// crossfades blend the body's locals where three blends the standard's. tools/humanoid-fixture.mjs measures both.
import { Matrix4, Quaternion, Vector3, MathUtils } from '../core/src/engine/math/index.js';
import { parseGLB } from '../core/src/engine/loaders/GLTF.js';
import { plainGlb } from './meshopt.js';

export const RIG = 'gf-humanoid-1';

// ---------------------------------------------------------------- the standard (rig.js, same tables)
const FINGERS = ['Thumb', 'Index', 'Middle', 'Ring', 'Pinky'];
const side = (s, list) => list.map(([n, p, req]) => [s + n, p && p.replace('$', s), req]);
const fingerBones = s => FINGERS.flatMap(f => [1, 2, 3].map(i => [`${s}Hand${f}${i}`, i === 1 ? `${s}Hand` : `${s}Hand${f}${i - 1}`, false]));
export const BONES = [
  ['Hips', null, true], ['Spine02', 'Hips', false], ['Spine01', 'Spine02', false], ['Spine', 'Spine01', true],
  ['neck', 'Spine', false], ['Head', 'neck', true], ['head_end', 'Head', false], ['headfront', 'Head', false],
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
const SWING = { LeftArm: 'LeftForeArm', LeftForeArm: 'LeftHand', RightArm: 'RightForeArm', RightForeArm: 'RightHand',
  LeftUpLeg: 'LeftLeg', LeftLeg: 'LeftFoot', RightUpLeg: 'RightLeg', RightLeg: 'RightFoot' };
const INHERIT = new Set(['LeftHand', 'RightHand', 'LeftFoot', 'RightFoot', 'LeftToeBase', 'RightToeBase',
  ...['Left', 'Right'].flatMap(s => FINGERS.flatMap(f => [1, 2, 3].map(i => `${s}Hand${f}${i}`)))]);
const PALM_FIRST = 0.45;
const FINGER_SEG = /^((?:Left|Right)Hand(?:Index|Middle|Ring|Pinky))([123])$/;
export function canonicalParent(name, has) {
  for (let p = PARENT[name]; p; p = PARENT[p]) if (has(p)) return p;
  return null;
}

// ---------------------------------------------------------------- GLB → the core's plain glTF data
/** ArrayBuffer (or Uint8Array) of a library GLB → parseGLB's result: meshopt decoded (kit/meshopt.js), quantised
 *  attributes left as integers (prepareBody dequantises them). */
export async function readGlb(bytes) {
  const buf = bytes instanceof ArrayBuffer ? bytes : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return parseGLB(await plainGlb(buf, { allow: ['KHR_mesh_quantization'] }));
}

const NORM = { 5120: 127, 5121: 255, 5122: 32767, 5123: 65535 };
function toFloat(a) {
  if (a.array instanceof Float32Array) return a.array;
  const k = a.normalized ? 1 / NORM[a.componentType] : 1;
  const f = new Float32Array(a.array.length);
  for (let i = 0; i < f.length; i++) f[i] = a.normalized ? Math.max(a.array[i] * k, -1) : a.array[i];
  return f;
}

/** Scene-graph helpers over plain glTF nodes: parents, three's traversal order, matrices from the current locals. */
function graph(g) {
  const N = g.nodes.length, parent = new Int32Array(N).fill(-1), order = [];
  const visit = i => { order.push(i); for (const c of g.nodes[i].children) { parent[c] = i; visit(c); } };
  for (const r of g.roots) visit(r);
  const local = g.nodes.map(n => ({ t: new Vector3().fromArray(n.t), r: new Quaternion().fromArray(n.r), s: new Vector3().fromArray(n.s) }));
  const _l = new Matrix4();
  /** rig.js relMatrix(o, root): the node's matrix in the scene's space, from the current local transforms */
  const rel = (i, target = new Matrix4()) => {
    target.identity();
    const chain = [];
    for (let n = i; n >= 0; n = parent[n]) chain.push(n);
    for (let k = chain.length - 1; k >= 0; k--) { const L = local[chain[k]]; target.multiply(_l.compose(L.t, L.r, L.s)); }
    return target;
  };
  const depth = i => { let d = 0; for (let n = i; n >= 0; n = parent[n]) d++; return d; };
  return { N, parent, order, local, rel, depth };
}

/**
 * A library body → the shape SkinnedModel takes, plus what the retarget needs. The core reads one skin and the first
 * skinned mesh node; library bodies have one skin per mesh (gltf-transform quantises each mesh into its own volume and
 * folds the dequantisation into that skin's inverse binds). So every primitive is dequantised and moved into character
 * space with its mesh's bind frame (rig.js bindPose: frame = hipsNodeWorld · IBM(hips)), all primitives go under one
 * skinned node, and the one skin's inverse binds are the inverses of the bind matrices. The nodes rest at the bind pose
 * (rig.js poseToBind), so the core's rest pose is rig.js's.
 * Returns { gltf (for SkinnedModel), rig: { bones: Map(name → node), bind: Map(node → Matrix4), pos, rot, frame, spread },
 *           extras (gf_body's), box: {min, max}, primitives: [{ material, color? }] }
 */
export function prepareBody(g) {
  const G = graph(g);
  const isJoint = new Set(g.skins.flatMap(s => s.joints));
  // three's GLTFLoader: one SkinnedMesh per primitive of a skinned node, in traversal order
  const skinnedNodes = G.order.filter(i => g.nodes[i].mesh !== undefined && g.nodes[i].skin !== undefined);
  if (!skinnedNodes.length) throw new Error('gf-humanoid-1: the body has no skinned mesh');
  // rig.js findRig: skeleton joints with canonical names first, then other (non-mesh) nodes with canonical names
  const bones = new Map();
  for (const m of skinnedNodes) for (const j of g.skins[g.nodes[m].skin].joints) { const n = g.nodes[j].name; if (CANON.has(n) && !bones.has(n)) bones.set(n, j); }
  for (const i of G.order) { const n = g.nodes[i].name; if (CANON.has(n) && !bones.has(n) && g.nodes[i].mesh === undefined) bones.set(n, i); }
  // rig.js bindPose
  const ibmOf = (skin, k) => new Matrix4().fromArray(skin.inverseBindMatrices, k * 16);
  const inv = new Map();
  for (const m of skinnedNodes) { const sk = g.skins[g.nodes[m].skin]; sk.joints.forEach((j, k) => { if (!inv.has(j)) inv.set(j, ibmOf(sk, k)); }); }
  const hips = bones.get('Hips');
  const hipsRest = hips !== undefined ? G.rel(hips) : null;
  const frameOf = bi => (hipsRest && bi ? hipsRest.clone().multiply(bi) : new Matrix4());
  const frame = frameOf(inv.get(hips));
  const frames = new Map(skinnedNodes.map(m => { const sk = g.skins[g.nodes[m].skin]; const k = sk.joints.indexOf(hips); return [m, frameOf(k >= 0 ? ibmOf(sk, k) : null)]; }));
  let spread = 0;
  for (const [b, bi] of inv) { const f = G.rel(b).multiply(bi).elements; for (let i = 0; i < 16; i++) spread = Math.max(spread, Math.abs(f[i] - frame.elements[i])); }
  const bind = new Map();
  for (const [b, bi] of inv) bind.set(b, frame.clone().multiply(bi.clone().invert()));
  const pos = new Map(), rot = new Map();
  const _v = new Vector3(), _q = new Quaternion(), _s = new Vector3();
  for (const [name, b] of bones) { (bind.get(b) ?? G.rel(b)).decompose(_v, _q, _s); pos.set(name, _v.clone()); rot.set(name, _q.clone()); }
  // rig.js poseToBind: every joint's local transform from the bind matrices, parents first
  const jointsByDepth = [...bind.keys()].sort((a, b) => G.depth(a) - G.depth(b));
  const _m = new Matrix4();
  for (const j of jointsByDepth) {
    const p = G.parent[j];
    const pw = p >= 0 && bind.has(p) ? bind.get(p) : p >= 0 ? G.rel(p) : new Matrix4();
    _m.copy(pw).invert().multiply(bind.get(j));
    const L = G.local[j];
    _m.decompose(L.t, L.r, L.s);
  }
  // one skin: every joint of every skin, inverse binds = inverse bind matrices
  const joints = [...inv.keys()];
  const jointIndex = new Map(joints.map((j, k) => [j, k]));
  const ibm = new Float32Array(joints.length * 16);
  joints.forEach((j, k) => ibm.set(bind.get(j).clone().invert().elements, k * 16));
  // primitives in character space (rig.js bindBox: frames(mesh) · bindMatrix · v; the skinned nodes rest at identity)
  const prims = [], box = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  const warn = [];
  for (const m of skinnedNodes) {
    const w = G.rel(m).elements;
    if (w.some((x, i) => Math.abs(x - (i % 5 === 0 ? 1 : 0)) > 1e-6)) warn.push(`skinned node ${g.nodes[m].name} does not rest at identity (bindMatrix taken as identity)`);
    const F = frames.get(m), Fe = F.elements;
    const nm = new Matrix4().copy(F).invert().transpose().elements;   // normals: inverse transpose of the frame
    const sk = g.skins[g.nodes[m].skin];
    for (const p of g.meshes[g.nodes[m].mesh]) {
      const A = p.attributes;
      const P = toFloat(A.POSITION).slice(), Nn = A.NORMAL ? toFloat(A.NORMAL).slice() : null;
      for (let i = 0; i < P.length; i += 3) {
        const x = P[i], y = P[i + 1], z = P[i + 2];
        P[i] = Fe[0] * x + Fe[4] * y + Fe[8] * z + Fe[12]; P[i + 1] = Fe[1] * x + Fe[5] * y + Fe[9] * z + Fe[13]; P[i + 2] = Fe[2] * x + Fe[6] * y + Fe[10] * z + Fe[14];
        for (let c = 0; c < 3; c++) { box.min[c] = Math.min(box.min[c], P[i + c]); box.max[c] = Math.max(box.max[c], P[i + c]); }
        if (Nn) {
          const a = Nn[i], b = Nn[i + 1], d = Nn[i + 2];
          let nx = nm[0] * a + nm[4] * b + nm[8] * d, ny = nm[1] * a + nm[5] * b + nm[9] * d, nz = nm[2] * a + nm[6] * b + nm[10] * d;
          const l = 1 / (Math.hypot(nx, ny, nz) || 1);
          Nn[i] = nx * l; Nn[i + 1] = ny * l; Nn[i + 2] = nz * l;
        }
      }
      const J = Uint32Array.from(A.JOINTS_0.array, k => jointIndex.get(sk.joints[k]));
      const attributes = {
        POSITION: { array: P, itemSize: 3, normalized: false },
        JOINTS_0: { array: J, itemSize: 4, normalized: false },
        WEIGHTS_0: { array: toFloat(A.WEIGHTS_0), itemSize: 4, normalized: false },
      };
      if (Nn) attributes.NORMAL = { array: Nn, itemSize: 3, normalized: false };
      if (A.TEXCOORD_0) attributes.TEXCOORD_0 = { array: toFloat(A.TEXCOORD_0), itemSize: 2, normalized: false };
      const color = A.COLOR_0 ? { array: toFloat(A.COLOR_0), itemSize: A.COLOR_0.itemSize } : null;
      prims.push({ attributes, indices: p.indices ? (p.indices instanceof Uint16Array || p.indices instanceof Uint32Array ? p.indices : Uint32Array.from(p.indices)) : null, material: p.material, mode: p.mode, color });
    }
  }
  // the gltf SkinnedModel reads: nodes resting at the bind pose, one mesh on the first skinned node, one skin
  const nodes = g.nodes.map((n, i) => {
    const L = G.local[i];
    const out = { name: n.name, children: n.children, t: L.t.toArray(), r: L.r.toArray(), s: L.s.toArray() };
    if (i === skinnedNodes[0]) { out.mesh = 0; out.skin = 0; }
    return out;
  });
  const extras = g.nodes.find(n => n.name === 'gf_body') ? (g.json.nodes[g.nodes.findIndex(n => n.name === 'gf_body')].extras ?? {}) : {};
  const gltf = { json: g.json, nodes, roots: g.roots, meshes: [prims], skins: [{ name: 'gf-humanoid-1', joints, inverseBindMatrices: ibm }], animations: [], materials: g.materials, textures: g.textures, images: g.images };
  return { gltf, graph: G, rig: { bones, bind, pos, rot, frame, spread, isJoint }, extras, box, warn };
}

// ---------------------------------------------------------------- the standard skeleton from the clip file
/** rig.js standardFrom: bones, rest positions (sums of local translations: the standard's rest rotations are identity),
 *  the ground (scene extras gfGround), the hips' height; and the clips with their metadata (gf_humanoid_1 extras). */
export function standardFrom(g) {
  const G = graph(g);
  const bones = new Map();
  for (const i of G.order) { const n = g.nodes[i].name; if (CANON.has(n) && !bones.has(n)) bones.set(n, i); }
  if (!bones.has('Hips')) throw new Error('gf-humanoid-1 clip file has no Hips');
  const rest = new Map();
  const walk = (i, acc) => { const p = acc.clone().add(new Vector3().fromArray(g.nodes[i].t)); if (CANON.has(g.nodes[i].name)) rest.set(g.nodes[i].name, p); for (const c of g.nodes[i].children) walk(c, p); };
  walk(bones.get('Hips'), new Vector3());
  const scene = g.json.scenes?.[g.json.scene ?? 0];
  const ground = scene?.extras?.gfGround ?? 0;
  const metaNode = g.json.nodes.find(n => n.extras?.gfClips);
  const clips = new Map(g.animations.map(a => [a.name, a]));
  return { gltf: g, graph: G, bones, rest, ground, hipsHeight: rest.get('Hips').y - ground, clips, meta: metaNode?.extras?.gfClips ?? {} };
}

// three.js 0.186.0 Quaternion.slerpFlat (MIT, three.js authors; research/gf-three/tools/lib/char-deps): slerp, or lerp
// and normalise when the keys are within ~3.6°. Copied rather than the core's Quaternion.slerp, which returns the first
// key when the dot of two not-quite-unit keys reaches 1 (the clip file's rotations are int16, |q| off by up to 2e-5).
function slerpFlat(dst, dstOffset, src0, srcOffset0, src1, srcOffset1, t) {
  let x0 = src0[srcOffset0], y0 = src0[srcOffset0 + 1], z0 = src0[srcOffset0 + 2], w0 = src0[srcOffset0 + 3];
  let x1 = src1[srcOffset1], y1 = src1[srcOffset1 + 1], z1 = src1[srcOffset1 + 2], w1 = src1[srcOffset1 + 3];
  if (w0 !== w1 || x0 !== x1 || y0 !== y1 || z0 !== z1) {
    let dot = x0 * x1 + y0 * y1 + z0 * z1 + w0 * w1;
    if (dot < 0) { x1 = -x1; y1 = -y1; z1 = -z1; w1 = -w1; dot = -dot; }
    let s = 1 - t;
    if (dot < 0.9995) {
      const theta = Math.acos(dot), sin = Math.sin(theta);
      s = Math.sin(s * theta) / sin; t = Math.sin(t * theta) / sin;
      x0 = x0 * s + x1 * t; y0 = y0 * s + y1 * t; z0 = z0 * s + z1 * t; w0 = w0 * s + w1 * t;
    } else {
      x0 = x0 * s + x1 * t; y0 = y0 * s + y1 * t; z0 = z0 * s + z1 * t; w0 = w0 * s + w1 * t;
      const f = 1 / Math.sqrt(x0 * x0 + y0 * y0 + z0 * z0 + w0 * w0);
      x0 *= f; y0 *= f; z0 *= f; w0 *= f;
    }
  }
  dst[dstOffset] = x0; dst[dstOffset + 1] = y0; dst[dstOffset + 2] = z0; dst[dstOffset + 3] = w0;
}

// three's sampling of a track (QuaternionLinearInterpolant: slerpFlat; LinearInterpolant: lerp; hold at the ends)
function sampleThree(ch, t, out) {
  const T = ch.times, V = ch.values, w = ch.path === 'rotation' ? 4 : 3, n = T.length;
  if (n === 1 || t <= T[0]) { for (let c = 0; c < w; c++) out[c] = V[c]; return out; }
  if (t >= T[n - 1]) { for (let c = 0; c < w; c++) out[c] = V[(n - 1) * w + c]; return out; }
  let k = 0;
  while (k < n - 2 && T[k + 1] <= t) k++;
  const f = ch.step ? 0 : (t - T[k]) / (T[k + 1] - T[k]);
  if (w === 4) slerpFlat(out, 0, V, k * 4, V, (k + 1) * 4, f);
  else for (let c = 0; c < 3; c++) out[c] = V[k * 3 + c] + (V[(k + 1) * 3 + c] - V[k * 3 + c]) * f;
  return out;
}

/** The standard skeleton posed by one clip at time t, as three's mixer leaves it: Map(name → {q: Quaternion, t: Vector3}). */
export function standardPose(std, clip, t, out = new Map()) {
  for (const [name, i] of std.bones) {
    const n = std.gltf.nodes[i];
    const e = out.get(name) ?? { q: new Quaternion(), t: new Vector3() };
    e.q.fromArray(n.r); e.t.fromArray(n.t);
    out.set(name, e);
  }
  const byNode = new Map([...std.bones].map(([n, i]) => [i, n]));
  const tmp = new Float32Array(4), tq = [0, 0, 0, 1];
  for (const ch of clip.channels) {
    const name = byNode.get(ch.node);
    if (!name) continue;
    sampleThree(ch, t, tmp);
    if (ch.path === 'rotation') { tq[0] = tmp[0]; tq[1] = tmp[1]; tq[2] = tmp[2]; tq[3] = tmp[3]; out.get(name).q.fromArray(tq); }
    else if (ch.path === 'translation') out.get(name).t.set(tmp[0], tmp[1], tmp[2]);
  }
  return out;
}

// ---------------------------------------------------------------- the retarget (rig.js createRetarget, ported)
/**
 * Per-body constants and pose(stdPose) → { rot: Map(node → Quaternion local), hips: Vector3 local } for the body's
 * canonical bones, the finger tips a shifted finger drives, and the hips' position. Same maths as rig.js, line for line.
 * Returns { pose, k, ground, height, swing, order, fingers, driver, spineBend, nodes: [node indices it writes] }.
 */
export function createRetarget(body, std) {
  const { rig, graph: G, extras } = body;
  const g = body.gltf;
  const has = n => rig.bones.has(n);
  const missing = REQUIRED.filter(n => !has(n));
  if (missing.length) throw new Error(`gf-humanoid-1: body is missing ${missing.join(', ')}`);
  const order = BONE_NAMES.filter(has);
  const ground = body.box.min[1], height = body.box.max[1] - body.box.min[1];
  const reach = (P, gr) => {
    const sd = s => P(`${s}UpLeg`).distanceTo(P(`${s}Leg`)) + P(`${s}Leg`).distanceTo(P(`${s}Foot`)) + (P(`${s}Foot`).y - gr) + (P('Hips').y - P(`${s}UpLeg`).y);
    return (sd('Left') + sd('Right')) / 2;
  };
  const stdReach = std.rest.has('LeftUpLeg') ? reach(n => std.rest.get(n), std.ground) : std.hipsHeight;
  const k = reach(n => rig.pos.get(n), ground) / stdReach;
  const _v = new Vector3(), _q = new Quaternion(), _s = new Vector3();

  // finger chains (RIG.md §2): a finger whose bone 1 sits inside the palm is shifted one bone outward
  const driver = new Map(order.map(n => [n, n]));
  const driven = [];
  const tipPos = new Map();
  const fingers = {};
  const byName = extras.gfFingers === 'by-name';
  for (const s of ['Left', 'Right']) for (const f of ['Index', 'Middle', 'Ring', 'Pinky']) {
    const [n1, n2, n3] = [1, 2, 3].map(i => `${s}Hand${f}${i}`);
    if (byName || !has(n1) || !has(n2) || !has(`${s}Hand`)) continue;
    const w = rig.pos.get(`${s}Hand`), d1 = rig.pos.get(n1).distanceTo(w), d2 = rig.pos.get(n2).distanceTo(w);
    if (!(d2 > 0 && d1 / d2 < PALM_FIRST)) continue;
    driver.set(n1, `${s}Hand`); driver.set(n2, n1);
    if (has(n3)) {
      driver.set(n3, n2);
      const tip = g.nodes[rig.bones.get(n3)].children.find(c => rig.isJoint.has(c) && !CANON.has(g.nodes[c].name) && rig.bind.has(c));
      if (tip !== undefined) { driven.push({ key: `${n3}>tip`, node: tip, driver: n3, parent: n3 }); tipPos.set(n3, new Vector3().setFromMatrixPosition(rig.bind.get(tip))); }
    }
    (fingers[s] ??= []).push(f);
  }
  // R(b): own swing or inherited
  const R = new Map(), swing = new Map();
  for (const n of BONE_NAMES) {
    if (!has(n)) continue;
    const r = new Quaternion();
    const child = SWING[n];
    if (child && has(child) && std.rest.has(n) && std.rest.has(child)) {
      const db = _v.copy(rig.pos.get(child)).sub(rig.pos.get(n)).normalize().clone();
      const ds = std.rest.get(child).clone().sub(std.rest.get(n)).normalize();
      if (db.lengthSq() > 0 && ds.lengthSq() > 0) r.setFromUnitVectors(db, ds);
    } else if (INHERIT.has(n)) {
      const p = canonicalParent(n, has);
      if (p && R.has(p)) r.copy(R.get(p));
      const fm = FINGER_SEG.exec(n), dn = driver.get(n), sm = dn && FINGER_SEG.exec(dn);
      if (fm && sm) {
        const next = has(`${fm[1]}${+fm[2] + 1}`) ? rig.pos.get(`${fm[1]}${+fm[2] + 1}`) : tipPos.get(n);
        const sNext = std.rest.get(`${sm[1]}${+sm[2] + 1}`);
        if (next && sNext && std.rest.has(dn)) {
          const db = next.clone().sub(rig.pos.get(n)).applyQuaternion(r).normalize();
          const ds = sNext.clone().sub(std.rest.get(dn)).normalize();
          if (db.lengthSq() > 0 && ds.lengthSq() > 0) r.premultiply(_q.setFromUnitVectors(db, ds));
        }
      }
    }
    R.set(n, r);
    swing.set(n, MathUtils.radToDeg(2 * Math.acos(Math.min(1, Math.abs(r.w)))));
  }
  // constants: C(b) = R(b) B(b); each bone's parent is a canonical bone (dynamic) or a static node
  const C = new Map(), parentOf = new Map(), staticParentInv = new Map(), staticParentMat = new Map();
  for (const n of order) {
    C.set(n, R.get(n).clone().multiply(rig.rot.get(n)));
    const node = rig.bones.get(n), pi = G.parent[node];
    const p = pi >= 0 && CANON.has(g.nodes[pi].name) && rig.bones.get(g.nodes[pi].name) === pi ? g.nodes[pi].name : null;
    parentOf.set(n, p);
    if (!p) {
      const pm = pi >= 0 ? G.rel(pi) : new Matrix4();
      pm.decompose(_v, _q, _s);
      staticParentInv.set(n, _q.clone().invert());
      staticParentMat.set(n, pm.clone().invert());
    }
  }
  for (const t of driven) { rig.bind.get(t.node).decompose(_v, _q, _s); C.set(t.key, R.get(t.parent).clone().multiply(_q)); }
  const W = new Map([...order, ...driven.map(t => t.key)].map(n => [n, new Quaternion()]));
  const stdWorld = new Map();
  const stdOrder = BONE_NAMES.filter(n => std.bones.has(n));
  const hipsLift = std.hipsHeight / stdReach;
  const spineBend = extras.gfSpineBend ?? 1;
  const SPINE = ['Spine02', 'Spine01', 'Spine', 'neck', 'Head'];
  const _rel = new Quaternion(), _hq = new Quaternion(), _I = new Quaternion(), tmpQ = new Quaternion();
  const out = { rot: new Map([...order.map(n => rig.bones.get(n)), ...driven.map(t => t.node)].map(i => [i, new Quaternion()])), hips: new Vector3(), hipsNode: rig.bones.get('Hips') };

  /** rig.js apply(proxy): the body's locals from a standard pose (standardPose()). */
  function pose(sp, { pinXZ = false } = {}) {
    for (const n of stdOrder) {
      const q = sp.get(n).q;
      const p = PARENT[n] && canonicalParent(n, x => sp.has(x));
      const w = stdWorld.get(n) ?? new Quaternion();
      if (p) w.copy(stdWorld.get(p)).multiply(q); else w.copy(q);
      stdWorld.set(n, w);
    }
    const sw = stdWorld;
    if (spineBend < 1 && sw.has('Hips')) {
      _hq.copy(sw.get('Hips'));
      for (const n of SPINE) { const d = sw.get(n); if (!d) continue; _rel.copy(_hq).invert().multiply(d).slerp(_I, 1 - spineBend); d.copy(_hq).multiply(_rel); }
    }
    for (const n of order) {
      const dn = driver.get(n);
      const d = sw.get(dn) ?? sw.get(canonicalParent(dn, x => sw.has(x)));
      W.get(n).copy(d).multiply(C.get(n));
      const q = out.rot.get(rig.bones.get(n)), p = parentOf.get(n);
      if (p) q.copy(tmpQ.copy(W.get(p)).invert().multiply(W.get(n)));
      else q.copy(staticParentInv.get(n)).multiply(W.get(n));
    }
    for (const t of driven) {
      W.get(t.key).copy(sw.get(t.driver) ?? W.get(t.parent)).multiply(C.get(t.key));
      out.rot.get(t.node).copy(tmpQ.copy(W.get(t.parent)).invert().multiply(W.get(t.key)));
    }
    const sh = sp.get('Hips').t;
    out.hips.set(pinXZ ? 0 : sh.x * k, ground + (sh.y - std.ground) * k * hipsLift, pinXZ ? 0 : sh.z * k);
    if (!parentOf.get('Hips')) out.hips.applyMatrix4(staticParentMat.get('Hips'));
    return out;
  }
  return { pose, k, ground, height, swing, order, fingers, driver, spineBend, nodes: [...out.rot.keys()], hipsNode: out.hipsNode };
}

/**
 * One standard clip → the same clip on the body's own nodes (the shape GLTF.js gives animations, for SkinnedModel):
 * rotation channels on every node the retarget writes, a translation channel on the hips, keyed at the union of the
 * standard clip's key times (at least every `maxStep` seconds).
 */
export function bakeClip(rt, std, clip, { maxStep = 1 / 30 } = {}) {
  const set = new Set([0, clip.duration]);
  for (const ch of clip.channels) for (const t of ch.times) set.add(Math.round(t * 1e6) / 1e6);
  let times = [...set].filter(t => t >= 0 && t <= clip.duration + 1e-9).sort((a, b) => a - b);
  const dense = [];
  for (let i = 0; i < times.length; i++) {
    dense.push(times[i]);
    const next = times[i + 1];
    if (next !== undefined) { const n = Math.ceil((next - times[i]) / maxStep - 1e-6); for (let j = 1; j < n; j++) dense.push(times[i] + (next - times[i]) * j / n); }
  }
  times = Float32Array.from(dense);
  const rot = new Map(rt.nodes.map(i => [i, new Float32Array(times.length * 4)]));
  const hips = new Float32Array(times.length * 3);
  const sp = new Map();
  for (let f = 0; f < times.length; f++) {
    const r = rt.pose(standardPose(std, clip, times[f], sp));
    for (const [i, q] of r.rot) {
      const a = rot.get(i), o = f * 4;
      // keep consecutive keys in one hemisphere (the core nlerps between them)
      let x = q.x, y = q.y, z = q.z, w = q.w;
      if (f > 0 && a[o - 4] * x + a[o - 3] * y + a[o - 2] * z + a[o - 1] * w < 0) { x = -x; y = -y; z = -z; w = -w; }
      a[o] = x; a[o + 1] = y; a[o + 2] = z; a[o + 3] = w;
    }
    hips[f * 3] = r.hips.x; hips[f * 3 + 1] = r.hips.y; hips[f * 3 + 2] = r.hips.z;
  }
  const channels = [...rot].map(([node, values]) => ({ node, path: 'rotation', times, values, step: false }));
  channels.push({ node: rt.hipsNode, path: 'translation', times, values: hips, step: false });
  return { name: clip.name, duration: clip.duration, channels };
}
