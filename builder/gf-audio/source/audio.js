// games.fun audio kit 1.5.0: browser runtime. Plays sounds only from a sound list (see sounds.mjs) through a fixed
// mix: sound → bus (sfx/music/ui/ambient) → master (player volume, mute) → limiter → speakers.
//
//   import { createAudio } from './audio/audio.js';
//   import sounds from './audio/sounds.json' with { type: 'json' };
//   const audio = createAudio(sounds, { storageKey: 'my-game' });
//   audio.play('shoot');            // respects cooldown, voice cap, jitter
//   audio.play('theme');            // music/ambient loop until audio.stop('theme')
//
// What it does for you: unlocks on the first pointer/key/touch (browsers keep audio suspended until then), drops
// one-shots fired before that instead of bursting them later, suspends when the tab is hidden, saves mute and
// volume in localStorage, and never lets the output clip.
import { buildSamples } from './zzfx.mjs';
import { resolveManifest, mixLayers, dbToGain, BUSES } from './sounds.mjs';

export const KIT_VERSION = '1.5.0';

// Limiter: a DynamicsCompressorNode with a hard knee. The Web Audio spec applies automatic makeup gain of
// 0.6 × |gain at 0 dBFS| dB; LIMIT_TRIM undoes it, so the limiter only ever turns sound down.
// With threshold -3 and ratio 20, the 0 dBFS gain is -2.85 dB, the makeup gain is +1.71 dB, and the ceiling is about -2.9 dBFS.
const LIMIT = { threshold: -3, knee: 0, ratio: 20, attack: 0.002, release: 0.15 };
const LIMIT_TRIM = dbToGain(-0.6 * -(LIMIT.threshold + -LIMIT.threshold / LIMIT.ratio));
const MAX_VOICES_TOTAL = 24;
const FADE = 0.015;
const SLICE_FADE = 0.004; // a one-shot slice that ends before its file does fades out over this long, so a cut mid-waveform doesn't click

/**
 * @param {object} manifest sound list object ({buses, sounds})
 * @param {object} [opts]
 * @param {object} [opts.presets] preset table (presets.json) for {preset} sources
 * @param {string} [opts.baseUrl] where {file} paths resolve from (default: the page)
 * @param {(path:string)=>string} [opts.fileUrl] map a {file} path to a URL. In Studio games, pass the data URLs from
 *   `import coin from './audio/coin.ogg'`, e.g. fileUrl: p => ({ 'audio/coin.ogg': coin })[p]
 * @param {string} [opts.storageKey] saves mute/volume under "gf-audio:<key>"; omit to not persist
 * @param {number} [opts.volume] starting player volume 0..1 when nothing is saved (default 0.7)
 * @param {boolean} [opts.listen] accept {type:'gf-audio:update'|'gf-audio:play'} postMessages from the parent frame (Studio preview)
 * @param {AudioContext} [opts.context] share an existing context
 */
