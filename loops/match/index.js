// loop: match (open builder M4-C). A match of several short rounds with the rounds won counted: best of N, or first to
// N. Each round is a timed round (round.seconds, rules.check may end it sooner; whoever leads it takes it); between two
// rounds there is a short pause while every screen says who took the last one, then the mechanics, the players and the
// scores go back to a round's start and rules.roundStart runs again. The match ends when someone has the wins it
// takes, or the rounds run out; the results card then shows the rounds each player won.
//
// The same hooks as a timed round (roundStart, check, results). ctx.round.end(reason, winners) from the rules or a
// mechanic ends the round being played, not the match. p.score is the round's score while it is played and the rounds
// won once the match is over; ctx.match.wins(p), ctx.match.round and ctx.match.rounds say where the match stands.
export const id = 'match';
const D = { rounds: 3, winsToWin: 0, between: 3, textRound: 'Round {n}', textTook: '{name} takes round {n}', textNobody: 'Nobody takes round {n}' };
export const params = { type: 'object', additionalProperties: false, properties: {
  rounds: { type: 'integer', minimum: 1, maximum: 15, default: D.rounds, description: 'The most rounds a match has (best of this many)' },
  winsToWin: { type: 'integer', minimum: 0, maximum: 15, default: D.winsToWin, description: 'Rounds a player must win to take the match (0: more than half of rounds)' },
  between: { type: 'number', minimum: 0, maximum: 15, default: D.between, description: 'Seconds between two rounds, while every screen says who took the last one' },
  textRound: { type: 'string', maxLength: 40, default: D.textRound, description: 'Banner when a round starts ({n})' },
  textTook: { type: 'string', maxLength: 40, default: D.textTook, description: 'Banner when a round is won ({name}, {n})' },
  textNobody: { type: 'string', maxLength: 40, default: D.textNobody, description: 'Banner when nobody took a round ({n})' },
} };

