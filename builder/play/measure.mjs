// The play judge's measured parts (builder/play/JUDGE.md): the play feeds of real rounds (kit/core/play.js) and what
// the scripted player could and could not get to, held to the game's play target (spec.play.target, gf-play-target/1)
// or, with none, to the loop's defaults. Pure: no browser.
//
//   const m = measured({ rounds, agents, target, spec });
//   // → { score 0–100 | null, parts: {objective, pace, deadAir, quiet, idle, firstAction, interaction, completion, leads},
//   //     hard: [{part, line}], findings: [{part, line, source: 'measured', hard?}], numbers, want }
//
// Two kinds of finding. HARD ones say the game is not a game yet, whatever its target or taste: objectives nobody can
// reach (all of them, or most: HARD.unreachableShare; or none taken in every round played), or nothing meaningful happening for HARD.deadAir seconds in most
// rounds. They fail gate D's play leg with or without a target. The rest are measured against the target's pacing and
// make the score.
const r1 = v => Math.round(v * 10) / 10, r2 = v => Math.round(v * 100) / 100;
const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
const median = xs => { const v = xs.filter(Number.isFinite).sort((a, b) => a - b); if (!v.length) return null; const m = v.length >> 1; return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2; };
const mean = xs => { const v = xs.filter(Number.isFinite); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };

/** What a game is held to when its spec has no play target: by its loop (the play-design stream's defaults agree). */
export const DEFAULTS = {
  // interactionsPerMinute: what a versus game (spec multiplayer.together) expects with no target; a co-op game's are its
  // target's touchpoints (help, revive), which only the target can name
  round: { firstAction: 10, eventsPerMinute: 6, idleMax: 30, interactionsPerMinute: 1 },
  match: { firstAction: 10, eventsPerMinute: 6, idleMax: 30, interactionsPerMinute: 1 },
  run: { firstAction: 10, eventsPerMinute: 6, idleMax: 30, interactionsPerMinute: 1 },
  endless: { firstAction: 10, eventsPerMinute: 6, idleMax: 30, interactionsPerMinute: 0.5 },
  turns: { firstAction: 20, eventsPerMinute: 2, idleMax: 60, interactionsPerMinute: 0.5 },
  world: { firstAction: 20, eventsPerMinute: 2, idleMax: 60, interactionsPerMinute: 0 },
  saved: { firstAction: 20, eventsPerMinute: 2, idleMax: 60, interactionsPerMinute: 0 },
};
/** The hard lines: never taste. */
export const HARD = { deadAir: 30, unreachableShare: 0.5 };
const FAR_M = 3;
export const WEIGHTS = { objective: 3, pace: 2, deadAir: 2, firstAction: 1, interaction: 1.5, quiet: 1, idle: 0.5, completion: 1, leads: 0.5 };

/** The numbers the game is held to: the target's pacing over the loop's defaults. */
export function wantOf(target, spec = {}) {
  const d = DEFAULTS[spec.loop] ?? DEFAULTS.round, p = target?.pacing ?? {};
  const together = spec.multiplayer?.together ?? null;
  const touch = Array.isArray(target?.touchpoints) ? target.touchpoints.length : null;
  return {
    firstAction: Number.isFinite(p.firstAction) ? p.firstAction : d.firstAction,
    eventsPerMinute: Number.isFinite(p.eventsPerMinute) ? p.eventsPerMinute : d.eventsPerMinute,
    idleMax: Number.isFinite(p.idleMax) ? p.idleMax : d.idleMax,
    // players on each other: the target's touchpoints say they are part of it; with none, a versus game expects them
    interactionsPerMinute: touch === 0 ? 0 : touch ? Math.max(1, d.interactionsPerMinute) : together === 'versus' ? d.interactionsPerMinute : 0,
    comeback: Number.isFinite(p.comeback) ? p.comeback : together === 'versus' ? 0.3 : 0,
    // what a player walks to (the target's reach: walk, the default); a thing hit from afar or that comes to them is not a spot to reach
    things: (target?.objective?.things ?? []).filter(t => ['ground', 'surface', 'zone'].includes(t.placed) && (t.reach ?? 'walk') === 'walk' && (t.count ?? 1) > 0),
  };
}

/** The words a spot's reason is grouped by ("out at sea", "inside the ground"). */
const reasonKey = why => (/outside the play area/.test(why ?? '') ? 'outside the play area' : /sea|water/.test(why ?? '') ? 'out in the sea' : /inside the ground/.test(why ?? '') ? 'inside the ground' : /above the ground/.test(why ?? '') ? 'out of a jump\'s reach above the ground' : why ? why : 'out of reach');

