#!/usr/bin/env node
// creatures.mjs: the stand-in creature set, one body for each archetype beside gf-humanoid-1 (kit/character/CREATURES.md):
// a worm standing up, a snake lying down, a slime blob, a pup on four legs, a bird. Round toy shapes with big eyes,
// generated from three.js primitives (no third-party art, CC0), then rigged by the kit's own autorig
// (builder/art/rig/autorig.mjs), so the set also proves that path on every archetype. The body is `tint_body`: the kit
// paints it in the player's colour; eyes, belly, beak and feet keep their own.
//
//   node runtimes/three/tools/creatures.mjs [--variant <id>|all] [--out <dir>, default .cache/creatures]
//   then: gamesfun art ingest <dir> --pack xk-creature-bodies --category body --rig <its rig> (one per archetype)
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { REPO } from '../../../builder/tools/lib/paths.mjs';

const tool = p => pathToFileURL(join(REPO, 'builder/tools/lib', p)).href;
await import(tool('char-node.mjs'));
const { io, gltfCore, THREE } = await import(tool('char-deps.mjs'));
const { mergeGeometries } = await import('three/addons/utils/BufferGeometryUtils.js');
const { autorig } = await import(pathToFileURL(join(REPO, 'builder/art/rig/autorig.mjs')).href);

const COLORS = { tint_body: '#ff8fb1', belly: '#ffe3cf', eye_white: '#ffffff', eye_dark: '#1b1622', beak: '#ffb23d', feet: '#ff9f43', inner: '#d9577d' };
const M = (x, y, z, sx = 1, sy = 1, sz = 1, rx = 0, ry = 0, rz = 0) => new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new THREE.Vector3(sx, sy, sz));
const sphere = (r, m, ws = 24, hs = 16) => new THREE.SphereGeometry(r, ws, hs).applyMatrix4(m);
const cyl = (r1, r2, h, m, s = 14) => new THREE.CylinderGeometry(r1, r2, h, s, 4).applyMatrix4(m);

