// gf-forge's look (CONTRACT §8 forge), vendored into a game as gf/forge/look.js. Pure: Node imports it (create writes
// config/look.json from `lookConfig`, tools/slots.mjs declares the slots from `slotsFor`) and the boot packs it for
// the core (`pack`). Every number and colour is a `look.*` slot (R1–R5).
//
// Track R's look stack (research/rust-engine/PLAN.md §4; the numbers from research/rust-engine/feel-targets.md "Look
// targets"):
//   sky        a gradient from the horizon (the fog's colour) to the zenith, faint stars, and the moon: a disc where the
//              moon light comes from, bright enough to bloom
//   fog        exponential (`density`) over wave 0's linear near/far ramp
//   ambient, moon (a directional light with one shadow map: `shadow.*`), torch (every fire light the world sets: colour,
//              brightness, reach and flicker)
//   bloom      extract, two blurs at a quarter size, added back (`bloom.*`)
//   tone       the curve (aces, reinhard or clamp), exposure, contrast, saturation, gamma, vignette
//   retro      square texels, grain, ordered dither, colour steps, vertex snap; with renderScale, pixelated and
//              `detail` (the scene's width cap): the measured target is full resolution with quantised texels and
//              grain, not a low resolution
//   aa, lights.max, hit (a hit's white body flash), fp.fov (the first-person layer), fire (embers and smoke over
//              every fire), weather.ash, emissive, particles (each kind's numbers: research/gf-forge/core/forge-render
//              particles.rs)
//
// Wave 2 (track L1; research/gf-forge/lookdev/README.md): the retro texel densities (retro.density, models, hand, crisp),
// a fire's pool (lights.falloff) and shadows (fire.shadows…), the adapting exposure (tone.auto, key, autoMin, autoMax,
// adapt), sky.haze, tracer.*, backdrop.* and pieces.*. `moonlit-ruins` was retuned against the look targets' exposure
// (mean luma 34–48): exposure 1 with the exposure adapting to key 41, more contrast and bloom, fires at the top of
// their measured range, and a sky and fog set so that through this tone curve they read as the reference's frames do
// (the sky about #1e252d, the far fog about #3c4143) rather than as its fog uniform's raw value.
//
// Wave 3 (track A2; values only): `moonlit-ruins` for a cooler place, with five fires in the arena where fourteen
// stood. The moon stands behind the first look's right (dir 0.72, 0.48, 0.5: it lights the weapon in hand and what a
// player first sees) at 1.55 times its measured strength over an ambient of 1.12, so moonlit stone, not fire, carries
// the picture's brightest percent; fires at 9.2 with a 9.5 m reach (11 m before); more bloom from a lower threshold (a
// small fire keeps its halo) and a little more colour; the backdrop's fog 1.2 (broad trees layer into the haze); the
// eyes adapt up to 2.2 (a wall in the dark is still read).
//
// Four presets (the fourth, `gaslit-street`, is wave 5's, below): `moonlit-ruins` (the measured moonlit ruin: moon (0.48, 0.60, 0.72), ambient (0.086, 0.111, 0.128),
// fires (1.00, 0.34, 0.07) r 11 m at 7.8–9.6, fog (0.038, 0.064, 0.078) density 0.019), `ember-crypt` (wave 0's crypt,
// now from the measured fire-and-ash area: fog (0.135, 0.025, 0.013) density 0.017, a warm sun, red-orange fires) and
// `ash-storm` (ours: a dim sun through falling ash).
//
// Wave 5 (track T; values only): `gaslit-street`, the town street's look (gf/forge/town.js). A world's lights are its
// gas lamps, so `torch` is gas light: yellower than a brazier (#ffb469), nearly steady (flicker 0.035), with an 11 m
// reach from a lantern 2.8 m up and a wider pool (lights.falloff 0.2), and `fire` sheds no embers and no smoke. The
// moon stands high behind the first look's right (dir 0.42, 0.62, 0.66): it lights the house fronts a player first
// faces and the west side of the street, and the east side's houses lay their shadows a few metres over the cobbles.
// Fog 0.024 (the ruin's is 0.019) in a bluer slate, so the far end of the street thins into it.
//
// The pack the core reads (forge-web set_look): wave 0's 22 floats, then the extension: 7301, version 1, the count and
// PACK_EXT's values in order, the kind count, PACK_KIND's count and each kind's values in KIND_IDS order. forge-render
// look.rs names the same fields in the same order (a cargo test reads this file).

const kind = (color, alpha, glow, count, life, size, speed, spread, gravity, drag, additive, stretch, delay, bounce, spin) => ({ color, alpha, glow, count, life, size, speed, spread, gravity, drag, additive, stretch, delay, bounce, spin });
/** The particle kinds' default numbers (feel-targets: the barrel smoke after ~130 ms lingering ~0.3 s, a few orange
 *  sparks, kills into dust and bone chips spreading ~0.4 s, ~400 ambient particles over the fires). */
