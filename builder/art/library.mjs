// Reading and writing the library: packs (pack.json), their assets (assets/<id>.json) and previews, public and private.
// A pack's folder: packs/<id>/{pack.json, assets/<asset>.json, previews/<asset>.png, LICENSE.txt}.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { packDir } from './config.mjs';

const json = v => JSON.stringify(v, null, 1) + '\n';
const readJson = f => JSON.parse(readFileSync(f, 'utf8'));

export const ID = /^[a-z0-9][a-z0-9._-]*$/;
/** An asset's library-wide reference: <pack>/<asset>. */
export const refOf = a => `${a.pack}/${a.id}`;

function packsIn(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory() && existsSync(path.join(dir, e.name, 'pack.json'))).map(e => path.join(dir, e.name));
}

/** One pack folder → { pack, assets, dir }. */
export function readPack(dir) {
  const pack = readJson(path.join(dir, 'pack.json'));
  const adir = path.join(dir, 'assets');
  const assets = existsSync(adir) ? readdirSync(adir).filter(f => f.endsWith('.json')).sort().map(f => readJson(path.join(adir, f))) : [];
  return { pack, assets, dir };
}

/**
 * Every pack the caller can see: the public ones in git and, unless { privatePacks: false }, the private ones in the
 * configured private folder. → [{ pack, assets, dir }]
 */
export function loadLibrary(config, { privatePacks = true } = {}) {
  const dirs = [...packsIn(config.packsDir), ...(privatePacks ? packsIn(path.join(config.privatePacks, 'packs')) : [])];
  return dirs.map(readPack);
}

/** All assets with their pack attached: [{ ...asset, _pack: pack }] */
export function allAssets(lib) { return lib.flatMap(p => p.assets.map(a => ({ ...a, _pack: p.pack }))); }

export async function writePack(config, pack) {
  const dir = packDir(config, pack);
  await mkdir(path.join(dir, 'assets'), { recursive: true });
  await writeFile(path.join(dir, 'pack.json'), json(pack));
  return dir;
}

export async function writeAsset(config, pack, asset, { preview = null } = {}) {
  const dir = packDir(config, pack);
  await mkdir(path.join(dir, 'assets'), { recursive: true });
  if (preview) {
    await mkdir(path.join(dir, 'previews'), { recursive: true });
    await writeFile(path.join(dir, 'previews', `${asset.id}.png`), preview);
  }
  await writeFile(path.join(dir, 'assets', `${asset.id}.json`), json(asset));
  return dir;
}

/** The pack that holds a sha256 already, if any: → { pack, asset } or null. */
export function findBySha(lib, sha) {
  for (const p of lib) for (const a of p.assets) if (a.sha256 === sha || (a.variants ?? []).some(v => v.sha256 === sha)) return { pack: p.pack, asset: a };
  return null;
}
