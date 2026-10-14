// Spec v2 everywhere (the creator, 2026-10-13: no backwards compatibility): a spec says runtime, profile, loop and
// kind; an older spec is refused with what to do; create, the catalog and verify's verdict resolve by runtime and
// profile, never by an engine; the examples are spec v2 and hold to the registry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { create } from '../builder/tools/create.mjs';
import { checkSpecV2, versionProblems, lookOf, readCatalog, planeOf } from '../builder/tools/lib/spec.mjs';
import { placeOf, rowOf, isScenic, isFlat, coreDrawn, rendererFor, placeOfGame, REPO } from '../builder/tools/lib/paths.mjs';
import { verdictOf } from '../builder/tools/lib/verdict.mjs';
import { catalogLines, registry } from '../builder/lib/catalog.mjs';
import { listExamples } from '../builder/lib/examples.mjs';
import { EXAMPLE_SETS } from '../builder/lib/paths.mjs';
import { loadSchemas, SCHEMA } from '../registry/schemas.mjs';
import { tempDir } from './helpers.mjs';

const json = async f => JSON.parse(await readFile(f, 'utf8'));
const example = id => json(path.join(REPO, 'examples/minimal', id, 'spec.json'));

test('an older spec is refused with what to do: no reading, no upgrade', async () => {
  const v1 = { specVersion: 0, engine: 'party', title: 'Old', hook: 'old', players: { min: 1, max: 4 } };
  const [p] = versionProblems(v1);
  assert.match(p, /not a spec v2 \(specVersion 0, engine "party"\)/);
  assert.match(p, /"runtime", "profile" .*"loop" and "kind" in place of "engine"/);
  assert.match(p, /Nothing upgrades an older spec: write it again as v2/);
  // a v2 marker with an engine beside it is still not a spec v2
  assert.equal(versionProblems({ ...(await example('soak-squad')), engine: 'party' }).length, 1);
  assert.deepEqual(versionProblems(await example('soak-squad')), []);
  // create refuses it before anything is written (exit code 2)
  const tmp = await tempDir();
  try {
    const file = path.join(tmp.dir, 'spec.json');
    await (await import('node:fs/promises')).writeFile(file, JSON.stringify(v1));
    const r = await create(file, path.join(tmp.dir, 'game'));
    assert.equal(r.ok, false); assert.equal(r.code, 2);
    assert.match(r.problems[0], /not a spec v2/);
    assert.ok(!existsSync(path.join(tmp.dir, 'game')), 'nothing written');
  } finally { await tmp.cleanup(); }
});

test('every example is a spec v2 that holds to the schema and the registry, tagged runtime, loop and kind', async () => {
  const list = await listExamples(EXAMPLE_SETS);
  assert.ok(list.length >= 5, `${list.length} examples`);
  for (const e of list) {
    const spec = await json(path.join(e.dir, 'spec.json'));
    const r = await checkSpecV2(spec);
    assert.deepEqual(r.problems, [], e.id);
    assert.ok(e.runtime && e.loop && e.kind, `${e.id} is tagged`);
    const meta = await json(path.join(e.dir, 'example.json'));
    assert.ok(!('engine' in meta) && !('closed' in meta), `${e.id}: example.json says no engine and closes nothing`);
  }
});

test('the schema and the registry hold a spec: a hard limit is a problem, what the game builds is a finding', async () => {
  const base = await example('soak-squad');
  const bad = await checkSpecV2({ ...base, camera: 'side' });
  assert.match(bad.problems.join('\n'), /no "side" rig/);
  const vistaPhone = await checkSpecV2({ ...(await example('lantern-cove')), devices: { targets: ['phone'] } });
  assert.match(vistaPhone.problems.join('\n'), /does not run on phone/);
  const noProfile = await checkSpecV2({ ...base, profile: undefined });
  assert.match(noProfile.problems.join('\n'), /three needs one of/);
  const solo = await checkSpecV2({ ...base, multiplayer: { mode: 'solo', together: 'versus' } });
  assert.ok(solo.problems.length, 'solo needs a why (and one player)');
});

