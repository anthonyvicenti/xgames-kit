// gf-forge lookdev: what a picture measures (track R's luma, wave 2's texel detail) and contact sheets. Everything runs
// in a browser page the caller already has (a canvas decodes the PNG): no image library.
//
// - lumaOf: mean, median and 99th percentile luma (Rec. 709, out of 255), the share of pixels over 200, and the eight
//   dominant colours, on a 320 px wide copy: against research/rust-engine/feel-targets.md "Look targets" (Exposure).
// - detailOf: pixel-to-pixel detail in a box of the picture at its own resolution: the mean absolute luma step between
//   a pixel and its right neighbour (`across`) and its lower neighbour (`down`). Square texels with grain raise it;
//   smooth filtering lowers it. feel-targets gives the reference's ground as 2.19 with its retro option on and 0.85
//   off; this measure on the same kind of ground box of two reference frames (its menu with the option on and off,
//   1280×720, the box x 640–1100, y 480–700) reads 2.52 and 1.26 across (2026-10-10), so compare ratios, not digits.

export const LOOK_TARGET = { mean: [34, 48], median: [28, 44], p99: [142, 213], over200: 0.01, source: 'research/rust-engine/feel-targets.md "Look targets" (exposure, from frame grabs)' };
/** What feel-targets gives for the reference's ground, and what `detailOf` reads on two reference frames. */
export const DETAIL_TARGET = { on: 2.19, off: 0.85, thisMeasure: { on: 2.52, off: 1.26, box: [640, 480, 1100, 700], size: [1280, 720] }, source: 'research/rust-engine/feel-targets.md "Look targets" (render resolution: the retro option)' };

const inRange = (v, [lo, hi]) => v >= lo && v <= hi;
export function verdictOf(m) {
  return { mean: inRange(m.mean, LOOK_TARGET.mean), median: inRange(m.median, LOOK_TARGET.median), p99: inRange(m.p99, LOOK_TARGET.p99), over200: m.over200 <= LOOK_TARGET.over200 * 3 };
}

/** Luma stats and 8 dominant colours of a PNG screenshot (in a page: a canvas, k-means on a 160×90 copy). */
export async function lumaOf(page, png) {
  return page.evaluate(async b64 => {
    const im = new Image(); im.src = 'data:image/png;base64,' + b64; await im.decode();
    const W = 320, H = Math.round((im.height / im.width) * 320), c = new OffscreenCanvas(W, H), g = c.getContext('2d');
    g.drawImage(im, 0, 0, W, H);
    const d = g.getImageData(0, 0, W, H).data, n = W * H, lum = new Float32Array(n), px = [];
    for (let i = 0; i < n; i++) { const r = d[i * 4], gg = d[i * 4 + 1], b = d[i * 4 + 2]; lum[i] = 0.2126 * r + 0.7152 * gg + 0.0722 * b; if (i % 4 === 0) px.push([r, gg, b]); }
    const s = [...lum].sort((a, b) => a - b), q = p => s[Math.min(n - 1, Math.floor(p * n))];
    const mean = lum.reduce((a, b) => a + b, 0) / n;
    // k-means, 8 colours
    let cent = Array.from({ length: 8 }, (_, k) => px[Math.floor((k + 0.5) * px.length / 8)].slice());
    const asg = new Int32Array(px.length);
    for (let it = 0; it < 12; it++) {
      for (let i = 0; i < px.length; i++) { let best = 0, bd = 1e9; for (let k = 0; k < 8; k++) { const dx = px[i][0] - cent[k][0], dy = px[i][1] - cent[k][1], dz = px[i][2] - cent[k][2], dd = dx * dx + dy * dy + dz * dz; if (dd < bd) { bd = dd; best = k; } } asg[i] = best; }
      const sum = Array.from({ length: 8 }, () => [0, 0, 0, 0]);
      for (let i = 0; i < px.length; i++) { const k = asg[i]; sum[k][0] += px[i][0]; sum[k][1] += px[i][1]; sum[k][2] += px[i][2]; sum[k][3]++; }
      cent = sum.map((x, k) => (x[3] ? [x[0] / x[3], x[1] / x[3], x[2] / x[3]] : cent[k]));
    }
    const count = new Array(8).fill(0); for (const k of asg) count[k]++;
    const hex = v => '#' + v.map(x => Math.round(x).toString(16).padStart(2, '0')).join('');
    const palette = cent.map((v, k) => ({ hex: hex(v), share: Math.round((count[k] / px.length) * 100) })).sort((a, b) => b.share - a.share);
    return { mean: Math.round(mean * 10) / 10, median: Math.round(q(0.5) * 10) / 10, p99: Math.round(q(0.99) * 10) / 10, over200: Math.round((s.filter(x => x > 200).length / n) * 1000) / 1000, palette };
  }, png.toString('base64'));
}

