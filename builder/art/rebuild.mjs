// A pack's binaries made again from its pinned source, for a machine that has neither the store nor a mirror. A pack
// that came in through `art ingest` of a pinned zip says how in `source.rebuild` (the same command line); this runs it:
// download the zip, check its sha256 against the pack's, ingest it into a scratch copy of the pack, and keep every file
// it makes in the store by its hash. Ingest is deterministic for a pinned zip and the kit's pinned tools, so the files
// come back with the hashes the manifests name; any that do not are counted, never kept under the wrong name.
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ingestOptions, parse } from './cli.mjs';
import { loadLibrary } from './library.mjs';
import { lazyRenderer } from './render.mjs';
import { inStore } from './store.mjs';

/** A command line in words, the way a shell splits it ('…' and "…" keep spaces); a trailing "(…)" note is dropped. */
export function words(line) {
  const out = [];
  const text = String(line).replace(/\s+\([^)]*\)\s*$/, '');
  for (const m of text.matchAll(/'([^']*)'|"([^"]*)"|(\S+)/g)) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

/** The rebuild line as ingest options: `art ingest <zip> --pack <id> …` → { file, opts }. */
export function rebuildPlan(pack) {
  const w = words(pack.source.rebuild);
  if (w[0] !== 'art' || w[1] !== 'ingest' || !w[2]) throw new Error(`${pack.id}: the rebuild line is not an art ingest command: ${pack.source.rebuild}`);
  const { o } = parse(w.slice(3));
  if (o.pack && o.pack !== pack.id) throw new Error(`${pack.id}: the rebuild line names another pack (${o.pack})`);
  return { file: w[2], opts: { ...ingestOptions(o), pack: pack.id, licence: null } };
}

/**
 * Rebuild a pack's files into the store. → { made (files ingest made), kept (of the pack's own hashes, now in the
 * store), missing ([ids] whose hash did not come back) }
 */
export async function rebuildPack(config, pack, { fetchImpl = fetch, log = () => {} } = {}) {
  const plan = rebuildPlan(pack);
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'art-rebuild-'));
  try {
    log(`${pack.id}: downloading ${pack.source.download}`);
    const r = await fetchImpl(pack.source.download);
    if (!r.ok) throw new Error(`${pack.id}: download failed (${r.status}) ${pack.source.download}`);
    const bytes = Buffer.from(await r.arrayBuffer());
    const got = createHash('sha256').update(bytes).digest('hex');
    if (got !== pack.source.sha256) throw new Error(`${pack.id}: the download is not the pinned file (sha256 ${got.slice(0, 12)}…, the pack pins ${pack.source.sha256.slice(0, 12)}…)`);
    const zip = path.join(tmp, plan.file);
    await writeFile(zip, bytes);
    // a scratch library holding only this pack's record: every file is new to it, and its bytes go to the real store
    const scratch = { ...config, packsDir: path.join(tmp, 'packs'), privatePacks: path.join(tmp, 'private') };
    const dir = path.join(pack.visibility === 'private' ? path.join(scratch.privatePacks, 'packs') : scratch.packsDir, pack.id);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'pack.json'), JSON.stringify(pack));
    const { ingest } = await import('./ingest.mjs');
    log(`${pack.id}: ${pack.source.rebuild}`);
    // a model is measured on the graphics card (its preview is drawn and dropped with the scratch library)
    const renderer = lazyRenderer();
    let done;
    try { done = await ingest(zip, { config: scratch, renderer, ...plan.opts }); } finally { await renderer.close(); }
    const own = loadLibrary(config).find(p => p.pack.id === pack.id)?.assets ?? [];
    const missing = own.filter(a => !inStore(config.store, a.sha256)).map(a => a.id);
    return { made: done.added.length, kept: own.length - missing.length, missing };
  } finally { await rm(tmp, { recursive: true, force: true }); }
}