test('where a game runs resolves by runtime and profile: place, row, renderer', async () => {
  const p = placeOf(await example('isle-run'));
  assert.deepEqual(p, { runtime: 'three', profile: 'scenic-3d' });
  assert.equal(rowOf(p), 'three/scenic-3d');
  assert.equal(rowOf({ runtime: 'vista', profile: null }), 'vista');
  assert.equal(isScenic(p), true);
  assert.equal(isFlat(placeOf(await example('coin-hop'))), true);
  assert.equal(coreDrawn({ runtime: 'forge' }), true);
  assert.equal(rendererFor({ runtime: 'three', profile: 'standard-3d' }).gpu, 'webgl');
  assert.equal(rendererFor({ runtime: 'three', profile: 'flat-2d' }).gpu, 'webgl');
  assert.deepEqual([rendererFor(p).gpu, rendererFor(p).withoutWebgpu], ['webgpu', 'webgl']);
  assert.deepEqual([rendererFor({ runtime: 'vista' }).gpu, rendererFor({ runtime: 'vista' }).withoutWebgpu], ['webgpu', 'error']);
  assert.equal(planeOf({ camera: 'side' }), 'side');
  assert.equal(planeOf({ camera: 'top' }), 'top');
});

test('what a spec leaves to its kind: the kind\'s look on the runtime, else the runtime\'s first look for the profile', async () => {
  const catalog = await readCatalog();
  const base = await example('soak-squad');
  const { look, ...noLook } = base;
  assert.deepEqual([lookOf(noLook, catalog).preset, lookOf(noLook, catalog).time], ['jelly-pastel', 'day']);
  assert.match(lookOf(noLook, catalog).from, /kind silly/);
  assert.equal(lookOf({ ...noLook, look: { preset: 'toon-lowpoly' } }, catalog).preset, 'toon-lowpoly');
  // a kind with no look on this profile: the profile's first look, and the game builds the kind's
  const scenicSilly = lookOf({ ...noLook, profile: 'scenic-3d' }, catalog);
  assert.match(scenicSilly.from, /has no look here: the game builds it/);
  assert.ok(catalog.runtimes.find(r => r.id === 'three').looks.some(l => l.id === scenicSilly.preset && l.profiles.includes('scenic-3d')));
});

test('create writes the runtime and profile into the game: record, kit.js, page and boot', async () => {
  const tmp = await tempDir();
  try {
    for (const [id, runtime, profile, boot, three] of [
      ['soak-squad', 'three', 'standard-3d', 'boot.js', 'three.module.js'],
      ['isle-run', 'three', 'scenic-3d', 'boot.js', 'three.webgpu.js'],
      ['coin-hop', 'three', 'flat-2d', 'boot.js', 'three.module.js'],
      ['lantern-cove', 'vista', null, 'boot-vista.js', null],
    ]) {
      const dir = path.join(tmp.dir, id);
      const r = await create(path.join(REPO, 'examples/minimal', id, 'spec.json'), dir);
      assert.equal(r.ok, true, `${id}: ${(r.problems ?? []).join('; ')}`);
      const rec = await json(path.join(dir, 'gf-three.json'));
      assert.deepEqual([rec.kit.runtime, rec.kit.profile ?? null], [runtime, profile], id);
      assert.equal(rec.kit.engine, undefined, `${id}: no engine in the record`);
      assert.ok(rec.loop && rec.kind && rec.look?.preset, `${id}: loop, kind and the look made`);
      assert.deepEqual(await placeOfGame(dir), { runtime, profile }, id);
      const kitJs = await readFile(path.join(dir, 'gf/three/kit.js'), 'utf8');
      assert.match(kitJs, new RegExp(`"runtime": "${runtime}"`));
      assert.doesNotMatch(kitJs, /"engine":/);
      assert.match(await readFile(path.join(dir, 'main.js'), 'utf8'), new RegExp(`core/${boot}`));
      const html = await readFile(path.join(dir, 'index.html'), 'utf8');
      if (three) assert.ok(html.includes(three), `${id}: ${three} in the import map`);
      // the registry's manifests are the catalog's, never a game's
      assert.ok(!existsSync(path.join(dir, 'gf/three/loops/round/loop.json')), `${id}: no loop manifest vendored`);
    }
    const flat = await json(path.join(tmp.dir, 'coin-hop', 'config/world.json'));
    assert.equal(flat.plane, 'side', 'the flat plane follows the camera');
  } finally { await tmp.cleanup(); }
});

