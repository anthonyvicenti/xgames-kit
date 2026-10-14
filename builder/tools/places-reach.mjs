#!/usr/bin/env node
// Reach in a 3D world, PROVED BY DRIVING THE CHARACTER (open builder wave 10, track H; the places spike's drive.mjs;
// HANDOFF M4-H). The model (kit/world/reach.js, check 17's `reach` rule) says which spawns, zones and entries a body can
// get to and by which jumps. A model can be wrong, so this tool builds the world's physics exactly as its loader does
// (kit/world/colliders.js: one list, the loader's own materials) on the vendored Rapier, in Node, puts the kit's own
// capsule (kit/controller/capsule.mjs, the body every party and scenic player moves with) at each take-off the model's
// route needs, runs it at the landing and presses jump, and counts a jump made only when the body is on the landing,
// settled, for three steps in a row (BuildersGate's traversal.py rule, MIT, ideas only). For every place the model
// refuses it also tries the best way up the model found: the body should not make it either. The side-on part's
// counterpart is tools/flat-reach.mjs (a browser, the real keys).
//
//   node builder/tools/places-reach.mjs <game-dir | template[:size] | layout.json> [--title T] [--json] [--out f] [--model]
//   node builder/tools/places-reach.mjs --calibrate        the jump, the running jump and the highest step, measured
//   node builder/tools/places-reach.mjs --sweep [--titles N] [--out f]
//        every outdoor template of both 3D profiles (arena, backyard, plaza; island, isles, ruins) at every size, N titles each
//        (seeded as create seeds them): the model, every jump it needs driven, and check 17 beside it
//   --model   only the model's answer (no physics)
// A template is a party one (kit/world/templates) or a scenic one (island, isles, ruins, dungeon), laid out for --title
// (default "Places Reach") the way create lays it out. Exit 0: everything reachable and every needed jump made.
// 1: something is out of reach, or a needed jump was not made, or the body's jump is short of the model's. 2: a wrong call.
import { isMain } from './lib/main.mjs';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { VENDOR, KIT, kitPath } from './lib/paths.mjs';
import { propsCatalog } from '../art/views.mjs';
import { installKitImports, importLayer } from './lib/kit-import.mjs';
import { createCapsule, capsuleConfig } from '../../runtimes/three/kit/controller/capsule.mjs';
import { jumpReach } from '../../runtimes/three/profiles/flat-2d/tilemap.js';
import { hashString } from '../../runtimes/three/kit/core/rng.js';
import { loadWorldSubject, checkWorld } from './lib/world-check.mjs';
// kit modules whose imports cross layers: through the hook (kit-import.mjs importLayer)
const { collidersOf, buildColliders, MATERIALS } = await importLayer(kitPath(KIT, 'world/colliders.js'));
const { reachOf, movementOf } = await importLayer(kitPath(KIT, 'world/reach.js'));
const { generateLayout } = await importLayer(kitPath(KIT, 'world/generate.js'));

installKitImports();   // the scenic generator imports the shared kit as a game sees it (../../three/world/…)
export const SETTLE = 3;
const DT = 1 / 60, SIZES = ['small', 'medium', 'large'];
export const OUTDOOR = { 'standard-3d': ['arena', 'backyard', 'plaza'], 'scenic-3d': ['island', 'isles', 'ruins'] };
let RAPIER = null;
async function rapier() {
  if (RAPIER) return RAPIER;
  RAPIER = (await import(pathToFileURL(join(VENDOR.rapier, 'rapier.mjs')).href)).default;
  const warn = console.warn; console.warn = () => {}; await RAPIER.init(); console.warn = warn;
  return RAPIER;
}
const readJson = async f => JSON.parse(await readFile(f, 'utf8'));
const scenicGen = async () => import('../../runtimes/three/profiles/scenic-3d/kit/world/generate.js');

