#!/usr/bin/env node
// Verify checks 9 and 19 for a forge game (track R; builder/tools/verify-forge.mjs calls these):
//
//   check 9   contact sheet and perf: lookdev/capture.mjs's game mode (the first look, ?gf-show=world and look at
//             1920×1080 and 390×844, luma against the look targets, coverage, 60 fps at 1080p high, 30+ at low under a
//             4× CPU throttle)
//   check 19  bodies hold their shape: every body the game ships (a model slot whose file is skinned) through the model
//             judge's measuring tier (rig.js, builder/tools/lib/body-judge.mjs), and then the same poses
//             drawn by forge: the game's own core poses each clip the judge reads (forge-anim) and its renderer skins
//             it on the GPU. Forge's bones must sit where rig.js puts them (2 mm, 0.01 rad, as forge-anim's own rig_js
//             test) and the GPU's vertices where the CPU's sum of the same bone matrices puts them (1 mm): then the
//             judge's verdict is a verdict on what forge draws.
//
//   node runtimes/forge/lookdev/forge-checks.mjs 19 <game>                 check 19 on a game
//   node runtimes/forge/lookdev/forge-checks.mjs 9 <game> --out <dir>      check 9 on a game
//   node runtimes/forge/lookdev/forge-checks.mjs bodies [<glb> …]          the parity alone on library bodies
import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startLookdev } from './serve.mjs';
import { forgeLibrarySync } from '../tools/library.mjs';
import { captureGame } from './capture.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FORGE = resolve(HERE, '..');
const REPO = resolve(FORGE, '../..');
const sleep = ms => new Promise(r => setTimeout(r, ms));
export const LIMITS = { bonePos: 0.002, boneRot: 0.01, gpu: 0.001, shape: 0.005, times: [0.25, 0.6] };
/** The forge clip file in the asset library, on this machine. */
const libraryClips = () => forgeLibrarySync().forgeFile('clips/forge-humanoid-1.glb');

/** A GLB's JSON chunk (no bytes decoded). */
export function glbJson(file) {
  const b = readFileSync(file);
  if (b.readUInt32LE(0) !== 0x46546c67) return null;
  const len = b.readUInt32LE(12);
  return JSON.parse(b.subarray(20, 20 + len).toString('utf8'));
}

/** The game's bodies (model slots whose file has a skin) and its clip file (a model slot with clips and no skin). */
export async function gameBodies(dir) {
  const m = JSON.parse(await readFile(join(dir, 'assets.json'), 'utf8'));
  const fileOf = s => s?.source?.file ?? s?.default?.file ?? s?.file ?? null;
  const bodies = [], clipFiles = [];
  for (const s of m.slots ?? []) {
    const f = fileOf(s);
    if (s.type !== 'model' || !f || !f.endsWith('.glb') || !existsSync(join(dir, f))) continue;
    const j = glbJson(join(dir, f));
    if (!j) continue;
    if ((j.skins ?? []).length) bodies.push({ slot: s.id, file: f, role: /player/.test(s.id) ? 'player' : 'enemy' });
    else if ((j.animations ?? []).length) clipFiles.push(f);
  }
  return { bodies, clips: clipFiles[0] ?? null };
}

// ---------------------------------------------------------------- rig.js's poses (three.js in Node)
async function rigPoses(bodyFile, clipsFile, samples) {
  const { loadGLB, THREE, SkeletonUtils } = await import('../../../builder/tools/lib/char-three.mjs');
  const rig = await import('../../three/kit/character/rig.js');
  const cg = await loadGLB(clipsFile);
  const std = rig.standardFrom(cg.scene);
  const g = await loadGLB(bodyFile);
  const root = g.scene, found = rig.findRig(root);
  const rt = rig.createRetarget(root, std, { rig: found });
  const proxyRoot = SkeletonUtils.clone(cg.scene);
  const proxy = new Map(); proxyRoot.traverse(o => { if (std.bones.has(o.name) && !proxy.has(o.name)) proxy.set(o.name, o); });
  const mixer = new THREE.AnimationMixer(proxyRoot);
  const out = [];
  for (const [clipName, t] of samples) {
    const clip = cg.animations.find(c => c.name === clipName);
    if (!clip) { out.push(null); continue; }
    mixer.stopAllAction();
    const act = mixer.clipAction(clip); act.reset().play();
    mixer.setTime(t);
    rt.apply(proxy);
    root.updateMatrixWorld(true);
    const bones = {};
    for (const [name, bone] of found.bones) {
      const m = rig.relMatrix(bone, root), p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
      m.decompose(p, q, s);
      bones[name] = { p: p.toArray(), q: q.toArray() };
    }
    // where three.js puts the skinned vertices (and rigid meshes on bones): count, centroid, box
    const v = new THREE.Vector3(), c = [0, 0, 0], min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    let count = 0;
    const take = () => { const a = v.toArray(); for (let k = 0; k < 3; k++) { c[k] += a[k]; min[k] = Math.min(min[k], a[k]); max[k] = Math.max(max[k], a[k]); } count++; };
    root.traverse(o => {
      if (!o.isMesh) return;
      const n = o.geometry.attributes.position.count;
      if (o.isSkinnedMesh) { for (let i = 0; i < n; i++) { o.getVertexPosition(i, v); v.applyMatrix4(o.matrixWorld); take(); } return; }
      let p = o.parent; while (p && !p.isBone) p = p.parent;
      if (!p) return;
      for (let i = 0; i < n; i++) { v.fromBufferAttribute(o.geometry.attributes.position, i).applyMatrix4(o.matrixWorld); take(); }
    });
    out.push({ bones, shape: { count, centroid: c.map(x => x / Math.max(count, 1)), min, max } });
  }
  return { out, durations: Object.fromEntries(cg.animations.map(a => [a.name, a.duration])), names: cg.animations.map(a => a.name), THREE };
}

