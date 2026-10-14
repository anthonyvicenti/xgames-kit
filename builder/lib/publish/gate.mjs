// The check before a game goes public: its `verify --quick` must pass on exactly the files being published.
// A pass is remembered in <game>/.gamesfun/gate.json with the files' fingerprint (builder/lib/publish/tree.mjs), so publishing
// again without a change does not run verify again; any change to a published file runs it again. A game whose checks
// fail can still go up as a private draft (a version in the person's games.fun Studio, with no public link), and the
// person is told which checks failed.
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { BIN } from '../paths.mjs';
import { latestVerdict } from '../games.mjs';
import { buildTree } from './tree.mjs';

export const gateFile = dir => path.join(dir, '.gamesfun', 'gate.json');

export async function readGate(dir) {
  try { return JSON.parse(await readFile(gateFile(dir), 'utf8')); } catch { return null; }
}

/** The report games.fun records with the version: {pass, quick, passed, ran, failed:[{n, name}], at, kit, run}. */
export function reportOf(summary, kit = null) {
  if (!summary) return { pass: false, quick: false, passed: 0, ran: 0, failed: [], at: null, kit, run: null };
  return { pass: Boolean(summary.pass) && !(summary.failed ?? []).length && summary.ran > 0, quick: Boolean(summary.quick), passed: summary.passed ?? 0, ran: summary.ran ?? 0,
    failed: (summary.failed ?? []).map(c => ({ n: c.n, name: c.name })), at: summary.started ?? new Date().toISOString(), kit, run: summary.run ?? null };
}

/** Runs this kit's own `gamesfun verify <dir> --quick` (real Chrome). → exit code. `onLine` gets each output line. */
export function runVerify(dir, { onLine = () => {}, signal } = {}) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [BIN, 'verify', dir, '--quick'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, signal });
    let buf = '';
    const take = d => { buf += d; const lines = buf.split(/\r?\n/); buf = lines.pop(); lines.forEach(l => onLine(l)); };
    child.stdout.on('data', take); child.stderr.on('data', take);
    child.on('error', () => resolve(1));
    child.on('close', code => { if (buf) onLine(buf); resolve(code ?? 1); });
  });
}

/**
 * The game's check result for its current files: the remembered pass when the files are unchanged, else a fresh
 * `verify --quick` (unless `run: false`). → { report, fingerprint, ran: bool, reused: bool, changedDuring: bool }
 */
export async function gate(dir, { run = true, kit = null, onLine = () => {}, verify = runVerify, signal } = {}) {
  const before = (await buildTree(dir)).fingerprint;
  const saved = await readGate(dir);
  if (saved?.fingerprint === before && saved.report?.pass) return { report: saved.report, fingerprint: before, ran: false, reused: true, changedDuring: false };
  if (!run) return { report: reportOf(null, kit), fingerprint: before, ran: false, reused: false, changedDuring: false };
  const lastRun = (await latestVerdict(dir))?.run ?? null;
  await verify(dir, { onLine, signal });
  const after = (await buildTree(dir)).fingerprint;
  const fresh = await latestVerdict(dir);
  // A verify that stopped before writing its verdict leaves the old one newest: that is no result for these files.
  const report = reportOf(fresh && fresh.run !== lastRun ? fresh : null, kit);
  if (after !== before) return { report: { ...report, pass: false }, fingerprint: after, ran: true, reused: false, changedDuring: true };
  await mkdir(path.dirname(gateFile(dir)), { recursive: true });
  await writeFile(gateFile(dir), JSON.stringify({ fingerprint: after, report, savedAt: new Date().toISOString() }, null, 2) + '\n');
  return { report, fingerprint: after, ran: true, reused: false, changedDuring: false };
}
