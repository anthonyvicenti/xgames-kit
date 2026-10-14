// What a file is, from its first bytes (never from its name alone). → { format, dimension, mime } or null.
const starts = (b, sig, at = 0) => b.length >= at + sig.length && sig.every((v, i) => b[at + i] === v);
const ascii = (b, s, at = 0) => b.length >= at + s.length && b.toString('latin1', at, at + s.length) === s;

const KTX2 = [0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a];

export const FORMATS = {
  glb: { dimension: '3d', mime: 'model/gltf-binary' },
  gltf: { dimension: '3d', mime: 'model/gltf+json' },
  png: { dimension: '2d', mime: 'image/png' },
  jpg: { dimension: '2d', mime: 'image/jpeg' },
  webp: { dimension: '2d', mime: 'image/webp' },
  ktx2: { dimension: '2d', mime: 'image/ktx2' },
  svg: { dimension: '2d', mime: 'image/svg+xml' },
  ogg: { dimension: 'audio', mime: 'audio/ogg' },
  wav: { dimension: 'audio', mime: 'audio/wav' },
  mp3: { dimension: 'audio', mime: 'audio/mpeg' },
  ttf: { dimension: 'font', mime: 'font/ttf' },
  otf: { dimension: 'font', mime: 'font/otf' },
  woff2: { dimension: 'font', mime: 'font/woff2' },
};

export function detect(bytes) {
  const b = Buffer.from(bytes);
  let format = null;
  if (ascii(b, 'glTF')) format = 'glb';
  else if (starts(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) format = 'png';
  else if (starts(b, [0xff, 0xd8, 0xff])) format = 'jpg';
  else if (ascii(b, 'RIFF') && ascii(b, 'WEBP', 8)) format = 'webp';
  else if (ascii(b, 'RIFF') && ascii(b, 'WAVE', 8)) format = 'wav';
  else if (starts(b, KTX2)) format = 'ktx2';
  else if (ascii(b, 'OggS')) format = 'ogg';
  else if (ascii(b, 'ID3') || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) format = 'mp3';
  else if (ascii(b, 'wOF2')) format = 'woff2';
  else if (starts(b, [0, 1, 0, 0, 0])) format = 'ttf';
  else if (ascii(b, 'OTTO')) format = 'otf';
  else {
    const head = b.toString('utf8', 0, Math.min(b.length, 512)).trimStart();
    if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) format = 'svg';
    else if (head.startsWith('{') && /"asset"\s*:/.test(b.toString('utf8', 0, Math.min(b.length, 4096)))) format = 'gltf';
  }
  return format ? { format, ...FORMATS[format] } : null;
}

/** The file extension a format is kept under. */
export const extensionOf = format => (format === 'jpg' ? 'jpg' : format);
