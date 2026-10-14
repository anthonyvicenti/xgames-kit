// Loading a set and its cases, resolving what is kept privately, and planning a pass.
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { checkSet, hashFile, setHash } from './freeze.mjs';
import { shuffle, blindIds } from './blind.mjs';
import { runKey } from './record.mjs';

export const PLAN_SCHEMA = 'xgk-eval-plan/1';

/** A set folder's set.json and its cases ({id: case}, from cases/*.json, or depth's slots). */
export async function loadSet(setDir) {
  const set = JSON.parse(await readFile(path.join(setDir, 'set.json'), 'utf8'));
  const cases = {};
  const dir = setDir.endsWith(`${path.sep}cases`) || path.basename(setDir) === 'cases' ? setDir : path.join(setDir, 'cases');
  if (existsSync(dir)) {
    for (const n of (await readdir(dir)).filter(n => /^[A-Z]+\d+\.json$/.test(n)).sort()) {
      const c = JSON.parse(await readFile(path.join(dir, n), 'utf8'));
      cases[c.id] = { ...c, file: path.relative(setDir, path.join(dir, n)).split(path.sep).join('/') };
    }
  }
  return { set, cases };
}

/**
 * Find a private file by its hash in the private refs folder (XGK_EVAL_PRIVATE). Images are hashed as bytes, JSON as
 * canonical JSON (freeze.mjs). → the file's path, or null.
 */
export async function findPrivate(sha256, dir = process.env.XGK_EVAL_PRIVATE) {
  if (!dir || !existsSync(dir)) return null;
  for (const n of await readdir(dir)) {
    const f = path.join(dir, n);
    try { if ((await hashFile(f)) === sha256) return f; } catch { /* not readable as its kind: not a match */ }
  }
  return null;
}

/**
 * What the loop is given for a case: the prompt (from the case, or from its private file), the images in order, the
 * answers, and the own-words list. Throws, before anything runs, when something kept privately is not on this machine.
 */
export async function resolveInputs(kase, privateDir = process.env.XGK_EVAL_PRIVATE) {
  let prompt = kase.prompt, ownWords = kase.ownWords ?? null;
  if (kase.private) {
    const f = await findPrivate(kase.private.sha256, privateDir);
    if (!f) throw Error(`${kase.id}: its private file (sha256 ${kase.private.sha256.slice(0, 12)}…) is not in XGK_EVAL_PRIVATE; this case runs only on a machine that has it`);
    const p = JSON.parse(await readFile(f, 'utf8'));
    prompt = p.prompt; ownWords = p.ownWords ?? ownWords;
  }
  if (typeof prompt !== 'string' || !prompt.trim()) throw Error(`${kase.id}: no prompt`);
  const images = [];
  for (const i of kase.images ?? []) {
    const f = await findPrivate(i.sha256, privateDir);
    if (!f) throw Error(`${kase.id}: image ${i.label} (sha256 ${i.sha256.slice(0, 12)}…) is not in XGK_EVAL_PRIVATE`);
    images.push({ label: i.label, file: f });
  }
  return { id: kase.id, prompt, images, answers: kase.answers ?? { default: 'accept' }, ownWords };
}

/**
 * Plan a pass: every run of every arm in one seeded order, a blind id per run, and the audit sample. The set must be
 * frozen and unchanged. pins: {arm: {name, commit}} from each arm's adapter. → {plan, sealed}
 */
export async function planPass({ setDir, arms, reps, seed, pass, pins, auditPerArm = 5 }) {
  const state = await checkSet(setDir);
  if (!state.ok) throw Error(`the set has changed since it was frozen:\n  ${state.problems.join('\n  ')}`);
  if (state.loose.length) throw Error(`freeze the set first; not frozen: ${state.loose.join(', ')}`);
  const { set, cases } = await loadSet(setDir);
  const keys = [];
  for (const id of Object.keys(cases)) for (const arm of arms) for (let rep = 1; rep <= reps; rep++) keys.push(runKey(id, arm, rep));
  const order = shuffle(keys, seed);
  const ids = blindIds(order, seed);
  const audit = arms.flatMap(arm => shuffle(order.filter(k => k.includes(`-${arm}-`)), seed + 7).slice(0, auditPerArm).map(k => ids[k]));
  const caseHashes = Object.fromEntries(Object.values(cases).map(c => [c.id, state.frozen[c.file]?.hash]));
  const plan = {
    schema: PLAN_SCHEMA, set: set.set, pass, seed, reps, arms,
    setHash: setHash(Object.fromEntries(Object.entries(state.frozen).map(([rel, f]) => [rel, f.hash]))),
    manifests: state.manifests, cases: caseHashes, pins, order, audit,
    wallClockHours: set.wallClockHours ?? null,
  };
  return { plan, sealed: { schema: 'xgk-eval-sealed/1', pass, map: ids } };
}

/** Write a plan's two files once: records/<set>/<pass>/plan.json and sealed/map.json. */
export async function writePlan(passDir, { plan, sealed }) {
  if (existsSync(path.join(passDir, 'plan.json'))) throw Error(`${passDir} already has a plan`);
  await mkdir(path.join(passDir, 'sealed'), { recursive: true });
  await writeFile(path.join(passDir, 'plan.json'), JSON.stringify(plan, null, 1) + '\n', { flag: 'wx' });
  await writeFile(path.join(passDir, 'sealed', 'map.json'), JSON.stringify(sealed, null, 1) + '\n', { flag: 'wx' });
}
