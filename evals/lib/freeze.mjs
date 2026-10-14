// Freezing eval sets. A set is a folder (paired/, breadth/, depth/, cases/). Freezing writes one manifest,
// <set>/frozen/<date>-<n>.json, that lists a hash for every file not already listed by an earlier manifest. Manifests
// are never edited: a later freeze adds a new one, so a set only grows (evals are append only). check() fails when a
// file a manifest lists is missing or no longer has its hash.
//
// The hash does not depend on formatting: a .json file is hashed as canonical JSON (keys sorted, no spaces), a text
// file with its line endings made \n. So an editor or git that re-indents JSON or turns \n into \r\n changes nothing;
// a changed word or value always does.
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

export const MANIFEST_SCHEMA = 'xgk-eval-frozen/1';
const TEXT = new Set(['.md', '.txt', '.mjs', '.js', '.csv', '.html']);
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export const sha256 = data => createHash('sha256').update(data).digest('hex');

/** JSON with every object's keys sorted and no whitespace: the same value always gives the same text. */
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** The hash of one file's content, by its kind (see the top of this file). */
export function hashContent(name, buf) {
  const ext = path.extname(name).toLowerCase();
  if (ext === '.json') return sha256(canonical(JSON.parse(buf.toString('utf8'))));
  if (TEXT.has(ext)) return sha256(buf.toString('utf8').replace(/\r\n/g, '\n'));
  return sha256(buf);
}

export const hashFile = async file => hashContent(file, await readFile(file));

/** One hash for a list of {path: hash}: the sorted "path hash" lines. */
export const setHash = files => sha256(Object.keys(files).sort().map(p => `${p} ${files[p]}\n`).join(''));

/** Every file in a set folder, relative and with / separators, except the manifests themselves. */
export async function listFiles(dir, base = dir, out = []) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    const rel = path.relative(base, p).split(path.sep).join('/');
    if (e.isDirectory()) { if (rel !== 'frozen') await listFiles(p, base, out); }
    else out.push(rel);
  }
  return out.sort();
}

/** The set's manifests, oldest first. */
export async function readManifests(setDir) {
  const dir = path.join(setDir, 'frozen');
  if (!existsSync(dir)) return [];
  const names = (await readdir(dir)).filter(n => /^\d{4}-\d{2}-\d{2}-\d+\.json$/.test(n));
  const order = n => { const [, d, i] = /^(.{10})-(\d+)/.exec(n); return `${d}-${i.padStart(4, '0')}`; };
  names.sort((a, b) => order(a).localeCompare(order(b)));
  return Promise.all(names.map(async n => ({ name: n, ...JSON.parse(await readFile(path.join(dir, n), 'utf8')) })));
}

/** Check a set against its manifests. → {ok, problems: [text], frozen: {path: {hash, date, manifest}}, loose: [path]} */
export async function checkSet(setDir) {
  const problems = [], frozen = {};
  const manifests = await readManifests(setDir);
  for (const m of manifests) {
    if (m.schema !== MANIFEST_SCHEMA) problems.push(`${m.name}: schema is ${m.schema}, not ${MANIFEST_SCHEMA}`);
    if (!DAY.test(m.date ?? '')) problems.push(`${m.name}: no date`);
    if (setHash(m.files ?? {}) !== m.setHash) problems.push(`${m.name}: its setHash does not match its own file list (the manifest was edited)`);
    for (const [rel, hash] of Object.entries(m.files ?? {})) {
      if (frozen[rel]) problems.push(`${m.name}: ${rel} was already frozen by ${frozen[rel].manifest}`);
      frozen[rel] = { hash, date: m.date, manifest: m.name };
    }
  }
  const present = new Set(await listFiles(setDir));
  for (const [rel, f] of Object.entries(frozen)) {
    const file = path.join(setDir, rel);
    if (!present.has(rel)) { problems.push(`${rel}: frozen by ${f.manifest} and now missing`); continue; }
    const now = await hashFile(file);
    if (now !== f.hash) problems.push(`${rel}: changed since it was frozen on ${f.date} (${f.manifest}); make a new case instead`);
    if (path.extname(rel) === '.json') {
      const v = JSON.parse(await readFile(file, 'utf8'));
      if (typeof v.frozen === 'string' && v.frozen !== f.date) problems.push(`${rel}: says frozen ${v.frozen}, its manifest says ${f.date}`);
    }
  }
  const loose = [...present].filter(rel => !frozen[rel]);
  return { ok: problems.length === 0, problems, frozen, loose, manifests: manifests.map(m => m.name) };
}

/**
 * Freeze every file of a set that no manifest lists yet. Refuses when the set fails check() (a frozen file changed),
 * when nothing is new, or when a new JSON file says it is frozen on another day. → the manifest written.
 */
export async function freezeSet(setDir, { date, note = '' } = {}) {
  if (!DAY.test(date ?? '')) throw Error(`freeze needs --date YYYY-MM-DD (got ${date})`);
  const state = await checkSet(setDir);
  if (!state.ok) throw Error(`cannot freeze ${setDir}:\n  ${state.problems.join('\n  ')}`);
  if (!state.loose.length) throw Error(`nothing new to freeze in ${setDir}`);
  const files = {};
  for (const rel of state.loose) {
    const file = path.join(setDir, rel);
    if (path.extname(rel) === '.json') {
      const v = JSON.parse(await readFile(file, 'utf8'));
      if (typeof v.frozen === 'string' && v.frozen !== date) throw Error(`${rel} says frozen ${v.frozen}; freezing on ${date}`);
    }
    files[rel] = await hashFile(file);
  }
  const dir = path.join(setDir, 'frozen');
  await mkdir(dir, { recursive: true });
  let n = 1;
  while (existsSync(path.join(dir, `${date}-${n}.json`))) n++;
  const manifest = { schema: MANIFEST_SCHEMA, set: path.basename(setDir), date, note, files, setHash: setHash(files) };
  const out = path.join(dir, `${date}-${n}.json`);
  await writeFile(out, JSON.stringify(manifest, null, 1) + '\n', { flag: 'wx' });
  return { file: out, ...manifest };
}
