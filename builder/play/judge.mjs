#!/usr/bin/env node
// The play judge (builder/play/JUDGE.md): is this game a game, and does it play like its play target? The creator,
// 2026-10-14, on the look test: "The biggest thing these all miss is the actual gameplay itself ... We need a better
// gameplayer designer and judge. We were supposed to collect berries, but there were no berries anywhere."
//
//   import { score } from './builder/play/judge.mjs';
//   const r = await score('<game>', target, { outDir });
//   // target: spec.play.target (gf-play-target/1) or null (the loop's defaults; the score is then advisory)
//   // → { score 0–100, verdict 'pass' | 'fail' | 'unsure', interval [lo, hi], bar, advisory, hard: [...],
//   //     parts: {measured: {...}, judged: {...}}, findings: [{part, line, source, hard?}], numbers, rounds, clips, vision }
//
//   node builder/play/judge.mjs <game> [--out dir] [--no-vision] [--passes 3] [--refs <folder of gameplay frames>]
//                                       [--rounds 2] [--no-duo] [--json] [--play <out>/play.json: judge a kept play again]
//
// How it decides:
//   real play     session.mjs: the game's bots and the scripted player (agent.mjs) on real keys, at two and four
//                 players where the game allows, ROUNDS rounds each of the game's own length on stepped time; one more
//                 round by two scripted friends over real WebRTC (a live game), both screens kept
//   measured      measure.mjs: the play feeds (kit/core/play.js) against the target's pacing: objectives reachable and
//                 taken, meaningful events a minute, dead air, each player's quiet stretch, idle share, the first
//                 action, players on each other, rounds completed, lead changes. Deterministic for a play.
//   judged        vision.mjs: clips of that play (the opening and the busiest stretch at each player count, and both
//                 friends' screens) on a fixed rubric: clarity, feel and impact, chaos and drama, player interaction,
//                 would play again, and each of the target's "what makes it play" lines; PASSES passes, the clips'
//                 order reversed on every other one
//   score         BLEND of the two; an interval round it: ± Z · judged weight · sd / √passes, sd never under NOISE
//   verdict       fail on any HARD finding (measure.mjs: no objective a player can reach, or nothing meaningful for 30 s
//                 in most rounds), whatever the target; with a target, fail when the whole interval is below BAR,
//                 unsure (advisory, never a fail) when it holds BAR; no target: scored and advisory
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { playGame, strips } from './session.mjs';
import { measured } from './measure.mjs';
import { judgeClips, judgedMark, partWeights, briefOf, PARTS } from './vision.mjs';
import { isMain } from '../tools/lib/main.mjs';

