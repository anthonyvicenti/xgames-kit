// window.__gfLook: the hook lookdev/capture.mjs (and K1's verify, check 9) uses on the bench and in any kit game.
//   __gfLook.shot(name)    'hero' | 'four' | 'wide' | 'action' | {position, target, fov} (placed) | null (back to the game camera)
//   __gfLook.perf(ms)      { fps, frames, p50, p95, p99, max, renderCpuMs, calls, triangles }  rAF intervals over ms
//   __gfLook.coverage()    { meshes, tagged, exempt, untagged: [...] }  (R3; ctx.assets.coverage when the kit has it)
//   __gfLook.info()        look.stats() + GPU renderer string + viewport
//   __gfLook.freeze(on)    pause animation where the host supports it (the bench does)
//   __gfLook.view(v)       a framing by numbers { pitch, distance, fov, yaw, aim } around the first subject (a style
//                          target's camera; builder/look/judge.mjs), like shot(); shot(null) goes back. With
//                          { where: 'cave' | 'day' | … } the world places the camera first (ctx.world.place(where):
//                          a cave shot inside a cave); a world with no such place frames the player and says so
//   __gfLook.worldLight(p) the world's own light, live, where the world has one (voxel: the cave's fill, lamps, glow
//                          and fog: world.voxel.setLight); null clears nothing and reads the values
//   __gfLook.values()      the look values in force (resolved: the preset, the game's values, the time of day)
//   __gfLook.restyle(v)    lay look values over the game's own, live, in every time of day (the tuning loop,
//                          builder/look/tune.mjs); restyle(null) goes back to the game's look. Never changes play.
//   __gfLook.bodies()      the bodies the active camera sees: [{ height, head }] (head = head height ÷ whole height)
// Subjects for the shots: extra.subjects(), else ctx.lookSubjects(), else ctx.players.list() (character or body).
import * as THREE from 'three';

function subjectsOf(ctx, extra) {
  if (extra.subjects) return extra.subjects();
  if (ctx.lookSubjects) return ctx.lookSubjects();
  const list = ctx.players?.list?.() ?? [];
  const me = list.findIndex(p => p.local);
  if (me > 0) list.unshift(...list.splice(me, 1));
  return list.map(p => {
    const o = p.character?.object3d ?? p.body ?? p.object3d;
    const pos = o ? o.getWorldPosition(new THREE.Vector3()) : new THREE.Vector3(p.pose?.x ?? p.x ?? 0, p.pose?.y ?? 0, p.pose?.z ?? p.z ?? 0);
    // where the body really is: the hips (a ragdolled or getting-up body drifts away from its capsule)
    const hips = p.character?.bones?.get?.('Hips');
    if (hips) { const w = hips.getWorldPosition(new THREE.Vector3()); pos.x = w.x; pos.z = w.z; }
    const yaw = o ? new THREE.Euler().setFromQuaternion(o.getWorldQuaternion(new THREE.Quaternion()), 'YXZ').y : (p.pose?.yaw ?? 0);
    // lying down (ragdoll, knocked out): never the hero while someone is standing (kit/look/shots.js)
    const down = p.alive === false || ['ragdoll', 'getup'].includes(p.character?.state);
    return { position: pos, yaw, height: p.character?.height ?? 1.7, down };
  });
}

// the first visible world mesh on the segment from → to (world props and ground; characters, sky and effects are not
// in world.root), so a contact-sheet camera never starts inside or behind a prop
function occludersOf(world) {
  const root = world?.root ?? world?.group;
  if (!root) return undefined;
  const ray = new THREE.Raycaster();
  return (from, to) => {
    const dir = to.clone().sub(from); const len = dir.length();
    if (len < 1e-4) return null;
    ray.set(from, dir.normalize()); ray.far = len; ray.near = 0;
    const hit = ray.intersectObject(root, true).find(h => h.object.visible !== false && !(h.object.userData?.gfProp && /^cloud/.test(h.object.userData.gfProp)));
    return hit ? { distance: hit.distance, point: hit.point, object: hit.object } : null;
  };
}

