/*! games.fun multiplayer kit: net.js v1.6.2, the game's side of a LIVE round or a WORLD. MIT. research/multiplayer/party/kit/net.js
 *
 * Kit-owned and byte-identical in every game (never edit a copy). Standard: research/multiplayer/STANDARD.md
 *
 * A live round puts the players in one shared space. Each player's copy of the game:
 *   - sends its own player's pose and draws everyone else's (net.pose / net.peers): you SEE your friends;
 *   - if it is the HOST's copy, owns whatever is shared (enemies, pickups, waves, the clock) and sends it
 *     (net.world); every other copy shows the host's world instead of simulating its own (net.shared);
 *   - sends events to the host or to everyone (net.send / net.on): "I hit zombie 7", "you were hurt".
 * Outside the party page (played alone, in Studio, in QA) net.active is false and every call does nothing, so one
 * code path serves both.
 *
 *   import { net } from './gf/mp/net.js';              // an ES module; the path is relative to the importing file
 *
 *   if (net.active) {                                   // set at load; never changes
 *     net.onStart(() => startPlaying());                // everyone's round starts at the same moment
 *     net.ready();                                      // call once the game has loaded and can start
 *   }
 *   // every frame:
 *   net.pose({ x, y, z, yaw, anim: 'run', hp });        // small flat object; the kit sends at most 15 a second
 *   for (const p of net.peers()) drawFriend(p.id, p.name, p.color, p.state);   // interpolated; p.state is null until known
 *   if (net.host) net.world({ wave, zombies: [{ id, x, z, yaw, hp, s }] });    // at most 12 a second, under 3.5 KB
 *   else { const w = net.shared(); if (w) showWorld(w.state); }                // interpolated between the last two
 *   net.send('hit', { id: 7, dmg: 40 }, 'host');        // 'host' | 'all' (everyone else, the default) | a player id
 *   net.on('hit', (data, from) => { ... });
 *   net.finish({ won: true, value: 183.4 });            // the round's result (team rounds: only the host's counts)
 *   net.finish({ won, value, values: { p1: 40, p2: 12 } });   // 1.4.0, the host: every player's own score (a team round
 *                                                       // shows each player theirs, not the host's number for all)
 *   net.onEnd(() => stopEverything());                  // the round is over for everyone (a result, the host's End round, the time cap)
 *
 * Kit 1.4.0, for a game that draws the room itself (multiplayer.json live.hud "game": the party page then gives it the
 * whole stage during a round):
 *   net.room            {code, invite, host, canEnd, players: [{id, name, color, host, you}]}, or null alone
 *   net.leave()         leave the room (the host: close it for everyone)
 *   net.endRound()      the host ends the round for everyone
 *   net.describe({ colors: ['#ff5ea8', …] })   the game's own seat colours, so the lobby shows each player in the colour
 *                       their character wears; works on any page in the party's frame, even before a round (the lobby's
 *                       backdrop)
 *
 * Kit 1.5.0, WORLDS (multiplayer.json mode "world"; research/worlds/PLAN.md): the page is loaded once with ?gf-world=1
 * and stays up while the player enters, leaves and re-enters, and while the room changes host. No rounds: no
 * finish, progress or endRound (they do nothing). net.mode is 'world' (a live round: 'live'; alone: null).
 *   net.status          'menu' (the world card is up: not in the room yet, or left it) · 'connecting' · 'in' · 'handoff'
 *                       (the host left; a new one is being found) · 'full' (waiting for a seat) · 'offline' (signaling
 *                       can't be reached; it keeps trying)
 *   net.onStatus(fn)    fn(status, info) now and on every change; 'in' comes on every (re)entry, a handoff's too
 *   net.onStart(fn)     once per page visit, on the first entry (never again: not after a handoff, nor a re-entry)
 *   net.started         false until that first entry, then true for the visit (leaving does not reset it)
 *   net.onHost(fn)      fn(isHost) at once when registered after the first entry, then on every change (a handoff
 *                       can make this copy the host). net.host is always current. The new host's copy owns the shared
 *                       world from then on; net.shared() starts empty again after a host change
 *   net.you             from page load, before entering: {id: null until in a room, cid, name, host, seat, color}
 *   cid                 every player entry (net.you, net.players, net.peers(), net.room.players) carries `cid`, the
 *                       tab's 8-character id. It stays the same across a handoff and a reload of that tab (sessionStorage),
 *                       while `id` (the seat) can change, so keep a friend's character by cid. Make anything unique per
 *                       copy (an edit id) from cid plus a counter that survives a reload too.
 *   net.room            {key, code, host, max, players: [...]} while in the room, else null
 *   net.leave()         leave the world: back to the card (status 'menu'); the page stays and Enter works again
 *   during a handoff    net.send(...) and net.world(...) are dropped (send returns false); net.pose keeps the latest pose
 *                       and sends it once back in
 *   net.onPlayers(fn)   also fires after a handoff with the new list
 *
 * Kit 1.6.0, WATCH THEN PLAY (research/watch/PLAN.md): a player can stream the game they are in, and anyone with the
 * link watches it live, drawn by their own copy of the game from the streamer's feed, then joins.
 *   net.watching        true while this copy is a viewer: it receives what the streamer's copy receives (every pose,
 *                       the host's world, every event for everyone) and can send nothing. A world: net.status 'watch'
 *   net.watch           while watching: {follow: {id, cid, name, color} | null (the streamer), live, viewers}; else null
 *   net.onWatchKey(fn)  a viewer: fn(blob) with the streamer's game blob, when the viewer catches up (its first key
 *                       frame, and again after it fell behind): what the game needs that the messages alone don't give
 *   net.watchKey(fn)    the streamer: fn() → that blob (JSON, under 48 KB): looks, a world's unsaved edits, …
 *   net.onWatchRoom(fn) a viewer, kit 1.6.2: fn(code) when the streamer's room changed (a world's host left and a new
 *                       room formed), in order with the stream's messages: a room's own counts (a world's edit order)
 *                       start again there
 *   net.live            the streamer's controls: {available, state ('off' | 'starting' | 'on' | 'error'), link,
 *                       viewers, error, start(), stop(), share(), onChange(fn)}; available is false where nothing relays
 *                       (no relay configured) or alone. Everyone in a streamed room sees LIVE on the party page.
 *
 * Limits (the room on the host's machine enforces them): one message is at most 4096 bytes of JSON, and a player may
 * send 60 messages a second (pose 15 + world 12 leaves room for events; a burst of 120 is tolerated). Over the limit
 * the host's own messages are dropped silently and another player is disconnected, so never send an event per frame.
 * net.shared().state blends every number between two snapshots: read a number that must not be blended (a wave
 * index, a count, a state code) from net.shared().latest, or send it as a string.
 *
 * Rules for a game in a live round: never pause the shared world (not on blur, not on a key: show a menu over a
 * world that keeps running); draw every other player as a character with their name; take the seed from net.seed.
 * Run the frame function with net.loop(frame) instead of requestAnimationFrame: the host's tab has to stay open, and
 * net.loop keeps its simulation stepping when the tab is in the background.
 */
