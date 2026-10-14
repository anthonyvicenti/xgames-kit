// Audio QA gate v5 (2026-10-11). Same API as v4 (installAudioTap, resetAudioTap, audioReport) and the same targets for
// everything that says "too loud", harsh, clipped, piled up or playing while hidden. One thing is judged differently:
// QUIET. v1 to v4 are unchanged for the games and scripts that import them.
//
// What v4 did: the loudest 400 ms of the capture had to reach -32 LUFS (MIX_TARGETS.momentaryMaxLufs, "the loudest
// moment must be clearly audible"). A 400 ms block is a window of time, not a sound: a 90 ms click fills under a
// quarter of it, so the same click at the same level reads about 6 LU lower than a sound that lasts, and a game whose
// sounds never overlap (one disc landing a turn, one coin a press) reads lower again than a round where three things
// sound at once. Board and panel games failed by 0.5 to 4 LU with every sound playing at the kit's own level
// (research/open-builder/findings/audio-gate-v5-2026-10-11.md has the measurements).
//
// What v5 does, in two parts that must both hold:
//   1. Loudness where a sound plays. `soundMaxLufs` is the loudest 100 ms (K-weighted as BS.1770, 10 ms steps): the
//      level of the loudest sound while it sounds. It has the SAME floor, -32 LUFS. The loudest 100 ms of a capture is
//      never quieter than its loudest 400 ms, so no capture that passed v4's floor fails this one; a sound mixed too low
//      still fails, however short or long it is. The kit's bus levels and presets are not touched and must not be raised
//      to pass (CLAUDE.md, Audio).
//   2. The sounds are really there. A floor read on 100 ms alone would let one stray click carry a silent game, so v5
//      also holds what v4 only counted:
//        heard        something reached the speakers (peak above -60 dBFS), as v4;
//        sounds       at least MIN_SOUNDS separate sounds started in the capture (merged starts, as v4 counts them) and
//                     at least MIN_DISTINCT of them were different sounds (different buffers, or oscillators);
//        audible      at least AUDIBLE_SHARE of the sounds that started put something above SOUND_AUDIBLE_DB at the
//                     speakers in the 300 ms after they started (a sound that is listed, started and gives nothing: a
//                     dead file, a zero gain, a muted bus);
//        listed       when the caller says which sounds the game lists (opts.listed: [{id, bus}], assets.json → sounds)
//                     and the page says which it played (opts.played: {id: count}, the kit's own count), the ids that
//                     played and the ids that never did are in the report, and the game's OWN sounds must be among
//                     the ones heard: the listed sounds that are not on the "ui" bus (the interface's clicks and the
//                     countdown are the kit's; a mechanic's, a flow's and the rules' sounds are the game's). A game
//                     that lists two or more sounds of its own and played none of them in the round fails, however
//                     loud the countdown was (a lone own sound is not judged: MIN_OWN_LISTED). With no count from the page (an older kit copy) this part is not judged, and
//                     the report says so.
// A silent game fails (nothing heard, no sounds). A game with every sound at -40 fails (the floor). A game whose single
// sounds play at the kit's level passes whether or not they overlap.
//
// The report is v4's with: soundMaxLufs, activeLufs (the mean loudness over the 100 ms blocks in which something
// sounds: reported, not judged), sounds: {started, distinct, audible, silent, share}, listed: {ids, played, never} when
// given, and `floor` (which number the quiet verdict came from). `problems` uses v4's wording for v4's problems.
import { measure, grade, MIX_TARGETS } from '../gf-audio/source/meter.mjs'; // frozen targets (v3's and v4's)
import { maxPerWindow, mergeStarts, MAX_SOUNDS_PER_100MS, MERGE_MS, WINDOW_MS } from './qa-gate-v4.mjs';

