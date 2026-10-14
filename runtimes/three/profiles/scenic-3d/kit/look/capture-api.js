// gf-scenic: window.__gfLook, the hook the lookdev bench, research/gf-three/lookdev/capture.mjs and verify (check 9)
// use. A copy of research/gf-three/kit/look/capture-api.js (games.fun), so a scenic game, which carries no
// gf/three/look/, answers the same calls. gf-scenic changes: info() reads the GPU from the WebGPU device
// (GPUDevice.adapterInfo) or, on the WebGL2 fallback, from WEBGL_debug_renderer_info, and says which backend draws;
// ready() is a promise that settles once the first frames have drawn.
//   __gfLook.shot(name)    'hero' | 'four' | 'wide' | 'action' | 'top' | null (back to the game camera)
//   __gfLook.perf(ms)      { fps, frames, p50, p95, p99, max, renderCpuMs, calls, triangles }  rAF intervals over ms
//   __gfLook.coverage()    { meshes, tagged, exempt, untagged: [...] }  (R3; ctx.assets.coverage when the kit has it)
//   __gfLook.info()        look.stats() + GPU + backend + viewport
//   __gfLook.freeze(on)    pause the look's clock (wind, water, weather, stars) for a still frame
import * as THREE from 'three/webgpu';

function subjectsOf(ctx, extra) {
  if (extra.subjects) return extra.subjects();
  if (ctx.lookSubjects) return ctx.lookSubjects();
  const list = ctx.players?.list?.() ?? [];
  const me = list.findIndex(p => p.local);
  if (me > 0) list.unshift(...list.splice(me, 1));
  return list.map(p => {
    const o = p.character?.object3d ?? p.body ?? p.object3d;
    const pos = o ? o.getWorldPosition(new THREE.Vector3()) : new THREE.Vector3(p.pose?.x ?? p.x ?? 0, p.pose?.y ?? 0, p.pose?.z ?? p.z ?? 0);
    const hips = p.character?.bones?.get?.('Hips');
    if (hips) { const w = hips.getWorldPosition(new THREE.Vector3()); pos.x = w.x; pos.z = w.z; }
    const yaw = o ? new THREE.Euler().setFromQuaternion(o.getWorldQuaternion(new THREE.Quaternion()), 'YXZ').y : (p.pose?.yaw ?? 0);
    const down = p.alive === false || ['ragdoll', 'getup'].includes(p.character?.state);
    return { position: pos, yaw, height: p.character?.height ?? 1.7, down };
  });
}

// the first visible world mesh on the segment from → to (world.root holds the world's props and ground)
function occludersOf(world) {
  const root = world?.root ?? world?.group;
  if (!root) return undefined;
  const ray = new THREE.Raycaster();
  return (from, to) => {
    const dir = to.clone().sub(from); const len = dir.length();
    if (len < 1e-4) return null;
    ray.set(from, dir.normalize()); ray.far = len; ray.near = 0;
    const hit = ray.intersectObject(root, true).find(h => h.object.visible !== false && !h.object.userData?.gfNoOcclude);
    return hit ? { distance: hit.distance, point: hit.point, object: hit.object } : null;
  };
}

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

export function gpuInfo(renderer) {
  const b = renderer?.backend;
  if (b?.isWebGPUBackend) {
    const i = b.device?.adapterInfo ?? {};
    return { backend: 'webgpu', gpu: [i.vendor, i.architecture, i.description].filter(Boolean).join(' / ') || 'webgpu (adapter info hidden)' };
  }
  try {
    const gl = b?.gl ?? renderer?.getContext?.();
    const ext = gl?.getExtension?.('WEBGL_debug_renderer_info');
    return { backend: 'webgl2', gpu: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl?.getParameter?.(gl.RENDERER) ?? 'unknown' };
  } catch { return { backend: 'unknown', gpu: 'unknown' }; }
}

export function installCaptureApi(ctx, extra = {}) {
  if (typeof window === 'undefined') return null;
  const look = ctx.look;
  let frames = 0, resolveReady = null;
  const readyP = new Promise(ok => { resolveReady = ok; });
  const api = {
    ready: false,
    /** called by the look after each frame */
    tick() { frames++; if (frames === 5) { api.ready = true; resolveReady(true); } },
    whenReady: () => readyP,
    shot(name) {
      if (!name) { look.shot(null); return null; }
      if (typeof name === 'object') { const cam = look.shot(name); return { shot: 'free', position: cam.position.toArray(), fov: cam.fov }; }
      extra.pose?.(name);
      const subjects = subjectsOf(ctx, extra);
      const w = extra.world ?? ctx.world;
      const bounds = w?.bounds;
      const box = bounds?.isBox3 ? bounds : bounds?.half ? new THREE.Box3(new THREE.Vector3(-bounds.half, 0, -bounds.half), new THREE.Vector3(bounds.half, 4, bounds.half)) : undefined;
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
      const g = gpuInfo(ctx.renderer);
      return { ...look.stats(), gpu: g.gpu, backend: g.backend, viewport: [innerWidth, innerHeight], dpr: devicePixelRatio, pixelRatio: ctx.renderer.getPixelRatio() };
    },
    freeze(on) { look.freeze?.(!!on); extra.freeze?.(on); return !!on; },
    /** the look handle itself (the bench's experiments; read the CONTRACT before relying on it in a game) */
    get look() { return look; },
    get ctx() { return ctx; },
  };
  window.__gfLook = api;
  return api;
}
