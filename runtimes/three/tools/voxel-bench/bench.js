// The voxel world's bench (runtimes/three/tools/voxel-shots.mjs drives it): a kind's voxel world drawn the way a game
// draws it (the kind's look through applyLook, the world through worlds/voxel/world.js), with the camera at one of a
// few framings found in the world itself, and a frame-cost run that flies the camera over the land.
//   ?kind=blocky&shot=horizon|cave|pit|build|third&quality=high|low&time=day
// window.__bench answers the driver: { ready, errors, info, perf(ms) }.
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { createRenderer, applyLook } from '/kit/look/look.js';

const Q = new URLSearchParams(location.search);
const SHOT = Q.get('shot') ?? 'horizon', QUALITY = Q.get('quality') ?? 'high';
const B = window.__bench = { ready: false, errors: [], info: { shot: SHOT, quality: QUALITY } };
addEventListener('error', e => B.errors.push(String(e.error?.stack ?? e.message)));
addEventListener('unhandledrejection', e => B.errors.push(String(e.reason?.stack ?? e.reason)));

const kind = await (await fetch(`/xk/kinds/${Q.get('kind') ?? 'blocky'}.json`)).json();
const L3 = kind.look.three, time = Q.get('time') ?? L3.time ?? 'day';
const lookCfg = { preset: L3.preset, ...(L3.values ?? {}), times: { [time]: L3.values ?? {} } };
const W = kind.sheet?.world ?? kind.world?.three ?? {};
const base = await (await fetch('/kit/world/voxel/default.json')).json();
const preset = W.preset ? await (await fetch(`/xk/${W.preset}`)).json() : { voxel: {} };
const pv = preset.voxel ?? {};
const cfg = { template: 'voxel', voxel: { ...base, ...pv, textures: { ...base.textures, ...(pv.textures ?? {}) }, terrain: { ...base.terrain, ...(pv.terrain ?? {}), plaza: { ...base.terrain.plaza, ...(pv.terrain?.plaza ?? {}) } } } };
if (Q.get('seed')) cfg.voxel.terrain.seed = Number(Q.get('seed'));

const canvas = document.getElementById('view');
const renderer = createRenderer(canvas, lookCfg, QUALITY);
renderer.setPixelRatio(Number(Q.get('dpr') ?? 1));
renderer.setSize(innerWidth, innerHeight, false);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(Number(Q.get('fov') ?? 70), innerWidth / innerHeight, 0.05, 900);
const ctx = { scene, camera, renderer, quality: QUALITY, RAPIER };
const noise = await new THREE.TextureLoader().loadAsync('/lib3/textures/noise-soft.png');
noise.wrapS = noise.wrapT = THREE.RepeatWrapping; noise.colorSpace = THREE.NoColorSpace;
const look = applyLook(ctx, lookCfg, { quality: QUALITY, time, textures: { noise }, captureApi: false });
await RAPIER.init();
ctx.physics = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
const assets = {
  async texture(id) {
    const name = id.replace('world.voxel.texture.', ''), file = cfg.voxel.textures[name];
    if (!file) throw new Error(`no texture ${id}`);
    const t = await new THREE.TextureLoader().loadAsync(file.replace(/^library:/, '/lib3/'));
    t.colorSpace = THREE.SRGBColorSpace; return t;
  },
};
ctx.worldSlug = '';
const t0 = performance.now();
const { loadWorld } = await import('/kit/world/voxel/world.js');
const world = await loadWorld({ ...ctx, assets, look }, cfg);
B.info.loadMs = Math.round(performance.now() - t0);
B.info.world = world.voxel.stats();
const V = world.voxel, G = V.grid, T = V.terrain, [sx, sy, sz] = G.size;
const id = name => V.table.byId.get(name)?.n ?? 0;
const at = T.plaza.at, py = T.plaza.y;