export { maxPerWindow, mergeStarts, MAX_SOUNDS_PER_100MS, MERGE_MS, WINDOW_MS };
/** The floor for the loudest sound while it sounds: v4's -32 LUFS, read on 100 ms where v4 read 400 ms. */
export const SOUND_FLOOR_LUFS = MIX_TARGETS.momentaryMaxLufs.min;
/** A capture must hold at least this many separate sounds, of at least this many different kinds. */
export const MIN_SOUNDS = 2, MIN_DISTINCT = 2;   // measured: a tag round that passes v4 starts 3 or 4 sounds, a panel game 2; one stray click is 1
/** The listed-sounds rule is judged when the game lists at least this many sounds of its own: a lone one is as a rule the
 *  win jingle, and whether that plays in a 25 s round says who won, not whether the game's sounds work (measured: Coin
 *  Corner lists one, round-win, and its idle test player loses). */
export const MIN_OWN_LISTED = 2;
/** A started sound counts as audible when the 300 ms after its start peak above this (dBFS), and this share must be. */
export const SOUND_AUDIBLE_DB = -50, AUDIBLE_SHARE = 0.8, SOUND_WINDOW_MS = 300;
const BLOCK_S = 0.1, STEP_S = 0.01;

// K-weighting as kit/meter.mjs does it (BS.1770-4: a +4 dB shelf at 1.5 kHz, then a 38 Hz high-pass). The frozen meter
// does not export its filters; these are the same coefficients, so 100 ms blocks and its 400 ms blocks share a scale.
function biquad(x, [b0, b1, b2, a1, a2]) {
  const y = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) { const v = b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2; x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v; }
  return y;
}
function shelf(fs, fc = 1500, gainDb = 4, Q = Math.SQRT1_2) {
  const A = 10 ** (gainDb / 40), w = 2 * Math.PI * fc / fs, c = Math.cos(w), al = Math.sin(w) / (2 * Q), sA = 2 * Math.sqrt(A) * al;
  const a0 = (A + 1) - (A - 1) * c + sA;
  return [A * ((A + 1) + (A - 1) * c + sA) / a0, -2 * A * ((A - 1) + (A + 1) * c) / a0, A * ((A + 1) + (A - 1) * c - sA) / a0, 2 * ((A - 1) - (A + 1) * c) / a0, ((A + 1) - (A - 1) * c - sA) / a0];
}
function highpass(fs, fc, Q) {
  const w = 2 * Math.PI * fc / fs, c = Math.cos(w), al = Math.sin(w) / (2 * Q), a0 = 1 + al;
  return [(1 + c) / 2 / a0, -(1 + c) / a0, (1 + c) / 2 / a0, -2 * c / a0, (1 - al) / a0];
}
const lufsOf = p => (p > 0 ? -0.691 + 10 * Math.log10(p) : -Infinity);
const r1 = x => (Number.isFinite(x) ? Math.round(x * 10) / 10 : null);

/**
 * Loudness where sounds play. channels: one or two Float32Arrays. → {soundMaxLufs, activeLufs, activeSeconds}
 * soundMaxLufs: the loudest 100 ms block (K-weighted, channels summed as BS.1770 sums them); activeLufs: the mean
 * over the blocks above -70 LUFS and within 20 LU of the loudest (the stretches in which a sound is playing).
 */
export function soundLevels(channels, sampleRate) {
  const chs = Array.isArray(channels) ? channels : [channels], n = chs[0]?.length ?? 0;
  const bl = Math.round(BLOCK_S * sampleRate), st = Math.max(1, Math.round(STEP_S * sampleRate));
  if (n < bl) return { soundMaxLufs: null, activeLufs: null, activeSeconds: 0 };
  const pre = chs.map(ch => { const k = biquad(biquad(ch, shelf(sampleRate)), highpass(sampleRate, 38, 0.5)); const a = new Float64Array(n + 1); for (let i = 0; i < n; i++) a[i + 1] = a[i] + k[i] * k[i]; return a; });
  let max = 0; const ps = [];
  for (let s = 0; s + bl <= n; s += st) { let p = 0; for (const a of pre) p += (a[s + bl] - a[s]) / bl; ps.push(p); if (p > max) max = p; }
  const top = lufsOf(max), act = ps.filter(p => lufsOf(p) > -70 && lufsOf(p) > top - 20);
  return { soundMaxLufs: r1(top), activeLufs: act.length ? r1(lufsOf(act.reduce((a, b) => a + b, 0) / act.length)) : null, activeSeconds: Math.round(act.length * STEP_S * 10) / 10 };
}

