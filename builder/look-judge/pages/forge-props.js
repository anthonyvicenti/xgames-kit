// The look judge's props tile for the forge runtime (kind dark): the kind's props (kinds/<id>.json → props.forge, forge
// names under ruins/) in two rows on the arena's ground, in the kind's look preset, lit by two standing torches, drawn
// by the forge renderer as a game draws them. No first-person layer. Served by the forge lookdev's server (/kit/,
// /library/), this page under /sheet/. ?kind=<id>&preset=<look id>
import { createHost } from '/kit/host.js';
import { createRender } from '/kit/render.js';
import * as look from '/kit/look.js';

const Q = new URLSearchParams(location.search);
const S = window.__sheet = { ready: false, errors: [], info: {} };
addEventListener('error', e => S.errors.push(String(e.error?.stack ?? e.message)));
addEventListener('unhandledrejection', e => S.errors.push(String(e.reason?.stack ?? e.reason)));
const bytes = async path => { const r = await fetch(`/library/${path}`); if (!r.ok) throw new Error(`${path}: ${r.status}`); return new Uint8Array(await r.arrayBuffer()); };
const lookAt = (eye, at) => { const d = [at[0] - eye[0], at[1] - eye[1], at[2] - eye[2]]; return { yaw: Math.atan2(-d[0], -d[2]), pitch: Math.atan2(d[1], Math.hypot(d[0], d[2])) }; };

/** A flat ground square, `size` metres, UVs repeating `repeat` times (the ground texture is laid over it). */
function planeGlb(size, repeat) {
  const s = size / 2;
  const pos = [-s, 0, -s, s, 0, -s, s, 0, s, -s, 0, s], nrm = [0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0], uv = [0, 0, repeat, 0, repeat, repeat, 0, repeat], idx = [0, 3, 2, 0, 2, 1];
  const bin = new Uint8Array(144);
  const f = new Float32Array(bin.buffer, 0, 32); f.set(pos, 0); f.set(nrm, 12); f.set(uv, 24);
  new Uint16Array(bin.buffer, 128, 6).set(idx);
  const json = JSON.stringify({ asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ name: 'ground', mesh: 0 }], meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: 3 }] }],
    buffers: [{ byteLength: bin.length }], bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 48 }, { buffer: 0, byteOffset: 48, byteLength: 48 }, { buffer: 0, byteOffset: 96, byteLength: 32 }, { buffer: 0, byteOffset: 128, byteLength: 12 }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 4, type: 'VEC3', min: [-s, 0, -s], max: [s, 0, s] }, { bufferView: 1, componentType: 5126, count: 4, type: 'VEC3' }, { bufferView: 2, componentType: 5126, count: 4, type: 'VEC2' }, { bufferView: 3, componentType: 5123, count: 6, type: 'SCALAR' }] });
  const enc = new TextEncoder().encode(json), jl = (enc.length + 3) & ~3;
  const out = new Uint8Array(28 + jl + bin.length), dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true); dv.setUint32(4, 2, true); dv.setUint32(8, out.length, true);
  dv.setUint32(12, jl, true); dv.setUint32(16, 0x4e4f534a, true); out.fill(0x20, 20, 20 + jl); out.set(enc, 20);
  dv.setUint32(20 + jl, bin.length, true); dv.setUint32(24 + jl, 0x004e4942, true); out.set(bin, 28 + jl);
  return out;
}

const kind = await (await fetch(`/sheet-kinds/${Q.get('kind')}.json`)).json();
const canvas = document.getElementById('c');
canvas.width = innerWidth; canvas.height = innerHeight;
const host = await createHost(canvas);
host.resize(canvas.width, canvas.height);
const r = createRender(host);
r.fp.auto(false); r.fp.visible(false);
const cfg = look.lookConfig(Q.get('preset') ?? kind.look?.forge?.preset ?? 'moonlit-ruins');
host.setLook(look.pack(cfg, 'high'));
host.lens(50, 0.05, 200);
host.eyes(false);
const torch = look.torch(cfg);
const cat = await (await fetch('/library/catalog.json')).json();
const A = cat.arenaMeshy ?? cat.arenaGrim ?? cat.arena;
const slots = new Map(), slotOf = f => { if (!slots.has(f)) slots.set(f, slots.size); return slots.get(f); };
// the ground: the arena's own picture, laid in world space
const ground = await host.model(planeGlb(80, 80 / (A.ground.size / A.ground.repeat)));
r.surface(ground.id, { texture: await host.texture(await bytes(A.ground.texture), 'image/jpeg'), tile: A.ground.size / A.ground.repeat, space: 'world' });
host.instance(ground.id, slotOf(A.ground.texture), { at: [0, 0, 0] });
// the props: two rows, the tallest at the back
const names = kind.props?.forge ?? [];
const list = [];
for (const n of names) {
  const file = `ruins/${n}.glb`;
  try { const m = await host.model(await bytes(file)); list.push({ n, file, m, w: Math.max(m.bounds[3] - m.bounds[0], m.bounds[5] - m.bounds[2]) + 0.6, h: m.bounds[4] - m.bounds[1] }); }
  catch (e) { S.errors.push(`no prop ${n} (${e.message})`); }
}
list.sort((a, b) => b.h - a.h);
const back = list.slice(0, Math.ceil(list.length / 2)), front = list.slice(back.length);
let span = 0, maxH = 0;
for (const [row, z] of [[back, -1.8], [front, 1.4]]) {
  const width = row.reduce((s, x) => s + x.w, 0); let x = -width / 2;
  for (const p of row) { x += p.w / 2; host.instance(p.m.id, slotOf(p.file), { at: [x, 0, z], rot: 200 }); x += p.w / 2; maxH = Math.max(maxH, p.h); }
  span = Math.max(span, width);
}
// two standing torches at the ends of the back row, their flames lit
const fires = [];
const tm = await host.model(await bytes('ruins/torch-standing.glb')).catch(() => null);
for (const x of [-span / 2 - 0.9, span / 2 + 0.9]) { if (tm) host.instance(tm.id, slotOf('ruins/torch-standing.glb'), { at: [x, 0, -0.4] }); fires.push({ at: [x, 1.7, -0.4], seed: fires.length + 1 }); }
fires.push({ at: [0, 2.2, 3.5], seed: 3 });
const dist = Math.max(span * 0.62, maxH * 1.8, 5.5), eye = [0, Math.max(1.9, maxH * 0.75), dist], at = [0, Math.min(maxH * 0.38, 1.3), -0.2];
const { yaw, pitch } = lookAt(eye, at);
host.pose(eye[0], eye[1], eye[2], yaw, pitch);
S.info.props = list.map(p => p.n);
let t = 0, drawn = 0;
const frame = () => {
  t += 1 / 60;
  host.setLights(fires.map(f => ({ x: f.at[0], y: f.at[1], z: f.at[2], range: torch.range, color: torch.color, intensity: torch.intensity * look.flicker(t, f.seed, torch.flicker) })));
  host.render(t);
  if (++drawn >= 6) S.ready = true;
  requestAnimationFrame(frame);
};
requestAnimationFrame(frame);
