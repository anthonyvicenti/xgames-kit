// Width and height from an image file's header (PNG, GIF, WebP, JPEG), without decoding it. Used to check that v1.3
// sprite-sheet frame rects sit inside their sheet (docs/asset-manifest.md "Sprite-sheet frames"), by Studio's
// lib/manifest.mjs and builder/asset-manifest/validate.mjs. No imports, so the worker container can load it.

/** @param {Uint8Array} b the file's first bytes (64 KB covers almost every JPEG header) @returns {{width:number,height:number,format:string}|null} */
export function imageSize(b) {
  if (!b || b.length < 16) return null;
  const u16be = i => (b[i] << 8) | b[i + 1], u16le = i => b[i] | (b[i + 1] << 8), u24le = i => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
  const u32be = i => ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3];
  const ascii = (i, n) => String.fromCharCode(...b.subarray(i, i + n));
  if (b[0] === 0x89 && ascii(1, 3) === 'PNG' && b.length >= 24) return {width: u32be(16), height: u32be(20), format: 'png'};
  if (ascii(0, 4) === 'GIF8') return {width: u16le(6), height: u16le(8), format: 'gif'};
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP' && b.length >= 30) {
    const chunk = ascii(12, 4);
    if (chunk === 'VP8X') return {width: u24le(24) + 1, height: u24le(27) + 1, format: 'webp'};
    if (chunk === 'VP8L') { const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24); return {width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1, format: 'webp'}; }
    if (chunk === 'VP8 ') return {width: u16le(26) & 0x3fff, height: u16le(28) & 0x3fff, format: 'webp'};
    return null;
  }
  if (b[0] === 0xff && b[1] === 0xd8) {
    // JPEG: walk the segments to a start-of-frame marker (C0–CF except C4, C8, CC).
    for (let i = 2; i + 9 < b.length;) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return {width: u16be(i + 7), height: u16be(i + 5), format: 'jpg'};
      i += 2 + u16be(i + 2);
    }
  }
  return null;
}
