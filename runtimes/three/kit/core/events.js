// The kit's event log (CONTRACT §5; verify gates C and D, research/gf-three/GATES.md): what happened in this copy, as
// the kit itself counts it. Read-only for the game; verify reads it through window.__game.events().
//
//   const log = createEventLog(ctx, { list, modules });   // boot: after the mechanics exist, before rules.setup
//   ctx.events.count(player, what, { at })                // rules: a counted event of the game's own (its own scoring)
//   window.__game.events({ since })                       // { entries, next, dropped, kinds, me }
//
// What it logs, each entry {i, t (the game's seconds), w (performance.now()), ph (the round's phase), k, …}:
//   event    every event a mechanic's manifest lists (kit/mechanics/<id>/index.js manifest.events: waves onKill, pickup
//            onCollect, projectile onHit, …), subscribed through the mechanic's own on<Event>(fn); `who` names the players
//            the event's arguments name ({from: 'p1', target: 'p2'}), `at` where it happened when they say. A game's own
//            counted event (ctx.events.count) is one too, part "rules".
//   counter  a number a mechanic keeps per player that a score may follow (its manifest.counters: paint's share, tag's
//            whole seconds as it), sampled ten times a second, logged when it moves
//   score    a player's score moved (sampled every frame): from, to
//   input    the local player pressed an action (primary, secondary, interact, jump): an edge, not a hold
//   sound    ctx.audio.play: the id, where, whether the kit started it (ok), and db: the level its voice puts out (the loudest
//            sample of its buffer with the sound's gain and its bus's, before the master volume; -999 for a silent file)
// Gate D holds every score change to a counted event or counter of that player (tools/lib/score-events.mjs); gate C
// looks for each event's answer on the player's own screen (tools/lib/events-check.mjs). The log keeps the last MAX
// entries (and counts every kind); nothing in it is sent to other copies or saved.
const MAX = 8000;
const ACTIONS = ['primary', 'secondary', 'interact', 'jump'];
const r2 = v => Math.round(v * 100) / 100;

/** Is this a player object (kit/net/players.js)? */
const isPlayer = v => !!v && typeof v === 'object' && typeof v.id === 'string' && 'score' in v && !!v.position;
/** A point an event's argument holds: {x, y, z} or null. */
function pointOf(a) {
  for (const c of [a?.point, a?.at, a?.enemy, a?.target?.position, a?.target, a?.player?.position, a?.from?.position, a?.shooter?.position, a?.attacker?.position]) {
    if (c && Number.isFinite(c.x) && Number.isFinite(c.z)) return { x: r2(c.x), y: r2(Number.isFinite(c.y) ? c.y : 0), z: r2(c.z) };
  }
  return null;
}

