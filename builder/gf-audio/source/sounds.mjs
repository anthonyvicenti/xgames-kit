// Sound list ("sounds manifest") schema, defaults and validator. Shared by the runtime (audio.js), QA and
// Creator Studio. The manifest is plain data, so it can live on its own (game/audio/sounds.json) or as the
// `sounds` section of a larger per-game asset manifest; the runtime takes the object, not a path.
//
// {
//   "version": 1,
//   "buses": { "master": 0, "sfx": -6, "music": -16, "ui": -10, "ambient": -18 },    // dB, all optional
//   "sounds": {
//     "<id>": {
//       "label": "Blaster shot",            // what the creator sees in Studio
//       "bus": "sfx",                        // sfx | music | ui | ambient
//       "src": { "zzfx": [ ... ] }           // or { "file": "audio/shot.ogg" } or { "preset": "laser-soft" },
//                                            // or { "file": "audio/sfx.ogg", "start": 1.2, "end": 1.9 } = only that slice of a shared
//                                            //   file, in seconds, `end` optional = to the file's end (an audio sprite; 1.4.0)
//                                            // or { "layers": [ {src..., "gainDb": -6, "delayMs": 40}, ... ] } = played together
//                                            // or an array of these = variations, rotated without back-to-back repeats
//       "gainDb": -4,                        // per-sound trim, -60..+6
//       "pitch": 1,                          // playback-rate multiplier, 0.25..4
//       "pitchJitter": 0.05,                 // ± fraction per play
//       "gainJitterDb": 1.5,                 // ± dB per play
//       "cooldownMs": 50,                    // min gap between starts of this sound
//       "maxVoices": 3,                      // simultaneous copies; the oldest is stopped (with a short fade)
//       "loop": false,
//       "note": "fires on every trigger pull" // optional, for creators and builders
//     }
//   }
// }
//
// A sound the game makes with its own Web Audio code (1.5.0; played by code-sounds.js, never by audio.js) adds:
//       "src": { "file": "sounds/code/jump.wav" },   // == code.preview: the game plays its own synth; anything else replaces it
//       "code": {
//         "sig": [["js/audio.js:82:24", "js/game.js:110:7"]],   // call-stack patterns ("file:line:col", innermost first)
//         "preview": "sounds/code/jump.wav",          // a recording of the game's own sound, for Studio
//         "from": "js/game.js:110 jump",              // where it's made, for people
//         "level": -21.4,                             // the sound's loudest 400 ms (LUFS) where it leaves its own nodes; a
//                                                     //   replacement is matched to it there, before the game's own master
//         "heardDb": -6,                              // optional: what the game's own chain added after that (its master); the
//                                                     //   preview file is already at that level, so Studio plays it as heard
//         "period": 0.25                              // optional: seconds between events of a sequencer (music)
//       },
//       "bake": { "from": "js/game.js", "hash": "<sha256 of that file when captured>" },
//       "editable": false, "readonlyReason": "..."    // optional: heard in Studio but not replaceable (an AudioWorklet synth)

export const MANIFEST_VERSION = 1;
export const BUSES = ['sfx', 'music', 'ui', 'ambient'];
// 1.1.0 raised master from -6 to 0: with 1.0.0 defaults a preset one-shot reached only about -29 LUFS (loudest
// 400 ms) at the default 0.7 volume, and effects-only games measured too quiet. Now it's about -23.
export const BUS_DEFAULTS = { master: 0, sfx: -6, music: -16, ui: -10, ambient: -18 };

/** Defaults per bus. Music and ambient loops don't jitter and default to looping. */
export const SOUND_DEFAULTS = {
  sfx: { gainDb: 0, pitch: 1, pitchJitter: 0.05, gainJitterDb: 1.5, cooldownMs: 50, maxVoices: 4, loop: false },
  ui: { gainDb: 0, pitch: 1, pitchJitter: 0.02, gainJitterDb: 0.5, cooldownMs: 40, maxVoices: 2, loop: false },
  music: { gainDb: 0, pitch: 1, pitchJitter: 0, gainJitterDb: 0, cooldownMs: 0, maxVoices: 1, loop: true },
  ambient: { gainDb: 0, pitch: 1, pitchJitter: 0, gainJitterDb: 0, cooldownMs: 0, maxVoices: 2, loop: true },
};

