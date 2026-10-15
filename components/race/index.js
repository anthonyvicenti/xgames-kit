// mechanic: race (track K2). Checkpoints, laps and a finish order. The host judges every crossing; everyone draws
// the gates and sees the standings. README.md has ownership and API.
//
//   const race = ctx.mechanics.get('race');
//   check(ctx) { return race.check(); }              // { winners: [first to finish], reason: 'finished' } or null
//   race.standings();                                 // every copy: [{ player, lap, cp, place }]
import * as THREE from 'three';
import { createRace, ringCheckpoints } from './logic.js';
import { areaOf } from '../../core/util.js';

export const id = 'race';
export const examples = ['three laps around the yard', 'checkpoint dash', 'obstacle course to the flag'];

const D = { checkpoints: [], ringCount: 6, ringRadius: 0, laps: 3, radius: 2.4, color: '#ffd23f', nextColor: '#4be0a8', gateSize: 2.6, prop: '', placePoints: [3, 2, 1], ending: 'first', toast: true, lapText: 'Lap {lap}/{laps}', soundCheckpoint: 'coin', soundLap: 'win' };
const num = (description, minimum, maximum) => ({ type: 'number', description, minimum, maximum });
const kebab = s => s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
export const params = {
  type: 'object', additionalProperties: true,
  properties: {
    checkpoints: { type: 'array', default: D.checkpoints, items: { type: 'array' }, description: 'The course: [[x, z], ...] in order, or [] for a ring of ringCount gates' },
    ringCount: { type: 'integer', minimum: 2, maximum: 24, default: D.ringCount, description: 'Gates in the automatic ring course' },
    ringRadius: { ...num('Radius of the ring course in metres (0: 60% of the play area)', 0, 100), default: D.ringRadius },
    laps: { type: 'integer', minimum: 1, maximum: 20, default: D.laps, description: 'Laps to finish' },
    radius: { ...num('How close counts as passing a gate (m)', 0.5, 10), default: D.radius },
    color: { type: 'string', default: D.color, description: 'Gate colour' },
    nextColor: { type: 'string', default: D.nextColor, description: 'Colour of the gate you are heading for' },
    gateSize: { ...num('Gate ring diameter in metres', 0.5, 8), default: D.gateSize },
    prop: { type: 'string', default: D.prop, description: 'Prop slot to stand at each gate instead of the ring ("": a ring)' },
    placePoints: { type: 'array', items: { type: 'number' }, default: D.placePoints, description: 'Score for finishing 1st, 2nd, ...' },
    ending: { type: 'string', enum: ['first', 'all', 'never'], default: D.ending, description: 'What check() waits for: the first finisher, everyone, or nothing (time decides)' },
    toast: { type: 'boolean', default: D.toast, description: 'Show a line when you finish a lap' },
    lapText: { type: 'string', default: D.lapText, description: 'That line; {lap} and {laps}' },
    soundCheckpoint: { type: 'string', default: D.soundCheckpoint, description: 'Sound id at a gate' },
    soundLap: { type: 'string', default: D.soundLap, description: 'Sound id at the end of a lap' },
  },
};
const vs = (name, label, type, extra = {}) => ({ id: `mechanic.race.${kebab(name)}`, label, group: 'mechanics', type, source: { pointer: `{base}/${name}` }, tier: 'advanced', facet: type === 'color' ? 'look' : type === 'text' ? 'text' : 'gameplay', ...extra });
export const slots = [
  vs('laps', 'Laps', 'integer', { tier: 'main', rank: 56, constraints: { min: 1, max: 20 } }),
  vs('color', 'Gate colour', 'color', { tier: 'main', rank: 50 }),
  vs('nextColor', 'Next gate colour', 'color', { rank: 44 }),
  vs('ringCount', 'Gates in the ring course', 'integer', { rank: 40, constraints: { min: 2, max: 24 } }),
  vs('radius', 'Gate pass distance', 'number', { constraints: { min: 0.5, max: 10, unit: 'm' } }),
  vs('gateSize', 'Gate size', 'number', { constraints: { min: 0.5, max: 8, unit: 'm' } }),
  vs('ringRadius', 'Ring course radius', 'number', { constraints: { min: 0, max: 100, unit: 'm' } }),
  vs('placePoints', 'Score for each place', 'json'),
  vs('lapText', 'Lap line', 'text', { constraints: { maxLength: 40 } }),
  vs('prop', 'Gate prop', 'text', { constraints: { maxLength: 40 } }),
  vs('soundCheckpoint', 'Gate sound id', 'text', { constraints: { maxLength: 40 } }),
  vs('soundLap', 'Lap sound id', 'text', { constraints: { maxLength: 40 } }),
];