export const PARTICLES = {
  smoke: kind('#e6e3dd', 0.3, 1, 3, 0.45, [0.1, 0.45], 0.35, 0.6, -0.4, 2, 0, 0, 0.13, 0, 0.6),
  sparks: kind('#ffc276', 1, 3, 8, 0.25, [0.035, 0.012], 6, 0.7, 9.8, 1.5, 1, 0.035, 0, 0.3, 0),
  embers: kind('#ffad59', 1, 2.5, 1, 2.2, [0.035, 0.012], 0.6, 0.5, -0.9, 0.6, 1, 0, 0, 0, 0),
  dust: kind('#e7e2d8', 0.45, 1, 10, 0.8, [0.18, 0.6], 2.2, 1.4, -0.3, 3, 0, 0, 0, 0, 0.4),
  bone: kind('#f1ede2', 1, 1, 14, 0.9, [0.06, 0.05], 4.5, 1.1, 12, 0.4, 0, 0, 0, 0.35, 8),
  blood: kind('#9a1b1b', 0.65, 1, 8, 0.55, [0.12, 0.45], 1.6, 1, 1, 2.5, 0, 0, 0, 0, 0.5),
  muzzle: kind('#ffeec4', 1, 4, 1, 0.05, [0.28, 0.18], 0, 0, 0, 0, 1, 0, 0, 0, 0),
  impact: kind('#ffdbaa', 1, 2.5, 1, 0.08, [0.08, 0.45], 0, 0, 0, 0, 1, 0, 0, 0, 0),
  orb: kind('#59ffb4', 1, 3, 1, 0.25, [0.35, 0.15], 0, 0, 0, 0, 1, 0, 0, 0, 0),
  ash: kind('#b4adaa', 0.7, 1, 1, 6, [0.025, 0.02], 0.3, 1, 0.25, 0.8, 0, 0, 0, 0, 2),
};
export const KIND_IDS = ['smoke', 'sparks', 'embers', 'dust', 'bone', 'blood', 'muzzle', 'impact', 'orb', 'ash'];
const particles = (over = {}) => ({ budget: 2048, ...Object.fromEntries(KIND_IDS.map(k => [k, { ...PARTICLES[k], ...(over[k] ?? {}) }])) });

