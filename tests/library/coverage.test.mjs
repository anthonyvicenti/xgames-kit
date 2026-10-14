// coverage (what the library holds for a look), recipe (concept-first prompts and credits) and the wave's tiling.
// No test calls Meshy: the wave's paid steps are covered by the plan and by makeTileable on a made-up picture.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { LIBRARY_ROOT, loadConfig } from '../../builder/art/config.mjs';
import { coverage, coverageReport, flatNeed, inventory, kindTarget, styleFit, targetTone } from '../../builder/art/coverage.mjs';
import { loadPolicy } from '../../builder/art/policy.mjs';
import { anchorPrompt, colourWords, conceptPrompt, COST, recipe, waveCost } from '../../builder/art/recipe.mjs';
import { loadCase, makeTileable, planWave } from '../../builder/art/wave.mjs';

const policy = loadPolicy(path.join(LIBRARY_ROOT, 'policy.json'));
const CASE = path.join(LIBRARY_ROOT, 'coverage', 'cases', 'artillery-cartoon.json');
const sig = (o = {}) => ({ fits: { signature: { palette: { saturation: 0.8, value: 0.6, families: [{ hue: 'green', share: 0.7 }, { hue: 'yellow', share: 0.3 }], grey: 0, ...o.palette }, trianglesPerMetre: o.tpm ?? 12, texturedShare: o.tex ?? 0.9, outline: { present: false } } } });
const target = { schema: 'gf-look-target/1', from: 'words', confidence: 0.4, reads: ['bright'], palette: { colors: [{ hex: '#6fd43a', share: 0.6 }, { hex: '#ffd23f', share: 0.4 }] }, materials: { texture: 'painted' }, shapes: { detail: 'mid' }, edges: { outline: 'mid' } };

// a two-pack library in memory: one in-style prop pack, one grey photo-textured one
function lib() {
  const pack = (id, extra = {}) => ({ packVersion: 1, id, owner: 'third-party', visibility: 'public', licence: { spdx: 'CC0-1.0', author: 'test' }, dimension: '3d', ...extra });
  const asset = (p, id, words, s) => ({ assetVersion: 1, id, pack: p, file: `${id}.glb`, sha256: id.padEnd(64, '0').replace(/[^0-9a-f]/g, 'a'), bytes: 10, dimension: '3d', category: 'prop', describe: words, tags: words.split(' '), budgets: { triangles: 100 }, validated: [], ...s });
  return [
    { pack: pack('bright'), assets: [asset('bright', 'crate', 'a green crate', sig()), asset('bright', 'barrel', 'a yellow barrel', sig())], dir: '/x' },
    { pack: pack('grim'), assets: [asset('grim', 'grim-crate', 'a grey crate', sig({ palette: { saturation: 0.1, value: 0.25, families: [{ hue: 'grey', share: 1 }], grey: 1 }, tex: 1, tpm: 60 }))], dir: '/y' },
  ];
}

test('styleFit: a matching asset fits; a grey, dark, dense, textured one does not, and says why', () => {
  const good = styleFit(sig(), target), bad = styleFit(sig({ palette: { saturation: 0.1, value: 0.2, families: [{ hue: 'grey', share: 1 }], grey: 1 }, tpm: 60 }), target);
  assert.ok(good.fit >= 0.7, `good fit ${good.fit}`);
  assert.ok(bad.fit < 0.6, `bad fit ${bad.fit}`);
  assert.ok(bad.why.some(w => /saturation/.test(w)));
  assert.ok(good.why.some(w => /outline/.test(w)), 'a look with ink names the missing outline as the runtime\'s job');
  // a near-white thing (a cloud) takes the look's light: no penalty for its lack of colour
  const cloud = styleFit(sig({ palette: { saturation: 0, value: 0.95, families: [{ hue: 'grey', share: 1 }], grey: 1 } }), target);
  assert.ok(cloud.colour >= 0.7, `cloud colour ${cloud.colour}`);
});

