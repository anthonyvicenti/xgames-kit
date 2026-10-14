// gf-three vfx: named effects ("spark-burst", "smoke-puff", "fire") drawn as instanced quads. ONE drawing path for both
// engines: an InstancedMesh of a unit plane with a MeshBasicMaterial, billboarded on the CPU (each instance matrix
// carries the camera's rotation), colour and fade in the per-instance colour. MeshBasicMaterial is accepted by
// WebGLRenderer and by the WebGPU renderer's node-material library alike, so this file has no renderer branch.
//
//   const vfx = vfxOf(ctx);                         // one per game (ctx.vfx), made on first use
//   vfx.fx('spark-burst', { at: {x,y,z}, dir: {x,y,z}, count, scale })      // a one-shot burst at a point
//   const h = vfx.follow('fire', object3d, { offset, rate, scale }); h.stop()   // a continuous emitter that rides an object
//   (named fx, never the verb play: verify check 18 reads every play('id') in game code as a sound id)
//   (the kit's frame calls vfx.update(dt) through ctx.onFrame, after the mechanics, before the render)
//
// A preset is config/game.json → vfx.<name> = { color, colorEnd, texture, shape: {...} } (module.js declares the slots):
// read through ctx.assets on every use, so a Studio override applies at once. The sprite is the slot
// `vfx.<name>.texture`; its mesh is tagged with it (R1) so the coverage walk finds a slot on every spark.
// Blending: 'additive' (light: fades by darkening, exact) and 'normal' (smoke, dust, confetti: a particle cannot
// fade its alpha on this path, so it shrinks away instead; a translucent, alpha-faded smoke would need a second path).
// Quality: the low tier (ctx.quality.name === 'low') draws 40% of the particles in a pool a quarter the size.
import * as THREE from 'three';
import { createSystem, emit, step, normalizeShape, owed } from './sim.js';
import { PRESETS } from './presets.js';

const CAP = { high: 2048, low: 512 };
const LOW_SCALE = 0.4;

