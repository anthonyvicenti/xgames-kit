// The registry: the manifests build a catalog with no problems, the catalog matches its schema and the file on disk,
// and every answer (can, which, checkSpec, the loop's registry calls) comes from the manifests' data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildCatalog, can, which, checkSpec, compat, createRegistry, crossProblems, conflictsOf } from '../registry/build-catalog.mjs';
import { loadSchemas, SCHEMA, ROOT } from '../registry/schemas.mjs';

const catalog = await buildCatalog();
const { validate } = await loadSchemas();
const json = async f => JSON.parse(await readFile(join(ROOT, f), 'utf8'));
const ids = list => list.map(x => x.id).sort();
const spec = async name => json(`builder/spec/examples/game-spec.v2/${name}`);

test('the manifests build a catalog with no problems, valid against its schema', () => {
  assert.deepEqual(catalog.problems, []);
  assert.deepEqual(validate(SCHEMA.catalog, catalog), []);
});

test('registry/catalog.json is the catalog the manifests build today (rebuild it: node registry/build-catalog.mjs)', async () => {
  const onDisk = await json('registry/catalog.json');
  assert.equal(onDisk.inputs.sha256, catalog.inputs.sha256);
});

test('today\'s registry: four runtimes, seven loops, the 18 mechanics, eight kinds', () => {
  assert.deepEqual(ids(catalog.runtimes), ['forge', 'godot', 'three', 'vista']);
  assert.deepEqual(ids(catalog.loops), ['endless', 'match', 'round', 'run', 'saved', 'turns', 'world']);
  assert.equal(catalog.mechanics.length, 18);
  assert.deepEqual(ids(catalog.kinds), ['blocky', 'calm', 'dark', 'drawn', 'lofi', 'pixel', 'scenic', 'silly']);
  const rt = id => catalog.runtimes.find(r => r.id === id);
  assert.deepEqual(ids(rt('three').profiles), ['flat-2d', 'scenic-3d', 'standard-3d']);
  assert.equal(rt('forge').state.open, true, 'forge is open (creator, 2026-10-13)');
  assert.equal(rt('vista').state.open, true, 'vista is open (creator, 2026-10-13)');
  assert.deepEqual([rt('godot').state.exists, rt('godot').state.open], [true, true]);
  assert.equal(catalog.loops.find(l => l.id === 'saved').state.exists, false);
});

test('every open runtime names a build measure for each of the six gates, and says why for each skip', () => {
  for (const rt of catalog.runtimes.filter(r => r.state.open)) {
    for (const g of ['A', 'B', 'C', 'D', 'E', 'F']) assert.ok(rt.measures.build[g]?.length, `${rt.id} gate ${g}`);
    for (const s of rt.measures.skipped ?? []) assert.ok(s.why.length > 10, `${rt.id} skip ${s.measure} says why`);
  }
});

test('the matrix is a view of the kinds\' data, never a folder', () => {
  const cell = (row, kind) => catalog.matrix.cells[row][kind].cell;
  assert.equal(cell('vista', 'calm'), 'proven');
  assert.equal(cell('forge', 'dark'), 'proven');
  assert.equal(cell('three/standard-3d', 'silly'), 'proven');
  assert.equal(cell('forge', 'calm'), 'empty');
  assert.ok(catalog.matrix.rows.some(r => r.key === 'godot/2d' && r.open === true));
});

test('can calm run on forge? unproven but allowed: the game builds the look; on vista it is proven', () => {
  const a = can(catalog, { kind: 'calm', runtime: 'forge' });
  assert.equal(a.answer, 'unproven');
  assert.match(a.why[0], /Allowed/);
  assert.equal(can(catalog, { kind: 'calm', runtime: 'vista' }).answer, 'proven');
  assert.equal(can(catalog, { kind: 'pixel', runtime: 'three', profile: 'flat-2d' }).answer, 'proven');
  assert.equal(can(catalog, { kind: 'pixel', runtime: 'godot', profile: '2d' }).answer, 'proven');
  assert.equal(can(catalog, { kind: 'cozy', runtime: 'three' }).answer, 'unknown');
});

test('which runtimes meet devices=phone, camera=first? three standard-3d and forge; vista is ruled out by the phone', () => {
  const a = which(catalog, { devices: ['phone'], camera: 'first' });
  const meets = a.meets.map(m => (m.profile ? `${m.runtime}/${m.profile}` : m.runtime)).sort();
  assert.deepEqual(meets, ['forge', 'three/standard-3d']);
  const vista = a.ruledOut.find(m => m.runtime === 'vista');
  assert.equal(vista.misses[0].limit, 'devices');
  assert.ok(!a.meets.some(m => m.runtime === 'godot'), 'godot has no first-person camera, so it is ruled out by its limits');
});

