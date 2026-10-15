// A game's reference images, by content. The images stay local (outside every repository, never in a published game,
// never an image-to-image source); a spec carries only each one's sha256 and source URL (spec.look.refs). A reference
// folder holds the images and a manifest.json (gf-look-refs/1):
//
//   { "schema": "gf-look-refs/1", "name": "…", "made": "2026-10-14", "game": "the reference game's name (optional)",
//     "frames": [{ "file": "01-gameplay.jpg", "sha256": "…", "url": "https://…", "frame": "gameplay", "note": "…" }] }
//
//   const m = await readManifest(dir);                 // the frames with absolute `file`, sha256 checked
//   spec.look.refs = refsOf(m.frames);                 // what the spec carries
//   const { frames, missing } = await findRefs(spec.look.refs);   // back to local files on this machine
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const REFS_SCHEMA = 'gf-look-refs/1';
const IMAGE = /\.(png|jpe?g|webp)$/i;
const FRAMES = new Set(['gameplay', 'character', 'terrain', 'ui', 'vfx', 'scene', 'other']);

export const sha256Of = async file => createHash('sha256').update(await readFile(file)).digest('hex');

/** The reference folders on this machine, in the order they are searched (each may hold manifests in subfolders). */
export function refDirs(env = process.env) {
  const dirs = [];
  if (env.XGK_LOOK_REFS) dirs.push(...env.XGK_LOOK_REFS.split(path.delimiter).filter(Boolean));
  if (env.XGK_EVAL_PRIVATE) dirs.push(path.join(env.XGK_EVAL_PRIVATE, 'looks'));
  dirs.push(path.join(os.homedir(), '.gamesfun', 'look-refs'));
  return dirs.filter(d => existsSync(d));
}

/**
 * A reference folder → {name, dir, frames: [{file, sha256, url, frame, note, size?}]}. With no manifest.json the
 * folder's images are the frames (no source URL). A manifest's sha256 that does not match its file is a problem: the
 * frame is left out and listed in `problems`.
 */
export async function readManifest(dir) {
  dir = path.resolve(dir);
  const file = path.join(dir, 'manifest.json');
  const problems = [];
  if (!existsSync(file)) {
    const frames = [];
    for (const f of readdirSync(dir).filter(f => IMAGE.test(f)).sort()) frames.push({ file: path.join(dir, f), sha256: await sha256Of(path.join(dir, f)), frame: 'other' });
    return { name: path.basename(dir), dir, frames, problems };
  }
  const m = JSON.parse(await readFile(file, 'utf8'));
  if (m.schema && m.schema !== REFS_SCHEMA) problems.push(`${file}: schema ${m.schema}, not ${REFS_SCHEMA}`);
  const frames = [];
  for (const f of m.frames ?? []) {
    const abs = path.resolve(dir, f.file);
    if (!existsSync(abs)) { problems.push(`${f.file}: missing`); continue; }
    const sha = await sha256Of(abs);
    if (f.sha256 && f.sha256 !== sha) { problems.push(`${f.file}: sha256 ${sha.slice(0, 12)}… is not the manifest's ${f.sha256.slice(0, 12)}…`); continue; }
    frames.push({ ...f, file: abs, sha256: sha, frame: FRAMES.has(f.frame) ? f.frame : 'other', ...(!f.game && m.game ? { game: String(m.game) } : {}) });
  }
  return { name: m.name ?? path.basename(dir), dir, frames, problems };
}

/** Frames → what spec.look.refs carries (no local path ever). `game` (the reference game's name) is a local record: the
 *  publish scan refuses a game whose shipped files carry it, and the published spec.json is a copy without it. */
export function refsOf(frames) {
  return frames.map(f => ({
    sha256: f.sha256,
    ...(f.url && /^https?:\/\//.test(f.url) ? { url: String(f.url).slice(0, 400) } : {}),
    frame: FRAMES.has(f.frame) ? f.frame : 'other',
    ...(f.note ? { note: String(f.note).slice(0, 200) } : {}),
    ...(f.size ? { size: f.size } : {}),
    ...(f.game ? { game: String(f.game).slice(0, 120) } : {}),
  }));
}

/** Every manifest under the reference folders (the folder itself and its subfolders, one level). */
async function manifestsUnder(dirs) {
  const out = [];
  for (const d of dirs) {
    const cands = [d, ...readdirSync(d).map(x => path.join(d, x)).filter(x => statSync(x).isDirectory())];
    for (const c of cands) if (existsSync(path.join(c, 'manifest.json'))) out.push(await readManifest(c));
  }
  return out;
}

/**
 * spec.look.refs → the local frames on this machine. → {frames: [{...ref, file}], missing: [sha256]}. Found through
 * the manifests in `dirs` (default refDirs()); a manifest's frame is trusted by its checked sha256.
 */
export async function findRefs(refs, { dirs = refDirs() } = {}) {
  const bySha = new Map();
  for (const m of await manifestsUnder(dirs)) for (const f of m.frames) bySha.set(f.sha256, f);
  const frames = [], missing = [];
  for (const r of refs ?? []) {
    const f = bySha.get(r.sha256);
    if (f) frames.push({ ...r, file: f.file, url: r.url ?? f.url }); else missing.push(r.sha256);
  }
  return { frames, missing };
}
