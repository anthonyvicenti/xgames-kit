// window.__gfLook: the hook lookdev/capture.mjs (and K1's verify, check 9) uses on the bench and in any kit game.
//   __gfLook.shot(name)    'hero' | 'four' | 'wide' | 'action' | null (back to the game camera)
//   __gfLook.perf(ms)      { fps, frames, p50, p95, p99, max, renderCpuMs, calls, triangles }  rAF intervals over ms
//   __gfLook.coverage()    { meshes, tagged, exempt, untagged: [...] }  (R3; ctx.assets.coverage when the kit has it)
//   __gfLook.info()        look.stats() + GPU renderer string + viewport
//   __gfLook.freeze(on)    pause animation where the host supports it (the bench does)
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
  const api = {
    ready: false,
    shot(name) {
      if (!name) { look.shot(null); return null; }
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