const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);
const over = (a, b) => { const out = { ...a }; for (const [k, x] of Object.entries(b)) out[k] = isObj(x) && isObj(out[k]) ? over(out[k], x) : x; return out; };

function coverageWalk(scene) {
  const out = { meshes: 0, tagged: 0, exempt: 0, untagged: [] };
  const exemptOf = o => { for (let p = o; p; p = p.parent) if (p.userData?.gfExempt) return true; return false; };
  scene.traverseVisible(o => {
    if (!(o.isMesh || o.isSprite || o.isPoints || o.isLine)) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    if (mats.length && mats.every(m => m && m.visible === false)) return;
    out.meshes++;
    if (exemptOf(o)) { out.exempt++; return; }
    if (o.userData.gfSlot) { out.tagged++; return; }
    const path = []; for (let p = o; p && p !== scene; p = p.parent) path.unshift(p.name || p.type);
    if (out.untagged.length < 50) out.untagged.push({ name: o.name || '', path: path.join('/'), type: o.type });
  });
  return out;
}

export function installCaptureApi(ctx, extra = {}) {
  if (typeof window === 'undefined') return null;
  const look = ctx.look;
  let original = null;   // the look as the game set it, before the first restyle
  const places = new Map();   // view({ where }): the world's place per setting, found once
  const frameInfo = (name, cam, subjects) => {
    const r2 = v => Math.round(v * 100) / 100;
    return { shot: name, position: cam.position.toArray(), fov: cam.fov, subjects: subjects.length, down: subjects.filter(s => s.down).length,
      target: cam.userData.frame?.target?.toArray().map(r2) ?? null, at: subjects.map(s => [r2(s.position.x), r2(s.position.y), r2(s.position.z), s.down ? 1 : 0]) };
  };
  const worldOpts = () => {
    const bounds = extra.world?.bounds ?? ctx.world?.bounds;
    const box = bounds?.isBox3 ? bounds : bounds?.half ? new THREE.Box3(new THREE.Vector3(-bounds.half, 0, -bounds.half), new THREE.Vector3(bounds.half, 4, bounds.half)) : undefined;
    const w = extra.world ?? ctx.world;
    return { bounds: box, raycast: w?.raycast ? (from, dir, max) => w.raycast(from, dir, max) : undefined, occluders: occludersOf(w) };
  };
  const api = {
    ready: false,
    view(v = {}) {
      const subjects = subjectsOf(ctx, extra);
      const w = extra.world ?? ctx.world;
      // a world's place for a setting is found once (a cave search walks the whole grid)
      if (v.where && typeof w?.place === 'function' && !places.has(v.where)) places.set(v.where, w.place(v.where) ?? null);
      const place = v.where ? places.get(v.where) ?? null : null;
      if (place) {
        const cam = look.shot('view', { subjects, ...worldOpts(), view: { ...v } });
        cam.position.set(...place.eye); cam.fov = place.fov ?? cam.fov; cam.lookAt(new THREE.Vector3(...place.target));
        cam.updateProjectionMatrix(); cam.updateMatrixWorld();
        return { ...frameInfo('view', cam, subjects), where: v.where, placed: true };
      }
      const cam = look.shot('view', { subjects, ...worldOpts(), view: { ...v } });
      return { ...frameInfo('view', cam, subjects), ...(v.where ? { where: v.where, placed: false } : {}) };
    },
    worldLight(p) {
      const V = (extra.world ?? ctx.world)?.voxel;
      if (!V?.setLight) return null;
      return p ? V.setLight(p) : V.lightValues();
    },
    values() { return JSON.parse(JSON.stringify(look.values)); },
    restyle(values) {
      original ??= { preset: look.preset, time: look.time };
      if (!values) { look.set({ preset: original.preset, time: original.time }); return api.values(); }
      const base = original.preset;
      // over the base and over every time block, so the preset's time of day never shadows a tuned value
      const next = over(base, values);
      if (isObj(base.times)) next.times = Object.fromEntries(Object.entries(base.times).map(([t, block]) => [t, over(block ?? {}, values)]));
      look.set({ preset: next, time: original.time });
      return api.values();
    },
    bodies() {
      const cam = look.activeCamera, out = [];
      const frustum = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
      for (const p of ctx.players?.list?.() ?? []) {
        const c = p.character, bones = c?.bones;
        const o = c?.object3d; if (!o || !bones?.get) continue;
        const box = new THREE.Box3().setFromObject(o);
        if (box.isEmpty() || !frustum.intersectsBox(box)) continue;
        const neck = bones.get('Neck') ?? bones.get('Head');
        if (!neck) continue;
        const ny = neck.getWorldPosition(new THREE.Vector3()).y, height = box.max.y - box.min.y;
        if (height <= 0) continue;
        out.push({ height: Math.round(height * 100) / 100, head: Math.round(((box.max.y - ny) / height) * 1000) / 1000 });
      }
      return out;
    },
    shot(name) {
      if (!name) { look.shot(null); return null; }
      // a camera placed by hand: {position: [x, y, z], target: [x, y, z], fov} (a reference's framing, a fixed view two
      // screens share)
      if (typeof name === 'object' && Array.isArray(name.position) && Array.isArray(name.target)) {
        const cam = look.shot('wide', { subjects: subjectsOf(ctx, extra) });
        cam.position.set(...name.position); if (Number.isFinite(name.fov)) cam.fov = name.fov;
        cam.lookAt(...name.target); cam.updateProjectionMatrix();
        return { shot: 'placed', position: cam.position.toArray(), target: name.target, fov: cam.fov };
      }
      extra.pose?.(name);
      const subjects = subjectsOf(ctx, extra);
      const bounds = extra.world?.bounds ?? ctx.world?.bounds;
      const box = bounds?.isBox3 ? bounds : bounds?.half ? new THREE.Box3(new THREE.Vector3(-bounds.half, 0, -bounds.half), new THREE.Vector3(bounds.half, 4, bounds.half)) : undefined;
      const w = extra.world ?? ctx.world;
      const raycast = w?.raycast ? (from, dir, max) => w.raycast(from, dir, max) : undefined;
      const cam = look.shot(name, { subjects, bounds: box, raycast, occluders: occludersOf(w) });
      const r2 = v => Math.round(v * 100) / 100;
      return { shot: name, position: cam.position.toArray(), fov: cam.fov, subjects: subjects.length, down: subjects.filter(s => s.down).length,
        target: cam.userData.frame?.target?.toArray().map(r2) ?? null, at: subjects.map(s => [r2(s.position.x), r2(s.position.y), r2(s.position.z), s.down ? 1 : 0]) };
    },
    perf(ms = 3000) {
      return new Promise((done) => {
        const gaps = []; let last = null; const t0 = performance.now();
        const tick = (now) => {
          if (last !== null) gaps.push(now - last);
          last = now;
          if (now - t0 < ms) requestAnimationFrame(tick);
          else {
            const s = [...gaps].sort((a, b) => a - b), pick = (f) => s[Math.min(s.length - 1, Math.floor(s.length * f))] ?? 0;
            const mean = gaps.reduce((a, b) => a + b, 0) / Math.max(1, gaps.length);
            const st = look.stats();
            done({ fps: +(1000 / mean).toFixed(1), frames: gaps.length, meanMs: +mean.toFixed(2), p50: +pick(0.5).toFixed(2), p95: +pick(0.95).toFixed(2), p99: +pick(0.99).toFixed(2), max: +(s[s.length - 1] ?? 0).toFixed(2), renderCpuMs: st.renderCpuMs, calls: st.calls, triangles: st.triangles });
          }
        };
        requestAnimationFrame(tick);
      });
    },
    coverage() { return ctx.assets?.coverage ? ctx.assets.coverage(ctx.scene) : coverageWalk(ctx.scene); },
    info() {
      const gl = ctx.renderer.getContext();
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      return { ...look.stats(), gpu: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER), viewport: [innerWidth, innerHeight], dpr: devicePixelRatio, pixelRatio: ctx.renderer.getPixelRatio() };
    },
    freeze(on) { extra.freeze?.(on); return !!on; },
  };
  window.__gfLook = api;
  return api;
}
