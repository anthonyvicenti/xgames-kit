// mechanic: shove (worlds, CONTRACT §9). A key (F) or a touch button pushes the nearest player in front of you a few
// blocks away. It is a push, never a knock-down (fair play F6): the player keeps control, and a player who is down or
// protected is not pushed at all (fair play F2, F3). A short cooldown keeps it a nudge, not a wall.
//
//   every copy   its own player's shove: it picks the target where this copy draws them and asks the target's owner to
//                push (p.push, routed by the kit to whoever owns that player)
//   observe()    {cooldown, shoves, missed, last: {target, d}}
import * as THREE from 'three';

export const id = 'shove';
export const examples = ['push a friend off a ledge', 'nudge people out of the way', 'a playful shove'];
const D = { key: 'KeyF', reach: 2.4, arc: 70, force: 7.5, lift: 3.5, cooldown: 1.1, sound: 'shove', label: 'Shove' };
const num = (description, minimum, maximum) => ({ type: 'number', description, minimum, maximum });
export const params = {
  type: 'object', additionalProperties: true,
  properties: {
    key: { type: 'string', default: D.key, description: 'The key (KeyboardEvent.code)' },
    reach: { ...num('How far a shove reaches, in metres', 1, 5), default: D.reach },
    arc: { ...num('How wide in front of you it reaches, in degrees', 20, 180), default: D.arc },
    force: { ...num('How hard the push is (m/s)', 1, 20), default: D.force },
    lift: { ...num('How much it lifts (m/s up)', 0, 10), default: D.lift },
    cooldown: { ...num('Seconds between shoves', 0.2, 10), default: D.cooldown },
    sound: { type: 'string', default: D.sound },
    label: { type: 'string', default: D.label, description: 'The touch button\'s word' },
  },
};
const vs = (name, label, type, extra = {}) => ({ id: `mechanic.shove.${name}`, label, group: 'mechanics', type, source: { pointer: `{base}/${name}` }, tier: 'advanced', facet: 'gameplay', ...extra });
export const slots = [
  vs('force', 'Shove strength', 'number', { tier: 'main', rank: 55, constraints: { min: 1, max: 20, unit: 'm/s' } }),
  vs('cooldown', 'Time between shoves', 'number', { constraints: { min: 0.2, max: 10, unit: 's' } }),
  vs('reach', 'Shove reach', 'number', { constraints: { min: 1, max: 5, unit: 'm' } }),
];

