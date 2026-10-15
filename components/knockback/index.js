// mechanic: knockback. Physical chaos as a shared part: a blast throws every body in range (a humanoid ragdolls, a
// creature tumbles, a loose prop flies), each body's whole flight is simulated once on the host (bounces, the sea, a rest,
// the bodies it bowls over on the way) and sent once, and every copy plays that same path, so both screens see the same
// flight and the same landing. README.md has the network ownership and the API.
//
//   const kb = ctx.mechanics.get('knockback');
//   if (ctx.host) kb.blast({ x, y, z }, { radius: 4, force: 16, from: shooter });   // everyone near flies
//   kb.onLand(e => ...)        every copy: a body hit the ground hard {body, player, at, speed}
//   kb.flying(p)               every copy: is this player in a flight now
//
// The owner's copy of a player rides the path (controller.carry); every copy steers that player's ragdoll or tumble onto
// it (character.steer), so the limbs flop on their own while the body goes where the host said. Loose props (params.props:
// names of the world's scenery props) fly the same way and stay where they land, late joiners included.
import * as THREE from 'three';
import { radialImpulse, simulateFlight, sampleFlight, chainHits, packKeys, unpackKeys, MAX_FLIGHT } from './logic.js';
import { physicsOf } from '../../core/util.js';

export const id = 'knockback';
export const examples = ['a blast throws everyone near it flying', 'explosions send ragdolls tumbling into the sea', 'a bomb bowls over a row of crates'];

const MASSES = { humanoid: 1, blob: 0.85, worm: 0.8, quadruped: 1.3, flyer: 0.6, prop: 1.2 };
const D = {
  radius: 4, force: 15, up: 0.7, falloff: 'smooth', damage: 0, gravity: 18, bounce: 0.38, friction: 0.72, settle: 0.5,
  chain: true, chainSpeed: 5, chainShare: 0.6, masses: MASSES, props: [], fromProjectile: true, creditSeconds: 8,
  juice: true, landFx: '', splashFx: '', sound: '', landSound: '', splashSound: '',
};
const kebab = s => s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
const num = (description, minimum, maximum, d) => ({ type: 'number', description, minimum, maximum, default: d });
export const params = {
  type: 'object', additionalProperties: true,
  properties: {
    radius: num('Reach of a blast that names none (m)', 0.5, 20, D.radius),
    force: num('Speed a blast gives a body of mass 1 at its centre (m/s)', 0, 32, D.force),
    up: num('How far a blast tips its push upward (0 straight out, 1 about 45°)', 0, 3, D.up),
    falloff: { type: 'string', enum: ['smooth', 'linear', 'flat'], default: D.falloff, description: 'How a blast weakens toward its edge' },
    damage: num('Damage at a blast\'s centre, passed to the health mechanic (0: blasts only throw)', 0, 1000, D.damage),
    gravity: num('Gravity on a flying body (m/s²)', 2, 40, D.gravity),
    bounce: num('Speed a body keeps off a hard landing (0 thud, 1 rubber)', 0, 0.9, D.bounce),
    friction: num('Sliding speed a body keeps per bounce', 0, 1, D.friction),
    settle: num('Seconds a body lies still after it stops, before it gets up', 0, 4, D.settle),
    chain: { type: 'boolean', default: D.chain, description: 'A body thrown fast knocks the bodies it passes' },
    chainSpeed: num('Slowest a thrown body knocks another (m/s)', 1, 30, D.chainSpeed),
    chainShare: num('Share of its speed a thrown body passes on', 0, 1.5, D.chainShare),
    masses: { type: 'object', default: MASSES, description: 'Mass per body kind (humanoid, blob, worm, quadruped, flyer, prop): heavier flies less far', additionalProperties: { type: 'number', minimum: 0.1, maximum: 20 } },
    props: { type: 'array', items: { type: 'string' }, default: D.props, description: 'Names of the world\'s scenery props that are loose: a blast throws them too' },
    fromProjectile: { type: 'boolean', default: D.fromProjectile, description: 'A projectile splash (splashRadius > 0) throws through this part, not the projectile\'s own knock' },
    creditSeconds: num('Seconds a thrown player still counts as thrown by whoever threw them (kb.lastHitBy)', 0, 60, D.creditSeconds),
    juice: { type: 'boolean', default: D.juice, description: 'Shake, hitstop and slow motion sized by each blast and landing (ctx.juice, within the player\'s comfort settings)' },
    landFx: { type: 'string', default: D.landFx, description: 'A vfx preset where a body lands hard (dust-kick, smoke-puff, ...); unset: the effect style\'s hit, or none' },
    splashFx: { type: 'string', default: D.splashFx, description: 'A vfx preset where a body falls into the sea (water-splash); unset: none' },
    sound: { type: 'string', default: D.sound, description: 'A sound id when a body is thrown; unset: none' },
    landSound: { type: 'string', default: D.landSound, description: 'A sound id when a body lands hard; unset: none' },
    splashSound: { type: 'string', default: D.splashSound, description: 'A sound id when a body falls into the sea; unset: none' },
  },
};
const vs = (name, label, type, extra = {}) => ({ id: `mechanic.knockback.${kebab(name)}`, label, group: 'mechanics', type, source: { pointer: `{base}/${name}` }, tier: 'advanced', facet: 'gameplay', ...extra });
export const slots = [
  vs('force', 'Blast throw', 'number', { tier: 'main', rank: 66, constraints: { min: 0, max: 32, unit: 'm/s' } }),
  vs('radius', 'Blast reach', 'number', { tier: 'main', rank: 64, constraints: { min: 0.5, max: 20, unit: 'm' } }),
  vs('up', 'Blast lift', 'number', { tier: 'main', rank: 62, constraints: { min: 0, max: 3 } }),
  vs('bounce', 'Bounciness', 'number', { tier: 'main', rank: 58, constraints: { min: 0, max: 0.9 } }),
  vs('damage', 'Blast damage', 'number', { constraints: { min: 0, max: 1000 } }),
  vs('settle', 'Seconds lying still', 'number', { constraints: { min: 0, max: 4, unit: 's' } }),
  vs('gravity', 'Flight gravity', 'number', { constraints: { min: 2, max: 40 } }),
  vs('chain', 'Thrown bodies knock others', 'boolean'),
  vs('juice', 'Shake and slow motion on big hits', 'boolean', { facet: 'look' }),
];

