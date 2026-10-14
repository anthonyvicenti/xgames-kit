// Body archetypes beside gf-humanoid-1 (runtimes/three/kit/character/CREATURES.md): the standards, the autorig, the
// creature judge (rig-check's half for worm, blob, quadruped and flyer), the slots and seat bodies, the spec, the art
// recipe and the coverage view. Written for the looks wave 2 brief (2026-10-14): Meshy's biped rig on a legless critter
// failed the model judge (a hand weighted to nothing, a face torn in two clips), so no worm, blob, dog or bird could
// be a playable body.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { KIT as REPO, hasCharDeps } from '../builder/look-judge/lib/roots.mjs';

const skip = hasCharDeps() ? false : 'the three runtime\'s character tools are not installed (builder/tools/lib/char-deps: npm ci)';
const kit = p => pathToFileURL(join(REPO, p)).href;

test('the standards: required bones, parents and rigs agree, and every humanoid clip word has an action', { skip }, async () => {
  await import(kit('builder/tools/lib/char-node.mjs'));
  const A = await import(kit('runtimes/three/kit/character/archetypes.js'));
  const rig = await import(kit('runtimes/three/kit/character/rig.js'));
  assert.deepEqual(Object.keys(A.STANDARDS).sort(), ['blob', 'flyer', 'quadruped', 'worm']);
  for (const [a, s] of Object.entries(A.STANDARDS)) {
    assert.equal(A.RIG_OF[a], s.rig);
    assert.equal(A.ARCHETYPE_OF[s.rig], a);
    assert.ok(s.required.includes('Root'), `${a}: a Root`);
    for (const [n, p] of s.bones) if (p) assert.ok(s.parent[p] !== undefined, `${a}: ${n}'s parent ${p} is a bone of the standard`);
    for (const b of Object.values(s.sockets)) assert.ok(s.names.includes(b), `${a}: socket bone ${b}`);
  }
  for (const w of [...rig.CLIPS, ...rig.MELEE_CLIPS]) assert.ok(A.ACTION_OF[w], `the word "${w}" has a creature action`);
  assert.equal(A.isCreature('humanoid'), false);
  assert.equal(A.isCreature('blob'), true);
});