const unsub = (arr, fn) => () => { const i = arr.indexOf(fn); if (i >= 0) arr.splice(i, 1); };

export function create(ctx, params = {}) {
  const P = { ...D, ...params };
  const V = k => { const sid = `mechanic.race.${kebab(k)}`; try { return ctx.assets?.has(sid) ? ctx.assets.value(sid, P[k]) : P[k]; } catch { return P[k]; } };
  const A = areaOf(ctx.world);
  const cps = V('checkpoints')?.length ? V('checkpoints').map(c => ({ x: c[0], z: c[1] })) : ringCheckpoints(V('ringCount'), A.cx, A.cz, V('ringRadius') || Math.min(A.hx, A.hz) * 0.6);
  const race = createRace({ cps, laps: V('laps'), radius: V('radius') });
  const L = { checkpoint: [], lap: [], finish: [] };
  const root = new THREE.Group(); root.name = 'gf-race'; ctx.scene.add(root);
  const gates = [];
  const lastPos = new Map(), seen = new Map();
  let S = null, t0 = 0, built = false, tmpl = null, loading = false, settled = false;
  // where each gate stands: on the world's own ground (worlds/placement.js), the same on every copy. Checkpoints the
  // game gives stand where it says, on the ground there; the default ring's go to the nearest open ground every seat
  // reaches (on island terrain a ring round the middle would stand in the sea), each a few metres from the others
  function settle() {
    settled = true;
    const W = ctx.world, given = !!V('checkpoints')?.length;
    cps.forEach((c, i) => {
      if (!given) { const q = W.place?.('checkpoint', 1, { prefer: { x: c.x, z: c.z }, clear: 1.0, away: 0, exclude: cps.slice(0, i).map(o => ({ x: o.x, z: o.z, r: 3 })) })?.[0]; if (q) { c.x = q.x; c.y = q.y; c.z = q.z; return; } }
      c.y = W.groundAt?.(c.x, c.z) ?? 0;
    });
  }
  const now = () => ctx.time.now;
  const list = () => ctx.players.list();

  async function build() {
    built = true;
    try { if (V('prop') && ctx.assets.has(`prop.${V('prop')}`)) tmpl = await ctx.assets.model(`prop.${V('prop')}`, { fit: V('gateSize') }); } catch (e) { console.warn('race: gate prop failed, drawing rings', e); }
    cps.forEach((c, i) => {
      let o;
      if (tmpl) o = tmpl.clone(true);
      else { o = new THREE.Mesh(new THREE.TorusGeometry(V('gateSize') / 2, 0.1, 10, 36), ctx.modules?.look?.material?.('glow', { tint: V('color') }) ?? new THREE.MeshStandardMaterial({ color: V('color'), emissive: V('color'), emissiveIntensity: 0.5 })); ctx.assets.tag(o, 'mechanic.race.color'); }
      o.position.set(c.x, (c.y ?? 0) + V('gateSize') / 2, c.z);
      o.rotation.y = Math.atan2(cps[(i + 1) % cps.length].x - c.x, cps[(i + 1) % cps.length].z - c.z);
      root.add(o); gates.push(o);
    });
  }
  const wireOf = () => Object.fromEntries(list().map(p => { const g = race.get(p.id); return [p.id, [g.lap, g.cp, g.place]]; }));
  const progress = p => { const w = ctx.host ? race.get(p.id) : (S?.r?.[p.id] ? { lap: S.r[p.id][0], cp: S.r[p.id][1], place: S.r[p.id][2] } : { lap: 0, cp: 0, place: 0 }); return w; };

  const api = {
    id, params: P, checkpoints: cps,
    /** Every copy: {lap (completed), cp (next gate index), place (0 until finished), fraction 0..1, done} */
    progress(p) { const w = progress(p); return { ...w, fraction: w.place ? 1 : (w.lap * cps.length + w.cp) / (V('laps') * cps.length), done: w.place > 0 }; },
    /** The next gate for a player: {x, z, index} (for bots and arrows). */
    nextGate(p) { const w = progress(p); return w.place ? null : { ...cps[w.cp], index: w.cp }; },
    /** The places every racer must get to (gate D: the reach leg's window.__game.objectives() and the play feed,
     *  kit/core/play.js): the gates, standing on the world's ground. */
    objectives: () => Object.assign(cps.map((g, i) => ({ id: `race:${i}`, kind: 'gate', label: `gate ${i + 1}`, x: g.x, y: g.y ?? 0, z: g.z, present: true, open: true, radius: g.r ?? g.radius ?? V('radius') })), { asked: cps.length }),
    /** Every copy: players best first [{player, lap, cp, place, fraction}]. */
    standings() {
      const ps = list(), pos = Object.fromEntries(ps.map(p => [p.id, p.position]));
      const mirror = createRace({ cps, laps: V('laps') });
      for (const p of ps) Object.assign(mirror.get(p.id), progress(p));
      return mirror.standings(ps.map(p => p.id), pos).map(id => { const p = ctx.players.get(id); return { player: p, ...api.progress(p) }; });
    },
    /** Every copy: ids in finishing order. */
    finishOrder: () => (ctx.host ? race.order.slice() : (S?.o ?? [])),
    /** Host `check()` helper: null, or {winners, reason: 'finished'} once the race's `ending` is met. */
    check() {
      const o = api.finishOrder(); if (!o.length || V('ending') === 'never') return null;
      if (V('ending') === 'all' && !list().every(p => progress(p).place > 0)) return null;
      return { winners: [o[0]], reason: 'finished' };
    },
    /** Host, for bots: head for the next gate. Call from rules.bot. */
    botStep(b) { const g = api.nextGate(b); if (g && b.bot) b.bot.seek(g, { stop: 0.4 }); else b.bot?.stop(); },
    /** Host: {player, index} / {player, lap} / {player, place}. → unsubscribe */
    onCheckpoint(fn) { L.checkpoint.push(fn); return unsub(L.checkpoint, fn); },
    onLap(fn) { L.lap.push(fn); return unsub(L.lap, fn); },
    onFinish(fn) { L.finish.push(fn); return unsub(L.finish, fn); },
    reset() { race.reset(); lastPos.clear(); seen.clear(); },
    update(dt) {
      if (!S) { if (!(ctx.shared && ctx.players && ctx.me)) return; S = ctx.shared.register('race', { r: {}, o: [] }); }
      if (!settled) { if (ctx.world.walk && !ctx.world.walk.ready()) return; settle(); }   // the ground is read after the physics' first step
      if (!built) build();
      t0 += dt;
      if (ctx.host) {
        if (ctx.round?.phase === 'playing') for (const p of list()) {
          const cur = { x: p.position.x, z: p.position.z }, prev = lastPos.get(p.id) ?? cur; lastPos.set(p.id, cur);
          if (p.alive === false) continue;
          const g = race.get(p.id), idx = g.cp;
          for (const e of race.pass(p.id, prev, cur, ctx.time.round, p.position.y)) {
            if (e === 'checkpoint') for (const fn of L.checkpoint.slice()) try { fn({ player: p, index: idx }); } catch (er) { console.error(er); }
            if (e === 'lap') for (const fn of L.lap.slice()) try { fn({ player: p, lap: g.lap }); } catch (er) { console.error(er); }
            if (e === 'finish') { const pts = V('placePoints')?.[g.place - 1] ?? 0; p.score += pts; for (const fn of L.finish.slice()) try { fn({ player: p, place: g.place, points: pts }); } catch (er) { console.error(er); } }
          }
        }
        S.r = wireOf(); S.o = race.order.slice();
      }
      // every copy: edges for sounds and the lap line (local player), the gates
      for (const p of list()) {
        const w = progress(p), prev = seen.get(p.id);
        if (prev && (w.cp !== prev.cp || w.lap !== prev.lap)) {
          const lapUp = w.lap > prev.lap;
          const snd = lapUp ? V('soundLap') : V('soundCheckpoint');
          if (snd && (p.local || p.drawn)) ctx.audio?.play(snd, { at: p.position, optional: true });
          if (lapUp && p.local && V('toast') && !w.place) ctx.ui?.toast(V('lapText').replace('{lap}', w.lap + 1).replace('{laps}', V('laps')));
        }
        seen.set(p.id, { ...w });
      }
      const me = ctx.me ? progress(ctx.me) : { cp: 0, place: 0 };
      gates.forEach((g, i) => {
        const next = !me.place && i === me.cp;
        g.rotation.z += dt * (next ? 1.6 : 0.4);
        g.scale.setScalar(next ? 1 + Math.sin(t0 * 5) * 0.06 : 0.85);
        if (g.material?.color) { g.material.color.set(next ? V('nextColor') : V('color')); if (g.material.emissive) g.material.emissive.set(next ? V('nextColor') : V('color')); }
      });
    },
    dispose() { root.removeFromParent(); },
  };
  return api;
}

