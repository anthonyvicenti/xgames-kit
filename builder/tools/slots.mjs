#!/usr/bin/env node
// gf-three slots: assets.json from the slot declarations (CONTRACT §2.2): the kit's modules (from the game's own kit
// copy), config/*.json and the files under assets/. The sound list a game already has is kept (it is Studio's).
//
//   node builder/tools/slots.mjs <game> [--write] [--check] [--json]
//   node builder/tools/slots.mjs <game> --set <slot id> <value>
//
//   (no flag)  print the slot count, the main tier and any warnings
//   --write    write assets.json (after an agent adds a prop, a rules param, a mechanic, or a file under assets/). A
//              table entry whose picture is "library:<id>" (or another entry's file) first gets its own file
//              (tools/lib/items-lib.mjs ensurePictures), so a new item never draws nothing
//   --check    exit 1 when assets.json differs from what the declarations give
//   --set      write one value slot the way a page does (tools/lib/items-lib.mjs writeSlot): the value is JSON (a
//              number, true, "words", a list), bare words, or @<file> holding the JSON; refused in words, with nothing written, when it does not
//              fit the slot's type and range, or, for a table of items (a json slot with constraints.item: melee
//              weapons, loot's upgrade cards), when any entry does not fit what its mechanic says one is. Then
//              assets.json is written (a new weapon gets its own slots)
import { isMain } from './lib/main.mjs';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { assembleManifest } from './lib/slots-lib.mjs';
import { json } from './lib/paths.mjs';

export async function slots(gameDir, { write = false } = {}) {
  const dir = resolve(gameDir);
  const path = join(dir, 'assets.json');
  // a new item's picture (open builder wave 10): its own file before the declarations are read
  const pictures = write ? await (await import('./lib/items-lib.mjs')).ensurePictures(dir) : { changed: [], problems: [] };
  const cur = existsSync(path) ? await readFile(path, 'utf8') : null;
  let sounds = null;
  try { sounds = cur ? JSON.parse(cur).sounds ?? null : null; } catch {}
  const r = await assembleManifest(dir, { sounds });
  const text = json(r.manifest);
  const same = cur === text;
  if (write && !same) await writeFile(path, text);
  return { ...r, warnings: [...r.warnings, ...pictures.problems], pictures: pictures.changed, same, wrote: write && !same };
}

if (isMain(import.meta)) {
  const a = process.argv.slice(2);
  const dir = a.find(x => !x.startsWith('--'));
  if (!dir) { console.error('usage: slots.mjs <game> [--write] [--check] [--json] | --set <slot id> <value>'); process.exit(2); }
  const set = a.indexOf('--set');
  if (set >= 0) {
    const id = a[set + 1], raw = a[set + 2];
    if (!id || raw === undefined) { console.error('usage: slots.mjs <game> --set <slot id> <value>'); process.exit(2); }
    // @<file>: the value is that file's JSON (a whole table is long for a command line)
    const text = raw.startsWith('@') ? await readFile(raw.slice(1), 'utf8') : raw;
    let value; try { value = JSON.parse(text); } catch { value = text; }
    const r = await (await import('./lib/items-lib.mjs')).writeSlot(dir, id, value);
    if (a.includes('--json')) console.log(JSON.stringify(r, null, 2));
    else if (!r.ok) { console.log(`refused: ${id}`); for (const p of r.problems) console.log(`  - ${p}`); }
    else {
      console.log(`${id}: written`);
      for (const p of r.pictures ?? []) console.log(`  picture: ${p}`);
      console.log(`slots: ${r.slots.count} (${r.slots.main} main) · assets.json written`);
    }
    process.exit(r.ok ? 0 : 1);
  }
  const r = await slots(dir, { write: a.includes('--write') });
  if (a.includes('--json')) { console.log(JSON.stringify({ slots: r.slotCount, main: r.mainCount, same: r.same, wrote: r.wrote, warnings: r.warnings, pictures: r.pictures, mainSlots: r.manifest.slots.filter(s => s.tier === 'main').map(s => s.id) }, null, 2)); }
  else {
    for (const w of r.warnings) console.log(`warning ${w}`);
    for (const p of r.pictures) console.log(`picture ${p}`);
    console.log(`main tier (${r.mainCount}): ${r.manifest.slots.filter(s => s.tier === 'main').map(s => s.id).join(', ')}`);
    console.log(`slots: ${r.slotCount} (${r.mainCount} main) · assets.json ${r.same ? 'is up to date' : r.wrote ? 'written' : 'differs (run with --write)'}`);
  }
  process.exitCode = a.includes('--check') && !r.same ? 1 : 0;
}
