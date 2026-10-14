// gf-scenic look (CONTRACT §4.2 and §8): the renderer, light, shade, fog, sky, weather, wind and post of the scenic
// engine, ported from folio-2025 (Bruno Simon, MIT, brunosimon/folio-2025@41046b5; research/gf-scenic/kit/LICENSE-folio-2025):
// Rendering.js → renderer + post.js, Materials.js + MeshDefaultMaterial.js → materials.js, Ligthing.js + Fog.js +
// Cycles/DayCycles.js → this file and sky.js, Wind.js + Noises.js → materials.js (windOffset) + noises.js,
// RainLines.js + Lightnings.js → weather.js. Each ported file names its upstream file in its header.
//
//   createRenderer(canvas, values, quality) → WebGPURenderer (WebGL2 inside it when WebGPU is missing, or ?renderer=webgl)
//   ready(renderer)                         await renderer.init() (boot awaits it before anything draws)
//   applyLook(ctx, values) → the look handle (also ctx.look):
//     render(camera), resize(w, h), update(dt, at), shot(name, subjects), stats(), freeze(on), set({time}),
//     setLamps(points), setBounce(color), fitShadows(box), focus, values, time, sun, U, material, adoptMaterials
//   presets, presetValues(id), lookConfig(id, {time}), resolveLook(cfg, time), slots, slotsFor(lookJson)
//   material(kind, opts), adoptMaterials(object, kind), setTint(target, colour)   house materials (CONTRACT §4.2)
//
// Every value is a look.* slot (slots.js). Quality tiers come from the preset's quality.high|low, capped by the kit's
// tier (kit/core/quality.js). Everything the game draws gets the house material: kit modules adopt their own meshes,
// and update() adopts anything else that appears (GLBs loaded later, mechanics' meshes), in place.
import * as THREE from 'three/webgpu';
import { fog } from 'three/tsl';
import { presets, presetValues, TIMES, resolveLook, deepMerge } from './presets.js';
import { U, LAMP_SLOTS, material, adoptMaterials, adoptScene, setTint, setGlowColors, patchMaterial, glowMaterial, fogColorNode, fogStrengthNode, windOffset, HouseMaterial } from './materials.js';
import { createNoises } from './noises.js';
import { createPost } from './post.js';
import { skyNode, setSky } from './sky.js';
import { createWeather } from './weather.js';
import { frameShot, SHOTS } from './shots.js';
import { installCaptureApi, gpuInfo } from './capture-api.js';

export { presets, presetValues, TIMES, resolveLook, material, adoptMaterials, setTint, frameShot, SHOTS, installCaptureApi, U, windOffset, HouseMaterial, glowMaterial, patchMaterial, fogColorNode, fogStrengthNode };
export { slots, slotsFor } from './slots.js';

/** config/look.json for a preset: the whole preset, every value a slot (time kept for Studio). */
export function lookConfig(id, { time } = {}) {
  const pid = presets[id] ? id : 'dusk-isle';
  const v = presetValues(pid);
  delete v.label; delete v.describe;
  return { preset: pid, ...v, time: TIMES.includes(time) ? time : v.time };
}

const DEG = Math.PI / 180;
const qName = q => (typeof q === 'string' ? q : q?.name) ?? 'high';
const urlParam = k => { try { return new URLSearchParams(location.search).get(k); } catch { return null; } };

/** The tier in force: the preset's quality[name], within the kit's tier (pixel ratio cap, shadows off). */
export function tierOf(values, quality) {
  const name = qName(quality) === 'low' ? 'low' : 'high';
  const t = { name, ...(values?.quality?.[name] ?? {}) };
  if (typeof quality === 'object' && quality) {
    if (quality.pixelRatio) t.pixelRatio = Math.min(t.pixelRatio ?? 2, quality.pixelRatio);
    t.msaa = quality.antialias !== false && name === 'high';
  }
  return t;
}