/** A game folder, a template (`arena`, `island:large`) or a layout file → {world, catalog, game, intent, profile, target}. */
export async function subjectOf(target, { title = 'Places Reach' } = {}) {
  const [id, size = 'small'] = String(target).split(':');
  const scenic = await scenicGen();
  if (!String(target).includes('/') && scenic.templates.includes(id)) {
    const world = scenic.generate({ template: id, size, seed: hashString(`${title}|world`) });
    await scenic.attachCatalog(world, {});
    const catalog = world.__catalog; delete world.__catalog;
    return { kind: 'layout', target, world, catalog, game: null, spec: null, intent: size, profile: 'scenic-3d' };
  }
  if (!String(target).includes('/') && existsSync(kitPath(KIT, 'world/templates', `${id}.json`))) {
    const recipe = await readJson(kitPath(KIT, 'world/templates', `${id}.json`));
    return { kind: 'layout', target, world: generateLayout(recipe, { size, seed: hashString(`${title}|world`) }), recipe, catalog: propsCatalog('three'), game: null, spec: null, intent: size, profile: 'standard-3d' };
  }
  const s = await loadWorldSubject(target);
  s.profile = Array.isArray(s.world?.levels) ? 'scenic-3d' : 'standard-3d';
  return s;
}

/** The world's physics as its loader builds it: the one collider list, the profile's own materials. */
export async function worldOf(layout, catalog, numbers) {
  const R = await rapier(), W = new R.World({ x: 0, y: -numbers.gravity, z: 0 }); W.timestep = DT;
  buildColliders(R, W, collidersOf(layout, catalog), Array.isArray(layout.levels) ? MATERIALS.scenic : MATERIALS.party);
  return W;
}
const FLAT = { size: [200, 200], bounds: { walls: false }, props: [] };

/** The kit's capsule with the game's numbers, standing with its feet at `feet` ([x, y, z]). */
async function capsuleAt(W, numbers, feet) {
  const R = await rapier();
  const cap = createCapsule(R, W, capsuleConfig({ move: { runSpeed: numbers.speed }, jump: { velocity: numbers.jump } }), { x: feet[0], y: feet[1] + 1.2, z: feet[2] });
  const feetY = () => cap.body.translation().y - cap.feetOffset;
  const tick = input => { cap.step(input); W.step(); cap.post(); };
  const place = p => { cap.reset({ x: p[0], y: p[1] + cap.feetOffset + 0.05, z: p[2] }); for (let i = 0; i < 40; i++) tick({}); };
  return { cap, tick, place, feetY, pos: () => { const t = cap.body.translation(); return [t.x, feetY(), t.z]; } };
}

/** What the body does on flat ground: one jump's rise, a running jump's length, the highest box it walks onto. */
export async function calibrate(numbers) {
  const out = {};
  { const W = await worldOf(FLAT, null, numbers), b = await capsuleAt(W, numbers, [0, 0, 0]); b.place([0, 0, 0]); const y0 = b.feetY(); let top = y0; b.tick({ jumpPresses: 1 }); for (let i = 0; i < 90; i++) { b.tick({}); top = Math.max(top, b.feetY()); } out.up = +(top - y0).toFixed(3); }
  {
    const W = await worldOf(FLAT, null, numbers), b = await capsuleAt(W, numbers, [0, 0, -20]); b.place([0, 0, -20]);
    for (let i = 0; i < 60; i++) b.tick({ x: 0, z: 1 });
    const z0 = b.pos()[2]; b.tick({ x: 0, z: 1, jumpPresses: 1 });
    let landed = null; for (let i = 0; i < 120 && landed === null; i++) { b.tick({ x: 0, z: 1 }); if (i > 5 && b.cap.state.onGround) landed = b.pos()[2]; }
    out.across0 = landed === null ? null : +(landed - z0).toFixed(3);
  }
  out.step = 0;
  const R = await rapier();
  for (let h = 0.05; h <= 0.8; h += 0.025) {
    const W = await worldOf(FLAT, null, numbers), body = W.createRigidBody(R.RigidBodyDesc.fixed());
    W.createCollider(R.ColliderDesc.cuboid(2, h / 2, 15).setTranslation(0, h / 2, 16), body);
    const b = await capsuleAt(W, numbers, [0, 0, -1]); b.place([0, 0, -1]);
    for (let i = 0; i < 90; i++) b.tick({ x: 0, z: 1 });
    const [, y, z] = b.pos();
    if (z > 1.2 && y > h - 0.08) out.step = +h.toFixed(3); else break;
  }
  return out;
}

const dist2 = (a, b) => Math.hypot(a[0] - b[0], a[2] - b[2]);
/** Drive one jump: start behind the take-off, run at the landing, press jump passing the take-off, steer on; a few
 *  run-ups. → { ok, tries, landed } */
