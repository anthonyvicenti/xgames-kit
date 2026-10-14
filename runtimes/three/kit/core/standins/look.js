// STAND-IN for track L's kit/look/look.js (CONTRACT §4.2), used until it lands. Plain lights, a gradient sky and fog
// from config/look.json `values` (every value is a look.* slot); no post stack. The kit picks the real module at boot
// when gf/three/kit.js lists it.
import * as THREE from 'three';

// Starting values for each preset name, so `create` has something to write until L's presets exist. They are not
// the house look: L's lookdev picks that.
export const presets = {
  'jelly-pastel': { sky: { top: '#7cc8ff', horizon: '#ffe0f0' }, fog: { color: '#ffe6f2', near: 28, far: 90 }, sun: { color: '#fff2dc', intensity: 2.4, elevation: 52, azimuth: 35 }, ambient: { sky: '#dcefff', ground: '#f5d2e4', intensity: 1.35 }, exposure: 1.05 },
  'toon-lowpoly': { sky: { top: '#4fb4ff', horizon: '#d8f2ff' }, fog: { color: '#d8f2ff', near: 30, far: 100 }, sun: { color: '#ffffff', intensity: 2.8, elevation: 60, azimuth: 20 }, ambient: { sky: '#cfe8ff', ground: '#c8d9a8', intensity: 1.1 }, exposure: 1.0 },
  'soft-stylised': { sky: { top: '#86b9e8', horizon: '#ffe7c8' }, fog: { color: '#f3e3cf', near: 25, far: 85 }, sun: { color: '#ffe2b8', intensity: 2.6, elevation: 40, azimuth: 50 }, ambient: { sky: '#d6e6f5', ground: '#e8d0b0', intensity: 1.0 }, exposure: 1.0 },
};
const TIME = { day: {}, golden: { sun: { elevation: 14, color: '#ffc58a' }, sky: { horizon: '#ffcf9e' } }, night: { sun: { intensity: 0.6, color: '#9fb4ff', elevation: 35 }, ambient: { intensity: 0.45 }, sky: { top: '#16204a', horizon: '#3a3f73' }, fog: { color: '#2a2f5a' } } };
/** The values `create` writes into config/look.json for a preset and a time of day. */
export function presetValues(id, time = 'day') {
  const p = JSON.parse(JSON.stringify(presets[id] ?? presets['jelly-pastel'])), t = TIME[time] ?? {};
  for (const [k, v] of Object.entries(t)) Object.assign(p[k], v);
  return p;
}

export function createRenderer(canvas, preset, quality) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: !!quality.antialias, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, quality.pixelRatio ?? 1));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = preset?.exposure ?? 1;
  renderer.shadowMap.enabled = !!quality.shadows;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  return renderer;
}

/** Lights, sky and fog. Returns {update(dt, focus), sun}. Every visible part is tagged with its look.* slot. */
export function applyLook(ctx, preset) {
  const v = preset ?? presetValues('jelly-pastel');
  const { scene, renderer } = ctx;
  renderer.toneMappingExposure = v.exposure ?? 1;
  scene.fog = new THREE.Fog(v.fog.color, v.fog.near, v.fog.far);
  scene.background = new THREE.Color(v.fog.color);
  const hemi = new THREE.HemisphereLight(v.ambient.sky, v.ambient.ground, v.ambient.intensity);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(v.sun.color, v.sun.intensity);
  const el = (v.sun.elevation ?? 50) * Math.PI / 180, az = (v.sun.azimuth ?? 30) * Math.PI / 180;
  const sunDir = new THREE.Vector3(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az));
  sun.castShadow = renderer.shadowMap.enabled;
  sun.shadow.mapSize.set(ctx.quality.shadowMapSize ?? 2048, ctx.quality.shadowMapSize ?? 2048);
  const span = 18; Object.assign(sun.shadow.camera, { left: -span, right: span, top: span, bottom: -span, near: 1, far: 80 });
  sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.02;
  scene.add(sun, sun.target);
  // the sky: a gradient dome from two colour slots (a kit primitive whose material is a slot, R1)
  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: { top: { value: new THREE.Color(v.sky.top) }, horizon: { value: new THREE.Color(v.sky.horizon) } },
    vertexShader: 'varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: 'uniform vec3 top; uniform vec3 horizon; varying vec3 vP; void main(){ float h = clamp(vP.y * 1.6, 0.0, 1.0); gl_FragColor = vec4(mix(horizon, top, pow(h, 0.8)), 1.0); }',
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(400, 32, 16), skyMat);
  sky.name = 'sky'; sky.renderOrder = -1; sky.frustumCulled = false;
  ctx.assets.tag(sky, 'look.sky.top');
  scene.add(sky);
  return {
    sun, hemi, sky,
    update(dt, focus) {
      if (focus) { sun.target.position.set(focus.x, 0, focus.z); sun.position.copy(sun.target.position).addScaledVector(sunDir, 40); sky.position.set(focus.x, 0, focus.z); }
    },
    render(camera) { renderer.render(scene, camera); },
  };
}

export function material(kind, { color = '#ffffff', map = null } = {}) {
  return new THREE.MeshStandardMaterial({ color, map, roughness: kind === 'glow' ? 0.4 : 0.8, emissive: kind === 'glow' ? color : '#000000', emissiveIntensity: kind === 'glow' ? 1.2 : 0 });
}
