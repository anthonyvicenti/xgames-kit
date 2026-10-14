#!/usr/bin/env node
// The eval runner (skeleton). RUNNER.md says what each step does and why; this file is the order they run in.
//
//   node evals/run.mjs check                                   every set against its frozen manifests
//   node evals/run.mjs freeze <set> --date YYYY-MM-DD [--note ...]   freeze the set's new files (a new manifest)
//   node evals/run.mjs plan <set> --seed N [--date YYYY-MM-DD]       plan a pass: order, blind ids, audit sample
//   node evals/run.mjs run <set> --pass ID [--only RUNKEY] [--model ID]   run the planned runs that have no record
//   node evals/run.mjs judge <set> --pass ID [--only BLINDID] [--model ID] the second reader on every bundle not judged yet
//   node evals/run.mjs score <set> --pass ID                   join records and judgements into result.json
//
// Sets: paired, breadth, cases (runs), depth (sessions with people: PROTOCOL.md; check and freeze only).
// Records go to evals/records/<set>/<pass>/ and are written once; a finished pass is frozen whole.
import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { checkSet, freezeSet } from './lib/freeze.mjs';
import { loadSet, planPass, writePlan, resolveInputs } from './lib/sets.mjs';
import { writeRecord, freezeDir } from './lib/record.mjs';
import { bundleFor, witnessText, leaks } from './lib/blind.mjs';
import { pairedResult, breadthResult } from './lib/score.mjs';
import { LOOPS, WITNESS, PROBE, completed, NotWired } from './lib/arms.mjs';
import { judgePass } from './lib/judge.mjs';
import { isVoid } from './lib/score.mjs';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SET_NAMES = ['paired', 'breadth', 'depth', 'cases'];
const RUNS = { paired: ['old', 'new'], breadth: ['new'], cases: ['new'] };
const today = () => new Date().toISOString().slice(0, 10);
const readJson = async f => JSON.parse(await readFile(f, 'utf8'));

export async function cmdCheck(root = HERE) {
  let ok = true;
  for (const name of SET_NAMES) {
    const dir = path.join(root, name);
    if (!existsSync(dir)) { console.log(`${name}: missing`); ok = false; continue; }
    const s = await checkSet(dir);
    console.log(`${name}: ${s.ok ? 'ok' : 'CHANGED'}, ${Object.keys(s.frozen).length} frozen in ${s.manifests.length} manifest(s)${s.loose.length ? `, ${s.loose.length} not frozen: ${s.loose.join(', ')}` : ''}`);
    for (const p of s.problems) console.log(`  ${p}`);
    if (!s.ok || s.loose.length) ok = false;
  }
  return ok;
}

/** The next pass id for a set: <date>-<n>. */
async function nextPass(setRecords, date) {
  let n = 1;
  while (existsSync(path.join(setRecords, `${date}-${n}`))) n++;
  return `${date}-${n}`;
}

export async function cmdPlan(name, { seed, date = today(), root = HERE, pins }) {
  if (!RUNS[name]) throw Error(`${name} is not run by this runner (depth sessions follow depth/PROTOCOL.md)`);
  const { set } = await loadSet(path.join(root, name));
  const records = path.join(root, 'records', name);
  const pass = await nextPass(records, date);
  pins ??= Object.fromEntries(RUNS[name].map(arm => [arm, LOOPS[arm].pin()]));
  const planned = await planPass({ setDir: path.join(root, name), arms: RUNS[name], reps: set.reps ?? 1, seed, pass, pins });
  await writePlan(path.join(records, pass), planned);
  return planned.plan;
}

/** One run, start to finish. Every step before the record can throw; nothing is written until all of them return. */
export async function runOne({ root = HERE, name, pass, key, model, adapters = { loops: LOOPS, witness: WITNESS, probe: PROBE }, privateDir }) {
  const passDir = path.join(root, 'records', name, pass);
  const plan = await readJson(path.join(passDir, 'plan.json'));
  const sealed = await readJson(path.join(passDir, 'sealed', 'map.json'));
  const [caseId, arm, r] = key.split('-');
  const { cases } = await loadSet(path.join(root, name));
  const kase = cases[caseId];
  const runDir = path.join(passDir, 'runs', key);
  if (existsSync(path.join(runDir, 'record.json'))) return { skipped: key };
  const inputs = await resolveInputs(kase, privateDir);
  const started = new Date().toISOString();
  const built = await adapters.loops[arm].run({ inputs, model, runDir, wallClockHours: plan.wallClockHours });
  const witness = built.delivered ? await adapters.witness.play({ game: built.game, inputs, runDir }) : null;
  const probe = built.delivered ? await adapters.probe.twoPlayer({ game: built.game, runDir }) : { value: false, why: 'not delivered', summary: '' };
  const outcome = { delivered: built.delivered, rescue: false, stopped: built.stopped ?? null, questions: built.questions ?? [], ladder: built.ladder ?? [], lastWords: built.lastWords ?? '' };
  const blindId = sealed.map[key];
  const record = {
    schema: 'xgk-eval-record/1', set: name, setHash: plan.setHash, case: caseId, caseHash: plan.cases[caseId], arm, rep: Number(r.slice(1)),
    runKey: key, pass, loop: plan.pins[arm], model: { base: model, used: built.models ?? [model] },
    started, finished: built.stopped === 'wall-clock' ? null : new Date().toISOString(),
    outcome, game: built.delivered ? built.game : null,
    measures: { completed: completed(outcome, witness), multiplayer: { value: !!probe.value, why: probe.why } },
    usage: { tokens: built.tokens ?? null, minutes: built.minutes ?? null, usd: built.usd ?? null },
    blindId, evidence: [],
  };
  const bundle = bundleFor({ blindId, kase, delivered: built.delivered, witness: witness && { ...witness, probe }, lastWords: outcome.lastWords });
  const problems = leaks(bundle, record);
  if (problems.length) throw Error(`bundle ${blindId} would tell its reader the arm:\n  ${problems.join('\n  ')}`);
  const bundleDir = path.join(passDir, 'blind', blindId);
  await mkdir(bundleDir, { recursive: true });
  await writeFile(path.join(bundleDir, 'bundle.json'), JSON.stringify(bundle, null, 1) + '\n', { flag: 'wx' });
  if (witness) await writeFile(path.join(bundleDir, 'witness.md'), witnessText(witness.log), { flag: 'wx' });
  await writeRecord(runDir, record);
  await freezeDir(runDir, { date: started.slice(0, 10) });
  return { recorded: key };
}

