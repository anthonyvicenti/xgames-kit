#!/usr/bin/env node
// Export a game's Godot project (<game>/project) to the files its page loads (<game>/build: game.js, game.wasm,
// game.pck), with the pinned editor run headless and the pinned web template (toolchain/toolchain.json).
//
//   node runtimes/godot/tools/export.mjs <game-dir> [--force] [--json]
//
// The project is copied to a work folder outside the game (~/.cache/xgames-kit/godot-work/<id>/), where Godot keeps
// its import cache between exports, and the kit's export preset is written there with the template's path: nothing
// machine-specific is ever written into the game. An unchanged project is not exported again (build/godot-build.json
// holds the project's hash) unless --force. GDScript errors in the log fail the export, each named.
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ensureToolchain, sha256 } from './install.mjs';
import { isMain, RUNTIME, TOOLCHAIN, VERSION } from './lib.mjs';

const run = promisify(execFile);
/** The files the page needs from Godot's output (the html shell, icons and the service worker are never used). */
export const KEEP = ['game.js', 'game.wasm', 'game.pck'];

async function walk(dir, base = dir, out = []) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.name === '.godot' || e.name === '.import' || e.name.startsWith('.')) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) await walk(p, base, out); else out.push(relative(base, p).split('\\').join('/'));
  }
  return out.sort();
}

/** A hash of the project's files (paths and bytes), the kit preset and the toolchain: equal means the export would be. */
export async function projectHash(project) {
  const h = createHash('sha256');
  for (const f of await walk(project)) { h.update(f + '\0'); h.update(await readFile(join(project, f))); h.update('\0'); }
  h.update(await readFile(join(RUNTIME, 'toolchain', 'export_presets.cfg'))); h.update(TOOLCHAIN.template.fileSha256);
  return h.digest('hex');
}

/** The lines of Godot's log that are errors in the game's scripts or resources (not the editor's own noise, and not the
 *  headless native run's dummy renderer, which has no real materials: its complaints never reach a browser). */
export function logErrors(text) {
  const seen = new Map(), lines = String(text).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^(SCRIPT ERROR|ERROR|Parse Error)/.test(l) && !/Condition "!FileAccess::exists|editor_settings|EditorSettings|is not a valid project|ProjectSettings::_load_settings|Failed loading resource: res:\/\/\.godot|servers\/rendering\/dummy\//.test(l) && !/servers\/rendering\/dummy\//.test(lines[i + 1] ?? "")) {
      const line = [l, lines[i + 1]?.trim().startsWith('at:') ? lines[i + 1].trim() : null].filter(Boolean).join(' ');
      seen.set(line, (seen.get(line) ?? 0) + 1);
    }
  }
  return [...seen].map(([line, n]) => (n > 1 ? `${line} (${n} times)` : line));
}

