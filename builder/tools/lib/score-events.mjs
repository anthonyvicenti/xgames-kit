// verify gate D, measure 12: scores come from counted events (builder/GATES.md). Pure: the pages' event logs
// (kit/core/events.js, window.__game.events()) in, a verdict out; tests/g-gates.test.mjs holds it.
//
// "Something happens" (the old check 12: T1 run 5 shipped a game in which no score ever moved) is the first half; the
// second closes the cheat that half invited: a score that only ticks. Every score change a player gets while the round
// is played must be matched, one to one, by a counted event in the kit's log that names that player (a kill they made,
// a pickup they took, a hit that landed on or by them, a move they played, a gate they passed, the game's own
// ctx.events.count) or by a change of a number a mechanic keeps for them (manifest.counters: paint's share, tag's
// seconds as it), at most BEFORE seconds before it or AFTER after. An event that names no player (a level cleared)
// counts once for each player. A reset to 0 is not a score earned and is never judged.
export const SCORE_LIMITS = { BEFORE: 1.6, AFTER: 0.3, MIN_UNEXPLAINED: 3, SHARE: 0.25 };

/** The counted events and counters of one log: [{t, who: Set(ids) | null (shared), kind}] in time order. */
function candidatesOf(entries) {
  const out = [];
  for (const e of entries) {
    if (e.k !== 'event' && e.k !== 'counter') continue;
    const ids = new Set(Object.values(e.who ?? {}).flat().filter(x => typeof x === 'string'));
    out.push({ t: e.t, who: ids.size ? ids : null, kind: e.k === 'counter' ? `${e.part} counter` : `${e.part}.${e.name}`, i: e.i });
  }
  return out.sort((a, b) => a.t - b.t);
}

/**
 * One page's log. → {changes, explained, unexplained: [{player, t, from, to}], byPlayer: {id: {changes, unexplained}},
 * kinds: {kind: n matched}}
 */
export function traceScores(entries, L = SCORE_LIMITS) {
  const cands = candidatesOf(entries);
  const used = new Map();                     // candidate index → Set(player ids it has explained)
  const scores = entries.filter(e => e.k === 'score' && e.ph === 'playing' && e.to !== 0);
  const byPlayer = {}, unexplained = [], kinds = {};
  let explained = 0;
  for (const s of scores) {
    const pid = s.who?.player;
    const row = byPlayer[pid] ??= { changes: 0, unexplained: 0 };
    row.changes++;
    let hit = -1;
    for (let k = 0; k < cands.length; k++) {
      const c = cands[k];
      if (c.t < s.t - L.BEFORE) continue;
      if (c.t > s.t + L.AFTER) break;
      if (c.who && !c.who.has(pid)) continue;
      const u = used.get(k);
      if (u?.has(pid)) continue;
      hit = k; break;
    }
    if (hit >= 0) {
      if (!used.has(hit)) used.set(hit, new Set());
      used.get(hit).add(pid);
      explained++;
      kinds[cands[hit].kind] = (kinds[cands[hit].kind] ?? 0) + 1;
    } else { row.unexplained++; unexplained.push({ player: pid, t: s.t, from: s.from, to: s.to }); }
  }
  return { changes: scores.length, explained, unexplained, byPlayer, kinds };
}

/**
 * The measure. logs: [{label, entries, me?, dropped?}] (one per page that kept a log); happens: the first half's
 * verdict {ok, detail} (verify's "something happens" reading, as before). → {ok, detail, record}
 */
export function judgeScores({ logs = [], happens = { ok: true, detail: '' } }, L = SCORE_LIMITS) {
  const kept = logs.filter(l => Array.isArray(l?.entries));
  if (!kept.length) {
    return { ok: happens.ok, detail: `${happens.detail}; scores not traced: the game's kit copy keeps no event log (window.__game.events: gf/three/core/events.js), so a score that only ticks is not caught here (upgrade the game)`, record: { traced: false } };
  }
  const pages = kept.map(l => ({ label: l.label, dropped: l.dropped ?? 0, ...traceScores(l.entries, L) }));
  const bad = [];
  for (const pg of pages) for (const [pid, r] of Object.entries(pg.byPlayer)) {
    if (r.unexplained >= L.MIN_UNEXPLAINED && r.unexplained / Math.max(1, r.changes) >= L.SHARE) {
      const first = pg.unexplained.filter(u => u.player === pid).slice(0, 3).map(u => `${u.from} → ${u.to} at ${u.t} s`).join(', ');
      bad.push(`on the ${pg.label} page ${pid}'s score changed ${r.changes} times and ${r.unexplained} of them came from no counted event (${first}…): nothing in the kit's log (a kill, a pickup, a hit, a move, a goal, a mechanic's counter, ctx.events.count) named that player within ${L.BEFORE} s before or ${L.AFTER} s after`);
    }
  }
  const changes = pages.reduce((n, p) => n + p.changes, 0), explained = pages.reduce((n, p) => n + p.explained, 0);
  const kinds = {}; for (const p of pages) for (const [k, n] of Object.entries(p.kinds)) kinds[k] = (kinds[k] ?? 0) + n;
  const from = Object.entries(kinds).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, n]) => `${k} ${n}`).join(', ');
  const traced = bad.length === 0;
  const fix = 'A score moves when something the player did happened: a mechanic\'s event (waves killPoints, a pickup\'s score effect, a hit in projectile.onHit), a counter (paint.coverageOf, tag.itSeconds), or the game\'s own counted event through ctx.events.count(player, what). Never add to p.score every frame or on a timer';
  const record = { traced: true, changes, explained, pages: pages.map(p => ({ label: p.label, changes: p.changes, explained: p.explained, unexplained: p.unexplained.length, dropped: p.dropped, byPlayer: p.byPlayer, kinds: p.kinds })), from: kinds };
  if (!happens.ok && !traced) return { ok: false, detail: `${happens.detail} | ${bad.join(' | ')}. ${fix}`, record };
  if (!happens.ok) return { ok: false, detail: happens.detail, record };
  if (!traced) return { ok: false, detail: `a score that only ticks: ${bad.join(' | ')}. ${fix}`, record };
  return { ok: true, detail: `${happens.detail}; every score change came from a counted event (${explained} of ${changes} changes over ${pages.length} pages${from ? `: ${from}` : ''})`, record };
}
