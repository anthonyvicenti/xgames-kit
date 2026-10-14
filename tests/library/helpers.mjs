// Test helpers: a library in a temporary folder, and asset manifests made from a few fields.
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, LIBRARY_ROOT } from '../../builder/art/config.mjs';
import { encodePng, blank } from '../../builder/art/png.mjs';

export async function tempLibrary() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'art-lib-'));
  const env = { XGAMES_STORE: path.join(root, 'store'), XGAMES_PRIVATE_PACKS: path.join(root, 'private'), XGAMES_QUARANTINE: path.join(root, 'quarantine'), XGAMES_KINDS: path.join(root, 'kinds') };
  const config = { ...loadConfig({ root, env }), policyFile: path.join(LIBRARY_ROOT, 'policy.json') };
  await mkdir(config.packsDir, { recursive: true });
  return { root, config, cleanup: () => rm(root, { recursive: true, force: true }) };
}

const sha = n => n.toString(16).padStart(64, '0');
let next = 1;

/** A pack with assets, written to the library. assets: [{ id, category, … }] */
export async function writeTestPack(config, def, assets) {
  const pack = { packVersion: 1, owner: 'third-party', visibility: 'public', dimension: '3d', source: { kind: 'own', store: 'test' }, licence: { spdx: 'CC0-1.0' }, title: def.id, ...def };
  const dir = path.join(pack.visibility === 'private' ? path.join(config.privatePacks, 'packs') : config.packsDir, pack.id);
  await mkdir(path.join(dir, 'assets'), { recursive: true });
  await writeFile(path.join(dir, 'pack.json'), JSON.stringify(pack));
  for (const a of assets) {
    const m = { assetVersion: 1, pack: pack.id, file: `${a.id}.glb`, sha256: sha(next++), bytes: 1000, dimension: '3d', category: 'prop', describe: a.id.replace(/-/g, ' '), tags: [], validated: [], ...a };
    await writeFile(path.join(dir, 'assets', `${a.id}.json`), JSON.stringify(m));
  }
  return dir;
}

/** A small RGBA PNG: a filled square of one colour on a see-through ground. */
export function squarePng(size = 16, rgb = [200, 40, 40], { fill = 0.6, outline = null } = {}) {
  const pic = blank(size, size), lo = Math.floor(size * (1 - fill) / 2), hi = size - lo;
  for (let y = lo; y < hi; y++) for (let x = lo; x < hi; x++) {
    const edge = outline && (x === lo || y === lo || x === hi - 1 || y === hi - 1);
    const c = edge ? outline : rgb, i = (y * size + x) * 4;
    pic.data[i] = c[0]; pic.data[i + 1] = c[1]; pic.data[i + 2] = c[2]; pic.data[i + 3] = 255;
  }
  return { pic, png: encodePng(pic) };
}
