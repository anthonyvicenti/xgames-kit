#!/usr/bin/env node
// Put the multiplayer kit into a game: copies the kit to <game>/gf/mp/ and checks <game>/multiplayer.json.
// The game's own files are never touched (no script tag, no code change).
//
//   node builder/multiplayer/party/adopt.mjs <game-dir> [--check] [--kit-version 1.0.0|dev]
//
//   <game-dir>   the folder the game is served from (the one holding index.html and assets.json: a trial's source/)
//   --check      change nothing; exit 1 when the kit copy differs from the kit or the manifest has problems
//
// A game in mode "solo" or "room" carries the manifest only: the kit folder is for modes "race", "live" and "world"
// (a world needs --kit-version 1.5.0 or later while KIT_VERSION is 1.4.0).
import { isMain } from '../../tools/lib/main.mjs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KIT_DIR, KIT_VERSION, MANIFEST, WORLD_SINCE, checkKit, compareVersions, kitFiles, readManifest, validateMultiplayer } from './manifest.mjs';

export async function adopt(gameDir, { check = false, version = KIT_VERSION, log = console.log } = {}) {
  const dir = resolve(gameDir);
  const out = { dir, ok: true, problems: [], warnings: [], wrote: [], removed: [], mode: null };
  const { manifest, error } = await readManifest(dir);
  if (error) { out.ok = false; out.problems.push(`${MANIFEST}: ${error}`); return out; }
  const v = validateMultiplayer(manifest);
  out.mode = manifest.mode ?? null; out.warnings = v.warnings;
  if (!v.ok) { out.ok = false; out.problems.push(...v.problems.map(p => `${MANIFEST}: ${p}`)); return out; }
  if (manifest.mode !== 'race' && manifest.mode !== 'live' && manifest.mode !== 'world') return out;   // solo and room games carry the manifest only
  // A world needs world rooms (kit 1.5.0+): an older kit would show its Host / Join lobby instead.
  if (manifest.mode === 'world' && version !== 'dev' && compareVersions(version, WORLD_SINCE) < 0) {
    out.ok = false; out.problems.push(`${MANIFEST}: mode "world" needs gf-multiplayer ${WORLD_SINCE} or later (--kit-version ${WORLD_SINCE}); asked for ${version}`);
    return out;
  }

  const state = await checkKit(dir, { version });
  if (check) {
    for (const f of state.missing) out.problems.push(`${KIT_DIR}/${f}: missing`);
    for (const f of state.changed) out.problems.push(`${KIT_DIR}/${f}: differs from kit ${version}`);
    for (const f of state.extra) out.problems.push(`${KIT_DIR}/${f}: not a kit file`);
    out.ok = state.ok;
    return out;
  }
  const files = await kitFiles({ version });
  for (const [rel, buf] of files) {
    const path = join(dir, KIT_DIR, rel);
    const cur = await readFile(path).catch(() => null);
    if (cur?.equals(buf)) continue;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, buf);
    out.wrote.push(`${KIT_DIR}/${rel}`);
  }
  for (const rel of state.extra) { await rm(join(dir, KIT_DIR, rel)); out.removed.push(`${KIT_DIR}/${rel}`); }
  return out;
}

if (isMain(import.meta)) {
  const a = process.argv.slice(2);
  const dir = a.find(x => !x.startsWith('--'));
  const vi = a.indexOf('--kit-version');
  if (!dir) { console.error('usage: adopt.mjs <game-dir> [--check] [--kit-version <semver|dev>]'); process.exit(2); }
  const r = await adopt(dir, { check: a.includes('--check'), version: vi >= 0 ? a[vi + 1] : KIT_VERSION });
  for (const w of r.warnings) console.log(`warning: ${w}`);
  for (const p of r.problems) console.log(`problem: ${p}`);
  for (const f of r.wrote) console.log(`wrote ${f}`);
  for (const f of r.removed) console.log(`removed ${f}`);
  console.log(r.ok ? `ok: ${r.mode}${r.mode === 'race' || r.mode === 'live' || r.mode === 'world' ? `, kit in ${KIT_DIR}/ (${r.wrote.length} written)` : ' (manifest only)'}` : 'not ok');
  process.exit(r.ok ? 0 : 1);
}
