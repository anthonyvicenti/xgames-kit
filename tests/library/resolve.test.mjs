// The resolver on a small library made here: kind first, then words, then budgets, then licence; hard limits refuse.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadLibrary } from '../../builder/art/library.mjs';
import { loadPolicy } from '../../builder/art/policy.mjs';
import { budgetFit, fillSlots, find, needFromSlot, resolveNeed, tokens } from '../../builder/art/resolve.mjs';
import { tempLibrary, writeTestPack } from './helpers.mjs';

const KIND = { id: 'scenic', packs: ['folio-nature', 'kaykit-dungeon-remastered', 'kaykit-skeletons'], bodies: { three: ['kaykit-knight'], enemies: ['skeleton-warrior'] }, props: { three: ['bridge'] } };
const ok = by => [{ by, ok: true, date: '2026-10-13' }];

async function library() {
  const t = await tempLibrary();
  const c = t.config;
  await writeTestPack(c, { id: 'folio-nature', licence: { spdx: 'MIT', author: 'Bruno Simon' } }, [
    { id: 'bridge', describe: 'a wooden footbridge with rails', tags: ['bridge', 'wood'], use: { size: [11, 3, 8] }, budgets: { triangles: 650 } },
    { id: 'fence', describe: 'a wooden fence', tags: ['fence', 'wood'], budgets: { triangles: 100 } },
    { id: 'tree-oak', describe: 'a round leafy oak tree', tags: ['tree', 'nature'], budgets: { triangles: 300 } },
    { id: 'tree-birch', describe: 'a tall birch tree', tags: ['tree', 'nature'], budgets: { triangles: 300 } },
  ]);
  await writeTestPack(c, { id: 'kenney-nature-kit' }, [
    { id: 'bridge-wood', describe: 'a wooden bridge', tags: ['bridge', 'wood', 'wooden'], budgets: { triangles: 200 } },
    { id: 'tree-oak', describe: 'a low-poly oak tree', tags: ['tree', 'oak'], budgets: { triangles: 90 } },
    { id: 'big-rock', describe: 'a huge cliff rock', tags: ['rock'], budgets: { triangles: 90000, textureMax: 4096 }, variants: [{ use: 'small', sha256: 'f'.repeat(64), bytes: 1000, textureMax: 512 }] },
    { id: 'heavy-rock', describe: 'a heavy cliff rock', tags: ['rock'], budgets: { triangles: 90000 } },
  ]);
  await writeTestPack(c, { id: 'poly-pizza-cc-by', licence: { spdx: 'CC-BY-3.0', author: 'several' } }, [
    { id: 'slide', describe: 'a red playground slide', tags: ['slide', 'playground'], licence: { spdx: 'CC-BY-3.0', author: 'Poly by Google', credit: '"Slide" by Poly by Google, CC BY 3.0' } },
    { id: 'swing', describe: 'a swing set', tags: ['swing', 'playground'] },
  ]);
  await writeTestPack(c, { id: 'kaykit-skeletons' }, [
    { id: 'skeleton-warrior', category: 'body', describe: 'a skeleton warrior', tags: ['skeleton', 'enemy', 'undead'], use: { rig: 'gf-humanoid-1' }, validated: ok('rig-check') },
    { id: 'skeleton-mage', category: 'body', describe: 'a skeleton mage with a staff', tags: ['skeleton', 'mage', 'enemy'], use: { rig: 'gf-humanoid-1' }, validated: ok('rig-check') },
    { id: 'skeleton-broken', category: 'body', describe: 'a skeleton with a broken rig', tags: ['skeleton'], use: { rig: 'gf-humanoid-1' }, validated: [{ by: 'rig-check', ok: false, date: '2026-10-13' }] },
    { id: 'crossbow', describe: 'a skeleton crossbow', tags: ['weapon', 'crossbow'], budgets: { triangles: 300 } },
  ]);
  await writeTestPack(c, { id: 'kaykit-adventurers' }, [
    { id: 'kaykit-knight', category: 'body', describe: 'a stocky knight in plate armour', tags: ['knight', 'player', 'hero'], use: { rig: 'gf-humanoid-1' }, validated: ok('rig-check') },
  ]);
  await writeTestPack(c, { id: 'rocketbox-adults', licence: { spdx: 'MIT' } }, [
    { id: 'keeper', category: 'body', describe: 'a shop keeper', tags: ['human'], use: { rig: 'rocketbox' } },
  ]);
  await writeTestPack(c, { id: 'forge-grim-bodies', visibility: 'private', owner: 'generated', licence: { spdx: 'LicenseRef-Meshy-Paid' }, source: { kind: 'maker', maker: 'meshy' } }, [
    { id: 'grim-lord', category: 'body', describe: 'a skeleton lord, a giant boss', tags: ['skeleton', 'boss', 'enemy'], use: { rig: 'gf-humanoid-1' }, validated: ok('rig-check') },
  ]);
  return { ...t, lib: loadLibrary(c), policy: loadPolicy(c.policyFile) };
}

