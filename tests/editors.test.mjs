// The editors (Map, Skins, Items; items as data): their pure parts, the map route (POST /api/editors/map)
// on a real created flat game, and the slot route as the Items tab uses it on a real created melee game. The pages
// themselves are driven in tests/editors-shots.mjs and tests/items-shots.mjs (real Chrome, real dev server).
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createGame } from '../builder/lib/create.mjs';
import { FLAT_KIT, GF3 } from '../builder/lib/paths.mjs';
import { importKitModule } from '../builder/tools/lib/kit-import.mjs';

// a flat profile module, imported the way the tools do (its imports follow a game's gf/three/ tree)
const flat = async rel => { const m = await importKitModule(path.join(FLAT_KIT, rel)); if (m.error) throw m.error; return m; };
import { startDevServer } from '../builder/server/index.mjs';
import { tempDir } from './helpers.mjs';
import { createHistory } from '../builder/studio/lib/editors/history.js';
import { charFor, checkMap, entryAt, fillCells, gridOf, jumpShade, lineCells, paintCells, paletteOf, rectCells, resizeGrid, withGrid } from '../builder/studio/lib/editors/paint.js';
import { addProp, clampTo, duplicateProp, fitView, hitProp, moveProp, propsView, removeProp, rotateProp, scaleProp, snap } from '../builder/studio/lib/editors/layout.js';
import { addEntry, balanceRequest, clampField, fieldRange, firstWords, itemsOf, liveWords, lookRequest, peersOf, removeEntry, renameEntry, setEntryField, switchOption, takesLive } from '../builder/studio/lib/editors/items.js';
import { listSlots } from '../builder/lib/slots.mjs';
import { bodyChoices, drawRequest, loadoutParam, lookAlike, modelRequest, setSeat, sheetFrames, showingRole, tryOnLoadout, tryOnPath } from '../builder/studio/lib/editors/skins.js';

const kitFlat = async () => ({
  ...(await flat('index.js')),
  ...(await flat('tilemap.js')),
  SIDE: (await flat('slots.js')).SIDE,
});

// a side-on map like the flat example "Coin Hop" (examples/minimal/coin-hop)
const ROWS = [
  'B............................B',
  'B............................B',
  'B............o..o............B',
  'B............................B',
  'B..o........======........o..B',
  'B............................B',
  'B.===..====..o..o..====..===.B',
  'B............................B',
  'B....====..========..====....B',
  'B..o......................o..B',
  'B.1...BB..1...BB...1..BB...1.B',
  '##############################',
];
const SIDE_MAP = { format: 'gf-tilemap-1', plane: 'side', tile: 1, kinds: { ground: { solid: true }, brick: { solid: true }, ledge: { solid: 'top' } },
  legend: { '1': 'spawn', '.': null, '#': 'ground', B: 'brick', '=': 'ledge', o: 'mark:coin' }, rows: ROWS };

test('history: push, undo, redo; an edit that changes nothing is not a step; push drops the redo side', () => {
  const h = createHistory({ a: 1 });
  assert.equal(h.canUndo, false);
  assert.equal(h.push({ a: 1 }), false);
  h.push({ a: 2 }); h.push({ a: 3 });
  assert.deepEqual(h.undo(), { a: 2 });
  assert.deepEqual(h.redo(), { a: 3 });
  h.undo(); h.push({ a: 9 });
  assert.equal(h.canRedo, false);
  assert.deepEqual(h.undo(), { a: 2 });
  assert.deepEqual(h.undo(), { a: 1 });
  assert.deepEqual(h.undo(), { a: 1 }, 'nothing left to undo: stays');
});

