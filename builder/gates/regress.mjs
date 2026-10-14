#!/usr/bin/env node
// The gates' regressions: every problem a person found by playing becomes a broken example a gate must fail, for the
// reason it names (builder/GATES.md, "never again"; builder/gates/regressions/README.md).
//
//   node builder/gates/regress.mjs [--only id[,id…]] [--record] [--keep] [--json]
//
// Each regressions/<id>/regression.json names a base (regressions/bases/<base>/: a locked spec v2, the game's own files
// and base.json's config patches), the smallest change that brings the mistake back (`files` copied over the base,
// `patches` set by JSON pointer, as Studio's overrides are) and what verify must say: `mustFail` (the gates that fail,
// with `measure`, the measure inside the gate that sees it, and `detail`, a pattern its words must match) or, for a
// control, `mustPass` (the same base with the mistake fixed passes the measures that would catch it). Each runs on a
// fresh game: create from the base's spec (builder/lib/create.mjs), the base's files and patches, the change, then
// verify with only that measure (`run`: {"check": [n…]} or {"gate": "C"} to run more). The games are made in the
// system's temporary folder, so this runs from any checkout; --keep leaves them there.
//
// --record writes regressions/last-green.json when every regression did what it must: the fingerprint of the files
// that decide the verdicts (verify, the checks, the verdict rule, this runner and the regressions) and each result.
// tests/gates-regressions.test.mjs fails while that fingerprint is not the current one: a change to a gate is
// recorded green on the GPU before it lands.
import { isMain } from '../tools/lib/main.mjs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gateOf } from '../tools/lib/verdict.mjs';
import { cpWritable } from '../lib/writable.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const KIT = resolve(HERE, '../..');
export const REGRESSIONS = join(HERE, 'regressions');
export const LAST_GREEN = join(REGRESSIONS, 'last-green.json');

/** The files whose change can change a regression's verdict (their hashes are last-green.json's fingerprint). */
export async function fingerprintFiles() {
  const lib = join(KIT, 'builder/tools/lib');
  const checks = (await readdir(lib)).filter(f => /-check\.mjs$/.test(f)).map(f => `builder/tools/lib/${f}`);
  const own = [];
  const walk = async (dir, rel) => { for (const e of await readdir(dir, { withFileTypes: true })) { const r = `${rel}/${e.name}`; if (e.isDirectory()) await walk(join(dir, e.name), r); else if (e.name !== 'last-green.json') own.push(r); } };
  await walk(REGRESSIONS, 'builder/gates/regressions');
  // the runtimes' own verify flows, the flows' signs, and measure 5's two-player gate and presence part decide verdicts too
  const flows = ['builder/tools/verify-forge.mjs', 'builder/tools/verify-vista.mjs', 'builder/tools/verify-world.mjs', 'builder/tools/lib/flow-signs.mjs',
    'builder/tools/lib/presence.mjs', 'builder/multiplayer/party/gate.mjs', 'builder/multiplayer/party/gate-live.mjs'];
  return [...['builder/tools/verify.mjs', 'builder/tools/lib/verdict.mjs', 'builder/tools/lib/stepped.mjs', 'builder/gates/regress.mjs'], ...flows, ...checks, ...own].sort();
}
/** {file: sha256} over fingerprintFiles(), and one hash of them all. */
export async function fingerprint() {
  const files = {};
  for (const f of await fingerprintFiles()) files[f] = createHash('sha256').update(await readFile(join(KIT, f))).digest('hex');
  const all = createHash('sha256').update(JSON.stringify(files)).digest('hex');
  return { all, files };
}

