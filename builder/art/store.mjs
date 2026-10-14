// The binary store: every asset file by its sha256, outside git. Manifests in git name a file by hash; `fetchAsset`
// finds the bytes in the local store, then in the kit's default set (library/defaults, in git), then in each configured
// mirror ("https://…/{sha256}" or a folder), then at the pack's pinned source: the file itself when the asset is that
// file byte for byte, else by running the pack's rebuild line (rebuild.mjs). A file is only ever kept under its own hash.
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { copyFileWritable } from '../lib/writable.mjs';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

/** Where a hash lives in a store folder: sha256/ab/<hash>. */
export const storePath = (store, hash) => path.join(store, 'sha256', hash.slice(0, 2), hash);

export const inStore = (store, hash) => existsSync(storePath(store, hash));

/** Where the bytes of a hash are on this machine without fetching: the local store, else the kit's default set. */
export function localPath(config, hash) {
  for (const dir of [config.store, config.defaults]) if (dir && existsSync(storePath(dir, hash))) return storePath(dir, hash);
  return null;
}

/** Keep bytes in the store. → { sha256, path, bytes, added } (added: false when it was there already). */
export async function put(store, bytes) {
  const hash = sha256(bytes), file = storePath(store, hash);
  if (existsSync(file)) return { sha256: hash, path: file, bytes: bytes.length, added: false };
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, bytes);
  await rename(tmp, file);
  return { sha256: hash, path: file, bytes: bytes.length, added: true };
}

/** Keep a file from disk in the store. */
export async function putFile(store, file) { return put(store, await readFile(file)); }

const fill = (tpl, hash) => tpl.replaceAll('{sha256}', hash).replaceAll('{ab}', hash.slice(0, 2));

/** Bytes from one place, checked against the hash; null when the place does not have them. */
async function tryPlace(where, hash, { fetchImpl = fetch } = {}) {
  try {
    let bytes;
    if (/^https?:\/\//.test(where)) {
      const r = await fetchImpl(fill(where, hash));
      if (!r.ok) return null;
      bytes = Buffer.from(await r.arrayBuffer());
    } else {
      const file = where.includes('{sha256}') ? fill(where, hash) : storePath(where, hash);
      if (!existsSync(file)) return null;
      bytes = await readFile(file);
    }
    return sha256(bytes) === hash ? bytes : null;
  } catch { return null; }
}

/**
 * The bytes of an asset, fetched into the local store when they are missing. asset: an asset manifest; pack: its pack.
 * → { path, from } or throws with the places it tried.
 */
export async function fetchAsset(config, asset, pack = null, { fetchImpl = fetch, rebuild = true } = {}) {
  const hash = asset.sha256, local = storePath(config.store, hash);
  if (existsSync(local)) return { path: local, from: 'store' };
  if (config.defaults && existsSync(storePath(config.defaults, hash))) return { path: storePath(config.defaults, hash), from: 'defaults' };
  const tried = ['the local store', ...(config.defaults ? ['the kit\'s default set'] : [])];
  for (const m of config.mirrors ?? []) {
    const bytes = await tryPlace(m, hash, { fetchImpl });
    if (bytes) { await put(config.store, bytes); return { path: local, from: m }; }
    tried.push(m);
  }
  // the pack's pinned source, only when the asset is that file unchanged
  const direct = asset.source?.download && asset.source?.sha256 === hash ? asset.source.download : null;
  if (direct) {
    const bytes = await tryPlace(direct, hash, { fetchImpl });
    if (bytes) { await put(config.store, bytes); return { path: local, from: direct }; }
    tried.push(direct);
  }
  // the pack's pinned source again, through its rebuild line (an `art ingest` of the pinned zip)
  if (rebuild && pack && rebuildable(pack)) {
    const { rebuildPack } = await import('./rebuild.mjs');
    const r = await rebuildPack(config, pack, { fetchImpl });
    if (existsSync(local)) return { path: local, from: `rebuilt from ${pack.source.download}` };
    tried.push(`a rebuild from ${pack.source.download} (${r.made} files made, none with this hash)`);
  }
  const how = pack?.source?.rebuild ? ` It is rebuilt from the pack's pinned source by: ${pack.source.rebuild}` : '';
  throw new Error(`${asset.pack}/${asset.id}: the file ${hash.slice(0, 12)}… is not in ${tried.join(', ')}.${how}`);
}

/** Can `art fetch` rebuild this pack by itself: a pinned zip and an `art ingest` rebuild line. */
export const rebuildable = pack => !!(pack?.source?.download && pack.source.sha256 && /^art ingest \S+/.test(pack.source.rebuild ?? ''));

/** Copy an asset's bytes out of the store to a path (a game's own copy). */
export async function exportAsset(config, asset, to, opts = {}) {
  const { path: from } = await fetchAsset(config, asset, opts.pack ?? null, opts);
  await mkdir(path.dirname(to), { recursive: true });
  await copyFileWritable(from, to);
  return to;
}
