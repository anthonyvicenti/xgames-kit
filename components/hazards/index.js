// mechanic: hazards. The ways a body leaves the play for a moment: into the water, out past the world's edge, a fall
// hard enough to hurt. The host decides; every copy sees the splash; the body comes back after respawnSeconds on dry
// ground every seat can reach (the world's placement API). README.md has the network ownership and the API.
//
//   const hz = ctx.mechanics.get('hazards');
//   hz.onFall(e => { if (e.by && e.by !== e.player) e.by.score += 3; });   // host: {player, cause, by, at}
//   hz.onBack(e => ...)                                                    // every copy: {player, at}
//
// With the knockback mechanic, whoever last threw a player (kb.lastHitBy, within its creditSeconds) is `by` when they
// fall, and a thrown body's landings hurt through the same fall damage (kb.onLand speeds).
import { spawnOf } from '../../core/util.js';

export const id = 'hazards';
export const examples = ['fall in the sea and come back on your island', 'knocked off the edge of the world', 'a long drop hurts'];

const D = { water: true, waterDepth: 0.6, out: true, outMargin: 4, floor: null, respawnSeconds: 2.5, protectSeconds: 1.5, fallDamage: 0, fallSafe: 12, splashFx: '', splashSound: '', fallSound: '', backSound: '', toast: true, textWater: 'Splash! Back in a moment', textOut: 'Out! Back in a moment' };
const kebab = s => s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
const num = (description, minimum, maximum, d) => ({ type: 'number', description, minimum, maximum, default: d });
const str = (description, d) => ({ type: 'string', default: d, description });
export const params = {
  type: 'object', additionalProperties: true,
  properties: {
    water: { type: 'boolean', default: D.water, description: 'Falling into the water (the world\'s sea, or its waterAt) takes a player out for a moment' },
    waterDepth: num('How far under the water surface the feet go before it counts (m)', 0, 5, D.waterDepth),
    out: { type: 'boolean', default: D.out, description: 'Leaving the world (past its edge, or falling below its floor) takes a player out for a moment' },
    outMargin: num('Metres past the world\'s edge before it counts', 0, 50, D.outMargin),
    floor: { type: ['number', 'null'], default: D.floor, description: 'Height below which a body is out (null: 8 m under the lowest of the sea and the world)' },
    respawnSeconds: num('Seconds out before coming back', 0.2, 30, D.respawnSeconds),
    protectSeconds: num('Seconds of protection after coming back (fair play)', 0, 10, D.protectSeconds),
    fallDamage: num('Damage per m/s a landing is over fallSafe (0: falls never hurt); passed to the health mechanic', 0, 100, D.fallDamage),
    fallSafe: num('Fastest landing that does not hurt (m/s)', 2, 60, D.fallSafe),
    splashFx: str('A vfx preset where a player falls into the water (water-splash); unset: none', D.splashFx),
    splashSound: str('A sound id for a fall into the water; unset: none', D.splashSound),
    fallSound: str('A sound id when a player goes out (the edge, the floor); unset: none', D.fallSound),
    backSound: str('A sound id when a player comes back; unset: none', D.backSound),
    toast: { type: 'boolean', default: D.toast, description: 'Tell the player who fell, in a toast' },
    textWater: str('What the player who fell in the water reads', D.textWater),
    textOut: str('What the player who went out reads', D.textOut),
  },
};
const vs = (name, label, type, extra = {}) => ({ id: `mechanic.hazards.${kebab(name)}`, label, group: 'mechanics', type, source: { pointer: `{base}/${name}` }, tier: 'advanced', facet: 'gameplay', ...extra });
export const slots = [
  vs('respawnSeconds', 'Seconds out after a fall', 'number', { tier: 'main', rank: 56, constraints: { min: 0.2, max: 30, unit: 's' } }),
  vs('fallDamage', 'Fall damage per m/s', 'number', { tier: 'main', rank: 52, constraints: { min: 0, max: 100 } }),
  vs('fallSafe', 'Safe landing speed', 'number', { constraints: { min: 2, max: 60, unit: 'm/s' } }),
  vs('water', 'The water takes players out', 'boolean'),
  vs('out', 'The world\'s edge takes players out', 'boolean'),
  vs('textWater', 'Fell in the water text', 'text', { constraints: { maxLength: 60 } }),
  vs('textOut', 'Went out text', 'text', { constraints: { maxLength: 60 } }),
];

