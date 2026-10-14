// What the forge world's worldConfig reads (create passes it in; the kit's code reads no file itself): the forge's
// casting (runtimes/forge/cast.json: roles, the ruin arena layouts, conventions, each piece's play data and its name in
// the asset library) put together with the asset library (library/packs, read through builder/art/views.mjs), which
// holds the art itself, its licences and its bytes. The scenic profile's pieces (the crypt room's KayKit modules) come
// from the same library through the scenic profile's own names.
//
//   forgeLibrary() → { props, licences, forgeLicences, forgeCatalog, standIns, standInOf(name), scenicFile(rel), forgeFile(rel) }
//     props          the scenic profile's props (gf-three-props/1 entries; `file` is the library's <pack>/<file>)
//     licences       licence records by those files; forgeLicences: by forge name (bodies/x.glb, small/…)
//     forgeCatalog   { conventions, roles, arena…, small (name → its small variant's name), sections (play data) }
//     scenicFile, forgeFile   a name → the bytes on this machine (the store or the kit's default set)
//     standIns       a role whose own art is not on this machine (a private pack's: the generated models the open kit
//                    does not ship) is drawn by its free stand-in (tools/stand-ins.mjs): {resolved, dropped}
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { artLibrary, assetsIn, findAsset, licenceOf, localFile, propEntry } from '../../../builder/art/views.mjs';
import { standIns } from './stand-ins.mjs';

const FORGE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const CAST = join(FORGE, 'cast.json');

const record = l => ({ spdx: l.spdx, author: l.author, page: l.url, ...(l.credit ? { credit: l.credit, title: l.title } : {}), ...(l.modified ? { modified: l.modified } : {}) });

let cached = null;
/** The forge's library, put together once per process (sync: every file the defaults name is on this machine). */
export function forgeLibrarySync() {
  if (cached) return cached;
  const cast = JSON.parse(readFileSync(CAST, 'utf8')), L = artLibrary();
  // a forge name → [asset, variant]: bodies/x.glb is <pack>/<id>; small/bodies/x.glb its "small" variant
  const pick = name => {
    const small = cast.small?.[name];
    const [ref, variant] = (small ?? cast.names?.[name] ?? '').split('#');
    const a = ref ? findAsset(ref, null, { L }) : null;
    return a ? [a, variant ?? null] : null;
  };
  const forgeLicences = {};
  for (const name of [...Object.keys(cast.names ?? {}), ...Object.keys(cast.small ?? {})]) { const p = pick(name); if (p) forgeLicences[name] = record(licenceOf(p[0], L)); }
  const forgeCatalog = {
    conventions: cast.conventions, roles: cast.roles, arena: cast.arena, arenaGrim: cast.arenaGrim, arenaMeshy: cast.arenaMeshy,
    // a piece a game ships in its small variant where the library has one for this machine (a private pack's art is
    // only here when that pack is)
    small: Object.fromEntries(Object.entries(cast.small ?? {}).filter(([s]) => pick(s)).map(([s]) => [s.replace(/^small\//, ''), s])),
    sections: cast.sections,
  };
  const props = assetsIn('scenic', { L, category: 'prop' }).map(a => propEntry(a, L));
  const licences = Object.fromEntries(assetsIn('scenic', { L }).map(a => [`${a.pack}/${a.file}`, record(licenceOf(a, L))]));
  const fileOf = (a, variant, name) => {
    const f = localFile(a, { variant, L });
    if (!f) throw new Error(`${name}: the library's ${a.pack}/${a.id} is not on this machine (gamesfun art fetch ${a.pack}/${a.id})`);
    return f;
  };
  // a name is here when the library has its asset on this machine (a private pack's only where that pack is)
  const here = name => { const p = pick(name); return !!p && !!localFile(p[0], { variant: p[1], L }); };
  const r = standIns(forgeCatalog, forgeLicences, here);
  const forgeFile = name => { const real = r.alias.get(name) ?? name, p = pick(real); if (!p) throw new Error(`the forge cast names no library asset for ${real} (runtimes/forge/cast.json)`); return fileOf(p[0], p[1], real); };
  const scenicFile = rel => { const a = findAsset(rel.replace(/\.[^.\/]+$/, ''), null, { L }); if (!a) throw new Error(`no library asset ${rel}`); return fileOf(a, null, rel); };
  cached = { props, licences, forgeLicences: r.licences, forgeCatalog: r.catalog, standIns: r.report, standInOf: name => r.alias.get(name) ?? null, scenicFile, forgeFile };
  return cached;
}

export async function forgeLibrary() { return forgeLibrarySync(); }
