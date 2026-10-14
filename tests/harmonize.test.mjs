// The style pass (looks wave 3): mixed packs' models and pictures moved toward one look, at load time
// (runtimes/three/kit/look/harmonize.js) and baked into new library assets (builder/art/harmonize.mjs), on the same
// numbers (harmonize-core.js). Shapes never change; the originals are never written.
import { installKitImports } from '../builder/tools/lib/kit-import.mjs';
installKitImports();
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as H from '../runtimes/three/kit/look/harmonize-core.js';
import { harmonizeValues, harmonizeLook, objectColours, harmonizePng, harmonizeGlb, distanceTo } from '../builder/look/harmonize.mjs';
import { applyTarget } from '../builder/look/apply.mjs';

const THREE = await import('three');
const Hm = await import('../runtimes/three/kit/look/harmonize.js');
const M = await import('../runtimes/three/kit/look/materials.js');

// a sunny island look: grass, foliage, sand, soil; a sky and a sea that are not things; a red HUD accent
const TARGET = {
  schema: 'gf-look-target/1', from: 'refs', confidence: 0.8,
  palette: { colors: [
    { hex: '#79bbc9', share: 0.2, role: 'day sky / sea' }, { hex: '#d2e3da', share: 0.15, role: 'clouds / smoke' },
    { hex: '#6be26b', share: 0.2, role: 'grass' }, { hex: '#67775d', share: 0.15, role: 'pine foliage' },
    { hex: '#a89e5f', share: 0.1, role: 'sand / sandstone' }, { hex: '#4d4457', share: 0.1, role: 'rock shadow / soil' },
    { hex: '#0c0c10', share: 0.05, role: 'ink' }, { hex: '#6795bc', share: 0.05 },
  ] },
  materials: { shading: 'soft-toon', roughness: 0.75, texture: 'painted' },
  edges: { outline: 'low' },
  ui: { accent: ['#e2453a'] },
};
const lab = hex => H.toLab(...H.hexToRgb(hex));
const hueDeg = hex => { const [, a, b] = lab(hex); return ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360; };
const one = (P, hex, words = '') => H.rgbToHex(H.mapColor(P, H.planOf(P, H.clustersOf([[...H.hexToRgb(hex), 1]]), { words }), ...H.hexToRgb(hex)));

test('the look\'s colours of things leave out its sky, sea, clouds and ink, and keep its accents and roles', () => {
  const cols = objectColours(TARGET);
  const hexes = cols.map(c => c.hex);
  for (const h of ['#79bbc9', '#d2e3da', '#0c0c10']) assert.ok(!hexes.includes(h), `${h} is not a thing`);
  for (const h of ['#6be26b', '#67775d', '#a89e5f', '#e2453a']) assert.ok(hexes.includes(h), `${h} is a thing's colour`);
  assert.equal(cols.find(c => c.hex === '#6be26b').role, 'grass');
  const v = harmonizeValues(TARGET);
  assert.equal(v.toon, true, 'soft-toon shading: the house toon material');
  assert.equal(v.metalness, 0); assert.equal(v.roughness, 0.75);
  assert.equal(v.outline, 'none', 'a low outline is left to the post pass');
  assert.equal(v.roles.length, v.palette.length);
  assert.equal(harmonizeValues({ ...TARGET, edges: { outline: 'high' } }).outline, 'hull');
  const px = harmonizeValues({ ...TARGET, edges: { outline: 'mid' } }, { style: 'pixel' });
  assert.equal(px.quantize, true); assert.equal(px.outline, 'ink'); assert.equal(px.outlineColor, 'own'); assert.equal(px.texelsPerMetre, 16);
  assert.equal(harmonizeValues({ ...TARGET, from: 'words' }).strength < harmonizeValues(TARGET).strength, true, 'a target from words leans less');
});