export function createRenderer(canvas, values, quality = {}) {
  const forceWebGL = urlParam('renderer') === 'webgl';
  const tier = tierOf(values, quality);
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: false, powerPreference: 'high-performance', forceWebGL });
  renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio ?? 1, tier.pixelRatio ?? 2));
  renderer.shadowMap.enabled = tier.shadows !== false;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.NoToneMapping;           // folio: no tone mapping; bloom's threshold sits at 1
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.info.autoReset = false;
  renderer.userData = { gfTier: tier };
  return renderer;
}

export async function ready(renderer) {
  await renderer.init();
}

// the times of day in the order a day cycle passes them, and where (0..1)
const CYCLE = [['day', 0], ['golden', 0.2], ['dusk', 0.3], ['night', 0.42], ['night', 0.62], ['golden', 0.78], ['day', 0.9]];
const BLEND = ['light.color', 'light.intensity', 'light.elevation', 'shadow.color', 'fog.colorA', 'fog.colorB', 'sky.top', 'sky.strength', 'sky.stars', 'lamps.intensity'];
const get = (o, p) => p.split('.').reduce((a, k) => a?.[k], o);
const put = (o, p, v) => { const k = p.split('.'); let a = o; for (const x of k.slice(0, -1)) a = a[x] ??= {}; a[k.at(-1)] = v; };
const sstep = t => t * t * (3 - 2 * t);
function blendValues(a, b, t) {
  const out = deepMerge(a, {});
  const ca = new THREE.Color(), cb = new THREE.Color();
  for (const p of BLEND) {
    const x = get(a, p), y = get(b, p);
    if (typeof x === 'number' && typeof y === 'number') put(out, p, x + (y - x) * t);
    else if (typeof x === 'string' && typeof y === 'string') put(out, p, '#' + ca.set(x).lerp(cb.set(y), t).getHexString());
  }
  return out;
}

