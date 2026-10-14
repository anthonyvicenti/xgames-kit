// Re-rest a body's thumbs along the standard's thumb, as ingest's `--fix thumbs` step. The kit's retarget gives a thumb
// the clip's own turn from the T-pose on top of the hand's swing (RIG.md §3), so a thumb that rests along another axis
// than the clips' thumb turns the right amount about the wrong axis: a twist of the clips' thumb about its own length
// becomes a bend of this one (quaternius-zombie's thumbs stick straight out of the palm, 75° off the clips' thumb, and
// bend back 92° in `knockdown` where the clips' thumb bends 5°). This turns each thumb, bones and skin, about its first
// joint until it rests along the standard's thumb, keeping its length and shape. Each vertex turns by its share of
// thumb weight, so the root of the thumb blends into the palm.
import { io } from '../deps.mjs';

/** The standard's thumb at rest (the shared clips' T-pose, left hand: LeftHandThumb1 → LeftHandThumb2), character axes. */
export const STANDARD_THUMB = [0.034, -0.019, 0.018];

const norm = v => { const l = Math.hypot(...v) || 1; return v.map(x => x / l); };
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const crossV = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
/** The rotation (axis, angle) that turns unit a onto unit b. */
function between(a, b) {
  const c = crossV(a, b), s = Math.hypot(...c), k = dot(a, b);
  return s < 1e-9 ? { axis: [1, 0, 0], angle: k > 0 ? 0 : Math.PI } : { axis: c.map(x => x / s), angle: Math.atan2(s, k) };
}
/** Rodrigues: v turned by angle about a unit axis. */
function turn(v, { axis, angle }) {
  const c = Math.cos(angle), s = Math.sin(angle), k = dot(axis, v), x = crossV(axis, v);
  return [0, 1, 2].map(i => v[i] * c + x[i] * s + axis[i] * k * (1 - c));
}
// column-major 4x4
const mul = (A, B) => { const o = new Array(16).fill(0); for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += A[k * 4 + r] * B[c * 4 + k]; return o; };
const apply = (M, v, w = 1) => [0, 1, 2].map(r => M[r] * v[0] + M[4 + r] * v[1] + M[8 + r] * v[2] + M[12 + r] * w);
function invert(m) {
  // general 4x4 inverse (column-major)
  const inv = new Array(16);
  inv[0] = m[5] * m[10] * m[15] - m[5] * m[11] * m[14] - m[9] * m[6] * m[15] + m[9] * m[7] * m[14] + m[13] * m[6] * m[11] - m[13] * m[7] * m[10];
  inv[4] = -m[4] * m[10] * m[15] + m[4] * m[11] * m[14] + m[8] * m[6] * m[15] - m[8] * m[7] * m[14] - m[12] * m[6] * m[11] + m[12] * m[7] * m[10];
  inv[8] = m[4] * m[9] * m[15] - m[4] * m[11] * m[13] - m[8] * m[5] * m[15] + m[8] * m[7] * m[13] + m[12] * m[5] * m[11] - m[12] * m[7] * m[9];
  inv[12] = -m[4] * m[9] * m[14] + m[4] * m[10] * m[13] + m[8] * m[5] * m[14] - m[8] * m[6] * m[13] - m[12] * m[5] * m[10] + m[12] * m[6] * m[9];
  inv[1] = -m[1] * m[10] * m[15] + m[1] * m[11] * m[14] + m[9] * m[2] * m[15] - m[9] * m[3] * m[14] - m[13] * m[2] * m[11] + m[13] * m[3] * m[10];
  inv[5] = m[0] * m[10] * m[15] - m[0] * m[11] * m[14] - m[8] * m[2] * m[15] + m[8] * m[3] * m[14] + m[12] * m[2] * m[11] - m[12] * m[3] * m[10];
  inv[9] = -m[0] * m[9] * m[15] + m[0] * m[11] * m[13] + m[8] * m[1] * m[15] - m[8] * m[3] * m[13] - m[12] * m[1] * m[11] + m[12] * m[3] * m[9];
  inv[13] = m[0] * m[9] * m[14] - m[0] * m[10] * m[13] - m[8] * m[1] * m[14] + m[8] * m[2] * m[13] + m[12] * m[1] * m[10] - m[12] * m[2] * m[9];
  inv[2] = m[1] * m[6] * m[15] - m[1] * m[7] * m[14] - m[5] * m[2] * m[15] + m[5] * m[3] * m[14] + m[13] * m[2] * m[7] - m[13] * m[3] * m[6];
  inv[6] = -m[0] * m[6] * m[15] + m[0] * m[7] * m[14] + m[4] * m[2] * m[15] - m[4] * m[3] * m[14] - m[12] * m[2] * m[7] + m[12] * m[3] * m[6];
  inv[10] = m[0] * m[5] * m[15] - m[0] * m[7] * m[13] - m[4] * m[1] * m[15] + m[4] * m[3] * m[13] + m[12] * m[1] * m[7] - m[12] * m[3] * m[5];
  inv[14] = -m[0] * m[5] * m[14] + m[0] * m[6] * m[13] + m[4] * m[1] * m[14] - m[4] * m[2] * m[13] - m[12] * m[1] * m[6] + m[12] * m[2] * m[5];
  inv[3] = -m[1] * m[6] * m[11] + m[1] * m[7] * m[10] + m[5] * m[2] * m[11] - m[5] * m[3] * m[10] - m[9] * m[2] * m[7] + m[9] * m[3] * m[6];
  inv[7] = m[0] * m[6] * m[11] - m[0] * m[7] * m[10] - m[4] * m[2] * m[11] + m[4] * m[3] * m[10] + m[8] * m[2] * m[7] - m[8] * m[3] * m[6];
  inv[11] = -m[0] * m[5] * m[11] + m[0] * m[7] * m[9] + m[4] * m[1] * m[11] - m[4] * m[3] * m[9] - m[8] * m[1] * m[7] + m[8] * m[3] * m[5];
  inv[15] = m[0] * m[5] * m[10] - m[0] * m[6] * m[9] - m[4] * m[1] * m[10] + m[4] * m[2] * m[9] + m[8] * m[1] * m[6] - m[8] * m[2] * m[5];
  const det = m[0] * inv[0] + m[1] * inv[4] + m[2] * inv[8] + m[3] * inv[12];
  return inv.map(x => x / det);
}

