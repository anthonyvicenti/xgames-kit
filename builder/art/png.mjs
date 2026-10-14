// A small PNG reader and writer on node:zlib, so the art checks need no native package on any system.
// Pictures are { width, height, data } with data a Buffer of RGBA bytes, 8 bits a channel, rows top to bottom.
// Reads 8-bit non-interlaced PNGs (grey, grey+alpha, RGB, RGBA, palette); anything else throws a plain sentence.
import { deflateSync, inflateSync } from 'node:zlib';

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc(buf) { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

export const isPng = buf => buf.length > 8 && buf.subarray(0, 8).equals(SIG);

export function blank(width, height) { return { width, height, data: Buffer.alloc(width * height * 4) }; }

function chunk(type, body) {
  const head = Buffer.alloc(8); head.writeUInt32BE(body.length, 0); head.write(type, 4, 'latin1');
  const tail = Buffer.alloc(4); tail.writeUInt32BE(crc(Buffer.concat([head.subarray(4), body])), 0);
  return Buffer.concat([head, body, tail]);
}

/** RGBA picture → PNG bytes (colour type 6, no filter). */
export function encodePng({ width, height, data }) {
  if (data.length !== width * height * 4) throw new Error(`a ${width}x${height} picture needs ${width * height * 4} bytes, got ${data.length}`);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) data.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  return Buffer.concat([SIG, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const paeth = (a, b, c) => { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; };

/** PNG bytes → RGBA picture, plus `hadAlpha` (did the file carry transparency at all). */
export function decodePng(buf) {
  if (!isPng(buf)) throw new Error('not a PNG file');
  let o = 8, width = 0, height = 0, depth = 0, type = 0, interlace = 0, palette = null, trns = null;
  const idat = [];
  while (o + 8 <= buf.length) {
    const len = buf.readUInt32BE(o), name = buf.toString('latin1', o + 4, o + 8), body = buf.subarray(o + 8, o + 8 + len);
    if (name === 'IHDR') { width = body.readUInt32BE(0); height = body.readUInt32BE(4); depth = body[8]; type = body[9]; interlace = body[12]; }
    else if (name === 'PLTE') palette = body;
    else if (name === 'tRNS') trns = body;
    else if (name === 'IDAT') idat.push(body);
    else if (name === 'IEND') break;
    o += 12 + len;
  }
  if (!width || !height) throw new Error('a PNG with no size');
  if (interlace) throw new Error('an interlaced PNG: save it without interlacing');
  if (depth !== 8) throw new Error(`a ${depth}-bit PNG: save it as 8 bits a channel`);
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[type];
  if (!channels) throw new Error(`PNG colour type ${type} is not supported`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  if (raw.length < (stride + 1) * height) throw new Error('a PNG whose picture data is cut short');
  const px = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1, dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? px[dst + x - channels] : 0, b = y ? px[dst - stride + x] : 0, c = y && x >= channels ? px[dst - stride + x - channels] : 0;
      const v = raw[src + x];
      px[dst + x] = (f === 0 ? v : f === 1 ? v + a : f === 2 ? v + b : f === 3 ? v + ((a + b) >> 1) : v + paeth(a, b, c)) & 0xff;
    }
  }
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    let r, g, b, a = 255;
    if (type === 6) { r = px[i * 4]; g = px[i * 4 + 1]; b = px[i * 4 + 2]; a = px[i * 4 + 3]; }
    else if (type === 2) { r = px[i * 3]; g = px[i * 3 + 1]; b = px[i * 3 + 2]; if (trns && trns.length >= 6 && r === trns[1] && g === trns[3] && b === trns[5]) a = 0; }
    else if (type === 0) { r = g = b = px[i]; if (trns && trns.length >= 2 && r === trns[1]) a = 0; }
    else if (type === 4) { r = g = b = px[i * 2]; a = px[i * 2 + 1]; }
    else { const k = px[i]; if (!palette || k * 3 + 2 >= palette.length) throw new Error('a palette PNG with a colour outside its palette'); r = palette[k * 3]; g = palette[k * 3 + 1]; b = palette[k * 3 + 2]; a = trns && k < trns.length ? trns[k] : 255; }
    data[i * 4] = r; data[i * 4 + 1] = g; data[i * 4 + 2] = b; data[i * 4 + 3] = a;
  }
  return { width, height, data, hadAlpha: type === 4 || type === 6 || !!trns };
}

/** A copy of the rectangle x, y, w, h. */
export function crop(pic, x, y, w, h) {
  const out = blank(w, h);
  for (let r = 0; r < h; r++) pic.data.copy(out.data, r * w * 4, ((y + r) * pic.width + x) * 4, ((y + r) * pic.width + x + w) * 4);
  return out;
}

/** Whole-number enlargement with hard pixels (how pixel art is shown). */
export function scaleUp(pic, k) {
  const out = blank(pic.width * k, pic.height * k);
  for (let y = 0; y < out.height; y++) for (let x = 0; x < out.width; x++) pic.data.copy(out.data, (y * out.width + x) * 4, ((Math.floor(y / k)) * pic.width + Math.floor(x / k)) * 4, ((Math.floor(y / k)) * pic.width + Math.floor(x / k)) * 4 + 4);
  return out;
}

/** Shrink to w x h by averaging the area each new pixel covers (alpha-weighted, so edges do not darken). */
export function scaleDown(pic, w, h) {
  const out = blank(w, h), fx = pic.width / w, fy = pic.height / h;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const x0 = Math.floor(x * fx), x1 = Math.max(x0 + 1, Math.floor((x + 1) * fx)), y0 = Math.floor(y * fy), y1 = Math.max(y0 + 1, Math.floor((y + 1) * fy));
    let r = 0, g = 0, b = 0, a = 0, n = 0;
    for (let yy = y0; yy < y1 && yy < pic.height; yy++) for (let xx = x0; xx < x1 && xx < pic.width; xx++) {
      const i = (yy * pic.width + xx) * 4, al = pic.data[i + 3];
      r += pic.data[i] * al; g += pic.data[i + 1] * al; b += pic.data[i + 2] * al; a += al; n++;
    }
    const i = (y * w + x) * 4;
    if (a) { out.data[i] = Math.round(r / a); out.data[i + 1] = Math.round(g / a); out.data[i + 2] = Math.round(b / a); }
    out.data[i + 3] = n ? Math.round(a / n) : 0;
  }
  return out;
}