/** Every regression: its folder's regression.json with its id and folder. */
export async function listRegressions() {
  const out = [];
  for (const e of await readdir(REGRESSIONS, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name === 'bases') continue;
    const file = join(REGRESSIONS, e.name, 'regression.json');
    if (!existsSync(file)) continue;
    out.push({ ...JSON.parse(await readFile(file, 'utf8')), id: e.name, dir: join(REGRESSIONS, e.name) });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/** What is wrong with a regression.json (an empty list when nothing is). */
export function problemsOf(r) {
  const p = [];
  if (!r.base || !existsSync(join(REGRESSIONS, 'bases', r.base, 'spec.json'))) p.push(`base "${r.base}" has no regressions/bases/${r.base}/spec.json`);
  const gates = r.mustFail ?? r.mustPass;
  if (!!r.mustFail === !!r.mustPass) p.push('needs mustFail (a broken example) or mustPass (a control), not both');
  if (!Array.isArray(gates) || !gates.length) p.push('names no gate');
  if (!Number.isInteger(r.measure)) p.push('names no measure');
  else if (Array.isArray(gates) && !gates.includes(gateOf(r.measure))) p.push(`measure ${r.measure} is in gate ${gateOf(r.measure)}, not in ${gates.join(', ')}`);
  if (r.mustFail && typeof r.detail !== 'string') p.push('a broken example names the detail its gate must print (detail: a pattern)');
  if (typeof r.why !== 'string' || !r.why) p.push('says nothing of why (why)');
  for (const to of Object.keys(r.files ?? {})) if (/^(gf|vendor|audio)\//.test(to)) p.push(`files changes ${to}: a kit copy (a regression changes the game's own files; an edited kit copy is gate A's)`);
  return p;
}

/** JSON pointer set (RFC 6901), the way Studio's overrides patch config. */
function setPointer(obj, pointer, value) {
  const parts = pointer.split('/').slice(1).map(s => s.replace(/~1/g, '/').replace(/~0/g, '~'));
  let o = obj;
  for (const k of parts.slice(0, -1)) { if (o[k] === undefined) o[k] = /^\d+$/.test(k) ? [] : {}; o = o[k]; }
  o[parts.at(-1)] = value;
}
async function applyPatches(game, patches = []) {
  const byFile = new Map();
  for (const p of patches) { if (!byFile.has(p.file)) byFile.set(p.file, []); byFile.get(p.file).push(p); }
  for (const [file, ps] of byFile) {
    const f = join(game, file), json = JSON.parse(await readFile(f, 'utf8'));
    for (const p of ps) setPointer(json, p.pointer, p.value);
    await writeFile(f, JSON.stringify(json, null, 2) + '\n');
  }
}
/** Copy a folder's files (not the base's own spec.json and base.json) over the game. */
async function overlay(from, game, { skip = [] } = {}) {
  for (const e of await readdir(from, { withFileTypes: true })) {
    if (skip.includes(e.name)) continue;
    await cpWritable(join(from, e.name), join(game, e.name), { recursive: true });
  }
}

/** Make one regression's game in `root`. → the game's folder */
export async function makeGame(r, root, { log = () => {} } = {}) {
  const { createGame } = await import('../lib/create.mjs');
  const base = join(REGRESSIONS, 'bases', r.base), game = join(root, r.id);
  await rm(game, { recursive: true, force: true });
  await createGame(game, { spec: join(base, 'spec.json'), force: true, cwd: KIT, env: { ...process.env, GAMESFUN_WEB3: '0' } });
  await overlay(base, game, { skip: ['spec.json', 'base.json', 'README.md'] });
  const b = existsSync(join(base, 'base.json')) ? JSON.parse(await readFile(join(base, 'base.json'), 'utf8')) : {};
  await applyPatches(game, b.patches);
  for (const [to, from] of Object.entries(r.files ?? {})) { await mkdir(dirname(join(game, to)), { recursive: true }); await cpWritable(join(r.dir, from), join(game, to)); }
  await applyPatches(game, r.patches);
  log(`  made ${relative(root, game)} (base ${r.base}${Object.keys(r.files ?? {}).length ? `, ${Object.keys(r.files).join(', ')} changed` : ''}${r.patches?.length ? `, ${r.patches.length} patches` : ''})`);
  return game;
}

/** Did verify say what the regression must? → {ok, why, gates, measure: {ok, detail}} */
export function judge(r, rec) {
  const m = rec.checks.find(c => c.n === r.measure);
  const failedGates = [...new Set(rec.checks.filter(c => c.ok === false && c.gate).map(c => c.gate))];
  if (r.mustFail) {
    const missing = r.mustFail.filter(g => !failedGates.includes(g));
    const re = new RegExp(r.detail, 'i');
    if (!m) return { ok: false, why: `measure ${r.measure} did not run`, failedGates };
    if (m.ok !== false) return { ok: false, why: `measure ${r.measure} passed: "${String(m.detail).slice(0, 300)}"`, failedGates };
    if (missing.length) return { ok: false, why: `gate ${missing.join(', ')} did not fail`, failedGates };
    if (!re.test(m.detail)) return { ok: false, why: `measure ${r.measure} failed for another reason than /${r.detail}/: "${String(m.detail).slice(0, 400)}"`, failedGates };
    return { ok: true, why: `gate ${r.mustFail.join(', ')} failed, measure ${r.measure}: ${String(m.detail).slice(0, 300)}`, failedGates };
  }
  const bad = r.mustPass.filter(g => failedGates.includes(g));
  if (!m) return { ok: false, why: `measure ${r.measure} did not run`, failedGates };
  if (m.ok !== true || bad.length) return { ok: false, why: `the control failed${bad.length ? ` gate ${bad.join(', ')}` : ''}: measure ${r.measure} "${String(m.detail).slice(0, 400)}"`, failedGates };
  return { ok: true, why: `passes measure ${r.measure}: ${String(m.detail).slice(0, 300)}`, failedGates };
}

export async function regress({ only = null, record = false, keep = false, log = console.log } = {}) {
  const { verify } = await import('../tools/verify.mjs');
  const all = await listRegressions();
  const list = only ? all.filter(r => only.includes(r.id)) : all;
  if (only && list.length !== only.length) throw new Error(`no regression named ${only.filter(id => !all.some(r => r.id === id)).join(', ')}`);
  const root = await mkdtemp(join(tmpdir(), 'xgk-regress-'));
  const results = [], t0 = Date.now();
  try {
    for (const r of list) {
      const t = Date.now(), problems = problemsOf(r);
      if (problems.length) { results.push({ id: r.id, ok: false, why: `regression.json: ${problems.join('; ')}` }); log(`FAIL ${r.id}: ${problems.join('; ')}`); continue; }
      log(`${r.id} (${r.mustFail ? `must fail ${r.mustFail.join(', ')}` : `control: must pass ${r.mustPass.join(', ')}`}, measure ${r.measure})`);
      let res;
      try {
        const game = await makeGame(r, root, { log });
        const run = r.run ?? { check: [r.measure] };
        const rec = await verify(game, { out: join(root, `${r.id}-verify`), log: () => {}, only: run.check ?? null, gates: run.gate ? [].concat(run.gate) : null });
        res = judge(r, rec);
      } catch (e) { res = { ok: false, why: `could not run: ${e.message}` }; }
      results.push({ id: r.id, kind: r.mustFail ? 'broken' : 'control', gates: r.mustFail ?? r.mustPass, measure: r.measure, ok: res.ok, why: res.why, seconds: Math.round((Date.now() - t) / 1000) });
      log(`${res.ok ? 'ok  ' : 'FAIL'} ${r.id}: ${res.why}`);
    }
  } finally { if (!keep) await rm(root, { recursive: true, force: true }); else log(`games kept in ${root}`); }
  const ok = results.length > 0 && results.every(x => x.ok);
  const out = { schema: 'xgk-regress/1', date: new Date().toISOString(), ok, seconds: Math.round((Date.now() - t0) / 1000), results };
  if (record) {
    if (!ok) throw new Error('not recorded: a regression did not do what it must');
    if (only) throw new Error('not recorded: --record runs every regression (no --only)');
    const fp = await fingerprint();
    await writeFile(LAST_GREEN, JSON.stringify({ ...out, fingerprint: fp.all, files: fp.files, machine: { node: process.version, platform: process.platform } }, null, 1) + '\n');
    log(`recorded ${relative(KIT, LAST_GREEN)}`);
  }
  return out;
}

if (isMain(import.meta)) {
  const a = process.argv.slice(2), opt = n => { const i = a.indexOf(n); return i >= 0 ? a[i + 1] : null; };
  const json = a.includes('--json');
  const r = await regress({ only: opt('--only')?.split(',') ?? null, record: a.includes('--record'), keep: a.includes('--keep'), log: json ? () => {} : console.log });
  if (json) console.log(JSON.stringify(r, null, 1));
  else console.log(`${r.ok ? 'GREEN' : 'NOT GREEN'}: ${r.results.filter(x => x.ok).length}/${r.results.length} in ${r.seconds} s`);
  process.exitCode = r.ok ? 0 : 1;
}
