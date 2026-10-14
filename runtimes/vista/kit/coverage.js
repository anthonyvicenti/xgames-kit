// gf-vista's slot coverage (runtimes/CONTRACT.md §3.4, §6.1: coverage() and slots()), vendored into a game as
// gf/vista/kit/coverage.js. The vista core builds its own scene (core/src: its engine's Object3D graph) and is never
// edited for this: before the core starts, stampAdds() wraps the engine's Object3D.add so every object added to the
// scene remembers which core modules added it (the call's stack). What each module draws is then the slots below:
//
//   the core's files      the stall props (game/StallKit.js and the stands that build from it), the driftwood and
//                         shells (world/debris/ScannedDebris.js), the whale (world/marine/Whale.js), the two vendors
//                         (engine/loaders/GLTF.js under game/FishStand.js or game/Chandlery.js): their file slots
//                         (kit/core-files.js, declared by kit/config.js coreSlots)
//   the sea               the ocean surface and what the sea throws up (spray, breakers, foam, marine snow): look.sea,
//                         the slot whose value drives it
//   friends' bodies       gf-humanoid-1 bodies (kit/humanoid.js): tagged with their seat's body slot by the boot
//   code-made             everything else the core builds in code (the island's ground, rocks, palms, the village,
//                         the reef, the boat, wildlife): exempt, each with the module that made it. Not a file, so
//                         nothing Studio swaps yet; counted apart, never as tagged.
//
//   stampAdds(Object3D)          once, before the core's App is made
//   coverage(scene) → {meshes, tagged, exempt, untagged: [{name, path}], unknownSlots, byModule, exemptBy}
//   slots(scene, camera, w, h) → {[slot]: {drawables, triangles, onScreen}}
import { CORE_FILES } from './core-files.js';