const unsub = (arr, fn) => () => { const i = arr.indexOf(fn); if (i >= 0) arr.splice(i, 1); };
const KINDS = ['land', 'bounce', 'water', 'out', 'rest'];
const r2 = v => Math.round(v * 100) / 100;

export function create(ctx, params = {}) {
  const P = { ...D, ...params, masses: { ...MASSES, ...(params.masses ?? {}) } };
  const V = k => { const sid = `mechanic.knockback.${kebab(k)}`; try { return ctx.assets?.has(sid) ? ctx.assets.value(sid, P[k]) : P[k]; } catch { return P[k]; } };
  const L = { blast: [], fling: [], land: [], splash: [], settle: [] };
  const flights = new Map();        // every copy: body key → { key, kind, id, keys, events, start, dur, settle, ei, from, off }
  const pending = [];               // host: chained knocks waiting for their moment { at, key, v, from, depth }
  const lastHit = new Map();        // host: player id → { from, at }
  const props = new Map();          // loose props: key → { entry (the scenery's), base: Matrix4 list, home: {x,y,z}, rot0, axis, moved }
  const stats = { blasts: 0, flights: 0, chains: 0, landings: 0, splashes: 0, refused: 0, received: 0 };
  let S = null, vfx = null, last = null, linked = false;
  if (P.landFx || P.splashFx || ctx.config?.fx) import('../../vfx/index.js').then(m => { vfx = m.vfxOf(ctx); }).catch(e => console.warn(`gf-three knockback: effects need the vfx module (${e.message})`));
  const now = () => ctx.time.now;
  const player = idOrP => (typeof idOrP === 'string' ? ctx.players.get(idOrP) : idOrP);
  const keyOf = p => `p:${p.id}`;

  // ---------- bodies ----------
  const archetypeOf = p => p.character?.archetype ?? 'humanoid';
  const radiusOf = p => { const a = archetypeOf(p); if (a === 'humanoid') return 0.35; return Math.max(0.25, Math.min(0.6, (p.character?.height ?? 1) * 0.35)); };
  /** Every body a blast can throw, where this copy has it: {key, kind, id, player?, prop?, x, y, z (feet), radius, mass}. */
  function bodies() {
    const out = [];
    for (const p of ctx.players.list()) {
      if (p.alive === false || !(p.owned || p.drawn !== false)) continue;
      const f = flights.get(keyOf(p)), s = f ? sampleFlight(f.keys, now() - f.start) : null;
      const at = s && !s.done ? s : p.position;
      out.push({ key: keyOf(p), kind: 'p', id: p.id, player: p, x: at.x, y: at.y, z: at.z, radius: radiusOf(p), mass: P.masses[archetypeOf(p)] ?? 1 });
    }
    for (const [key, o] of props) {
      if (o.entry.gone) continue;
      const f = flights.get(key), s = f ? sampleFlight(f.keys, now() - f.start) : null, at = s && !s.done ? s : o.at;
      out.push({ key, kind: 'o', id: key, prop: o, x: at.x, y: at.y, z: at.z, radius: o.radius, mass: P.masses.prop ?? 1.2 });
    }
    return out;
  }
  const centreOf = b => ({ x: b.x, y: b.y + b.radius, z: b.z });

  // ---------- the host: the world a flight meets ----------
  const balls = new Map();
  function hitWorld(a, b, r) {
    const { RAPIER: R, world: W } = physicsOf(ctx);
    if (!R || !W) return null;
    let ball = balls.get(r); if (!ball) balls.set(r, ball = new R.Ball(r));
    const vel = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
    if (vel.x === 0 && vel.y === 0 && vel.z === 0) return null;
    const h = W.castShape(a, { x: 0, y: 0, z: 0, w: 1 }, vel, ball, 0, 1, false, undefined, undefined, undefined, undefined, c => { const p = c.parent(); return !p || p.isFixed(); });
    if (!h) return null;
    const n = h.normal1;
    return { t: h.time_of_impact ?? h.toi, normal: [n.x, n.y, n.z] };
  }
  function worldLimits() {
    const B = ctx.world?.bounds, sea = Number.isFinite(ctx.world?.seaLevel) ? ctx.world.seaLevel : null;
    const bounds = B?.min && B?.max ? [B.min.x, B.min.z, B.max.x, B.max.z] : null;
    const floor = Math.min(sea ?? 0, B?.min?.y ?? 0) - 8;
    return { sea, bounds, floor };
  }

  // ---------- every copy: a flight starts ----------
  function startFlight(key, keys, events, { from = null, settle = V('settle'), v0 = null } = {}) {
    const kind = key[0], bid = key.slice(2), dur = keys[keys.length - 1][0];
    const f = { key, kind, id: bid, keys, events, start: now(), dur, settle, ei: 0, from, off: null };
    flights.set(key, f);
    stats.flights++;
    const s0 = sampleFlight(keys, 0);
    const v = v0 ?? { x: s0.vx, y: s0.vy, z: s0.vz };
    if (kind === 'p') {
      const p = ctx.players.get(bid);
      if (p) {
        // the body goes limp with the push, then is steered onto the path; the owner's copy rides it
        try { p.character?.knock?.(v, { getUp: false }); } catch (e) { console.error(e); }
        const c = p.character?.centre?.();
        f.off = c ? { x: c.x - s0.x, y: c.y - s0.y, z: c.z - s0.z } : { x: 0, y: radiusOf(p), z: 0 };
        f.lift = radiusOf(p);
        if (p.owned && p.controller?.carry) p.controller.carry(() => sampleFlight(f.keys, now() - f.start), dur + settle);
        if (V('sound')) ctx.audio?.play(V('sound'), { at: s0, optional: true });
        if (V('juice') && p.local) ctx.juice?.impact?.(Math.min(1, Math.hypot(v.x, v.y, v.z) / 22), { at: s0, local: true });
      }
    }
    const e = { body: key, kind: kind === 'p' ? 'player' : 'prop', player: kind === 'p' ? ctx.players.get(bid) ?? null : null, v, from: from ? ctx.players.get(from) ?? null : null, duration: dur, into: events.length ? events[events.length - 1].kind : 'rest' };
    for (const fn of L.fling.slice()) try { fn(e); } catch (err) { console.error(err); }
    return f;
  }
  function flightEvent(f, ev) {
    const at = ev.at, p = f.kind === 'p' ? ctx.players.get(f.id) : null;
    if (ev.kind === 'land' || ev.kind === 'bounce') {
      stats.landings++;
      if (ev.speed > 5) {
        if (vfx && V('landFx')) vfx.fx(V('landFx'), { at, scale: Math.min(1.6, 0.5 + ev.speed / 14) });
        else if (vfx && ctx.config?.fx) vfx.hit(at, { scale: Math.min(1.2, ev.speed / 14) });
        if (V('landSound')) ctx.audio?.play(V('landSound'), { at, optional: true });
        if (V('juice')) ctx.juice?.impact?.(Math.min(0.6, ev.speed / 30), { at, reach: 14 });
      }
      const e = { body: f.key, player: p, at, speed: ev.speed, first: ev.kind === 'land' };
      for (const fn of L.land.slice()) try { fn(e); } catch (err) { console.error(err); }
    } else if (ev.kind === 'water') {
      stats.splashes++;
      if (vfx && V('splashFx')) vfx.fx(V('splashFx'), { at: { x: at.x, y: worldLimits().sea ?? at.y, z: at.z }, scale: 2.2 });
      if (V('splashSound')) ctx.audio?.play(V('splashSound'), { at, optional: true });
      if (V('juice')) ctx.juice?.shake?.(0.15, { at, reach: 25 });
      const e = { body: f.key, player: p, at, from: f.from ? ctx.players.get(f.from) ?? null : null };
      for (const fn of L.splash.slice()) try { fn(e); } catch (err) { console.error(err); }
    }
  }

  // ---------- the host: throw ----------
  /** Host: throw one body (a player, or a body key) at velocity v (m/s). → true when it flies. */
  function fling(target, v, { from = null, depth = 0, check = true } = {}) {
    if (!ctx.host || !S) return false;
    const key = typeof target === 'string' ? target : keyOf(target);
    const b = bodies().find(x => x.key === key);
    if (!b || !Number.isFinite(v?.x + v?.y + v?.z)) return false;
    const fromP = player(from);
    if (b.kind === 'p') {
      // fair play: a player who is down, out or protected (or in the round's start grace) is not thrown again
      if (check && ctx.fair?.on) { const why = ctx.fair.blocked(b.player, { from: fromP }); if (why) { ctx.fair.refuse(why); stats.refused++; return false; } }
      ctx.fair?.knocked?.(b.player);
      if (fromP && fromP !== b.player) lastHit.set(b.player.id, { from: fromP.id, at: now() });
    }
    // a body already flying keeps its momentum
    const f = flights.get(key), s = f ? sampleFlight(f.keys, now() - f.start) : null;
    const vel = s && !s.done ? { x: v.x + s.vx, y: v.y + Math.max(0, s.vy), z: v.z + s.vz } : v;
    const lim = worldLimits();
    // fair play (CONTRACT §6c, F1: a player is back in control within downSeconds and a second): a player's flight keeps
    // to that budget: from its ragdoll share on, the next landing is the last, and the flight ends by the budget
    const F = b.kind === 'p' && ctx.fair?.on ? ctx.fair.split : null;
    // (a flight that ends in the sea or out of the world flies whole: the hazards part takes that player out from the
    // throw on, so they are knocked out, not lying down)
    const opts = { radius: b.radius, gravity: V('gravity'), bounce: V('bounce'), friction: V('friction'), settle: F ? 0.1 : 0.25, sea: lim.sea, bounds: lim.bounds, floor: lim.floor, hit: hitWorld, maxTime: MAX_FLIGHT };
    let sim = simulateFlight({ x: b.x, y: b.y + 0.05, z: b.z }, vel, opts);
    if (F) {
      const gone = sim.events.find(e => e.kind === 'water' || e.kind === 'out');
      if (!gone) sim = simulateFlight({ x: b.x, y: b.y + 0.05, z: b.z }, vel, { ...opts, calmAfter: Math.max(0.6, F.ragdoll + 0.35), maxTime: F.total + 0.3 });
    }
    const settle = F ? Math.min(V('settle'), 0.15) : V('settle');
    const msg = { b: key, k: packKeys(sim.keys), e: sim.events.map(e => [Math.round(e.t * 1000), KINDS.indexOf(e.kind), Math.round(e.at.x * 100), Math.round(e.at.y * 100), Math.round(e.at.z * 100), Math.round(e.speed * 10)]), s: Math.round(settle * 1000), ...(fromP ? { f: fromP.id } : {}) };
    ctx.net.send('knockback:fly', msg);
    startFlight(key, unpackKeys(msg.k), decodeEvents(msg.e), { from: fromP?.id ?? null, settle, v0: vel });
    if (b.kind === 'o') { const o = b.prop; o.moved = true; o.flying = true; }
    // the bodies it bowls over on its way, each at its moment (they are where they stand then)
    if (V('chain') && depth < 3) {
      const others = bodies().filter(x => x.key !== key && !flights.has(x.key)).map(x => ({ id: x.key, x: x.x, y: x.y, z: x.z, radius: x.radius, mass: x.mass }));
      for (const h of chainHits(sim, others, { radius: b.radius, minSpeed: V('chainSpeed'), share: V('chainShare') })) {
        const o = others.find(x => x.id === h.id), m = o?.mass ?? 1;
        pending.push({ at: now() + h.t, key: h.id, v: { x: h.v.x / m, y: h.v.y / m, z: h.v.z / m }, from: fromP?.id ?? (b.kind === 'p' ? b.id : null), depth: depth + 1 });
      }
    }
    return true;
  }
  function decodeEvents(list) {
    if (!Array.isArray(list)) return [];
    return list.filter(e => Array.isArray(e) && e.length === 6 && e.every(Number.isFinite) && KINDS[e[1]]).slice(0, 64)
      .map(e => ({ t: e[0] / 1000, kind: KINDS[e[1]], at: { x: e[2] / 100, y: e[3] / 100, z: e[4] / 100 }, speed: e[5] / 10 }));
  }
  /** Host: a blast at `at`. opts: {radius, force, up, falloff, damage, from, source}. → [{key, player?, v, k}] the bodies thrown. */
  function blast(at, o = {}) {
    if (!ctx.host || !S || !at) return [];
    const radius = o.radius ?? V('radius'), force = o.force ?? V('force'), up = o.up ?? V('up'), falloff = o.falloff ?? V('falloff'), damage = o.damage ?? V('damage');
    const from = player(o.from ?? null);
    stats.blasts++;
    const msg = { p: [r2(at.x), r2(at.y), r2(at.z)], r: r2(radius), F: r2(force), ...(from ? { f: from.id } : {}) };
    ctx.net.send('knockback:blast', msg);
    const thrown = [];
    const hm = ctx.mechanics?.get('health');
    for (const b of bodies()) {
      const imp = radialImpulse(at, centreOf(b), { radius, force, up, falloff, mass: b.mass });
      if (!imp) continue;
      if (b.kind === 'p' && damage > 0 && hm?.damage && !hm.standin) {
        // the damage first (it refuses what fair play refuses: then nothing flies either)
        if (!hm.damage(b.player, Math.round(damage * imp.k * 10) / 10, { from, point: at, source: o.source ?? 'blast' })) { stats.refused++; continue; }
      }
      if (fling(b.kind === 'p' ? b.player : b.key, imp, { from, check: !(b.kind === 'p' && damage > 0 && hm?.damage && !hm.standin) })) thrown.push({ key: b.key, player: b.player ?? null, v: imp, k: imp.k });
    }
    blasted(at, radius, force, from, thrown);
    return thrown;
  }
  /** Every copy: a blast happened (listeners, the shake). */
  function blasted(at, radius, force, from, thrown = null) {
    last = { at: { x: r2(at.x), y: r2(at.y), z: r2(at.z) }, radius, force, t: r2(now()), thrown: thrown?.length ?? null };
    if (V('juice')) ctx.juice?.impact?.(Math.min(1, (force / 22) * Math.min(1.4, radius / 4)), { at, reach: 20 + radius * 5 });
    const e = { at, radius, force, from, bodies: thrown };
    for (const fn of L.blast.slice()) try { fn(e); } catch (err) { console.error(err); }
  }

  // ---------- loose props ----------
  function linkProps() {
    const names = V('props') ?? [];
    if (!names.length || !ctx.world?.props) return;
    for (const name of names) for (const entry of ctx.world.props.get(name) ?? []) {
      if (entry.far) continue;
      const key = `o:${name}#${entry.instance}`;
      const at = { x: entry.at[0], y: entry.at[1], z: entry.at[2] };
      const size = entry.meshes?.[0]?.geometry?.boundingSphere?.radius ?? 0.5;
      props.set(key, { entry, at, home: { ...at }, radius: Math.max(0.25, Math.min(1, size * (entry.scale ?? 1) * 0.7)), axis: new THREE.Vector3(1, 0, 0), moved: false, flying: false, a: 0 });
    }
  }
  const M4 = new THREE.Matrix4(), Q = new THREE.Quaternion(), Qs = new THREE.Quaternion(), P3 = new THREE.Vector3(), S3 = new THREE.Vector3(), Y = new THREE.Vector3(0, 1, 0);
  function placeProp(o, s, a) {
    const e = o.entry;
    // lift off: its collider goes (a thrown crate is a thrown crate, not a wall where it used to stand)
    if (e.colliders?.length) { const { world: W } = physicsOf(ctx); for (const c of e.colliders) { try { W?.removeCollider(c, false); } catch {} } e.colliders = []; }
    Qs.setFromAxisAngle(o.axis, a);
    Q.setFromAxisAngle(Y, ((e.rot ?? 0) * Math.PI) / 180).premultiply(Qs);
    M4.compose(P3.set(s.x, s.y, s.z), Q, S3.setScalar(e.scale ?? 1));
    e.meshes?.forEach((im, i) => { im.setMatrixAt(e.instance, M4.clone().multiply(e.locals?.[i] ?? new THREE.Matrix4())); im.instanceMatrix.needsUpdate = true; });
    o.at = { x: s.x, y: s.y, z: s.z }; o.a = a;
  }

  // ---------- every copy, every frame ----------
  function frame() {
    const t = now();
    for (const f of [...flights.values()]) {
      const tt = t - f.start, s = sampleFlight(f.keys, tt);
      while (f.ei < f.events.length && f.events[f.ei].t <= tt) flightEvent(f, f.events[f.ei++]);
      if (f.kind === 'p') {
        const p = ctx.players.get(f.id);
        if (p?.character?.steer && !s.done) {
          // the path's ball, with the body's own middle eased onto it over the first half second
          const k = Math.max(0, 1 - tt / 0.5), off = f.off ?? { x: 0, y: f.lift, z: 0 };
          p.character.steer({ x: s.x + off.x * k, y: s.y + off.y * k + f.lift * (1 - k), z: s.z + off.z * k }, { x: s.vx, y: s.vy, z: s.vz });
        }
      } else if (f.kind === 'o') {
        const o = props.get(f.key);
        if (o) { if (!f.axisSet) { f.axisSet = true; const sx = f.keys[1] ?? f.keys[0]; o.axis.set(sx[3] - f.keys[0][3], 0, -(sx[1] - f.keys[0][1])); if (o.axis.lengthSq() < 1e-6) o.axis.set(1, 0, 0); o.axis.normalize(); } placeProp(o, s, s.a); }
      }
      if (tt >= f.dur + f.settle) {
        flights.delete(f.key);
        if (f.kind === 'o') { const o = props.get(f.key); if (o) { o.flying = false; if (ctx.host && S) S.o = { ...(S.o ?? {}), [f.key]: [r2(o.at.x), r2(o.at.y), r2(o.at.z), r2(o.a), r2(o.axis.x), r2(o.axis.z)] }; } }
        const e = { body: f.key, player: f.kind === 'p' ? ctx.players.get(f.id) ?? null : null, at: { x: r2(s.x), y: r2(s.y), z: r2(s.z) } };
        for (const fn of L.settle.slice()) try { fn(e); } catch (err) { console.error(err); }
      }
    }
    // a copy that came late: props already thrown stand where the host has them
    if (!ctx.host && S?.o) for (const [key, q] of Object.entries(S.o)) { const o = props.get(key); if (o && !flights.has(key) && (o.a !== q[3] || o.at.x !== q[0])) { o.axis.set(q[4], 0, q[5]); if (o.axis.lengthSq() < 1e-6) o.axis.set(1, 0, 0); o.axis.normalize(); placeProp(o, { x: q[0], y: q[1], z: q[2] }, q[3]); } }
  }

  // ---------- with the projectile mechanic: its splashes throw through here ----------
  function link() {
    if (linked) return; linked = true;
    linkProps();
  }

  const api = {
    id, params: P, stats,
    blast, fling,
    /** Every copy: is this player (or body key) flying now. */
    flying(target) { const key = typeof target === 'string' ? target : target ? keyOf(target) : null; const f = key && flights.get(key); return !!f && now() - f.start < f.dur; },
    /** Host: who last threw this player and when ({from: id, at}) within creditSeconds, else null. */
    lastHitBy(target) { const t = player(target); const h = t && lastHit.get(t.id); return h && now() - h.at <= V('creditSeconds') ? { from: h.from, at: h.at } : null; },
    /** Does a projectile splash throw through this part (the projectile mechanic asks). */
    get takesSplash() { return V('fromProjectile') !== false; },
    onBlast(fn) { L.blast.push(fn); return unsub(L.blast, fn); },
    onFling(fn) { L.fling.push(fn); return unsub(L.fling, fn); },
    onLand(fn) { L.land.push(fn); return unsub(L.land, fn); },
    onSplash(fn) { L.splash.push(fn); return unsub(L.splash, fn); },
    onSettle(fn) { L.settle.push(fn); return unsub(L.settle, fn); },
    /** The last blast this copy saw {at, radius, force, t, thrown}. */
    get lastBlast() { return last; },
    reset() {
      flights.clear(); pending.length = 0; lastHit.clear();
      for (const p of ctx.players?.list?.() ?? []) p.controller?.carry?.(null);
      for (const o of props.values()) if (o.moved) { placeProp(o, o.home, 0); o.moved = false; }
      if (ctx.host && S) S.o = {};
    },
    update(dt) {
      if (!S) { if (!(ctx.shared && ctx.players && ctx.me)) return; S = ctx.shared.register('kb', { o: {} }); }
      if (!linked && ctx.world) link();
      if (ctx.host && ctx.round?.phase === 'playing') {
        for (let i = pending.length - 1; i >= 0; i--) {
          const c = pending[i]; if (c.at > now()) continue;
          pending.splice(i, 1);
          if (!flights.has(c.key) || !api.flying(c.key)) { if (fling(c.key.startsWith('p:') ? ctx.players.get(c.key.slice(2)) ?? c.key : c.key, c.v, { from: c.from, depth: c.depth })) stats.chains++; }
        }
      }
      frame(dt);
    },
    /** 'knockback:fly' (a flight, from the host) and 'knockback:blast' (a blast happened). */
    event(name, d) {
      if (ctx.host || !d) return;
      if (name === 'fly') {
        const keys = unpackKeys(d.k); if (!keys || typeof d.b !== 'string' || !/^[po]:/.test(d.b)) return;
        stats.received++;
        startFlight(d.b, keys, decodeEvents(d.e), { from: typeof d.f === 'string' ? d.f : null, settle: Number.isFinite(d.s) ? Math.min(4, Math.max(0, d.s / 1000)) : V('settle') });
        if (d.b.startsWith('o:')) { const o = props.get(d.b); if (o) { o.moved = true; o.flying = true; } }
      } else if (name === 'blast' && Array.isArray(d.p) && d.p.length === 3 && d.p.every(Number.isFinite)) {
        blasted({ x: d.p[0], y: d.p[1], z: d.p[2] }, Number(d.r) || V('radius'), Number(d.F) || V('force'), typeof d.f === 'string' ? ctx.players.get(d.f) ?? null : null);
      }
    },
    /** The loose props blasts threw, where they came to rest (window.__game.objectives(): each held to the seats by the
     *  world's walk grid). Not required: a crate blown into the sea is the chaos working, so the reach measure reports
     *  where each one lies and never fails on it. */
    objectives: () => [...props.entries()].filter(([, o]) => o.moved && !o.flying).map(([key, o]) => ({ kind: 'prop', id: key, label: o.entry?.prop ?? 'prop', x: o.at.x, y: o.at.y, z: o.at.z, present: true, open: true, radius: o.radius + 1, required: false })),
    /** QA: what this copy holds. */
    observe: () => ({ host: !!ctx.host, flying: [...flights.values()].map(f => ({ body: f.key, t: r2(now() - f.start), dur: r2(f.dur), into: f.events.length ? f.events[f.events.length - 1].kind : 'rest', end: f.keys[f.keys.length - 1].slice(1, 4), keys: f.keys.length, at: api.pathAt(f.key) })), last, props: props.size, stats: { ...stats } }),
    /** QA: where a flying body is on its path now, on this copy {x, y, z} (feet), or null. */
    pathAt(target) {
      const key = typeof target === 'string' ? target : target ? keyOf(target) : null; const f = key && flights.get(key); if (!f) return null;
      const s = sampleFlight(f.keys, now() - f.start), p = f.kind === 'p' ? ctx.players.get(f.id) : null, c = p?.character?.centre?.();
      // body: where this copy draws the thrown body's middle now (its ragdoll or tumble), against the path's ball (lift)
      return { x: r2(s.x), y: r2(s.y), z: r2(s.z), t: r2(now() - f.start), done: !!s.done, lift: r2(f.lift ?? 0), ...(c ? { body: { x: r2(c.x), y: r2(c.y), z: r2(c.z) } } : {}) };
    },
    dispose() {},
  };
  return api;
}

