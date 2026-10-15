// gf-three vfx: named effects ("spark-burst", "smoke-puff", "fire") drawn as instanced quads, and the effect STYLES a
// mechanic calls without naming a preset (styles.js). ONE drawing path for both engines: an InstancedMesh of a unit
// plane with a MeshBasicMaterial, billboarded on the CPU (each instance matrix carries the camera's rotation), colour
// and fade in the per-instance colour. MeshBasicMaterial and MeshLambertMaterial are accepted by WebGLRenderer and by
// the WebGPU renderer's node-material library alike, so this file has no renderer branch (the one WebGL-only extra, a
// soft sprite's alpha fade, is skipped elsewhere and the sprite shrinks away instead).
//
//   const vfx = vfxOf(ctx);                         // one per game (ctx.vfx), made on first use
//   vfx.fx('spark-burst', { at: {x,y,z}, dir: {x,y,z}, count, scale })      // a one-shot burst at a point
//   const h = vfx.follow('fire', object3d, { offset, rate, scale }); h.stop()   // a continuous emitter that rides an object
//   (named fx, never the verb play: verify check 18 reads every play('id') in game code as a sound id)
//   (the kit's frame calls vfx.update(dt) through ctx.onFrame, after the mechanics, before the render)
//
// The style part (config/game.json → fx, the slot `vfx.style`; styles.js): what the mechanics call.
//   vfx.blast(at, { radius, dir })    a blast: the style's blast presets, sized to the radius (projectile: a splash)
//   vfx.hit(at, { dir, scale })       a hit: the style's hit presets (projectile: a direct hit or a landing)
//   vfx.trail(object3d) → { stop() }  the style's trail behind a flying thing (projectile: each shot)
//   vfx.damage(at, amount, { color }) a damage number over a point, in the HUD's number style (health: every hurt)
// A game with no fx block draws the soft style from the kit's presets.
//
// A preset is config/game.json → vfx.<name> = { color, colorEnd, texture, shape: {...} } (module.js declares the slots):
// read through ctx.assets on every use, so a Studio override applies at once. The sprite is the slot
// `vfx.<name>.texture`; its mesh is tagged with it (R1) so the coverage walk finds a slot on every spark (a mesh preset,
// the blast's rocks, is tagged with its colour slot).
// Drawing kinds (sim.js shape): a sprite, blended 'additive' (light: fades by darkening, exact) or 'normal' (smoke,
// dust, confetti), `solid` (a cut-out: alpha test and depth, so cartoon puffs hide each other), `alpha` (a soft sprite
// that fades its alpha: WebGL), `mesh` (lit low-poly pieces that tumble: chunk, shard), `flipFrames` (a flipbook played
// once a burst: one quad each, a few at a time).
// Quality: the low tier (ctx.quality.name === 'low') draws 40% of the particles in a pool a quarter the size.
import * as THREE from 'three';
import { createSystem, emit, step, normalizeShape, owed } from './sim.js';
import { PRESETS } from './presets.js';
import { STYLES } from './styles.js';

const CAP = { high: 2048, low: 512 };
const LOW_SCALE = 0.4;
const FLIP_MAX = 8;            // flipbook bursts alive at once per preset

