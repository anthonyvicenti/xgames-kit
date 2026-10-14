// games.fun multiplayer kit: the generic RACE room. Kit-owned and byte-identical in every game (never edit a copy).
//
// Everyone plays the SAME single-player game on the SAME seed in the same round. The room hands out the seed, collects
// each player's live value and result, ranks them, and stays open for another round. The game itself has no
// multiplayer code: the party shell (index.html beside this file) loads it in a frame and reads its outcome through
// the adapter declared in the game's multiplayer.json (research/multiplayer/STANDARD.md).
//
// It runs on the host player's machine through the host-join kit (p2p/host-worker.js), under the same room contract
// as every other room (research/multiplayer/ROOM_GUIDE.md). Adapted from templates/live-race/room.js.
//
// Trust: results are each player's own claim, relayed by a host who can read and change everything. Fine for friends;
// nothing here may feed a leaderboard, a prize or a token.
//
// Client → room:  {k:'config', metric, direction, maxSeconds, live?, team?, minPlayers?}   host only, between rounds
//                                                               (minPlayers, kit 1.4.0: connected players a start needs)
//                 {k:'config', world: true}                     host only, before the first round: a world (kit 1.5.0)
//                 {k:'start'} · {k:'stop'}                      host only
//                 {k:'progress', p?: 0..1, v?: number}          a racer's progress share and live value
//                 {k:'finish', value, won?, values?}            a racer's result, once per round (team: the host's, for all;
//                                                               values {id: number}: each player's own score, kit 1.4.0)
//                 {k:'ready'}                                   live: this player's game has loaded and can start
//                 {k:'net', t, to?, d}                          live: a game message for 'all' (default), 'host' or a player id
// Room → client:  {k:'go', round, seed, startsInMs, cfg, resumed?}
//                 {k:'begin', startsInMs}                       live: everyone starts playing then
//                 {k:'net', t, from, d, to?}                     to: set on a message for one player (kit 1.6.0), so a
//                                                               streaming copy forwards only what everyone was sent
//                 {k:'standings', phase, round, hostId, cfg, elapsedMs, startsInMs, racers: [...]}
//                 {k:'error', reason}
//
// LIVE rounds (cfg.live, kit 1.2.0): the players are in one shared space. Each game sends its player's pose and
// draws the others; the host player's copy of the game owns whatever is shared (enemies, pickups, the clock) and
// sends it to everyone. The room only carries those messages: it never looks inside them. A live round waits until
// every game has loaded ('loading'), then counts down and starts everyone together, and a late joiner drops into
// the round in progress. cfg.team: one result for everybody, reported by the host's copy.
//
// WORLDS (kit 1.5.0): {k:'config', world: true} from the host, before any round, makes the room a world for good:
// phase 'world', no rounds, ready wait, countdown, time cap or results. Everyone in it, and everyone who joins later,
// is in at once; game messages ('net') flow as in a live round; a player who leaves is gone (the host engine frees the
// seat and the name). start, stop, progress and finish do nothing.

const DEFAULTS = { metric: 'score', direction: 'higher', maxSeconds: 300, live: false, team: false, minPlayers: 1 };
const COUNTDOWN_MS = 3000;
const LOADING_MS = 25000;       // live: how long a round waits for every game to say it has loaded
const METRICS = ['score', 'time', 'count'];

