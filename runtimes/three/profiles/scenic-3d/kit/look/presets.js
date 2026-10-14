// gf-scenic look presets (research/gf-scenic/PLAN.md §1, CONTRACT §8). Plain data, no three.js: create and the slot
// tools read them in Node. Every number and colour becomes a look.* slot through slots.js.
//
// The values are a port of folio-2025's look (Bruno Simon, MIT, brunosimon/folio-2025@41046b5: Cycles/DayCycles.js
// presets, Ligthing.js, Fog.js, Wind.js, Rendering.js bloom and cheap depth of field), retuned per preset. What each
// group means (look.js applies them):
//   light     the sun: colour, intensity, elevation and azimuth (degrees; the follow camera sits at azimuth 225°),
//             and folio's core-shadow edges (how far round a form the shade wraps)
//   shadow    folio's coloured shade: what shadowed and turned-away surfaces are multiplied by (no grey shadows)
//   bounce    folio's light bounce: surfaces facing down near the ground take the ground's colour
//   fog       folio's fog: a radial gradient on screen (colorA in the middle, colorB at the edges) that is also the sky
//             behind everything; near and far in metres from the camera. voidTop/voidBottom: below the islands,
//             things fade into colorB between these heights (the floating isles' undersides)
//   sky       a vertical tint over the fog gradient (top colour, strength) and stars (density, colour, size)
//   lamps     warm light pools round lanterns and braziers (the world's light points): colour, intensity, radius
//   glow      emissive palette for lanterns, crystals and runes (bloom picks them up): each a colour, and intensity
//   rim       a soft rim light on characters so they read against dark ground
//   character characters' own shading: their shade lifted toward white, its strength, a brightness lift (bodies keep
//             reading as their own colours in a dark look)
//   wind      folio's wind: strength, angle (degrees), speed
//   weather   rain, snow and lightning amounts (0 to 1); rain and snow are folio's rain lines
//   cycle     an optional slow day cycle through the times below (seconds per full day)
//   post      bloom (strength, radius, threshold, smoothWidth) and folio's cheap depth of field (high tier only)
//   quality   per tier: shadow map size, depth of field on/off, bloom mips, grass density, pixel ratio cap
//   times     the other times of day: each a partial override of light, shadow, fog, sky and lamps. The preset's own
//             `time` has no entry (its values are the base), so editing a base value always shows
//   palette   accent (the UI), glow, and the suggested player colours

export const TIMES = ['day', 'golden', 'dusk', 'night'];

const quality = (high = {}, low = {}) => ({
  // no pixelRatio: the kit draws the screen's real pixels within the tier's budget (gf-three kit/core/resolution.js)
  high: { shadowMapSize: 2048, shadowRadius: 3, dof: true, bloomMips: 5, grassDensity: 1, ...high },
  low: { shadowMapSize: 1024, shadowRadius: 2, dof: false, bloomMips: 2, grassDensity: 0.55, ...low },
});

// the times of day every preset can switch to (each preset keeps only the ones that are not its own)
const T = {
  day: {
    light: { color: '#fff1e2', intensity: 1.25, elevation: 52 },
    shadow: { color: '#6a5bd6' },
    fog: { colorA: '#a6e4ff', colorB: '#b9a9ff' },
    sky: { top: '#5ea6ff', strength: 0.35, stars: 0 },
    lamps: { intensity: 0.25 },
  },
  golden: {
    light: { color: '#ffc9a0', intensity: 1.2, elevation: 22 },
    shadow: { color: '#6b3f9a' },
    fog: { colorA: '#ffc39a', colorB: '#e9729a' },
    sky: { top: '#7f7bd8', strength: 0.3, stars: 0 },
    lamps: { intensity: 0.7 },
  },
  dusk: {
    light: { color: '#ffb4a0', intensity: 1.05, elevation: 30 },
    shadow: { color: '#452f8f' },
    fog: { colorA: '#2c2352', colorB: '#0a0917' },
    sky: { top: '#3a2a6a', strength: 0.25, stars: 0.45 },
    lamps: { intensity: 1.3 },
  },
  night: {
    light: { color: '#7d8cff', intensity: 0.8, elevation: 48 },
    shadow: { color: '#1f1d5c' },
    fog: { colorA: '#141a3a', colorB: '#04050c' },
    sky: { top: '#1a2050', strength: 0.25, stars: 1 },
    lamps: { intensity: 1.8 },
  },
};
const others = own => Object.fromEntries(TIMES.filter(t => t !== own).map(t => [t, JSON.parse(JSON.stringify(T[t]))]));