test('targetTone measures a target like an asset (HSL over its swatches), and a kind target carries its own', () => {
  const t = targetTone(target);
  assert.ok(t.saturation > 0.6 && t.lightness > 0.4 && t.lightness < 0.8);
  assert.deepEqual(targetTone({ tone: { saturation: 0.3, lightness: 0.4 } }), { saturation: 0.3, lightness: 0.4 });
});

test('coverage: have, off-style, missing and code, and a body of an archetype with no standard is missing', () => {
  const needs = [
    { id: 'crates', category: 'prop', dimension: '3d', words: 'crate', count: 1 },
    { id: 'two-crates', category: 'prop', dimension: '3d', words: 'crate, box', count: 3 },
    { id: 'bombs', category: 'prop', dimension: '3d', words: 'bomb, dynamite', count: 1 },
    { id: 'sky', category: 'sky', dimension: '2d', words: 'sky', count: 1, code: 'a sky dome' },
    { id: 'critters', category: 'body', archetype: 'centaur', words: 'centaur', count: 2 },
  ];
  const r = coverage(lib(), needs, { target, policy });
  const by = Object.fromEntries(r.needs.map(n => [n.id, n]));
  assert.equal(by.crates.status, 'have');
  assert.equal(by.crates.best[0].ref, 'bright/crate');
  assert.equal(by['two-crates'].status, 'have');
  assert.match(by['two-crates'].gap, /1 of 3 in style; 2 more is new art/, 'the grey crate has the wrong surface and detail: no style pass brings it in');
  assert.equal(by.bombs.status, 'missing');
  assert.equal(by.sky.status, 'code');
  assert.equal(by.critters.status, 'missing');
  assert.match(by.critters.gap, /centaur body/);
  assert.equal(r.totals.missing, 2);
});

test('a kind as a target: in-kind assets are in style; flat kinds ask for sprite sheets and pictures', () => {
  const l = lib();
  l[0].pack.signature = { palette: { saturation: 0.8, value: 0.6, families: [{ hue: 'green', share: 1 }] }, trianglesPerMetre: 12, texturedShare: 0.9 };
  const kind = { id: 'bright-kind', packs: ['bright'], feel: 'bright' };
  const kt = kindTarget(kind, l);
  assert.equal(kt.from, 'kind');
  assert.equal(kt.tone.saturation, 0.8);
  const r = coverage(l, [{ id: 'c', category: 'prop', dimension: '3d', words: 'crate', count: 2 }], { target: kt, kindPreset: kind, policy });
  assert.equal(r.needs[0].best[0].inKind, true);
  assert.deepEqual([flatNeed({ category: 'body', archetype: 'worm' }).category, flatNeed({ category: 'prop' }).category, flatNeed({ category: 'texture' }).category], ['sprite-sheet', 'picture', 'tile']);
});

test('inventory counts by category and licence class', () => {
  const inv = inventory(lib(), { policy });
  assert.equal(inv.totals.assets, 3);
  assert.equal(inv.totals.byLicenceClass['public-domain'], 3);
  assert.equal(inv.packs[0].byCategory.prop, 2);
});

test('the real library: the report runs over every kind and the proving case', () => {
  const r = coverageReport({ config: loadConfig(), casePath: CASE });
  assert.ok(r.inventory.totals.assets > 1000);
  assert.ok(r.views.some(v => v.id === 'kind:silly'));
  const c = r.views.find(v => v.id === 'case:artillery-cartoon');
  assert.ok(c.needs.length >= 20);
  for (const n of c.needs) assert.ok(['have', 'off-style', 'missing', 'code'].includes(n.status), `${n.id} ${n.status}`);
});

