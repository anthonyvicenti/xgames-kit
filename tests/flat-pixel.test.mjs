// The pixel kind's own art and what the flat profile draws from a top-down map: the villagers (folk.mjs) and the town
// (town.mjs) pass the flat runtime's judge within 32 colours; the draw plan (drawplan.js) picks edge pictures, lays
// dressing and stands set pieces the same on every machine; create's world config copies what a map asks for; each
// role gets a villager; the library holds every picture the pixel kind and its town name.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importLayer } from '../builder/tools/lib/kit-import.mjs';
import { repoFileOf } from '../builder/tools/lib/paths.mjs';
import { FOLK, sheet } from '../runtimes/three/tools/pixel/folk.mjs';
import { PICTURES, make } from '../runtimes/three/tools/pixel/town.mjs';
import { colourCount } from '../runtimes/three/tools/pixel/paint.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const { judge } = await importLayer(repoFileOf('gf/three/flat/judge.js'));
const { readMap } = await importLayer(repoFileOf('gf/three/flat/tilemap.js'));
const { drawPlan, blendMask, connectMask } = await importLayer(repoFileOf('gf/three/flat/drawplan.js'));
const flat = await importLayer(repoFileOf('gf/three/flat/slots.js'));
const rgba = p => ({ width: p.width, height: p.height, data: new Uint8Array(p.data.buffer, p.data.byteOffset, p.data.length) });

test('every villager sheet passes the flat judge in both forms, within 32 colours', () => {
  for (const id of Object.keys(FOLK)) {
    for (const [rows, plane] of [[3, 'top'], [1, 'side']]) {
      const pic = sheet(id, { rows }), j = judge('body', rgba(pic), { style: 'pixel', plane });
      assert.equal(j.ok, true, `${id} ${plane}: ${JSON.stringify(j.errors)}`);
      assert.equal(j.cell, 32); assert.equal(j.rows, rows);
      assert.ok(colourCount(pic) <= 32, `${id} ${plane}: ${colourCount(pic)} colours`);
    }
  }
});

test('the villagers are different people: no two idle frames are the same picture', () => {
  const seen = new Map();
  for (const id of Object.keys(FOLK)) {
    const p = sheet(id, { rows: 3 }), cell = Buffer.alloc(32 * 32 * 4);
    for (let y = 0; y < 32; y++) p.data.copy(cell, y * 128, y * 192 * 4, y * 192 * 4 + 128);
    const key = cell.toString('base64');
    assert.ok(!seen.has(key), `${id} looks like ${seen.get(key)}`);
    seen.set(key, id);
  }
});

test('every town picture passes its judge (tile, edges, dress, prop) within 32 colours', () => {
  for (const id of Object.keys(PICTURES)) {
    const { judge: j, colours } = make(id);
    assert.equal(j.ok, true, `${id}: ${JSON.stringify(j.errors)}`);
    assert.ok(colours <= 32, `${id}: ${colours} colours`);
  }
});

test('the judge refuses a broken edge set and a strip with an empty picture', () => {
  const blank = (w, h) => ({ width: w, height: h, data: new Uint8Array(w * h * 4) });
  assert.equal(judge('edges', blank(64, 48), { style: 'pixel' }).errors[0].rule, 'shape');
  const e = judge('edges', blank(64, 64), { style: 'pixel', mode: 'blend' });
  assert.ok(e.errors.some(x => x.rule === 'empty' && x.frame === 'mask 1'));
  assert.ok(e.errors.some(x => x.rule === 'empty' && x.frame === 'mask 15'));
  assert.ok(judge('dress', blank(48, 16), { style: 'pixel' }).errors.some(x => x.rule === 'empty'));
});

const MAP = {
  format: 'gf-tilemap-1', plane: 'top', tile: 1, base: 'grass',
  kinds: { grass: { solid: false, dress: 1 }, path: { solid: false, edges: 'blend' }, fence: { solid: true, edges: 'connect' }, house: { solid: true, piece: [3, 2] } },
  legend: { '.': null, ',': 'path', f: 'fence', H: 'house', '1': 'spawn', o: 'mark:coin' },
  rows: ['........', '.HHH....', '.HHH....', ',,,o,,,,', '.fff..1.', '........'],
};

test('a top-down map may ask for edges, dressing and set pieces; readMap keeps them and refuses nonsense', () => {
  const M = readMap(MAP);
  assert.equal(M.ok, true, M.problems.join('; '));
  assert.deepEqual(M.kinds.path, { solid: false, edges: 'blend' });
  assert.deepEqual(M.kinds.house.piece, [3, 2]);
  const bad = readMap({ ...MAP, kinds: { ...MAP.kinds, path: { edges: 'wavy' }, house: { solid: true, piece: [0, 2] } } });
  assert.ok(bad.problems.some(p => /edges is "blend" or "connect"/.test(p)) && bad.problems.some(p => /piece is its footprint/.test(p)));
  assert.ok(readMap({ format: 'gf-tilemap-1', plane: 'side', kinds: { g: { solid: true, edges: 'blend' } }, legend: { '#': 'g', '1': 'spawn' }, rows: ['........', '........', '........', '........', '1.......', '########'] }).problems.some(p => /seen from above/.test(p)));
});

