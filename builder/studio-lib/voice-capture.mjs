// The streamer's voice (2026-10-12; the creator: "How hard would it be to add in an audio stream from a mic for the
// stream watchers", then "the streamer being forced on the website is fine"). Plain browser JS, no imports: the play
// page (components/play/play-room.tsx) uses it, and gf-three verify check 34 loads this same file into a stand-in
// streamer page with Chrome's fake microphone.
//
// The microphone is opened here, on the Studio page, never on the play origin: every game shares that origin, which
// sends `permissions-policy: microphone=()` (lib/play-policy.mjs), and a grant there would let any game listen later.
// What leaves this page is compressed audio only: Opus (WebCodecs AudioEncoder), 20 ms packets, mono, about 24 kbit/s,
// posted every 100 ms to the friends page in the game's frame ({type: 'gf:voice', v: 1, f: 20, ms, d}), which sends it
// over its stream (gf-multiplayer 1.7.0, `a` frames; research/watch/relay/core.mjs keeps a byte budget per stream).
//
// `d` is base64 of the packets one after another, each a 2-byte big-endian length then its bytes (packVoice /
// unpackVoice; the kit's party.js reads the same layout).
//
//   if (voiceSupported()) { const v = await startVoice({ send: msg => frame.postMessage(msg, playOrigin) }); ... v.stop(); }

export const VOICE_FRAME_MS = 20, VOICE_POST_MS = 100, VOICE_BITRATE = 24000;

/** Can this browser send voice? (a microphone API, WebCodecs' AudioEncoder, AudioWorklet) */
export function voiceSupported() {
  return typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && typeof AudioEncoder === 'function'
    && typeof AudioData === 'function' && typeof AudioWorkletNode === 'function';
}

/** Packets → base64 of [u16 length, bytes]… */
export function packVoice(packets) {
  let n = 0; for (const p of packets) n += 2 + p.length;
  const out = new Uint8Array(n); let o = 0;
  for (const p of packets) { out[o++] = p.length >> 8; out[o++] = p.length & 255; out.set(p, o); o += p.length; }
  let s = ''; for (let i = 0; i < out.length; i++) s += String.fromCharCode(out[i]);
  return btoa(s);
}
/** base64 → packets (the inverse of packVoice; a broken tail is dropped). */
export function unpackVoice(b64) {
  const s = atob(b64), bytes = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  const out = [];
  for (let o = 0; o + 2 <= bytes.length;) { const n = (bytes[o] << 8) | bytes[o + 1]; o += 2; if (!n || o + n > bytes.length) break; out.push(bytes.slice(o, o + n)); o += n; }
  return out;
}

const WORKLET = `class GfVoiceTap extends AudioWorkletProcessor {
  process(inputs) { const ch = inputs[0] && inputs[0][0]; if (ch && ch.length) this.port.postMessage(ch.slice(0)); return true; }
}
registerProcessor('gf-voice-tap', GfVoiceTap);`;

/**
 * Open the microphone and send compressed voice until stop(). The browser asks the person first; a refusal throws
 * (err.name 'NotAllowedError'). → { stop(), level() 0..1 (the last 100 ms, for a meter), stats() }
 * send(msg) posts one message to the friends page; onError(err) hears an encoder failure after the start.
 */
export async function startVoice({ send, onError = () => {}, bitrate = VOICE_BITRATE, constraints = {}, stream: given = null }) {
  if (!voiceSupported()) throw Object.assign(new Error('This browser can’t send voice.'), { name: 'NotSupportedError' });
  // `stream`: send this audio instead of opening the microphone (voice chat's mix of the room, lib/voice-chat.mjs);
  // its tracks are the caller's and are not stopped here
  const stream = given ?? await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1, ...constraints }, video: false });
  const stopTracks = () => { if (!given) for (const t of stream.getTracks()) try { t.stop(); } catch {} };
  let ctx = null, enc = null, node = null, timer = null, stopped = false;
  const stats = { packets: 0, posts: 0, bytes: 0, errors: 0 };
  try {
    ctx = new AudioContext({ sampleRate: 48000 });
    // started from code, not a click (voice chat's mix when the stream goes live): resume it (the page has been clicked)
    if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
    const rate = ctx.sampleRate, config = { codec: 'opus', sampleRate: rate, numberOfChannels: 1, bitrate, opus: { frameDuration: VOICE_FRAME_MS * 1000 } };
    const ok = await AudioEncoder.isConfigSupported(config).catch(() => null);
    if (!ok?.supported) throw Object.assign(new Error(`This browser can’t make Opus voice at ${rate} Hz.`), { name: 'NotSupportedError' });
    const pending = [];
    enc = new AudioEncoder({
      output: chunk => { const b = new Uint8Array(chunk.byteLength); chunk.copyTo(b); if (b.length < 65536) pending.push(b); stats.packets++; },
      error: e => { stats.errors++; onError(e); },
    });
    enc.configure(config);
    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
    try { await ctx.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
    const src = ctx.createMediaStreamSource(stream);
    node = new AudioWorkletNode(ctx, 'gf-voice-tap');
    const hush = ctx.createGain(); hush.gain.value = 0;                 // keeps the tap pulled; nothing is heard here
    src.connect(node); node.connect(hush); hush.connect(ctx.destination);
    const per = Math.round(rate * VOICE_FRAME_MS / 1000);
    let buf = new Float32Array(per), fill = 0, ts = 0, sq = 0, sqN = 0, level = 0;
    node.port.onmessage = e => {
      if (stopped || enc.state !== 'configured') return;
      const x = e.data;
      for (let i = 0; i < x.length; i++) {
        buf[fill++] = x[i]; sq += x[i] * x[i]; sqN++;
        if (fill === per) {
          const ad = new AudioData({ format: 'f32-planar', sampleRate: rate, numberOfFrames: per, numberOfChannels: 1, timestamp: ts, data: buf });
          try { enc.encode(ad); } catch { stats.errors++; } finally { ad.close(); }
          ts += VOICE_FRAME_MS * 1000; buf = new Float32Array(per); fill = 0;
        }
      }
    };
    timer = setInterval(() => {
      level = sqN ? Math.min(1, Math.sqrt(sq / sqN) * 4) : 0; sq = 0; sqN = 0;
      if (!pending.length) return;
      const batch = pending.splice(0, pending.length);
      const d = packVoice(batch);
      stats.posts++; stats.bytes += d.length;
      send({ type: 'gf:voice', v: 1, f: VOICE_FRAME_MS, ms: batch.length * VOICE_FRAME_MS, d });
    }, VOICE_POST_MS);
    const stop = () => {
      if (stopped) return; stopped = true;
      clearInterval(timer);
      try { node.port.onmessage = null; node.disconnect(); } catch {}
      try { if (enc.state !== 'closed') enc.close(); } catch {}
      try { ctx.close(); } catch {}
      stopTracks();
    };
    return { stop, level: () => level, stats: () => ({ ...stats }) };
  } catch (e) {
    try { if (enc && enc.state !== 'closed') enc.close(); } catch {}
    try { ctx?.close(); } catch {}
    stopTracks();
    throw e;
  }
}
