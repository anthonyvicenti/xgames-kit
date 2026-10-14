// games.fun asset runtime, gf-assets/1.2.1: code-art.js, for images a game draws in its own code.
// Contract: creator-studio/docs/asset-manifest.md, "v1.5: images built in code". Load it as a classic script before every
// game script: <script src="gf/code-art.js"></script> (research/asset-manifest/capture-code-art.mjs --write adds it).
//
// A game that paints its textures, atlas tiles and icons on canvases has no image files, so Studio had nothing to show or
// replace. capture-code-art.mjs plays the game, saves each picture the code painted as `drawn.preview`, and writes an image
// slot with a `drawn` block: where in the code it is painted (`sig`, call-stack patterns of "file:line:col" frames,
// innermost first, the same format as code sounds), which part of the canvas (`rect`) and its pixels' sha256 (`hash`).
//   - While a slot's `source.file` is still its own preview, nothing here runs: no hooks are installed at all.
//   - Any other `source.file` is the creator's replacement. Each 2D draw call on an off-page canvas the size of a replaced
//     region's canvas (any off-page canvas, for a whole-canvas slot) is checked: when its box lies mostly inside (or covers) the slot's rect and its call stack starts with one of
//     the slot's patterns, the rect is due. The first time anything reads that canvas (texImage2D/texSubImage2D, drawImage
//     from it, toDataURL/toBlob, createPattern, createImageBitmap, getImageData, WebGPU copyExternalImageToTexture), the
//     replacement is written into the rect first (putImageData, so the game's transform, clip and alpha don't touch it),
//     fitted per `drawn.fit` ("stretch", "contain", "cover"). The game then uploads, copies or encodes the new pixels.
//   - A slot no pattern finds (the code moved since the capture) is still found by its pixels: the first read of each
//     canvas of that size compares the rect's sha256 with `drawn.hash`. And any whole canvas holding exactly a replaced
//     picture's pixels (the same tile kept as its own canvas for icons) is replaced at its first read too.
//   - Same code, same rect, several canvases (a loop that paints six textures with one function): `drawn.nth` says which
//     of them, in the order they're painted; an exact `hash` wins over the order.
//   - 1.2.1: `drawn.also` lists the other places of the same canvas that hold the same picture (an atlas that paints one
//     tile on every face): a draw over any of them makes the slot due, and the replacement is written at every one.
// Timing (the design problem): many games paint and upload every texture synchronously while their first script runs, so
// an async fetch or image decode would always land too late. So this script reads assets.json and each replacement
// synchronously (same-origin XMLHttpRequest, before the game's first script) and decodes PNG with its own inflate, also
// synchronously. Another format (JPEG, WebP, GIF, SVG) is decoded asynchronously: reads after it decodes get it, and
// canvases already read are repainted and their recorded WebGL uploads re-issued (a data URL or a copy the game already
// took keeps the old picture). So replacements of drawn slots should be saved as PNG (validate.mjs warns otherwise).
// Where the manifest comes from: __GF_FILES present (the packed inline page) → no swaps at all, as for code sounds (the
// packer bundles the scripts, so no frame matches). Else assets.json beside the page (the play origin merges a Studio
// draft into it) or __GF_ASSET_OVERRIDES.files['assets.json'], with __GF_ASSET_OVERRIDES.patches for 'assets.json'
// applied; a replacement's bytes come from __GF_ASSET_OVERRIDES.files[path] (a data: URL) or the file beside the page.
// `editable: false` and `kind: "sprite"` slots are never swapped in this version.
// window.__GF_CODE_ART: {version, ready, slots, stats}. stats.applied[id] counts rects written, stats.matched[id] the
// draws that matched a pattern, stats.hashMatched[id] rects found by their pixels, stats.copies[id] whole-canvas copies,
// stats.notReady[id] reads before an async replacement decoded, stats.late[id] / stats.reissued repaints and re-uploads
// after it, stats.stacks the call stacks taken, stats.ms the time spent here (not in the game's calls), stats.startMs the
// start (reading assets.json, decoding PNGs). With globalThis.__GF_CODE_ART_CHECK = true, each slot's first write is
// read back and counted in stats.confirmed[id]. In the packed page a replacement is only recorded in __GF_ASSETS_SEEN.
// Capture mode: capture-code-art.mjs defines globalThis.__GF_CODE_ART_CAPTURE before the page loads; then nothing is
// swapped and every canvas, draw (with its frames and box) and read is reported to it.
// No dependencies. In a page without a DOM (Node tests) it only defines globalThis.__GF_CODE_ART_LIB.
(function () {
  'use strict';
  const W = globalThis;
  const VERSION = '1.2.1';

  // ---- inflate (RFC 1950/1951), so a PNG decodes synchronously ----
  const LBASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
  const LEXT = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
  const DBASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
  const DEXT = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
  const CLORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
  // A canonical Huffman code as a lookup table indexed by the next `bits` input bits (LSB first): sym << 4 | length.
  function huffman(lengths, n) {
    let max = 0;
    for (let i = 0; i < n; i++) if (lengths[i] > max) max = lengths[i];
    const count = new Uint16Array(16), next = new Uint16Array(16), table = new Int32Array(1 << max);
    for (let i = 0; i < n; i++) count[lengths[i]]++;
    count[0] = 0;
    for (let b = 1, code = 0; b <= 15; b++) { code = (code + count[b - 1]) << 1; next[b] = code; }
    for (let s = 0; s < n; s++) {
      const len = lengths[s];
      if (!len) continue;
      let c = next[len]++, r = 0;
      for (let i = 0; i < len; i++) { r = (r << 1) | (c & 1); c >>= 1; }
      for (let i = r; i < 1 << max; i += 1 << len) table[i] = (s << 4) | len;
    }
    return { table, bits: max };
  }
  let FIXED = null;
  function fixedCodes() {
    if (FIXED) return FIXED;
    const l = new Uint8Array(288);
    for (let i = 0; i < 288; i++) l[i] = i < 144 ? 8 : i < 256 ? 9 : i < 280 ? 7 : 8;
    return (FIXED = [huffman(l, 288), huffman(new Uint8Array(30).fill(5), 30)]);
  }
  /** Raw deflate data from `start` → bytes. `size` is the expected output size when known. */
  function inflate(src, start = 0, size = 0) {
    let pos = start, bb = 0, bc = 0, op = 0, out = new Uint8Array(size || Math.max(1024, (src.length - start) * 4));
    const need = n => { while (bc < n) { bb |= (pos < src.length ? src[pos] : 0) << bc; pos++; bc += 8; } };
    const bits = n => { if (!n) return 0; need(n); const v = bb & ((1 << n) - 1); bb >>>= n; bc -= n; return v; };
    const sym = h => { need(h.bits); const e = h.table[bb & ((1 << h.bits) - 1)], l = e & 15; if (!l) throw new Error('inflate: bad code'); bb >>>= l; bc -= l; return e >> 4; };
    const grow = n => { if (op + n <= out.length) return; let len = out.length * 2; while (len < op + n) len *= 2; const o = new Uint8Array(len); o.set(out.subarray(0, op)); out = o; };
    let last = 0;
    do {
      if (pos - (bc >> 3) > src.length) throw new Error('inflate: data ends early');
      last = bits(1);
      const type = bits(2);
      if (type === 0) {
        const drop = bc & 7; bb >>>= drop; bc -= drop;
        pos -= bc >> 3; bb = 0; bc = 0;
        if (pos + 4 > src.length) throw new Error('inflate: data ends early');
        const len = src[pos] | (src[pos + 1] << 8);
        pos += 4;
        if (pos + len > src.length) throw new Error('inflate: data ends early');
        grow(len); out.set(src.subarray(pos, pos + len), op); op += len; pos += len;
        continue;
      }
      let lit, dist;
      if (type === 1) [lit, dist] = fixedCodes();
      else if (type === 2) {
        const hlit = bits(5) + 257, hdist = bits(5) + 1, hclen = bits(4) + 4, cl = new Uint8Array(19);
        for (let i = 0; i < hclen; i++) cl[CLORDER[i]] = bits(3);
        const ch = huffman(cl, 19), total = hlit + hdist, lens = new Uint8Array(total);
        for (let i = 0; i < total;) {
          const s = sym(ch);
          if (s < 16) lens[i++] = s;
          else {
            if (s === 16 && !i) throw new Error('inflate: bad lengths');
            const v = s === 16 ? lens[i - 1] : 0;
            let r = s === 16 ? 3 + bits(2) : s === 17 ? 3 + bits(3) : 11 + bits(7);
            if (i + r > total) throw new Error('inflate: bad lengths');
            while (r--) lens[i++] = v;
          }
        }
        lit = huffman(lens.subarray(0, hlit), hlit); dist = huffman(lens.subarray(hlit), hdist);
      } else throw new Error('inflate: bad block type');
      for (;;) {
        const s = sym(lit);
        if (s < 256) { grow(1); out[op++] = s; continue; }
        if (s === 256) break;
        const li = s - 257;
        if (li >= 29) throw new Error('inflate: bad length');
        const len = LBASE[li] + bits(LEXT[li]), di = sym(dist);
        if (di >= 30) throw new Error('inflate: bad distance');
        const d = DBASE[di] + bits(DEXT[di]);
        if (d > op) throw new Error('inflate: distance too far back');
        grow(len);
        for (let k = 0; k < len; k++, op++) out[op] = out[op - d];
      }
    } while (!last);
    return out.subarray(0, op);
  }

  // ---- PNG → RGBA (all colour types and depths, tRNS, Adam7) ----
  const PNG_SIG = [137, 80, 78, 71, 13, 10, 26, 10];
  const isPng = b => b && b.length > 8 && PNG_SIG.every((v, i) => b[i] === v);
  const ADAM7 = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]];
  /** PNG bytes → {width, height, data: Uint8ClampedArray RGBA}. Throws on anything it can't read. */
  function decodePng(bytes) {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (!isPng(u8)) throw new Error('not a PNG');
    const u32 = o => ((u8[o] << 24) | (u8[o + 1] << 16) | (u8[o + 2] << 8) | u8[o + 3]) >>> 0;
    let p = 8, w = 0, h = 0, depth = 0, ctype = 0, interlace = 0, palette = null, trns = null, zlen = 0;
    const idat = [];
    while (p + 8 <= u8.length) {
      const len = u32(p), type = String.fromCharCode(u8[p + 4], u8[p + 5], u8[p + 6], u8[p + 7]), d = p + 8;
      if (d + len > u8.length) throw new Error('PNG: truncated chunk');
      if (type === 'IHDR') { w = u32(d); h = u32(d + 4); depth = u8[d + 8]; ctype = u8[d + 9]; interlace = u8[d + 12]; }
      else if (type === 'PLTE') palette = u8.subarray(d, d + len);
      else if (type === 'tRNS') trns = u8.subarray(d, d + len);
      else if (type === 'IDAT') { idat.push(u8.subarray(d, d + len)); zlen += len; }
      else if (type === 'IEND') break;
      p = d + len + 4;
    }
    const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ctype];
    if (!w || !h || !channels || ![1, 2, 4, 8, 16].includes(depth) || w * h > 64e6) throw new Error('PNG: unsupported header');
    if (ctype === 3 && !palette) throw new Error('PNG: palette missing');
    const z = new Uint8Array(zlen);
    for (let i = 0, o = 0; i < idat.length; o += idat[i].length, i++) z.set(idat[i], o);
    if ((z[0] & 15) !== 8 || ((z[0] << 8) | z[1]) % 31 || z[1] & 32) throw new Error('PNG: bad zlib header');
    const passes = interlace ? ADAM7 : [[0, 0, 1, 1]];
    let expected = 0;
    for (const [x0, y0, dx, dy] of passes) { const pw = Math.ceil((w - x0) / dx), ph = Math.ceil((h - y0) / dy); if (pw > 0 && ph > 0) expected += ph * (1 + Math.ceil(pw * channels * depth / 8)); }
    const raw = inflate(z, 2, expected);
    if (raw.length < expected) throw new Error('PNG: image data ends early');
    const out = new Uint8ClampedArray(w * h * 4), bpp = Math.max(1, (channels * depth) >> 3), max = (1 << Math.min(depth, 8)) - 1;
    const tr16 = trns && trns.length >= 2 ? (trns[0] << 8) | trns[1] : -1;
    let rp = 0;
    for (const [x0, y0, dx, dy] of passes) {
      const pw = Math.ceil((w - x0) / dx), ph = Math.ceil((h - y0) / dy);
      if (pw <= 0 || ph <= 0) continue;
      const stride = Math.ceil(pw * channels * depth / 8);
      let prev = new Uint8Array(stride);
      for (let y = 0; y < ph; y++) {
        const f = raw[rp++], cur = raw.slice(rp, rp + stride);
        rp += stride;
        for (let i = 0; i < stride; i++) {
          const a = i >= bpp ? cur[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
          if (f === 1) cur[i] += a;
          else if (f === 2) cur[i] += b;
          else if (f === 3) cur[i] += (a + b) >> 1;
          else if (f === 4) { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c); cur[i] += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
          else if (f !== 0) throw new Error('PNG: bad filter');
        }
        const sample = (i, k) => {   // channel k of pixel i, as a full-range value (16 bits: 0-65535, else 0-max)
          const n = i * channels + k;
          if (depth === 8) return cur[n];
          if (depth === 16) return (cur[n * 2] << 8) | cur[n * 2 + 1];
          const bit = n * depth;
          return (cur[bit >> 3] >> (8 - depth - (bit & 7))) & max;
        };
        const to8 = v => (depth === 16 ? v >> 8 : depth === 8 ? v : Math.round(v * 255 / max));
        for (let x = 0; x < pw; x++) {
          const o = ((y0 + y * dy) * w + x0 + x * dx) * 4;
          if (ctype === 3) {
            const idx = sample(x, 0);
            out[o] = palette[idx * 3]; out[o + 1] = palette[idx * 3 + 1]; out[o + 2] = palette[idx * 3 + 2];
            out[o + 3] = trns && idx < trns.length ? trns[idx] : 255;
          } else if (ctype === 0 || ctype === 4) {
            const g = sample(x, 0);
            out[o] = out[o + 1] = out[o + 2] = to8(g);
            out[o + 3] = ctype === 4 ? to8(sample(x, 1)) : g === tr16 ? 0 : 255;
          } else {
            const r = sample(x, 0), g = sample(x, 1), b = sample(x, 2);
            out[o] = to8(r); out[o + 1] = to8(g); out[o + 2] = to8(b);
            out[o + 3] = ctype === 6 ? to8(sample(x, 3)) : trns && trns.length >= 6 && r === ((trns[0] << 8) | trns[1]) && g === ((trns[2] << 8) | trns[3]) && b === ((trns[4] << 8) | trns[5]) ? 0 : 255;
          }
        }
        prev = cur;
      }
    }
    return { width: w, height: h, data: out };
  }

  // ---- SHA-256 (drawn.hash is the sha256 of the rect's RGBA bytes) ----
  const K256 = new Uint32Array([0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2]);
  function sha256(bytes) {
    const n = bytes.length, total = ((n + 9 + 63) >> 6) << 6, m = new Uint8Array(total);
    m.set(bytes); m[n] = 0x80;
    const bitsHi = Math.floor(n / 0x20000000), bitsLo = (n << 3) >>> 0;
    m[total - 8] = bitsHi >>> 24; m[total - 7] = bitsHi >>> 16; m[total - 6] = bitsHi >>> 8; m[total - 5] = bitsHi;
    m[total - 4] = bitsLo >>> 24; m[total - 3] = bitsLo >>> 16; m[total - 2] = bitsLo >>> 8; m[total - 1] = bitsLo;
    const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]), w = new Uint32Array(64);
    for (let off = 0; off < total; off += 64) {
      for (let i = 0; i < 16; i++) w[i] = (m[off + i * 4] << 24) | (m[off + i * 4 + 1] << 16) | (m[off + i * 4 + 2] << 8) | m[off + i * 4 + 3];
      for (let i = 16; i < 64; i++) {
        const a = w[i - 15], b = w[i - 2];
        const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3), s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
      }
      let a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
      for (let i = 0; i < 64; i++) {
        const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7)), ch = (e & f) ^ (~e & g);
        const t1 = (h + S1 + ch + K256[i] + w[i]) | 0;
        const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10)), mj = (a & b) ^ (a & c) ^ (b & c);
        const t2 = (S0 + mj) | 0;
        h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      H[0] += a; H[1] += b; H[2] += c; H[3] += d; H[4] += e; H[5] += f; H[6] += g; H[7] += h;
    }
    let hex = '';
    for (let i = 0; i < 8; i++) hex += H[i].toString(16).padStart(8, '0');
    return hex;
  }

  // ---- Matching helpers ----
  /** Where a replacement of w×h goes in a rect of rw×rh: [dx, dy, dw, dh] (may reach outside the rect for "cover"). */
  function fitBox(fit, w, h, rw, rh) {
    if (fit === 'contain' || fit === 'cover') {
      const s = fit === 'contain' ? Math.min(rw / w, rh / h) : Math.max(rw / w, rh / h), dw = w * s, dh = h * s;
      return [(rw - dw) / 2, (rh - dh) / 2, dw, dh];
    }
    return [0, 0, rw, rh];
  }
  /** Whether a draw's device-space box [x0, y0, x1, y1] paints the rect [x, y, w, h]: mostly inside it, or covering it. */
  function paints(b, r) {
    const ix = Math.min(b[2], r[0] + r[2]) - Math.max(b[0], r[0]), iy = Math.min(b[3], r[1] + r[3]) - Math.max(b[1], r[1]);
    const area = Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
    if (!area) { const cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2; return cx >= r[0] && cy >= r[1] && cx <= r[0] + r[2] && cy <= r[1] + r[3]; }
    if (ix <= 0 || iy <= 0) return false;
    const inter = ix * iy;
    return inter >= 0.5 * area || inter >= 0.9 * r[2] * r[3];
  }
  /** The id of the first pattern (innermost frames first) that `keys` starts with, from a Map of "f|f|f" → value. */
  function matchKeys(patterns, maxLen, keys) {
    let key = '';
    for (let k = 0; k < keys.length && k < maxLen; k++) { key = k ? key + '|' + keys[k] : keys[k]; const v = patterns.get(key); if (v !== undefined) return v; }
    return undefined;
  }
  const LIB = { VERSION, inflate, decodePng, isPng, sha256, fitBox, paints, matchKeys };
  W.__GF_CODE_ART_LIB = LIB;
  if (typeof W.document === 'undefined' || typeof W.CanvasRenderingContext2D === 'undefined' || W.__GF_CODE_ART) return;

  // ---- The page ----
  const doc = W.document, CAP = W.__GF_CODE_ART_CAPTURE || null, CHECK = W.__GF_CODE_ART_CHECK === true;
  const SELF = ((doc.currentScript && doc.currentScript.src) || '').split(/[?#]/)[0];
  const BASE = (() => { try { return new URL('.', doc.URL).href; } catch { return ''; } })();
  const stats = { applied: {}, matched: {}, hashMatched: {}, copies: {}, confirmed: {}, notReady: {}, late: {}, reissued: 0, stacks: 0, ms: 0, errors: [] };
  const count = (o, id, n = 1) => { o[id] = (o[id] || 0) + n; };
  const fail = (what, e) => { if (stats.errors.length < 20) stats.errors.push(`${what}: ${(e && e.message) || e}`); };
  const api = W.__GF_CODE_ART = { version: VERSION, stats, slots: [], ready: Promise.resolve(), raw: null, capture: !!CAP };

  // Originals, before anything wraps them: ours and the game's never go through the hooks.
  const P2 = CanvasRenderingContext2D.prototype, PO = W.OffscreenCanvasRenderingContext2D ? W.OffscreenCanvasRenderingContext2D.prototype : null;
  const ORIG = new Map();
  for (const P of [P2, PO]) if (P) { const o = {}; for (const k of ['putImageData', 'getImageData', 'drawImage', 'getTransform', 'measureText', 'clearRect']) o[k] = P[k]; ORIG.set(P, o); }
  const orig = (ctx, k) => (PO && ctx instanceof W.OffscreenCanvasRenderingContext2D ? ORIG.get(PO) : ORIG.get(P2))[k];
  const oToDataURL = HTMLCanvasElement.prototype.toDataURL, oGetContext = HTMLCanvasElement.prototype.getContext;
  api.raw = { getImageData: (ctx, ...a) => orig(ctx, 'getImageData').apply(ctx, a), putImageData: (ctx, ...a) => orig(ctx, 'putImageData').apply(ctx, a), toDataURL: (c, ...a) => oToDataURL.apply(c, a) };

  // ---- Where a draw was made: the game's frames, innermost first (as code-sounds.js) ----
  function rel(url) {
    if (!url) return null;
    if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) return url.replace(/^\.?\//, '');
    const clean = url.split(/[?#]/)[0];
    if (clean === SELF || !BASE || !clean.startsWith(BASE)) return null;
    try { const r = decodeURIComponent(clean.slice(BASE.length)) || 'index.html'; return r === 'gf/code-art.js' ? null : r; } catch { return null; }
  }
  const STACK_LINE = /^\s*(?:at\s+)?(?:(?:async\s+)?(.*?)\s*\(|(.*?)@)?(\S+?):(\d+):(\d+)\)?\s*$/;
  const MAX_FRAMES = 40;
  function callsites() {
    const E = Error, lim = E.stackTraceLimit, prep = E.prepareStackTrace;
    let raw;
    try {
      E.stackTraceLimit = MAX_FRAMES;
      if (typeof E.captureStackTrace === 'function') { E.prepareStackTrace = (_, s) => s; const holder = {}; E.captureStackTrace(holder, callsites); raw = holder.stack; }
      else raw = new E().stack;
    } catch { raw = null; } finally { E.stackTraceLimit = lim; E.prepareStackTrace = prep; }
    const out = [];
    stats.stacks++;
    if (Array.isArray(raw)) {
      for (const c of raw) {
        const file = rel(c.getScriptNameOrSourceURL ? c.getScriptNameOrSourceURL() : c.getFileName());
        if (file) out.push({ file, line: c.getLineNumber(), col: c.getColumnNumber(), name: c.getFunctionName() || c.getMethodName() || null });
      }
    } else if (typeof raw === 'string') {
      for (const l of raw.split('\n')) {
        const m = STACK_LINE.exec(l); if (!m) continue;
        const file = rel(m[3]);
        if (file) out.push({ file, line: +m[4], col: +m[5], name: (m[1] || m[2] || '').replace(/^new /, '') || null });
      }
    }
    return out;
  }
  const fkey = f => `${f.file}:${f.line}:${f.col}`;

  // ---- The draw's box, in canvas pixels (the transform at the call, clipped by rectangular clips) ----
  const shapes = new WeakMap();   // ctx -> {path: box|null, clip: box|null, saved: []}
  const shapeOf = ctx => { let s = shapes.get(ctx); if (!s) shapes.set(ctx, s = { path: null, clip: null, saved: [] }); return s; };
  function grow(b, T, pts) {
    for (let i = 0; i < pts.length; i += 2) {
      const x = pts[i], y = pts[i + 1], X = T.a * x + T.c * y + T.e, Y = T.b * x + T.d * y + T.f;
      if (X < b[0]) b[0] = X; if (Y < b[1]) b[1] = Y; if (X > b[2]) b[2] = X; if (Y > b[3]) b[3] = Y;
    }
    return b;
  }
  const empty = () => [Infinity, Infinity, -Infinity, -Infinity];
  const rectPts = (x, y, w, h) => [x, y, x + w, y, x, y + h, x + w, y + h];
  function pathOp(ctx, m, a) {
    const s = shapeOf(ctx);
    if (m === 'beginPath') { s.path = null; return; }
    const T = orig(ctx, 'getTransform').call(ctx), b = s.path || (s.path = empty());
    switch (m) {
      case 'moveTo': case 'lineTo': grow(b, T, [a[0], a[1]]); break;
      case 'rect': case 'roundRect': grow(b, T, rectPts(a[0], a[1], a[2], a[3])); break;
      case 'arc': { const r = a[2]; grow(b, T, rectPts(a[0] - r, a[1] - r, 2 * r, 2 * r)); break; }
      case 'ellipse': { const r = Math.max(a[2], a[3]); grow(b, T, rectPts(a[0] - r, a[1] - r, 2 * r, 2 * r)); break; }
      case 'arcTo': case 'quadraticCurveTo': grow(b, T, [a[0], a[1], a[2], a[3]]); break;
      case 'bezierCurveTo': grow(b, T, [a[0], a[1], a[2], a[3], a[4], a[5]]); break;
    }
  }
  function stateOp(ctx, m) {
    const s = shapeOf(ctx);
    if (m === 'save') s.saved.push(s.clip);
    else if (m === 'restore') s.clip = s.saved.length ? s.saved.pop() : null;
    else if (m === 'reset') { s.clip = null; s.path = null; s.saved.length = 0; }
    else if (m === 'clip' && s.path && isFinite(s.path[0])) { const p = s.path, c = s.clip; s.clip = c ? [Math.max(c[0], p[0]), Math.max(c[1], p[1]), Math.min(c[2], p[2]), Math.min(c[3], p[3])] : p.slice(); }
  }
  function drawBox(ctx, m, a) {
    let b = null;
    if (m === 'putImageData') {   // device pixels: no transform, no clip
      const d = a[0]; if (!d) return null;
      return a.length >= 7 ? [a[1] + a[3], a[2] + a[4], a[1] + a[3] + a[5], a[2] + a[4] + a[6]] : [a[1], a[2], a[1] + d.width, a[2] + d.height];
    }
    const T = orig(ctx, 'getTransform').call(ctx);
    switch (m) {
      case 'fillRect': case 'clearRect': b = grow(empty(), T, rectPts(a[0], a[1], a[2], a[3])); break;
      case 'strokeRect': { const l = (ctx.lineWidth || 1) / 2; b = grow(empty(), T, rectPts(a[0] - l, a[1] - l, a[2] + 2 * l, a[3] + 2 * l)); break; }
      case 'fill': case 'stroke': {
        if (a[0] && typeof a[0] === 'object') return null;   // a Path2D: its shape is unknown here
        const p = shapeOf(ctx).path; if (!p || !isFinite(p[0])) return null;
        b = p.slice();
        if (m === 'stroke') { const l = (ctx.lineWidth || 1) / 2 * Math.hypot(T.a, T.b); b[0] -= l; b[1] -= l; b[2] += l; b[3] += l; }
        break;
      }
      case 'fillText': case 'strokeText': {
        const w = orig(ctx, 'measureText').call(ctx, String(a[0])).width, h = parseFloat((/(\d+(?:\.\d+)?)px/.exec(ctx.font) || [])[1] || 10);
        b = grow(empty(), T, [a[1] - w, a[2] - h, a[1] + w, a[2] + h]); break;
      }
      case 'drawImage': {
        const s = a[0]; let dx, dy, dw, dh;
        if (a.length >= 9) { dx = a[5]; dy = a[6]; dw = a[7]; dh = a[8]; }
        else if (a.length >= 5) { dx = a[1]; dy = a[2]; dw = a[3]; dh = a[4]; }
        else { dx = a[1]; dy = a[2]; dw = (s && (s.width || s.videoWidth || s.naturalWidth)) || 0; dh = (s && (s.height || s.videoHeight || s.naturalHeight)) || 0; }
        b = grow(empty(), T, rectPts(dx, dy, dw, dh)); break;
      }
      default: return null;
    }
    const c = shapeOf(ctx).clip;
    if (c) b = [Math.max(b[0], c[0]), Math.max(b[1], c[1]), Math.min(b[2], c[2]), Math.min(b[3], c[3])];
    return b;
  }
  const isCanvas = v => !!v && ((W.HTMLCanvasElement && v instanceof W.HTMLCanvasElement) || (W.OffscreenCanvas && v instanceof W.OffscreenCanvas));

  // ---- The manifest and the replacements (synchronously: the game may paint and upload while its first script runs) ----
  const O = W.__GF_ASSET_OVERRIDES || {};
  const SEEN = () => (W.__GF_ASSETS_SEEN = W.__GF_ASSETS_SEEN || []);
  const seen = p => { const s = SEEN(); if (!s.includes(p)) s.push(p); };
  function dataBytes(u) {
    const comma = u.indexOf(','), meta = u.slice(5, comma), body = u.slice(comma + 1);
    if (!/;base64$/i.test(meta)) return new TextEncoder().encode(decodeURIComponent(body));
    const bin = atob(body), out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function readSync(path, binary) {
    const x = new XMLHttpRequest();
    x.open('GET', new URL(path, BASE).href, false);
    if (binary) x.overrideMimeType('text/plain; charset=x-user-defined');
    x.send(null);
    if (x.status !== 200 && x.status !== 0) throw new Error(`${path}: HTTP ${x.status}`);
    if (!binary) return x.responseText;
    const s = x.responseText, out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
    return out;
  }
  const clean = p => String(p).replace(/^\.\//, '').split(/[?#]/)[0];
  function setPointer(doc, pointer, value) {
    const keys = pointer === '' ? [] : pointer.slice(1).split('/').map(k => k.replace(/~1/g, '/').replace(/~0/g, '~'));
    if (!keys.length) return JSON.parse(JSON.stringify(value));
    let v = doc;
    for (const k of keys.slice(0, -1)) { if (v == null || typeof v !== 'object' || !(k in v)) return doc; v = v[k]; }
    if (v && typeof v === 'object') v[keys[keys.length - 1]] = JSON.parse(JSON.stringify(value));
    return doc;
  }
  function manifest() {
    const ov = (O.files && O.files['assets.json']) ?? (W.__GF_FILES ? W.__GF_FILES['assets.json'] : undefined);
    if (ov === undefined && W.__GF_FILES) return { slots: [] };
    let m = ov !== undefined ? (typeof ov === 'string' ? JSON.parse(ov.startsWith('data:') ? new TextDecoder().decode(dataBytes(ov)) : ov) : JSON.parse(JSON.stringify(ov))) : JSON.parse(readSync('assets.json', false));
    for (const p of O.patches || []) if (p && clean(p.file) === 'assets.json' && typeof p.pointer === 'string') m = setPointer(m, p.pointer, p.value);
    return m;
  }
  function fileBytes(path) {
    const v = O.files && O.files[path];
    if (typeof v === 'string' && v.startsWith('data:')) return dataBytes(v);
    if (v instanceof Uint8Array) return v;
    return readSync(path, true);
  }

  // A replaced slot, ready to match: {id, whole, rect, size, pats, maxLen, hash, nth, group, fit, img, ...}. Regions are
  // matched on canvases of their canvas's exact size (bySize); whole-canvas slots on any canvas (a sprite the game paints
  // again at another size after a resize is still the same sprite).
  const slots = [], bySize = new Map(), whole = [], unhashed = new Set();
  const copies = new Map(), copyChecked = new WeakSet(), ctxOf = new WeakMap();   // rect size -> hash -> slot; canvases checked; 2D contexts the game made
  let pending = 0, readyResolve = null;
  const sizeKey = (w, h) => w * 65536 + h;
  function prepare(m) {
    const editable = new Map((m.groups || []).map(g => [g && g.id, g && g.defaults && g.defaults.editable]));
    const groups = new Map();
    for (const s of m.slots || []) {
      const d = s && s.drawn;
      if (!d || s.type !== 'image' || !s.source || typeof s.source.file !== 'string' || d.kind === 'sprite') continue;
      if ((s.editable !== undefined ? s.editable : editable.get(s.group)) === false) continue;
      const file = clean(s.source.file);
      if (file === clean(d.preview || '')) continue;   // the game's own art: nothing to do
      const isWhole = d.kind === 'canvas', size = isWhole ? d.size : d.canvas;
      if (!Array.isArray(size) || !(size[0] > 0) || !(size[1] > 0)) continue;
      const rect = isWhole ? [0, 0, size[0], size[1]] : d.rect;
      const okRect = q => Array.isArray(q) && q.length === 4 && q.every(n => typeof n === 'number' && isFinite(n)) && q[2] > 0 && q[3] > 0 && q[0] >= 0 && q[1] >= 0 && q[0] + q[2] <= size[0] && q[1] + q[3] <= size[1];
      if (!Array.isArray(rect) || !rect.every(n => typeof n === 'number' && isFinite(n)) || !(rect[2] > 0) || !(rect[3] > 0)) continue;
      const rects = isWhole ? [rect] : [rect].concat(Array.isArray(d.also) ? d.also.filter(okRect) : []);
      const S = { id: s.id, file, whole: isWhole, rect, rects, size, key: sizeKey(size[0], size[1]), pats: new Map(), maxLen: 0, hash: typeof d.hash === 'string' ? d.hash : null,
        nth: Number.isInteger(d.nth) ? d.nth : null, fit: d.fit || 'stretch', img: null, fits: new Map(), late: new Set(), group: null, everMatched: false };
      for (const p of Array.isArray(d.sig) ? d.sig : []) if (Array.isArray(p) && p.length && p.every(f => typeof f === 'string')) { S.pats.set(p.join('|'), S); S.maxLen = Math.max(S.maxLen, p.length); }
      // Same patterns (and rect) for several slots: told apart by their pixels, else by drawn.nth.
      if (S.nth !== null) {
        const gk = `${isWhole ? 'whole' : S.key + '|' + rect.join(',')}|${[...S.pats.keys()].sort().join('#')}`;
        let g = groups.get(gk); if (!g) groups.set(gk, g = { slots: [], seen: 0 }); g.slots.push(S); S.group = g;
      }
      slots.push(S);
      if (isWhole) whole.push(S); else { if (!bySize.has(S.key)) bySize.set(S.key, []); bySize.get(S.key).push(S); }
      if (S.hash) { unhashed.add(S); const ck = isWhole ? S.key : sizeKey(rect[2], rect[3]); if (!copies.has(ck)) copies.set(ck, new Map()); copies.get(ck).set(S.hash, S); }
      api.slots.push({ id: S.id, file, kind: d.kind || 'region' });
      load(S);
    }
  }
  function load(S) {
    try {
      const bytes = fileBytes(S.file);
      seen(S.file);
      if (isPng(bytes)) { const p = decodePng(bytes); S.img = { w: p.width, h: p.height, data: p.data }; return; }
      if (typeof W.createImageBitmap !== 'function') throw new Error('not a PNG, and this browser has no createImageBitmap');
      pending++;
      W.createImageBitmap(new Blob([bytes])).then(bm => {
        const c = scratch(0, bm.width, bm.height), g = c.ctx;
        orig(g, 'clearRect').call(g, 0, 0, bm.width, bm.height); orig(g, 'drawImage').call(g, bm, 0, 0);
        S.img = { w: bm.width, h: bm.height, data: orig(g, 'getImageData').call(g, 0, 0, bm.width, bm.height).data };
        lateApply(S);
      }).catch(e => fail(`${S.id}: ${S.file}`, e)).finally(() => { if (--pending === 0 && readyResolve) readyResolve(); });
    } catch (e) { fail(`${S.id}: ${S.file}`, e); }
  }

  // Our own scratch canvases (never a game canvas; only original methods touch them).
  const scratches = [];
  function scratch(i, w, h) {
    let s = scratches[i];
    if (!s) { const c = doc.createElement('canvas'); scratches[i] = s = { c, ctx: oGetContext.call(c, '2d', { willReadFrequently: true }) }; }
    if (s.c.width !== w || s.c.height !== h) { s.c.width = w; s.c.height = h; }
    return s;
  }
  /** The replacement as ImageData rw×rh, fitted per drawn.fit (cached per size). */
  function fitted(S, rw, rh) {
    const k = rw * 65536 + rh;
    if (S.fits.has(k)) return S.fits.get(k);
    const im = S.img;
    let out;
    if (im.w === rw && im.h === rh) out = new ImageData(new Uint8ClampedArray(im.data), rw, rh);
    else {
      const a = scratch(1, im.w, im.h), b = scratch(2, rw, rh), g = b.ctx;
      orig(a.ctx, 'putImageData').call(a.ctx, new ImageData(new Uint8ClampedArray(im.data), im.w, im.h), 0, 0);
      orig(g, 'clearRect').call(g, 0, 0, rw, rh);
      g.imageSmoothingEnabled = im.w > rw || im.h > rh;   // shrinking a painting: smooth; enlarging pixel art: keep the pixels
      g.imageSmoothingQuality = 'high';
      const [dx, dy, dw, dh] = fitBox(S.fit, im.w, im.h, rw, rh);
      orig(g, 'drawImage').call(g, a.c, dx, dy, dw, dh);
      out = orig(g, 'getImageData').call(g, 0, 0, rw, rh);
    }
    S.fits.set(k, out);
    return out;
  }

  // ---- Canvases: which slots are due on each, written in at the next read ----
  const recs = new WeakMap();   // canvas -> {ctx, epoch, due: Set<slot|group>|null, st: Map, inst: Map, hashTried, uploads, urls}
  function recOf(c, ctx) {
    let r = recs.get(c);
    if (!r) recs.set(c, r = { ctx: null, epoch: 0, due: null, st: new Map(), inst: new Map(), hashTried: false, uploads: null, urls: null });
    if (ctx) r.ctx = ctx;
    return r;
  }
  const TESTS_PER_EPOCH = 16;   // call stacks taken per slot and canvas between two reads before giving up on it there
  const GIVE_UP = 8;            // paintings of one canvas with no match before it is no longer looked at for that slot
  let keys = null;              // the current draw's frames, taken at most once per draw
  function test(r, S) {
    let st = r.st.get(S);
    if (!st) r.st.set(S, st = { ok: -1, tested: -1, tests: 0, misses: 0 });
    if (st.ok === r.epoch) { due(r, S); return; }
    if (st.tested !== r.epoch) {
      // A canvas the game paints again and again (a HUD layer, a buffer) that never matched in GIVE_UP of its paintings
      // is some other picture: stop taking stacks there.
      if (st.tested >= 0 && st.ok !== st.tested && ++st.misses >= GIVE_UP) return;
      st.tested = r.epoch; st.tests = 0;
    }
    if (st.tests >= TESTS_PER_EPOCH) return;
    st.tests++;
    if (!keys) keys = callsites().map(fkey);
    if (matchKeys(S.pats, S.maxLen, keys) !== S) return;
    st.ok = r.epoch; S.everMatched = true; unhashed.delete(S); count(stats.matched, S.id);
    if (S.group && !r.inst.has(S.group)) r.inst.set(S.group, S.group.seen++);
    due(r, S);
  }
  function onDraw(ctx, m, a) {
    const c = ctx.canvas;
    if (!c || c.isConnected === true) return;
    if (CAP) {
      const b = drawBox(ctx, m, a);
      try { CAP.op(c, ctx, m, a, b, callsites); } catch (e) { fail('capture op', e); }
      return;
    }
    const list = bySize.get(sizeKey(c.width, c.height));
    if (!list && !whole.length) return;
    const t0 = performance.now();
    keys = null;
    try {
      const r = recOf(c, ctx);
      for (let i = 0; i < whole.length; i++) test(r, whole[i]);
      if (list) {
        const b = drawBox(ctx, m, a);
        if (b) for (let i = 0; i < list.length; i++) { const R = list[i].rects; for (let j = 0; j < R.length; j++) if (paints(b, R[j])) { test(r, list[i]); break; } }
      }
    } catch (e) { fail('draw', e); } finally { keys = null; stats.ms += performance.now() - t0; }
  }
  function due(r, S) { (r.due || (r.due = new Set())).add(S.group || S); }
  // The 2D context the game drew with (never getContext() here: on a canvas with no context yet it would make one, and the
  // game's own getContext('webgl') would then fail).
  const ctx2d = (c, r) => (r && r.ctx) || ctxOf.get(c) || null;
  const rectOf = (c, S) => (S.whole ? [0, 0, c.width, c.height] : S.rect);
  function write(c, r, S, at) {
    const ctx = ctx2d(c, r), list = at ? [at] : S.whole ? [rectOf(c, S)] : S.rects;   // every place of the picture (1.2.1)
    if (!ctx) return false;
    let wrote = false;
    for (let i = 0; i < list.length; i++) {
      const rect = list[i];
      if (!(rect[2] > 0) || !(rect[3] > 0)) continue;
      const im = fitted(S, rect[2], rect[3]);
      orig(ctx, 'putImageData').call(ctx, im, rect[0], rect[1]);
      count(stats.applied, S.id); wrote = true;
      if (CHECK && !stats.confirmed[S.id]) { try {   // read back once per slot (a check run only)
        if (sha256(orig(ctx, 'getImageData').call(ctx, rect[0], rect[1], rect[2], rect[3]).data) === sha256(im.data)) count(stats.confirmed, S.id); } catch (e) { fail('check', e); } }
    }
    return wrote;
  }
  function rectHash(c, r, rect) {
    const ctx = ctx2d(c, r);
    return ctx ? sha256(orig(ctx, 'getImageData').call(ctx, rect[0], rect[1], rect[2], rect[3]).data) : null;
  }
  /** Before the game reads canvas `c`: write every due replacement into it. Returns the slots still decoding. */
  function onRead(c, use, info) {
    if (CAP) { try { CAP.read(c, use, info || null); } catch (e) { fail('capture read', e); } return; }
    const r = recs.get(c);
    if (!r && !(copies.size && copies.has(sizeKey(c.width, c.height)))) return;
    const t0 = performance.now();
    try {
      let waiting = null;
      const put = S => { if (S.img) write(c, r, S); else { count(stats.notReady, S.id); S.late.add(c); (waiting || (waiting = [])).push(S); } };
      // A copy: a whole canvas holding exactly a replaced picture's pixels (the same tile kept as its own canvas for
      // icons). Checked once per canvas, at its first read.
      const byHash = copies.size ? copies.get(sizeKey(c.width, c.height)) : null;
      if (byHash && !copyChecked.has(c)) {
        copyChecked.add(c);
        const ctx = ctx2d(c, r);
        if (ctx) {
          const S = byHash.get(sha256(orig(ctx, 'getImageData').call(ctx, 0, 0, c.width, c.height).data));
          if (S && S.img && write(c, r || recOf(c, ctx), S, [0, 0, c.width, c.height])) count(stats.copies, S.id);
        }
      }
      if (!r) return waiting;
      if (r.due) {
        for (const x of r.due) {
          let S = x;
          if (x.slots) {   // several slots share these patterns: the exact pixels first, else the order they were painted in
            const h = x.slots.some(s => s.hash) && x.slots.some(s => s.size[0] === c.width && s.size[1] === c.height) ? rectHash(c, r, rectOf(c, x.slots[0])) : null;
            S = (h && x.slots.find(s => s.hash === h)) || x.slots.find(s => s.nth === r.inst.get(x)) || null;
            if (!S) continue;
          }
          put(S);
        }
        r.due = null;
      }
      // Slots no pattern has found yet: compare the rect's pixels once per canvas of their size, at its first read.
      if (unhashed.size && r.ctx && !r.hashTried) {
        r.hashTried = true;
        const k = sizeKey(c.width, c.height);
        for (const S of unhashed) {
          if (S.everMatched || S.key !== k) continue;
          if (rectHash(c, r, rectOf(c, S)) !== S.hash) continue;
          count(stats.hashMatched, S.id); unhashed.delete(S);
          put(S);
        }
      }
      r.epoch++;
      return waiting;
    } catch (e) { fail('read', e); return null; } finally { stats.ms += performance.now() - t0; }
  }

  // ---- Late replacements (not PNG): repaint what was already read, re-issue its WebGL uploads, swap its data URLs in <img> ----
  const mipped = new WeakSet();
  function lateApply(S) {
    for (const c of S.late) {
      const r = recs.get(c);
      if (!r || !write(c, r, S)) continue;
      count(stats.late, S.id);
      for (const u of r.uploads || []) {
        try {
          const gl = u.gl, prev = gl.getParameter(u.binding);
          gl.bindTexture(u.bindTarget, u.tex);
          const keep = u.unpack.map(([k]) => [k, gl.getParameter(k)]);
          for (const [k, v] of u.unpack) gl.pixelStorei(k, v);
          u.fn.apply(gl, u.args);
          for (const [k, v] of keep) gl.pixelStorei(k, v);
          if (mipped.has(u.tex)) gl.generateMipmap(u.bindTarget);
          gl.bindTexture(u.bindTarget, prev);
          stats.reissued++;
        } catch (e) { fail('re-upload', e); }
      }
      for (const old of r.urls || []) {
        try { const now = oToDataURL.call(c, ...old.args); for (const img of doc.images) if (img.src === old.url) img.src = now; } catch (e) { fail('data URL', e); }
      }
    }
    S.late.clear();
  }

  // ---- Hooks ----
  function hook(P, name, wrap) { const o = P && P[name]; if (typeof o === 'function') P[name] = wrap(o); }
  function install() {
    const DRAW = ['fillRect', 'strokeRect', 'fillText', 'strokeText', 'fill', 'stroke', 'drawImage', 'putImageData'];
    const PATH = ['beginPath', 'rect', 'roundRect', 'moveTo', 'lineTo', 'arc', 'arcTo', 'ellipse', 'quadraticCurveTo', 'bezierCurveTo'];
    const STATE = ['save', 'restore', 'clip', 'reset'];
    // Draws are looked at on canvases that aren't on the page: all of them while capturing or when a whole-canvas slot is
    // replaced, else only canvases the size of a replaced region's canvas. Path and clip calls only where boxes are needed.
    const boxed = c => !!c && c.isConnected !== true && (CAP || bySize.has(sizeKey(c.width, c.height)));
    const tracked = c => !!c && c.isConnected !== true && (CAP || whole.length > 0 || bySize.has(sizeKey(c.width, c.height)));
    for (const P of [P2, PO]) {
      if (!P) continue;
      for (const m of DRAW) hook(P, m, o => function () {
        if (m === 'drawImage' && isCanvas(arguments[0])) onRead(arguments[0], 'drawImage');
        if (tracked(this.canvas)) onDraw(this, m, arguments);
        return o.apply(this, arguments);
      });
      for (const m of PATH) hook(P, m, o => function () { if (boxed(this.canvas)) try { pathOp(this, m, arguments); } catch (e) { fail(m, e); } return o.apply(this, arguments); });
      for (const m of STATE) hook(P, m, o => function () { if (boxed(this.canvas)) try { stateOp(this, m); } catch (e) { fail(m, e); } return o.apply(this, arguments); });
      hook(P, 'getImageData', o => function () { if (this.canvas) onRead(this.canvas, 'pixels'); return o.apply(this, arguments); });
      hook(P, 'createPattern', o => function (src) { if (isCanvas(src)) onRead(src, 'pattern'); return o.apply(this, arguments); });
    }
    hook(HTMLCanvasElement.prototype, 'toDataURL', o => function () {
      const waiting = onRead(this, 'dataURL');
      const url = o.apply(this, arguments);
      if (waiting) { const r = recs.get(this); if (r) (r.urls || (r.urls = [])).push({ url, args: [...arguments] }); }
      return url;
    });
    hook(HTMLCanvasElement.prototype, 'toBlob', o => function () { onRead(this, 'dataURL'); return o.apply(this, arguments); });
    if (W.OffscreenCanvas) {
      hook(W.OffscreenCanvas.prototype, 'convertToBlob', o => function () { onRead(this, 'dataURL'); return o.apply(this, arguments); });
      hook(W.OffscreenCanvas.prototype, 'transferToImageBitmap', o => function () { onRead(this, 'bitmap'); return o.apply(this, arguments); });
    }
    if (typeof W.createImageBitmap === 'function') { const o = W.createImageBitmap; W.createImageBitmap = function (src) { if (isCanvas(src)) onRead(src, 'bitmap'); return o.apply(this, arguments); }; }
    // WebGL: the texture upload is the read. A late replacement re-issues it, so remember how it was made.
    const BIND = { 0x0DE1: [0x0DE1, 0x8069], 0x806F: [0x806F, 0x806A], 0x8C1A: [0x8C1A, 0x8C1D] };   // TEXTURE_2D, _3D, _2D_ARRAY → [bind target, binding]
    const UNPACK = [0x9240, 0x9241, 0x9243, 0x0CF5];   // FLIP_Y, PREMULTIPLY_ALPHA, COLORSPACE_CONVERSION, UNPACK_ALIGNMENT
    for (const P of [W.WebGLRenderingContext && WebGLRenderingContext.prototype, W.WebGL2RenderingContext && WebGL2RenderingContext.prototype]) {
      if (!P) continue;
      for (const fn of ['texImage2D', 'texSubImage2D', 'texImage3D', 'texSubImage3D']) hook(P, fn, o => function () {
        const src = arguments[arguments.length - 1];
        if (isCanvas(src)) {
          const t = arguments[0], bt = BIND[t] || (t >= 0x8515 && t <= 0x851A ? [0x8513, 0x8514] : null);   // cube faces → TEXTURE_CUBE_MAP
          const info = CAP ? { fn, target: t, level: arguments[1] } : null;
          const waiting = onRead(src, 'texture', info);
          if (waiting && bt && !CAP) {
            try { const r = recs.get(src); (r.uploads || (r.uploads = [])).push({ gl: this, fn: o, args: [...arguments], bindTarget: bt[0], binding: bt[1], tex: this.getParameter(bt[1]), unpack: UNPACK.map(k => [k, this.getParameter(k)]) }); } catch (e) { fail('upload', e); }
          }
        }
        return o.apply(this, arguments);
      });
      hook(P, 'generateMipmap', o => function (t) { try { const bt = t === 0x8513 ? 0x8514 : (BIND[t] || [0, 0])[1]; if (bt && pending) { const tex = this.getParameter(bt); if (tex) mipped.add(tex); } } catch { /* ignore */ } return o.apply(this, arguments); });
    }
    // Which canvases have a 2D context (to read a possible copy's pixels without ever making a context ourselves).
    if (copies.size && !CAP) for (const P of [HTMLCanvasElement.prototype, W.OffscreenCanvas && W.OffscreenCanvas.prototype]) hook(P, 'getContext', o => function (type) {
      const ctx = o.apply(this, arguments);
      if (ctx && type === '2d') ctxOf.set(this, ctx);
      return ctx;
    });
    if (W.GPUQueue) hook(W.GPUQueue.prototype, 'copyExternalImageToTexture', o => function (src) { if (src && isCanvas(src.source)) onRead(src.source, 'texture'); return o.apply(this, arguments); });
    if (CAP) {
      // Where each canvas was made (labels and grouping in the capture).
      const oCreate = Document.prototype.createElement;
      Document.prototype.createElement = function (tag) { const el = oCreate.apply(this, arguments); if (typeof tag === 'string' && tag.toLowerCase() === 'canvas') try { CAP.canvas(el, callsites()); } catch (e) { fail('capture canvas', e); } return el; };
      if (W.OffscreenCanvas) { const OC = W.OffscreenCanvas; W.OffscreenCanvas = new Proxy(OC, { construct(t, a, nt) { const o = Reflect.construct(t, a, nt); try { CAP.canvas(o, callsites()); } catch (e) { fail('capture canvas', e); } return o; } }); }
    }
  }

  if (CAP) { install(); return; }
  if (W.__GF_FILES) {
    // The packed inline page: no swaps (its scripts are bundled, so no frame would match). A replacement the version
    // carries is still recorded as read, as code-sounds.js does, so the version's checks see that it ships.
    try {
      const m = manifest();
      for (const s of m.slots || []) { const d = s && s.drawn, f = d && s.source && clean(s.source.file || ''); if (f && f !== clean(d.preview || '') && s.editable !== false && (W.__GF_FILES[f] !== undefined || (O.files && O.files[f] !== undefined))) seen(f); }
    } catch (e) { fail('assets.json', e); }
    return;
  }
  const tStart = performance.now();
  try { prepare(manifest()); } catch (e) { fail('assets.json', e); return; } finally { stats.startMs = Math.round((performance.now() - tStart) * 10) / 10; }   // reading assets.json and decoding PNG replacements
  if (!slots.length) return;   // every drawn slot is the game's own art: no hooks at all
  if (slots.length) seen('assets.json');
  if (pending) api.ready = new Promise(r => { readyResolve = r; });
  install();
})();
