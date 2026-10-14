// Audio QA gate v4 (2026-10-01). Same API, exports and targets as v3. Changes: only the sound-start check.
//   - Each start is placed when it sounds, not when start() was called. start(when) with `when` after
//     ctx.currentTime sounds (when - currentTime) s after the call, so a melody scheduled 2 s ahead in one burst of
//     calls is spread over 2 s instead of counting as one pile-up.
//   - Starts that sound within 5 ms of the previous start are merged into one sound (a chord, a layered hit, a grain
//     train). The limit is the same 12 per 100 ms, now counted in merged sounds. A game with its own synth starts
//     dozens of nodes per sound (ponpoko-kart 28 starts per 100 ms, ZOMBIES-LAN 162) and failed v3 with every loudness
//     target in range.
//   - The report keeps `startsPerSec` and `maxStartsPer100ms` and adds the merged counts (see audioReport below).
// The loudness targets (frozen MIX_TARGETS import), meter, tap and hidden-tab check are v3's, line for line. v1 to v3
// are unchanged for the scripts that import them.
//
// Audio QA gate v3 (2026-09-26). Same API and targets as v2. Changes: the tap records continuously from context
// creation, including stretches where the game has nothing connected (engines that disconnect after each sound
// were measured as 0.2 s of audio), and a context that never ran is reported as a problem instead of a silent
// mix:null. v1 and v2 are unchanged for the scripts that import them.
//
// Audio QA gate v2 (2026-09-25). Same API and targets as qa-gate.mjs (v1, unchanged while the rollout uses it); the
// difference is the tap: an AudioWorklet instead of ScriptProcessorNode, so Chrome doesn't log
// "ScriptProcessorNode is deprecated" (QA scripts that fail on console warnings failed on the tap). Falls back to
// ScriptProcessorNode where worklets can't load; the report's `tap` says which one ran.
//
// Audio QA gate for a trial's qa.mjs (Playwright). Taps everything that reaches the speakers, then measures it
// against kit/meter.mjs MIX_TARGETS and checks that sound stops while the tab is hidden.
//
//   import { installAudioTap, audioReport } from '../../../audio/qa-gate-v4.mjs';
//   await installAudioTap(page);             // before page.goto
//   await page.goto(url); ...play the game with real input for 15-30 s...
//   const audio = await audioReport(page);   // {mix, hidden: {suspended, audible, seconds}, oscillatorTypes, ok, problems,
//                                            //  startsPerSec, maxStartsPer100ms, soundsPerSec, maxSoundsPer100ms, maxStartsPerSound}
//   check('audio within loudness targets', audio.ok, audio.problems.join('; '));
//
// What the start counts mean:
//   startsPerSec       raw AudioScheduledSourceNode.start() calls per second of the capture (v3's number; by call time).
//   maxStartsPer100ms  raw starts in the busiest 100 ms, each placed when it sounds (v4; v3 placed it at call time). A diagnostic:
//                      a game with its own synth reads high here without a problem.
//   soundsPerSec       merged sounds per second: starts within 5 ms of the previous start count once.
//   maxSoundsPer100ms  merged sounds in the busiest 100 ms. The gate: more than 12 is a problem.
//   maxStartsPerSound  the most raw starts merged into one sound (30 for a 30-oscillator chord).
//
// audioReport() ends the capture: it hides the page for 3 s to test the hidden-tab behaviour, then restores it.
import { measure, grade, MIX_TARGETS } from '../gf-audio/source/meter.mjs'; // frozen targets

// The sound-start limit: no more than MAX_SOUNDS_PER_100MS sounds in any 100 ms (v3's 12, unchanged). Starts that sound
// within MERGE_MS of the previous start are one sound.
export const MAX_SOUNDS_PER_100MS = 12, MERGE_MS = 5, WINDOW_MS = 100;

/** Most items of the ascending list `ts` (ms) within any `windowMs`. A span of exactly 100 ms counts, as in v3. */
export function maxPerWindow(ts, windowMs = WINDOW_MS) {
  let best = 0;
  for (let i = 0, j = 0; i < ts.length; i++) { while (ts[i] - ts[j] > windowMs) j++; best = Math.max(best, i - j + 1); }
  return best;
}

/**
 * Merge starts into sounds. `ts` are the times (ms) the starts sound, in any order. A start within `mergeMs` of the
 * previous start joins that start's sound, so a chord, a layered hit or a train of grains 4 ms apart is one sound.
 * Returns {sounds: ascending ms time of each sound's first start, maxStartsPerSound}.
 */
export function mergeStarts(ts, mergeMs = MERGE_MS) {
  const t = [...ts].sort((a, b) => a - b), sounds = [];
  let size = 0, maxStartsPerSound = 0;
  for (let i = 0; i < t.length; i++) {
    if (i > 0 && t[i] - t[i - 1] <= mergeMs) size++;
    else { sounds.push(t[i]); size = 1; }
    maxStartsPerSound = Math.max(maxStartsPerSound, size);
  }
  return { sounds, maxStartsPerSound };
}

