#!/usr/bin/env node
// verify for runtime godot: the six gates, with the measures this runtime supplies and the ones it skips, each named.
//
//   node runtimes/godot/tools/verify.mjs <game-dir> [--out <dir>] [--static] [--mp-gate] [--devices] [--legs a,b] [--json]
//     --static    only what needs no browser (gate A, the export's integrity, the map)
//     --mp-gate   also the shared multiplayer gate (gf/mp's gate.mjs: a host and a joiner over real WebRTC, random
//                 real input, the round, a reload, the host leaving); it takes a few minutes
//     --devices   also a phone emulated in Chrome and Playwright's Firefox and WebKit (a release's; `gamesfun verify
//                 --release` runs both of these)
//
// The browser measures are tools/measure.mjs's (run this under the GPU slot script). Writes <out>/verdict.json.
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { projectHash } from './export.mjs';
import { sourceOf, closure, GODOT_NOTICES } from './create.mjs';
import { toolchainDir } from './install.mjs';
import { importShared, isMain, REPO, RUNTIME, SHARED, TOOLCHAIN, VERSION } from './lib.mjs';
import { measure } from './measure.mjs';

const sha = b => createHash('sha256').update(b).digest('hex');
const read = async p => JSON.parse(await readFile(p, 'utf8'));
const getAt = (doc, pointer) => pointer.slice(1).split('/').reduce((v, k) => (v == null ? undefined : v[k.replace(/~1/g, '/').replace(/~0/g, '~')]), doc);

/**
 * The measures of the six gates (the shared verify's numbers, research's GATES.md), and what runtime godot does with
 * each: `ran` (a check here or in tools/measure.mjs), `partial` (part of it, the rest named), or `skip` (with why).
 */
export const MEASURES = {
  A: {
    1: ['ran', 'manifests: assets.json, every file slot\'s file, every value slot\'s pointer, multiplayer.json'],
    2: ['ran', 'kit copies unedited and the core pinned: every vendored file (gf/godot, gf/three, gf/mp, gf/gf-assets.js, audio/, project/addons/gf) equals its kit source byte for byte; build/ was exported from project/ as it is, and game.js and game.wasm are the pinned template\'s bytes'],
    4: ['partial', 'every picture slot is read by the game through gf-assets (measure.mjs boot); not yet: a slot-ID pass that proves nothing on screen is drawn from outside a slot (Godot draws into its own canvas; the three.js pass reads object ids)'],
    8: ['ran', 'swap proof: a value slot changed live shows on screen; a picture slot replaced as Studio replaces it is the file the game draws (measure.mjs swap)'],
    18: ['ran', 'sounds listed: every GF.sound id in the project and every ctx.audio.play id in rules.js is in assets.json → sounds'],
    19: ['ran', 'bodies hold their shape: every picture slot passes the gf-flat-1 judge (body sheets, tiles, props); a 3D body passes the kit\'s rig check (gf-humanoid-1 bones, scale, skin, the shared clips through the retarget, the model judge)'],
  },
  B: {
    3: ['ran', 'boots to the menu and plays with no console error, page error or failed request, alone, alone with bots, with a panel open and with a friend; the native run of the export (alone, 120 frames) has no script error'],
    9: ['skip', 'contact sheet and frame cost: the capture tool drives three.js scenes; a Godot capture with frame times is not written'],
    20: ['partial', 'the kit\'s UI over the game: Play, Esc opens the pause menu and holds input; a panel (GF.panel: the kit\'s choice cards) covers the game, holds input and its answer reaches the game; the release check of every view is the shared kit\'s and was not run on godot'],
    22: ['skip', 'the wallet in the menu: the kit\'s own, unchanged here; not run on godot yet'],
    24: ['skip', 'plays inside a post on X: not tried with a Godot export'],
    31: ['skip', 'sharp on every screen: the canvas is Godot\'s (canvas_resize_policy 2, device pixels); not measured'],
    32: ['skip', 'the no-WebGL2 screen: written (boot.js unsupported) but not driven by a browser without WebGL2'],
  },
  C: {
    13: ['ran', 'controls work: D runs, Space jumps (seen from above: W walks north; 3D: W walks away from the camera and the body turns to it), nothing moves under the pause menu, and alone the bots hold still under it'],
    7: ['skip', 'audio gate: gf-audio plays every sound (GF.sound), so the kit\'s loudness gate applies unchanged, but it was not run on a Godot game'],
    10: ['skip', 'fair play: nothing in the starter knocks a player down'],
    15: ['skip', 'the loop is alive (a slot-ID sight pass): not built for godot'],
    16: ['skip', 'hits read: nothing is hit in the starter'],
    21: ['skip', 'the HUD shows your state: the kit\'s HUD, not run per release on godot'],
    38: ['skip', 'every event answered: GF events are in events() but the answered-on-screen check is the gf-three boot\'s'],
  },
  D: {
    6: ['ran', 'a round reaches the results and plays again (measure.mjs round); alone with bots, they take seats, move, and are in the results'],
    12: ['skip', 'scores come from counted events: events() logs scores and game events, but the one-to-one trace is not wired'],
  },
  E: {
    5: ['ran', 'two players: each draws the other where they are (to 0.15 m once still), in view, with their name; the host owns the round; the shared world agrees (measure.mjs live); --mp-gate adds the shared gate'],
    25: ['partial', 'playing with friends: names picked in the room, each player\'s own name on the other\'s screen, both reach the results; not yet: a rename in the waiting room, the phone lobby'],
    34: ['ran', 'watch then play and voice: Go live from the game\'s pause menu, a viewer tunes in and follows the streamer with no player of its own, draws the streamer where they are after a run, keeps the clock and scores, the name tag over the streamer, the count; the shared voice steps unchanged (a fake microphone: the viewer hears the streamer; only the page above may hand voice)'],
  },
  F: {
    14: ['ran', 'looks honoured: the look\'s background is the sky on screen (seen from above, where the field fills the view: look.view is the camera\'s view)'],
    17: ['ran', 'the world is complete: the map reads (gf-tilemap-1) and every ledge and mark is within a jump of a spawn (the same model the starter\'s physics follow)'],
    11: ['skip', 'set dressing: the stage is the map; no props are laid out from the spec'],
    35: ['ran', 'the game\'s own tests: tests/*.play.mjs, played with both players in the live leg (a game without any has nothing to run)'],
    39: ['skip', 'hits per kill: nothing is hit'],
  },
};

