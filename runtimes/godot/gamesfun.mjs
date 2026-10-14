// runtime godot in the `gamesfun` CLI: create, verify and dev for a game whose spec says runtime "godot". The builder's
// commands call these through one seam each (builder/lib/create.mjs, builder/commands/verify.mjs, builder/commands/
// dev.mjs); everything Godot-specific stays here. The toolchain is installed only from here (create's export, dev's
// first export, verify of a game with no build): a three.js game never reaches this file.
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { create } from './tools/create.mjs';
import { applyExample } from './tools/example.mjs';
import { exportGame } from './tools/export.mjs';
import { RUNTIME } from './tools/lib.mjs';
import { DEVICE_LEGS, LEGS } from './tools/measure.mjs';

const readJson = async (file, fallback = null) => { try { return JSON.parse(await readFile(file, 'utf8')); } catch { return fallback; } };

/** Does this spec file ask for runtime godot? */
export async function isGodotSpec(specPath) {
  return (await readJson(specPath, {}))?.runtime === 'godot';
}

/** Is this folder a game on runtime godot? (create's record says so.) */
export function isGodotGame(dir) {
  try { return JSON.parse(readFileSync(path.join(dir, 'xgames.json'), 'utf8'))?.runtime?.id === 'godot'; } catch { return false; }
}

const toPosix = p => p.split(path.sep).join('/');

/** The game's guide for the person's agent (AGENTS.md and a CLAUDE.md that imports it), from templates/game/. */
async function writeGuide(dir, spec, { kitRoot, shown, force = false }) {
  const vars = {
    TITLE: spec.title ?? path.basename(dir), HOOK: spec.hook ?? '', GAME: shown, KIT: toPosix(path.relative(dir, kitRoot)) || '.',
    PROFILE: spec.profile ?? '2d', CAMERA: spec.camera ?? 'side',
    CONTROLS: Object.entries(spec.controls ?? {}).map(([k, v]) => `${k}: ${v}`).join('; ') || '(none named)',
  };
  const wrote = [];
  for (const [from, to] of [['AGENTS.md', 'AGENTS.md'], ['CLAUDE.md', 'CLAUDE.md'], ['gitignore', '.gitignore']]) {
    const out = path.join(dir, to);
    if (existsSync(out) && !force) continue;
    const text = await readFile(path.join(RUNTIME, 'templates', 'game', from), 'utf8');
    await writeFile(out, text.replace(/\{\{([A-Z_]+)\}\}/g, (m, k) => (k in vars ? String(vars[k]) : m)));
    wrote.push(to);
  }
  return wrote;
}

/**
 * `gamesfun create` for a godot spec: create's output, the example's own files over it (rules.js, files/), the export
 * (installing Godot the first time), the guide. → the shape builder/lib/create.mjs returns.
 */
export async function createGodotGame(dir, { specPath, example = null, force = false, fresh = true, kitRoot, shown, log = () => {} }) {
  if (!fresh && !force) throw new Error(`${shown} is already a game. A Godot game is made once from its spec: pick a new folder (or pass --force to make it again over this one)`);
  if (force && existsSync(dir)) {
    // --force: everything create writes is written again; the person's own files outside it stay
    const keep = new Set(['evidence', '.git']);
    const { rm } = await import('node:fs/promises');
    for (const e of await readdir(dir)) if (!keep.has(e)) await rm(path.join(dir, e), { recursive: true, force: true });
  }
  await mkdir(dir, { recursive: true });
  if ((await readdir(dir)).filter(e => !['evidence', '.git'].includes(e)).length) throw new Error(`${shown} is not empty`);
  // create writes into an empty folder: a kept evidence/ waits beside it and comes back
  const r = await create(specPath, dir, { exportNow: false, log, allowEvidence: true });
  if (!r.ok) throw new Error(`the spec does not make a game:\n  ${r.problems.join('\n  ')}`);
  const applied = example ? await applyExample(example.dir, dir) : [];
  const e = await exportGame(dir, { log });
  if (!e.ok) throw new Error(`the Godot export failed:\n  ${e.errors.join('\n  ')}`);
  const spec = await readJson(path.join(dir, 'spec.json'), {});
  const guide = await writeGuide(dir, spec, { kitRoot, shown, force });
  const slots = r.slotList ?? [];
  return {
    ok: true, dir, shown, title: spec.title, example: example?.id ?? null, fresh, runtime: 'godot',
    wrote: r.files, kept: [], applied, guide, web3: null,
    notes: [...(r.notes ?? []), `exported with Godot (build/, ${e.skipped ? 'unchanged' : `${e.seconds} s`})`, 'web3: the wallet and items are not wired into Godot games yet, so gf/web3/ was not added'],
    warnings: [], modules: [], slots: slots.length, main: slots.filter(s => s.tier === 'main').length,
  };
}