export function createAudio(manifest, opts = {}) {
  const presets = opts.presets ?? {};
  const fileUrl = opts.fileUrl ?? (p => new URL(p, opts.baseUrl ?? document.baseURI).href);
  const storeKey = opts.storageKey ? `gf-audio:${opts.storageKey}` : null;
  const saved = load(storeKey);
  let muted = saved?.muted ?? false;
  let volume = clamp01(saved?.volume ?? opts.volume ?? 0.7);
  let m = resolveManifest(manifest, { presets });

  const ctx = opts.context ?? new (window.AudioContext || window.webkitAudioContext)();
  const limiter = ctx.createDynamicsCompressor();
  for (const [k, v] of Object.entries(LIMIT)) limiter[k].value = v;
  const trim = ctx.createGain(); trim.gain.value = LIMIT_TRIM;
  const master = ctx.createGain();
  master.connect(limiter).connect(trim).connect(ctx.destination);
  const buses = Object.fromEntries(BUSES.map(b => { const g = ctx.createGain(); g.connect(master); return [b, g]; }));
  const duckGain = Object.fromEntries(BUSES.map(b => [b, 1]));

  const buffers = new Map();   // id -> {key, p: Promise<clip[]>, done?: clip[]}; a clip is {buffer, offset, duration, sliced}
  const files = new Map();     // file path -> Promise<AudioBuffer>: a file several sounds play slices of is decoded once
  const voices = new Map();    // id -> [{src, gain, t}]
  const lastStart = new Map(); // id -> ctx time
  const lastVariant = new Map();
  const wantedLoops = new Set();
  const stats = { plays: {}, dropped: { cooldown: 0, voices: 0, locked: 0, total: 0, missing: 0 } };
  let unlocked = false, total = 0;

  function applyGains(ramp = 0.05) {
    const t = ctx.currentTime;
    master.gain.setTargetAtTime(muted ? 0 : dbToGain(m.buses.master) * volume * volume, t, ramp / 3);
    for (const b of BUSES) buses[b].gain.setTargetAtTime(dbToGain(m.buses[b]) * duckGain[b], t, ramp / 3);
  }
  master.gain.value = muted ? 0 : dbToGain(m.buses.master) * volume * volume;
  for (const b of BUSES) buses[b].gain.value = dbToGain(m.buses[b]);

  const whole = buffer => ({ buffer, offset: 0, duration: undefined, sliced: false });
  function decodeFile(path) {
    let p = files.get(path);
    if (!p) { p = readFile(fileUrl(path)).then(b => ctx.decodeAudioData(b)); files.set(path, p); p.catch(() => files.delete(path)); }
    return p;
  }
  // {file, start, end} (1.4.0): the clip is the whole decoded file plus the span to play. `end` is optional (to the
  // file's end) and anything past the file is clamped; a span with nothing in it is an error, so it warns once at load.
  function slice(buffer, { start, end }) {
    if (start === undefined && end === undefined) return whole(buffer);
    const offset = Math.min(start ?? 0, buffer.duration), stop = Math.min(end ?? buffer.duration, buffer.duration);
    if (stop <= offset) throw new Error(`slice ${start ?? 0}-${end ?? 'end'} s is outside the file (${buffer.duration.toFixed(2)} s)`);
    return { buffer, offset, duration: end === undefined ? undefined : stop - offset, sliced: true };
  }
  async function decode(src) {
    if (src.layers) { // render every layer, then mix to one buffer so the sound is one voice
      const clips = await Promise.all(src.layers.map(decode));
      const mixed = mixLayers(clips.map((c, i) => {
        const rate = c.buffer.sampleRate, from = Math.round(c.offset * rate), to = c.duration === undefined ? c.buffer.length : Math.min(c.buffer.length, from + Math.round(c.duration * rate));
        return { channels: Array.from({ length: c.buffer.numberOfChannels }, (_, ch) => c.buffer.getChannelData(ch).subarray(from, to)), gainDb: src.layers[i].gainDb, delayMs: src.layers[i].delayMs };
      }), ctx.sampleRate);
      const buf = ctx.createBuffer(mixed.length, mixed[0].length, ctx.sampleRate);
      mixed.forEach((ch, c) => buf.getChannelData(c).set(ch));
      return whole(buf);
    }
    if (src.zzfx) {
      const data = buildSamples(src.zzfx, { sampleRate: ctx.sampleRate, random: () => 0.5 });
      const buf = ctx.createBuffer(1, Math.max(1, data.length), ctx.sampleRate);
      buf.getChannelData(0).set(data);
      return whole(buf);
    }
    return slice(await decodeFile(src.file), src);
  }
  function prepare(id) {
    const s = m.sounds[id];
    const key = JSON.stringify(s.src);
    const hit = buffers.get(id);
    if (hit && hit.key === key) return hit.p;
    const p = Promise.all(s.src.map(decode));
    p.catch(e => console.warn(`audio: could not load "${id}":`, e.message));
    buffers.set(id, { key, p });
    return p;
  }
  // Sounds built in code (1.5.0, `code`) are the game's own synth, played by code-sounds.js: their preview files aren't decoded here.
  const prepareAll = () => Promise.allSettled(Object.keys(m.sounds).filter(id => !m.sounds[id].code).map(prepare));
  const ready = prepareAll();

  function start(id, s, clips, o) {
    let vi = 0;
    if (clips.length > 1) { const last = lastVariant.get(id); do vi = Math.floor(Math.random() * clips.length); while (vi === last); }
    lastVariant.set(id, vi);
    const clip = clips[vi];
    const src = ctx.createBufferSource();
    src.buffer = clip.buffer;
    src.loop = !!s.loop;
    // A looping slice loops inside its span. A slice with no `end` runs to the file's end (loopEnd 0 = the whole buffer).
    if (clip.sliced && s.loop) { src.loopStart = clip.offset; if (clip.duration !== undefined) src.loopEnd = clip.offset + clip.duration; }
    const pj = s.pitchJitter ? 1 + (Math.random() * 2 - 1) * s.pitchJitter : 1;
    const baseRate = s.pitch * pj;
    src.playbackRate.value = baseRate * (o.pitch ?? 1);
    const gj = s.gainJitterDb ? (Math.random() * 2 - 1) * s.gainJitterDb : 0;
    const baseDb = s.gainDb + gj;
    const g = ctx.createGain();
    const target = dbToGain(baseDb + (o.gainDb ?? 0));
    const t = Math.max(ctx.currentTime, o.at ?? 0); // o.at: a scheduled start on the AudioContext clock
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(target, t + (s.loop ? 0.25 : 0.003));
    const pan = ctx.createStereoPanner(); pan.pan.value = clampPan(o.pan);
    // A one-shot slice that stops before its file ends is cut by start()'s duration (buffer seconds, so the output
    // is duration / rate long). A short fade on its own gain node, which retuning doesn't touch, keeps the cut from clicking.
    let head = src;
    if (clip.sliced && !s.loop && clip.duration !== undefined && clip.offset + clip.duration < clip.buffer.duration - 0.002) {
      const tail = ctx.createGain(), end = t + clip.duration / src.playbackRate.value;
      tail.gain.setValueAtTime(1, Math.max(t, end - SLICE_FADE)); tail.gain.linearRampToValueAtTime(0, end);
      src.connect(tail); head = tail;
    }
    head.connect(pan).connect(g).connect(buses[s.bus]);
    const v = { src, gain: g, pan, t, baseRate, baseDb };
    const list = voices.get(id) ?? []; list.push(v); voices.set(id, list); total++;
    src.onended = () => { const l = voices.get(id); const i = l?.indexOf(v) ?? -1; if (i >= 0) { l.splice(i, 1); total--; } };
    if (!clip.sliced) src.start(t);
    else if (s.loop || clip.duration === undefined) src.start(t, clip.offset);   // the loop keeps going; no `end` plays to the file's end
    else src.start(t, clip.offset, clip.duration);
    stats.plays[id] = (stats.plays[id] ?? 0) + 1;
    return v;
  }
  function fadeOut(v, sec = FADE) {
    const t = ctx.currentTime;
    v.stopping = true;
    v.gain.gain.cancelScheduledValues(t);
    v.gain.gain.setValueAtTime(v.gain.gain.value, t);
    v.gain.gain.linearRampToValueAtTime(0, t + sec);
    try { v.src.stop(t + sec + 0.01); } catch {}
  }
  const drop = why => { stats.dropped[why]++; stats.dropped.total++; return null; };

  /** Play a sound. o: {gainDb, pitch, pan, at (AudioContext time to start), optional (no warning if the id is missing)}. Returns a handle {stop(fadeSec), set({pitch, gainDb, pan}), playing} or null when dropped. */
  function play(id, o = {}) {
    const s = m.sounds[id];
    if (!s) { if (!o.optional) console.warn(`audio: no sound "${id}"`); return drop('missing'); }
    if (s.loop) wantedLoops.add(id);
    if (!unlocked || ctx.state !== 'running') return s.loop ? null : drop('locked'); // loops start on unlock
    const now = ctx.currentTime;
    const live = s.loop && voices.get(id)?.find(v => !v.stopping);
    if (live) return handle(live);
    if (s.cooldownMs && Math.max(now, o.at ?? 0) - (lastStart.get(id) ?? -1e9) < s.cooldownMs / 1000) return drop('cooldown');
    const list = voices.get(id) ?? [];
    if (list.length >= s.maxVoices) fadeOut(list.shift(), FADE), total--;
    if (total >= MAX_VOICES_TOTAL && s.bus !== 'music') return drop('voices');
    lastStart.set(id, Math.max(now, o.at ?? 0));
    const hit = buffers.get(id);
    let v = null;
    // Buffers are usually ready (prepared at load). If not, start as soon as they are, unless it's stale by then.
    if (hit?.done) v = start(id, s, hit.done, o);
    else prepare(id).then(bufs => { const h = buffers.get(id); if (h) h.done = bufs; if (ctx.currentTime - now < 0.1 || s.loop || (o.at ?? 0) > ctx.currentTime) start(id, s, bufs, o); }).catch(() => {});
    return v ? handle(v) : null;
  }
  // Retune a playing voice. pitch and gainDb are relative to the sound's own settings, like play()'s options.
  function retune(v, o, sec = 0.05) {
    if (v.stopping) return;
    const t = ctx.currentTime;
    if (o.pitch !== undefined) v.src.playbackRate.setTargetAtTime(v.baseRate * o.pitch, t, sec / 3);
    if (o.gainDb !== undefined) { v.gain.gain.cancelScheduledValues(t); v.gain.gain.setTargetAtTime(dbToGain(v.baseDb + o.gainDb), t, sec / 3); }
    if (o.pan !== undefined) v.pan.pan.setTargetAtTime(clampPan(o.pan), t, sec / 3);
  }
  const handle = v => ({ stop: (sec = FADE) => fadeOut(v, sec), set: (o, sec) => retune(v, o, sec), get playing() { return !v.stopping; }, get rate() { return v.src.playbackRate.value; } });
  /**
   * An input into a bus, for audio the kit doesn't play itself (a game's own synth or sequencer). Connect your
   * engine's output here, never to ctx.destination or audio.output: this goes through the bus, master volume, mute
   * and the limiter like every kit sound. One input per bus; call again to get the same node.
   */
  const busInputs = {};
  function busInput(bus = 'music') {
    if (!BUSES.includes(bus)) throw new Error(`audio: no bus "${bus}"`);
    if (!busInputs[bus]) { busInputs[bus] = ctx.createGain(); busInputs[bus].connect(buses[bus]); }
    return busInputs[bus];
  }
  /** Retune every playing voice of a sound: {pitch, gainDb, pan}, e.g. a reel that clicks faster as the fish tires. */
  function set(id, o, sec) { for (const v of voices.get(id) ?? []) retune(v, o, sec); }

  /** Stop every voice of a sound (fades). Loops stay stopped until played again. */
  function stop(id, sec = 0.2) {
    wantedLoops.delete(id);
    for (const v of voices.get(id) ?? []) fadeOut(v, sec);
  }
  function stopAll(sec = 0.1) { for (const id of voices.keys()) stop(id, sec); }

  /** Duck a bus by `db` for `sec` seconds (e.g. music under a boss roar). sec = Infinity holds it until unduck(bus). */
  const duckTimers = {};
  function duck(bus, db = -8, sec = 0.6) {
    if (!(bus in duckGain)) return;
    duckGain[bus] = dbToGain(db); applyGains(0.05);
    clearTimeout(duckTimers[bus]);
    if (Number.isFinite(sec)) duckTimers[bus] = setTimeout(() => unduck(bus), sec * 1000);
  }
  /** Release a duck (e.g. on unpause). */
  function unduck(bus, sec = 0.4) {
    if (!(bus in duckGain)) return;
    clearTimeout(duckTimers[bus]); duckGain[bus] = 1; applyGains(sec);
  }

  function persist() { if (storeKey) try { localStorage.setItem(storeKey, JSON.stringify({ muted, volume })); } catch {} }

  // Mark prepared buffers as done so play() can start synchronously.
  ready.then(() => { for (const [id, h] of buffers) h.p.then(b => { if (buffers.get(id) === h) h.done = b; }, () => {}); });

  async function unlock() {
    if (unlocked && ctx.state === 'running') return;
    try { await ctx.resume(); } catch {}
    if (ctx.state !== 'running') return;
    unlocked = true;
    for (const id of wantedLoops) play(id); // play() reuses a loop that is already running
  }
  const gesture = () => unlock();
  for (const ev of ['pointerdown', 'keydown', 'touchstart']) window.addEventListener(ev, gesture, { capture: true, passive: true });
  const onVis = () => { if (document.hidden) ctx.suspend().catch(() => {}); else if (unlocked) ctx.resume().catch(() => {}); };
  document.addEventListener('visibilitychange', onVis);

  /** Replace the sound list (Studio live tuning). Changed sources are re-rendered; running loops keep playing. */
  function update(next) {
    m = resolveManifest(next, { presets });
    for (const id of [...buffers.keys()]) if (!m.sounds[id]) { buffers.delete(id); stop(id, 0.1); }
    const used = new Set(), walk = x => { if (x.layers) x.layers.forEach(walk); else if (x.file) used.add(x.file); };
    for (const s of Object.values(m.sounds)) s.src.forEach(walk);
    for (const path of [...files.keys()]) if (!used.has(path)) files.delete(path); // decoded files no sound plays any more
    prepareAll().then(() => { for (const [id, h] of buffers) h.p.then(b => { if (buffers.get(id) === h) h.done = b; }, () => {}); });
    applyGains(0.05);
  }

  /** Replace or add one sound (def = a sound entry), or remove it with def = null. */
  function setSound(id, def) {
    const raw = { buses: { ...m.buses }, sounds: Object.fromEntries(Object.entries(m.sounds).map(([k, s]) => [k, unresolve(s)])) };
    if (def) raw.sounds[id] = def; else delete raw.sounds[id];
    update(raw);
  }

  function onMessage(e) {
    if (e.source !== window.parent || window.parent === window) return;
    const d = e.data;
    if (d?.type === 'gf-audio:update' && d.manifest) update(d.manifest);
    else if (d?.type === 'gf-audio:set' && typeof d.id === 'string') setSound(d.id, d.def ?? null);
    else if (d?.type === 'gf-audio:play' && typeof d.id === 'string') play(d.id);
    else if (d?.type === 'gf-audio:stop') d.id ? stop(d.id) : stopAll();
  }
  if (opts.listen) window.addEventListener('message', onMessage);

  const api = {
    version: KIT_VERSION,
    context: ctx,
    output: trim, // final node before the speakers, after the limiter. For QA taps only; route sound into busInput()
    ready,
    play, stop, stopAll, set, duck, unduck, busInput, update, setSound, unlock,
    has: id => !!m.sounds[id],
    get manifest() { return m; },
    get muted() { return muted; },
    set muted(v) { muted = !!v; applyGains(); persist(); },
    toggleMute() { api.muted = !muted; return muted; },
    get volume() { return volume; },
    set volume(v) { volume = clamp01(v); applyGains(); persist(); },
    setBus(bus, db) { if (bus in m.buses) { m.buses[bus] = db; applyGains(); } },
    stats,
    destroy() {
      stopAll(0.05);
      for (const ev of ['pointerdown', 'keydown', 'touchstart']) window.removeEventListener(ev, gesture, { capture: true });
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('message', onMessage);
      if (!opts.context) setTimeout(() => ctx.close().catch(() => {}), 100);
    },
  };
  return api;
}

