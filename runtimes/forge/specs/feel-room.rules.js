// rules.js: THE GAME AGENT'S FILE. Feel Room (gf-forge track F's test room; runtimes/forge/specs/feel-room.spec.json,
// copied in after create as rules.js; not a game for anyone): hello forge's crypt room with target dummies that break into
// bones, a weapon pickup cycle, a corner that hurts, so every weapon and move of forge-feel can be tried in a browser.
//
// Win: nothing; the round runs ten minutes. Scoring: +1 for each broken dummy, times the combo multiplier; +1 a coin.
// Death (stand in the far right corner, or press H): the hard cut to the results, with the death recap.
//
// The core (forge-feel) does the feel; gf/forge/feel.js (the kit) draws its DOM side; the renderer draws the rest
// (since the wave 1b integration: the dummies as skinned bodies, the pieces, coins and pickups, the event lights, the
// hit flash, the weapon in hand with its kick, sway, bob, reload and swing: gf/forge/fight.js and forge-web glue.rs).
// Track F's own stand-in drawing, which this file carried until then, is gone.
import { FEEL_OP } from './gf/forge/feel.js';

// [x, z, yaw, hit points, seconds before it stands again]: three out in the room, a tight group of three (debris from
// one knocks the others down), one far off for the repeater
const P = Math.PI;   // facing the spawns (a yaw of 0 faces −Z, away from them)
const DUMMIES = [[0, 0.5, P, 60, 3], [-3.2, -1.6, P, 60, 3], [3.4, -2.2, P, 90, 3], [-0.5, -4.4, P, 40, 4], [0.5, -4.4, P, 40, 4], [0, -5.3, P, 40, 4], [5.2, -5.6, P, 200, 4]];
// [weapon id, x, z, seconds before it is back]
const PICKUPS = [['scatter', -5.2, 3.6, 4], ['repeater', 5.2, 3.6, 4], ['blade', -5.2, -3.2, 4]];
const HURT_AT = [6.4, -6.4], HURT_R = 1.6, HURT_EVERY = 0.45, HURT = 9;

const coreId = ctx => ctx.feel?.view().player || 1;

export default {
  setup(ctx) {
    ctx.ui.goal?.('Break the dummies. Pick up weapons (1-4), V: melee, Shift: evade, R: reload, H: hurt yourself');
    ctx.room = { spawned: false, hurtT: 0 };
  },
  roundStart(ctx) {
    for (const p of ctx.players.list()) p.score = 0;
    const host = ctx.forge;
    if (!ctx.room.spawned) {
      ctx.room.spawned = true;
      for (const [x, z, yaw, hp, every] of DUMMIES) host.cmd.raw(FEEL_OP.DUMMY, [], [x, 0, z, yaw, hp, every]);
      for (const [id, x, z, every] of PICKUPS) {
        const row = (ctx.tables.weapons ?? []).findIndex(w => w.id === id);
        if (row >= 0) host.cmd.raw(FEEL_OP.PICKUP, [row], [x, 0, z, every]);
      }
    }
    host.cmd.raw(FEEL_OP.RESET, [coreId(ctx)]);
  },
  update(ctx, dt) {
    const room = ctx.room;
    if (!ctx.host || ctx.round.phase !== 'playing') return;
    const me = ctx.me;
    if (!me || me.alive === false) return;
    // the far right corner hurts while you stand in it; H hurts at once
    room.hurtT -= dt;
    const inCorner = Math.hypot(me.position.x - HURT_AT[0], me.position.z - HURT_AT[1]) < HURT_R;
    if ((inCorner && room.hurtT <= 0) || ctx.input?.keyPressed?.('KeyH')) {
      room.hurtT = HURT_EVERY;
      ctx.forge.cmd.damage(coreId(ctx), HURT + (inCorner ? 0 : 3), 0, [0, 0, 1]);
    }
  },
  event(ctx, name, data) {
    if (data?.remote) return;
    const me = ctx.me;
    if (name === 'kill' && me && data.entity === coreId(ctx)) me.score += Math.round(data.c * 10) / 10;
    if (name === 'coin' && me && data.entity === coreId(ctx)) me.score += data.a;
    if (name === 'player-dead' && data.entity === coreId(ctx)) ctx.round.end('lost', []);
  },
  check() { return null; },
  results(ctx) { return ctx.players.list().map(p => ({ id: p.id, name: p.name, value: Math.round(p.score * 10) / 10 })); },
  // QA (CONTRACT §6b): the feel's state as the room sees it
  observe(ctx) {
    const v = ctx.feel?.view();
    return v ? { weapon: v.weapon, ammo: v.ammo, combo: v.combo, kills: v.kills, debris: v.debris, tint: v.tint, stage: v.stage, fight: ctx.fight?.observe?.() ?? null } : null;
  },
};