export default {
  meta: { name: 'Play with friends', minPlayers: 1, maxPlayers: 8, tickHz: 2, rematch: true },

  setup() { return { phase: 'lobby', round: 0, seed: null, startAt: 0, racers: {}, hostId: null, cfg: { ...DEFAULTS } }; },

  onJoin(s, player, api) {
    elect(s, api);
    if (s.phase === 'world') { s.racers[player.id] = fresh(true); return standings(s, api); }   // in at once
    // A late joiner watches the round in progress and races the next one. A rejoining racer keeps their seat.
    const between = s.phase === 'lobby' || s.phase === 'results';
    // Live: a late joiner drops into the shared round. Race: they would only get a head start to nowhere, so they wait.
    if (!s.racers[player.id]) s.racers[player.id] = fresh(between || s.cfg.live);
    const r = s.racers[player.id];
    const running = s.phase === 'loading' || s.phase === 'countdown' || s.phase === 'racing';
    if (running && r.racing && !r.done) {
      r.ready = false;
      api.send(player.id, { k: 'go', round: s.round, seed: s.seed, startsInMs: s.phase === 'loading' ? 0 : Math.max(0, s.startAt - api.now), cfg: s.cfg, resumed: true });
      if (s.cfg.live && s.phase !== 'loading') api.send(player.id, { k: 'begin', startsInMs: Math.max(0, s.startAt - api.now) });
    }
    standings(s, api);
  },

  onLeave(s, player, api) {
    elect(s, api);
    if (s.phase === 'world') { if (!api.players.some(p => p.id === player.id)) delete s.racers[player.id]; return standings(s, api); }
    // kit 1.7.2: a seat that is gone for good (the host removed it), not just away, leaves the standings in any phase
    if (!api.players.some(p => p.id === player.id)) delete s.racers[player.id];
    if (s.phase === 'loading' && allReady(s, api)) return begin(s, api);
    if (s.phase === 'racing' && !s.cfg.team && allDone(s, api)) return finish(s, api);
    standings(s, api);
  },

  onMessage(s, player, msg, api) {
    const r = s.racers[player.id];
    if (!r) return;
    const isHost = player.id === s.hostId, between = s.phase === 'lobby' || s.phase === 'results';
    switch (msg.k) {
      case 'config': {
        if (!isHost || !between) return;
        if (msg.world === true) {
          if (s.round !== 0) return;
          // A world, for good: one endless "round" everyone is in, so game messages flow (kit 1.5.0).
          s.cfg = { ...s.cfg, live: true, team: false, world: true, minPlayers: 1 };
          s.phase = 'world'; s.round = 1; s.startAt = api.now;
          s.seed = String(1 + api.randomInt(2 ** 31 - 2));
          s.racers = {};
          for (const p of api.players) if (p.connected) s.racers[p.id] = fresh(true);
          return standings(s, api);
        }
        if (METRICS.includes(msg.metric)) s.cfg.metric = msg.metric;
        if (msg.direction === 'higher' || msg.direction === 'lower') s.cfg.direction = msg.direction;
        if (Number.isInteger(msg.maxSeconds) && msg.maxSeconds >= 5 && msg.maxSeconds <= 3600) s.cfg.maxSeconds = msg.maxSeconds;
        if (typeof msg.live === 'boolean') s.cfg.live = msg.live;
        if (typeof msg.team === 'boolean') s.cfg.team = msg.team && s.cfg.live;
        if (Number.isInteger(msg.minPlayers) && msg.minPlayers >= 1 && msg.minPlayers <= 8) s.cfg.minPlayers = msg.minPlayers;
        return standings(s, api);
      }
      case 'start': {
        if (!isHost || !between) return api.send(player.id, { k: 'error', reason: 'only the host can start, between rounds' });
        // Friends play friends, never bots (creator 2026-10-08: "We really shouldn't have bots in multiplayer modes"):
        // a round needs the players the host's page asked for (kit 1.4.0: two), all here.
        const here = api.players.filter(p => p.connected && !p.bot).length;
        if (here < (s.cfg.minPlayers ?? 1)) return api.send(player.id, { k: 'error', reason: `a round needs ${s.cfg.minPlayers} players: invite a friend first` });
        s.round++;
        // Live: wait for every game to load, then count down. Race: count down at once (the game starts when it starts).
        if (s.cfg.live) { s.phase = 'loading'; s.startAt = api.now + LOADING_MS; }
        else { s.phase = 'countdown'; s.startAt = api.now + COUNTDOWN_MS; }
        // Digits only: games read ?seed= as a number as often as a string, and a number that is not one means "random".
        s.seed = String(1 + api.randomInt(2 ** 31 - 2));
        s.racers = {};
        for (const p of api.players) s.racers[p.id] = fresh(p.connected);
        api.broadcast({ k: 'go', round: s.round, seed: s.seed, startsInMs: s.cfg.live ? 0 : COUNTDOWN_MS, cfg: s.cfg });
        return standings(s, api);
      }
      case 'ready': {
        if (!s.cfg.live || !r.racing) return;
        r.ready = true;
        if (s.phase === 'loading' && allReady(s, api)) return begin(s, api);
        return;
      }
      case 'net': {
        // kit 1.6.1: a stream's LIVE notice reaches everyone in the room in any phase (the waiting room included)
        if (msg.t === 'gf:live' && s.cfg.live && msg.d && typeof msg.d === 'object') return api.broadcast({ k: 'net', t: msg.t, from: player.id, d: { on: !!msg.d.on, n: Math.max(0, msg.d.n | 0) } }, player.id);
        // kit 1.7.2: voice chat's setup between the players' Studio pages (offers, answers, network candidates, who is in
        // voice) in any phase, the waiting room included; to everyone or to one player. The room never reads it.
        if (msg.t === 'gf:vc') {
          if (!msg.d || typeof msg.d !== 'object' || Array.isArray(msg.d)) return;
          const out = { k: 'net', t: msg.t, from: player.id, d: msg.d };
          if (msg.to === undefined || msg.to === 'all') return api.broadcast(out, player.id);
          if (typeof msg.to === 'string' && msg.to !== player.id && s.racers[msg.to]) api.send(msg.to, { ...out, to: msg.to });
          return;
        }
        // A game message. The room carries it and never reads it; the host engine has already capped its size and rate.
        if (!s.cfg.live || !r.racing || s.round === 0 || typeof msg.t !== 'string' || msg.t.length > 24) return;
        const out = { k: 'net', t: msg.t, from: player.id, d: msg.d };
        if (msg.to === undefined || msg.to === 'all') return api.broadcast(out, player.id);
        const to = msg.to === 'host' ? s.hostId : msg.to;
        if (typeof to === 'string' && to !== player.id && s.racers[to]) api.send(to, { ...out, to });
        return;
      }
      case 'stop': {
        if (!isHost || s.phase !== 'racing') return;
        return finish(s, api);
      }
      case 'progress': {
        if (s.phase !== 'racing' || !r.racing || r.done) return;
        if (finite(msg.p)) r.progress = Math.max(r.progress, Math.min(0.999, Math.max(0, msg.p)));   // 1.0 only on finish
        if (finite(msg.v)) r.live = msg.v;
        return;
      }
      case 'finish': {
        if (s.phase !== 'racing' || !r.racing || r.done) return;
        if (!finite(msg.value)) return api.send(player.id, { k: 'error', reason: 'finish needs a numeric value' });
        if (s.cfg.team) {
          // One result for everybody, and only the copy that owns the shared world can say what it was.
          if (!isHost) return;
          // Kit 1.4.0: the host's copy owns every player's score, so it sends each one (values); before that everyone got
          // the host's own number (creator 2026-10-08: "Final scores seem to always be the same regardless").
          const won = msg.won === true ? true : msg.won === false ? false : null;
          const own = msg.values && typeof msg.values === 'object' && !Array.isArray(msg.values) ? msg.values : null;
          for (const [id, x] of Object.entries(s.racers)) if (x.racing) { const v = own && finite(own[id]) ? own[id] : msg.value; x.done = true; x.value = v; x.live = v; x.won = won; x.progress = 1; x.ms = api.now - s.startAt; }
          return finish(s, api);
        }
        r.done = true; r.value = msg.value; r.live = msg.value;
        r.won = msg.won === true ? true : msg.won === false ? false : null;
        // When lower is better, a lost run keeps the progress it had: it ranks with the unfinished (see ranking).
        if (!(s.cfg.direction === 'lower' && r.won === false)) r.progress = 1;
        r.ms = api.now - s.startAt;
        if (allDone(s, api)) return finish(s, api);
        return standings(s, api);
      }
      default: return api.send(player.id, { k: 'error', reason: 'unknown message' });
    }
  },

  onTick(s, dtMs, api) {
    if (s.phase === 'loading') { if (api.now >= s.startAt) begin(s, api); }      // a game that never says ready does not hold the others
    else if (s.phase === 'countdown' && api.now >= s.startAt) { s.phase = 'racing'; standings(s, api); }
    else if (s.phase === 'racing') {
      if (api.now - s.startAt > s.cfg.maxSeconds * 1000) return finish(s, api);
      standings(s, api);
    }
  },
};

