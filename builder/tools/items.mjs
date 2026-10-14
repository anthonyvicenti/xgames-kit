#!/usr/bin/env node
// gf-three items: a game's things as data (open builder wave 10, track I). Every command is a write of one slot (the
// table's json slot, tools/lib/items-lib.mjs writeSlot), the same write a studio page makes, so nothing here can do
// what a page cannot.
//
//   node builder/tools/items.mjs <game> [list] [--json]
//   node builder/tools/items.mjs <game> add <table slot> --name "Foam sword" [--like <id>] [--id <id>] [--set <field>=<json> ...]
//   node builder/tools/items.mjs <game> remove <table slot> <id>
//
//   list     each item: a table (its slot, entries, what its card shows first) or a single item (its slots)
//   add      a new entry made like --like (default: the first): its own id and name, its picture the like's (copied to
//            its own file) or the mechanic's library default; --set changes a field inside it (combo/0/damage=2)
//   remove   take an entry out (a table keeps at least its declared least)
import { isMain } from './lib/main.mjs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tablesOf, writeSlot } from './lib/items-lib.mjs';
import { addLike, removeItem, nameOf, getAt, fieldSchema } from '../../runtimes/three/kit/assets/items.js';

export async function listItems(gameDir) {
  const m = JSON.parse(await readFile(join(gameDir, 'assets.json'), 'utf8'));
  const tables = await tablesOf(gameDir);
  return (m.items ?? []).map(it => {
    if (!it.table) return it;
    const t = tables.find(x => x.slot.id === it.table);
    const value = t?.value;
    return { ...it, entries: Array.isArray(value) ? value.map((e, i) => ({ id: e?.[t.item.id ?? 'id'] ?? e, name: nameOf(t.item, e, i), front: Object.fromEntries((t.item.front ?? []).map(f => [f, getAt(e, f) ?? fieldSchema(t.item, f)?.default])) })) : null, min: t?.item.min, max: t?.item.max };
  });
}

export async function addItem(gameDir, slot, opts) {
  const t = (await tablesOf(gameDir)).find(x => x.slot.id === slot);
  if (!t) return { ok: false, problems: [`there is no table slot "${slot}" (tables: ${(await tablesOf(gameDir)).map(x => x.slot.id).join(', ') || 'none'})`] };
  let made;
  try { made = addLike(t.item, t.value, opts); } catch (e) { return { ok: false, problems: [e.message] }; }
  return { ...(await writeSlot(gameDir, slot, made.table)), entry: made.entry };
}

export async function removeFrom(gameDir, slot, id) {
  const t = (await tablesOf(gameDir)).find(x => x.slot.id === slot);
  if (!t) return { ok: false, problems: [`there is no table slot "${slot}"`] };
  const r = removeItem(t.item, t.value, id);
  return r.problem ? { ok: false, problems: [r.problem] } : writeSlot(gameDir, slot, r.table);
}

if (isMain(import.meta)) {
  const a = process.argv.slice(2), flag = k => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
  const pos = a.filter((x, i) => !x.startsWith('--') && !['--name', '--like', '--id', '--set'].includes(a[i - 1]));
  const [dir, cmd = 'list', slot, id] = pos;
  if (!dir) { console.error('usage: items.mjs <game> [list] | add <table slot> --name <words> [--like <id>] [--id <id>] [--set field=json] | remove <table slot> <id>'); process.exit(2); }
  const game = resolve(dir), json = a.includes('--json');
  let r;
  if (cmd === 'list') {
    const list = await listItems(game);
    if (json) console.log(JSON.stringify(list, null, 2));
    else for (const it of list) {
      if (it.table) { console.log(`${it.mechanic}: ${it.nouns ?? it.noun} (${it.table}, ${it.entries?.length ?? 'the kit\'s own'} of ${it.min ?? 0}–${it.max ?? '∞'})`); for (const e of it.entries ?? []) console.log(`  ${e.id}  ${e.name}  ${Object.entries(e.front).filter(([k]) => k !== 'name').map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ')}`); }
      else console.log(`${it.mechanic}: one ${it.noun} (${it.picture ?? 'no picture'}): ${it.fields.join(', ')}`);
    }
    process.exit(0);
  }
  if (cmd === 'add') {
    const set = {};
    a.forEach((x, i) => { if (x === '--set' && a[i + 1]) { const [k, ...v] = a[i + 1].split('='); const t = v.join('='); try { set[k] = JSON.parse(t); } catch { set[k] = t; } } });
    r = await addItem(game, slot, { like: flag('--like') ?? null, name: flag('--name') ?? '', id: flag('--id') ?? '', set });
  } else if (cmd === 'remove') r = await removeFrom(game, slot, id);
  else { console.error(`unknown command ${cmd}`); process.exit(2); }
  if (json) console.log(JSON.stringify(r, null, 2));
  else if (!r.ok) { console.log(`refused:`); for (const p of r.problems) console.log(`  - ${p}`); }
  else { console.log(`${slot}: written${r.entry ? ` (added ${r.entry.id})` : ''}`); for (const p of r.pictures ?? []) console.log(`  picture: ${p}`); console.log(`slots: ${r.slots.count} (${r.slots.main} main)`); }
  process.exit(r.ok ? 0 : 1);
}