/**
 * Which started sounds reached the speakers. events: [{at (ms since the capture began), kind}], channels as above.
 * → {started, distinct, audible, silent, share}: started counts merged sounds (starts within MERGE_MS are one), distinct
 * the different kinds among them, audible those with a peak above SOUND_AUDIBLE_DB in the SOUND_WINDOW_MS after.
 */
export function soundsHeard(channels, sampleRate, events) {
  const chs = Array.isArray(channels) ? channels : [channels], n = chs[0]?.length ?? 0;
  const ev = [...events].sort((a, b) => a.at - b.at), merged = [];
  for (const e of ev) { const last = merged.at(-1); if (last && e.at - last.last <= MERGE_MS) { last.last = e.at; last.kinds.add(e.kind); } else merged.push({ at: e.at, last: e.at, kinds: new Set([e.kind]) }); }
  const lim = 10 ** (SOUND_AUDIBLE_DB / 20);
  let audible = 0, measured = 0;
  for (const m of merged) {
    const a = Math.max(0, Math.round(m.at / 1000 * sampleRate)), b = Math.min(n, a + Math.round(SOUND_WINDOW_MS / 1000 * sampleRate));
    if (a >= n) continue;                       // it started after the capture ended
    measured++;
    let hit = false;
    for (const ch of chs) { for (let i = a; i < b; i++) if (Math.abs(ch[i]) > lim) { hit = true; break; } if (hit) break; }
    if (hit) audible++;
  }
  const kinds = new Set(merged.flatMap(m => [...m.kinds]));
  return { started: merged.length, distinct: kinds.size, audible, silent: measured - audible, share: measured ? Math.round(audible / measured * 100) / 100 : 0 };
}

/** A listed sound as {id, bus}: an id alone is taken as a sound of the game's own. */
const asListed = listed => (listed ?? []).map(x => (typeof x === 'string' ? { id: x, bus: 'sfx' } : { id: x.id, bus: x.bus ?? 'sfx' }));
/** The game's own sounds among the listed ones: every one that is not an interface sound (bus "ui"). → ids */
export const ownSounds = listed => asListed(listed).filter(x => x.bus !== 'ui').map(x => x.id);

/**
 * The quiet verdict of v5, on numbers alone (so a test can hold it). mix: the meter's stats; levels: soundLevels();
 * sounds: soundsHeard(); listed/played: optional ids. → the problems (v4's other problems are not made here)
 */
export function quietProblems({ heard, levels, sounds, listed = null, played = null }) {
  const own = ownSounds(listed);
  const p = [];
  if (!heard) { p.push('nothing was heard: no sound reached the speakers in the round'); return p; }
  if (levels.soundMaxLufs === null || levels.soundMaxLufs < SOUND_FLOOR_LUFS) p.push(`soundMaxLufs ${levels.soundMaxLufs} < ${SOUND_FLOOR_LUFS} (the loudest sound, over the 100 ms it is loudest, is too quiet to hear clearly: the sound's own gainDb is too low or it never played at full level; the kit's bus levels stay as they are)`);
  if (sounds.started < MIN_SOUNDS) p.push(`${sounds.started} sound${sounds.started === 1 ? '' : 's'} started in the round (needs ${MIN_SOUNDS}): the game's sounds are listed but almost nothing plays them`);
  else if (sounds.distinct < MIN_DISTINCT) p.push(`every sound that started was the same one (${sounds.started} starts, ${sounds.distinct} kind; needs ${MIN_DISTINCT} different sounds)`);
  if (sounds.started && sounds.share < AUDIBLE_SHARE) p.push(`${sounds.silent} of ${sounds.audible + sounds.silent} sounds that started put nothing at the speakers (a dead file, a gain of zero or a muted bus)`);
  if (own.length >= MIN_OWN_LISTED && played && !own.some(id => (played[id] ?? 0) > 0)) p.push(`the game lists ${own.length} sound${own.length === 1 ? '' : 's'} of its own (${own.slice(0, 6).join(', ')}) and played none of them in the round (what played: ${Object.keys(played).filter(id => played[id] > 0).join(', ') || 'nothing'}): the mechanics and rules never reach ctx.audio.play with these ids, or nothing in the round triggers them`);
  return p;
}

