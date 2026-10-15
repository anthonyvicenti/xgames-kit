// The play feed (builder/play/JUDGE.md; the gameplay layer, 2026-10-14): what playing this copy was like, as numbers a
// judge holds to the game's play target. The creator, on the look test: "The biggest thing these all miss is the actual
// gameplay itself ... We were supposed to collect berries, but there were no berries anywhere." The gates checked that
// controls work and a round ends; nothing counted whether the objective could be reached or whether anything happened.
//
//   const feed = createPlay(ctx, { log, list, modules, rows });   // boot: after the event log (kit/core/events.js)
//   ctx.events.count(player, name, { at, target })               // rules: a gameplay event of the game's own (the play
//                                                                 // target's events[].name), read as rules.<name>
//   window.__game.play()                                         // → gf-play/1 (below)
//
// Every runtime fills it the same way: it reads the kit's event log (every mechanic's manifest events, scores, presses,
// a game's own counted events), the players (where they are, their scores) and the round (phase, winners, rows), and
// asks each mechanic for its objectives. Nothing here is sent to other copies or changes play.
//
// gf-play/1: { schema, runtime, profile, phase, round, now, players [{id, name, bot, local}],
//   objectives [{id, part, kind, x, y, z, open, reach true|false|null, by 'world'|'ground'|'none', why?, closest, taken}],
//   rounds [{ n, t0 (game s), players, bots, seconds, done, outcome {winners, reason, scores, margin} | null,
//     events {total, meaningful, perMinute, byType, byName, first, longestGap},
//     interactions {total, perMinute, pairs {'a>b': n}},
//     idle {byPlayer {id: s still and doing nothing}, share {id: 0–1}, longest {id: s}},
//     quiet {longest {id: s with nothing meaningful done by or to them}},
//     leads {changes, leader}, objectives {present, reachable, unreachable, unknown, approached, taken},
//     timeline [[t, type, name, actor, target]] }] }
//
// The pure part (createTracker, typeOf, …) has no DOM and no three.js: builder/play/judge.mjs imports this same file
// to read a recording of a runtime that has no feed yet.
export const PLAY_SCHEMA = 'gf-play/1';
/** Meaningful kinds of event (a judge counts these) and attempts (a shot fired, a swing: something tried, not done). */
export const MEANINGFUL = ['score', 'hit', 'knockout', 'pickup', 'goal', 'death', 'combo', 'move', 'tag', 'blast'];
export const TYPES = [...MEANINGFUL, 'attempt'];
/** The kit's mechanic events by name (a manifest event may say its own `play` type, which wins). null: not counted. */
export const EVENT_TYPES = {
  onCollect: 'pickup', onGrab: 'pickup', onHit: 'hit', onDamage: 'hit', onPlayerHit: 'hit', onTargetHit: 'hit',
  onDown: 'knockout', onKill: 'knockout', onTargetDown: 'death', onLose: 'death', onTag: 'tag', onCarve: 'blast',
  onLap: 'goal', onCheckpoint: 'goal', onFinish: 'goal', onComplete: 'goal', onClear: 'goal', onWin: 'goal', onLevel: 'goal',
  onMove: 'move', onSwing: 'attempt', onThrow: 'attempt', onFire: 'attempt',
  onHurt: null, onSpawn: null, onRespawn: null, onPhase: null, onStart: null, onEnd: null, onRefuse: null, onBlocked: null,
  onSurface: null, onCancel: null, onTurn: null, onDrop: null,
};
// a name no table knows (a game's own event, a forge or vista core event): its words say
const WORDS = [
  [/combo|streak|chain/i, 'combo'], [/collect|pick|grab|loot|coin|gem|berr|fruit|take|caught|catch|fish|land/i, 'pickup'],
  [/kill|knock|down|ko$|elimin|bowl|ragdoll|launch/i, 'knockout'], [/death|die|dead|drown|fell|fall|splash|lost|lose/i, 'death'],
  [/blast|crater|carve|explo|boom/i, 'blast'], [/hit|damage|hurt|struck|shot/i, 'hit'], [/tag/i, 'tag'], [/move|place|drop|played/i, 'move'],
  [/fire|throw|swing|lob|shoot|cast|attempt/i, 'attempt'],
  [/lap|finish|checkpoint|goal|complete|clear|win|level|capture|deliver|score|point|sell|claim/i, 'goal'],
];
/** The play type of a word (a game's own event name), or null. */
export function typeOfWord(name) { for (const [re, t] of WORDS) if (re.test(String(name ?? ''))) return t; return null; }

