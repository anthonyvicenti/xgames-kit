// The forge library's free stand-ins (runtimes/forge/tools/stand-ins.mjs): every role a forge world, its enemies or
// its players draw is either in this checkout or drawn by a free (CC0) stand-in the library carries, and create makes
// a game from every forge spec with nothing but those.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { standIns, roleFiles, STAND_INS } from '../runtimes/forge/tools/stand-ins.mjs';

const ROOT = new URL('..', import.meta.url).pathname;

test('a missing role takes its listed stand-in or its spare sibling, under its own file names', () => {
  const catalog = { roles: {
    'enemy.a': { kind: 'body', body: 'bodies/grim-a.glb', height: 2, held: { hand_r: { file: 'held/grim-axe.glb' } } },
    'enemy.a.kaykit': { kind: 'body', spare: true, body: 'bodies/kay-a.glb', height: 1.7, held: {} },
    'ruins.b': { file: 'ruins/grim-b.glb' }, 'ruins.c': { file: 'ruins/c.glb' },
    'card.x': { file: 'cards/x.png' }, 'here': { file: 'ruins/c.glb' },
  }, small: { 'bodies/grim-a.glb': 'small/bodies/grim-a.glb' }, sections: { bodies: { 'bodies/kay-a.glb': { fist: [1, 2, 3] } } } };
  const files = new Set(['bodies/kay-a.glb', 'ruins/c.glb']);
  const licences = { 'bodies/kay-a.glb': { spdx: 'CC0-1.0', author: 'Kay' }, 'ruins/c.glb': { spdx: 'CC0-1.0', author: 'Kay' } };
  const r = standIns(catalog, licences, f => files.has(f), { 'ruins.b': 'ruins.c', 'card.x': null });
  assert.deepEqual(r.report.resolved, { 'enemy.a': 'enemy.a.kaykit', 'ruins.b': 'ruins.c' });
  assert.deepEqual(r.report.dropped, ['card.x']);
  const a = r.catalog.roles['enemy.a'];
  assert.equal(a.body, 'bodies/grim-a.glb', 'the role keeps its own body name');
  assert.equal(a.height, 1.7, 'and takes the stand-in\'s fields');
  assert.deepEqual(a.held, {}, 'what the stand-in holds, not the missing role\'s');
  assert.equal(r.catalog.small['bodies/grim-a.glb'], undefined, 'a small variant that is not here is dropped');
  assert.equal(r.alias.get('bodies/grim-a.glb'), 'bodies/kay-a.glb');
  assert.equal(r.alias.get('ruins/grim-b.glb'), 'ruins/c.glb');
  assert.deepEqual(r.catalog.sections.bodies['bodies/grim-a.glb'].fist, [1, 2, 3], 'the section entry is the stand-in\'s');
  assert.equal(r.licences['bodies/grim-a.glb'].spdx, 'CC0-1.0');
  assert.equal(r.licences['bodies/grim-a.glb'].standIn, 'bodies/kay-a.glb');
  assert.equal(r.catalog.roles.here, catalog.roles.here, 'a role that is here is untouched');
});

/** The forge library as the open kit sees it: no private packs on this machine (XGAMES_PRIVATE_PACKS: an empty folder). */
async function openKit(fn) {
  const tmp = await mkdtemp(join(tmpdir(), 'forge-open-kit-'));
  try { return await fn({ ...process.env, XGAMES_PRIVATE_PACKS: tmp }, tmp); } finally { await rm(tmp, { recursive: true, force: true }); }
}

test('the real library with no private packs: every role that draws is on this machine or has a free stand-in', { timeout: 60000 }, async () => {
  const script = `const { forgeLibrary } = await import(${JSON.stringify(join(ROOT, 'runtimes/forge/tools/library.mjs'))});
    const { roleFiles } = await import(${JSON.stringify(join(ROOT, 'runtimes/forge/tools/stand-ins.mjs'))});
    const L = await forgeLibrary(), out = { report: L.standIns, files: [] };
    for (const [name, role] of Object.entries(L.forgeCatalog.roles)) for (const f of roleFiles(role)) {
      if (!/\\.(glb|png|jpg)$/.test(f)) continue;
      let file = null; try { file = L.forgeFile(L.forgeCatalog.small?.[f] ?? f); } catch (e) { file = 'ERR ' + e.message; }
      const l = L.forgeLicences[f] ?? L.forgeLicences[L.standInOf(f) ?? ''];
      out.files.push({ name, f, file, spdx: l?.spdx ?? null });
    }
    console.log(JSON.stringify(out));`;
  const r = await openKit(env => promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], { env, maxBuffer: 1 << 26 }));
  const { report, files } = JSON.parse(r.stdout);
  assert.ok(Object.keys(report.resolved).length > 40, 'the generated roles are stood in for');
  for (const x of files) {
    assert.ok(x.file && !x.file.startsWith('ERR') && existsSync(x.file), `${x.name}: ${x.f} → ${x.file}`);
    assert.match(x.spdx ?? '', /^(CC0-1\.0|MIT|CC-BY-4\.0)$/, `${x.name}: ${x.f} is free (${x.spdx})`);
  }
  for (const d of report.dropped) assert.match(d, /^(card\.|fp\.hands\.|fp\.gauntlet$|prop\.chest$|ruins\.reliquary$)/, `${d} is dropped`);
});

test('create makes a game from every forge spec with the free stand-ins alone (no private packs)', { timeout: 120000 }, async () => {
  const run = promisify(execFile);
  const tmp = await mkdtemp(join(tmpdir(), 'forge-standins-'));
  try {
    for (const s of ['hello', 'coop', 'feel-room', 'arena', 'room', 'vigil']) {
      const out = join(tmp, s);
      await openKit(env => run(process.execPath, [join(ROOT, 'builder/tools/create.mjs'), join(ROOT, `runtimes/forge/specs/${s}.spec.json`), out], { env }));
      const att = await readFile(join(out, 'ATTRIBUTION.md'), 'utf8');
      assert.doesNotMatch(att, /LicenseRef-Meshy/, `${s}: no paid model`);
      const assets = JSON.parse(await readFile(join(out, 'assets.json'), 'utf8'));
      for (const slot of assets.slots.filter(x => x.source?.file)) assert.ok(existsSync(join(out, slot.source.file)), `${s}: ${slot.id} → ${slot.source.file}`);
    }
  } finally { await rm(tmp, { recursive: true, force: true }); }
});
