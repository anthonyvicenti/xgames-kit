/*! games.fun multiplayer kit: party shell v1.6.3 (race and live rounds, worlds, and watching a stream). MIT. research/multiplayer/party/kit/party.js
 *
 * Kit-owned and byte-identical in every game (never edit a copy). Standard: research/multiplayer/STANDARD.md
 *
 * Gives an ordinary single-player game "play with friends" with no multiplayer code in the game:
 *   - vendor/gf.js (the host-join kit) draws the Host / Join lobby and carries the room over WebRTC; the host
 *     player's browser runs room.js (the generic race room) in a Web Worker. No game server.
 *   - each round the room hands everyone one seed; this page loads the game's own page in a frame with that seed,
 *     reads the player's live value and result, and sends them to the room; the rail shows everyone's standing.
 *   - the game's result is read through the adapter in ../../multiplayer.json → race:
 *       "observe": poll the game's read-only QA observation (window.__game.snapshot()), no game change at all;
 *       "hooks":   the game calls gf.run.start / progress / end (research/multiplayer/sdk/gf.js).
 * LIVE rounds (multiplayer.json mode "live", kit 1.2.0): the players are in one shared space and see each other.
 * The game imports gf/mp/net.js, which reaches this page through window.__gfParty: poses, the host's world and game
 * events travel through the room; every game is loaded first and then everyone starts together.
 * Layout: <game>/multiplayer.json · <game>/gf/mp/{index.html, party.js, party.css, room.js, bot.js, p2p.json,
 *         vendor/gf.js, p2p/*, kit.json}
 * Kit 1.4.0 (creator 2026-10-08: "The waiting lobby is pretty poorly done from a UI perspective. New users can't name
 * before joining a room or change name in a room before the game. Final scores seem to always be the same regardless.
 * We really shouldn't have bots in multiplayer modes"):
 *   - one waiting room, drawn here: the room code and invite link, every player in the colour their character wears
 *     (the game's net.describe({colors})), your own name editable until the round starts (gf.room.rename), the host's
 *     Start, Leave; the host-join kit's corner pill is off (bar 'none'), so nothing shows the code twice
 *   - multiplayer.json live.backdrop (a query): the game's own page, silent and untouchable, stands behind the Host /
 *     Join screen and the waiting room (gf-three: gf-backdrop=1, its world with the camera circling a character)
 *   - friends play friends: a round needs two players here (players.min when higher; QA: ?min=1); the room refuses less
 *   - live.hud "game": the game draws everyone's scores and its own room menu (net.room, net.leave, net.endRound), so a
 *     round gets the whole stage and the standings rail stays away; the results card is the one result screen
 *   - a team round shows each player their own score (net.finish values), not the host's number for everyone
 * Kit 1.5.0, WORLDS (multiplayer.json mode "world"; research/worlds/PLAN.md): opening the page puts you in THE room of
 * this game (keyed world:<slug>), with no codes, no Start, no rounds and no reloads. The game's page loads at once and
 * once (world.entry?gf-world=1), and the world card stands over it: the title, who is in now, your name and Enter.
 * Enter finds the live room and joins it, or claims the key and hosts; a full world (8, or players.max) waits for a
 * seat and comes in by itself. When the host leaves (a closed frame, or 6 s of silence) every copy finds or claims
 * again after 0-600 ms, and the game's page is never touched. A reload within 60 s of being in comes straight back in.
 * The game talks through gf/mp/net.js as in a live round (net.mode 'world', net.status, net.onHost, cid).
 * Kit 1.6.0, WATCH THEN PLAY (research/watch/PLAN.md; creator 2026-10-09: "people would be able to do a mini stream right
 * from X as they play and others would be able to watch or join"): a player in a room presses Go live (net.live.start,
 * from the game's menu) and this page sends what an extra player would receive (every pose, the host's world, every
 * event for everyone) plus its own, as key frames and deltas, to a relay channel (the play host's /watch/v1 says where).
 * Everyone in the room sees LIVE. ?watch=<id> opens this page as a viewer: the game's page loads as usual, the feed is
 * played into it through net.js as if it were one more player who sends nothing, and Join puts the viewer in.
 * Kit 1.6.1: live rounds too. The streamer goes live from the game's menu or the waiting room (#mp-golive); a viewer's
 * page loads each round's game page with that round's seed as the stream reaches it, and Join opens the room's own
 * link (?join=<code>): the viewer plays from the next round.
 * Kit 1.7.0 (2026-10-12; the creator: "How hard would it be to add in an audio stream from a mic for the stream
 * watchers"): the streamer's voice. The Studio play page above this frame opens the microphone (never this page: the
 * play origin is every game's) and posts compressed Opus packets ({type:'gf:voice'}, creator-studio/lib/voice-capture.mjs);
 * this page sends them on its stream as `a` frames, and tells the page above when it is live ({type:'gf:live-state'}). A
 * viewer turns the sound on with a tap (#mp-watch-sound) and hears the voice in step with the game, decoded by WebCodecs.
 * Query:  ?join=CODE (invite link) · ?signal=<url> (signaling endpoint) · ?watch=<id> (a stream to watch, kit 1.6.0)
 *         QA only: ?max=<seconds> (round cap; a world: its seats, 1-8) · ?gq=<query> (extra query for the game's page,
 *         e.g. a one-lap race) · ?min=<players> (a smaller start minimum, never below 1)
 */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var params = new URLSearchParams(location.search);
  var gameRoot = new URL('../../', location.href);          // <game>/gf/mp/ → <game>/
  var root = $('party'), frame = $('game'), card = $('card'), rail = $('rail');
  var M = null, R = null, LIVE = false, WORLD = false;       // multiplayer.json, its "race", "live" or "world" block, and which
  var COLORS = ['#4f7cff', '#ff5ea8', '#3ddc84', '#ffd166', '#b388ff', '#ff8a50', '#4dd0e1', '#e57373'];   // one per seat
  var S = { phase: 'boot', you: null, code: null, names: {}, away: {}, standing: null, go: null, goAt: 0, revealed: false,
    results: null, dismissed: 0, sentConfig: false, note: '', fatal: '', colors: null, lobbyOpen: false, nameDraft: null, renamed: 0, locked: false };
  var MIN = 2, OWN_HUD = false, BACKDROP = null;     // kit 1.4.0: the start minimum, live.hud "game", live.backdrop
  var A = freshAdapter();
  var pollTimer = null, countTimer = null, cardKey = null, railKey = null;

  function freshAdapter() { return { kind: null, ok: false, armed: false, started: false, done: false, live: null, progress: null, first: undefined, polls: 0, sent: 0, lastSend: 0, lastP: null, lastV: null, flush: null, moves: 0, value: null, won: null, error: '', url: null, seen: false, loaded: false }; }

  function el(tag, attrs, kids) {
    var e = document.createElement(tag);
    for (var k in attrs || {}) {
      if (k === 'text') e.textContent = attrs[k];
      else if (k.slice(0, 2) === 'on') e.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] !== false && attrs[k] != null) e.setAttribute(k, attrs[k] === true ? '' : attrs[k]);
    }
    (kids || []).forEach(function (c) { if (c) e.append(c); });
    return e;
  }

  // ---------------- manifest helpers ----------------
  function get(obj, path) {
    if (typeof path !== 'string' || !path) return undefined;
    var parts = path.split('.'), v = obj;
    for (var i = 0; i < parts.length; i++) { if (v == null) return undefined; v = v[parts[i]]; }
    return v;
  }
  // A condition on the observation: {path, in|is|gte|gt|lte|lt|truthy} or {any:[…]} / {all:[…]} / {not: …}.
  function test(c, snap) {
    if (!c || typeof c !== 'object') return false;
    if (Array.isArray(c.any)) return c.any.some(function (x) { return test(x, snap); });
    if (Array.isArray(c.all)) return c.all.every(function (x) { return test(x, snap); });
    if (c.not) return !test(c.not, snap);
    var v = get(snap, c.path);
    if (Array.isArray(c['in'])) return c['in'].indexOf(v) >= 0;
    if ('is' in c) return v === c.is;
    if (typeof v === 'number') {
      if (typeof c.gte === 'number') return v >= c.gte;
      if (typeof c.gt === 'number') return v > c.gt;
      if (typeof c.lte === 'number') return v <= c.lte;
      if (typeof c.lt === 'number') return v < c.lt;
    }
    if (c.truthy === true) return !!v;
    if (c.truthy === false) return !v;
    return false;
  }
  function num(v) { return typeof v === 'number' && isFinite(v) ? v : null; }
  // observe.value: a dot path, or {sum: [paths]} for a result kept in parts (a course total plus the hole in play).
  // A part that is empty counts as 0; the value is empty only when every part is.
  function readValue(snap, spec) {
    if (typeof spec === 'string') return num(get(snap, spec));
    if (!spec || !Array.isArray(spec.sum)) return null;
    var total = 0, any = false;
    for (var i = 0; i < spec.sum.length; i++) { var v = num(get(snap, spec.sum[i])); if (v !== null) { total += v; any = true; } }
    return any ? total : null;
  }
  function cfg() { return (S.standing && S.standing.cfg) || (S.go && S.go.cfg) || { metric: R.metric, direction: R.direction, maxSeconds: R.maxSeconds }; }
  function fmt(v) {
    if (num(v) === null) return '';
    if (cfg().metric === 'time') {
      var s = R.unit === 'ms' ? v / 1000 : v, m = Math.floor(s / 60);
      return m ? m + ':' + (s % 60 < 10 ? '0' : '') + (s % 60).toFixed(1) : s.toFixed(2) + ' s';
    }
    var n = Number.isInteger(v) || Math.abs(v) >= 100 ? Math.round(v).toLocaleString('en-US') : String(Math.round(v * 100) / 100);
    return R.unit ? n + ' ' + R.unit : n;
  }
  function goal() { var c = cfg(), low = c.direction === 'lower'; return c.metric === 'time' ? (low ? 'Fastest time wins.' : 'Longest time wins.') : c.metric === 'count' ? (low ? 'Fewest wins.' : 'Most wins.') : (low ? 'Lowest score wins.' : 'Best score wins.'); }
  function me() { return S.standing ? S.standing.racers.filter(function (r) { return r.id === S.you; })[0] || null : null; }
  function isHost() { return !!(S.standing && S.standing.hostId && S.standing.hostId === S.you); }
  function name(id) { return S.names[id] || id; }
  // A seat's colour: the game's own (net.describe), else the kit's list. Seat ids are 'p1', 'p2', … in join order.
  function colorOf(id) { var n = seat(id), c = S.colors && S.colors.length ? S.colors : COLORS; return c[n % c.length]; }
  function humans() { return S.standing ? S.standing.racers.filter(function (r) { return !S.away[r.id]; }).length : 1; }
  function hostName() { var h = S.standing && S.standing.hostId; return h ? name(h) : 'the host'; }
  function roomNote() { return S.note && /needs \d+ players/.test(S.note) ? '' : S.note; }

  // ---------------- boot ----------------
  function fail(msg, detail) {
    S.fatal = msg; root.dataset.phase = 'boot';
    card.hidden = false;
    card.replaceChildren(el('div', { class: 'panel' }, [el('h2', { text: 'Play with friends' }), el('p', { class: 'err', id: 'mp-fatal', text: msg }),
      detail ? el('p', { class: 'muted', text: detail }) : null,
      el('div', { class: 'row' }, [el('a', { href: new URL('index.html', gameRoot).href }, [el('button', { text: 'Play on your own' })])])]));
  }

  fetch(new URL('multiplayer.json', gameRoot), { cache: 'no-store' }).then(function (r) { if (!r.ok) throw new Error('multiplayer.json: HTTP ' + r.status); return r.json(); }).then(function (m) {
    M = m;
    if (!M || typeof M !== 'object') throw new Error('multiplayer.json is not an object');
    if (M.mode === 'solo') return fail('This game is single-player.', typeof M.reason === 'string' ? M.reason : '');
    if (M.mode === 'room') {            // a game written as a room has its own multiplayer page: pass the invite on
      var to = new URL((M.room && M.room.entry) || 'index.html', gameRoot);
      params.forEach(function (v, k) { to.searchParams.set(k, v); });
      location.replace(to.href); return;
    }
    if (M.mode === 'world') return bootWorld();
    LIVE = M.mode === 'live';
    R = LIVE ? M.live : M.race;
    if ((M.mode !== 'race' && !LIVE) || !R || typeof R !== 'object') throw new Error('multiplayer.json: mode must be "race" or "live", with a block of the same name');
    if (LIVE) R.adapter = 'net';                    // the game reports through gf/mp/net.js
    else if (R.adapter !== 'observe' && R.adapter !== 'hooks') throw new Error('multiplayer.json: race.adapter must be "observe" or "hooks"');
    if (R.adapter === 'observe' && (!R.observe || !R.observe.ended || !R.observe.value)) throw new Error('multiplayer.json: race.observe needs "ended" and "value"');
    R.metric = ['score', 'time', 'count'].indexOf(R.metric) >= 0 ? R.metric : 'score';
    R.direction = R.direction === 'lower' ? 'lower' : 'higher';
    var cap = parseInt(params.get('max') || '', 10);
    R.maxSeconds = cap >= 5 && cap <= 3600 ? cap : (Number.isInteger(R.maxSeconds) && R.maxSeconds >= 5 && R.maxSeconds <= 3600 ? R.maxSeconds : 300);
    A.kind = R.adapter;
    var pmin = M.players && Number.isInteger(M.players.min) ? M.players.min : 1, qmin = parseInt(params.get('min') || '', 10);
    MIN = qmin >= 1 && qmin <= 8 ? qmin : Math.max(2, Math.min(8, pmin));
    OWN_HUD = LIVE && R.hud === 'game';
    BACKDROP = LIVE && typeof R.backdrop === 'string' && R.backdrop.length <= 200 ? R.backdrop : null;
    root.dataset.hud = OWN_HUD ? 'game' : 'rail';
    try { var kept = JSON.parse(sessionStorage.getItem('gf-mp:colors:' + gameRoot.pathname) || 'null'); if (Array.isArray(kept)) S.colors = kept; } catch (e) {}
    var title = typeof M.title === 'string' && M.title ? M.title.slice(0, 60) : 'this game';
    document.title = title + ' · play with friends';
    $('rail-title').textContent = title;
    applyTheme(title);
    if (WATCH_ID && LIVE) return bootLiveWatch();          // kit 1.6.1: a viewer of a live round (no room until Join)
    var s = document.createElement('script');
    s.src = 'vendor/gf.js';
    s.onload = wire;
    s.onerror = function () { fail('The multiplayer kit did not load.', 'gf/mp/vendor/gf.js is missing.'); };
    document.body.append(s);
  }).catch(function (e) { fail('This game has no multiplayer set up.', String(e && e.message || e)); });

  // multiplayer.json "theme": the same keys as the host-join kit's GF_P2P_THEME, so lobby, pill and rail match the game.
  function applyTheme(title) {
    var t = M.theme && typeof M.theme === 'object' ? M.theme : {}, keys = { font: 'font', bg: 'bg', panel: 'panel', fg: 'fg', muted: 'muted', faint: 'faint', line: 'line', row: 'row', button: 'button', accent: 'accent', accentFg: 'accent-fg', code: 'code', ok: 'ok', radius: 'radius' };
    for (var k in keys) if (typeof t[k] === 'string' && t[k].length < 200 && !/[;{}<>]/.test(t[k])) document.documentElement.style.setProperty('--mp-' + keys[k], t[k]);
    var theme = { title: title }; for (var j in t) theme[j] = t[j];
    window.GF_P2P_THEME = theme;
    // bar 'none': this page draws the room (code, invite, leave) itself, so the host-join kit's pill would only repeat it
    var conf = { bar: 'none', inviteParams: Array.isArray(M.inviteParams) ? M.inviteParams.concat(['max', 'gq', 'signal']) : ['max', 'gq', 'signal'] };
    if (params.get('signal')) conf.signal = params.get('signal');
    window.GF_P2P_CONFIG = Object.assign({}, window.GF_P2P_CONFIG || {}, conf);
  }

  function wire() {
    var room = window.gf && window.gf.room;
    if (!room) return fail('The multiplayer kit did not start.');
    S.phase = 'home'; root.dataset.phase = 'home';
    watchConfig();                                  // kit 1.6.1: whether streams are on here (Go live)
    showBackdrop();
    room.on('welcome', function (w) {
      S.you = w.you; S.code = w.code; S.phase = 'room'; root.dataset.phase = 'room'; S.locked = false; S.closed = false;
      (w.players || []).forEach(function (p) { S.names[p.id] = p.name; S.away[p.id] = !p.connected; });
      render();
      liveResume();                                 // kit 1.6.2: back in after a reload within a minute: the stream carries on
    });
    room.on('players', function (list) {
      var here = {};
      (list || []).forEach(function (p) { here[p.id] = 1; S.names[p.id] = p.name; S.away[p.id] = !p.connected; });
      Object.keys(S.names).forEach(function (id) { if (!here[id]) S.away[id] = true; });   // 1.7.2: removed by the host
      tellPlayers(); render();
    });
    $('rail-invite').onclick = function () { copyText(inviteLink(), $('rail-invite'), 'Copy invite link'); };
    $('rail-leave').onclick = leaveRoom;
    room.on('message', function (m) {
      if (!m || typeof m !== 'object') return;
      if (m.k === 'standings') {
        S.standing = m;
        if (isHost() && !S.sentConfig && (m.phase === 'lobby' || m.phase === 'results')) { S.sentConfig = true; room.send({ k: 'config', metric: R.metric, direction: R.direction, maxSeconds: R.maxSeconds, live: LIVE, team: LIVE && R.team === true, minPlayers: MIN }); }
        if (m.phase !== 'lobby' && m.phase !== 'results') S.lobbyOpen = false;
        tellPlayers();
        // The round this game page belongs to is over for everyone: tell the game once, so it stops its world and sound.
        if (S.session && !S.session.ended && m.phase === 'results' && m.round === S.session.round) { S.session.ended = true; try { if (S.session.H.onEnd) S.session.H.onEnd(); } catch (e) { console.error(e); } }
        render();
      } else if (m.k === 'net') {
        if (m.t === LIVE_TYPE) return liveBadgeIn(m);
        if (m.t === VC_TYPE) return vcIn(m);
        if (!m.to) liveTee(m.t, m.from, m.d);
        if (S.session) { try { S.session.H.onNet(m.t, m.from, m.d); } catch (e) { console.error(e); } }
      }
      else if (m.k === 'go') startRound(m);
      else if (m.k === 'begin') { S.goAt = performance.now() + Math.max(0, m.startsInMs | 0); render(); }
      else if (m.k === 'error') { S.note = String(m.reason || ''); cardKey = null; render(); }
    });
    room.on('ended', function (res) { S.results = res; render(); });
    room.on('error', function (e) { S.note = String((e && e.reason) || ''); render(); });
    room.on('closed', function () { clearInterval(pollTimer); clearInterval(countTimer); S.closed = true; roomTellPage(true); });   // 1.7.2: the page above leaves voice
    $('start').onclick = startRoundNow;
    $('stop').onclick = function () { room.send({ k: 'stop' }); };
    window.addEventListener('message', onGameMessage);
    render();
  }

  // ---------------- a round ----------------
  function gameUrl(go) {
    var u = new URL(R.entry || 'index.html', gameRoot), q = new URLSearchParams(u.search);
    if (typeof R.query === 'string') new URLSearchParams(R.query).forEach(function (v, k) { q.set(k, v); });
    if (params.get('gq')) new URLSearchParams(params.get('gq')).forEach(function (v, k) { q.set(k, v); });
    if (typeof R.seedParam === 'string' && R.seedParam) q.set(R.seedParam, go.seed);
    q.set('gf_seed', go.seed); q.set('gf_mode', 'race'); q.set('gf_round', String(go.round));   // gf_round: a fresh load every round
    u.search = q.toString();
    return u.href;
  }

  // The page the frame was navigated to, whatever the game has done to its address bar since (replaceState).
  function frameUrl() {
    try { var w = frame.contentWindow, n = w.performance.getEntriesByType('navigation')[0]; return (n && n.name) || w.location.href; } catch (e) { return ''; }
  }
  // Until the frame has loaded THIS round's page it still holds the last round's game, which may be running or ending:
  // nothing is read from the frame before then. Once this round's page has been seen, a game that reloads or
  // navigates itself is still this round's game.
  // (A game that redirects itself at once never shows the exact address: any page loaded since the round began
  // that is not the last round's counts too.)
  function thisRound() {
    if (A.seen) return true;
    var u = frameUrl();
    if (!A.url || !u || u === 'about:blank') return false;
    if (u === A.url || (A.loaded && u !== S.prevUrl)) { A.seen = true; return true; }
    return false;
  }
  frame.addEventListener('load', function () { A.loaded = true; });

  function startRound(go) {
    S.go = go; S.revealed = false; S.results = null; S.note = ''; S.dismissed = 0;
    LV.world = null; LV.worldFrom = null; LV.poses = {}; LV.keyAt = 0;      // a stream: the new round's world, from its first message
    // A live round waits for the room's 'begin' (every game loaded), then everyone counts down together.
    S.goAt = live() ? Infinity : performance.now() + Math.max(0, go.startsInMs | 0);
    S.session = null; S.info = null;
    S.prevUrl = A.url || frameUrl();
    A = freshAdapter(); A.kind = R.adapter;
    A.url = gameUrl(go);
    frame.hidden = false; frame.classList.remove('backdrop'); frame.removeAttribute('tabindex'); frame.removeAttribute('aria-hidden');
    frame.src = A.url;
    S.lobbyOpen = false;
    clearInterval(pollTimer);
    if (R.adapter === 'observe') pollTimer = setInterval(poll, 250);
    clearInterval(countTimer);
    countTimer = setInterval(function () {
      if (performance.now() >= S.goAt) {
        clearInterval(countTimer); S.revealed = true; focusGame();
        if (S.session) { try { S.session.H.onStart(); } catch (e) { console.error(e); } }
      }
      render();
    }, 100);
    render();
  }

  // ---------------- live rounds: the bridge gf/mp/net.js talks to ----------------
  function live() { return !!(LIVE && S.go && S.go.cfg && S.go.cfg.live); }
  function seat(id) { var n = parseInt(String(id).slice(1), 10); return isFinite(n) && n > 0 ? n - 1 : 0; }
  function playerList() {
    var st = S.standing, host = st ? st.hostId : null;
    return (st ? st.racers : []).filter(function (r) { return !r.watching; }).map(function (r) {
      return { id: r.id, seat: seat(r.id), name: name(r.id), color: colorOf(r.id), host: r.id === host, you: r.id === S.you, connected: !S.away[r.id] };
    }).sort(function (a, b) { return seat(a.id) - seat(b.id); });
  }
  function buildInfo() {
    var list = playerList(), you = list.filter(function (p) { return p.you; })[0] || { id: S.you, seat: seat(S.you), name: name(S.you), color: colorOf(S.you), host: isHost(), you: true, connected: true };
    S.info = { you: you, players: list, seed: S.go ? S.go.seed : null, round: S.go ? S.go.round : 0 };
    return S.info;
  }
  function tellPlayers() {
    if (WORLD) return tellWorldPlayers();
    if (!S.session) return;
    var before = S.info ? JSON.stringify(S.info.players) : '', info = buildInfo();
    if (JSON.stringify(info.players) !== before) { try { S.session.H.onPlayers(info.players); } catch (e) { console.error(e); } }
  }
  // The game's frame is same-origin, so net.js calls this directly: window.parent.__gfParty.attach(window, handlers).
  // Only this round's game page gets a session; a page from the last round, or any other window, gets null.
  window.__gfParty = Object.freeze({
    attach: function (win, H) {
      if (WORLD) return attachWorld(win, H);
      if (WS.watch) return attachLiveWatch(win, H);
      if (!live() || win !== frame.contentWindow || !H || typeof H.onNet !== 'function') return null;
      A.seen = true; A.ok = true; A.armed = true;
      var round = S.go.round, mine = function () { return S.session === session && S.go && S.go.round === round; };
      var session = { H: H, round: round, ended: false,
        info: function () { return S.info || buildInfo(); },
        send: function (t, d, to) { if (!mine() || typeof t !== 'string' || /^gf:/.test(t)) return; window.gf.room.send(to && to !== 'all' ? { k: 'net', t: t, to: to, d: d } : { k: 'net', t: t, d: d }); if (!to || to === 'all') liveTee(t, S.you, d); },
        watching: function () { return false; }, live: liveApi(),
        ready: function () { if (!mine()) return; S.gameReady = round; window.gf.room.send({ k: 'ready' }); if (S.revealed) { try { H.onStart(); } catch (e) { console.error(e); } } render(); },
        progress: function (p, v) { if (mine()) { A.started = true; report(p, v); } },
        finish: function (value, won, values) { if (mine()) finishRun(value, won, values); },
        // kit 1.4.0: the room, for a game that draws it in its own menu (live.hud "game")
        room: function () { var ph = S.standing ? S.standing.phase : 'lobby'; return { code: S.code, invite: inviteLink(), host: isHost(), canEnd: isHost() && ph === 'racing', players: playerList() }; },
        leave: function () { leaveRoom(); },
        endRound: function () { if (mine() && isHost() && S.standing && S.standing.phase === 'racing') window.gf.room.send({ k: 'stop' }); } };
      S.session = session; buildInfo();
      return session;
    },
    // kit 1.4.0: any page in this page's frame (a round's game, or the lobby's backdrop) says how it draws players:
    // {colors: [css colours by seat]}. The lobby, the rail and the results then show each player in their character's colour.
    describe: function (win, info) {
      if (win !== frame.contentWindow || !info || typeof info !== 'object' || !Array.isArray(info.colors)) return;
      var ok = info.colors.filter(function (c) { return typeof c === 'string' && c.length < 40 && /^(#[0-9a-f]{3,8}|rgba?\([0-9.,\s%]+\)|hsla?\([0-9.,\s%deg]+\))$/i.test(c.trim()); }).slice(0, 16);
      if (!ok.length || JSON.stringify(ok) === JSON.stringify(S.colors)) return;
      S.colors = ok;
      try { sessionStorage.setItem('gf-mp:colors:' + gameRoot.pathname, JSON.stringify(ok)); } catch (e) {}
      railKey = null; cardKey = null; tellPlayers(); render();
    },
  });

  function focusGame() { try { frame.focus(); frame.contentWindow.focus(); } catch (e) {} }
  function releasePointer() { try { frame.contentDocument.exitPointerLock(); } catch (e) {} try { document.exitPointerLock(); } catch (e) {} }
  function settled() { return performance.now() - (S.resultsAt || 0) > 700; }

  // At most two progress messages a second. A value that arrives inside that window is sent when it closes, so the
  // others never sit on a stale number (a game using the hooks reports in bursts, not on a clock).
  function report(p, v) {
    if (p !== A.progress || v !== A.live) A.moves++;
    A.progress = p; A.live = v;
    if (!S.revealed || A.done || (p === A.lastP && v === A.lastV)) return;
    // The room counts progress only once it says the round is racing; a game shown at this page's own count can report
    // a moment before that. Hold the value and send it then, or an unchanged value would never be sent again.
    if (!(S.standing && S.standing.phase === 'racing')) { if (!A.flush) { var h = A; A.flush = setTimeout(function () { h.flush = null; if (h === A) report(A.progress, A.live); }, 250); } return; }
    var wait = 500 - (performance.now() - A.lastSend);
    if (wait > 0) { if (!A.flush) { var a = A; A.flush = setTimeout(function () { a.flush = null; if (a === A) report(A.progress, A.live); }, wait); } return; }
    var msg = { k: 'progress' };
    if (p !== null) msg.p = Math.round(p * 1000) / 1000;
    if (v !== null) msg.v = v;
    if (msg.p === undefined && msg.v === undefined) return;
    A.lastSend = performance.now(); A.lastP = p; A.lastV = v; A.sent++;
    window.gf.room.send(msg);
  }
  function finishRun(value, won, values) {
    if (A.done) return;
    if (num(value) === null) { A.error = 'the game ended but reported no number as its result'; render(); return; }
    A.done = true; A.value = value; A.won = won;
    window.gf.room.send(values ? { k: 'finish', value: value, won: won, values: values } : { k: 'finish', value: value, won: won });
    render();
  }

  // Adapter "observe": the game's own read-only observation, polled 4 times a second. Nothing in the game changes.
  function poll() {
    if (A.done || !S.go || !thisRound()) return;
    A.polls++;
    var O = R.observe, snap;
    try {
      var w = frame.contentWindow, o = w[O.object || '__game'];
      if (o == null) return;
      var call = O.call === undefined ? 'snapshot' : O.call;
      snap = call ? (typeof o[call] === 'function' ? o[call]() : undefined) : (typeof o === 'function' ? o() : o);
    } catch (e) { A.error = String(e && e.message || e).slice(0, 200); return; }
    if (!snap || typeof snap !== 'object') return;
    A.ok = true; A.error = '';
    var ended = test(O.ended, snap);
    if (!A.armed) { if (ended) return; A.armed = true; }       // an end only counts after the game was seen not ended
    var v = readValue(snap, O.value);
    if (A.first === undefined) A.first = v;
    if (!A.started && (O.started ? test(O.started, snap) : v !== A.first)) A.started = true;
    var p = null;
    if (O.progress && typeof O.progress === 'object') {
      var raw = num(get(snap, O.progress.path));
      if (raw !== null) p = Math.max(0, Math.min(1, typeof O.progress.max === 'number' && O.progress.max > 0 ? raw / O.progress.max : raw));
    }
    if (ended) return finishRun(v, O.won ? test(O.won, snap) : null);
    report(p, v);
  }

  // Adapter "hooks": the game calls gf.run.* (sdk/gf.js), which posts to its parent, this page.
  function onGameMessage(e) {
    if (e.source !== frame.contentWindow || !e.data || e.data.gf !== 1 || !R) return;
    var m = e.data;
    if (m.type === 'hello') { A.ok = true; frame.contentWindow.postMessage({ gf: 1, type: 'init' }, '*'); return; }
    if (R.adapter !== 'hooks' || !S.go || A.done || !thisRound()) return;
    if (m.type === 'start') { A.armed = true; A.started = true; }
    else if (m.type === 'progress' && num(m.value) !== null) {
      var kind = R.progress && R.progress.kind === 'fraction' ? 'fraction' : 'score', max = R.progress && R.progress.max;
      if (kind === 'fraction') report(Math.max(0, Math.min(1, m.value)), null);
      else report(typeof max === 'number' && max > 0 ? Math.max(0, Math.min(1, m.value / max)) : null, m.value);
    } else if (m.type === 'end' && A.armed) finishRun(m.value, m.won === true ? true : m.won === false ? false : null);
  }

  // ---------------- the room's own actions ----------------
  // The game's page behind the Host / Join screen and the waiting room (live.backdrop): silent, untouchable, its world
  // with the camera circling a character. Until a round starts; a round's page then takes the frame.
  function showBackdrop() {
    if (!BACKDROP || S.go) return;
    var u = new URL(R.entry || 'index.html', gameRoot), q = new URLSearchParams(u.search);
    new URLSearchParams(BACKDROP).forEach(function (v, k) { q.set(k, v); });
    q.set('gf_mode', 'backdrop'); u.search = q.toString();
    frame.classList.add('backdrop'); frame.setAttribute('tabindex', '-1'); frame.setAttribute('aria-hidden', 'true');
    frame.hidden = false; frame.src = u.href;
    root.dataset.backdrop = '1';
  }
  function copyText(text, btn, label) {
    var done = function () { btn.textContent = 'Copied!'; setTimeout(function () { btn.textContent = label; }, 1400); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, function () { done(); }); else done();
  }
  function leaveRoom() { try { if (window.gf.room.leave) window.gf.room.leave(); } catch (e) { console.error(e); } }
  function startRoundNow() {
    if (humans() < minNow()) { S.note = ''; cardKey = null; render(); return; }
    S.note = ''; window.gf.room.send({ k: 'start' });
  }
  // Kit 1.6.6 (the creator, 2026-10-11: "We cant lock it so others cant join. We also cant play solo"; they chose "Lock
  // room, stream solo"): the host locks the waiting room. The room then refuses anyone new (an invite link, a viewer's
  // Join), and a round starts with whoever is in, the host alone included, so a player can go live on their own. A
  // world is one shared room per game and has no lock.
  function minNow() { return S.locked ? 1 : MIN; }
  function lockRoom(on) {
    if (WORLD || !isHost() || !window.gf.room.lock || !window.gf.room.lock(on)) return;
    S.locked = !!on;
    window.gf.room.send({ k: 'config', minPlayers: on ? 1 : MIN });
    S.note = ''; cardKey = null; render(); liveChanged();
  }
  // Your name, until the round starts (creator 2026-10-08: "change name in a room before the game"). The room keeps
  // it clean and unique and tells everyone; it shows at once here.
  function renameTo(v) {
    v = String(v || '').replace(/\s+/g, ' ').trim().slice(0, 24);
    S.nameDraft = null;
    if (!v || v === name(S.you) || !window.gf.room.rename) { cardKey = null; render(); return; }
    if (window.gf.room.rename(v)) { S.names[S.you] = v; S.renamed++; }
    cardKey = null; railKey = null; render();
  }

  // ---------------- drawing ----------------
  function inviteLink() {
    // kit 1.7.2: under Studio's play page, the invite opens that page (where voice chat is), not this frame's address
    if (VOICE.above && VOICE.invite && !WORLD) return VOICE.invite + '?join=' + encodeURIComponent(S.code || '');
    var u = new URL(location.href), q = new URLSearchParams();
    q.set('join', S.code || '');
    (window.GF_P2P_CONFIG.inviteParams || []).forEach(function (k) { var v = params.get(k); if (v !== null) q.set(k, v); });
    u.search = q.toString(); u.hash = '';
    return u.href;
  }
  function dot(id) { return el('i', { class: 'dot', style: 'background:' + colorOf(id) }); }
  function tags(id) {
    var st = S.standing, t = [];
    if (st && st.hostId === id) t.push('host');
    if (id === S.you) t.push('you');
    if (S.away[id]) t.push('away');
    return t.join(' · ');
  }
  function railVisible(ph) { return !OWN_HUD && !!S.go && ph !== 'lobby'; }

  function render() { renderRoom(); roomTellPage(false); }
  function renderRoom() {
    if (WORLD) return renderWorld();
    renderLiveBadge();
    if (S.fatal || S.phase !== 'room') { rail.hidden = true; if (!S.fatal) card.hidden = true; return; }
    var st = S.standing, ph = st ? st.phase : 'lobby', mine = me(), host = isHost();
    rail.hidden = !railVisible(ph);
    root.dataset.rail = rail.hidden ? 'off' : 'on';
    var left = Math.max(0, Math.ceil((S.goAt - performance.now()) / 1000));
    var counting = !!S.go && !S.revealed;

    // rail (race games, and live games that leave the standings to the kit): during and after a round
    var rk = JSON.stringify([st && st.racers, S.names, S.away, S.you, ph, host, S.note, A.done, A.error, A.started, st && st.round, LIVE, S.colors]);
    if (rk !== railKey) {
      railKey = rk;
      $('rail-sub').textContent = 'Room ' + (S.code || '') + (st && st.round ? ' · round ' + st.round : '');
      $('racers').replaceChildren.apply($('racers'), (st ? st.racers : []).map(function (r, i) {
        var val = r.watching ? 'next round' : r.done ? (r.dnf || (cfg().direction === 'lower' && r.won === false) ? 'out' : fmt(r.value)) : r.dnf ? 'did not finish' : ph === 'racing' || ph === 'results' ? (r.live !== null ? fmt(r.live) : '') : '';
        var out = r.done && cfg().direction === 'lower' && r.won === false;   // lost where lower is better: not a result
        return el('li', { class: (r.id === S.you ? 'me ' : '') + (r.done ? (out ? 'out ' : 'done ') : '') + (S.away[r.id] ? 'away' : ''), 'data-id': r.id }, [
          LIVE ? dot(r.id) : el('span', { class: 'place', text: r.watching ? '' : String(i + 1) }),
          el('span', { class: 'name', text: name(r.id) + (r.id === S.you ? ' (you)' : '') + (S.away[r.id] ? ' · away' : '') }),
          el('span', { class: 'val', text: val }),
          el('span', { class: 'bar' }, [el('i', { style: 'width:' + Math.round((r.progress || 0) * 100) + '%;background:' + (LIVE ? colorOf(r.id) : '') })]),
        ]);
      }));
      var status = roomNote() || A.error;
      if (!status) {
        if (ph === 'racing' && mine && mine.watching) status = 'Round in progress. You are in the next one.';
        else if (ph === 'racing' && A.done) status = 'Your result: ' + fmt(A.value) + '. Waiting for the others.';
        else if (LIVE && ph === 'loading') status = 'Loading the game for everyone.';
        else if (LIVE && (ph === 'racing' || ph === 'countdown')) status = R.team === true ? 'You are all in the same game, on the same side.' : 'You are all in the same game. ' + goal();
        else if (ph === 'racing') status = A.started ? 'Same game for everyone. ' + goal() : 'Start your game when you are ready.';
        else if (ph === 'results') status = host ? 'Start another round when ready.' : 'Waiting for ' + hostName() + ' to start another round.';
      }
      $('status').textContent = status || '';
      $('stop').hidden = !(host && ph === 'racing');
      $('rail-leave').textContent = host ? 'Close room' : 'Leave';
    }

    // card over the stage
    var loading = counting && S.goAt === Infinity;        // live: games are loading, the room has not said 'begin' yet
    var between = ph === 'lobby' || ph === 'results';
    var view = between && (!S.go || S.lobbyOpen) ? 'lobby' : loading ? 'loading' : counting ? 'count' : ph === 'results' && S.dismissed !== (st ? st.round : 0) ? 'results'
      : (ph === 'racing' || ph === 'countdown') && mine && mine.watching ? 'watching' : null;
    // The rail's own Start shows only when no card is offering it (the lobby and results cards carry the button).
    $('start').hidden = !(host && between && view !== 'lobby' && view !== 'results');
    $('start').textContent = ph === 'results' ? 'Play again' : 'Start';
    var editing = document.activeElement && document.activeElement.id === 'mp-name';
    var ck = JSON.stringify([view, LV.state, liveAvailable(), view === 'count' ? left : 0, view === 'results' ? [st.racers, S.names] : 0,
      view === 'lobby' ? [S.code, host, st && st.racers.map(function (r) { return r.id; }), S.names, S.away, st && st.hostId, ph, editing ? S.renamed : 0] : 0, st && st.round,
      view === 'loading' ? [st && st.racers.map(function (r) { return r.ready; }), S.names] : 0, S.colors, roomNote()]);
    if (ck === cardKey) return;
    cardKey = ck;
    root.dataset.view = view || '';
    if (!view) { card.hidden = true; card.className = 'card'; card.replaceChildren(); return; }
    // the name field keeps your typing and caret through a redraw (a friend joining while you type)
    var focus = editing ? { v: document.activeElement.value, a: document.activeElement.selectionStart, b: document.activeElement.selectionEnd } : null;
    var kids = [];
    if (view === 'lobby') kids = lobbyView(st, ph, host);
    else if (view === 'loading') {
      kids.push(el('div', { class: 'eyebrow', text: 'Round ' + S.go.round }), el('h2', { id: 'mp-loading', text: 'Loading the game for everyone…' }),
        el('ul', { class: 'players' }, (st ? st.racers : []).filter(function (r) { return !r.watching; }).map(function (r) {
          return el('li', { class: r.id === S.you ? 'me' : '' }, [dot(r.id), el('span', { class: 'name', text: name(r.id) + (r.id === S.you ? ' (you)' : '') }),
            el('span', { class: 'tag' + (r.ready ? ' ok' : ''), text: r.ready ? 'ready' : 'loading…' })]);
        })));
    } else if (view === 'count') {
      kids.push(el('div', { class: 'eyebrow', text: 'Round ' + S.go.round }), el('div', { class: 'count', id: 'mp-countdown', text: String(left || 1) }),
        el('p', { class: 'center', text: LIVE ? 'Everyone starts together.' : 'Everyone gets the same game. Start it when it appears.' }));
    } else if (view === 'watching') {
      kids.push(el('h2', { text: 'Round in progress' }), el('p', { text: 'You are in the next one.' + (OWN_HUD ? '' : ' The standings are on the side.') }));
    } else if (view === 'results') kids = resultsView(st, host);
    card.className = 'card' + (view === 'lobby' ? ' lobby' : '') + (view === 'results' ? ' results' : '');
    card.replaceChildren(el('div', { class: 'panel', 'data-view': view }, kids));
    card.hidden = false;
    if (focus) { var ni = $('mp-name'); if (ni) { ni.value = focus.v; ni.focus(); try { ni.setSelectionRange(focus.a, focus.b); } catch (e) {} } }
  }

  // The waiting room: before the first round, and between rounds when a player opens it from the results.
  function lobbyView(st, ph, host) {
    var racers = st ? st.racers.filter(function (r) { return !S.away[r.id] || r.id === S.you; }) : [];
    var max = Math.max(MIN, Math.min(8, M.players && Number.isInteger(M.players.max) ? M.players.max : 8));
    var n = humans(), enough = n >= minNow(), locked = S.locked || !!(window.gf.room && window.gf.room.locked);
    var link = el('input', { id: 'mp-invite', readonly: true, value: inviteLink(), 'aria-label': 'Invite link', onfocus: function () { link.select(); } });
    var cp = el('button', { id: 'mp-copy', type: 'button', text: 'Copy invite link', onclick: function () { copyText(link.value, cp, 'Copy invite link'); } });
    var list = el('ul', { class: 'players', id: 'mp-players' }, racers.map(function (r) {
      var mineRow = r.id === S.you, kids = [dot(r.id)];
      if (mineRow) {
        var ni = el('input', { id: 'mp-name', class: 'name-edit', maxlength: '24', value: S.nameDraft !== null ? S.nameDraft : name(r.id), 'aria-label': 'Your name', spellcheck: 'false', autocomplete: 'nickname',
          oninput: function () { S.nameDraft = ni.value; },
          // Enter leaves the field, and leaving it saves the name; Escape puts the old one back
          onkeydown: function (e) { if (e.key === 'Enter') { e.preventDefault(); if (S.nameDraft === null) S.nameDraft = ni.value; ni.blur(); } else if (e.key === 'Escape') { S.nameDraft = null; ni.value = name(S.you); ni.blur(); } },
          onblur: function () { if (S.nameDraft !== null) renameTo(ni.value); } });
        kids.push(el('label', { class: 'name-wrap', title: 'Your name: click to change it' }, [ni, el('span', { class: 'pen', 'aria-hidden': 'true', text: '✎' })]));
      } else kids.push(el('span', { class: 'name', text: name(r.id) }));
      kids.push(el('span', { class: 'tag', text: tags(r.id) }));
      if (host && !mineRow) kids.push(kickButton(r.id));
      return el('li', { class: mineRow ? 'me' : '', 'data-id': r.id }, kids);
    }).concat(locked ? [el('li', { class: 'empty locked', id: 'mp-locked' }, [el('i', { class: 'dot' }), el('span', { class: 'name', text: 'Locked: nobody new can join' })])]
      : n < Math.min(max, 4) ? [el('li', { class: 'empty' }, [el('i', { class: 'dot' }), el('span', { class: 'name', text: n < MIN ? 'Waiting for a friend to join…' : 'Room for ' + (max - n) + ' more' })])] : []));
    var again = ph === 'results';
    var startBtn = host ? el('button', { id: 'mp-start', class: 'primary big', type: 'button', disabled: !enough,
      text: enough ? (again ? 'Play again' : n === 1 ? 'Start on my own' : 'Start the game') : 'Waiting for a friend…', onclick: startRoundNow }) : null;
    // Kit 1.7.3 (the creator on a phone: "Looks like some of the buttons run off the screen"): the room's facts in one
    // part that scrolls inside the card when the screen is short, the actions in another that always shows (beside the
    // facts on a phone held sideways, under them otherwise). party.css lays them out; nothing else changed.
    var kids = [
      el('div', { class: 'eyebrow', text: again ? 'Round ' + st.round + ' is over · waiting room' : 'Waiting room' }),
      el('h2', { class: 'title', text: $('rail-title').textContent }),
      el('div', { class: 'share' }, [
        el('div', { class: 'codebox' }, [el('span', { class: 'label', text: 'Room code' }), el('b', { class: 'code', id: 'mp-code', text: S.code || '' })]),
        el('div', { class: 'link' }, [link, cp]),
      ]),
      el('p', { class: 'hint', text: locked ? (host ? 'The room is locked: you play with whoever is here, and people watching your stream can\u2019t join. Unlock it to let friends in.' : 'The host has locked the room: nobody new can join.')
        : host ? 'Send friends the link, or have them choose Play with friends and type the code. The game runs on your computer: keep this tab open. Or lock the room to play on your own.' : 'Invite more friends with the link or the code.' }),
      el('div', { class: 'listhead' }, [el('span', { text: 'Players' }), el('span', { class: 'count-pill', id: 'mp-count', text: n + ' / ' + max })]),
      list,
      el('p', { class: 'tip', text: 'Click your name to change it' + (again ? '.' : ' before the game starts.') }),
    ];
    if (roomNote()) kids.push(el('p', { class: 'err', text: roomNote() }));
    if (LIVE) kids.push(el('p', { class: 'muted', text: R.team === true ? 'Everyone plays in the same game, on the same side.' : 'Everyone plays in the same game and sees each other. ' + goal() }));
    var acts = [];
    acts.push(el('div', { class: 'row' }, host ? [startBtn] : [el('p', { class: 'waiting', id: 'mp-waiting' }, [el('i', { class: 'pulse' }), document.createTextNode('Waiting for ' + hostName() + ' to start' + (again ? ' the next round…' : ' the game…'))])]));
    var foot = [];
    if (host && !enough && !again) foot.push(el('a', { id: 'mp-alone', class: 'quiet', href: new URL(R.entry || 'index.html', gameRoot).href, text: 'Play alone instead' }));
    if (again) foot.push(el('button', { id: 'mp-to-results', class: 'quiet', type: 'button', text: 'See the results', onclick: function () { S.lobbyOpen = false; S.dismissed = 0; cardKey = null; render(); } }));
    if (host && !WORLD) foot.push(el('button', { id: 'mp-lock', class: 'quiet', type: 'button', 'aria-pressed': locked ? 'true' : 'false', text: locked ? 'Unlock room' : 'Lock room',
      title: locked ? 'Let friends join again' : 'Nobody new can join; you can start on your own', onclick: function () { lockRoom(!locked); } }));
    var golive = liveButton(); if (golive) foot.push(golive);
    foot.push(el('button', { id: 'mp-leave', class: 'quiet', type: 'button', text: host ? 'Close room' : 'Leave room', onclick: leaveRoom }));
    var vcta = voiceCta(); if (vcta) acts.push(vcta);
    acts.push(el('div', { class: 'row foot' }, foot));
    var vhint = voiceHint(); if (vhint) acts.push(vhint);
    return [el('div', { class: 'lobby-main', id: 'mp-lobby-main' }, kids), el('div', { class: 'lobby-acts', id: 'mp-lobby-acts' }, acts)];
  }

  function resultsView(st, host) {
    var team = !!(st.cfg && st.cfg.team), rows = st.racers.filter(function (r) { return !r.watching; });
    // a live round ended by the host or the time cap: everyone played to the same end, so each live score is a result
    var score = function (r) { return r.done && !r.dnf ? r.value : LIVE && num(r.live) !== null ? r.live : null; };
    var win = st.racers[0], second = rows[1];
    var winner = !team && win && (win.done && !win.dnf || (LIVE && score(win) !== null && (!second || score(second) === null || score(second) !== score(win))));
    var best = rows.reduce(function (b, r) { var v = score(r); return v !== null && (b === null || (cfg().direction === 'lower' ? v < b : v > b)) ? v : b; }, null);
    var list = el('ol', { class: 'standings', id: 'mp-standings' }, rows.map(function (r, i) {
      var top = team ? score(r) !== null && score(r) === best && rows.length > 1 : i === 0 && winner;
      return el('li', { class: (r.id === S.you ? 'me ' : '') + (top ? 'top' : ''), 'data-id': r.id }, [
        el('span', { class: 'place', text: team ? (top ? '★' : '') : String(i + 1) }), dot(r.id),
        el('span', { class: 'name', text: name(r.id) + (r.id === S.you ? ' (you)' : '') }),
        el('b', { class: 'val', text: r.done && !r.dnf ? fmt(r.value) : r.done ? 'out · ' + fmt(r.value) : LIVE && num(r.live) !== null ? fmt(r.live) : 'did not finish' + (r.live !== null ? ' · ' + fmt(r.live) : '') })]);
    }));
    var title = team ? (win && win.won === true ? 'You won together!' : win && win.won === false ? 'You lost together' : 'Round ' + st.round + ' is over')
      : winner ? (win.id === S.you ? 'You win!' : name(win.id) + ' wins!') : 'Round ' + st.round + ' is over';
    var kids = [el('div', { class: 'eyebrow', text: 'Round ' + st.round + ' · results' }), el('h2', { id: 'mp-results', class: 'title', text: title }), list];
    if (team && rows.length > 1) kids.push(el('p', { class: 'muted', text: '★ most points this round' }));
    kids.push(el('div', { class: 'row' }, [
      host ? el('button', { id: 'mp-again', class: 'primary big', text: 'Play again', onclick: function () { if (!settled()) return; if (humans() < minNow()) { S.lobbyOpen = true; cardKey = null; render(); return; } window.gf.room.send({ k: 'start' }); } })
        : el('p', { class: 'waiting', id: 'mp-waiting' }, [el('i', { class: 'pulse' }), document.createTextNode('Waiting for ' + hostName() + ' to start the next round…')]),
    ]), el('div', { class: 'row foot' }, [
      el('button', { id: 'mp-lobby', class: 'quiet', type: 'button', text: 'Waiting room', onclick: function () { if (!settled()) return; S.lobbyOpen = true; cardKey = null; render(); } }),
      liveButton(),
      // a game that draws its own room has no rail to come back to: the waiting room is the way on
      OWN_HUD ? null : el('button', { id: 'mp-back', class: 'quiet', type: 'button', text: 'Back to the game', onclick: function () { if (!settled()) return; S.dismissed = st.round; cardKey = null; render(); focusGame(); } })]));
    // The round can end mid-click: give the mouse back (a shooter holds it) and ignore clicks for a moment, so a
    // press meant for the game does not land on a button that has just appeared under it.
    if (S.shownResults !== st.round) { S.shownResults = st.round; S.resultsAt = performance.now(); releasePointer(); }
    return kids;
  }

  // ================= WORLDS (kit 1.5.0) =================
  // One room per world, found by its key: no codes, no Start, no rounds, no reloads. The game's page loads once; the
  // card is drawn over it until the player is in. gf.js (v0.4.0) carries each room; this page finds, claims, joins and
  // re-forms rooms, and tells the game through the session its net.js attached.
  var WS = { key: null, max: 8, status: 'menu', n: null, nmax: null, reach: true, code: null, handoffs: 0, lastHandoffMs: null, handoffAt: 0, lastWhy: null,
    attempt: 0, retry: null, countTimer: null, entering: false, leaving: false, stepping: false, avoid: null, avoidUntil: 0, started: false, configured: null,
    cid: null, name: '', draft: null, seed: null, roster: [], last: [], hostNow: null, visitTimer: null, auto: false, toastAt: 0, frameUrl: null, enterAt: 0 };
  var WORLD_VISIT_MS = 60000, WORLD_COUNT_MS = 10000, WORLD_FULL_MS = 5000, WORLD_OFFLINE_MS = 5000;

  function hash32(s, seed) { var h = (seed || 0x811c9dc5) >>> 0; for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h >>> 0; }
  function hex8(n) { return ('0000000' + n.toString(16)).slice(-8); }
  // world.key "auto": world:<slug> under /p/<slug>/ (a published game), else world:local-<hash of the game's path>
  function worldKey() {
    var m = /^\/p\/([a-z0-9]+(?:-[a-z0-9]+)*)\//.exec(gameRoot.pathname);
    if (m && m[1].length <= 48) return 'world:' + m[1];
    var p = location.host + gameRoot.pathname;
    return 'world:local-' + hex8(hash32(p)) + hex8(hash32(p, 0x9747b28c));
  }
  function store(k, v) { try { if (v == null) sessionStorage.removeItem(k); else sessionStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  function load(k) { try { return JSON.parse(sessionStorage.getItem(k) || 'null'); } catch (e) { return null; } }
  // This tab's id: 8 base-36 characters, kept in sessionStorage (a reload keeps it). A duplicated tab copies
  // sessionStorage, so a tab asks the others on this origin whether its id is taken, and takes a new one if so.
  function newCid() { var a = new Uint8Array(8), s = ''; crypto.getRandomValues(a); for (var i = 0; i < 8; i++) s += (a[i] % 36).toString(36); return s; }
  function cidReady() {
    var cid = load('gf-mp:cid');
    if (!(typeof cid === 'string' && /^[a-z0-9]{8}$/.test(cid))) { cid = newCid(); store('gf-mp:cid', cid); }
    WS.cid = cid;
    return new Promise(function (resolve) {
      var bc = null;
      try { bc = new BroadcastChannel('gf-mp:cid'); } catch (e) { resolve(); return; }
      var settled = false, done = function () { if (!settled) { settled = true; resolve(); } };
      bc.onmessage = function (e) {
        var d = e.data || {};
        if (d.q && d.q === WS.cid) bc.postMessage({ dup: d.q, n: d.n });          // another tab asks about my id: it is mine
        else if (d.dup && d.dup === WS.cid && d.n === nonce && !settled) { WS.cid = newCid(); store('gf-mp:cid', WS.cid); done(); }
      };
      var nonce = Math.random().toString(36).slice(2);
      bc.postMessage({ q: WS.cid, n: nonce });
      setTimeout(done, 150);
    });
  }

  function bootWorld() {
    WORLD = true; R = M.world;
    if (!R || typeof R !== 'object') throw new Error('multiplayer.json: mode "world" needs a "world" block');
    var qmax = parseInt(params.get('max') || '', 10), pmax = M.players && Number.isInteger(M.players.max) ? M.players.max : 8;
    WS.max = qmax >= 1 && qmax <= 8 ? qmax : Math.max(1, Math.min(8, pmax));
    WS.key = worldKey();
    WS.seed = String(1 + (hash32(WS.key) % 2147483646));
    OWN_HUD = R.hud === 'game';
    root.dataset.hud = OWN_HUD ? 'game' : 'pill'; root.dataset.mode = 'world'; root.dataset.rail = 'off'; root.dataset.world = 'menu';
    try { var kept = JSON.parse(sessionStorage.getItem('gf-mp:colors:' + gameRoot.pathname) || 'null'); if (Array.isArray(kept)) S.colors = kept; } catch (e) {}
    var title = typeof M.title === 'string' && M.title ? M.title.slice(0, 60) : 'this world';
    document.title = title;
    $('rail-title').textContent = title;
    applyTheme(title);
    window.GF_P2P_CONFIG.ui = 'none';                        // this page draws the card; gf.js draws nothing
    var visit = load('gf-mp:world:' + WS.key);
    WS.auto = !!(visit && typeof visit.at === 'number' && Date.now() - visit.at < WORLD_VISIT_MS);
    if (WATCH_ID) { WS.auto = false; WS.watch = newWatch(WATCH_ID); WS.status = 'watch'; root.dataset.world = 'watch'; }
    watchConfig();
    cidReady().then(function () {
      // The game's own page, loaded at once and never again: the world behind the card, then the world you play in.
      var u = new URL(R.entry || 'index.html', gameRoot), q = new URLSearchParams(u.search);
      q.set('gf-world', '1');
      if (typeof R.query === 'string') new URLSearchParams(R.query).forEach(function (v, k) { q.set(k, v); });
      if (params.get('gq')) new URLSearchParams(params.get('gq')).forEach(function (v, k) { q.set(k, v); });
      q.set('gf_mode', 'world');
      u.search = q.toString();
      WS.frameUrl = u.href;
      frame.hidden = false; frame.src = u.href;
      S.phase = 'world'; root.dataset.phase = 'world';
      renderWorld();
      var s = document.createElement('script');
      s.src = 'vendor/gf.js';
      s.onload = wireWorld;
      s.onerror = function () { fail('The multiplayer kit did not load.', 'gf/mp/vendor/gf.js is missing.'); };
      document.body.append(s);
    });
  }

  function wireWorld() {
    var room = window.gf && window.gf.room, world = window.gf && window.gf.world;
    if (!room || !world) return fail('The multiplayer kit did not start.', 'gf/mp/vendor/gf.js has no world rooms (kit 1.5.0+).');
    var visit = load('gf-mp:world:' + WS.key);
    WS.name = (visit && typeof visit.name === 'string' && visit.name) || world.name();
    room.on('welcome', function (w) {
      S.you = w.you; S.code = w.code || world.state.code;
      WS.roster = Array.isArray(w.players) ? w.players.slice() : [];
      WS.roster.forEach(function (p) { S.names[p.id] = p.name; });
      if (w.name) WS.name = w.name;
      goIn();
    });
    room.on('players', function (list) {
      if (WS.status !== 'in') return;
      WS.roster = Array.isArray(list) ? list.slice() : [];
      WS.roster.forEach(function (p) { S.names[p.id] = p.name; });
      tellWorldPlayers(); renderWorld();
    });
    room.on('message', function (m) {
      if (!m || typeof m !== 'object' || WS.status !== 'in') return;
      if (m.k === 'standings') { S.standing = m; if (!m.cfg || !m.cfg.world) configureWorld(); }
      else if (m.k === 'net') {
        if (m.t === LIVE_TYPE) return liveBadgeIn(m);
        if (m.t === VC_TYPE) return vcIn(m);
        if (!m.to) liveTee(m.t, m.from, m.d);
        if (S.session) { try { S.session.H.onNet(m.t, m.from, m.d); } catch (e) { console.error(e); } }
      }
    });
    room.on('end', onWorldEnd);
    room.on('signal', function (e) { if (e && e.state === 'lost') onWorldSignalLost(); });
    window.addEventListener('pagehide', function () { if (WS.status === 'in') keepVisit(); });
    renderWorld();
    if (WS.watch) watchConnect(WS.watch);
    else if (WS.auto) enterWorld(true);
    else refreshCount();
  }

  // ---- the count on the card ----
  function refreshCount() {
    clearTimeout(WS.countTimer);
    if (WS.status !== 'menu' || !window.gf || !window.gf.world) return;
    window.gf.world.find(WS.key).then(function (f) {
      if (f.t === 'found') { WS.n = f.n; WS.nmax = Math.min(f.max || 8, 8); WS.reach = true; }
      else if (f.t === 'none') { WS.n = 0; WS.nmax = WS.max; WS.reach = true; }
      else if (f.code === 'unreachable') WS.reach = false;
      renderWorld();
    }).then(function () { if (WS.status === 'menu') WS.countTimer = setTimeout(refreshCount, WORLD_COUNT_MS); });
  }

  // ---- entering, and the attempts that find, claim or join the room ----
  function enterWorld(auto) {
    if (WS.status === 'in' || WS.entering) return;
    if (WS.leaving) { setTimeout(function () { enterWorld(auto); }, 120); return; }
    var ni = $('mp-name');
    if (ni && !auto) WS.name = cleanWorldName(ni.value);
    WS.draft = null;
    window.gf.world.saveName(WS.name);
    clearTimeout(WS.countTimer);
    WS.entering = true; WS.enterAt = performance.now();
    setWorldStatus('connecting');
    attemptWorld();
  }
  function cleanWorldName(v) { v = String(v || '').replace(/\s+/g, ' ').trim().slice(0, 24); return v || window.gf.world.roll(); }
  function isCurrent(my) { return my === WS.attempt && WS.entering && !WS.leaving; }
  function attemptWorld() {
    var my = ++WS.attempt;
    clearTimeout(WS.retry);
    window.gf.world.find(WS.key).then(function (f) {
      if (!isCurrent(my)) return;
      if (f.t === 'found') {
        WS.n = f.n; WS.nmax = Math.min(f.max || 8, 8); WS.reach = true;
        // The host that just left is still listed for a moment (a clean close: until its goodbye reaches signaling; a
        // crash: until signaling notices). Never join it then: look again, and claim the world once it is free.
        if (avoiding(f.code)) return retryWorld(my, null, avoidWait());
        if (f.n >= Math.min(WS.nmax, WS.max)) return worldFull(my);
        return joinWorld(f.code, my);
      }
      if (f.t === 'none') { WS.reach = true; WS.n = 0; return hostWorld(my); }
      retryWorld(my, f.code === 'unreachable' ? 'offline' : null, f.code === 'rate' ? 4000 + Math.random() * 2000 : null);
    });
  }
  function avoiding(code) { return !!code && code === WS.avoid && performance.now() < WS.avoidUntil; }
  function avoidWait() { return WS.avoidQuick ? 250 + Math.random() * 250 : 1500 + Math.random() * 500; }
  function hostWorld(my) {
    window.gf.world.host({ key: WS.key, name: WS.name, cid: WS.cid, max: WS.max }).then(function (r) {
      if (!isCurrent(my)) return;
      if (r.t === 'hosted') return;                                      // the welcome brings this copy in
      if (r.code === 'taken') {
        if (avoiding(r.room)) return retryWorld(my, null, avoidWait());
        WS.n = r.n; WS.nmax = Math.min(r.max || 8, 8);
        if (r.n >= Math.min(WS.nmax, WS.max)) return worldFull(my);
        return joinWorld(r.room, my);
      }
      retryWorld(my, r.code === 'unreachable' ? 'offline' : null, r.code === 'rate' ? 4000 + Math.random() * 2000 : null);
    });
  }
  function joinWorld(code, my) {
    // A host gone without a word (a crash) can still be listed for up to 12 s: give it 4 s to answer.
    window.gf.world.join(code, { key: WS.key, name: WS.name, cid: WS.cid, offerMs: WS.handoffAt ? 4000 : 8000 }).then(function (r) {
      if (!isCurrent(my)) return;
      if (r.t === 'in') return;
      if (r.code === 'full') return worldFull(my);
      if (r.code === 'removed') return worldRemoved();
      retryWorld(my, r.code === 'unreachable' ? 'offline' : null, r.code === 'rate' ? 4000 + Math.random() * 2000 : null);
    });
  }
  function retryWorld(my, status, ms) {
    window.gf.world.reset();
    if (status) setWorldStatus(status);
    var wait = ms != null ? ms : status === 'offline' ? WORLD_OFFLINE_MS : 500 + Math.random() * 1000;
    WS.retry = setTimeout(function () { if (isCurrent(my)) attemptWorld(); }, wait);
  }
  // The world's host removed this visitor (kit 1.7.2): no retrying by itself; Enter tries again (refused while that host runs it).
  function worldRemoved() {
    clearInterval(WS.visitTimer);
    S.you = null; S.code = null; S.standing = null; WS.roster = []; WS.entering = false;
    try { window.gf.world.reset(); } catch (e) {}
    setWorldStatus('removed');
  }
  function worldFull(my) {
    window.gf.world.reset();
    setWorldStatus('full');
    WS.retry = setTimeout(function () { if (isCurrent(my)) attemptWorld(); }, WORLD_FULL_MS);
  }
  function stopWaiting() {
    WS.attempt++; clearTimeout(WS.retry); WS.entering = false;
    window.gf.world.reset();
    if (WS.watch) { WS.watch.joinOpen = true; setWorldStatus('watch'); return; }     // a viewer goes back to the stream
    setWorldStatus('menu');
    refreshCount();
  }

  function goIn() {
    clearTimeout(WS.retry); clearTimeout(WS.countTimer);
    WS.entering = false; WS.code = S.code; WS.avoid = null;
    if (WS.handoffAt) { WS.lastHandoffMs = Math.round(performance.now() - WS.handoffAt); WS.handoffAt = 0; }
    WS.stepping = false;
    if (isWorldHost()) configureWorld();
    keepVisit();
    clearInterval(WS.visitTimer); WS.visitTimer = setInterval(keepVisit, 5000);
    var watched = !!WS.watch;
    if (watched) watchStop();                       // a viewer who joined: the room's own messages take over from here
    setWorldStatus('in');
    var first = !WS.started;
    WS.started = true;
    tellWorldHost(); tellWorldPlayers();
    if (first && S.session) { try { S.session.H.onStart(); } catch (e) { console.error(e); } }
    focusGame();
    liveResume();
  }
  // The room becomes a world (room.js: no rounds), once per room, from the host's page.
  function configureWorld() {
    if (!isWorldHost() || WS.configured === S.code) return;
    WS.configured = S.code;
    window.gf.room.send({ k: 'config', world: true });
  }
  function keepVisit() { if (WS.status === 'in') store('gf-mp:world:' + WS.key, { at: Date.now(), name: WS.name }); }

  // The room ended under this copy. Unless this page ended it on purpose, find the world again: the host left.
  function onWorldEnd(e) {
    if (WS.leaving || WS.stepping || WS.status !== 'in') return;
    if (e && e.why === 'kicked') return worldRemoved();
    worldHandoff(e && e.why);
  }
  function worldHandoff(why) {
    WS.handoffs++; WS.handoffAt = performance.now(); WS.lastWhy = why || 'lost';
    // A host that said goodbye is gone for good: skip it until signaling has its goodbye. One that went quiet may be
    // dead or only cut off from this copy: skip it until signaling would have given its world up (12 s), then, if it is
    // still listed, it is alive, and this copy joins it again.
    var bye = why === 'host-left' || why === 'replaced';
    WS.avoid = S.code; WS.avoidQuick = bye; WS.avoidUntil = performance.now() + (bye ? 10000 : 13000);
    WS.last = worldPlayers();
    clearInterval(WS.visitTimer);
    S.you = null; S.code = null; S.standing = null; WS.roster = [];
    WS.entering = true;
    setWorldStatus('handoff');
    var my = ++WS.attempt;
    setTimeout(function () { if (isCurrent(my)) { window.gf.world.reset(); attemptWorld(); } }, Math.random() * 600);
  }
  // This copy hosts, and its signaling session ended: claim the key again for the same room. Another copy holding
  // it means two rooms: this one steps down (its guests follow) and joins the other, so the world never splits.
  function onWorldSignalLost() {
    if (WS.status !== 'in' || !isWorldHost()) return;
    var code = S.code;
    window.gf.world.rehost().then(function (r) {
      if (WS.status !== 'in' || !isWorldHost()) return;
      if (r.t === 'hosted') { S.code = WS.code = r.code; WS.configured = r.code; return; }
      if (r.code === 'taken' && r.room !== code) return stepDown();
      setTimeout(onWorldSignalLost, 3000);                               // unreachable, or our own quiet room still listed
    });
  }
  function stepDown() {
    WS.stepping = true;
    window.gf.world.leave();
    setTimeout(function () { worldHandoff('replaced'); }, 250);
  }

  // net.leave(): back to the card. The game's page stays; Enter works again.
  function leaveWorld() {
    if (WS.status === 'menu') return;
    liveStop('left');
    WS.leaving = true; WS.attempt++; clearTimeout(WS.retry); clearInterval(WS.visitTimer);
    if (WS.status === 'in') window.gf.world.leave();
    store('gf-mp:world:' + WS.key, null);
    WS.last = []; S.you = null; S.code = null; S.standing = null; WS.roster = []; WS.entering = false;
    setWorldStatus('menu');
    tellWorldPlayers();
    setTimeout(function () { window.gf.world.reset(); WS.leaving = false; refreshCount(); }, 300);
  }

  function setWorldStatus(st) {
    if (WS.status === st) { renderWorld(); return; }
    WS.status = st; root.dataset.world = st;
    if (st !== 'handoff') WS.toastAt = 0; else WS.toastAt = performance.now();
    if (S.session) { var H = S.session.H; try { if (H.onStatus) H.onStatus(st, statusInfo()); } catch (e) { console.error(e); } }
    renderWorld();
  }
  function statusInfo() { return { key: WS.key, code: WS.status === 'in' ? S.code : null, n: WS.n, max: WS.max, handoffs: WS.handoffs, why: WS.lastWhy }; }

  // ---- players, as the game sees them ----
  function worldHostId() { return (S.standing && S.standing.hostId) || 'p1'; }      // the hosting copy's seat is the room's first
  function isWorldHost() { return !!(S.you && window.gf && window.gf.world && window.gf.world.state.role === 'host'); }
  // Colours follow the tab (cid), not the seat, so a friend keeps theirs through a handoff; a clash takes the next free one.
  function worldColors(list) {
    var pal = S.colors && S.colors.length ? S.colors : COLORS, used = {}, out = {};
    list.slice().sort(function (a, b) { return seat(a.id) - seat(b.id); }).forEach(function (p) {
      var i = (p.cid ? hash32(p.cid) : seat(p.id)) % pal.length;
      for (var k = 0; k < pal.length && used[i]; k++) i = (i + 1) % pal.length;
      used[i] = 1; out[p.id] = pal[i];
    });
    return out;
  }
  function worldPlayers() {
    if (WS.watch && WS.status !== 'in') return watchPlayers();          // a viewer: the stream's players (kit 1.6.0)
    if (WS.status !== 'in') return WS.status === 'handoff' ? WS.last : [];
    var host = worldHostId(), list = WS.roster.filter(function (p) { return p.connected !== false && !p.bot; }), col = worldColors(list);
    return list.map(function (p) {
      return { id: p.id, seat: seat(p.id), name: S.names[p.id] || p.name, color: col[p.id], host: p.id === host, you: p.id === S.you, connected: true, cid: p.cid || null };
    }).sort(function (a, b) { return a.seat - b.seat; });
  }
  function worldInfo() {
    var list = worldPlayers(), me = list.filter(function (p) { return p.you; })[0];
    var you = me && WS.status === 'in' ? me : { id: WS.status === 'in' ? S.you : null, seat: 0, name: WS.name, color: (S.colors && S.colors[0]) || COLORS[0], host: false, you: true, connected: false, cid: WS.cid };
    return { you: you, players: list, seed: WS.seed, round: WS.started ? 1 : 0 };
  }
  function tellWorldPlayers() {
    if (!S.session) return;
    var list = worldPlayers(), key = JSON.stringify(list);
    if (key === WS.toldPlayers) return;
    WS.toldPlayers = key;
    try { S.session.H.onPlayers(list); } catch (e) { console.error(e); }
  }
  function tellWorldHost() {
    var h = isWorldHost();
    WS.hostNow = h;
    if (S.session && S.session.H.onHost) { try { S.session.H.onHost(h); } catch (e) { console.error(e); } }
  }

  // The game's page attaches once (net.js, at load), before or after the player is in.
  function attachWorld(win, H) {
    if (win !== frame.contentWindow || !H || typeof H.onNet !== 'function') return null;
    var session = { H: H, mode: 'world',
      info: function () { return worldInfo(); },
      status: function () { return WS.status; },
      send: function (t, d, to) {
        if (S.session !== session || WS.status !== 'in' || typeof t !== 'string' || /^gf:/.test(t)) return false;   // gf:* is the kit's own (1.7.2)
        window.gf.room.send(to && to !== 'all' ? { k: 'net', t: t, to: to, d: d } : { k: 'net', t: t, d: d });
        if (!to || to === 'all') liveTee(t, S.you, d);
        return true;
      },
      // the game has set itself up (gf-three: after rules.setup): a viewer's first key frame can go in now
      ready: function () { if (S.session !== session) return; S.gameReady = true; if (WS.watch) watchKeyNow(WS.watch); },
      progress: function () {}, finish: function () {}, endRound: function () {},
      watching: function () { return !!WS.watch && WS.status !== 'in'; },
      watchInfo: function () { return WS.watch ? watchInfo(WS.watch) : null; },
      live: liveApi(),
      room: function () { return WS.status === 'in' ? { key: WS.key, code: S.code, host: isWorldHost(), max: WS.max, players: worldPlayers() } : null; },
      leave: function () { leaveWorld(); } };
    S.session = session; WS.toldPlayers = null; S.gameReady = false;
    if (WS.watch) { WS.watch.keyed = false; WS.watch.queue.length = 0; }        // a reloaded game page catches up again
    // Catch the page up once its module has finished loading (attach runs inside net.js's own setup).
    setTimeout(function () {
      if (S.session !== session) return;
      try { if (H.onStatus) H.onStatus(WS.status, statusInfo()); } catch (e) { console.error(e); }
      if (WS.status === 'in') { tellWorldHost(); tellWorldPlayers(); try { H.onStart(); } catch (e) { console.error(e); } }
    }, 0);
    return session;
  }

  // ---- drawing: the card, the pill and the toast ----
  function countLine() {
    if (!WS.reach) return { cls: 'off', text: 'Can’t reach the world right now' };
    if (WS.status === 'full') return { cls: 'full', text: 'Full right now (' + (WS.n != null ? WS.n : WS.max) + ' of ' + Math.min(WS.nmax || WS.max, WS.max) + ')' };
    if (WS.n === null) return { cls: 'wait', text: 'Checking who’s here…' };
    if (WS.n <= 0) return { cls: 'empty', text: 'Nobody’s here yet: you’ll be first' };
    if (WS.n >= Math.min(WS.nmax || WS.max, WS.max)) return { cls: 'full', text: 'Full right now (' + WS.n + ' of ' + Math.min(WS.nmax || WS.max, WS.max) + ')' };
    return { cls: 'live', text: WS.n + ' building now' };
  }
  function renderWorld() { renderWorldNow(); roomTellPage(false); }
  function renderWorldNow() {
    if (S.fatal) return;
    if (!WORLD) { renderWatch(); renderLiveBadge(); return; }      // a live round's viewer (kit 1.6.1)
    var showCard = WS.status === 'menu' || WS.status === 'connecting' || WS.status === 'full' || WS.status === 'offline' || WS.status === 'removed' || (WS.status === 'watch' && !!WS.watch && WS.watch.joinOpen);
    renderWatch(); renderLiveBadge();
    // the pill (unless the game draws the room itself) and the reconnecting toast
    var pill = $('mp-world-pill');
    if (!OWN_HUD && WS.status === 'in') {
      if (!pill) { pill = el('div', { id: 'mp-world-pill', class: 'world-pill', role: 'status' }); $('stage').append(pill); }
      var n = worldPlayers().length;
      pill.replaceChildren(el('i', { class: 'live-dot' }), document.createTextNode(n + ' here'));
      pill.hidden = false;
    } else if (pill) pill.hidden = true;
    var toast = $('mp-toast');
    if (WS.status === 'handoff') {
      if (!toast) { toast = el('div', { id: 'mp-toast', class: 'world-toast', role: 'status', 'aria-live': 'polite' }); $('stage').append(toast); }
      toast.replaceChildren(el('i', { class: 'spin' }), document.createTextNode('Reconnecting…'));
      toast.hidden = false;
    } else if (toast) toast.hidden = true;

    var editing = document.activeElement && document.activeElement.id === 'mp-name';
    var line = countLine();
    var ck = JSON.stringify([showCard, WS.status, line, WS.name, editing ? 1 : WS.draft, S.colors, !!WS.watch]);
    if (ck === cardKey) return;
    cardKey = ck;
    root.dataset.view = showCard ? 'world-card' : '';
    if (!showCard) { card.hidden = true; card.className = 'card'; card.replaceChildren(); return; }
    var focus = editing ? { v: document.activeElement.value, a: document.activeElement.selectionStart, b: document.activeElement.selectionEnd } : null;
    var busy = WS.status === 'connecting', full = WS.status === 'full', off = WS.status === 'offline';
    var preset = !!(window.GF_P2P_THEME && window.GF_P2P_THEME.names === 'preset');
    var nameIn = preset ? el('output', { id: 'mp-name', class: 'name-field preset', text: WS.name })
      : el('input', { id: 'mp-name', class: 'name-field', maxlength: '24', value: WS.draft !== null ? WS.draft : WS.name, 'aria-label': 'Your name', autocomplete: 'nickname', spellcheck: 'false', disabled: busy || full ? true : null,
        oninput: function () { WS.draft = nameIn.value; },
        onkeydown: function (e) { if (e.key === 'Enter') { e.preventDefault(); enterWorld(false); } } });
    var dice = el('button', { id: 'mp-dice', class: 'dice', type: 'button', title: 'Roll a name', 'aria-label': 'Roll a name', text: preset ? 'New name' : '🎲', disabled: busy || full ? true : null,
      onclick: function () { WS.name = window.gf ? window.gf.world.roll() : WS.name; WS.draft = null; cardKey = null; renderWorld(); } });
    var enter = el('button', { id: 'mp-enter', class: 'primary big', type: 'button', disabled: busy || full ? true : null,
      text: busy ? 'Entering…' : full ? 'Waiting for a seat…' : off ? 'Try again' : 'Enter', onclick: function () { if (off) stopWaiting(); enterWorld(false); } });
    var kids = [
      el('div', { class: 'eyebrow' }, [el('i', { class: 'live-dot' }), document.createTextNode('Live world')]),
      el('h2', { class: 'title', text: $('rail-title').textContent }),
      typeof R.tagline === 'string' && R.tagline ? el('p', { class: 'tagline', text: R.tagline.slice(0, 160) }) : null,
      el('p', { class: 'world-count ' + line.cls, id: 'mp-world-count' }, [el('i', { class: 'dot' }), el('span', { text: line.text })]),
      el('label', { class: 'field-label', for: 'mp-name', text: 'Your name' }),
      el('div', { class: 'namebox' }, [nameIn, dice]),
      el('div', { class: 'row' }, [enter]),
    ];
    if (full) kids.push(el('p', { class: 'hint', text: 'You’ll come in by yourself as soon as a seat frees up.' }),
      el('div', { class: 'row foot' }, [el('button', { id: 'mp-stop-waiting', class: 'quiet', type: 'button', text: WS.watch ? 'Back to watching' : 'Stop waiting', onclick: stopWaiting })]));
    else if (WS.watch && WS.status === 'watch') kids.push(el('div', { class: 'row foot' }, [el('button', { id: 'mp-back-watch', class: 'quiet', type: 'button', text: 'Back to watching', onclick: function () { WS.watch.joinOpen = false; cardKey = null; renderWorld(); } })]));
    else if (off) kids.push(el('p', { class: 'err', text: 'Can’t reach the world right now. Trying again…' }));
    else if (WS.status === 'removed') kids.push(el('p', { class: 'err', id: 'mp-removed', text: 'The host removed you from this world.' }));
    else if (typeof R.sees === 'string' && R.sees) kids.push(el('p', { class: 'hint', text: R.sees.slice(0, 200) }));
    card.className = 'card lobby world';
    card.replaceChildren(el('div', { class: 'panel', 'data-view': 'world' }, kids));
    card.hidden = false;
    if (focus) { var ni = $('mp-name'); if (ni) { ni.value = focus.v; ni.focus(); try { ni.setSelectionRange(focus.a, focus.b); } catch (e) {} } }
  }

  // ================= WATCH THEN PLAY (kit 1.6.0) =================
  // research/watch/PLAN.md §3. The streamer's page tees what an extra player would receive into a relay channel; a
  // viewer's page plays that feed into its game page through the session net.js attached, and sends nothing.
  var WATCH_ID = /^[a-z0-9]{12}$/.test(params.get('watch') || '') ? params.get('watch') : null;
  var LIVE_TYPE = 'gf:live';                       // the room message that tells everyone in it a stream is on
  var PLAYOUT_MS = 300, KEY_MS = 2000, META_MS = 3000, BADGE_MS = 5000, BADGE_STALE_MS = 12000, BATCH_BYTES = 12000;
  var WCFG = null;
  // The play host's /watch/v1: where the relay is (null: streaming is off here) and Studio's origin (the link's page).
  function watchConfig() {
    if (WCFG) return WCFG;
    WCFG = fetch(new URL('/watch/v1', location.href), { cache: 'no-store', credentials: 'omit' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (c) {
        var relay = c && typeof c.relay === 'string' && /^wss?:\/\/[^\s?#]+\/watch\/v1\/$/.test(c.relay) ? c.relay : null;
        var studio = c && typeof c.studio === 'string' && /^https?:\/\/[^\s/?#]+$/.test(c.studio) ? c.studio : null;
        LV.relay = relay; LV.studio = studio; liveChanged();
        helloPage(0);
        return { relay: relay, studio: studio };
      })
      .catch(function () { return { relay: null, studio: null }; });
    return WCFG;
  }
  function gameId() { var m = /^\/p\/([a-z0-9]+(?:-[a-z0-9]+)*)\//.exec(gameRoot.pathname); return m ? m[1] : gameRoot.pathname; }
  function hexColor(c) { return typeof c === 'string' && /^#[0-9a-f]{3,8}$/i.test(c) ? c : null; }
  function text(v, n) { return typeof v === 'string' ? v.replace(/[\u0000-\u001f]/g, ' ').slice(0, n) : ''; }

  // ---- the streamer ----
  var LV = { relay: null, studio: null, state: 'off', ws: null, id: null, key: null, viewers: 0, link: null, error: null, fns: [], timer: null,
    tries: 0, stopping: false, parts: [], size: 0, batchT: 0, poses: {}, world: null, worldFrom: null, rosterKey: '', keyAt: 0, metaAt: 0,
    metaKey: '', badgeAt: 0, sent: { key: 0, d: 0, meta: 0 }, lastErr: null, popup: false, saved: takeSavedStream(), savedShut: false };
  var BADGES = {};                                 // room id → {on, n, at}: who in this room is streaming
  function inRoom() { return WORLD ? WS.status === 'in' : S.phase === 'room' && !!S.code; }
  function liveAvailable() { return !!LV.relay && (WORLD || LIVE) && (inRoom() || LV.state !== 'off'); }
  // The party page's own Go live (a live game's waiting room and results), beside the game's menu (gf-three #gf-live)
  function liveButton() {
    if (WORLD || !liveAvailable()) return null;
    var on = LV.state !== 'off';
    return el('button', { id: 'mp-golive', class: 'quiet live', type: 'button', text: on ? '● You’re live' : 'Go live', onclick: function () { if (on) { LV.popup = true; livePopup(); } else liveStart(); } });
  }
  var LIVE_API = null;
  function liveApi() {
    if (LIVE_API) return LIVE_API;
    LIVE_API = Object.freeze({
      get available() { return liveAvailable(); }, get state() { return LV.state; }, get link() { return LV.link; },
      get viewers() { return LV.viewers; }, get error() { return LV.error; }, get saved() { return !!LV.saved; },
      start: function () { return liveStart(); }, stop: function () { liveStop('stop'); },
      share: function () { if (LV.state !== 'off') { LV.popup = true; livePopup(); } },
      // kit 1.7.4: voice chat on Studio's play page, for the game's pause menu (gf-three: the Voice chat row)
      get voice() { return voiceInfo(); },
      voiceOpen: function () { return vcAsk('gf:vc-open'); }, voiceClose: function () { return vcAsk('gf:vc-close'); },
      onChange: function (fn) { if (typeof fn === 'function') LV.fns.push(fn); },
    });
    return LIVE_API;
  }
  function liveChanged() { LV.fns.forEach(function (fn) { try { fn(LIVE_API); } catch (e) { console.error(e); } }); renderLiveBadge(); renderSaved(); liveTellPage(); if (!WORLD && S.phase === 'room') { cardKey = null; render(); } }

  // ---- the streamer's voice (kit 1.7.0) ----
  // Only the page directly above this one, and only from Studio's origin (this machine, with no Studio: this page's
  // own origin), may hand voice in: a game below this page, or another page on the play origin, never can.
  // Kit 1.7.1 (the creator: "The mic options should come up after you click go live before you start the game"): the
  // stream panel offers Turn on mic as soon as you're live. Under Studio's play page (it answers gf:mic-here) the
  // button asks that page to open the mic; anywhere else it opens Studio's small mic window (/play/<slug>/voice), the
  // only other page that may hand voice in: the window this page opened, from Studio's origin. The play origin itself
  // never opens a microphone (every game shares it), and the mic window opens the mic only when it is clicked there.
  var VOICE = { on: false, frames: 0, bytes: 0, refused: 0, at: 0, above: false, invite: null, popup: null, watch: null, blocked: false };
  function studioOrigin() { return LV.studio || location.origin; }
  function voiceFrom(e) { return e.origin === studioOrigin() && (e.source === window.parent || (!!VOICE.popup && e.source === VOICE.popup)); }
  window.addEventListener('message', function (e) {
    var d = e.data;
    if (!d || typeof d !== 'object' || typeof d.type !== 'string') return;
    if (d.type === 'gf:vc-send' || d.type === 'gf:kick' || d.type === 'gf:room-ask' || d.type === 'gf:vc-state' || d.type === 'gf:vc-closed') {
      // voice chat and the room (kit 1.7.2): only Studio's play page, directly above, never the mic window or a game
      if (!voiceFrom(e) || e.source !== window.parent || window.parent === window) { VOICE.refused++; return; }
      if (d.type === 'gf:room-ask') return roomTellPage(true);
      if (d.type === 'gf:vc-state') return vcState(d);
      if (d.type === 'gf:vc-closed') { if (VCS.open) { VCS.open = false; liveChanged(); } focusGame(); return; }   // the overlay's ×
      if (d.type === 'gf:kick') return void kickPlayer(String(d.id || ''));
      return vcSend(d);
    }
    if (d.type !== 'gf:voice' && d.type !== 'gf:voice-state' && d.type !== 'gf:live-ask' && d.type !== 'gf:mic-here') return;
    if (!voiceFrom(e)) { VOICE.refused++; return; }
    if (d.type === 'gf:mic-here') {
      if (e.source !== window.parent || window.parent === window) return;
      var inv = typeof d.invite === 'string' && d.invite.length < 300 && d.invite.indexOf(studioOrigin() + '/play/') === 0 && !/[\s?#]/.test(d.invite) ? d.invite : null;
      if (!VOICE.above || inv !== VOICE.invite) { VOICE.above = true; VOICE.invite = inv; liveChanged(); cardKey = null; railKey = null; if (WORLD) renderWorld(); else render(); }
      roomTellPage(true);
      return;
    }
    if (d.type === 'gf:live-ask') return liveTellPage(true);
    if (d.type === 'gf:voice-state') { var on = d.on === true && LV.state === 'on'; if (on !== VOICE.on) { VOICE.on = on; LV.metaAt = 0; liveChanged(); } return; }
    if (LV.state !== 'on' || !LV.ws || LV.ws.readyState !== 1) return;
    if (typeof d.d !== 'string' || !d.d || d.d.length > 3800 || !/^[A-Za-z0-9+/]+={0,2}$/.test(d.d)) return;
    var ms = Math.max(10, Math.min(400, Number(d.ms) || 100)), f = Math.max(10, Math.min(60, Number(d.f) || 20));
    // the time is this page's clock, as every delta's is: a viewer plays the voice in step with the game
    LV.ws.send('{"k":"a","t":' + Math.round(performance.now() - ms) + ',"f":' + f + ',"d":"' + d.d + '"}');
    VOICE.frames++; VOICE.bytes += d.d.length; VOICE.at = performance.now();
    if (!VOICE.on) { VOICE.on = true; LV.metaAt = 0; liveChanged(); }
  });
  // The page above (Studio's play page) shows the microphone button while this stream is on.
  var liveTold = '';
  function liveTellPage(force) {
    var msg = { type: 'gf:live-state', v: 1, state: LV.state, viewers: LV.viewers, mic: VOICE.on, id: LV.id }, k = JSON.stringify(msg);
    if (k === liveTold && !force) return;
    liveTold = k;
    if (window.parent !== window) try { window.parent.postMessage(msg, studioOrigin()); } catch (e) {}
    if (VOICE.popup) try { VOICE.popup.postMessage(msg, studioOrigin()); } catch (e) {}
  }
  // The stream panel's mic button (kit 1.7.1).
  function micPress() {
    if (LV.state !== 'on') return;
    if (VOICE.above) { try { window.parent.postMessage({ type: 'gf:mic', v: 1, on: !VOICE.on }, studioOrigin()); } catch (e) {} return; }
    if (VOICE.popup && !VOICE.popup.closed) {
      if (VOICE.on) try { VOICE.popup.postMessage({ type: 'gf:mic', v: 1, on: false }, studioOrigin()); } catch (e) {}
      else try { VOICE.popup.focus(); } catch (e) {}
      return;
    }
    var slug = gameId(), w = null;
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) slug = 'game';
    // not noopener: the mic window talks to this page through window.opener, and this page knows it by the handle
    try { w = window.open(studioOrigin() + '/play/' + slug + '/voice?s=' + encodeURIComponent(LV.id || ''), 'gf-voice', 'popup,width=420,height=380'); } catch (e) {}
    VOICE.blocked = !w; VOICE.popup = w || null;
    if (w) { clearInterval(VOICE.watch); VOICE.watch = setInterval(function () { if (VOICE.popup && !VOICE.popup.closed) return; clearInterval(VOICE.watch); VOICE.popup = null; if (VOICE.on) { VOICE.on = false; LV.metaAt = 0; } liveChanged(); }, 1000); }
    liveChanged();
  }
  // ---- voice chat and the room, for Studio's play page (kit 1.7.2; the creator, 2026-10-12: "connect your mic when
  // joining any game, it just had to be on the website ... you could hear everyone voice in the stream", "Admin can kick,
  // any player can mute them for themselves") ----
  // Voice itself runs on Studio's page (creator-studio/lib/voice-chat.mjs): the play origin never opens a microphone.
  // This page carries its setup between the players over the room (net messages of type gf:vc, any phase, to one player
  // or all; never to the game or a stream), tells the page who is in the room (gf:room), and does the host's Remove.
  var VC_TYPE = 'gf:vc', VC = { sent: 0, got: 0, dropped: 0 }, roomTold = '';
  function vcSend(d) {
    if (!inRoom() || !window.gf || !window.gf.room) { VC.dropped++; return; }
    var to = typeof d.to === 'string' && /^p\d{1,4}$/.test(d.to) ? d.to : null, body = d.d, size = 0;
    try { size = JSON.stringify(body).length; } catch (e) { size = Infinity; }
    if (!body || typeof body !== 'object' || Array.isArray(body) || size > 3800) { VC.dropped++; return; }
    VC.sent++;
    window.gf.room.send(to ? { k: 'net', t: VC_TYPE, to: to, d: body } : { k: 'net', t: VC_TYPE, d: body });
  }
  // ---- kit 1.7.4: voice chat easier to find (the creator, 2026-10-12: "The voice taking up the whole bottom of the screen
  // on game start is too much. It should go away and only be accessable by clicking escape and looking at the menue
  // options. We should also make it more obvious in the lobby. I almost missed it my first time"; and couldn't find the mic
  // on the game's own link). Under Studio's page: a Voice chat button in the waiting room (gf:vc-join) and the pause
  // menu's row (gf:vc-open, gf:vc-close), with the state Studio's page sends down (gf:vc-state). On the game's own link,
  // where Studio is known (the play host's /watch/v1 studio): a line that opens Studio's page in this room. ----
  var VCS = { joined: false, mic: false, n: 0, supported: null, at: 0, asked: [], open: false };
  function vcState(d) {
    var next = { joined: d.joined === true, mic: d.mic === true, n: Math.max(0, Math.min(64, Number(d.n) | 0)), supported: d.supported === false ? false : d.supported === true ? true : null };
    if (next.joined === VCS.joined && next.mic === VCS.mic && next.n === VCS.n && next.supported === VCS.supported) return;
    VCS.joined = next.joined; VCS.mic = next.mic; VCS.n = next.n; VCS.supported = next.supported; VCS.at = Date.now();
    liveChanged();
  }
  function vcAvailable() { return !!VOICE.above && window.parent !== window && VCS.supported !== false && inRoom(); }
  function vcAsk(type) {
    if (!vcAvailable()) return false;
    VCS.asked.push(type); if (VCS.asked.length > 20) VCS.asked.shift();
    try { window.parent.postMessage({ type: type, v: 1 }, studioOrigin()); } catch (e) { return false; }
    var open = type === 'gf:vc-open' ? true : type === 'gf:vc-close' ? false : VCS.open;
    if (open !== VCS.open) { VCS.open = open; liveChanged(); }
    return true;
  }
  function voiceInfo() { return { available: vcAvailable(), joined: VCS.joined, mic: VCS.mic, n: VCS.n, supported: VCS.supported, open: VCS.open }; }
  function voiceLabel() { return VCS.joined ? 'In voice · mic ' + (VCS.mic ? 'on' : 'off') + (VCS.n > 1 ? ' · ' + VCS.n + ' in voice' : '') : 'Join voice chat'; }
  function voiceCta() {
    if (!vcAvailable()) return null;
    return el('button', { id: 'mp-voice', class: 'voice-cta' + (VCS.joined ? ' on' : ''), type: 'button', 'aria-pressed': VCS.joined ? 'true' : 'false',
      text: (VCS.joined ? '🎙 ' : '🎤 ') + voiceLabel(), onclick: function () { vcAsk(VCS.joined ? 'gf:vc-open' : 'gf:vc-join'); } });
  }
  function voiceHint() {
    var slug = gameId();
    if (VOICE.above || !LV.studio || !inRoom() || WORLD || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) return null;
    var href = LV.studio + '/play/' + slug + '?join=' + encodeURIComponent(S.code || '');
    return el('a', { id: 'mp-voice-hint', class: 'voice-hint', href: href, target: '_blank', rel: 'noopener',
      text: 'Voice chat: play from ' + LV.studio.replace(/^https?:\/\//, '') + '/play/' + slug });
  }
  function vcIn(m) {
    if (!VOICE.above || typeof m.from !== 'string' || !m.d || typeof m.d !== 'object') return;
    VC.got++;
    try { window.parent.postMessage({ type: 'gf:vc-in', v: 1, from: m.from, d: m.d }, studioOrigin()); } catch (e) {}
  }
  function roomPlayers() { return (WORLD ? worldPlayers() : playerList()).map(function (p) { return { id: p.id, name: p.name, color: p.color, host: !!p.host, you: !!p.you, connected: p.connected !== false }; }); }
  function roomTellPage(force) {
    if (!VOICE || !VOICE.above) return;                // (VOICE is set further down this file; render can run first)
    var inR = inRoom() && !(S.closed && !WORLD), host = inR && (WORLD ? isWorldHost() : isHost());
    var msg = { type: 'gf:room', v: 1, inRoom: inR, you: inR ? S.you : null, host: host, code: inR ? S.code : null, world: WORLD, players: inR ? roomPlayers() : [],
      phase: WORLD ? 'world' : (S.standing ? S.standing.phase : 'lobby') };   // kit 1.7.4: lobby | loading | countdown | racing | results | world
    var k = JSON.stringify(msg);
    if (k === roomTold && !force) return;
    roomTold = k;
    if (inR) try { msg.ice = window.gf.room.ice; } catch (e) {}
    try { window.parent.postMessage(msg, studioOrigin()); } catch (e) {}
  }
  function kickPlayer(id) {
    if (!/^p\d{1,4}$/.test(id) || id === S.you || !inRoom() || !(WORLD ? isWorldHost() : isHost())) return false;
    return !!(window.gf.room.kick && window.gf.room.kick(id));
  }
  // The host's Remove beside a player: a first press asks, a second within 4 s removes.
  var kickAsk = null, kickTimer = null;
  function kickButton(id) {
    var asking = kickAsk === id;
    return el('button', { class: 'quiet kick' + (asking ? ' asking' : ''), type: 'button', 'data-kick': id, 'aria-label': (asking ? 'Confirm: remove ' : 'Remove ') + name(id),
      text: asking ? 'Remove?' : 'Remove', onclick: function () {
        clearTimeout(kickTimer);
        if (kickAsk === id) { kickAsk = null; kickPlayer(id); }
        else { kickAsk = id; kickTimer = setTimeout(function () { kickAsk = null; cardKey = null; render(); }, 4000); }
        cardKey = null; render();
      } });
  }
  function micRow() {
    if (LV.state !== 'on' || (!VOICE.above && !LV.studio && window.parent !== window)) return null;
    var open = !!VOICE.popup && !VOICE.popup.closed;
    var text = VOICE.on ? 'Mic on · Turn off' : open ? 'Mic window open' : 'Turn on mic';
    var hint = VOICE.on ? 'Your viewers hear you.' : VOICE.blocked ? 'Your browser blocked the mic window. Allow pop-ups for this site, then press again.'
      : VOICE.above ? 'Let your viewers hear you. You can start before the game does.'
      : open ? 'Press Turn on mic in the games.fun window. Keep it open while you talk.'
      : 'Opens a small games.fun window that holds your mic. Keep it open while you talk.';
    return el('div', { class: 'mic' }, [
      el('button', { id: 'mp-live-mic', class: VOICE.on ? 'primary on' : 'primary', type: 'button', 'aria-pressed': VOICE.on ? 'true' : 'false', text: (VOICE.on ? '🎙 ' : '🎤 ') + text, onclick: micPress }),
      el('p', { class: VOICE.blocked && !VOICE.on ? 'err' : 'muted', text: hint })]);
  }
  // kit 1.7.2: the page above may not be listening yet when this page first speaks (its frame loads at once), so the
  // live state goes again each second until Studio's page answers (gf:mic-here), at most ten times; another page above
  // (a post on X) never answers and hears nothing (the target origin is Studio's).
  function helloPage(n) {
    if (VOICE.above || window.parent === window || n >= 10) return;
    liveTellPage(true);
    setTimeout(function () { helloPage(n + 1); }, 1000);
  }
  function setLive(st, err) { LV.state = st; LV.error = err || null; liveChanged(); }
  function rand36(n) { var a = new Uint8Array(n), s = ''; crypto.getRandomValues(a); for (var i = 0; i < n; i++) s += (a[i] % 36).toString(36); return s; }
  function rand64(n) { var a = new Uint8Array(n), s = ''; crypto.getRandomValues(a); for (var i = 0; i < n; i++) s += String.fromCharCode(a[i]); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
  // This tab's channel for this game: a public id (the link) and a secret only this tab holds. sessionStorage, never
  // localStorage: every game on the play origin can read that (kit 1.6.2; play-test 1, 2026-10-09: another page on the
  // origin read the secret and took the stream over). So the link stays the same while this tab is open (a reload, Go
  // live again), and a new tab streams on a new link.
  function channel(fresh) {
    var k = 'gf-watch:' + gameRoot.pathname, c = null;
    try { localStorage.removeItem(k); } catch (e) {}                 // 1.6.0-1.6.1 kept it there
    try { c = JSON.parse(sessionStorage.getItem(k) || 'null'); } catch (e) {}
    if (fresh || !c || !/^[a-z0-9]{12}$/.test(c.id) || !/^[A-Za-z0-9_-]{43}$/.test(c.key)) {
      c = { id: rand36(12), key: rand64(32) };
      try { sessionStorage.setItem(k, JSON.stringify(c)); } catch (e) {}
    }
    return c;
  }
  // Kit 1.6.5 (the creator, 2026-10-11: "If I close my game but want to stream live from the same link as before, how
  // can I do that?"): the share sheet hands the streamer a private streamer link, this friends page with the channel in
  // its #fragment (never sent to a server). Opened later, in any tab, it puts that channel back in this tab's
  // sessionStorage and the next Go live is on the same public link, so an old post on X goes live again. The secret
  // lives in the streamer's own bookmark or notes, not in storage every game on the origin can read.
  function takeSavedStream() {
    var m = /(?:^#|&)gf-stream=([a-z0-9]{12})\.([A-Za-z0-9_-]{43})(?:&|$)/.exec(location.hash);
    if (!m || WATCH_ID) return null;
    try { history.replaceState(history.state, '', location.pathname + location.search); } catch (e) {}
    try { sessionStorage.setItem('gf-watch:' + gameRoot.pathname, JSON.stringify({ id: m[1], key: m[2] })); } catch (e) { return null; }
    return m[1];
  }
  function streamerLink() {
    if (!LV.id || !LV.key) return null;
    var u = new URL(location.href); u.search = ''; u.hash = '';
    if (params.get('signal')) u.searchParams.set('signal', params.get('signal'));
    return u.href + '#gf-stream=' + LV.id + '.' + LV.key;
  }
  function renderSaved() {
    var stage = $('stage'); if (!stage) return;
    var b = $('mp-live-saved'), show = !!LV.saved && !LV.savedShut && LV.state === 'off' && !!LV.relay;
    if (!show) { if (b) b.hidden = true; return; }
    if (!b) {
      b = el('div', { id: 'mp-live-saved', class: 'live-saved', role: 'status' }, [el('i', { class: 'rec off' }),
        el('span', { text: 'Saved stream link ready: Go live to reuse it.' }),
        el('button', { class: 'quiet x', type: 'button', 'aria-label': 'Close', text: '\u00d7', onclick: function () { LV.savedShut = true; renderSaved(); } })]);
      stage.append(b);
    }
    b.hidden = false;
  }
  function watchLink(id) {
    var slug = /^\/p\/([a-z0-9]+(?:-[a-z0-9]+)*)\//.exec(gameRoot.pathname);
    if (slug && LV.studio) return LV.studio + '/play/' + slug[1] + '/live/' + id;
    var u = new URL(location.href); u.search = ''; u.hash = ''; u.searchParams.set('watch', id);   // this machine: the watch page itself
    return u.href;
  }
  function liveStart(fresh) {
    if (LV.state === 'on' || LV.state === 'starting') return true;
    if (!LV.relay || !inRoom() || !(WORLD || LIVE)) return false;
    var c = channel(fresh);
    LV.id = c.id; LV.key = c.key; LV.link = watchLink(c.id);
    LV.stopping = false; LV.tries = 0; LV.lastErr = null; LV.popup = true;
    try { sessionStorage.setItem('gf-watch:on:' + gameRoot.pathname, String(Date.now())); } catch (e) {}
    setLive('starting');
    liveConnect();
    return true;
  }
  // Back in after a reload or a host change within a minute of streaming: carry on, on the same link.
  function liveResume() {
    if (LV.state !== 'off') return;
    var at = 0; try { at = Number(sessionStorage.getItem('gf-watch:on:' + gameRoot.pathname)) || 0; } catch (e) {}
    if (at && Date.now() - at < 60000) watchConfig().then(function () { if (LV.state === 'off' && inRoom()) { liveStart(); LV.popup = false; renderLiveBadge(); } });
  }
  function liveConnect() {
    var ws;
    try { ws = new WebSocket(LV.relay + LV.id + '?role=pub'); } catch (e) { return liveRetry(); }
    LV.ws = ws;
    ws.onopen = function () { if (LV.ws === ws) ws.send(JSON.stringify({ k: 'hello', v: 1, key: LV.key, meta: liveMeta() })); };
    ws.onmessage = function (e) {
      if (LV.ws !== ws) return;
      var m; try { m = JSON.parse(e.data); } catch (x) { return; }
      if (!m || typeof m !== 'object') return;
      if (m.k === 'ok') { LV.tries = 0; LV.viewers = Math.max(0, m.viewers | 0); LV.keyAt = 0; LV.rosterKey = ''; LV.parts = []; LV.size = 0; setLive('on'); liveTick(); liveBadgeSend(); }
      else if (m.k === 'viewers') { LV.viewers = Math.max(0, m.n | 0); liveChanged(); liveBadgeSend(); }
      else if (m.k === 'error') LV.lastErr = String(m.code || '');
    };
    ws.onclose = function (e) {
      if (LV.ws !== ws) return;
      LV.ws = null; clearInterval(LV.timer); LV.timer = null;
      if (LV.stopping || LV.state === 'off') return;
      // somebody else's channel (a new link is made) or this stream went on from another tab
      if (e.code === 4003 || LV.lastErr === 'key') { LV.state = 'off'; return liveStart(true); }
      if (e.code === 4009 || LV.lastErr === 'replaced') return liveEnd('You went live from another tab.');
      liveRetry();
    };
  }
  function liveRetry() {
    if (LV.tries++ >= 6) return liveEnd('Lost the stream. Press Go live to start again.');
    setLive('starting');
    setTimeout(function () { if (LV.state === 'starting' && !LV.stopping && !LV.ws) liveConnect(); }, Math.min(8000, 400 * Math.pow(2, LV.tries)));
  }
  function liveEnd(err) { liveStop('error'); LV.popup = true; setLive('error', err); }
  function liveStop(why) {
    if (LV.state === 'off' && !LV.ws) return;
    LV.stopping = true; clearInterval(LV.timer); LV.timer = null;
    var ws = LV.ws; LV.ws = null;
    if (ws) { try { if (ws.readyState === 1) ws.send('{"k":"bye"}'); ws.close(1000); } catch (e) {} }
    try { sessionStorage.removeItem('gf-watch:on:' + gameRoot.pathname); } catch (e) {}
    LV.viewers = 0; LV.popup = false; LV.parts = []; LV.size = 0; VOICE.on = false; VOICE.blocked = false;
    setLive('off');                                  // the mic window hears 'off' (liveTellPage) and turns the mic off
    liveBadgeSend();
    void why;
  }
  function liveRoster() {
    var list = WORLD ? worldPlayers() : playerList();
    return list.map(function (p) { return { id: p.id, name: p.name, color: p.color, seat: p.seat, cid: p.cid || null, host: !!p.host }; });
  }
  function liveMeta() {
    var list = liveRoster(), mine = list.filter(function (p) { return p.id === S.you; })[0];
    return { v: 1, game: gameId(), title: $('rail-title').textContent || '', mode: WORLD ? 'world' : 'live', name: mine ? mine.name : (WORLD ? WS.name : name(S.you)),
      color: mine ? mine.color : null, mic: VOICE.on, room: { code: S.code || null, n: list.length, max: WORLD ? WS.max : 8, locked: !WORLD && S.locked,
        phase: WORLD ? 'world' : S.lobbyOpen ? 'lobby' : (S.standing ? S.standing.phase : 'lobby'), round: WORLD ? 1 : (S.standing ? S.standing.round : 0),
        result: !WORLD && S.standing && S.standing.phase === 'results' ? resultLine(S.standing) : null } };
  }
  // A finished round in a few words, for a viewer's bar (kit 1.6.2; the results card's own rule): "Hosta wins", "a draw"
  function resultLine(st) {
    var rows = st.racers.filter(function (r) { return !r.watching; }), win = rows[0], second = rows[1];
    if (!win) return null;
    if (st.cfg && st.cfg.team) return win.won === true ? 'they won together' : win.won === false ? 'they lost together' : null;
    var score = function (r) { return r.done && !r.dnf ? r.value : num(r.live) !== null ? r.live : null; };
    var one = win.done && !win.dnf || (score(win) !== null && (!second || score(second) === null || score(second) !== score(win)));
    return one ? name(win.id) + ' wins' : 'a draw';
  }
  // Every message this copy receives for everyone, and every one it sends to everyone, goes in the next delta.
  function liveTee(t, from, d) {
    if (LV.state !== 'on' || typeof t !== 'string' || t === LIVE_TYPE || typeof from !== 'string') return;
    var now = performance.now();
    if (!LV.parts.length) LV.batchT = now;
    if (t === 'p') LV.poses[from] = d;
    else if (t === 'w') { LV.world = d; LV.worldFrom = from; }
    var part;
    try { part = JSON.stringify([Math.round(now - LV.batchT), t, from, d === undefined ? null : d]); } catch (e) { return; }
    if (part.length > 8000) return;
    LV.parts.push(part); LV.size += part.length + 1;
    if (LV.size > BATCH_BYTES) liveFlush();
  }
  function liveFlush() {
    if (!LV.ws || LV.ws.readyState !== 1) { LV.parts = []; LV.size = 0; return; }
    var rk = JSON.stringify(liveRoster()), extra = '';
    if (rk !== LV.rosterKey) { LV.rosterKey = rk; extra = ',"roster":' + rk; LV.keyAt = 0; }
    if (!LV.parts.length && !extra) return;
    LV.ws.send('{"k":"d","t":' + Math.round(LV.batchT || performance.now()) + ',"code":' + JSON.stringify(S.code || null) + ',"m":[' + LV.parts.join(',') + ']' + extra + '}');
    LV.sent.d++; LV.parts = []; LV.size = 0; LV.batchT = 0;
  }
  function liveKey() {
    if (!LV.ws || LV.ws.readyState !== 1) return;
    var roster = liveRoster(), ids = {}, poses = {};
    roster.forEach(function (p) { ids[p.id] = 1; if (LV.poses[p.id]) poses[p.id] = LV.poses[p.id]; });
    for (var k in LV.poses) if (!ids[k]) delete LV.poses[k];
    var blob = null;
    try { blob = S.session && S.session.H.watchKey ? S.session.H.watchKey() : null; } catch (e) { console.error(e); }
    var frame = { k: 'key', v: 1, t: Math.round(performance.now()), mode: WORLD ? 'world' : 'live', code: S.code || null, you: S.you, cid: WORLD ? WS.cid : null, roster: roster,
      seed: WORLD ? WS.seed : (S.go ? S.go.seed : null), round: WORLD ? 1 : (S.go ? S.go.round : 0), poses: poses,
      world: LV.world && LV.worldFrom && ids[LV.worldFrom] ? LV.world : null, host: LV.worldFrom, game: blob };
    var out = JSON.stringify(frame);
    if (out.length > 60000) { frame.game = null; out = JSON.stringify(frame); }
    if (out.length > 64000) return;
    LV.ws.send(out); LV.sent.key++; LV.keyAt = performance.now(); LV.rosterKey = JSON.stringify(roster);
  }
  function liveTick() {
    clearInterval(LV.timer);
    LV.timer = setInterval(function () {
      if (LV.state !== 'on' || !LV.ws) return;
      if (!inRoom() && !(WORLD && WS.status === 'handoff')) return liveStop('left');
      liveFlush();
      var now = performance.now();
      if (now - LV.keyAt > KEY_MS) liveKey();
      if (now - LV.metaAt > META_MS) {
        LV.metaAt = now;
        var mk = JSON.stringify(liveMeta());
        if (mk !== LV.metaKey) { LV.metaKey = mk; LV.ws.send('{"k":"meta","meta":' + mk + '}'); LV.sent.meta++; }
      }
      if (now - LV.badgeAt > BADGE_MS) liveBadgeSend();
    }, 100);
  }
  // Everyone in the room sees that it is being streamed, and how many watch.
  function liveBadgeSend() {
    LV.badgeAt = performance.now();
    if (!inRoom() || !window.gf || !window.gf.room) return;
    try { window.gf.room.send({ k: 'net', t: LIVE_TYPE, d: { on: LV.state === 'on', n: LV.viewers } }); } catch (e) {}
  }
  function liveBadgeIn(m) {
    if (typeof m.from !== 'string' || !m.d || typeof m.d !== 'object') return;
    if (m.d.on) BADGES[m.from] = { on: true, n: Math.max(0, m.d.n | 0), at: performance.now() }; else delete BADGES[m.from];
    renderLiveBadge();
  }
  setInterval(function () { var t = performance.now(), gone = false; for (var k in BADGES) if (t - BADGES[k].at > BADGE_STALE_MS) { delete BADGES[k]; gone = true; } if (gone) renderLiveBadge(); }, 2000);
  function renderLiveBadge() {
    var stage = $('stage'); if (!stage) return;
    var b = $('mp-live'), mine = LV.state === 'on' || LV.state === 'starting' || LV.state === 'error';
    var others = Object.keys(BADGES).filter(function (k) { return k !== S.you && inRoom(); });
    if (!mine && !others.length) { if (b) b.hidden = true; livePopup(); return; }
    if (!b) { b = el('button', { id: 'mp-live', class: 'live-badge', type: 'button', onclick: function () { if (LV.state !== 'off') { LV.popup = !LV.popup; livePopup(); } } }); stage.append(b); }
    var n = mine ? LV.viewers : others.reduce(function (t, k) { return t + BADGES[k].n; }, 0);
    // everyone streaming in this room, not just the first (kit 1.6.2)
    var names = others.map(function (k) { return name(k); }), list = names.length > 2 ? names.length + ' people' : names.join(' and ');
    var who = mine ? (LV.state === 'starting' ? 'Going live…' : LV.state === 'error' ? 'Stream stopped' : 'You’re live' + (others.length ? ', with ' + list : '')) : list + (others.length > 1 ? ' are live' : ' is live');
    if (LV.state === 'error') b.replaceChildren(el('i', { class: 'rec off' }), document.createTextNode(' ' + who + (LV.error ? ': ' + LV.error : '')));
    else b.replaceChildren(el('i', { class: 'rec' }), el('b', { text: 'LIVE' }), document.createTextNode(' ' + who + (LV.state === 'starting' ? '' : ' · ' + n + ' watching') + (mine && VOICE.on ? ' · mic on' : '')));
    b.dataset.state = mine ? LV.state : 'other';
    b.hidden = false;
    livePopup();
  }
  // The streamer's share sheet: the link, Copy, Post on X, Stop.
  function livePopup() {
    var p = $('mp-live-share'), show = LV.popup && (LV.state === 'on' || LV.state === 'starting' || LV.state === 'error');
    if (!show) { if (p) p.hidden = true; return; }
    var key = JSON.stringify([LV.state, LV.link, LV.error, LV.id, VOICE.on, VOICE.above, !!VOICE.popup, VOICE.blocked, LV.studio]);
    if (!p) { p = el('section', { id: 'mp-live-share', class: 'live-share', role: 'dialog', 'aria-label': 'Your stream' }); $('stage').append(p); }
    p.hidden = false;
    if (p.dataset.key === key) return;
    p.dataset.key = key;
    var link = el('input', { id: 'mp-live-link', readonly: true, value: LV.link || '', 'aria-label': 'Your stream link', onfocus: function () { link.select(); } });
    var copy = el('button', { id: 'mp-live-copy', type: 'button', text: 'Copy link', onclick: function () { copyText(LV.link || '', copy, 'Copy link'); } });
    var title = $('rail-title').textContent || 'this game';
    var intent = 'https://x.com/intent/post?text=' + encodeURIComponent('I’m playing ' + title + ' live. Come watch or jump in:') + '&url=' + encodeURIComponent(LV.link || '');
    // A frame that may not open windows (Studio's play page): the page above opens X's post box (gf:open)
    var post = el('a', { id: 'mp-live-post', class: 'button primary', target: '_blank', rel: 'noopener', href: intent, onclick: function (e) {
      e.preventDefault();
      var w = null; try { w = window.open(intent, '_blank'); } catch (x) {}
      if (w) { try { w.opener = null; } catch (x) {} return; }
      var a = []; try { var cur = window; for (var i = 0; i < 6 && cur.parent && cur.parent !== cur; i++) { a.push(cur.parent); cur = cur.parent; } } catch (x) {}
      a.forEach(function (t) { try { t.postMessage({ type: 'gf:open', url: intent }, '*'); } catch (x) {} });
    } }, [document.createTextNode('Post on X')]);
    var keep = el('button', { id: 'mp-live-keep', class: 'quiet', type: 'button', text: 'Copy my streamer link', onclick: function () { var s = streamerLink(); if (s) copyText(s, keep, 'Copy my streamer link'); } });
    p.replaceChildren.apply(p, [
      el('div', { class: 'live-head' }, [el('b', { text: LV.state === 'error' ? 'Stream stopped' : LV.state === 'starting' ? 'Going live…' : 'You’re live' }),
        el('button', { id: 'mp-live-close', class: 'quiet x', type: 'button', 'aria-label': 'Close', text: '×', onclick: function () { LV.popup = false; livePopup(); focusGame(); } })]),
      LV.error ? el('p', { class: 'err', text: LV.error }) : el('p', { class: 'muted', text: 'Anyone with this link watches you play, then can jump in. Everyone here sees that you’re live.' }),
      el('div', { class: 'link' }, [link, copy]),
      micRow(),
      LV.state === 'error' ? null : el('div', { class: 'keep' }, [
        el('p', { class: 'muted', text: 'Want this same link next time? Keep your streamer link and open it before you go live. It\u2019s private: anyone with it can stream as you.' }),
        keep]),
      el('div', { class: 'row' }, LV.state === 'error' ? [el('button', { id: 'mp-live-again', class: 'primary', type: 'button', text: 'Go live again', onclick: function () { LV.state = 'off'; liveStart(); } })]
        : [post, el('button', { id: 'mp-live-stop', class: 'quiet', type: 'button', text: 'Stop streaming', onclick: function () { liveStop('stop'); } })])].filter(Boolean));
  }

  // ---- a live round's viewer (kit 1.6.1): no room; each round's page loads with that round's seed ----
  function bootLiveWatch() {
    S.phase = 'watch'; root.dataset.phase = 'watch'; root.dataset.rail = 'off'; rail.hidden = true; card.hidden = true;
    WS.watch = newWatch(WATCH_ID); WS.status = 'watch';
    showBackdrop();                                 // the game's world, until the stream's round is known
    renderWorld();
    watchConnect(WS.watch);
  }
  function liveWatchRound(W, m) {
    var round = m.round | 0, seed = m.seed;
    if (!round || (typeof seed !== 'string' && typeof seed !== 'number') || !/^[A-Za-z0-9_-]{1,32}$/.test(String(seed))) return;   // the waiting room before round 1: the backdrop stays
    if (W.round === round && W.seed === String(seed)) return;
    W.round = round; W.seed = String(seed); W.keyed = false; W.pendingKey = null; W.queue.length = 0; W.lastHost = null;
    S.go = { round: round, seed: W.seed, cfg: { live: true } };
    var u = new URL(gameUrl(S.go)); u.searchParams.set('gf_mode', 'watch');
    S.session = null; S.gameReady = false;
    frame.classList.remove('backdrop'); frame.removeAttribute('tabindex'); frame.removeAttribute('aria-hidden'); root.dataset.backdrop = '';
    frame.hidden = false; frame.src = u.href;
  }
  function attachLiveWatch(win, H) {
    if (win !== frame.contentWindow || !H || typeof H.onNet !== 'function' || !S.go) return null;
    var W = WS.watch;
    var session = { H: H, mode: 'live',
      info: function () { return { you: { id: 'watch', seat: 0, name: '', color: COLORS[0], host: false, you: true, connected: true }, players: watchPlayers(), seed: W.seed, round: W.round }; },
      status: function () { return null; },
      send: function () { return false; },             // a viewer sends nothing
      // the round is already on: the game starts at once, then catches up from the next key frame
      ready: function () { if (S.session !== session) return; S.gameReady = true; try { H.onStart(); } catch (e) { console.error(e); } watchKeyNow(W); },
      progress: function () {}, finish: function () {}, endRound: function () {}, leave: function () {},
      room: function () { return null; },
      watching: function () { return !!WS.watch; },
      watchInfo: function () { return WS.watch ? watchInfo(WS.watch) : null; },
      live: liveApi() };
    // A new round (or a reloaded viewer) has a new game page. Even an unchanged roster must be sent to that page:
    // the previous page's delivery cache would leave it with no streamer to follow and the arena camera forever.
    S.session = session; WS.toldPlayers = null; S.gameReady = false; W.keyed = false; W.queue.length = 0;
    return session;
  }

  // ---- the viewer ----
  function newWatch(id) {
    return { id: id, ws: null, state: 'connecting', live: false, ended: false, full: false, mismatch: false, meta: null, viewers: 0, since: null,
      roster: [], you: null, keyed: false, pendingKey: null, queue: [], offset: null, lastHost: null, joinOpen: false, retry: null, ping: null,
      got: { key: 0, d: 0, msgs: 0, a: 0 }, voice: newVoice() };
  }
  function watchConnect(W) {
    watchConfig().then(function (c) {
      if (WS.watch !== W) return;
      if (!c.relay) { W.state = 'off'; renderWorld(); return; }
      var ws;
      try { ws = new WebSocket(c.relay + W.id); } catch (e) { return watchRetry(W); }
      W.ws = ws; W.state = 'connecting';
      ws.onopen = function () { if (W.ws !== ws) return; W.state = 'open'; clearInterval(W.ping); W.ping = setInterval(function () { try { if (ws.readyState === 1) ws.send('ping'); } catch (e) {} }, 25000); };
      ws.onmessage = function (e) { if (W.ws === ws && typeof e.data === 'string') watchMessage(W, e.data); };
      ws.onclose = function (e) {
        if (W.ws !== ws) return;
        W.ws = null; clearInterval(W.ping);
        // full (or full from this network): try again in a while, without a reload (kit 1.6.2)
        if (e.code === 4029) { W.full = true; W.state = 'full'; renderWorld(); clearTimeout(W.retry); W.retry = setTimeout(function () { if (WS.watch === W && !W.ws) { W.full = false; watchConnect(W); } }, 20000); return; }
        watchRetry(W);
      };
    });
  }
  function watchRetry(W) {
    if (WS.watch !== W) return;
    W.keyed = false; W.state = 'reconnecting'; renderWorld();
    clearTimeout(W.retry); W.retry = setTimeout(function () { if (WS.watch === W && !W.ws) watchConnect(W); }, 1500 + Math.random() * 2000);
  }
  function watchStop() {
    var W = WS.watch; if (!W) return;
    WS.watch = null;
    clearTimeout(W.retry); clearInterval(W.ping); W.queue.length = 0;
    try { if (W.voice.dec && W.voice.dec.state !== 'closed') W.voice.dec.close(); if (W.voice.ctx) W.voice.ctx.close(); } catch (e) {}
    if (W.ws) { var ws = W.ws; W.ws = null; try { ws.close(1000); } catch (e) {} }
    var bar = $('mp-watch'); if (bar) bar.hidden = true;
    root.dataset.watch = '';
  }
  function cleanMeta(m) {
    if (!m || typeof m !== 'object') return null;
    var r = m.room && typeof m.room === 'object' ? m.room : {};
    return { game: text(m.game, 120), title: text(m.title, 60), mode: m.mode === 'live' ? 'live' : 'world', name: text(m.name, 24) || 'Someone', color: hexColor(m.color), mic: m.mic === true,
      room: { n: Math.max(0, Math.min(99, r.n | 0)), max: Math.max(1, Math.min(99, r.max | 0 || 8)), code: typeof r.code === 'string' && /^[A-Za-z0-9-]{3,32}$/.test(r.code) ? r.code : null,
        phase: ['lobby', 'loading', 'countdown', 'racing', 'results', 'world'].indexOf(r.phase) >= 0 ? r.phase : null, round: Math.max(0, r.round | 0), result: text(r.result, 60) || null, locked: r.locked === true } };
  }
  function cleanRoster(list) {
    return (Array.isArray(list) ? list : []).slice(0, 16).filter(function (p) { return p && typeof p.id === 'string' && /^[a-z0-9]{1,8}$/i.test(p.id); }).map(function (p) {
      return { id: p.id, name: text(p.name, 24) || p.id, color: hexColor(p.color), seat: Math.max(0, Math.min(15, p.seat | 0)), cid: typeof p.cid === 'string' && /^[a-z0-9]{8}$/.test(p.cid) ? p.cid : null, host: !!p.host };
    });
  }
  function watchMessage(W, raw) {
    var m; try { m = JSON.parse(raw); } catch (e) { return; }                      // 'pong' is not JSON
    if (!m || typeof m !== 'object') return;
    if (m.k === 'state') {
      W.live = !!m.live; W.viewers = Math.max(0, m.viewers | 0); W.full = !!m.full; W.fullWhy = m.why === 'network' ? 'network' : null; W.since = typeof m.since === 'number' ? m.since : null; W.gotState = true;
      var meta = cleanMeta(m.meta); if (meta) watchMeta(W, meta);
      if (W.live) W.ended = false; else if (W.keyed) { W.keyed = false; W.queue.length = 0; tellWorldPlayers(); }
      renderWorld();
    } else if (m.k === 'key') { W.got.key++; watchKeyFrame(W, m); }
    else if (m.k === 'd') { W.got.d++; watchDelta(W, m); }
    else if (m.k === 'a') { W.got.a++; watchVoice(W, m); }
    else if (m.k === 'meta') { var mt = cleanMeta(m.meta); if (mt) { watchMeta(W, mt); renderWorld(); } }
    else if (m.k === 'viewers') { W.viewers = Math.max(0, m.n | 0); renderWatch(); }
    else if (m.k === 'end') { W.live = false; W.ended = true; W.keyed = false; W.queue.length = 0; tellWorldPlayers(); renderWorld(); }
  }
  function watchMeta(W, meta) {
    W.meta = meta;
    W.mismatch = meta.game !== gameId() || meta.mode !== (WORLD ? 'world' : 'live');
    if (WS.status === 'watch') { WS.n = meta.room.n; WS.nmax = Math.min(meta.room.max, 8); WS.reach = true; }
  }
  function watchKeyFrame(W, m) {
    if (W.mismatch || !Array.isArray(m.roster)) return;
    var roster = cleanRoster(m.roster), changed = JSON.stringify(roster) !== JSON.stringify(W.roster);
    W.roster = roster; W.you = typeof m.you === 'string' ? m.you : null; W.live = true; W.ended = false;
    W.lastFrameAt = performance.now(); if (W.paused) W.paused = false;
    var kc = typeof m.code === 'string' && /^[A-Za-z0-9-]{3,32}$/.test(m.code) ? m.code : null;
    if (kc && W.keyed && W.code && kc !== W.code) W.queue.push({ at: performance.now() + PLAYOUT_MS, t: '@room', from: '', d: kc });
    if (kc) W.code = kc;
    if (!WORLD) liveWatchRound(W, m);
    if (changed) tellWorldPlayers();
    if (W.keyed) return renderWatch();
    W.pendingKey = m;
    watchKeyNow(W);
  }
  // The first key frame (or the first after falling behind) goes into the game once it has set itself up.
  function watchKeyNow(W) {
    var m = W.pendingKey, H = S.session && S.session.H;
    if (!m || !H || !S.gameReady || W.keyed) return;
    W.pendingKey = null; W.keyed = true; W.queue.length = 0; W.offset = null;
    tellWorldPlayers();
    try {
      if (m.world && typeof m.host === 'string') { if (H.resetWorld) H.resetWorld(); W.lastHost = m.host; H.onNet('w', m.host, m.world); }
      var poses = m.poses && typeof m.poses === 'object' ? m.poses : {};
      for (var id in poses) if (W.roster.some(function (p) { return p.id === id; })) H.onNet('p', id, poses[id]);
      if (H.onWatchKey) H.onWatchKey(m.game && typeof m.game === 'object' ? m.game : null);
    } catch (e) { console.error(e); }
    renderWorld();
  }
  function watchDelta(W, m) {
    W.lastFrameAt = performance.now(); if (W.paused) { W.paused = false; renderWatch(); }
    if (Array.isArray(m.roster)) { var r = cleanRoster(m.roster); if (JSON.stringify(r) !== JSON.stringify(W.roster)) { W.roster = r; tellWorldPlayers(); } }
    if (!W.keyed || W.mismatch || !Array.isArray(m.m) || typeof m.t !== 'number' || !isFinite(m.t)) return;
    // the streamer's own timing, a moment late: the offset is the quickest trip seen lately, and creeps up 1 ms a batch
    var off = performance.now() - m.t;
    W.offset = W.offset === null ? off : Math.min(off, W.offset + 1);
    // kit 1.6.2: the streamer's room changed (a world's host left): the game hears it in order, before the new room's messages
    var code = typeof m.code === 'string' && /^[A-Za-z0-9-]{3,32}$/.test(m.code) ? m.code : null;
    if (code && W.code && code !== W.code) W.queue.push({ at: m.t + W.offset + PLAYOUT_MS - 1, t: '@room', from: '', d: code });
    if (code) W.code = code;
    for (var i = 0; i < m.m.length; i++) {
      var x = m.m[i];
      if (!Array.isArray(x) || typeof x[1] !== 'string' || typeof x[2] !== 'string' || x[1].length > 32) continue;
      W.queue.push({ at: m.t + (Number(x[0]) || 0) + W.offset + PLAYOUT_MS, t: x[1], from: x[2], d: x[3] });
    }
    if (W.queue.length > 4000) W.queue.splice(0, W.queue.length - 4000);
  }
  // ---- the streamer's voice, for a viewer (kit 1.7.0) ----
  // Off until the viewer turns it on (a browser plays sound only after a tap). Each `a` frame is 100 ms of Opus packets
  // (2-byte length, then the bytes: creator-studio/lib/voice-capture.mjs packVoice) stamped with the streamer's clock,
  // so it is played at the same moment as the game messages around it: t + offset + PLAYOUT_MS.
  function newVoice() {
    return { on: false, ctx: null, gain: null, dec: null, due: [], next: 0, supported: typeof AudioDecoder === 'function' && typeof EncodedAudioChunk === 'function',
      heard: 0, offset: null, frames: 0, decoded: 0, played: 0, late: 0, errors: 0, level: 0, peak: 0, error: null };
  }
  function voicePackets(b64) {
    var s; try { s = atob(b64); } catch (e) { return []; }
    var out = [];
    for (var o = 0; o + 2 <= s.length;) {
      var n = (s.charCodeAt(o) << 8) | s.charCodeAt(o + 1); o += 2;
      if (!n || o + n > s.length) break;
      var b = new Uint8Array(n); for (var i = 0; i < n; i++) b[i] = s.charCodeAt(o + i);
      out.push(b); o += n;
    }
    return out;
  }
  function watchVoice(W, m) {
    var V = W.voice, was = V.heard; V.heard = performance.now();
    if (!was) renderWatch();
    if (!V.on || !V.dec || V.dec.state !== 'configured' || typeof m.d !== 'string' || typeof m.t !== 'number') return;
    // kit 1.7.2: in the waiting room there is no game yet, so no clock from the game's frames: the voice keeps its own
    // (from its first packet) until the game's is known, then plays in step with the game as before
    if (W.offset === null && V.offset == null) V.offset = performance.now() - m.t;
    var off = W.offset !== null ? W.offset : V.offset;
    var f = Math.max(10, Math.min(60, Number(m.f) || 20)), pk = voicePackets(m.d);
    V.frames++;
    for (var i = 0; i < pk.length; i++) {
      V.due.push(m.t + i * f + off + PLAYOUT_MS);
      try { V.dec.decode(new EncodedAudioChunk({ type: 'key', timestamp: Math.round((m.t + i * f) * 1000), duration: f * 1000, data: pk[i] })); }
      catch (e) { V.errors++; V.due.pop(); }
    }
  }
  function voicePlay(V, data) {
    var at = V.due.shift();
    try {
      if (at === undefined || !V.ctx || !V.on) return;
      var n = data.numberOfFrames, buf = V.ctx.createBuffer(1, n, data.sampleRate), ch = buf.getChannelData(0);
      data.copyTo(ch, { planeIndex: 0, format: 'f32-planar' });
      var sq = 0, pk = 0; for (var i = 0; i < n; i++) { sq += ch[i] * ch[i]; if (Math.abs(ch[i]) > pk) pk = Math.abs(ch[i]); }
      V.level = Math.sqrt(sq / Math.max(1, n)); V.peak = Math.max(V.peak * 0.98, pk); V.decoded++;
      var t = V.ctx.currentTime, when = t + (at - performance.now()) / 1000;
      if (when < t - 0.03) { V.late++; V.next = 0; return; }                      // behind: skip it, the next one lands on time
      if (V.next && Math.abs(when - V.next) < 0.04) when = V.next;                 // no clicks between packets
      when = Math.max(when, t);
      var src = V.ctx.createBufferSource(); src.buffer = buf; src.connect(V.gain); src.start(when);
      V.next = when + buf.duration; V.played++;
    } catch (e) { V.errors++; }
    finally { try { data.close(); } catch (e) {} }
  }
  function watchSound() {
    var W = WS.watch; if (!W) return;
    var V = W.voice;
    if (V.on) { V.on = false; V.due.length = 0; V.next = 0; try { V.ctx.suspend(); } catch (e) {} renderWatch(); return; }
    if (!V.supported) { V.error = 'Sound isn’t supported in this browser'; renderWatch(); return; }
    try {
      if (!V.ctx) { var AC = window.AudioContext || window.webkitAudioContext; V.ctx = new AC(); V.gain = V.ctx.createGain(); V.gain.connect(V.ctx.destination); }
      V.ctx.resume();
      if (!V.dec || V.dec.state === 'closed') {
        V.dec = new AudioDecoder({ output: function (d) { voicePlay(V, d); }, error: function (e) { V.errors++; V.error = 'The sound stopped'; V.on = false; V.due.length = 0; renderWatch(); } });
        V.dec.configure({ codec: 'opus', sampleRate: 48000, numberOfChannels: 1 });
      }
      V.on = true; V.error = null; V.due.length = 0; V.next = 0;
    } catch (e) { V.error = 'Sound isn’t supported in this browser'; V.on = false; }
    renderWatch();
  }
  // A stream that sends nothing for 6 s (the streamer's tab frozen: a phone switched apps) says it is paused (kit 1.6.2)
  setInterval(function () { var W = WS.watch; if (!W || !W.live || !W.keyed || W.paused || !W.lastFrameAt) return; if (performance.now() - W.lastFrameAt > 6000) { W.paused = true; renderWatch(); } }, 1000);
  // Play what is due, in order, into the game page (a timer, not animation frames: it runs in a background tab too).
  setInterval(function () {
    var W = WS.watch, H = S.session && S.session.H;
    if (!W || !W.queue.length || !H) return;
    var now = performance.now(), n = 0;
    while (W.queue.length && W.queue[0].at <= now && n < 400) {
      var q = W.queue.shift(); n++;
      if (q.t === '@room') { try { if (H.onWatchRoom) H.onWatchRoom(q.d); } catch (e) { console.error(e); } continue; }
      if (q.t === 'w' && q.from !== W.lastHost) { if (H.resetWorld) H.resetWorld(); W.lastHost = q.from; }
      try { H.onNet(q.t, q.from, q.d); W.got.msgs++; } catch (e) { console.error(e); }
    }
  }, 16);
  function watchPlayers() {
    var W = WS.watch; if (!W || !W.keyed) return [];
    var col = worldColors(W.roster);
    return W.roster.map(function (p) { return { id: p.id, seat: p.seat, name: p.name, color: p.color || col[p.id], host: p.host, you: false, connected: true, cid: p.cid }; });
  }
  function watchInfo(W) {
    var f = W.roster.filter(function (p) { return p.id === W.you; })[0] || null;
    return { follow: f ? { id: f.id, cid: f.cid, name: f.name, color: f.color } : null, live: W.live, viewers: W.viewers,
      phase: W.meta ? W.meta.room.phase : null, round: W.meta ? W.meta.room.round : null };
  }
  function watchJoin() {
    var W = WS.watch; if (!W) return;
    if (!WORLD) {                                   // a live round: the room's own invite link; the viewer plays from the next round
      var u = new URL(location.href); u.search = ''; u.hash = '';
      if (W.live && W.meta && W.meta.room.code) u.searchParams.set('join', W.meta.room.code);   // after the stream: the friends page (its room may be gone)
      if (params.get('signal')) u.searchParams.set('signal', params.get('signal'));
      watchStop(); location.assign(u.href); return;
    }
    W.joinOpen = true; cardKey = null; renderWorld(); var ni = $('mp-name'); if (ni && ni.focus) ni.focus();
  }
  // kit 1.6.3 (the creator, 2026-10-10: "add an option to start own lobby or play solo"): a viewer's other ways in.
  // A room of their own is the friends page without the stream or its invite; solo is the game's own page (a world's
  // is its practice copy). A world is one shared world per link, so it has no room of one's own to start.
  function ownRoomUrl() {
    var u = new URL(location.href), q = new URLSearchParams();
    (window.GF_P2P_CONFIG.inviteParams || []).forEach(function (k) { var v = params.get(k); if (v !== null) q.set(k, v); });
    u.search = q.toString(); u.hash = '';
    return u.href;
  }
  function soloUrl() { return new URL((R && R.entry) || 'index.html', gameRoot).href; }
  function watchOwn() { if (!WS.watch || WORLD) return; watchStop(); location.assign(ownRoomUrl()); }
  function watchSolo() { if (!WS.watch) return; watchStop(); location.assign(soloUrl()); }
  // A live round's state, from the stream's meta: what the viewer is looking at between rounds.
  function watchActivity(W) {
    var phase = !WORLD && W.meta ? W.meta.room.phase : null;
    return phase === 'lobby' ? ' is in the lobby' : phase === 'results' ? ' is preparing the next game'
      : phase === 'loading' || phase === 'countdown' ? ' is starting the next game…' : '';
  }

  // The viewer's bar: who is live, how many watch, Join; or why there is nothing to watch. Beside Join (kit 1.6.3): a
  // room of one's own (a live game) and the game alone.
  var watchKeyStr = null;
  function renderWatch() {
    var W = WS.watch, bar = $('mp-watch');
    // hidden while the world card is up over the stream (kit 1.6.2: on a phone it covered "Back to watching")
    if (!W || WS.status === 'in' || (WORLD && (WS.status !== 'watch' || W.joinOpen))) { if (bar) bar.hidden = true; return; }
    if (!bar) { bar = el('div', { id: 'mp-watch', class: 'watch-bar', role: 'status', 'aria-live': 'polite' }); $('stage').append(bar); }
    root.dataset.watch = W.live && !W.mismatch ? 'live' : 'idle';
    var who = W.meta ? W.meta.name : 'This stream', live = W.live && !W.mismatch;
    bar.dataset.waiting = String(!!(live && watchActivity(W)));
    var line = W.mismatch ? 'This stream is playing another game now' : W.full ? (W.fullWhy === 'network' ? 'Too many people are watching from your network' : 'Too many people are watching right now') + ': trying again soon' : W.state === 'off' ? 'Streams aren’t available here'
      : live && W.paused ? who + '’s stream is paused'
      // 1.7.5: no round words (the creator: "just number of people watching is fine"). 1.7.6: this comment had been put at
      // the end of the next line, which cut off its "has ended" and "isn't live" (check 34's Stop step caught it)
      : live ? (W.keyed || !WORLD ? who + watchActivity(W) + ' · ' + W.viewers + ' watching' : 'Tuning in to ' + who + '…') : W.ended ? who + '’s stream has ended' : W.meta ? who + ' isn’t live right now'
      : W.gotState ? 'Nobody is live on this link yet' : 'Looking for the stream…';
    var shut = live && !WORLD && !!(W.meta && W.meta.room.locked);     // kit 1.6.6: the streamer locked their room
    var V = W.voice, talks = live && !!(W.meta && W.meta.mic || V.heard && performance.now() - V.heard < 5000);   // kit 1.7.0: the streamer's mic is on
    var key = JSON.stringify([line, live, !!W.paused, WS.status, W.joinOpen, shut, talks, V.on, V.error]);
    bar.hidden = false;
    if (key === watchKeyStr) return;
    watchKeyStr = key;
    var busy = WS.status !== 'watch' || W.joinOpen ? true : null;
    // the way in with others: the streamer's game while it is live; after it, the game's own friends page (a world: its card)
    var acts = [el('button', { id: 'mp-watch-join', class: 'primary', type: 'button', text: shut ? 'Room locked' : live ? 'Join' : WORLD ? 'Enter the world' : 'Play with friends', title: shut ? who + ' is playing on their own: start a room or play solo' : null, onclick: watchJoin, disabled: busy || (shut ? true : null) })];
    if (live && !WORLD) acts.push(el('button', { id: 'mp-watch-own', type: 'button', text: 'Start a room', title: 'Your own room, for you and your friends', onclick: watchOwn, disabled: busy }));
    acts.push(el('button', { id: 'mp-watch-solo', type: 'button', text: 'Play solo', title: WORLD ? 'A practice copy: nothing you build is saved' : 'On your own, right now', onclick: watchSolo, disabled: busy }));
    if (talks || V.on) acts.unshift(el('button', { id: 'mp-watch-sound', class: V.on ? 'sound on' : 'sound', type: 'button', 'aria-pressed': V.on ? 'true' : 'false',
      text: V.error ? V.error : V.on ? '\u{1F50A} Sound on' : '\u{1F507} Tap for sound', title: V.on ? 'Mute ' + who : 'Hear ' + who + ' talk', onclick: watchSound, disabled: V.error && !V.supported ? true : null }));
    var kids = [el('span', { class: 'watch-line', id: 'mp-watch-line', text: line }), el('span', { class: 'watch-acts' }, acts)];
    if (live && !W.paused) kids.unshift(el('span', { class: 'live-tag' }, [el('i', { class: 'rec' }), el('b', { text: 'LIVE' })]));
    bar.replaceChildren.apply(bar, kids);          // never a null child: replaceChildren writes null out as text
  }

  // Read-only QA observation.
  window.__party = Object.freeze({
    snapshot: function () {
      var st = S.standing;
      return JSON.parse(JSON.stringify({ phase: S.phase, fatal: S.fatal, you: S.you, code: S.code, host: isHost(), room: st ? st.phase : null, round: st ? st.round : 0,
        seed: S.go ? S.go.seed : null, revealed: S.revealed, frame: frame.src || null, frameSeen: A.seen, live: LIVE, session: !!S.session, gameReady: S.gameReady === (S.go ? S.go.round : -1), cfg: R ? cfg() : null, racers: st ? st.racers : [], names: S.names,
        colors: st ? st.racers.map(function (r) { return { id: r.id, color: colorOf(r.id) }; }) : [], described: !!S.colors, min: MIN, hud: OWN_HUD ? 'game' : 'rail', rail: !rail.hidden,
        backdrop: frame.classList.contains('backdrop') ? frame.src : null, note: S.note,
        // kit 1.5.0: a world page (null otherwise)
        world: WORLD ? { key: WS.key, status: WS.status, code: WS.status === 'in' ? S.code : null, n: WS.n, max: WS.max, host: WS.status === 'in' && isWorldHost(), handoffs: WS.handoffs,
          lastHandoffMs: WS.lastHandoffMs, lastWhy: WS.lastWhy, cid: WS.cid, name: WS.name, players: worldPlayers(), started: WS.started, frame: WS.frameUrl, session: !!S.session } : null,
        // kit 1.6.0: streaming (this copy's own stream) and watching (a viewer)
        locked: S.locked, live: { available: liveAvailable(), state: LV.state, id: LV.id, saved: LV.saved, link: LV.link, viewers: LV.viewers, error: LV.error, sent: LV.sent, relay: LV.relay, badges: Object.keys(BADGES),
          mic: { on: VOICE.on, frames: VOICE.frames, bytes: VOICE.bytes, refused: VOICE.refused, above: VOICE.above, window: !!VOICE.popup, blocked: VOICE.blocked } },
          voiceChat: { sent: VC.sent, got: VC.got, dropped: VC.dropped, invite: VOICE.invite || null, state: { joined: VCS.joined, mic: VCS.mic, n: VCS.n, supported: VCS.supported, open: VCS.open }, asked: VCS.asked.slice(), available: vcAvailable() },
        watch: WS.watch ? { id: WS.watch.id, state: WS.watch.state, live: WS.watch.live, ended: WS.watch.ended, keyed: WS.watch.keyed, mismatch: WS.watch.mismatch, full: WS.watch.full,
          viewers: WS.watch.viewers, follow: watchInfo(WS.watch).follow, roster: WS.watch.roster.length, queued: WS.watch.queue.length, got: WS.watch.got, joinOpen: WS.watch.joinOpen,
          voice: (function (V) { return { on: V.on, supported: V.supported, mic: !!(WS.watch.meta && WS.watch.meta.mic), frames: V.frames, decoded: V.decoded, played: V.played, late: V.late, errors: V.errors,
            level: Math.round(V.level * 1e4) / 1e4, peak: Math.round(V.peak * 1e4) / 1e4, error: V.error, ctx: V.ctx ? V.ctx.state : null }; })(WS.watch.voice) } : null,
        results: S.results, card: card.hidden ? null : (card.firstElementChild && card.firstElementChild.dataset.view) || 'fatal',
        adapter: { kind: A.kind, ok: A.ok, armed: A.armed, started: A.started, done: A.done, live: A.live, progress: A.progress, value: A.value, won: A.won, polls: A.polls, sent: A.sent, moves: A.moves, error: A.error } }));
    },
  });
})();
