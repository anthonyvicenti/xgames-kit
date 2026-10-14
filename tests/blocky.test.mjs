// The blocky body set (runtimes/three/tools/blocky.mjs): every variant, made fresh, is a gf-humanoid-1 body that passes
// rig-check (bones, scale, skin, clips, budget, and the model judge's measuring tier: face, body, arms, hands, legs,
// feet at rest and in every clip a player plays) with no warnings, and passes the model judge on every clip in the file.
// The set itself lives in the asset library (pack xk-blocky-bodies); its manifests' sha256 are what the maker makes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { KIT as REPO, hasCharDeps } from '../builder/look-judge/lib/roots.mjs';

const skip = hasCharDeps() ? false : 'the three runtime\'s character tools are not installed (builder/tools/lib/char-deps: npm ci)';

test('every blocky variant passes rig-check and the model judge on every clip', { skip, timeout: 120000 }, async () => {
  const { VARIANTS, makeBlocky } = await import('../runtimes/three/tools/blocky.mjs');
  const { rigCheck } = await import(pathToFileURL(join(REPO, 'builder/tools/rig-check.mjs')).href);
  const { judgeBody, DEFAULT_CLIPS } = await import(pathToFileURL(join(REPO, 'builder/tools/lib/body-judge.mjs')).href);
  const { loadGLB } = await import(pathToFileURL(join(REPO, 'builder/tools/lib/char-three.mjs')).href);
  const all = (await loadGLB(DEFAULT_CLIPS)).animations.map(a => a.name);
  const dir = mkdtempSync(join(tmpdir(), 'blocky-'));
  try {
    assert.ok(Object.keys(VARIANTS).length >= 4, 'a set, not one body');
    for (const id of Object.keys(VARIANTS)) {
      const made = await makeBlocky(id);
      const file = join(dir, `${id}.glb`);
      writeFileSync(file, made.bytes);
      const r = await rigCheck(file);
      assert.ok(r.ok, `${id}: ${r.errors.join('; ')}`);
      assert.deepEqual(r.warnings, [], `${id} warnings`);
      assert.ok(r.stats.materials <= 8, `${id}: ${r.stats.materials} materials`);
      const j = await judgeBody(file, { clipNames: all });
      assert.ok(j.ok, `${id} on all ${all.length} clips: ${j.errors.join('; ')}`);
      for (const part of ['face', 'hand_l', 'hand_r', 'foot_l', 'foot_r']) assert.ok(j.parts[part].ok && !j.parts[part].na, `${id}: ${part}`);
      assert.ok(made.height > 1.3 && made.height < 2.2, `${id}: ${made.height} m`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a blocky body tints its shirt, keeps its face, and has a hurt face', { skip }, async () => {
  const { makeBlocky } = await import('../runtimes/three/tools/blocky.mjs');
  const { io } = await import(pathToFileURL(join(REPO, 'builder/tools/lib/char-deps.mjs')).href);
  const doc = await (await io()).readBinary((await makeBlocky('blocky-classic')).bytes);
  const root = doc.getRoot().listNodes().find(n => n.getName() === 'gf_body');
  const x = root.getExtras();
  assert.equal(x.gfRig, 'gf-humanoid-1');
  assert.deepEqual(x.gfTint, ['tint_body']);
  assert.deepEqual(x.gfFaces.hurt, { show: ['face_hurt'], hide: ['eye_white', 'eye_dark'] });
  const mats = doc.getRoot().listMaterials().map(m => m.getName()).sort();
  assert.deepEqual(mats, ['eye_dark', 'eye_white', 'face_hurt', 'hair', 'pants', 'shoe', 'skin', 'tint_body']);
});

// the set lives in the asset library (pack xk-blocky-bodies): each manifest's sha256 is what the maker makes today
const PACK = new URL('../library/packs/xk-blocky-bodies/assets/', import.meta.url);
const packSkip = skip || (existsSync(PACK) ? false : 'the asset library (library/packs/xk-blocky-bodies) is not in this checkout');
test('the library\'s block bodies are what the maker makes', { skip: packSkip, timeout: 120000 }, async () => {
  const { makeBlocky, VARIANTS } = await import('../runtimes/three/tools/blocky.mjs');
  for (const id of Object.keys(VARIANTS)) {
    const m = JSON.parse(readFileSync(new URL(`${id}.json`, PACK), 'utf8'));
    const fresh = await makeBlocky(id);
    assert.equal(createHash('sha256').update(fresh.bytes).digest('hex'), m.sha256, `${id}: the maker no longer makes the library's file (make it, then art ingest it into xk-blocky-bodies)`);
  }
});
