// World saves in a folder, for the local world server (builder/world-server/serve.mjs) and scripts/world-admin.mjs --data:
// world-core's memoryStore(), told about every change and written to disk as it happens, so a restart keeps the world.
// Node only (the play host keeps worlds in Postgres and the bucket: lib/world-http.mjs).
//   <dir>/world.json        the world rows
//   <dir>/edits.jsonl       every saved edit, one JSON object a line, appended as it is saved
//   <dir>/snapshots.json    the snapshot rows
//   <dir>/objects/<key>     the snapshots' bytes (worlds/<slug>/<seq>.gfw)
//   <dir>/.lock             the pid of the process using the folder: a second one is refused
import {appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync} from 'node:fs';
import {dirname, join, resolve, sep} from 'node:path';
import {memoryStore} from './world-core.mjs';

const readJson = (path, fallback) => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; } };
function writeAtomic(path, data) {
  mkdirSync(dirname(path), {recursive: true});
  const temp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
  writeFileSync(temp, data);
  renameSync(temp, path);
}

function takeLock(dir) {
  const lock = join(dir, '.lock');
  if (existsSync(lock)) {
    const pid = Number(readFileSync(lock, 'utf8'));
    let alive = false;
    if (pid && pid !== process.pid) try { process.kill(pid, 0); alive = true; } catch (error) { alive = error?.code === 'EPERM'; }
    if (alive) throw new Error(`The world folder ${dir} is in use by process ${pid}. Stop it first.`);
  }
  writeFileSync(lock, String(process.pid));
  const release = () => { try { if (readFileSync(lock, 'utf8') === String(process.pid)) rmSync(lock); } catch { /* already gone */ } };
  process.once('exit', release);
  return release;
}

/** A memoryStore() kept in `dir` (created if missing). `.close()` releases the folder. */
export function fileStore(dir) {
  const base = resolve(dir);
  mkdirSync(base, {recursive: true});
  const release = takeLock(base);
  const objectPath = key => {
    const path = resolve(base, 'objects', key);
    if (!path.startsWith(join(base, 'objects') + sep)) throw new Error(`bad object key ${key}`);
    return path;
  };
  const worlds = new Map((readJson(join(base, 'world.json'), [])).map(w => [w.slug, w]));
  const snapshots = readJson(join(base, 'snapshots.json'), []);
  const edits = [];
  if (existsSync(join(base, 'edits.jsonl'))) {
    for (const line of readFileSync(join(base, 'edits.jsonl'), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { edits.push(JSON.parse(line)); } catch { /* a line cut short by a crash: the push it belonged to was never answered */ }
    }
  }
  const objects = [];
  for (const s of snapshots) { try { objects.push([s.key, new Uint8Array(readFileSync(objectPath(s.key)))]); } catch { /* missing: reads report it */ } }
  const store = memoryStore({
    load: {worlds: [...worlds.values()], edits, snapshots, objects},
    persist: {
      world(row) { worlds.set(row.slug, row); writeAtomic(join(base, 'world.json'), JSON.stringify([...worlds.values()], null, 1)); },
      edits(slug, rows) { appendFileSync(join(base, 'edits.jsonl'), rows.map(r => JSON.stringify(r)).join('\n') + '\n'); },
      snapshot(slug, row) { snapshots.push(row); writeAtomic(join(base, 'snapshots.json'), JSON.stringify(snapshots, null, 1)); },
      object(key, bytes) { writeAtomic(objectPath(key), bytes); },
    },
  });
  return Object.assign(store, {kind: 'files', dir: base, close: release});
}