test('the stand-in set: each archetype rigged by autorig passes the creature judge in every action', { skip, timeout: 600000 }, async () => {
  const { VARIANTS, makeCreature } = await import(kit('runtimes/three/tools/creatures.mjs'));
  const { rigCheck } = await import(kit('builder/tools/rig-check.mjs'));
  const dir = mkdtempSync(join(tmpdir(), 'creatures-'));
  try {
    const seen = new Set();
    for (const id of Object.keys(VARIANTS)) {
      const made = await makeCreature(id);
      const file = join(dir, `${id}.glb`);
      writeFileSync(file, made.bytes);
      const r = await rigCheck(file);                       // the file names its archetype (gf_body extras)
      assert.equal(r.archetype, made.archetype);
      assert.ok(r.ok, `${id}: ${r.errors.join('; ')}`);
      assert.ok(r.poses.length >= 12, `${id}: posed through every action`);
      seen.add(made.archetype);
    }
    assert.deepEqual([...seen].sort(), ['blob', 'flyer', 'quadruped', 'worm']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the creature judge fails what it should: wrong standard, a joint placed off the body, a humanoid file', { skip, timeout: 300000 }, async () => {
  const { makeCreature } = await import(kit('runtimes/three/tools/creatures.mjs'));
  const { autorig } = await import(kit('builder/art/rig/autorig.mjs'));
  const { judgeCreature } = await import(kit('builder/tools/lib/creature-judge.mjs'));
  const dir = mkdtempSync(join(tmpdir(), 'creatures-bad-'));
  try {
    const slime = join(dir, 'slime.glb');
    writeFileSync(slime, (await makeCreature('slime-blue')).bytes);
    // a blob judged as a quadruped: no legs
    const q = await judgeCreature(slime, { archetype: 'quadruped' });
    assert.equal(q.ok, false);
    assert.match(q.errors.join(' '), /missing required gf-quadruped-1 bones/);
    // a worm whose head joint sits metres above it: every bend of the head tears the skin
    const raw = (await makeCreature('worm-pink')).bytes;
    const bad = await autorig(raw, { archetype: 'worm', id: 'bad', joints: { Head: [0, 4, 0] } });
    const badFile = join(dir, 'bad.glb'); writeFileSync(badFile, bad.bytes);
    const b = await judgeCreature(badFile);
    assert.equal(b.ok, false, 'a torn body fails');
    assert.match(b.errors.join(' '), /off the body|stretch|squeeze|fold|flies off/);
    // a blob whose Top joint sits metres above it: the judge says the joint is off the body
    const far = await autorig(readFileSync(slime), { archetype: 'blob', id: 'far', joints: { Top: [0, 3, 0] } });
    const farFile = join(dir, 'far.glb'); writeFileSync(farFile, far.bytes);
    assert.match((await judgeCreature(farFile)).errors.join(' '), /Top sits off the body/);
    // a gf-humanoid-1 body is no creature
    const bean = (await import(kit('builder/art/views.mjs'))).refFile('gf-beans/bean-classic');
    if (bean) { const h = await judgeCreature(bean, { archetype: 'blob' }); assert.equal(h.ok, false); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a creature role: its slots name its standard, seats get their own bodies, and no clip file is asked for', { skip }, async () => {
  await import(kit('builder/tools/lib/char-node.mjs'));
  const ch = await import(kit('runtimes/three/kit/character/character.js'));
  const cfg = { characters: { roles: { player: { body: 'assets/models/body-player.glb', height: 0.84, archetype: 'blob', seats: [{ body: 'assets/models/body-player-seat2.glb', height: 1 }, 'assets/models/body-player-seat3.glb'] } } } };
  const slots = ch.slotsFor(cfg);
  const body = slots.find(s => s.id === 'character.body.player');
  assert.deepEqual([body.constraints.rig, body.constraints.archetype], ['gf-blob-1', 'blob']);
  assert.ok(!body.constraints.animations, 'a creature plays no clips');
  assert.ok(slots.find(s => s.id === 'character.body.player.seat2'));
  assert.equal(slots.find(s => s.id === 'character.body.player.seat3').source.file, 'assets/models/body-player-seat3.glb');
  assert.ok(!slots.some(s => s.id === 'character.clips'), 'no humanoid role: no clip slot');
  assert.equal(slots.find(s => s.id === 'character.height.player').constraints.min, 0.1);
  // seat 0 the role's body, seat 1 the first seat body, seat 3 round again
  assert.equal(ch.bodyFor(cfg.characters, 'player', 0).bodySlot, 'character.body.player');
  assert.deepEqual([ch.bodyFor(cfg.characters, 'player', 1).bodySlot, ch.bodyFor(cfg.characters, 'player', 1).height], ['character.body.player.seat2', 1]);
  assert.equal(ch.bodyFor(cfg.characters, 'player', 3).bodySlot, 'character.body.player');
  assert.equal(ch.roleOfSlot('character.body.player.seat3'), 'player');
  // a humanoid game is as before
  const h = ch.slotsFor({ characters: { roles: { player: { body: 'b.glb', height: 1.7 } } } });
  assert.equal(h.find(s => s.id === 'character.body.player').constraints.rig, 'gf-humanoid-1');
  assert.ok(h.some(s => s.id === 'character.clips'));
});

test('measure 19 judges a creature body with the creature judge (gate A, widened)', { skip, timeout: 300000 }, async () => {
  const { makeCreature } = await import(kit('runtimes/three/tools/creatures.mjs'));
  const { checkBodies } = await import(kit('builder/tools/lib/bodies-check.mjs'));
  const { autorig } = await import(kit('builder/art/rig/autorig.mjs'));
  const dir = mkdtempSync(join(tmpdir(), 'creature-game-'));
  try {
    mkdirSync(join(dir, 'assets/models'), { recursive: true });
    const good = (await makeCreature('worm-pink')).bytes;
    writeFileSync(join(dir, 'assets/models/body-player.glb'), good);
    const slot = file => ({ id: 'character.body.player', type: 'model', source: { file }, constraints: { rigged: true, rig: 'gf-worm-1', archetype: 'worm' } });
    writeFileSync(join(dir, 'assets.json'), JSON.stringify({ slots: [slot('assets/models/body-player.glb')] }));
    const ok = await checkBodies(dir);
    assert.ok(ok.ok, ok.detail);
    assert.match(ok.detail, /a worm on gf-worm-1/);
    // the same worm with its head joint thrown far off: the measure fails it and says why
    const bad = await autorig(good, { archetype: 'worm', id: 'bad', joints: { Head: [0, 4, 0] } });
    writeFileSync(join(dir, 'assets/models/body-player.glb'), bad.bytes);
    const no = await checkBodies(dir);
    assert.equal(no.ok, false, no.detail);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('motion is the same from the same words: a friend\'s copy poses the creature as its owner does', { skip, timeout: 120000 }, async () => {
  const { makeCreature } = await import(kit('runtimes/three/tools/creatures.mjs'));
  const { loadGLB } = await import(kit('builder/tools/lib/char-three.mjs'));
  const A = await import(kit('runtimes/three/kit/character/archetypes.js'));
  const { createMotion } = await import(kit('runtimes/three/kit/character/motion.js'));
  const dir = mkdtempSync(join(tmpdir(), 'creature-motion-'));
  try {
    const file = join(dir, 'pup.glb'); writeFileSync(file, (await makeCreature('pup-tan')).bytes);
    const poseAfter = async () => {
      const g = await loadGLB(file), std = A.standardOf('quadruped'), rig = A.findCreatureRig(g.scene, std), bind = A.creatureBind(g.scene, rig);
      const m = createMotion(std, rig, bind, A.measureCreature(std, rig, bind), { bodyNode: g.scene.getObjectByName('gf_body') });
      const base = { grounded: true, vy: 0, airT: 0, landT: 9, vel: { x: 0, z: 1.2 }, hold: 0, aim: 0, down: 0, tumbling: false, getup: null };
      for (let t = 0; t < 2; t += 1 / 60) m.pose({ ...base, t, speed: 1.2, action: t > 1 ? { action: 'hit', t: t - 1, dur: 0.42 } : null }, 1 / 60);
      return [...rig.bones.values()].map(b => [...b.quaternion.toArray(), ...b.position.toArray()].map(x => +x.toFixed(6)));
    };
    assert.deepEqual(await poseAfter(), await poseAfter());
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the art recipe and coverage know every archetype: a creature is made unrigged and rigged by autorig', async () => {
  const { recipe, RIG_OF } = await import(kit('builder/art/recipe.mjs'));
  const { RIGGED_ARCHETYPES } = await import(kit('builder/art/coverage.mjs'));
  const blob = recipe({ id: 'critter', kind: 'body', archetype: 'blob', words: 'a round critter' });
  assert.equal(blob.rig, 'gf-blob-1');
  assert.ok(blob.steps.some(s => s.step === 'autorig') && !blob.steps.some(s => s.step === 'rig'));
  assert.match(blob.prompt, /standing on its base/);
  const person = recipe({ id: 'kid', kind: 'body', words: 'a kid' });
  assert.ok(person.steps.some(s => s.step === 'rig'));
  for (const a of ['worm', 'blob', 'quadruped', 'flyer']) { assert.ok(RIGGED_ARCHETYPES[a]); assert.equal(RIGGED_ARCHETYPES[a], RIG_OF[a]); }
});

test('the spec: a body names its archetype, a role its seats; a wrong archetype is refused', async () => {
  const { loadSchemas, SCHEMA } = await import(kit('registry/schemas.mjs'));
  const { validate } = await loadSchemas();
  const spec = JSON.parse(readFileSync(join(REPO, 'examples/minimal/critter-lob/spec.json'), 'utf8'));
  assert.deepEqual(validate(SCHEMA.spec, spec), []);
  const bad = structuredClone(spec); bad.characters[0].body.archetype = 'centaur';
  assert.match(validate(SCHEMA.spec, bad).join(' '), /archetype|allowed/);
  const odd = structuredClone(spec); odd.world.props[0].archetype = 'blob';      // only a body has an archetype
  assert.ok(validate(SCHEMA.spec, odd).length);
});