export const presets = {
  'moonlit-ruins': {
    sky: { zenith: '#262d36', horizon: '#42494d', stars: 0.6, haze: 0.7 },
    fog: { color: '#42494d', near: 0, far: 0, density: 0.019 },
    ambient: { color: '#535e64', intensity: 1.12 },
    moon: { color: '#b8ccdd', intensity: 1.55, dir: [0.72, 0.48, 0.5], disc: '#e9eef5', size: 2.8, brightness: 3.4, glow: 0.9 },
    torch: { color: '#ff9e4b', intensity: 9.2, range: 9.5, flicker: 0.09 },
    shadow: { size: 2048, distance: 40, strength: 0.85, bias: 1.5, softness: 1 },
    bloom: { intensity: 1.2, threshold: 0.8, knee: 0.6, radius: 1.6 },
    tone: { curve: 'aces', contrast: 1.14, saturation: 0.9, gamma: 1, vignette: 0.35, auto: 1, key: 41, autoMin: 0.3, autoMax: 2.2, adapt: 0.3 },
    retro: { texels: true, density: 16, models: 48, hand: 160, crisp: 0.5, grain: 0.035, dither: 1, steps: 0, snap: 0 },
    exposure: 1,
    renderScale: 1,
    pixelated: false,
    detail: 1440,
    aa: true,
    lights: { max: 32, falloff: 0.16 },
    hit: { color: '#ffffff', time: 0.05, amount: 1 },
    fp: { fov: 60 },
    fire: { embers: 14, smoke: 5, shadows: 3, shadowSize: 256, shadowFaces: 4, shadowStrength: 0.85 },
    tracer: { width: 0.02, length: 3, speed: 220, glow: 6 },
    backdrop: { distance: 0, fog: 1.2 },
    pieces: { shadow: 14, distance: 70 },
    weather: { ash: 0 },
    emissive: 1,
    particles: particles(),
  },
  'ember-crypt': {
    sky: { zenith: '#120705', horizon: '#672c1e', stars: 0 },
    fog: { color: '#672c1e', near: 6, far: 30, density: 0.017 },
    ambient: { color: '#655f6b', intensity: 0.5 },
    moon: { color: '#e7b59c', intensity: 0.3, dir: [0.35, 1, 0.25], disc: '#ffd2b0', size: 0, brightness: 4, glow: 0 },
    torch: { color: '#ff9548', intensity: 7, range: 9, flicker: 0.12 },
    shadow: { size: 2048, distance: 24, strength: 0.9, bias: 1.5, softness: 1 },
    bloom: { intensity: 0.6, threshold: 0.9, knee: 0.6, radius: 1.5 },
    tone: { curve: 'aces', contrast: 1.03, saturation: 0.95, gamma: 1, vignette: 0.4, auto: 1, key: 41, autoMin: 0.3, autoMax: 1.6, adapt: 0.3 },
    retro: { texels: true, density: 16, models: 48, hand: 160, crisp: 0.5, grain: 0.03, dither: 1, steps: 0, snap: 0 },
    exposure: 0.8,
    renderScale: 1,
    pixelated: false,
    detail: 1440,
    aa: true,
    lights: { max: 32, falloff: 0 },
    hit: { color: '#ffffff', time: 0.05, amount: 1 },
    fp: { fov: 60 },
    fire: { embers: 10, smoke: 3, shadows: 2, shadowSize: 256, shadowFaces: 4, shadowStrength: 0.85 },
    tracer: { width: 0.02, length: 3, speed: 220, glow: 6 },
    backdrop: { distance: 0, fog: 1.4 },
    pieces: { shadow: 14, distance: 70 },
    weather: { ash: 0 },
    emissive: 1,
    particles: particles(),
  },
  'ash-storm': {
    sky: { zenith: '#2a2420', horizon: '#5a4a3e', stars: 0 },
    fog: { color: '#4a3c34', near: 0, far: 0, density: 0.045 },
    ambient: { color: '#6a5a50', intensity: 0.9 },
    moon: { color: '#ffb27a', intensity: 0.55, dir: [-0.4, 0.35, -0.85], disc: '#ffcf9a', size: 2.6, brightness: 3, glow: 1.6 },
    torch: { color: '#ff7a33', intensity: 9, range: 10, flicker: 0.14 },
    shadow: { size: 2048, distance: 35, strength: 0.6, bias: 1.5, softness: 2 },
    bloom: { intensity: 0.5, threshold: 1, knee: 0.6, radius: 1.8 },
    tone: { curve: 'aces', contrast: 0.98, saturation: 0.8, gamma: 1, vignette: 0.4, auto: 1, key: 41, autoMin: 0.3, autoMax: 1.6, adapt: 0.3 },
    retro: { texels: true, density: 16, models: 48, hand: 160, crisp: 0.5, grain: 0.06, dither: 1, steps: 0, snap: 0 },
    exposure: 1.2,
    renderScale: 1,
    pixelated: false,
    detail: 1440,
    aa: true,
    lights: { max: 32, falloff: 0 },
    hit: { color: '#ffffff', time: 0.05, amount: 1 },
    fp: { fov: 60 },
    fire: { embers: 22, smoke: 8, shadows: 2, shadowSize: 256, shadowFaces: 4, shadowStrength: 0.7 },
    tracer: { width: 0.02, length: 3, speed: 220, glow: 6 },
    backdrop: { distance: 0, fog: 1.3 },
    pieces: { shadow: 14, distance: 70 },
    weather: { ash: 140 },
    emissive: 1,
    particles: particles({ embers: { glow: 3 } }),
  },
  // wave 5 (track T): the town street's look. Values only: the same packed fields as the others.
  'gaslit-street': {
    sky: { zenith: '#1c222d', horizon: '#3a4250', stars: 0.5, haze: 0.75 },
    fog: { color: '#3a4250', near: 0, far: 0, density: 0.024 },
    ambient: { color: '#566170', intensity: 1.18 },
    moon: { color: '#b4c6de', intensity: 1.45, dir: [0.42, 0.62, 0.66], disc: '#e9eef5', size: 2.8, brightness: 3.4, glow: 0.9 },
    torch: { color: '#ffb469', intensity: 9.6, range: 11, flicker: 0.035 },
    shadow: { size: 2048, distance: 44, strength: 0.85, bias: 1.5, softness: 1 },
    bloom: { intensity: 1.25, threshold: 0.8, knee: 0.6, radius: 1.7 },
    tone: { curve: 'aces', contrast: 1.12, saturation: 0.95, gamma: 1, vignette: 0.35, auto: 1, key: 41, autoMin: 0.3, autoMax: 2.2, adapt: 0.3 },
    retro: { texels: true, density: 16, models: 48, hand: 160, crisp: 0.5, grain: 0.035, dither: 1, steps: 0, snap: 0 },
    exposure: 1,
    renderScale: 1,
    pixelated: false,
    detail: 1440,
    aa: true,
    lights: { max: 32, falloff: 0.2 },
    hit: { color: '#ffffff', time: 0.05, amount: 1 },
    fp: { fov: 60 },
    fire: { embers: 0, smoke: 0, shadows: 3, shadowSize: 256, shadowFaces: 4, shadowStrength: 0.8 },
    tracer: { width: 0.02, length: 3, speed: 220, glow: 6 },
    backdrop: { distance: 0, fog: 1.25 },
    pieces: { shadow: 14, distance: 70 },
    weather: { ash: 0 },
    emissive: 1,
    particles: particles(),
  },
};
export const DEFAULT = 'ember-crypt';
const clone = v => JSON.parse(JSON.stringify(v));

/** What the quality tiers lower (never raise): the shadow map, the lights a frame shades, AA, the particle budget,
 *  the fires that cast a shadow and the faces drawn a frame, and how far loose pieces and the backdrop are drawn. */
export const TIERS = {
  low: { shadowSize: 1024, softness: 0.75, lights: 12, aa: false, budget: 768, fireShadows: 0, piecesShadow: 6, piecesDistance: 40, backdropDistance: 90 },
  medium: { shadowSize: 1536, lights: 20, aa: true, budget: 1536, fireShadows: 2, fireFaces: 2, piecesShadow: 10 },
  high: {},
};

