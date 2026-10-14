// verify check 10: fair play. Does the local player stay in control when bots play for real?
//
// Two solo pages at once (real keys and mouse, three bots, no ?gf-calm): one stands where it spawned and fights (turns,
// sprays or throws in bursts, picks things up), one wanders and sprays (holds W, turns now and then). Each samples the
// observation every 100 ms for `seconds` of play. Measured on the local player while alive (time out after a knock-out
// is counted apart): the share of time in control, the longest stretch without control, and, for every player, a knock
// that lands while they are protected. Creator feedback that made this check (Bladder Wars, 2026-10-06): "people kept
// knocking me down and I couldnt get up. The knock down timer was also pretty long."
//
// Fails when, on either page: the longest stretch without control while alive > fair.downSeconds + 1 s; a protected
// player is knocked; or the player is in control < 85% of the time alive. Bot score balance is reported, never failed.
// The detail names the numbers and what to change, because the build agent repairs from it.
//
// Time (tools/lib/stepped.mjs): each page runs on stepped time when the game's kit offers it. The 42 s are then the
// game's own seconds, let by 100 ms at a time between the scripted human's real keys and clicks, and a sample's `wall`
// is the game time since the round was taken up (it was the wall clock, which is the same thing at 60 frames a second
// and not on a slow machine). An older kit runs on the wall clock, as before; the record's `clock` says which.
import { prepareStepped, stepUrl, clockFor, mouseTaken } from './stepped.mjs';
import { DOWN_WORDS } from '../../../runtimes/three/kit/core/fair-logic.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const r1 = v => Math.round(v * 10) / 10;
/** Check 12: a score must stay moved this long on a page to count as "something happens". */
export const PULSE_HOLD_SECONDS = 1.5;
/** …and some player's score must climb at least this far above where it started. */
export const PULSE_MIN_PEAK = 2;
export const FAIR_LIMITS = { slackSeconds: 1, minControlPct: 85, protectSlack: 0.25 };

