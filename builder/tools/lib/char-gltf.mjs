// glTF-level helpers for track C: put any humanoid rig on gf-humanoid-1, and measure a body.
// Uses three.js's skinning convention (a joint's bind matrix is inverse(IBM) in the scene's space and vertices are
// placed by the skinned mesh node's world matrix), because three.js is what plays the bodies.
import './char-node.mjs';
import { gltfCore, THREE } from './char-deps.mjs';

const rig = await import('../../../runtimes/three/kit/character/rig.js');
const { Matrix4, Vector3, Quaternion } = THREE;
const silent = doc => doc.setLogger(new gltfCore.Logger(gltfCore.Logger.Verbosity.SILENT));

const parentMap = root => { const m = new Map(); for (const n of root.listNodes()) for (const c of n.listChildren()) m.set(c, n); return m; };
const worldOf = (n, parents) => { const m = new Matrix4().fromArray(n.getMatrix()); for (let p = parents.get(n); p; p = parents.get(p)) m.premultiply(new Matrix4().fromArray(p.getMatrix())); return m; };

/** Disposes an animation with its channels and samplers (disposing the animation alone leaves them holding accessors). */
export function disposeAnimation(a) { for (const c of a.listChannels()) c.dispose(); for (const s of a.listSamplers()) s.dispose(); a.dispose(); }

/** Skinned primitives as [{node, mesh, prim}] for one skin. */
function skinnedPrims(root, skin) {
  const out = [];
  for (const node of root.listNodes()) if (node.getSkin() === skin && node.getMesh()) for (const prim of node.getMesh().listPrimitives()) out.push({ node, mesh: node.getMesh(), prim });
  return out;
}

/**
 * Normalises a rigged humanoid in place onto gf-humanoid-1:
 *   canonical bone names (rig.js canonicalNames), canonical parents, unweighted helpers dropped, weighted Hips
 *   ancestors merged into Hips, Y up, facing +Z, metres, feet at the origin, every joint's rest rotation identity
 *   (IBMs recomputed, so the mesh is unchanged), one root node `gf_body`, no embedded animations.
 * Options: { height } forces the standing height in metres; { scale } multiplies the file's units by a fixed factor
 * instead (a pack whose characters must keep their sizes relative to each other); { names } a Map(original → canonical)
 * to use instead.
 * Returns a report { renamed, dropped, merged, kept, fix: {up, yawDeg, scale}, height }.
 */
