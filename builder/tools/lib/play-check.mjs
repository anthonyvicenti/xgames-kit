// Gate D's play leg, inside measure 6 ("a round plays to results and replays"; builder/GATES.md, "Gate D widened for
// 'the game is not a game'"). The creator, 2026-10-14, on the look test: "The biggest thing these all miss is the actual
// gameplay itself ... We were supposed to collect berries, but there were no berries anywhere. I think in the ocean I
// saw some boxes but those are impossible to get." Every gate passed nothing about whether the game could be played to
// its objective, or whether anything happened in a round.
//
//   const r = await checkPlay('<game>', { outDir, log });   // → { ok, detail, record, notes }
//
// It runs the play judge (builder/play/judge.mjs): real rounds with bots and the scripted player at two and four
// players, the friends round, the play feed (kit/core/play.js) measured against the locked spec's play.target, and a
// vision judge on clips of that play. It fails on a hard finding (objectives a player cannot reach; nothing meaningful
// happening for 30 s in most rounds) whatever the target, and below the bar when the spec has a play target and the
// whole interval is below it; an interval holding the bar is unsure (advisory). With no play target the score is
// advisory. GF_PLAY_VISION=0 judges by the measured half alone (said in the detail).
import { join, resolve } from 'node:path';

export async function checkPlay(gameDir, { outDir = null, log = () => {}, score = null } = {}) {
  const dir = resolve(gameDir), notes = [];
  const judge = await import('../../play/judge.mjs');
  let r;
  try { r = await (score ?? judge.score)(dir, undefined, { outDir: outDir ? join(outDir, 'play') : undefined, log }); }
  catch (e) { return { ok: false, detail: `the play judge could not play the game: ${String(e.message).split('\n')[0].slice(0, 300)}`, record: { error: String(e.message).slice(0, 500) }, notes }; }
  if (r.verdict === 'skipped') return { ok: true, skipped: true, detail: `play leg ${judge.playLine(r)}`, record: { verdict: 'skipped', why: r.skipped }, notes: [`play (measure 6): ${r.skipped}`] };
  if (r.vision?.error || (r.vision && r.vision.passes < r.vision.asked)) notes.push(`play (measure 6): the vision judge ran ${r.vision.passes ?? 0} of ${r.vision.asked ?? '?'} passes${r.vision.error ? ` (${r.vision.error.slice(0, 160)})` : r.vision.errors?.length ? ` (${r.vision.errors[0].slice(0, 160)})` : ''}`);
  if (!r.vision) notes.push('play (measure 6): judged by the measured half alone (GF_PLAY_VISION=0, or no round was played)');
  if (r.verdict === 'unsure') notes.push(`play (measure 6): unsure: ${r.score} with the bar ${r.bar} inside its interval (${r.interval.join('–')}); advisory, not a fail`);
  if (r.play.runs.some(x => x.noFeed)) notes.push('play (measure 6): the game\'s kit copy has no play feed (window.__game.play): re-run create to refresh gf/three');
  const ok = r.verdict !== 'fail';
  const line = judge.playLine(r);
  const detail = ok ? `plays: ${line}` : `does not play: ${line}. Fix: put every objective where a player can get to it (on the world's own ground above the water, from where players start), make something meaningful happen every few seconds (bots that go for the objective and for each other, the main action on a press), then node builder/play/judge.mjs <game> runs this alone`;
  return { ok, detail, notes, record: { verdict: r.verdict, score: r.score, interval: r.interval, bar: r.bar, advisory: r.advisory, hard: r.hard, parts: r.parts, findings: r.findings.slice(0, 12), change: r.change, numbers: r.numbers, clips: r.clips.map(c => c.file), seconds: r.seconds, play: r.play } };
}
