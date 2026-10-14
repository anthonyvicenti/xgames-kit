// Voice chat between the players of one game (gf-multiplayer 1.7.2; the creator, 2026-10-12: "if we made it so you could
// connect your mic when joining any game, it just had to be on the website. And then you could hear everyone voice in
// the stream", "Admin can kick, any player can mute them for themselves"). Plain browser JS, no imports: Studio's play
// page (components/play/voice-panel.tsx) uses it, and gf-three verify loads this same file into stand-in Studio pages.
//
// It runs on Studio's page, never on the play origin (every game shares that origin, which refuses the microphone).
// Each pair of players in voice has one WebRTC connection carrying audio only (Opus), so the browser's own echo
// cancellation, jitter buffer and loss handling apply, and voices play on this same page that holds the mic. The setup
// (offers, answers, network candidates, who is in voice) travels through the friends page in the game's frame and the
// room (kit net messages of type gf:vc): `send(to, d)` posts one, `handle(from, d)` takes one in.
//
//   const vc = createVoiceChat({ send: (to, d) => frame.postMessage({type:'gf:vc-send', to, d}, playOrigin), onChange });
//   vc.setRoom({you, players, ice});  vc.handle(from, d);  await vc.join();  await vc.micOn();  vc.mute(id, true);
//   vc.mix() → a MediaStream of everyone you hear plus your own mic (for a stream); vc.leave();
//
// Rules: the mic is off until micOn() (the browser asks the person first); "mute" is for this listener only (and for
// this listener's stream); a player who leaves the room or voice is hung up at once.

/** Can this browser do voice chat? */
export function voiceChatSupported() {
  return typeof window !== 'undefined' && typeof RTCPeerConnection === 'function' && !!navigator.mediaDevices?.getUserMedia && typeof AudioContext === 'function';
}

const seatOf = id => { const n = parseInt(String(id).slice(1), 10); return Number.isFinite(n) ? n : 0; };
const ID = /^p\d{1,4}$/;