test('paint: grid round trip, strokes, box, fill, pick, and a new legend character only when one is missing', () => {
  const g = gridOf(SIDE_MAP);
  assert.equal(withGrid(SIDE_MAP, g).rows.join('\n'), ROWS.join('\n'));
  assert.deepEqual(charFor(SIDE_MAP, 'ledge'), { map: SIDE_MAP, ch: '=' });
  const added = charFor(SIDE_MAP, 'mark:gem');
  assert.notEqual(added.map, SIDE_MAP);
  assert.equal(added.map.legend[added.ch], 'mark:gem');
  assert.ok(!(added.ch in SIDE_MAP.legend));
  const line = lineCells({ c: 1, r: 1 }, { c: 6, r: 3 });
  assert.deepEqual(line[0], { c: 1, r: 1 }); assert.deepEqual(line.at(-1), { c: 6, r: 3 });
  for (let i = 1; i < line.length; i++) assert.ok(Math.abs(line[i].c - line[i - 1].c) <= 1 && Math.abs(line[i].r - line[i - 1].r) <= 1, 'a fast drag leaves no gap');
  assert.equal(rectCells({ c: 3, r: 2 }, { c: 1, r: 1 }).length, 6);
  const painted = paintCells(g, [{ c: 1, r: 1 }, { c: 99, r: 1 }], '=');
  assert.equal(painted[1][1], '='); assert.equal(g[1][1], '.', 'the old grid is untouched');
  const filled = fillCells(g, 5, 1, '#');
  assert.equal(filled[0][5], '#', 'the sky joins the top row');
  assert.equal(filled[11][5], '#'); assert.equal(filled[4][12], '=', 'a ledge is not the sky: the fill stops at it');
  assert.equal(entryAt(SIDE_MAP, g, 13, 2), 'mark:coin');
  const pal = paletteOf(SIDE_MAP, { tiles: { ground: 'assets/tiles/ground.png' }, marks: { coin: 'assets/sprites/coin.png' } });
  assert.deepEqual(pal.map(p => p.entry), ['ground', 'brick', 'ledge', 'spawn', 'mark:coin', null]);
  assert.equal(pal.find(p => p.entry === 'mark:coin').slot, 'prop.coin');
});

test('paint: resizing keeps a side-on floor whole and moves the right wall out', () => {
  const g = resizeGrid(gridOf(SIDE_MAP), { cols: 32, rows: 13 }, '.', { plane: 'side' });
  assert.equal(g.length, 13); assert.equal(g[0].length, 32);
  assert.equal(g.at(-1).join(''), '#'.repeat(32), 'the floor runs on');
  assert.equal(g[5].at(-1), 'B', 'the right wall moved out with the edge');
  assert.equal(g[0].join(''), '.'.repeat(32), 'a new row is added at the top');
  assert.equal(resizeGrid(g, { cols: 30, rows: 12 }, '.', { plane: 'side' }).at(-1).length, 30);
});

test('checkMap: the kit says the example map is playable; a ledge painted out of reach is red with words', async () => {
  const kit = await kitFlat();
  const ok = checkMap(SIDE_MAP, { kit, seats: 4 });
  assert.equal(ok.ok, true, ok.errors.join('; '));
  assert.equal(ok.spawns, 4); assert.equal(ok.bad.size, 0);
  assert.ok(ok.reached.size > 20, 'standing places are known');
  // a ledge across the top-left, five rows above anything: nothing reaches it
  const g = paintCells(gridOf(SIDE_MAP), rectCells({ c: 3, r: 1 }, { c: 8, r: 1 }), '=');
  const bad = checkMap(withGrid(SIDE_MAP, g), { kit, seats: 4 });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some(e => /ledge at column 4, row 1/.test(e) && /cannot be reached/.test(e)), bad.errors.join('; '));
  assert.ok(bad.bad.has('4,1') && bad.bad.has('4,0'), 'the ledge and the place above it are coloured');
  // the shade under the cursor is the reach model's: from the floor it does not reach row 1
  const M = kit.readMap(SIDE_MAP);
  const shade = jumpShade(M, ok.reach, 5, 10);
  assert.ok(shade.some(q => q.r === 8) && !shade.some(q => q.r <= 6));
  // a map the kit refuses outright (a spawn in no legend) says why
  const broken = checkMap({ ...SIDE_MAP, rows: ROWS.map(r => r.replace('1', 'Z')) }, { kit });
  assert.equal(broken.ok, false); assert.ok(broken.errors.some(e => /legend does not name/.test(e)));
});

