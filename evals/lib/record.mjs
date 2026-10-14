// The run record: one record.json per run, written once, then frozen with the rest of its folder. Nothing here runs a
// loop; it says what a finished run must have written down and refuses a record that is missing any of it.
import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { hashFile, setHash, MANIFEST_SCHEMA } from './freeze.mjs';

export const RECORD_SCHEMA = 'xgk-eval-record/1';
export const SETS = ['paired', 'breadth', 'depth', 'cases'];
export const ARMS = ['old', 'new'];
const HEX = /^[0-9a-f]{64}$/;
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const RUN_KEY = /^[A-Za-z0-9]+-(old|new)-r[1-9]\d*$/;

/** The key of one run: <case>-<arm>-r<rep>, e.g. PA04-new-r2. */
export const runKey = (caseId, arm, rep) => `${caseId}-${arm}-r${rep}`;

/**
 * Problems with a record, as plain sentences; [] when it is complete. A record says what ran (set and case, with the
 * hashes they were frozen under), which arm and repetition, what pinned the loop, which models it used, when, what came
 * out (delivered, rescued, stopped, questions, ladder), and the measures the runner itself takes. The second reader's
 * marks are not in it: they are judgements/<blindId>.json, joined only when the pass is scored.
 */
export function validateRecord(r) {
  const p = [];
  const need = (cond, text) => { if (!cond) p.push(text); };
  if (!r || typeof r !== 'object') return ['the record is not an object'];
  need(r.schema === RECORD_SCHEMA, `schema must be ${RECORD_SCHEMA}`);
  need(SETS.includes(r.set), `set must be one of ${SETS.join(', ')}`);
  need(HEX.test(r.setHash ?? ''), 'setHash: the set\'s hash at plan time (64 hex)');
  need(typeof r.case === 'string' && r.case.length > 0, 'case: the case id');
  need(HEX.test(r.caseHash ?? ''), 'caseHash: the case file\'s frozen hash (64 hex)');
  need(ARMS.includes(r.arm), `arm must be one of ${ARMS.join(', ')}`);
  need(Number.isInteger(r.rep) && r.rep >= 1, 'rep: 1, 2, 3 ...');
  need(r.runKey === runKey(r.case, r.arm, r.rep) && RUN_KEY.test(r.runKey ?? ''), 'runKey must be <case>-<arm>-r<rep>');
  need(typeof r.pass === 'string' && /^\d{4}-\d{2}-\d{2}-\d+$/.test(r.pass), 'pass: the pass id, <date>-<n>');
  need(r.loop && typeof r.loop.name === 'string' && typeof r.loop.commit === 'string' && r.loop.commit.length >= 7, 'loop: {name, commit}');
  need(r.model && typeof r.model.base === 'string' && Array.isArray(r.model.used) && r.model.used.length > 0, 'model: {base, used: [every model the run called]}');
  need(STAMP.test(r.started ?? ''), 'started: an ISO time with its zone');
  need(r.finished === null || STAMP.test(r.finished ?? ''), 'finished: an ISO time with its zone, or null when the wall clock stopped it');
  const o = r.outcome;
  need(o && typeof o.delivered === 'boolean', 'outcome.delivered: true or false');
  need(o && typeof o.rescue === 'boolean', 'outcome.rescue: true when a person touched the run');
  need(o && (o.stopped === null || ['wall-clock', 'error', 'declined', 'asking'].includes(o.stopped)), 'outcome.stopped: null, wall-clock, error, declined or asking');
  need(o && Array.isArray(o.questions), 'outcome.questions: [{asked, answered}] (empty when none)');
  need(o && Array.isArray(o.ladder), 'outcome.ladder: the rungs climbed (empty when none)');
  if (o?.rescue) need(typeof o.rescueNotes === 'string' && o.rescueNotes.length > 0, 'outcome.rescueNotes: what the person did');
  if (o && !o.delivered) need(typeof o.lastWords === 'string', 'outcome.lastWords: what the loop said instead of delivering');
  need(o?.delivered ? (r.game && HEX.test(r.game.sha256 ?? '')) : r.game === null, 'game: {sha256, ...} when delivered, null when not');
  const m = r.measures;
  need(m && typeof m === 'object', 'measures: the runner\'s own measures');
  if (m) {
    need(m.completed && typeof m.completed.value === 'boolean' && typeof m.completed.why === 'string', 'measures.completed: {value, why}');
    need(m.multiplayer && (typeof m.multiplayer.value === 'boolean') && typeof m.multiplayer.why === 'string', 'measures.multiplayer: {value, why}');
    if (m.completed?.value) need(o?.delivered && !o?.rescue, 'measures.completed is true only for a delivered run with no rescue');
    if (m.multiplayer?.value) need(o?.delivered, 'measures.multiplayer is true only for a delivered run');
  }
  need(typeof r.blindId === 'string' && /^J[0-9A-Z]{6}$/.test(r.blindId), 'blindId: the bundle\'s id from the plan');
  need(Array.isArray(r.evidence), 'evidence: [{what, ref}]');
  return p;
}

/** Write a run's record once. Refuses a record with problems and a record that is already there. */
export async function writeRecord(dir, record) {
  const problems = validateRecord(record);
  if (problems.length) throw Error(`record ${record?.runKey ?? '?'} is incomplete:\n  ${problems.join('\n  ')}`);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, 'record.json');
  if (existsSync(file)) throw Error(`${file} exists: a record is written once (start a new pass instead)`);
  await writeFile(file, JSON.stringify(record, null, 1) + '\n', { flag: 'wx' });
  return file;
}

async function walk(dir, base = dir, out = []) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await walk(p, base, out);
    else out.push(path.relative(base, p).split(path.sep).join('/'));
  }
  return out.sort();
}

/** Freeze a finished folder (a run, a pass): FROZEN.json with every file's hash. Written once. */
export async function freezeDir(dir, { date }) {
  const out = path.join(dir, 'FROZEN.json');
  if (existsSync(out)) throw Error(`${out} exists: ${dir} is already frozen`);
  const files = {};
  for (const rel of await walk(dir)) files[rel] = await hashFile(path.join(dir, rel));
  const manifest = { schema: MANIFEST_SCHEMA, dir: path.basename(dir), date, files, setHash: setHash(files) };
  await writeFile(out, JSON.stringify(manifest, null, 1) + '\n', { flag: 'wx' });
  return manifest;
}

/** Check a frozen folder: → problems ([] when every file still has its hash and nothing was added). */
export async function checkDir(dir) {
  const f = path.join(dir, 'FROZEN.json');
  if (!existsSync(f)) return [`${dir} is not frozen`];
  const m = JSON.parse(await readFile(f, 'utf8')), p = [];
  if (setHash(m.files) !== m.setHash) p.push('FROZEN.json was edited');
  const now = (await walk(dir)).filter(rel => rel !== 'FROZEN.json');
  for (const rel of now) if (!m.files[rel]) p.push(`${rel}: added after the freeze`);
  for (const [rel, h] of Object.entries(m.files)) {
    if (!now.includes(rel)) p.push(`${rel}: missing`);
    else if ((await hashFile(path.join(dir, rel))) !== h) p.push(`${rel}: changed after the freeze`);
  }
  return p;
}

export const isDir = async p => { try { return (await stat(p)).isDirectory(); } catch { return false; } };