/** The play type of one event-log entry (kit/core/events.js), or null when it is not a gameplay event. */
export function typeOf(e, { names = {} } = {}) {
  if (!e) return null;
  if (e.k === 'score') return Number(e.to) !== Number(e.from) ? 'score' : null;
  if (e.k === 'counter') return null;
  if (e.k !== 'event') return null;
  if (typeof e.play === 'string') return TYPES.includes(e.play) ? e.play : null;
  const key = `${e.part}.${e.name}`;
  if (key in names) return names[key];
  if (e.part === 'rules') return typeOfWord(e.name) ?? 'goal';      // a counted event of the game's own counts
  if (e.name in EVENT_TYPES) return EVENT_TYPES[e.name];
  return typeOfWord(e.name);
}

/** Who did it and to whom, from an entry's `who` ({from, target}, {shooter, target}, {from, player}, {by, player}, {player}, {winners: […]}). */
export function actorsOf(e) {
  const w = e?.who ?? {}, one = v => (Array.isArray(v) ? v[0] ?? null : v ?? null);
  // a doer named apart (from, shooter, attacker, by, tagger) makes the event's `player` the one it was done to: a fling
  // {from, player}, a fall {by, player}
  const doer = one(w.from ?? w.shooter ?? w.attacker ?? w.by ?? w.tagger ?? null);
  const actor = doer ?? one(w.player ?? w.winner ?? null);
  let target = one(w.target ?? w.victim ?? w.it ?? w.tagged ?? (doer ? w.player : null) ?? null);
  if (target === actor) target = null;
  return { actor, target };
}

const r1 = v => Math.round(v * 10) / 10, r2 = v => Math.round(v * 100) / 100;
const MAX_TIMELINE = 600, MAX_ROUNDS = 16;
export const PLAY_LIMITS = {
  SAMPLE_S: 0.25,       // players and objectives sampled four times a second (game time)
  STILL_M: 0.6,         // a player who moved less than this over STILL_S stands still…
  STILL_S: 1.0,
  BUSY_S: 2.0,          // …and is idle unless an event named them, or they pressed something, this recently
  DEDUPE_S: 0.2,        // one hit reported by two parts (the projectile's hit and the health's damage) counts once
  COMBO_N: 3, COMBO_S: 4,   // three meaningful things by one player within 4 s is a combo
  NEAR_M: 1.5,          // a player within an objective's reach plus this has approached it
  JUMP_M: 1.6,          // a spot higher than this above the ground under it is out of reach without something to stand on
  BURIED_M: 0.6,        // a spot more than this under the ground's surface is inside the ground
};

/**
 * The tracker: rounds, events, players and objectives in, the gf-play/1 feed out. Pure (time comes in with each call).
 * names: {"part.event": type} from the manifests; meaningfulOf(name) → true/false/undefined for a game's own event.
 */
