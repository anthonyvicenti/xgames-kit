#!/usr/bin/env node
// sound-wire.mjs: the forge's sounds into a forge game (wave 2, track U; INTEGRATION.md mismatch 25). The core plays
// sounds by the ids its tables name; until now create listed every one as a gf-audio preset. This turns those ids into
// the asset library's files (runtimes/forge/sounds/sounds.json names them by their forge names, wired by wire.json;
// the forge's cast says which library asset each name is), copied into the game as assets/sounds/*.ogg (each an `audio`
// slot, each played through gf-audio's sound list in assets.json: Studio lists, plays and replaces them).
//
//   import { forgeSoundList } from '…/runtimes/forge/tools/sound-wire.mjs';
//   const r = forgeSoundList({ ids: tables.soundsOf(forge), tables: forge });      (create: tools/lib/spec-config.mjs)
//   r.sounds   {id: gf-audio entry}        files as assets/sounds/<name>.ogg; an id the library lacks keeps its preset
//   r.assets   [{to, from, license}]        the files to copy, with each one's licence record
//   r.rows     [{id, from, files, how}]     what each id became (library, alias, own, preset), for a report
//
//   node runtimes/forge/tools/sound-wire.mjs <spec.json | game dir>            print what each id becomes
//   node runtimes/forge/tools/sound-wire.mjs <game dir> --write                 rewire an existing forge game:
//        its assets.json sound list replaced by the library's, the files copied in (run upgrade or create after, so
//        assets.json lists the new audio slots)
//
// Default bus levels only (research/audio/GUIDE.md): no `buses` key is written, and no gainDb is above 0.
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { forgeLibrarySync } from './library.mjs';

const FORGE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOUNDS = join(FORGE, 'sounds');
const readJson = p => JSON.parse(readFileSync(p, 'utf8'));
const clone = v => JSON.parse(JSON.stringify(v));

/** Every file a gf-audio source names. */
export function filesOf(src, out = new Set()) {
  if (Array.isArray(src)) src.forEach(s => filesOf(s, out));
  else if (src?.layers) filesOf(src.layers, out);
  else if (typeof src?.file === 'string') out.add(src.file);
  return out;
}
const rebase = (src, to) => {
  if (Array.isArray(src)) return src.map(s => rebase(s, to));
  if (src?.layers) return { ...src, layers: rebase(src.layers, to) };
  return typeof src?.file === 'string' ? { ...src, file: to(src.file) } : src;
};

/**
 * The sound list of a forge game. ids: [{id, preset, label}] (the tables' soundsOf, then the kit's round sounds);
 * tables: the filled forge tables (which weapons name an id, whether the game has waves and cards).
 */
