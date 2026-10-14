// gf-three look (track L): renderer, lighting, sky and fog, shadows, post stack and house materials.
// CONTRACT §4.2:
//   createRenderer(canvas, preset, quality)  WebGLRenderer + tone mapping + shadows from the preset
//   applyLook(ctx, preset, opts)            lights, sky/fog, environment, post stack; returns the look handle (also ctx.look)
//   material(kind, opts)                    house materials: character | prop | ground | water | liquid | glow
//   presets                                 { 'jelly-pastel', 'toon-lowpoly', 'soft-stylised' } (kit/look/presets/*.json)
// A preset is plain JSON; every number and colour in it is a look.* slot (slots.js). Lighting and post are tuned per
// quality tier (preset.quality.high|low) and per time of day (preset.times.day|golden|night, deep-merged over the base).
import * as THREE from 'three';
import { presets } from './presets.js';
import { material, adoptMaterials, configureMaterials, tickMaterials, setTint, setWorldLight, worldLightUniforms, U as materialUniforms } from './materials.js';
import { createSky, sunDirection } from './sky.js';
import { createPost } from './post.js';
import { attachLofi } from './lofi.js';
import { frameShot, SHOTS } from './shots.js';
import { createStream } from './liquid.js';
import { installCaptureApi } from './capture-api.js';

export { presets, material, adoptMaterials, setTint, setWorldLight, worldLightUniforms, createStream, frameShot, SHOTS, materialUniforms, sunDirection, installCaptureApi };
export { slots, slotsFor } from './slots.js';
export const TIMES = ['day', 'golden', 'night'];
export const QUALITIES = ['high', 'low'];

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
export function deepMerge(a, b) {
  if (!isObj(a) || !isObj(b)) return b === undefined ? structuredClone(a) : structuredClone(b);
  const out = structuredClone(a);
  for (const [k, v] of Object.entries(b)) out[k] = isObj(v) && isObj(out[k]) ? deepMerge(out[k], v) : structuredClone(v);
  return out;
}

/** The preset object for an id, a preset object, or a config/look.json ({ preset: id, ...overrides }). */
export function presetOf(p) {
  if (typeof p === 'string') { if (!presets[p]) throw new Error(`gf-three look: unknown preset "${p}" (${Object.keys(presets).join(', ')})`); return presets[p]; }
  if (!isObj(p)) return presets['jelly-pastel'];
  const id = p.preset ?? p.id;
  return presets[id] ? deepMerge(presets[id], p) : p;
}

/** The values in force: the preset with its time of day merged over the base (times/quality blocks dropped). */
export function resolveLook(preset, time = 'day') {
  const p = presetOf(preset);
  const t = p.times?.[time] ?? {};
  const out = deepMerge(p, t);
  delete out.times;
  out.time = time;
  return out;
}

/** What `gf-three create` writes to config/look.json: the whole preset (every value a slot) plus the chosen time. */
export function lookConfig(presetId, { time = 'day', quality } = {}) {
  const p = structuredClone(presetOf(presetId));
  return { preset: p.id, time, ...(quality ? { quality: quality } : {}), ...p, id: undefined };
}

export function tierOf(preset, quality = 'high') {
  const p = presetOf(preset);
  return { name: quality, ...(p.quality?.[quality] ?? p.quality?.high ?? {}) };
}

// quality may be 'high' | 'low' or K1's tier object ({ name: 'high', ... }, kit/core/quality.js)
const qualityName = (q) => (typeof q === 'string' ? q : q?.name) ?? null;
function urlQuality() {
  try { const q = new URLSearchParams(location.search).get('quality'); return QUALITIES.includes(q) ? q : null; } catch { return null; }
}

/** WebGLRenderer with the preset's tone mapping, exposure and soft shadows. Tone mapping itself runs in the post stack. */
export function createRenderer(canvas, preset, quality) {
  quality = qualityName(quality) ?? urlQuality() ?? 'high';
  const tier = tierOf(preset, quality);
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, stencil: false, depth: true, powerPreference: 'high-performance', alpha: false });
  renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio ?? 1, tier.pixelRatio ?? 1));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;           // AgX / ACES run in the post stack (ToneMappingEffect)
  renderer.toneMappingExposure = resolveLook(preset).renderer?.exposure ?? 1;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;          // r186: PCF with a Vogel-disk radius = soft shadows
  renderer.info.autoReset = false;
  renderer.userData = { gfQuality: quality };
  return renderer;
}

/**
 * Lights, sky, fog, environment and post for a scene. ctx needs { scene, camera, renderer }.
 * opts: { quality: 'high'|'low', time: 'day'|'golden'|'night', textures: { noise: THREE.Texture } }.
 * Returns the look handle and sets ctx.look. The game loop calls look.render(dt) instead of renderer.render.
 */