export function vfxOf(ctx) {
  if (ctx.vfx) return ctx.vfx;
  const low = ctx.quality?.name === 'low', cap = low ? CAP.low : CAP.high, density = low ? LOW_SCALE : 1;
  const systems = new Map(), followers = new Set(), warned = new Set();
  let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);   // cosmetic only: never touches the game's rng
  const plane = new THREE.PlaneGeometry(1, 1);
  const pieces = { chunk: new THREE.IcosahedronGeometry(0.5, 0), shard: new THREE.TetrahedronGeometry(0.55, 0) };
  pieces.shard.scale(0.6, 1.4, 0.35);
  const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), Qz = new THREE.Quaternion(), P = new THREE.Vector3(), S = new THREE.Vector3(), Z = new THREE.Vector3(0, 0, 1);
  const camQ = new THREE.Quaternion(), right = new THREE.Vector3(), up = new THREE.Vector3(), C0 = new THREE.Color(), C1 = new THREE.Color(), C = new THREE.Color(), W = new THREE.Vector3();
  const E = new THREE.Euler(), V3 = new THREE.Vector3();
  const hsl = { h: 0, s: 0, l: 0 };
  const val = (id, d) => { try { return ctx.assets?.has(id) ? ctx.assets.value(id, d) : d; } catch { return d; } };
  const warnOnce = (key, msg) => { if (!warned.has(key)) { warned.add(key); console.warn(`gf-three vfx: ${msg}`); } };
  const webgpu = () => !!ctx.renderer?.isWebGPURenderer;
  // the camera the frame is drawn from: a look's shot (a sheet, the judge's framings) when one is placed, else the game's
  const viewCam = () => ctx.look?.activeCamera ?? ctx.camera;

  /** A soft sprite's alpha fade (WebGL): a per-instance alpha the fragment multiplies in. */
  function alphaFade(mat, geo) {
    geo.setAttribute('gfAlpha', new THREE.InstancedBufferAttribute(new Float32Array(cap).fill(1), 1));
    mat.onBeforeCompile = sh => {
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute float gfAlpha;\nvarying float vGfAlpha;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvGfAlpha = gfAlpha;');
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying float vGfAlpha;').replace('#include <alphamap_fragment>', '#include <alphamap_fragment>\ndiffuseColor.a *= vGfAlpha;');
    };
    mat.customProgramCacheKey = () => 'gf-vfx-alpha';
  }

  function systemOf(name) {
    let sys = systems.get(name); if (sys) return sys;
    const inConfig = !!ctx.assets?.has(`vfx.${name}.shape`), kit = PRESETS[name];
    if (!inConfig && !kit) { warnOnce(name, `no effect called "${name}" (the kit has ${Object.keys(PRESETS).join(', ')}; a game lists its own in config/game.json → vfx)`); return null; }
    if (!inConfig) warnOnce(`cfg:${name}`, `"${name}" is not in config/game.json → vfx, so it has no slots: add it there (create does, for a mechanic's hitFx param or the game's effect style)`);
    const shape = normalizeShape({ ...kit?.shape, ...val(`vfx.${name}.shape`, {}) });
    const tex = `vfx.${name}.texture`;
    let mesh, mat, flip = null;
    if (shape.mesh) {
      // lit low-poly pieces (the blast's rocks): a tumbling instanced mesh, coloured per instance
      mat = new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true });
      mesh = new THREE.InstancedMesh(pieces[shape.mesh] ?? pieces.chunk, mat, cap);
      mesh.castShadow = false;
      if (ctx.assets?.has(`vfx.${name}.color`)) ctx.assets.tag(mesh, `vfx.${name}.color`);
      else mesh.userData.gfExempt = 'a vfx mesh preset without a colour slot (not in config/game.json → vfx)';
    } else {
      const solid = shape.solid > 0;
      mat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: !solid, alphaTest: solid ? 0.5 : 0, depthWrite: solid, toneMapped: false, blending: shape.blending === 'normal' || solid ? THREE.NormalBlending : THREE.AdditiveBlending });
      const geo = shape.alpha > 0 && !solid && !webgpu() ? plane.clone() : plane;
      if (geo !== plane) alphaFade(mat, geo);
      if (shape.flipFrames > 0) {
        // a flipbook: one quad a burst (a few at a time), each with its own offset into the shared picture
        flip = { list: [], cols: Math.max(1, shape.flipCols), rows: Math.max(1, shape.flipRows), frames: shape.flipFrames, tex: null };
        mesh = new THREE.Group();
      } else mesh = new THREE.InstancedMesh(geo, mat, cap);
      if (ctx.assets?.has(tex)) {
        ctx.assets.tag(mesh, tex);
        ctx.assets.texture(tex).then(t => { if (flip) flip.tex = t; else { mat.map = t; mat.needsUpdate = true; } }).catch(e => console.warn(`gf-three vfx: ${tex}: ${e.message}`));
      } else mesh.userData.gfExempt = 'a vfx preset without a sprite slot (not in config/game.json → vfx)';
    }
    if (mesh.isInstancedMesh) { mesh.count = 0; mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3); }
    mesh.frustumCulled = false; mesh.name = `gf-vfx-${name}`; mesh.renderOrder = 6;
    ctx.scene.add(mesh);
    sys = { name, mesh, mat, pool: createSystem(cap), shape, c0: new THREE.Color('#ffffff'), c1: new THREE.Color('#ffffff'), kit, flip };
    systems.set(name, sys); read(sys); return sys;
  }
  /** Take the preset's current values from the slots (a Studio override applies on the next use). */
  function read(sys) {
    const n = sys.name, kit = sys.kit;
    sys.shape = normalizeShape({ ...kit?.shape, ...val(`vfx.${n}.shape`, {}) });
    sys.c0.set(val(`vfx.${n}.color`, kit?.color ?? '#ffd27a')); sys.c1.set(val(`vfx.${n}.color-end`, val(`vfx.${n}.color`, kit?.colorEnd ?? kit?.color ?? '#ffd27a')));
    if (sys.shape.mesh || sys.shape.solid > 0) return;
    const want = sys.shape.blending === 'normal' ? THREE.NormalBlending : THREE.AdditiveBlending;
    if (sys.mat.blending !== want) { sys.mat.blending = want; sys.mat.needsUpdate = true; }
  }
  /** A flipbook burst: a quad with its own copy of the texture (the picture is shared; only the offset is its own). */
  function flipBurst(sys, at, scale) {
    const F = sys.flip; if (!F.tex) return;
    let q = F.list.find(x => x.age >= x.life);
    if (!q) {
      if (F.list.length >= FLIP_MAX) q = F.list.reduce((a, b) => (a.age / a.life > b.age / b.life ? a : b));
      else {
        const t = F.tex.clone(); t.repeat.set(1 / F.cols, 1 / F.rows); t.needsUpdate = true;
        const m = sys.mat.clone(); m.map = t;
        q = { mesh: new THREE.Mesh(plane, m), tex: t, age: 1, life: 1 }; q.mesh.frustumCulled = false; q.mesh.renderOrder = 6; sys.mesh.add(q.mesh); F.list.push(q);
      }
    }
    const sh = sys.shape;
    q.age = 0; q.life = Math.max(0.1, sh.life); q.size = sh.size * scale * (1 + (rnd() * 2 - 1) * sh.sizeJitter); q.mesh.position.set(at.x, at.y + q.size * 0.25, at.z); q.mesh.visible = true;
    q.mesh.material.color.copy(sys.c0);
  }

  // the game's effect style (config/game.json → fx, the slot `vfx.style`); none: the soft style from the kit's presets
  const styleNow = () => { const f = val('vfx.style', ctx.config?.fx ?? null); return f && typeof f === 'object' ? { ...(STYLES[f.style] ?? STYLES.soft), ...f } : { ...STYLES.soft, style: 'soft', scale: 1 }; };

  const api = {
    /** Fire a named preset at a point. `dir` aims a cone; without it the burst goes every way. An unknown name warns once. */
    fx(name, { at, dir = null, count, scale = 1 } = {}) {
      if (!at) return;
      const sys = systemOf(name); if (!sys) return;
      read(sys);
      if (sys.flip) { flipBurst(sys, at, scale); return; }
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
    /** The game's effect style now: {style, blast, hit, trail, numbers, scale}. */
    get style() { return styleNow(); },
    /** A blast at a point, in the game's style, sized to `radius` (metres; the style's presets are made for about 2). */
    blast(at, { radius = 2, dir = null } = {}) {
      if (!at) return;
      const f = styleNow(), scale = (f.scale ?? 1) * Math.min(3, Math.max(0.4, radius / 2));
      // a blast sits on what it hit: its centre a little up, so the cloud is not half under the ground
      const c = { x: at.x, y: at.y + 0.45 * scale, z: at.z };
      for (const n of f.blast ?? []) api.fx(n, { at: c, dir, scale });
    },
    /** A hit at a point, in the game's style. */
    hit(at, { dir = null, scale = 1 } = {}) {
      if (!at) return;
      const f = styleNow();
      for (const n of f.hit ?? []) api.fx(n, { at, dir, scale: scale * (f.scale ?? 1) });
    },
    /** The style's trail behind a flying object (a shot); stops itself when the object leaves the scene. → { stop() } */
    trail(object3d, { scale = 1 } = {}) {
      const f = styleNow();
      return f.trail ? api.follow(f.trail, object3d, { scale: scale * (f.scale ?? 1) }) : { stop() {} };
    },
    /** A damage number over a world point, in the HUD's number style (kind-hud.js `numbers`: comic | float). */
    damage(at, amount, { color = null } = {}) {
      const f = styleNow(), cam = viewCam();
      if (!at || !cam || f.numbers === 'none' || !ctx.ui?.pop || !Number.isFinite(amount) || Math.abs(amount) < 1e-6) return;
      V3.set(at.x, at.y, at.z).project(cam);
      if (V3.z > 1 || Math.abs(V3.x) > 1.1 || Math.abs(V3.y) > 1.1) return;
      const n = Math.round(Math.abs(amount) * 10) / 10;
      ctx.ui.pop(String(n), (V3.x * 0.5 + 0.5) * innerWidth, (-V3.y * 0.5 + 0.5) * innerHeight, color);
    },
    /** Once a frame, from ctx.onFrame: emit for the followers, step every system and write its instances for this camera. */
    update(dt) {
      if (api.paused) dt = 0;                                       // a still frame for the preview and the screenshots
      const cam = viewCam();
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
        const sh = sys.shape;
        if (sys.flip) {                                                       // flipbooks: one quad each
          for (const q of sys.flip.list) {
            if (q.age >= q.life) { q.mesh.visible = false; continue; }
            q.age += dt; const k = Math.min(0.999, q.age / q.life), F = sys.flip;
            const fr = Math.min(F.frames - 1, Math.floor(k * F.frames)), cx = fr % F.cols, cy = Math.floor(fr / F.cols);
            q.tex.offset.set(cx / F.cols, 1 - (cy + 1) / F.rows);
            const sc = q.size * (1 + (sh.grow - 1) * k);
            q.mesh.quaternion.copy(camQ); q.mesh.scale.set(sc, sc, 1);
            if (q.age >= q.life) q.mesh.visible = false;
          }
          continue;
        }
        const s = sys.pool, mesh = sys.mesh;
        if (s.alive === 0 && mesh.count === 0) continue;        // nothing alive, nothing drawn: no work at all
        step(s, sh, dt);
        const additive = sh.blending !== 'normal' && !(sh.solid > 0) && !sh.mesh, hue = sh.hueJitter > 0, alpha = mesh.geometry.getAttribute?.('gfAlpha');
        let n = 0;
        for (let i = 0; i < s.cap; i++) {
          if (s.age[i] >= s.life[i]) continue;
          const k = s.age[i] / s.life[i], sc = s.size[i] * (1 + (sh.grow - 1) * k) * Math.max(0.02, 1 - k * sh.shrink);
          let len = 1;
          if (sh.mesh) {                    // a tumbling piece: its own rotation, lit by the world
            E.set(s.rot[i], s.rot[i] * 0.7 + i, s.rot[i] * 1.3); Q.setFromEuler(E);
            M.compose(P.set(s.px[i], s.py[i], s.pz[i]), Q, S.set(sc, sc, sc));
          } else {
            if (sh.stretch > 0) {      // stretch along the screen-space velocity
              const vr = s.vx[i] * right.x + s.vy[i] * right.y + s.vz[i] * right.z, vu = s.vx[i] * up.x + s.vy[i] * up.y + s.vz[i] * up.z;
              len = 1 + Math.min(sh.stretch, Math.hypot(vr, vu) * 0.12 * sh.stretch);
              Qz.setFromAxisAngle(Z, Math.atan2(vu, vr) - Math.PI / 2);
            } else Qz.setFromAxisAngle(Z, sh.upright > 0 ? 0 : s.rot[i]);
            Q.copy(camQ).multiply(Qz);
            M.compose(P.set(s.px[i], s.py[i], s.pz[i]), Q, S.set(sc, sc * len, 1));
          }
          mesh.setMatrixAt(n, M);
          C.copy(C0.copy(sys.c0).lerp(C1.copy(sys.c1), k));
          if (hue) { C.getHSL(hsl); C.setHSL((hsl.h + s.hue[i] + 1) % 1, Math.max(hsl.s, 0.75), Math.max(hsl.l, 0.55)); }
          C.multiplyScalar(sh.intensity * (additive ? Math.pow(1 - k, sh.fade) : 1));
          mesh.setColorAt(n, C);
          if (alpha) alpha.array[n] = Math.pow(1 - k, sh.fade);
          n++;
        }
        mesh.count = n;
        mesh.instanceMatrix.needsUpdate = true; mesh.instanceColor.needsUpdate = true;
        if (alpha) alpha.needsUpdate = true;
      }
    },
    paused: false,
    /** Which effects the game has loaded, for tests and the harness. */
    stats() {
      let alive = 0, flips = 0; for (const s of systems.values()) { alive += s.pool.alive; flips += s.flip ? s.flip.list.filter(q => q.age < q.life).length : 0; }
      return { systems: systems.size, followers: followers.size, alive, flips, instances: [...systems.values()].reduce((a, s) => a + (s.mesh.count ?? 0), 0), cap, density, style: styleNow().style ?? 'soft' };
    },
    /** Kill every particle and stop every follower (a round restart). */
    reset() {
      followers.clear();
      for (const s of systems.values()) {
        s.pool.age.fill(1); s.pool.life.fill(1); s.pool.alive = 0;
        if (s.flip) for (const q of s.flip.list) { q.age = q.life; q.mesh.visible = false; } else s.mesh.count = 0;
      }
    },
  };
  ctx.vfx = api;
  (ctx.onFrame ??= []).push(dt => api.update(dt));
  return api;
}