const RANGES = {
  gainDb: [-60, 6], pitch: [0.25, 4], pitchJitter: [0, 0.5], gainJitterDb: [0, 12],
  cooldownMs: [0, 10000], maxVoices: [1, 32],
};
const BUS_RANGE = [-60, 6];
const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

const isNum = v => typeof v === 'number' && Number.isFinite(v);

const MAX_LAYERS = 6;
const LAYER_RANGES = { gainDb: [-60, 6], delayMs: [0, 2000] };

const MAX_SLICE_S = 36000;      // a slice's start and end are seconds into the file; far past any real file, so a typo in ms shows up
const MIN_SLICE_S = 0.01;       // shorter than this is almost certainly a mistake (warned, not an error)

function checkSrc(src, where, errors, { presets, layer = false, warnings = [] } = {}) {
  if (!src || typeof src !== 'object' || Array.isArray(src)) { errors.push(`${where}: must be {zzfx}, {file}, {preset} or {layers}`); return; }
  if ('layers' in src) {
    if (layer) { errors.push(`${where}: layers can't be nested`); return; }
    if (!Array.isArray(src.layers) || src.layers.length < 1 || src.layers.length > MAX_LAYERS) { errors.push(`${where}.layers: 1 to ${MAX_LAYERS} sources`); return; }
    src.layers.forEach((l, i) => {
      checkSrc(l, `${where}.layers[${i}]`, errors, { presets, layer: true, warnings });
      for (const [k, [lo, hi]] of Object.entries(LAYER_RANGES))
        if (l?.[k] !== undefined && (!isNum(l[k]) || l[k] < lo || l[k] > hi)) errors.push(`${where}.layers[${i}].${k}: number between ${lo} and ${hi}`);
    });
    return;
  }
  const keys = ['zzfx', 'file', 'preset'].filter(k => k in src);
  if (keys.length !== 1) { errors.push(`${where}: needs exactly one of zzfx, file, preset`); return; }
  if (src.zzfx !== undefined) {
    if (!Array.isArray(src.zzfx) || src.zzfx.length > 21 || src.zzfx.some(v => v !== null && v !== undefined && !isNum(v)))
      errors.push(`${where}.zzfx: must be an array of up to 21 numbers (nulls allowed)`);
  }
  if (src.file !== undefined && (typeof src.file !== 'string' || !src.file || src.file.includes('..') || /^[a-z]+:/i.test(src.file)))
    errors.push(`${where}.file: must be a relative path inside the game`);
  // {file, start, end} (1.4.0): play only start..end seconds of the file. `end` is optional (to the file's end).
  if (src.start !== undefined || src.end !== undefined) {
    if (src.file === undefined) errors.push(`${where}: start and end only apply to a {file} source`);
    else {
      for (const k of ['start', 'end'])
        if (src[k] !== undefined && (!isNum(src[k]) || src[k] < 0 || src[k] > MAX_SLICE_S)) errors.push(`${where}.${k}: seconds into the file, between 0 and ${MAX_SLICE_S}`);
      if (isNum(src.start) && isNum(src.end)) {
        if (src.end <= src.start) errors.push(`${where}.end: must be after start (${src.start})`);
        else if (src.end - src.start < MIN_SLICE_S) warnings.push(`${where}: slice is ${Math.round((src.end - src.start) * 1000)} ms, shorter than ${MIN_SLICE_S * 1000} ms`);
      }
    }
  }
  if (src.preset !== undefined && (typeof src.preset !== 'string' || !ID.test(src.preset)))
    errors.push(`${where}.preset: must be a preset id`);
  else if (src.preset !== undefined && presets && !presets[src.preset]) errors.push(`${where}: unknown preset "${src.preset}"`);
}