export function createTracker({ names = {}, meaningfulOf = () => undefined, limits = PLAY_LIMITS } = {}) {
  const L = limits;
  const rounds = [];
  let cur = null;
  const objectives = new Map();      // id → the latest {id, part, kind, x, y, z, open, reach, by, why}
  const newRound = (n, t, players) => ({
    n, t0: t, t1: null, done: false, players: players.length, bots: players.filter(p => p.bot).length, ids: players.map(p => p.id),
    events: [], last: new Map(), byType: {}, byName: {}, first: null, lastAt: t, longestGap: 0,
    pairs: {}, interactions: 0, pos: new Map(), still: {}, longestStill: {}, stillRun: {}, busyAt: {}, quietFrom: {}, quiet: {},
    scores: {}, leader: null, leadChanges: 0, recent: new Map(), combos: 0, lastSample: undefined,
    seen: new Map(),                 // objective id → {open, taken, closest, approached}
    outcome: null,
  });
  const touch = (R, id, t) => { if (!id) return; R.busyAt[id] = t; const q = t - (R.quietFrom[id] ?? R.t0); if (q > (R.quiet[id] ?? 0)) R.quiet[id] = q; R.quietFrom[id] = t; };
  const api = {
    /** The round began (its playing phase) at game time t. */
    start(n, t, players = []) {
      if (cur && !cur.done) api.end(t, null);
      cur = newRound(n, t, players);
      for (const p of players) { cur.quietFrom[p.id] = t; cur.scores[p.id] = Number(p.score) || 0; }
      rounds.push(cur); if (rounds.length > MAX_ROUNDS) rounds.shift();
    },
    /** The round left its playing phase at t; outcome {winners, reason, rows} or null (left early). */
    end(t, outcome) {
      if (!cur || cur.done) return;
      cur.t1 = t; cur.done = !!outcome;
      const gap = t - cur.lastAt; if (gap > cur.longestGap) cur.longestGap = gap;
      for (const id of cur.ids) touch(cur, id, t);
      if (outcome) {
        const scores = {};
        for (const r of outcome.rows ?? []) if (r && r.id != null) scores[r.id] = Number(r.value ?? r.score ?? 0) || 0;
        for (const [id, s] of Object.entries(cur.scores)) if (!(id in scores)) scores[id] = s;
        const v = Object.values(scores).sort((a, b) => b - a);
        cur.outcome = { winners: outcome.winners ?? [], reason: outcome.reason ?? null, scores, margin: v.length > 1 ? r2(v[0] - v[1]) : v[0] ?? 0 };
      }
      cur = null;
    },
    /** Entries of the kit's event log (only those logged while a round played count). */
    ingest(entries = []) {
      if (!cur) return;
      for (const e of entries) {
        if (e.ph && e.ph !== 'playing') continue;
        if (Number.isFinite(e.t) && e.t < cur.t0 - 1e-6) continue;
        const type = typeOf(e, { names });
        if (!type) continue;
        // a game's own event the play target marks as not meaningful
        if (e.k === 'event' && e.part === 'rules' && meaningfulOf(e.name) === false) continue;
        const { actor, target } = actorsOf(e);
        const t = Number.isFinite(e.t) ? e.t : cur.lastAt;
        api.note(t, type, e.k === 'score' ? 'score' : `${e.part}.${e.name}`, actor, target);
      }
    },
    /** One gameplay event: t (game s), its type, name, who did it and to whom. */
    note(t, type, name, actor = null, target = null) {
      const R = cur; if (!R || !TYPES.includes(type)) return;
      const key = `${type}|${actor ?? ''}|${target ?? ''}`, was = R.last.get(key);
      if (type !== 'score' && was !== undefined && t - was < L.DEDUPE_S) return;
      R.last.set(key, t);
      const meaningful = MEANINGFUL.includes(type);
      R.byName[name] = (R.byName[name] ?? 0) + 1;
      if (R.events.length < MAX_TIMELINE) R.events.push([r2(t - R.t0), type, name, actor, target]);
      R.byType[type] = (R.byType[type] ?? 0) + 1;
      if (!meaningful) { if (actor) R.busyAt[actor] = t; return; }
      if (R.first === null && type !== 'score') R.first = r2(t - R.t0);
      const gap = t - R.lastAt; if (gap > R.longestGap) R.longestGap = gap;
      R.lastAt = t;
      touch(R, actor, t); touch(R, target, t);
      if (actor && target && actor !== target) { R.interactions++; const k = `${actor}>${target}`; R.pairs[k] = (R.pairs[k] ?? 0) + 1; }
      if (actor && type !== 'score' && type !== 'combo') {
        const list = (R.recent.get(actor) ?? []).filter(x => t - x <= L.COMBO_S); list.push(t);
        if (list.length >= L.COMBO_N) { R.recent.set(actor, []); R.combos++; api.note(t, 'combo', 'play.combo', actor, null); }
        else R.recent.set(actor, list);
      }
    },
    /** A sample at t: players [{id, x, z, score, pressed}] and objectives [{id, part, kind, x, y, z, open, reach, by, why, near}]. */
    sample(t, players = [], objs = null) {
      const R = cur;
      if (objs) for (const o of objs) objectives.set(o.id, { ...objectives.get(o.id), ...o });
      if (!R) return;
      for (const p of players) {
        if (p.pressed) R.busyAt[p.id] = t;
        const hist = R.pos.get(p.id) ?? []; hist.push([t, p.x, p.z]);
        while (hist.length > 2 && t - hist[0][0] > L.STILL_S) hist.shift();
        R.pos.set(p.id, hist);
        const moved = hist.length > 1 ? Math.hypot(p.x - hist[0][1], p.z - hist[0][2]) : Infinity;
        const busy = t - (R.busyAt[p.id] ?? -Infinity) <= L.BUSY_S;
        const dt = R.lastSample === undefined ? 0 : Math.max(0, Math.min(1, t - R.lastSample));
        if (moved < L.STILL_M && !busy && hist.length > 1) {
          R.still[p.id] = (R.still[p.id] ?? 0) + dt; R.stillRun[p.id] = (R.stillRun[p.id] ?? 0) + dt;
          if (R.stillRun[p.id] > (R.longestStill[p.id] ?? 0)) R.longestStill[p.id] = R.stillRun[p.id];
        } else R.stillRun[p.id] = 0;
        // the lead: one player alone on the top score, above zero
        const s = Number(p.score) || 0; R.scores[p.id] = s;
        if (!R.ids.includes(p.id)) R.ids.push(p.id);
      }
      R.lastSample = t;
      const top = Object.entries(R.scores).sort((a, b) => b[1] - a[1]);
      const leader = top.length && top[0][1] > 0 && (top.length === 1 || top[0][1] > top[1][1]) ? top[0][0] : null;
      if (leader && R.leader && leader !== R.leader) R.leadChanges++;
      if (leader) R.leader = leader;
      // objectives: who came near, which were taken (open → closed while the round played; a part that lists only what
      // is there now, as interactables() does, drops a spot when it is taken)
      if (objs) for (const [id, s] of R.seen) if (s.open && !objs.some(o => o.id === id)) { s.taken++; s.open = false; }
      for (const o of objs ?? []) {
        const s = R.seen.get(o.id) ?? { open: o.open, taken: 0, closest: Infinity, approached: false };
        if (s.open && o.open === false) s.taken++;
        s.open = o.open;
        if (Number.isFinite(o.x)) for (const p of players) {
          const d = Math.hypot(p.x - o.x, p.z - o.z);
          if (d < s.closest) s.closest = d;
          if (d <= (o.near ?? 1) + L.NEAR_M) s.approached = true;
        }
        R.seen.set(o.id, s);
      }
    },
    /** The feed (gf-play/1, less what the page adds: runtime, phase, players). */
    read(now = null) {
      const out = [];
      for (const R of rounds) {
        const end = R.t1 ?? now ?? R.lastSample ?? R.t0, seconds = Math.max(0, end - R.t0), mins = seconds / 60;
        // meaningful events: what players did (a score is the result of one, a combo a run of them: neither adds)
        const meaningful = MEANINGFUL.reduce((a, k) => a + (R.byType[k] ?? 0), 0) - (R.byType.score ?? 0) - (R.byType.combo ?? 0);
        const gapNow = R.t1 === null && now !== null ? now - R.lastAt : 0;
        const quiet = {};
        for (const id of R.ids) quiet[id] = r1(Math.max(R.quiet[id] ?? 0, R.t1 === null && now !== null ? now - (R.quietFrom[id] ?? R.t0) : 0));
        const seen = [...R.seen.entries()];
        const objs = seen.map(([id]) => objectives.get(id)).filter(Boolean);
        out.push({
          n: R.n, t0: r2(R.t0), players: R.players, bots: R.bots, seconds: r1(seconds), done: R.done, outcome: R.outcome,
          events: { total: R.events.length, meaningful, perMinute: mins > 0 ? r2(meaningful / mins) : 0, byType: { ...R.byType }, byName: { ...R.byName }, first: R.first, longestGap: r1(Math.max(R.longestGap, gapNow)) },
          interactions: { total: R.interactions, perMinute: mins > 0 ? r2(R.interactions / mins) : 0, pairs: { ...R.pairs } },
          idle: { byPlayer: Object.fromEntries(R.ids.map(id => [id, r1(R.still[id] ?? 0)])), share: Object.fromEntries(R.ids.map(id => [id, seconds > 0 ? r2((R.still[id] ?? 0) / seconds) : 0])), longest: Object.fromEntries(R.ids.map(id => [id, r1(R.longestStill[id] ?? 0)])) },
          quiet: { longest: quiet },
          leads: { changes: R.leadChanges, leader: R.leader },
          objectives: {
            present: seen.length, reachable: objs.filter(o => o.reach === true).length, unreachable: objs.filter(o => o.reach === false).length,
            unknown: objs.filter(o => o.reach !== true && o.reach !== false).length,
            approached: seen.filter(([, s]) => s.approached).length, taken: seen.reduce((a, [, s]) => a + s.taken, 0),
            takenSpots: seen.filter(([, s]) => s.taken > 0).length,
          },
          combos: R.combos,
          timeline: R.events,
        });
      }
      const last = rounds.at(-1);
      return {
        objectives: [...objectives.values()].map(o => {
          const s = last?.seen.get(o.id);
          return { id: o.id, part: o.part, kind: o.kind, x: r2(o.x), y: r2(o.y ?? 0), z: r2(o.z), open: s ? s.open !== false : o.open !== false, reach: o.reach ?? null, by: o.by ?? 'none', ...(o.why ? { why: o.why } : {}), closest: s && Number.isFinite(s.closest) ? r1(s.closest) : null, taken: s?.taken ?? 0 };
        }),
        rounds: out,
      };
    },
  };
  return api;
}