/** A small seeded stream for the scripted human (the same moves every run). */
function stream(seed) { let s = seed >>> 0 || 1; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

/** What one sample keeps: the phase, the round clock, fair play's summary and every player's state. */
const SAMPLE = () => {
  const s = window.__game?.snapshot?.(); if (!s) return null;
  return { phase: s.phase, t: s.time?.round ?? 0, fair: s.fair ?? null, players: s.players.map(p => ({ id: p.id, name: p.name, local: p.local, bot: p.bot, alive: p.alive, anim: p.anim, score: p.score, control: p.control, down: p.down, protected: p.protected, pl: p.pl })) };
};

/**
 * How long a page plays on, past its `seconds`, while no score has moved yet: up to the game's own round, at most
 * this. A game whose first score comes late by its own design (a race scored at the finish line, a match's first goal)
 * is given the time its round gives it, so no game is tuned to the check's clock (the rules audit, 2026-10-14: a
 * race's bots were made faster than a new player could enjoy so one finished inside the old fixed window).
 */
export const PLAY_ON_MAX_SECONDS = 150;
/** The seconds a page may play for this game: its own round when longer than `seconds`, capped. */
export const playOnFor = (game, seconds) => Math.max(seconds, Math.min(PLAY_ON_MAX_SECONDS, Number(game?.round?.seconds) || 0));

/** One page: play `seconds` as `mode` ('stand' | 'wander'), and on up to `upTo` while no score has moved; the samples. */
async function playPage({ newPage, url, seed, mode, seconds, upTo = seconds, log, stepped = true }) {
  const T = await newPage(`fair ${mode}`, { overrides: { patches: [{ file: 'config/game.json', pointer: '/round/seconds', value: Math.ceil(Math.max(seconds, upTo)) + 8 }] } });
  const p = T.page, rnd = stream(seed * 7919 + (mode === 'stand' ? 1 : 2));
  const samples = [];
  let clock = null;
  try {
    if (stepped) await prepareStepped(p);
    await p.goto(stepped ? stepUrl(`${url}?seed=${seed}&bots=3`) : `${url}?seed=${seed}&bots=3`, { waitUntil: 'load' });
    const t0 = Date.now();
    while ((await p.evaluate(() => window.__game?.phase ?? null).catch(() => null)) !== 'lobby') { if (Date.now() - t0 > 90000) throw new Error('no lobby in 90 s'); await sleep(250); }
    const play = await p.locator('#gf-play').boundingBox().catch(() => null);
    if (play) await p.mouse.click(play.x + play.width / 2, play.y + play.height / 2); else await p.keyboard.press('Enter');
    clock = await clockFor(p, { real: !stepped });
    const t1 = clock.now();
    while ((await p.evaluate(() => window.__game?.phase ?? null).catch(() => null)) !== 'playing') { if (clock.now() - t1 > 20000) throw new Error('the round did not start'); await clock.wait(150); }
    await p.mouse.click(640, 400);
    if (clock.stepped) await mouseTaken(p);
    if (mode === 'wander') await p.keyboard.down('KeyW');
    let k = 0, firing = false;
    const start = clock.now();
    // past `seconds`, only while nothing has scored yet (checked once a second), up to `upTo`
    const more = () => { const t = (clock.now() - start) / 1000; return t < seconds || (t < upTo && (k % 10 !== 0 || !measure(samples).scoreMoved)); };
    while (more()) {
      const s = await p.evaluate(SAMPLE).catch(() => null);
      if (!s) break;
      samples.push({ ...s, wall: (clock.now() - start) / 1000 });
      if (s.phase !== 'playing') break;
      k++;
      // the scripted human: turn now and then, fire in bursts, pick things up, jump once in a while
      if (k % (mode === 'wander' ? 15 : 7) === 0) await p.mouse.move(640 + (rnd() - 0.5) * (mode === 'wander' ? 320 : 180), 400 + (rnd() - 0.5) * 30, { steps: 3 });
      if (k % 20 === 0) { await p.mouse.down(); firing = true; }
      if (k % 20 === (mode === 'wander' ? 10 : 14) && firing) { await p.mouse.up(); firing = false; }
      if (k % 30 === 5) await p.keyboard.press('KeyE');
      if (mode === 'wander' && k % 45 === 22) await p.keyboard.press('Space');
      await clock.wait(100);
    }
    if (firing) await p.mouse.up().catch(() => {});
    if (mode === 'wander') await p.keyboard.up('KeyW').catch(() => {});
  } finally {
    const errors = T.errors.slice();
    await T.ctx.close().catch(() => {});
    T.errorsAtEnd = errors;
  }
  return { mode, seed, samples, errors: T.errorsAtEnd, clock: clock?.stepped ? 'stepped' : 'wall' };
}

/** The numbers for one page's samples. */
export function measure(samples, { downSeconds = 1.2 } = {}) {
  const fairObs = samples.some(s => s.players?.some(p => typeof p.control === 'boolean'));
  const ctl = p => (typeof p.control === 'boolean' ? p.alive !== false && p.control : p.alive !== false && !DOWN_WORDS.has(p.anim));
  let alive = 0, inCtl = 0, out = 0, cur = 0, longest = 0, longestAt = null, curFrom = 0, knocks = 0, deaths = 0;
  const words = [];
  const violations = [];
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1], b = samples[i];
    const dt = Math.max(0, Math.min(1, b.wall - a.wall));
    const me = b.players.find(p => p.local), was = a.players.find(p => p.local);
    if (!me || !was) continue;
    if (me.alive === false) { out += dt; if (was.alive !== false) deaths++; cur = 0; continue; }
    alive += dt;
    if (ctl(me)) { inCtl += dt; cur = 0; }
    else {
      if (cur === 0) { curFrom = a.t; if (ctl(was) && was.alive !== false) knocks++; }
      cur += dt;
      if (cur > longest) { longest = cur; longestAt = { from: curFrom, to: b.t }; }
    }
    // a knock on a protected player (any player): protected with time left, then down while alive
    for (const q of b.players) {
      const pq = a.players.find(x => x.id === q.id); if (!pq) continue;
      if (pq.protected && (pq.pl ?? 1) >= FAIR_LIMITS.protectSlack && q.down && q.alive !== false && pq.alive !== false) violations.push({ id: q.id, name: q.name, at: r1(b.t), left: pq.pl });
    }
  }
  // the worst stretch, as the words the local player carried (for the repair detail)
  if (longestAt) {
    let last = '';
    for (const s of samples) { if (s.t < longestAt.from - 0.05 || s.t > longestAt.to + 0.05) continue; const me = s.players.find(p => p.local); const w = me?.alive === false ? 'out' : me?.anim; if (w && w !== last) { words.push(`${r1(s.t)} ${w}`); last = w; } }
  }
  const end = samples.at(-1);
  // the pulse (verify check 12): did a score move and stay moved for a while (a point that flickers for a frame and is
  // wiped by the rules is not a game: the never-again example dead-scoring found that on 2026-10-07)
  const first = new Map((samples[0]?.players ?? []).map(p => [p.id, p.score ?? 0]));
  let held = 0, heldMax = 0;
  for (let i = 1; i < samples.length; i++) {
    const moved = samples[i].players?.some(p => (p.score ?? 0) !== (first.get(p.id) ?? 0));
    held = moved ? held + Math.max(0, Math.min(1, samples[i].wall - samples[i - 1].wall)) : 0;
    heldMax = Math.max(heldMax, held);
  }
  const peak = Math.max(0, ...samples.flatMap(s => (s.players ?? []).map(p => (p.score ?? 0) - (first.get(p.id) ?? 0))));
  // scores in a real round build up; a broken one flickers between 0 and the 1 point a pickup gives before the rules
  // wipe it (the flicker held 1.9–2.6 s on 2026-10-07, so time alone can't tell them apart)
  // a round the game itself ended with a score built up (a race won at the line) keeps that score on its results: it is
  // held however late in the page it came
  const endedScored = !!end && !['playing', 'lobby', 'countdown'].includes(end.phase) && (end.players ?? []).some(p => (p.score ?? 0) - (first.get(p.id) ?? 0) >= PULSE_MIN_PEAK);
  const scoreMoved = (heldMax >= PULSE_HOLD_SECONDS || endedScored) && peak >= PULSE_MIN_PEAK;
  const maxScore = Math.max(0, ...samples.flatMap(s => (s.players ?? []).map(p => p.score ?? 0)));
  return {
    scoreMoved, scoreHeldSec: Math.round(heldMax * 10) / 10, maxScore,
    observed: r1(samples.length ? end.wall - samples[0].wall : 0), aliveSec: r1(alive), outSec: r1(out), deaths, knocks,
    controlPct: alive > 0 ? r1(100 * inCtl / alive) : 0, longestNoControlSec: r1(longest), longestAt: longestAt ? { from: r1(longestAt.from), to: r1(longestAt.to), words } : null,
    protectedKnocked: violations, fairObserved: fairObs,
    scores: (end?.players ?? []).map(p => ({ name: p.name, bot: p.bot, local: p.local, score: p.score })),
    fair: end?.fair ?? null,
  };
}