async function walk(dir, base = dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) await walk(p, base, out); else out.push(relative(base, p).split('\\').join('/'));
  }
  return out;
}

/** The pinned template's engine files, by sha256 (from the template zip, once). */
async function templateHashes() {
  const zip = join(toolchainDir(), TOOLCHAIN.template.file);
  if (!existsSync(zip)) return null;
  const { extract } = await import('./install.mjs');
  const b = await readFile(zip);
  return { 'game.js': sha(extract(b, 'godot.js')), 'game.wasm': sha(extract(b, 'godot.wasm')) };
}

export async function staticChecks(dir) {
  const checks = [];
  const check = (gate, measure, name, ok, detail) => { checks.push({ gate, measure, name, ok: !!ok, detail }); return !!ok; };
  // ---- A1 manifests ----
  const manifest = await read(join(dir, 'assets.json'));
  const docs = new Map(), missing = [], unresolved = [];
  for (const s of manifest.slots ?? []) {
    const f = s.source?.file;
    if (!f || !existsSync(join(dir, f))) { missing.push(`${s.id} → ${f}`); continue; }
    if (s.source.pointer !== undefined) {
      if (!docs.has(f)) docs.set(f, await read(join(dir, f)));
      if (getAt(docs.get(f), s.source.pointer) === undefined) unresolved.push(`${s.id} → ${f}${s.source.pointer}`);
    }
  }
  const { validateMultiplayer } = await import(pathToFileURL(join(SHARED.party, 'manifest.mjs')).href);
  const mp = validateMultiplayer(await read(join(dir, 'multiplayer.json')));
  check('A', 1, 'manifests', !missing.length && !unresolved.length && mp.ok, `${manifest.slots.length} slots; missing files: ${missing.length ? missing.join(', ') : 'none'}; unresolved pointers: ${unresolved.length ? unresolved.join(', ') : 'none'}; multiplayer.json ${mp.ok ? `valid (${(await read(join(dir, 'multiplayer.json'))).mode})` : mp.problems.join('; ')}`);
  // ---- A2 kit copies unedited (against the kit's sources, never a list inside the game) ----
  const edited = [], absent = [], extra = [];
  const want = new Set([...(await closure()), ...(await walk(SHARED.mp)).map(f => `gf/mp/${f}`), ...(await walk(SHARED.audio)).map(f => `audio/${f}`)]);
  for (const g of want) {
    const p = join(dir, g);
    if (!existsSync(p)) { absent.push(g); continue; }
    if (sha(await readFile(p)) !== sha(await readFile(sourceOf(g)))) edited.push(g);
  }
  for (const f of await walk(join(RUNTIME, 'addon'))) {
    const p = join(dir, 'project', 'addons', 'gf', f);
    if (!existsSync(p)) absent.push(`project/addons/gf/${f}`);
    else if (sha(await readFile(p)) !== sha(await readFile(join(RUNTIME, 'addon', f)))) edited.push(`project/addons/gf/${f}`);
  }
  for (const f of GODOT_NOTICES) {
    const p = join(dir, 'gf', 'godot', f);
    if (!existsSync(p)) absent.push(`gf/godot/${f}`);
    else if (sha(await readFile(p)) !== sha(await readFile(join(RUNTIME, 'toolchain', f)))) edited.push(`gf/godot/${f}`);
  }
  for (const g of (await walk(join(dir, 'gf'))).map(f => `gf/${f}`)) if (!want.has(g) && !['gf/godot/kit.js', 'gf/godot/LICENSES.md', 'gf/three/LICENSE', ...GODOT_NOTICES.map(f => `gf/godot/${f}`)].includes(g)) extra.push(g);
  check('A', 2, 'kit-copies-unedited', !edited.length && !absent.length && !extra.length, `${want.size} kit files and the addon checked against runtime godot ${VERSION} and the shared kit's sources; edited: ${edited.join(', ') || 'none'}; missing: ${absent.join(', ') || 'none'}; not the kit's: ${extra.join(', ') || 'none'}`);
  // ---- A18 sounds listed ----
  const listed = new Set(Object.keys(manifest.sounds?.sounds ?? {})), used = new Set();
  for (const f of (await walk(join(dir, 'project'))).filter(f => f.endsWith('.gd') && !f.startsWith('addons/'))) for (const m of (await readFile(join(dir, 'project', f), 'utf8')).matchAll(/GF\.sound\(\s*"([^"]+)"/g)) used.add(m[1]);
  if (existsSync(join(dir, 'rules.js'))) for (const m of (await readFile(join(dir, 'rules.js'), 'utf8')).matchAll(/audio\.play\(\s*['"]([^'"]+)['"](?![^)]*optional)/g)) used.add(m[1]);
  const unlisted = [...used].filter(id => !listed.has(id));
  check('A', 18, 'sounds-listed', !unlisted.length, `${used.size} sound ids played by the game (${[...used].join(', ') || 'none'}); unlisted: ${unlisted.join(', ') || 'none'}`);
  // ---- A19 every picture passes the gf-flat-1 judge ----
  const { judgeGame } = await import('./judge.mjs');
  const judged = (await judgeGame(dir)).pictures;
  const bad = judged.filter(j => !j.ok);
  // a 3D game's body: the kit's rig check (gf-humanoid-1 bones, scale, skin, the shared clips through the retarget)
  const models = (manifest.slots ?? []).filter(x => x.type === 'model' && x.constraints?.rig === 'gf-humanoid-1');
  for (const m of models) {
    const { rigCheck } = await import(pathToFileURL(join(SHARED.toolsLib, '..', 'rig-check.mjs')).href);
    const r = await rigCheck(join(dir, m.source.file)).catch(e => ({ ok: false, errors: [e.message] }));
    check('A', 19, 'bodies-pass-the-rig-check', r.ok, `${m.id} (${m.source.file}): ${r.ok ? 'a gf-humanoid-1 body' : r.errors.join('; ')}`);
  }
  check('A', 19, 'pictures-pass-the-judge', !bad.length && judged.length > 0, `${judged.length} pictures judged as gf-flat-1 (${judged.map(j => `${j.slot ?? j.file}`).join(', ')}); failing: ${bad.map(j => `${j.slot ?? j.file}: ${j.errors.map(e => e.rule).join(', ')}`).join('; ') || 'none'}`);
  // ---- B: the build is the project, and the engine is the pinned template ----
  const rec = existsSync(join(dir, 'build', 'godot-build.json')) ? await read(join(dir, 'build', 'godot-build.json')) : null;
  const now = await projectHash(join(dir, 'project'));
  const tpl = await templateHashes();
  const engineOk = rec && tpl && rec.files['game.js'].sha256 === tpl['game.js'] && rec.files['game.wasm'].sha256 === tpl['game.wasm'];
  const filesOk = rec && ['game.js', 'game.wasm', 'game.pck'].every(f => existsSync(join(dir, 'build', f)) && rec.files[f]);
  let onDisk = true;
  if (filesOk) for (const f of ['game.js', 'game.wasm', 'game.pck']) if (sha(await readFile(join(dir, 'build', f))) !== rec.files[f].sha256) onDisk = false;
  check('A', 2, 'the-build-is-the-project', rec && rec.project === now && engineOk && filesOk && onDisk, !rec ? 'no build/godot-build.json: export the game (tools/export.mjs)' : `build/ ${rec.project === now ? 'was exported from project/ as it is now' : 'is OLDER than project/: export again'}; game.js and game.wasm ${engineOk ? `are the pinned Godot ${TOOLCHAIN.version} template's` : 'are NOT the pinned template\'s bytes'}; the files on disk ${onDisk ? 'match the record' : 'differ from the record'}`);
  // ---- F17 the world is complete ----
  const world = await read(join(dir, 'config', 'world.json')), game = await read(join(dir, 'config', 'game.json'));
  const { readMap, reachOf, jumpReach } = await importShared('gf/three/flat/tilemap.js');
  const M = readMap(world.map);
  const { walkReach } = await import('../kit/world.js');
  const reach = !M.ok ? { problems: [] } : M.plane === 'top' ? walkReach(M) : reachOf(M, jumpReach({ gravity: 20, fallScale: 1.7, jump: game.controller?.jump ?? 10.5, speed: game.controller?.speed ?? 5.2 }));
  const tiles = Object.keys(M.kinds ?? {}).filter(k => !manifest.slots.some(s => s.id === `world.tiles.${k}`));
  check('F', 17, 'the-world-is-complete', M.ok && !reach.problems.length && !tiles.length, `the map (${M.cols}×${M.rows}, ${M.spawns.length} spawns, marks: ${Object.entries(M.marks).map(([k, v]) => `${k} ${v.length}`).join(', ') || 'none'}) ${M.ok ? 'reads' : `has problems: ${M.problems.join('; ')}`}; ${reach.problems.length ? reach.problems.join('; ') : (M.plane === 'top' ? 'every spawn and mark can be walked to' : 'every ledge and mark is within a jump of a spawn')}; kinds with no picture slot: ${tiles.join(', ') || 'none'}`);
  return checks;
}

const AREA = { A: 'art', B: 'code', C: 'feel', D: 'code', E: 'netcode', F: 'code' };
/** The gate a measure belongs to (a check counts in its measure's gate, whatever leg ran it). */
export const gateOfMeasure = n => Object.entries(MEASURES).find(([, list]) => Object.hasOwn(list, String(n)))?.[0] ?? null;

/**
 * Checks → the verdict's gates (builder/gates/verdict.schema.json): per gate what ran, passed, failed, and what was
 * skipped with why. A measure this runtime supplies that the run did not reach is skipped and required (the gate fails);
 * measure 35 with no tests/*.play.mjs in the game has nothing to run and is skipped, not required.
 */
export function judge(checks, { staticOnly = false, ownTests = true, only = null } = {}) {
  const gates = {};
  for (const [g, list] of Object.entries(MEASURES)) {
    if (only && g !== only) continue;
    const mine = checks.filter(c => Number.isInteger(c.measure) && gateOfMeasure(c.measure) === g);
    const ran = [...new Set(mine.map(c => c.measure))].sort((x, y) => x - y);
    const bad = ran.filter(n => mine.some(c => c.measure === n && !c.ok));
    const nothing = n => Number(n) === 35 && !ownTests && !staticOnly;
    const notRun = Object.entries(list).filter(([n, v]) => v[0] !== 'skip' && !ran.includes(Number(n)) && !nothing(n)).map(([n]) => ({ measure: Number(n), why: staticOnly ? 'a static run: the browser measures did not run' : 'not reached in this run', required: true }));
    const skipped = [...Object.entries(list).filter(([n, v]) => v[0] === 'skip' || nothing(n)).map(([n, v]) => ({ measure: Number(n), why: nothing(n) ? 'the game has no tests/*.play.mjs: nothing of its own to run' : v[1].slice(0, 300) })), ...notRun];
    gates[g] = { gate: g, ran, passed: ran.filter(n => !bad.includes(n)), skipped, failed: bad, ok: ran.length > 0 && !bad.length && !notRun.length };
  }
  return gates;
}

export async function verify(gameDir, { out = null, staticOnly = false, mpGate = false, legs = undefined, only = null, log = () => {} } = {}) {
  const t0 = Date.now(), dir = resolve(gameDir), o = resolve(out ?? join(dir, 'evidence', `verify-${new Date().toISOString().replace(/[:.]/g, '-')}`));
  await mkdir(o, { recursive: true });
  const checks = await staticChecks(dir);
  for (const c of checks) log(`${c.ok ? 'pass' : 'FAIL'} ${c.gate}${typeof c.measure === 'number' ? ` ${c.measure}` : ''} ${c.name}: ${c.detail}`);
  let measured = null, mp = null;
  if (!staticOnly) {
    measured = await measure(dir, { out: o, legs, log });
    const imageSlots = (await read(join(dir, 'assets.json'))).slots.filter(s => s.type === 'image').map(s => s.id);
    const unread = imageSlots.filter(id => !(measured.read ?? []).includes(id));
    checks.push({ gate: 'A', measure: 4, name: 'every-picture-slot-is-read', ok: !unread.length && !!measured.read, detail: `${imageSlots.length} picture slots; read by the game at boot: ${(measured.read ?? []).length}; never read: ${unread.join(', ') || 'none'} (the other half of measure 4, that nothing is drawn from outside a slot, is not proven on godot)` });
    const MEASURE_OF = { 'boots-to-the-menu': 3, 'observation-answers': 3, 'pictures-read-through-slots': 4, 'D-runs-right': 13, 'Space-jumps': 13, 'menu-holds-input': 13, 'esc-resumes': 20, 'no-console-errors': 3, 'look-background-honoured': 14, 'look-view-honoured': 14, 'W-walks-up': 13, 'W-walks-north': 13, 'bots-fill-the-seats': 6, 'bots-move': 6, 'bots-hold-under-the-menu': 13, 'bots-in-the-results': 6, 'no-console-errors-bots': 3, 'panel-covers-the-game': 20, 'phone-menu-fits': 3, 'phone-stick-moves': 13, 'phone-jump-button-jumps': 13, 'no-console-errors-phone': 3, 'phone-ran': 3, 'phone-hud-fits': 3, 'phone-controls-match': 13, 'phone-menu-fits-landscape': 3, 'phone-hud-fits-landscape': 3, 'phone-controls-match-landscape': 13, 'phone-stick-moves-landscape': 13, 'phone-jump-button-jumps-landscape': 13, 'no-console-errors-phone-landscape': 3, 'phone-ran-landscape': 3, 'firefox-boots': 3, 'firefox-D-runs-right': 13, 'no-console-errors-firefox': 3, 'webkit-boots': 3, 'webkit-D-runs-right': 13, 'no-console-errors-webkit': 3, 'panel-answer-reaches-the-game': 20, 'no-console-errors-panels': 3, 'round-reaches-results': 6, 'plays-again': 6, 'no-console-errors-round': 3, 'joiner-joins': 5, 'one-host': 5, 'each-draws-the-other-where-they-are': 5, 'each-sees-the-other-on-screen': 5, 'names-are-the-players-own': 25, 'name-tag-over-the-friend': 5, 'shared-world-agrees': 5, 'shared-clock-runs': 5, 'both-reach-the-results': 25, 'no-console-errors-live': 3, 'value-slot-shows-live': 8, 'picture-slot-replaced': 8, 'no-console-errors-swap': 3, ran: 3 };
    for (const c of measured.checks) { const m = MEASURE_OF[c.name] ?? (c.name.startsWith('own:') ? 35 : c.name.startsWith('watch: ') ? 34 : null); checks.push({ ...c, measure: m, gate: gateOfMeasure(m) ?? c.gate }); }
    if (mpGate) {
      const { gate } = await import(pathToFileURL(join(SHARED.party, 'gate.mjs')).href);
      mp = await gate(dir, { out: o, log });
      checks.push({ gate: 'E', measure: 5, name: 'shared-multiplayer-gate', ok: mp.verdict === 'pass', detail: `gf/mp's gate: ${mp.verdict} (${mp.checks?.filter(c => c.ok).length}/${mp.checks?.length} checks)` });
    }
  }
  // the verdict (builder/gates/verdict.schema.json): per gate what ran, passed, was skipped (with why) and failed; the
  // checks behind each measure are in checks.json beside it
  const gates = judge(checks, { staticOnly, only, ownTests: existsSync(join(dir, 'tests')) && (await readdir(join(dir, 'tests'))).some(f => f.endsWith('.play.mjs')) });
  const failed = Object.values(gates).flatMap(g => g.failed.map(n => ({ gate: g.gate, measure: n, area: AREA[g.gate], detail: checks.filter(c => c.measure === n && !c.ok).map(c => `${c.name}: ${c.detail}`).join(' | ').slice(0, 1000) })));
  const verdict = await verdictOf(dir, gates, failed, measured?.chrome ?? null);
  const detail = { runtime: { id: 'godot', version: VERSION, godot: TOOLCHAIN.version }, at: new Date().toISOString(), chrome: measured?.chrome ?? null, checks, shots: measured?.shots ?? [], live: measured?.live ?? null, swap: measured?.swap ?? null, read: measured?.read ?? null, phone: measured?.phone ?? null, browsers: measured?.browsers ?? null, notRun: measured?.notRun ?? [], mpGate: mp ? { verdict: mp.verdict } : null };
  await writeFile(join(o, 'checks.json'), JSON.stringify(detail, null, 2) + '\n');
  await writeFile(join(o, 'verdict.json'), JSON.stringify(verdict, null, 2) + '\n');
  // record.json: what the studio and the MCP tool read of a run (builder/lib/games.mjs latestVerdict), every measure's
  // checks flat ({n, gate, name, ok, detail}; a skipped measure ok null with why)
  const record = { runtime: 'godot', pass: verdict.pass, started: detail.at, seconds: Math.round((Date.now() - t0) / 1000), outDir: relative(dir, o).split(sep).join('/'), checks: flatChecks(checks, verdict) };
  await writeFile(join(o, 'record.json'), JSON.stringify(record, null, 2) + '\n');
  await scrubHardware(o);
  return { verdict, detail, record, out: o };
}

