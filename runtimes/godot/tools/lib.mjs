// runtime godot: paths and small helpers shared by its tools.
//
// SHARED names where the shared system's parts are in this repository (docs/LAYOUT.md). A Godot game vendors the
// three.js-free parts of the shared page kit (gf/three/: assets, core, net, ui, flat), gf/mp/, gf/gf-assets.js and
// audio/, each assembled from its layer by builder/tools/lib/paths.mjs (GAME_TREE, repoFileOf): a game path's source is
// repoFileOf(path), and gf/godot/ is this runtime's kit/ (its row in GAME_TREE). Nothing else in runtimes/godot names a
// path outside this table.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BUILDER, GF_ASSETS, GF_AUDIO, GF_MP, KIT, PARTY, REPO, TOOLS_LIB, FLAT_KIT, repoFileOf } from '../../../builder/tools/lib/paths.mjs';

export const RUNTIME = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const TOOLCHAIN = JSON.parse(readFileSync(join(RUNTIME, 'toolchain', 'toolchain.json'), 'utf8'));
export const RUNTIME_JSON = JSON.parse(readFileSync(join(RUNTIME, 'runtime.json'), 'utf8'));
export const VERSION = RUNTIME_JSON.version;
export { REPO, repoFileOf };

/** Where each shared part a Godot game uses comes from. */
export const SHARED = {
  three: KIT,                                         // gf/three/ as a game sees it (repoFileOf maps each file to its layer)
  flat: FLAT_KIT,                                     // gf/three/flat/: the gf-tilemap-1 reader, the gf-flat-1 judge
  mp: join(GF_MP, 'source'),                          // → gf/mp/ (whole)
  assets: GF_ASSETS,                                  // → gf/gf-assets.js
  audio: join(GF_AUDIO, 'source'),                    // → audio/ (whole)
  png: join(TOOLS_LIB, 'flat-png.mjs'),               // decodePng (the flat judge reads pictures with it)
  party: PARTY,                                       // serve, the friends page and signaling, the multiplayer gate
  toolsLib: TOOLS_LIB,                                // the shared checks a runtime may reuse (friends-watch-check: voice)
  browser: join(BUILDER, 'qa', 'browser.mjs'),        // launchChrome
  kinds: process.env.XGAMES_KINDS || join(REPO, 'kinds'),   // the kind presets (kinds/<id>.json)
};
const ver = f => { try { return readFileSync(f, 'utf8').trim(); } catch { return null; } };
export const KIT_VERSIONS = {
  three: '0.1.0-dev',
  mp: JSON.parse(readFileSync(join(SHARED.mp, 'kit.json'), 'utf8')).version,
  assets: ver(join(dirname(GF_ASSETS), 'VERSION')),
  audio: ver(join(SHARED.audio, 'VERSION')),
};

export function isMain(meta) {
  try { return process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === meta.url; } catch { return false; }
}

/** Texels per metre of a flat style (gf-flat-1). */
export const PPM = { pixel: 16, drawn: 128 };

/** A module of the shared page kit by its game path (gf/three/flat/tilemap.js), imported in Node: imports that cross
 *  layers resolve through the game's tree (builder/tools/lib/kit-import.mjs). */
export async function importShared(gamePath) {
  const { importLayer } = await import('../../../builder/tools/lib/kit-import.mjs');
  return importLayer(repoFileOf(gamePath));
}
