#!/usr/bin/env node
// Make one of runtime godot's examples into a playable game folder: create's output from the example's spec, with the
// example's own files over it (rules.js, and files/: project/ for its Godot scripts, tests/ for its own play tests),
// then the export. The examples are in the repository's example sets (examples/minimal/godot-*, examples/showcase/
// godot-*), laid out as every example is: spec.json, rules.js, README.md, example.json, files/.
//
//   node runtimes/godot/tools/example.mjs <example-dir> <new-game-dir> [--json]
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { create } from './create.mjs';
import { exportGame } from './export.mjs';
import { isMain } from './lib.mjs';
import { copyFileWritable, cpWritable } from '../../../builder/lib/writable.mjs';

/** Lay an example's own files over a created game: rules.js and everything under files/. → the paths laid. */
export async function applyExample(ex, out) {
  const own = [];
  if (existsSync(join(ex, 'rules.js'))) { await copyFileWritable(join(ex, 'rules.js'), join(out, 'rules.js')); own.push('rules.js'); }
  if (existsSync(join(ex, 'files'))) for (const e of await readdir(join(ex, 'files'))) { await cpWritable(join(ex, 'files', e), join(out, e), { recursive: true }); own.push(e); }
  return own;
}

export async function makeExample(exampleDir, outDir, { log = () => {} } = {}) {
  const ex = resolve(exampleDir), out = resolve(outDir);
  const r = await create(join(ex, 'spec.json'), out, { exportNow: false, log });
  if (!r.ok) return r;
  const own = await applyExample(ex, out);
  const e = await exportGame(out, { log });
  if (!e.ok) return { ok: false, dir: out, problems: e.errors.map(x => `export: ${x}`) };
  return { ...r, own, exported: e };
}

if (isMain(import.meta)) {
  const a = process.argv.slice(2), [ex, out] = a.filter(x => !x.startsWith('--'));
  if (!ex || !out) { console.error('usage: example.mjs <example-dir> <new-game-dir> [--json]'); process.exit(2); }
  const r = await makeExample(ex, out, { log: m => { if (!a.includes('--json')) console.log(m); } }).catch(e => ({ ok: false, problems: [e.stack ?? e.message] }));
  if (a.includes('--json')) console.log(JSON.stringify(r, null, 2));
  else if (r.ok) console.log(`made ${r.game} → ${r.dir}${r.own.length ? ` (its own: ${r.own.join(', ')})` : ' (create\'s output as it is)'}`);
  else for (const p of r.problems) console.error(`failed: ${p}`);
  process.exit(r.ok ? 0 : 1);
}
