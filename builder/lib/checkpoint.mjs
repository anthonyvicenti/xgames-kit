// Checkpoints of a game folder: a copy of every file before an agent round, and a way back.
//
//   const cp = checkpointStore(gameDir);
//   await cp.keep('round-2', { step: 'repair' });   // → { name, at, files, bytes, hash, added }
//   await cp.restore('round-2');                    // → { name, written: [rel], removed: [rel], same }
//   await cp.has('round-2'); await cp.get('round-2'); await cp.list(); await cp.next('round');
//
// No git and no shell: plain files under <game>/.gf-loop/checkpoints/. Each file's bytes are stored once, by their
// sha256 (objects/<2 hex>/<64 hex>); a checkpoint is a small manifest of path → sha256. A game is about 11 MB, most of
// it kit copies that never change, so a round costs only the files it changed.
//
// What a checkpoint holds: every regular file of the game except the loop's own folder (.gf-loop), node_modules and
// .git. Symbolic links are never followed, stored, or removed. A restore puts back each file whose bytes differ,
// removes each file the checkpoint does not have, and removes folders that this left empty, so the folder is byte for
// byte what it was (the loop's own folder aside). The loop library's `versions` interface (keep, restore, has) is this
// one, so the versions the loop keeps ('verified', 'created') and the rounds the tools keep share one store.
//
// The shape (a checkpoint per run, content-addressed, with a rollback) follows what we read in FunplayAI/Funplay's
// electron/main/agent-platform/file-checkpoint-store.ts (Apache-2.0). No code is taken from it.
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const CHECKPOINT_SCHEMA = 'gf-checkpoint/1';
export const LOOP_DIR = '.gf-loop';
const SKIP_TOP = new Set([LOOP_DIR]);
const SKIP_ANY = new Set(['node_modules', '.git']);
const NAME = /^[a-z0-9][a-z0-9-]{0,40}$/;

const sha256 = buf => createHash('sha256').update(buf).digest('hex');
const exists = p => stat(p).then(() => true, () => false);

/** Every regular file of the game the checkpoint covers, and every folder. → { files: [rel], dirs: [rel] }, sorted, forward slashes. */
export async function gameFiles(game) {
  const files = [], dirs = [];
  const walk = async (dir, rel) => {
    let entries = [];
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (SKIP_ANY.has(e.name) || e.isSymbolicLink() || (!rel && SKIP_TOP.has(e.name))) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { dirs.push(r); await walk(path.join(dir, e.name), r); }
      else if (e.isFile()) files.push(r);
    }
  };
  await walk(path.resolve(game), '');
  return { files, dirs };
}

/** One hash over the covered files (path and sha256 of each, sorted): two folders with the same hash hold the same bytes. */
export async function treeHash(game) {
  const { files } = await gameFiles(game);
  const rows = [];
  for (const rel of files) rows.push(`${rel}\0${sha256(await readFile(path.join(game, ...rel.split('/'))))}`);
  return sha256(rows.join('\n'));
}

async function writeAtomic(file, data) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, file);
}