export async function cmdRun(name, { pass, only, model = 'claude-opus-5-5', root = HERE }) {
  const plan = await readJson(path.join(root, 'records', name, pass, 'plan.json'));
  for (const key of plan.order) {
    if (only && key !== only) continue;
    try { console.log(JSON.stringify(await runOne({ root, name, pass, key, model }))); }
    catch (e) { if (e instanceof NotWired) { console.error(e.message); return false; } throw e; }
  }
  return true;
}

export async function cmdScore(name, { pass, root = HERE }) {
  const passDir = path.join(root, 'records', name, pass);
  const plan = await readJson(path.join(passDir, 'plan.json'));
  const { cases } = await loadSet(path.join(root, name));
  const records = [], judgements = {};
  for (const key of plan.order) {
    const f = path.join(passDir, 'runs', key, 'record.json');
    if (existsSync(f)) records.push(await readJson(f));
  }
  const jd = path.join(passDir, 'judgements');
  // a void judgement (control present) never stands over a fresh reader's judgement of the same bundle
  if (existsSync(jd)) for (const n of (await readdir(jd)).sort()) { const j = await readJson(path.join(jd, n)), have = judgements[j.blindId]; if (!have || (isVoid(have) && !isVoid(j))) judgements[j.blindId] = j; }
  const result = name === 'paired' ? pairedResult({ cases, records, judgements, reps: plan.reps, seed: plan.seed })
    : breadthResult({ cases, records, judgements });
  const out = path.join(passDir, 'result.json');
  if (result.complete) await writeFile(out, JSON.stringify({ schema: 'xgk-eval-result/1', set: name, pass, ...result }, null, 1) + '\n', { flag: 'wx' });
  return result;
}

/** The second reader on every bundle of a pass that has no judgement yet (lib/judge.mjs). */
export async function cmdJudge(name, { pass, only = null, model = 'claude-opus-5-5', root = HERE, runner = null }) {
  if (!RUNS[name]) throw Error(`${name} has no bundles to judge (depth sessions follow depth/PROTOCOL.md)`);
  return judgePass({ root, set: name, pass, model, runner, only });
}

async function main(argv) {
  const { positionals, values } = parseArgs({ args: argv, allowPositionals: true, options: {
    date: { type: 'string' }, note: { type: 'string' }, seed: { type: 'string' }, pass: { type: 'string' },
    only: { type: 'string' }, model: { type: 'string' } } });
  const [cmd, name] = positionals;
  if (name && !SET_NAMES.includes(name)) throw Error(`no set ${name} (${SET_NAMES.join(', ')})`);
  switch (cmd) {
    case 'check': return cmdCheck();
    case 'freeze': { const m = await freezeSet(path.join(HERE, name), { date: values.date, note: values.note ?? '' }); console.log(`froze ${Object.keys(m.files).length} files of ${name}: ${path.relative(HERE, m.file)} ${m.setHash}`); return true; }
    case 'plan': { if (!values.seed) throw Error('plan needs --seed'); const p = await cmdPlan(name, { seed: Number(values.seed), date: values.date }); console.log(`planned ${name} ${p.pass}: ${p.order.length} runs`); return true; }
    case 'run': return cmdRun(name, { pass: values.pass, only: values.only, model: values.model });
    case 'judge': { const done = await cmdJudge(name, { pass: values.pass, only: values.only, model: values.model }); for (const d of done) console.log(JSON.stringify(d)); return true; }
    case 'score': { const r = await cmdScore(name, { pass: values.pass }); console.log(JSON.stringify(r, null, 1)); return r.complete; }
    default: console.log('usage: node evals/run.mjs check | freeze <set> --date D | plan <set> --seed N | run <set> --pass ID | judge <set> --pass ID | score <set> --pass ID'); return false;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(ok => { process.exitCode = ok ? 0 : 1; }, e => { console.error(e.message); process.exitCode = 1; });
}
