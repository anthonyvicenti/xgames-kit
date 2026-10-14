// Where the look judge finds the runtimes' code and art: this repository's own layers (builder/tools/lib/paths.mjs) and
// the asset library (builder/art/views.mjs). A page asks for a file the way a game sees it (/kit/look/look.js is a
// game's gf/three/look/look.js), and the server answers from the layer that holds it (repoFileOf), so the sheet draws
// with the same files a game vendors.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO, GF3, SCENIC, FORGE, VISTA, VENDOR, repoFileOf } from '../../tools/lib/paths.mjs';
import { bodiesIn, propsCatalog, findAsset, localFile, artLibrary } from '../../art/views.mjs';

/** The repository root (kinds/, runtimes/, builder/ under it). */
export const KIT = REPO;

/** Each runtime's folder: three (its kit and tools), the scenic-3d profile, forge, vista. */
export const ROOTS = { three: GF3, scenic: SCENIC, forge: FORGE, vista: VISTA };
export { VENDOR, repoFileOf };

/** The three runtime's character tools need their pinned three.js, gltf-transform and sharp (builder/tools/lib/char-deps,
 *  `npm ci` there). True when they are installed, so a test can skip with a reason instead of failing. */
export const CHAR_DEPS = join(REPO, 'builder/tools/lib/char-deps');
export function hasCharDeps() {
  return existsSync(join(CHAR_DEPS, 'node_modules'));
}

/**
 * The asset library as a page outside a game reads it (the world module's opts.library, the sheet's /lib3/):
 *   bodies.json     every gf-humanoid-1 body in the three and scenic packs and the kinds' packs ({bodies: [{id, file: "<pack>/<file>"…}], clips})
 *   props.json      the three packs' props (gf-three-props/1)
 *   <pack>/<file>   an asset's bytes on this machine
 *   textures/<name> a picture by its file name
 * → a function from the rest of a path to a file on this machine (null: not here). The two catalogs are written into
 * `cache` once.
 */
export function libraryRoute(cache) {
  mkdirSync(cache, { recursive: true });
  const seen = new Set();
  // the kinds' own packs too (a kind's body set may sit in a pack no runtime names by default: xk-blocky-bodies)
  const kindPacks = [...new Set(readdirSync(join(REPO, 'kinds')).filter(f => f.endsWith('.json')).flatMap(f => JSON.parse(readFileSync(join(REPO, 'kinds', f), 'utf8')).packs ?? []))];
  const known = new Set(artLibrary().packs.keys());
  const bodies = [...bodiesIn('three'), ...bodiesIn('scenic'), ...bodiesIn(kindPacks.filter(p => known.has(p)))].filter(b => !seen.has(b.id) && seen.add(b.id));
  writeFileSync(join(cache, 'bodies.json'), JSON.stringify({ bodies, clips: 'humanoid-clips/gf-humanoid-1.glb' }));
  writeFileSync(join(cache, 'props.json'), JSON.stringify(propsCatalog('three')));
  const L = artLibrary();
  const byFile = new Map();
  for (const p of L.lib) for (const a of p.assets) byFile.set(`${a.pack}/${a.file}`, a);
  return rel => {
    if (rel === 'bodies.json' || rel === 'props.json') return join(cache, rel);
    const a = byFile.get(rel) ?? (/^[a-z0-9.-]+\/[a-z0-9._-]+$/.test(rel) ? findAsset(rel) : null) ?? (rel.startsWith('textures/') ? findAsset(rel.split('/').pop().replace(/\.[^.]+$/, ''), 'three') : null);
    return a ? localFile(a) : null;
  };
}
