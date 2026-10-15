// The files `gamesfun publish` sends: a game folder as games.fun's file tree (gf-tree-v1: path, sha256, bytes for
// every file; the bytes go up separately, only those games.fun does not have yet).
//
// Left out, never uploaded:  evidence/ (verify's screenshots and verdicts), supabase/ (a backend's server-side SQL:
//                            not secret, but not the game; `gamesfun backend`), node_modules/, and every hidden file
//                            or folder (.gitignore, .gamesfun/ where publish keeps the game's link and its last check).
// Refused (nothing is sent): a .env file anywhere in the folder, and symbolic links (a tree holds ordinary files).
// Added, in the upload only: foundation.lock.json and adaptation-plan.json when the game has none (games.fun keeps
// them with every version; a game made in the kit does not need them on disk). They are made from gf-three.json and
// spec.json, and the lock is the same for every kit publish, so each update of a game keeps it.
// Copied, in the upload only: spec.json without the names of the games it was made to look or play like
// (./names.mjs: the person's prompt keeps them on this machine; the published copy says "a reference game").
import { createHash } from 'node:crypto';
import { lstat, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { referenceNames, redactJson } from './names.mjs';

export const LEFT_OUT_DIRS = ['evidence', 'node_modules', 'supabase'];
export const TREE_FORMAT = 'gf-tree-v1';
export const KIT_LOCK = Object.freeze({ schemaVersion: 1, id: 'gf-three', version: 'kit', adapter: 'gamesfun-kit publish' });

export const sha256 = data => createHash('sha256').update(data).digest('hex');
/** Canonical JSON (sorted keys), as games.fun hashes trees. */
export function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
}

const readJson = async file => { try { return JSON.parse(await readFile(file, 'utf8')); } catch { return null; } };

/** The names of the games this one was made to look or play like (./names.mjs), from its spec and its loop's ledger. */
export async function referenceNamesOf(dir) {
  const spec = await readJson(path.join(dir, 'spec.json'));
  const state = await readJson(path.join(dir, '.gf-loop', 'state.json'));
  return referenceNames({ spec, ledger: state?.ledger ?? null });
}

/** The two files games.fun keeps with every version, made from the game's own records (`names` taken out). */
export async function kitRecords(dir, { names = [] } = {}) {
  const raw = (await readJson(path.join(dir, 'spec.json'))) ?? {};
  const spec = names.length ? redactJson(raw, names) : raw;
  const game = (await readJson(path.join(dir, 'config', 'game.json'))) ?? {};
  const record = (await readJson(path.join(dir, 'gf-three.json'))) ?? {};
  const title = game.text?.title ?? spec.title ?? path.basename(dir);
  const plan = {
    brief: String(spec.prompt || spec.hook || `${title}, made with the games.fun kit.`).slice(0, 2000),
    requirements: [spec.hook, ...(spec.mechanics ?? []).map(m => `${m.id}: ${m.as ?? ''}`.trim()), ...(spec.accept ?? [])].filter(Boolean).slice(0, 40),
    selectionRationale: `Made with xgames-kit on ${record.kit?.profile ? `${record.kit.runtime}/${record.kit.profile}` : record.kit?.runtime ?? 'three'} (kit ${record.kit?.version ?? 'unknown'}) and published from it.`,
    missingFeatures: Array.isArray(spec.notInV1) ? spec.notInV1 : [],
  };
  if (!plan.requirements.length) plan.requirements = ['Publish the game as built.'];
  return { lock: KIT_LOCK, plan, title };
}

/**
 * Build the tree for `dir`. → { tree: {schemaVersion, format, files:[{path, sha256, bytes}]}, sources: Map<sha256,
 * {file?, data?}>, bytes, skipped: [path], refused: [{path, why}], added: [path], copied: [path] (sent as a copy
 * without the reference names), names (those names), fingerprint, title }
 * `fingerprint` names exactly these files with these contents (the check gate keys its pass on it).
 */
export async function buildTree(dir) {
  const root = path.resolve(dir), files = [], sources = new Map(), skipped = [], refused = [], copied = [];
  const names = await referenceNamesOf(root);
  async function walk(abs, rel) {
    const entries = (await readdir(abs, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      const relPath = rel ? `${rel}/${e.name}` : e.name, full = path.join(abs, e.name);
      if (/^\.env(\..*)?$/i.test(e.name)) { refused.push({ path: relPath, why: 'a .env file: secrets never live in a game folder; move it out of the game' }); continue; }
      if (e.name.startsWith('.')) { skipped.push(relPath + (e.isDirectory() ? '/' : '')); continue; }
      if (!rel && LEFT_OUT_DIRS.includes(e.name) && e.isDirectory()) { skipped.push(relPath + '/'); continue; }
      if (e.name === 'node_modules') { skipped.push(relPath + '/'); continue; }
      const st = await lstat(full);
      if (st.isSymbolicLink()) { refused.push({ path: relPath, why: 'a symbolic link: a published game holds ordinary files only' }); continue; }
      if (st.isDirectory()) { await walk(full, relPath); continue; }
      if (!st.isFile()) { refused.push({ path: relPath, why: 'not an ordinary file' }); continue; }
      let data = await readFile(full), own = false;
      // the spec goes up as a copy without the reference games' names (the file on disk keeps the person's words)
      if (relPath === 'spec.json' && names.length) {
        try { const red = Buffer.from(JSON.stringify(redactJson(JSON.parse(data.toString('utf8')), names), null, 2) + '\n'); if (!red.equals(data)) { data = red; own = true; copied.push(relPath); } } catch { /* not JSON: scanned as it is */ }
      }
      const sha = sha256(data);
      files.push({ path: relPath, sha256: sha, bytes: data.length });
      if (!sources.has(sha)) sources.set(sha, own ? { data } : { file: full });
    }
  }
  await walk(root, '');
  const added = [], { lock, plan, title } = await kitRecords(root, { names });
  for (const [name, value] of [['foundation.lock.json', lock], ['adaptation-plan.json', plan]]) {
    if (files.some(f => f.path === name)) continue;
    const data = Buffer.from(JSON.stringify(value, null, 2) + '\n'), sha = sha256(data);
    files.push({ path: name, sha256: sha, bytes: data.length });
    if (!sources.has(sha)) sources.set(sha, { data });
    added.push(name);
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const tree = { schemaVersion: 1, format: TREE_FORMAT, files };
  return { tree, sources, bytes: files.reduce((n, f) => n + f.bytes, 0), skipped, refused, added, copied, names, fingerprint: sha256(canonical(files)), title };
}

/** A file's bytes for upload: from disk, or the made-up records. */
export async function sourceBytes(source) {
  return source.data ?? readFile(source.file);
}