test('tokens drop the words that say nothing and fold plurals', () => {
  assert.deepEqual(tokens('A wooden bridge with rails'), ['wooden', 'bridge', 'rail']);
});

test('find "wooden bridge" --kind scenic --3d: the kind\'s pack first, then the best words elsewhere', async () => {
  const t = await library();
  try {
    const r = find(t.lib, 'wooden bridge', { kindPreset: KIND, policy: t.policy, dimension: '3d' });
    assert.equal(r.results[0].ref, 'folio-nature/bridge');
    assert.equal(r.results[1].ref, 'kenney-nature-kit/bridge-wood');
    assert.ok(!r.results.some(x => x.ref === 'folio-nature/fence'), 'the fence matches "wooden" only: under the relevance floor');
    // with no kind, the closest words win
    const plain = find(t.lib, 'wooden bridge', { policy: t.policy });
    assert.equal(plain.results[0].ref, 'kenney-nature-kit/bridge-wood');
  } finally { await t.cleanup(); }
});

test('a kind that names an asset ranks it over the same id in another pack', async () => {
  const t = await library();
  try {
    const r = resolveNeed(t.lib, { category: 'prop', dimension: '3d', words: 'oak tree' }, { kindPreset: KIND, policy: t.policy });
    assert.equal(r.pick.ref, 'folio-nature/tree-oak');
    assert.match(r.pick.why.join(' '), /in a scenic pack|names it/);
  } finally { await t.cleanup(); }
});

test('bodies: the rig is a hard limit, a failed validator is refused, enemies come from the kind\'s enemy list', async () => {
  const t = await library();
  try {
    const r = resolveNeed(t.lib, { category: 'body', dimension: '3d', rig: 'gf-humanoid-1', role: 'monster', words: 'Monster character a skeleton warrior' }, { kindPreset: KIND, policy: t.policy });
    assert.equal(r.pick.ref, 'kaykit-skeletons/skeleton-warrior');
    assert.ok(r.refused.some(x => x.ref === 'kaykit-skeletons/skeleton-broken' && /failed rig-check/.test(x.why)));
    assert.ok(r.refused.some(x => x.ref === 'rocketbox-adults/keeper' && /rig rocketbox/.test(x.why)));
    const player = resolveNeed(t.lib, { category: 'body', dimension: '3d', rig: 'gf-humanoid-1', role: 'player', words: 'Player character a knight in armour' }, { kindPreset: KIND, policy: t.policy });
    assert.equal(player.pick.ref, 'kaykit-adventurers/kaykit-knight');
  } finally { await t.cleanup(); }
});