// Runs in the page before any game code (addInitScript). v4's tap, line for line, with one addition: each start also
// records what kind of sound it is (a number per AudioBuffer, or the oscillator's type), so sounds can be told apart.
export const TAP = () => {
  const WORKLET = `registerProcessor('gf-audio-tap', class extends AudioWorkletProcessor {
    constructor() { super(); this.n = 0; this.L = new Float32Array(4096); this.R = new Float32Array(4096); }
    process(inputs) {
      const ch = inputs[0], l = ch && ch[0], r = (ch && ch[1]) || l;
      for (let i = 0, n = l ? l.length : 128; i < n; i++) { // no input (nothing connected right now) records silence, so time keeps its length
        this.L[this.n] = l ? l[i] : 0; this.R[this.n] = r ? r[i] : 0;
        if (++this.n === 4096) { this.port.postMessage([this.L, this.R], [this.L.buffer, this.R.buffer]); this.L = new Float32Array(4096); this.R = new Float32Array(4096); this.n = 0; }
      }
      return true;
    }
  });`;
  const W = window, st = W.__audioTap = { ran: false, tapKind: null, tapNote: null, ctxs: [], contexts: 0, starts: [], osc: {}, media: 0, chunks: [], rate: 0, hiddenChunks: [], phase: 'play', t0: performance.now(), tAudio: null };
  const taps = new WeakMap(), kinds = new WeakMap(); let nextKind = 1;
  const origConnect = AudioNode.prototype.connect, origDisconnect = AudioNode.prototype.disconnect;
  function tapFor(ctx) {
    let t = taps.get(ctx);
    if (t) return t;
    st.contexts++; st.ctxs.push(ctx); st.rate = ctx.sampleRate;
    const g = ctx.createGain();
    origConnect.call(g, ctx.destination);
    try { const keep = ctx.createConstantSource(); keep.offset.value = 0; origConnect.call(keep, g); keep.start(); } catch {}
    t = { g }; taps.set(ctx, t);
    const take = (L, R) => {
      // tAudio: when the first kept chunk's first sample sounded, so a start's time can be laid on the recording
      if (st.phase === 'play') { if (st.tAudio === null) st.tAudio = performance.now() - L.length / ctx.sampleRate * 1000; st.chunks.push([L, R]); if (ctx.state === 'running') st.ran = true; }
      else if (st.phase === 'hidden') st.hiddenChunks.push([L, R]);
    };
    const fallback = why => {
      st.tapKind = 'script-processor'; st.tapNote = why;
      const sp = ctx.createScriptProcessor(4096, 2, 2);
      sp.onaudioprocess = e => take(e.inputBuffer.getChannelData(0).slice(), e.inputBuffer.getChannelData(1).slice());
      origConnect.call(g, sp); origConnect.call(sp, ctx.destination);
    };
    try {
      const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
      ctx.audioWorklet.addModule(url).then(() => {
        const node = new AudioWorkletNode(ctx, 'gf-audio-tap', { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 2, channelCountMode: 'explicit' });
        node.port.onmessage = e => take(e.data[0], e.data[1]);
        origConnect.call(g, node);
        st.tapKind ??= 'audio-worklet';
      }, e => fallback(`worklet: ${e?.message ?? e}`));
    } catch (e) { fallback(`worklet: ${e?.message ?? e}`); }
    return t;
  }
  AudioNode.prototype.connect = function (dest, ...rest) {
    if (dest instanceof AudioDestinationNode && !(W.OfflineAudioContext && dest.context instanceof W.OfflineAudioContext)) { origConnect.call(this, tapFor(dest.context).g, ...rest); return dest; }
    return origConnect.call(this, dest, ...rest);
  };
  AudioNode.prototype.disconnect = function (dest, ...rest) {
    if (dest instanceof AudioDestinationNode && !(W.OfflineAudioContext && dest.context instanceof W.OfflineAudioContext)) return origDisconnect.call(this, tapFor(dest.context).g, ...rest);
    return origDisconnect.call(this, dest, ...rest);
  };
  for (const C of [AudioScheduledSourceNode, AudioBufferSourceNode, OscillatorNode, ConstantSourceNode]) {
    if (!C || !Object.prototype.hasOwnProperty.call(C.prototype, 'start')) continue;
    const origStart = C.prototype.start;
    C.prototype.start = function (...a) {
      const now = performance.now(), when = a[0], lead = Number.isFinite(when) && when > 0 ? Math.max(0, when - this.context.currentTime) : 0;
      // the kind: one number per AudioBuffer (the same sound played twice is one kind), the type for an oscillator;
      // a constant source makes no sound of its own (the tap's own keep-alive is one) and is not a sound
      let kind = null;
      if (this instanceof OscillatorNode) kind = `osc:${this.type}`;
      else if (typeof AudioBufferSourceNode !== 'undefined' && this instanceof AudioBufferSourceNode && this.buffer) { if (!kinds.has(this.buffer)) kinds.set(this.buffer, nextKind++); kind = `buf:${kinds.get(this.buffer)}`; }
      if (!(W.OfflineAudioContext && this.context instanceof W.OfflineAudioContext)) st.starts.push([now, now + lead * 1000, kind]);
      if (this instanceof OscillatorNode) st.osc[this.type] = (st.osc[this.type] ?? 0) + 1;
      return origStart.apply(this, a);
    };
  }
  const origPlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function (...a) { st.media++; return origPlay.apply(this, a); };
};