test('a teal canopy turns toward the look\'s greens; on-look colours and far accents mostly stay', () => {
  const P = H.prepare(harmonizeValues(TARGET));
  const teal = one(P, '#70e6d6', 'leafsGreen tree');
  assert.ok(Math.abs(hueDeg(teal) - hueDeg('#6be26b')) < Math.abs(hueDeg('#70e6d6') - hueDeg('#6be26b')) - 20, `teal ${teal} turns toward the grass`);
  // a colour that is the look's own hardly moves
  const g = H.toLab(...H.hexToRgb(one(P, '#6be26b'))), g0 = lab('#6be26b');
  assert.ok(Math.hypot(g[0] - g0[0], g[1] - g0[1], g[2] - g0[2]) < 0.03, 'the grass stays the grass');
  // a red barrel keeps red (the look's accent is red)
  assert.ok(Math.abs(hueDeg(one(P, '#d03030', 'barrel')) - hueDeg('#d03030')) < 15, 'red stays red');
});

test('matter words choose between colours alone cannot tell apart: foliage goes green, not sea-blue', () => {
  const s = harmonizeValues(TARGET), P = H.prepare(s);
  const cl = H.clustersOf([[...H.hexToRgb('#70e6d6'), 1]]);
  assert.equal(H.planOf(P, cl, { words: 'leafsGreen tree-oak' }).clusters[0].anchor, '#6be26b');
  assert.deepEqual([...H.matterOf('woodBark')], ['wood']);
  assert.deepEqual([...H.matterOf('prop.tree-oak leafsGreen')].sort(), ['foliage']);
});

test('an asset keeps its own value contrast: lightness moves once for the whole asset', () => {
  const P = H.prepare(harmonizeValues(TARGET));
  const samples = [[230, 170, 120, 1], [120, 70, 40, 1]];      // a crate's light and dark planks
  const plan = H.planOf(P, H.clustersOf(samples), { words: 'crate' });
  const [a, b] = samples.map(([r, g, bb]) => H.toLab(...H.mapColor(P, plan, r, g, bb))[0]);
  const [a0, b0] = samples.map(([r, g, bb]) => H.toLab(r, g, bb)[0]);
  assert.ok(Math.abs((a - b) - (a0 - b0)) < 0.03, `contrast ${(a0 - b0).toFixed(3)} → ${(a - b).toFixed(3)}`);
});

test('settings: the look\'s block, a level\'s over it, false or strength 0 off; skip, only and the always-left slots', () => {
  const look = { harmonize: { strength: 0.8, palette: ['#6be26b'] }, level: 'dusk', levels: { dusk: { harmonize: { palette: ['#6959c1'] } }, day: {} } };
  assert.deepEqual(H.settingsOfLook(look).palette, ['#6959c1']);
  assert.deepEqual(H.settingsOfLook(look, 'day').palette, ['#6be26b']);
  assert.equal(H.settingsOfLook({ harmonize: false }), null);
  assert.equal(H.settingsOfLook({ harmonize: { strength: 0, palette: ['#fff000'] } }), null);
  const s = H.settingsOfLook({ harmonize: { palette: ['#6be26b'], skip: ['prop.logo'] } });
  assert.equal(H.slotTaken(s, 'prop.tree'), true);
  assert.equal(H.slotTaken(s, 'prop.logo'), false, 'a look\'s own opt-out');
  assert.equal(H.slotTaken(s, 'ui.title'), false, 'UI is always left as it is drawn');
  assert.equal(H.slotTaken(s, 'look.textures.noise'), false);
  assert.equal(H.slotTaken(s, 'prop.tree', { harmonize: false }), false, 'a slot\'s own opt-out');
  assert.equal(H.slotTaken({ ...s, only: ['prop.*'] }, 'world.ground'), false);
});

