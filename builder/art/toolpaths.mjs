// Where the validators the library calls live. They belong to other layers (the shared rig-check, the flat runtime's
// judge, the shared audio gate and gf-audio's meter), so this file is the one place that names their paths. Each can
// be pointed elsewhere by its variable.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { importLayer } from '../tools/lib/kit-import.mjs';
import { REPO_ROOT } from './config.mjs';

const TOOLS = {
  rigCheck: { env: 'XGAMES_RIG_CHECK', at: 'builder/tools/rig-check.mjs' },
  soundGate: { env: 'XGAMES_SOUND_GATE', at: 'builder/audio-gates/qa-gate-v5.mjs' },
  flatJudge: { env: 'XGAMES_FLAT_JUDGE', at: 'runtimes/three/profiles/flat-2d/judge.js' },
  meter: { env: 'XGAMES_METER', at: 'builder/gf-audio/source/meter.mjs' },
};

/** The file of a tool, or null: its variable, else its place in the kit. */
export function toolPath(name, { env = process.env, root = REPO_ROOT } = {}) {
  const t = TOOLS[name];
  if (!t) throw new Error(`no tool "${name}"`);
  return [env[t.env], path.join(root, t.at)].filter(Boolean).find(p => existsSync(p)) ?? null;
}

const cache = new Map();
/** The tool's module, or null when it is not on this machine (the caller records the check as skipped, with why). */
export async function loadTool(name, opts) {
  const file = toolPath(name, opts);
  if (!file) return null;
  // a kit module (the flat judge) imports across layers as a game would: through the kit's import hook
  if (!cache.has(file)) cache.set(file, file.endsWith('.js') ? importLayer(file) : import(pathToFileURL(file).href));
  return { file, mod: await cache.get(file) };
}