/**
 * What the build that draws on a device changes in the picture (wave 3, track W). The quality tiers above are a
 * choice; these are what a device can do, found by the core when it starts (gf/forge/render.js `caps()`, and
 * window.__game.forge.state().render: `backend`, `hdr`, `tier`). Nothing here is packed: the core applies it itself.
 *
 *   full  the WebGPU build, and the WebGL2 build on a device with float render targets (EXT_color_buffer_float or
 *         EXT_color_buffer_half_float: nearly every WebGL2 device). The same passes, the same shaders (translated
 *         from the same WGSL), every look value honoured: the moon's shadow map, the fires' shadows, the HDR scene,
 *         bloom, the eye's adaptation, the retro texels, grain and colour steps, FXAA.
 *   ldr   the WebGL2 build on a device without float render targets ("the 8-bit scene"). The scene target is 8 bits a
 *         channel, so the exposure and the tone curve are applied as each pixel is drawn. Not drawn: bloom
 *         (`look.bloom.*` is ignored: nothing glows around a fire or the moon). Kept: the eye's adaptation (its
 *         factor in an 8-bit texel), shadows, fires, texels, grain, colour steps. Light that would have been brighter
 *         than white before the tone curve blends as white (fire over smoke, flashes). `?gf-forge-scene=8bit` draws
 *         it on any device, with either build, for QA.
 *
 * What differs between the two builds whatever the tier (the reasons are WebGL2's): the vertex capture verify's check
 * 19 reads needs a 32-bit float target (`caps().floatCapture`), and a lost device is a lost and restored WebGL2
 * context (gf/forge/host.js). How close the two builds' pictures are is measured, not promised: verify check 32
 * (research/gf-three/tools/lib/forge-webgl-check.mjs) holds them together on the look shots.
 */
export const BACKEND_TIERS = {
  full: { bloom: true, hdr: true, adapts: true, about: 'every pass and every look value, on WebGPU and on WebGL2 with float render targets' },
  ldr: { bloom: false, hdr: false, adapts: true, about: 'WebGL2 without float render targets: an 8-bit scene toned as it is drawn; no bloom' },
};

/** A preset's values (unknown ids get the default's). */
export function presetValues(id) { return clone(presets[id] ?? presets[DEFAULT]); }
/** config/look.json: the preset's id and every value. */
export function lookConfig(id) { return { preset: id in presets ? id : DEFAULT, ...presetValues(id) }; }