const finite = v => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 1e12;
const fresh = racing => ({ racing, ready: false, progress: 0, live: null, done: false, value: null, won: null, ms: null });

// Live: every connected player's game has loaded.
function allReady(s, api) {
  const here = new Set(api.players.filter(p => p.connected).map(p => p.id));
  const racing = Object.entries(s.racers).filter(([id, r]) => r.racing && here.has(id));
  return racing.length > 0 && racing.every(([, r]) => r.ready);
}
function begin(s, api) {
  s.phase = 'countdown'; s.startAt = api.now + COUNTDOWN_MS;
  api.broadcast({ k: 'begin', startsInMs: COUNTDOWN_MS });
  standings(s, api);
}

// The host is the first connected human (the host-join kit seats the hosting player first).
function elect(s, api) {
  const here = api.players.filter(p => p.connected);
  const cur = here.find(p => p.id === s.hostId);
  if (!cur || (cur.bot && here.some(p => !p.bot))) s.hostId = (here.find(p => !p.bot) ?? here[0])?.id ?? null;
}

// The round is over when every racer still connected has a result (a racer who left can't hold the others up).
function allDone(s, api) {
  const here = new Set(api.players.filter(p => p.connected).map(p => p.id));
  const racing = Object.entries(s.racers).filter(([id, r]) => r.racing && here.has(id));
  return racing.length > 0 && racing.every(([, r]) => r.done);
}