// Runs in the page before any game code (addInitScript).
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
  const W = window, st = W.__audioTap = { ran: false, tapKind: null, tapNote: null, ctxs: [], contexts: 0, starts: [], osc: {}, media: 0, chunks: [], rate: 0, hiddenChunks: [], phase: 'play', t0: performance.now() };
  const taps = new WeakMap();
  const origConnect = AudioNode.prototype.connect, origDisconnect = AudioNode.prototype.disconnect;
  function tapFor(ctx) {
    let t = taps.get(ctx);
    if (t) return t;
    st.contexts++; st.ctxs.push(ctx); st.rate = ctx.sampleRate;
    const g = ctx.createGain();
    origConnect.call(g, ctx.destination);
    // Keep the tap fed even when the game disconnects its nodes between sounds (PuzzleScript does), so the
    // recording runs continuously from context creation instead of only while something is connected.
    try { const keep = ctx.createConstantSource(); keep.offset.value = 0; origConnect.call(keep, g); keep.start(); } catch {}
    t = { g }; taps.set(ctx, t);
    const take = (L, R) => {
      if (st.phase === 'play') { st.chunks.push([L, R]); if (ctx.state === 'running') st.ran = true; }
      else if (st.phase === 'hidden') st.hiddenChunks.push([L, R]);
    };
    // Record with an AudioWorklet sink (no outputs, so it's rendered but adds nothing to the mix). The module is
    // loaded from a blob URL, which is async: the first few ms before it's ready aren't captured. If worklets are
    // unavailable (e.g. a CSP blocks blob: modules), fall back to ScriptProcessorNode, which Chrome logs as deprecated.
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
    // offline rendering (e.g. pre-rendering a sound) isn't what the player hears: leave it untapped
    if (dest instanceof AudioDestinationNode && !(W.OfflineAudioContext && dest.context instanceof W.OfflineAudioContext)) { origConnect.call(this, tapFor(dest.context).g, ...rest); return dest; }
    return origConnect.call(this, dest, ...rest);
  };
  AudioNode.prototype.disconnect = function (dest, ...rest) {
    if (dest instanceof AudioDestinationNode && !(W.OfflineAudioContext && dest.context instanceof W.OfflineAudioContext)) return origDisconnect.call(this, tapFor(dest.context).g, ...rest);
    return origDisconnect.call(this, dest, ...rest);
  };
  // Chrome defines start() separately on AudioBufferSourceNode (and may on others), so patch every prototype that
  // owns one. A subclass's own start() doesn't call the base one, so nothing is counted twice.
  for (const C of [AudioScheduledSourceNode, AudioBufferSourceNode, OscillatorNode, ConstantSourceNode]) {
    if (!C || !Object.prototype.hasOwnProperty.call(C.prototype, 'start')) continue;
    const origStart = C.prototype.start;
    C.prototype.start = function (...a) {
      // [when start() was called, when it sounds], performance.now() ms. start(when) with `when` after the context's
      // clock sounds (when - currentTime) s from now; a `when` in the past, or none, sounds now.
      const now = performance.now(), when = a[0], lead = Number.isFinite(when) && when > 0 ? Math.max(0, when - this.context.currentTime) : 0;
      st.starts.push([now, now + lead * 1000]);
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
  await page.evaluate(() => { const s = window.__audioTap; s.chunks = []; s.starts = []; s.t0 = performance.now(); });
}

function decode(b64) {
  const buf = Buffer.from(b64, 'base64');
  const f = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4), n = f.length / 2;
  return [f.slice(0, n), f.slice(n)];
}

/** Measure what was heard since installAudioTap/resetAudioTap, then run the hidden-tab check. */
export async function audioReport(page, { targets = MIX_TARGETS, hiddenSeconds = 3 } = {}) {
  const t1 = await page.evaluate(() => { window.__audioTap.t1 = performance.now(); window.__audioTap.phase = 'hidden';
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
    // skip the first ~0.4 s after hiding (a fade-out or suspend in progress)
    return { ran: s.ran || s.ctxs.some(c => c.state === 'running'), tapKind: s.tapKind, tapNote: s.tapNote, suspended, contexts: s.contexts, starts: s.starts.filter(([t]) => t >= s.t0 && t <= s.t1), t0: s.t0, t1: s.t1, osc: s.osc, media: s.media, rate: s.rate, audio: b64(s.chunks), hidden: b64(s.hiddenChunks.slice(4)) };
  });
  const r = { tap: data.tapKind, tapNote: data.tapNote, contexts: data.contexts, mediaPlays: data.media, oscillatorTypes: data.osc };
  const secs = Math.max(0.001, (data.t1 - data.t0) / 1000);
  // Raw starts are every start() call, as v3 counted them: startsPerSec by call time, maxStartsPer100ms where each one
  // sounds. Merged sounds: starts within MERGE_MS of the previous one are one sound, and the limit applies to those.
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
  // suspended: every AudioContext was suspended while hidden (the kit does this), so nothing was captured: silent.
  r.hidden = { seconds: h?.seconds ?? 0, suspended: data.suspended, audible: !data.suspended && !!(h && h.samplePeakDb !== null && h.samplePeakDb > -60) };
  const g = r.mix ? grade(r.mix, targets) : { ok: true, problems: [] };
  r.problems = [...g.problems];
  if (r.hidden.audible) r.problems.push('sound keeps playing while the tab is hidden');
  if (r.maxSoundsPer100ms > MAX_SOUNDS_PER_100MS) r.problems.push(`${r.maxSoundsPer100ms} sounds started within 100 ms (${r.maxStartsPer100ms} node starts; starts within ${MERGE_MS} ms of each other count as one sound)`);
  if (data.contexts > 0 && !data.ran) r.problems.push('context never ran: no user gesture since load (a reload after installAudioTap?)');
  r.ok = r.problems.length === 0;
  return r;
}