/** Lay pictures on a background colour, side by side (for a person or a session to look at). */
export function onBackground(pic, [r, g, b] = [58, 62, 74]) {
  const out = blank(pic.width, pic.height);
  for (let i = 0; i < pic.width * pic.height; i++) {
    const a = pic.data[i * 4 + 3] / 255;
    out.data[i * 4] = Math.round(pic.data[i * 4] * a + r * (1 - a)); out.data[i * 4 + 1] = Math.round(pic.data[i * 4 + 1] * a + g * (1 - a)); out.data[i * 4 + 2] = Math.round(pic.data[i * 4 + 2] * a + b * (1 - a)); out.data[i * 4 + 3] = 255;
  }
  return out;
}

/** The same picture repeated cols x rows (to see whether a tile's edges meet). */
export function tiled(pic, cols, rows) {
  const out = blank(pic.width * cols, pic.height * rows);
  for (let y = 0; y < out.height; y++) for (let c = 0; c < cols; c++) pic.data.copy(out.data, (y * out.width + c * pic.width) * 4, ((y % pic.height) * pic.width) * 4, ((y % pic.height) * pic.width + pic.width) * 4);
  return out;
}

/** What a region holds: how much is drawn, its box, the colours in it. Region defaults to the whole picture. */
export function stats(pic, { x = 0, y = 0, w = pic.width - x, h = pic.height - y } = {}) {
  let drawn = 0, soft = 0, minX = w, minY = h, maxX = -1, maxY = -1;
  const colours = new Set();
  for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) {
    const i = ((y + yy) * pic.width + x + xx) * 4, a = pic.data[i + 3];
    if (a > 0 && a < 255) soft++;
    if (a < 16) continue;
    drawn++;
    if (xx < minX) minX = xx; if (xx > maxX) maxX = xx; if (yy < minY) minY = yy; if (yy > maxY) maxY = yy;
    if (colours.size <= 4096) colours.add((pic.data[i] << 16) | (pic.data[i + 1] << 8) | pic.data[i + 2]);
  }
  return { pixels: w * h, drawn, cover: drawn / (w * h), soft, colours: colours.size, box: maxX < 0 ? null : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1, right: w - 1 - maxX, bottom: h - 1 - maxY } };
}