const L = 'config/look.json';
const num01 = { min: 0, max: 1 };
// [path, label, main rank or 0 (advanced), constraints (and type), description]
const SLOTS = [
  ['sky', 'Sky colour', 72, null, 'What shows past the walls, and the top of the dark'],
  ['sky/zenith', 'Sky overhead', 72, null, 'The sky straight up'],
  ['sky/horizon', 'Sky at the horizon', 71, null, 'The sky low down (keep it near the fog colour so far things meet it)'],
  ['sky/stars', 'Stars', 0, { min: 0, max: 4 }],
  ['sky/haze', 'Haze at the horizon', 0, num01, 'How high the horizon colour reaches up the sky (far things fade into it and stand out as silhouettes)'],
  ['fog/color', 'Fog colour', 70, null, 'Far things fade into it (keep it near the sky)'],
  ['fog/near', 'Fog starts', 0, { min: 0, max: 60, unit: 'm' }],
  ['fog/far', 'Fog is full', 66, { min: 0, max: 200, unit: 'm' }, 'Past this distance everything is fog (0: no linear ramp)'],
  ['fog/density', 'Fog thickness', 66, { min: 0, max: 0.3 }, 'Exponential fog: 0.019 leaves 40% clear at 50 m'],
  ['ambient/color', 'Ambient light colour', 0, null],
  ['ambient/intensity', 'Ambient light', 64, { min: 0, max: 3 }, 'How bright the shadows are'],
  ['moon/color', 'Moonlight colour', 0, null],
  ['moon/intensity', 'Moonlight', 63, { min: 0, max: 4 }],
  ['moon/dir', 'Moonlight direction', 0, null, '[x, y, z] towards the moon (the moon is drawn there)'],
  ['moon/disc', 'Moon colour', 0, null],
  ['moon/size', 'Moon size', 0, { min: 0, max: 20, unit: '°' }, 'The disc\'s angular radius (0: no moon in the sky)'],
  ['moon/brightness', 'Moon brightness', 0, { min: 0, max: 50 }, 'Over 1 it glows (bloom)'],
  ['moon/glow', 'Moon halo', 0, { min: 0, max: 8 }],
  ['torch/color', 'Torch light colour', 68, null, 'The fire\'s light on the walls'],
  ['torch/intensity', 'Torch brightness', 67, { min: 0, max: 40 }],
  ['torch/range', 'Torch reach', 0, { min: 1, max: 40, unit: 'm' }],
  ['torch/flicker', 'Torch flicker', 0, num01, '0 steady, 1 wild'],
  ['shadow/size', 'Shadow detail', 0, { type: 'integer', min: 0, max: 4096, unit: 'px' }, 'The moon\'s shadow map (0: no shadows)'],
  ['shadow/distance', 'Shadow reach', 0, { min: 2, max: 400, unit: 'm' }],
  ['shadow/strength', 'Shadow darkness', 0, num01],
  ['shadow/bias', 'Shadow offset', 0, { min: 0, max: 16 }],
  ['shadow/softness', 'Shadow softness', 0, { min: 0, max: 4 }],
  ['bloom/intensity', 'Glow (bloom)', 61, { min: 0, max: 8 }, 'Halos around fires, flashes and the moon (0: none)'],
  ['bloom/threshold', 'Glow threshold', 0, { min: 0, max: 64 }],
  ['bloom/knee', 'Glow softness', 0, { min: 0, max: 4 }],
  ['bloom/radius', 'Glow width', 0, { min: 0.1, max: 4 }],
  ['tone/curve', 'Tone curve', 0, { type: 'enum', options: ['aces', 'reinhard', 'clamp'] }],
  ['tone/contrast', 'Contrast', 0, { min: 0.2, max: 3 }],
  ['tone/saturation', 'Colour', 60, { min: 0, max: 3 }, 'Saturation: 0 grey, 1 as drawn'],
  ['tone/gamma', 'Gamma', 0, { min: 0.3, max: 3 }],
  ['tone/vignette', 'Dark corners', 0, { min: 0, max: 2 }],
  ['tone/auto', 'Eyes adapt', 0, num01, 'The exposure follows the picture so its mean brightness stays at the key below (0: off, the exposure as set; 1: all the way)'],
  ['tone/key', 'Brightness key', 0, { min: 1, max: 254 }, 'The mean brightness the eyes adapt to, out of 255 (a dark night picture: 34 to 48)'],
  ['tone/autoMin', 'Adapt down at most', 0, { min: 0.01, max: 1 }, 'The least the adapting may multiply the exposure by'],
  ['tone/autoMax', 'Adapt up at most', 0, { min: 1, max: 100 }, 'The most the adapting may multiply the exposure by'],
  ['tone/adapt', 'Adapting time', 0, { min: 0, max: 30, unit: 's' }, 'To a brighter picture; to a darker one it takes four times as long'],
  ['retro/texels', 'Retro texture and grain', 59, null, 'Textures are drawn as square texels at the densities below, with fine grain over the picture; off: textures filtered smooth, no grain'],
  ['retro/density', 'Texels per metre (ground and walls)', 57, { min: 0, max: 256, unit: '/m' }, 'How many square texels a metre of ground or wall shows (0: the picture\'s own pixels)'],
  ['retro/models', 'Texels per metre (props and bodies)', 0, { min: 0, max: 1024, unit: '/m' }, 'The same for anything with its own texture layout: props, bodies, held weapons (0: the picture\'s own pixels)'],
  ['retro/hand', 'Texels per metre (weapon in hand)', 0, { min: 0, max: 4096, unit: '/m' }, 'The same for the first-person arms and weapon, which fill the screen (0: the picture\'s own pixels)'],
  ['retro/crisp', 'Texel grit', 0, num01, '0: each texel is the average of the picture under it (soft); 1: one pixel of the picture (gritty)'],
  ['retro/grain', 'Film grain', 58, num01],
  ['retro/dither', 'Dither', 0, { min: 0, max: 4 }],
  ['retro/steps', 'Colour steps', 0, { type: 'integer', min: 0, max: 256 }, 'Levels per colour channel (0: off; 16–32 reads retro)'],
  ['retro/snap', 'Wobbly vertices', 0, { type: 'integer', min: 0, max: 4096 }, 'Vertices snap to a screen this many lines tall (0: off; 240 reads old console)'],
  ['exposure', 'Exposure', 0, { min: 0.2, max: 4 }],
  ['renderScale', 'Render scale', 62, { min: 0.25, max: 1 }, 'Under 1 draws the scene at fewer pixels and scales it up (a chunkier, retro look; also faster)'],
  ['pixelated', 'Pixelated upscale', 0, null, 'With a render scale under 1: hard pixel edges instead of a smooth stretch'],
  ['detail', 'Scene detail', 0, { type: 'integer', min: 0, max: 8192, unit: 'px' }, 'The scene\'s widest drawing in pixels (0: the screen\'s own)'],
  ['aa', 'Smooth edges', 0, null, 'Edge anti-aliasing'],
  ['lights/max', 'Lights at once', 0, { type: 'integer', min: 0, max: 32 }],
  ['lights/falloff', 'Fire pool width', 0, { min: 0, max: 2 }, 'How wide a fire\'s bright pool is, as a share of its reach (0: a 1 m core, tight; 0.16: a pool most of the way out; short lights such as a muzzle flash keep the 1 m core)'],
  ['hit/color', 'Hit flash colour', 0, null],
  ['hit/time', 'Hit flash length', 0, { min: 0, max: 1, unit: 's' }],
  ['hit/amount', 'Hit flash strength', 0, num01, '0: no flash when a body is hit'],
  ['fp/fov', 'Weapon field of view', 0, { min: 20, max: 120, unit: '°' }, 'The first-person arms and weapon'],
  ['fire/embers', 'Embers per fire', 0, { min: 0, max: 200 }, 'A second, rising from every fire'],
  ['fire/smoke', 'Smoke per fire', 0, { min: 0, max: 100 }],
  ['fire/shadows', 'Fires that cast shadows', 0, { type: 'integer', min: 0, max: 4 }, 'The nearest fires throw shadows (0: none; each costs six small shadow faces)'],
  ['fire/shadowSize', 'Fire shadow detail', 0, { type: 'integer', min: 32, max: 512, unit: 'px' }],
  ['fire/shadowFaces', 'Fire shadow faces per frame', 0, { type: 'integer', min: 1, max: 24 }, 'How many of the faces are drawn again each frame (fewer: cheaper, and a moving shadow lags)'],
  ['fire/shadowStrength', 'Fire shadow darkness', 0, num01],
  ['tracer/width', 'Tracer width', 0, { min: 0, max: 1, unit: 'm' }],
  ['tracer/length', 'Tracer length', 0, { min: 0.05, max: 100, unit: 'm' }],
  ['tracer/speed', 'Tracer speed', 0, { min: 1, max: 5000, unit: 'm/s' }, 'How fast a streak crosses a shot\'s line (the shot itself has already landed)'],
  ['tracer/glow', 'Tracer brightness', 0, { min: 0, max: 64 }, 'Over 1 it glows (bloom)'],
  ['backdrop/distance', 'Backdrop draw distance', 0, { min: 0, max: 10000, unit: 'm' }, 'What stands beyond the walls is not drawn past this (0: always drawn)'],
  ['backdrop/fog', 'Backdrop fog', 0, { min: 0, max: 16 }, 'Fog on what stands beyond the walls, as if it were this many times farther: over 1 it fades to silhouettes'],
  ['pieces/shadow', 'Debris shadow reach', 0, { min: 0, max: 10000, unit: 'm' }, 'Loose pieces farther than this cast no shadow (0: all do)'],
  ['pieces/distance', 'Debris draw distance', 0, { min: 0, max: 10000, unit: 'm' }, 'Loose pieces farther than this are not drawn (0: all are)'],
  ['weather/ash', 'Falling ash', 0, { min: 0, max: 2000 }, 'Flakes a second around you'],
  ['emissive', 'Glow of eyes and coals', 0, { min: 0, max: 16 }],
  ['particles/budget', 'Particles at most', 0, { type: 'integer', min: 0, max: 4096 }],
  ...KIND_IDS.map(k => [`particles/${k}`, `Particles: ${k}`, 0, { type: 'json' }, `{color, alpha, glow, count, life (s), size [start, end] (m), speed (m/s), spread (rad), gravity, drag, additive (0/1), stretch (s), delay (s), bounce, spin}`]),
];
const kebab = s => s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
const at = (doc, path) => path.split('/').reduce((v, k) => (v == null ? undefined : v[k]), doc);