/**
 * Check 10. newPage(label, {overrides}) → {ctx, page, errors} (verify's own); url: the served game. → {ok, detail, record}
 */
export async function checkFairPlay({ newPage, url, seconds = 42, game = null, log = () => {}, stepped = true }) {
  const upTo = playOnFor(game, seconds);
  const runs = await Promise.all([
    playPage({ newPage, url, seed: 11, mode: 'stand', seconds, upTo, log, stepped }),
    playPage({ newPage, url, seed: 7, mode: 'wander', seconds, upTo, log, stepped }),
  ]);
  const pages = runs.map(r => {
    const downSeconds = r.samples.at(-1)?.fair?.downSeconds ?? 1.2;
    const m = measure(r.samples, { downSeconds });
    const limit = r1(downSeconds + FAIR_LIMITS.slackSeconds);
    const fails = [];
    const ended = r.samples.at(-1)?.phase === 'results';
    if (!r.samples.length || (m.aliveSec < 10 && !ended)) fails.push(`only ${m.aliveSec} s of play observed (the page stalled or never started the round)`);
    if (m.longestNoControlSec > limit) fails.push(`the player was out of control for ${m.longestNoControlSec} s at once while alive (limit ${limit} s = downSeconds ${downSeconds} + ${FAIR_LIMITS.slackSeconds}; ${m.longestAt.from}–${m.longestAt.to} s: ${m.longestAt.words.join(', ')})`);
    if (m.controlPct < FAIR_LIMITS.minControlPct) fails.push(`the player was in control ${m.controlPct}% of the time alive (needs ${FAIR_LIMITS.minControlPct}%; ${m.knocks} knocks in ${m.aliveSec} s)`);
    if (m.protectedKnocked.length) fails.push(`${m.protectedKnocked.length} knock(s) landed on protected players (${m.protectedKnocked.slice(0, 3).map(v => `${v.name} at ${v.at} s with ${v.left} s left`).join(', ')})`);
    if (!m.fairObserved) fails.push('the observation has no fair-play fields (players[].control, down, protected): the game\'s kit predates fair play; re-run create to refresh gf/three');
    return { mode: r.mode, seed: r.seed, clock: r.clock, ...m, limit, fails, errors: r.errors.slice(0, 3) };
  });
  const ok = pages.every(p => p.fails.length === 0);
  const line = p => `${p.mode} (seed ${p.seed}): in control ${p.controlPct}% of ${p.aliveSec} s alive, longest without control ${p.longestNoControlSec} s (limit ${p.limit}), ${p.knocks} knocks, ${p.deaths} knock-outs (${p.outSec} s out)${p.protectedKnocked.length ? `, ${p.protectedKnocked.length} protected players knocked` : ''}`;
  const balance = pages.map(p => p.scores.map(s => `${s.local ? 'you' : s.name} ${s.score}`).join(', ')).join(' | ');
  let detail = pages.map(line).join('; ') + `; scores: ${balance}`;
  if (!ok) {
    detail = `${pages.flatMap(p => p.fails.map(f => `${p.mode}: ${f}`)).join('; ')}. Numbers: ${pages.map(line).join('; ')}. ` +
      'Fix: keep config/game.json → fair on (fair.on true, fair.downSeconds ≤ 2, fair.protectSeconds ≥ 1); hurt and knock only through the kit ' +
      '(ctx.mechanics.get(\'health\').damage, projectile hits) and never p.knock(…, {force: true}) or a knock in rules.update on a timer; score only in ' +
      'projectile.onHit / health.onDamage (they skip players who are down or protected); in rules.bot pick foes with ctx.bots.target(p, {range}) and ' +
      'attack with ctx.bots.attack(p, t) instead of the nearest player; a continuous attack should not knock (streams push).';
  }
  // bot score balance: a warning, never a failure
  const warnings = [];
  for (const p of pages) {
    const bots = p.scores.filter(s => s.bot).map(s => s.score), me = p.scores.find(s => s.local)?.score ?? 0;
    if (bots.length && Math.max(...bots) >= 10 && Math.max(...bots) > 3 * Math.max(1, Math.min(...bots), me)) warnings.push(`${p.mode}: bot scores lopsided (${p.scores.map(s => `${s.local ? 'you' : s.name} ${s.score}`).join(', ')}): consider fair.botSkill or the rules' scoring`);
  }
  for (const p of pages) if (p.aliveSec < 10 && !p.fails.length) warnings.push(`${p.mode}: the round ended after ${p.observed} s (rules.check), too short to judge fair play well`);
  return { ok, detail, warnings, record: { limits: FAIR_LIMITS, seconds, upTo, pages: pages.map(({ scores, ...rest }) => ({ ...rest, scores })) } };
}