export const BAR = 50;
export const BLEND = { measured: 0.6, judged: 0.4 };
export const PASSES = 3;
export const Z = 3;
/** The judged half's spread on an unchanged play (points of 0–100), measured by stability.mjs: never assumed smaller. */
export const NOISE = { judgedSd: 6 };
const r1 = v => Math.round(v * 10) / 10;
const meanOf = xs => { const v = xs.filter(Number.isFinite); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
const sdOf = xs => { const v = xs.filter(Number.isFinite); if (v.length < 2) return 0; const m = meanOf(v); return Math.sqrt(v.reduce((a, x) => a + (x - m) ** 2, 0) / (v.length - 1)); };

/** The rounds and objectives a play gave, every run's, with the objectives' ids kept apart per run. */
export function roundsOf(play) {
  const rounds = [], objectives = [], agents = [];
  const take = (label, players, feed, agent) => {
    for (const round of feed?.rounds ?? []) rounds.push({ label, players, round });
    for (const o of feed?.objectives ?? []) objectives.push({ ...o, id: `${label}:${o.id}` });
    if (agent) agents.push({ ...agent, tried: (agent.tried ?? []).map(t => ({ ...t, id: `${label}:${t.id}` })) });
  };
  for (const run of play.runs ?? []) take(run.label, run.players, run.feed, run.agent);
  // the friends round: the host's copy owns the shared world, its feed hears every event
  if (play.duo?.feeds?.[0]) take('duo', 2, play.duo.feeds[0], play.duo.agents?.host);
  return { rounds, objectives, agents };
}

/** The clips a vision judge watches: per player count the opening and the busiest six seconds, and both friends' screens. */
export function pickClips(play, { n = 6 } = {}) {
  const clips = [];
  for (const run of play.runs ?? []) {
    const R = run.feed?.rounds?.[0], frames = run.frames.filter(f => !R || f.round === R.n || f.round == null);
    if (frames.length < n) continue;
    const t0 = R?.t0 ?? frames[0].t;
    const window = at => { const i = Math.max(0, Math.min(frames.length - n, frames.findIndex(f => f.t >= at))); return frames.slice(i, i + n); };
    clips.push({ title: `${run.players} players (${run.bots} bots), the scripted player's own screen: the opening`, frames: window(t0 + 1) });
    // the busiest stretch by the round's meaningful events
    const tl = (R?.timeline ?? []).filter(e => !['score', 'attempt', 'combo'].includes(e[1])).map(e => e[0] + t0);
    let best = null, bestN = -1;
    for (const f of frames) { const k = tl.filter(t => t >= f.t && t < f.t + n).length; if (k > bestN) { bestN = k; best = f.t; } }
    const mid = frames[Math.floor(frames.length / 2)].t;
    const at = bestN > 0 ? best : mid;
    if (Math.abs(at - (t0 + 1)) > n) clips.push({ title: `${run.players} players, the scripted player's own screen: ${bestN > 0 ? `the busiest ${n} s (${bestN} events)` : 'the middle of the round'}`, frames: window(at) });
  }
  const host = play.duo?.frames?.host ?? [], friend = play.duo?.frames?.friend ?? [];
  if (host.length >= 3 && friend.length >= 3) {
    const k = Math.floor(Math.min(host.length, friend.length) / 2), h = host.slice(k, k + 3), f = h.map(x => friend.reduce((b, y) => (Math.abs(y.wall - x.wall) < Math.abs(b.wall - x.wall) ? y : b)));
    clips.push({ title: 'two friends in one round: top row the host\'s screen, bottom row the friend\'s, the same seconds', frames: [...h.map(x => ({ ...x, label: `host ${x.t}s` })), ...f.map(x => ({ ...x, label: `friend ${x.t}s` }))] });
  }
  return clips;
}

/** Reference gameplay frames: a folder of pictures (local only). */
export function refFiles(dir) {
  if (!dir || !existsSync(dir)) return [];
  return readdirSync(dir).filter(n => /\.(png|jpe?g|webp)$/i.test(n)).sort().slice(0, 8).map(n => join(dir, n));
}

/**
 * Score a game. opts: outDir, log, vision (default on unless GF_PLAY_VISION=0), passes, refs (files), play (a session
 * already played: re-judge the same play), counts, rounds, duo, judge (replaces judgeClips: tests).
 */
export async function score(game, target = undefined, opts = {}) {
  const dir = resolve(game);
  const { log = () => {}, vision = process.env.GF_PLAY_VISION !== '0', passes = PASSES, refs = [], judge = judgeClips } = opts;
  const outDir = resolve(opts.outDir ?? join(dir, '.verify', 'play'));
  await mkdir(join(outDir, 'frames'), { recursive: true });
  const spec = JSON.parse(await readFile(join(dir, 'spec.json'), 'utf8').catch(() => '{}'));
  if (target === undefined) target = spec.play?.target ?? null;
  const t0 = Date.now();
  // a runtime that has no play feed yet (Godot: its own boot and event log) is said, never judged on nothing
  if ((spec.runtime ?? 'three') === 'godot' && !opts.play) {
    const record = { schema: 'gf-play-judge/1', game: basename(dir), verdict: 'skipped', skipped: 'not yet for godot: its boot (runtimes/godot/kit/boot.js) keeps its own event log and fills no window.__game.play() yet', score: null, interval: null, bar: BAR, advisory: true, hard: [], parts: {}, findings: [], change: [], numbers: {}, play: { runs: [] }, clips: [], vision: null, seconds: Math.round((Date.now() - t0) / 1000) };
    await writeFile(join(outDir, 'play-judge.json'), JSON.stringify(record, null, 1) + '\n');
    return record;
  }
  const play = opts.play ?? await playGame(dir, { outDir: join(outDir, 'frames'), log, ...(opts.counts ? { counts: opts.counts } : {}), ...(opts.rounds ? { rounds: opts.rounds } : {}), duo: opts.duo !== false });
  if (!opts.play) await writeFile(join(outDir, 'play.json'), JSON.stringify(play) + '\n');     // the play, to judge again (--play)
  const { rounds, objectives, agents } = roundsOf(play);
  const m = measured({ rounds, objectives, agents, target, spec });
  // ---- the judged half ----
  let judged = null, visionRec = null, clipFiles = [];
  if (vision && rounds.length) {
    const clips = pickClips(play).map((c, i) => ({ ...c, file: join(outDir, `clip-${i + 1}.jpg`) }));
    try {
      if (clips.length) await strips(clips);
      clipFiles = clips.map(c => ({ file: c.file, title: c.title }));
      const makes = (target?.makes ?? []).map(x => x.see ? `${x.says} (on screen: ${x.see})` : x.says);
      const brief = briefOf(spec, target);
      const answers = clips.length ? (await Promise.allSettled(Array.from({ length: passes }, (_, i) => judge(clipFiles, { brief, makes, refs, reverse: i % 2 === 1 })))) : [];
      const ok = answers.filter(a => a.status === 'fulfilled').map(a => a.value);
      const weights = partWeights(target, { together: rounds.some(r => r.players >= 2) });
      const marks = ok.map(a => judgedMark(a, weights)).filter(Number.isFinite);
      if (marks.length) {
        const parts = Object.fromEntries(PARTS.map(p => [p, r1(meanOf(ok.map(a => a.parts[p]?.mark).filter(v => v !== null)) ?? NaN)]).filter(([, v]) => Number.isFinite(v)));
        judged = { score: r1(meanOf(marks)), marks, sd: r1(sdOf(marks)), parts, makes: (target?.makes ?? []).map((x, i) => ({ line: x.says, mark: r1(meanOf(ok.map(a => a.makes[i]?.mark).filter(v => v !== null)) ?? NaN) })),
          findings: ok[0] ? [...PARTS.map(p => ({ part: p, mark: parts[p], line: ok[0].parts[p]?.finding })).filter(f => f.line && f.line !== 'fine' && Number.isFinite(f.mark) && f.mark < 3), ...ok[0].makes.filter(x => x.mark !== null && x.mark < 2).map(x => ({ part: 'makes', line: `"${x.line}": ${x.finding}` }))] : [],
          change: ok[0]?.change ?? [], summary: ok.map(a => a.summary) };
      }
      visionRec = { passes: ok.length, asked: passes, errors: answers.filter(a => a.status === 'rejected').map(a => String(a.reason?.message ?? a.reason).slice(0, 200)), model: ok[0]?.model ?? null, seconds: ok.map(a => a.seconds), cost: ok.reduce((s, a) => s + (a.cost ?? 0), 0) || null, refs: refs.length };
    } catch (e) { visionRec = { error: String(e.message).slice(0, 300) }; }
  }
  // ---- the score, its interval and the verdict ----
  const w = judged ? BLEND : { measured: 1, judged: 0 };
  const total = m.score === null ? null : r1(w.measured * m.score + w.judged * (judged?.score ?? 0));
  const half = judged ? Z * w.judged * Math.max(judged.sd, NOISE.judgedSd) / Math.sqrt(Math.max(1, judged.marks.length)) : 0;
  const interval = total === null ? null : [r1(Math.max(0, total - half)), r1(Math.min(100, total + half))];
  const advisory = !target;
  let verdict;
  if (m.hard.length) verdict = 'fail';
  else if (total === null) verdict = 'fail';
  else if (advisory) verdict = 'pass';
  else verdict = interval[1] < BAR ? 'fail' : interval[0] >= BAR ? 'pass' : 'unsure';
  const findings = [...m.findings, ...(judged?.findings ?? []).map(f => ({ ...f, source: 'judged' }))];
  const record = {
    schema: 'gf-play-judge/1', game: basename(dir), score: total, verdict, interval, bar: BAR, advisory, blend: w, hard: m.hard,
    parts: { measured: { score: m.score, ...m.parts }, judged: judged ? { score: judged.score, ...judged.parts, makes: judged.makes } : null },
    findings, change: judged?.change ?? [], summary: judged?.summary ?? [], numbers: m.numbers, want: m.want, target: target ? { from: target.from, confidence: target.confidence } : null,
    play: { counts: play.counts, round: play.round, seconds: play.seconds, renderer: play.renderer, runs: (play.runs ?? []).map(r => ({ label: r.label, players: r.players, clock: r.clock, rounds: r.feed?.rounds?.length ?? 0, frames: r.frames.length, errors: r.errors, noFeed: !!r.noFeed, agent: r.agent })),
      duo: play.duo?.skipped ? { skipped: play.duo.skipped } : { rounds: play.duo?.feeds?.[0]?.rounds?.length ?? 0, frames: Object.fromEntries(Object.entries(play.duo?.frames ?? {}).map(([k, v]) => [k, v.length])), errors: play.duo?.errors ?? [] } },
    rounds: rounds.map(r => ({ label: r.label, players: r.players, n: r.round.n, seconds: r.round.seconds, done: r.round.done, events: { meaningful: r.round.events.meaningful, perMinute: r.round.events.perMinute, first: r.round.events.first, longestGap: r.round.events.longestGap, byType: r.round.events.byType }, interactions: r.round.interactions.total, idle: r.round.idle.share, leads: r.round.leads.changes, objectives: r.round.objectives, outcome: r.round.outcome })),
    objectives: objectives.filter(o => o.reach === false).slice(0, 12).map(o => ({ id: o.id, kind: o.kind, at: [o.x, o.y, o.z], why: o.why })),
    clips: clipFiles, vision: visionRec, seconds: Math.round((Date.now() - t0) / 1000), at: new Date().toISOString(),
  };
  await writeFile(join(outDir, 'play-judge.json'), JSON.stringify(record, null, 1) + '\n');
  return record;
}

/** One line for a person: the verdict, the score, the hard findings first. */
export function playLine(r) {
  if (r.verdict === 'skipped') return `skipped: ${r.skipped}`;
  const head = `${r.verdict}: ${r.score ?? '—'}/100${r.interval && r.interval[0] !== r.interval[1] ? ` (${r.interval[0]}–${r.interval[1]})` : ''}${r.advisory ? ' (no play target: advisory)' : `, the bar ${r.bar}`}`;
  const top = [...r.hard.map(h => h.line), ...r.findings.filter(f => !f.hard).slice(0, 4).map(f => f.line)];
  return `${head}${top.length ? `; ${top.slice(0, 5).join('; ')}` : ''}`;
}

if (isMain(import.meta)) {
  const a = process.argv.slice(2), opt = k => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : null; };
  const VALUED = ['--out', '--passes', '--refs', '--rounds', '--play'];
  const game = a.find((x, i) => !x.startsWith('--') && !VALUED.includes(a[i - 1]));
  if (!game) { console.error('usage: node builder/play/judge.mjs <game> [--out dir] [--no-vision] [--passes N] [--refs dir] [--rounds N] [--no-duo] [--json]'); process.exit(2); }
  const r = await score(game, undefined, { play: opt('--play') ? JSON.parse(await readFile(opt('--play'), 'utf8')) : undefined, outDir: opt('--out') ?? undefined, vision: !a.includes('--no-vision') && process.env.GF_PLAY_VISION !== '0', passes: Number(opt('--passes') ?? PASSES), refs: refFiles(opt('--refs')), rounds: opt('--rounds') ? Number(opt('--rounds')) : undefined, duo: !a.includes('--no-duo'), log: a.includes('--json') ? () => {} : console.log });
  if (a.includes('--json')) console.log(JSON.stringify(r));
  else { console.log(playLine(r)); console.log(`record: ${join(resolve(opt('--out') ?? join(resolve(game), '.verify', 'play')), 'play-judge.json')}`); }
  process.exit(r.verdict === 'fail' ? 1 : 0);
}