/**
 * Can a player get to an objective? The world's own answer when it has one (`world.reach(from, to)`: the reach part),
 * else outside the world's bounds, else the ground under it: a spot is out of reach when there is no ground under it, the ground there is under the
 * sea, the spot is inside the ground, or it floats above a jump. → {reach: true|false|null, by, why?}
 */
export function reachOf(world, spot, { seats = [], limits = PLAY_LIMITS } = {}) {
  if (!world || !spot || !Number.isFinite(spot.x)) return { reach: null, by: 'none' };
  // the world's walk grid (worlds/placement.js): the same answer as the reach leg's window.__game.objectives(), held to
  // every seat (or, where the seats' ground is split, to the seats that can get there)
  if (typeof world.walk?.audit === 'function') {
    try {
      const [a] = world.walk.audit([{ id: String(spot.id ?? 'spot'), kind: spot.kind ?? 'spot', x: spot.x, y: Number.isFinite(spot.y) ? spot.y : 0, z: spot.z, radius: spot.near ?? 1 }]);
      if (a) return a.ok ? { reach: true, by: 'world' } : { reach: false, by: 'world', why: a.why ?? 'no seat can get to it' };
    } catch {}
  }
  if (typeof world.reach === 'function') {
    for (const s of seats.length ? seats : [null]) {
      try {
        const r = world.reach(s, spot);
        const ok = typeof r === 'object' && r !== null ? r.ok ?? r.reach : r;
        if (ok === true) return { reach: true, by: 'world' };
        if (ok === false) return { reach: false, by: 'world', why: (typeof r === 'object' && r?.why) || 'the world says no seat reaches it' };
      } catch {}
    }
  }
  // outside the world's play area (its bounds: the walls of a yard, the edge of a field)
  const b = world.bounds;
  if (b?.min && b?.max && Number.isFinite(b.min.x) && (spot.x < b.min.x - 0.5 || spot.x > b.max.x + 0.5 || spot.z < b.min.z - 0.5 || spot.z > b.max.z + 0.5)) return { reach: false, by: 'ground', why: 'outside the play area (past its edge or walls)' };
  const ground = groundUnder(world, spot);
  if (!ground) return { reach: null, by: 'none' };
  const sea = Number.isFinite(world.seaLevel) ? world.seaLevel : null;
  const y = Number.isFinite(spot.y) ? spot.y : 0;
  if (ground.y === null) return { reach: false, by: 'ground', why: sea !== null ? 'no ground under it: it is out at sea' : 'no ground under it' };
  if (sea !== null && ground.y < sea - 0.05) return { reach: false, by: 'ground', why: `in the sea (the sea floor under it is ${r1(sea - ground.y)} m below the water)` };
  if (y < ground.y - limits.BURIED_M) return { reach: false, by: 'ground', why: `inside the ground (${r1(ground.y - y)} m under its surface)` };
  if (y > ground.y + limits.JUMP_M) return { reach: false, by: 'ground', why: `${r1(y - ground.y)} m above the ground, out of a jump's reach` };
  return { reach: true, by: 'ground' };
}