// Sounds built in code (1.5.0). A frame is "path:line:col" in the game folder; patterns are short (innermost frames).
const MAX_PATTERNS = 256, MAX_PATTERN_FRAMES = 40;
const FRAME = /^[^\s:][^\n]*:\d+:\d+$/;
const PATH = p => typeof p === 'string' && !!p && !p.includes('..') && !/^[a-z]+:/i.test(p) && !p.startsWith('/');
const isOwnSrc = (src, preview) => !!src && typeof src === 'object' && !Array.isArray(src) && src.file === preview && src.start === undefined && src.end === undefined && !src.layers;
/** For a sound built in code: 'own' while it plays the game's own synth (src is {file: code.preview}), 'replaced' when the
 *  creator gave it another source, null for a sound that isn't built in code. */
export function codeState(def) {
  if (!def?.code || typeof def.code !== 'object') return null;
  const src = Array.isArray(def.src) && def.src.length === 1 ? def.src[0] : def.src;
  return isOwnSrc(src, def.code.preview) ? 'own' : 'replaced';
}
function checkCode(s, at, errors) {
  const c = s.code;
  if (!c || typeof c !== 'object' || Array.isArray(c)) { errors.push(`${at}.code: must be an object`); return; }
  if (!PATH(c.preview) || !/\.(wav|ogg|mp3)$/i.test(c.preview)) errors.push(`${at}.code.preview: a .wav, .ogg or .mp3 path inside the game`);
  if (c.sig === undefined) { if (s.editable !== false) errors.push(`${at}.code.sig: needed unless the sound is editable: false`); }
  else if (!Array.isArray(c.sig) || c.sig.length > MAX_PATTERNS || c.sig.some(p => !Array.isArray(p) || !p.length || p.length > MAX_PATTERN_FRAMES || p.some(f => typeof f !== 'string' || !FRAME.test(f))))
    errors.push(`${at}.code.sig: up to ${MAX_PATTERNS} patterns, each 1 to ${MAX_PATTERN_FRAMES} frames "file:line:col"`);
  if (c.from !== undefined && typeof c.from !== 'string') errors.push(`${at}.code.from: a string`);
  if (c.level !== undefined && (!isNum(c.level) || c.level < -120 || c.level > 20)) errors.push(`${at}.code.level: LUFS between -120 and 20`);
  if (c.period !== undefined && (!isNum(c.period) || c.period <= 0 || c.period > 60)) errors.push(`${at}.code.period: seconds between 0 and 60`);
  if (c.heardDb !== undefined && (!isNum(c.heardDb) || c.heardDb < -60 || c.heardDb > 30)) errors.push(`${at}.code.heardDb: dB between -60 and 30`);
  if (s.editable === false && codeState(s) === 'replaced') errors.push(`${at}: a view-only sound (editable: false) can't be replaced; its src must stay {file: code.preview}`);
}