export function create(ctx, params = {}) {
  const P = { ...D, ...params };
  let cool = 0, held = false;
  const stats = { shoves: 0, missed: 0, last: null };
  const f = new THREE.Vector3();

  function target() {
    const me = ctx.me; if (!me) return null;
    const yaw = me.yaw ?? 0;
    f.set(Math.sin(yaw), 0, Math.cos(yaw));
    let best = null;
    for (const p of ctx.players.list()) {
      if (p === me || p.alive === false || !(p.owned || p.drawn)) continue;
      const dx = p.position.x - me.position.x, dz = p.position.z - me.position.z, dy = p.position.y - me.position.y, d = Math.hypot(dx, dz);
      if (d > P.reach || Math.abs(dy) > 1.6) continue;
      const ang = Math.acos(Math.max(-1, Math.min(1, (dx * f.x + dz * f.z) / (d || 1)))) * 180 / Math.PI;
      if (d > 0.6 && ang > P.arc / 2) continue;
      if (!best || d < best.d) best = { p, d, dx, dz };
    }
    return best;
  }
  // a miss says why, now and then (play-test 2026-10-09: a missed shove gave no feedback at all)
  let saidAt = -9;
  function missSay() {
    const now = ctx.time?.now ?? performance.now() / 1000;
    if (now - saidAt < 2.5) return;
    saidAt = now;
    const me = ctx.me, near = ctx.players.list().some(p => p !== me && p.alive !== false && (p.owned || p.drawn) && Math.hypot(p.position.x - me.position.x, p.position.z - me.position.z) <= P.reach && Math.abs(p.position.y - me.position.y) <= 1.6);
    ctx.ui?.toast?.(near ? 'Face someone to shove them' : 'Nobody close enough to shove');
  }
  function shove() {
    if (cool > 0 || !ctx.me?.controller || ctx.me.alive === false) return;
    cool = P.cooldown;
    ctx.me.act?.('interact', 0.3);
    const t = target();
    if (!t) { stats.missed++; ctx.audio.play('shove-miss', { optional: true, gainDb: -6 }); missSay(); return; }
    // fair play: a player who is down or protected is not pushed
    if (ctx.fair?.blocked?.(t.p, { from: ctx.me })) { stats.missed++; return; }
    const l = Math.hypot(t.dx, t.dz) || 1;
    t.p.push({ x: t.dx / l * P.force, y: P.lift, z: t.dz / l * P.force });
    ctx.net.send('shove:hit', { id: t.p.id });
    ctx.audio.play(P.sound, { at: { x: t.p.position.x, y: t.p.position.y + 1, z: t.p.position.z }, optional: true });
    stats.shoves++; stats.last = { target: t.p.id, d: Math.round(t.d * 100) / 100 };
  }

  return {
    id: 'shove', interacts: false, aimed: false, stats,
    setup() {
      ctx.ui.touchButton?.('shove', P.label, 'right:28px;bottom:160px', down => { held = down; if (down) shove(); });
    },
    update(dt) {
      cool = Math.max(0, cool - dt);
      if (ctx.round?.phase !== 'playing' || ctx.menu?.view || ctx.ui.covered) return;
      if (ctx.input?.keyPressed?.(P.key)) shove();
      void held;
    },
    event(name, d) {
      // the one shoved hears it too (the push itself comes through the kit's routing to the owner)
      if (name === 'hit' && d?.id === ctx.me?.id) ctx.audio.play(P.sound, { optional: true, gainDb: -2 });
    },
    observe: () => ({ cooldown: Math.round(cool * 100) / 100, ...stats }),
    shove,
    dispose() {},
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// The part's manifest (tools/catalog.mjs MANIFEST lists the fields): what `create` composes and refuses by, what the
// catalog tells a pitch, the handlers and traps of the rules.js stub, and verify check 15's sign of life. The tools
// read it in Node; nothing in play does.
// ---------------------------------------------------------------------------------------------------------------------
export const manifest = {
  id, examples, params,
  describe: 'A key or a touch button pushes the nearest player in front of you a few blocks away; a push, never a knock-down',
  needs: { parts: [], world: [] },
  uses: [],
  owns: p => [{ res: `input.key.${p.key ?? 'KeyF'}`, why: `the ${p.key ?? 'KeyF'} key shoves (params.key)`, free: 'set shove params.key to another key' }],
  // it keeps no shared state: the push itself goes through the kit's routing to whoever owns the player pushed
  state: { key: null, fields: {}, stats: 'window.__game.controls().mechanics[shove].stats: { shoves, missed, last: { target, d } } (this copy\'s own)' },
  events: [],
  sync: { owner: 'copy', how: 'each copy picks its own player\'s target where it draws them and asks that player\'s owner to push' },
  note: [
    'F (or the touch button) pushes the nearest player in front: nothing to wire, and fair play decides who can be pushed.',
    'It is a nudge with a cooldown, not an attack: it never damages, knocks over or scores.',
    'shove.shove() pushes as the local player would.',
  ],
  stub: {
    as: 'shove',
    worked: 'shove.shove();   // pushes as the local player would; the kit already reads the key and the touch button',
    traps: ['a shove reaches only players this copy draws within reach and in front: do not use it to move bots or props'],
  },
  signs: {
    // reported, never failed on its own: a round where nobody shoves is a round
    reportOnly: true,
    sample: (sh, stats) => { const s = stats('shove'); return s ? { shove: [s.shoves ?? 0, s.missed ?? 0] } : null; },
    judge: v => {
      let n = null;
      for (const p of v.pages) for (const s of p.samples) { const x = s.sh?.shove; if (x) n = Math.max(n ?? 0, x[0]); }
      v.add('a shove lands', n ? 'ok' : 'note', 'controls().mechanics[shove].stats.shoves (the local player\'s)', n === null ? 'the shove was not seen on these pages' : n ? `${n} landed` : 'the local player shoved nobody on these pages');
    },
  },
};