/** The ground's height under a point: the world's own height field, else a ray down. → {y} ({y: null}: nothing) | null */
export function groundUnder(world, p) {
  const field = world.terrain?.heightAt ?? world.heightAt ?? null;
  if (typeof field === 'function') { try { const h = field(p.x, p.z); return { y: Number.isFinite(h) ? h : null }; } catch {} }
  const top = world.voxel?.grid?.top ?? world.topAt;
  if (typeof top === 'function') { try { const h = top(Math.floor(p.x), Math.floor(p.z)); return { y: Number.isFinite(h) ? h + 1 : null }; } catch {} }
  if (typeof world.raycast === 'function' && world.down) {
    // a ray from a little above the spot: the floor under it (never a roof far above it)
    try { const h = world.raycast(world.down.from(p.x, (Number.isFinite(p.y) ? p.y : 0) + 1.8, p.z), world.down.dir, 60); return { y: h ? h.point.y : null }; } catch {}
  }
  return null;
}

/** The objectives the mechanics offer now: a mechanic's `objectives()`, else what it lets a player interact with. */
export function objectivesOf(list = []) {
  const out = [];
  for (const m of list) {
    if (!m || m.standin) continue;
    let rows = null;
    try { rows = typeof m.objectives === 'function' ? m.objectives() : typeof m.interactables === 'function' ? m.interactables() : null; } catch { rows = null; }
    for (const o of rows ?? []) {
      if (!o || !Number.isFinite(o.x) || !Number.isFinite(o.z)) continue;
      out.push({ id: String(o.id ?? `${m.id}:${out.length}`), part: m.id, kind: o.kind ?? m.id, x: o.x, y: Number.isFinite(o.y) ? o.y : 0, z: o.z, open: o.open ?? o.present ?? true, near: Math.max(Number(o.touch) || 0, Number(o.reach) || 0, Number(o.radius) || 0, 1) });
    }
  }
  return out;
}