/** The look's slots (CONTRACT §2.2): every value in config/look.json. */
export function slotsFor(cfg) {
  const look = cfg?.look ?? cfg ?? {};
  const out = [];
  for (const [path, label, rank, cons, description] of SLOTS) {
    const v = at(look, path);
    if (v === undefined || (v && typeof v === 'object' && !Array.isArray(v) && cons?.type !== 'json')) continue;
    const { type: forced, ...constraints } = cons ?? {};
    const type = forced ?? (typeof v === 'boolean' ? 'boolean' : typeof v === 'number' ? 'number' : Array.isArray(v) ? 'json' : 'color');
    out.push({ id: `look.${path.split('/').map(kebab).join('.')}`, group: 'look', label, type, source: { file: L, pointer: `/${path}` },
      ...(Object.keys(constraints).length ? { constraints } : {}), ...(description ? { description } : {}), tier: rank ? 'main' : 'advanced', facet: 'look', rank: rank || 12 });
  }
  return out;
}

// sRGB hex → linear
const lin = hex => { const n = parseInt(String(hex ?? '#000000').replace('#', '').padEnd(6, '0').slice(0, 6), 16) || 0; return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(c => { const s = c / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }); };
const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);

/** The extension's fields in pack order (forge-render look.rs EXT_FIELDS). */
export const PACK_EXT = ['fog.density', 'sky.zenith.r', 'sky.zenith.g', 'sky.zenith.b', 'sky.horizon.r', 'sky.horizon.g', 'sky.horizon.b', 'sky.stars',
  'moon.disc.r', 'moon.disc.g', 'moon.disc.b', 'moon.size', 'moon.brightness', 'moon.glow',
  'shadow.size', 'shadow.distance', 'shadow.strength', 'shadow.bias',
  'bloom.intensity', 'bloom.threshold', 'bloom.knee', 'bloom.radius',
  'tone.curve', 'tone.contrast', 'tone.saturation', 'tone.gamma',
  'retro.texels', 'retro.grain', 'retro.dither', 'retro.steps', 'retro.snap', 'detail', 'aa', 'lights.max',
  'hit.color.r', 'hit.color.g', 'hit.color.b', 'hit.time', 'hit.amount', 'fp.fov', 'fire.embers', 'fire.smoke', 'weather.ash', 'particles.budget', 'emissive', 'vignette', 'shadow.softness',
  // wave 2 (track L1), appended: a look.json without them packs the wave 1 picture (each picture at its own texels, tight lights)
  'retro.density', 'lights.falloff', 'tracer.width', 'tracer.length', 'tracer.speed', 'tracer.glow', 'backdrop.distance', 'backdrop.fog', 'pieces.shadow', 'pieces.distance',
  'fire.shadows', 'fire.shadowSize', 'fire.shadowFaces', 'fire.shadowStrength', 'retro.models', 'retro.hand', 'retro.crisp', 'sky.haze',
  'tone.auto', 'tone.key', 'tone.autoMin', 'tone.autoMax', 'tone.adapt'];