/**
 * A small mute button + volume slider. Returns the element; place it anywhere (it's unstyled beyond basics).
 * Games should also map a key (M) to audio.toggleMute().
 */
export function mountAudioControls(audio, parent = document.body) {
  const el = document.createElement('div');
  el.className = 'gf-audio-controls';
  el.style.cssText = 'display:inline-flex;align-items:center;gap:6px;font:12px system-ui,sans-serif;';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.style.cssText = 'min-width:32px;cursor:pointer;';
  const slider = document.createElement('input');
  slider.type = 'range'; slider.min = '0'; slider.max = '100'; slider.setAttribute('aria-label', 'Volume');
  slider.style.width = '80px';
  const sync = () => { btn.textContent = audio.muted ? '🔇' : '🔊'; btn.setAttribute('aria-label', audio.muted ? 'Unmute' : 'Mute'); slider.value = String(Math.round(audio.volume * 100)); };
  btn.addEventListener('click', e => { e.stopPropagation(); audio.toggleMute(); sync(); });
  slider.addEventListener('input', e => { e.stopPropagation(); audio.volume = slider.valueAsNumber / 100; if (audio.muted && audio.volume > 0) audio.muted = false; sync(); });
  for (const ev of ['pointerdown', 'keydown']) slider.addEventListener(ev, e => e.stopPropagation());
  el.append(btn, slider); sync(); parent.append(el);
  el.sync = sync;
  return el;
}

