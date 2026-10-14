// games.fun audio kit 1.5.0: code-sounds.js, for games that make their sounds with their own Web Audio code.
// Load it as a classic script before every game script: <script src="audio/code-sounds.js"></script>.
//
// It watches the audio nodes the game creates. Nodes created in one task (one keydown handler, one animation frame)
// form a burst, and each node is matched to a sound in assets.json by where in the game's code it was made: a sound
// built in code has `code.sig`, a list of call-stack patterns (frames "file:line:col", innermost first) written by
// research/audio/capture-code-sounds.mjs. Contract: creator-studio/docs/asset-manifest.md, "v1.4: sounds built in code".
//   - A sound whose `src` is still its own recording ({file: code.preview}) plays exactly as the game makes it; the
//     file is only Studio's preview.
//   - Any other `src` is the creator's replacement (a preset, ZzFX numbers, layers, a file or a slice). The game's
//     nodes for that event still run, so its timers and `onended` callbacks behave, but their way out (a connect() to
//     a node outside the sound) goes into a muted sink instead. The replacement plays in the game's own AudioContext,
//     into the node the event was going to connect to, so the game's own volume, mute and pause still apply. It is
//     matched to the loudness of the original (`code.level`), then the sound's gainDb.
//   - Unmatched nodes, sounds marked `editable: false`, and everything before assets.json has loaded play exactly as
//     before. Offline rendering (OfflineAudioContext) is never touched.
// Where the manifest comes from: __GF_FILES['assets.json'] when packed, else assets.json next to the page (the play
// origin merges a draft's sounds into it), plus __GF_ASSET_OVERRIDES.sounds and the active variant's sounds, as
// gf-assets merges them. Studio's live edits arrive as {type: 'gf-audio:set' | 'gf-audio:update'} messages from the
// parent frame. Frames are positions in the game's files, so swaps need the files as written: the play origin or a
// static server. The packed inline page inlines and bundles scripts, so its frames never match and it plays the
// game's own sounds (unless a script carries `//# sourceURL=<its path>`).
// window.__GF_CODE_SOUNDS has debug counters: stats.events[id] (events matched), stats.swapped[id] (replacements played),
// stats.own[id] (events left to the game), stats.unmatched (nodes no pattern picked out), stats.early (nodes made before
// assets.json loaded), stats.notReady (a replacement still decoding), stats.dropped (its cooldown).
//
// BUILT FILE (do not edit): research/audio/build-code-sounds.mjs makes this from kit/code-sounds.src.js and inlines
// the kit's zzfx.mjs, sounds.mjs and meter.mjs (unchanged, each in its own scope) and the presets' ZzFX numbers.
// Edit code-sounds.src.js, then rebuild.
(function () {
  'use strict';
  const W = globalThis;
  if (W.__GF_CODE_SOUNDS || typeof AudioNode === 'undefined' || typeof W.document === 'undefined') return;
  const kit = {
  zzfx: (() => { // ---- zzfx.mjs, inlined unchanged ----
// ZzFX synth as a pure function. Adapted from ZzFX v1.3.2 by Frank Force (MIT). The verbatim upstream
// is in research/audio/upstream/zzfx/ (commit c4af351). Changes from upstream: no AudioContext on import,
// the sample rate and random source are arguments, and the output is a Float32Array. The algorithm is unchanged.
//
// ZzFX MIT License, Copyright (c) 2019 - Frank Force
// Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
// documentation files (the "Software"), to deal in the Software without restriction, including without limitation
// the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and
// to permit persons to whom the Software is furnished to do so, subject to the following conditions:
// The above copyright notice and this permission notice shall be included in all copies or substantial portions
// of the Software.
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO
// THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF
// CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
// IN THE SOFTWARE.

/** Parameter names in ZzFX order, so tools can label the array. */
const ZZFX_PARAMS = [
  'volume', 'randomness', 'frequency', 'attack', 'sustain', 'release', 'shape', 'shapeCurve', 'slide', 'deltaSlide',
  'pitchJump', 'pitchJumpTime', 'repeatTime', 'noise', 'modulation', 'bitCrush', 'delay', 'sustainVolume', 'decay',
  'tremolo', 'filter',
];
const ZZFX_DEFAULTS = [1, .05, 220, 0, 0, .1, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0];
const ZZFX_SHAPES = ['sine', 'triangle', 'saw', 'tan', 'noise', 'square'];

/** Fill holes (ZzFX arrays are often sparse, e.g. [,,220]) with defaults. */
function zzfxParams(params = []) {
  return ZZFX_DEFAULTS.map((d, i) => (params[i] === undefined || params[i] === null ? d : params[i]));
}

/**
 * Render a ZzFX sound to mono samples.
 * @param {number[]} params ZzFX parameter array (sparse is fine)
 * @param {{sampleRate?:number, random?:()=>number}} [opts] use random:()=>.5 for a deterministic render
 */
function buildSamples(params, { sampleRate = 44100, random = Math.random } = {}) {
  let [volume, randomness, frequency, attack, sustain, release, shape, shapeCurve, slide, deltaSlide, pitchJump,
    pitchJumpTime, repeatTime, noise, modulation, bitCrush, delay, sustainVolume, decay, tremolo, filter] = zzfxParams(params);
  const PI2 = Math.PI * 2, abs = Math.abs, sign = v => (v < 0 ? -1 : 1);
  let startSlide = slide *= 500 * PI2 / sampleRate / sampleRate,
    startFrequency = frequency *= (1 + randomness * 2 * random() - randomness) * PI2 / sampleRate,
    modOffset = 0, repeat = 0, crush = 0, jump = 1, length, t = 0, i = 0, s = 0, f;
  const quality = 2, w = PI2 * abs(filter) * 2 / sampleRate,
    cos = Math.cos(w), alpha = Math.sin(w) / 2 / quality,
    a0 = 1 + alpha, a1 = -2 * cos / a0, a2 = (1 - alpha) / a0,
    b0 = (1 + sign(filter) * cos) / 2 / a0,
    b1 = -(sign(filter) + cos) / a0, b2 = b0;
  let x2 = 0, x1 = 0, y2 = 0, y1 = 0;

  const minAttack = 9; // prevent pop if attack is 0
  attack = attack * sampleRate || minAttack;
  decay *= sampleRate;
  sustain *= sampleRate;
  release *= sampleRate;
  delay *= sampleRate;
  deltaSlide *= 500 * PI2 / sampleRate ** 3;
  modulation *= PI2 / sampleRate;
  pitchJump *= PI2 / sampleRate;
  pitchJumpTime *= sampleRate;
  repeatTime = repeatTime * sampleRate | 0;

  length = attack + decay + sustain + release + delay | 0;
  const b = new Float32Array(Math.max(0, length));
  for (; i < length; b[i++] = s * volume) {
    if (!(++crush % (bitCrush * 100 | 0))) {
      s = shape ? shape > 1 ? shape > 2 ? shape > 3 ? shape > 4 ?
        (t / PI2 % 1 < shapeCurve / 2 ? 1 : -1) :
        Math.sin(t ** 3) :
        Math.max(Math.min(Math.tan(t), 1), -1) :
        1 - (2 * t / PI2 % 2 + 2) % 2 :
        1 - 4 * abs(Math.round(t / PI2) - t / PI2) :
        Math.sin(t);

      s = (repeatTime ? 1 - tremolo + tremolo * Math.sin(PI2 * i / repeatTime) : 1) *
        (shape > 4 ? s : sign(s) * abs(s) ** shapeCurve) *
        (i < attack ? i / attack :
          i < attack + decay ? 1 - ((i - attack) / decay) * (1 - sustainVolume) :
            i < attack + decay + sustain ? sustainVolume :
              i < length - delay ? (length - i - delay) / release * sustainVolume :
                0);

      s = delay ? s / 2 + (delay > i ? 0 :
        (i < length - delay ? 1 : (length - i) / delay) * b[i - delay | 0] / 2 / volume) : s;

      if (filter) s = y1 = b2 * x2 + b1 * (x2 = x1) + b0 * (x1 = s) - a2 * y2 - a1 * (y2 = y1);
    }

    f = (frequency += slide += deltaSlide) * Math.cos(modulation * modOffset++);
    t += f + f * noise * Math.sin(i ** 5);

    if (jump && ++jump > pitchJumpTime) {
      frequency += pitchJump;
      startFrequency += pitchJump;
      jump = 0;
    }
    if (repeatTime && !(++repeat % repeatTime)) {
      frequency = startFrequency;
      slide = startSlide;
      jump ||= 1;
    }
  }
  return b;
}
return { ZZFX_PARAMS, ZZFX_DEFAULTS, ZZFX_SHAPES, zzfxParams, buildSamples };
})(),
  sounds: (() => { // ---- sounds.mjs, inlined unchanged ----
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

const MANIFEST_VERSION = 1;
const BUSES = ['sfx', 'music', 'ui', 'ambient'];
// 1.1.0 raised master from -6 to 0: with 1.0.0 defaults a preset one-shot reached only about -29 LUFS (loudest
// 400 ms) at the default 0.7 volume, and effects-only games measured too quiet. Now it's about -23.
const BUS_DEFAULTS = { master: 0, sfx: -6, music: -16, ui: -10, ambient: -18 };

/** Defaults per bus. Music and ambient loops don't jitter and default to looping. */
const SOUND_DEFAULTS = {
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
function codeState(def) {
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
function validateManifest(m, { presets } = {}) {
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
function resolveManifest(m, { presets = {} } = {}) {
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
function mixLayers(parts, sampleRate) {
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

const dbToGain = db => 10 ** (db / 20);
const gainToDb = g => (g > 0 ? 20 * Math.log10(g) : -Infinity);
return { MANIFEST_VERSION, BUSES, BUS_DEFAULTS, SOUND_DEFAULTS, codeState, validateManifest, resolveManifest, mixLayers, dbToGain, gainToDb };
})(),
  meter: (() => { // ---- meter.mjs, inlined unchanged ----
// Loudness meter in plain JS (Node and browser, no dependencies).
// Integrated/momentary/short-term loudness follow ITU-R BS.1770-4 / EBU R128: K-weighting (38 Hz high-pass +
// 1.5 kHz +4 dB shelf, derived for any sample rate the way pyloudnorm does), 400 ms blocks with 75% overlap,
// -70 LUFS absolute gate and -10 LU relative gate. True peak uses 4x windowed-sinc oversampling (an
// approximation of the BS.1770 annex filter, within ~0.1 dB on typical material).
// "Harshness" (hf) is the share of signal energy above 4 kHz after a 4th-order Butterworth high-pass. It isn't a
// standard metric; it's our proxy for bright square/saw tones.

const LOG10 = Math.log10;
const toDb = x => (x > 0 ? 20 * LOG10(x) : -Infinity);

function biquad(x, [b0, b1, b2, a1, a2]) {
  const y = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v;
  }
  return y;
}

function shelf(fs, fc = 1500, gainDb = 4, Q = Math.SQRT1_2) {
  const A = 10 ** (gainDb / 40), w = 2 * Math.PI * fc / fs, c = Math.cos(w), al = Math.sin(w) / (2 * Q), sA = 2 * Math.sqrt(A) * al;
  const a0 = (A + 1) - (A - 1) * c + sA;
  return [A * ((A + 1) + (A - 1) * c + sA) / a0, -2 * A * ((A - 1) + (A + 1) * c) / a0, A * ((A + 1) + (A - 1) * c - sA) / a0,
    2 * ((A - 1) - (A + 1) * c) / a0, ((A + 1) - (A - 1) * c - sA) / a0];
}

function highpass(fs, fc, Q) {
  const w = 2 * Math.PI * fc / fs, c = Math.cos(w), al = Math.sin(w) / (2 * Q), a0 = 1 + al;
  return [(1 + c) / 2 / a0, -(1 + c) / a0, (1 + c) / 2 / a0, -2 * c / a0, (1 - al) / a0];
}

const kWeight = (ch, fs) => biquad(biquad(ch, shelf(fs)), highpass(fs, 38, 0.5));

/** Mean-square power per block for each channel's K-weighted signal. */
function blockPowers(kw, fs, blockSec, stepSec) {
  const n = kw[0].length, bl = Math.round(blockSec * fs), st = Math.round(stepSec * fs), out = [];
  if (n < bl) { // shorter than one block: treat as one zero-padded block
    let p = 0;
    for (const ch of kw) { let s = 0; for (const v of ch) s += v * v; p += s / bl; }
    return [p];
  }
  // prefix sums of squares per channel
  const pre = kw.map(ch => { const a = new Float64Array(n + 1); for (let i = 0; i < n; i++) a[i + 1] = a[i] + ch[i] * ch[i]; return a; });
  for (let s = 0; s + bl <= n; s += st) { let p = 0; for (const a of pre) p += (a[s + bl] - a[s]) / bl; out.push(p); }
  return out;
}

const lufsOf = p => (p > 0 ? -0.691 + 10 * LOG10(p) : -Infinity);

function integrated(powers) {
  const abs = powers.filter(p => lufsOf(p) > -70);
  if (!abs.length) return -Infinity;
  const rel = lufsOf(abs.reduce((a, b) => a + b, 0) / abs.length) - 10;
  const gated = abs.filter(p => lufsOf(p) > rel);
  return gated.length ? lufsOf(gated.reduce((a, b) => a + b, 0) / gated.length) : -Infinity;
}

// 4x oversampling with a Hann-windowed sinc, 12 taps per phase.
const TP_PHASES = 4, TP_TAPS = 12;
const TP_KERNEL = (() => {
  const k = [];
  for (let p = 1; p < TP_PHASES; p++) {
    const frac = p / TP_PHASES, row = [];
    for (let j = 0; j < TP_TAPS; j++) {
      const x = j - TP_TAPS / 2 + 1 - frac, w = 0.5 + 0.5 * Math.cos(Math.PI * x / (TP_TAPS / 2));
      row.push((x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x)) * w);
    }
    k.push(row);
  }
  return k;
})();

function truePeak(ch) {
  let peak = 0;
  for (let i = 0; i < ch.length; i++) {
    const a = Math.abs(ch[i]); if (a > peak) peak = a;
    for (const row of TP_KERNEL) {
      let s = 0;
      for (let j = 0; j < TP_TAPS; j++) { const idx = i + j - TP_TAPS / 2 + 1; if (idx >= 0 && idx < ch.length) s += row[j] * ch[idx]; }
      const b = Math.abs(s); if (b > peak) peak = b;
    }
  }
  return peak;
}

/**
 * Measure audio.
 * @param {Float32Array[]|Float32Array} channels one or two channels (mono is measured as mono, per BS.1770)
 * @param {number} sampleRate
 * @param {{truePeak?:boolean}} [opts] true peak costs ~12x a pass; turn it off for very long captures if needed
 */
function measure(channels, sampleRate, { truePeak: wantTp = true } = {}) {
  const chs = Array.isArray(channels) ? channels : [channels];
  const n = chs[0]?.length ?? 0;
  const kw = chs.map(ch => kWeight(ch, sampleRate));
  const mom = blockPowers(kw, sampleRate, 0.4, 0.1);
  const short = blockPowers(kw, sampleRate, 3, 0.1);
  let samplePeak = 0, clipped = 0, total = 0, hfE = 0, active = 0;
  const hp = highpass(sampleRate, 4000, 0.5412), hp2 = highpass(sampleRate, 4000, 1.3066); // 4th-order Butterworth
  for (const ch of chs) {
    const hf = biquad(biquad(ch, hp), hp2);
    for (let i = 0; i < n; i++) {
      const a = Math.abs(ch[i]);
      if (a > samplePeak) samplePeak = a;
      if (a >= 1) clipped++;
      total += ch[i] * ch[i]; hfE += hf[i] * hf[i];
    }
  }
  // share of 100 ms windows (mono-summed) above -50 dBFS RMS: how much of the time something is sounding
  const win = Math.max(1, Math.round(sampleRate * 0.1)); let wins = 0;
  for (let s = 0; s < n; s += win) {
    let e = 0, c = 0;
    for (const ch of chs) for (let i = s; i < Math.min(n, s + win); i++) { e += ch[i] * ch[i]; c++; }
    wins++; if (c && 10 * LOG10(e / c || 1e-20) > -50) active++;
  }
  const r = x => (Number.isFinite(x) ? Math.round(x * 10) / 10 : null);
  return {
    seconds: r(n / sampleRate),
    integratedLufs: r(integrated(mom)),
    momentaryMaxLufs: r(Math.max(...mom.map(lufsOf))),
    shortTermMaxLufs: r(Math.max(...short.map(lufsOf))),
    samplePeakDb: r(toDb(samplePeak)),
    truePeakDb: wantTp ? r(toDb(Math.max(...chs.map(truePeak)))) : null,
    clippedSamples: clipped,
    hfRatio: total > 0 ? Math.round(hfE / total * 1000) / 1000 : 0,
    activeRatio: wins ? Math.round(active / wins * 100) / 100 : 0,
  };
}

/** Gain (linear) that brings `lufs` to `target` without pushing the sample peak over `peakCeilingDb`. */
function normalizeGain(stats, target = -18, peakCeilingDb = -1) {
  if (stats.integratedLufs === null && stats.momentaryMaxLufs === null) return 1;
  const loud = stats.integratedLufs ?? stats.momentaryMaxLufs;
  let db = target - loud;
  const pk = stats.truePeakDb ?? stats.samplePeakDb;
  if (pk !== null) db = Math.min(db, peakCeilingDb - pk);
  return 10 ** (db / 20);
}

/** Thresholds a game's captured mix is checked against. Proposed, not an industry standard (see GUIDE.md). */
// Quiet is judged by the loudest 400 ms, not integrated loudness: a game with only sparse one-shots (no music)
// reads low integrated loudness however loud each sound is. Too loud is judged on both.
const MIX_TARGETS = {
  integratedLufs: { max: -16 },             // a busy mix with music aims for about -20
  momentaryMaxLufs: { min: -32 },           // the loudest moment must be clearly audible
  shortTermMaxLufs: { max: -10 },           // no 3-second stretch louder than this
  truePeakDb: { max: -1 },
  hfRatio: { max: 0.25 },                   // energy above 4 kHz
  clippedSamples: { max: 0 },
};

function grade(stats, targets = MIX_TARGETS) {
  const problems = [];
  for (const [key, t] of Object.entries(targets)) {
    const v = stats[key];
    if (v === null || v === undefined) continue;
    if (t.max !== undefined && v > t.max) problems.push(`${key} ${v} > ${t.max}`);
    if (t.min !== undefined && v < t.min) problems.push(`${key} ${v} < ${t.min}`);
  }
  return { ok: problems.length === 0, problems };
}
return { measure, normalizeGain, MIX_TARGETS, grade };
})(),
  presets: {"laser-soft":{"zzfx":[0.7,0.05,520,0.005,0.02,0.09,1,1.4,-18,0,0,0,0,0,0,0,0,0.7,0.02,0,-3200]},"blaster-thump":{"zzfx":[0.716,0.05,170,0.004,0.03,0.12,0,1.8,-8,0,0,0,0,0.4,0,0,0,0.6,0.02,0,-2400]},"pew-retro":{"zzfx":[0.442,0.05,780,0.002,0.02,0.08,5,0.6,-32,0,0,0,0,0,0,0,0,0.6,0,0,-2600]},"arrow-whoosh":{"zzfx":[0.776,0.05,300,0.03,0.03,0.12,4,1,4,0,0,0,0,0.2,0,0,0,0.5,0,0,-1100]},"hit-soft":{"zzfx":[0.407,0.08,140,0.002,0.02,0.1,4,1,-2,0,0,0,0,0.8,0,0,0,0.6,0.03,0,-1200]},"hit-crunch":{"zzfx":[0.367,0.08,90,0.002,0.03,0.14,4,0.8,-1,0,0,0,0,1.2,0,0.02,0,0.5,0.03,0,-2200]},"hurt":{"zzfx":[0.708,0.05,240,0.005,0.06,0.16,1,1.5,-6,0,0,0,0,0.3,0,0,0,0.6,0.04,0,-1600]},"explosion-small":{"zzfx":[0.372,0.05,70,0.005,0.08,0.35,4,1,-0.5,0,0,0,0,1.5,0,0,0,0.5,0.08,0,-900]},"explosion-big":{"zzfx":[0.589,0.05,50,0.01,0.18,0.8,4,1,-0.2,0,0,0,0,2,0,0,0.05,0.5,0.15,0,-700]},"coin":{"zzfx":[0.822,0.02,880,0.002,0.04,0.14,1,1,0,0,440,0.04,0,0,0,0,0,0.7,0,0,-4000]},"gem":{"zzfx":[0.881,0.02,1175,0.002,0.03,0.22,0,1,0,0,294,0.05,0.08,0,0,0,0,0.6,0,0.2,-4500]},"powerup":{"zzfx":[0.813,0.02,330,0.01,0.18,0.2,1,1,4,0,0,0,0.06,0,0,0,0,0.6,0,0.1,-3500]},"heal":{"zzfx":[0.589,0.02,440,0.04,0.15,0.3,0,1,2,0,110,0.1,0,0,0,0,0,0.6,0,0.3,-3000]},"jump":{"zzfx":[0.741,0.03,200,0.005,0.04,0.1,1,1,9,0,0,0,0,0,0,0,0,0.6,0,0,-2500]},"land":{"zzfx":[0.403,0.08,80,0.002,0.01,0.08,4,1,-1,0,0,0,0,1,0,0,0,0.5,0.02,0,-600]},"footstep":{"zzfx":[0.412,0.15,120,0.002,0,0.05,4,1,0,0,0,0,0,1,0,0,0,0.4,0.01,0,-900]},"bounce":{"zzfx":[0.724,0.05,160,0.003,0.02,0.12,0,1,6,0,0,0,0,0,0,0,0,0.7,0.02,0,0]},"splash":{"zzfx":[0.569,0.05,400,0.01,0.05,0.3,4,1,-3,0,0,0,0,0.5,0,0,0,0.4,0.05,0,-1100]},"click":{"zzfx":[0.902,0.02,660,0.001,0,0.03,1,1,0,0,0,0,0,0,0,0,0,0.5,0,0,-3000]},"hover":{"zzfx":[0.785,0.02,990,0.002,0,0.025,0,1,0,0,0,0,0,0,0,0,0,0.3,0,0,-4000]},"confirm":{"zzfx":[0.692,0.01,523,0.003,0.04,0.1,1,1,0,0,262,0.05,0,0,0,0,0,0.6,0,0,-3500]},"cancel":{"zzfx":[0.716,0.01,392,0.003,0.04,0.1,1,1,0,0,-98,0.05,0,0,0,0,0,0.6,0,0,-3000]},"error":{"zzfx":[0.902,0.01,150,0.004,0.08,0.08,1,1,0,0,0,0,0.06,0,0,0,0,0.6,0,0.4,-1800]},"countdown":{"zzfx":[0.457,0,660,0.004,0.06,0.08,0,1,0,0,0,0,0,0,0,0,0,0.7,0,0,0]},"win":{"zzfx":[1.059,0,523,0.01,0.25,0.35,1,1,0,0,262,0.12,0.12,0,0,0,0.08,0.6,0,0,-4000]},"lose":{"zzfx":[1.23,0,330,0.02,0.3,0.45,1,1,-1.5,0,0,0,0,0,0,0,0.1,0.6,0,0.2,-2200]},"level-up":{"zzfx":[0.676,0,392,0.01,0.2,0.3,1,1,0,0,196,0.07,0.07,0,0,0,0,0.6,0,0,-4000]},"door":{"zzfx":[0.403,0.05,110,0.005,0.05,0.15,3,1,-3,0,0,0,0,0.5,0,0.03,0,0.5,0.02,0,-1200]},"alarm":{"zzfx":[0.684,0,600,0.02,0.3,0.1,1,1,0,0,0,0,0.25,0,8,0,0,0.6,0,0,-2500]},"engine-loop":{"zzfx":[0.468,0,55,0.05,1,0.05,2,1,0,0,0,0,0,0.1,3,0,0,0.8,0,0,-500]},"wind-loop":{"zzfx":[0.55,0,300,0.5,2,0.5,4,1,0,0,0,0,0,0.3,0,0,0,0.7,0,0.15,-700]}},
  };
  const { buildSamples } = kit.zzfx, { resolveManifest, mixLayers, dbToGain, codeState } = kit.sounds, { measure } = kit.meter;
  const VERSION = '1.5.0';
  // Capture mode: capture-code-sounds.mjs defines these hooks (addInitScript) before the page loads.
  const CAP = W.__GF_CODE_SOUNDS_CAPTURE || null;
  const doc = W.document, SELF = (doc.currentScript && doc.currentScript.src || '').split(/[?#]/)[0];
  // The game folder is the page's own folder (not <base href>, which a game may point at its assets).
  const BASE = (() => { try { return new URL('.', doc.URL).href; } catch { return ''; } })();
  const Offline = W.OfflineAudioContext;
  const RATE = 48000;            // replacements are rendered once at this rate; a context at another rate resamples on playback
  const MAX_FRAMES = 40, FADE = 0.03, MATCH_DB = [-48, 12];   // a match outside this means a bad measurement: clamp it
  const stats = { events: {}, swapped: {}, own: {}, unmatched: 0, early: 0, notReady: 0, dropped: 0 };

  // ---- Where a node was made: the game's frames, innermost first ----
  // A frame's file relative to the game folder ("js/audio.js"; "index.html" for the page's inline scripts; a
  // `//# sourceURL=` name as written), or null for anything else (this script, other origins, native code, eval).
  function rel(url) {
    if (!url) return null;
    if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) return url.replace(/^\.?\//, '');
    const clean = url.split(/[?#]/)[0];
    if (clean === SELF || !BASE || !clean.startsWith(BASE)) return null;
    try { return decodeURIComponent(clean.slice(BASE.length)) || 'index.html'; } catch { return null; }
  }
  const STACK_LINE = /^\s*(?:at\s+)?(?:(?:async\s+)?(.*?)\s*\(|(.*?)@)?(\S+?):(\d+):(\d+)\)?\s*$/;
  function callsites() {
    const E = Error, lim = E.stackTraceLimit, prep = E.prepareStackTrace;
    let raw;
    try {
      E.stackTraceLimit = MAX_FRAMES;
      if (typeof E.captureStackTrace === 'function') { E.prepareStackTrace = (_, s) => s; const holder = {}; E.captureStackTrace(holder, callsites); raw = holder.stack; }
      else raw = new E().stack;
    } catch { raw = null; } finally { E.stackTraceLimit = lim; E.prepareStackTrace = prep; }
    const out = [];
    if (Array.isArray(raw)) {   // V8 structured call sites
      for (const c of raw) {
        const file = rel(c.getScriptNameOrSourceURL ? c.getScriptNameOrSourceURL() : c.getFileName());
        if (file) out.push({ file, line: c.getLineNumber(), col: c.getColumnNumber(), name: c.getFunctionName() || c.getMethodName() || null });
      }
    } else if (typeof raw === 'string') {   // other engines: "at name (url:1:2)" or "name@url:1:2"
      for (const l of raw.split('\n')) {
        const m = STACK_LINE.exec(l); if (!m) continue;
        const file = rel(m[3]);
        if (file) out.push({ file, line: +m[4], col: +m[5], name: (m[1] || m[2] || '').replace(/^new /, '') || null });
      }
    }
    return out;
  }
  const frameKey = f => `${f.file}:${f.line}:${f.col}`;

  // ---- Bursts: nodes made in one task ----
  let burst = 0, burstSeq = 0, nodeSeq = 0;
  const open = new Map();   // "<burst>|<sound id>" -> event, while the burst lasts
  function currentBurst() {
    if (!burst) { const b = burst = ++burstSeq; queueMicrotask(() => { if (burst === b) burst = 0; for (const k of [...open.keys()]) if (k.startsWith(b + '|')) open.delete(k); hook('burstEnd', b); }); }
    return burst;
  }
  function hook(name, ...a) { if (CAP && typeof CAP[name] === 'function') try { CAP[name](...a); } catch (e) { console.warn('code-sounds capture:', e); } }

  // ---- The sounds: patterns, replacements ----
  const patterns = new Map();   // "frame|frame|..." -> sound id
  const sounds = new Map();     // id -> {id, def (resolved), code, swap, rendered: {channels, gain}|null, state: WeakMap ctx -> {...}}
  let maxLen = 0, active = false, loaded = false, section = null;
  const contexts = new Set();
  function match(frames) {
    let key = '';
    for (let k = 0; k < frames.length && k < maxLen; k++) { key = k ? key + '|' + frames[k] : frames[k]; const id = patterns.get(key); if (id) return id; }
    return null;
  }
  function setSection(next) {
    section = next && typeof next === 'object' ? next : null;
    patterns.clear(); sounds.clear(); maxLen = 0;
    for (const [id, raw] of Object.entries((section && section.sounds) || {})) {
      const code = raw && raw.code;
      if (!code || raw.editable === false || !Array.isArray(code.sig)) continue;
      let def;
      try { def = resolveManifest({ sounds: { [id]: raw } }, { presets: kit.presets }).sounds[id]; } catch (e) { console.warn(`code-sounds: "${id}":`, e.message); continue; }
      for (const p of code.sig) if (Array.isArray(p) && p.length && p.every(f => typeof f === 'string')) { patterns.set(p.join('|'), id); maxLen = Math.max(maxLen, p.length); }
      // While src is still {file: code.preview} the game plays its own synth (the file is only Studio's preview).
      const snd = { id, raw, def, code, swap: codeState(raw) === 'replaced', rendered: null, state: new WeakMap(), buffers: new WeakMap() };
      sounds.set(id, snd);
      if (snd.swap) render(snd);
    }
    active = patterns.size > 0;
  }

  // ---- Rendering a replacement (once, at RATE; files are decoded asynchronously) ----
  const PRESETS = kit.presets;
  const SEEN = () => (W.__GF_ASSETS_SEEN = W.__GF_ASSETS_SEEN || []);
  const seen = p => { const s = SEEN(); if (!s.includes(p)) s.push(p); };
  function dataBytes(u) {
    const comma = u.indexOf(','), meta = u.slice(5, comma), body = u.slice(comma + 1);
    if (!/;base64$/i.test(meta)) return new TextEncoder().encode(decodeURIComponent(body)).buffer;
    const bin = atob(body), out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out.buffer;
  }
  // A game file's bytes: Studio's override, the packed copy, or the file next to the page (never fetch() a data: URL:
  // the packed page's policy blocks it).
  async function fileBytes(path) {
    const O = W.__GF_ASSET_OVERRIDES || {}, F = W.__GF_FILES || null;
    const v = (O.files && O.files[path]) || (F && F[path]);
    seen(path);
    if (typeof v === 'string' && v.startsWith('data:')) return dataBytes(v);
    if (F) throw new Error(`${path} is not in this page`);
    const res = await fetch(new URL(path, BASE).href, { cache: 'no-store' });
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
    return res.arrayBuffer();
  }
  let decoder = null;
  async function decodeFile(path) {
    decoder = decoder || new Offline(1, 1, RATE);
    const b = await decoder.decodeAudioData(await fileBytes(path));
    return Array.from({ length: b.numberOfChannels }, (_, c) => b.getChannelData(c));
  }
  // {file, start, end} plays only that slice (gf-audio 1.4.0), cut like the kit cuts it.
  function slice(channels, src) {
    if (src.start === undefined && src.end === undefined) return channels;
    const n = channels[0].length, from = Math.min(n, Math.round((src.start || 0) * RATE)), to = src.end === undefined ? n : Math.min(n, Math.round(src.end * RATE));
    if (to <= from) throw new Error(`slice ${src.start || 0}-${src.end ?? 'end'} s is outside the file`);
    return channels.map(ch => ch.subarray(from, to));
  }
  async function renderSrc(src) {
    if (src.layers) {
      const parts = await Promise.all(src.layers.map(async l => ({ channels: await renderSrc(l), gainDb: l.gainDb, delayMs: l.delayMs })));
      return mixLayers(parts, RATE);
    }
    if (src.zzfx) return [buildSamples(src.zzfx, { sampleRate: RATE, random: () => 0.5 })];
    if (src.file) return slice(await decodeFile(src.file), src);
    throw new Error('no source');
  }
  function render(snd) {
    snd.rendered = null;
    const job = Promise.all(snd.def.src.map(renderSrc)).then(variations => {
      if (sounds.get(snd.id) !== snd) return;
      // Match the original's loudness (its loudest 400 ms, measured on its recording), then the sound's own gainDb.
      const lufs = measure(variations[0], RATE, { truePeak: false }).momentaryMaxLufs;
      const lvl = typeof snd.code.level === 'number' && typeof lufs === 'number' ? Math.min(MATCH_DB[1], Math.max(MATCH_DB[0], snd.code.level - lufs)) : 0;
      snd.rendered = { channels: variations, gain: dbToGain(lvl) * dbToGain(snd.def.gainDb || 0), matchDb: Math.round(lvl * 10) / 10 };
    });
    job.catch(e => console.warn(`code-sounds: could not render "${snd.id}":`, e && e.message));
    snd.job = job;
    return job;
  }
  function buffersFor(snd, ctx) {
    let list = snd.buffers.get(ctx);
    if (!list) {
      list = snd.rendered.channels.map(chs => { const b = oCreateBuffer.call(ctx, chs.length, Math.max(1, chs[0].length), RATE); chs.forEach((ch, i) => b.getChannelData(i).set(ch)); return b; });
      snd.buffers.set(ctx, list);
    }
    return list;
  }

  // ---- Events and swaps ----
  const sinks = new WeakMap();
  function sinkOf(ctx) {
    let s = sinks.get(ctx);
    if (!s) { s = oCreateGain.call(ctx); s.gain.value = 0; oConnect.call(s, ctx.destination); sinks.set(ctx, s); }
    return s;
  }
  function seeCtx(ctx) {
    if (contexts.has(ctx)) return;
    if (contexts.size < 16) contexts.add(ctx);
    hook('context', ctx);
  }
  const nodes = new WeakMap();   // node -> {ctx, burst, kind, frames, sound, ev}
  function track(node, ctx, kind) {
    if (!node || !ctx || (Offline && ctx instanceof Offline)) return;
    seeCtx(ctx);
    const b = currentBurst(), info = { ctx, burst: b, kind, frames: null, sound: null, ev: null };
    nodes.set(node, info);
    if (!active && !CAP) { if (!loaded) stats.early++; return; }
    const cs = callsites();
    info.frames = cs.map(frameKey);
    if (CAP) { info.id = ++nodeSeq; hook('node', node, { id: info.id, burst: b, kind, frames: info.frames, names: cs.map(f => f.name), ctx }); }
    if (!active) { if (!loaded) stats.early++; return; }
    const id = match(info.frames);
    if (!id) { stats.unmatched++; return; }
    const key = b + '|' + id;
    let ev = open.get(key);
    if (!ev) {
      const snd = sounds.get(id);
      ev = { id, ctx, burst: b, swap: false, exit: null, voice: null, live: 0 };
      if (snd.swap) { if (snd.rendered) ev.swap = true; else stats.notReady++; }
      open.set(key, ev);
      stats.events[id] = (stats.events[id] || 0) + 1;
      if (!ev.swap) stats.own[id] = (stats.own[id] || 0) + 1;
    }
    info.sound = id; info.ev = ev;
  }
  function exitTo(ev, dest) {
    if (ev.exit) return;
    ev.exit = dest;
    const v = ev.voice;
    if (v && v.out && !v.connected) { oConnect.call(v.out, dest); v.connected = true; }
  }
  function fade(v, sec = FADE) {
    if (!v || v.stopping) return;
    v.stopping = true;
    const t = v.ctx.currentTime;
    try { v.g.gain.cancelScheduledValues(t); v.g.gain.setValueAtTime(v.g.gain.value, t); v.g.gain.linearRampToValueAtTime(0, t + sec); v.src.stop(t + sec + 0.01); } catch {}
  }
  const loops = new Set();
  let loopTimer = 0;
  function watchLoops() {
    if (loopTimer) return;
    loopTimer = setInterval(() => {
      for (const st of loops) {
        const v = st.loop, gap = Math.max(1, 3 * (st.period || 0));
        if (!v || v.stopping) { loops.delete(st); continue; }
        if (st.live <= 0 && v.ctx.currentTime - st.lastEvent > gap) { fade(v, 0.3); loops.delete(st); }
      }
      if (!loops.size) { clearInterval(loopTimer); loopTimer = 0; }
    }, 250);
  }
  function stateOf(snd, ctx) {
    let st = snd.state.get(ctx);
    if (!st) { st = { voices: [], lastStart: -1e9, lastEvent: 0, live: 0, loop: null, lastVariant: -1, period: snd.code.period }; snd.state.set(ctx, st); }
    return st;
  }
  // The first start() of a swapped event plays the replacement (once per event), when the original would have sounded.
  function playFor(ev, when) {
    const snd = sounds.get(ev.id);
    if (!snd || !snd.rendered) return;
    const ctx = ev.ctx, def = snd.def, st = stateOf(snd, ctx), t = Math.max(ctx.currentTime, Number(when) || 0);
    st.lastEvent = ctx.currentTime;
    if (def.loop && st.loop && !st.loop.stopping) { ev.voice = st.loop; return; }
    if (!def.loop && def.cooldownMs && t - st.lastStart < def.cooldownMs / 1000) { ev.voice = { dropped: true }; stats.dropped++; return; }
    st.voices = st.voices.filter(v => !v.ended && !v.stopping);
    while (st.voices.length >= def.maxVoices) fade(st.voices.shift());
    const list = buffersFor(snd, ctx);
    let vi = 0;
    if (list.length > 1) { do vi = Math.floor(Math.random() * list.length); while (vi === st.lastVariant); }
    st.lastVariant = vi;
    const src = oCreateBufferSource.call(ctx), g = oCreateGain.call(ctx);
    src.buffer = list[vi]; src.loop = !!def.loop;
    src.playbackRate.value = def.pitch * (def.pitchJitter ? 1 + (Math.random() * 2 - 1) * def.pitchJitter : 1);
    g.gain.value = snd.rendered.gain * dbToGain(def.gainJitterDb ? (Math.random() * 2 - 1) * def.gainJitterDb : 0);
    oConnect.call(src, g);
    const v = { src, g, out: g, ctx, connected: false, stopping: false, ended: false };
    src.addEventListener('ended', () => { v.ended = true; });
    ev.voice = v;
    if (ev.exit) { oConnect.call(g, ev.exit); v.connected = true; }
    oStart.call(src, t);
    if (def.loop) { st.loop = v; loops.add(st); watchLoops(); } else { st.lastStart = t; st.voices.push(v); }
    stats.swapped[ev.id] = (stats.swapped[ev.id] || 0) + 1;
  }
  function started(node, info, when) {
    const ev = info.ev, snd = sounds.get(ev.id);
    const st = snd ? stateOf(snd, ev.ctx) : null;
    ev.live++; if (st) { st.live++; st.lastEvent = ev.ctx.currentTime; }
    node.addEventListener('ended', () => { ev.live--; if (st) st.live--; }, { once: true });
    if (ev.swap && !ev.voice) playFor(ev, when);
  }

  // ---- Wrapping Web Audio ----
  const AN = AudioNode.prototype, oConnect = AN.connect, oDisconnect = AN.disconnect;
  const BAC = (W.BaseAudioContext || W.AudioContext).prototype;
  const oCreateGain = BAC.createGain, oCreateBufferSource = BAC.createBufferSource, oCreateBuffer = BAC.createBuffer;
  const ASN = W.AudioScheduledSourceNode && W.AudioScheduledSourceNode.prototype;
  const oStart = (W.AudioBufferSourceNode.prototype.start) || (ASN && ASN.start);
  const FACTORIES = ['createOscillator', 'createBufferSource', 'createConstantSource', 'createGain', 'createBiquadFilter', 'createIIRFilter', 'createDelay',
    'createDynamicsCompressor', 'createWaveShaper', 'createStereoPanner', 'createPanner', 'createConvolver', 'createChannelMerger', 'createChannelSplitter',
    'createAnalyser', 'createScriptProcessor', 'createMediaElementSource', 'createMediaStreamSource'];
  const CTORS = ['OscillatorNode', 'AudioBufferSourceNode', 'ConstantSourceNode', 'GainNode', 'BiquadFilterNode', 'IIRFilterNode', 'DelayNode', 'DynamicsCompressorNode',
    'WaveShaperNode', 'StereoPannerNode', 'PannerNode', 'ConvolverNode', 'ChannelMergerNode', 'ChannelSplitterNode', 'AnalyserNode', 'AudioWorkletNode',
    'MediaElementAudioSourceNode', 'MediaStreamAudioSourceNode'];
  for (const proto of [W.BaseAudioContext && W.BaseAudioContext.prototype, W.AudioContext && W.AudioContext.prototype]) {
    if (!proto) continue;
    for (const name of FACTORIES) {
      if (!Object.prototype.hasOwnProperty.call(proto, name) || typeof proto[name] !== 'function') continue;
      const orig = proto[name], kind = name.slice(6);
      proto[name] = function (...a) { const node = orig.apply(this, a); try { track(node, this, kind); } catch (e) { console.warn('code-sounds:', e); } return node; };
    }
  }
  for (const name of CTORS) {
    const C = W[name];
    if (typeof C !== 'function') continue;
    const kind = name.replace(/(Audio)?(Node)$/, '').replace(/^AudioBufferSource$/, 'BufferSource');
    W[name] = new Proxy(C, { construct(target, a, nt) { const node = Reflect.construct(target, a, nt); try { track(node, a[0], kind); } catch (e) { console.warn('code-sounds:', e); } return node; } });
  }
  for (const name of ['AudioContext', 'webkitAudioContext']) {
    const C = W[name];
    if (typeof C !== 'function') continue;
    W[name] = new Proxy(C, { construct(target, a, nt) { const ctx = Reflect.construct(target, a, nt); try { seeCtx(ctx); } catch {} return ctx; } });
  }
  AN.connect = function (dest, ...rest) {
    const info = nodes.get(this);
    if (CAP && info) hook('connect', this, dest, info, dest instanceof AudioNode ? nodes.get(dest) || null : null);
    const ev = info && info.ev;
    if (ev && ev.swap) {
      const d = dest instanceof AudioNode ? nodes.get(dest) : null;
      if (!(d && d.sound === ev.id)) {   // a way out of the sound: into the muted sink instead
        if (dest instanceof AudioNode) { exitTo(ev, dest); oConnect.call(this, sinkOf(info.ctx), rest[0] || 0); (info.redirected = info.redirected || new Set()).add(dest); return dest; }
        (info.skipped = info.skipped || new Set()).add(dest);   // an AudioParam outside the sound: a swapped sound modulates nothing
        return undefined;
      }
    }
    return oConnect.call(this, dest, ...rest);
  };
  AN.disconnect = function (...a) {
    const info = nodes.get(this), d = a[0];
    if (info && d && info.redirected && info.redirected.has(d)) { info.redirected.delete(d); if (!info.redirected.size) try { oDisconnect.call(this, sinkOf(info.ctx)); } catch {} return; }
    if (info && d && info.skipped && info.skipped.has(d)) { info.skipped.delete(d); return; }
    return oDisconnect.apply(this, a);
  };
  // Chrome defines start() on AudioBufferSourceNode as well as AudioScheduledSourceNode: wrap every prototype that owns one.
  for (const C of [W.AudioScheduledSourceNode, W.AudioBufferSourceNode, W.OscillatorNode, W.ConstantSourceNode]) {
    const p = C && C.prototype;
    if (!p || !Object.prototype.hasOwnProperty.call(p, 'start')) continue;
    const orig = p.start;
    p.start = function (...a) {
      const info = nodes.get(this);
      if (info) { if (CAP) hook('start', this, a, info); if (info.ev) try { started(this, info, a[0]); } catch (e) { console.warn('code-sounds:', e); } }
      return orig.apply(this, a);
    };
  }

  // ---- The manifest ----
  const clone = v => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
  function merged(m) {
    if (!m || !m.sounds) return null;
    const O = W.__GF_ASSET_OVERRIDES || {}, out = clone(m.sounds);
    out.sounds = out.sounds || {};
    // The active variant (its select.query matches the page's query) may override sounds by id, as gf-assets does.
    const q = new URLSearchParams((W.location && W.location.search) || '');
    const v = (m.variants || []).find(x => [...new URLSearchParams((x.select && x.select.query) || '')].every(([k, val]) => q.get(k) === val));
    if (v && v.sounds) Object.assign(out.sounds, clone(v.sounds));
    if (O.sounds) for (const [id, def] of Object.entries(O.sounds)) { if (def === null) delete out.sounds[id]; else out.sounds[id] = clone(def); }
    return out;
  }
  async function load() {
    const F = W.__GF_FILES || null;
    let m = F && F['assets.json'];
    if (typeof m === 'string') m = JSON.parse(m.startsWith('data:') ? new TextDecoder().decode(dataBytes(m)) : m);
    if (!m && !F) { const res = await fetch(new URL('assets.json', BASE).href, { cache: 'no-store' }); m = res.ok ? await res.json() : null; }
    const s = merged(m);
    if (s && Object.values(s.sounds).some(x => x && x.code)) seen('assets.json');
    setSection(s);
    return s;
  }
  const ready = load().catch(e => { console.warn('code-sounds: no sounds:', e && e.message); return null; }).finally(() => { loaded = true; });
  W.addEventListener('message', e => {
    if (e.source !== W.parent || W.parent === W) return;
    const d = e.data;
    if (d && d.type === 'gf-audio:update' && d.manifest && typeof d.manifest === 'object') setSection(clone(d.manifest));
    else if (d && d.type === 'gf-audio:set' && typeof d.id === 'string' && section) {
      const had = section.sounds && section.sounds[d.id];
      if (!(had && had.code) && !(d.def && d.def.code)) return;   // not a code sound: the audio kit handles it
      const next = clone(section); next.sounds = next.sounds || {};
      if (d.def) next.sounds[d.id] = clone(d.def); else delete next.sounds[d.id];
      setSection(next);
    }
  });

  W.__GF_CODE_SOUNDS = {
    version: VERSION, stats, ready,
    get sounds() { return [...sounds.values()].map(s => ({ id: s.id, swap: s.swap, ready: !!s.rendered, matchDb: s.rendered ? s.rendered.matchDb : null })); },
    match: frames => match(frames),
    whenRendered: () => Promise.all([...sounds.values()].map(s => s.job).filter(Boolean)).catch(() => {}),
  };
})();