export function checkpointStore(game, { dir = path.join(game, LOOP_DIR, 'checkpoints'), clock = () => Date.now() } = {}) {
  const root = path.resolve(game);
  const objectOf = h => path.join(dir, 'objects', h.slice(0, 2), h);
  const manifestOf = name => path.join(dir, `${name}.json`);
  const at = rel => path.join(root, ...rel.split('/'));
  const good = name => { if (!NAME.test(String(name))) throw new Error(`checkpoint name "${name}": lowercase letters, digits and dashes`); return name; };

  const store = {
    dir,
    /** Copy the game as it is now. A name used again is replaced (the loop's 'verified' moves forward). */
    async keep(name, meta = {}) {
      good(name);
      const { files, dirs } = await gameFiles(root);
      const map = {};
      let bytes = 0, added = 0;
      for (const rel of files) {
        const buf = await readFile(at(rel)), h = sha256(buf);
        map[rel] = h; bytes += buf.length;
        if (!await exists(objectOf(h))) { await writeAtomic(objectOf(h), buf); added++; }
      }
      const rows = files.map(rel => `${rel}\0${map[rel]}`);
      const manifest = { schema: CHECKPOINT_SCHEMA, name, at: new Date(clock()).toISOString(), hash: sha256(rows.join('\n')), count: files.length, bytes, meta, dirs, files: map };
      await writeAtomic(manifestOf(name), JSON.stringify(manifest, null, 1) + '\n');
      return { name, at: manifest.at, files: files.length, bytes, hash: manifest.hash, added };
    },
    async get(name) {
      try { const m = JSON.parse(await readFile(manifestOf(good(name)), 'utf8')); return m?.schema === CHECKPOINT_SCHEMA ? m : null; } catch { return null; }
    },
    async has(name) { return !!await store.get(name); },
    /** Every checkpoint, oldest first, without its file list. */
    async list() {
      let names = [];
      try { names = (await readdir(dir)).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5)); } catch { return []; }
      const out = [];
      for (const n of names) { const m = NAME.test(n) ? await store.get(n) : null; if (m) out.push({ name: m.name, at: m.at, hash: m.hash, count: m.count, bytes: m.bytes, meta: m.meta ?? {} }); }
      return out.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.name.localeCompare(b.name, 'en', { numeric: true })));
    },
    /** The next free number for `<prefix>-<n>` (1 when there is none). */
    async next(prefix) {
      const used = (await store.list()).map(c => new RegExp(`^${prefix}-(\\d+)$`).exec(c.name)?.[1]).filter(Boolean).map(Number);
      return used.length ? Math.max(...used) + 1 : 1;
    },
    /**
     * Make the game what it was at the checkpoint. Nothing is written until every file the checkpoint needs has been
     * found in the store, so a damaged store changes nothing.
     */
    async restore(name) {
      const m = await store.get(name);
      if (!m) throw new Error(`no checkpoint "${name}" for this game`);
      const want = Object.entries(m.files);
      for (const [rel, h] of want) if (!await exists(objectOf(h))) throw new Error(`checkpoint "${name}" is damaged: the stored copy of ${rel} is missing; nothing was changed`);
      const now = await gameFiles(root);
      const written = [], removed = [];
      let same = 0;
      for (const rel of now.files) if (!(rel in m.files)) { await rm(at(rel), { force: true }); removed.push(rel); }
      for (const [rel, h] of want) {
        let have = null;
        try { have = sha256(await readFile(at(rel))); } catch {}
        if (have === h) { same++; continue; }
        await writeAtomic(at(rel), await readFile(objectOf(h)));
        written.push(rel);
      }
      // folders the round made and the restore emptied: deepest first; a folder the checkpoint had stays
      const keepDirs = new Set(m.dirs ?? []);
      for (const d of (await gameFiles(root)).dirs.sort((a, b) => b.length - a.length)) {
        if (keepDirs.has(d)) continue;
        try { await rmdir(at(d)); } catch {}   // not empty (a link, or a skipped folder inside): left alone
      }
      for (const d of keepDirs) await mkdir(at(d), { recursive: true });
      return { name, at: m.at, hash: m.hash, written, removed, same };
    },
  };
  return store;
}

// ---------------------------------------------------------------- the studio page's side (builder/server/routes/build.mjs)
const WORDS = { created: 'The game as it was made', verified: 'The last version that passed verify' };
/** A checkpoint's name as a person reads it. */
export function checkpointLabel(c) {
  const m = /^(round|playtest)-(\d+)$/.exec(c.name);
  if (m?.[1] === 'round') return `Before round ${m[2]} of your session's work${c.meta?.kind ? ` (${c.meta.kind})` : ''}`;
  if (m?.[1] === 'playtest') return `What the play-tester played (play-test ${m[2]}${c.meta?.kind ? `: ${c.meta.kind}` : ''})`;
  return WORDS[c.name] ?? c.name;
}
/** Every checkpoint of a game for the Build tab, newest first: [{ id, label, round, at, hash, files }]. */
export async function listCheckpoints(game) {
  return (await checkpointStore(game).list()).reverse().map(c => ({
    id: c.name, label: checkpointLabel(c), round: Number(/^round-(\d+)$/.exec(c.name)?.[1]) || null, at: c.at, hash: c.hash, files: c.count,
  }));
}
/** Put the game back to a checkpoint (the roll-back button). → { at, hash, written, removed, unchanged } */
export async function restoreCheckpoint(game, id) {
  const r = await checkpointStore(game).restore(String(id));
  return { at: r.at, hash: r.hash, written: r.written.length, removed: r.removed.length, unchanged: r.same };
}
