// gf-three core: how much of the player's own view a thing takes (verify check 15, CONTRACT §5), for QA only.
//
//   window.__game.sight(['prop.token'])   →  { share, pixels, open, drawables, rect, center, size, distance, w, h }
//
// Creator, "Hang Up On Them" (2026-10-07): the round-1 game passed verify while the play-tester saw "no token
// anywhere on screen". So verify asks, at round start, how much of the local player's first look the goal fills. This
// renders the frame once more from the player's camera into a small target: every mesh black, then the meshes of the
// named slots white with the depth test on (a desk in front of the token hides it), and counts the white pixels.
// `open` is the same count with nothing in front (what a clear view would show). It runs only when verify calls it,
// between two frames, and puts back every renderer, scene and camera setting it touched.
//
// The scenic-3d profile (CONTRACT §8) renders with WebGPURenderer, which reads a target back only asynchronously
// (readRenderTargetPixelsAsync; WebGPU's rows start at the top, WebGL's at the bottom). There sight() returns a Promise
// of the same answer: callers `await window.__game.sight(ids)` (awaiting the WebGL answer, a plain object, is harmless).
import * as THREE from 'three';

const LAYER = 31;                      // the goal's meshes join this layer for the second pass only
const BLACK = new THREE.MeshBasicMaterial({ color: 0x000000, fog: false, side: THREE.DoubleSide });
const WHITE = new THREE.MeshBasicMaterial({ color: 0xffffff, fog: false, side: THREE.DoubleSide, depthFunc: THREE.LessEqualDepth });
const r2 = v => Math.round(v * 100) / 100;

/** Count white pixels (and their bounds) in an RGBA buffer read from a w × h target (row 0 at the bottom, or at the top
 *  when `topDown`: WebGPU). */
function count(px, w, h, topDown = false) {
  let n = 0, x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (px[(y * w + x) * 4] < 128) continue;
    n++; const ty = topDown ? y : h - 1 - y;
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (ty < y0) y0 = ty; if (ty > y1) y1 = ty;
  }
  return { n, rect: n ? [r2(x0 / w), r2(y0 / h), r2((x1 + 1) / w), r2((y1 + 1) / h)] : null };
}

/**
 * The share of the view the meshes tagged with any of `ids` (userData.gfSlot) fill, as drawn from `camera`.
 * → { share (visible pixels / all, 0..1), pixels, open (share with nothing in front), drawables, rect ([x0, y0, x1, y1]
 *     of the visible pixels, 0..1 from the top left, or null), center and size (world box of those meshes, or null),
 *     distance (camera to center, m), w, h }
 */
export function sight({ renderer, scene, camera }, ids, { w = 192, h = 108 } = {}) {
  if (renderer?.isWebGPURenderer) return sightAsync({ renderer, scene, camera }, ids, { w, h });
  const want = new Set(Array.isArray(ids) ? ids : [ids]);
  const goal = [], hidden = [];
  const box = new THREE.Box3(), part = new THREE.Box3();
  scene.updateMatrixWorld(true);
  scene.traverseVisible(o => {
    if (!(o.isMesh || o.isSprite || o.isPoints || o.isLine)) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    const unseen = mats.every(m => !m || m.visible === false || m.colorWrite === false || (m.transparent && m.opacity <= 0.02));
    if (!o.isMesh || unseen) { hidden.push(o); return; }           // sprites, points, lines and invisible meshes stay out
    if (want.has(o.userData?.gfSlot)) { goal.push(o); part.setFromObject(o); box.union(part); }
  });
  const out = { share: 0, pixels: 0, open: 0, drawables: goal.length, rect: null, center: null, size: null, distance: null, w, h };
  if (!goal.length) return out;
  const c = box.getCenter(new THREE.Vector3()), s = box.getSize(new THREE.Vector3());
  out.center = { x: r2(c.x), y: r2(c.y), z: r2(c.z) }; out.size = { x: r2(s.x), y: r2(s.y), z: r2(s.z) };
  out.distance = r2(camera.getWorldPosition(new THREE.Vector3()).distanceTo(c));
  const rt = new THREE.WebGLRenderTarget(w, h, { depthBuffer: true });
  const px = new Uint8Array(w * h * 4);
  const saved = { target: renderer.getRenderTarget(), bg: scene.background, fog: scene.fog, ov: scene.overrideMaterial, mask: camera.layers.mask, auto: renderer.autoClear, color: renderer.getClearColor(new THREE.Color()), alpha: renderer.getClearAlpha(), shadows: renderer.shadowMap.autoUpdate };
  const shown = hidden.map(o => o.visible), had = goal.map(o => o.layers.isEnabled(LAYER));
  try {
    for (const o of hidden) o.visible = false;
    scene.background = null; scene.fog = null; renderer.shadowMap.autoUpdate = false; renderer.autoClear = false;
    renderer.setRenderTarget(rt); renderer.setClearColor(0x000000, 1);
    // the view: everything black, then the goal white where nothing is in front of it
    renderer.clear(true, true, true);
    scene.overrideMaterial = BLACK; renderer.render(scene, camera);
    for (const o of goal) o.layers.enable(LAYER);
    camera.layers.set(LAYER);
    scene.overrideMaterial = WHITE; renderer.render(scene, camera);
    renderer.readRenderTargetPixels(rt, 0, 0, w, h, px);
    const seen = count(px, w, h);
    // the open view: the goal alone
    renderer.clear(true, true, true); renderer.render(scene, camera);
    renderer.readRenderTargetPixels(rt, 0, 0, w, h, px);
    const open = count(px, w, h);
    Object.assign(out, { share: Math.round(seen.n / (w * h) * 10000) / 10000, pixels: seen.n, rect: seen.rect, open: Math.round(open.n / (w * h) * 10000) / 10000 });
  } finally {
    goal.forEach((o, i) => { if (!had[i]) o.layers.disable(LAYER); });
    hidden.forEach((o, i) => { o.visible = shown[i]; });
    camera.layers.mask = saved.mask;
    scene.overrideMaterial = saved.ov; scene.background = saved.bg; scene.fog = saved.fog;
    renderer.setRenderTarget(saved.target); renderer.setClearColor(saved.color, saved.alpha);
    renderer.autoClear = saved.auto; renderer.shadowMap.autoUpdate = saved.shadows;
    rt.dispose();
  }
  return out;
}