export function createEventLog(ctx, { list = [], modules = new Map(), now = () => performance.now() } = {}) {
  const entries = [], kinds = {};
  let seq = 0, dropped = 0;
  const ids = () => new Set(ctx.players?.list?.().map(p => p.id) ?? []);
  /** The players an event's arguments name, by field: {from: 'p1', target: 'p2', winners: ['p1']}. */
  const whoOf = a => {
    const who = {};
    if (!a || typeof a !== 'object') return who;
    let known = null;
    for (const [k, v] of Object.entries(a)) {
      if (isPlayer(v)) who[k] = v.id;
      else if (Array.isArray(v) && v.length && v.every(x => isPlayer(x) || typeof x === 'string')) {
        known ??= ids();
        const got = v.map(x => (isPlayer(x) ? x.id : x)).filter(x => known.has(x));
        if (got.length) who[k] = got;
      }
    }
    return who;
  };
  const push = e => {
    e.i = seq++; e.t = r2(ctx.time?.now ?? 0); e.w = Math.round(now()); e.ph = ctx.round?.phase ?? null;
    const kind = e.k === 'event' || e.k === 'counter' ? `${e.part}.${e.name}` : e.k === 'sound' ? `sound.${e.id}` : e.k === 'input' ? `input.${e.action}` : e.k;
    kinds[kind] = (kinds[kind] ?? 0) + 1;
    if (entries.length >= MAX) { entries.shift(); dropped++; }
    entries.push(e);
  };

  // ---- every mechanic's events, as its manifest lists them ----
  for (const m of list) {
    if (m.standin) continue;
    const man = modules.get?.(m.id)?.manifest;
    for (const ev of man?.events ?? []) {
      const on = m[ev.name];
      if (typeof on !== 'function') continue;
      try { on.call(m, a => { try { push({ k: 'event', part: m.id, name: ev.name, who: whoOf(a), at: pointOf(a) }); } catch {} }); } catch {}
    }
  }

  // ---- the sounds the kit plays, each with the level its voice puts out: the loudest sample of its buffer and the
  // sound's own gain and its bus's, in dB before the master volume; -Infinity for a silent file ----
  const peaks = new WeakMap();
  const peakOf = buf => {
    if (!buf || typeof buf.getChannelData !== 'function') return null;
    if (peaks.has(buf)) return peaks.get(buf);
    let p = 0;
    for (let c = 0; c < buf.numberOfChannels; c++) { const d = buf.getChannelData(c); for (let i = 0; i < d.length; i += 2) { const v = d[i] < 0 ? -d[i] : d[i]; if (v > p) p = v; } }
    peaks.set(buf, p);
    return p;
  };
  // (gf-audio's handle hides its voice: the buffer is the one its context hands out while play runs, and the gains are
  // its manifest's, the sound's own gainDb and its bus's)
  const raw = ctx.audio?.raw, actx = raw?.context;
  let capturing = false, captured = null;
  if (actx && typeof actx.createBufferSource === 'function') {
    const make = actx.createBufferSource.bind(actx);
    actx.createBufferSource = function () { const n = make(); if (capturing) captured = n; return n; };
  }
  const gainsOf = id => { try { const m = raw?.manifest, s = m?.sounds?.[id]; return s ? (Number(s.gainDb) || 0) + (Number(m.buses?.[s.bus ?? 'sfx']) || 0) : 0; } catch { return 0; } };
  if (ctx.audio && typeof ctx.audio.play === 'function') {
    const play = ctx.audio.play;
    ctx.audio.play = function (id, opts = {}) {
      capturing = true; captured = null;
      let h;
      try { h = play.call(this, id, opts); } finally { capturing = false; }
      try {
        const peak = peakOf(captured?.buffer);
        const db = peak === null ? null : peak > 0 ? Math.round((20 * Math.log10(peak) + gainsOf(id) + (Number(opts?.gainDb) || 0)) * 10) / 10 : -Infinity;
        push({ k: 'sound', id: String(id), at: opts?.at ? pointOf({ at: opts.at }) : null, ok: h !== null && h !== undefined, ...(db === null ? {} : { db: Number.isFinite(db) ? db : -999 }) });
      } catch {}
      return h;
    };
  }

  // ---- each frame: scores, the local player's presses, and ten times a second the mechanics' counters ----
  const scores = new Map(), counters = new Map();
  let tick = 0;
  const counterParts = list.filter(m => !m.standin && typeof modules.get?.(m.id)?.manifest?.counters === 'function').map(m => ({ m, fn: modules.get(m.id).manifest.counters }));
  ctx.onFrame?.push(dt => {
    const players = ctx.players?.list?.() ?? [];
    for (const p of players) {
      const s = Number(p.score) || 0, was = scores.get(p.id);
      if (was !== undefined && s !== was) push({ k: 'score', who: { player: p.id }, from: was, to: s, at: pointOf({ at: p.position }) });
      scores.set(p.id, s);
    }
    const me = ctx.me, acts = me?.actions;
    if (acts) for (const a of ACTIONS) if (acts[a]?.pressed) push({ k: 'input', action: a, who: { player: me.id }, at: pointOf({ at: me.position }) });
    tick += dt;
    if (tick >= 0.1) {
      tick = 0;
      for (const { m, fn } of counterParts) {
        let rows = null; try { rows = fn(m, ctx); } catch {}
        for (const [pid, v] of rows ?? []) {
          const key = `${m.id}:${pid}`, n = Number(v) || 0, was = counters.get(key);
          if (was !== undefined && Math.abs(n - was) > 1e-9) push({ k: 'counter', part: m.id, name: 'counter', who: { player: pid }, from: r2(was * 1000) / 1000, to: r2(n * 1000) / 1000 });
          counters.set(key, n);
        }
      }
    }
  });

  const api = {
    /** A counted event of the game's own (its own way to score: a lap of its own, a round won by its rules). */
    count(player, what = 'count', { at = null } = {}) {
      push({ k: 'event', part: 'rules', name: String(what).slice(0, 40), who: isPlayer(player) ? { player: player.id } : typeof player === 'string' ? { player } : {}, at: at ? pointOf({ at }) : player?.position ? pointOf({ at: player.position }) : null });
    },
    /** The log since entry `since` (the index the last read returned as `next`). */
    read({ since = 0 } = {}) {
      const first = entries.length ? entries[0].i : seq;
      return { entries: entries.filter(e => e.i >= since), next: seq, first, dropped, kinds: { ...kinds }, me: ctx.me?.id ?? null, max: MAX };
    },
  };
  return api;
}
