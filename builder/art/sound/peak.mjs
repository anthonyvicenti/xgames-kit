// Bring a sound's peak under full scale, as ingest's `--peak <dBFS>` step. A sound whose decoded samples reach full
// scale clips (the sound gate refuses it); this lowers the whole sound by one gain so its loudest sample sits at the
// peak asked for, and writes it back as Ogg (Opus, 48 kHz, the browser's own encoder through WebCodecs), so a file
// named .ogg stays an Ogg file. Lossy coding can overshoot by a fraction of a dB, so the result is decoded again and
// lowered once more when it still reaches full scale.
//
//   const { bytes, gainDb, peakDb } = await limitPeak(oggOrWavBytes, { peakDb: -1 });
import { findChrome } from '../render.mjs';

const ORIGIN = 'http://localhost';          // WebCodecs needs a secure context: localhost is one

// the page side: decode at 48 kHz, scale, encode Opus packets → [{ data (base64), duration (µs) }]
const PAGE = async ([b64, peakDb]) => {
  const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  const audio = await new OfflineAudioContext(1, 1, 48000).decodeAudioData(bytes.buffer);
  const ch = Math.min(2, audio.numberOfChannels), n = audio.length;
  let peak = 0;
  for (let c = 0; c < ch; c++) { const d = audio.getChannelData(c); for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(d[i])); }
  const gain = peak > 0 ? Math.min(1, 10 ** (peakDb / 20) / peak) : 1;
  const planar = new Float32Array(n * ch);
  for (let c = 0; c < ch; c++) { const d = audio.getChannelData(c); for (let i = 0; i < n; i++) planar[c * n + i] = d[i] * gain; }
  const packets = [];
  const enc = new AudioEncoder({ output: chunk => { const a = new Uint8Array(chunk.byteLength); chunk.copyTo(a); let s = ''; for (const x of a) s += String.fromCharCode(x); packets.push({ data: btoa(s), duration: chunk.duration }); }, error: e => { throw e; } });
  enc.configure({ codec: 'opus', sampleRate: 48000, numberOfChannels: ch, bitrate: 128000 });
  enc.encode(new AudioData({ format: 'f32-planar', sampleRate: 48000, numberOfFrames: n, numberOfChannels: ch, timestamp: 0, data: planar }));
  await enc.flush();
  return { packets, channels: ch, frames: n, peakBefore: 20 * Math.log10(peak || 1e-9), gainDb: 20 * Math.log10(gain) };
};
const PEAK = async b64 => {
  const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  const audio = await new OfflineAudioContext(1, 1, 48000).decodeAudioData(bytes.buffer);
  let peak = 0;
  for (let c = 0; c < audio.numberOfChannels; c++) for (const x of audio.getChannelData(c)) peak = Math.max(peak, Math.abs(x));
  return 20 * Math.log10(peak || 1e-9);
};

// ---- Ogg (RFC 3533) with Opus (RFC 7845) ------------------------------------------------------------------------
const CRC = (() => { const t = new Uint32Array(256); for (let i = 0; i < 256; i++) { let r = i << 24; for (let k = 0; k < 8; k++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1; t[i] = r >>> 0; } return t; })();
const crc32 = b => { let c = 0; for (const x of b) c = ((c << 8) ^ CRC[((c >>> 24) ^ x) & 0xff]) >>> 0; return c; };

function page(packet, { serial, seq, granule, first = false, last = false }) {
  const lacing = [];
  for (let left = packet.length; ; left -= 255) { if (left >= 255) lacing.push(255); else { lacing.push(left); break; } }
  const head = Buffer.alloc(27 + lacing.length);
  head.write('OggS', 0, 'latin1');
  head[5] = (first ? 2 : 0) | (last ? 4 : 0);
  head.writeBigInt64LE(BigInt(granule), 6);
  head.writeUInt32LE(serial, 14); head.writeUInt32LE(seq, 18);
  head[26] = lacing.length; lacing.forEach((l, i) => { head[27 + i] = l; });
  const out = Buffer.concat([head, packet]);
  out.writeUInt32LE(crc32(out), 22);
  return out;
}

export const PRE_SKIP = 312;                  // libopus's look-ahead at 48 kHz (6.5 ms), trimmed by the decoder

/** Opus packets → an Ogg Opus file. frames: the sound's length in samples at 48 kHz (the end is trimmed to it). */
export function oggOpus(packets, { channels, frames, serial = 0x67666b31 }) {
  const headPkt = Buffer.alloc(19);
  headPkt.write('OpusHead', 0, 'latin1'); headPkt[8] = 1; headPkt[9] = channels;
  headPkt.writeUInt16LE(PRE_SKIP, 10); headPkt.writeUInt32LE(48000, 12); headPkt.writeInt16LE(0, 16); headPkt[18] = 0;
  const vendor = Buffer.from('xgames-kit art peak', 'utf8');
  const tags = Buffer.alloc(8 + 4 + vendor.length + 4);
  tags.write('OpusTags', 0, 'latin1'); tags.writeUInt32LE(vendor.length, 8); vendor.copy(tags, 12); tags.writeUInt32LE(0, 12 + vendor.length);
  const pages = [page(headPkt, { serial, seq: 0, granule: 0, first: true }), page(tags, { serial, seq: 1, granule: 0 })];
  let samples = 0;
  packets.forEach((p, i) => {
    samples += Math.round((p.duration ?? 20000) * 48000 / 1e6);
    const last = i === packets.length - 1;
    pages.push(page(Buffer.from(p.data, 'base64'), { serial, seq: i + 2, granule: last ? PRE_SKIP + frames : Math.min(PRE_SKIP + frames, samples), last }));
  });
  return Buffer.concat(pages);
}

/** A sound's bytes → { bytes (Ogg Opus), gainDb, peakBefore, peakDb (decoded again) }. */
export async function limitPeak(bytes, { peakDb = -1, env = process.env } = {}) {
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ executablePath: findChrome(env) ?? undefined, headless: true });
  try {
    const p = await browser.newPage();
    await p.route(`${ORIGIN}/**`, r => r.fulfill({ status: 200, body: '<!doctype html><title>peak</title>', headers: { 'content-type': 'text/html' } }));
    await p.goto(`${ORIGIN}/peak`);
    let target = peakDb, out = null;
    for (let round = 0; round < 4; round++) {
      const r = await p.evaluate(PAGE, [Buffer.from(bytes).toString('base64'), target]);
      const ogg = oggOpus(r.packets, { channels: r.channels, frames: r.frames });
      const after = await p.evaluate(PEAK, ogg.toString('base64'));
      out = { bytes: ogg, gainDb: +r.gainDb.toFixed(2), peakBefore: +r.peakBefore.toFixed(2), peakDb: +after.toFixed(2) };
      if (after <= peakDb + 0.05) break;
      target -= after - peakDb + 0.1;           // the coding overshot: aim lower by what it overshot
    }
    return out;
  } finally { await browser.close(); }
}