/**
 * sight() for WebGPURenderer (the scenic-3d profile; also its WebGL2 fallback inside it): the same two renders into a
 * RenderTarget, read back with readRenderTargetPixelsAsync. w × 4 bytes must be a multiple of 256 (WebGPU pads rows to
 * 256 bytes), so w is rounded up to a multiple of 64. → Promise of the same answer as sight().
 */
async function sightAsync({ renderer, scene, camera }, ids, { w = 192, h = 108 } = {}) {
  w = Math.ceil(w / 64) * 64;
  const want = new Set(Array.isArray(ids) ? ids : [ids]);
  const goal = [], hidden = [];
  const box = new THREE.Box3(), part = new THREE.Box3();
  scene.updateMatrixWorld(true);
  scene.traverseVisible(o => {
    if (!(o.isMesh || o.isSprite || o.isPoints || o.isLine)) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    const unseen = mats.every(m => !m || m.visible === false || m.colorWrite === false || (m.transparent && m.opacity <= 0.02));
    if (!o.isMesh || unseen) { hidden.push(o); return; }
    if (want.has(o.userData?.gfSlot)) { goal.push(o); part.setFromObject(o); box.union(part); }
  });
  const out = { share: 0, pixels: 0, open: 0, drawables: goal.length, rect: null, center: null, size: null, distance: null, w, h };
  if (!goal.length) return out;
  const c = box.getCenter(new THREE.Vector3()), s = box.getSize(new THREE.Vector3());
  out.center = { x: r2(c.x), y: r2(c.y), z: r2(c.z) }; out.size = { x: r2(s.x), y: r2(s.y), z: r2(s.z) };
  out.distance = r2(camera.getWorldPosition(new THREE.Vector3()).distanceTo(c));
  // both renders now, between two frames, into their own targets (state put back at once); only the reads wait, so the
  // game's next frame never sees the overrides
  const rtSeen = new THREE.RenderTarget(w, h, { depthBuffer: true }), rtOpen = new THREE.RenderTarget(w, h, { depthBuffer: true });
  const topDown = !!renderer.backend?.isWebGPUBackend;
  const saved = { target: renderer.getRenderTarget(), bg: scene.background, fog: scene.fog, ov: scene.overrideMaterial, mask: camera.layers.mask, auto: renderer.autoClear, color: renderer.getClearColor(new THREE.Color()), alpha: renderer.getClearAlpha(), shadows: renderer.shadowMap?.autoUpdate };
  const shown = hidden.map(o => o.visible), had = goal.map(o => o.layers.isEnabled(LAYER));
  try {
    for (const o of hidden) o.visible = false;
    scene.background = null; scene.fog = null; if (renderer.shadowMap) renderer.shadowMap.autoUpdate = false; renderer.autoClear = false;
    renderer.setClearColor(0x000000, 1);
    // the view: everything black, then the goal white where nothing is in front of it
    renderer.setRenderTarget(rtSeen); renderer.clear(true, true, true);
    scene.overrideMaterial = BLACK; renderer.render(scene, camera);
    for (const o of goal) o.layers.enable(LAYER);
    camera.layers.set(LAYER);
    scene.overrideMaterial = WHITE; renderer.render(scene, camera);
    // the open view: the goal alone
    renderer.setRenderTarget(rtOpen); renderer.clear(true, true, true); renderer.render(scene, camera);
  } finally {
    goal.forEach((o, i) => { if (!had[i]) o.layers.disable(LAYER); });
    hidden.forEach((o, i) => { o.visible = shown[i]; });
    camera.layers.mask = saved.mask;
    scene.overrideMaterial = saved.ov; scene.background = saved.bg; scene.fog = saved.fog;
    renderer.setRenderTarget(saved.target); renderer.setClearColor(saved.color, saved.alpha);
    renderer.autoClear = saved.auto; if (renderer.shadowMap) renderer.shadowMap.autoUpdate = saved.shadows;
  }
  try {
    const [a, b] = await Promise.all([rtSeen, rtOpen].map(rt => renderer.readRenderTargetPixelsAsync(rt, 0, 0, w, h)));
    const seen = count(a, w, h, topDown), open = count(b, w, h, topDown);
    Object.assign(out, { share: Math.round(seen.n / (w * h) * 10000) / 10000, pixels: seen.n, rect: seen.rect, open: Math.round(open.n / (w * h) * 10000) / 10000 });
  } finally { rtSeen.dispose(); rtOpen.dispose(); }
  return out;
}