export function normalizeBody(doc, { height, scale, names, keepAnimations = false } = {}) {
  silent(doc);
  const root = doc.getRoot();
  const skins = root.listSkins();
  if (!skins.length) throw new Error('not rigged: the GLB has no skin');
  const skin = skins[0];
  const joints = skin.listJoints();
  for (const s of skins.slice(1)) {
    const js = s.listJoints();
    if (js.length !== joints.length || js.some((j, i) => j !== joints[i])) throw new Error('several skins with different joints: merge them first');
  }
  // (several skins over the same joints is what per-mesh quantisation leaves: each skin's IBMs carry its mesh's volume)
  const parents = parentMap(root);
  const ibmAcc = skin.getInverseBindMatrices();
  const IBM = joints.map((j, i) => ibmAcc ? new Matrix4().fromArray(ibmAcc.getElement(i, [])) : worldOf(j, parents).invert());
  const rawNames = joints.map(j => j.getName());
  const canon = names ?? rig.canonicalNames(rawNames);
  const canonOf = j => canon.get(j.getName()) ?? null;
  const byCanon = new Map(joints.map((j, i) => [canonOf(j), i]).filter(([c]) => c));
  const missing = rig.REQUIRED.filter(n => !byCanon.has(n));
  if (missing.length) throw new Error(`missing gf-humanoid-1 bones: ${missing.join(', ')} (have: ${rawNames.join(', ')})`);
  // three.js (and glTF) skin a vertex as jointWorld · IBM · v, ignoring the mesh node's transform. The space the
  // bind pose lives in is therefore frame = hipsWorld(rest) · IBM(hips): identity for most files, the armature's
  // transform for rigs exported under a scaled/rotated armature (Quaternius), the dequantisation for quantised ones.
  const hi = byCanon.get('Hips');
  const frame = worldOf(joints[hi], parents).multiply(IBM[hi]);
  const bindW = IBM.map(m => frame.clone().multiply(m.clone().invert()));
  const P = bindW.map(m => new Vector3().setFromMatrixPosition(m));

  // --- which joints carry weight
  const prims = skins.flatMap(s => skinnedPrims(root, s));
  const weighted = new Float64Array(joints.length);
  for (const { prim } of prims) {
    const J = prim.getAttribute('JOINTS_0'), Wt = prim.getAttribute('WEIGHTS_0');
    if (!J || !Wt) continue;
    if (prim.getAttribute('JOINTS_1')) throw new Error('more than 4 influences per vertex (JOINTS_1): three.js reads only 4');
    const j = [], w = [];
    for (let v = 0; v < J.getCount(); v++) { J.getElement(v, j); Wt.getElement(v, w); for (let k = 0; k < 4; k++) weighted[j[k]] += w[k]; }
  }
  // --- keep / drop / merge
  const hipsIdx = byCanon.get('Hips');
  const ancestorsOfHips = new Set(); for (let p = parents.get(joints[hipsIdx]); p; p = parents.get(p)) ancestorsOfHips.add(p);
  const idxOf = new Map(joints.map((j, i) => [j, i]));
  const isDesc = (a, b) => { for (let p = parents.get(a); p; p = parents.get(p)) if (p === b) return true; return false; };
  const keep = new Array(joints.length).fill(false), mergeTo = new Array(joints.length).fill(-1);
  joints.forEach((j, i) => { if (canonOf(j)) keep[i] = true; });
  joints.forEach((j, i) => {
    if (keep[i]) return;
    if (ancestorsOfHips.has(j)) { if (weighted[i] > 0) mergeTo[i] = hipsIdx; return; }
    if (weighted[i] > 0) keep[i] = true;
  });
  // unweighted helpers that parent kept extras stay too
  joints.forEach((j, i) => { if (!keep[i] && mergeTo[i] < 0 && !ancestorsOfHips.has(j) && joints.some((k, m) => keep[m] && !canonOf(k) && isDesc(k, j))) keep[i] = true; });
  // non-canonical kept joints that lie outside the Hips tree are re-hung under Hips
  const newParentIdx = joints.map((j, i) => {
    if (!keep[i]) return -1;
    const c = canonOf(j);
    if (c) { const pc = rig.canonicalParent(c, n => byCanon.has(n)); return pc ? byCanon.get(pc) : -1; }
    for (let p = parents.get(j); p; p = parents.get(p)) { const pi = idxOf.get(p); if (pi !== undefined && keep[pi]) return pi; }
    return hipsIdx;
  });

  // --- the fix: up axis, facing, scale, origin
  const Pc = n => P[byCanon.get(n)].clone();
  const F = new Matrix4();
  const up = Pc('Head').sub(Pc('Hips'));
  const ax = ['x', 'y', 'z'].reduce((a, b) => (Math.abs(up[b]) > Math.abs(up[a]) ? b : a));
  let upFix = 'Y';
  if (ax === 'z') { F.makeRotationX(up.z > 0 ? -Math.PI / 2 : Math.PI / 2); upFix = up.z > 0 ? 'Z' : '-Z'; }
  else if (ax === 'x') { F.makeRotationZ(up.x > 0 ? Math.PI / 2 : -Math.PI / 2); upFix = up.x > 0 ? 'X' : '-X'; }
  else if (up.y < 0) { F.makeRotationX(Math.PI); upFix = '-Y'; }
  const lat = Pc('LeftUpLeg').sub(Pc('RightUpLeg')).add(Pc('LeftArm').sub(Pc('RightArm'))).applyMatrix4(new Matrix4().extractRotation(F));
  lat.y = 0; lat.normalize();
  const yaw = Math.atan2(lat.z, lat.x);    // makeRotationY(yaw) brings the body's left side onto +X
  const Y = new Matrix4().makeRotationY(yaw);
  F.premultiply(Y);
  // vertices in character space (before scale/offset) to measure height
  // each skin's own frame (its IBMs may carry a per-mesh dequantisation)
  const skinFrame = sk => { const acc = sk.getInverseBindMatrices(); return acc ? worldOf(joints[hi], parents).multiply(new Matrix4().fromArray(acc.getElement(hi, []))) : frame; };
  const meshWorld = new Map(prims.map(({ node }) => [node, skinFrame(node.getSkin())]));
  const box = new THREE.Box3(), tmp = new Vector3();
  for (const { node, prim } of prims) {
    const pos = prim.getAttribute('POSITION'), M = F.clone().multiply(meshWorld.get(node)), e = [];
    for (let v = 0; v < pos.getCount(); v++) box.expandByPoint(tmp.fromArray(pos.getElement(v, e)).applyMatrix4(M));
  }
  const h0 = box.max.y - box.min.y;
  const s = scale ?? (height ? height / h0 : h0 > 5 ? 0.01 : 1);
  const S = new Matrix4().makeScale(s, s, s);
  const feet = Pc('LeftFoot').add(Pc('RightFoot')).multiplyScalar(0.5).applyMatrix4(F).multiplyScalar(s);
  const T = new Matrix4().makeTranslation(-feet.x, -box.min.y * s, -feet.z);
  const X = T.clone().multiply(S).multiply(F);       // old character space → new
  const XR = new Matrix4().extractRotation(F);

  // --- new joint nodes
  const newPos = P.map(p => p.clone().applyMatrix4(X));
  const newNodes = joints.map((j, i) => keep[i] ? doc.createNode(canonOf(j) ?? j.getName()) : null);
  const order = joints.map((_, i) => i).filter(i => keep[i]);
  for (const i of order) {
    const pi = newParentIdx[i];
    const t = newPos[i].clone().sub(pi >= 0 ? newPos[pi] : new Vector3());
    newNodes[i].setTranslation(t.toArray()).setRotation([0, 0, 0, 1]).setScale([1, 1, 1]);
  }
  const gfRoot = doc.createNode('gf_body');
  for (const i of order) { const pi = newParentIdx[i]; (pi >= 0 ? newNodes[pi] : gfRoot).addChild(newNodes[i]); }
  const remap = joints.map((_, i) => keep[i] ? order.indexOf(i) : mergeTo[i] >= 0 ? order.indexOf(mergeTo[i]) : -1);
  const buf = root.listBuffers()[0] ?? doc.createBuffer();
  const ibmNew = doc.createAccessor('gf_ibm').setType('MAT4').setBuffer(buf)
    .setArray(new Float32Array(order.flatMap(i => new Matrix4().makeTranslation(-newPos[i].x, -newPos[i].y, -newPos[i].z).toArray())));
  const newSkin = doc.createSkin('gf_skin').setInverseBindMatrices(ibmNew).setSkeleton(newNodes[hipsIdx]);
  for (const i of order) newSkin.addJoint(newNodes[i]);

  // --- vertices into the new space; joints remapped; weights merged and renormalised
  const done = new Set();
  const dropped = [], merged = [];
  joints.forEach((j, i) => { if (!keep[i]) (mergeTo[i] >= 0 ? merged : dropped).push(j.getName()); });
  for (const { node, prim } of prims) {
    if (done.has(prim)) continue; done.add(prim);
    const M = X.clone().multiply(meshWorld.get(node));
    const N = new Matrix4().extractRotation(XR.clone().multiply(new Matrix4().extractRotation(meshWorld.get(node))));
    const pos = prim.getAttribute('POSITION'), nor = prim.getAttribute('NORMAL');
    const e = [];
    const pa = new Float32Array(pos.getCount() * 3);
    for (let v = 0; v < pos.getCount(); v++) tmp.fromArray(pos.getElement(v, e)).applyMatrix4(M).toArray(pa, v * 3);
    prim.setAttribute('POSITION', doc.createAccessor().setType('VEC3').setBuffer(buf).setArray(pa));
    if (nor) {
      const na = new Float32Array(nor.getCount() * 3);
      for (let v = 0; v < nor.getCount(); v++) tmp.fromArray(nor.getElement(v, e)).applyMatrix4(N).normalize().toArray(na, v * 3);
      prim.setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setBuffer(buf).setArray(na));
    }
    if (prim.getAttribute('TANGENT')) prim.setAttribute('TANGENT', null);
    for (const t of prim.listTargets()) {
      const lin = new THREE.Matrix3().setFromMatrix4(M);
      for (const sem of t.listSemantics()) {
        const a = t.getAttribute(sem); if (!['POSITION', 'NORMAL'].includes(sem)) { t.setAttribute(sem, null); continue; }
        const out = new Float32Array(a.getCount() * 3);
        for (let v = 0; v < a.getCount(); v++) { tmp.fromArray(a.getElement(v, e)); (sem === 'POSITION' ? tmp.applyMatrix3(lin) : tmp.applyMatrix4(N).normalize()).toArray(out, v * 3); }
        t.setAttribute(sem, doc.createAccessor().setType('VEC3').setBuffer(buf).setArray(out));
      }
    }
    const J = prim.getAttribute('JOINTS_0'), Wt = prim.getAttribute('WEIGHTS_0');
    const n = J.getCount(), ja = order.length > 255 ? new Uint16Array(n * 4) : new Uint8Array(n * 4), wa = new Float32Array(n * 4);
    const jj = [], ww = [];
    for (let v = 0; v < n; v++) {
      J.getElement(v, jj); Wt.getElement(v, ww);
      const acc = new Map();
      for (let k = 0; k < 4; k++) { if (ww[k] <= 0) continue; const r = remap[jj[k]]; if (r < 0) continue; acc.set(r, (acc.get(r) ?? 0) + ww[k]); }
      if (!acc.size) acc.set(order.indexOf(hipsIdx), 1);
      const ent = [...acc].sort((a, b) => b[1] - a[1]).slice(0, 4);
      const sum = ent.reduce((a, [, w]) => a + w, 0);
      ent.forEach(([jn, w], k) => { ja[v * 4 + k] = jn; wa[v * 4 + k] = w / sum; });
    }
    prim.setAttribute('JOINTS_0', doc.createAccessor().setType('VEC4').setBuffer(buf).setArray(ja));
    prim.setAttribute('WEIGHTS_0', doc.createAccessor().setType('VEC4').setBuffer(buf).setArray(wa));
  }
  // skinned mesh nodes: fresh nodes at identity under gf_body
  const meshNodes = [...new Set(prims.map(p => p.node))];
  for (const old of meshNodes) gfRoot.addChild(doc.createNode(old.getName() || 'body').setMesh(old.getMesh()).setSkin(newSkin));
  // non-skinned meshes hanging off joints (helmets, props): keep them on the matching new joint
  const jointIdx = new Map(joints.map((j, i) => [j, i]));
  for (const node of root.listNodes()) {
    if (!node.getMesh() || node.getSkin() || meshNodes.includes(node) || newNodes.includes(node)) continue;
    let host = null;
    for (let p = parents.get(node); p; p = parents.get(p)) { const i = jointIdx.get(p); if (i !== undefined) { host = keep[i] ? i : (mergeTo[i] >= 0 ? mergeTo[i] : newParentIdx[i]); break; } }
    const w = X.clone().multiply(worldOf(node, parents));
    const hostW = host != null && host >= 0 ? new Matrix4().makeTranslation(newPos[host].x, newPos[host].y, newPos[host].z) : new Matrix4();
    const local = hostW.clone().invert().multiply(w);
    const nn = doc.createNode(node.getName()).setMesh(node.getMesh()).setMatrix(local.toArray());
    (host != null && host >= 0 ? newNodes[host] : gfRoot).addChild(nn);
  }
  // swap the scene over
  const keepNodes = new Set([gfRoot, ...newNodes.filter(Boolean)]);
  gfRoot.traverse(n => keepNodes.add(n));
  const scene = root.listScenes()[0] ?? doc.createScene('Scene');
  for (const c of scene.listChildren()) scene.removeChild(c);
  scene.addChild(gfRoot);
  for (const sc of root.listScenes()) if (sc !== scene) sc.dispose();
  if (!keepAnimations) for (const a of root.listAnimations()) disposeAnimation(a);
  for (const n of root.listNodes()) if (!keepNodes.has(n)) n.dispose();
  for (const sk of root.listSkins()) if (sk !== newSkin) sk.dispose();
  root.setDefaultScene(scene);
  const renamed = [...canon].filter(([a, b]) => a !== b).map(([a, b]) => `${a}→${b}`);
  return { renamed, dropped, merged, kept: order.map(i => newNodes[i].getName()),
    fix: { up: upFix, yawDeg: +(yaw * 180 / Math.PI).toFixed(1), scale: +s.toFixed(5) }, height: +(h0 * s).toFixed(3) };
}

/** Size and content numbers for a body GLB: { bytes, triangles, vertices, materials, textures: [{w,h,mime,bytes}], joints, skins }. */
export function bodyStats(doc, bytes) {
  const root = doc.getRoot();
  let triangles = 0, vertices = 0;
  for (const m of root.listMeshes()) for (const p of m.listPrimitives()) {
    const idx = p.getIndices(), pos = p.getAttribute('POSITION');
    vertices += pos?.getCount() ?? 0;
    triangles += (idx ? idx.getCount() : pos?.getCount() ?? 0) / 3;
  }
  return {
    bytes, triangles, vertices,
    materials: root.listMaterials().length,
    textures: root.listTextures().map(t => ({ size: t.getSize(), mime: t.getMimeType(), bytes: t.getImage()?.byteLength ?? 0 })),
    joints: root.listSkins()[0]?.listJoints().length ?? 0,
    skins: root.listSkins().length,
    animations: root.listAnimations().map(a => a.getName()),
    extensions: root.listExtensionsUsed().map(e => e.extensionName),
  };
}