export function applyLook(ctx, preset, opts = {}) {
  opts = { ...opts };
  const { scene, camera, renderer } = ctx;
  if (!preset && ctx.assets?.config) { try { preset = ctx.assets.config('look'); } catch { /* no config/look.json */ } }
  let base = presetOf(preset ?? 'jelly-pastel');
  let time = opts.time ?? (isObj(preset) ? preset.time : null) ?? 'day';
  const quality = qualityName(opts.quality) ?? renderer.userData?.gfQuality ?? qualityName(ctx.quality) ?? urlQuality() ?? 'high';
  let tier = tierOf(base, quality);
  let values = resolveLook(base, time);

  const sky = createSky();
  scene.add(sky.dome);
  const sun = new THREE.DirectionalLight('#ffffff', 2);
  sun.name = 'gf-sun';
  sun.castShadow = true;
  sun.shadow.mapSize.set(tier.shadowMapSize ?? 2048, tier.shadowMapSize ?? 2048);
  sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.025;
  scene.add(sun, sun.target);
  const hemi = new THREE.HemisphereLight('#ffffff', '#888888', 1);
  hemi.name = 'gf-ambient';
  scene.add(hemi);
  scene.fog = new THREE.Fog('#ffffff', 40, 160);
  const sunDir = new THREE.Vector3();
  const shadowBox = new THREE.Box3(new THREE.Vector3(-20, 0, -20), new THREE.Vector3(20, 6, 20));
  let post = null, lofi = null;
  let shotCamera = null;
  let mainCamera = camera;
  const lamps = { points: [], lights: [], orbs: [], group: new THREE.Group() };
  lamps.group.name = 'gf-lamps';
  scene.add(lamps.group);
  const stats = { frames: 0, cpuMs: 0, last: 0 };
  let t0 = performance.now();

  function fitShadows(box = shadowBox) {
    shadowBox.copy(box);
    const center = box.getCenter(new THREE.Vector3());
    const radius = box.getBoundingSphere(new THREE.Sphere()).radius;
    sun.target.position.copy(center);
    sun.position.copy(center).addScaledVector(sunDir, radius * 2);
    const c = sun.shadow.camera;
    c.left = -radius; c.right = radius; c.top = radius; c.bottom = -radius;
    c.near = radius * 0.5; c.far = radius * 3.5;
    c.updateProjectionMatrix();
    sun.target.updateMatrixWorld(); sun.updateMatrixWorld();
    sun.shadow.needsUpdate = true;
  }

  function configure() {
    const v = values;
    configureMaterials(v.materials, opts.textures ?? {});
    sunDirection(v.sun.elevation, v.sun.azimuth, sunDir);
    sun.color.set(v.sun.color); sun.intensity = v.sun.intensity;
    sun.shadow.intensity = v.sun.shadowStrength ?? 1;
    sun.shadow.radius = v.sun.shadowSoftness ?? 2;
    hemi.color.set(v.ambient.sky); hemi.groundColor.set(v.ambient.ground); hemi.intensity = v.ambient.intensity;
    scene.fog.color.set(v.fog.color); scene.fog.near = v.fog.near; scene.fog.far = v.fog.far;
    sky.set(v.sky, sunDir, v.ambient.envGround ?? v.ambient.ground);
    scene.environment = sky.bakeEnvironment(renderer);
    scene.environmentIntensity = v.ambient.envIntensity ?? 1;
    scene.background = null;
    renderer.toneMappingExposure = v.renderer?.exposure ?? 1;
    fitShadows(shadowBox);
    configureLamps();
    post?.configure(v);
    if (lofi && v.post?.lofi) lofi.set(v.post.lofi);
  }

  function configureLamps() {
    const L = values.lamps ?? {};
    const on = (L.intensity ?? 0) > 0;
    for (const l of lamps.lights) { l.visible = on; l.color.set(L.color ?? '#ffd59a'); l.intensity = L.intensity ?? 0; l.distance = L.distance ?? 9; }
    for (const o of lamps.orbs) { o.visible = on && (L.glow ?? 0) > 0; }
    if (lamps.orbMaterial) { lamps.orbMaterial.color.set(L.color ?? '#ffd59a'); }
  }

  /** Light points from the world (lanterns, street lights, lamps): [{ position: Vector3 }]. Night turns them on. */
  function setLamps(points = []) {
    for (const l of lamps.lights) lamps.group.remove(l);
    for (const o of lamps.orbs) lamps.group.remove(o);
    lamps.lights = []; lamps.orbs = []; lamps.points = points;
    if (!points.length) return;
    lamps.orbMaterial ??= material('glow', { color: values.lamps?.color ?? '#ffd59a' });
    lamps.orbGeometry ??= new THREE.IcosahedronGeometry(0.16, 2);
    const center = shadowBox.getCenter(new THREE.Vector3());
    const ranked = [...points].sort((a, b) => a.position.distanceToSquared(center) - b.position.distanceToSquared(center));
    const n = Math.min(tier.lampLights ?? 4, ranked.length);
    for (let i = 0; i < n; i++) {
      const l = new THREE.PointLight('#ffd59a', 0, 9, 1.6);
      l.position.copy(ranked[i].position);
      l.castShadow = false;
      lamps.lights.push(l); lamps.group.add(l);
    }
    for (const p of points) {
      const o = new THREE.Mesh(lamps.orbGeometry, lamps.orbMaterial);
      o.position.copy(p.position); o.scale.setScalar(p.radius ?? 1);
      o.userData.gfSlot = 'look.lamps.color';   // a kit primitive whose material is a look slot
      o.castShadow = false;
      lamps.orbs.push(o); lamps.group.add(o);
    }
    configureLamps();
  }

  function buildPost() {
    lofi?.dispose(); lofi = null;
    post?.dispose();
    post = createPost(renderer, scene, shotCamera ?? mainCamera, values, tier);
    // the lofi kind's pass (post.lofi; kit/look/lofi.js): after the stack, at its own low resolution
    if (values.post?.lofi) lofi = attachLofi(post.composer, renderer, scene, values.post.lofi);
    const s = renderer.getSize(new THREE.Vector2());
    if (lofi) { renderer.setPixelRatio(lofi.pixelRatio(s.y)); renderer.setSize(s.x, s.y, false); }
    post.setSize(s.x, s.y);
    lofi?.fitted();
  }

  configure();
  buildPost();
  // the noise texture slot (look.textures.noise): from opts, else through the kit's assets (async; flat until it loads)
  if (!opts.textures?.noise && ctx.assets?.texture && (ctx.assets.has?.('look.textures.noise') ?? true)) {
    Promise.resolve(ctx.assets.texture('look.textures.noise')).then((t) => {
      if (!t) return;
      t.colorSpace = THREE.NoColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.needsUpdate = true;
      opts = { ...opts, textures: { ...(opts.textures ?? {}), noise: t } };
      configureMaterials(values.materials, opts.textures);
    }).catch(() => { /* optional slot: flat materials */ });
  }

  const handle = {
    get preset() { return base; }, get values() { return values; }, get time() { return time; }, get quality() { return quality; }, get tier() { return tier; },
    sun, hemi, sky, lamps, get post() { return post; },
    material, adoptMaterials, setTint, setWorldLight, worldLightUniforms,
    /** Restyle live: a new preset (id or object) and/or time. */
    set({ preset: p, time: t } = {}) {
      if (p) { base = presetOf(p); tier = tierOf(base, quality); }
      if (t) time = t;
      values = resolveLook(base, time);
      configure();
      if (p) buildPost();
      return handle;
    },
    setTime(t) { return handle.set({ time: t }); },
    fitShadows, setLamps,
    resize(w, h) {
      // under the lofi pass the renderer's pixel ratio is the pass's (whole screen pixels a lofi pixel)
      if (lofi) renderer.setPixelRatio(lofi.pixelRatio(h));
      renderer.setSize(w, h, false);
      for (const cam of [mainCamera, shotCamera]) if (cam?.isPerspectiveCamera) { cam.aspect = w / h; cam.updateProjectionMatrix(); }
      post?.setSize(w, h);
      lofi?.fitted();
    },
    get lofi() { return lofi; },
    /** Point a dedicated camera at one of SHOTS ('hero' | 'four' | 'wide' | 'action') or null to go back to ctx.camera. */
    shot(name, subjects = {}) {
      if (!name) { shotCamera = null; post?.setCamera(mainCamera); return null; }
      shotCamera ??= new THREE.PerspectiveCamera(50, mainCamera.aspect, 0.1, mainCamera.far);
      shotCamera.aspect = mainCamera.aspect; shotCamera.far = mainCamera.far;
      shotCamera.userData.frame = frameShot(name, shotCamera, { bounds: subjects.bounds ?? shadowBox, ...subjects });
      post?.setCamera(shotCamera);
      return shotCamera;
    },
    get activeCamera() { return shotCamera ?? mainCamera; },
    /** No per-frame work: the shadow camera is fitted to the world (fitShadows), so it never swims. */
    update() {},
    /** render(dt) or render(camera) (K1's boot passes its camera; a new one is adopted for the post stack). */
    render(arg) {
      if (arg?.isCamera && arg !== mainCamera) { mainCamera = arg; if (!shotCamera) post?.setCamera(arg); }
      const a = performance.now();
      const dt = typeof arg === 'number' ? arg : Math.min(0.1, (a - (stats.at ?? a)) / 1000);
      stats.at = a;
      tickMaterials((a - t0) / 1000);
      renderer.info.reset();
      lofi?.update();
      post.render(dt);
      const ms = performance.now() - a;
      stats.frames++; stats.cpuMs = stats.cpuMs * 0.95 + ms * 0.05; stats.last = ms;
    },
    stats() {
      const i = renderer.info;
      return { frames: stats.frames, renderCpuMs: +stats.cpuMs.toFixed(3), calls: i.render.calls, triangles: i.render.triangles, programs: i.programs?.length ?? 0, geometries: i.memory.geometries, textures: i.memory.textures, quality, preset: base.id, time };
    },
    dispose() { post?.dispose(); sky.dispose(); scene.remove(sky.dome, sun, sun.target, hemi, lamps.group); },
  };
  ctx.look = handle;
  if (typeof window !== 'undefined' && opts.captureApi !== false) { const api = installCaptureApi(ctx); if (api) api.ready = true; }
  return handle;
}