// ---- framings found in the world ----
const v3 = (x, y, z) => new THREE.Vector3(x, y, z);
const aim = (eye, target, fov) => { camera.position.copy(eye); camera.lookAt(target); if (fov) camera.fov = fov; camera.updateProjectionMatrix(); };
const top = (x, z) => G.top(x, z);
const land = (x, z) => T.heights[z * sx + x];   // the ground (G.top counts tree tops)
function openDistance(x, y, z, yaw, max = 70) {
  for (let d = 2; d < max; d += 1) { const X = Math.floor(x + Math.sin(yaw) * d), Z = Math.floor(z + Math.cos(yaw) * d); if (X < 0 || Z < 0 || X >= sx || Z >= sz) return max; if (G.solidAt(X, Math.floor(y), Z)) return d; }
  return max;
}
const ground = b => [id('grass'), id('snow-grass'), id('snow'), id('stone'), id('sand'), id('gravel')].includes(b);
function horizon() {
  // a grassy rise within 60 cells of the spawn square (not a snowy peak), facing the widest open view: the mean open
  // distance over a 60° fan, so a gap between a cliff and a tree never wins
  let best = null;
  const snow = T.model.snowline - 4;
  for (let z = 10; z < sz - 10; z += 3) for (let x = 10; x < sx - 10; x += 3) {
    const h = land(x, z), d = Math.hypot(x - at[0], z - at[1]);
    if (d > 60 || h >= snow || G.block(x, h - 1, z) !== id('grass') || top(x, z) > h + 1) continue;
    for (let k = 0; k < 16; k++) {
      const yaw = k / 16 * Math.PI * 2;
      let fan = 0;
      for (let f = -3; f <= 3; f++) fan += openDistance(x + 0.5, h + 1.4, z + 0.5, yaw + f * 0.17, 90);
      const score = fan / 7 + (h - T.water) * 0.6 - d * 0.05;
      if (!best || score > best.score) best = { x, z, h, yaw, score };
    }
  }
  const e = v3(best.x + 0.5, best.h + 1.65, best.z + 0.5);
  aim(e, e.clone().add(v3(Math.sin(best.yaw) * 20, -2.0, Math.cos(best.yaw) * 20)), 70);
  return { at: [best.x, best.h, best.z], yaw: +best.yaw.toFixed(2), score: +best.score.toFixed(1) };
}
function cave() {
  // an open cavern with the most block light and no sun, looking at its brightest wall
  let best = null;
  const L = V.light.data;
  for (let y = 4; y < sy - 4; y += 1) for (let z = 6; z < sz - 6; z += 2) for (let x = 6; x < sx - 6; x += 2) {
    const i = G.index(x, y, z), w = L[i];
    if (G.data[i] || (w >> 12) > 1) continue;
    const blk = ((w >> 8) & 15) + ((w >> 4) & 15) + (w & 15);
    if (blk < 6) continue;
    let air = 0, sky = 0;
    for (let dy = -1; dy <= 2; dy++) for (let dz = -3; dz <= 3; dz++) for (let dx = -3; dx <= 3; dx++) { if (!G.solidAt(x + dx, y + dy, z + dz)) air++; sky += V.light.at(x + dx * 3, y + dy, z + dz * 3) >> 12; }
    if (sky > 2) continue;   // deep in, not at a cave's mouth
    if (!G.solidAt(x, y - 1, z)) continue;
    // a big cavern, lit but not drowned in light where the camera stands, with warm and cool light both reaching it
    const warm = (w >> 8) & 15, cool = w & 15;
    const score = air * 1.5 + Math.min(warm, cool) * 4 - Math.max(0, blk - 14) * 3;
    if (!best || score > best.score) best = { x, y, z, score };
  }
  if (!best) return { found: false };
  const e = v3(best.x + 0.5, best.y + 1.4, best.z + 0.5);
  // look across the cavern: the direction that runs furthest through open cave, with the most light along it
  let yaw = 0, bestL = -1;
  for (let k = 0; k < 24; k++) {
    const a = k / 24 * Math.PI * 2; let sum = 0, open = 0;
    for (let d = 1; d < 24; d++) { const X = Math.floor(e.x + Math.sin(a) * d), Z = Math.floor(e.z + Math.cos(a) * d), Y = Math.floor(e.y - 0.4); if (G.solidAt(X, Y, Z)) break; open = d; const w = V.light.at(X, Y, Z); sum += ((w >> 8) & 15) + ((w >> 4) & 15) + (w & 15); }
    const score = open * 6 + sum * 0.5;
    if (score > bestL) { bestL = score; yaw = a; }
  }
  aim(e, e.clone().add(v3(Math.sin(yaw) * 10, -1.4, Math.cos(yaw) * 10)), 75);
  return { found: true, at: [best.x, best.y, best.z], score: best.score };
}
function dig(x0, z0, w, depth) {
  // a pit with a stair down one side, as a player digs it (the world's own edits: light and meshes follow)
  const h = land(x0, z0);
  for (let d = 0; d < depth; d++) for (let z = z0; z < z0 + w; z++) for (let x = x0; x < x0 + w; x++) {
    const y = h - 1 - d; if (y < 2) continue;
    const stair = x === x0 && z - z0 >= d % w;
    if (!stair) V.apply(x, y, z, 0);
  }
  for (let y = h + 3; y >= h - depth; y--) for (let z = z0; z < z0 + w; z++) for (let x = x0; x < x0 + w; x++) if (y >= h) V.apply(x, y, z, 0);
  V.apply(x0 + w - 1, h - depth + 1, z0 + w - 1, id('lantern'));
  return h;
}
function pit() {
  // the flattest open ground 12-30 cells from the spawn square, with no tree on it
  let best = null;
  for (let z = at[1] - 40; z < at[1] + 40; z++) for (let x = at[0] - 40; x < at[0] + 40; x++) {
    const d = Math.hypot(x - at[0], z - at[1]); if (d < 12 || x < 4 || z < 4 || x > sx - 12 || z > sz - 12) continue;
    let lo = 1e9, hi = -1e9, tree = false;
    for (let k = -2; k < 11; k++) for (let j = -2; j < 11; j++) { const h = land(x + j, z + k); lo = Math.min(lo, h); hi = Math.max(hi, h); if (top(x + j, z + k) > h + 1) tree = true; }
    if (tree || lo <= T.water + 1) continue;
    const score = hi - lo + d * 0.02;
    if (!best || score < best.score) best = { x, z, score };
  }
  const x0 = best.x, z0 = best.z, w = 9, h = dig(x0, z0, w, 11);
  for (let k = 0; k < 60; k++) world.update();
  // over the near rim of the pit (open air: the pit is below), looking down to its far bottom corner
  aim(v3(x0 + w / 2, h + 2.6, z0 + 0.5), v3(x0 + w / 2 + 0.5, h - 9, z0 + w - 1), 75);
  return { at: [x0, h, z0] };
}
function build() {
  // a small house beside the spawn square: planks, brick, glass, a door gap, a lantern; looked at from 6 m
  const x0 = T.plaza.min[0] + 1, z0 = T.plaza.min[2] + 1, y0 = py;
  for (let y = y0; y < y0 + 4; y++) for (let z = z0; z < z0 + 6; z++) for (let x = x0; x < x0 + 6; x++) {
    const wall = x === x0 || x === x0 + 5 || z === z0 || z === z0 + 5; if (!wall) continue;
    const corner = (x === x0 || x === x0 + 5) && (z === z0 || z === z0 + 5);
    let b = corner ? 'log' : y === y0 + 3 ? 'stone-brick' : 'planks';
    if (!corner && y === y0 + 1 && (x === x0 + 2 || x === x0 + 3)) b = 'glass';
    if (x === x0 + 5 && z === z0 + 2 && y < y0 + 2) b = null;
    if (b) V.apply(x, y, z, id(b));
  }
  for (let z = z0 - 1; z < z0 + 7; z++) for (let x = x0 - 1; x < x0 + 7; x++) V.apply(x, y0 + 4, z, id(Math.abs(x - x0 - 2.5) + Math.abs(z - z0 - 2.5) < 5 ? 'brick' : 'brick'));
  V.apply(x0 + 6, y0 + 2, z0 + 1, id('lantern'));
  for (let k = 0; k < 60; k++) world.update();
  aim(v3(x0 + 10, y0 + 2.4, z0 + 9.5), v3(x0 + 3, y0 + 1.8, z0 + 2.5), 65);
  return { at: [x0, y0, z0] };
}
function third() {
  aim(v3(at[0] + 9, py + 6, at[1] + 14), v3(at[0], py + 1.5, at[1]), 58);
  return {};
}
// friends in a cave: three block bodies (the kind's body set) in the cave shot's cavern, one by the brightest light,
// one in the dark, lit by the world (kit/character reads world.lightAt)
async function friends() {
  const f = cave();
  if (!f.found) return f;
  const [{ GLTFLoader }, { MeshoptDecoder }, SkeletonUtils, { spawnCharacter }, { adoptMaterials }] = await Promise.all([
    import('three/addons/loaders/GLTFLoader.js'), import('three/addons/libs/meshopt_decoder.module.js'), import('three/addons/utils/SkeletonUtils.js'),
    import('/kit/character/character.js'), import('/kit/look/look.js')]);
  const loader = new GLTFLoader(); loader.setMeshoptDecoder(MeshoptDecoder);
  const lib = await (await fetch('/lib3/bodies.json')).json();
  const bodies = new Map(lib.bodies.map(b => [b.id, `/lib3/${b.file}`]));
  const clips = `/lib3/${typeof lib.clips === 'string' ? lib.clips : lib.clips?.file ?? 'clips/gf-humanoid-1.glb'}`;
  const sheetBodies = kind.sheet?.bodies ?? [];
  const bodyAssets = { ...assets,
    has: id => id === 'character.clips' || bodies.has(id.replace('character.body.', '')),
    async model(id) {
      const g = await loader.loadAsync(id === 'character.clips' ? clips : bodies.get(id.replace('character.body.', '')));
      let skinned = false; g.scene.traverse(o => { if (o.isSkinnedMesh) skinned = true; });
      const sc = skinned ? SkeletonUtils.clone(g.scene) : g.scene.clone(true);
      if (id !== 'character.clips') adoptMaterials(sc, 'character');
      const r = new THREE.Group(); r.add(sc); r.animations = g.animations;
      r.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; o.userData.gfSlot = id; } });
      return r;
    } };
  const cctx = { ...ctx, assets: bodyAssets, look, world, time: { now: 0 } };
  const eye = camera.position.clone(), fwd = new THREE.Vector3(); camera.getWorldDirection(fwd); fwd.y = 0; fwd.normalize();
  const side = new THREE.Vector3(-fwd.z, 0, fwd.x);
  const palette = look.values.palette.players;
  const placed = [];
  for (const [i, [a, d]] of [[-1.4, 3.2], [1.1, 4.6], [0.2, 7.5]].entries()) {
    const id = sheetBodies[i % sheetBodies.length] ?? 'blocky-classic';
    const p = eye.clone().addScaledVector(fwd, d).addScaledVector(side, a);
    let y = Math.floor(p.y); while (y > 1 && !G.solidAt(Math.floor(p.x), y - 1, Math.floor(p.z))) y--; while (G.solidAt(Math.floor(p.x), y, Math.floor(p.z))) y++;
    const c = await spawnCharacter(cctx, { player: { id: `f${i}`, name: '', color: palette[i] }, bodySlot: `character.body.${id}`, tint: palette[i], plate: null });
    c.object3d.position.set(p.x, y, p.z); c.object3d.rotation.y = Math.atan2(-fwd.x, -fwd.z) + (i - 1) * 0.4;
    scene.add(c.object3d); c.play('idle', { loop: true, fade: 0 });
    for (let k = 0; k < 20; k++) c.update(1 / 60);
    placed.push({ id, at: [+p.x.toFixed(1), y, +p.z.toFixed(1)], light: world.lightAt(p.x, y + 1, p.z) });
  }
  return { ...f, friends: placed };
}
const SHOTS = { horizon, cave, pit, build, third, friends };
try { B.info.frame = await (SHOTS[SHOT] ?? horizon)(); } catch (e) { B.errors.push(`shot ${SHOT}: ${e.stack ?? e}`); }
// a held block in the hand, as the build mechanic draws it in first person (?held=0: none)
if (Q.get('held') !== '0' && SHOT !== 'third' && world.voxel.heldMesh) {
  if (!camera.parent) scene.add(camera);
  const h = world.voxel.heldMesh({ block: id(Q.get('block') ?? 'cobble') });
  h.scale.setScalar(0.085); h.rotation.set(0.32, 0.72, 0); h.position.set(0.15, -0.14, -0.27);
  camera.add(h); camera.updateMatrixWorld(true);
  const at = h.getWorldPosition(new THREE.Vector3()); h.userData.relight(at.x, at.y, at.z);
}
for (let i = 0; i < 400 && G.dirty.size; i++) world.update();
for (let i = 0; i < 8; i++) { world.update(); look.render(camera); await new Promise(r => requestAnimationFrame(r)); }
B.info.stats = look.stats?.();