/** The next evidence/verify-N folder of a game. */
export async function nextVerifyDir(dir) {
  let n = 0;
  try { for (const e of await readdir(path.join(dir, 'evidence'))) { const m = /^verify-(\d+)$/.exec(e); if (m) n = Math.max(n, Number(m[1])); } } catch {}
  return path.join(dir, 'evidence', `verify-${n + 1}`);
}

/**
 * `gamesfun verify` for a godot game: runtimes/godot/tools/verify.mjs. --quick: the measures without the shared
 * multiplayer gate (the default here); --release: with it; --check <static list> or --gate: what that needs.
 * --json prints the verdict, with a flat `checks` list ({n, name, ok, detail}: what the studio and the MCP tool show).
 */
export async function verifyGodotGame(dir, { quick = false, release = false, check = null, gate = null, out = null, json = false } = {}) {
  const { verify } = await import('./tools/verify.mjs');
  const STATIC = new Set(['1', '2', '17', '18', '19']);
  const staticOnly = !!check && check.split(',').every(n => STATIC.has(n));
  const o = out ? path.resolve(out) : await nextVerifyDir(dir);
  const t0 = Date.now();
  const r = await verify(dir, { out: o, staticOnly, mpGate: release && !quick, legs: [...legsFor(gate), ...(release ? DEVICE_LEGS : [])], only: gate ? gate.toUpperCase() : null, log: m => { if (!json) console.log(m); } });
  const seconds = Math.round((Date.now() - t0) / 1000);
  if (json) console.log(JSON.stringify({ ...r.verdict, checks: r.record.checks, outDir: path.relative(dir, o), seconds }, null, 2));
  else {
    for (const [g, x] of Object.entries(r.verdict.gates)) console.log(`gate ${g}: ${x.ok ? 'pass' : x.ran.length ? 'FAIL' : 'not run'}  ran ${x.ran.join(' ') || '-'}  passed ${x.passed.join(' ') || '-'}  failed ${x.failed.join(' ') || '-'}  skipped ${x.skipped.map(s => s.measure + (s.required ? '!' : '')).join(' ') || '-'}`);
    console.log(`${r.verdict.pass ? 'verified' : 'NOT verified'} (runtime godot, ${seconds} s) → ${toPosix(path.relative(process.cwd(), o)) || o}/verdict.json`);
  }
  return r.verdict.pass ? 0 : 1;
}

/** The browser legs a gate needs (all of them when no gate is named). */
export function legsFor(gate) {
  if (!gate) return LEGS;
  return { A: ['boot', 'swap'], B: LEGS, C: ['boot', 'bots', 'panels'], D: ['round', 'bots'], E: ['live', 'watch'], F: ['boot', 'live'] }[gate.toUpperCase()] ?? LEGS;
}

/**
 * `gamesfun dev` for a godot game: the dev server serves it as any game (live reload sees build/ change); this exports
 * the project once now and again whenever a file in project/ changes. → { close }
 */
export async function devGodotGame(dir, { log = console.log } = {}) {
  const { watch } = await import('node:fs');
  const first = await exportGame(dir, { log }).catch(e => ({ ok: false, errors: [e.message] }));
  if (!first.ok) for (const e of first.errors) log(`  godot    export: ${e}`);
  else log(`  godot    build/ ${first.skipped ? 'is current' : `exported in ${first.seconds} s`}; a change in project/ exports again`);
  let timer = null, running = false, again = false;
  const rebuild = async () => {
    if (running) { again = true; return; }
    running = true;
    const r = await exportGame(dir, { log: () => {} }).catch(e => ({ ok: false, errors: [e.message] }));
    if (!r.ok) for (const e of r.errors) log(`  godot    export: ${e}`);
    else if (!r.skipped) log(`  godot    exported in ${r.seconds} s (the page reloads)`);
    running = false;
    if (again) { again = false; rebuild(); }
  };
  const w = watch(path.join(dir, 'project'), { recursive: true }, (_, f) => {
    if (!f || /(^|[\\/])\.godot([\\/]|$)/.test(f)) return;
    clearTimeout(timer); timer = setTimeout(rebuild, 400);
  });
  return { close: () => { clearTimeout(timer); w.close(); } };
}
