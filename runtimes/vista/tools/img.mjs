// Image helpers for the vista tools: PNG read/write (builder/art/png.mjs) and the core's raw readback
// format (8-byte width/height header, then BGRA8 or RGBA8 rows, as tidewater's core/Bench.js uploads it).
import { readFileSync, writeFileSync } from 'node:fs';
import { encodePng, decodePng } from '../../../builder/art/png.mjs';

/** raw readback body → {width, height, data: RGBA Buffer} (alpha forced to 255; bgra: swap channels) */
export function fromReadback(buf, { bgra = true } = {}) {
  const b = Buffer.from(buf);
  const width = b.readUInt32LE(0), height = b.readUInt32LE(4);
  const src = b.subarray(8), data = Buffer.alloc(width * height * 4);
  // rows may be padded to 256 bytes by the GPU copy
  const stride = src.length / height;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const s = y * stride + x * 4, d = (y * width + x) * 4;
    data[d] = src[s + (bgra ? 2 : 0)]; data[d + 1] = src[s + 1]; data[d + 2] = src[s + (bgra ? 0 : 2)]; data[d + 3] = 255;
  }
  return { width, height, data };
}

export function writePng(file, img) { writeFileSync(file, encodePng(img)); }

export function readPng(file) { return decodePng(readFileSync(file)); }

/** Downscale by an integer factor (box filter): a 4K shot → a contact-sheet tile or a judge-sized image. */
export function shrink({ width, height, data }, k) {
  const w = Math.floor(width / k), h = Math.floor(height / k), out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let r = 0, g = 0, b = 0;
    for (let j = 0; j < k; j++) for (let i = 0; i < k; i++) { const s = ((y * k + j) * width + x * k + i) * 4; r += data[s]; g += data[s + 1]; b += data[s + 2]; }
    const d = (y * w + x) * 4, n = k * k;
    out[d] = r / n; out[d + 1] = g / n; out[d + 2] = b / n; out[d + 3] = 255;
  }
  return { width: w, height: h, data: out };
}

/**
 * Compare two same-size images. → {meanAbs (0..255), psnr (dB), over (fraction of pixels whose max channel
 * difference exceeds `tol`), identical}. Used by frame-compare: the vendored core against the reference build.
 */
export function compare(a, b, { tol = 8 } = {}) {
  if (a.width !== b.width || a.height !== b.height) throw new Error(`size ${a.width}x${a.height} vs ${b.width}x${b.height}`);
  let sum = 0, sq = 0, over = 0;
  const n = a.width * a.height;
  for (let p = 0; p < n; p++) {
    let m = 0;
    for (let c = 0; c < 3; c++) { const d = Math.abs(a.data[p * 4 + c] - b.data[p * 4 + c]); sum += d; sq += d * d; if (d > m) m = d; }
    if (m > tol) over++;
  }
  const mse = sq / (n * 3);
  return { meanAbs: +(sum / (n * 3)).toFixed(4), psnr: mse === 0 ? 99 : +(10 * Math.log10(255 * 255 / mse)).toFixed(2), identical: mse === 0, over: +(over / n).toFixed(6) };   // 99 dB stands for identical (JSON has no Infinity)
}