test('the catalog reads the registry: runtimes by row with their state, kinds, the matrix', async () => {
  const reg = await registry();
  assert.equal(reg.catalogVersion, 1);
  const lines = catalogLines(reg, ['runtimes', 'kinds', 'matrix']).join('\n');
  for (const row of ['three/standard-3d', 'three/scenic-3d', 'three/flat-2d', 'forge', 'vista']) assert.match(lines, new RegExp(`\\n?\\s+${row.replace('/', '\\/')}\\s+\\[open\\]`));
  assert.match(lines, /godot\/2d\s+\[open\]/);
  assert.match(lines, /RUNTIME x KIND/);
  assert.match(lines, /calm\s/);
});

test('every implementation a manifest names is a file of this repository', async () => {
  const reg = await registry();
  const paths = [...reg.mechanics, ...reg.loops].flatMap(x => Object.values(x.impl ?? {}).map(i => i.path)).filter(Boolean);
  assert.ok(paths.length > 20);
  for (const p of paths) assert.ok(existsSync(path.join(REPO, p)), p);
});

test('verify\'s verdict: per gate ran, passed and skipped (with why), the runtime\'s own skips listed, valid against the schema', async () => {
  const { validate } = await loadSchemas();
  const rec = {
    game: 'x', place: { runtime: 'vista', profile: null }, specLoop: 'round', loop: { casts: 1 }, specSha: 'a'.repeat(64), release: false, pass: false, seconds: 12, renderer: 'webgpu', chrome: 'Chrome 141',
    required: [1, 2, 3, 13],
    checks: [{ n: 1, ok: true, name: 'manifests' }, { n: 2, ok: true }, { n: 3, ok: false, name: 'boots', detail: 'a console error', rule: 'r', fix: 'f' },
      { n: 4, ok: null, notYet: 'the core is not slots yet' }, { n: 23, ok: false, name: 'likeness', detail: 'too dark' }],
  };
  const v = verdictOf(rec, { skips: [{ measure: 38, why: 'no event log on vista yet' }] });
  assert.deepEqual(validate(SCHEMA.verdict, v), []);
  assert.deepEqual([v.runtime, v.loop, v.run, v.pass], ['vista', 'round', 'build', false], 'the spec\'s loop, never a runtime\'s own record of the same name');
  assert.deepEqual(v.gates.A.ran, [1, 2]);
  assert.deepEqual(v.gates.A.skipped, [{ measure: 4, why: 'the core is not slots yet' }]);
  assert.equal(v.gates.B.ok, false);
  assert.deepEqual(v.failed.map(f => `${f.gate}${f.measure}`), ['B3']);
  assert.equal(v.gates.C.skipped.find(s => s.measure === 13).required, true, 'a required measure that did not run is a required skip');
  assert.equal(v.gates.C.ok, false);
  assert.ok(v.gates.C.skipped.some(s => s.measure === 38 && /event log/.test(s.why)), 'the runtime\'s own skip is named');
  assert.equal(v.judges[0].measure, 23, 'a judge is advice, never a failed gate');
});

test('no engine is read by the builder\'s tools, the CLI or the three runtime\'s boot', async () => {
  const roots = ['builder/tools', 'builder/lib', 'builder/commands', 'bin', 'registry', 'components', 'loops', 'worlds', 'runtimes/three/profiles/flat-2d'];
  const files = ['runtimes/three/kit/core/boot.js', 'runtimes/three/kit/net/session.js'];
  const walk = async d => {
    const out = [];
    for (const e of await readdir(path.join(REPO, d), { withFileTypes: true })) {
      if (e.isDirectory()) { if (e.name !== 'node_modules') out.push(...await walk(path.join(d, e.name))); }
      else if (/\.m?js$/.test(e.name)) out.push(path.join(d, e.name));
    }
    return out;
  };
  for (const r of roots) files.push(...await walk(r));
  const hits = [];
  // a spec's engine, an engine key, engineOf: none. (`where: "engine"` is spec v2's own word for an override of the
  // runtime's code, and spec.mjs names `engine` once, to refuse an older spec.)
  for (const f of files.filter(f => !f.endsWith('builder/tools/lib/spec.mjs'))) {
    const text = await readFile(path.join(REPO, f), 'utf8');
    for (const re of [/\bspec\??\.engine\b/, /\bengineOf\w*\b/, /\bENGINE\b/, /\bkit\??\.engine\b/, /\brec\??\.engine\b/, /\bengine: '(party|scenic|forge|vista|flat)'/]) if (re.test(text)) hits.push(`${f}: ${re}`);
  }
  assert.deepEqual(hits, []);
});
