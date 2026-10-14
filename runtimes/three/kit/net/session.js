// gf-three net: a live round over gf/mp/net.js (gf-multiplayer 1.4.0), and the same code alone with bots.
// Friends play friends: a live round has no bots, whatever botCount or ?bots says (creator 2026-10-08: "We really
// shouldn't have bots in multiplayer modes"); bots are for playing alone.
//
// What each copy owns:
//   every copy   its local player (movement, aim, actions; sends its pose 15 a second through net.pose)
//   the host     the round (phase, clock, end, winners), scores, `alive`, the bots (alone), and ctx.shared: all in one
//                net.world message (12 a second, under 3.5 KB), which every other copy shows instead of simulating
// Events (ctx.net.send/on) are edges, never per frame; they travel as one kit message type 'g' {n, d}.
// Loadouts (CONTRACT §6e, kit/net/looks.js): the pose carries the player's loadout key (`lk`); the loadout itself goes
// as kit messages 'lo' (the loadout) and 'lq' (asking for one), on a change and when a copy lacks it.
// The genex traps (PLAN §2.6): the frame never pauses (net.loop, also in a background tab); hit-pause or any card
// never stops the net pump; reactions to remote things fire on edges (changes in the world), not per frame.
//
// World mode (config/game.json round.mode "world", CONTRACT §9; research/worlds/PLAN.md): no rounds. The phase goes
// lobby → playing and stays there: no clock, no results, no replay. With friends the party page is in world mode
// (gf-multiplayer 1.5.0): the room is the world's, players drop in and out, and the host can change (a handoff), so
// players are keyed by their tab's stable `cid` instead of the room's seat id (worldNet below translates both ways) and
// ctx.host follows net.onHost. Alone, Play enters the world and Quit to menu leaves it as it is.
//
// Watch then play (gf-multiplayer 1.6.0, research/watch/PLAN.md, CONTRACT §9b): a viewer's copy is fed the streamer's
// stream as if it were one more player who sends nothing (net.watching; a world's status 'watch'). It keeps its own
// local player, hidden and still, draws everyone in the stream, and its camera follows the streamer (core/boot.js).
// Each key frame carries what the messages alone don't give a viewer catching up (watchBlob below): everyone's looks,
// each mechanic's watchKey() (build: the world's unsaved edits) and rules.watchKey(ctx); the viewer's copy hands them
// to looks, each mechanic's watchStart(data) and rules.watchStart(ctx, data). Joining ends watching (watchEnd()).
//
// Round flow: lobby → countdown → playing → results → (replay, or back to the lobby: toLobby). Alone the kit draws the
// home menu (kit/ui/menu.js) and the countdown;
// in a live round the party page does (it counts everyone in and starts them together through net.onStart), and
// Play again loads a fresh page, so the in-game replay is for playing alone.
//
// The flow is a part (open builder M4-C; kit/loops/<id>/index.js, kit/loops/README.md): what happens while the phase is
// 'playing' (whose clock, who may act, what ends it) is the flow's, named by config/game.json → round.flow and handed
// in by the boot. A game that names none runs the timed round (kit/loops/round), which is what this file did itself
// before. The lobby, the countdown, the results, the replay, the players and the net stay here for every flow. A world
// (round.mode "world") is not a flow: it changes who the players are and who hosts (below), and stays a mode.
import { net as mpNet } from '../../mp/net.js';
import { createShared } from './shared.js';
// the players module comes from the boot (kit/net/players.js for three.js, gf/forge/players.js for forge,
// CONTRACT §8): the round, the net and the scores here are the same for every runtime
import { createLooks } from './looks.js';
import { spawnOf } from '../core/util.js';
import { refuse } from '../core/refusals.js';
import * as roundFlow from '../loops/round/index.js';

const r2 = v => Math.round(v * 100) / 100;