/** A column-major 4x4 (16 floats) → position and quaternion. */
function decompose(THREE, f) {
  const m = new THREE.Matrix4().fromArray(f), p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
  m.decompose(p, q, s);
  return { p: p.toArray(), q };
}

/**
 * Pose bodies through clips in forge (a WebGPU page on `kit`: the game's own gf/forge, or the dev kit) and in rig.js,
 * and compare. bodies: [{file (absolute), url (as the page fetches it), role}]. → per body {ok, bones, gpu, poses, worst}.
 */
export async function forgeParity(bodies, { clipsFile, clipsUrl, kit = '/kit', files = '/library', extra = {}, wasm = null, clipNames = null, log = () => {} }) {
  const { launchChrome } = await import(join(REPO, 'builder/qa/browser.mjs'));
  const { clipsFor } = await import('../../../builder/tools/lib/body-judge.mjs');
  const srv = await startLookdev({ port: 0, extra, wasm });
  const browser = await launchChrome({ gpu: 'webgpu' });
  const results = [];
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message)); page.on('console', m => { if (m.type() === 'error') errors.push(m.text().slice(0, 300)); });
    await page.goto(`${srv.url}check.html?kit=${encodeURIComponent(kit)}&files=${encodeURIComponent(files)}`, { waitUntil: 'load' });
    for (let i = 0; i < 300 && !(await page.evaluate(() => window.__ready === true).catch(() => false)); i++) await sleep(100);
    if (!(await page.evaluate(() => window.__ready === true).catch(() => false))) throw new Error(`the pose page did not start: ${errors.slice(0, 2).join(' | ') || 'no answer'}`);
    for (const b of bodies) {
      const probe = await rigPoses(b.file, clipsFile, []);
      const names = clipNames ?? clipsFor(probe.names, { role: b.role });
      const samples = names.flatMap(n => LIMITS.times.map(k => [n, +(Math.min(probe.durations[n] * k, probe.durations[n] - 1e-3)).toFixed(4)]));
      const rj = await rigPoses(b.file, clipsFile, samples);
      const fg = await page.evaluate(arg => window.__pose(arg), { body: b.url, clips: clipsUrl, samples });
      let worstPos = { v: 0 }, worstRot = { v: 0 }, worstGpu = { v: 0 }, worstShape = { v: 0 }, compared = 0, missing = [], vertices = Infinity, spread = Infinity, short = 0, counts = 0;
      fg.poses.forEach((pose, k) => {
        const want = rj.out[k]?.bones, ws = rj.out[k]?.shape;
        if (pose.missing || !want) { missing.push(samples[k][0]); return; }
        if (pose.gpuError > worstGpu.v) worstGpu = { v: pose.gpuError, at: `${pose.clip}@${pose.t}` };
        // the readback is real: every vertex came back from the GPU and the body has its height
        vertices = Math.min(vertices, pose.vertices); spread = Math.min(spread, pose.spread);
        if (pose.gpuVertices !== pose.vertices || pose.cpuVertices !== pose.vertices) short++;
        // the GPU's vertices sit where three.js skins them: the same count, centroid and box
        if (ws && pose.shape) {
          if (ws.count !== pose.shape.count) counts++;
          const d = Math.max(...[0, 1, 2].flatMap(a => [Math.abs(ws.centroid[a] - pose.shape.centroid[a]), Math.abs(ws.min[a] - pose.shape.min[a]), Math.abs(ws.max[a] - pose.shape.max[a])]));
          if (d > worstShape.v) worstShape = { v: d, at: `${pose.clip}@${pose.t}` };
        }
        for (const [bone, w] of Object.entries(want)) {
          const j = fg.names.indexOf(bone);
          if (j < 0) continue;
          const got = decompose(rj.THREE, pose.bones.slice(j * 16, j * 16 + 16));
          const dp = Math.hypot(got.p[0] - w.p[0], got.p[1] - w.p[1], got.p[2] - w.p[2]);
          const wq = new rj.THREE.Quaternion(...w.q).normalize();
          const dr = got.q.normalize().angleTo(wq);
          if (dp > worstPos.v) worstPos = { v: dp, at: `${pose.clip}@${pose.t} ${bone}` };
          if (dr > worstRot.v) worstRot = { v: dr, at: `${pose.clip}@${pose.t} ${bone}` };
          compared++;
        }
      });
      const ok = compared > 0 && worstPos.v < LIMITS.bonePos && worstRot.v < LIMITS.boneRot && worstGpu.v < LIMITS.gpu && worstShape.v < LIMITS.shape && !counts && vertices > 0 && vertices < Infinity && !short && spread > 0.2 && !errors.length;
      const r = { file: b.file, ok, poses: fg.poses.length, compared, vertices, minHeightSpread: +spread.toFixed(3), shortReads: short, countMismatches: counts, missing: [...new Set(missing)], worst: { position: worstPos, rotation: worstRot, gpu: worstGpu, shape: worstShape }, errors: errors.splice(0) };
      log(`forge parity ${relative(REPO, b.file)}: ${ok ? 'ok' : 'FAIL'} · ${compared} bone poses in ${fg.poses.length} poses · worst ${(worstPos.v * 1000).toFixed(2)} mm (${worstPos.at ?? '-'}), ${worstRot.v.toFixed(4)} rad · GPU vs CPU ${(worstGpu.v * 1000).toFixed(3)} mm over ${vertices} vertices (posed heights ≥ ${spread.toFixed(2)} m) · against three.js's skinning ${(worstShape.v * 1000).toFixed(2)} mm (centroid and box${counts ? `; ${counts} poses with another vertex count` : ''})`);
      results.push(r);
    }
  } finally { await browser.close(); await srv.close(); }
  return results;
}

