/*! gf-p2p.js v0.4.0: games.fun host-join (peer-to-peer) multiplayer bridge. MIT. research/multiplayer/p2p/kit/gf-p2p.js
 *
 * Drop-in for vendor/gf.js in a game with a room.js: it defines the SAME window.gf.room surface
 * (available, on('welcome'|'players'|'message'|'ended'|'closed'|'error'), send, you), so room clients written for
 * the platform shell run unchanged. Instead of a platform server:
 *   - the HOST's browser runs the game's room.js + bot.js in a module Web Worker (p2p/host-worker.js), through
 *     the platform's own sandbox runner (p2p/sandbox-core.js, byte-identical to runtime/src/sandbox/core.js);
 *   - JOINERS connect to the host over a WebRTC data channel (reliable, ordered);
 *   - signaling only introduces them: room code → host, offer/answer/ICE. Two transports (v0.2.0): a WebSocket at
 *     /signal (signal-server.mjs, on this machine) or HTTP at /signal/v1 (creator-studio/lib/signal-core.mjs: Studio's
 *     play origin, and the Node server too). See "signaling transports" below for which one a page uses.
 * The host's own game client gets only its seat's messages, exactly like a joiner; the room state stays in the worker.
 * It also injects a small lobby (shadow DOM): name, Host a game, Join by code or ?join=CODE invite link, player list,
 * Start / fill with bots, and the end states (host closed the game, connection failed, room full).
 * v0.3.0 (gf-multiplayer 1.4.0): a name is never blank (the one you used last, else a rolled '<adjective> <noun>' with a
 * dice button); gf.room.rename(name) changes it in the room at any time, gf.room.leave() leaves (the host: closes the
 * room for everyone), gf.room.name is the name the room keeps; config bar: 'none' draws no in-game pill (a page that
 * draws its own room controls, as the party shell does).
 * v0.4.0 (gf-multiplayer 1.5.0): WORLD rooms, for a page that stays open while rooms come and go (the party shell's
 * world mode; research/worlds/PLAN.md). gf.world.find(key) asks signaling for the live room keyed 'world:<slug>';
 * gf.world.host(opts) claims the key and hosts (or answers 'taken' with the room that holds it); gf.world.join(code,
 * opts) joins; gf.world.leave() leaves (the host closes the room for everyone); gf.world.reset() forgets the session
 * so the next one can start, with no page reload. A world session sends the tab's id (cid) in its hello, keeps no
 * resume token and no ?join= in the address bar, treats 6 s of host silence as the host gone, and gives up on a host
 * that sends no offer within opts.offerMs. Its liveness timers run on a worker clock (not slowed in a background tab).
 * Every end of a session is the 'end' event {phase, why, reason, role, code}; a world host whose signaling session
 * ends gets 'signal' {state:'lost'} and re-claims with gf.world.rehost(). Config ui: 'none' draws no overlay at all.
 * Live, race and room pages never call gf.world and behave exactly as in v0.3.0.
 * v0.4.1 (gf-multiplayer 1.6.4): (1) the host stops sending ICE candidates to a joiner once its data channel is open, and a
 * candidate still queued behind the HTTP signaling POSTs is dropped at send time. A joiner leaves signaling the moment its
 * channel opens; the reflexive and relay candidates the host gathers after that used to come back 400 "no such peer"
 * (about ten per join on the play host, seen on Bone Vigil, 2026-10-11). (2) ONLINE: p2p.json "online" is the address of a
 * play host's signaling (https://.../signal/v1); config signal 'online' or ?signal=online uses it from any page, a locally
 * served game included, with that host's ICE servers (relay credentials) and its plain refusals shown to the player. When
 * that host cannot be reached at all the page falls back to the WebSocket on this machine (two tabs). Without the setting a
 * localhost page keeps the WebSocket on this machine, exactly as before.
 *
 * Layout (written by research/multiplayer/p2p/vendor.mjs):  <site>/index.html (the game client) · vendor/gf.js (this
 * file) · p2p.json · room.js · bot.js · p2p/{host-worker.js, host-engine.js, sandbox-core.js, rng.js}
 * Config: p2p.json {room, bot, start:'lobby'|'live', title, signal?, iceServers?}, overridden by window.GF_P2P_CONFIG.
 * Query: ?join=CODE (invite link) · ?stun=1 / ?stun=0 (force public STUN on/off) · ?signal=http|ws|auto|<url>.
 */