test('a capability a runtime lacks never rules it out: it is a build item', () => {
  const a = which(catalog, { devices: ['phone'], camera: 'first', needs: ['grappling-hook'] });
  assert.ok(a.meets.find(m => m.runtime === 'forge').lacks.includes('grappling-hook'));
  const b = which(catalog, { graphics: 'photoreal', needs: ['boats', 'fishing'] });
  assert.deepEqual(b.meets.map(m => m.runtime), ['vista']);
  assert.deepEqual(b.meets[0].lacks, []);
});

test('the example specs check clean; findings say what is emulated', async () => {
  for (const f of ['valid-party-dodgeball.json', 'valid-forge-street.json', 'valid-flat-board.json']) {
    const r = checkSpec(catalog, await spec(f));
    assert.deepEqual(r.problems, [], f);
  }
  const r = checkSpec(catalog, await spec('valid-party-dodgeball.json'));
  assert.ok(r.findings.some(f => /x-post on three\/standard-3d: emulated/.test(f)));
});

test('checkSpec holds a spec to the manifests: hard limits are problems, what the game builds is a finding', async () => {
  const base = await spec('valid-forge-street.json');
  const with_ = patch => checkSpec(catalog, { ...structuredClone(base), ...patch });
  assert.match(with_({ runtime: 'vista', world: { template: 'islands' }, tables: {} }).problems.join('\n'), /does not run on phone/);
  assert.match(with_({ camera: 'follow' }).problems.join('\n'), /no "follow" rig/);
  assert.match(with_({ mechanics: [{ id: 'projectile' }] }).problems.join('\n'), /projectile does not run on forge: take it out and add a build item/);
  assert.match(with_({ kind: 'calm' }).problems.join('\n'), /build item with kind "calm"/);
  const proven = with_({ kind: 'calm', build: [...base.build, { what: 'a calm sea light on the street', how: 'an engine override of the forge look that adds a golden-hour preset', where: 'engine', kind: 'calm' }] });
  assert.deepEqual(proven.problems, []);
  assert.ok(proven.findings.some(f => /calm is proven on forge by this game/.test(f)));
  assert.match(with_({ loop: 'turns' }).problems.join('\n'), /turns is not open on forge/);
  assert.match(with_({ profile: 'standard-3d' }).problems.join('\n'), /forge has no profiles/);
  assert.match(with_({ src: [{ path: 'src/x.js', for: ['build.9'] }] }).problems.join('\n'), /"build.9" is not a build item/);
  assert.match(with_({ overrides: [{ file: 'gf/forge/wasm/core.wasm', why: 'x', for: ['build.1'] }] }).problems.join('\n'), /never overridable/);
  assert.match(with_({ kind: 'cozy' }).problems.join('\n'), /"cozy" is not a kind/);
});

test('mechanics on three: params by their own schema, needs, and unshared claims', async () => {
  const base = await spec('valid-party-dodgeball.json');
  const with_ = mechanics => checkSpec(catalog, { ...structuredClone(base), mechanics }).problems.join('\n');
  assert.match(with_([{ id: 'projectile', params: { speed: 999 } }]), /mechanics\[0\]\.params\/speed/);
  assert.match(with_([{ id: 'melee' }, { id: 'carry' }]), /both claim player\.socket\.hand_r/);
  assert.match(with_([{ id: 'build' }]), /build needs the voxel world/);
  assert.equal(with_([{ id: 'projectile' }, { id: 'health' }]), '');
});

test('conflicts are derived from owned resources, never written by hand', () => {
  const pairs = catalog.conflicts.map(c => `${c.a}+${c.b}:${c.res}`);
  assert.ok(pairs.includes('carry+melee:player.socket.hand_r') || pairs.includes('melee+carry:player.socket.hand_r'));
  assert.ok(pairs.some(p => /build/.test(p) && /melee/.test(p) && /input\.primary/.test(p)));
  assert.deepEqual(conflictsOf([{ id: 'a', owns: [{ res: 'input.interact', shared: true }] }, { id: 'b', owns: [{ res: 'input.interact', shared: true }] }]), []);
});

