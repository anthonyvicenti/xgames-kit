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
export function measure(channels, sampleRate, { truePeak: wantTp = true } = {}) {
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
export function normalizeGain(stats, target = -18, peakCeilingDb = -1) {
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
export const MIX_TARGETS = {
  integratedLufs: { max: -16 },             // a busy mix with music aims for about -20
  momentaryMaxLufs: { min: -32 },           // the loudest moment must be clearly audible
  shortTermMaxLufs: { max: -10 },           // no 3-second stretch louder than this
  truePeakDb: { max: -1 },
  hfRatio: { max: 0.25 },                   // energy above 4 kHz
  clippedSamples: { max: 0 },
};

export function grade(stats, targets = MIX_TARGETS) {
  const problems = [];
  for (const [key, t] of Object.entries(targets)) {
    const v = stats[key];
    if (v === null || v === undefined) continue;
    if (t.max !== undefined && v > t.max) problems.push(`${key} ${v} > ${t.max}`);
    if (t.min !== undefined && v < t.min) problems.push(`${key} ${v} < ${t.min}`);
  }
  return { ok: problems.length === 0, problems };
}