export async function exportGame(gameDir, { force = false, noSmoke = false, log = () => {} } = {}) {
  const game = resolve(gameDir), project = join(game, 'project'), build = join(game, 'build');
  if (!existsSync(join(project, 'project.godot'))) throw new Error(`${project}: no project.godot (a runtime godot game keeps its Godot project in project/)`);
  const hash = await projectHash(project);
  const record = join(build, 'godot-build.json');
  if (!force && existsSync(record)) {
    const r = JSON.parse(await readFile(record, 'utf8'));
    if (r.project === hash && KEEP.every(f => existsSync(join(build, f)))) return { ok: true, skipped: true, ...r };
  }
  const tc = await ensureToolchain({ log });
  const id = createHash('sha256').update(game).digest('hex').slice(0, 16);
  const work = join(process.env.XGAMES_GODOT_WORK || join(homedir(), '.cache', 'xgames-kit', 'godot-work'), id);
  const wp = join(work, 'project'), out = join(work, 'out');
  await mkdir(wp, { recursive: true });
  // the work copy: everything but Godot's import cache goes, then the game's project is copied over
  for (const e of await readdir(wp)) if (e !== '.godot') await rm(join(wp, e), { recursive: true, force: true });
  await cp(project, wp, { recursive: true, filter: s => !/[\\/]\.godot([\\/]|$)/.test(s) });
  const preset = (await readFile(join(RUNTIME, 'toolchain', 'export_presets.cfg'), 'utf8')).replace('$TEMPLATE', tc.template.replace(/\\/g, '/'));
  await writeFile(join(wp, 'export_presets.cfg'), preset);
  await rm(out, { recursive: true, force: true }); await mkdir(out, { recursive: true });
  const env = { ...process.env, HOME: join(work, 'home'), XDG_CONFIG_HOME: join(work, 'home', '.config'), XDG_DATA_HOME: join(work, 'home', '.local', 'share'), XDG_CACHE_HOME: join(work, 'home', '.cache') };
  const logs = [];
  const t0 = Date.now();
  for (const args of [['--headless', '--path', wp, '--import'], ['--headless', '--path', wp, '--export-release', 'Web', join(out, 'game.html')]]) {
    try {
      const r = await run(tc.editor, args, { env, timeout: 300000, maxBuffer: 64 * 1024 * 1024 });
      logs.push(r.stdout, r.stderr);
    } catch (e) { logs.push(e.stdout ?? '', e.stderr ?? '', String(e.message)); break; }
  }
  // a native run of the exported project's scenes, headless, alone (GF reads res://gf_alone.json and the slot files
  // beside the project): the game's script errors show here in seconds, before any browser
  let smoke = '';
  if (existsSync(join(out, 'game.pck')) && !noSmoke) {
    await rm(join(work, 'assets'), { recursive: true, force: true });
    if (existsSync(join(game, 'assets'))) await cp(join(game, 'assets'), join(work, 'assets'), { recursive: true });
    try { const r = await run(tc.editor, ['--headless', '--path', wp, '--quit-after', '120'], { env, timeout: 120000, maxBuffer: 16 * 1024 * 1024 }); smoke = r.stdout + '\n' + r.stderr; }
    catch (e) { smoke = (e.stdout ?? '') + '\n' + (e.stderr ?? '') + '\n' + String(e.message); }
    logs.push('---- native run (alone, 120 frames) ----', smoke);
  }
  const text = logs.join('\n');
  await writeFile(join(work, 'export.log'), text);
  const errors = logErrors(text);
  const missing = KEEP.filter(f => !existsSync(join(out, f)));
  if (missing.length || errors.length) return { ok: false, errors: errors.length ? errors : [`Godot wrote no ${missing.join(', ')} (log: ${join(work, 'export.log')})`], log: join(work, 'export.log') };
  await mkdir(build, { recursive: true });
  const files = {};
  for (const f of KEEP) { const b = await readFile(join(out, f)); files[f] = { sha256: sha256(b), bytes: b.length }; await rm(join(build, f), { force: true }); await rename(join(out, f), join(build, f)); }
  const rec = { schema: 'xgames-godot-build/1', runtime: VERSION, godot: TOOLCHAIN.version, template: TOOLCHAIN.template.fileSha256, project: hash, seconds: Math.round((Date.now() - t0) / 100) / 10, files };
  await writeFile(record, JSON.stringify(rec, null, 2) + '\n');
  log(`exported ${relative(process.cwd(), build) || build} in ${rec.seconds} s`);
  return { ok: true, skipped: false, ...rec };
}

if (isMain(import.meta)) {
  const a = process.argv.slice(2), dir = a.find(x => !x.startsWith('--'));
  if (!dir) { console.error('usage: export.mjs <game-dir> [--force] [--json]'); process.exit(2); }
  const r = await exportGame(dir, { force: a.includes('--force'), log: m => { if (!a.includes('--json')) console.log(m); } }).catch(e => ({ ok: false, errors: [e.message] }));
  if (a.includes('--json')) console.log(JSON.stringify(r, null, 2));
  else if (!r.ok) for (const e of r.errors) console.error(`export: ${e}`);
  else if (r.skipped) console.log('the project is unchanged: build/ is current');
  process.exit(r.ok ? 0 : 1);
}