export function applyLook(ctx, cfg = {}, opts = {}) {
  const { scene, renderer, camera } = ctx;
  if (!cfg?.light && ctx.assets?.config) { try { cfg = ctx.assets.config('look'); } catch { /* bench */ } }
  if (!cfg?.light) cfg = lookConfig(cfg?.preset ?? 'dusk-isle', { time: cfg?.time });
  let time = opts.time ?? cfg.time;
  const tier = tierOf(cfg, ctx.quality ?? renderer.userData?.gfTier?.name);
  let values = resolveLook(cfg, time);
  const states = Object.fromEntries(TIMES.map(t => [t, resolveLook(cfg, t)]));

  // ---- noise (wind, grass, water), sky, fog for anything not adopted ----
  const noises = createNoises(renderer);
  U.perlin.value = noises.perlin; U.voronoi.value = noises.voronoi;
  scene.backgroundNode = skyNode;
  scene.fogNode = fog(fogColorNode, fogStrengthNode);

  // ---- the sun (folio's Lighting): a directional light whose shadow box follows the view ----
  const sun = new THREE.DirectionalLight('#ffffff', 1);
  sun.name = 'gf-scenic-sun';
  sun.castShadow = renderer.shadowMap.enabled;
  sun.shadow.mapSize.set(tier.shadowMapSize ?? 2048, tier.shadowMapSize ?? 2048);
  sun.shadow.bias = -0.001; sun.shadow.normalBias = 0.08; sun.shadow.radius = tier.shadowRadius ?? 3;
  scene.add(sun, sun.target);
  const sunDir = new THREE.Vector3();
  const focus = new THREE.Vector3(), viewFocus = new THREE.Vector3();
  let viewRadius = 20;

  // ---- weather, post ----
  const weather = createWeather(scene, { rng: mulberry(cfg.seed ?? 7), count: tier.name === 'low' ? 2048 : 4096 });
  const post = createPost(renderer, scene, camera, values, { ...tier, msaa: tier.msaa });
  let shotCamera = null, mainCamera = camera;

  // ---- lamps: the world's light points; the nearest LAMP_SLOTS to the view light the ground ----
  let lamps = [];
  const lampCol = new THREE.Color();

  function configure(v) {
    const L = v.light ?? {};
    const el = (L.elevation ?? 38) * DEG, az = (L.azimuth ?? 205) * DEG;
    sunDir.set(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az)).normalize();
    U.lightDir.value.copy(sunDir);
    U.lightColor.value.set(L.color ?? '#ffffff');
    U.lightIntensity.value = L.intensity ?? 1;
    U.coreLow.value = L.coreShadowLow ?? -0.25; U.coreHigh.value = L.coreShadowHigh ?? 1;
    sun.color.set(L.color ?? '#ffffff'); sun.intensity = L.intensity ?? 1;
    U.shadowColor.value.set(v.shadow?.color ?? '#4b3896'); U.shadowStrength.value = v.shadow?.strength ?? 1;
    U.bounceStrength.value = v.bounce?.strength ?? 0.6; U.bounceDistance.value = v.bounce?.distance ?? 1.5;
    const F = v.fog ?? {};
    U.fogA.value.set(F.colorA ?? '#2b2552'); U.fogB.value.set(F.colorB ?? '#08081a');
    U.fogNear.value = F.near ?? 34; U.fogFar.value = F.far ?? 120;
    U.fogRadialStart.value = F.radialStart ?? 0.1; U.fogRadialEnd.value = F.radialEnd ?? 0.85;
    U.voidTop.value = F.voidTop ?? -1; U.voidBottom.value = F.voidBottom ?? -26;
    U.rimColor.value.set(v.rim?.color ?? '#ffffff'); U.rimStrength.value = v.rim?.strength ?? 0.3;
    U.charLift.value = v.character?.shadeLift ?? 0.4; U.charShade.value = v.character?.shadeStrength ?? 0.75; U.charBright.value = v.character?.brightness ?? 1.05;
    U.lampColor.value.set(v.lamps?.color ?? '#ffae5c'); U.lampIntensity.value = v.lamps?.intensity ?? 1; U.lampRadius.value = v.lamps?.radius ?? 6;
    U.glowIntensity.value = v.glow?.intensity ?? 2;
    U.glowRune.value.set(v.glow?.rune ?? '#55ff9e'); U.glowCrystal.value.set(v.glow?.crystal ?? '#9b72ff');
    const W = v.wind ?? {};
    U.windStrength.value = W.strength ?? 0.35;
    U.windDir.value.set(Math.sin((W.angle ?? 108) * DEG), Math.cos((W.angle ?? 108) * DEG));
    setSky(v);
    setGlowColors(v.glow ?? {});
    post.configure(v, tier);
    camera.far = Math.max(camera.far, (F.far ?? 120) * 2.5); camera.updateProjectionMatrix();
  }
  configure(values);

  // the ground point the active camera looks at, and how much of the ground it sees (folio's optimal area)
  const ray = new THREE.Ray(), plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), fwd = new THREE.Vector3();
  function viewArea(cam, groundY) {
    cam.getWorldDirection(fwd);
    ray.set(cam.position, fwd);
    plane.constant = -groundY;
    const hit = ray.intersectPlane(plane, viewFocus);
    if (!hit || cam.position.distanceTo(viewFocus) > 400) viewFocus.set(cam.position.x + fwd.x * 20, groundY, cam.position.z + fwd.z * 20);
    const d = cam.position.distanceTo(viewFocus);
    const half = Math.tan((cam.fov ?? 50) * DEG / 2) * d;
    viewRadius = Math.max(10, Math.min(80, half * Math.max(1, cam.aspect ?? 1) * 1.35));
    return viewFocus;
  }

  // the shadow box: centred on the view, snapped to whole shadow texels in light space so shadows never shimmer
  const lx = new THREE.Vector3(), ly = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0), snapped = new THREE.Vector3();
  function placeSun(center, radius) {
    const size = sun.shadow.mapSize.x, texel = (radius * 2) / size;
    lx.crossVectors(up, sunDir).normalize(); ly.crossVectors(sunDir, lx).normalize();
    const a = Math.round(center.dot(lx) / texel) * texel, b = Math.round(center.dot(ly) / texel) * texel, c = center.dot(sunDir);
    snapped.copy(lx).multiplyScalar(a).addScaledVector(ly, b).addScaledVector(sunDir, c);
    const sc = sun.shadow.camera;
    if (sc.right !== radius) { sc.left = -radius; sc.right = radius; sc.top = radius; sc.bottom = -radius; sc.near = 1; sc.far = radius * 4 + 60; sc.updateProjectionMatrix(); }
    sun.target.position.copy(snapped);
    sun.position.copy(snapped).addScaledVector(sunDir, radius * 2 + 30);
  }

  let clock = 0, frozen = false, adoptTick = 0, cycleClock = 0;
  const stats = { frames: 0, cpuMs: 0 };
  const handle = {
    get preset() { return cfg.preset; }, get values() { return values; }, get time() { return time; }, get tier() { return tier; },
    get focus() { return focus; }, get viewRadius() { return viewRadius; }, get clock() { return clock; },
    get activeCamera() { return shotCamera ?? mainCamera; },
    sun, U, weather, post, noises,
    material, adoptMaterials, setTint, patchMaterial, glowMaterial,
    /** Restyle live: another time of day (or a new config/look.json). */
    set({ time: t, config } = {}) {
      if (config) { cfg = config; for (const k of TIMES) states[k] = resolveLook(cfg, k); }
      if (t) time = t;
      values = resolveLook(cfg, time);
      configure(values);
      return handle;
    },
    setTime(t) { return handle.set({ time: t }); },
    /** Light points from the world: [{ position: Vector3, color?: 'lantern'|'crystal'|'rune'|'#hex', radius?, intensity? }]. */
    setLamps(points = []) { lamps = points.map(p => ({ ...p, position: p.position.clone?.() ?? new THREE.Vector3(...p.position) })); },
    /** The ground colour light bounces up from (the world sets it). */
    setBounce(c) { U.bounceColor.value.set(c); },
    fitShadows() { /* the shadow box follows the view (folio); kept for CONTRACT §4.2 */ },
    resize(w, h) { for (const cam of [mainCamera, shotCamera]) if (cam?.isPerspectiveCamera) { cam.aspect = w / Math.max(1, h); cam.updateProjectionMatrix(); } },
    /** Point a dedicated camera at one of SHOTS (or null to go back to the game camera). */
    shot(name, subjects = {}) {
      if (!name) { shotCamera = null; post.setCamera(mainCamera); post.dof(true); return null; }
      shotCamera ??= new THREE.PerspectiveCamera(50, mainCamera.aspect, 0.1, mainCamera.far);
      shotCamera.aspect = mainCamera.aspect; shotCamera.far = mainCamera.far;
      // a free camera (the lookdev bench): {position: [x, y, z], target: [x, y, z], fov}
      if (typeof name === 'object') {
        shotCamera.fov = name.fov ?? 35; shotCamera.position.set(...name.position); shotCamera.lookAt(...name.target); shotCamera.updateProjectionMatrix(); shotCamera.updateMatrixWorld();
        shotCamera.userData.frame = { position: shotCamera.position.clone(), target: new THREE.Vector3(...name.target) };
        post.setCamera(shotCamera);
        return shotCamera;
      }
      const box = subjects.bounds ?? ctx.world?.bounds ?? new THREE.Box3(new THREE.Vector3(-15, 0, -15), new THREE.Vector3(15, 4, 15));
      shotCamera.userData.frame = frameShot(name, shotCamera, { ...subjects, bounds: box });
      post.setCamera(shotCamera);
      post.dof(!['hero', 'four', 'action'].includes(name));
      return shotCamera;
    },
    freeze(on) { frozen = !!on; },
    /** dt: seconds; at: the local player's feet (the ground height the view is measured on). */
    update(dt = 0, at = null) {
      if (frozen) dt = 0;
      clock += dt; U.time.value = clock;
      U.windTime.value += dt * (values.wind?.speed ?? 0.1) * U.windStrength.value;
      // the slow day cycle: blend the times of day the cycle passes
      if (cfg.cycle?.on) {
        cycleClock += dt;
        const start = CYCLE.find(c => c[0] === (cfg.time ?? 'dusk'))?.[1] ?? 0;
        const p = ((cycleClock / Math.max(10, cfg.cycle.seconds ?? 300)) + start) % 1;
        let i = CYCLE.length - 1; while (i > 0 && CYCLE[i][1] > p) i--;
        const [ta, pa] = CYCLE[i], [tb, pb] = CYCLE[(i + 1) % CYCLE.length];
        const span = ((pb - pa + 1) % 1) || 1, t = sstep(((p - pa + 1) % 1) / span);
        values = blendValues(states[ta], states[tb], t);
        configure(values);
      }
      const cam = shotCamera ?? mainCamera;
      focus.copy(viewArea(cam, at?.y ?? 0));
      if (sun.castShadow) placeSun(focus, Math.min(60, viewRadius));
      // lamps nearest the view
      if (lamps.length) {
        const near = lamps.length > LAMP_SLOTS ? [...lamps].sort((a, b) => a.position.distanceToSquared(focus) - b.position.distanceToSquared(focus)).slice(0, LAMP_SLOTS) : lamps;
        for (let k = 0; k < LAMP_SLOTS; k++) {
          const l = near[k];
          if (!l) { U.lamps.array[k].set(0, -9999, 0, 1); U.lampTints.array[k].set(0, 0, 0, 0); continue; }
          U.lamps.array[k].set(l.position.x, l.position.y, l.position.z, l.radius ?? 1);
          const c = l.color ?? 'lantern';
          lampCol.set(/^#/.test(c) ? c : (values.glow?.[c] ?? values.lamps?.color ?? '#ffae5c'));
          U.lampTints.array[k].set(lampCol.r, lampCol.g, lampCol.b, l.intensity ?? 1);
        }
      }
      weather.update(dt, focus, values);
      // folio's warm-up (scenic-drive revision 2): build the render pipelines of what is in the scene ahead of drawing it
      if ((stats.frames === 2 || stats.frames === 240) && renderer.compileAsync) renderer.compileAsync(scene, cam).catch(() => {});
      // everything drawn gets the house material, whenever it appears
      if ((adoptTick++ & 7) === 0) adoptScene(scene);
    },
    render(arg) {
      if (arg?.isCamera && arg !== mainCamera) { mainCamera = arg; if (!shotCamera) post.setCamera(arg); }
      const a = performance.now();
      renderer.info.reset();
      post.render();
      const ms = performance.now() - a;
      stats.frames++; stats.cpuMs = stats.cpuMs * 0.95 + ms * 0.05;
      api?.tick();
    },
    stats() {
      const r = renderer.info.render;
      return { frames: stats.frames, renderCpuMs: +stats.cpuMs.toFixed(3), calls: r.drawCalls ?? r.calls ?? 0, triangles: r.triangles ?? 0, preset: cfg.preset, time, quality: tier.name, backend: gpuInfo(renderer).backend };
    },
    dispose() { post.dispose(); weather.dispose(); scene.remove(sun, sun.target); },
  };
  ctx.look = handle;
  const api = typeof window !== 'undefined' && opts.captureApi !== false ? installCaptureApi(ctx) : null;
  return handle;
}

function mulberry(a) { return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