test('the draw plan: blend corners, connect neighbours, one picture a footprint, the same dressing every time', () => {
  const M = readMap(MAP), all = new Set(['grass', 'path', 'fence', 'house']);
  const at = (c, r) => M.at(c, r);
  assert.equal(blendMask(at, 'path', 2, 4), 1 | 2);          // the corner under two path cells: top left and top right
  assert.equal(connectMask(at, 'fence', 2, 4), 2 | 8);       // the middle of three fence cells joins east and west
  const plan = drawPlan(M, { tiles: all, edges: new Set(['path', 'fence']), dress: new Set(['grass']), sizes: { 'world.tiles.house': [48, 64], 'world.dress.grass': [64, 16] }, pad: 0 });
  const pieces = plan.filter(i => i.layer === 5);
  assert.equal(pieces.length, 1);
  assert.deepEqual([pieces[0].c, pieces[0].near, pieces[0].w, pieces[0].h], [2, 2.5, 3, 4]);   // centred on the footprint, standing on its near edge
  assert.ok(plan.some(i => i.shadow), 'a set piece has a shadow');
  assert.ok(plan.filter(i => i.layer === 4).every(i => i.slot === 'world.edges.fence'));
  // the coin's cell is drawn as the path round it, so the path has no hole
  assert.ok(plan.some(i => i.layer === 2 && i.c === 3.5 && i.r === 3.5 && i.frame[0] + i.frame[1] * 4 === 1 + 2));
  // dressing: never on a cell beside the path's soft border, and the same plan again
  assert.ok(plan.filter(i => i.layer === 3 && i.slot).every(i => Math.round(i.r) !== 2 && Math.round(i.r) !== 4));
  assert.deepEqual(drawPlan(M, { tiles: all, edges: new Set(['path', 'fence']), dress: new Set(['grass']), sizes: { 'world.tiles.house': [48, 64], 'world.dress.grass': [64, 16] }, pad: 0 }), plan);
  // without the pictures a kind is drawn as plain tiles
  const plain = drawPlan(M, { tiles: all, pad: 0 });
  assert.ok(!plain.some(i => i.layer === 2 || i.layer === 4) && plain.some(i => i.slot === 'world.tiles.path'));
});

test('create\'s world config copies the edges, dressing and set pieces a pixel map asks for; drawn art has none', () => {
  const spec = { title: 'T', camera: 'top', look: { preset: 'pixel-day' }, players: { max: 2 }, world: { template: 'field', map: { rows: MAP.rows, legend: MAP.legend, kinds: MAP.kinds } } };
  const assets = [], W = flat.worldConfig(spec, { assets });
  assert.equal(W.edges.path, 'assets/tiles/path-edges.png');
  assert.equal(W.edges.fence, 'assets/tiles/fence-edges.png');
  assert.equal(W.dress.grass, 'assets/tiles/grass-dress.png');
  assert.ok(assets.find(a => a.to === 'assets/tiles/house.png').from.endsWith('/pixel/house-red.png'));
  for (const a of assets) assert.ok(existsSync(join(REPO, 'builder', a.from)), a.from);
  const drawn = flat.worldConfig({ ...spec, look: { preset: 'drawn-day' } }, { assets: [] });
  assert.equal(drawn.edges, undefined);
  // the generated map's defaults ask for them too
  const gen = flat.worldConfig({ title: 'G', camera: 'top', look: { preset: 'pixel-day' }, players: { max: 4 }, world: { template: 'field', size: 'small' } }, { assets: [] });
  assert.deepEqual(Object.keys(gen.edges).sort(), ['path', 'wall', 'water']);
});

test('each role gets a villager: the player the tintable one, a baker the baker, another a fixed pick', () => {
  assert.equal(flat.folkFor({ role: 'player' }), 'folk-player');
  assert.equal(flat.folkFor({ role: 'shopkeeper', describe: 'sells bread at the bakery' }), 'folk-baker');
  assert.equal(flat.folkFor({ role: 'npc-7' }), flat.folkFor({ role: 'npc-7' }));
  const assets = [], b = flat.bodyFor({ role: 'fisher' }, { plane: 'side', assets });
  assert.ok(assets[0].from.endsWith('pixel/folk-fisher-side.png') && existsSync(join(REPO, 'builder', assets[0].from)));
  assert.equal(b.role.body, 'assets/sprites/body-fisher.png');
});

test('the pixel kind and its town name only pictures the asset library holds', () => {
  const lib = ref => existsSync(join(REPO, 'library/packs', ref.split('/')[0], 'assets', `${ref.split('/')[1]}.json`));
  const kind = JSON.parse(readFileSync(join(REPO, 'kinds/pixel.json'), 'utf8'));
  for (const ref of kind.bodies.three) assert.ok(lib(ref), ref);
  for (const ref of kind.props.three.filter(r => r.includes('/'))) assert.ok(lib(ref), ref);
  const town = JSON.parse(readFileSync(join(REPO, kind.sheet.world), 'utf8'));
  assert.equal(readMap(town.map).ok, true);
  for (const group of Object.values(town.art)) for (const ref of Object.values(group)) assert.ok(lib(ref), ref);
  for (const row of town.sheet.props) for (const ref of row) assert.ok(lib(ref), ref);
  // every one of them passed the flat judge at ingest
  for (const pack of ['xk-pixel-folk', 'xk-pixel-town', 'flat-standins-pixel']) {
    const p = JSON.parse(readFileSync(join(REPO, 'library/packs', pack, 'pack.json'), 'utf8'));
    assert.equal(p.licence.spdx, 'CC0-1.0');
  }
});