export async function driveJump(W, numbers, jump) {
  const b = await capsuleAt(W, numbers, jump.from);
  const dir = [jump.to[0] - jump.from[0], jump.to[2] - jump.from[2]], len = Math.hypot(...dir) || 1, u = [dir[0] / len, dir[1] / len];
  const arrived = () => { const p = b.pos(); return b.cap.state.onGround && Math.abs(b.cap.state.vy) < 0.5 && Math.abs(p[1] - jump.to[1]) < 0.25 && dist2(p, jump.to) < 0.6; };
  let landed = null, tries = 0;
  for (const back of [0.6, 1.2, 0.3, 0, 2]) for (const lead of [0, 0.25, -0.25]) {
    tries++;
    const start = [jump.from[0] - u[0] * back, jump.from[1], jump.from[2] - u[1] * back];
    b.place(start);
    if (Math.abs(b.feetY() - jump.from[1]) > 0.3) continue;   // the run-up is not on the same floor
    let pressed = false, held = 0;
    for (let i = 0; i < 240; i++) {
      const p = b.pos(), along = (p[0] - start[0]) * u[0] + (p[2] - start[2]) * u[1];
      const toT = [jump.to[0] - p[0], jump.to[2] - p[2]], d = Math.hypot(...toT);
      const input = d > 0.15 ? { x: toT[0] / d, z: toT[1] / d } : {};
      if (!pressed && along >= back + lead) { input.jumpPresses = 1; pressed = true; }
      b.tick(input);
      held = arrived() ? held + 1 : 0;
      if (held >= SETTLE) return { ok: true, tries, landed: b.pos().map(v => +v.toFixed(2)) };
    }
    landed = b.pos().map(v => +v.toFixed(2));
  }
  return { ok: false, tries, landed };
}

/** The model's route for a subject, each jump it needs driven, and what it refuses tried. */
export async function prove(subject, { measure = true } = {}) {
  const layout = subject.world, numbers = movementOf(subject.game ?? {});
  const model = reachOf(layout, collidersOf(layout, subject.catalog), numbers), W = await worldOf(layout, subject.catalog, numbers);
  const drives = [];
  for (const j of model.jumps) drives.push({ ...j, ...(await driveJump(W, numbers, j)) });
  const tried = [];
  for (const p of model.problems) if (p.from) tried.push({ target: p.target, rise: p.rise, gap: p.gap, ...(await driveJump(W, numbers, { from: p.from, to: p.to })) });
  // the body's own jump against the physics the model is built on (more than 12% short: the model asks too much)
  const J = jumpReach({ gravity: numbers.gravity, jump: numbers.jump, fallScale: numbers.fallScale, speed: numbers.speed });
  const measured = measure ? await calibrate(numbers) : null;
  const short = !!measured && (measured.up < J.up * 0.88 || (measured.across0 != null && measured.across0 < J.across(0) * 0.88));
  return { ok: model.ok && drives.every(d => d.ok) && !short, model, drives, tried, agrees: tried.every(t => !t.ok), measured, physics: { up: +J.up.toFixed(3), across0: +J.across(0).toFixed(3) }, short };
}

/** Every outdoor template of both 3D profiles, every size, `titles` titles: the model, the driven jumps, check 17. */
export async function sweep({ titles = 20, log = () => {} } = {}) {
  const rows = {};
  for (const [profile, ids] of Object.entries(OUTDOOR)) for (const id of ids) for (const size of SIZES) {
    const row = rows[`${id}:${size}`] = { profile, titles, reachOk: 0, refused: {}, jumps: 0, made: 0, refusalsMade: 0, check17Ok: 0, check17Warnings: {} };
    for (let k = 0; k < titles; k++) {
      const s = await subjectOf(`${id}:${size}`, { title: `Sweep ${k}` });
      s.game = { mechanics: [{ id: 'waves' }] };   // a game with enemies at the gates, so the entries rule runs
      const r = await prove(s, { measure: false });
      if (r.model.ok) row.reachOk++;
      for (const p of r.model.problems) row.refused[p.target] = (row.refused[p.target] ?? 0) + 1;
      row.jumps += r.drives.length; row.made += r.drives.filter(d => d.ok).length; row.refusalsMade += r.tried.filter(t => t.ok).length;
      const c = checkWorld(s);
      if (c.ok) row.check17Ok++;
      for (const p of c.problems.filter(p => p.severity === 'warning' && p.rule === 'reach')) row.check17Warnings[p.rule] = (row.check17Warnings[p.rule] ?? 0) + 1;
    }
    log(`${`${id}:${size}`.padEnd(16)} reach ${row.reachOk}/${titles}${Object.keys(row.refused).length ? ` (refused: ${Object.entries(row.refused).map(([t, n]) => `${t} ${n}`).join(', ')})` : ''} · jumps driven ${row.made}/${row.jumps}${row.refusalsMade ? ` · ${row.refusalsMade} refusals the capsule made anyway` : ''} · check 17 ok ${row.check17Ok}/${titles}${row.check17Warnings.reach ? `, reach warnings ${row.check17Warnings.reach}` : ''}`);
  }
  return rows;
}