/**
 * The room's net with every player id turned into the player's `cid` (world mode: a handoff gives everyone a new seat
 * id, the cid stays), so the kit's players, looks and events keep their ids across it. Live rounds use net as it is.
 */
export function worldNet(net) {
  const cidOf = id => net.players.find(p => p.id === id)?.cid ?? id;
  const netIdOf = cid => (cid === 'all' || cid === 'host' ? cid : net.players.find(p => (p.cid ?? p.id) === cid)?.id ?? cid);
  const withCid = p => (p ? { ...p, id: p.cid ?? p.id, netId: p.id } : p);
  return new Proxy(net, {
    get(t, k) {
      if (k === 'players') return t.players.map(withCid);
      if (k === 'you') return withCid(t.you);
      if (k === 'peers') return () => t.peers().map(withCid);
      if (k === 'send') return (type, data, to = 'all') => t.send(type, data, netIdOf(to));
      if (k === 'on') return (type, fn) => t.on(type, (d, from) => fn(d, cidOf(from)));
      if (k === 'onPlayers') return fn => t.onPlayers(list => fn(list.map(withCid)));
      const v = Reflect.get(t, k);
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
}

// `coreWorld` (the forge runtime, CONTRACT §8 forge "Live co-op"): on the host, a function called every frame that
// returns the runtime core's own part of the world message ({f: the core's snapshot}) when one is due, else null; the world
// then goes out only with it, so every snapshot the core takes is sent (its events are taken with it). The three.js
// boot passes none and sends the world every frame as before.
// `coreWatch` (the forge runtime, watch then play: CONTRACT §9b): {key(), take(data)}: the runtime core's own part of the
// stream's key frame (what a viewer tuning in cannot learn from the messages to come), beside looks, mech and rules.
/** The seat colours: character.tint.<role> (config/characters.json → palette), else the look's player palette. */
export const seatPalette = assets => assets.config('characters').palette ?? assets.config('look').palette?.players ?? ['#4f7cff', '#ff5ea8', '#3ddc84', '#ffd166'];

export function createSession(ctx, { rules, spawnCharacter, characterFor, rng, botCount, onPhase = () => {}, createPlayers, coreWorld = null, coreWatch = null, flow: flowModule = null }) {
  const cfg = ctx.config;
  const R = cfg.round ?? {};
  const worldMode = R.mode === 'world';
  const live = mpNet.active;
  const net = live && worldMode ? worldNet(mpNet) : mpNet;
  const listeners = new Map();
  const round = { phase: 'lobby', number: 1, clock: 0, total: 0, countdown: 0, winners: null, reason: null, rows: null, finishedAt: 0, endedByNet: false };
  let hostTime = 0, lastWorldPhase = null, finishTimer = null;

  ctx.host = !live || net.host;
  const localId = live ? net.you.id : 'p1';
  ctx.worldMode = worldMode;
  const shared = createShared({ isHost: () => ctx.host });
  ctx.shared = shared;

  // ---- events ----
  function dispatch(name, data, from) {
    const i = name.indexOf(':');
    if (i > 0) { const m = ctx.mechanics?.get(name.slice(0, i)); if (m?.event) { try { m.event(name.slice(i + 1), data, from); } catch (e) { console.error(e); } return; } }
    // the flow's own messages ('turns:move'): a mechanic of the same name comes first, as above
    if (i > 0 && flow?.event && name.slice(0, i) === flow.id) { try { flow.event(name.slice(i + 1), data, from); } catch (e) { console.error(e); } return; }
    for (const fn of listeners.get(name) ?? []) { try { fn(data, from); } catch (e) { console.error(e); } }
    try { rules.event?.(ctx, name, data, from); } catch (e) { console.error(e); }
  }
  ctx.net = {
    active: live,
    get you() { return live ? net.you.id : localId; },
    /** Send a gameplay event: to 'all' (everyone else), 'host', or a player id. Alone it goes nowhere: the local copy is the host. */
    send(name, data = {}, to = 'all') { if (live && typeof name === 'string') net.send('g', { n: name, d: data }, to); },
    on(name, fn) { if (typeof fn === 'function') (listeners.get(name) ?? listeners.set(name, []).get(name)).push(fn); },
    blend: net.blend,
    /** The room (world mode: {key, code, host, max, players}), or null alone. */
    get room() { return live ? net.room ?? null : null; },
    /** World mode: 'menu' | 'connecting' | 'in' | 'handoff' | 'full' | 'offline'; 'alone' without friends. */
    get status() { return live ? net.status ?? 'in' : 'alone'; },
    worldMode,
  };
  net.on('g', (m, from) => { if (m && typeof m.n === 'string') dispatch(m.n, m.d, from); });
  // the kit's own routed calls: a knock or teleport for a player this copy owns
  net.on('k', m => {
    const p = ctx.players.get(m?.id); if (!p?.owned || !p.controller) return;
    if (m.t === 'knock') p.controller.knock({ x: m.i[0], y: m.i[1], z: m.i[2] }, m.s, { budget: ctx.fair?.on && !m.o ? ctx.fair.split : null });
    else if (m.t === 'push') p.controller.push({ x: m.i[0], y: m.i[1], z: m.i[2] });
    else if (m.t === 'teleport') p.controller.teleport({ x: m.p[0], y: m.p[1], z: m.p[2] }, m.y);
  });
  const ownerOf = p => (p.isBot ? 'host' : p.id);
  const players = createPlayers(ctx, { spawnCharacter, characterFor, routeToOwner: (p, t, d) => { if (live) net.send('k', { t, id: p.id, ...d }, ownerOf(p)); } });
  // What a game's code sees. add, remove and place are the session's own (who plays, where a friend stands): in a friends
  // round the room decides who plays, so a call from rules.js or a mechanic is refused with a code and does nothing
  // (verify check 25 still plays the friends page and counts the players); alone, the call passes through as before.
  const refuseSeat = (what, ret) => (...a) => {
    if (!live) return players[what](...a);
    refuse('players-add-with-friends', `ctx.players.${what}(...) in a friends round: the room decides who plays, so a friends round has the friends and no bots (CONTRACT §6h). Alone the kit seats the bots itself (config/game.json → players.bots, steered by rules.bot); things to fight with friends are the waves mechanic's enemies, not players. Make the call only when !ctx.net.active. It was ignored`, what);
    return ret;
  };
  ctx.players = Object.create(players, {
    add: { value: refuseSeat('add', Promise.resolve(null)), enumerable: true },
    remove: { value: refuseSeat('remove', undefined), enumerable: true },
    place: { value: refuseSeat('place', undefined), enumerable: true },
  });
  // player looks (CONTRACT §6e): this player's loadout from the page, everyone's over the net (kit/net/looks.js)
  const looks = createLooks(ctx, { live, net, localId });
  ctx.looks = looks;

  // ---- watch then play (gf-multiplayer 1.6.0) ----
  const watchBlob = () => {
    const mech = {};
    for (const m of ctx.mechanicsList ?? []) {
      if (typeof m.watchKey !== 'function') continue;
      try { const v = m.watchKey(); if (v != null) mech[m.id] = v; } catch (e) { console.error(e); }
    }
    let r = null; try { r = rules.watchKey?.(ctx) ?? null; } catch (e) { console.error(e); }
    let own = null; if (coreWatch) { try { own = coreWatch.key?.() ?? null; } catch (e) { console.error(e); } }
    return { looks: looks.watchKey(), mech, rules: r, ...(own != null ? { core: own } : {}) };
  };
  function watchTake(b) {
    if (!b || typeof b !== 'object') return;
    looks.watchTake(b.looks);
    if (coreWatch) { try { coreWatch.take?.(b.core ?? null); } catch (e) { console.error(e); } }
    for (const m of ctx.mechanicsList ?? []) { try { m.watchStart?.(b.mech?.[m.id] ?? null); } catch (e) { console.error(e); } }
    try { rules.watchStart?.(ctx, b.rules ?? null); } catch (e) { console.error(e); }
  }
  let wasWatching = false;
  function watchEnded() {
    for (const m of ctx.mechanicsList ?? []) { try { m.watchEnd?.(); } catch (e) { console.error(e); } }
    try { rules.watchEnd?.(ctx); } catch (e) { console.error(e); }
  }

  // ---- who plays ----
  // seat colours: character.tint.<role> (config/characters.json → palette), else the look's player palette
  const palette = seatPalette(ctx.assets);
  const botNames = cfg.players?.botNames ?? ['Pip', 'Bo', 'Moss', 'Juno', 'Rex', 'Ivy', 'Tam'];
  const colorOf = seat => palette[seat % palette.length];
  // a world: the room gives each player the colour that follows their tab (gf-multiplayer 1.5.0, from the palette
  // described below), the one their dot shows on the world card and in the menu; it stays the same through a handoff
  // (play-test 2026-10-09: a player changed colour on becoming the host, and dots and characters disagreed)
  const colorFor = h => (worldMode && typeof h?.color === 'string' && /^#[0-9a-f]{6}$/i.test(h.color) ? h.color : colorOf(h?.seat ?? 0));
  // the party page shows each player in the colour their character wears: the lobby, the rail, the results (kit 1.4.0)
  net.describe?.({ colors: palette.slice(0, 8).map(String) });
  const max = Math.max(1, cfg.players?.max ?? 4);
  async function syncHumans(list) {
    for (const h of list) {
      // a live round's viewer (gf-multiplayer 1.6.1): its own player is a ghost, hidden and in no list (a world's viewer
      // keeps a real one, hidden, because Join makes it theirs in place)
      if (!players.get(h.id)) await players.add({ id: h.id, name: h.name, seat: h.seat, color: colorFor(h), local: h.id === localId, owned: h.id === localId, ghost: h.id === localId && !worldMode && !!net.watching });
      const p = players.get(h.id); if (!p) continue;
      p.connected = h.connected !== false;
      // a world: the seat changes on entering and in a handoff; the colour is the room's (the tab's), so the character,
      // its ring and its name match its dot on the world card and in the menu
      if (worldMode && Number.isInteger(h.seat) && h.seat !== p.seat) p.seat = h.seat;
      if (worldMode && colorFor(h) !== p.color) {
        p.color = colorFor(h);
        p.character?.setTint?.(p.color); p.character?.nameplate?.(p.name, p.color);
        p.character?.object3d.getObjectByName('ring')?.material?.color?.set?.(p.color);
      }
      // a friend changed their name in the room (gf-multiplayer 1.4.0): the scoreboard reads p.name; the nameplate is redrawn
      if (h.name && h.name !== p.name) { p.name = h.name; p.character?.nameplate?.(p.name, p.character.plate?.color ?? p.color); }
    }
    // the local player is never removed by a list (a world's list is empty before entering and changes in a handoff;
    // re-creating the local player would leave ctx.me on an old body whose pose never moves)
    for (const p of players.humans()) if (!p.local && !list.some(h => h.id === p.id)) players.remove(p.id);
  }
  async function syncBots() {
    if (!ctx.host) return;
    const humans = players.humans().length;
    const want = live || worldMode ? 0 : Math.max(0, Math.min(botCount, max - humans));
    const have = players.bots();
    for (let i = have.length; i < want; i++) {
      const seat = humans + i, id = `b${i + 1}`;
      const p = await players.add({ id, name: botNames[i % botNames.length], seat, color: colorOf(seat), isBot: true, owned: true });
      p.bot = ctx.makeBot?.(p) ?? null;
    }
    for (const p of have.slice(want)) players.remove(p.id);
  }

  async function start() {
    if (live) await syncHumans(net.players.length ? net.players : [{ id: localId, name: net.you?.name, seat: net.you?.seat ?? 0 }]);
    else await players.add({ id: localId, name: cfg.text?.you ?? 'You', seat: 0, color: colorOf(0), local: true, owned: true });
    await syncBots();
    ctx.me = players.get(localId);
  }
  /** After rules.setup: the round can start (a late or reloaded copy gets net.onStart at once, so not before). */
  const hostFns = [];
  /** World mode: fn(isHost) when this copy becomes or stops being the host (a handoff). */
  function onHost(fn) { if (typeof fn === 'function') hostFns.push(fn); }
  function arm() {
    if (!live) return;
    looks.start();
    net.watchKey?.(watchBlob);
    net.onWatchKey?.(watchTake);
    // a viewer: the streamer's room changed (gf-multiplayer 1.6.2): a room's own counts start again (build's edit order)
    net.onWatchRoom?.(code => { for (const m of ctx.mechanicsList ?? []) { try { m.watchRoom?.(code); } catch (e) { console.error(e); } } });
    wasWatching = !!net.watching;
    net.onPlayers(list => { syncHumans(list).then(syncBots).catch(e => console.error(e)); });
    net.onStart(() => { if (round.phase === 'lobby') beginPlaying(); });
    if (worldMode) {
      // the host can change in a world (gf-multiplayer 1.5.0): the new host takes the world over where it stands
      net.onHost?.(isHost => {
        const was = ctx.host; ctx.host = !!isHost;
        if (was === ctx.host) return;
        for (const fn of hostFns) { try { fn(ctx.host); } catch (e) { console.error(e); } }
        for (const m of ctx.mechanicsList ?? []) { try { m.hostChanged?.(ctx.host); } catch (e) { console.error(e); } }
        try { rules.hostChanged?.(ctx, ctx.host); } catch (e) { console.error(e); }
      });
      // leaving the world (the pause menu's Leave world, the party page's card): back to the lobby, the world untouched
      net.onStatus?.(st => {
        const w = !!net.watching;
        if (wasWatching && !w) watchEnded();          // a viewer joined (or the stream page stopped watching)
        wasWatching = w;
        if (st === 'menu' && round.phase === 'playing') setPhase('lobby'); else if (st === 'in' && round.phase === 'lobby' && net.started) beginPlaying();
      });
      return;
    }
    net.onEnd(() => { round.endedByNet = true; if (round.phase !== 'results') enterResults(null, 'ended'); });
  }

  // ---- the round ----
  function setPhase(ph) { if (round.phase === ph) return; round.phase = ph; onPhase(ph); }
  function resetPlayers() {
    for (const p of players.list()) {
      p.score = 0; p.alive = true; for (const k of Object.keys(p.data)) delete p.data[k];   // the same object every round
      if (p.owned && p.controller) { const s = spawnOf(ctx.world, p.seat); p.controller.teleport(s, s.yaw); }
    }
  }
  function beginCountdown() {
    if (live) return beginPlaying();
    round.countdown = Math.max(0, R.countdown ?? 3);
    setPhase(round.countdown > 0 ? 'countdown' : 'playing');
    if (round.countdown <= 0) beginPlaying();
  }
  // a world: a player who enters stands on a spawn of their own (their seat's, else the one farthest from everyone they
  // can see), never on top of someone (play-test 2026-10-09: players after the eighth spawned stacked on one spot).
  // Friends' poses can arrive just after this copy is in, so the choice is made again 0.7 s later if it has not moved.
  function enterSpawn(again = false) {
    const me = ctx.me; if (!me?.owned || !me.controller) return;
    if (again && me._spawnAt && Math.hypot(me.position.x - me._spawnAt.x, me.position.z - me._spawnAt.z) > 0.3) return;
    const others = players.list().filter(q => q !== me && q.drawn).map(q => q.position);
    const room = s => others.reduce((m, o) => Math.min(m, Math.hypot(o.x - s.x, o.z - s.z)), Infinity);
    const n = Math.max(1, ctx.world.spawns?.length ?? 1);
    const seat = live && Number.isInteger(net.you?.seat) ? net.you.seat : me.seat ?? 0;
    let best = spawnOf(ctx.world, seat);
    if (room(best) < 1.5) for (let i = 0; i < n; i++) { const s = spawnOf(ctx.world, i); if (room(s) > room(best)) best = s; }
    if (again && me._spawnAt && Math.hypot(best.x - me._spawnAt.x, best.z - me._spawnAt.z) < 0.1) return;
    me.controller.teleport(best, best.yaw);
    me._spawnAt = { x: best.x, z: best.z };
  }
  function beginPlaying() {
    round.clock = 0; round.winners = null; round.reason = null; round.rows = null;
    // (alone, Quit to menu and Play again carries on where the player stood)
    if (worldMode && (live || !ctx.me?._spawnAt)) { enterSpawn(); if (live) setTimeout(() => { if (round.phase === 'playing') enterSpawn(true); }, 700); }
    setPhase('playing');
    if (flow.begin) { try { flow.begin(); } catch (e) { console.error(e); } }
    try { rules.roundStart?.(ctx); } catch (e) { console.error(e); }
  }
  function topScorers() {
    const list = players.list(); if (!list.length) return [];
    const best = Math.max(...list.map(p => p.score));
    return best > 0 || list.length === 1 ? list.filter(p => p.score === best).map(p => p.id) : [];
  }
  function enterResults(winners, reason) {
    if (round.phase === 'results') return;
    round.winners = winners ?? topScorers(); round.reason = reason ?? 'time';
    setPhase('results');
    try { round.rows = rules.results?.(ctx) ?? players.list().map(p => ({ id: p.id, name: p.name, value: p.score })); } catch (e) { console.error(e); round.rows = []; }
    // The result goes in the world first; the party's finish a moment later, so a friend sees the reason before "round over".
    if (live && !net.over) {
      clearTimeout(finishTimer);
      // values: every player's own score from the host's world (a team round shows each player theirs, kit 1.4.0)
      finishTimer = setTimeout(() => {
        const me = ctx.me, values = {};
        for (const p of players.humans()) values[p.id] = p.score;
        net.finish({ won: round.winners.length ? round.winners.includes(me.id) : null, value: me.score, values });
      }, 450);
    }
  }
  /** Host: end the round now ({winners, reason} as check() returns, or a reason string). A flow with rounds inside it
   *  (a match) takes the call as the end of one of them, unless it is `final` (the host's End round in the menu). */
  function end(reason = 'ended', winners = null, final = false) {
    if (!ctx.host || round.phase !== 'playing' || worldMode) return;
    if (flow.end && !final) flow.end(reason, winners); else enterResults(winners, reason);
  }
  /** A flow with rounds inside it: the next one starts where the last ended. Every copy: the mechanics and the players
   *  go back to a round's start and rules.roundStart runs; the host also puts the shared state back, but for `keep`. */
  function restart({ keep = [] } = {}) {
    if (ctx.host) {
      const held = keep.map(k => [k, JSON.parse(JSON.stringify(shared.outgoing()[k] ?? null))]);
      shared.reset();
      for (const [k, v] of held) if (v) shared.outgoing()[k] = v;
    }
    for (const m of ctx.mechanicsList ?? []) { try { m.reset?.(); } catch (e) { console.error(e); } }
    resetPlayers();
    round.clock = 0;
    try { rules.roundStart?.(ctx); } catch (e) { console.error(e); }
  }
  /** Alone: play again in the same page. */
  function replay() {
    if (live || round.phase !== 'results') return false;
    round.number++;
    shared.reset();
    for (const m of ctx.mechanicsList ?? []) { try { m.reset?.(); } catch (e) { console.error(e); } }
    if (flow.reset) { try { flow.reset(); } catch (e) { console.error(e); } }
    resetPlayers();
    beginCountdown();
    return true;
  }

  /** Alone: end the round where it is and go back to the home menu (CONTRACT §6g: Quit to menu, results → Menu). */
  function toLobby() {
    if (live || round.phase === 'lobby') return false;
    // a world is left as it is: nobody is reset or moved, nothing is cleared
    if (worldMode) { setPhase('lobby'); return true; }
    round.number++;
    round.winners = null; round.reason = null; round.rows = null; round.clock = 0; round.countdown = 0;
    shared.reset();
    for (const m of ctx.mechanicsList ?? []) { try { m.reset?.(); } catch (e) { console.error(e); } }
    if (flow.reset) { try { flow.reset(); } catch (e) { console.error(e); } }
    resetPlayers();
    setPhase('lobby');
    return true;
  }

  /** Every frame, before the physics steps: the round clock and, on other copies, the host's world. */
  function tick(dt) {
    hostTime += dt;
    if (ctx.host) {
      if (round.phase === 'countdown') { round.countdown -= dt; if (round.countdown <= 0) beginPlaying(); }
      else if (round.phase === 'playing' && worldMode) round.clock += dt;    // a world has no end
      else if (round.phase === 'playing') flow.hostTick(dt);     // the flow's: its clock, who may act, what ends it
    } else {
      const w = net.shared();
      if (w) {
        const k = w.latest.k ?? {}, ks = w.state.k ?? {};
        shared.receive(w.latest.s ?? null, w.state.s ?? null);
        for (const p of players.list()) { if (k.sc && p.id in k.sc) p.score = k.sc[p.id]; if (k.al && p.id in k.al) p.alive = !!k.al[p.id]; }
        round.clock = (k.t ?? 0) + (k.ph === 'playing' ? Math.min(w.age, 500) / 1000 : 0);
        round.number = k.n ?? round.number;
        hostTime = Math.max(hostTime, k.T ?? 0);
        syncRemoteBots(ks.b ?? [], dt);
        if (k.ph !== lastWorldPhase && !worldMode) {
          lastWorldPhase = k.ph;
          if (k.ph === 'playing' && round.phase !== 'playing' && round.phase !== 'results') beginPlaying();
          if (k.ph === 'results' && round.phase !== 'results') enterResults(k.w ?? null, k.why ?? 'time');
        }
      }
    }
    // friends: from their poses
    if (live) {
      const seen = new Set();
      for (const peer of net.peers()) {
        seen.add(peer.id);
        const p = players.get(peer.id); if (!p || p.owned) continue;
        p.connected = peer.connected !== false;
        players.place(p, peer.state, dt);
      }
    }
    // looks: ask for a friend's loadout their pose says this copy lacks; put on whatever arrived or changed
    looks.tick(dt);
    players.updateLooks();
    // the flow, on every copy: what it shows and plays when its state changes (a turn passed, a round of a match ended)
    if (flow.frame) { try { flow.frame(dt); } catch (e) { console.error(e); } }
  }
  const remoteBotSeen = new Set();
  function syncRemoteBots(list, dt) {
    remoteBotSeen.clear();
    for (const b of list) {
      if (!b || typeof b.id !== 'string') continue;
      remoteBotSeen.add(b.id);
      let p = players.get(b.id);
      if (!p) { if (!pendingBots.has(b.id)) { pendingBots.add(b.id); players.add({ id: b.id, name: b.n, seat: b.s, color: colorOf(b.s ?? 0), isBot: true, owned: false }).finally(() => pendingBots.delete(b.id)); } continue; }
      players.place(p, { x: b.x, y: b.y, z: b.z, yaw: b.yaw, anim: b.a, aim: b.aim, ...(Number.isFinite(b.ad) ? { ad: b.ad } : {}), ...(b.e ? { extra: b.e } : {}) }, dt);
    }
    for (const p of players.bots()) if (!p.owned && !remoteBotSeen.has(p.id) && !pendingBots.has(p.id)) players.remove(p.id);
  }
  const pendingBots = new Set();

  /** Every frame, after everything moved: send this copy's pose and, on the host, the world. */
  let reported = null;
  function send() {
    if (!live) return;
    const me = ctx.me;
    if (me?.controller) { const pose = me.controller.pose(); if (looks.key) pose.lk = looks.key; net.pose(pose); }   // lk: this player's loadout key (§6e)
    // this player's live score for the party page (a round the time cap or a leaving host ends still has everyone's number)
    if (me && round.phase === 'playing' && me.score !== reported && !worldMode) { reported = me.score; net.progress(null, me.score); }
    if (ctx.host) {
      const sc = {}, al = {};
      for (const p of players.list()) { sc[p.id] = p.score; al[p.id] = p.alive ? 1 : 0; }
      const b = players.bots().filter(p => p.controller).map(p => { const q = p.controller.pose(); return { id: p.id, n: p.name, s: p.seat, x: q.x, y: q.y, z: q.z, yaw: q.yaw, a: q.anim, ...(q.aim ? { aim: q.aim } : {}), ...(Number.isFinite(q.ad) ? { ad: q.ad } : {}), ...(q.extra ? { e: q.extra } : {}) }; });
      const extra = coreWorld ? coreWorld() : null;
      if (coreWorld && !extra) return;
      net.world({ k: { ph: round.phase, n: round.number, t: r2(round.clock), T: r2(hostTime), sc, al, b, w: round.winners, why: round.reason }, s: shared.outgoing(), ...(extra ?? {}) });
    }
  }

  function ready() { if (live) net.ready(); }

  /** The block the multiplayer gate reads (research/multiplayer/party/gate-live.mjs). */
  function gateBlock(covered) {
    if (!live) return null;
    const me = ctx.me;
    // where a player is: their body, or, when a part holds the body and gives them a mark (ctx.presenceOf: a board's
    // cursor), the mark. `mark: true` says which, so a reader never takes one for the other
    const at = p => { const q = ctx.presenceOf?.(p) ?? null; return q ? { x: r2(q.x), y: r2(q.y ?? 0), z: r2(q.z), mark: true } : { x: r2(p.position.x), y: r2(p.position.y), z: r2(p.position.z) }; };
    const peers = players.humans().filter(p => !p.local).map(p => ({ id: p.id, name: p.name, ...(p.drawn ? at(p) : { x: null, y: null, z: null }), onScreen: players.visible(p, covered) }));
    return {
      you: net.you.id, host: net.host, started: net.started, watching: !!net.watching,
      me: me ? at(me) : null,
      peers, over: net.over, clock: r2(hostTime), shared: digest(),
    };
  }
  /** A short string equal on every copy when the shared world agrees: the phase, the round and the scores. */
  function digest() {
    const sc = players.list().map(p => `${p.id}:${p.score}`).join(',');
    let extra = ''; try { extra = rules.digest?.(ctx) ?? ''; } catch { extra = '?'; }
    return `${round.phase}|${round.number}|${sc}${extra ? `|${extra}` : ''}`;
  }

  // the flow is made last: it is handed what it may call (kit/loops/README.md) and registers its own shared state
  const flowMod = flowModule ?? roundFlow;
  const flow = flowMod.create(ctx, { ...(R.params ?? {}) }, { round, R, rules, live, worldMode, players, shared, enterResults, restart, topScorers, max });
  ctx.flow = flow;

  return { live, worldMode, net, round, flow, get watching() { return live && !!net.watching; }, get watch() { return live ? net.watch ?? null : null; }, start, arm, ready, tick, send, beginCountdown, end, replay, toLobby, gateBlock, digest, onHost, get hostTime() { return hostTime; }, loop: fn => net.loop(fn), get over() { return net.over; } };
}