const noop = () => {};
const now = () => performance.now();
const ANGLE = /(^|[^a-z])(yaw|pitch|roll|angle|rot|rotation|heading|facing|dir)$/i;
const POSE_MS = 1000 / 15, WORLD_MS = 1000 / 12, DELAY_MS = 130, STALE_MS = 4000;

/** Blend two states for display. Numbers lerp (angles the short way), lists of {id} match by id, the rest steps at the half. */
export function blend(a, b, t, key = '') {
  if (a === undefined || a === null) return b;
  if (typeof a === 'number' && typeof b === 'number') {
    if (ANGLE.test(key)) { const d = ((b - a + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI; return a + d * t; }
    return a + (b - a) * t;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (b.length && b[0] && typeof b[0] === 'object' && 'id' in b[0]) {
      const old = new Map(a.filter(x => x && typeof x === 'object').map(x => [x.id, x]));
      return b.map(x => blend(old.get(x.id), x, t, key));       // an entity the older state does not have appears as it is
    }
    return a.length === b.length ? b.map((x, i) => blend(a[i], x, t, key)) : b;
  }
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(b)) {
    const out = {};
    for (const k of Object.keys(b)) out[k] = blend(a[k], b[k], t, k);
    return out;
  }
  return t < 0.5 ? a : b;
}

// Two timestamped samples around (now - DELAY_MS) → the blended state. One sample: that sample.
function sample(buf) {
  if (!buf.length) return null;
  const at = now() - DELAY_MS;
  let i = buf.length - 1;
  while (i > 0 && buf[i].t > at) i--;
  const a = buf[i], b = buf[i + 1];
  if (!b) return a.s;
  const span = b.t - a.t;
  return span <= 0 ? b.s : blend(a.s, b.s, Math.max(0, Math.min(1, (at - a.t) / span)));
}
const push = (buf, s) => { buf.push({ t: now(), s }); if (buf.length > 6) buf.shift(); };

function create() {
  const handlers = {}, peers = new Map(), world = [], starts = [], ends = [], playerFns = [], statusFns = [], hostFns = [], watchKeyFns = [], watchRoomFns = [];
  let watchKeyFn = null;
  let lastPose = 0, lastWorld = 0, pendingPose = null, pendingWorld = null, started = false, over = false, timer = null, hostNow = null;
  const call = (fns, ...a) => { for (const fn of fns) { try { fn(...a); } catch (e) { console.error(e); } } };
  const H = {
    onNet(t, from, d) {
      if (t === 'p') { let p = peers.get(from); if (!p) peers.set(from, p = { buf: [], seen: 0 }); push(p.buf, d); p.seen = now(); }
      else if (t === 'w') push(world, d);
      else if (t.charCodeAt(0) === 101 && t[1] === ':') { for (const fn of handlers[t.slice(2)] ?? []) { try { fn(d, from); } catch (e) { console.error(e); } } }
    },
    onPlayers(list) { for (const id of [...peers.keys()]) if (!list.some(p => p.id === id)) peers.delete(id); for (const fn of playerFns) { try { fn(list); } catch (e) { console.error(e); } } },
    onStart() { if (started) return; started = true; for (const fn of starts) { try { fn(); } catch (e) { console.error(e); } } },
    onEnd() { if (over) return; over = true; for (const fn of ends) { try { fn(); } catch (e) { console.error(e); } } },
    // kit 1.5.0, a world: the party page tells the game where it stands, and who owns the shared world now
    onStatus(st, info) { if (st === 'in') flush(); call(statusFns, st, info ?? null); },
    onHost(isHost) {
      isHost = !!isHost;
      if (isHost === hostNow) return;
      hostNow = isHost; world.length = 0;            // the last host's snapshots are not the new host's
      call(hostFns, isHost);
    },
    // kit 1.6.0, watching: the streamer's game blob for a viewer that catches up; the streamer's copy is asked for one
    onWatchKey(blob) { call(watchKeyFns, blob ?? null); },
    onWatchRoom(code) { call(watchRoomFns, code ?? null); },
    watchKey() { if (!watchKeyFn) return null; try { return watchKeyFn() ?? null; } catch (e) { console.error(e); return null; } },
    // a viewer's feed: the streamer's world came from another host than the last one this copy saw
    resetWorld() { world.length = 0; },
  };
  let S = null;
  try { if (window.parent !== window && window.parent.__gfParty) S = window.parent.__gfParty.attach(window, H); } catch { S = null; }   // a parent on another origin: not the party page
  const active = !!S;
  const mode = active ? (S.mode === 'world' ? 'world' : 'live') : null;
  const WORLD = mode === 'world';
  const status = () => (WORLD ? S.status() : null);
  const canSend = () => !WORLD || S.status() === 'in';

  // Whatever is due goes out on the call itself (the game calls pose and world every frame, and net.loop keeps frames
  // coming in a background tab, where a page timer fires only once a second). The timer is only there to send the last
  // value set inside the rate window if the game then stops calling.
  // A world between rooms (a handoff) holds the latest pose and sends it once back in.
  function flush() {
    if (!active || !canSend()) return;
    const t = now();
    if (pendingPose && t - lastPose >= POSE_MS) { S.send('p', pendingPose); pendingPose = null; lastPose = t; }
    if (pendingWorld && t - lastWorld >= WORLD_MS) { S.send('w', pendingWorld); pendingWorld = null; lastWorld = t; }
    if ((pendingPose || pendingWorld) && !timer) timer = setTimeout(() => { timer = null; flush(); }, 30);
  }

  return {
    active,
    /** 'live' (a live round), 'world' (kit 1.5.0), or null when the game is played alone. */
    mode,
    get you() { return active ? S.info().you : null; },
    get host() { return active ? !!S.info().you.host : false; },
    get players() { return active ? S.info().players : []; },
    get seed() { return active ? S.info().seed : null; },
    get round() { return active ? S.info().round : 0; },
    get started() { return started; },
    get over() { return over; },
    /** A world: 'menu' | 'connecting' | 'in' | 'handoff' | 'full' | 'offline'. Otherwise null. */
    get status() { return status(); },

    ready() { if (active) S.ready(); },
    onStart(fn) { if (typeof fn !== 'function') return; starts.push(fn); if (started) fn(); },
    onPlayers(fn) { if (typeof fn === 'function') { playerFns.push(fn); if (active) fn(S.info().players); } },
    onEnd(fn) { if (typeof fn !== 'function') return; ends.push(fn); if (over) fn(); },
    /** A world: fn(status, info) now and on every change. */
    onStatus(fn) { if (typeof fn !== 'function') return; statusFns.push(fn); if (WORLD) { try { fn(S.status(), null); } catch (e) { console.error(e); } } },
    /** fn(isHost) at once once known (a world: after the first entry), then on every change. */
    onHost(fn) {
      if (typeof fn !== 'function') return;
      hostFns.push(fn);
      const known = WORLD ? hostNow !== null : active;
      if (known) { try { fn(WORLD ? hostNow : !!S.info().you.host); } catch (e) { console.error(e); } }
    },

    pose(state) { if (!active || !state || typeof state !== 'object') return; pendingPose = state; flush(); },
    /** Everyone else: [{id, name, color, host, connected, state, age}]. state is interpolated; null until a pose arrives. */
    peers() {
      if (!active) return [];
      const t = now(), you = S.info().you.id;
      return S.info().players.filter(p => p.id !== you).map(p => {
        const q = peers.get(p.id), age = q ? t - q.seen : Infinity;
        return { ...p, state: q && age < STALE_MS ? sample(q.buf) : null, age };
      });
    },

    world(state) { if (!active || !S.info().you.host || !state || typeof state !== 'object' || !canSend()) return; pendingWorld = state; flush(); },
    /** A copy that is not the host's: {state (interpolated), latest, age in ms}, or null before the first one arrives. */
    shared() { return world.length ? { state: sample(world), latest: world[world.length - 1].s, age: now() - world[world.length - 1].t } : null; },

    /** → true when it went out; false alone, or in a world between rooms (a handoff: the event is dropped). */
    send(type, data, to = 'all') { if (!active || typeof type !== 'string' || !canSend()) return false; return S.send('e:' + type, data, to) !== false; },
    on(type, fn) { if (typeof fn === 'function') (handlers[type] ??= []).push(fn); },

    progress(share, value) { if (active && !WORLD) S.progress(typeof share === 'number' ? share : null, typeof value === 'number' ? value : null); },
    finish(result) {
      if (!active || WORLD || !result || typeof result.value !== 'number') return;
      const values = {};
      if (result.values && typeof result.values === 'object') for (const [id, v] of Object.entries(result.values)) if (typeof v === 'number' && Number.isFinite(v)) values[id] = v;
      S.finish(result.value, result.won === true ? true : result.won === false ? false : null, Object.keys(values).length ? values : null);
    },

    /** Kit 1.6.0: true while this copy is watching someone's stream (it sends nothing). */
    get watching() { return active && S.watching ? !!S.watching() : false; },
    /** While watching: {follow: {id, cid, name, color} | null, live, viewers, phase, round}; else null. */
    get watch() { return active && S.watching && S.watching() && S.watchInfo ? S.watchInfo() : null; },
    onWatchKey(fn) { if (typeof fn === 'function') watchKeyFns.push(fn); },
    onWatchRoom(fn) { if (typeof fn === 'function') watchRoomFns.push(fn); },
    watchKey(fn) { watchKeyFn = typeof fn === 'function' ? fn : null; },
    /** The streamer's controls (kit 1.6.0). */
    get live() { return active && S.live ? S.live : LIVE_OFF; },

    get room() { return active && S.room ? S.room() : null; },
    leave() { if (active && S.leave) S.leave(); },
    endRound() { if (active && !WORLD && S.endRound) S.endRound(); },
    describe(info) { try { if (window.parent !== window && window.parent.__gfParty?.describe) window.parent.__gfParty.describe(window, info); } catch {} },

    /**
     * Run the game's frame function: net.loop(frame) INSTEAD of the game's own requestAnimationFrame chain (frame must
     * not schedule itself). Alone, this is exactly requestAnimationFrame. In a live round it also keeps the game
     * stepping when the browser stops animation frames (a hidden, covered or background tab; page timers there slow
     * to one a second), which would freeze the shared world for everyone if this copy is the host: a Web Worker's
     * timer is not slowed, and it calls frame about 30 times a second whenever frames have stalled.
     * The time handed to frame never goes backwards (an animation frame's own stamp can be older than the timer call
     * before it); a game should still clamp its step at zero.
     * Returns a function that stops the loop.
     */
    loop(frame) {
      if (typeof frame !== 'function') return noop;
      let lastRaf = now(), lastT = 0, raf = 0, stopped = false, w = null;
      const run = t => { lastT = t = Math.max(t, lastT); try { frame(t); } catch (e) { console.error(e); } };
      const tick = t => { if (stopped) return; lastRaf = now(); run(t); raf = requestAnimationFrame(tick); };
      raf = requestAnimationFrame(tick);
      if (active) {
        // Animation frames have stalled when none has come for 100 ms. From then on every worker tick (30 ms, inside
        // the 50 ms step most games cap at) is a frame, so the world runs at full speed, until frames come back.
        try {
          w = new Worker(URL.createObjectURL(new Blob(['setInterval(() => postMessage(0), 30)'], { type: 'text/javascript' })));
          w.onmessage = () => { if (!stopped && now() - lastRaf > 100) run(now()); };
        } catch { w = null; }
      }
      return () => { stopped = true; cancelAnimationFrame(raf); if (w) w.terminate(); };
    },
    blend,
  };
}

// No relay, or played alone: nothing to stream.
const LIVE_OFF = Object.freeze({ available: false, state: 'off', link: null, viewers: 0, error: null, start() { return false; }, stop() {}, onChange() {} });

export const net = create();
export default net;