export function create(ctx, params, S) {
  const P = { ...D, ...params };
  const { round, R, rules, players } = S;
  const kebab = k => k.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`);
  const V = k => { const sid = `round.${kebab(k)}`; try { return ctx.assets?.has?.(sid) ? ctx.assets.value(sid, P[k]) : P[k]; } catch { return P[k]; } };
  // r: the round being played (1 first) · ph: 'play' | 'between' · w: { playerId: rounds won } · last: who took the
  // last round · s: rounds that ended with somebody ahead on points
  const M = ctx.shared.register('match', { r: 1, ph: 'play', w: {}, last: [], s: 0 });
  let checkAcc = 0, pause = 0, shown = '';
  const need = () => (V('winsToWin') > 0 ? V('winsToWin') : Math.floor(V('rounds') / 2) + 1);
  const winsOf = pid => M.w?.[pid] ?? 0;
  /** Host: the round being played is over. */
  function endRound(winners, reason) {
    if (round.phase !== 'playing' || M.ph !== 'play') return;
    const took = Array.isArray(winners) ? winners : S.topScorers();
    const w = { ...M.w }; for (const pid of took) w[pid] = (w[pid] ?? 0) + 1;
    M.w = w; M.last = [...took]; if (took.length) M.s += 1;
    const best = Math.max(0, ...Object.values(w));
    if (best >= need() || M.r >= V('rounds')) {
      // the match is over: the card shows the rounds each player won
      for (const p of players.list()) p.score = winsOf(p.id);
      const top = players.list().filter(p => best > 0 && winsOf(p.id) === best).map(p => p.id);
      S.enterResults(top, reason === 'ended' ? 'ended' : 'match');
    } else { M.ph = 'between'; pause = V('between'); }
  }
  const api = {
    id,
    /** The round being played (1 first), the most a match has, and the wins it takes. */
    get round() { return M.r; }, get rounds() { return V('rounds'); }, get winsToWin() { return need(); },
    get between() { return M.ph === 'between'; },
    /** Rounds a player has won. */
    wins: p => winsOf(typeof p === 'string' ? p : p?.id),
    begin() { checkAcc = 0; pause = 0; shown = ''; if (ctx.host) Object.assign(M, { r: 1, ph: 'play', w: {}, last: [], s: 0 }); },
    reset() { checkAcc = 0; pause = 0; shown = ''; },
    end(reason, winners) { endRound(winners, reason); },
    hostTick(dt) {
      if (M.ph === 'between') {
        if ((pause -= dt) > 0) return;
        M.r += 1; M.ph = 'play'; checkAcc = 0;
        S.restart({ keep: ['match'] });
        return;
      }
      round.clock += dt;
      if ((R.seconds ?? 120) - round.clock <= 0) endRound(null, 'time');
      else if ((checkAcc += dt) >= 0.1) {
        checkAcc = 0;
        let r = null; try { r = rules.check?.(ctx) ?? null; } catch (e) { console.error(e); }
        if (r) endRound(Array.isArray(r.winners) ? r.winners : null, r.reason ?? 'won');
      }
    },
    /** Every copy: say who took a round and when the next begins; a copy that is not the host starts it too. */
    frame() {
      if (round.phase !== 'playing') { shown = ''; return; }
      const key = `${M.r}:${M.ph}`;
      if (key === shown) return;
      const was = shown; shown = key;
      if (M.ph === 'between') {
        const names = (M.last ?? []).map(pid => players.get(pid)?.name ?? pid);
        ctx.ui?.banner?.(String(names.length ? V('textTook') : V('textNobody')).replace('{name}', names.join(' & ')).replace('{n}', M.r), Math.max(1.2, V('between')));
        ctx.audio?.play('round-end', { optional: true });
      } else if (was) {
        if (!ctx.host) S.restart();
        ctx.ui?.banner?.(String(V('textRound')).replace('{n}', M.r), 1.2);
        ctx.audio?.play('round-go', { optional: true });
      }
    },
    observe: () => ({ id, round: M.r, rounds: V('rounds'), winsToWin: need(), between: M.ph === 'between', wins: { ...M.w }, scored: M.s }),
  };
  ctx.match = api;
  return api;
}

// The part's manifest (tools/catalog.mjs LOOP_MANIFEST lists the fields). The tools read it in Node; nothing in play does.
export const manifest = {
  id, params,
  describe: 'A match of several short rounds with the rounds won counted: best of N or first to N; everything goes back to a round\'s start between two',
  seconds: 'required',
  seats: { alone: 'fill', late: 'join', why: 'alone, bots fill every empty seat up to players.max; with friends the room decides who plays' },
  needs: { parts: [], world: [] },
  state: { key: 'match', fields: { r: 'the round being played (1 first)', ph: '"play" or "between" (the pause after a round)', w: '{ playerId: rounds won }', last: 'ids of who took the last round', s: 'rounds that ended with somebody ahead' } },
  events: [
    { name: 'roundStart', on: 'every copy', args: '(ctx)', when: 'each round of the match starts (scores, p.data and the mechanics are back at a round\'s start)' },
    { name: 'check', on: 'host', args: '(ctx) → null | { winners: [playerId], reason }', when: 'ten times a second: is this round over before its clock? The match counts the win' },
    { name: 'results', on: 'every copy', args: '(ctx) → [{ id, name, value }]', when: 'the match is over: p.score is now the rounds each player won' },
  ],
  sync: { owner: 'host', how: 'the host owns each round, the wins and the end of the match; every other copy shows them and restarts its own player with the round' },
  note: [
    'Write one short round as for a timed round; the kit plays it again, counts who took each one (ctx.match.wins(p)) and ends the match at round.params.winsToWin or after round.params.rounds.',
    'Everything a round sets up goes in roundStart(ctx): it runs at the start of every round of the match, after scores, p.data and ctx.shared are back at their start.',
  ],
  stub: {
    as: 'match',
    worked: 'roundStart(ctx) { ctx.ui.toast(`Round ${ctx.match.round} of ${ctx.match.rounds}`); }',
    traps: [
      'ctx.round.end(reason, winners) ends the round being played, not the match',
      'state the rules keep outside ctx.shared and p.data is not put back between rounds: reset it in roundStart',
      'results(ctx) should show p.score (the rounds won when the match is over), not a round\'s points',
    ],
  },
  signs: {
    // r: the round, between: 1 in the pause, s: rounds somebody took on points
    sample: sh => (sh.match ? { match: [sh.match.r ?? 1, sh.match.ph === 'between' ? 1 : 0, sh.match.s ?? 0] } : null),
    judge: v => {
      let r = 0, s = 0, seen = false;
      for (const p of v.pages) for (const x of p.samples) { const m = x.sh?.match; if (!Array.isArray(m)) continue; seen = true; r = Math.max(r, m[0]); s = Math.max(s, m[2]); }
      if (!seen) return;
      if (r >= 2) v.add('the next round starts', 'ok', 'shared.match.r', `round ${r} of the match was reached${s ? `; ${s} round${s === 1 ? '' : 's'} had someone ahead` : ''}`);
      else v.add('the next round starts', 'note', 'shared.match.r', `no page played long enough for a second round (${v.names})`);
    },
    // verify check 12, "something happens", for this flow: a round of the match ended with somebody ahead on points
    pulse: { what: 'rounds of the match somebody took on points', min: 1, of: snapshot => snapshot?.flow?.scored ?? 0, fix: 'every round of the match ended with no score above 0: check the score code in rules.update against each mechanic\'s API, and that rules.bot makes bots act' },
    // a check's short run of `seconds`: two rounds and the pause between them fit in it
    short: seconds => [{ file: 'config/game.json', pointer: '/round/params/rounds', value: 2 }, { file: 'config/game.json', pointer: '/round/params/winsToWin', value: 0 }, { file: 'config/game.json', pointer: '/round/params/between', value: 2 }, { file: 'config/game.json', pointer: '/round/seconds', value: Math.max(5, Math.floor((seconds - 3) / 2)) }],
  },
};