// Resolved sound → manifest entry (presets go back to {preset}, the single-source array back to one object).
function unresolve(s) {
  const { id, ...rest } = s;
  const leaf = x => { if (!x.preset) return x; const { zzfx, ...rest } = x; return rest; };
  const src = s.src.map(x => (x.layers ? { layers: x.layers.map(leaf) } : leaf(x)));
  return { ...rest, src: src.length === 1 ? src[0] : src };
}

// data: URLs (what the Studio packer turns imported files into) are decoded here with no network request;
// other URLs (unpacked trials served over http) are fetched.
async function readFile(url) {
  const m = /^data:[^,]*?(;base64)?,(.*)$/s.exec(url);
  if (m) {
    if (!m[1]) return new TextEncoder().encode(decodeURIComponent(m[2])).buffer;
    const bin = atob(m[2]), u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u.buffer;
  }
  const get = globalThis.fetch;
  const res = await get(url);
  if (!res.ok) throw new Error(`audio: ${url} HTTP ${res.status}`);
  return res.arrayBuffer();
}

function load(key) { if (!key) return null; try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; } }
function clampPan(v) { return Math.max(-1, Math.min(1, Number(v) || 0)); }
function clamp01(v) { return Math.max(0, Math.min(1, Number(v) || 0)); }