/**
 * The clips of the forge clip file only an enemy plays (its arrivals, tells and attacks: forge-ai's archetypes). A
 * player's body is not judged on them, and an enemy's is (the art library judges its bodies the same way:
 * library/tools/meshy-art-build.mjs ENEMY_ONLY, the list this one copies).
 */
export const FORGE_ENEMY_ONLY = Object.freeze(['walk_shamble', 'emerge', 'emerge_leap', 'awaken', 'taunt', 'windup', 'lunge', 'recover', 'attack_enemy', 'cast_windup']);

/** Verify check 19 on a forge game. → {ok, detail, bodies, notes} */
export async function check19Forge(dir, { log = () => {} } = {}) {
  dir = resolve(dir);
  const notes = [];
  const { bodies, clips } = await gameBodies(dir);
  if (!bodies.length) return { ok: true, detail: 'no character bodies (nothing to judge)', bodies: [], notes };
  const { judgeBody, judgeSummary, DEV_RIG, clipsFor } = await import('../../../builder/tools/lib/body-judge.mjs');
  const clipsFile = clips ? join(dir, clips) : libraryClips();
  if (!clips) notes.push('no clip file among the game\'s slots: judged with the library\'s forge-humanoid-1.glb');
  // which clips a body is judged on: a player's, every clip a player may play (never an enemy's arrival or tell); an
  // enemy's, the enemy set and those arrivals and tells
  const all = (glbJson(clipsFile)?.animations ?? []).map(a => a.name).filter(Boolean);
  const clipNames = role => (role === 'player' ? clipsFor(all, { role }).filter(n => !FORGE_ENEMY_ONLY.includes(n)) : clipsFor(all, { role, extra: FORGE_ENEMY_ONLY }));
  const out = [];
  for (const b of bodies) {
    const names = all.length ? clipNames(b.role) : null;
    const j = await judgeBody(join(dir, b.file), { rig: DEV_RIG, clips: clipsFile, role: b.role, ...(names ? { clipNames: names } : {}) });
    out.push({ ...b, judge: j.ok, clips: names?.length ?? null, summary: j.ok ? '' : judgeSummary(j), stats: j.stats });
  }
  const kitOk = existsSync(join(dir, 'gf/forge/render.js'));
  let parity = [];
  if (!kitOk) notes.push('the game\'s gf/forge has no render.js (an older kit): forge parity not measured');
  else {
    parity = await forgeParity(bodies.map(b => ({ file: join(dir, b.file), url: b.file, role: b.role })), { clipsFile, clipsUrl: clips ?? '/library/clips/forge-humanoid-1.glb', kit: '/game/gf/forge', files: '/game', extra: { '/game/': dir }, log });
  }
  out.forEach((b, i) => { b.forge = parity[i] ?? null; });
  const ok = out.every(b => b.judge && (!kitOk || b.forge?.ok));
  const detail = out.map(b => `${b.slot} (${b.file}): ${b.judge ? 'holds its shape' : `FAIL ${b.summary}`}${b.forge ? ` · drawn by forge ${b.forge.ok ? 'as rig.js poses it' : 'NOT as rig.js poses it'} (${b.forge.compared} bone poses, worst ${(b.forge.worst.position.v * 1000).toFixed(2)} mm / ${b.forge.worst.rotation.v.toFixed(4)} rad; GPU skinning within ${(b.forge.worst.gpu.v * 1000).toFixed(3)} mm of the CPU and ${(b.forge.worst.shape.v * 1000).toFixed(2)} mm of three.js's)` : ''}`).join(' · ');
  return { ok, detail, bodies: out, notes };
}

/** Verify check 9 on a forge game: the capture's game mode into <outDir>/sheet. → {ok, detail, record} */
export async function check9Forge(dir, { outDir, quick = false, log = () => {} } = {}) {
  if (quick) return { ok: null, detail: '--quick' };
  const rec = await captureGame(dir, { out: join(outDir, 'sheet'), log });
  const hi = rec.perf.find(p => p.cpuThrottle === 1), lo = rec.perf.find(p => p.cpuThrottle > 1);
  const look = rec.shots.filter(s => s.size?.[0] === 1920).map(s => `${s.shot} luma ${s.luma.mean}/${s.luma.median}/${s.luma.p99}`).join(', ');
  const detail = `sheet in ${relative(dir, join(outDir, 'sheet'))}: ${rec.shots.length} shots (${look}); 1920×1080 high ${hi?.fps ?? '?'} fps (loop ${hi?.loopCpuMs.median ?? '?'} ms), low 4× CPU ${lo?.fps ?? '?'} fps; coverage ${rec.gates.coverage100 ? '100%' : 'NOT 100%'}${rec.problems.length ? `; ${rec.problems.slice(0, 3).join(' | ')}` : ''}`;
  return { ok: rec.verdict === 'pass', detail, record: rec };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const a = process.argv.slice(2), opt = k => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : null; };
  const log = m => console.log(m);
  if (a[0] === 'bodies') {
    const list = a.slice(1).filter((x, i, all) => !x.startsWith('--') && all[i - 1] !== '--wasm');
    const L = forgeLibrarySync(), cat = L.forgeCatalog;
    // every body in the library (the grim set, the KayKit spares, the players)
    const files = list.length ? list : Object.keys(cat.sections.bodies ?? {}).filter(f => f.endsWith('.glb'));
    const res = await forgeParity(files.map(f => ({ file: L.forgeFile(f), url: f, role: /player/.test(f) ? 'player' : 'enemy' })), { clipsFile: libraryClips(), clipsUrl: 'clips/forge-humanoid-1.glb', wasm: opt('--wasm'), log });
    if (a.includes('--json')) console.log(JSON.stringify(res.map(r => ({ ...r, file: relative(REPO, r.file) })), null, 1));
    process.exitCode = res.every(r => r.ok) ? 0 : 1;
  } else if (a[0] === '19') {
    const r = await check19Forge(a[1], { log });
    console.log(`${r.ok ? 'PASS' : 'FAIL'} 19 bodies hold their shape — ${r.detail}`);
    for (const n of r.notes) console.log(`note: ${n}`);
    process.exitCode = r.ok ? 0 : 1;
  } else if (a[0] === '9') {
    const r = await check9Forge(a[1], { outDir: resolve(opt('--out') ?? join(HERE, 'evidence', 'check9')), log });
    console.log(`${r.ok ? 'PASS' : r.ok === null ? 'SKIP' : 'FAIL'} 9 contact sheet and perf — ${r.detail}`);
    process.exitCode = r.ok === false ? 1 : 0;
  } else {
    console.error('usage: forge-checks.mjs 19 <game> | 9 <game> --out <dir> | bodies [<library glb> …] [--json]');
    process.exitCode = 2;
  }
}