export function forgeSoundList({ ids = [], tables = {}, sounds: soundsDir = SOUNDS, library = null, dir = 'assets/sounds' } = {}) {
  const list = readJson(join(soundsDir, 'sounds.json')).sounds, wire = readJson(join(soundsDir, 'wire.json'));
  const L = library ?? forgeLibrarySync(), licences = L.forgeLicences;
  const fileOf = f => { try { return L.forgeFile(f); } catch { return null; } };
  const want = new Map(ids.map(s => [s.id, s]));
  const extra = [...wire.always, ...((tables.waves ?? []).length ? wire.withWaves : []), ...((tables.cards ?? []).length ? wire.withCards : [])];
  for (const id of extra) if (!want.has(id)) want.set(id, { id, preset: null, label: null });
  // an id several weapons name takes the sound of their kinds when every one of them agrees
  const kindsOf = id => new Set((tables.weapons ?? []).filter(w => Object.values(w.sounds ?? {}).includes(id)).map(w => w.kind));
  const aliasOf = id => {
    const byKind = wire.aliasByKind?.[id];
    if (byKind) { const k = [...kindsOf(id)]; if (k.length && k.every(x => byKind[x] && byKind[x] === byKind[k[0]])) return byKind[k[0]]; }
    return wire.alias?.[id] ?? null;
  };
  const to = f => `${dir}/${f.replace(/^sounds\//, '')}`;
  const sounds = {}, rows = [], used = new Set();
  for (const [id, s] of want) {
    const alias = aliasOf(id);
    const [entry, how, from] = wire.own?.[id] ? [wire.own[id], 'own', null] : alias && list[alias] ? [list[alias], 'alias', alias] : list[id] ? [list[id], 'library', id] : [null, 'preset', null];
    if (!entry) {
      if (s.preset) sounds[id] = { label: s.label ?? id, src: { preset: s.preset } };
      rows.push({ id, how, from: s.preset ?? null, files: [] });
      continue;
    }
    const e = clone(entry), files = [...filesOf(e.src)];
    // a trim the wiring records (wire.json trim: measured by tools/listen.mjs): only ever down
    if (Number.isFinite(wire.trim?.[id]) && wire.trim[id] < 0) e.gainDb = Math.min(0, (e.gainDb ?? 0) + wire.trim[id]);
    for (const f of files) used.add(f);
    e.src = rebase(e.src, to);
    sounds[id] = e;
    rows.push({ id, how, from, files });
  }
  const assets = [...used].sort().map(f => {
    const l = licences[f] ?? null;
    return { to: to(f), name: f, from: fileOf(f), license: l ? { spdx: l.spdx, author: l.author, url: l.page } : null, modified: l?.modified ?? null };
  });
  const missing = assets.filter(a => !a.from || !existsSync(a.from)).map(a => a.name), unlicensed = assets.filter(a => !a.license).map(a => a.to);
  return { sounds, assets, rows, presets: rows.filter(r => r.how === 'preset').map(r => r.id), bytes: assets.reduce((n, a) => n + (a.from && existsSync(a.from) ? statSync(a.from).size : 0), 0), problems: [...missing.map(f => `${f}: not on this machine`), ...unlicensed.map(f => `${f}: no licence record`)] };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const a = process.argv.slice(2), target = a.find(x => !x.startsWith('--'));
  if (!target) { console.error('usage: sound-wire.mjs <spec.json | game dir> [--write]'); process.exit(2); }
  const T = await import(pathToFileURL(join(FORGE, 'kit/tables/index.js')).href);
  const isDir = existsSync(join(resolve(target), 'config/game.json'));
  const forge = isDir ? readJson(join(resolve(target), 'config/game.json')).forge : T.fill(readJson(resolve(target)).forge ?? {});
  const kit = [['ui-click', 'click', 'Menu click'], ['round-countdown', 'countdown', 'Countdown beep'], ['round-go', 'confirm', 'Round starts'], ['round-win', 'win', 'You won the round'], ['round-end', 'lose', 'The round ends']].map(([id, preset, label]) => ({ id, preset, label }));
  const r = forgeSoundList({ ids: [...kit, ...T.soundsOf(forge)], tables: forge });
  for (const x of r.rows) console.log(`${x.how.padEnd(8)} ${x.id.padEnd(22)} ${x.how === 'preset' ? `gf-audio preset ${x.from}` : `${x.from ? `${x.from}: ` : ''}${x.files.map(f => f.replace('sounds/', '')).join(', ')}`}`);
  console.log(`${r.rows.length} ids: ${r.rows.filter(x => x.how === 'library').length} the library's, ${r.rows.filter(x => x.how === 'alias').length} by another name, ${r.rows.filter(x => x.how === 'own').length} made from its files, ${r.presets.length} still presets${r.presets.length ? ` (${r.presets.join(', ')})` : ''}; ${r.assets.length} files, ${(r.bytes / 1024).toFixed(0)} KB`);
  for (const p of r.problems) console.log(`problem: ${p}`);
  if (a.includes('--write')) {
    if (!isDir) { console.error('--write needs a game dir'); process.exit(2); }
    const dir = resolve(target), mf = join(dir, 'assets.json'), m = readJson(mf);
    for (const x of r.assets) { mkdirSync(dirname(join(dir, x.to)), { recursive: true }); copyFileSync(x.from, join(dir, x.to)); }
    m.sounds = { version: 1, sounds: r.sounds };
    writeFileSync(mf, JSON.stringify(m, null, 2) + '\n');
    console.log(`wrote ${r.assets.length} files under assets/sounds and the sound list in assets.json (run upgrade or create next: the files become audio slots)`);
  }
  if (r.problems.length) process.exitCode = 1;
}