test('pictures: the ink edge and the pixel ramp never change a sprite\'s alpha; a uniform ink takes each thing\'s own shade', () => {
  const w = 16, h = 16, data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = (y * w + x) * 4, inside = x > 2 && x < 13 && y > 2 && y < 13; data.set(inside ? [58, 165, 143, 255] : [0, 0, 0, 0], i); }
  const alpha0 = data.filter((_, i) => i % 4 === 3).join();
  const s = { ...harmonizeValues({ ...TARGET, edges: { outline: 'mid' } }, { style: 'pixel' }) };
  const r = H.harmonizePicture({ width: w, height: h, data }, s, { words: 'bush' });
  assert.deepEqual(r.did, ['palette', 'ramp', 'ink']);
  assert.equal(data.filter((_, i) => i % 4 === 3).join(), alpha0, 'alpha unchanged');
  assert.ok(H.toLab(data[(3 * w + 8) * 4], data[(3 * w + 8) * 4 + 1], data[(3 * w + 8) * 4 + 2])[0] < 0.35, 'the edge is inked');
  const colours = new Set(); for (let i = 0; i < data.length; i += 4) if (data[i + 3]) colours.add(data.slice(i, i + 3).join());
  assert.ok(colours.size <= 6, `few colours: ${colours.size}`);
  // a uniform black outline → the deep shade of what it surrounds
  const d2 = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = (y * w + x) * 4, inside = x > 2 && x < 13 && y > 2 && y < 13, edge = inside && (x === 3 || x === 12 || y === 3 || y === 12); d2.set(!inside ? [0, 0, 0, 0] : edge ? [20, 15, 15, 255] : [200, 60, 50, 255], i); }
  assert.equal(H.hasInk(d2, w, h), true);
  H.retintInk(d2, w, h);
  const e = d2.slice((3 * w + 8) * 4, (3 * w + 8) * 4 + 3);
  assert.ok(e[0] > e[1] + 10, `the ink is a deep red now: ${[...e]}`);
  // texel density: down by k and back up with whole texels, the same size
  const big = { width: 64, height: 64, data: new Uint8ClampedArray(64 * 64 * 4).fill(255) };
  const small = H.downsample(big, 8);
  assert.deepEqual([small.width, small.height], [8, 8]);
  assert.deepEqual([H.upsample(small, 8, 64, 64).width, H.upsample(small, 8, 64, 64).height], [64, 64]);
});

test('load time (three): a model\'s materials move once, its geometry never; hull outline shares the geometry; restyle redoes from the originals', () => {
  const look = { harmonize: { ...harmonizeValues({ ...TARGET, edges: { outline: 'high' } }) } };
  const geo = new THREE.BoxGeometry(1, 1, 1);
  const before = geo.attributes.position.array.slice();
  const m = new THREE.MeshStandardMaterial({ color: '#70e6d6', roughness: 0.2, metalness: 0.8, name: 'leafsGreen' });
  const root = new THREE.Group(); root.add(new THREE.Mesh(geo, m));
  const r = Hm.harmonizeModel(root, 'prop.tree-oak', { look });
  assert.ok(r.did.includes('materials') && r.did.includes('toon') && r.did.includes('hull outline'));
  assert.notEqual('#' + m.color.getHexString(), '#70e6d6');
  assert.ok(m.roughness > 0.6 && m.metalness < 0.2, 'roughness and metalness toward the look\'s');
  assert.deepEqual([...geo.attributes.position.array], [...before], 'geometry untouched');
  const mesh = root.children[0], hull = mesh.children.find(c => c.userData.gfHull);
  assert.equal(hull.geometry, geo, 'the outline shares the geometry');
  assert.equal(mesh.material.userData.gfKind, 'prop', 'the house toon material');
  const house = mesh.material, tinted = '#' + house.color.getHexString();
  Hm.restyle(null);
  assert.equal('#' + m.color.getHexString(), '#70e6d6', 'off: the original colour');
  assert.equal('#' + house.color.getHexString(), '#70e6d6', 'the house copy follows (adoptMaterials keeps it)');
  Hm.restyle(H.settingsOfLook(look));
  assert.equal('#' + house.color.getHexString(), tinted);
  assert.equal(Hm.harmonizeModel(new THREE.Group().add(new THREE.Mesh(geo, new THREE.MeshStandardMaterial())), 'ui.logo', { look }), null, 'UI slots are left');
});