/** Every check flat, as the studio reads a run: {n, gate, name, ok, detail}; a skipped measure is ok null with why. */
export function flatChecks(checks, verdict) {
  const out = checks.map(c => ({ n: c.measure ?? null, gate: c.gate, name: c.name, ok: c.ok, detail: c.detail }));
  for (const g of Object.values(verdict.gates)) for (const x of g.skipped) out.push({ n: x.measure, gate: g.gate, name: 'skipped', ok: null, detail: x.why });
  return out;
}

/** Evidence names no person's hardware: a graphics card's model in any record (ANGLE's renderer string) becomes its
 *  maker's word and "GPU". The run's own facts (WebGL2, the GPU path, the browser's version) stay. */
export function scrubText(text) {
  return text.replace(/\b(NVIDIA|AMD|Intel)( Corporation)?, (NVIDIA |AMD |Intel\(R\) )?(GeForce|Radeon|Quadro|Arc|Iris|UHD|RTX|GTX)[^,/)"]*/g, (m, maker, corp) => `${maker}${corp ?? ''}, ${maker} GPU`);
}
export async function scrubHardware(dir) {
  for (const f of (await walk(dir)).filter(f => f.endsWith('.json'))) {
    // (and no machine's paths: a record's absolute paths inside this repository become relative to it)
    const p = join(dir, f), t = await readFile(p, 'utf8'), u = scrubText(t).split(REPO + sep).join('').split(REPO).join('.');
    if (u !== t) await writeFile(p, u);
  }
}

async function verdictOf(dir, gates, failed, chrome) {
  const specFile = join(dir, 'spec.json');
  return {
    verdictVersion: 1, game: dir.split(/[\\/]/).pop(), runtime: 'godot', profile: '2d', loop: (await read(join(dir, 'config', 'game.json'))).loop ?? 'round', run: 'build',
    ...(existsSync(specFile) ? { spec: sha(await readFile(specFile)) } : {}),
    environment: { browser: chrome ?? 'none (static)', api: 'webgl2' },
    gates, failed, pass: !failed.length && Object.values(gates).every(g => g.ok),
  };
}

/** The verdict again from a run's checks.json (the judging changed, the run did not): writes verdict.json beside it. */
export async function rejudge(out, gameDir) {
  const d = await read(join(out, 'checks.json')), dir = resolve(gameDir);
  for (const c of d.checks) if (Number.isInteger(c.measure)) c.gate = gateOfMeasure(c.measure) ?? c.gate;
  const gates = judge(d.checks, { staticOnly: false, ownTests: existsSync(join(dir, 'tests')) && (await readdir(join(dir, 'tests'))).some(f => f.endsWith('.play.mjs')) });
  const failed = Object.values(gates).flatMap(g => g.failed.map(n => ({ gate: g.gate, measure: n, area: AREA[g.gate], detail: d.checks.filter(c => c.measure === n && !c.ok).map(c => `${c.name}: ${c.detail}`).join(' | ').slice(0, 1000) })));
  const chrome = d.chrome ?? (existsSync(join(out, 'measures.json')) ? (await read(join(out, 'measures.json'))).chrome : existsSync(join(out, 'record.json')) ? (await read(join(out, 'record.json'))).chrome : null);
  const verdict = await verdictOf(dir, gates, failed, chrome);
  await writeFile(join(out, 'checks.json'), JSON.stringify(d, null, 2) + '\n');
  await writeFile(join(out, 'verdict.json'), JSON.stringify(verdict, null, 2) + '\n');
  return { verdict, out };
}

if (isMain(import.meta)) {
  const a = process.argv.slice(2), opt = k => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : null; };
  const dir = a.find((x, i) => !x.startsWith('--') && !['--out', '--rejudge', '--legs'].includes(a[i - 1]));
  if (!dir) { console.error('usage: verify.mjs <game-dir> [--out <dir>] [--static] [--mp-gate] [--json]\n       verify.mjs <game-dir> --rejudge <run-dir>   (the verdict again from that run\'s checks.json)'); process.exit(2); }
  const { LEGS, DEVICE_LEGS } = await import('./measure.mjs');
  const legs = opt('--legs') ? opt('--legs').split(',') : a.includes('--devices') ? [...LEGS, ...DEVICE_LEGS] : LEGS;
  const v = opt('--rejudge') ? await rejudge(resolve(opt('--rejudge')), dir) : await verify(dir, { out: opt('--out'), staticOnly: a.includes('--static'), mpGate: a.includes('--mp-gate'), legs, log: m => { if (!a.includes('--json')) console.log(m); } });
  if (a.includes('--json')) console.log(JSON.stringify(v.verdict, null, 2));
  else {
    for (const [g, r] of Object.entries(v.verdict.gates)) console.log(`gate ${g}: ${r.ok ? 'pass' : r.ran.length ? 'FAIL' : 'not run'}  ran ${r.ran.join(' ') || '-'}  passed ${r.passed.join(' ') || '-'}  failed ${r.failed.join(' ') || '-'}  skipped ${r.skipped.map(x => x.measure + (x.required ? '!' : '')).join(' ') || '-'}`);
    console.log(`${v.verdict.pass ? 'verified' : 'NOT verified'} → ${v.out}/verdict.json`);
  }
  process.exit(v.verdict.pass ? 0 : 1);
}
