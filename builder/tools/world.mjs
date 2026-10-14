#!/usr/bin/env node
// gf-three world: is this world complete and does it make sense? verify check 17 on its own (tools/lib/world-check.mjs),
// plus a template expanded at a size class (kit/world/generate.js) for the pitch and the build agent.
//
//   node builder/tools/world.mjs <game | template[:size] | layout.json> [--json]
//   node builder/tools/world.mjs office:medium --layout out.json     write the generated layout
//
// Prints one line per problem (errors fail check 17, warnings are notes) and a summary. Exit 0 = complete, 1 = not.
import { isMain } from './lib/main.mjs';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadWorldSubject, reportFor, worldLines } from './lib/world-check.mjs';

if (isMain(import.meta)) {
  const a = process.argv.slice(2);
  const opt = k => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : null; };
  const target = a.find((x, i) => !x.startsWith('--') && a[i - 1] !== '--layout');
  if (!target) { console.error('usage: world.mjs <game | template[:size] | layout.json> [--json] [--layout out.json]'); process.exit(2); }
  const subject = await loadWorldSubject(target);
  if (opt('--layout')) await writeFile(opt('--layout'), JSON.stringify(subject.world, null, 1) + '\n');
  const r = await reportFor(subject);
  if (a.includes('--json')) process.stdout.write(JSON.stringify(r, null, 2) + '\n');
  else {
    for (const l of worldLines(r)) console.log(`  ${l}`);
    const s = r.stats;
    if (r.profile === 'flat-2d') console.log(`world ${r.template} (${subject.kind} ${target}): ${r.ok ? 'complete' : 'NOT COMPLETE'}, ${r.errors} errors, ${r.warnings} warnings · flat, seen from ${r.plane === 'side' ? 'the side' : 'above'} · ${s.cells.join(' x ')} cells = ${s.size.join(' x ')} m · ${s.kinds} tile kinds · ${s.spawns} spawns`);
    else console.log(`world ${r.template} (${subject.kind} ${target}): ${r.ok ? 'complete' : 'NOT COMPLETE'}, ${r.errors} errors, ${r.warnings} warnings · ${r.kind} ${s.size.join(' x ')} m = ${s.area} m² (asked ${s.sizeClass}, measures ${s.measuredClass}) · ${s.rooms} rooms · ${s.entries} entries · ceiling ${s.ceiling ?? 'none'} · floor filled ${Math.round(s.filledGround * 100)}%`);
  }
  process.exitCode = r.ok ? 0 : 1;
}
