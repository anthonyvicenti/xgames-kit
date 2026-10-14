// The sheet packs (sheet-packs.json): fetch a pack's zip, check its hash, unpack it into .cache/packs/<id>/.
// Downloaded files are data: they are unpacked into their own folder and never run. A HUD font is read from the asset
// library: its font pack's manifest names the file by sha256, and the bytes are in the library's store.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KIT } from './roots.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const SHEET_PACKS = JSON.parse(readFileSync(join(HERE, '../sheet-packs.json'), 'utf8'));
export const CACHE = join(KIT, '.cache/packs');

export const packDir = id => join(CACHE, id.replace(/^kenney-/, ''));
export const hasPack = id => existsSync(join(packDir(id), 'License.txt'));

/** Make sure the packs are unpacked; fetch the missing ones when `fetch` is true. → { ready: [], missing: [] } */
export async function ensurePacks(ids, { fetch: allowFetch = false, log = () => {} } = {}) {
  const ready = [], missing = [];
  for (const id of ids) {
    if (hasPack(id)) { ready.push(id); continue; }
    const p = SHEET_PACKS.packs[id];
    if (!p || !allowFetch) { missing.push(id); continue; }
    log(`fetching ${id} (${p.download})`);
    const r = await fetch(p.download);
    if (!r.ok) throw new Error(`${id}: download ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    const sha = createHash('sha256').update(buf).digest('hex');
    if (sha !== p.zipSha256) throw new Error(`${id}: zip sha256 ${sha} is not the pinned ${p.zipSha256}`);
    mkdirSync(packDir(id), { recursive: true });
    const zip = join(CACHE, `${id}.zip`);
    writeFileSync(zip, buf);
    execFileSync('unzip', ['-qo', zip, '-d', packDir(id)]);
    ready.push(id);
  }
  return { ready, missing };
}

/** The asset library's folder (library/, or XGAMES_LIBRARY) and its store (library.json → store, or XGAMES_STORE). */
function library() {
  const root = process.env.XGAMES_LIBRARY ?? join(KIT, 'library');
  let cfg = {};
  try { cfg = JSON.parse(readFileSync(join(root, 'library.json'), 'utf8')); } catch { /* no library in this checkout */ }
  const home = p => (p?.startsWith('~/') ? join(homedir(), p.slice(2)) : p);
  return { root, store: home(process.env.XGAMES_STORE ?? cfg.store ?? '~/.xgames/store') };
}

/** A font family's file for the HUD tile (sheet-packs.json → fonts → its library pack), or null with why. → {file, pack} | {missing} */
export function fontFile(family) {
  const f = SHEET_PACKS.fonts[family];
  if (!f) return { missing: `no font pack named for "${family}" in sheet-packs.json` };
  const { root, store } = library();
  const dir = join(root, 'packs', f.pack, 'assets');
  if (!existsSync(dir)) return { missing: `${f.pack}: not in the asset library (${dir})` };
  for (const name of readdirSync(dir).filter(n => n.endsWith('.json'))) {
    const a = JSON.parse(readFileSync(join(dir, name), 'utf8'));
    if (a.category !== 'font' || !a.sha256) continue;
    const file = join(store, 'sha256', a.sha256.slice(0, 2), a.sha256);
    if (existsSync(file)) return { file, pack: f.pack, ext: a.file.slice(a.file.lastIndexOf('.')) };
    return { missing: `${f.pack}/${a.id}: not in the library store (art fetch ${f.pack}/${a.id})` };
  }
  return { missing: `${f.pack}: no font asset` };
}