export function vfxOf(ctx) {
  if (ctx.vfx) return ctx.vfx;
  const low = ctx.quality?.name === 'low', cap = low ? CAP.low : CAP.high, density = low ? LOW_SCALE : 1;
  const systems = new Map(), followers = new Set(), warned = new Set();
  let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);   // cosmetic only: never touches the game's rng
  const plane = new THREE.PlaneGeometry(1, 1);
  const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), Qz = new THREE.Quaternion(), P = new THREE.Vector3(), S = new THREE.Vector3(), Z = new THREE.Vector3(0, 0, 1);
  const camQ = new THREE.Quaternion(), right = new THREE.Vector3(), up = new THREE.Vector3(), C0 = new THREE.Color(), C1 = new THREE.Color(), C = new THREE.Color(), W = new THREE.Vector3();
  const hsl = { h: 0, s: 0, l: 0 };
  const val = (id, d) => { try { return ctx.assets?.has(id) ? ctx.assets.value(id, d) : d; } catch { return d; } };
  const warnOnce = (key, msg) => { if (!warned.has(key)) { warned.add(key); console.warn(`gf-three vfx: ${msg}`); } };

  function systemOf(name) {
    let sys = systems.get(name); if (sys) return sys;
    const inConfig = !!ctx.assets?.has(`vfx.${name}.shape`), kit = PRESETS[name];
    if (!inConfig && !kit) { warnOnce(name, `no effect called "${name}" (the kit has ${Object.keys(PRESETS).join(', ')}; a game lists its own in config/game.json → vfx)`); return null; }
    if (!inConfig) warnOnce(`cfg:${name}`, `"${name}" is not in config/game.json → vfx, so it has no slots: add it there (create does, for a mechanic's hitFx param)`);
    const shape = normalizeShape({ ...kit?.shape, ...val(`vfx.${name}.shape`, {}) });
    const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, depthWrite: false, toneMapped: false, blending: shape.blending === 'normal' ? THREE.NormalBlending : THREE.AdditiveBlending });
    const mesh = new THREE.InstancedMesh(plane, mat, cap);
    mesh.count = 0; mesh.frustumCulled = false; mesh.name = `gf-vfx-${name}`; mesh.renderOrder = 6;
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    const tex = `vfx.${name}.texture`;
    if (ctx.assets?.has(tex)) {
      ctx.assets.tag(mesh, tex);
      ctx.assets.texture(tex).then(t => { mat.map = t; mat.needsUpdate = true; }).catch(e => console.warn(`gf-three vfx: ${tex}: ${e.message}`));
    } else mesh.userData.gfExempt = 'a vfx preset without a sprite slot (not in config/game.json → vfx)';
    ctx.scene.add(mesh);
    sys = { name, mesh, mat, pool: createSystem(cap), shape, c0: new THREE.Color('#ffffff'), c1: new THREE.Color('#ffffff'), kit };
    systems.set(name, sys); read(sys); return sys;
  }
  /** Take the preset's current values from the slots (a Studio override applies on the next use). */
  function read(sys) {
    const n = sys.name, kit = sys.kit;
    sys.shape = normalizeShape({ ...kit?.shape, ...val(`vfx.${n}.shape`, {}) });
    sys.c0.set(val(`vfx.${n}.color`, kit?.color ?? '#ffd27a')); sys.c1.set(val(`vfx.${n}.color-end`, val(`vfx.${n}.color`, kit?.colorEnd ?? kit?.color ?? '#ffd27a')));
    const want = sys.shape.blending === 'normal' ? THREE.NormalBlending : THREE.AdditiveBlending;
    if (sys.mat.blending !== want) { sys.mat.blending = want; sys.mat.needsUpdate = true; }
  }

  const api = {
    /** Fire a named preset at a point. `dir` aims a cone; without it the burst goes every way. An unknown name warns once. */
    fx(name, { at, dir = null, count, scale = 1 } = {}) {
      if (!at) return;
      const sys = systemOf(name); if (!sys) return;
      read(sys);
      const n = Math.max(1, Math.round((count ?? sys.shape.count) * density));
      emit(sys.pool, sys.shape, at, { dir, count: n, scale, rnd });
    },
    /** A continuous emitter on an object: particles are born at the object's world position (+ offset) at the preset's
     *  `rate` a second and stay where they were born (a trail forms behind a moving object). Stops itself when the
     *  object leaves the scene. → { stop() } */
    follow(name, object3d, { offset = null, rate, dir = null, scale = 1 } = {}) {
      const sys = object3d ? systemOf(name) : null;
      if (!sys) return { stop() {} };
      const f = { name, obj: object3d, offset, rate, dir, scale, acc: 0 };
      followers.add(f);
      return { stop() { followers.delete(f); } };
    },
    /** Once a frame, from ctx.onFrame: emit for the followers, step every system and write its instances for this camera. */
    update(dt) {
      if (api.paused) dt = 0;                                       // a still frame for the preview and the screenshots
      const cam = ctx.camera;
      if (cam) { cam.updateMatrixWorld(); cam.getWorldQuaternion(camQ); right.set(1, 0, 0).applyQuaternion(camQ); up.set(0, 1, 0).applyQuaternion(camQ); }
      for (const f of followers) {
        let o = f.obj; while (o && o !== ctx.scene) o = o.parent;
        if (!o) { followers.delete(f); continue; }                                  // the object left the scene
        const sys = systems.get(f.name); read(sys);
        f.obj.getWorldPosition(W); if (f.offset) { W.x += f.offset.x ?? 0; W.y += f.offset.y ?? 0; W.z += f.offset.z ?? 0; }
        const per = f.rate ?? (sys.shape.rate > 0 ? sys.shape.rate : 20), n = owed(f, per * density, dt);
        if (n > 0) emit(sys.pool, sys.shape, W, { dir: f.dir, count: n, scale: f.scale, rnd });
      }
      for (const sys of systems.values()) {
        const s = sys.pool, sh = sys.shape, mesh = sys.mesh;
        if (s.alive === 0 && mesh.count === 0) continue;        // nothing alive, nothing drawn: no work at all
        step(s, sh, dt);
        const additive = sh.blending !== 'normal', hue = sh.hueJitter > 0;
        let n = 0;
        for (let i = 0; i < s.cap; i++) {
          if (s.age[i] >= s.life[i]) continue;
          const k = s.age[i] / s.life[i], sc = s.size[i] * (1 + (sh.grow - 1) * k) * Math.max(0.02, 1 - k * sh.shrink);
          let len = 1;
          if (sh.stretch > 0) {      // stretch along the screen-space velocity
            const vr = s.vx[i] * right.x + s.vy[i] * right.y + s.vz[i] * right.z, vu = s.vx[i] * up.x + s.vy[i] * up.y + s.vz[i] * up.z;
            len = 1 + Math.min(sh.stretch, Math.hypot(vr, vu) * 0.12 * sh.stretch);
            Qz.setFromAxisAngle(Z, Math.atan2(vu, vr) - Math.PI / 2);
          } else Qz.setFromAxisAngle(Z, s.rot[i]);
          Q.copy(camQ).multiply(Qz);
          M.compose(P.set(s.px[i], s.py[i], s.pz[i]), Q, S.set(sc, sc * len, 1));
          mesh.setMatrixAt(n, M);
          C.copy(C0.copy(sys.c0).lerp(C1.copy(sys.c1), k));
          if (hue) { C.getHSL(hsl); C.setHSL((hsl.h + s.hue[i] + 1) % 1, Math.max(hsl.s, 0.75), Math.max(hsl.l, 0.55)); }
          C.multiplyScalar(sh.intensity * (additive ? Math.pow(1 - k, sh.fade) : 1));
          mesh.setColorAt(n, C);
          n++;
        }
        mesh.count = n;
        mesh.instanceMatrix.needsUpdate = true; mesh.instanceColor.needsUpdate = true;
      }
    },
    paused: false,
    /** Which effects the game has loaded, for tests and the harness. */
    stats() { let alive = 0; for (const s of systems.values()) alive += s.pool.alive; return { systems: systems.size, followers: followers.size, alive, instances: [...systems.values()].reduce((a, s) => a + s.mesh.count, 0), cap, density }; },
    /** Kill every particle and stop every follower (a round restart). */
    reset() { followers.clear(); for (const s of systems.values()) { s.pool.age.fill(1); s.pool.life.fill(1); s.pool.alive = 0; s.mesh.count = 0; } },
  };
  ctx.vfx = api;
  (ctx.onFrame ??= []).push(dt => api.update(dt));
  return api;
}