(function () {
  'use strict';
  if (typeof window === 'undefined' || window.gf) return;

  var script = document.currentScript;
  var siteBase = new URL('../', (script && script.src) || location.href);   // vendor/gf.js → site root
  var params = new URLSearchParams(location.search);
  var LOCALHOST = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/.test(location.hostname);
  var PUBLIC_STUN = [{ urls: 'stun:stun.l.google.com:19302' }];
  var CONNECT_TIMEOUT_MS = 20000;
  var cfg = null, cfgLoaded = null;
  var cfgReady = new Promise(function (r) { cfgLoaded = r; });     // world calls wait for p2p.json (v0.4.0)

  // ---------------- gf surface (same as sdk/gf.js) ----------------
  var listeners = {}, welcome = null;
  var EVENTS = { welcome: 1, players: 1, message: 1, ended: 1, closed: 1, error: 1, end: 1, signal: 1 };
  function fire(ev, data) {
    if (ev === 'welcome') welcome = data;
    var ls = listeners[ev] || [];
    for (var i = 0; i < ls.length; i++) { try { ls[i](data); } catch (err) { console.error(err); } }
  }
  function rng(seed) {   // cyrb128 + sfc32 (public domain, bryc), identical to sdk/gf.js
    var str = String(seed), h1 = 1779033703, h2 = 3144134277, h3 = 1013904242, h4 = 2773480762;
    for (var i = 0, k; i < str.length; i++) {
      k = str.charCodeAt(i);
      h1 = h2 ^ Math.imul(h1 ^ k, 597399067); h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
      h3 = h4 ^ Math.imul(h3 ^ k, 951274213); h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
    }
    h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067); h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
    h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213); h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
    var a = (h1 ^ h2 ^ h3 ^ h4) >>> 0, b = (h2 ^ h1) >>> 0, c = (h3 ^ h1) >>> 0, d = (h4 ^ h1) >>> 0;
    return function () {
      a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
      var t = (a + b) | 0; a = b ^ (b >>> 9); b = (c + (c << 3)) | 0; c = (c << 21) | (c >>> 11);
      d = (d + 1) | 0; t = (t + d) | 0; c = (c + t) | 0;
      return (t >>> 0) / 4294967296;
    };
  }
  var noop = function () {};

  window.gf = Object.freeze({
    version: '0.2.0-p2p', protocol: 1, embedded: false, p2p: true, rng: rng,
    run: Object.freeze({ seed: null, mode: null, start: function () { return 0; }, progress: noop, end: noop, get active() { return false; } }),
    ghost: Object.freeze({ sample: noop, onTrack: noop }),
    room: Object.freeze({
      available: true,
      /** Change this player's name in the room (any time). The room cleans it and keeps it unique: see 'renamed'. */
      rename: function (name) {
        var v = typeof name === 'string' ? name.replace(/\s+/g, ' ').trim().slice(0, 24) : '';
        if (!v || !S.code) return false;
        S.name = v; saveName(v);
        sendFrameText(JSON.stringify({ k: 'name', name: v }));
        return true;
      },
      /** The host locks the room (on) or opens it again: while locked nobody new can join (gf-multiplayer 1.6.6). */
      lock: function (on) { if (S.role !== 'host' || !S.code) return false; hostCmd({ k: 'lock', on: on === true }); return true; },
      /** The host removes a player (gf-multiplayer 1.7.2): they see that the host removed them, and their browser can't
       *  join this room again while this host runs it. Never the host's own seat. */
      kick: function (playerId) { if (S.role !== 'host' || !S.code || typeof playerId !== 'string' || !/^p\d{1,4}$/.test(playerId)) return false; hostCmd({ k: 'kick', playerId: playerId }); return true; },
      /** The STUN/TURN servers this page connects with (for the page above's own connections, e.g. voice chat). */
      get ice() { return iceServers(); },
      get locked() { return !!(S.lobby && S.lobby.locked); },
      /** Leave the room: a joiner gives up its seat; the host closes the room for everyone. */
      leave: function () { if (S.role === 'host') closeGame(); else leave(); },
      get name() { return S.name || null; },
      get code() { return S.code || null; },
      get hosting() { return S.role === 'host'; },
      on: function (event, fn) {
        if (!EVENTS[event] || typeof fn !== 'function') return;
        (listeners[event] = listeners[event] || []).push(fn);
        if (event === 'welcome' && welcome) fn(welcome);
      },
      send: function (data) {
        if (!data || typeof data !== 'object' || Array.isArray(data)) return;
        var text; try { text = JSON.stringify({ k: 'send', data: data }); } catch (e) { return; }
        if (text.length > 4096 + 32) { console.warn('gf.room.send: message over 4 KB dropped'); return; }
        sendFrameText(text);
      },
      get you() { return welcome ? welcome.you : null; },
    }),
    // World rooms (v0.4.0). Every call that starts a session first forgets the last one (reset).
    world: Object.freeze({
      /** → Promise<{t:'found', code, n, max} | {t:'none'} | {t:'error', code, reason}> ('unreachable' when signaling is). */
      find: function (key) { return worldFind(key); },
      /** opts {key, name, cid, max} → Promise<{t:'hosted', code} | {t:'error', code:'taken', room, n, max} | {t:'error', code, reason}> */
      host: function (opts) { return worldHost(opts || {}); },
      /** opts {key, name, cid, offerMs} → Promise<{t:'in', you, code} | {t:'error', code: why, reason}> (resolves at the welcome) */
      join: function (code, opts) { return worldJoin(code, opts || {}); },
      /** The host lost its signaling session: claim the key again for the same room → Promise like host(). */
      rehost: function () { return worldRehost(); },
      leave: function () { worldLeave(); },
      reset: function () { resetSession(); },
      /** The name to offer: the one used last, else a rolled '<adjective> <noun>'. roll(): another one. */
      name: function () { return savedName() || rollName(); },
      roll: function () { return rollName(); },
      saveName: function (n) { if (typeof n === 'string' && n.trim()) saveName(n.replace(/\s+/g, ' ').trim().slice(0, 24)); },
      get state() { return { role: S.role, phase: S.phase, code: S.code, you: S.you, key: W ? W.key : null, n: S.seatN || 0, signal: transport ? transport.kind : null }; },
    }),
    debugLog: function () { return []; },
  });

  // ---------------- session ----------------
  var S = { role: null, phase: 'home', code: null, you: null, lobby: null, reason: '', detail: '', connected: false, rtt: null };
  var sig = null, worker = null, peers = {}, dc = null, pc = null, connectTimer = null, gotClosedFrame = false;
  // v0.4.0 world sessions: `epoch` counts sessions (a callback from an earlier one does nothing); W is this session's
  // world ({key, cid, max, offerMs, resolve}) or null; `stops` are its timers to cancel on reset.
  var epoch = 0, W = null, stops = [];
  var WORLD_SILENT_MS = 6000, WORLD_BEAT_MS = 4000;
  // A repeating clock. In a world it runs on a Web Worker's timer, which a background tab does not slow the way it
  // slows page timers (the trick net.js's loop uses), so pings and the liveness watch keep time. → stop()
  function ticker(fn, ms) {
    if (W) {
      try {
        var w = new Worker(URL.createObjectURL(new Blob(['setInterval(function(){postMessage(0)},' + (ms | 0) + ')'], { type: 'text/javascript' })));
        w.onmessage = function () { fn(); };
        return function () { w.terminate(); };
      } catch (e) { /* no worker (a strict page policy): a page timer */ }
    }
    var id = setInterval(fn, ms);
    return function () { clearInterval(id); };
  }

  function store(k, v) { try { if (v == null) sessionStorage.removeItem(k); else sessionStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  function load(k) { try { return JSON.parse(sessionStorage.getItem(k) || 'null'); } catch (e) { return null; } }
  function savedName() { try { return localStorage.getItem('gf-p2p:name') || ''; } catch (e) { return ''; } }
  function saveName(n) { try { localStorage.setItem('gf-p2p:name', n); } catch (e) {} }
  // This browser's id (1.7.2), not a secret: a host's Remove refuses it. Clearing the site's storage makes a new one, so
  // it keeps out a removed player who just clicks the link again, not a determined one (the host can also lock the room).
  var BID = null;
  function browserId() {
    if (BID) return BID;
    try { BID = localStorage.getItem('gf-p2p:bid'); } catch (e) {}
    if (!BID || !/^[a-z0-9]{12}$/.test(BID)) {
      var a = new Uint8Array(12); crypto.getRandomValues(a); BID = '';
      for (var i = 0; i < 12; i++) BID += (a[i] % 36).toString(36);
      try { localStorage.setItem('gf-p2p:bid', BID); } catch (e) {}
    }
    return BID;
  }

  // ---------------- signaling transports ----------------
  // Two transports behind one handle ({kind, send(obj), close()}), so the host and joiner code below is the same for both:
  //   ws    the WebSocket at /signal (research/multiplayer/p2p/signal-server.mjs), on this machine
  //   http  POST /signal/v1 and a long-poll (creator-studio/lib/signal-core.mjs): Studio's play origin, which runs on
  //         Vercel and can't hold a WebSocket. The Node server answers it too.
  // Which one: ?signal= wins, then GF_P2P_CONFIG / p2p.json "signal": 'http' | 'ws' | 'auto' | a URL (one ending in
  // /signal/v1 is HTTP, any other is a WebSocket URL, as in v0.1). Otherwise a page on localhost / 127.0.0.1 keeps the
  // WebSocket, exactly as before; any other page uses HTTP when GET /signal/v1/ice answers (and takes its ICE servers:
  // STUN, plus TURN when the platform has one), else falls back to the WebSocket. Neither answering is an error panel
  // after at most PROBE_MS + WS_OPEN_MS, never a lobby that hangs.
  var HTTP_PATH = '/signal/v1', PROBE_MS = 4000, WS_OPEN_MS = 8000, POST_MS = 10000, POLL_MS = 15000;
  var transport = null, choosing = null;

  function cleanIce(list) {
    return list.slice(0, 8).filter(function (s) { return s && typeof s === 'object' && (typeof s.urls === 'string' || Array.isArray(s.urls)); })
      .map(function (s) { var o = { urls: s.urls }; if (typeof s.username === 'string') o.username = s.username; if (typeof s.credential === 'string') o.credential = s.credential; return o; });
  }
  // GET <base>/ice → {iceServers} when HTTP signaling answers there, else null (never throws, gives up after PROBE_MS).
  function probeIce(base) {
    if (typeof fetch !== 'function') return Promise.resolve(null);
    var ctl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctl) ctl.abort(); }, PROBE_MS);
    return fetch(base + '/ice', { cache: 'no-store', credentials: 'same-origin', signal: ctl ? ctl.signal : undefined })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { clearTimeout(timer); return j && j.signal === 'http' && Array.isArray(j.iceServers) ? { iceServers: cleanIce(j.iceServers) } : null; },
        function () { clearTimeout(timer); return null; });
  }
  // GET <online>/ice → {reached, ice}: reached when the host answered at all (a refusal is an answer), ice when it gave servers.
  function probeOnline(base) {
    if (typeof fetch !== 'function') return Promise.resolve({ reached: false });
    var ctl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctl) ctl.abort(); }, PROBE_MS);
    return fetch(base + '/ice', { cache: 'no-store', credentials: 'omit', signal: ctl ? ctl.signal : undefined })
      .then(function (r) { return r.json().then(function (j) { return { r: r, j: j }; }, function () { return { r: r, j: null }; }); })
      .then(function (x) {
        clearTimeout(timer);
        var ok = x.r.ok && x.j && x.j.signal === 'http' && Array.isArray(x.j.iceServers);
        return { reached: !!(ok || (x.j && x.j.t === 'error')), ice: ok ? cleanIce(x.j.iceServers) : undefined };
      }, function () { clearTimeout(timer); return { reached: false }; });
  }
  function chooseTransport() {
    if (choosing) return choosing;
    var raw = String(params.get('signal') || (cfg && cfg.signal) || '').trim(), low = raw.toLowerCase();
    var wsDefault = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/signal';
    var httpDefault = location.origin + HTTP_PATH;
    var pick = function (t) { transport = t; return t; };
    var http = function (url, why) {
      var remote = false; try { remote = new URL(url, location.href).origin !== location.origin; } catch (e) {}
      return probeIce(url).then(function (j) { return pick({ kind: 'http', url: url, ice: j && j.iceServers, why: why, remote: remote }); });
    };
    var online = onlineUrl();
    // 'online': the play host when it answers (even to refuse: its words reach the player, "off for now", "try again in
    // 12 minutes"); the WebSocket on this machine when it cannot be reached at all (no network), so a person building
    // offline still plays in two tabs.
    if (low === 'online' && online) choosing = probeOnline(online).then(function (r) {
      if (r.reached) return pick({ kind: 'http', url: online, ice: r.ice, why: 'online', remote: true });
      return pick({ kind: 'ws', url: wsDefault, why: 'online-unreachable' });
    });
    else if (low === 'ws') choosing = Promise.resolve(pick({ kind: 'ws', url: wsDefault, why: 'forced' }));
    else if (low === 'http') choosing = http(httpDefault, 'forced');
    else if (raw && low !== 'auto' && low !== 'online') {
      var u = null; try { u = new URL(raw, location.href); } catch (e) {}
      if (u && /^https?:$/.test(u.protocol) && /\/signal\/v1\/?$/.test(u.pathname)) choosing = http(u.href.replace(/\/$/, ''), 'configured');
      else choosing = Promise.resolve(pick({ kind: 'ws', url: u ? u.href.replace(/^http/, 'ws') : wsDefault, why: 'configured' }));
    } else if (LOCALHOST) choosing = Promise.resolve(pick({ kind: 'ws', url: wsDefault, why: 'localhost' }));
    else choosing = probeIce(httpDefault).then(function (j) {
      return pick(j ? { kind: 'http', url: httpDefault, ice: j.iceServers, why: 'found' } : { kind: 'ws', url: wsDefault, why: 'fallback' });
    });
    return choosing;
  }
  // p2p.json "online": the signaling address of a play host, used when signal is 'online'. Only an https address that ends
  // in /signal/v1 counts (a page never sends its players to anything else), or an http one on this machine (a signaling
  // server you run yourself while you build); anything else is ignored.
  function onlineUrl() {
    var v = cfg && cfg.online; if (typeof v !== 'string') return null;
    try {
      var u = new URL(v), local = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/.test(u.hostname);
      return (u.protocol === 'https:' || (u.protocol === 'http:' && local)) && /\/signal\/v1\/?$/.test(u.pathname) && !u.search && !u.hash && !u.username ? u.href.replace(/\/$/, '') : null;
    } catch (e) { return null; }
  }
  function iceServers() {
    if (params.get('stun') === '1') return PUBLIC_STUN;
    if (params.get('stun') === '0') return [];
    if (Array.isArray(cfg.iceServers)) return cfg.iceServers;
    if (LOCALHOST && !(transport && transport.remote)) return [];
    if (transport && transport.ice && transport.ice.length) return transport.ice;   // the signaling server's: STUN, plus its TURN relay
    return PUBLIC_STUN;     // TURN (paid relay) only when configured: the server's /signal/v1/ice, or cfg.iceServers
  }

  function sendFrameText(text) {
    if (S.role === 'host' && worker) worker.postMessage({ k: 'in', id: 'local', text: text });
    else if (S.role === 'joiner' && dc && dc.readyState === 'open') dc.send(text);
  }

  function handleFrame(f) {
    if (!f || typeof f.k !== 'string') return;
    switch (f.k) {
      case 'seat':
        S.you = f.you;
        if (S.role === 'joiner' && f.resume && !W) store('gf-p2p:' + S.code, { resume: f.resume, name: S.name });
        break;
      case 'lobby':
        S.lobby = f;
        if (S.phase !== 'closed') S.phase = f.started ? 'playing' : 'lobby';
        if (W && S.role === 'host') reportSeats();
        break;
      case 'welcome':
        S.phase = 'playing'; if (f.name) S.name = f.name;
        fire('welcome', { you: f.you, name: f.name, code: f.code, meta: f.meta, players: f.players, ended: f.ended });
        if (W) settle({ t: 'in', you: f.you, code: f.code || S.code });
        break;
      case 'renamed':
        if (typeof f.name !== 'string') break;
        S.name = f.name;
        if (S.role === 'joiner') { var kept = load('gf-p2p:' + S.code); if (kept) store('gf-p2p:' + S.code, { resume: kept.resume, name: f.name }); }
        break;                       // the roster itself comes as 'players' (in a match) or 'lobby' (before it)
      case 'players': fire('players', f.players); break;
      case 'msg': fire('message', f.data); break;
      case 'ended': fire('ended', f.results); break;
      case 'error': fire('error', { reason: f.reason }); break;
      case 'closed':
        gotClosedFrame = true;
        fire('closed', f.reason);
        finish('closed', f.reason === 'the host closed the game' ? (S.role === 'host' ? T('You closed the game.') : T('The host closed the game.')) : T('The game closed: ') + f.reason, '',
          f.reason === 'replaced by a newer connection' ? 'replaced' : S.role === 'host' ? 'closed' : 'host-left');
        break;
      case 'kicked': gotClosedFrame = true; fire('closed', 'kicked: ' + f.reason); finish('closed', f.reason === 'removed by the host' ? T('The host removed you from this room.') : T('You left the game (') + f.reason + ').', '', 'kicked'); break;
      case 'refused':
        gotClosedFrame = true;
        if (f.code === 'full') finish('refused', T('This room is full.'), '', 'full');
        else if (f.code === 'locked') finish('refused', T('This room is locked: the host is playing on their own.'), '', 'locked');
        else if (f.code === 'ended') finish('refused', T('That match has already ended.'), '', 'ended');
        else if (f.code === 'removed') finish('refused', T('The host removed you from this room.'), '', 'removed');
        else finish('refused', T('Could not join: ') + f.reason + '.', '', 'refused');
        break;
    }
    render();
  }

  // `why` (v0.4.0) names the end for a page that carries on (a world): host-left, closed (you closed it), left, lost,
  // silent, full, ended, refused, replaced, kicked, no-room, no-answer, timeout, unreachable, failed.
  function finish(phase, reason, detail, why) {
    if (S.phase === 'closed' || S.phase === 'refused' || S.phase === 'failed' || S.phase === 'lost') { render(); return; }
    S.phase = phase; S.reason = reason; S.detail = detail || '';
    // Keep the resume token when the connection was merely lost (the seat may still be there); drop it once the room
    // is really over for this player.
    if (S.code && S.role === 'joiner' && (phase === 'closed' || phase === 'refused')) store('gf-p2p:' + S.code, null);
    clearTimeout(connectTimer);
    var ep = epoch;
    setTimeout(function () { if (ep === epoch) teardown(); }, S.role === 'host' ? 600 : 50);
    var end = { phase: phase, why: why || phase, reason: reason, detail: S.detail, role: S.role, code: S.code };
    if (W) settle({ t: 'error', code: end.why, reason: reason });
    fire('end', end);
    render();
  }

  function teardown() {
    try { if (sig) sig.close(); } catch (e) {} sig = null;
    for (var id in peers) closePeer(id);
    try { if (dc) dc.close(); } catch (e) {} try { if (pc) pc.close(); } catch (e) {} dc = pc = null;
    if (worker) { var w = worker; setTimeout(function () { w.terminate(); }, 50); worker = null; }
    S.connected = false;
  }

  // ---------------- world sessions (v0.4.0) ----------------
  // Forget the current session at once, so the next one starts clean on the same page: signaling, peers, the data
  // channel and the host's worker go; nothing an older session scheduled will run (epoch). Listeners stay.
  function resetSession() {
    epoch++;
    settle({ t: 'error', code: 'reset', reason: 'the session was reset' });
    teardown();
    clearTimeout(connectTimer); connectTimer = null;
    stops.splice(0).forEach(function (stop) { try { stop(); } catch (e) {} });
    if (sweepTimer) { if (sweepTimer.stop) sweepTimer.stop(); else clearInterval(sweepTimer); sweepTimer = null; }
    S = { role: null, phase: 'home', code: null, you: null, lobby: null, reason: '', detail: '', connected: false, rtt: null };
    welcome = null; gotClosedFrame = false; lastRenderKey = null; W = null;
  }
  // A world call's promise is answered once.
  function settle(result) { var r = W && W.resolve; if (r) { W.resolve = null; r(result); } }
  function cleanCid(v) { return typeof v === 'string' && /^[a-z0-9]{8}$/.test(v) ? v : undefined; }
  function cleanWorldName(v) { var n = typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, 24) : ''; return n || rollName(); }
  function validMax(v) { return v === (v | 0) && v >= 1 && v <= 8 ? v : 8; }

  // One POST to the HTTP signaling endpoint: the answer's JSON (an error answer too), or a rejection (network, timeout).
  function httpPost(url, body, ms, keepalive) {
    var ctl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctl) ctl.abort(); }, ms);
    return fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), cache: 'no-store', credentials: 'same-origin', keepalive: !!keepalive, signal: ctl ? ctl.signal : undefined })
      .then(function (r) { return r.json().then(null, function () { return null; }); })
      .then(function (j) { clearTimeout(timer); if (!j || typeof j !== 'object') throw new Error('not a signaling answer'); return j; }, function (e) { clearTimeout(timer); throw e; });
  }

  var NO_WEBRTC = { t: 'error', code: 'unsupported', reason: 'This browser does not support WebRTC, which this game needs to play with friends.' };
  function worldFind(key) {
    var unreachable = { t: 'error', code: 'unreachable', reason: 'signaling did not answer' };
    return cfgReady.then(chooseTransport).then(function () {
      if (transport.kind === 'http') {
        return httpPost(transport.url, { op: 'find', key: key }, POST_MS).then(function (j) {
          return j.t === 'found' || j.t === 'none' || j.t === 'error' ? j : unreachable;
        }, function () { return unreachable; });
      }
      return new Promise(function (resolve) {
        var done = false, h = null;
        var answer = function (m) { if (done) return; done = true; clearTimeout(timer); try { h.close(); } catch (e) {} resolve(m); };
        var timer = setTimeout(function () { answer(unreachable); }, WS_OPEN_MS + POST_MS);
        h = wsSignal(transport.url, function () { h.send({ t: 'find', key: key }); },
          function (m) { if (m && (m.t === 'found' || m.t === 'none' || m.t === 'error')) answer(m); },
          function () { answer(unreachable); });
      });
    });
  }

  // Claim the key and host. The worker starts once signaling says 'hosted'; the room is open from the start.
  function worldHost(opts) {
    resetSession();
    var ep = epoch, name = cleanWorldName(opts.name);
    return cfgReady.then(function () { return typeof RTCPeerConnection === 'undefined' ? NO_WEBRTC : ep !== epoch ? { t: 'error', code: 'reset' } : new Promise(function (resolve) {
      W = { key: String(opts.key || ''), cid: cleanCid(opts.cid), max: validMax(opts.max), resolve: resolve };
      saveName(name);
      S.role = 'host'; S.name = name; S.phase = 'connecting'; S.reason = T('Opening a room…');
      chooseTransport().then(function () {
        if (ep !== epoch || sig) return;
        sig = openHostSignal(ep, function (r) {
          if (r.t === 'hosted') { S.code = r.code; startWorker(); if (worker) { settle({ t: 'hosted', code: r.code }); beat(ep); } return; }
          settle(r.t === 'error' ? r : { t: 'error', code: 'failed', reason: 'unexpected answer' });
          resetSession();
        });
      });
    }); });
  }
  // The world host's signaling session ended (the server restarted, the network dropped, or a takeover after this tab
  // went quiet): open a new one for the same room. 'taken' means another copy holds the world now.
  function worldRehost() {
    var ep = epoch;
    return new Promise(function (resolve) {
      if (!W || S.role !== 'host' || !worker) { resolve({ t: 'error', code: 'bad', reason: 'not hosting a world' }); return; }
      try { if (sig) sig.close(); } catch (e) {} sig = null;
      var h = openHostSignal(ep, function (r) {
        if (ep !== epoch) { resolve({ t: 'error', code: 'reset' }); return; }
        if (r.t === 'hosted') { sig = h; S.code = r.code; S.detail = ''; reportSeats(true); resolve(r); return; }
        try { h.close(); } catch (e) {}
        resolve(r);
      });
    });
  }
  // The host's signaling: 'first' gets the first answer ({t:'hosted', code} or an error). After that the session
  // introduces joiners as in hostGame; if it ends, the page hears 'signal' {state:'lost'}.
  function openHostSignal(ep, first) {
    var answered = false, h = null, lastErr = null;
    var answer = function (r) { if (!answered) { answered = true; first(r); } };
    h = openSignal(function () { if (ep === epoch) h.send({ t: 'host', key: W && W.key, max: W && W.max }); }, function (m) {
      if (ep !== epoch) return;
      if (m.t === 'hosted') answer({ t: 'hosted', code: m.code });
      else if (m.t === 'peer') addPeer(m.peer);
      else if (m.t === 'signal' && peers[m.from]) onHostSignal(peers[m.from], m.data);
      else if (m.t === 'peer-left' && peers[m.peer] && !peers[m.peer].open) closePeer(m.peer);
      else if (m.t === 'error') { lastErr = m.code || null; answer({ t: 'error', code: m.code || 'failed', reason: m.reason || '', room: m.room, n: m.n, max: m.max }); }
    }, function (never) {
      if (ep !== epoch) return;
      if (!answered) { answer({ t: 'error', code: never ? 'unreachable' : 'failed', reason: 'signaling closed' }); return; }
      if (sig !== h) return;
      sig = null;
      S.detail = T('Signaling is offline: players already here keep playing, new players cannot join.');
      fire('signal', { state: 'lost', code: lastErr });
    });
    return h;
  }
  // The world host reports its seats to signaling (find shows them), and over the WebSocket every WORLD_BEAT_MS as a
  // sign of life (an HTTP host's long-poll is one already).
  function reportSeats(force) {
    var L = S.lobby, n = L ? L.seats.filter(function (s) { return s.connected && !s.bot; }).length : 1;
    if (!force && n === S.seatN) return;
    S.seatN = n;
    if (sig && sig.seats) sig.seats(n, W.max);
  }
  function beat(ep) { stops.push(ticker(function () { if (ep === epoch && W && S.role === 'host') reportSeats(true); }, WORLD_BEAT_MS)); }

  function worldJoin(code, opts) {
    resetSession();
    var ep = epoch, name = cleanWorldName(opts.name);
    return cfgReady.then(function () { return typeof RTCPeerConnection === 'undefined' ? NO_WEBRTC : ep !== epoch ? { t: 'error', code: 'reset' } : new Promise(function (resolve) {
      W = { key: String(opts.key || ''), cid: cleanCid(opts.cid), offerMs: opts.offerMs > 0 ? Math.min(20000, opts.offerMs) : 8000, resolve: resolve };
      saveName(name);
      joinGame(cleanCode(code), name, null);
    }); });
  }
  function worldLeave() {
    if (!W) return;
    if (S.role === 'host') {
      // Tell every guest directly first (as pagehide does), so the room's end reaches them even as this page moves on.
      var text = JSON.stringify({ k: 'closed', reason: 'the host closed the game' });
      for (var id in peers) { var p = peers[id]; if (p.dc && p.dc.readyState === 'open') { try { p.dc.send(text); } catch (e) {} } }
      if (worker) closeGame(); else finish('closed', T('You closed the game.'), '', 'closed');
    } else if (S.role === 'joiner') {
      if (S.connected) leave(); else finish('closed', T('You left the game.'), '', 'left');
    }
  }

  // onOpen(): ready to send · onMsg(m): a signaling message ({t:'hosted'|'joined'|'peer'|'signal'|'peer-left'|'host-left'|'error'})
  // · onClose(never): the transport ended (never: it never reached the server). Not called after handle.close().
  function openSignal(onOpen, onMsg, onClose) {
    return transport && transport.kind === 'http' ? httpSignal(transport.url, onOpen, onMsg, onClose) : wsSignal(transport ? transport.url : null, onOpen, onMsg, onClose);
  }
  function wsSignal(url, onOpen, onMsg, onClose) {
    var h = { kind: 'ws', send: noop, close: noop }, ws, opened = false, done = false, timer = null;
    var end = function (never) { if (done) return; done = true; clearTimeout(timer); onClose(never); };
    try { ws = new WebSocket(url || ((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/signal')); }
    catch (e) { setTimeout(function () { end(true); }, 0); return h; }
    timer = setTimeout(function () { if (!opened) { try { ws.close(); } catch (e) {} end(true); } }, WS_OPEN_MS);
    ws.onopen = function () { opened = true; clearTimeout(timer); onOpen(); };
    ws.onmessage = function (e) { var m; try { m = JSON.parse(e.data); } catch (x) { return; } if (!done) onMsg(m); };
    ws.onclose = function () { end(!opened); };
    ws.onerror = noop;
    h.send = function (obj) { if (ws.readyState === 1) { try { ws.send(JSON.stringify(obj)); } catch (e) {} } };
    h.close = function () { done = true; clearTimeout(timer); try { ws.close(); } catch (e) {} };
    h.seats = function (n, max) { h.send({ t: 'seats', n: n, max: max }); };     // a world host (v0.4.0): also its sign of life
    return h;
  }
  // HTTP: each message is a POST (in order, one at a time); a long-poll brings the other side's messages; leaving tells
  // the server (a keepalive request, so it still goes out while the page unloads).
  function httpSignal(url, onOpen, onMsg, onClose) {
    var h = { kind: 'http' }, peer = null, token = null, after = 0, done = false, left = false, polling = false, fails = 0, queue = Promise.resolve(), seats = null;
    function post(body, ms, keepalive) { return httpPost(url, body, ms, keepalive); }
    function auth(o) { o.peer = peer; o.token = token; return o; }
    // A world host's seats ride on its next poll (v0.4.0): the long-poll is its sign of life already.
    h.seats = function (n, max) { seats = { n: n, max: max }; };
    function leave() { if (peer && !left) { left = true; post(auth({ op: 'leave' }), 4000, true).then(noop, noop); } }
    function end(never) { if (done) return; done = true; onClose(never); }
    // A failed look (network, or the server busy or rate-limiting) is tried again, backing off; only six in a row
    // (about 20 s) end signaling. A session the server no longer knows ends it at once, like a socket it closed.
    function retry() { if (++fails >= 6) { end(false); return; } setTimeout(poll, Math.min(5000, 800 * fails)); }
    function poll() {
      if (done || polling || !peer) return;
      polling = true;
      var body = auth({ op: 'poll', after: after });
      if (seats) { body.n = seats.n; body.max = seats.max; }
      post(body, POLL_MS).then(function (j) {
        polling = false;
        if (done) return;
        if (j.t === 'error') {
          if (j.code === 'rate' || j.code === 'busy' || j.code === 'full') { retry(); return; }
          onMsg(j); end(false); return;
        }
        fails = 0;
        if (typeof j.last === 'number' && j.last > after) after = j.last;
        var list = Array.isArray(j.msgs) ? j.msgs : [];
        for (var i = 0; i < list.length && !done; i++) onMsg(list[i]);
        poll();
      }, function () { polling = false; if (!done) retry(); });
    }
    h.send = function (obj) {
      if (done || !obj) return;
      var body = obj.t === 'host' ? (obj.key ? { op: 'host', key: obj.key, max: obj.max } : { op: 'host' }) : obj.t === 'join' ? { op: 'join', code: obj.code } : obj.t === 'signal' ? { op: 'signal', to: obj.to, data: obj.data } : null;
      if (obj.t === 'leave') { h.close(); return; }
      if (!body) return;
      var opening = body.op !== 'signal';
      queue = queue.then(function () {
        if (done) return;
        if (obj.skip && obj.skip()) return;              // 1.6.4: a candidate for a joiner that is already connected or gone
        if (!opening) auth(body);
        return post(body, POST_MS).then(function (j) {
          if (opening && j.peer && j.token) {
            peer = j.peer; token = j.token;
            if (done) { leave(); return; }               // closed while the room was being opened
            onMsg(j.t === 'hosted' ? { t: 'hosted', code: j.code } : { t: 'joined', peer: j.peer });
            poll();
          } else if (j.t === 'error' && !done) onMsg(j);
        }, function () { if (opening) end(true); });   // a lost candidate is not fatal: the connect timeout reports a failure
      });
    };
    h.close = function () { done = true; leave(); };
    setTimeout(function () { if (!done) onOpen(); }, 0);
    return h;
  }
  function sigSend(obj) { if (sig) sig.send(obj); }
  // The error panel when signaling never answered. A page that tried HTTP and then the WebSocket says so.
  function unreachable() {
    finish('failed', T('Could not reach the signaling server.'), transport && transport.why === 'fallback'
      ? T('Tried HTTP signaling (/signal/v1) and the WebSocket (/signal); neither answered. Check your connection and try again.')
      : T('Check your connection and try again.'), 'unreachable');
  }

  // ---------------- host ----------------
  function hostGame(name) {
    S.role = 'host'; S.name = name; S.phase = 'connecting'; S.reason = T('Opening a room…'); render();
    chooseTransport().then(function () {
      if (S.phase !== 'connecting' || sig) return;
      sig = openSignal(function () { sigSend({ t: 'host' }); }, function (m) {
        if (m.t === 'hosted') { S.code = m.code; startWorker(); }
        else if (m.t === 'peer') addPeer(m.peer);
        else if (m.t === 'signal' && peers[m.from]) onHostSignal(peers[m.from], m.data);
        else if (m.t === 'peer-left' && peers[m.peer] && !peers[m.peer].open) closePeer(m.peer);
        else if (m.t === 'error' && !S.code) finish('failed', T('Could not open a room: ') + m.reason);
      }, function (never) {
        if (never) unreachable();
        else if (S.phase === 'lobby' || S.phase === 'playing') { S.detail = T('Signaling is offline: players already here keep playing, new players cannot join.'); render(); }
      });
    });
  }

  function startWorker() {
    try { worker = new Worker(new URL('p2p/host-worker.js', siteBase), { type: 'module' }); }
    catch (e) { finish('failed', T('This browser cannot host (it needs module Web Workers).')); return; }
    var mine = worker;
    worker.onmessage = function (e) {
      if (mine !== worker) return;                        // a worker from an earlier session (v0.4.0)
      var d = e.data || {};
      if (d.k === 'out') {
        if (d.id === 'local') { try { handleFrame(JSON.parse(d.text)); } catch (x) {} }
        else { var p = peers[d.id]; if (p && p.dc && p.dc.readyState === 'open') { try { p.dc.send(d.text); } catch (x) {} } }
      } else if (d.k === 'hangup') {
        var id = d.id; setTimeout(function () { closePeer(id); }, 300);
      } else if (d.k === 'stats') S.stats = d.stats;
      else if (d.k === 'fatal') finish('failed', T('The game could not start on this machine.'), d.error);
    };
    worker.onerror = function (e) { if (mine === worker) finish('failed', T('The game could not start on this machine.'), e.message || 'worker error'); };
    var init = { k: 'init', roomUrl: new URL(cfg.room || 'room.js', siteBase).href, botUrl: new URL(cfg.bot || 'bot.js', siteBase).href,
      code: S.code, hostName: S.name, startMode: cfg.start === 'live' ? 'live' : 'lobby', seed: params.get('seed') || '',
      botNames: Array.isArray(theme().botNames) ? theme().botNames.slice(0, 16).map(String) : undefined,
      namePool: presetPool() || undefined };
    if (W) { init.world = true; init.maxSeats = W.max; init.hostCid = W.cid; init.startMode = 'live'; }
    worker.postMessage(init);
    S.connected = true;
  }

  function addPeer(id) {
    if (peers[id] || Object.keys(peers).length >= 32) return;
    var p = peers[id] = { id: id, pc: new RTCPeerConnection({ iceServers: iceServers() }), dc: null, open: false, remote: false, iceQ: [], ep: epoch };
    p.dc = p.pc.createDataChannel('gf', { ordered: true });
    // Once the channel is open the joiner has left signaling and needs no more candidates (1.6.4: they used to come back
    // 400 "no such peer"). `skip` is checked again when a queued HTTP POST is about to go out.
    p.pc.onicecandidate = function (e) {
      if (p.ep !== epoch || p.open) return;
      sigSend({ t: 'signal', to: id, data: { ice: e.candidate ? e.candidate.toJSON() : null }, skip: function () { return p.open || peers[id] !== p; } });
    };
    p.dc.onopen = function () { if (p.ep !== epoch) return; p.open = true; p.lastSeen = Date.now(); clearTimeout(p.timer); if (worker) worker.postMessage({ k: 'attach', id: id }); startSweep(); };
    p.dc.onmessage = function (e) {
      if (p.ep !== epoch) return;
      p.lastSeen = Date.now();
      if (e.data === PING) return;                        // liveness only, never reaches the room
      if (worker && typeof e.data === 'string') worker.postMessage({ k: 'in', id: id, text: e.data });
    };
    p.dc.onclose = function () { dropPeer(id); };
    // A joiner whose tab dies (closed, crashed, network gone) may never close the data channel cleanly. ICE consent
    // checks still notice within seconds: treat failed/closed at once, and a disconnect that doesn't recover in 8 s.
    p.pc.onconnectionstatechange = function () {
      var st = p.pc.connectionState;
      clearTimeout(p.dropTimer);
      if (st === 'failed' || st === 'closed') dropPeer(id);
      else if (st === 'disconnected') p.dropTimer = setTimeout(function () { if (p.pc.connectionState !== 'connected') dropPeer(id); }, 8000);
    };
    p.timer = setTimeout(function () { if (!p.open) closePeer(id); }, CONNECT_TIMEOUT_MS + 5000);
    p.pc.createOffer().then(function (o) { return p.pc.setLocalDescription(o); })
      .then(function () { if (p.ep === epoch) sigSend({ t: 'signal', to: id, data: { sdp: { type: p.pc.localDescription.type, sdp: p.pc.localDescription.sdp } } }); })
      .catch(function () { if (p.ep === epoch) closePeer(id); });
  }

  function onHostSignal(p, data) {
    if (data.sdp && data.sdp.type === 'answer') {
      p.pc.setRemoteDescription(data.sdp).then(function () { p.remote = true; p.iceQ.splice(0).forEach(function (c) { p.pc.addIceCandidate(c).catch(noop); }); }).catch(noop);
    } else if ('ice' in data) {
      if (!data.ice) return;
      if (p.remote) p.pc.addIceCandidate(data.ice).catch(noop); else p.iceQ.push(data.ice);
    }
  }

  // Liveness: joiners send a tiny ping every 2 s. A joiner whose page is frozen, crashed or cut off stops pinging
  // even when the browser still answers ICE consent checks, so the host drops a connection silent for 15 s.
  // The seat is kept (a reload resumes it). 15 s leaves room for background-tab timer throttling.
  var PING = '{"k":"ping"}', SILENT_MS = 15000, sweepTimer = null;
  function startSweep() {
    if (sweepTimer) return;
    var beat = 0;
    var sweep = function () {
      var now = Date.now(), ping = (beat++ % 2) === 0;
      for (var id in peers) {
        var p = peers[id];
        if (p.open && now - (p.lastSeen || 0) > SILENT_MS) { dropPeer(id); continue; }
        // The host pings too, so joiners notice a crashed or frozen host (quiet turn-based rooms send nothing else).
        if (p.open && ping) { try { p.dc.send(PING); } catch (e) {} }
      }
    };
    // A world's host keeps pinging from a background tab (its guests give up on 6 s of silence): a worker clock.
    if (W) sweepTimer = { stop: ticker(sweep, 1000) };
    else sweepTimer = setInterval(sweep, 1000);
  }

  function dropPeer(id) {
    var p = peers[id]; if (!p) return;
    if (p.open && worker) worker.postMessage({ k: 'detach', id: id });   // the seat is kept; a reload resumes it
    p.open = false; closePeer(id);
  }

  function closePeer(id) {
    var p = peers[id]; if (!p) return;
    delete peers[id]; clearTimeout(p.timer); clearTimeout(p.dropTimer);
    try { p.dc.close(); } catch (e) {} try { p.pc.close(); } catch (e) {}
  }

  function hostCmd(cmd) { if (worker) worker.postMessage(cmd); }

  function closeGame() {
    if (S.role !== 'host') return;
    hostCmd({ k: 'close', reason: 'the host closed the game' });   // the worker sends 'closed' to every seat first
  }

  // The host's tab going away ends the room: tell every joiner directly (the worker may not get to run).
  window.addEventListener('pagehide', function () {
    // A joiner leaving (tab closed or reloading) hangs up now, so the host frees the seat's connection at once
    // instead of waiting for ICE timeouts. The seat itself is kept: a reload resumes it with the stored token.
    // A joiner still mid-handshake also leaves signaling (over HTTP nothing else would tell the server).
    if (S.role === 'joiner') { try { if (dc) dc.close(); } catch (e) {} try { if (pc) pc.close(); } catch (e) {} try { if (sig) sig.close(); } catch (e) {} return; }
    if (S.role !== 'host' || S.phase === 'closed') return;
    var text = JSON.stringify({ k: 'closed', reason: 'the host closed the game' });
    for (var id in peers) { var p = peers[id]; if (p.dc && p.dc.readyState === 'open') { try { p.dc.send(text); } catch (e) {} } }
    try { if (sig) sig.close(); } catch (e) {}
  });

  // ---------------- joiner ----------------
  function joinGame(code, name, resume) {
    var ep = epoch;
    S.role = 'joiner'; S.code = code; S.name = name; S.phase = 'connecting'; S.reason = T('Finding the game ') + code + '…'; render();
    // Keep the code in the address bar, so a reload rejoins the same seat (token in sessionStorage). Not in a world:
    // its page finds the room again by its key.
    if (!W) { try { var u = new URL(location.href); if (u.searchParams.get('join') !== code) { u.searchParams.set('join', code); history.replaceState(history.state, '', u.href); } } catch (e) {} }
    var remote = false, iceQ = [], offered = false;
    function onSignal(m) {
      if (ep !== epoch) return;
      if (m.t === 'joined') {
        S.reason = T('Connecting to the host…'); render();
        connectTimer = setTimeout(function () {
          if (ep === epoch && !S.connected) finish('failed', T('Could not connect to the host.'),
            T('Your network or theirs blocks direct connections. Try another network, or the game needs a TURN relay (see the kit README).'), 'timeout');
        }, CONNECT_TIMEOUT_MS);
        // A world's host that sends no offer soon is gone (its signaling session may outlive it by a few seconds).
        if (W && W.offerMs) setTimeout(function () { if (ep === epoch && !offered && !S.connected) finish('failed', T('The host did not answer.'), '', 'no-answer'); }, W.offerMs);
      } else if (m.t === 'signal' && m.data) {
        if (m.data.sdp && m.data.sdp.type === 'offer') {
          offered = true;
          pc = new RTCPeerConnection({ iceServers: iceServers() });
          var mine = pc;
          pc.onicecandidate = function (e) { if (ep === epoch) sigSend({ t: 'signal', data: { ice: e.candidate ? e.candidate.toJSON() : null } }); };
          pc.ondatachannel = function (e) { if (ep === epoch) setupChannel(e.channel); };
          pc.onconnectionstatechange = function () {
            if (ep === epoch && pc === mine && pc.connectionState === 'failed' && !S.connected) finish('failed', T('Could not connect to the host.'), T('A direct connection failed. The game may need a TURN relay (see the kit README).'));
          };
          pc.setRemoteDescription(m.data.sdp).then(function () {
            remote = true; iceQ.splice(0).forEach(function (c) { mine.addIceCandidate(c).catch(noop); });
            return mine.createAnswer();
          }).then(function (a) { return mine.setLocalDescription(a); })
            .then(function () { if (ep === epoch) sigSend({ t: 'signal', data: { sdp: { type: mine.localDescription.type, sdp: mine.localDescription.sdp } } }); })
            .catch(function (e) { if (ep === epoch) finish('failed', T('Could not connect to the host.'), String(e && e.message || e)); });
        } else if ('ice' in m.data && m.data.ice) {
          if (remote) pc.addIceCandidate(m.data.ice).catch(noop); else iceQ.push(m.data.ice);
        }
      } else if (m.t === 'error') {
        if (m.code === 'no-room') { store('gf-p2p:' + code, null); finish('refused', T('No game with the code ') + code + '.', T('The host may have closed it. Check the code or ask for a new link.'), 'no-room'); }
        else if (!S.connected) finish('failed', T('Could not join: ') + m.reason + '.', '', m.code === 'rate' || m.code === 'busy' ? m.code : 'failed');
      } else if (m.t === 'host-left' && !S.connected) finish('closed', T('The host closed the game.'), '', 'host-left');
    }
    chooseTransport().then(function () {
      if (ep !== epoch || S.phase !== 'connecting' || sig) return;
      sig = openSignal(function () { if (ep === epoch) sigSend({ t: 'join', code: code }); }, onSignal, function (never) { if (ep === epoch && never && !S.connected) unreachable(); });
    });
  }

  function setupChannel(ch) {
    var ep = epoch, silent = W ? WORLD_SILENT_MS : SILENT_MS;
    dc = ch;
    dc.onopen = function () {
      if (ep !== epoch) return;
      S.connected = true; clearTimeout(connectTimer);
      var saved = W ? null : load('gf-p2p:' + S.code);
      var hello = { k: 'hello', name: S.name, resume: saved && saved.resume ? saved.resume : undefined };
      if (W && W.cid) hello.cid = W.cid;
      hello.bid = browserId();                     // 1.7.2: what a host's Remove bars from coming back
      dc.send(JSON.stringify(hello));
      var ch = dc, stopPing = ticker(function () { if (ch.readyState !== 'open') { stopPing(); return; } try { ch.send(PING); } catch (e) {} }, 2000);
      if (W) stops.push(stopPing);
      try { if (sig) { sig.send({ t: 'leave' }); sig.close(); } } catch (e) {}   // signaling done: game traffic is peer-to-peer
      sig = null;
      S.reason = T('Connected. Waiting for the host…'); render();
    };
    var hostSeen = Date.now();
    dc.onmessage = function (e) { if (ep !== epoch) return; hostSeen = Date.now(); if (e.data === PING) return; var f; try { f = JSON.parse(e.data); } catch (x) { return; } handleFrame(f); };
    // Host silent for 15 s (crashed, frozen, or its network died without closing the channel): treat as lost.
    // A world gives up after 6 s and finds a new host.
    var stopWatch = ticker(function () {
      if (ep !== epoch || dc !== ch || S.phase === 'closed' || S.phase === 'refused' || S.phase === 'failed' || S.phase === 'lost') { stopWatch(); return; }
      if (S.connected && Date.now() - hostSeen > silent) {
        stopWatch();
        fire('closed', 'connection lost');
        finish('lost', T('Lost the connection to the host.'), T('The host stopped responding. Rejoin to pick up where you left off if their game is still open.'), 'silent');
        try { ch.close(); } catch (x) {} try { if (pc) pc.close(); } catch (x) {}
      }
    }, 1000);
    if (W) stops.push(stopWatch);
    dc.onclose = function () {
      if (ep !== epoch || gotClosedFrame) return;
      // No 'closed' frame: the host crashed, or this page stalled and the host dropped it (the host's heartbeat).
      // Either way the seat may still exist, so offer Rejoin (resume token kept) instead of claiming the host closed.
      if (S.connected) { fire('closed', 'connection lost'); finish('lost', T('Lost the connection to the host.'), T('Your seat is kept for a while. Rejoin to pick up where you left off.'), 'lost'); }
    };
  }

  function leave() {
    if (S.role === 'joiner') {
      try { if (dc && dc.readyState === 'open') dc.send(JSON.stringify({ k: 'bye' })); } catch (e) {}
      gotClosedFrame = true; fire('closed', 'you left');
      finish('closed', T('You left the game.'), '', 'left');
    }
  }

  // ---------------- lobby UI (shadow DOM, isolated from the game's CSS) ----------------
  var root = null, ui = {};
  var CSS = [
    ':host{all:initial}',
    '*{box-sizing:border-box;font:15px/1.4 var(--gfp-font)}',
    '.back{position:fixed;inset:0;z-index:2147483600;display:grid;place-items:center;padding:16px;background:var(--gfp-back);backdrop-filter:blur(3px)}',
    '.panel{width:min(420px,100%);max-height:calc(100vh - 32px);overflow:auto;background:var(--gfp-panel);color:var(--gfp-fg);border:1px solid var(--gfp-line);border-radius:var(--gfp-radius);padding:20px;box-shadow:var(--gfp-shadow)}',
    'h2{margin:0 0 4px;font-size:20px;font-weight:700}',
    'p{margin:6px 0;color:var(--gfp-muted)}',
    '.muted{color:var(--gfp-faint);font-size:13px}',
    'label{display:block;margin:12px 0 4px;color:var(--gfp-muted);font-size:13px}',
    'input{width:100%;padding:10px 12px;border-radius:9px;border:1px solid var(--gfp-line);background:var(--gfp-field);color:var(--gfp-fg)}',
    'input.code{text-transform:uppercase;letter-spacing:.2em;font-weight:700}',
    'output.preset{display:block;padding:10px 12px;border-radius:9px;border:1px solid var(--gfp-line);background:var(--gfp-field);color:var(--gfp-fg);font-weight:700}',
    '.row{display:flex;gap:8px;margin-top:12px;flex-wrap:wrap}',
    'button{cursor:pointer;border:1px solid var(--gfp-line);background:var(--gfp-button);color:var(--gfp-fg);border-radius:9px;padding:10px 14px;font-weight:600}',
    'button.primary{background:var(--gfp-accent);border-color:var(--gfp-accent);color:var(--gfp-accent-fg)}',
    'button.danger{background:var(--gfp-danger-bg);border-color:var(--gfp-danger);color:var(--gfp-danger-fg)}',
    'input::placeholder{color:var(--gfp-faint);opacity:1}',
    ':focus-visible{outline:2px solid var(--gfp-accent);outline-offset:2px}',
    'button:disabled{opacity:.45;cursor:default}',
    '.grow{flex:1 1 auto}',
    '.or{margin:14px 0 2px;text-align:center;color:var(--gfp-faint);font-size:13px}',
    '.eyebrow{font-size:12px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:var(--gfp-accent)}',
    'h2.title{font-size:26px;font-weight:800;margin:2px 0 4px}',
    '.namebox{display:flex;gap:8px;align-items:stretch}.namebox input{font-size:17px;font-weight:700;padding:11px 12px}',
    'button.dice{padding:0 12px;font-size:20px;line-height:1}',
    'button.big{flex:1 1 auto;padding:13px 16px;font-size:16px}',
    'button.quiet{background:transparent;border-color:transparent;color:var(--gfp-muted);text-decoration:underline;padding:6px 8px}',
    '.row.center{justify-content:center}.row.joinrow{flex-wrap:nowrap}.joinrow input{height:100%}',
    '.bigcode{font:800 34px/1.1 ui-monospace,Menlo,Consolas,monospace;letter-spacing:.18em;margin:6px 0;color:var(--gfp-code)}',
    '.link{display:flex;gap:6px;align-items:center}.link input{font-size:12px}',
    'ul{list-style:none;padding:0;margin:8px 0}li{display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:8px;background:var(--gfp-row);margin:4px 0}',
    'li .n{flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    'li .tag{font-size:12px;color:var(--gfp-faint)}li button{padding:2px 8px}',
    '.bar{position:fixed;z-index:2147483600;display:flex;gap:6px;align-items:flex-start;flex-wrap:wrap;max-width:calc(100vw - 16px)}',
    '.top-right{top:6px;right:6px;flex-direction:row-reverse}.top-left{top:6px;left:6px}.bottom-right{bottom:6px;right:6px;flex-direction:row-reverse}.bottom-left{bottom:6px;left:6px}',
    '.bar button{padding:4px 9px;font-size:13px}',
    '.pill{display:flex;gap:6px;align-items:center;background:var(--gfp-pill);border-color:var(--gfp-line);border-radius:999px;opacity:.8}.pill:hover,.pill[aria-expanded=true]{opacity:1}',
    '.pill b{letter-spacing:.1em;color:var(--gfp-code);font-size:12px}.pill span{font-size:12px;color:var(--gfp-muted)}',
    '.dot{width:8px;height:8px;border-radius:50%;background:var(--gfp-ok);display:inline-block}',
    '.menu{flex-basis:100%;display:grid;gap:6px;width:min(280px,calc(100vw - 16px));background:var(--gfp-panel);border:1px solid var(--gfp-line);border-radius:10px;padding:10px;color:var(--gfp-fg)}',
    '.err{color:var(--gfp-danger-fg)}.detail{color:var(--gfp-faint);font-size:13px;word-break:break-word}',
    // Phones (gf-multiplayer 1.7.3; the creator, 2026-10-12: "Looks like some of the buttons run off the screen"): every
    // button and field on a panel at least 44 px tall; the panel never taller than the screen (it scrolls inside itself);
    // a secondary action is a button, not underlined words; on a short, wide screen (a phone held sideways) the Host /
    // Join screen puts the words on the left and the name, Host and Join on the right, all in view.
    '.panel{max-height:calc(100dvh - 32px)}',
    '.panel button,.panel input,.panel output.preset{min-height:44px}',
    '.panel button.quiet{text-decoration:none;border-color:var(--gfp-line);padding:8px 14px}',
    '.panel li button{min-width:44px}',
    '.acts>label:first-child{margin-top:4px}',
    '@media (max-height:600px){.back{padding:8px}.panel{max-height:calc(100dvh - 16px);padding:14px 16px}h2.title{font-size:22px}}',
    '@media (max-height:540px) and (min-width:560px){.back[data-phase=home] .panel{width:min(760px,100%);display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);column-gap:22px;align-items:center}.back[data-phase=home] .intro p{margin-bottom:0}}',
  ].join('\n');

  function el(tag, attrs, kids) {
    var e = document.createElement(tag);
    for (var k in attrs || {}) { if (k === 'text') e.textContent = attrs[k]; else if (k.slice(0, 2) === 'on') e.addEventListener(k.slice(2), attrs[k]); else if (attrs[k] !== false && attrs[k] != null) e.setAttribute(k, attrs[k] === true ? '' : attrs[k]); }
    (kids || []).forEach(function (c) { if (c) e.append(c); });
    return e;
  }
  // Invite links carry the room code plus the host's presentation params (default: the IP pack), so friends see the
  // same theme. Rules travel through the room itself. p2p.json "inviteParams" overrides the list. A forced ?signal= is
  // always kept: a room lives on one transport, so friends must use the host's.
  function inviteLink() {
    var u = new URL(location.href), keep = ((cfg && Array.isArray(cfg.inviteParams)) ? cfg.inviteParams : ['ip']).concat(['signal']);
    var q = new URLSearchParams(); q.set('join', S.code);
    keep.forEach(function (k) { var v = params.get(k); if (typeof k === 'string' && v !== null) q.set(k, v); });
    u.search = q.toString(); u.hash = ''; return u.href;
  }
  function copy(text, btn) {
    var done = function () { btn.textContent = 'Copied'; setTimeout(function () { btn.textContent = 'Copy'; }, 1200); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, done); else done();
  }
  function title() { var t = theme().title; return (typeof t === 'string' && t) || (cfg && cfg.title) || document.title || 'this game'; }
  function cleanCode(v) { return String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6); }

  function seatList(lobby, canKick) {
    var ul = el('ul', { id: 'gfp-players' });
    (lobby ? lobby.seats : []).forEach(function (s) {
      var tags = [s.host ? 'host' : '', s.bot ? 'bot' : '', !s.bot && !s.connected ? 'away' : '', s.id === S.you ? 'you' : ''].filter(Boolean).join(' · ');
      ul.append(el('li', { 'data-id': s.id }, [el('span', { class: 'n', text: s.name }), el('span', { class: 'tag', text: tags }),
        canKick && !s.host && !s.bot ? el('button', { 'aria-label': 'remove ' + s.name, text: '×', onclick: function () { hostCmd({ k: 'kick', playerId: s.id }); } }) : null]));
    });
    return ul;
  }

  // Theme: a game sets window.GF_P2P_THEME from its IP pack (before or after loading gf.js) so the lobby and pill
  // look like the game, not like every other game on the kit:
  //   { font, bg, panel, fg, muted, faint, line, field, button, row, accent, accentFg, code, ok, pill, back, radius,
  //     shadow, danger, dangerBg, dangerFg, title, botNames: [...], names: 'preset', namePool: {adjectives: [...], nouns: [...]} }
  //   every field optional; colors are any CSS color, font any CSS font-family.
  //   names: 'preset' → no name typing at all: players get '<adjective> <noun>' names with a reroll button, and the
  //   host enforces the pool (use it for young audiences or any game that shows names in the world).
  var THEME_DEFAULTS = { font: 'system-ui,-apple-system,"Segoe UI",sans-serif', panel: '#1b1e27', fg: '#eef0f6', muted: '#b8bfd2', faint: '#8a90a2',
    line: '#333a4d', field: '#11131a', button: '#262a37', row: '#232735', accent: '#4f7cff', accentFg: '#fff', code: '#ffd166', ok: '#3ddc84',
    pill: 'rgba(27,30,39,.85)', back: 'rgba(8,10,16,.72)', radius: '14px',
    shadow: '0 12px 40px rgba(0,0,0,.5)', danger: '#6b2a36', dangerBg: '#3a1f25', dangerFg: '#ffb3bf' };
  function theme() { var t = window.GF_P2P_THEME; return t && typeof t === 'object' ? t : {}; }
  // UI strings: GF_P2P_THEME.strings maps the kit's English text (the key) to the game's own words or language,
  // e.g. { 'Host a game': 'Open the vault', 'Join': 'Sneak in' }. Missing keys stay English.
  function T(key) { var m = theme().strings; var v = m && typeof m === 'object' ? m[key] : null; return typeof v === 'string' && v.length <= 300 ? v : key; }
  // Keys with {placeholders}: TF('Start (needs {n})', {n: 2}).
  function TF(key, vars) { return T(key).replace(/\{(\w+)\}/g, function (m, k) { return vars && vars[k] != null ? String(vars[k]) : m; }); }
  var DEFAULT_POOL = { adjectives: ['Sunny', 'Brave', 'Quiet', 'Lucky', 'Swift', 'Cozy', 'Bright', 'Jolly', 'Clever', 'Gentle', 'Bold', 'Merry', 'Nimble', 'Sleepy', 'Happy', 'Misty'],
    nouns: ['Otter', 'Comet', 'Maple', 'Pebble', 'Falcon', 'Biscuit', 'Lantern', 'Clover', 'Badger', 'Harbor', 'Meadow', 'Sparrow', 'Pixel', 'Acorn', 'Willow', 'Button'] };
  function presetPool() {
    var t = theme(); if (t.names !== 'preset') return null;
    var p = t.namePool && Array.isArray(t.namePool.adjectives) && Array.isArray(t.namePool.nouns) && t.namePool.adjectives.length && t.namePool.nouns.length ? t.namePool : DEFAULT_POOL;
    var w = function (a) { return a.map(String).filter(function (x) { return x && !/\s/.test(x); }).slice(0, 200); };
    return { adjectives: w(p.adjectives), nouns: w(p.nouns) };
  }
  function rollName() { var P = presetPool() || DEFAULT_POOL; return P.adjectives[Math.floor(Math.random() * P.adjectives.length)] + ' ' + P.nouns[Math.floor(Math.random() * P.nouns.length)]; }
  function validPreset(v) { var P = presetPool(), parts = String(v || '').split(' '); return parts.length === 2 && P.adjectives.indexOf(parts[0]) >= 0 && P.nouns.indexOf(parts[1]) >= 0; }
  function themeCss() {
    var t = theme(), out = [];
    for (var k in THEME_DEFAULTS) {
      var v = typeof t[k] === 'string' && t[k].length < 200 && !/[;{}<>]/.test(t[k]) ? t[k] : THEME_DEFAULTS[k];
      out.push('--gfp-' + k.replace(/[A-Z]/g, function (c) { return '-' + c.toLowerCase(); }) + ':' + v);
    }
    return ':host{' + out.join(';') + '}';
  }

  var lastRenderKey = null;
  function render() {
    if (!root || !cfg) return;
    if (cfg.ui === 'none') { if (root.childNodes.length) root.replaceChildren(); return; }   // v0.4.0: the page draws everything
    // handleFrame calls render() after every frame, including game messages at the room's tick rate. Rebuilding
    // an unchanged overlay replaced its buttons mid-click (a press and release on different nodes drop the click),
    // so only rebuild when something the overlay draws has changed.
    var key; try { key = JSON.stringify([S.phase, S.menu, S.code, S.role, S.reason, S.detail, S.you, S.lobby, theme(), S.presetName]); } catch (e) { key = null; }
    if (key !== null && key === lastRenderKey) return;
    lastRenderKey = key;
    root.replaceChildren(el('style', { text: themeCss() + '\n' + CSS }));
    var L = S.lobby, isHost = S.role === 'host';
    if (S.phase === 'playing' && cfg.bar === 'none') return;     // the page draws its own room controls (gf.room.leave, …)
    if (S.phase === 'playing') {
      // In-game: a small pill in one corner (p2p.json "bar": top-right | top-left | bottom-right | bottom-left),
      // expanded on demand, so it covers as little of the game as possible.
      var n = L ? L.seats.length : 0;
      var inv = el('button', { id: 'gfp-copy', text: T('Copy invite link'), onclick: function () { copy(inviteLink(), inv); setTimeout(function () { inv.textContent = 'Copy invite link'; }, 1300); } });
      var pos = /^(top|bottom)-(left|right)$/.test(cfg.bar || '') ? cfg.bar : 'top-right';
      root.append(el('div', { class: 'bar ' + pos, id: 'gfp-bar' }, [
        el('button', { id: 'gfp-pill', class: 'pill', 'aria-expanded': S.menu ? 'true' : 'false', title: 'Room ' + (S.code || '') + ', ' + n + ' players',
          onclick: function () { S.menu = !S.menu; render(); } }, [el('i', { class: 'dot' }), el('b', { id: 'gfp-roomcode', text: S.code || '' }), el('span', { id: 'gfp-count', text: String(n) })]),
        isHost && L && L.ended && !L.meta.rematch ? el('button', { id: 'gfp-rematch', class: 'primary', text: T('Rematch'), onclick: function () { hostCmd({ k: 'rematch' }); } }) : null,
        S.menu ? el('div', { class: 'menu', id: 'gfp-menu' }, [
          el('div', { class: 'muted', text: (isHost ? T('You are hosting.') + ' ' : '') + TF(n === 1 ? '{n} player: {names}' : '{n} players: {names}', { n: n, names: L ? L.seats.map(function (x) { return x.name; }).join(', ') : '' }) }),
          inv,
          isHost ? el('button', { id: 'gfp-close', class: 'danger', text: T('Close game (ends it for everyone)'), onclick: closeGame }) : el('button', { id: 'gfp-leave', text: T('Leave game'), onclick: leave }),
        ]) : null,
      ]));
      return;
    }
    var body = [];
    if (S.phase === 'home') {
      // Your name comes first and is never blank: the one you used last, else a rolled '<adjective> <noun>' (the dice
      // rolls another). Typing is kept across redraws (S.draft) and saved when you host or join.
      var joinCode = cleanCode(params.get('join'));
      var preset = !!presetPool();
      if (preset && !validPreset(S.presetName)) S.presetName = validPreset(savedName()) ? savedName() : rollName();
      if (!preset && typeof S.draft !== 'string') S.draft = savedName() || rollName();
      var nameIn = preset
        ? el('output', { id: 'gfp-name', class: 'preset', text: S.presetName })
        : el('input', { id: 'gfp-name', maxlength: '24', placeholder: T('Your name'), value: S.draft, autocomplete: 'nickname', spellcheck: 'false' });
      if (!preset) nameIn.addEventListener('input', function () { S.draft = nameIn.value; });
      var roll = el('button', { id: 'gfp-reroll', class: 'dice', type: 'button', title: T('Roll a name'), 'aria-label': T('Roll a name'), text: preset ? T('New name') : '🎲',
        onclick: function () { if (preset) S.presetName = rollName(); else S.draft = rollName(); lastRenderKey = null; render(); } });
      var codeIn = el('input', { id: 'gfp-code', class: 'code', maxlength: '6', placeholder: 'ABC123', value: joinCode, autocomplete: 'off', inputmode: 'text', 'aria-label': T('Room code') });
      var nm = function () { var v = preset ? S.presetName : (nameIn.value.replace(/\s+/g, ' ').trim().slice(0, 24) || rollName()); S.draft = v; saveName(v); return v; };
      var doJoin = function () { var c = cleanCode(codeIn.value); if (c.length !== 6) { codeIn.focus(); return; } joinGame(c, nm(), null); };
      codeIn.addEventListener('keydown', function (e) { if (e.key === 'Enter') doJoin(); });
      if (!preset) nameIn.addEventListener('keydown', function (e) { if (e.key === 'Enter') { if (joinCode) doJoin(); else hostGame(nm()); } });
      var hostBtn = el('button', { id: 'gfp-host', class: joinCode ? 'quiet' : 'primary big', text: joinCode ? T('Host your own game instead') : T('Host a game'), onclick: function () { hostGame(nm()); } });
      var joinBtn = el('button', { id: 'gfp-join', class: joinCode ? 'primary big' : '', text: joinCode ? TF('Join game {code}', { code: joinCode }) : T('Join'), onclick: doJoin });
      // two parts (gf-multiplayer 1.7.3): the words, and what you do (side by side on a phone held sideways)
      var acts = [el('label', { for: 'gfp-name', text: T('Your name') }), el('div', { class: 'namebox' }, [el('div', { class: 'grow' }, [nameIn]), roll])];
      if (joinCode) acts.push(el('div', { class: 'row' }, [joinBtn]), el('div', { class: 'row center' }, [hostBtn]), el('div', { hidden: true }, [codeIn]));
      else acts.push(el('div', { class: 'row' }, [hostBtn]), el('div', { class: 'or', text: T('or join a friend') }),
        el('div', { class: 'row joinrow' }, [el('div', { class: 'grow' }, [codeIn]), joinBtn]));
      body.push(el('div', { class: 'intro' }, [el('div', { class: 'eyebrow', text: T('Play with friends') }),
        el('h2', { class: 'title', text: title() }),
        el('p', { text: joinCode ? TF('You were invited to game {code}. Pick the name your friends will see, then join.', { code: joinCode }) : T('One of you hosts, the others join with the room code. Pick the name your friends will see.') })]),
        el('div', { class: 'acts' }, acts));
      setTimeout(function () { if (!preset) { nameIn.focus(); nameIn.select(); } }, 0);
    } else if (S.phase === 'connecting') {
      body.push(el('h2', { text: title() }), el('p', { id: 'gfp-msg', text: S.reason }));
      if (S.role === 'joiner') body.push(el('div', { class: 'row' }, [el('button', { id: 'gfp-cancel', text: T('Cancel'), onclick: function () { finish('closed', T('You left the game.')); } })]));
    } else if (S.phase === 'lobby') {
      var humans = L ? L.seats.filter(function (s) { return !s.bot; }).length : 0;
      var max = L ? L.meta.maxPlayers : 0, min = L ? L.meta.minPlayers : 1, empty = Math.max(0, max - humans);
      if (isHost) {
        var linkIn = el('input', { id: 'gfp-invite', readonly: true, value: inviteLink() });
        var cp = el('button', { text: T('Copy'), onclick: function () { copy(inviteLink(), cp); } });
        body.push(el('h2', { text: T('Your game is open') }), el('p', { text: T('Share this code or link. Everyone plays on your computer’s copy of the game, so keep this tab open.') }),
          el('div', { class: 'bigcode', id: 'gfp-roomcode', text: S.code }), el('div', { class: 'link' }, [linkIn, cp]),
          el('label', { text: TF('Players ({n}/{max})', { n: L ? L.seats.length : 0, max: max }) }), seatList(L, true),
          el('div', { class: 'row' }, [
            el('button', { id: 'gfp-start', class: 'primary', disabled: humans < min, text: humans < min ? TF('Start (needs {n})', { n: min }) : T('Start'), onclick: function () { hostCmd({ k: 'start' }); } }),
            el('button', { id: 'gfp-fill', disabled: empty === 0, text: empty ? TF(empty === 1 ? 'Fill {n} empty seat with bots & start' : 'Fill {n} empty seats with bots & start', { n: empty }) : T('No empty seats'), onclick: function () { hostCmd({ k: 'start', fill: true }); } }),
          ]),
          el('div', { class: 'row' }, [el('button', { id: 'gfp-close', class: 'danger', text: T('Close game'), onclick: closeGame })]));
      } else {
        body.push(el('h2', { text: TF('Joined game {code}', { code: S.code }) }), el('p', { id: 'gfp-msg', text: T('Waiting for the host to start…') }),
          el('label', { text: TF('Players ({n}/{max})', { n: L ? L.seats.length : 0, max: max }) }), seatList(L, false),
          el('div', { class: 'row' }, [el('button', { id: 'gfp-leave', text: T('Leave'), onclick: leave })]));
      }
      if (S.detail) body.push(el('p', { class: 'detail', text: S.detail }));
    } else if (S.phase === 'lost') {
      body.push(el('h2', { id: 'gfp-state', 'data-phase': S.phase, text: T('Connection lost') }),
        el('p', { id: 'gfp-msg', class: 'err', text: S.reason }));
      if (S.detail) body.push(el('p', { class: 'detail', text: S.detail }));
      body.push(el('div', { class: 'row' }, [
        el('button', { id: 'gfp-rejoin', class: 'primary', text: T('Rejoin'), onclick: function () { var u = new URL(location.href); u.searchParams.set('join', S.code); location.href = u.href; } }),
        el('button', { id: 'gfp-back', text: T('Back to start'), onclick: function () { store('gf-p2p:' + S.code, null); var u = new URL(location.href); u.searchParams.delete('join'); location.href = u.href; } })]));
    } else {   // closed · refused · failed
      body.push(el('h2', { id: 'gfp-state', 'data-phase': S.phase, text: T(S.phase === 'failed' ? 'Connection failed' : S.phase === 'refused' ? 'Can’t join' : 'Game over') }),
        el('p', { id: 'gfp-msg', class: S.phase === 'closed' ? '' : 'err', text: S.reason }));
      if (S.detail) body.push(el('p', { class: 'detail', text: S.detail }));
      body.push(el('div', { class: 'row' }, [el('button', { id: 'gfp-back', class: 'primary', text: T('Back to start'), onclick: function () { var u = new URL(location.href); u.searchParams.delete('join'); location.href = u.href; } })]));
    }
    root.append(el('div', { class: 'back', id: 'gfp-panel', 'data-phase': S.phase }, [el('div', { class: 'panel', role: 'dialog', 'aria-modal': 'true' }, body)]));
  }

  function mount() {
    var host = document.createElement('div');
    host.id = 'gf-p2p';
    document.body.append(host);
    root = host.attachShadow({ mode: 'open' });
    var cfgUrl = new URL('p2p.json', siteBase);
    fetch(cfgUrl).then(function (r) { return r.ok ? r.json() : {}; }).catch(function () { return {}; }).then(function (fileCfg) {
      cfg = Object.assign({}, fileCfg, window.GF_P2P_CONFIG || {});
      cfgLoaded();
      if (typeof RTCPeerConnection === 'undefined') { S.phase = 'failed'; S.reason = T('This browser does not support WebRTC, which this game needs to play with friends.'); render(); return; }
      chooseTransport();      // decided while the player reads the lobby, so Host / Join start at once
      var code = cleanCode(params.get('join'));
      var saved = code && load('gf-p2p:' + code);
      if (saved && saved.resume) joinGame(code, saved.name || savedName() || 'Player', saved.resume);   // reload → rejoin the same seat
      else render();
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();

  // Read-only QA observation (no room state: the host's page never has it).
  window.__p2p = Object.freeze({
    snapshot: function () { return JSON.parse(JSON.stringify({ role: S.role, phase: S.phase, code: S.code, you: S.you, reason: S.reason, detail: S.detail, connected: S.connected, seats: S.lobby ? S.lobby.seats : [], started: !!(S.lobby && S.lobby.started), ended: !!(S.lobby && S.lobby.ended), ice: cfg ? iceServers().length : null,
      signal: transport ? transport.kind : null, signalWhy: transport ? transport.why : null, world: W ? { key: W.key, cid: W.cid || null, epoch: epoch } : null })); },
    peers: function () { return Object.keys(peers).map(function (id) { var p = peers[id]; return { id: id, open: p.open, state: p.pc.connectionState }; }); },
    transport: function () { return S.role === 'joiner' ? { dc: dc ? dc.readyState : null, pc: pc ? pc.connectionState : null } : null; },
  });
})();
