// Items as data, the tools' half (open builder wave 10, track I; the pure half is kit/assets/items.js). A mechanic's
// table of things (melee weapons, loot's upgrade cards) is one json value slot; this file writes a value slot the way a
// page does, checks it first, and makes every new entry's picture its own file so the game never draws nothing.
//
//   writeSlot(game, id, value)   check (refused in words, nothing written) → config at the slot's pointer → pictures
//                                → assets.json from the declarations
//   ensurePictures(game)         every table entry whose picture is "library:<id>" (or another entry's file) gets
//                                its own file, copied from the library (with its grip and licence) or from that entry
//   itemProblems(game)           every table against its declaration (verify check 1)
//   tablesOf(game)               [{slot, item, value, mechanic}] from assets.json
//
// No list of mechanics here: what a table is comes from the slot's constraints.item (written from the mechanic's own
// manifest by tools/slots.mjs) and, for the pictures at create time, from the mechanic's manifest.items.
import { readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { json } from './paths.mjs';
import { findAsset, licenceOf, localFile, propEntry } from '../../art/views.mjs';
import { kitModule, assembleManifest } from './slots-lib.mjs';
import { checkItems, slotValueProblems, getAt, setAt, libraryRef, pictureFile, nameOf } from '../../../runtimes/three/kit/assets/items.js';
import { copyFileWritable } from '../../lib/writable.mjs';

const readJson = async p => JSON.parse(await readFile(p, 'utf8'));
const readJsonMaybe = async p => { try { return await readJson(p); } catch { return null; } };
const inside = (dir, rel) => { const p = resolve(dir, rel), r = relative(resolve(dir), p); return r && !r.startsWith('..') ? p : null; };
const clone = v => JSON.parse(JSON.stringify(v));

async function writeJsonLike(file, doc) {
  const raw = existsSync(file) ? await readFile(file, 'utf8') : '';
  const indent = /^\{\r?\n( +)/.exec(raw)?.[1]?.length ?? 2;
  const text = JSON.stringify(doc, null, indent) + '\n', tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, text);
  // Windows refuses to rename over a file another process holds open: write in place then
  try { await rename(tmp, file); } catch { await writeFile(file, text); await rm(tmp, { force: true }); }
}

/** Every table slot of a game: [{slot, item, value, mechanic}] (value: what the config holds now). */
export async function tablesOf(gameDir) {
  const m = await readJson(join(gameDir, 'assets.json'));
  const out = [], docs = new Map();
  for (const s of m.slots ?? []) {
    if (s.type !== 'json' || !s.constraints?.item || !s.source?.pointer) continue;
    if (!docs.has(s.source.file)) docs.set(s.source.file, await readJsonMaybe(join(gameDir, s.source.file)));
    const index = (m.items ?? []).find(x => x.table === s.id);
    out.push({ slot: s, item: s.constraints.item, value: getAt(docs.get(s.source.file) ?? {}, s.source.pointer), mechanic: index?.mechanic ?? s.id.split('.')[1] });
  }
  return out;
}

/** Every table against what one entry may be, in words: [`<slot label>: <problem>`]. */
export async function itemProblems(gameDir) {
  const out = [];
  for (const t of await tablesOf(gameDir)) for (const p of checkItems(t.item, t.value)) out.push(`${t.slot.label ?? t.slot.id}: ${p}`);
  return out;
}

// ---- a picture from the asset library: "library:<id>" (the three runtime's packs first, then the scenic profile's)
// or "library:<pack>/<id>", with its grip and its licence ----
/** A library entry by id or ref: { id, file (absolute, on this machine), grip, license } or null. */
export async function libraryEntry(id) {
  const a = findAsset(id, 'three', { anywhere: false }) ?? findAsset(id, 'scenic');
  const file = a && localFile(a);
  if (!file) return null;
  const e = propEntry(a), l = licenceOf(a);
  return { id, file, grip: e.grip ? { position: e.grip.position, quaternion: e.grip.quaternion } : null, license: { spdx: l.spdx, author: l.author, url: l.url } };
}

/** One table's pictures, in place on `table` (files copied only with write). → { changed, problems } */
export async function pictureStep(gameDir, item, table, { write = true } = {}) {
  const changed = [], problems = [], P = item?.picture;
  if (!item || item.single || !P?.field || !Array.isArray(table)) return { changed, problems };
  const dirOf = P.dir ?? 'assets/models', used = new Map();
  const fieldWords = (item.schema?.properties?.[P.field]?.title ?? P.field).toLowerCase();
  for (const [j, entry] of table.entries()) {
    if (!entry || typeof entry !== 'object') continue;
    const who = nameOf(item, entry, j), v = entry[P.field];
    if (typeof v !== 'string' || !v) continue;
    const to = pictureFile(item, entry), toRel = to ? to.slice(dirOf.length + 1) : null;
    const ref = libraryRef(v);
    if (ref) {
      const e = await libraryEntry(ref);
      if (!e) { problems.push(`${who}: there is no "${ref}" in the asset library on this machine (gamesfun art find)`); continue; }
      if (!to) { problems.push(`${who}: its mechanic names no file for its ${fieldWords}`); continue; }
      if (write) { await mkdir(dirname(join(gameDir, to)), { recursive: true }); await copyFileWritable(e.file, join(gameDir, to)); }
      entry[P.field] = toRel;
      for (const f of Object.values(P.extra ?? {})) if (f === 'grip' && e.grip && entry[f] == null) entry[f] = e.grip;
      entry.license ??= e.license;
      changed.push(`${who}: ${fieldWords} ${v} → ${to} (${e.license.spdx}${e.license.author ? `, ${e.license.author}` : ''})`);
      used.set(toRel, j);
      continue;
    }
    const at = `${dirOf}/${v}`, abs = inside(gameDir, at);
    if (!abs || !existsSync(abs)) { problems.push(`${who}: its ${fieldWords} ${at} is not in the game (put a file there, or write "library:<id>" for a library one)`); continue; }
    if (used.has(v) && to && to !== at) {
      // a copy of another entry's picture: its own file, so either can be replaced alone
      if (write) await copyFileWritable(abs, join(gameDir, to));
      entry[P.field] = toRel;
      changed.push(`${who}: ${fieldWords} ${at} was ${nameOf(item, table[used.get(v)], used.get(v))}'s too → its own copy ${to}`);
      used.set(toRel, j);
      continue;
    }
    used.set(v, j);
  }
  return { changed, problems };
}

/**
 * Give every table entry its own picture file: a picture field that names "library:<id>" gets that library model
 * copied to the entry's own file (its grip and licence with it, unless the entry has its own); a field that names a
 * file another entry already uses gets a copy of it. A missing file is a problem, never a silent stand-in. Writes
 * config/game.json only when something changed. → { changed: [words], problems: [words] }
 */
export async function ensurePictures(gameDir, { write = true } = {}) {
  const file = join(gameDir, 'config/game.json');
  const game = await readJsonMaybe(file);
  const changed = [], problems = [];
  if (!game) return { changed, problems };
  for (const m of game.mechanics ?? []) {
    let mod; try { mod = await kitModule(gameDir, `mechanics/${m.id}/index.js`); } catch { continue; }
    for (const item of Array.isArray(mod.manifest?.items) ? mod.manifest.items : []) {
      const r = await pictureStep(gameDir, item, m.params?.[item.key], { write });
      changed.push(...r.changed); problems.push(...r.problems);
    }
  }
  if (changed.length && write) await writeJsonLike(file, game);
  return { changed, problems };
}

/**
 * Write a value slot the way a page or the session does: checked against its slot (its range and type, and for a
 * table every entry against the item its mechanic declares, its pictures included), written into its config file,
 * every new entry's picture made its own, then assets.json written from the declarations (so new entries get their
 * own slots). Refused in words, with nothing written, when the value does not fit.
 * → { ok, problems, before, after, pictures, slots }
 */
export async function writeSlot(gameDir, id, value) {
  const dir = resolve(gameDir);
  const m = await readJson(join(dir, 'assets.json'));
  const s = (m.slots ?? []).find(x => x.id === id);
  if (!s) return { ok: false, problems: [`there is no slot "${id}" in assets.json`] };
  if (!s.source?.pointer) return { ok: false, problems: [`${id} is a ${s.type} file slot: it takes a new file, not a value`] };
  const problems = slotValueProblems(s, value);
  if (problems.length) return { ok: false, problems };
  // a table's pictures are checked before anything is written (a missing file or an unknown library id refuses)
  if (s.type === 'json' && s.constraints?.item) {
    const pre = await pictureStep(dir, s.constraints.item, clone(value), { write: false });
    if (pre.problems.length) return { ok: false, problems: pre.problems };
  }
  const file = inside(dir, s.source.file);
  if (!file || !existsSync(file)) return { ok: false, problems: [`${id}: its config file ${s.source.file} is missing`] };
  const doc = await readJson(file);
  const before = getAt(doc, s.source.pointer);
  try { setAt(doc, s.source.pointer, value); } catch (e) { return { ok: false, problems: [`${id}: ${e.message}`] }; }
  await writeJsonLike(file, doc);
  const pictures = await ensurePictures(dir);
  const r = await writeManifest(dir);
  return { ok: !pictures.problems.length, problems: pictures.problems, before, after: value, pictures: pictures.changed, slots: { count: r.slotCount, main: r.mainCount, warnings: r.warnings } };
}

/** assets.json from the declarations, keeping the game's sound list (what tools/slots.mjs --write does after its
 *  pictures step; here so that tool can call this file without a loop between the two). */
async function writeManifest(dir) {
  const path = join(dir, 'assets.json');
  let sounds = null;
  try { sounds = JSON.parse(await readFile(path, 'utf8')).sounds ?? null; } catch {}
  const r = await assembleManifest(dir, { sounds });
  await writeFile(path, json(r.manifest));
  return r;
}