export async function installAudioTap(page) {
  await page.addInitScript(TAP);
}

/** Start counting from now (drops loading/title-screen audio from the measurement). */
export async function resetAudioTap(page) {
  await page.evaluate(() => { const s = window.__audioTap; s.chunks = []; s.starts = []; s.t0 = performance.now(); s.tAudio = null; });
}

function decode(b64) {
  const buf = Buffer.from(b64, 'base64');
  const f = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4), n = f.length / 2;
  return [f.slice(0, n), f.slice(n)];
}

/**
 * Measure what was heard since installAudioTap/resetAudioTap, then run the hidden-tab check.
 * opts.listed: the sound ids the game lists (assets.json → sounds); opts.played: {id: count} as the page counted them
 * (the kit's audio.stats.plays), or a function (page) → that. Both optional. opts.raw: also return {L, R, rate, events}.
 */
export async function audioReport(page, { targets = MIX_TARGETS, hiddenSeconds = 3, listed = null, played = null, raw = false } = {}) {
  const playedNow = typeof played === 'function' ? await played(page).catch(() => null) : played;
  await page.evaluate(() => { window.__audioTap.t1 = performance.now(); window.__audioTap.phase = 'hidden';
    const hide = v => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => v }); Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (v ? 'hidden' : 'visible') }); };
    hide(true); document.dispatchEvent(new Event('visibilitychange')); window.__audioTapHide = hide; return performance.now(); });
  await page.waitForTimeout(hiddenSeconds * 1000);
  const data = await page.evaluate(() => {
    const s = window.__audioTap; s.phase = 'done';
    const suspended = s.ctxs.length > 0 && s.ctxs.every(c => c.state !== 'running'); // read before un-hiding
    window.__audioTapHide(false); document.dispatchEvent(new Event('visibilitychange'));
    const b64 = chunks => {
      const n = chunks.reduce((a, c) => a + c[0].length, 0), f = new Float32Array(n * 2); let o = 0;
      for (const [l] of chunks) { f.set(l, o); o += l.length; } for (const [, r] of chunks) { f.set(r, o); o += r.length; }
      const u = new Uint8Array(f.buffer); let str = ''; for (let i = 0; i < u.length; i += 0x8000) str += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
      return btoa(str);
    };
    return { ran: s.ran || s.ctxs.some(c => c.state === 'running'), tapKind: s.tapKind, tapNote: s.tapNote, suspended, contexts: s.contexts, starts: s.starts.filter(([t]) => t >= s.t0 && t <= s.t1), t0: s.t0, t1: s.t1, tAudio: s.tAudio, osc: s.osc, media: s.media, rate: s.rate, audio: b64(s.chunks), hidden: b64(s.hiddenChunks.slice(4)) };
  });
  const r = { gate: 'v5', tap: data.tapKind, tapNote: data.tapNote, contexts: data.contexts, mediaPlays: data.media, oscillatorTypes: data.osc };
  const secs = Math.max(0.001, (data.t1 - data.t0) / 1000);
  r.startsPerSec = Math.round(data.starts.length / secs * 10) / 10;
  const sounding = data.starts.map(([, at]) => at).sort((a, b) => a - b);
  r.maxStartsPer100ms = maxPerWindow(sounding);
  const merged = mergeStarts(sounding);
  r.soundsPerSec = Math.round(merged.sounds.length / secs * 10) / 10;
  r.maxSoundsPer100ms = maxPerWindow(merged.sounds);
  r.maxStartsPerSound = merged.maxStartsPerSound;
  const [L, R] = decode(data.audio);
  const rate = data.rate || 48000;
  r.mix = L.length ? measure([L, R], rate) : null;
  r.heard = !!(r.mix && r.mix.samplePeakDb !== null && r.mix.samplePeakDb > -60);
  const [hL, hR] = decode(data.hidden);
  const h = hL.length ? measure([hL, hR], rate, { truePeak: false }) : null;
  r.hidden = { seconds: h?.seconds ?? 0, suspended: data.suspended, audible: !data.suspended && !!(h && h.samplePeakDb !== null && h.samplePeakDb > -60) };
  // ---- v5: loudness where sounds play, and the sounds that started ----
  // a start is laid on the recording by the page's clock: tAudio is when the recording's first sample sounded
  const origin = data.tAudio ?? data.t0;
  const events = data.starts.filter(([, , kind]) => kind !== null).map(([, at, kind]) => ({ at: at - origin, kind }));
  const levels = L.length ? soundLevels([L, R], rate) : { soundMaxLufs: null, activeLufs: null, activeSeconds: 0 };
  const sounds = soundsHeard([L, R], rate, events);
  Object.assign(r, { soundMaxLufs: levels.soundMaxLufs, activeLufs: levels.activeLufs, activeSeconds: levels.activeSeconds, sounds });
  if (listed) { const ids = asListed(listed).map(x => x.id), own = ownSounds(listed); r.listed = { ids: ids.length, own: own.length, played: playedNow ? ids.filter(id => (playedNow[id] ?? 0) > 0) : null, ownPlayed: playedNow ? own.filter(id => (playedNow[id] ?? 0) > 0) : null, never: playedNow ? ids.filter(id => !(playedNow[id] > 0)) : null, counted: !!playedNow, ...(playedNow ? {} : { note: 'the page gives no count of what played (window.__game.sounds, an older kit copy): which listed sounds were heard is not judged' }) }; }
  // everything but the quiet floor is v4's grade, on v4's targets; the floor is v5's (quietProblems)
  const { momentaryMaxLufs: _floor, ...loudTargets } = targets;
  const g = r.mix ? grade(r.mix, loudTargets) : { ok: true, problems: [] };
  r.problems = [...g.problems];
  r.floor = { on: 'soundMaxLufs', min: SOUND_FLOOR_LUFS, v4: r.mix ? { momentaryMaxLufs: r.mix.momentaryMaxLufs, wouldPass: r.mix.momentaryMaxLufs !== null && r.mix.momentaryMaxLufs >= targets.momentaryMaxLufs.min } : null };
  if (data.contexts > 0 && data.ran) r.problems.push(...quietProblems({ heard: r.heard, levels, sounds, listed, played: playedNow }));
  if (r.hidden.audible) r.problems.push('sound keeps playing while the tab is hidden');
  if (r.maxSoundsPer100ms > MAX_SOUNDS_PER_100MS) r.problems.push(`${r.maxSoundsPer100ms} sounds started within 100 ms (${r.maxStartsPer100ms} node starts; starts within ${MERGE_MS} ms of each other count as one sound)`);
  if (data.contexts > 0 && !data.ran) r.problems.push('context never ran: no user gesture since load (a reload after installAudioTap?)');
  r.ok = r.problems.length === 0;
  if (raw) Object.defineProperty(r, 'raw', { enumerable: false, value: { L, R, rate, events, starts: data.starts, t0: data.t0, tAudio: data.tAudio } });
  return r;
}