test('licence: a paid maker\'s output only with the key and a yes; CC-BY comes with its credit line', async () => {
  const t = await library();
  try {
    const need = { category: 'body', dimension: '3d', rig: 'gf-humanoid-1', role: 'boss', words: 'a giant skeleton lord boss' };
    const no = resolveNeed(t.lib, need, { policy: t.policy });
    assert.notEqual(no.pick.ref, 'forge-grim-bodies/grim-lord');
    assert.ok(no.refused.some(x => x.ref === 'forge-grim-bodies/grim-lord' && /key and the creator's yes/.test(x.why)));
    const yes = resolveNeed(t.lib, need, { policy: t.policy, paid: { yes: true, keys: ['meshy'] } });
    assert.equal(yes.pick.ref, 'forge-grim-bodies/grim-lord');
    const slide = resolveNeed(t.lib, { category: 'prop', dimension: '3d', words: 'red playground slide' }, { policy: t.policy });
    assert.equal(slide.pick.ref, 'poly-pizza-cc-by/slide');
    assert.match(slide.pick.credit, /Poly by Google/);
    // the swing set has no credit line of its own and the pack's licence has none: never offered
    const swing = resolveNeed(t.lib, { category: 'prop', dimension: '3d', words: 'swing set' }, { policy: t.policy });
    assert.notEqual(swing.pick?.ref, 'poly-pizza-cc-by/swing');
  } finally { await t.cleanup(); }
});

test('budgets: a phone takes the asset with a small copy over the one with none', async () => {
  const t = await library();
  try {
    const big = t.lib.flatMap(p => p.assets).find(a => a.id === 'big-rock');
    assert.deepEqual(budgetFit(big, ['desktop']).ok, true);
    assert.equal(budgetFit(big, ['phone']).ok, false, 'its triangles are over a phone\'s budget even with the small copy');
    const r = resolveNeed(t.lib, { category: 'prop', dimension: '3d', words: 'cliff rock' }, { policy: t.policy, devices: ['phone'] });
    assert.ok(r.findings.some(f => /over budget for phone/.test(f)));
  } finally { await t.cleanup(); }
});

test('needFromSlot reads a gf-assets slot; fillSlots fills each and avoids giving two slots the same asset', async () => {
  const t = await library();
  try {
    assert.deepEqual(needFromSlot({ id: 'look.hud.accent', type: 'color' }), null);
    const body = needFromSlot({ id: 'character.body.boss', type: 'model', label: 'Boss character', constraints: { rig: 'gf-humanoid-1' }, description: 'a giant skeleton sorcerer' });
    assert.equal(body.category, 'body'); assert.equal(body.role, 'boss');
    const prop = needFromSlot({ id: 'prop.bridge', type: 'model', label: 'Bridge', description: 'A scenic prop. Metres, Y up, base at y=0, centred.', constraints: { size: [11, 3, 8] } });
    assert.equal(prop.words.includes('Metres'), false, 'the boilerplate sentence is not part of the need');
    const r = fillSlots(t.lib, [
      { id: 'prop.tree-a', type: 'model', label: 'Tree' },
      { id: 'prop.tree-b', type: 'model', label: 'Tree' },
      { id: 'mechanic.waves.archer.weapon', type: 'model', label: 'Archer: weapon', generate: { prompt: 'the weapon a Archer holds' } },
      { id: 'game.speed', type: 'number' },
    ], { kindPreset: KIND, policy: t.policy });
    assert.equal(r.filled.length, 3);
    assert.notEqual(r.filled[0].pick.ref, r.filled[1].pick.ref, 'two tree slots get two trees of the kind');
    assert.ok(r.filled.slice(0, 2).every(f => f.pick.pack === 'folio-nature'));
    assert.equal(r.filled[2].pick.ref, 'kaykit-skeletons/crossbow', 'an archer\'s weapon finds the crossbow through words.json');
    assert.deepEqual(r.skipped, ['game.speed']);
  } finally { await t.cleanup(); }
});

test('nothing to give: the answer says so and names the next step (a connection), never a silent stand-in', async () => {
  const t = await library();
  try {
    const r = resolveNeed(t.lib, { category: 'sound', dimension: 'audio', words: 'splash' }, { policy: t.policy });
    assert.equal(r.status, 'none');
    assert.equal(r.next, 'connection');
  } finally { await t.cleanup(); }
});

test('fillGame copies each pick from the store to the slot\'s path, leaves provided slots alone, and returns the credits', async () => {
  const { fillGame, creditRows } = await import('../../builder/art/fill.mjs');
  const { put } = await import('../../builder/art/store.mjs');
  const { readFileSync, existsSync } = await import('node:fs');
  const { writeFile, mkdir } = await import('node:fs/promises');
  const path = (await import('node:path')).default;
  const t = await tempLibrary();
  try {
    const bridge = Buffer.from('bridge bytes'), slide = Buffer.from('slide bytes');
    const b = await put(t.config.store, bridge), s = await put(t.config.store, slide);
    await writeTestPack(t.config, { id: 'folio-nature', licence: { spdx: 'MIT', author: 'Bruno Simon', file: 'library/packs/folio-nature/LICENSE.txt' } }, [{ id: 'bridge', describe: 'a wooden bridge', tags: ['bridge'], sha256: b.sha256 }]);
    await writeTestPack(t.config, { id: 'poly-pizza-cc-by', licence: { spdx: 'CC-BY-3.0' } }, [{ id: 'slide', describe: 'a red playground slide', tags: ['slide'], sha256: s.sha256, licence: { spdx: 'CC-BY-3.0', author: 'Poly by Google', credit: '"Slide" by Poly by Google, CC BY 3.0' } }]);
    await mkdir(path.join(t.config.kindsDir), { recursive: true });
    await writeFile(path.join(t.config.kindsDir, 'scenic.json'), JSON.stringify(KIND));
    const game = path.join(t.root, 'game');
    const slots = [
      { id: 'prop.bridge', type: 'model', label: 'Wooden bridge', source: { file: 'assets/models/bridge.glb' } },
      { id: 'prop.slide', type: 'model', label: 'Red playground slide', source: { file: 'assets/models/slide.glb' } },
      { id: 'prop.mine', type: 'model', label: 'Wooden bridge', source: { file: 'assets/models/mine.glb' } },
      { id: 'world.ground', type: 'image', label: 'Ground pattern', source: { file: 'assets/textures/ground.png' } },
    ];
    const r = await fillGame({ config: t.config, game, slots, kind: 'scenic', provided: ['prop.mine'] });
    assert.equal(readFileSync(path.join(game, 'assets/models/bridge.glb'), 'utf8'), 'bridge bytes');
    assert.equal(readFileSync(path.join(game, 'assets/models/slide.glb'), 'utf8'), 'slide bytes');
    assert.equal(existsSync(path.join(game, 'assets/models/mine.glb')), false, 'a provided slot is the creator\'s');
    assert.deepEqual(r.next.map(n => n.slot), ['world.ground'], 'nothing for the ground: handed to the next step');
    assert.match(creditRows(r.credits).join('\n'), /"Slide" by Poly by Google/);
  } finally { await t.cleanup(); }
});