const SRC = /\/core\/src\/([^:?#)]+\.js)/;
/** The core modules on a stack, innermost first, without the engine's own scene code. */
function modulesOf(stack) {
  const out = [];
  for (const line of String(stack).split('\n')) {
    const m = SRC.exec(line);
    if (m && !m[1].startsWith('engine/scene/') && !out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

/** Wrap the engine's Object3D.prototype.add: each child added remembers the core modules that added it. Once. */
export function stampAdds(Object3D) {
  const P = Object3D?.prototype;
  if (!P || P.add.__gfStamped) return;
  const add = P.add;
  P.add = function (...objs) {
    const limit = Error.stackTraceLimit; Error.stackTraceLimit = 40;
    let from; try { from = modulesOf(new Error().stack); } finally { Error.stackTraceLimit = limit; }
    for (const o of objs) if (o && o.userData && !o.userData.gfFrom) o.userData.gfFrom = from;
    return add.apply(this, objs);
  };
  P.add.__gfStamped = true;
}

/** A folder's slots, the shape first (a model, or the data file a model is read from: props.json, humpback.json), then
 *  its pictures: the first is the slot coverage counts the drawable under. */
const RANK = { model: 0, data: 1, image: 2 };
const slotsIn = folder => CORE_FILES.filter(f => f.slot.startsWith(`core.${folder}.`)).sort((a, b) => RANK[a.type] - RANK[b.type]).map(f => f.slot);
const SEA = ['ocean/', 'fx/Spray', 'fx/Breakers', 'fx/MarineSnow', 'ocean/ShoreWaves', 'ocean/SurfFoam'];

/** What one drawable carries: {slots: [id], exempt: why | null}. frames: the modules of it and its parents, nearest first. */
export function tagOf(o, frames) {
  const name = String(o.name ?? '');
  const has = s => frames.some(f => f.includes(s));
  if (/^debris-scan/.test(name) || has('world/debris/ScannedDebris.js')) return { slots: slotsIn('debris'), exempt: null };
  if (has('world/marine/Whale.js')) return { slots: slotsIn('whale'), exempt: null };
  // the vendors: loaded by engine/loaders/GLTF.js and drawn skinned (engine/render/Skinning.js) under their stand
  const character = has('engine/loaders/GLTF.js') || has('engine/render/Skinning.js');
  if (character && has('game/FishStand.js')) return { slots: ['core.characters.joe'], exempt: null };
  if (character && has('game/Chandlery.js')) return { slots: ['core.characters.marta'], exempt: null };
  if (/Stall$|Kit$/.test(name) || has('game/StallKit.js')) return { slots: slotsIn('props'), exempt: null };
  if (frames[0] === 'App.js' && /ocean|water/i.test(name)) return { slots: ['look.sea'], exempt: null };
  if (SEA.some(has)) return { slots: ['look.sea'], exempt: null };
  if (frames.length) return { slots: [], exempt: `code-made by the core (${frames[0]})` };
  return { slots: [], exempt: null };
}

/** The ocean is App.js's own Mesh (no name upstream): the boot names it so the sea's slot finds it. */
export function nameOcean(app) { if (app?.ocean && !app.ocean.name) app.ocean.name = 'ocean'; }

const drawable = o => o?.isMesh && o.visible !== false && o.material !== null && (o.count === undefined || o.count > 0);
/** Walk what is drawn: fn(o, tag). The tag is the object's own (userData.gfSlot) or its nearest parent's, else tagOf. */
function walk(scene, fn) {
  scene.traverseVisible(o => {
    if (!drawable(o)) return;
    let own = null, frames = [];
    for (let p = o; p && p !== scene; p = p.parent) {
      if (!own && p.userData?.gfSlot) own = { slots: [p.userData.gfSlot], exempt: null };
      if (!own && p.userData?.gfExempt) own = { slots: [], exempt: String(p.userData.gfExempt) };
      for (const f of p.userData?.gfFrom ?? []) if (!frames.includes(f)) frames.push(f);
    }
    fn(o, own ?? tagOf(o, frames), frames);
  });
}

/** coverage() for vista. has(slotId): the game declares that slot. */
export function coverage(scene, { has = () => true } = {}) {
  const out = { meshes: 0, tagged: 0, exempt: 0, untagged: [], unknownSlots: [], exemptBy: {}, bySlot: {} };
  const unknown = new Set();
  walk(scene, (o, tag, frames) => {
    out.meshes++;
    if (tag.slots.length) {
      out.tagged++;
      for (const s of tag.slots) if (!has(s)) unknown.add(s);
      out.bySlot[tag.slots[0]] = (out.bySlot[tag.slots[0]] ?? 0) + 1;
      return;
    }
    if (tag.exempt) { out.exempt++; out.exemptBy[tag.exempt] = (out.exemptBy[tag.exempt] ?? 0) + 1; return; }
    if (out.untagged.length < 50) { const path = []; for (let p = o; p && p !== scene; p = p.parent) path.unshift(p.name || p.type); out.untagged.push({ name: o.name || '', path: path.join('/'), from: frames.slice(0, 3) }); }
  });
  out.unknownSlots = [...unknown];
  return out;
}

const trianglesOf = o => { const g = o.geometry, n = g?.index ? g.index.count : g?.attributes?.position?.count ?? 0; return Math.round(n / 3) * Math.max(1, o.count ?? 1); };
/** slots() for vista: what each slot puts in the scene, and whether any of it is in front of the camera. */
export function slots(scene, camera) {
  const out = {};
  const e = camera.matrixWorld.elements, cx = camera.position.x, cy = camera.position.y, cz = camera.position.z, fx = -e[8], fy = -e[9], fz = -e[10];
  walk(scene, (o, tag) => {
    for (const s of tag.slots) {
      const r = (out[s] ??= { drawables: 0, triangles: 0, onScreen: false });
      r.drawables++; r.triangles += trianglesOf(o);
      if (!r.onScreen) {
        const m = o.matrixWorld?.elements, px = m ? m[12] : 0, py = m ? m[13] : 0, pz = m ? m[14] : 0, dx = px - cx, dy = py - cy, dz = pz - cz;
        // instanced or huge things (the sea, the debris batches) sit at the origin: in view when anything of them is
        r.onScreen = !!o.isInstancedMesh || s === 'look.sea' || (dx * fx + dy * fy + dz * fz) > 0;
      }
    }
  });
  return out;
}

/** The drawables that carry any of `ids`. */
export function drawablesOf(scene, ids) {
  const want = new Set(ids), out = [];
  walk(scene, (o, tag) => { if (tag.slots.some(s => want.has(s))) out.push(o); });
  return out;
}

const W = 192, H = 108;
/** This page's canvas, as drawn, at W×H (RGBA). The WebGPU canvas is read after the browser presented it. */
async function grab(canvas) {
  const bmp = await createImageBitmap(canvas);
  const c = new OffscreenCanvas(W, H), g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(bmp, 0, 0, W, H); bmp.close?.();
  return g.getImageData(0, 0, W, H).data;
}
const frames = n => new Promise(r => { const go = k => (k <= 0 ? r() : requestAnimationFrame(() => go(k - 1))); go(n); });
const differs = (a, b, i, t = 36) => Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > t;

/**
 * sight(ids) for vista (runtimes/CONTRACT.md §6.1): a slot's share of this player's view, depth-tested by the core's
 * own drawing: the frame as drawn, the same with that slot's things hidden, and shown again. A pixel is the slot's when
 * it changed when they went and changed back when they came (the sea and the clouds move on their own; a pixel that
 * only moved once is noise). Real time only (a stepped page draws no frames between calls). → {share, pixels, open,
 * drawables, rect, center, size, distance, w, h, noise}
 */
export async function sight({ scene, camera, canvas }, ids) {
  const list = drawablesOf(scene, ids);
  const none = { share: 0, pixels: 0, open: 0, drawables: list.length, rect: null, center: null, size: null, distance: null, w: W, h: H, noise: null };
  if (!list.length) return none;
  await frames(2); const a = await grab(canvas);
  const was = list.map(o => o.visible);
  for (const o of list) o.visible = false;
  let b;
  try { await frames(2); b = await grab(canvas); } finally { list.forEach((o, i) => { o.visible = was[i]; }); }
  await frames(2); const c = await grab(canvas);
  let n = 0, noise = 0, x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4, gone = differs(a, b, i), back = differs(b, c, i);
    if (gone && back) { n++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    else if (gone || back) noise++;
  }
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const o of list) { const m = o.matrixWorld?.elements; if (!m) continue; for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], m[12 + k]); hi[k] = Math.max(hi[k], m[12 + k]); } }
  const r2 = v => Math.round(v * 100) / 100, all = W * H;
  const center = Number.isFinite(lo[0]) ? { x: r2((lo[0] + hi[0]) / 2), y: r2((lo[1] + hi[1]) / 2), z: r2((lo[2] + hi[2]) / 2) } : null;
  return { share: n / all, pixels: n, open: n / all, drawables: list.length, rect: n ? [r2(x0 / W), r2(y0 / H), r2((x1 + 1) / W), r2((y1 + 1) / H)] : null,
    center, size: center ? { x: r2(hi[0] - lo[0]), y: r2(hi[1] - lo[1]), z: r2(hi[2] - lo[2]) } : null,
    distance: center ? r2(Math.hypot(center.x - camera.position.x, center.y - camera.position.y, center.z - camera.position.z)) : null, w: W, h: H, noise: r2(noise / all) };
}