test('checkMap: from above, a start spot walled in on every side is red', async () => {
  const kit = await kitFlat();
  const rows = ['##########', '#1.......#', '#........#', '#....###.#', '#....#1#.#', '#....###.#', '#........#', '##########'];
  const map = { format: 'gf-tilemap-1', plane: 'top', tile: 1, base: 'grass', kinds: { grass: { solid: false }, wall: { solid: true } }, legend: { '.': null, '#': 'wall', '1': 'spawn' }, rows };
  const r = checkMap(map, { kit, seats: 2 });
  assert.equal(r.ok, false);
  assert.ok(r.bad.has('6,4'));
  assert.ok(r.errors.some(e => /walled in/.test(e)));
});

test('layout: snap, move inside the ground, turn, size, copy, remove, pick the smallest under the cursor', () => {
  assert.equal(snap(1.26), 1.5); assert.equal(snap(1.26, 0), 1.26);
  const props = [{ prop: 'house', at: [0, 0, 0], rot: 0, scale: 1 }, { prop: 'bench', at: [0.5, 0, 0], rot: 90, scale: 1 }];
  const sizes = { house: [6, 4, 6], bench: [2, 1, 0.6] };
  const v = propsView(props, sizes);
  assert.deepEqual([v[1].w, v[1].d], [2, 0.6]);
  assert.equal(hitProp(v, 0.5, 0.8), 1, 'the bench turned 90° covers z 0.8; it is smaller than the house');
  assert.equal(hitProp(v, 2.5, 2.5), 0);
  assert.equal(hitProp(v, 20, 20), -1);
  const moved = moveProp(props, 1, 30.2, -3.7, { size: [40, 32] });
  assert.deepEqual(moved[1].at, [20, 0, -3.5], 'clamped to the ground, snapped');
  assert.equal(rotateProp(props, 1, 300)[1].rot, 30);
  assert.equal(rotateProp(props, 1, -120)[1].rot, 330);
  assert.equal(scaleProp(props, 0, 9)[0].scale, 4);
  const d = duplicateProp(props, 1, { size: [40, 32] });
  assert.equal(d.props.length, 3); assert.equal(d.index, 2); assert.deepEqual(d.props[2].at, [2, 0, 0]);
  assert.equal(removeProp(props, 0).length, 1);
  assert.deepEqual(addProp(props, 'bench', 1.2, 2.9).at(-1), { prop: 'bench', at: [1, 0, 3], rot: 0, scale: 1 });
  assert.deepEqual(clampTo([10, 6], 9, -9), [5, -3]);
  const f = fitView([40, 20], 440, 240, 20);
  assert.equal(f.k, 10); assert.deepEqual(f.toPx(0, 0), [220, 120]); assert.deepEqual(f.toWorld(...f.toPx(3, -4)), [3, -4]);
});

// the melee and pickup party game the items proof uses (a games.fun proof spec)
const PILLOW = JSON.parse(readFileSync(new URL('./fixtures/pillow-brawl.spec.json', import.meta.url), 'utf8'));
async function pillowGame(t) {
  const tmp = await tempDir();
  t.after(() => tmp.cleanup());
  const specFile = path.join(tmp.dir, 'spec.json');
  await writeFile(specFile, JSON.stringify(PILLOW));
  const dir = path.join(tmp.dir, 'game');
  await createGame(dir, { spec: specFile });
  return dir;
}
const kitItems = () => import(pathToFileURL(path.join(GF3, 'kit/assets/items.js')).href);