if (isMain(import.meta)) {
  const args = process.argv.slice(2), val = k => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
  const asJson = args.includes('--json'), out = val('--out');
  const save = async v => { if (out) await writeFile(resolve(out), `${JSON.stringify(v, null, 1)}\n`); if (asJson) console.log(JSON.stringify(v, null, 1)); };
  if (args.includes('--calibrate')) {
    const numbers = movementOf({}), m = await calibrate(numbers), J = jumpReach({ gravity: numbers.gravity, jump: numbers.jump, fallScale: numbers.fallScale, speed: numbers.speed });
    await save({ numbers, measured: m, physics: { up: J.up, across0: J.across(0) } });
    if (!asJson) console.log(`the kit's capsule (jump ${numbers.jump}, gravity ${numbers.gravity}, speed ${numbers.speed}): one jump rises ${m.up} m (the physics says ${J.up.toFixed(2)}), a running jump carries ${m.across0} m (${J.across(0).toFixed(2)}), it walks onto a box ${m.step} m high`);
    process.exit(0);
  }
  if (args.includes('--sweep')) {
    const rows = await sweep({ titles: Number(val('--titles') ?? 20), log: asJson ? () => {} : m => console.log(m) });
    await save({ schema: 'gf-three-places-reach-sweep/1', at: new Date().toISOString(), numbers: movementOf({}), rows });
    process.exit(Object.values(rows).every(r => r.reachOk === r.titles && r.made === r.jumps) ? 0 : 1);
  }
  const target = args[0] && !args[0].startsWith('--') ? args[0] : null;
  if (!target) { console.error('usage: places-reach.mjs <game-dir | template[:size] | layout.json> [--title T] [--json] [--out file.json] [--model] | --calibrate | --sweep [--titles N]'); process.exit(2); }
  let s;
  try { s = await subjectOf(existsSync(target) ? resolve(target) : target, { title: val('--title') ?? 'Places Reach' }); } catch (e) { console.error(e.message); process.exit(2); }
  if (args.includes('--model')) {
    const r = reachOf(s.world, collidersOf(s.world, s.catalog), movementOf(s.game ?? {}));
    await save({ ok: r.ok, numbers: r.numbers, stats: r.stats, jumps: r.jumps, problems: r.problems });
    if (!asJson) console.log(`a jump rises ${r.numbers.up} m and crosses ${r.numbers.across} m (${Math.round(r.numbers.margin * 100)}% of what the physics gives); ${r.stats.targets} places to get to, ${r.jumps.length} jumps on the way\n${r.problems.map(p => `out of reach: ${p.message}`).join('\n') || 'everything is in reach'}`);
    process.exit(r.ok ? 0 : 1);
  }
  const r = await prove(s);
  await save({ ok: r.ok, problems: r.model.problems.map(p => p.message), numbers: r.model.numbers, stats: r.model.stats, measured: r.measured, physics: r.physics, drives: r.drives, tried: r.tried, agrees: r.agrees });
  if (!asJson) {
    for (const d of r.drives) console.log(`${d.ok ? 'made  ' : 'MISSED'} ${d.for}: rise ${d.rise} m, gap ${d.gap} m (${d.tries} tries)${d.ok ? '' : `; came to rest at ${d.landed}`}`);
    for (const p of r.model.problems) console.log(`out of reach: ${p.message}`);
    for (const t of r.tried) console.log(`${t.ok ? 'MADE (the model is too strict)' : 'and the body did not make it either'}: ${t.target}, rise ${t.rise} m over ${t.gap} m (${t.tries} tries; came to rest at ${t.landed})`);
    console.log(`${r.ok ? 'PASS' : 'FAIL'}: ${r.drives.filter(d => d.ok).length} of ${r.drives.length} needed jumps made by the kit's capsule; ${r.model.problems.length} places out of reach${r.short ? `; the body's jump (${r.measured.up} m up, ${r.measured.across0} m across) is more than 12% short of the physics (${r.physics.up}, ${r.physics.across0})` : ''}`);
  }
  process.exit(r.ok ? 0 : 1);
}