const unsub = (arr, fn) => () => { const i = arr.indexOf(fn); if (i >= 0) arr.splice(i, 1); };
const r2 = v => Math.round(v * 100) / 100;

export function create(ctx, params = {}) {
  const P = { ...D, ...params };
  const V = k => { const sid = `mechanic.hazards.${kebab(k)}`; try { return ctx.assets?.has(sid) ? ctx.assets.value(sid, P[k]) : P[k]; } catch { return P[k]; } };
  const L = { fall: [], back: [], hurt: [] };
  const out = new Map();            // every copy: player id → { cause, until (host), at, hold }
  const splashedAt = new Map();     // every copy: player id → time the knockback mechanic splashed them (no second splash)
  const arriving = new Map();       // host: player id → {at, until}: on the way back (a friend's pose shows it a moment later)
  const doomed = new Map();         // host: player id → until: thrown on a flight that ends in the water or out (out already)
  const stats = { water: 0, out: 0, back: 0, falls: 0, hurt: 0 };
  let vfx = null, linked = false, last = null;
  if (P.splashFx) import('../../vfx/index.js').then(m => { vfx = m.vfxOf(ctx); }).catch(e => console.warn(`gf-three hazards: splashFx needs the vfx module (${e.message})`));
  const now = () => ctx.time.now;

  const waterAt = (x, z) => { const w = ctx.world?.waterAt?.(x, z); return Number.isFinite(w) ? w : Number.isFinite(ctx.world?.seaLevel) ? ctx.world.seaLevel : null; };
  function edges() {
    const B = ctx.world?.bounds, m = V('outMargin');
    const box = B?.min && B?.max ? [B.min.x - m, B.min.z - m, B.max.x + m, B.max.z + m] : null;
    const floor = V('floor') ?? Math.min(Number.isFinite(ctx.world?.seaLevel) ? ctx.world.seaLevel : 0, B?.min?.y ?? 0) - 8;
    return { box, floor };
  }
  /** Where a player comes back: the world's placement API (dry ground every seat reaches, near their own seat) when it
   *  has one, else their seat, else the first seat still standing over dry ground. → {x, y, z, yaw} */
  function spotFor(p) {
    const W = ctx.world, seat = spawnOf(W, p.seat ?? 0);
    const others = ctx.players.list().filter(o => o !== p && o.alive !== false);
    const face = s => (others.length ? Math.atan2(others[0].position.x - s.x, others[0].position.z - s.z) : seat.yaw);
    if (typeof W?.reach === 'function' && W?.walk && typeof W.place === 'function') {
      try {
        const got = W.place('respawn', 1, { prefer: { x: seat.x, z: seat.z }, clear: 0.8, away: 0, near: { at: [seat.x, seat.z], r: 8 } })?.[0];   // the open ground nearest the seat
        if (got && Number.isFinite(got.x)) return { x: got.x, y: got.y, z: got.z, yaw: face(got) };
      } catch (e) { console.warn(`gf-three hazards: world.place: ${e.message}`); }
    }
    // no placement API: a seat whose ground is still there (a crater may have taken it), its height as it is now
    const n = Math.max(1, W?.spawns?.length ?? 1);
    for (let k = 0; k < n; k++) {
      const s = spawnOf(W, ((p.seat ?? 0) + k) % n), g = W?.groundAt?.(s.x, s.z), w = waterAt(s.x, s.z);
      if (g == null) return s;
      if (w === null || g > w + 0.3) return { x: s.x, y: g + 0.05, z: s.z, yaw: s.yaw };
    }
    return seat;
  }

  // ---------- every copy: a player is out, then back ----------
  function wentOut(p, cause, at, by) {
    const o = { cause, at, by: by ?? null, since: now() };
    out.set(p.id, o);
    p.hidden = true; p.alive = false;
    if (cause === 'water') {
      stats.water++;
      const recent = splashedAt.has(p.id) && now() - splashedAt.get(p.id) < 1.5;
      if (!recent) { if (vfx && V('splashFx')) vfx.fx(V('splashFx'), { at: { x: at.x, y: waterAt(at.x, at.z) ?? at.y, z: at.z }, scale: 1.3 }); if (V('splashSound')) ctx.audio?.play(V('splashSound'), { at, optional: true }); }
    } else { stats.out++; if (V('fallSound')) ctx.audio?.play(V('fallSound'), { at, optional: true }); }
    // the owner holds the body where it went in, under the surface, until it comes back (it does not sink for ever)
    if (p.owned && p.controller?.carry) { const hold = { x: at.x, y: at.y - 0.6, z: at.z, vx: 0, vy: 0, vz: 0, done: false }; p.controller.carry(() => hold, V('respawnSeconds') + 1); }
    if (p.local && V('toast')) ctx.ui?.toast?.(cause === 'water' ? V('textWater') : V('textOut'));
    ctx.juice?.shake?.(cause === 'water' ? 0.1 : 0.15, { at, reach: 20 });
    if (p.character?.object3d) p.character.object3d.visible = false;
  }
  function cameBack(p, at, yaw) {
    out.delete(p.id);
    p.hidden = false; p.alive = true;
    if (p.owned) { p.controller?.carry?.(null); p.controller?.teleport?.(at, yaw ?? p.yaw); }
    if (p.character?.object3d) { p.character.recover?.(); p.character.object3d.visible = true; }
    stats.back++;
    if (V('backSound') && p.local) ctx.audio?.play(V('backSound'), { optional: true });
    for (const fn of L.back.slice()) try { fn({ player: p, at }); } catch (e) { console.error(e); }
  }

  // ---------- the host ----------
  function hostFall(p, cause) {
    if (!ctx.host || out.has(p.id)) return;
    const at = { x: r2(p.position.x), y: r2(p.position.y), z: r2(p.position.z) };
    const kb = ctx.mechanics?.get('knockback');
    const h = kb?.lastHitBy?.(p) ?? null, by = h ? ctx.players.get(h.from) ?? null : null;
    stats.falls++; doomed.delete(p.id);
    last = { player: p.id, cause, at, by: by?.id ?? null, t: r2(now()) };
    ctx.net.send('hazards:out', { id: p.id, c: cause, p: [at.x, at.y, at.z], ...(by ? { b: by.id } : {}) });
    wentOut(p, cause, at, by);
    out.get(p.id).until = now() + V('respawnSeconds');
    for (const fn of L.fall.slice()) try { fn({ player: p, cause, by, at }); } catch (e) { console.error(e); }
  }
  function hostBack(p) {
    const s = spotFor(p), at = { x: r2(s.x), y: r2(s.y), z: r2(s.z) };
    ctx.net.send('hazards:back', { id: p.id, p: [at.x, at.y, at.z], y: r2(s.yaw ?? 0) });
    cameBack(p, at, s.yaw);
    arriving.set(p.id, { at, until: now() + 3 });
    if (V('protectSeconds') > 0) ctx.fair?.protect?.(p, V('protectSeconds'));
  }
  /** Host: a landing at `speed` m/s hurts by fallDamage per m/s over fallSafe. */
  function hostLanding(p, speed, source = 'fall') {
    const over = speed - V('fallSafe');
    if (!ctx.host || !(V('fallDamage') > 0) || over <= 0 || out.has(p.id)) return;
    const hm = ctx.mechanics?.get('health');
    const amount = Math.round(over * V('fallDamage') * 10) / 10;
    if (hm?.damage && !hm.standin) { const kb = ctx.mechanics?.get('knockback'), h = kb?.lastHitBy?.(p); hm.damage(p, amount, { from: h ? ctx.players.get(h.from) ?? null : null, source, push: true }); }
    stats.hurt++;
    for (const fn of L.hurt.slice()) try { fn({ player: p, amount, speed: r2(speed) }); } catch (e) { console.error(e); }
  }

  function link() {
    if (linked) return; linked = true;
    const kb = ctx.mechanics?.get('knockback');
    if (kb && !kb.standin) {
      kb.onSplash?.(e => { if (e.player) splashedAt.set(e.player.id, now()); });
      kb.onLand?.(e => { if (ctx.host && e.player) hostLanding(e.player, e.speed, 'thrown'); });
      // a throw whose flight ends in the water or out of the world: the player is out from the throw on (knocked out,
      // never lying helpless in the air), and the fall comes when the body goes under
      kb.onFling?.(e => { if (ctx.host && e.player && (e.into === 'water' || e.into === 'out') && !out.has(e.player.id) && (e.into === 'water' ? V('water') : V('out'))) { doomed.set(e.player.id, now() + e.duration + 2); e.player.alive = false; } });
    }
  }

  const api = {
    id, params: P, stats,
    /** Host: {player, cause: 'water' | 'out', by (whoever threw them last, or null), at}. */
    onFall(fn) { L.fall.push(fn); return unsub(L.fall, fn); },
    /** Every copy: a player came back {player, at}. */
    onBack(fn) { L.back.push(fn); return unsub(L.back, fn); },
    /** Host: a landing hurt {player, amount, speed}. */
    onHurt(fn) { L.hurt.push(fn); return unsub(L.hurt, fn); },
    /** Every copy: is this player out right now (in the water, past the edge). */
    isOut: p => !!p && out.has(typeof p === 'string' ? p : p.id),
    /** Host: take a player out now (a game's own hazard: lava, a pit). */
    takeOut(p, cause = 'out') { const t = typeof p === 'string' ? ctx.players.get(p) : p; if (t) hostFall(t, cause); },
    /** Where this player would come back now (QA, and a game that moves players itself). */
    spotFor,
    reset() { for (const [pid] of out) { const p = ctx.players.get(pid); if (p) { p.hidden = false; p.alive = true; p.controller?.carry?.(null); if (p.character?.object3d) p.character.object3d.visible = true; } } out.clear(); splashedAt.clear(); arriving.clear(); doomed.clear(); },
    update() {
      if (!linked && ctx.mechanics) link();
      const playing = ctx.round?.phase === 'playing';
      // every copy: an owned player's own hard landing (not a thrown one: the knockback mechanic reports those)
      for (const p of ctx.players?.owned?.() ?? []) {
        const st = p.controller?.state;
        if (playing && st?.landed && st.landSpeed > V('fallSafe') && V('fallDamage') > 0 && !p.controller.carried) {
          if (ctx.host) hostLanding(p, st.landSpeed); else ctx.net.send('hazards:land', { s: r2(st.landSpeed) }, 'host');
        }
      }
      // hidden players stay hidden (a friend's pose would show them again)
      for (const [pid] of out) { const p = ctx.players.get(pid); if (p?.character?.object3d?.visible) p.character.object3d.visible = false; }
      if (!ctx.host || !playing) return;
      const E = edges();
      for (const p of ctx.players.list()) {
        if (out.has(p.id)) continue;
        const doom = doomed.get(p.id);
        if (doom !== undefined && now() > doom) { doomed.delete(p.id); p.alive = true; }   // it never went under: back in play
        if (p.alive === false && !doomed.has(p.id)) continue;
        const q = p.position;
        // a player on the way back is not judged until their pose shows them there (or a moment has passed)
        const ar = arriving.get(p.id);
        if (ar) { if (now() < ar.until && Math.hypot(q.x - ar.at.x, q.z - ar.at.z) > 1.5) continue; arriving.delete(p.id); }
        if (V('water')) { const w = waterAt(q.x, q.z); if (w !== null && q.y < w - V('waterDepth')) { hostFall(p, 'water'); continue; } }
        if (V('out') && (q.y < E.floor || (E.box && (q.x < E.box[0] || q.z < E.box[1] || q.x > E.box[2] || q.z > E.box[3])))) hostFall(p, 'out');
      }
      for (const [pid, o] of [...out]) { if (o.until !== undefined && now() >= o.until) { const p = ctx.players.get(pid); if (p) hostBack(p); else out.delete(pid); } }
    },
    /** 'hazards:out', 'hazards:back' (the host tells everyone), 'hazards:land' (a player's copy tells the host). */
    event(name, d, from) {
      if (!d) return;
      if (name === 'land' && ctx.host) { const p = ctx.players.get(from); if (p && Number.isFinite(d.s)) hostLanding(p, Math.min(80, d.s)); return; }
      if (ctx.host) return;
      const p = ctx.players.get(d.id); if (!p || !Array.isArray(d.p) || d.p.length !== 3 || !d.p.every(Number.isFinite)) return;
      const at = { x: d.p[0], y: d.p[1], z: d.p[2] };
      if (name === 'out') { last = { player: p.id, cause: d.c, at, by: d.b ?? null, t: r2(now()) }; wentOut(p, d.c === 'water' ? 'water' : 'out', at, d.b ? ctx.players.get(d.b) ?? null : null); }
      else if (name === 'back') cameBack(p, at, Number.isFinite(d.y) ? d.y : p.yaw);
    },
    observe: () => ({ host: !!ctx.host, out: [...out].map(([pid, o]) => ({ player: pid, cause: o.cause, by: o.by?.id ?? null })), last, stats: { ...stats } }),
    dispose() {},
  };
  return api;
}