test('items: cards come from the game\'s own items index and each table\'s declaration (no list of mechanics in the page)', async t => {
  const dir = await pillowGame(t);
  const L = await listSlots(dir, { all: true });
  assert.ok(Array.isArray(L.items), 'GET /api/game/slots carries assets.json → items');
  const { cards, tables } = itemsOf(L.slots, L.items);
  assert.deepEqual(cards.map(c => c.id), ['mechanic.melee.weapons:pillow', 'mechanic.melee.weapons:big-pillow', 'pickup:single']);
  assert.equal(tables.length, 1);
  assert.equal(tables[0].start?.id, 'mechanic.melee.start-weapon', 'the start slot is found by its choices');
  const pillow = cards[0];
  assert.equal(pillow.starts, true);
  assert.deepEqual(pillow.main.map(f => f.label), ['Swing 1: damage', 'Swing 1: reach', 'Heavy attack: damage', 'Rarity'], 'the front the mechanic declares, the weapon\'s name taken off each label');
  const rarity = pillow.main[3];
  assert.deepEqual([rarity.via, rarity.constraints.min, rarity.constraints.max, takesLive(rarity)], [{ table: 'mechanic.melee.weapons', index: 0, field: 'rarity' }, 0, 3, false], 'a front field with no slot is written with the table, and reloads');
  assert.equal(takesLive(pillow.main[0]), true, 'a number with its own slot is sent to the running game');
  assert.equal(takesLive(pillow.more.find(f => f.type === 'color')), false, 'a colour reloads');
  assert.deepEqual(peersOf(cards, pillow, 'combo/0/damage'), [{ name: 'Big pillow', value: 2 }]);
  const crate = cards[2];
  assert.equal(crate.name, 'Crate'); assert.equal(crate.show, 'prop.crate'); assert.equal(crate.what, 'feather crates that patch you up');
  assert.deepEqual(crate.main.map(f => f.id), ['mechanic.pickup.value', 'mechanic.pickup.respawn-seconds', 'mechanic.pickup.count']);
  assert.ok(crate.more.some(f => f.id === 'prop.crate.size'), 'the picture\'s own slots sit behind More');
  assert.deepEqual(itemsOf(L.slots, null).cards, [], 'a game made before items were data has no cards');
  assert.equal(firstWords('a shiny gold coin (collected)'), 'Shiny gold coin');
});

test('items: add like, remove, rename and switch are the kit\'s own table changes; each refusal is in words', async () => {
  const kit = await kitItems();
  const item = { key: 'weapons', noun: 'weapon', nouns: 'weapons', min: 1, max: 3, id: 'id', name: 'name', schema: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string', maxLength: 32 }, combo: { type: 'array', items: { type: 'object', properties: { damage: { type: 'number', minimum: 0, maximum: 100 } } } } } },
    picture: { field: 'model', alias: ['prop'], file: 'melee-<id>.glb', slot: 'mechanic.melee.<id>.model', library: 'kaykit-sword' } };
  const table = [{ id: 'pillow', name: 'Pillow', combo: [{ damage: 1 }] }, { id: 'big-pillow', name: 'Big pillow', combo: [{ damage: 2 }] }];
  const a = addEntry(kit, item, table, { like: 'pillow', name: 'Foam sword' });
  assert.equal(a.entry.id, 'foam-sword'); assert.equal(a.entry.model, 'library:kaykit-sword'); assert.deepEqual(a.entry.combo, [{ damage: 1 }]);
  assert.equal(a.table.length, 3); assert.equal(table.length, 2, 'the old table is untouched');
  assert.match(addEntry(kit, item, a.table, { like: 'pillow', name: 'Fourth' }).problem, /at most 3 weapons/);
  assert.match(addEntry(kit, item, table, { like: 'pillow', name: '  ' }).problem, /name/);
  assert.match(addEntry(kit, item, table, { like: 'laser', name: 'X' }).problem, /no weapon "laser"/);
  assert.deepEqual(removeEntry(kit, item, a.table, 'big-pillow').table.map(e => e.id), ['pillow', 'foam-sword']);
  assert.match(removeEntry(kit, item, [table[0]], 'pillow').problem, /at least 1 weapon/);
  const r = renameEntry(item, table, 'big-pillow', 'Huge pillow');
  assert.deepEqual(r.table.map(e => [e.id, e.name]), [['pillow', 'Pillow'], ['big-pillow', 'Huge pillow']], 'the id stays, so its slots and picture stay');
  assert.match(renameEntry(item, table, 'big-pillow', '').problem, /letter/);
  assert.equal(setEntryField(table, 1, 'combo/0/damage', 7).table[1].combo[0].damage, 7);
  assert.deepEqual(switchOption(['b'], ['a', 'b', 'c'], 'a', true).table, ['a', 'b']);
  assert.deepEqual(switchOption(['a', 'b'], ['a', 'b', 'c'], 'a', false).table, ['b']);
  assert.match(liveWords('taken', 'Pillow: reach'), /playing now, no reload/);
  assert.match(liveWords(null, 'Pillow: reach'), /reloaded/);
  assert.match(liveWords('saved', 'Colour'), /reloads to show it/);
});

