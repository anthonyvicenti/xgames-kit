// Pictures → RGBA pixels for stats.mjs, decoded by the browser (JPEG, PNG and WebP alike; node has no image decoder in
// this kit's dependencies). One plain Chrome page, no GPU: each file is drawn into a canvas at most `width` pixels wide
// (the aspect kept, smoothing on, so a downscale averages), optionally cropped first.
//
//   const px = await openPixels();                       // or openPixels({ browser }) to use a browser already open
//   const img = await px.read('/path/a.jpg', { width: 320, crop: [x, y, w, h] });   // → { width, height, data }
//   await px.close();
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { launchChrome } from '../qa/browser.mjs';

const TYPES = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };
export const STATS_WIDTH = 320;

export async function openPixels({ browser = null } = {}) {
  const own = !browser;
  browser ??= await launchChrome();
  const page = await browser.newPage({ viewport: { width: 400, height: 300 }, deviceScaleFactor: 1 });
  await page.setContent('<!doctype html><meta charset=utf-8><title>pixels</title>');
  /** bytes (Buffer) or a file path → { width, height, data: Uint8Array RGBA } */
  async function read(src, { width = STATS_WIDTH, crop = null, type = null } = {}) {
    const bytes = Buffer.isBuffer(src) ? src : await readFile(src);
    const mime = type ?? (Buffer.isBuffer(src) ? 'image/png' : TYPES[extname(src).toLowerCase()] ?? 'image/png');
    const out = await page.evaluate(async ({ b64, mime, width, crop }) => {
      const blob = await (await fetch(`data:${mime};base64,${b64}`)).blob();
      const bmp = await createImageBitmap(blob);
      const [sx, sy, sw, sh] = crop ?? [0, 0, bmp.width, bmp.height];
      const w = Math.max(1, Math.min(width, sw)), h = Math.max(1, Math.round((sh * w) / sw));
      const c = new OffscreenCanvas(w, h), g = c.getContext('2d', { willReadFrequently: true });
      g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
      g.drawImage(bmp, sx, sy, sw, sh, 0, 0, w, h);
      const d = g.getImageData(0, 0, w, h).data;
      let s = ''; for (let i = 0; i < d.length; i += 0x8000) s += String.fromCharCode.apply(null, d.subarray(i, i + 0x8000));
      return { width: w, height: h, full: [bmp.width, bmp.height], b64: btoa(s) };
    }, { b64: bytes.toString('base64'), mime, width, crop });
    return { width: out.width, height: out.height, full: out.full, data: new Uint8Array(Buffer.from(out.b64, 'base64')) };
  }
  /** A crop of a picture as its own JPEG (full resolution, at most maxWidth wide). → Buffer */
  async function extract(src, { crop = null, maxWidth = 1600, quality = 0.9 } = {}) {
    const bytes = Buffer.isBuffer(src) ? src : await readFile(src);
    const mime = Buffer.isBuffer(src) ? 'image/png' : TYPES[extname(src).toLowerCase()] ?? 'image/png';
    const b64 = await page.evaluate(async ({ b64, mime, crop, maxWidth, quality }) => {
      const bmp = await createImageBitmap(await (await fetch(`data:${mime};base64,${b64}`)).blob());
      const [sx, sy, sw, sh] = crop ?? [0, 0, bmp.width, bmp.height];
      const w = Math.min(maxWidth, sw), h = Math.round((sh * w) / sw);
      const c = new OffscreenCanvas(w, h), g = c.getContext('2d');
      g.imageSmoothingQuality = 'high'; g.drawImage(bmp, sx, sy, sw, sh, 0, 0, w, h);
      const buf = new Uint8Array(await (await c.convertToBlob({ type: 'image/jpeg', quality })).arrayBuffer());
      let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
      return btoa(s);
    }, { b64: bytes.toString('base64'), mime, crop, maxWidth, quality });
    return Buffer.from(b64, 'base64');
  }
  async function close() { await page.close().catch(() => {}); if (own) await browser.close().catch(() => {}); }
  return { read, extract, close, browser, page };
}
