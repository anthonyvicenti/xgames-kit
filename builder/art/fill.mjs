// Filling a game's default slots from the library. The art order is: provided, library, connection, session,
// stand-ins; this is the library step, so a slot the creator already provided is left alone and a slot the library
// cannot fill is returned for the next step, never filled with a stand-in here.
//   fillGame(…)      resolve every file slot, copy each pick's bytes to the slot's own path, hand back the credits
//   libraryFill(…)   create's one call (builder/tools/create.mjs): every declared file slot a new game still lacks
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { loadLibrary } from './library.mjs';
import { loadPolicy } from './policy.mjs';
import { fillSlots, loadKind } from './resolve.mjs';
import { exportAsset } from './store.mjs';
import { artLibrary, assetFile, findAsset, licenceOf } from './views.mjs';

/**
 * fillGame({ config, game, slots, kind, runtime, devices, provided, paid, write })
 *   game      the game folder (slot files are written relative to it)
 *   slots     the game's slot declarations (assets.json → slots)
 *   provided  slot ids the creator already gave a file for (left alone)
 *   write     false: plan only, copy nothing
 * → { written: [{slot, file, ref}], credits: [{file, ref, licence, credit}], next: [{slot, findings}], findings }
 */
export async function fillGame({ config, game, slots, kind = null, runtime = 'three', devices = ['phone', 'desktop'], provided = [], paid = null, write = true, privatePacks = true }) {
  const lib = loadLibrary(config, { privatePacks });
  const kindPreset = loadKind(kind, config.kindsDir);
  const open = (Array.isArray(slots) ? slots : Object.values(slots)).filter(s => !provided.includes(s.id));
  const r = fillSlots(lib, open, { kindPreset, runtime, devices, policy: loadPolicy(config.policyFile), paid });
  const written = [], credits = [], findings = [];
  const byRef = new Map(lib.flatMap(p => p.assets.map(a => [`${a.pack}/${a.id}`, { asset: a, pack: p.pack }])));
  for (const f of r.filled) {
    const slot = open.find(s => s.id === f.slot);
    const rel = slot?.source?.file;
    if (!rel) { findings.push(`${f.slot}: the slot names no file to write`); continue; }
    const { asset, pack } = byRef.get(f.pick.ref);
    if (write) await exportAsset(config, asset, path.join(game, rel));
    written.push({ slot: f.slot, file: rel, ref: f.pick.ref, variant: f.pick.variant, scale: f.pick.scale });
    const lic = asset.licence ?? pack.licence;
    credits.push({ file: rel, ref: f.pick.ref, licence: lic.spdx, author: lic.author ?? null, credit: lic.credit ?? null, licenceFile: pack.visibility === 'public' ? lic.file ?? null : null });
    findings.push(...f.findings.map(x => `${f.slot}: ${x}`));
  }
  return { written, credits, next: r.none.map(n => ({ slot: n.slot, optional: n.optional, findings: n.findings, next: n.next })), findings, kindMissing: !!kindPreset?.missing };
}

/** Credit lines as an ATTRIBUTION table's rows (the game's credits file). */
export function creditRows(credits) {
  return credits.map(c => `| ${c.file} | ${c.ref} | ${c.credit ?? `${c.licence}${c.author ? `, ${c.author}` : ''}`} |`);
}

export const hasGame = dir => existsSync(path.join(dir, 'assets.json'));

const SLOT_DIMENSION = { image: '2d', texture: '2d', model: '3d', audio: 'audio', sound: 'audio' };
const json = v => JSON.stringify(v, null, 2) + '\n';

/**
 * create's library step: every declared file slot the new game still has no file for is filled from the asset
 * library. A slot first takes the asset of its own file's name in the runtime's packs (a module's own picture, e.g. the
 * look's noise; a noise or pattern slot the library's soft noise); a slot that is not optional then takes whatever the
 * resolver finds best by need and fit for the game's kind (an optional one, a hat say, stays empty until asked for). Each pick is written through `put` (create's own-file writer), its
 * licence goes into the build record's art rows (ATTRIBUTION.md; a CC BY pick with its full credit line), and a slot
 * nothing fits is a warning that names the next step. → the manifest assembled again (or A unchanged).
 *   A          create's assembled manifest ({ manifest, … })
 *   spec       the game spec (its `kind` ranks the kind's packs first)
 *   record     the build record (gf-three.json), rewritten through `rewrite` when anything was filled
 *   assemble   () → A again, once the files are in
 */
export async function libraryFill(dir, A, { spec = {}, record, put, rewrite, assemble, warnings = [], scope = null } = {}) {
  const open = (A.manifest.slots ?? []).filter(s => s.source?.file && !s.source.pointer && SLOT_DIMENSION[s.type] && !existsSync(path.join(dir, s.source.file)));
  if (!open.length) return A;
  const L = artLibrary(), sc = scope ?? (record?.kit?.profile === 'scenic-3d' ? 'scenic' : 'three');
  // a spec's own slot (spec.slots[], game.*) may say how it is filled: a library asset by name, or a made one's stand-in
  const fills = new Map((spec.slots ?? []).filter(x => x?.id && x.fill).map(x => [x.id, x.fill]));
  const named = s => { const f = fills.get(s.id); const ref = f?.from === 'library' ? f.asset : ['generate', 'reference'].includes(f?.from) ? f.standIn : null; return ref ? findAsset(ref, null, { L }) : null; };
  const picks = [], rest = [];
  for (const s of open) {
    const base = s.source.file.split('/').pop().replace(/\.[^.]+$/, '');
    const a = [named(s), ...[base, ...(/noise|pattern/i.test(`${s.id} ${base}`) ? ['noise-soft'] : [])].map(n => findAsset(n, sc, { anywhere: false, L }))].find(x => x?.dimension === SLOT_DIMENSION[s.type]);
    if (a) picks.push({ slot: s, asset: a }); else if (!s.optional) rest.push(s);
  }
  if (rest.length) {
    const r = await fillGame({ config: L.config, game: dir, slots: rest, kind: spec.kind ?? null, runtime: 'three', write: false });
    for (const w of r.written) picks.push({ slot: rest.find(s => s.id === w.slot), asset: findAsset(w.ref, null, { L }) });
    for (const n of r.next) warnings.push(`slot ${n.slot}: no file, and the asset library has nothing that fits (${n.findings.join('; ')}); next: ${n.next}`);
  }
  for (const { slot, asset } of picks) {
    await put(slot.source.file, await readFile(await assetFile(asset, { L })));
    const l = licenceOf(asset, L), ref = `${asset.pack}/${asset.id}`;
    const licence = l.licenseUrl ? `"${l.title}" by ${l.author}${l.url ? ` (${l.url})` : ''}, licensed under ${l.spdx.replace(/^CC-BY-/, 'CC BY ')} (${l.licenseUrl})${l.modified ? `; changed: ${l.modified}` : ''}` : `${l.spdx}${l.author ? `, ${l.author}` : ''}`;
    (record.worldArt ??= []).push({ file: slot.source.file, what: `${slot.label ?? slot.id} (library:${ref})`, license: licence });
  }
  if (!picks.length) return A;
  await rewrite('gf-three.json', json(record));
  return assemble();
}