test('items: a slider never leaves its slot\'s range; requests name the slots and what the session should use', () => {
  const dmg = { id: 'mechanic.melee.pillow.combo-1.damage', type: 'number', value: 1, constraints: { min: 0, max: 100 } }, count = { id: 'x', type: 'integer', value: 6, constraints: { min: 1, max: 60 } };
  assert.deepEqual(fieldRange(dmg), { min: 0, max: 100, step: 0.5 });
  assert.equal(clampField(dmg, 140), 100); assert.equal(clampField(dmg, -3), 0); assert.equal(clampField(dmg, 'x'), 1);
  assert.equal(clampField(count, 7.6), 8);
  const card = { kind: 'entry', name: 'Foam sword', what: 'one of 3 weapons', noun: 'weapon', table: 'mechanic.melee.weapons', entryId: 'foam-sword', picture: null, main: [{ ...dmg, label: 'Swing 1: damage' }], more: [] };
  const b = balanceRequest(card, 'pillows should feel even');
  assert.match(b, /Swing 1: damage \(mechanic\.melee\.pillow\.combo-1\.damage\) = 1 \[0\.\.100\]/);
  const table = { item: { picture: { field: 'model', dir: 'assets/models', file: 'melee-<id>.glb' } } };
  assert.match(lookRequest(card, 'soft blue foam', table), /assets\/models\/melee-foam-sword\.glb.*"model" field.*mechanic\.melee\.weapons/);
  assert.match(lookRequest({ ...card, picture: { slot: 'prop.crate', type: 'model' } }, 'a gold crate'), /slots set prop\.crate --file/);
});