export function createVoiceChat({ send, onChange = () => {}, log = () => {} }) {
  const S = {
    you: null, players: new Map(), ice: [], joined: false, inVoice: new Set(), muted: new Set(), peers: new Map(),
    mic: { on: false, busy: false, error: '' }, micStream: null, micTrack: null,
    ctx: null, mixOut: null, micGain: null, meters: new Map(), stats: { offers: 0, answers: 0, ice: 0, failed: 0 },
  };
  let changeTimer = null;
  const changed = () => { if (changeTimer) return; changeTimer = setTimeout(() => { changeTimer = null; try { onChange(); } catch (e) { log(e); } }, 0); };
  const tell = (to, d) => { try { send(to, d); } catch (e) { log(e); } };

  // ---- the audio graph: meters for everyone, and the mix for a stream ----
  function audio() {
    if (S.ctx) return S.ctx;
    S.ctx = new AudioContext();
    S.mixOut = S.ctx.createMediaStreamDestination();
    return S.ctx;
  }
  function meter(key, stream, toMix) {
    unmeter(key);
    const ctx = audio(), src = ctx.createMediaStreamSource(stream), an = ctx.createAnalyser(), gain = ctx.createGain();
    an.fftSize = 512; src.connect(an);
    gain.gain.value = toMix ? 1 : 0; src.connect(gain); gain.connect(S.mixOut);
    S.meters.set(key, { src, an, gain, buf: new Float32Array(an.fftSize) });
  }
  function unmeter(key) { const m = S.meters.get(key); if (!m) return; try { m.src.disconnect(); m.gain.disconnect(); } catch {} S.meters.delete(key); }
  function level(key) {
    const m = S.meters.get(key); if (!m) return 0;
    m.an.getFloatTimeDomainData(m.buf); let sq = 0; for (const x of m.buf) sq += x * x;
    return Math.min(1, Math.sqrt(sq / m.buf.length) * 4);
  }
  function setMixGain(id) { const m = S.meters.get(id); if (m) m.gain.gain.value = S.muted.has(id) ? 0 : 1; }

  // ---- one connection per other player in voice; the lower seat makes the offer ----
  function peer(id) {
    let p = S.peers.get(id);
    if (p) return p;
    const pc = new RTCPeerConnection({ iceServers: S.ice });
    p = { id, pc, pending: [], el: null, stream: null, offerer: seatOf(S.you) < seatOf(id), state: 'connecting' };
    S.peers.set(id, p);
    pc.onicecandidate = e => { if (e.candidate) { S.stats.ice++; tell(id, { k: 'ice', c: e.candidate.toJSON() }); } };
    pc.ontrack = e => {
      const stream = e.streams[0] || new MediaStream([e.track]);
      if (p.stream === stream) return;
      p.stream = stream;
      // an audio element plays the voice (WebRTC's own playout: echo cancellation knows it) and keeps the track flowing
      if (!p.el) { p.el = new Audio(); p.el.autoplay = true; }
      p.el.srcObject = stream; p.el.muted = S.muted.has(id);
      p.el.play().catch(() => {});
      meter(id, stream, !S.muted.has(id));
      changed();
    };
    pc.onconnectionstatechange = () => {
      p.state = pc.connectionState; changed();
      if (pc.connectionState === 'failed') {
        S.stats.failed++;
        hangup(id);
        // the offerer tries once more after a moment, if both are still in voice
        if (p.offerer) setTimeout(() => { if (S.joined && S.inVoice.has(id) && !S.peers.has(id)) connect(id); }, 2000);
      }
    };
    return p;
  }
  function prepare(p, tr) {
    tr.direction = 'sendrecv';
    try {
      const caps = RTCRtpReceiver.getCapabilities?.('audio')?.codecs ?? [];
      const opus = caps.filter(c => /opus/i.test(c.mimeType));
      if (opus.length && tr.setCodecPreferences) tr.setCodecPreferences(opus);    // a short offer: Opus only
    } catch {}
    tr.sender.replaceTrack(S.mic.on ? S.micTrack : null).catch(() => {});
  }
  async function connect(id) {
    if (!S.joined || id === S.you || !S.inVoice.has(id)) return;
    const p = peer(id);
    if (!p.offerer) return;                                   // the other side makes the offer
    if (p.pc.getTransceivers().length) return;
    const tr = p.pc.addTransceiver('audio', { direction: 'sendrecv' });
    prepare(p, tr);
    const offer = await p.pc.createOffer();
    await p.pc.setLocalDescription(offer);
    S.stats.offers++;
    tell(id, { k: 'offer', sdp: p.pc.localDescription.sdp });
  }
  function hangup(id) {
    const p = S.peers.get(id); if (!p) return;
    S.peers.delete(id); unmeter(id);
    try { p.pc.close(); } catch {}
    if (p.el) { p.el.srcObject = null; p.el = null; }
    changed();
  }

  // ---- the setup, from the other players ----
  async function handle(from, d) {
    if (!ID.test(from) || from === S.you || !d || typeof d !== 'object') return;
    if (d.k === 'here') {
      const was = S.inVoice.has(from);
      if (d.on === true) S.inVoice.add(from); else { S.inVoice.delete(from); hangup(from); }
      // a newcomer said so to everyone: answer them alone, so they know this player is in voice too
      if (d.on === true && !d.re && S.joined) tell(from, { k: 'here', on: true, re: 1 });
      if (d.on === true && S.joined && !was) connect(from);
      changed();
      return;
    }
    if (!S.joined || !S.inVoice.has(from)) return;
    try {
      if (d.k === 'offer' && typeof d.sdp === 'string') {
        let p = S.peers.get(from);
        if (p && p.pc.signalingState !== 'stable') { hangup(from); p = null; }
        if (p && p.pc.remoteDescription) { hangup(from); p = null; }          // the other side started over
        p = peer(from);
        await p.pc.setRemoteDescription({ type: 'offer', sdp: d.sdp });
        const tr = p.pc.getTransceivers()[0];
        if (tr) prepare(p, tr);
        const answer = await p.pc.createAnswer();
        await p.pc.setLocalDescription(answer);
        S.stats.answers++;
        tell(from, { k: 'answer', sdp: p.pc.localDescription.sdp });
        for (const c of p.pending.splice(0)) await p.pc.addIceCandidate(c).catch(() => {});
      } else if (d.k === 'answer' && typeof d.sdp === 'string') {
        const p = S.peers.get(from);
        if (!p || p.pc.signalingState !== 'have-local-offer') return;
        await p.pc.setRemoteDescription({ type: 'answer', sdp: d.sdp });
        for (const c of p.pending.splice(0)) await p.pc.addIceCandidate(c).catch(() => {});
      } else if (d.k === 'ice' && d.c && typeof d.c === 'object') {
        const p = S.peers.get(from) ?? (S.inVoice.has(from) ? peer(from) : null);
        if (!p) return;
        if (p.pc.remoteDescription) await p.pc.addIceCandidate(d.c).catch(() => {});
        else if (p.pending.length < 40) p.pending.push(d.c);
      }
    } catch (e) { log(e); }
  }

  // ---- the room (from the friends page) ----
  /** @param {{you?: string|null, players?: Array<{id: string, name?: string, color?: string, host?: boolean, you?: boolean, connected?: boolean}>, ice?: RTCIceServer[]}} room */
  function setRoom({ you, players = [], ice }) {
    const youWas = S.you;
    S.you = ID.test(you ?? '') ? you : null;
    if (Array.isArray(ice) && ice.length) S.ice = ice;
    S.players = new Map(players.filter(p => p && ID.test(p.id)).map(p => [p.id, p]));
    // gone from the room (left, or the host removed them): hung up and forgotten
    for (const id of [...S.inVoice]) if (!S.players.has(id) || S.players.get(id).connected === false) { S.inVoice.delete(id); hangup(id); }
    if (!S.you || (youWas && youWas !== S.you)) { if (S.joined) leave(); }
    changed();
  }

  async function join() {
    if (S.joined || !S.you) return;
    S.joined = true;
    const ctx = audio(); if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
    tell(null, { k: 'here', on: true });
    for (const id of S.inVoice) connect(id);
    changed();
  }
  function leave() {
    if (!S.joined) return;
    S.joined = false;
    tell(null, { k: 'here', on: false });
    for (const id of [...S.peers.keys()]) hangup(id);
    micOff();
    changed();
  }
  async function micOn() {
    if (S.mic.on || S.mic.busy || !S.joined) return;
    S.mic = { on: false, busy: true, error: '' }; changed();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 }, video: false });
      S.micStream = stream; S.micTrack = stream.getAudioTracks()[0];
      meter('me', stream, true);
      for (const p of S.peers.values()) for (const tr of p.pc.getTransceivers()) tr.sender.replaceTrack(S.micTrack).catch(() => {});
      S.mic = { on: true, busy: false, error: '' };
    } catch (e) {
      const n = e?.name;
      S.mic = { on: false, busy: false, error: n === 'NotAllowedError' ? 'The microphone is blocked. Allow it for this site in your browser, then try again.' : n === 'NotFoundError' ? 'No microphone was found.' : e?.message || 'The microphone couldn’t start.' };
    }
    changed();
  }
  function micOff() {
    for (const p of S.peers.values()) for (const tr of p.pc.getTransceivers()) tr.sender.replaceTrack(null).catch(() => {});
    unmeter('me');
    for (const t of S.micStream?.getTracks() ?? []) try { t.stop(); } catch {}
    S.micStream = null; S.micTrack = null;
    if (S.mic.on || S.mic.busy || S.mic.error) S.mic = { on: false, busy: false, error: '' };
    changed();
  }
  /** Mute (or unmute) one player for this listener only, and for this listener's stream. */
  function mute(id, on) {
    if (!ID.test(id) || id === S.you) return;
    if (on) S.muted.add(id); else S.muted.delete(id);
    const p = S.peers.get(id); if (p?.el) p.el.muted = !!on;
    setMixGain(id);
    changed();
  }

  function state() {
    const list = [...S.players.values()].map(p => {
      const peerOf = S.peers.get(p.id);
      return { id: p.id, name: p.name, color: p.color, host: !!p.host, you: p.id === S.you, inVoice: p.id === S.you ? S.joined : S.inVoice.has(p.id),
        connection: p.id === S.you ? null : peerOf ? peerOf.state : null, hearing: !!peerOf?.stream, muted: S.muted.has(p.id),
        level: p.id === S.you ? (S.mic.on ? level('me') : 0) : S.muted.has(p.id) ? 0 : level(p.id) };
    });
    return { joined: S.joined, you: S.you, mic: { ...S.mic }, players: list, stats: { ...S.stats, peers: S.peers.size } };
  }
  /** Everyone this listener hears (not muted) plus their own mic when it is on: the stream's voice. */
  function mix() { audio(); return S.mixOut.stream; }
  function close() { leave(); try { S.ctx?.close(); } catch {} S.ctx = null; }

  return { setRoom, handle, join, leave, micOn, micOff, mute, state, mix, close, level, get joined() { return S.joined; } };
}