test('cross-manifest problems are reported: a kind keyed by a profile name, a mechanic on a runtime that does not exist', () => {
  const kinds = [{ id: 'x', look: { flat: { preset: 'pixel-day' } }, runtimes: {}, state: {} }];
  const mechanics = [{ id: 'm', impl: { nowhere: { path: 'x', state: {} } }, owns: [] }];
  const p = crossProblems({ runtimes: catalog.runtimes, loops: catalog.loops, mechanics, kinds, capabilities: null });
  assert.ok(p.some(x => /kinds\/x: "flat" is not a runtime/.test(x)));
  assert.ok(p.some(x => /components\/m: impl on "nowhere"/.test(x)));
});

test('the registry object the loop library calls: every call, answered from the catalog', async () => {
  const r = createRegistry(catalog);
  for (const k of ['runtimes', 'compat', 'loops', 'kinds', 'mechanics', 'capabilities', 'vocabulary', 'manifest']) assert.equal(typeof r[k], 'function', k);
  const rts = await r.runtimes();
  assert.deepEqual(rts.find(x => x.id === 'three').profiles.map(p => p.id).sort(), ['flat-2d', 'scenic-3d', 'standard-3d']);
  assert.deepEqual(rts.find(x => x.id === 'forge').profiles.map(p => p.id), [null]);
  const c = await r.compat({ devices: ['phone'], camera: 'first' });
  assert.equal(c.ok, true);
  assert.equal(c.runtimes['godot/2d'].open, true);
  assert.equal(c.runtimes['godot/2d'].fits, false); // ruled out by its camera, never by being closed
  assert.deepEqual(c.runtimes.forge.misses, []);
  assert.equal(c.runtimes.vista.fits, false);
  const loops = await r.loops();
  assert.equal(new Set(loops.map(l => l.acts)).size, loops.length, 'one loop per acts word');
  assert.deepEqual((await r.kinds()).find(k => k.id === 'pixel').proven, ['three/flat-2d', 'godot/2d']);
  const m = await r.manifest('runtime', 'vista');
  assert.ok(m.gates.C.skips.some(s => /^16 /.test(s)), 'vista skips 16 (nothing is hit)');
  assert.ok(!m.gates.C.skips.some(s => /^38 /.test(s)), 'vista runs 38 since the runtimes stream');
  assert.ok((await r.manifest('mechanic', 'waves')).traps.length);
  assert.equal(await r.manifest('runtime', 'three/no-such'), null);
  const v = await r.vocabulary();
  assert.ok(v.cameras.includes('first') && v.devices.includes('x-post') && v.graphics.includes('photoreal'));
});

test('compat answers a spec, a ledger and plain limits in one shape', async () => {
  const forgeSpec = await spec('valid-forge-street.json');
  const a = compat(catalog, forgeSpec);
  assert.deepEqual([a.ok, a.problems], [true, []]);
  assert.equal(a.runtimes.forge.fits, true);
  assert.equal(a.runtimes.vista.fits, false);
  const bad = compat(catalog, { ...forgeSpec, camera: 'follow' });
  assert.equal(bad.ok, false);
  const ledger = await json('builder/loop/examples/ledger/valid-hook-foundation.json');
  const b = compat(catalog, ledger);
  assert.equal(b.ok, true);
  assert.ok(b.runtimes.forge.lacks.includes('grappling-hook'));
  assert.ok(b.findings.some(f => /forge has no grappling-hook/.test(f)));
  const c = compat(catalog, { devices: ['phone'], graphics: 'photoreal' });
  assert.equal(c.ok, false);
  assert.match(c.problems[0], /no open runtime meets every hard limit/);
  const d = compat(catalog, { schema: 'gf-ledger/1', rows: [{ id: 'x', about: 'action', what: 'x', home: 'exists', by: 'mechanic:jetpack' }] });
  assert.ok(d.problems.some(p => /no mechanic "jetpack"/.test(p)));
});

// The loop library's own checks run on this registry once it is in builder/loop (the core-loop stream).
const LOOP = join(ROOT, 'builder/loop');
test('the loop library accepts this registry and chooses a foundation from it', { skip: !existsSync(join(LOOP, 'foundation.mjs')) && 'the loop library (builder/loop/foundation.mjs) is not here yet' }, async () => {
  const { checkRegistry } = await import(pathToFileURL(join(LOOP, 'registry.mjs')));
  const { chooseFoundation } = await import(pathToFileURL(join(LOOP, 'foundation.mjs')));
  const registry = checkRegistry(createRegistry(catalog));
  const ledger = await json('builder/loop/examples/ledger/valid-hook-foundation.json');
  const f = await chooseFoundation(ledger, registry);
  assert.equal(f.runtime, 'forge', JSON.stringify(f.problems ?? f));
  assert.equal(f.kind, 'dark');
  assert.ok(f.builds.some(b => b.capability === 'grappling-hook'));
});