/** A tube swept along points with a radius at each: rings in the plane facing the path, capped round at both ends. */
function sweep(path, { seg = 18 } = {}) {
  const pos = [], idx = [];
  const n = path.length;
  for (let i = 0; i < n; i++) {
    const p = path[i], prev = path[Math.max(0, i - 1)], next = path[Math.min(n - 1, i + 1)];
    const t = new THREE.Vector3(next.x - prev.x, next.y - prev.y, next.z - prev.z).normalize();
    const a = Math.abs(t.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
    const u = new THREE.Vector3().crossVectors(t, a).normalize(), v = new THREE.Vector3().crossVectors(t, u).normalize();
    for (let k = 0; k < seg; k++) {
      const ang = (k / seg) * Math.PI * 2;
      pos.push(p.x + (u.x * Math.cos(ang) + v.x * Math.sin(ang)) * p.r, p.y + (u.y * Math.cos(ang) + v.y * Math.sin(ang)) * p.r, p.z + (u.z * Math.cos(ang) + v.z * Math.sin(ang)) * p.r);
    }
  }
  for (let i = 0; i < n - 1; i++) for (let k = 0; k < seg; k++) {
    const a = i * seg + k, b = i * seg + ((k + 1) % seg), c = (i + 1) * seg + k, d = (i + 1) * seg + ((k + 1) % seg);
    idx.push(a, c, b, b, c, d);
  }
  // caps: a centre point at each end
  const cap = (i, flip) => { const c = pos.length / 3; const p = path[i]; pos.push(p.x, p.y, p.z); for (let k = 0; k < seg; k++) { const a = i * seg + k, b = i * seg + ((k + 1) % seg); if (flip) idx.push(c, b, a); else idx.push(c, a, b); } };
  cap(0, false); cap(n - 1, true);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals();
  return g;
}
/** Points along a path with a radius profile: f(t) → {x, y, z, r}, t from 0 to 1, round ends. */
const along = (n, f) => Array.from({ length: n + 1 }, (_, i) => { const t = i / n; const p = f(t); const end = Math.min(t, 1 - t) * n; const round = end < 2.5 ? Math.sqrt(Math.max(0.02, 1 - Math.pow(1 - end / 2.5, 2))) : 1; return { ...p, r: p.r * round }; });

/** Two eyes looking out along `dir` from a head at `at` of radius r. */
function eyes(at, r, { dir = new THREE.Vector3(0, 0, 1), apart = 0.42, size = 0.42 } = {}) {
  const white = [], dark = [];
  for (const s of [1, -1]) {
    const side = new THREE.Vector3(s, 0, 0);
    const p = at.clone().add(dir.clone().multiplyScalar(r * 0.78)).add(side.multiplyScalar(r * apart)).add(new THREE.Vector3(0, r * 0.18, 0));
    white.push(sphere(r * size, M(p.x, p.y, p.z, 1, 1.15, 0.7)));
    const q = p.clone().add(dir.clone().multiplyScalar(r * size * 0.62));
    dark.push(sphere(r * size * 0.48, M(q.x, q.y + r * 0.03, q.z, 1, 1.1, 0.5)));
  }
  return { eye_white: white, eye_dark: dark };
}

export const VARIANTS = {
  'worm-pink': {
    archetype: 'worm', label: 'Pink worm', describe: 'a pink worm standing up in a soft S with big round eyes (a stand-in for a worm or serpent body)',
    parts() {
      const H = 0.86;
      const path = along(26, t => ({ x: 0, y: 0.015 + t * (H - 0.03), z: 0.06 * Math.sin(t * Math.PI * 1.4) - 0.02, r: 0.115 * (1 - 0.18 * t) }));
      const head = new THREE.Vector3(0, H * 0.8, 0.06 * Math.sin(0.8 * Math.PI * 1.4) - 0.02);
      return { tint_body: [sweep(path)], ...eyes(head, 0.1, { apart: 0.45, size: 0.45 }) };
    },
  },
  'snake-green': {
    archetype: 'worm', label: 'Green snake', describe: 'a green snake lying along the ground with a round head and big eyes (a stand-in for a serpent body)',
    parts() {
      const path = along(30, t => ({ x: 0.05 * Math.sin(t * Math.PI * 2), y: 0.085 * (0.45 + 0.55 * Math.sin(Math.min(1, t * 1.6) * Math.PI / 2)) + (t > 0.85 ? (t - 0.85) * 0.12 : 0), z: -0.75 + 1.45 * t, r: t > 0.85 ? 0.085 + (t - 0.85) * 0.25 : 0.085 * (0.35 + 0.65 * Math.sin(Math.min(1, t * 1.6) * Math.PI / 2)) }));
      const head = new THREE.Vector3(path.at(-4).x, path.at(-4).y, path.at(-4).z);
      return { tint_body: [sweep(path)], ...eyes(head.add(new THREE.Vector3(0, 0.03, 0)), 0.1, { apart: 0.55, size: 0.36 }) };
    },
    tint: '#58c26b',
  },
  'slime-blue': {
    archetype: 'blob', label: 'Slime', describe: 'a round jelly slime, flat underneath, with big eyes and no limbs (a stand-in for a blob body)',
    parts() {
      // a flat-bottomed dome: the lower half squashed to 0.12 m, the upper half 0.3 m
      const prof = Array.from({ length: 17 }, (_, i) => { const a = -Math.PI / 2 + (i / 16) * Math.PI; return new THREE.Vector2(Math.max(0.001, Math.cos(a) * 0.32), a < 0 ? 0.12 * (Math.sin(a) + 1) : 0.12 + 0.3 * Math.sin(a)); });
      const body = new THREE.LatheGeometry(prof, 32);
      const box = new THREE.Box3().setFromBufferAttribute(body.attributes.position);
      body.translate(0, -box.min.y, 0);
      return { tint_body: [body], belly: [sphere(0.2, M(0, 0.17, 0.2, 1, 0.8, 0.45))], ...eyes(new THREE.Vector3(0, 0.3, 0.12), 0.2, { apart: 0.5, size: 0.38 }) };
    },
    tint: '#58b8ff',
  },
  'pup-tan': {
    archetype: 'quadruped', label: 'Pup', describe: 'a round toy pup on four short legs with floppy ears, a tail and big eyes (a stand-in for a quadruped body)',
    parts() {
      const legs = [], feet = [];
      for (const [x, z] of [[0.11, 0.2], [-0.11, 0.2], [0.11, -0.2], [-0.11, -0.2]]) { legs.push(cyl(0.055, 0.05, 0.26, M(x, 0.15, z))); feet.push(sphere(0.06, M(x, 0.035, z + 0.015, 1, 0.6, 1.2))); }
      const body = new THREE.CapsuleGeometry(0.17, 0.32, 8, 20).applyMatrix4(M(0, 0.38, 0, 1, 0.95, 1, Math.PI / 2));
      const head = sphere(0.16, M(0, 0.56, 0.36));
      const snout = sphere(0.075, M(0, 0.52, 0.5, 1, 0.8, 1));
      const ears = [sphere(0.07, M(0.14, 0.62, 0.32, 0.5, 1.3, 0.8, 0, 0, 0.5)), sphere(0.07, M(-0.14, 0.62, 0.32, 0.5, 1.3, 0.8, 0, 0, -0.5))];
      const tail = new THREE.CapsuleGeometry(0.035, 0.2, 6, 12).applyMatrix4(M(0, 0.5, -0.38, 1, 1, 1, -0.75));
      return { tint_body: [body, head, ...legs, tail], belly: [snout, sphere(0.13, M(0, 0.3, 0.05, 1, 0.6, 1.6))], inner: ears, feet, ...eyes(new THREE.Vector3(0, 0.6, 0.38), 0.16, { apart: 0.42, size: 0.32 }) };
    },
    tint: '#e0a35c',
  },
  'bird-red': {
    archetype: 'flyer', label: 'Bird', describe: 'a round little bird with broad wings, a tail fan, a beak, two thin legs and big eyes (a stand-in for a flyer body)',
    parts() {
      const body = sphere(0.19, M(0, 0.34, 0, 1, 0.95, 1.25));
      const head = sphere(0.13, M(0, 0.52, 0.17));
      const wings = [sphere(0.3, M(0.4, 0.38, -0.02, 1, 0.09, 0.42), 32, 12), sphere(0.3, M(-0.4, 0.38, -0.02, 1, 0.09, 0.42), 32, 12)];
      const tail = sphere(0.14, M(0, 0.36, -0.3, 1, 0.12, 1, 0.35));
      const beak = new THREE.ConeGeometry(0.045, 0.12, 12).applyMatrix4(M(0, 0.5, 0.32, 1, 1, 1, Math.PI / 2));
      const legs = [cyl(0.018, 0.018, 0.16, M(0.06, 0.1, 0.02)), cyl(0.018, 0.018, 0.16, M(-0.06, 0.1, 0.02))];
      const feet = [sphere(0.035, M(0.06, 0.02, 0.05, 1, 0.4, 1.6)), sphere(0.035, M(-0.06, 0.02, 0.05, 1, 0.4, 1.6))];
      return { tint_body: [body, head, ...wings, tail], belly: [sphere(0.15, M(0, 0.3, 0.1, 1, 1, 0.8))], beak: [beak, ...feet], feet: legs, ...eyes(new THREE.Vector3(0, 0.54, 0.2), 0.13, { apart: 0.5, size: 0.38 }) };
    },
    tint: '#ff6b5e',
  },
};

/** One stand-in: its parts merged per material, a glTF document, then autorig. → { bytes, archetype, label, describe, did, report } */
export async function makeCreature(id) {
  const v = VARIANTS[id];
  if (!v) throw new Error(`no creature "${id}" (have ${Object.keys(VARIANTS).join(', ')})`);
  const doc = new gltfCore.Document();
  doc.setLogger(new gltfCore.Logger(gltfCore.Logger.Verbosity.SILENT));
  const buf = doc.createBuffer();
  const mesh = doc.createMesh(id);
  for (const [name, list] of Object.entries(v.parts())) {
    const g = mergeGeometries(list.map(x => (x.index ? x : x.toNonIndexed()).toNonIndexed()), false);
    g.computeVertexNormals();
    const col = new THREE.Color(name === 'tint_body' ? v.tint ?? COLORS.tint_body : COLORS[name]);
    const mat = doc.createMaterial(name).setBaseColorFactor([...col.toArray().map(c => Math.pow(c, 2.2)), 1]).setRoughnessFactor(name.startsWith('eye') ? 0.25 : 0.6).setMetallicFactor(0);
    const P = g.attributes.position.array, N = g.attributes.normal.array;
    mesh.addPrimitive(doc.createPrimitive().setMaterial(mat)
      .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setBuffer(buf).setArray(new Float32Array(P)))
      .setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setBuffer(buf).setArray(new Float32Array(N))));
  }
  const node = doc.createNode(id).setMesh(mesh);
  doc.createScene(id).addChild(node);
  const raw = await (await io()).writeBinary(doc);
  const r = await autorig(raw, { archetype: v.archetype, id, tint: ['tint_body'], tintMix: 1 });
  return { bytes: r.bytes, archetype: v.archetype, label: v.label, describe: v.describe, did: r.did, report: r.report };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const a = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
  const which = a('--variant', 'all');
  const out = resolve(a('--out', resolve(REPO, '.cache/creatures')));
  mkdirSync(out, { recursive: true });
  for (const id of which === 'all' ? Object.keys(VARIANTS) : [which]) {
    const r = await makeCreature(id);
    writeFileSync(join(out, `${id}.glb`), r.bytes);
    console.log(`${id}.glb  ${(r.bytes.length / 1024).toFixed(0)} KB  ${r.archetype}  ${r.report.size.join(' x ')} m  bones ${r.report.bones.join(',')}`);
  }
}