/**
 * Pixel-to-pixel detail of a box ([x0, y0, x1, y1] in the picture's own pixels; default the whole picture):
 * {across, down, mean (the box's mean luma), box}. `across` is the number to compare with DETAIL_TARGET.
 */
export async function detailOf(page, png, box = null) {
  return page.evaluate(async ({ b64, box }) => {
    const im = new Image(); im.src = 'data:image/png;base64,' + b64; await im.decode();
    const c = new OffscreenCanvas(im.width, im.height), g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(im, 0, 0);
    const [x0, y0, x1, y1] = box ? [Math.max(0, box[0]), Math.max(0, box[1]), Math.min(im.width, box[2]), Math.min(im.height, box[3])] : [0, 0, im.width, im.height];
    const w = x1 - x0, h = y1 - y0;
    if (w < 2 || h < 2) return { across: 0, down: 0, mean: 0, box: [x0, y0, x1, y1] };
    const d = g.getImageData(x0, y0, w, h).data, L = new Float32Array(w * h);
    let sum = 0;
    for (let i = 0; i < w * h; i++) { L[i] = 0.2126 * d[i * 4] + 0.7152 * d[i * 4 + 1] + 0.0722 * d[i * 4 + 2]; sum += L[i]; }
    let ax = 0, ay = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w - 1; x++) ax += Math.abs(L[y * w + x + 1] - L[y * w + x]);
    for (let y = 0; y < h - 1; y++) for (let x = 0; x < w; x++) ay += Math.abs(L[(y + 1) * w + x] - L[y * w + x]);
    const r = v => Math.round(v * 100) / 100;
    return { across: r(ax / ((w - 1) * h)), down: r(ay / (w * (h - 1))), mean: r(sum / (w * h)), box: [x0, y0, x1, y1] };
  }, { b64: png.toString('base64'), box });
}

/** A contact sheet: the shots ({file, caption}) in a grid with captions, as one JPEG (drawn in a page). */
export async function sheetOf(browser, shots, title, file, cols = 3) {
  const { readFileSync, writeFileSync } = await import('node:fs');
  const page = await browser.newPage();
  try {
    const data = shots.map(s => ({ src: 'data:image/png;base64,' + readFileSync(s.file).toString('base64'), caption: s.caption }));
    const jpg = await page.evaluate(async ({ data, title, cols }) => {
      const ims = await Promise.all(data.map(async d => { const im = new Image(); im.src = d.src; await im.decode(); return { im, caption: d.caption }; }));
      const cw = 640, ch = Math.round(cw * (ims[0].im.height / ims[0].im.width)), cap = 34, head = 46, rows = Math.ceil(ims.length / cols);
      const c = new OffscreenCanvas(cw * cols, head + rows * (ch + cap)), g = c.getContext('2d');
      g.fillStyle = '#101317'; g.fillRect(0, 0, c.width, c.height);
      g.fillStyle = '#e8ecef'; g.font = '600 22px system-ui, sans-serif'; g.fillText(title, 12, 30);
      ims.forEach(({ im, caption }, i) => {
        const x = (i % cols) * cw, y = head + Math.floor(i / cols) * (ch + cap);
        const h = Math.round(cw * (im.height / im.width));
        g.drawImage(im, x, y + (ch - Math.min(ch, h)) / 2, cw, Math.min(ch, h));
        g.fillStyle = '#c8d0d6'; g.font = '13px ui-monospace, monospace'; g.fillText(caption.length > Math.floor((cw - 16) / 7.9) ? caption.slice(0, Math.floor((cw - 16) / 7.9) - 1) + '…' : caption, x + 8, y + ch + 22);
      });
      const blob = await c.convertToBlob({ type: 'image/jpeg', quality: 0.86 });
      const b = new Uint8Array(await blob.arrayBuffer()); let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
      return btoa(s);
    }, { data, title, cols });
    writeFileSync(file, Buffer.from(jpg, 'base64'));
  } finally { await page.close(); }
}