test('POST /api/game/slots/value on a created melee game: refuses in the kit\'s words and writes nothing; a table write adds a weapon with its own picture and slots', async t => {
  const dir = await pillowGame(t);
  const srv = await startDevServer({ gameDir: dir, port: 0, log: () => {}, watch: false });
  t.after(() => srv.close());
  const post = async body => { const r = await fetch(`http://127.0.0.1:${srv.port}/api/game/slots/value`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  const gameFile = path.join(dir, 'config/game.json'), before = await readFile(gameFile, 'utf8');
  // a number out of its range
  const big = await post({ id: 'mechanic.melee.pillow.combo-1.damage', value: 500 });
  assert.equal(big.status, 400);
  assert.deepEqual(big.body.problems, ['Pillow, swing 1: damage is 500: more than 100, the most it can be']);
  // a table with an entry out of range, and a start weapon the table does not hold
  const L = await (await fetch(`http://127.0.0.1:${srv.port}/api/game/slots?all=1`)).json();
  assert.equal(L.items.find(i => i.table)?.table, 'mechanic.melee.weapons');
  const t0 = L.slots.find(s => s.id === 'mechanic.melee.weapons');
  const kit = await kitItems();
  const made = addEntry(kit, t0.constraints.item, t0.value, { like: 'pillow', name: 'Foam sword' });
  const bad = JSON.parse(JSON.stringify(made.table)); bad[2].combo[0].damage = 500;
  const refused = await post({ id: 'mechanic.melee.weapons', value: bad });
  assert.equal(refused.status, 400);
  assert.deepEqual(refused.body.problems, ['Foam sword, swing 1: damage is 500: more than 100, the most it can be']);
  const laser = await post({ id: 'mechanic.melee.start-weapon', value: 'laser' });
  assert.equal(laser.status, 400); assert.match(laser.body.problems[0], /must be one of pillow, big-pillow/);
  assert.equal(await readFile(gameFile, 'utf8'), before, 'nothing was written');
  // the good table: written, the new weapon's picture copied in from the library with its licence, its slots made
  const ok = await post({ id: 'mechanic.melee.weapons', value: made.table });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.before.length, 2); assert.equal(ok.body.after.length, 3);
  assert.ok(ok.body.pictures.some(p => /Foam sword: model library:kaykit-sword → assets\/models\/melee-foam-sword\.glb \(CC0-1\.0/.test(p)), ok.body.pictures.join('; '));
  const game = JSON.parse(await readFile(gameFile, 'utf8')), w = game.mechanics.find(m => m.id === 'melee').params.weapons;
  assert.deepEqual(w.map(x => x.id), ['pillow', 'big-pillow', 'foam-sword']);
  assert.equal(w[2].model, 'melee-foam-sword.glb'); assert.equal(w[2].license.spdx, 'CC0-1.0');
  assert.equal((await readFile(path.join(dir, 'assets/models/melee-foam-sword.glb'))).subarray(0, 4).toString('latin1'), 'glTF');
  const after = await (await fetch(`http://127.0.0.1:${srv.port}/api/game/slots?all=1`)).json();
  for (const id of ['mechanic.melee.foam-sword.combo-1.damage', 'mechanic.melee.foam-sword.model']) assert.ok(after.slots.some(s => s.id === id), id);
  assert.deepEqual(after.slots.find(s => s.id === 'mechanic.melee.start-weapon').constraints.enum, ['pillow', 'big-pillow', 'foam-sword']);
  // now the start weapon may be it, and a number of it is an ordinary write
  assert.equal((await post({ id: 'mechanic.melee.start-weapon', value: 'foam-sword' })).status, 200);
  const n = await post({ id: 'mechanic.melee.foam-sword.combo-1.reach', value: 3.6 });
  assert.deepEqual([n.status, n.body.before, n.body.after], [200, 2.2, 3.6]);
  // the remove: the kit refuses a table below its least
  const one = await post({ id: 'mechanic.melee.weapons', value: [] });
  assert.equal(one.status, 400); assert.match(one.body.problems[0], /at least 1 weapon/);
  // the tab's own files are served
  for (const f of ['studio/tabs/items.js', 'studio/lib/editors/items.js', 'game/gf/three/assets/items.js']) assert.equal((await fetch(`http://127.0.0.1:${srv.port}/${f}`)).status, 200, f);
});

test('skins: the try-on address carries a loadout the kit reads; seats, look-alikes, sheet frames, bodies, requests', () => {
  const p = loadoutParam({ values: { 'character.tint.player': '#23c64a' } });
  assert.doesNotMatch(p, /[+/=]/, 'base64url');
  assert.deepEqual(JSON.parse(Buffer.from(p, 'base64url').toString('utf8')), { values: { 'character.tint.player': '#23c64a' }, files: {}, pass: null });
  const url = new URL(tryOnPath('player', { colour: '#ABCDEF' }), 'http://x');
  assert.equal(url.searchParams.get('gf-show'), 'character.player');
  assert.equal(JSON.parse(Buffer.from(url.searchParams.get('gf-loadout'), 'base64url')).values['character.tint.player'], '#abcdef');
  assert.equal(new URL(tryOnPath('player'), 'http://x').searchParams.has('gf-loadout'), false);
  // once the turning player shows, a new look is a message (the kit's gf:loadout) and the subject restyles in place
  assert.deepEqual(tryOnLoadout({ colour: '#ABCDEF' }), { values: { 'character.tint.player': '#abcdef' }, files: {} });
  assert.equal(showingRole('?gf-show=character.player&gf-loadout=x', 'player'), true);
  assert.equal(showingRole('?seed=1', 'player'), false);
  assert.deepEqual(setSeat(['#111111'], 2, '#FF0000'), ['#111111', '#111111', '#ff0000']);
  assert.throws(() => setSeat([], 0, 'red'));
  assert.deepEqual(lookAlike(['#ff0000', '#fe0101', '#0000ff']), [[0, 1]]);
  const f = sheetFrames(1536, 256);
  assert.equal(f.length, 6); assert.deepEqual(f[3], { name: 'air', row: 0, x: 768, y: 0, w: 256, h: 256 });
  assert.equal(sheetFrames(192, 96).length, 18, 'three rows by heading');
  const bodies = bodyChoices([{ id: 'a', license: { spdx: 'CC0-1.0' } }, { id: 'b', license: { spdx: 'CC-BY-4.0' } }], { current: 'a' });
  assert.deepEqual(bodies.map(b => [b.id, b.current]), [['a', true]]);
  assert.match(drawRequest({ slot: 'character.body.player', subject: 'a knight', style: 'pixel', plane: 'side' }), /gamesfun_art_request .* gamesfun_art_take/);
  assert.match(modelRequest({ slot: 'character.body.player', subject: 'a robot' }), /do not spend money without asking me/);
});

test('POST /api/editors/map on a created flat game: refuses a ledge out of reach, writes a good map through the slot and rewrites the spawn list', async t => {
  const tmp = await tempDir();
  t.after(() => tmp.cleanup());
  const spec = {
    specVersion: 2, runtime: 'three', profile: 'flat-2d', loop: 'round', kind: 'drawn', title: 'Painter Test', hook: 'A side-on coin grab.', prompt: 'a 2D side-on coin grab',
    players: { min: 1, max: 4, bots: true }, multiplayer: { mode: 'live', together: 'versus' }, devices: { targets: ['desktop', 'phone'] }, round: { seconds: 60, winBy: 'most coins', replay: true }, camera: 'side',
    controls: { interact: 'grab a coin', jump: 'jump' },
    world: { template: 'stage', size: 'small', props: [{ name: 'coin', describe: 'a gold coin', count: 12, role: 'collected', kind: 'gameplay' }], map: { legend: { o: 'mark:coin' }, rows: ROWS } },
    mechanics: [{ id: 'pickup', as: 'coins to collect', params: { prop: 'coin', count: 0, effect: 'score', value: 1, respawnSeconds: 4, size: 0.8, collect: 'both' } }],
    rules: { summary: 'Grab coins.', scoring: '+1 per coin', params: {} }, characters: [{ role: 'player', describe: 'a kid', body: { from: 'kind' } }],
    look: { preset: 'drawn-day' }, sounds: [{ id: 'coin', describe: 'a chime' }], build: [], content: { rating: 'E' }, accept: ['coins'],
  };
  const specFile = path.join(tmp.dir, 'spec.json');
  await writeFile(specFile, JSON.stringify(spec));
  const dir = path.join(tmp.dir, 'game');
  await createGame(dir, { spec: specFile });
  const srv = await startDevServer({ gameDir: dir, port: 0, log: () => {}, watch: false });
  t.after(() => srv.close());
  const post = async body => { const r = await fetch(`http://127.0.0.1:${srv.port}/api/editors/map`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  const world = JSON.parse(await readFile(path.join(dir, 'config/world.json'), 'utf8'));
  const high = withGrid(world.map, paintCells(gridOf(world.map), rectCells({ c: 3, r: 1 }, { c: 8, r: 1 }), '='));
  const refused = await post({ map: high });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /out of reach: the ledge at column 4, row 1/);
  // a good change: a start spot moved along the floor, and the floor ledge widened
  const g = gridOf(world.map); g[10][2] = '.'; g[10][4] = '1';
  const good = withGrid(world.map, g);
  const ok = await post({ map: good });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.id, 'world.map');
  const after = JSON.parse(await readFile(path.join(dir, 'config/world.json'), 'utf8'));
  assert.deepEqual(after.map.rows, good.rows, 'the map is what was painted');
  assert.deepEqual(ok.body.derived, ['config/world.json'], 'the spawn list was rewritten from the map');
  assert.equal(after.spawns[0][0], -10.5, 'the first spawn is now at column 5');
  const tabs = await (await fetch(`http://127.0.0.1:${srv.port}/api/studio/tabs`)).json();
  for (const f of ['map.js', 'skins.js', 'items.js']) assert.ok(tabs.some(x => x.file === f), f);
  for (const f of ['history.js', 'paint.js', 'layout.js', 'items.js', 'skins.js', 'ui.js', 'map-flat.js', 'map-layout.js']) assert.equal((await fetch(`http://127.0.0.1:${srv.port}/studio/lib/editors/${f}`)).status, 200, f);
  assert.equal((await fetch(`http://127.0.0.1:${srv.port}/studio/editors.css`)).status, 200);
  const lib = await fetch(`http://127.0.0.1:${srv.port}/api/editors/library/bodies/..%2fbodies.json`);
  assert.equal(lib.status, 404, 'only a library file by its plain name');
});