export const presets = {
  // the creator's reference art: a dark void, mossy stone, purple and green glow, warm lanterns
  'dusk-isle': {
    label: 'Dusk isle', describe: 'Late dusk on mossy islands over a near-black violet void: cool violet light, deep shade, glowing crystals, runes, waterfalls and warm lanterns.',
    time: 'dusk',
    renderer: { exposure: 1.0 },
    light: { color: '#d6d4f2', intensity: 0.95, elevation: 40, azimuth: 205, coreShadowLow: -0.25, coreShadowHigh: 1 },
    shadow: { color: '#363a82', strength: 1 },
    bounce: { strength: 0.5, distance: 1.5 },
    fog: { colorA: '#141631', colorB: '#03040c', near: 38, far: 130, radialStart: 0.08, radialEnd: 0.85, voidTop: -10, voidBottom: -50 },
    sky: { top: '#1d1d4d', strength: 0.3, stars: 0.6, starColor: '#e8e0ff', starSize: 1 },
    lamps: { color: '#ffc985', intensity: 1.35, radius: 5 },
    glow: { lantern: '#ffa451', crystal: '#9b6bff', rune: '#45ff9a', intensity: 2.1 },
    rim: { color: '#a9a2ff', strength: 0.5 },
    character: { shadeLift: 0.5, shadeStrength: 0.65, brightness: 1.15 },
    wind: { strength: 0.35, angle: 108, speed: 0.1 },
    weather: { rain: 0, snow: 0, lightning: 0 },
    cycle: { on: false, seconds: 300 },
    post: { bloom: { strength: 0.75, radius: 0.65, threshold: 0.8, smoothWidth: 0.6 }, dof: { start: 0.22, end: 0.52, amount: 0.0032, repeats: 20 } },
    quality: quality(),
    times: others('dusk'),
    palette: { accent: '#9d7bff', glow: '#7dff9a', players: ['#ff6b8b', '#5cc8ff', '#ffd25c', '#a77bff'] },
  },
  'night-ruins': {
    label: 'Night ruins', describe: 'Moonlit stone ruins under a starry sky; braziers and runes carry the light.',
    time: 'night',
    renderer: { exposure: 1.1 },
    light: { color: '#a9b4ff', intensity: 0.9, elevation: 50, azimuth: 160, coreShadowLow: -0.2, coreShadowHigh: 1 },
    shadow: { color: '#211f5e', strength: 1 },
    bounce: { strength: 0.45, distance: 1.5 },
    fog: { colorA: '#151c3d', colorB: '#03040b', near: 30, far: 105, radialStart: 0.05, radialEnd: 0.9, voidTop: -1, voidBottom: -24 },
    sky: { top: '#1c2458', strength: 0.3, stars: 1, starColor: '#dfe6ff', starSize: 1.1 },
    lamps: { color: '#ff9a46', intensity: 1.6, radius: 5.5 },
    glow: { lantern: '#ff9d48', crystal: '#7f8cff', rune: '#ffb347', intensity: 2.6 },
    rim: { color: '#7d8fff', strength: 0.5 },
    character: { shadeLift: 0.45, shadeStrength: 0.7, brightness: 1.1 },
    wind: { strength: 0.25, angle: 140, speed: 0.08 },
    weather: { rain: 0, snow: 0, lightning: 0 },
    cycle: { on: false, seconds: 300 },
    post: { bloom: { strength: 0.55, radius: 0.6, threshold: 0.85, smoothWidth: 0.6 }, dof: { start: 0.22, end: 0.52, amount: 0.0032, repeats: 20 } },
    quality: quality(),
    times: others('night'),
    palette: { accent: '#ff9a4a', glow: '#ffb35c', players: ['#ff6b6b', '#5cc8ff', '#ffd25c', '#7dff9a'] },
  },
  'golden-meadow': {
    label: 'Golden meadow', describe: 'Low golden sun over long grass and leafy trees; warm haze and lilac shade.',
    time: 'golden',
    renderer: { exposure: 1.0 },
    light: { color: '#ffd0a2', intensity: 1.22, elevation: 24, azimuth: 240, coreShadowLow: -0.25, coreShadowHigh: 1 },
    shadow: { color: '#7a4c9e', strength: 1 },
    bounce: { strength: 0.7, distance: 1.5 },
    fog: { colorA: '#ffd2a3', colorB: '#f08f8a', near: 40, far: 150, radialStart: 0.1, radialEnd: 0.9, voidTop: -1, voidBottom: -30 },
    sky: { top: '#a58cf0', strength: 0.3, stars: 0, starColor: '#ffffff', starSize: 1 },
    lamps: { color: '#ffc27a', intensity: 0.6, radius: 6 },
    glow: { lantern: '#ffc070', crystal: '#c49bff', rune: '#8dffb8', intensity: 1.8 },
    rim: { color: '#ffd9b0', strength: 0.3 },
    character: { shadeLift: 0.35, shadeStrength: 0.75, brightness: 1.0 },
    wind: { strength: 0.5, angle: 100, speed: 0.12 },
    weather: { rain: 0, snow: 0, lightning: 0 },
    cycle: { on: false, seconds: 300 },
    post: { bloom: { strength: 0.3, radius: 0.5, threshold: 0.95, smoothWidth: 0.6 }, dof: { start: 0.2, end: 0.5, amount: 0.0036, repeats: 20 } },
    quality: quality(),
    times: others('golden'),
    palette: { accent: '#ff8a3d', glow: '#ffe08a', players: ['#ff5d6c', '#3fa9f5', '#ffc93c', '#8c6cff'] },
  },
  'storm-coast': {
    label: 'Storm coast', describe: 'Cold storm light on a windswept coast: rain lines, lightning, slate shade.',
    time: 'day',
    renderer: { exposure: 1.0 },
    light: { color: '#d9e0ec', intensity: 0.95, elevation: 42, azimuth: 200, coreShadowLow: -0.3, coreShadowHigh: 1 },
    shadow: { color: '#39415e', strength: 1 },
    bounce: { strength: 0.5, distance: 1.5 },
    fog: { colorA: '#6f7b8c', colorB: '#262c3a', near: 28, far: 105, radialStart: 0.05, radialEnd: 0.95, voidTop: -1, voidBottom: -24 },
    sky: { top: '#3c4558', strength: 0.35, stars: 0, starColor: '#ffffff', starSize: 1 },
    lamps: { color: '#ffd08a', intensity: 1.1, radius: 6 },
    glow: { lantern: '#ffd08a', crystal: '#7fd8ff', rune: '#9cffe0', intensity: 2.0 },
    rim: { color: '#bfe2ff', strength: 0.4 },
    character: { shadeLift: 0.4, shadeStrength: 0.7, brightness: 1.05 },
    wind: { strength: 0.9, angle: 120, speed: 0.22 },
    weather: { rain: 0.8, snow: 0, lightning: 0.6 },
    cycle: { on: false, seconds: 300 },
    post: { bloom: { strength: 0.3, radius: 0.5, threshold: 0.95, smoothWidth: 0.6 }, dof: { start: 0.22, end: 0.52, amount: 0.003, repeats: 20 } },
    quality: quality(),
    times: others('day'),
    palette: { accent: '#5cc8ff', glow: '#bfe8ff', players: ['#ff6b6b', '#5cc8ff', '#ffd25c', '#7dff9a'] },
  },
  'clear-day': {
    label: 'Clear day', describe: 'Bright midday sun, a cyan-to-lilac sky, crisp coloured shade (folio-2025\'s day).',
    time: 'day',
    renderer: { exposure: 1.0 },
    light: { color: '#ffeedd', intensity: 1.2, elevation: 54, azimuth: 222, coreShadowLow: -0.25, coreShadowHigh: 1 },
    shadow: { color: '#6d5aff', strength: 1 },
    bounce: { strength: 0.7, distance: 1.5 },
    fog: { colorA: '#9fe8ff', colorB: '#b4a3ff', near: 45, far: 170, radialStart: 0.1, radialEnd: 0.9, voidTop: -1, voidBottom: -34 },
    sky: { top: '#5aa2ff', strength: 0.35, stars: 0, starColor: '#ffffff', starSize: 1 },
    lamps: { color: '#ffd08a', intensity: 0.2, radius: 5 },
    glow: { lantern: '#ffc070', crystal: '#b28cff', rune: '#7dffb0', intensity: 1.6 },
    rim: { color: '#ffffff', strength: 0.25 },
    character: { shadeLift: 0.3, shadeStrength: 0.8, brightness: 1.0 },
    wind: { strength: 0.4, angle: 108, speed: 0.1 },
    weather: { rain: 0, snow: 0, lightning: 0 },
    cycle: { on: false, seconds: 300 },
    post: { bloom: { strength: 0.22, radius: 0.45, threshold: 1, smoothWidth: 0.6 }, dof: { start: 0.2, end: 0.5, amount: 0.003, repeats: 20 } },
    quality: quality(),
    times: others('day'),
    palette: { accent: '#ff7a59', glow: '#fff1a8', players: ['#ff5d6c', '#3fa9f5', '#ffc93c', '#8c6cff'] },
  },
};

/** A preset's values (a deep copy), or null for an unknown id. */
export function presetValues(id) {
  const p = presets[id];
  return p ? JSON.parse(JSON.stringify(p)) : null;
}

const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
/** a deep merge (b over a), new objects */
export function deepMerge(a, b) {
  if (!isObj(a) || !isObj(b)) return JSON.parse(JSON.stringify(b === undefined ? a : b));
  const out = JSON.parse(JSON.stringify(a));
  for (const [k, v] of Object.entries(b)) out[k] = isObj(v) && isObj(out[k]) ? deepMerge(out[k], v) : JSON.parse(JSON.stringify(v));
  return out;
}

/**
 * The values in force for a config/look.json (or a preset) at a time of day: the base, with that time's override
 * merged over it when the time is not the preset's own. Pure (Node and browser).
 */
export function resolveLook(cfg, time = cfg?.time) {
  const base = isObj(cfg) ? cfg : presetValues('dusk-isle');
  const own = presets[base.preset]?.time ?? base.time;
  const t = time && time !== own ? base.times?.[time] ?? null : null;
  const out = t ? deepMerge(base, t) : deepMerge(base, {});
  out.time = time ?? own;
  return out;
}