test('load time (three): a texture slot\'s picture is recoloured in place, its alpha kept', () => {
  const look = { style: 'pixel', harmonize: harmonizeValues({ ...TARGET, edges: { outline: 'mid' } }, { style: 'pixel' }) };
  const data = new Uint8Array(8 * 8 * 4); for (let i = 0; i < 64; i++) data.set(i % 8 && i > 8 && i < 56 ? [58, 165, 143, 255] : [0, 0, 0, 0], i * 4);
  const tex = new THREE.DataTexture(data, 8, 8);
  assert.equal(Hm.harmonizePicture(tex, 'flat.body', { look }), true);
  const d = tex.image.data;
  assert.equal([...d].filter((_, i) => i % 4 === 3).join(), [...data].filter((_, i) => i % 4 === 3).join());
  assert.notEqual([...d.slice(36, 39)].join(), '58,165,143');
});

test('create\'s seam: the target\'s settings into the look, each level its own, the look\'s picks skipped, the spec\'s own win', () => {
  const looks = [{ id: 'day', name: 'Day', frames: [], share: 0.6, palette: { colors: TARGET.palette.colors } }, { id: 'dusk', name: 'Dusk', frames: [], share: 0.4, palette: { colors: [{ hex: '#6959c1', share: 0.5, role: 'violet sky' }, { hex: '#3a734a', share: 0.5, role: 'pine foliage' }] } }];
  const spec = { look: { target: { ...TARGET, looks }, harmonize: { strength: 0.6 } }, world: { template: 'terrain', params: { materials: { top: { from: 'library:xk-terrain/grass-top', size: 4 } } } } };
  const C = { look: { levels: { day: {}, dusk: {} } } };
  const r = harmonizeLook(C, spec, { place: { runtime: 'three', profile: 'standard-3d' } });
  assert.equal(r.on, true);
  assert.equal(C.look.harmonize.strength, 0.6, 'the spec\'s own value wins');
  assert.ok(C.look.harmonize.skip.includes('world.terrain.top'), 'the look\'s own ground picture is left');
  assert.ok(C.look.levels.dusk.harmonize.palette.includes('#3a734a'));
  assert.ok(C.look.levels.dusk.harmonize.palette.includes('#6be26b'), 'the other looks\' colours at a smaller share');
  const off = { look: {} };
  harmonizeLook(off, { look: { target: TARGET, harmonize: false } }, { place: { runtime: 'three' } });
  assert.equal(off.look.harmonize, undefined);
  // through applyTarget, on the flat profile too (its levers are not mapped; the pass is)
  const F = { look: { style: 'pixel' } };
  const a = applyTarget(F, { look: { target: { ...TARGET, edges: { outline: 'mid' } } } }, { place: { runtime: 'three', profile: 'flat-2d' } });
  assert.ok(a.levers.includes('harmonize'));
  assert.equal(F.look.harmonize.quantize, true);
});

test('files: a picture and a GLB through the pass; a GLB\'s geometry is written back as it was read', async () => {
  const { sharp, io, gltfCore } = await import('../builder/art/deps.mjs');
  const s = harmonizeValues(TARGET);
  const png = await sharp({ create: { width: 8, height: 8, channels: 4, background: { r: 58, g: 165, b: 143, alpha: 1 } } }).png().toBuffer();
  const p = await harmonizePng(png, s, { words: 'bush' });
  assert.ok(p.did.includes('palette'));
  const doc = new gltfCore.Document(); const buf = doc.createBuffer();
  const pos = doc.createAccessor().setType('VEC3').setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])).setBuffer(buf);
  const mat = doc.createMaterial('leafsGreen').setBaseColorFactor([0.16, 0.79, 0.67, 1]).setMetallicFactor(0.8).setRoughnessFactor(0.2);
  doc.createScene().addChild(doc.createNode().setMesh(doc.createMesh().addPrimitive(doc.createPrimitive().setAttribute('POSITION', pos).setMaterial(mat))));
  const IO = await io();
  const glb = Buffer.from(await IO.writeBinary(doc));
  const r = await harmonizeGlb(glb, s, { words: 'tree' });
  const back = (await IO.readBinary(new Uint8Array(r.bytes))).getRoot();
  assert.deepEqual([...back.listAccessors()[0].getArray()], [0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const f = back.listMaterials()[0];
  assert.notDeepEqual(f.getBaseColorFactor().slice(0, 3), [0.16, 0.79, 0.67]);
  assert.ok(f.getMetallicFactor() < 0.2 && f.getRoughnessFactor() > 0.6);
  // the measure the bake reports: the colours' distance to the look's falls
  const d0 = distanceTo([{ hex: '#70e6d6', share: 1 }], s), d1 = distanceTo([{ hex: H.rgbToHex(f.getBaseColorFactor().slice(0, 3).map(H.fromLinear)), share: 1 }], s);
  assert.ok(d1.palette < d0.palette, `${d0.palette} → ${d1.palette}`);
});