/**
 * A gf-humanoid-1 body GLB → the same body with each thumb resting along the standard's. → { bytes, turned: [{side,
 * degrees}] }. A thumb already within `within` degrees of the standard is left alone.
 */
export async function restThumbs(bytes, { within = 20 } = {}) {
  const IO = await io();
  const doc = await IO.readBinary(new Uint8Array(bytes));
  const root = doc.getRoot();
  const byName = new Map(root.listNodes().map(n => [n.getName(), n]));
  const turned = [];
  for (const side of ['Left', 'Right']) {
    const t1 = byName.get(`${side}HandThumb1`), t2 = byName.get(`${side}HandThumb2`);
    if (!t1 || !t2) continue;
    const p1 = apply(t1.getWorldMatrix(), [0, 0, 0]), p2 = apply(t2.getWorldMatrix(), [0, 0, 0]);
    const want = norm(side === 'Left' ? STANDARD_THUMB : [-STANDARD_THUMB[0], STANDARD_THUMB[1], STANDARD_THUMB[2]]);
    const rot = between(norm(p2.map((x, i) => x - p1[i])), want);
    const degrees = +(rot.angle * 180 / Math.PI).toFixed(1);
    if (degrees <= within) continue;
    // every bone of the thumb below Thumb1 moves with it (their rest rotations stay identity: only positions turn)
    const thumbBones = new Set();
    const walkDown = n => { thumbBones.add(n); for (const c of n.listChildren()) walkDown(c); };
    walkDown(t1);
    const oldWorld = new Map([...thumbBones].map(n => [n, apply(n.getWorldMatrix(), [0, 0, 0])]));
    for (const n of thumbBones) {
      if (n === t1) continue;
      const parent = n.getParentNode(), pw = oldWorld.get(parent), w = oldWorld.get(n);
      const pTurned = parent === t1 ? p1 : turn(pw.map((x, i) => x - p1[i]), rot).map((x, i) => x + p1[i]);
      const wTurned = turn(w.map((x, i) => x - p1[i]), rot).map((x, i) => x + p1[i]);
      n.setTranslation(wTurned.map((x, i) => x - pTurned[i]));
    }
    // the skin: per skinned primitive, each vertex turned by its share of thumb weight, in the bind frame
    for (const node of root.listNodes()) {
      const skin = node.getSkin(), mesh = node.getMesh();
      if (!skin || !mesh) continue;
      const joints = skin.listJoints(), ibm = skin.getInverseBindMatrices();
      const handIdx = joints.indexOf(byName.get(`${side}Hand`));
      if (handIdx < 0) continue;
      // the bind frame: joint world × its inverse bind matrix, the same for every joint of a skin at bind
      const bindM = mul(byName.get(`${side}Hand`).getWorldMatrix(), ibm.getElement(handIdx, []));
      const bindInv = invert(bindM);
      const isThumb = joints.map(j => thumbBones.has(j));
      // the new inverse bind matrices of the moved bones: their world at bind is a translation, then the bind frame
      joints.forEach((j, k) => {
        if (!isThumb[k] || j === t1) return;
        const W = j.getWorldMatrix();
        ibm.setElement(k, mul(invert(W), bindM));
      });
      for (const prim of mesh.listPrimitives()) {
        const P = prim.getAttribute('POSITION'), N = prim.getAttribute('NORMAL'), J = prim.getAttribute('JOINTS_0'), Wt = prim.getAttribute('WEIGHTS_0');
        const n = P.getCount(), pos = new Float32Array(n * 3), nor = N ? new Float32Array(n * 3) : null;
        for (let i = 0; i < n; i++) {
          const v = P.getElement(i, []), j = J.getElement(i, []), w = Wt.getElement(i, []);
          let share = 0; for (let k = 0; k < 4; k++) if (isThumb[j[k]]) share += w[k];
          let out = v, nv = N ? N.getElement(i, []) : null;
          if (share > 1e-4) {
            const r = { axis: rot.axis, angle: rot.angle * Math.min(1, share) };
            const wp = apply(bindM, v), moved = turn(wp.map((x, a) => x - p1[a]), r).map((x, a) => x + p1[a]);
            out = apply(bindInv, moved);
            if (nv) nv = norm(apply(bindInv, turn(apply(bindM, nv, 0), r), 0));
          }
          pos.set(out, i * 3); if (nor) nor.set(nv, i * 3);
        }
        P.setArray(pos).setNormalized(false);
        if (N) N.setArray(nor).setNormalized(false);
      }
    }
    turned.push({ side, degrees });
  }
  return { bytes: Buffer.from(await IO.writeBinary(doc)), turned };
}