// ---- frame cost: fly a loop round the spawn square at sprint speed, a little over the ground, looking ahead ----
B.perf = async (ms = 6000, { speed = 9, radius = 34, height = 2.2 } = {}) => {
  const dts = [], cpu = [];
  let last = performance.now(), a = 0;
  const end = last + ms;
  await new Promise(done => {
    const step = () => {
      const now = performance.now(), dt = (now - last) / 1000; last = now;
      dts.push(dt * 1000);
      a += speed * dt / radius;
      const x = at[0] + Math.cos(a) * radius, z = at[1] + Math.sin(a) * radius;
      const gy = top(Math.floor(x), Math.floor(z));
      camera.position.set(x, Math.max(gy + height, py + height), z);
      camera.lookAt(at[0] + Math.cos(a + 0.5) * radius, camera.position.y - 1, at[1] + Math.sin(a + 0.5) * radius);
      const c0 = performance.now(); world.update(); look.render(camera); cpu.push(performance.now() - c0);
      if (now < end) requestAnimationFrame(step); else done();
    };
    requestAnimationFrame(step);
  });
  const s = dts.slice(5).sort((p, q) => p - q), q = f => +s[Math.min(s.length - 1, Math.floor(f * s.length))].toFixed(2);
  const c = cpu.slice(5).sort((p, q2) => p - q2), qc = f => +c[Math.min(c.length - 1, Math.floor(f * c.length))].toFixed(2);
  const info = renderer.info.render;
  return { frames: s.length, fps: +(1000 / (s.reduce((p, v) => p + v, 0) / s.length)).toFixed(1), p50: q(0.5), p95: q(0.95), p99: q(0.99), max: q(1), cpuP50: qc(0.5), cpuP95: qc(0.95), calls: info.calls, triangles: info.triangles, size: [renderer.domElement.width, renderer.domElement.height] };
};
B.ready = true;
