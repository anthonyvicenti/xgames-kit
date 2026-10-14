#!/usr/bin/env node
// A flat (2D) game's tile map (config/world.json → map, the slot world.map; kit/flat/tilemap.js): print it with what
// is wrong with it, and write again what is derived from it.
//
//   node builder/tools/flat-map.mjs <game-dir> [--json]     the map, its size, kinds, spawns and marks, and
//                                                                     the world's own report (kit/flat worldReport)
//   node builder/tools/flat-map.mjs <game-dir> --sync       after the map was edited (a painter, a change by
//                                                                     hand): rewrite config/world.json → spawns and half
//                                                                     from the map. Nothing else is touched.
// Exit 0 when the report has no error, 1 otherwise, 2 for a wrong call.
import { isMain } from './lib/main.mjs';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { readMap } from '../../runtimes/three/profiles/flat-2d/tilemap.js';
import { KIT, kitPath } from './lib/paths.mjs';
import { importLayer } from './lib/kit-import.mjs';
// kit modules whose imports cross layers: through the hook (kit-import.mjs importLayer)
const { worldReport, spawnsOf } = await importLayer(kitPath(KIT, 'flat/index.js'));

const read = async f => JSON.parse(await readFile(f, 'utf8'));

/** The world's own report for a created flat game. */
export async function reportOf(dir) {
  const world = await read(join(dir, 'config/world.json')), game = await read(join(dir, 'config/game.json')), spec = await read(join(dir, 'spec.json')).catch(() => null);
  return worldReport({ world, game, spec, intent: spec?.world?.size ?? world.size, target: dir });
}
/** Rewrite what is derived from the map. → the files it changed */
export async function sync(dir) {
  const file = join(dir, 'config/world.json'), world = await read(file), M = readMap(world.map);
  if (!M.ok) throw new Error(`the map has problems: ${M.problems.join('; ')}`);
  const next = { ...world, spawns: spawnsOf(world.map), half: Math.round((M.cols * M.tile) / 2) };
  if (JSON.stringify(next) === JSON.stringify(world)) return [];
  await writeFile(file, `${JSON.stringify(next, null, 1)}\n`);
  return ['config/world.json'];
}

if (isMain(import.meta)) {
  const args = process.argv.slice(2), dir = args[0] && !args[0].startsWith('--') ? resolve(args[0]) : null;
  if (!dir) { console.error('usage: flat-map.mjs <game-dir> [--json] [--sync]'); process.exit(2); }
  if (args.includes('--sync')) { const wrote = await sync(dir); console.log(wrote.length ? `wrote ${wrote.join(', ')}` : 'nothing to write: the list already matches the map'); }
  const r = await reportOf(dir), world = await read(join(dir, 'config/world.json'));
  if (args.includes('--json')) console.log(JSON.stringify(r, null, 1));
  else {
    console.log(`${world.map.rows.join('\n')}\n`);
    console.log(`a flat ${r.template} (plane ${r.plane}), ${r.stats.cells.join(' x ')} cells, ${r.stats.kinds} tile kinds, ${r.stats.spawns} spawns, marks ${JSON.stringify(r.stats.marks)}`);
    for (const p of r.problems) console.log(`${p.severity === 'error' ? 'ERROR' : 'note '} ${p.rule}: ${p.message}${p.fix ? ` → ${p.fix}` : ''}`);
  }
  process.exit(r.ok ? 0 : 1);
}