test('recipe: concept first, the 3D step for models, Meshy\'s rig for a humanoid and the kit\'s autorig for a creature; textures stop at the concept', () => {
  assert.deepEqual(recipe({ id: 'p', kind: 'prop', words: 'a crate' }).steps.map(s => s.step), ['concept', '3d']);
  const hum = recipe({ id: 'h', kind: 'body', archetype: 'humanoid', words: 'a knight' });
  assert.equal(hum.rig, 'gf-humanoid-1');
  assert.equal(hum.credits, COST['image-to-image'] + COST['image-to-3d'] + COST.rigging);
  // a creature (CREATURES.md): made unrigged, rigged on its archetype's standard by the kit's autorig, no credits
  const blob = recipe({ id: 'b', kind: 'body', archetype: 'blob', words: 'a blob' });
  assert.equal(blob.rig, 'gf-blob-1');
  assert.deepEqual(blob.steps.map(s => s.step), ['concept', '3d', 'autorig']);
  assert.equal(blob.credits, COST['image-to-image'] + COST['image-to-3d']);
  assert.match(recipe({ id: 'c', kind: 'body', archetype: 'centaur', words: 'a centaur' }).next, /no rig standard/);
  assert.deepEqual(recipe({ id: 't', kind: 'texture', words: 'soil' }).steps.map(s => s.step), ['concept']);
  assert.equal(waveCost([{ kind: 'prop' }, { kind: 'texture' }]).credits, 6 + 36 + 6);
});

test('prompts come from words: colours named, never a hex code, no reference and no outline baked into a model', () => {
  assert.equal(colourWords('#5ec8ff'), 'vivid light turquoise');
  assert.equal(colourWords('#141414'), 'near-black ink');
  assert.equal(colourWords('#231d33'), 'dusty deep purple');
  const a = anchorPrompt({ ...target, avoid: ['the reference game\'s characters', 'grey surfaces'] }, { subjects: ['a crate'] });
  assert.doesNotMatch(a, /#[0-9a-f]{6}/i);
  assert.doesNotMatch(a, /reference game/);
  assert.match(a, /grey surfaces/);
  const c = conceptPrompt({ kind: 'prop', words: 'a crate' }, target);
  assert.match(c, /no drawn outlines/);
  assert.doesNotMatch(c, /dark outlines/);
  assert.match(conceptPrompt({ kind: 'texture', words: 'soil' }, target), /tileable/);
});

test('the proving case plans its wave inside its cap', () => {
  const c = loadCase(CASE);
  const p = planWave(c);
  assert.ok(p.cost.credits <= c.wave.cap, `${p.cost.credits} credits against the cap ${c.wave.cap}`);
  assert.equal(p.items.filter(i => i.kind === 'body').length, 3);
  assert.ok(p.items.every(i => i.prompt.length <= 1500));
});

test('makeTileable: the made picture repeats (its opposite edges meet)', async () => {
  const { sharp } = await import('../../builder/art/deps.mjs');
  // a horizontal ramp: its left and right edges differ as much as they can
  const W = 64, raw = Buffer.alloc(W * W * 3);
  for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) raw.fill(Math.round((x / (W - 1)) * 255), (y * W + x) * 3, (y * W + x) * 3 + 3);
  const png = await sharp(raw, { raw: { width: W, height: W, channels: 3 } }).png().toBuffer();
  const out = await makeTileable(png, { sharp, size: W });
  const { data, info } = await sharp(out).raw().toBuffer({ resolveWithObject: true });
  const at = (x, y) => data[(y * info.width + x) * info.channels];
  let before = 0, after = 0;
  for (let y = 0; y < W; y++) { before += Math.abs(raw[(y * W) * 3] - raw[(y * W + W - 1) * 3]); after += Math.abs(at(0, y) - at(W - 1, y)); }
  assert.ok(after / W < 12, `the seam is ${after / W} levels apart (it was ${before / W})`);
  assert.equal(JSON.parse(readFileSync(CASE, 'utf8')).wave.items.filter(i => i.kind === 'texture').length, 6);
});

