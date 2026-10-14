// loop: round (open builder M4-C). The timed round every game ran before a flow was a part: everyone plays at once,
// one clock (config/game.json → round.seconds), the rules may end it sooner (rules.check, asked ten times a second),
// then results and play again. The session (kit/net/session.js) keeps the lobby, the countdown, the results, the
// replay and the net; a flow owns what happens while the phase is 'playing'. This one is the session's default: a game
// whose config names no flow (every game made before 2026-10-11) runs it, and it does exactly what the session did.
//
// A flow module (kit/loops/<id>/index.js) exports: id, params (JSON Schema of round.params), manifest, an optional
// botsAlone(players) and create(ctx, params, session) → the hooks the session and the boot call (kit/loops/README.md).
export const id = 'round';
export const params = { type: 'object', additionalProperties: false, properties: {} };

export function create(ctx, P, S) {
  const { round, R, rules } = S;
  let checkAcc = 0;
  return {
    id,
    /** Host, every frame while the phase is 'playing': the round clock, then the rules' own end. */
    hostTick(dt) {
      round.clock += dt;
      if ((R.seconds ?? 120) - round.clock <= 0) S.enterResults(null, 'time');
      else if ((checkAcc += dt) >= 0.1) {
        checkAcc = 0;
        let r = null; try { r = rules.check?.(ctx) ?? null; } catch (e) { console.error(e); }
        if (r) S.enterResults(Array.isArray(r.winners) ? r.winners : null, r.reason ?? 'won');
      }
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// The part's manifest (tools/catalog.mjs LOOP_MANIFEST lists the fields). The tools read it in Node; nothing in play does.
// ---------------------------------------------------------------------------------------------------------------------
export const manifest = {
  id, params,
  describe: 'One timed round: everyone plays at once, the clock or the rules end it, then results and play again',
  seconds: 'required',
  seats: { alone: 'fill', late: 'join', why: 'alone, bots fill every empty seat up to players.max; with friends the room decides who plays' },
  needs: { parts: [], world: [] },
  state: { key: null, fields: {} },
  events: [
    { name: 'roundStart', on: 'every copy', args: '(ctx)', when: 'the round starts (the same moment for everyone)' },
    { name: 'check', on: 'host', args: '(ctx) → null | { winners: [playerId], reason }', when: 'ten times a second: is the round over before the clock?' },
    { name: 'results', on: 'every copy', args: '(ctx) → [{ id, name, value }]', when: 'the round ended: the rows of the results card' },
  ],
  sync: { owner: 'host', how: 'the host owns the phase, the clock, the end and the winners; every other copy shows them' },
  note: ['Everyone acts at once for round.seconds; the most points wins unless check(ctx) names winners sooner.'],
  stub: null,      // the six hooks every rules.js already has are this flow's
  signs: {
    // what "something happens" is in a timed round (verify check 12): a score that moved. The check's own reading.
    pulse: null,
    sample: () => null,
    judge: () => {},
    short: () => [],
  },
};