/**
 * The page's feed: wires the tracker to this copy (the event log, the players, the round, the mechanics, the world).
 * rows: () → the round's results rows (session.round.rows). Returns {read}.
 */
export function createPlay(ctx, { log = null, list = [], modules = new Map(), rows = () => null, seats = null, down = null } = {}) {
  // a manifest event may say its own play type: {name: 'onCollect', play: 'pickup'}
  const names = {};
  // (a quiet event with no type is not counted: a body that settled, a refused hit)
  for (const m of list) for (const ev of modules.get?.(m.id)?.manifest?.events ?? []) {
    if (ev && typeof ev.play === 'string') names[`${m.id}.${ev.name}`] = ev.play;
    else if (ev?.quiet) names[`${m.id}.${ev.name}`] = null;
  }
  // the play target's events (config/game.json → play.events, when create copies them): which of the game's own count
  const targetEvents = new Map((ctx.config?.play?.events ?? []).map(e => [e.name, e]));
  const tracker = createTracker({ names, meaningfulOf: name => targetEvents.get(name)?.meaningful });
  const world = () => ctx.world ?? null;
  const seatsOf = () => { try { return seats ? seats() : (world()?.spawns ?? []).map(s => ({ x: s.x, y: s.y, z: s.z })); } catch { return []; } };
  const reachCache = new Map();
  const reachFor = o => {
    const k = `${o.id}@${Math.round(o.x * 4)},${Math.round((o.y ?? 0) * 4)},${Math.round(o.z * 4)}`;
    if (!reachCache.has(k)) { const w = world(); reachCache.set(k, reachOf(w ? { ...w, raycast: w.raycast?.bind(w), down } : null, o, { seats: seatsOf() })); if (reachCache.size > 400) reachCache.delete(reachCache.keys().next().value); }
    return reachCache.get(k);
  };
  let since = 0, acc = 0, phase = null, number = null;
  const pressedSince = new Set();
  const people = () => (ctx.players?.list?.() ?? []).map(p => ({ id: p.id, name: p.name, bot: !!p.isBot, local: !!p.local, x: p.position?.x ?? 0, z: p.position?.z ?? 0, score: p.score }));
  const pull = () => {
    if (!log) return;
    const r = log.read({ since }); since = r.next;
    for (const e of r.entries) if (e.k === 'input' && e.who?.player) pressedSince.add(e.who.player);
    tracker.ingest(r.entries);
  };
  ctx.onFrame?.push(dt => {
    const now = ctx.time?.now ?? 0, ph = ctx.round?.phase ?? null, n = ctx.round?.number ?? null;
    if (ph !== phase || n !== number) {
      pull();
      if (phase === 'playing' && ph !== 'playing') tracker.end(now, ph === 'results' ? { winners: ctx.round?.winners ?? [], reason: ctx.round?.reason ?? null, rows: rows() ?? [] } : null);
      if (ph === 'playing' && (phase !== 'playing' || n !== number)) tracker.start(n ?? 0, now, people());
      phase = ph; number = n;
    }
    acc += dt;
    if (acc < PLAY_LIMITS.SAMPLE_S) return;
    acc = 0;
    pull();
    const ps = people().map(p => ({ ...p, pressed: pressedSince.has(p.id) }));
    pressedSince.clear();
    const objs = objectivesOf(list).map(o => ({ ...o, ...reachFor(o) }));
    tracker.sample(now, ps, objs);
  });
  return {
    read() {
      pull();
      const f = tracker.read(ctx.time?.now ?? null);
      return { schema: PLAY_SCHEMA, runtime: ctx.kit?.runtime ?? null, profile: ctx.kit?.profile ?? null, phase: ctx.round?.phase ?? null, round: ctx.round?.number ?? null, now: r2(ctx.time?.now ?? 0),
        players: people().map(({ id, name, bot, local }) => ({ id, name, bot, local })), ...f };
    },
  };
}