export const manifest = {
  id, examples, params,
  describe: 'Water, the world\'s edge and hard falls: a player who falls in is out for a moment and comes back on reachable ground; hard landings can hurt',
  rank: 32,
  needs: { parts: [], world: [] },
  uses: ['knockback', 'health'],
  owns: () => [],
  state: { key: null, fields: {} },
  events: [
    { name: 'onFall', on: 'host', args: '{ player, cause: \'water\' | \'out\', by, at }', when: 'a player fell in the water or out of the world (by: whoever threw them last)', play: 'death' },
    { name: 'onBack', on: 'every copy', args: '{ player, at }', when: 'a player came back after a fall', quiet: true },
    { name: 'onHurt', on: 'host', args: '{ player, amount, speed }', when: 'a hard landing hurt (fallDamage > 0)', play: 'hit' },
  ],
  sync: { owner: 'host', how: 'the host watches every player and decides a fall; it tells every copy (the splash, the hold under water) and where the player comes back' },
  note: [
    'The kit HUD and the toast say a player fell; rules only score: hz.onFall(e => { if (e.by && e.by !== e.player) e.by.score += 3; }).',
    'A player comes back on ground every seat can reach (the world\'s placement API), near their own seat, protected for protectSeconds.',
    'With the knockback mechanic a thrown player\'s thrower is e.by for creditSeconds after the throw.',
  ],
  stub: {
    as: 'hz',
    worked: 'hz.onFall(e => { if (ctx.host && e.by && e.by !== e.player) e.by.score += 3; });',
    traps: ['onFall runs on the host only: score there, never on every copy', 'do not move a fallen player yourself: the part brings them back'],
  },
  signs: {
    sample: () => null,
    judge: v => v.add('falls', 'note', 'hazards (observe)', 'reported by the mechanic\'s own observe on each page'),
  },
};