// Finished runs first: a run the game called won before one it did not (kit 1.2.3: in a last-one-standing versus the
// winner can have fewer points than a player who went out), then best value, earlier finish breaking ties. When lower
// is better (a time, strokes), a run the game called lost never beats a finished one: it ranks with the unfinished,
// by how far it got.
function ranking(s) {
  const lower = s.cfg.direction === 'lower';
  const counts = r => r.done && !(lower && r.won === false);
  const racing = Object.entries(s.racers).filter(([, r]) => r.racing).map(([id, r]) => ({ id, ...r }));
  const done = racing.filter(counts).sort((a, b) => (b.won === true) - (a.won === true) || (lower ? a.value - b.value : b.value - a.value) || a.ms - b.ms);
  const rest = racing.filter(r => !counts(r)).sort((a, b) => b.progress - a.progress || (lower ? (a.live ?? Infinity) - (b.live ?? Infinity) : (b.live ?? -Infinity) - (a.live ?? -Infinity)));
  return [...done, ...rest.map(r => ({ ...r, dnf: true }))];
}

function finish(s, api) {
  s.phase = 'results';
  const rank = ranking(s);
  standings(s, api);
  api.end({ round: s.round, seed: s.seed, cfg: s.cfg, ...(s.cfg.team ? { team: true, won: rank[0]?.won ?? null } : {}), ranking: rank.map(r => r.id),
    results: rank.map(r => ({ id: r.id, value: r.value, won: r.won, ms: r.ms, dnf: !!r.dnf })) });
}

function standings(s, api) {
  const watching = Object.entries(s.racers).filter(([, r]) => !r.racing).map(([id, r]) => ({ id, ...r, watching: true }));
  api.broadcast({ k: 'standings', phase: s.phase, round: s.round, hostId: s.hostId, cfg: s.cfg,
    elapsedMs: s.phase === 'racing' ? api.now - s.startAt : 0, startsInMs: s.phase === 'countdown' ? Math.max(0, s.startAt - api.now) : 0,
    racers: ranking(s).concat(watching).map(r => ({ id: r.id, ready: !!r.ready, progress: Math.round(r.progress * 1000) / 1000, live: r.live, done: r.done,
      value: r.value, won: r.won, ms: r.ms, dnf: !!r.dnf && s.phase === 'results', watching: !!r.watching })) });
}
