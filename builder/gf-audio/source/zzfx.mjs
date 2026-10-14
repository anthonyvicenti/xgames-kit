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
export const ZZFX_PARAMS = [
  'volume', 'randomness', 'frequency', 'attack', 'sustain', 'release', 'shape', 'shapeCurve', 'slide', 'deltaSlide',
  'pitchJump', 'pitchJumpTime', 'repeatTime', 'noise', 'modulation', 'bitCrush', 'delay', 'sustainVolume', 'decay',
  'tremolo', 'filter',
];
export const ZZFX_DEFAULTS = [1, .05, 220, 0, 0, .1, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0];
export const ZZFX_SHAPES = ['sine', 'triangle', 'saw', 'tan', 'noise', 'square'];

/** Fill holes (ZzFX arrays are often sparse, e.g. [,,220]) with defaults. */
export function zzfxParams(params = []) {
  return ZZFX_DEFAULTS.map((d, i) => (params[i] === undefined || params[i] === null ? d : params[i]));
}

/**
 * Render a ZzFX sound to mono samples.
 * @param {number[]} params ZzFX parameter array (sparse is fine)
 * @param {{sampleRate?:number, random?:()=>number}} [opts] use random:()=>.5 for a deterministic render
 */
export function buildSamples(params, { sampleRate = 44100, random = Math.random } = {}) {
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
