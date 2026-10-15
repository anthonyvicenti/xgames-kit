// The art of what a game is played for (builder/art/objectives.mjs) and gate F's objective leg (measure 14,
// builder/tools/lib/looks-check.mjs). The creator, 2026-10-14, on the composed levels: "We were supposed to collect
// berries, but there were no berries anywhere. I think in the ocean I saw some boxes": the berry slot held the kit's
// stand-in crate. No browser, no maker: a test passes its own `generate`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, copyFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { create } from '../builder/tools/create.mjs';
import { objectiveArt, objectiveProps, whatModel } from '../builder/art/objectives.mjs';
import { means } from '../builder/art/resolve.mjs';
import { setFile } from '../builder/lib/slots.mjs';
import { checkLooks } from '../builder/tools/lib/looks-check.mjs';
import { readCatalog } from '../builder/tools/lib/spec.mjs';
import { findAsset } from '../builder/art/views.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STANDIN = path.join(REPO, 'builder/tools/lib/standin-assets');
const readJson = async f => JSON.parse(await readFile(f, 'utf8'));
const prop = (name, more = {}) => ({ name, describe: `a ${name}`, kind: 'gameplay', ...more });

test('the props a game\'s objectives draw come from the mechanics\' manifests, and goal props', async () => {
  const catalog = await readCatalog();
  const spec = { world: { props: [prop('berry'), prop('bench', { kind: 'scenery' }), prop('coin'), prop('totem', { goal: true })] },
    mechanics: [{ id: 'pickup', params: {} }, { id: 'loot', params: { potionProp: 'nothing-here' } }, { id: 'projectile', params: { prop: 'berry' } }] };
  const got = objectiveProps(spec, catalog);
  // pickup's empty prop is the first gameplay prop; loot's coinProp default ("coin") is a prop of the game, its
  // potionProp names none (the part draws its own); a projectile's shot is no objective; the goal prop is one
  assert.deepEqual(got.map(o => [o.name, o.by]), [['berry', ['pickup.prop']], ['coin', ['loot.coinProp']], ['totem', ['goal']]]);
});

test('a model means what its slot names by its id, its tags or a word of their family, never by its description alone', () => {
  const strawberry = findAsset('kenney-food-kit/strawberry');
  assert.ok(strawberry, 'the library has the strawberry (kenney-food-kit)');
  assert.equal(means(strawberry, 'berry'), true);              // library/words.json: berry → strawberry
  assert.equal(means(strawberry, 'Strawberry'), true);
  assert.equal(means(findAsset('kaykit-dungeon-remastered/dungeon-barrel'), 'berry'), false);
  assert.equal(means({ id: 'bush', tags: ['nature'], describe: 'a bush with berries' }, 'berry'), false);
  assert.equal(means({ id: 'gold-coin', tags: [] }, 'coin'), true);
});

test('a kit stand-in is a stand-in, and means the thing only when it is that shape', async () => {
  const crate = await whatModel(await readFile(path.join(STANDIN, 'crate.glb')), 'berry');
  assert.equal(crate.standin, true); assert.equal(crate.means, false);
  const ball = await whatModel(await readFile(path.join(STANDIN, 'ball.glb')), 'ball');
  assert.equal(ball.standin, true); assert.equal(ball.means, true);
});

test('create fills an objective from the library by meaning; a stand-in or another thing in its slot fails measure 14', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'objective-art-'));
  try {
    const r = await create(path.join(REPO, 'examples/minimal/critter-lob/spec.json'), dir);
    assert.equal(r.ok, true, JSON.stringify(r.problems ?? r.why));
    const record = await readJson(path.join(dir, 'gf-three.json'));
    assert.equal(record.props.berry.from, 'library:kenney-food-kit/strawberry');
    assert.ok(record.notes.some(n => /prop "berry": an objective \(pickup\.prop\); the library's kenney-food-kit\/strawberry means it/.test(n)));
    assert.match(await readFile(path.join(dir, 'ATTRIBUTION.md'), 'utf8'), /assets\/models\/berry\.glb \| prop "berry" \(library:kenney-food-kit\/strawberry\) \| CC0-1\.0, Kenney/);
    assert.equal((await checkLooks(dir)).ok, true);
    // the creator's case: the kit's stand-in crate in the berry's slot
    await copyFile(path.join(STANDIN, 'crate.glb'), path.join(dir, 'assets/models/berry.glb'));
    const lk = await checkLooks(dir);
    assert.equal(lk.ok, false);
    assert.match(lk.detail, /the objective "berry" \(prop\.berry, drawn by pickup\.prop: "a big shiny red berry"\) is the kit stand-in crate\.glb/);
    // the art step puts the library's berry back, and the leg passes
    const oa = await objectiveArt(dir, {});
    assert.deepEqual(oa.items.map(i => [i.name, i.now, i.ref]), [['berry', 'library', 'kenney-food-kit/strawberry']]);
    assert.equal((await checkLooks(dir)).ok, true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('an objective the library lacks: without a maker it stays a stand-in and fails; made, it passes; a failed try is said and excused', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'objective-art-'));
  try {
    const spec = await readJson(path.join(REPO, 'examples/minimal/critter-lob/spec.json'));
    spec.world.props = spec.world.props.map(p => (p.name === 'berry' ? { ...p, name: 'zorblat', describe: 'a glowing zorblat' } : p));
    for (const m of spec.mechanics) if (m.params?.prop === 'berry') m.params.prop = 'zorblat';
    const file = path.join(dir, 'spec.in.json');
    await writeFile(file, JSON.stringify(spec, null, 2));
    const r = await create(file, path.join(dir, 'g'));
    assert.equal(r.ok, true, JSON.stringify(r.problems ?? r.why));
    const g = path.join(dir, 'g');
    assert.ok(r.warnings.some(w => /objective "zorblat" \(prop\.zorblat\) is still a stand-in/.test(w)));
    const gen = await readJson(path.join(g, 'generated.json'));
    assert.equal(gen.items[0].state, 'skipped');
    assert.match(gen.delivery, /"zorblat" \(assets\/models\/zorblat\.glb\)/);
    // skipped is no excuse: nothing was tried
    assert.equal((await checkLooks(g)).ok, false);

    // a maker that fails (the credit cap): recorded with why, the delivery names it, the leg excuses it
    const refuse = async () => { throw new Error('Meshy cap: 150 credits spent in the wave; stopped'); };
    let oa = await objectiveArt(g, { yes: true, generate: refuse });
    assert.equal(oa.items[0].now, 'standin');
    assert.equal((await readJson(path.join(g, 'generated.json'))).items[0].state, 'refused');
    const ex = await checkLooks(g);
    assert.equal(ex.ok, true, ex.detail);
    assert.ok(ex.notes.some(n => /zorblat.*generation refused/.test(n)));

    // a maker that makes it: the slot holds the made model, the record says where it came from
    const make = async ({ game, slot }) => { await setFile(game, slot, { from: path.join(STANDIN, 'bench.glb') }); return { ok: true, ref: 'game-g/zorblat', credits: 36, licence: { spdx: 'LicenseRef-Meshy-Paid', author: 'Meshy AI', url: 'https://www.meshy.ai' } }; };
    oa = await objectiveArt(g, { yes: true, generate: make });
    assert.equal(oa.items[0].now, 'generated');
    assert.equal(oa.credits, 36);
    const record = await readJson(path.join(g, 'gf-three.json'));
    assert.equal(record.props.zorblat.from, 'generated:game-g/zorblat');
    assert.equal((await readJson(path.join(g, 'generated.json'))).items[0].state, 'placed');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
