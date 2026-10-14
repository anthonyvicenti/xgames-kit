// The judge: the second reader (builder/loop/reader.mjs) as the evals' reader of a blind bundle. One fresh model
// session per bundle, given the set's frozen JUDGE.md as its whole prompt with {{bundle}} filled in, and a working
// folder that holds a copy of that bundle and nothing else (no repository, no records, no other bundle, no MCP server).
// Its reply goes to judgements/<bundle id>.json, written once. A judgement that marks the control present is void, and
// the bundle goes to a fresh session (judgements/<bundle id>.2.json, the void one kept). RUNNER.md, "Judge".
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { judgePrompt, judgementProblems, jsonIn } from '../../builder/loop/reader.mjs';
import { isVoid } from './score.mjs';

/** The shape a judge's structured answer must have at least (each set's JUDGE.md has the whole of it). */
export const JUDGEMENT_SCHEMA = { type: 'object', required: ['schema', 'set', 'blindId', 'control', 'summary'], properties: { schema: { type: 'string' }, set: { type: 'string' }, blindId: { type: 'string' }, ledger: { type: 'array', items: { type: 'object' } }, musts: { type: 'array', items: { type: 'object' } }, policy: { type: 'array', items: { type: 'object' } }, control: { type: 'object' }, outcome: { type: 'string' }, missingParts: { type: 'array', items: { type: 'string' } }, summary: { type: 'string' }, armGuess: { type: 'object' } } };
/** A session with no server of its own: an empty MCP config, so only the tools named here exist. */
const NO_MCP = JSON.stringify({ mcpServers: {} });

/** The ids a bundle's judgement must mark: the paired ledger's lines, or the breadth musts. */
export const idsOf = bundle => (bundle.ledger ?? bundle.musts ?? []).map(x => x.id);

/**
 * Judge one bundle in a fresh session. runner: claudeRunner's run (a test passes its own). → the judgement (checked)
 * Throws when two sessions in a row give no judgement of the set's shape: a reader that failed is not a verdict.
 */
export async function judgeOne({ setDir, set, bundleDir, model, runner, logDir }) {
  const bundle = JSON.parse(await readFile(path.join(bundleDir, 'bundle.json'), 'utf8'));
  const md = await readFile(path.join(setDir, 'JUDGE.md'), 'utf8');
  const problems = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    const work = await mkdtemp(path.join(os.tmpdir(), 'xgk-judge-'));
    try {
      const copy = path.join(work, bundle.blindId);
      await cp(bundleDir, copy, { recursive: true });
      const run = runner ?? (await import('../../builder/loop/claude.mjs')).claudeRunner({ mcpConfig: NO_MCP, logDir });
      const r = await run({ prompt: judgePrompt(md, copy), model, cwd: copy, name: `judge-${bundle.blindId}`, schema: JUDGEMENT_SCHEMA,
        allowed: [`Read(/${copy}/**)`, 'Glob', 'Grep'], disallowed: ['Edit', 'Write', 'Bash', 'WebFetch', 'WebSearch', 'Task'] });
      const j = r.structured ?? jsonIn(r.text);
      const p = judgementProblems(j, { set, ids: idsOf(bundle), blindId: bundle.blindId });
      if (!p.length) return { ...j, judgedBy: { model: (r.models ?? [])[0] ?? model, attempt } };
      problems.push(`attempt ${attempt}: ${p.slice(0, 4).join('; ')}${r.error ? ` (${r.error})` : ''}`);
    } finally { await rm(work, { recursive: true, force: true }); }
  }
  throw new Error(`the judge gave no judgement of the ${set} shape for ${bundle.blindId}: ${problems.join(' | ')}`);
}

/**
 * Judge every bundle of a pass that has no judgement yet. → [{blindId, file, void?}]
 * A void judgement (control present) is kept, and the bundle goes to a fresh session once more.
 */
export async function judgePass({ root, set, pass, model, runner = null, only = null }) {
  const passDir = path.join(root, 'records', set, pass), blind = path.join(passDir, 'blind'), out = path.join(passDir, 'judgements');
  await mkdir(out, { recursive: true });
  const { readdir } = await import('node:fs/promises');
  const done = [];
  for (const id of (await readdir(blind).catch(() => [])).sort()) {
    if (only && id !== only) continue;
    const first = path.join(out, `${id}.json`), second = path.join(out, `${id}.2.json`);
    if (existsSync(second) || (existsSync(first) && !isVoid(JSON.parse(await readFile(first, 'utf8'))))) continue;
    const file = existsSync(first) ? second : first;
    const j = await judgeOne({ setDir: path.join(root, set), set, bundleDir: path.join(blind, id), model, runner, logDir: path.join(passDir, 'judging') });
    await writeFile(file, JSON.stringify(j, null, 1) + '\n', { flag: 'wx' });
    done.push({ blindId: id, file: path.relative(passDir, file), ...(isVoid(j) ? { void: true } : {}) });
    if (isVoid(j) && file === first) {
      const again = await judgeOne({ setDir: path.join(root, set), set, bundleDir: path.join(blind, id), model, runner, logDir: path.join(passDir, 'judging') });
      await writeFile(second, JSON.stringify(again, null, 1) + '\n', { flag: 'wx' });
      done.push({ blindId: id, file: path.relative(passDir, second), ...(isVoid(again) ? { void: true } : {}) });
    }
  }
  return done;
}
