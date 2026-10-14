// Shared by tools/fix.mjs and tools/dressing.mjs --fix (track M2-C): reading and writing a game's JSON the way it was
// written, and the locked spec. A repair is data, `{fix, file, pointer, before, after, why}`, so verify can note it.
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

/** The JSON files of a game folder, opened once, written back only when a fix changed them, in their own indent. */
export function openDocs(dir) {
  const docs = new Map();
  return {
    dir,
    /** → the parsed file (shared, mutate it), or null when the game has no such file or it is not JSON */
    async get(file) {
      if (docs.has(file)) return docs.get(file).obj;
      const p = join(dir, file);
      if (!existsSync(p)) { docs.set(file, { obj: null }); return null; }
      const raw = await readFile(p, 'utf8');
      let obj = null; try { obj = JSON.parse(raw); } catch { obj = null; }
      const indent = /^\n?([ \t]+)"/m.exec(raw)?.[1] ?? 2;
      docs.set(file, { obj, indent, nl: raw.endsWith('\n'), before: obj === null ? null : JSON.stringify(obj) });
      return obj;
    },
    /** Write every file a fix changed. → the files written */
    async save() {
      const out = [];
      for (const [file, d] of docs) {
        if (!d.obj || JSON.stringify(d.obj) === d.before) continue;
        await writeFile(join(dir, file), JSON.stringify(d.obj, null, d.indent) + (d.nl ? '\n' : ''));
        d.before = JSON.stringify(d.obj); out.push(file);
      }
      return out;
    },
  };
}

/**
 * The spec the game was made from, when nothing has touched it since create (spec.json against the sha in
 * gf-three.json; the same lock check 16 uses for oneHitKills). → { spec, why }; spec is null when it cannot be trusted.
 */
export async function lockedSpec(dir) {
  const f = join(dir, 'spec.json');
  if (!existsSync(f)) return { spec: null, why: 'no spec.json in the game' };
  const bytes = await readFile(f);
  const rec = JSON.parse(await readFile(join(dir, 'gf-three.json'), 'utf8').catch(() => '{}'));
  if (rec.spec?.sha256 && rec.spec.sha256 !== createHash('sha256').update(bytes).digest('hex')) return { spec: null, why: 'spec.json changed since create (its sha differs from gf-three.json)' };
  try { return { spec: JSON.parse(bytes.toString('utf8')), why: 'the spec is the one create locked' }; } catch { return { spec: null, why: 'spec.json is not JSON' }; }
}

/** One plain line for the verdict's notes. */
export const repairLine = r => `fix ${r.fix}: ${r.file}${r.pointer ? ` ${r.pointer}` : ''} ${r.before === undefined ? '(absent)' : JSON.stringify(r.before)} → ${r.after === undefined ? '(removed)' : JSON.stringify(r.after)}. ${r.why}`;

/** Set a value at a JSON pointer ("/a/0/b"); the parents must exist. → the old value */
export function setAt(doc, pointer, value) {
  const keys = pointer.split('/').slice(1).map(k => k.replace(/~1/g, '/').replace(/~0/g, '~'));
  let o = doc; for (const k of keys.slice(0, -1)) o = o[k];
  const last = keys.at(-1), old = o[last];
  if (value === undefined) { if (Array.isArray(o)) o.splice(Number(last), 1); else delete o[last]; } else o[last] = value;
  return old;
}