/** A particle kind's fields in pack order (forge-render look.rs KIND_FIELDS). */
export const PACK_KIND = ['color.r', 'color.g', 'color.b', 'alpha', 'glow', 'count', 'life', 'size0', 'size1', 'speed', 'spread', 'gravity', 'drag', 'additive', 'stretch', 'delay', 'bounce', 'spin'];
const CURVES = { clamp: 0, aces: 1, reinhard: 2 };
export const EXT_MAGIC = 7301;

/** A particle kind's packed fields (PACK_KIND order). */
function packKind(k, d) {
  const c = lin(k?.color ?? d.color), size = Array.isArray(k?.size) ? k.size : d.size;
  return [...c, num(k?.alpha, d.alpha), num(k?.glow, d.glow), num(k?.count, d.count), num(k?.life, d.life), num(size[0], d.size[0]), num(size[1] ?? size[0], d.size[1]),
    num(k?.speed, d.speed), num(k?.spread, d.spread), num(k?.gravity, d.gravity), num(k?.drag, d.drag), num(k?.additive, d.additive), num(k?.stretch, d.stretch), num(k?.delay, d.delay), num(k?.bounce, d.bounce), num(k?.spin, d.spin)];
}

/**
 * config/look.json → the core's packed look (forge-web set_look): wave 0's 22 floats (colours linear), then the track R
 * extension. `tier` (the quality tier's name) lowers what TIERS says. A wave 0 look.json (sky a colour, no stack) packs
 * with the stack off: no bloom, shadows or retro pass, as wave 0 drew.
 */