test('the bake: a new asset in a derived pack with provenance; the original pack is not written', async () => {
  const { harmonizePack, derivedId } = await import('../builder/art/harmonize.mjs');
  const { put } = await import('../builder/art/store.mjs');
  const { sharp } = await import('../builder/art/deps.mjs');
  const { schemas } = await import('../builder/art/manifest.mjs');
  const root = await mkdtemp(path.join(os.tmpdir(), 'harmonize-test-'));
  try {
    const config = { root, packsDir: path.join(root, 'packs'), store: path.join(root, 'store'), defaults: null, privatePacks: path.join(root, 'private'), quarantine: path.join(root, 'q'), mirrors: [], policyFile: null, kindsDir: path.join(root, 'kinds') };
    const png = await sharp({ create: { width: 16, height: 16, channels: 4, background: { r: 58, g: 165, b: 143, alpha: 1 } } }).png().toBuffer();
    const { sha256 } = await put(config.store, png);
    const dir = path.join(config.packsDir, 'test-pack');
    await mkdir(path.join(dir, 'assets'), { recursive: true });
    const pack = { packVersion: 1, id: 'test-pack', title: 'Test pack', licence: { spdx: 'CC0-1.0' }, source: { kind: 'own', store: 'local' }, owner: 'own', visibility: 'public', dimension: '2d' };
    const asset = { assetVersion: 1, id: 'bush', pack: 'test-pack', file: 'bush.png', sha256, bytes: png.length, dimension: '2d', category: 'picture', describe: 'a round green bush', tags: ['bush'], use: { texelsPerMetre: 128, style: 'drawn' } };
    await writeFile(path.join(dir, 'pack.json'), JSON.stringify(pack));
    await writeFile(path.join(dir, 'assets', 'bush.json'), JSON.stringify(asset));
    await writeFile(path.join(dir, 'LICENSE.txt'), 'CC0');
    const lookFile = path.join(root, 'look.target.json');
    await writeFile(lookFile, JSON.stringify(TARGET));
    const before = readFileSync(path.join(dir, 'assets', 'bush.json'), 'utf8');
    const r = await harmonizePack(config, 'test-pack', lookFile, { renderer: null });
    assert.equal(r.added.length, 1, JSON.stringify(r.skipped));
    assert.equal(r.pack, derivedId('test-pack', 'look'));
    assert.equal(readFileSync(path.join(dir, 'assets', 'bush.json'), 'utf8'), before, 'the original manifest is not written');
    assert.deepEqual(readdirSync(dir).sort(), ['LICENSE.txt', 'assets', 'pack.json']);
    const out = JSON.parse(readFileSync(path.join(config.privatePacks, 'packs', r.pack, 'assets', 'bush.json'), 'utf8'));
    assert.equal(out.harmonized.from, 'test-pack/bush');
    assert.equal(out.harmonized.sha256, sha256);
    assert.notEqual(out.sha256, sha256);
    assert.ok(out.tags.includes('harmonised'));
    assert.ok(existsSync(path.join(config.privatePacks, 'packs', r.pack, 'previews', 'bush.png')));
    const S = schemas();
    if (S) assert.deepEqual(S.validateAsset(out), []);
    assert.ok(r.added[0].after.distance.palette <= r.added[0].before.distance.palette);
  } finally { await rm(root, { recursive: true, force: true }); }
});
