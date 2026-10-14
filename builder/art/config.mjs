// Where the asset library lives and how it is set up. One file says it: library/library.json (in git). Every path in
// it can be overridden by an environment variable, so a test or another machine points the tools elsewhere.
//
//   library/packs/<id>/          public packs: pack.json, assets/<asset>.json, previews/<asset>.png, LICENSE.txt (git)
//   library/defaults/sha256/ab/  the small default set the kit ships: the public binaries its runtimes and examples
//                                use by default, content-addressed like the store (git)
//   <store>/sha256/ab/<sha256>   every binary, content-addressed, outside git              (XGAMES_STORE)
//   <privatePacks>/packs/<id>/   private packs, laid out like public ones, never pushed     (XGAMES_PRIVATE_PACKS)
//   <quarantine>/<sha256>/       what ingest refused (no licence record), never indexed     (XGAMES_QUARANTINE)
//
// Where private packs live is an open creator decision (2026-10-13); the default is a folder in the person's home.
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The repository root: builder/art/ sits two levels down. */
export const REPO_ROOT = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
export const LIBRARY_ROOT = path.join(REPO_ROOT, 'library');

export const expandHome = p => (p && (p === '~' || p.startsWith('~/')) ? path.join(os.homedir(), p.slice(1)) : p);

const DEFAULTS = {
  store: '~/.xgames/store',
  defaults: 'defaults',
  privatePacks: '~/.xgames/private-packs',
  quarantine: '~/.xgames/quarantine',
  mirrors: [],
  policy: 'policy.json',
  kinds: '../kinds',
};

/**
 * The library's settings: library.json under `root`, the defaults above, then the environment.
 * → { root, packsDir, store, defaults, privatePacks, quarantine, mirrors, policyFile, kindsDir }
 */
export function loadConfig({ root = process.env.XGAMES_LIBRARY ?? LIBRARY_ROOT, env = process.env } = {}) {
  const file = path.join(root, 'library.json');
  const own = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const c = { ...DEFAULTS, ...own };
  const at = p => path.resolve(root, expandHome(p));
  return {
    root,
    packsDir: path.join(root, 'packs'),
    store: at(env.XGAMES_STORE ?? c.store),
    defaults: at(c.defaults),
    privatePacks: at(env.XGAMES_PRIVATE_PACKS ?? c.privatePacks),
    quarantine: at(env.XGAMES_QUARANTINE ?? c.quarantine),
    mirrors: env.XGAMES_MIRRORS ? env.XGAMES_MIRRORS.split(/\s+/).filter(Boolean) : c.mirrors,
    policyFile: at(c.policy),
    kindsDir: at(env.XGAMES_KINDS ?? c.kinds),
  };
}

/** The folder a pack's manifests and previews live in, by its visibility. */
export const packDir = (config, pack) => path.join(pack.visibility === 'private' ? path.join(config.privatePacks, 'packs') : config.packsDir, pack.id);
