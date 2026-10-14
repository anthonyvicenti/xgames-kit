// PNG in and out for the flat (2D) tools, with node:zlib alone: 8-bit RGBA, straight alpha, no interlace. That is the
// only kind the gf-flat-1 standard allows (kit/flat/ART-STANDARD.md), so anything else is "not an 8-bit RGBA PNG".
import { deflateSync, inflateSync, crc32 } from 'node:zlib';

const SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** { width, height, data: Uint8Array RGBA } → PNG bytes */
export function encodePng({ width: w, height: h, data }) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; Buffer.from(data.buffer, data.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1); }
  const chunk = (type, body) => { const len = Buffer.alloc(4); len.writeUInt32BE(body.length); const td = Buffer.concat([Buffer.from(type), body]); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(td) >>> 0); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([SIG, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

/** PNG bytes → { width, height, data } or { error } (what is wrong, in words). */
export function decodePng(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 33 || !buf.subarray(0, 8).equals(SIG)) return { error: 'not a PNG file' };
  const width = buf.readUInt32BE(16), height = buf.readUInt32BE(20), depth = buf[24], type = buf[25], interlace = buf[28];
  if (depth !== 8 || type !== 6) return { error: `a PNG of ${depth} bits and colour type ${type}; the standard is 8-bit RGBA (colour type 6)`, width, height };
  if (interlace) return { error: 'an interlaced PNG; save it without interlacing', width, height };
  const idat = [];
  for (let o = 8; o + 12 <= buf.length;) { const len = buf.readUInt32BE(o), tag = buf.toString('latin1', o + 4, o + 8); if (tag === 'IDAT') idat.push(buf.subarray(o + 8, o + 8 + len)); o += 12 + len; }
  let raw; try { raw = inflateSync(Buffer.concat(idat)); } catch (e) { return { error: `the PNG's data does not unpack (${e.message})`, width, height }; }
  const bpp = 4, stride = width * bpp, data = new Uint8Array(stride * height);
  if (raw.length < (stride + 1) * height) return { error: 'the PNG is cut short', width, height };
  for (let y = 0; y < height; y++) {       // undo the row filters
    const f = raw[y * (stride + 1)], row = y * (stride + 1) + 1, o = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? data[o + x - bpp] : 0, b = y ? data[o - stride + x] : 0, c = x >= bpp && y ? data[o - stride + x - bpp] : 0;
      let add = 0;
      if (f === 1) add = a; else if (f === 2) add = b; else if (f === 3) add = (a + b) >> 1;
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); add = pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      data[o + x] = (raw[row + x] + add) & 255;
    }
  }
  return { width, height, data };
}
