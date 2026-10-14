// loop: endless (open builder M4-C). A session with no end clock: it goes on until the game says it is over (everyone
// has fallen, a target is reached, the players stop) and the score only grows. The same shape as the timed round
// (kit/loops/round) without the clock: rules.check, asked ten times a second, is the only end. config/game.json →
// round.seconds is not written for an endless game; when someone sets it, it is a cap on the session (verify sets one
// for its short run; a creator may want one).
export const id = 'endless';
export const params = { type: 'object', additionalProperties: false, properties: {} };

export function create(ctx, P, S) {
  const { round, R, rules } = S;
  let checkAcc = 0;
  const capped = () => Number.isFinite(R.seconds);
  return {
    id,
    hostTick(dt) {
      round.clock += dt;
      if (capped() && R.seconds - round.clock <= 0) S.enterResults(null, 'time');
      else if ((checkAcc += dt) >= 0.1) {
        checkAcc = 0;
        let r = null; try { r = rules.check?.(ctx) ?? null; } catch (e) { console.error(e); }
        if (r) S.enterResults(Array.isArray(r.winners) ? r.winners : null, r.reason ?? 'over');
      }
    },
    /** The HUD shows no clock (Infinity) unless the session is capped. */
    hudLeft: () => (capped() ? Math.max(0, R.seconds - round.clock) : Infinity),
    observe: () => ({ id, capped: capped(), seconds: Math.round(round.clock) }),
  };
}

// The part's manifest (tools/catalog.mjs LOOP_MANIFEST lists the fields). The tools read it in Node; nothing in play does.
export const manifest = {
  id, params,
  describe: 'A session with no end clock: it goes on until the game says it is over, and the score only grows',
  seconds: 'cap',
  seats: { alone: 'fill', late: 'join', why: 'alone, bots fill every empty seat up to players.max; with friends the room decides who plays' },
  needs: { parts: [], world: [] },
  state: { key: null, fields: {} },
  events: [
    { name: 'check', on: 'host', args: '(ctx) → null | { winners: [playerId], reason }', when: 'ten times a second: is it over? Nothing else ends an endless session' },
  ],
  sync: { owner: 'host', how: 'the host owns the phase, the end and the winners; every other copy shows them' },
  note: [
    'There is no clock: check(ctx) is the only end. Return { winners, reason } when everyone is down, a target is reached or nobody is left; never return null for ever.',
    'ctx.time.left is Infinity and the HUD shows no timer; ctx.time.round still counts the seconds played (make it harder with it).',
  ],
  stub: {
    as: 'endless',
    worked: 'check(ctx) { const up = ctx.players.list().filter(p => p.alive); return up.length ? null : { winners: [], reason: \'lost\' }; }',
    traps: [
      'a game whose check() can never be true never ends: with friends the party page stops it after an hour',
      'do not read ctx.time.left as seconds remaining: it is Infinity here',
    ],
  },
  signs: {
    pulse: null,       // verify check 12 reads the scores, as in a timed round: an endless score must still move
    sample: () => null,
    judge: () => {},
    // a check's short run: the cap the check sets on round.seconds is this flow's whole length, nothing more to cut
    short: () => [],
  },
};