/**
 * rounds: [{label, players, round: <gf-play/1 round>}]; objectives: the feeds' objective lists, all runs ([{id, reach, why,
 * taken, closest, …}]); agents: the scripted player's reports; target: spec.play.target or null; spec: the locked spec.
 */
export function measured({ rounds = [], objectives = [], agents = [], target = null, spec = {} } = {}) {
  const want = wantOf(target, spec), by = target?.pacing ? 'the target' : `the ${spec.loop ?? 'round'} loop's default`;
  const parts = {}, findings = [], hard = [];
  const say = (part, line, extra = {}) => { const f = { part, line, source: 'measured', ...extra }; findings.push(f); if (extra.hard) hard.push(f); };
  const played = rounds.filter(r => r.round && r.round.seconds > 5);
  if (!played.length) {
    say('completion', 'no round was played: the play judge saw no round start (the game did not reach play, or it has no play feed: re-run create to refresh its kit)', { hard: true });
    return { score: 0, parts: { completion: 0 }, hard, findings, numbers: { rounds: 0 }, want };
  }
  // a game's own event its target marks as not meaningful is taken out (the page counts every rules.<name> it logs)
  const notMeant = (target?.events ?? []).filter(e => e && e.meaningful === false).map(e => `rules.${e.name}`);
  const R = played.map(r => {
    const x = r.round, off = notMeant.reduce((a, k) => a + (x.events?.byName?.[k] ?? 0), 0);
    if (!off) return x;
    const m = Math.max(0, (x.events.meaningful ?? 0) - off);
    return { ...x, events: { ...x.events, meaningful: m, perMinute: x.seconds > 0 ? r2(m / (x.seconds / 60)) : 0 } };
  });
  // ---- the objective: present, reachable, taken ----
  const byId = new Map();
  for (const o of objectives) {
    const k = o.id, was = byId.get(k) ?? { id: k, kind: o.kind, taken: 0, reach: null, whys: new Set(), closest: Infinity };
    was.taken += o.taken ?? 0;
    if (o.reach === true && was.reach !== false) was.reach = true; else if (o.reach === false) { was.reach = false; if (o.why) was.whys.add(o.why); }
    if (Number.isFinite(o.closest)) was.closest = Math.min(was.closest, o.closest);
    byId.set(k, was);
  }
  const takenInRounds = R.reduce((a, r) => a + (r.objectives?.takenSpots ?? 0), 0);
  const present = byId.size || Math.max(0, ...R.map(r => r.objectives?.present ?? 0));
  const gaveUp = agents.flatMap(a => (a?.tried ?? []).filter(t => t.gaveUp));
  if (present > 0) {
    const all = [...byId.values()];
    const taken = all.filter(o => o.taken > 0);
    // what a player could get to: taken in play, or reachable by the ground under it and not given up by the player
    // out of reach: never taken, and the ground under it says so, or nobody came within FAR_M of it and the scripted
    // player tried to get there and gave up (a wall, a fence, a cliff: the ground probe cannot tell)
    const triedAndFailed = o => gaveUp.some(g => g.id === o.id) && !(o.closest <= FAR_M);
    const unreach = all.filter(o => o.taken === 0 && (o.reach === false || triedAndFailed(o)));
    const reached = all.filter(o => o.taken > 0 || (o.reach !== false && !triedAndFailed(o)));
    // shares: what a player could get to of every objective seen (all runs), and what was taken of a round's (the mean)
    const rShare = takenInRounds && !reached.length ? 1 / present : reached.length / present;
    const kShare = mean(R.filter(r => (r.objectives?.present ?? 0) > 0).map(r => r.objectives.takenSpots / r.objectives.present)) ?? 0;
    parts.objective = Math.round(100 * Math.sqrt(rShare * clamp(kShare / 0.6)));
    const kinds = [...new Set(all.map(o => o.kind))].join(', ');
    if (unreach.length) {
      const groups = new Map(); for (const o of unreach) { const k = o.reach === false ? reasonKey([...o.whys][0]) : 'that nobody got within 3 m of (the scripted player tried and gave up)'; groups.set(k, (groups.get(k) ?? 0) + 1); }
      say('objective', `${unreach.length} of ${present} objectives (${kinds}) cannot be reached: ${[...groups].map(([k, n]) => `${n} ${k}`).join(', ')}`);
    }
    if (gaveUp.length) say('objective', `the scripted player could not get to ${new Set(gaveUp.map(g => g.id)).size} objective(s) it tried (${gaveUp.slice(0, 3).map(g => `${g.id}: ${g.why}`).join('; ')})`);
    if (!reached.length && takenInRounds === 0) say('objective', `no objective can be reached: all ${present} (${kinds}) are out of a player's reach and nobody took one in ${R.length} round(s)`, { hard: true });
    else if (unreach.length / present > HARD.unreachableShare) say('objective', `most objectives cannot be reached: ${unreach.length} of ${present} (${kinds}) are out of a player's reach (${Math.round(100 * unreach.length / present)}%)`, { hard: true });
    else if (!taken.length && takenInRounds === 0) say('objective', `nobody took an objective in ${R.length} round(s) with bots and the scripted player (${present} ${kinds} out; the player got no closer than ${r1(Math.min(...all.map(o => o.closest)))} m)`, { hard: true });
    else if (kShare < 0.5) say('objective', `only ${taken.length} of ${present} objectives were ever taken`);
  } else if (want.things.length) {
    parts.objective = 0;
    say('objective', `the play target places ${want.things.map(t => `${t.count ?? 'some'} ${t.what}`).join(', ')} in the world, and the game has no objective a player can get to`, { hard: true });
  }
  // ---- pace: meaningful events a minute ----
  const epm = median(R.map(r => r.events?.perMinute ?? 0));
  parts.pace = Math.round(100 * Math.pow(clamp(epm / want.eventsPerMinute), 0.7));
  if (epm < want.eventsPerMinute) say('pace', `${r1(epm)} meaningful events a minute (the median round); ${by} is ${want.eventsPerMinute}`);
  // ---- dead air: the longest stretch with nothing meaningful happening ----
  const gaps = R.map(r => r.events?.longestGap ?? r.seconds);
  const gap = median(gaps), idleMax = Math.max(want.idleMax, 1);
  parts.deadAir = Math.round(100 * clamp(1 - Math.max(0, gap - idleMax) / idleMax));
  // dead air is hard only in a round someone was seen playing: bots fill seats, or the scripted player's presses reached
  // the game (an attempt the log counts: a shot, a throw, a cast). A game whose verbs need a sequence no press of its
  // controls starts (take out the rod, cast, wait for a bite, strike) is said, and the play-tester's report decides it
  const driven = R.filter(r => (r.bots ?? 0) > 0 || (r.events?.byType?.attempt ?? 0) > 0 || (r.events?.meaningful ?? 0) > 0);
  const deadRounds = driven.filter(r => (r.events?.longestGap ?? r.seconds) >= Math.max(HARD.deadAir, want.idleMax));
  if (!driven.length && R.every(r => (r.events?.longestGap ?? r.seconds) >= Math.max(HARD.deadAir, want.idleMax))) say('deadAir', `nothing meaningful happened for ${r1(gap)} s at a stretch, with no bots, and none of the scripted player's presses of this game's controls (${Object.keys(spec.controls ?? {}).join(', ') || 'none listed'}) started anything the log counts: it may need a sequence the scripted player does not follow; the play-tester's report decides`);
  else if (driven.length && deadRounds.length * 2 > driven.length) {
    const none = R.filter(r => (r.events?.meaningful ?? 0) === 0).length;
    say('deadAir', none === R.length ? `nothing meaningful happened in any round: ${R.length} round(s) of ${r1(mean(R.map(r => r.seconds)))} s with no hit, pickup, goal or score` : `nothing meaningful happened for ${r1(gap)} s at a stretch in ${deadRounds.length} of ${driven.length} rounds (the line is ${Math.max(HARD.deadAir, want.idleMax)} s)`, { hard: true });
  } else if (gap > idleMax) say('deadAir', `the longest stretch with nothing meaningful happening is ${r1(gap)} s (${by} allows ${idleMax} s)`);
  // ---- quiet: each player's longest stretch with nothing done by or to them ----
  const quiets = R.flatMap(r => Object.values(r.quiet?.longest ?? {}));
  const q = median(quiets);
  if (q !== null) { parts.quiet = Math.round(100 * clamp(1 - Math.max(0, q - idleMax) / (2 * idleMax))); if (q > idleMax) say('quiet', `a player's longest stretch with nothing done by or to them is ${r1(q)} s (median; ${by} allows ${idleMax} s)`); }
  // ---- idle: players standing still doing nothing ----
  const shares = R.flatMap(r => Object.values(r.idle?.share ?? {}));
  const idle = mean(shares);
  // a turns game is played from the seats: standing still is how it is played (its quiet stretches still count)
  if (idle !== null && spec.loop !== 'turns') { parts.idle = Math.round(100 * clamp(1 - Math.max(0, idle - 0.2) / 0.6)); if (idle > 0.35) say('idle', `players stand still with nothing to do ${Math.round(idle * 100)}% of the time (bots included: make them play the game)`); }
  // ---- the first meaningful action ----
  const firsts = R.map(r => (r.events?.first === null || r.events?.first === undefined ? Infinity : r.events.first));
  const first = median(firsts.map(v => (Number.isFinite(v) ? v : 1e6)));
  parts.firstAction = first >= 1e6 ? 0 : Math.round(100 * clamp(1 - Math.max(0, first - want.firstAction) / (3 * want.firstAction)));
  if (first > want.firstAction) say('firstAction', first >= 1e6 ? 'no meaningful action in the median round' : `the first meaningful action comes ${r1(first)} s in (${by}: ${want.firstAction} s)`);
  // ---- players on each other ----
  const multi = R.filter(r => r.players >= 2);
  // players taking turns at each other with verbs that touch bodies (a hit, a knock, a blast, a tag) are expected to
  // touch each other, as a versus game is
  const touches = R.some(r => ['hit', 'knockout', 'blast', 'tag'].some(k => (r.events?.byType?.[k] ?? 0) > 0));
  if (want.interactionsPerMinute === 0 && touches && spec.multiplayer?.together === 'turns' && !Array.isArray(target?.touchpoints)) want.interactionsPerMinute = DEFAULTS.turns.interactionsPerMinute;
  if (want.interactionsPerMinute > 0 && multi.length) {
    // the mean over rounds (a round at four players may hold every touch), and the rounds that had none, said
    const ipm = mean(multi.map(r => r.interactions?.perMinute ?? 0)), none = multi.filter(r => !(r.interactions?.total > 0)).length;
    parts.interaction = Math.round(100 * Math.pow(clamp(ipm / want.interactionsPerMinute), 0.6));
    if (ipm === 0) say('interaction', 'players never touch each other: no hit, knock, steal or tag between two players in any round');
    else if (ipm < want.interactionsPerMinute) say('interaction', `${r1(ipm)} player-on-player moments a minute (${by}: ${want.interactionsPerMinute})${none ? `; none at all in ${none} of ${multi.length} rounds` : ''}`);
    else if (none * 2 > multi.length) say('interaction', `players touched each other in only ${multi.length - none} of ${multi.length} rounds`);
  }
  // ---- rounds that end in results ----
  const done = R.filter(r => r.done).length;
  parts.completion = Math.round(100 * done / R.length);
  if (done < R.length) say('completion', `${R.length - done} of ${R.length} rounds did not reach results`);
  // ---- the lead changes hands (a game with scores and rivals) ----
  const scored = multi.filter(r => r.outcome && Object.values(r.outcome.scores ?? {}).some(s => s > 0));
  if (want.comeback > 0 && scored.length) {
    const lc = mean(scored.map(r => r.leads?.changes ?? 0));
    parts.leads = Math.round(100 * clamp(lc / 1));
    if (lc < 0.5) say('leads', `the lead changed hands ${r2(lc)} times a round: the first to score keeps it`);
  }
  // the weighted geometric mean: one collapsed part pulls the whole down
  let wsum = 0, lsum = 0;
  for (const [k, v] of Object.entries(parts)) { if (v === null || v === undefined) continue; const w = WEIGHTS[k] ?? 1; wsum += w; lsum += w * Math.log(Math.max(1, v) / 100); }
  const score = wsum ? Math.round(100 * Math.exp(lsum / wsum)) : null;
  const numbers = {
    rounds: R.length, done, eventsPerMinute: r2(epm), longestGap: r1(gap), quietMedian: q === null ? null : r1(q), idleShare: idle === null ? null : r2(idle),
    firstAction: first >= 1e6 ? null : r1(first), interactionsPerMinute: multi.length ? r2(mean(multi.map(r => r.interactions?.perMinute ?? 0))) : null,
    objectives: { present, taken: [...byId.values()].filter(o => o.taken > 0).length, unreachable: [...byId.values()].filter(o => o.taken === 0 && o.reach === false).length },
    byType: R.reduce((a, r) => { for (const [k, v] of Object.entries(r.events?.byType ?? {})) a[k] = (a[k] ?? 0) + v; return a; }, {}),
  };
  return { score, parts, hard, findings, numbers, want };
}