// ---------------------------------------------------------------------------------------------------------------------
// The part's manifest (tools/catalog.mjs MANIFEST lists the fields). The tools read it in Node; nothing in play does.
// ---------------------------------------------------------------------------------------------------------------------
export const manifest = {
  id, examples, params,
  describe: 'Blasts throw every body near them (ragdolls, tumbling creatures, loose props); the host simulates each flight and every screen plays the same one',
  rank: 30,
  needs: { parts: [], world: [] },
  uses: ['health', 'projectile', 'carve', 'hazards', 'aim'],
  owns: () => [],
  state: { key: 'kb', fields: { o: '{ propKey: [x, y, z, angle, axisX, axisZ] } loose props a blast moved' } },
  events: [
    { name: 'onBlast', on: 'every copy', args: '{ at, radius, force, from, bodies (host: [{ key, player, v, k }]) }', when: 'a blast went off', play: 'blast' },
    { name: 'onFling', on: 'every copy', args: '{ body, kind: \'player\' | \'prop\', player, v, from, duration, into }', when: 'a body was thrown (into: rest | water | out): the flight is its answer on every screen', play: 'hit' },
    { name: 'onLand', on: 'every copy', args: '{ body, player, at, speed, first }', when: 'a thrown body hit the ground hard', quiet: true },
    { name: 'onSplash', on: 'every copy', args: '{ body, player, at, from }', when: 'a thrown body fell into the sea', play: 'knockout' },
    { name: 'onSettle', on: 'every copy', args: '{ body, player, at }', when: 'a thrown body came to rest', quiet: true },
  ],
  sync: { owner: 'host', how: 'the host simulates each flight once against the world and sends the whole path; every copy plays it from when it arrived (the owner\'s capsule rides it, every copy steers the ragdoll onto it); moved props are in the shared state for late copies' },
  note: [
    'Nothing throws by itself but a projectile splash (fromProjectile): rules or another part call kb.blast(at, { radius, force, from }) on the host.',
    'A thrown player is down for the flight and the settle; fair play refuses a throw on a player who is down or protected. Score in onFling or onSplash (from: who threw them), on the host.',
    'kb.lastHitBy(p) says who threw a player within creditSeconds: the hazards mechanic credits a fall into the sea with it.',
  ],
  stub: {
    as: 'kb',
    worked: 'kb.onSplash(e => { if (ctx.host && e.from && e.player && e.from !== e.player) e.from.score += 3; });',
    traps: ['kb.blast and kb.fling act on the host only: keep them under if (ctx.host)', 'a projectile splash already blasts through here (fromProjectile): calling kb.blast in onHit too throws everyone twice'],
  },
  signs: {
    sample: sh => (sh.kb ? { kb: Object.keys(sh.kb.o ?? {}).length } : null),
    judge: v => v.add('blasts throw', 'note', 'knockback (observe)', 'reported by the mechanic\'s own observe on each page'),
  },
};