test('a held prop floats with no base; a standing one keeps its base', () => {
  assert.match(conceptPrompt({ kind: 'prop', held: true, words: 'a launcher' }, target), /no base, stand or plinth/);
  assert.match(conceptPrompt({ kind: 'prop', words: 'a crate' }, target), /on its own base/);
});

// ---- looks wave 3: one anchor per look, set pieces with colliders, every piece judged against its look's anchor
const LEVELS = path.join(LIBRARY_ROOT, 'coverage', 'cases', 'artillery-levels.json');

test('a case with several looks plans one anchor a look, each item drawn from its own look, inside the cap', () => {
  const c = loadCase(LEVELS), p = planWave(c);
  assert.deepEqual(Object.keys(p.anchors).sort(), c.target.looks.map(L => L.id).sort());
  assert.ok(p.cost.credits <= c.wave.cap, `${p.cost.credits} credits against the cap ${c.wave.cap}`);
  assert.equal(p.cost.byStep.anchor, 6 * c.target.looks.length);
  for (const it of p.items) assert.ok(c.wave.looks[it.look], `${it.id} names a look the wave has`);
  // a look's anchor carries our own words for it, and nothing the reference frames were read as
  for (const [id, a] of Object.entries(p.anchors)) {
    assert.match(a, new RegExp(c.wave.looks[id].keep[0].slice(0, 30).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.doesNotMatch(a, /#[0-9a-f]{6}/i);
  }
  // a set piece stands on the world's ground (no base), and carries its collider to ingest
  const castle = p.items.find(i => i.id === 'cone-roof-castle');
  assert.match(castle.prompt, /no base, plinth, island or chunk of ground/);
  assert.equal(castle.ingest.collider, 'box');
  assert.equal(castle.polycount, 12000);
  assert.equal(p.items.find(i => i.id === 'fizz-blaster').ingest.collider, 'none');
  // creatures are made for the worm and blob standards, rigged by the kit's autorig
  assert.deepEqual([...new Set(p.items.filter(i => i.kind === 'body').map(i => i.rig))].sort(), ['gf-blob-1', 'gf-worm-1']);
  // the public case names no reference frame, game or picture
  const raw = readFileSync(LEVELS, 'utf8');
  assert.doesNotMatch(raw, /"frames"|[0-9a-f]{64}|mayhem|\bworms\b/i);
});

test('anchorPrompt: a target read from reference frames never sends its reads to a maker, only our own words', () => {
  const measured = { ...target, from: 'refs+words', reads: ['the reference\'s pink heroes with goggles'] };
  assert.doesNotMatch(anchorPrompt(measured, { subjects: ['a crate'] }), /goggles/);
  assert.match(anchorPrompt(measured, { keep: ['round islands in a blue sea'] }), /round islands in a blue sea/);
  assert.match(anchorPrompt({ ...target, reads: ['bright candy colours'] }), /bright candy colours/);
});

test('a case need may name a level: it is held to that level\'s own target', () => {
  const r = coverageReport({ config: loadConfig(), casePath: LEVELS, kind: 'silly' });
  const v = r.views.find(x => x.id === 'case:artillery-levels');
  const c = JSON.parse(readFileSync(LEVELS, 'utf8'));
  assert.deepEqual(v.needs.map(n => n.id), c.needs.map(n => n.id), 'the needs keep the case\'s order');
  assert.equal(v.needs.find(n => n.id === 'canyon-mesa').look, 'sunset-canyon-sands');
  assert.equal(Object.values(v.totals).reduce((a, b) => a + b, 0), c.needs.length);
});

test('colliderFor: a set piece\'s collider fits its measured size; a held thing has none', async () => {
  const { colliderFor } = await import('../../builder/art/ingest.mjs');
  assert.deepEqual(colliderFor('box', [4, 8, 2]), { shape: 'box', size: [3.6, 8, 1.8], offset: [0, 4, 0] });
  assert.deepEqual(colliderFor('cylinder', [6, 9, 5]), { shape: 'cylinder', radius: 2.7, height: 9, offset: [0, 4.5, 0] });
  const trunk = colliderFor('trunk', [3, 5, 3]);
  assert.ok(trunk.radius < 0.5 && trunk.height < 5);
  assert.deepEqual(colliderFor('none', null), { shape: 'none' });
  assert.equal(colliderFor('box', null), null);
  assert.throws(() => colliderFor('pyramid', [1, 1, 1]), /no collider shape/);
});

test('judgePieces: each piece against its look\'s anchor; an off piece and one far under its look\'s median are outliers', async () => {
  const { anchorSignature, anchorTarget, judgePieces } = await import('../../builder/art/anchor.mjs');
  // an anchor: green and yellow subjects on a plain cream background (the background is left out)
  const W = 40, data = new Uint8ClampedArray(W * W * 4);
  for (let i = 0; i < W * W; i++) {
    const x = i % W, y = Math.floor(i / W), inA = x > 5 && x < 18 && y > 5 && y < 34, inB = x > 22 && x < 35 && y > 5 && y < 34;
    const c = inA ? [70, 200, 60] : inB ? [240, 210, 50] : [245, 240, 225];
    data.set([...c, 255], i * 4);
  }
  const s = anchorSignature({ width: W, height: W, data });
  assert.equal(s.background, '#f5f0e1');
  assert.deepEqual(s.colors.map(c => c.hex).sort(), ['#46c83c', '#f0d232']);
  assert.ok(s.subjectShare > 0.4 && s.subjectShare < 0.7);
  const anchor = anchorTarget(s, { materials: { texture: 'painted' }, shapes: { detail: 'mid' } });
  const pieces = [
    { id: 'a', look: 'x', asset: sig(), anchor }, { id: 'b', look: 'x', asset: sig(), anchor }, { id: 'c', look: 'x', asset: sig({ palette: { saturation: 0.75 } }), anchor },
    { id: 'grey', look: 'x', asset: sig({ palette: { saturation: 0.05, value: 0.2, families: [{ hue: 'grey', share: 1 }], grey: 1 }, tpm: 60 }), anchor },
    { id: 'broken', look: 'x', asset: { ...sig(), validated: [{ by: 'budget', ok: false }] }, anchor },
  ];
  const rows = Object.fromEntries(judgePieces(pieces).map(r => [r.id, r]));
  assert.ok(rows.a.ok && rows.c.ok, 'in-style pieces pass');
  assert.equal(rows.grey.ok, false); assert.ok(rows.grey.outlier);
  assert.equal(rows.broken.ok, false); assert.match(rows.broken.why[0], /failed budget/);
});

test('setItems: a whole art set for a look, priced by the recipe; a flat look makes pictures only', async () => {
  const { setItems, FLAT_BODY_FRAMES } = await import('../../builder/art/recipe.mjs');
  const needs = [{ id: 'hero', category: 'body', archetype: 'humanoid', count: 2 }, { id: 'worm', category: 'body', archetype: 'worm', count: 1 }, { id: 'crate', category: 'prop', count: 3 },
    { id: 'soil', category: 'texture' }, { id: 'boom', category: 'effect' }, { id: 'sky', category: 'sky', code: 'sky.js' }, { id: 'font', category: 'font' }, { id: 'snd', category: 'sound' }];
  const three = setItems(needs, { setPieces: 2 });
  assert.equal(waveCost(three, { anchors: 2 }).credits, 12 + 2 * 41 + 36 + 3 * 36 + 6 + 6 + 2 * 36);
  const flat = setItems(needs, { flat: true, setPieces: 2 });
  assert.ok(flat.every(i => i.kind === 'picture' || i.kind === 'texture'));
  assert.equal(flat.length, 3 * FLAT_BODY_FRAMES + 3 + 1 + 1 + 2);
});