// ---------------------------------------------------------------------------------------------------------------------
// The part's manifest (tools/catalog.mjs MANIFEST lists the fields): what `create` composes and refuses by, what the
// catalog tells a pitch, the handlers and traps of the rules.js stub, and verify check 15's sign of life. The tools
// read it in Node; nothing in play does.
// ---------------------------------------------------------------------------------------------------------------------
export const manifest = {
  id, examples, params,
  describe: 'Checkpoints, laps, a finish order',
  rank: 80,
  needs: { parts: [], world: [] },
  uses: [],
  owns: () => [],
  state: { key: 'race', fields: { r: '{ playerId: [lap, checkpoint, place] }', o: 'the finish order (player ids)' } },
  events: [
    { name: 'onCheckpoint', on: 'host', args: '{ player, index }', when: 'a player passed a gate' },
    { name: 'onLap', on: 'host', args: '{ player, lap }', when: 'a player finished a lap' },
    { name: 'onFinish', on: 'host', args: '{ player, place, points }', when: 'a player finished the race' },
  ],
  sync: { owner: 'host', how: 'the host judges every crossing and the finish order' },
  note: [
    'The gates are drawn and judged by the kit: params.checkpoints is [[x, z], …], or leave it empty for a ring of ringCount gates.',
    'The race ends the round only when rules.check returns race.check(); a finish already scores placePoints.',
    'race.standings() and race.progress(p) are the same on every copy.',
  ],
  stub: {
    as: 'race',
    worked: 'check(ctx) { return race.check(); }   // null, or { winners: [first to finish], reason: \'finished\' }',
    traps: [
      'bots stand still unless the rules steer them: in bot(ctx, p) call race.botStep(p)',
      'adding score in onFinish counts a place twice (placePoints is already added)',
    ],
  },
  signs: {
    sample: sh => (sh.race ? { race: sh.race.r ?? {} } : null),
    judge: v => {
      const ok = v.others.race;
      v.add('a gate is passed', ok ? 'ok' : 'dead', 'shared.race.r', ok ? 'yes' : `nobody passed a gate on any page (${v.names})`, ok ? '' : 'call race.botStep(p) in rules.bot and check the gates are reachable');
    },
  },
};