export function pack(look = {}, tier = 'high') {
  const d = presets[DEFAULT];
  const T = TIERS[tier] ?? {};
  const skyObj = look.sky && typeof look.sky === 'object' ? look.sky : null;
  const skyTop = skyObj ? skyObj.zenith : look.sky;
  const dir = Array.isArray(look.moon?.dir) && look.moon.dir.length === 3 ? look.moon.dir.map(Number) : d.moon.dir;
  const base = [
    ...lin(skyTop ?? d.sky.zenith), ...lin(look.fog?.color ?? d.fog.color), num(look.fog?.near, d.fog.near), num(look.fog?.far, d.fog.far),
    ...lin(look.ambient?.color ?? d.ambient.color), num(look.ambient?.intensity, d.ambient.intensity),
    ...dir, ...lin(look.moon?.color ?? d.moon.color), num(look.moon?.intensity, d.moon.intensity),
    num(look.exposure, d.exposure), Math.min(1, Math.max(0.25, num(look.renderScale, d.renderScale))), look.pixelated ? 1 : 0,
  ];
  // a wave 0 look (no stack values at all): wave 0's picture
  const stack = skyObj || ['shadow', 'bloom', 'tone', 'retro', 'particles'].some(k => look[k] !== undefined);
  if (!stack) return new Float32Array(base);
  const low = (v, cap) => (cap === undefined ? v : Math.min(v, cap));
  // a distance where 0 means "no limit": a tier's cap is a limit even then
  const far = (v, cap) => (cap === undefined ? v : v > 0 ? Math.min(v, cap) : cap);
  const z = lin(skyObj?.zenith ?? skyTop ?? d.sky.zenith), h = lin(skyObj?.horizon ?? look.fog?.color ?? d.fog.color);
  const disc = lin(look.moon?.disc ?? '#e9eef5'), hit = lin(look.hit?.color ?? '#ffffff');
  const ext = {
    'fog.density': num(look.fog?.density, 0),
    'sky.zenith.r': z[0], 'sky.zenith.g': z[1], 'sky.zenith.b': z[2], 'sky.horizon.r': h[0], 'sky.horizon.g': h[1], 'sky.horizon.b': h[2], 'sky.stars': num(skyObj?.stars, 0),
    'moon.disc.r': disc[0], 'moon.disc.g': disc[1], 'moon.disc.b': disc[2], 'moon.size': num(look.moon?.size, 0), 'moon.brightness': num(look.moon?.brightness, 4), 'moon.glow': num(look.moon?.glow, 0),
    'shadow.size': low(num(look.shadow?.size, 0), T.shadowSize), 'shadow.distance': num(look.shadow?.distance, 30), 'shadow.strength': num(look.shadow?.strength, 1), 'shadow.bias': num(look.shadow?.bias, 1.5),
    'bloom.intensity': num(look.bloom?.intensity, 0), 'bloom.threshold': num(look.bloom?.threshold, 1), 'bloom.knee': num(look.bloom?.knee, 0.5), 'bloom.radius': num(look.bloom?.radius, 1),
    'tone.curve': CURVES[look.tone?.curve] ?? 0, 'tone.contrast': num(look.tone?.contrast, 1), 'tone.saturation': num(look.tone?.saturation, 1), 'tone.gamma': num(look.tone?.gamma, 1),
    'retro.texels': look.retro?.texels ? 1 : 0, 'retro.grain': num(look.retro?.grain, 0), 'retro.dither': num(look.retro?.dither, 0), 'retro.steps': num(look.retro?.steps, 0), 'retro.snap': num(look.retro?.snap, 0),
    detail: num(look.detail, 0), aa: look.aa && T.aa !== false ? 1 : 0, 'lights.max': low(num(look.lights?.max, 16), T.lights),
    'hit.color.r': hit[0], 'hit.color.g': hit[1], 'hit.color.b': hit[2], 'hit.time': num(look.hit?.time, 0.05), 'hit.amount': num(look.hit?.amount, 1),
    'fp.fov': num(look.fp?.fov, 54), 'fire.embers': num(look.fire?.embers, 0), 'fire.smoke': num(look.fire?.smoke, 0), 'weather.ash': num(look.weather?.ash, 0),
    'particles.budget': low(num(look.particles?.budget, 2048), T.budget), emissive: num(look.emissive, 1), vignette: num(look.tone?.vignette, 0),
    'shadow.softness': low(num(look.shadow?.softness, 1), T.softness),
    'retro.density': num(look.retro?.density, 0), 'retro.models': num(look.retro?.models, 0), 'retro.hand': num(look.retro?.hand, 0), 'retro.crisp': num(look.retro?.crisp, 0),
    'sky.haze': num(skyObj?.haze, 0),
    'tone.auto': num(look.tone?.auto, 0), 'tone.key': num(look.tone?.key, 41), 'tone.autoMin': num(look.tone?.autoMin, 0.3), 'tone.autoMax': num(look.tone?.autoMax, 1.6), 'tone.adapt': num(look.tone?.adapt, 0.3),
    'lights.falloff': num(look.lights?.falloff, 0),
    'tracer.width': num(look.tracer?.width, 0.02), 'tracer.length': num(look.tracer?.length, 3), 'tracer.speed': num(look.tracer?.speed, 220), 'tracer.glow': num(look.tracer?.glow, 6),
    'backdrop.distance': far(num(look.backdrop?.distance, 0), T.backdropDistance), 'backdrop.fog': num(look.backdrop?.fog, 1),
    'pieces.shadow': far(num(look.pieces?.shadow, 0), T.piecesShadow), 'pieces.distance': far(num(look.pieces?.distance, 0), T.piecesDistance),
    'fire.shadows': low(num(look.fire?.shadows, 0), T.fireShadows), 'fire.shadowSize': num(look.fire?.shadowSize, 256), 'fire.shadowFaces': low(num(look.fire?.shadowFaces, 4), T.fireFaces), 'fire.shadowStrength': num(look.fire?.shadowStrength, 0.85),
  };
  const kinds = KIND_IDS.flatMap(k => packKind(look.particles?.[k], PARTICLES[k]));
  return new Float32Array([...base, EXT_MAGIC, 1, PACK_EXT.length, ...PACK_EXT.map(n => ext[n]), KIND_IDS.length, PACK_KIND.length, ...kinds]);
}

/** The torches' light from config/look.json: {color (linear), intensity, range, flicker}. */
export function torch(look = {}) {
  const d = presets[DEFAULT].torch, t = look.torch ?? {};
  return { color: lin(t.color ?? d.color), intensity: num(t.intensity, d.intensity), range: num(t.range, d.range), flicker: Math.min(1, Math.max(0, num(t.flicker, d.flicker))) };
}

// a smooth 1D value noise (for a flame's slow gusts)
const hash = n => { const s = Math.sin(n * 127.1) * 43758.5453; return s - Math.floor(s); };
const noise = x => { const i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f); return hash(i) * (1 - u) + hash(i + 1) * u; };

/**
 * A flame's brightness at time t, around 1 (seeded per light so fires differ): a quick shimmer over a slow breath and
 * an occasional gust, never a strobe. At flicker 0.09 the measured brazier's 7.8–9.2 swing around 8.5.
 */
export function flicker(t, seed, amount) {
  if (!amount) return 1;
  const s = (seed ?? 1) * 12.9898;
  const w = Math.sin(t * 7.3 + s) * 0.35 + Math.sin(t * 13.1 + s * 1.7) * 0.25 + Math.sin(t * 29.7 + s * 2.3) * 0.12 + (noise(t * 2.1 + s) - 0.5) * 0.9;
  return Math.max(0, 1 + w * amount);
}