/** Validate a manifest object. Returns {ok, errors, warnings}. `presets` (optional) checks preset ids exist. */
export function validateManifest(m, { presets } = {}) {
  const errors = [], warnings = [];
  if (!m || typeof m !== 'object') return { ok: false, errors: ['manifest must be an object'], warnings };
  if (m.version !== undefined && m.version !== MANIFEST_VERSION) errors.push(`version: expected ${MANIFEST_VERSION}`);
  for (const [k, v] of Object.entries(m.buses ?? {})) {
    if (!(k === 'master' || BUSES.includes(k))) errors.push(`buses.${k}: unknown bus`);
    else if (!isNum(v) || v < BUS_RANGE[0] || v > BUS_RANGE[1]) errors.push(`buses.${k}: dB between ${BUS_RANGE[0]} and ${BUS_RANGE[1]}`);
  }
  const sounds = m.sounds ?? {};
  if (typeof sounds !== 'object' || Array.isArray(sounds)) errors.push('sounds: must be an object keyed by id');
  for (const [id, s] of Object.entries(sounds)) {
    const at = `sounds.${id}`;
    if (!ID.test(id)) errors.push(`${at}: id must be letters, digits, - or _`);
    if (!s || typeof s !== 'object') { errors.push(`${at}: must be an object`); continue; }
    if (typeof s.label !== 'string' || !s.label.trim()) warnings.push(`${at}.label: missing (Studio will show the id)`);
    if (s.bus !== undefined && !BUSES.includes(s.bus)) errors.push(`${at}.bus: one of ${BUSES.join(', ')}`);
    const srcs = Array.isArray(s.src) ? s.src : [s.src];
    if (!srcs.length) errors.push(`${at}.src: empty`);
    srcs.forEach((src, i) => checkSrc(src, Array.isArray(s.src) ? `${at}.src[${i}]` : `${at}.src`, errors, { presets, warnings }));
    for (const [k, [lo, hi]] of Object.entries(RANGES)) {
      if (s[k] === undefined) continue;
      if (!isNum(s[k]) || s[k] < lo || s[k] > hi) errors.push(`${at}.${k}: number between ${lo} and ${hi}`);
    }
    if (s.loop !== undefined && typeof s.loop !== 'boolean') errors.push(`${at}.loop: true or false`);
    if (s.code !== undefined) checkCode(s, at, errors);
    if (s.editable !== undefined && typeof s.editable !== 'boolean') errors.push(`${at}.editable: true or false`);
    if (s.readonlyReason !== undefined && typeof s.readonlyReason !== 'string') errors.push(`${at}.readonlyReason: a string`);
    if (s.bake !== undefined && (!s.bake || !PATH(s.bake.from) || typeof s.bake.hash !== 'string' || !/^[0-9a-f]{64}$/.test(s.bake.hash)))
      errors.push(`${at}.bake: {from: a path in the game, hash: sha256 hex}`);
    const bus = s.bus ?? 'sfx';
    if ((bus === 'sfx' || bus === 'ui') && s.cooldownMs === 0) warnings.push(`${at}: cooldownMs 0 lets it fire every frame`);
    if (s.gainDb > 0) warnings.push(`${at}: gainDb above 0 boosts it; prefer lowering other sounds`);
  }
  return { ok: errors.length === 0, errors, warnings };
}

/** Fill defaults. Returns a new object; the input is not changed. */
export function resolveManifest(m, { presets = {} } = {}) {
  const buses = { ...BUS_DEFAULTS, ...(m.buses ?? {}) };
  const sounds = {};
  for (const [id, s] of Object.entries(m.sounds ?? {})) {
    const bus = s.bus ?? 'sfx';
    const leaf = src => {
      if (src?.preset) {
        const p = presets[src.preset];
        if (!p) throw new Error(`sounds.${id}: unknown preset "${src.preset}"`);
        return { ...src, zzfx: p.zzfx, preset: src.preset };
      }
      return { ...src };
    };
    const srcs = (Array.isArray(s.src) ? s.src : [s.src]).map(src => (src?.layers ? { layers: src.layers.map(leaf) } : leaf(src)));
    sounds[id] = { ...SOUND_DEFAULTS[bus], ...s, id, bus, label: s.label || id, src: srcs };
  }
  return { version: MANIFEST_VERSION, buses, sounds };
}

/**
 * Mix layers into one sound. parts: [{channels: Float32Array[], gainDb?, delayMs?}] at one sample rate.
 * Returns Float32Array[] with as many channels as the widest part (mono parts are copied to every channel).
 * The runtime and Studio both use this, so a layered sound renders the same in each.
 */
export function mixLayers(parts, sampleRate) {
  const nCh = Math.max(1, ...parts.map(p => p.channels.length));
  const offs = parts.map(p => Math.round((p.delayMs ?? 0) / 1000 * sampleRate));
  const len = Math.max(1, ...parts.map((p, i) => offs[i] + (p.channels[0]?.length ?? 0)));
  const out = Array.from({ length: nCh }, () => new Float32Array(len));
  parts.forEach((p, i) => {
    const g = dbToGain(p.gainDb ?? 0);
    for (let c = 0; c < nCh; c++) {
      const src = p.channels[Math.min(c, p.channels.length - 1)], dst = out[c], o = offs[i];
      for (let j = 0; j < src.length; j++) dst[o + j] += src[j] * g;
    }
  });
  return out;
}

export const dbToGain = db => 10 ** (db / 20);
export const gainToDb = g => (g > 0 ? 20 * Math.log10(g) : -Infinity);
