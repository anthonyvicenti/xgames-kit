// The one start-up guard for every tool that is both a module and a command:
//
//   import { isMain } from './lib/main.mjs';
//   if (isMain(import.meta)) { …the command line… }
//
// It replaces two forms that were wrong off Linux:
//   import.meta.url === `file://${process.argv[1]}`              never true on Windows (C:\… against file:///C:/…), nor
//                                                                under a path with a space, a % or a non-ASCII letter
//   fileURLToPath(import.meta.url) === resolve(process.argv[1])  false when the tool is started through a symlinked
//                                                                path (macOS /tmp, a symlinked home): Node loads the
//                                                                real path, argv[1] keeps the one that was typed
// Node 24.2+ answers the question itself (import.meta.main). On an older Node, sameEntry() compares the two as files:
// both turned into paths by Node's own rules for the system, symlinks resolved, and letter case ignored on Windows.
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Is the module at `url` (an import.meta.url) the file Node was started with (`argv1`, process.argv[1])?
 * Pure apart from `realpath`; `platform` picks the path rules, so a Windows case can be checked on any system.
 */
export function sameEntry(url, argv1, { platform = process.platform, cwd = null, realpath = realpathSync } = {}) {
  if (!url || !argv1 || !String(url).startsWith('file:')) return false;
  const windows = platform === 'win32', impl = windows ? path.win32 : path.posix;
  let a;
  try { a = fileURLToPath(url, { windows }); } catch { return false; }
  // path.resolve reads the real working directory; `cwd` is for tests that check another system's paths
  const b = impl.isAbsolute(argv1) ? impl.normalize(argv1) : impl.resolve(cwd ?? process.cwd(), argv1);
  const real = p => { try { return realpath(p); } catch { return p; } };
  const key = p => { const n = impl.normalize(p); return windows ? n.toLowerCase() : n; };
  if (key(a) === key(b)) return true;
  // Node also starts `node tools/create` and `node tools\create.mjs` style paths; extension-less starts are not ours
  return key(real(a)) === key(real(b));
}

/** Was this module started as the command (`node tool.mjs …`), not imported? Pass import.meta. */
export function isMain(meta, { argv1 = process.argv[1], ...opts } = {}) {
  if (typeof meta?.main === 'boolean') return meta.main;
  return sameEntry(meta?.url, argv1, opts);
}
